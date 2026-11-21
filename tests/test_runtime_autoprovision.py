"""Operator opt-in per-user runtime auto-provisioning and manager assignment scoping.

In-process WSGI with SQLite and the simulation lifecycle only; synthetic data,
loopback peers, no Docker, no vendor or model calls.
"""
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest

from openteamily.app import App, Config
from openteamily.lifecycle import Lifecycle, ManagerAuth, ManagerIdentity, RuntimePolicy
from openteamily.operator_config import load_auto_provision, load_manager_auth
from openteamily.runtime_autoprovision import AutoProvisionPolicy
from openteamily.security import digest, opaque
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class AutoProvisionTests(unittest.TestCase):
    def make_app(self, enabled=True, max_instances=5, auto_manager=True, grants=()):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = 1800000000
        self.store = Store(Path(self.temp.name) / 'state')
        self.runtime = Lifecycle(self.store, RuntimePolicy(), clock=lambda: self.now)
        self.token, self.other_token = opaque(), opaque()
        auth = ManagerAuth([
            ManagerIdentity('auto-mgr', digest(self.token), frozenset(grants), 'simulation', auto_manager),
            ManagerIdentity('other-mgr', digest(self.other_token), frozenset(), 'simulation', True),
        ])
        policy = AutoProvisionPolicy(enabled=True, manager_id='auto-mgr', max_instances=max_instances) if enabled else None
        self.app = App(self.store, Config(ORIGIN, allow_registration=True), clock=lambda: self.now,
                       lifecycle=self.runtime, manager_auth=auth, auto_provision=policy)

    def user(self, name, peer):
        client = Client(self.app, peer=peer)
        self.assertEqual(client.register(name)['status'], 201)
        client.username = name
        return client

    def manager(self, method, path, body=None, token=None, name='auto-mgr'):
        return Client(self.app).call(method, path, body,
                                     {'HTTP_AUTHORIZATION': f'Bearer {name}.' + (token or self.token)},
                                     origin=None, csrf=False)

    def listed(self, **kw):
        result = self.manager('GET', '/v1/internal/instances?limit=100', **kw)
        self.assertEqual(result['status'], 200, result)
        return result['body']['items']

    def ensure(self, client):
        # B1 moved /v1/personal-agent to the owner's DS-Bot (410 on the platform), so
        # the platform side calls the same server code path directly: personal.ensure
        # plus the auto-provisioning binding it used to expose through that route.
        with self.store.transaction() as db:
            user = db.execute('SELECT * FROM users WHERE username=?', (client.username,)).fetchone()
            status, payload, _headers = self.app.personal_agent_ensure(
                db, {'user_id': user['id'], 'username': user['username']}, self.now)
        self.assertIn(status, (200, 201), payload)
        return payload['personal_agent']

    def run_job(self, iid, observed, process_ref=None, issue=False):
        claim = self.manager('POST', '/v1/internal/jobs/claim', {'instance_id': iid})
        self.assertEqual(claim['status'], 200, claim)
        body = claim['body']['claim']
        self.assertIsNotNone(body)
        key = None
        if issue:
            key = self.manager('POST', f'/v1/internal/instances/{iid}/runtime-agent-key', {
                'job_id': body['job']['id'], 'observed_revision': body['job']['revision'], 'lease': body['lease']})
            self.assertEqual(key['status'], 200, key)
            key = key['body']['runtime_key']
        payload = {'job_id': body['job']['id'], 'observed_revision': body['job']['revision'],
                   'lease': body['lease'], 'observed': observed}
        if process_ref:
            payload['process_ref'] = process_ref
        result = self.manager('POST', f'/v1/internal/instances/{iid}/observe', payload)
        self.assertEqual(result['status'], 200, result)
        # Receipt is for the claimed job even when the server queues a follow-up start.
        self.assertEqual(result['body']['job']['id'], body['job']['id'])
        self.assertEqual(result['body']['job']['status'], 'succeeded')
        return body, key

    def count(self, sql, *args):
        with self.store.connect() as db:
            return db.execute(sql, args).fetchone()[0]

    def test_disabled_by_default_keeps_existing_behavior(self):
        self.make_app(enabled=False)
        alice = self.user('alice', '127.0.0.1')
        personal = self.ensure(alice)
        self.assertNotIn('runtime_provisioning', personal)
        self.assertEqual(self.count('SELECT COUNT(*) FROM instances'), 0)
        self.assertEqual(self.listed(), [])
        conv = alice.call('GET', f"/v1/workspaces/{personal['workspace']['id']}/agents/{personal['agent']['id']}/conversations")
        cid = conv['body']['items'][0]['id']
        sent = alice.call('POST', f"/v1/workspaces/{personal['workspace']['id']}/agents/{personal['agent']['id']}/conversations/{cid}/messages",
                          {'body': 'hi'}, {'HTTP_IDEMPOTENCY_KEY': 'autoprov-off-msg-0001'})
        self.assertEqual(sent['status'], 201, sent)
        self.assertEqual(sent['body']['reply']['error_code'], 'no_agent')

    def test_provision_bind_idempotent_and_isolated(self):
        self.make_app()
        alice, bob = self.user('alice', '127.0.0.1'), self.user('bob', '127.0.0.2')
        first = self.ensure(alice)
        state = first['runtime_provisioning']
        self.assertEqual(state['state'], 'provisioned')
        self.assertEqual(state['error_code'], 'runtime_starting')
        iid = state['instance_id']
        again = self.ensure(alice)['runtime_provisioning']
        self.assertEqual((again['state'], again['instance_id']), ('existing', iid))
        self.assertEqual(self.count('SELECT COUNT(*) FROM instances WHERE owner_id=(SELECT id FROM users WHERE username=?)', 'alice'), 1)
        wid, aid = first['workspace']['id'], first['agent']['id']
        binding = alice.call('GET', f'/v1/workspaces/{wid}/agents/{aid}/runtime')['body']['runtime']
        self.assertEqual(binding['instance_id'], iid)
        inst = alice.call('GET', f'/v1/instances/{iid}')['body']
        self.assertEqual(inst['instance']['workspace_id'] if 'instance' in inst else inst['workspace_id'], wid)
        bob_state = self.ensure(bob)['runtime_provisioning']
        self.assertNotEqual(bob_state['instance_id'], iid)
        # Bob can neither see nor bind Alice's instance; the binding is server-derived.
        self.assertEqual(bob.call('GET', f'/v1/instances/{iid}')['status'], 404)
        self.assertEqual(bob.call('GET', f'/v1/workspaces/{wid}/agents/{aid}/runtime')['status'], 404)
        bob_personal = self.ensure(bob)
        rebind = bob.call('POST', f"/v1/workspaces/{bob_personal['workspace']['id']}/agents/{bob_personal['agent']['id']}/runtime",
                          {'instance_id': iid, 'revision': 1})
        self.assertEqual(rebind['status'], 404)
        ids = {item['id'] for item in self.listed()}
        self.assertEqual(ids, {iid, bob_state['instance_id']})
        self.assertTrue(all(item['provisioning'] == 'auto' for item in self.listed()))

    def test_concurrent_ensure_creates_one_instance(self):
        self.make_app()
        alice = self.user('alice', '127.0.0.1')
        results, errors = [], []
        def go():
            try:
                with self.store.transaction() as db:
                    user = db.execute("SELECT * FROM users WHERE username='alice'").fetchone()
                    results.append(self.app.personal_agent_ensure(
                        db, {'user_id': user['id'], 'username': user['username']}, self.now))
            except Exception as error:  # pragma: no cover - surfaced below
                errors.append(error)
        threads = [threading.Thread(target=go) for _ in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(errors, [])
        self.assertTrue(all(r[0] in (200, 201) for r in results), results)
        self.assertEqual(self.count('SELECT COUNT(*) FROM instances'), 1)
        self.assertEqual(self.count('SELECT COUNT(*) FROM runtime_auto_provisions'), 1)
        self.assertEqual(self.count('SELECT COUNT(*) FROM workspace_agent_bindings'), 1)

    def test_global_cap_refuses_cleanly_with_actionable_chat_state(self):
        self.make_app(max_instances=1)
        alice, bob = self.user('alice', '127.0.0.1'), self.user('bob', '127.0.0.2')
        self.assertEqual(self.ensure(alice)['runtime_provisioning']['state'], 'provisioned')
        bob_personal = self.ensure(bob)
        self.assertEqual(bob_personal['runtime_provisioning']['state'], 'capacity')
        self.assertEqual(bob_personal['runtime_provisioning']['error_code'], 'runtime_capacity')
        self.assertEqual(self.count('SELECT COUNT(*) FROM instances'), 1)
        wid, aid = bob_personal['workspace']['id'], bob_personal['agent']['id']
        cid = bob.call('GET', f'/v1/workspaces/{wid}/agents/{aid}/conversations')['body']['items'][0]['id']
        sent = bob.call('POST', f'/v1/workspaces/{wid}/agents/{aid}/conversations/{cid}/messages',
                        {'body': 'hello'}, {'HTTP_IDEMPOTENCY_KEY': 'autoprov-cap-msg-00001'})
        self.assertEqual(sent['status'], 201, sent)
        self.assertEqual(sent['body']['reply']['error_code'], 'runtime_capacity')

    def test_lifecycle_capacity_maps_to_capacity(self):
        self.make_app()
        self.runtime.policy = RuntimePolicy(max_instances=1)
        alice, bob = self.user('alice', '127.0.0.1'), self.user('bob', '127.0.0.2')
        self.ensure(alice)
        self.assertEqual(self.ensure(bob)['runtime_provisioning']['state'], 'capacity')

    def test_explicit_binding_is_respected_not_duplicated(self):
        self.make_app(enabled=False)
        alice = self.user('alice', '127.0.0.1')
        personal = self.ensure(alice)
        wid, aid = personal['workspace']['id'], personal['agent']['id']
        inst = alice.call('POST', f'/v1/workspaces/{wid}/instances', {}, {'HTTP_IDEMPOTENCY_KEY': 'manual-instance-0001'})
        iid = inst['body']['instance']['id']
        self.assertEqual(alice.call('POST', f'/v1/workspaces/{wid}/agents/{aid}/runtime', {'instance_id': iid})['status'], 201)
        self.app.auto_provision = AutoProvisionPolicy(enabled=True, manager_id='auto-mgr', max_instances=5)
        state = self.ensure(alice)['runtime_provisioning']
        self.assertEqual((state['state'], state['instance_id']), ('bound', iid))
        self.assertEqual(self.count('SELECT COUNT(*) FROM instances'), 1)
        # Operator-enrolled instance is NOT visible to the auto manager.
        self.assertEqual(self.listed(), [])


    def test_workspace_create_reuses_personal_runtime(self):
        self.make_app()
        alice = self.user('alice', '127.0.0.1')
        personal = self.ensure(alice)
        iid = personal['runtime_provisioning']['instance_id']
        wid = 'a' * 32
        with self.store.transaction() as db:
            owner_id = db.execute("SELECT id FROM users WHERE username='alice'").fetchone()[0]
            db.execute('INSERT INTO workspaces VALUES(?,?,?,?,?,?)',
                       (wid, owner_id, 'another workspace', self.now, 'key', 'request'))
        result = alice.call('POST', f'/v1/workspaces/{wid}/instances', {},
                            {'HTTP_IDEMPOTENCY_KEY': 'another-instance-key'})
        self.assertEqual(result['status'], 200, result)
        self.assertEqual(result['body']['instance']['id'], iid)
        self.assertEqual(self.count('SELECT COUNT(*) FROM instances'), 1)

    def test_failed_create_shows_unavailable(self):
        self.make_app()
        alice = self.user('alice', '127.0.0.1')
        personal = self.ensure(alice)
        iid = personal['runtime_provisioning']['instance_id']
        claim = self.manager('POST', '/v1/internal/jobs/claim', {'instance_id': iid})['body']['claim']
        failed = self.manager('POST', f'/v1/internal/instances/{iid}/observe', {
            'job_id': claim['job']['id'], 'observed_revision': claim['job']['revision'], 'lease': claim['lease'],
            'observed': 'failed', 'error_code': 'runtime_failure'})
        self.assertEqual(failed['status'], 200, failed)
        state = self.ensure(alice)['runtime_provisioning']
        self.assertEqual(state['error_code'], 'runtime_unavailable')
        # No automatic start after a failed create.
        self.assertEqual(self.count("SELECT COUNT(*) FROM runtime_jobs WHERE instance_id=? AND operation_type='start'", iid), 0)

    def test_manager_scoping(self):
        self.make_app()
        alice, bob = self.user('alice', '127.0.0.1'), self.user('bob', '127.0.0.2')
        a = self.ensure(alice)['runtime_provisioning']['instance_id']
        # An operator-enrolled instance in Bob's own workspace, not granted to anyone.
        bob_ws = bob.workspace('bobspace', 'request_example_0009')['body']['workspace']['id']
        manual = bob.call('POST', f'/v1/workspaces/{bob_ws}/instances', {}, {'HTTP_IDEMPOTENCY_KEY': 'bob-manual-inst-0001'})
        m = manual['body']['instance']['id']
        self.assertEqual({i['id'] for i in self.listed()}, {a})
        for path in (f'/v1/internal/instances/{m}/heartbeat',):
            self.assertEqual(self.manager('POST', path, {'job_id': '0' * 32, 'observed_revision': 1, 'lease': 'x' * 43})['status'], 404)
        self.assertEqual(self.manager('POST', '/v1/internal/jobs/claim', {'instance_id': m})['status'], 404)
        # Another auto_provisioned manager sees none of auto-mgr's assignments.
        self.assertEqual(self.listed(token=self.other_token, name='other-mgr'), [])
        self.assertEqual(self.manager('POST', '/v1/internal/jobs/claim', {'instance_id': a},
                                      token=self.other_token, name='other-mgr')['status'], 404)

    def test_manager_without_auto_flag_sees_only_explicit_grants(self):
        self.make_app(auto_manager=False, enabled=False)
        self.app.manager_auth.identities['auto-mgr'] = ManagerIdentity('auto-mgr', digest(self.token), frozenset(), 'simulation', False)
        self.app.auto_provision = AutoProvisionPolicy(enabled=True, manager_id='auto-mgr', max_instances=5)
        alice = self.user('alice', '127.0.0.1')
        a = self.ensure(alice)['runtime_provisioning']['instance_id']
        self.assertEqual(self.listed(), [])
        self.assertEqual(self.manager('POST', '/v1/internal/jobs/claim', {'instance_id': a})['status'], 404)

    def test_startup_validation_fails_closed(self):
        store = Store(Path(tempfile.mkdtemp()) / 'state')
        runtime = Lifecycle(store)
        token = opaque()
        policy = AutoProvisionPolicy(enabled=True, manager_id='auto-mgr', max_instances=5)
        with self.assertRaises(ValueError):
            App(store, Config(ORIGIN), lifecycle=runtime, manager_auth=None, auto_provision=policy)
        plain = ManagerAuth([ManagerIdentity('auto-mgr', digest(token), frozenset(), 'simulation', False)])
        with self.assertRaises(ValueError):
            App(store, Config(ORIGIN), lifecycle=runtime, manager_auth=plain, auto_provision=policy)
        compose = ManagerAuth([ManagerIdentity('auto-mgr', digest(token), frozenset(), 'compose', True)])
        with self.assertRaises(ValueError):
            App(store, Config(ORIGIN), lifecycle=runtime, manager_auth=compose, auto_provision=policy)
        with self.assertRaises(ValueError):
            App(store, Config(ORIGIN), lifecycle=None, manager_auth=compose, auto_provision=policy)
        with self.assertRaises(ValueError):
            AutoProvisionPolicy(enabled=True, manager_id='auto-mgr', max_instances=0)
        with self.assertRaises(ValueError):
            AutoProvisionPolicy(enabled=True, manager_id=None, max_instances=3)
        with self.assertRaises(ValueError):
            AutoProvisionPolicy(enabled=True, manager_id='auto-mgr', max_instances=3, max_per_user=2)

    def test_operator_files(self):
        directory = Path(tempfile.mkdtemp())
        os.chmod(directory, 0o700)
        token = opaque()
        grants = directory / 'grants.json'
        grants.write_text(json.dumps([{'id': 'auto-mgr', 'credential_hash': digest(token), 'instance_ids': [],
                                       'backend_mode': 'compose', 'auto_provisioned': True}]))
        os.chmod(grants, 0o600)
        auth = load_manager_auth(grants)
        self.assertTrue(auth.identities['auto-mgr'].auto_provisioned)
        grants.write_text(json.dumps([{'id': 'auto-mgr', 'credential_hash': digest(token), 'instance_ids': [],
                                       'backend_mode': 'compose', 'auto_provisioned': 'yes'}]))
        with self.assertRaises(ValueError):
            load_manager_auth(grants)
        legacy = [{'id': 'm', 'credential_hash': digest(token), 'instance_ids': ['a' * 32], 'backend_mode': 'compose'}]
        grants.write_text(json.dumps(legacy))
        self.assertFalse(load_manager_auth(grants).identities['m'].auto_provisioned)
        auto = directory / 'auto.json'
        auto.write_text(json.dumps({'enabled': True, 'manager_id': 'auto-mgr', 'max_instances': 20}))
        os.chmod(auto, 0o600)
        policy = load_auto_provision(auto)
        self.assertEqual((policy.enabled, policy.manager_id, policy.max_instances, policy.max_per_user), (True, 'auto-mgr', 20, 1))
        auto.write_text(json.dumps({'enabled': True, 'manager_id': 'auto-mgr', 'max_instances': 20, 'extra': 1}))
        with self.assertRaises(ValueError):
            load_auto_provision(auto)
        os.chmod(auto, 0o644)
        with self.assertRaises(ValueError):
            load_auto_provision(auto)


if __name__ == '__main__':
    unittest.main()
