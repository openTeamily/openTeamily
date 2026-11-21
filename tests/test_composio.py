"""Per-user Composio connections. In-process WSGI, temporary SQLite and a fake
Composio HTTP transport only; no network and no real Composio key."""
from pathlib import Path
import json
import tempfile
import unittest
from urllib.parse import parse_qs, urlsplit

from openteamily import composio
from openteamily.app import App, Config
from openteamily.fake_runtime import FakeRuntimeBackend
from openteamily.store import Store
from tests.test_management import Client, ORIGIN

ALICE_KEY = 'ak_alice_fake_composio_key_0001'
BOB_KEY = 'ak_bob_fake_composio_key_0002'


class FakeComposio:
    """Records every call; answers like Composio REST v3.1."""

    def __init__(self):
        self.calls = []
        self.accounts = {}
        self.fail = None
        self.counter = 0

    def __call__(self, method, url, headers, body):
        parts = urlsplit(url)
        path = parts.path.removeprefix('/api/v3.1')
        payload = json.loads(body) if body else None
        self.calls.append({'method': method, 'path': path, 'query': parse_qs(parts.query),
                           'key': headers.get('x-api-key'), 'body': payload})
        if self.fail:
            return self.fail
        if method == 'GET' and path == '/toolkits':
            return 200, json.dumps({'items': [
                {'slug': 'github', 'name': 'GitHub', 'auth_schemes': ['OAUTH2'],
                 'composio_managed_auth_schemes': ['OAUTH2'],
                 'meta': {'description': 'Code hosting', 'logo': 'https://logos.example/github.png'}},
            ], 'next_cursor': None, 'total_pages': 1, 'current_page': 1, 'total_items': 1}).encode()
        if method == 'POST' and path == '/tool_router/session':
            return 201, json.dumps({'session_id': 'trs_' + str(len(self.calls)),
                                    'mcp': {'type': 'http', 'url': 'https://mcp.example/x'}}).encode()
        if method == 'POST' and path.startswith('/tool_router/session/') and path.endswith('/link'):
            self.counter += 1
            account = f'ca_{self.counter:04d}'
            user = next(c['body']['user_id'] for c in reversed(self.calls) if c['path'] == '/tool_router/session')
            self.accounts[account] = {'id': account, 'status': 'INITIATED', 'toolkit': {'slug': payload['toolkit']},
                                      'user_id': user, 'key': headers.get('x-api-key'), 'status_reason': None}
            return 201, json.dumps({'link_token': 'lt_x', 'connected_account_id': account,
                                    'redirect_url': 'https://connect.composio.dev/link/lt_x'}).encode()
        if path.startswith('/connected_accounts/'):
            account = self.accounts.get(path.rsplit('/', 1)[1])
            if account is None or account['key'] != headers.get('x-api-key'):
                return 404, json.dumps({'error': {'message': 'not found', 'code': 404, 'slug': 'x', 'status': 404}}).encode()
            if method == 'DELETE':
                del self.accounts[account['id']]
                return 200, b'{"success":true}'
            return 200, json.dumps({k: v for k, v in account.items() if k != 'key'}).encode()
        if method == 'GET' and path == '/connected_accounts':
            users = parse_qs(parts.query).get('user_ids', [])
            items = [{k: v for k, v in a.items() if k != 'key'} for a in self.accounts.values()
                     if a['user_id'] in users and a['key'] == headers.get('x-api-key')]
            return 200, json.dumps({'items': items, 'next_cursor': None, 'total_pages': 1,
                                    'current_page': 1, 'total_items': len(items)}).encode()
        return 404, b'{}'


class ComposioTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.fake = FakeComposio()
        self.app = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                       clock=lambda: 1800000000, automation_backend=FakeRuntimeBackend(),
                       composio_transport=self.fake)
        self.alice = Client(self.app)
        self.alice.register('alice')
        self.bob = Client(self.app)
        self.bob.register('bob')

    def set_key(self, client, key):
        return client.call('POST', '/v1/composio/key', {'api_key': key})

    def connect(self, client, toolkit='github'):
        return client.call('POST', '/v1/composio/connections', {'toolkit': toolkit})

    def test_missing_key_is_not_configured_and_makes_no_upstream_call(self):
        view = self.alice.call('GET', '/v1/composio')
        self.assertEqual(view['status'], 200)
        self.assertFalse(view['body']['composio']['configured'])
        self.assertIsNone(view['body']['composio']['key_hint'])
        self.assertIn({'id': 'github', 'toolkit': 'github', 'managed': 'yes'}, view['body']['catalog'])
        for method, path, body in [('POST', '/v1/composio/connections', {'toolkit': 'github'}),
                                   ('GET', '/v1/composio/connections', None),
                                   ('GET', '/v1/composio/toolkits', None)]:
            result = self.alice.call(method, path, body)
            self.assertEqual(result['status'], 409, (path, result))
            self.assertEqual(result['body']['error']['code'], 'composio_not_configured')
        self.assertEqual(self.fake.calls, [])

    def test_there_is_no_server_wide_fallback_key(self):
        import os
        os.environ['COMPOSIO_API_KEY'] = 'env_key_must_never_be_used'
        self.addCleanup(os.environ.pop, 'COMPOSIO_API_KEY', None)
        result = self.connect(self.alice)
        self.assertEqual(result['status'], 409)
        self.assertEqual(self.fake.calls, [])

    def test_key_is_masked_updated_and_removed(self):
        saved = self.set_key(self.alice, ALICE_KEY)
        self.assertEqual(saved['status'], 200, saved)
        self.assertEqual(saved['body']['composio'], {'configured': True, 'key_hint': '••••0001', 'revision': 1})
        self.assertNotIn(ALICE_KEY, json.dumps(saved))
        seen = self.alice.call('GET', '/v1/composio')
        self.assertNotIn(ALICE_KEY, json.dumps(seen))
        self.assertTrue(seen['body']['composio']['configured'])
        raw = (Path(self.temp.name) / 'state' / 'management.sqlite3').read_bytes()
        self.assertNotIn(ALICE_KEY.encode(), raw)
        updated = self.set_key(self.alice, 'ak_alice_second_key_9999')
        self.assertEqual(updated['body']['composio']['revision'], 2)
        self.assertEqual(updated['body']['composio']['key_hint'], '••••9999')
        removed = self.set_key(self.alice, None)
        self.assertEqual(removed['body']['composio'], {'configured': False, 'key_hint': None, 'revision': 0})
        self.assertEqual(self.connect(self.alice)['status'], 409)

    def test_invalid_key_and_csrf_are_rejected(self):
        self.assertEqual(self.set_key(self.alice, 'short')['status'], 400)
        self.assertEqual(self.set_key(self.alice, 'has a space in it')['status'], 400)
        no_csrf = self.alice.call('POST', '/v1/composio/key', {'api_key': ALICE_KEY}, csrf=False)
        self.assertEqual(no_csrf['status'], 403)
        anonymous = Client(self.app).call('GET', '/v1/composio')
        self.assertEqual(anonymous['status'], 401)

    def test_connect_flow_polls_to_connected_lists_and_disconnects(self):
        self.set_key(self.alice, ALICE_KEY)
        started = self.connect(self.alice)
        self.assertEqual(started['status'], 201, started)
        self.assertEqual(started['body']['redirect_url'], 'https://connect.composio.dev/link/lt_x')
        connection = started['body']['connection']
        self.assertEqual(connection['state'], 'connecting')
        self.assertEqual(connection['catalog_id'], 'github')
        session_call = next(c for c in self.fake.calls if c['path'] == '/tool_router/session')
        alice_id = self.alice.call('GET', '/v1/auth/session')['body']['user']['id']
        self.assertEqual(session_call['body']['user_id'], 'openteamily-' + alice_id)
        link_call = next(c for c in self.fake.calls if c['path'].endswith('/link'))
        self.assertEqual(link_call['body']['callback_url'], ORIGIN + '/v1/composio/callback')
        self.assertTrue(all(c['key'] == ALICE_KEY for c in self.fake.calls))
        polled = self.alice.call('GET', f"/v1/composio/connections/{connection['id']}")
        self.assertEqual(polled['body']['connection']['state'], 'connecting')
        self.fake.accounts['ca_0001']['status'] = 'ACTIVE'
        polled = self.alice.call('GET', f"/v1/composio/connections/{connection['id']}")
        self.assertEqual(polled['body']['connection']['state'], 'connected')
        listed = self.alice.call('GET', '/v1/composio/connections')
        self.assertEqual(listed['body']['sync'], 'ok')
        self.assertEqual([(i['toolkit'], i['state']) for i in listed['body']['items']], [('github', 'connected')])
        gone = self.alice.call('POST', f"/v1/composio/connections/{connection['id']}/disconnect", {})
        self.assertEqual(gone['status'], 200, gone)
        self.assertEqual(self.fake.calls[-1]['method'], 'DELETE')
        self.assertEqual(self.fake.accounts, {})
        self.assertEqual(self.alice.call('GET', '/v1/composio/connections')['body']['items'], [])

    def test_failed_authorization_is_reported_not_faked(self):
        self.set_key(self.alice, ALICE_KEY)
        connection = self.connect(self.alice)['body']['connection']
        self.fake.accounts['ca_0001'].update(status='FAILED', status_reason='User denied consent')
        polled = self.alice.call('GET', f"/v1/composio/connections/{connection['id']}")
        self.assertEqual(polled['body']['connection']['state'], 'failed')
        self.assertEqual(polled['body']['connection']['status_reason'], 'User denied consent')
        self.fake.accounts['ca_0001']['status'] = 'SOMETHING_NEW'
        polled = self.alice.call('GET', f"/v1/composio/connections/{connection['id']}")
        self.assertEqual(polled['body']['connection']['state'], 'failed')

    def test_upstream_failures_map_to_502_without_leaking_the_key(self):
        self.set_key(self.alice, ALICE_KEY)
        self.fake.fail = (401, b'{"error":{"message":"bad key ' + ALICE_KEY.encode() + b'"}}')
        rejected = self.connect(self.alice)
        self.assertEqual(rejected['status'], 502)
        self.assertEqual(rejected['body']['error']['code'], 'composio_key_rejected')
        self.assertNotIn(ALICE_KEY, json.dumps(rejected))
        self.fake.fail = (500, b'oops')
        failed = self.connect(self.alice)
        self.assertEqual(failed['status'], 502)
        self.assertEqual(failed['body']['error']['code'], 'composio_upstream')
        # A 502 from the gateway is the same class as any upstream 5xx: it is
        # the other side being down, not a bad key and not "not configured".
        self.fake.fail = (502, b'bad gateway')
        gateway = self.connect(self.alice)
        self.assertEqual(gateway['status'], 502)
        self.assertEqual(gateway['body']['error']['code'], 'composio_upstream')
        # 409 means this toolkit already has an account upstream: the copy has
        # to say "already connected", not "request failed".
        self.fake.fail = (409, b'{"error":{"message":"account already exists"}}')
        conflict = self.connect(self.alice)
        self.assertEqual(conflict['body']['error']['code'], 'composio_conflict')
        self.fake.fail = (201, b'{"session_id":"trs_1","redirect_url":"http://evil.example"}')
        bad_link = self.connect(self.alice)
        self.assertEqual(bad_link['status'], 502)
        self.fake.fail = None

        def broken(*_args):
            raise OSError('network down')
        self.app.composio_transport = broken
        unreachable = self.connect(self.alice)
        self.assertEqual(unreachable['body']['error']['code'], 'composio_unreachable')
        self.app.composio_transport = self.fake
        with self.app.store.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM composio_connections').fetchone()[0], 0)

    def test_users_never_share_keys_or_connections(self):
        self.set_key(self.alice, ALICE_KEY)
        connection = self.connect(self.alice)['body']['connection']
        # Bob has no key: Alice's key is never used for him.
        before = len(self.fake.calls)
        self.assertEqual(self.connect(self.bob)['status'], 409)
        self.assertEqual(self.bob.call('GET', '/v1/composio')['body']['composio']['configured'], False)
        self.assertEqual(len(self.fake.calls), before)
        # Bob cannot read or disconnect Alice's record, even with his own key.
        self.set_key(self.bob, BOB_KEY)
        self.assertEqual(self.bob.call('GET', f"/v1/composio/connections/{connection['id']}")['status'], 404)
        self.assertEqual(self.bob.call('POST', f"/v1/composio/connections/{connection['id']}/disconnect", {})['status'], 404)
        self.assertEqual(self.bob.call('GET', '/v1/composio/connections')['body']['items'], [])
        self.connect(self.bob, 'notion')
        bob_calls = self.fake.calls[before:]
        self.assertTrue(bob_calls)
        self.assertTrue(all(c['key'] == BOB_KEY for c in bob_calls))
        alice_items = self.alice.call('GET', '/v1/composio/connections')['body']['items']
        self.assertEqual([i['toolkit'] for i in alice_items], ['github'])
        self.assertEqual(self.fake.calls[-1]['key'], ALICE_KEY)

    def test_toolkit_listing_drops_logos_and_validates_queries(self):
        self.set_key(self.alice, ALICE_KEY)
        listed = self.alice.call('GET', '/v1/composio/toolkits?search=git')
        self.assertEqual(listed['status'], 200, listed)
        self.assertEqual(listed['body']['items'][0]['slug'], 'github')
        self.assertTrue(listed['body']['items'][0]['composio_managed'])
        self.assertNotIn('logo', json.dumps(listed))
        self.assertEqual(self.fake.calls[-1]['query']['search'], ['git'])
        self.assertEqual(self.alice.call('GET', '/v1/composio/toolkits?evil=1')['status'], 400)
        self.assertEqual(self.connect(self.alice, 'Bad Slug!')['status'], 400)

    def test_callback_page_changes_nothing_and_bounces_to_connectors(self):
        anonymous = Client(self.app)
        result = anonymous.call('GET', '/v1/composio/callback?status=success&connected_account_id=ca_x',
                                origin=None, parse='raw')
        self.assertEqual(result['status'], 200)
        self.assertIn(b'url=/settings/connectors', result['body'])
        self.assertEqual(self.fake.calls, [])

    def test_client_repr_and_errors_hide_the_key(self):
        client = composio.Client(ALICE_KEY, transport=lambda *a: (500, b''))
        self.assertNotIn(ALICE_KEY, repr(client))
        with self.assertRaises(composio.ComposioError) as caught:
            client.list_toolkits()
        self.assertNotIn(ALICE_KEY, str(caught.exception))
        with self.assertRaises(composio.ComposioError):
            composio.Client(None)


if __name__ == '__main__':
    unittest.main()
