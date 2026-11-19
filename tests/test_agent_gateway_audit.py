"""Workspace Agent API gateway audit overview (issue #131 reuse)."""
import io
import json
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class BearerClient:
    def __init__(self, app, token, peer='127.0.0.1'):
        self.app, self.token, self.peer = app, token, peer

    def call(self, method, path, body=None, origin=None, cookie=None, key=None):
        payload = json.dumps(body if body is not None else {}).encode()
        if method == 'GET' and body is None:
            payload = b''
        env = {'REQUEST_METHOD': method, 'PATH_INFO': path, 'QUERY_STRING': '',
               'HTTP_HOST': 'management.test', 'REMOTE_ADDR': self.peer,
               'CONTENT_TYPE': 'application/json', 'CONTENT_LENGTH': str(len(payload)),
               'wsgi.input': io.BytesIO(payload),
               'HTTP_AUTHORIZATION': 'Bearer ' + self.token}
        if key:
            env['HTTP_IDEMPOTENCY_KEY'] = key
        if origin is not None:
            env['HTTP_ORIGIN'] = origin
        if cookie is not None:
            env['HTTP_COOKIE'] = cookie
        result = {}
        def start(status, values):
            result['status'], result['headers'] = int(status.split()[0]), values
        result['body'] = json.loads(b''.join(self.app(env, start)))
        return result


class GatewayAuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'state'
        self.app = App(Store(self.path), Config(ORIGIN, allow_registration=True),
                       clock=lambda: 1800000000)
        self.alice = Client(self.app)
        self.alice.register('alice')
        self.bob = Client(self.app, peer='127.0.0.2')
        self.bob.register('bob')
        self.eve = Client(self.app, peer='127.0.0.3')
        self.eve.register('eve')
        self.wid = self.alice.workspace()['body']['workspace']['id']
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/members', {'username': 'bob', 'role': 'member'})
        agent = self.alice.call('POST', f'/v1/workspaces/{self.wid}/agents', {'name': '外部助手'},
                                {'HTTP_IDEMPOTENCY_KEY': 'gateway-agent-0001'})
        self.aid = agent['body']['agent']['id']
        key = self.alice.call('POST', f'/v1/workspaces/{self.wid}/agents/{self.aid}/api-keys',
                              {'name': '站点', 'rate_per_minute': 10})
        self.token = key['body']['token']

    def overview(self, client=None, query=''):
        return (client or self.alice).call('GET', f'/v1/workspaces/{self.wid}/gateway/overview{query}')

    def test_overview_lists_keys_and_invocations(self):
        api = BearerClient(self.app, self.token)
        invoked = api.call('POST', f'/v1/gateway/agents/{self.aid}/invocations',
                           {'prompt': '外部请求'}, key='gateway-invoke-0001')
        self.assertEqual(invoked['status'], 202, invoked)
        result = self.overview()
        self.assertEqual(result['status'], 200, result)
        self.assertEqual(len(result['body']['keys']), 1)
        key = result['body']['keys'][0]
        self.assertEqual(key['agent_name'], '外部助手')
        self.assertEqual(key['scope'], 'invoke')
        self.assertNotIn('token', key)
        self.assertEqual(len(result['body']['invocations']), 1)
        invocation = result['body']['invocations'][0]
        self.assertEqual(invocation['agent_name'], '外部助手')
        self.assertIn(invocation['status'], ('failed', 'queued'))
        self.assertNotIn(self.token, str(result['body']))
        self.assertNotIn('prompt', str(result['body']))
        self.assertEqual(self.overview(self.bob)['status'], 403)
        self.assertEqual(self.overview(self.eve)['status'], 404)
        self.assertEqual(self.overview(query='?limit=0')['status'], 400)
        self.assertEqual(self.overview(query='?limit=101')['status'], 400)

    def test_revoke_is_reflected_and_stops_the_key(self):
        key = self.overview()['body']['keys'][0]
        revoked = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/agents/{self.aid}/api-keys/{key["id"]}/revoke', {})
        self.assertEqual(revoked['status'], 200, revoked)
        result = self.overview()
        self.assertTrue(result['body']['keys'][0]['revoked'])
        api = BearerClient(self.app, self.token)
        self.assertEqual(api.call('POST', f'/v1/gateway/agents/{self.aid}/invocations',
                                  {'prompt': 'x'}, key='gateway-invoke-0002')['status'], 401)
        with self.app.store.connect() as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 1)


if __name__ == '__main__':
    unittest.main()
