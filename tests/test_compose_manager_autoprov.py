"""poll-once discovers server auto-provisioned instances over real loopback HTTP; Docker is a stub."""
from contextlib import redirect_stdout
from dataclasses import replace
import io
import json
import unittest

import test_compose_manager as base
from openteamily.lifecycle import ManagerAuth, ManagerIdentity
from openteamily.dsbot_gateway import ensure_schema, owner_runtime_readiness, record_upstream
from openteamily.manager.__main__ import main
from openteamily.manager.engine import Registry
from openteamily.manager.safety import ManagerError
from openteamily.runtime_autoprovision import AutoProvisionPolicy
from openteamily.security import digest
from tests.test_management import Client


class AutoProvisionPollTests(unittest.TestCase):
    setUp = base.ComposeManagerTests.setUp
    start_http = base.ComposeManagerTests.start_http
    create = base.ComposeManagerTests.create
    manager = base.ComposeManagerTests.manager
    put_model_api = base.ComposeManagerTests.put_model_api

    def enable_auto(self, static=False):
        # The Docker stub models one project, so the auto-only manager has no static grant here.
        grants = frozenset([self.iid]) if static else frozenset()
        self.app.manager_auth = ManagerAuth([ManagerIdentity('manager-a', digest(self.token), grants, 'compose', True)])
        self.app.auto_provision = AutoProvisionPolicy(enabled=True, manager_id='manager-a', max_instances=3)

    def auto_instance(self, name='carol', peer='127.0.0.9', static=False):
        self.enable_auto(static)
        user = Client(self.app, peer=peer)
        registration = user.register(name)
        self.assertEqual(registration['status'], 201)
        owner = registration['body']['user']['id']
        # Before any home request, signup has already queued exactly one owner-scoped start.
        with self.store.connect() as db:
            first = db.execute(
                'SELECT p.instance_id, i.desired, j.operation_type, j.revision FROM runtime_auto_provisions p '
                'JOIN instances i ON i.id=p.instance_id JOIN runtime_jobs j ON j.instance_id=i.id WHERE p.user_id=?',
                (owner,),
            ).fetchall()
        self.assertEqual(len(first), 1)
        self.assertEqual(tuple(first[0])[1:], ('running', 'start', 1))
        state = user.call('POST', '/v1/personal-agent')['body']['personal_agent']['runtime_provisioning']
        self.assertEqual((state['state'], state['instance_id']), ('existing', first[0]['instance_id']))
        return state['instance_id']

    def poll(self):
        out = io.StringIO()
        with redirect_stdout(out):
            code = main(['--config', str(self.cfgpath), '--execute', 'poll-once'])
        return code, json.loads(out.getvalue())

    def test_poll_once_adopts_auto_instance_without_restart(self):
        self.start_http()
        self.put_model_api('platform', 'synthetic-platform-fixture-key')
        with self.store.transaction() as db:
            ensure_schema(db)
        auto = self.auto_instance()
        self.cfg['auto_instances'] = {'image': base.IMAGE, 'healthcheck': None}
        self.cfg['instances'] = {}
        self.cfgpath.write_text(json.dumps(self.cfg))
        code, first = self.poll()
        self.assertEqual(code, 0, first)
        self.assertEqual([r['instance_id'] for r in first['results']], [auto])
        by_id = {r['instance_id']: r for r in first['results']}
        self.assertEqual(by_id[auto]['status'], 'observed', first)
        self.assertEqual(by_id[auto]['observed'], 'running', first)
        self.assertEqual(by_id[auto]['revision'], 1)
        lease_files = self.root / 'secrets'
        config = json.loads((lease_files / ('model-api-' + auto + '.json')).read_text())
        self.assertEqual((config['source'], config['api_key']), ('platform', 'synthetic-platform-fixture-key'))
        with self.store.transaction() as db:
            owner = db.execute('SELECT owner_id FROM instances WHERE id=?', (auto,)).fetchone()[0]
            self.assertEqual(db.execute('SELECT COUNT(*) FROM runtime_jobs WHERE instance_id=?', (auto,)).fetchone()[0], 1)
            self.assertEqual(owner_runtime_readiness(db, owner), 'starting')
            record_upstream(db, auto, '10.0.0.1:8080', 'dsh-auth-fixture=' + 'x' * 24, self.now)
            self.assertEqual(owner_runtime_readiness(db, owner), 'ready')
        # A repeat poll cannot enqueue or run an additional startup.
        code, second = self.poll()
        self.assertEqual(code, 0, second)
        by_id = {r['instance_id']: r for r in second['results']}
        self.assertEqual(by_id[auto]['status'], 'no_claim', second)
        manager_cfg = json.loads(self.cfgpath.read_text())
        self.assertNotIn(auto, manager_cfg['instances'])  # never written back

    def test_signup_remains_valid_when_personal_workspace_has_no_capacity(self):
        self.enable_auto()
        self.app.config = replace(self.app.config, max_workspaces=1)
        user = Client(self.app, peer='127.0.0.9')
        self.assertEqual(user.register('carol')['status'], 201)
        self.assertEqual(user.call('GET', '/v1/auth/session')['status'], 200)
        self.assertEqual(user.call('GET', '/v1/personal-agent')['body'], {'personal_agent': None})
        self.assertEqual(user.call('POST', '/v1/personal-agent')['status'], 429)
        self.app.config = replace(self.app.config, max_workspaces=10)
        provisioning = user.call('POST', '/v1/personal-agent')['body']['personal_agent']['runtime_provisioning']
        self.assertEqual(provisioning['state'], 'provisioned')
        self.assertEqual(user.call('GET', '/v1/instances/' + provisioning['instance_id'])['body']['instance']['desired'], 'running')

    def test_without_template_auto_instance_is_skipped(self):
        self.start_http()
        auto = self.auto_instance(static=True)
        code, result = self.poll()
        self.assertEqual(code, 0, result)
        by_id = {r['instance_id']: r for r in result['results']}
        self.assertEqual(by_id[auto]['status'], 'skipped')

    def test_adopt_requires_matching_auto_snapshot(self):
        self.cfg['auto_instances'] = {'image': base.IMAGE, 'healthcheck': None}
        self.cfgpath.write_text(json.dumps(self.cfg))
        registry = Registry(str(self.cfgpath))
        iid = 'b' * 32
        good = {'id': iid, 'provisioning': 'auto', 'backend_mode': 'compose', 'image_ref': base.IMAGE, 'volume_ref': 'ot-' + iid}
        for bad in ({**good, 'provisioning': 'operator'}, {**good, 'image_ref': 'other/image@sha256:' + 'b' * 64},
                    {**good, 'volume_ref': 'ot-' + 'c' * 32}, {**good, 'id': 'c' * 32}):
            with self.assertRaises(ManagerError):
                registry.adopt(iid, bad)
        with self.assertRaises(ManagerError):
            registry.adopt(self.iid, {**good, 'id': self.iid, 'volume_ref': 'ot-' + self.iid})
        self.assertEqual(registry.adopt(iid, good)['publish_port'], None)
        entry, _ = registry.entry(iid, good)
        self.assertEqual(entry['image'], base.IMAGE)


if __name__ == '__main__':
    unittest.main()
