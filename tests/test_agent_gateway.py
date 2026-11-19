"""External Agent API gateway (issues #11 #2). Labeled local fake runtime; no vendor is contacted."""
import unittest

from tests import test_agent_chat_infer as infer_tests
from tests.test_runtime_connect import AgentClient



class AgentGatewayTests(unittest.TestCase):
    setUp = infer_tests.AgentChatInferTests.setUp
    online_agent = infer_tests.AgentChatInferTests.online_agent
    finish_infer = infer_tests.AgentChatInferTests.finish_infer

    def keys(self):
        return f'/v1/workspaces/{self.wid}/agents/{self.agent["id"]}/api-keys'

    def issue(self, client=None, **body):
        return (client or self.alice).call('POST', self.keys(), {'name': 'CI caller', **body})

    def invoke(self, caller, prompt='请问好', key='gateway-invoke-0001', agent_id=None, **extra):
        return caller.call('POST', f'/v1/gateway/agents/{agent_id or self.agent["id"]}/invocations',
                           {'prompt': prompt}, HTTP_IDEMPOTENCY_KEY=key, **extra)

    def test_issue_invoke_poll_and_revoke(self):
        issued = self.issue(rate_per_minute=5)
        self.assertEqual(issued['status'], 201, issued)
        token = issued['body']['token']
        self.assertNotIn(token, str(self.alice.call('GET', self.keys())['body']))
        _, runtime = self.online_agent()
        caller = AgentClient(self.app, token)
        started = self.invoke(caller)
        self.assertEqual(started['status'], 202, started)
        inv = started['body']['invocation']
        self.assertEqual((inv['status'], inv['reply']), ('queued', None))
        self.assertEqual(self.invoke(caller)['body']['invocation']['id'], inv['id'])  # idempotent replay
        self.assertEqual(self.invoke(caller, prompt='别的')['status'], 409)
        tasks = runtime.call('GET', '/v1/agent/tasks')['body']['items']
        self.assertEqual(len(tasks), 1)
        self.assertIn('User: 请问好', tasks[0]['prompt'])
        self.finish_infer(runtime, tasks[0]['id'], text='[FAKE PROVIDER] 你好')
        polled = caller.call('GET', f'/v1/gateway/invocations/{inv["id"]}')
        self.assertEqual((polled['body']['invocation']['status'], polled['body']['invocation']['reply']),
                         ('succeeded', '[FAKE PROVIDER] 你好'))
        listed = self.alice.call('GET', self.keys())['body']['items'][0]
        self.assertEqual(listed['last_used'], self.now)
        revoked = self.alice.call('POST', self.keys() + f'/{listed["id"]}/revoke', {})
        self.assertTrue(revoked['body']['key']['revoked'])
        self.assertEqual(caller.call('GET', f'/v1/gateway/invocations/{inv["id"]}')['status'], 401)

    def test_auth_scope_rate_and_errors(self):
        token = self.issue(rate_per_minute=2)['body']['token']
        caller = AgentClient(self.app, token)
        self.assertEqual(AgentClient(self.app, 'x' * 43).call('GET', '/v1/gateway/invocations/' + '0' * 32)['status'], 401)
        self.assertEqual(caller.call('GET', '/v1/gateway/invocations/' + '0' * 32, auth=False)['status'], 401)
        self.assertEqual(caller.call('GET', '/v1/gateway/invocations/' + '0' * 32, cookie='ot_session=1')['status'], 401)
        self.assertEqual(caller.call('GET', '/v1/gateway/invocations/' + '0' * 32,
                                     origin='https://management.test')['status'], 401)
        self.assertEqual(self.invoke(caller, agent_id='f' * 32)['status'], 403)
        self.assertEqual(self.invoke(caller, prompt='')['status'], 400)
        self.assertEqual(caller.call('POST', f'/v1/gateway/agents/{self.agent["id"]}/invocations',
                                     {'prompt': 'x'})['status'], 400)  # no Idempotency-Key
        # No runtime is online: the invocation is recorded as an honest failure, not a fake reply.
        failed = self.invoke(caller, key='gateway-invoke-0002')
        self.assertEqual((failed['status'], failed['body']['invocation']['status'],
                          failed['body']['invocation']['error_code']), (202, 'failed', 'no_agent'))
        self.assertEqual(self.invoke(caller, key='gateway-invoke-0003')['status'], 202)
        self.assertEqual(self.invoke(caller, key='gateway-invoke-0004')['status'], 429)
        self.now += 60
        self.assertEqual(self.invoke(caller, key='gateway-invoke-0005')['status'], 202)
        self.assertEqual(caller.call('GET', '/v1/gateway/invocations/' + '0' * 32)['status'], 404)

    def test_management_permissions_and_creator_access(self):
        self.assertEqual(self.issue(self.bob)['status'], 403)  # plain member
        for bad in ({'name': ''}, {'name': 'k', 'rate_per_minute': 0}, {'name': 'k', 'rate_per_minute': 61}):
            self.assertEqual(self.alice.call('POST', self.keys(), bad)['status'], 400, bad)
        self.assertIn(self.alice.call('POST', self.keys(), {'name': 'k'}, csrf=False)['status'], (401, 403))
        # A key stops working when its creator loses admin rights.
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/members/{self.bob.call("GET", "/v1/auth/session")["body"]["user"]["id"]}',
                        {'role': 'admin'})
        bob_token = self.issue(self.bob)['body']['token']
        bob_caller = AgentClient(self.app, bob_token)
        self.assertEqual(self.invoke(bob_caller, key='gateway-invoke-0010')['status'], 202)
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/members/{self.bob.call("GET", "/v1/auth/session")["body"]["user"]["id"]}',
                        {'role': 'member'})
        self.assertEqual(self.invoke(bob_caller, key='gateway-invoke-0011')['status'], 401)


if __name__ == '__main__':
    unittest.main()
