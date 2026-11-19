"""Synthetic Composio + management + FlyBot integration. NO vendor requests."""
import io
import json
import threading
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from openteamily import connected_tools
from openteamily.flybot import AgentError, connected_tool_bridge, infer_chat
from tests import test_composio
from tests.test_composio import FakeComposio, ALICE_KEY, BOB_KEY
from tests.test_runtime_connect import AgentClient


class FakeTools(FakeComposio):
    def __init__(self):
        super().__init__()
        self.executions = []
        self.tool_fail = False

    def __call__(self, method, url, headers, body):
        parts = urlsplit(url)
        path = parts.path.removeprefix('/api/v3.1')
        if path == '/tools':
            toolkit = parse_qs(parts.query)['toolkit_slug'][0]
            tool = {'slug': 'GITHUB_GET_USER', 'description': 'Read synthetic profile', 'toolkit': {'slug': toolkit},
                    'version': '20261101_01', 'input_parameters': {'type': 'object', 'properties': {'username': {'type': 'string'}}}}
            bad = {**tool, 'slug': 'COMPOSIO_MULTI_EXECUTE_TOOL'}
            foreign = {**tool, 'slug': 'SLACK_SEND_MESSAGE', 'toolkit': {'slug': 'slack'}}
            return 200, json.dumps({'items': [tool, bad, foreign]}).encode()
        if path.startswith('/tools/execute/'):
            self.executions.append({'body': json.loads(body), 'key': headers['x-api-key']})
            if self.tool_fail:
                raise TimeoutError('synthetic upstream timeout after possible mutation')
            return 200, json.dumps({'successful': True, 'error': None, 'data': {'login': 'synthetic',
                                    'api_key': ALICE_KEY, 'echo': ALICE_KEY}}).encode()
        return super().__call__(method, url, headers, body)


class ConnectedToolsTests(unittest.TestCase):
    set_key = test_composio.ComposioTests.set_key
    connect = test_composio.ComposioTests.connect
    # Reuse the key/isolation test harness as well as its existing regressions.
    def setUp(self):
        test_composio.ComposioTests.setUp(self)
        self.now = 1800000000
        self.app.clock = lambda: self.now
        self.fake = FakeTools()
        self.app.composio_transport = self.fake
        self.set_key(self.alice, ALICE_KEY)
        self.record = self.connect(self.alice)['body']['connection']
        self.fake.accounts['ca_0001']['status'] = 'ACTIVE'
        self.alice.call('GET', '/v1/composio/connections')
        self.token = self.alice.call('POST', '/v1/runtime-keys', {'name': 'synthetic'})['body']['token']
        self.agent = AgentClient(self.app, self.token)
        self.agent.call('POST', '/v1/agent/connect', {'hostname': 'fake-runtime'})
        self.task = self.alice.call('POST', '/v1/runtime/tasks', {'kind': 'infer', 'prompt': 'read my synthetic profile'})['body']['task']
        self.agent.call('POST', f"/v1/agent/tasks/{self.task['id']}/claim", {})
        self.path = f"/v1/agent/tasks/{self.task['id']}/tools"

    def discover(self):
        result = self.agent.call('POST', self.path, {})
        self.assertEqual(result['status'], 200, result)
        return result['body']

    def propose(self, call_id='call_1', **extra):
        result = self.agent.call('POST', self.path + '/calls',
                                 {'call_id': call_id, 'name': 'GITHUB_GET_USER', 'arguments': {'username': 'synthetic'}, **extra})
        return result

    def approval(self, cid, decision='approve', client=None, **kwargs):
        return (client or self.alice).call('POST', '/v1/composio/approvals/' + cid, {'decision': decision}, **kwargs)

    def execute(self, cid):
        return self.agent.call('POST', self.path + '/calls/' + cid, {})

    def test_discovery_approval_execute_no_key_leak_and_exactly_once(self):
        discovery = self.discover()
        self.assertEqual([t['function']['name'] for t in discovery['tools']], ['GITHUB_GET_USER'])
        proposal = self.propose()['body']['call']
        self.assertEqual(proposal['status'], 'pending')
        self.assertEqual(self.execute(proposal['id'])['body']['call']['status'], 'pending')
        self.assertEqual(self.fake.executions, [])
        listing = self.alice.call('GET', '/v1/composio/approvals')['body']['items']
        self.assertEqual(listing[0]['arguments'], {'username': 'synthetic'})
        self.assertEqual(self.approval(proposal['id'])['status'], 200)
        execution = self.execute(proposal['id'])
        self.assertEqual(execution['body']['call']['status'], 'succeeded', execution)
        self.assertNotIn(ALICE_KEY, json.dumps(execution))
        self.assertEqual(self.fake.executions[0]['body']['connected_account_id'], 'ca_0001')
        self.assertEqual(self.fake.executions[0]['body']['version'], '20261101_01')
        self.assertEqual(self.fake.executions[0]['key'], ALICE_KEY)
        self.execute(proposal['id'])
        self.assertEqual(len(self.fake.executions), 1)
        self.assertEqual(self.propose()['body']['call']['id'], proposal['id'])
        self.assertEqual(self.propose(arguments={'username': 'different'})['status'], 409)

    def test_unregistered_tool_and_foreign_actor_are_blocked(self):
        self.assertEqual(self.propose()['status'], 403)
        self.discover()
        self.assertEqual(self.propose(name='COMPOSIO_MULTI_EXECUTE_TOOL')['status'], 403)
        self.assertEqual(self.propose(name='SLACK_SEND_MESSAGE')['status'], 403)
        cid = self.propose()['body']['call']['id']
        self.assertEqual(self.approval(cid, client=self.bob)['status'], 404)
        self.assertEqual(self.approval(cid, csrf=False)['status'], 403)
        self.assertEqual(self.bob.call('GET', '/v1/composio/approvals')['body']['items'], [])
        other_token = self.bob.call('POST', '/v1/runtime-keys', {'name': 'bob'})['body']['token']
        other = AgentClient(self.app, other_token)
        other.call('POST', '/v1/agent/connect', {'hostname': 'other'})
        self.assertEqual(other.call('POST', self.path, {})['status'], 404)
        self.assertEqual(other.call('POST', self.path + '/calls/' + cid, {})['status'], 404)
        self.assertEqual(self.fake.executions, [])

    def test_denied_and_expired_calls_never_execute(self):
        self.discover()
        cid = self.propose()['body']['call']['id']
        self.assertEqual(self.approval(cid, 'deny')['status'], 200)
        self.assertEqual(self.execute(cid)['body']['call']['status'], 'denied')
        self.assertEqual(self.approval(cid)['status'], 409)
        second = self.propose('call_2')['body']['call']['id']
        self.now += 1000
        self.app.clock = lambda: self.now
        self.assertEqual(self.approval(second)['status'], 409)
        self.assertEqual(self.execute(second)['status'], 409)
        self.assertEqual(self.fake.executions, [])

    def test_disconnect_key_rotation_and_revocation_block_execution(self):
        self.discover()
        cid = self.propose()['body']['call']['id']
        self.approval(cid)
        self.alice.call('POST', f"/v1/composio/connections/{self.record['id']}/disconnect", {})
        self.assertEqual(self.execute(cid)['status'], 409)
        self.assertEqual(self.fake.executions, [])
        self.set_key(self.alice, 'synthetic-key-replacement')
        self.assertEqual(self.propose('call_2')['status'], 403)
        self.set_key(self.alice, None)
        self.assertEqual(self.agent.call('POST', self.path, {})['status'], 409)
        self.assertEqual(self.fake.executions, [])

    def test_provider_revoked_and_timeout_are_not_retried(self):
        self.discover()
        cid = self.propose()['body']['call']['id']
        self.approval(cid)
        self.fake.accounts['ca_0001']['status'] = 'REVOKED'
        self.assertEqual(self.execute(cid)['body']['call']['status'], 'failed')
        self.assertEqual(self.fake.executions, [])
        self.fake.accounts['ca_0001']['status'] = 'ACTIVE'
        cid = self.propose('call_2')['body']['call']['id']
        self.approval(cid)
        self.fake.tool_fail = True
        self.assertEqual(self.execute(cid)['body']['call']['status'], 'unknown')
        self.execute(cid)
        self.assertEqual(len(self.fake.executions), 1)

    def test_cancelled_task_no_tools_and_shared_work_no_personal_grant(self):
        self.alice.call('POST', f"/v1/runtime/tasks/{self.task['id']}/cancel", {})
        self.assertEqual(self.agent.call('POST', self.path, {})['status'], 409)
        workspace = self.alice.workspace()['body']['workspace']['id']
        shared = self.alice.call('POST', '/v1/runtime/tasks', {'kind': 'infer', 'prompt': 'shared task', 'workspace_id': workspace})['body']['task']
        self.agent.call('POST', f"/v1/agent/tasks/{shared['id']}/claim", {})
        self.assertEqual(self.agent.call('POST', f"/v1/agent/tasks/{shared['id']}/tools", {})['status'], 403)

    def test_concurrent_execution_consumes_approval_once(self):
        self.discover()
        cid = self.propose()['body']['call']['id']
        self.approval(cid)
        results = []
        threads = [threading.Thread(target=lambda: results.append(self.execute(cid))) for _ in range(2)]
        for thread in threads: thread.start()
        for thread in threads: thread.join()
        self.assertEqual(len(self.fake.executions), 1)
        self.assertTrue(all(r['status'] == 200 for r in results), results)

    def test_runtime_key_revocation_and_owner_key_isolation(self):
        self.discover()
        cid = self.propose()['body']['call']['id']
        self.set_key(self.bob, BOB_KEY)
        bob_token = self.bob.call('POST', '/v1/runtime-keys', {'name': 'bob'})['body']['token']
        bob_agent = AgentClient(self.app, bob_token)
        bob_agent.call('POST', '/v1/agent/connect', {'hostname': 'bob'})
        self.assertEqual(bob_agent.call('POST', self.path + '/calls/' + cid, {})['status'], 404)
        self.approval(cid)
        with self.app.store.transaction() as db:
            db.execute('UPDATE runtime_keys SET revoked=1')
        self.assertEqual(self.execute(cid)['status'], 401)
        self.assertEqual(self.fake.executions, [])

    def test_other_composio_owner_and_removed_membership_fail_closed(self):
        self.fake.accounts['ca_0001']['user_id'] = 'another-owner'
        self.assertEqual(self.discover()['tools'], [])
        self.assertEqual(self.propose()['status'], 403)
        self.assertEqual(self.fake.executions, [])

    def test_deprecated_upstream_owner_field_can_be_omitted(self):
        # Composio deprecates user_id on GET account responses. Ownership still
        # comes from our local task/connection mapping; contradictory nonempty
        # upstream identities remain rejected by the adjacent test.
        for value in (None, ''):
            self.fake.accounts['ca_0001']['user_id'] = value
            self.assertEqual(len(self.discover()['tools']), 1)

    def test_private_conversation_grants_same_owner_and_revokes_with_membership(self):
        workspace = self.alice.workspace()['body']['workspace']['id']
        self.alice.call('POST', f'/v1/workspaces/{workspace}/members', {'username': 'bob', 'role': 'member'})
        created = self.alice.call('POST', f'/v1/workspaces/{workspace}/agents',
                                  {'name': 'Synthetic', 'summary': '', 'instructions': 'Read connected profile.'},
                                  {'HTTP_IDEMPOTENCY_KEY': 'connected-tools-agent-0001'})
        self.assertEqual(created['status'], 201, created)
        agent_id = created['body']['agent']['id']
        path = f'/v1/workspaces/{workspace}/agents/{agent_id}/conversations'
        conv = self.alice.call('POST', path, {'title': 'Tool test'}, {'HTTP_IDEMPOTENCY_KEY': 'connected-tools-conv-0001'})
        conv_id = conv['body']['conversation']['id']
        sent = self.alice.call('POST', path + '/' + conv_id + '/messages', {'body': 'Read my profile'},
                               {'HTTP_IDEMPOTENCY_KEY': 'connected-tools-message-0001'})
        self.assertEqual(sent['status'], 201, sent)
        tid = sent['body']['reply']['task_id']
        self.agent.call('POST', f'/v1/agent/tasks/{tid}/claim', {})
        self.assertEqual(self.agent.call('POST', f'/v1/agent/tasks/{tid}/tools', {})['status'], 200)
        with self.app.store.transaction() as db:
            # Simulate lost membership by removing this personal task owner from
            # the workspace view (owner still owns the runtime, not a valid member).
            db.execute('UPDATE workspaces SET owner_id=(SELECT id FROM users WHERE username=?) WHERE id=?', ('bob', workspace))
            db.execute('DELETE FROM workspace_members WHERE workspace_id=?', (workspace,))
        self.assertEqual(self.agent.call('POST', f'/v1/agent/tasks/{tid}/tools', {})['status'], 403)

    def test_synthetic_python_model_tool_roundtrip(self):
        # In-process WSGI requester + fake model response: approval is simulated
        # by the owner client, never a live third-party mutation.
        def requester(origin, method, path, token, body):
            result = self.agent.call(method, path, body)
            if result['status'] >= 400: raise AgentError(result['status'], result['body'])
            return result['status'], result['body']
        def approve(_delay):
            items = self.alice.call('GET', '/v1/composio/approvals')['body']['items']
            for item in items:
                if item['status'] == 'pending': self.approval(item['id'])
        tools, execute = connected_tool_bridge(self.task, 'https://management.test', self.token, requester,
                                               sleeper=approve, clock=lambda: self.now)
        bodies = []
        def opener(req, **_kwargs):
            body = json.loads(req.data)
            bodies.append(body)
            message = ({'tool_calls': [{'id': 'call_1', 'type': 'function', 'function': {'name': 'GITHUB_GET_USER',
                        'arguments': '{"username":"synthetic"}'}}], 'content': None} if len(bodies) == 1
                       else {'content': 'Profile read from synthetic tool.'})
            return io.BytesIO(json.dumps({'choices': [{'message': message}]}).encode())
        text = infer_chat({'provider': 'openai', 'base_url': 'https://model.invalid/v1', 'model': 'fake', 'api_key': 'model-fake-key'},
                          'read profile', opener=opener, tools=tools, execute_tool=execute)
        self.assertEqual(text, 'Profile read from synthetic tool.')
        self.assertEqual(bodies[1]['messages'][-1]['role'], 'tool')
        self.assertEqual(len(self.fake.executions), 1)
        self.assertNotIn(ALICE_KEY, json.dumps(bodies))


if __name__ == '__main__': unittest.main()
