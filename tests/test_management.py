"""In-process WSGI/SQLite tests. No listening socket, Docker or actual credentials."""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from http.cookies import SimpleCookie
import io
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from openteamily.app import App, Config
from openteamily.store import Store

PASSWORD = 'Synthetic test passphrase #2026'
ORIGIN = 'https://management.test'


class Client:
    def __init__(self, app, peer='127.0.0.1'):
        self.app, self.peer, self.cookies = app, peer, {}

    def call(self, method, path, body=None, headers=None, raw=None, csrf=True, origin=ORIGIN, parse='json'):
        path, _, query = path.partition('?')
        payload = raw if raw is not None else json.dumps(body if body is not None else {}).encode()
        env = {'REQUEST_METHOD': method, 'PATH_INFO': path, 'QUERY_STRING': query,
               'HTTP_HOST': 'management.test', 'REMOTE_ADDR': self.peer,
               'CONTENT_TYPE': 'application/json', 'CONTENT_LENGTH': str(len(payload)),
               'wsgi.input': io.BytesIO(payload), 'HTTP_COOKIE': '; '.join(f'{k}={v}' for k, v in self.cookies.items())}
        if origin is not None:
            env['HTTP_ORIGIN'] = origin
        if csrf:
            env['HTTP_X_CSRF_TOKEN'] = self.cookies.get(self.app.config.cookie_names[1], '')
        env.update(headers or {})
        result = {}
        def start(status, values):
            result['status'], result['headers'] = int(status.split()[0]), values
        raw_body = b''.join(self.app(env, start))
        result['body'] = raw_body if parse == 'raw' else json.loads(raw_body)
        for key, value in result['headers']:
            if key.lower() == 'set-cookie':
                cookie = SimpleCookie(); cookie.load(value)
                for name, item in cookie.items():
                    if item['max-age'] == '0':
                        self.cookies.pop(name, None)
                    else:
                        self.cookies[name] = item.value
        return result

    def register(self, username='alice'):
        return self.call('POST', '/v1/auth/register', {'username': username, 'password': PASSWORD})

    def workspace(self, name='示例工作区', key='request_example_0001'):
        return self.call('POST', '/v1/workspaces', {'name': name}, {'HTTP_IDEMPOTENCY_KEY': key})


class ManagementTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = 1800000000
        self.store = Store(Path(self.temp.name) / 'state')
        self.config = Config(ORIGIN, allow_registration=True)
        self.app = App(self.store, self.config, clock=lambda: self.now)
        self.client = Client(self.app)

    def test_register_session_logout_and_login(self):
        registered = self.client.register('Alice')
        self.assertEqual(registered['status'], 201)
        self.assertEqual(registered['body']['user']['username'], 'alice')
        self.assertEqual(self.client.call('GET', '/v1/auth/session')['status'], 200)
        self.assertEqual(self.client.call('POST', '/v1/auth/logout')['body'], {'logged_out': True})
        self.assertEqual(self.client.call('GET', '/v1/auth/session')['status'], 401)
        response = self.client.call('POST', '/v1/auth/login', {'username': 'ALICE', 'password': PASSWORD})
        self.assertEqual(response['status'], 200)

    def test_cookies_are_host_bound_secure_and_session_is_httponly(self):
        response = self.client.register()
        values = [v for k, v in response['headers'] if k == 'Set-Cookie']
        self.assertEqual(len(values), 2)
        for value in values:
            self.assertIn('__Host-', value); self.assertIn('Secure', value)
            self.assertIn('SameSite=Strict', value); self.assertIn('Path=/', value)
            self.assertNotIn('Domain=', value)
        self.assertIn('HttpOnly', values[0]); self.assertNotIn('HttpOnly', values[1])
        self.assertEqual(dict(response['headers'])['Cache-Control'], 'no-store')
        self.assertNotIn('Access-Control-Allow-Origin', dict(response['headers']))

    def test_db_does_not_contain_password_session_or_csrf_plaintext(self):
        self.client.register()
        secrets = [PASSWORD, *self.client.cookies.values()]
        with self.store.connect() as db:
            dump = '\n'.join(db.iterdump())
            record = db.execute('SELECT password_hash FROM users').fetchone()[0]
        for secret in secrets:
            self.assertNotIn(secret, dump)
        self.assertTrue(record.startswith('scrypt-v1$'))
        for path in self.store.path.parent.iterdir():
            self.assertEqual(path.stat().st_mode & 0o077, 0)

    def test_equal_passwords_get_independent_salts(self):
        self.client.register('alice'); Client(self.app).register('bob')
        with self.store.connect() as db:
            hashes = [row[0] for row in db.execute('SELECT password_hash FROM users')]
        self.assertEqual(len(set(hashes)), 2)

    def test_csrf_missing_wrong_cross_session_or_nonascii_cookies_fail(self):
        self.client.register()
        self.assertEqual(self.client.workspace()['status'], 201)
        for header in ['', 'x' * 43]:
            response = self.client.call('POST', '/v1/workspaces', {'name': 'x'},
                                        {'HTTP_X_CSRF_TOKEN': header, 'HTTP_IDEMPOTENCY_KEY': 'another_request_1'})
            self.assertEqual(response['status'], 403)
        other = Client(self.app); other.register('bob')
        response = self.client.call('POST', '/v1/auth/logout', {},
                                   {'HTTP_X_CSRF_TOKEN': other.cookies[self.config.cookie_names[1]]})
        self.assertEqual(response['status'], 403)
        response = self.client.call('POST', '/v1/auth/logout', {},
                                   {'HTTP_COOKIE': f'{self.config.cookie_names[0]}={self.client.cookies[self.config.cookie_names[0]]}; {self.config.cookie_names[1]}="\\377"'})
        self.assertEqual(response['status'], 403)
        self.assertEqual(self.client.call('GET', '/v1/auth/session')['status'], 200)

    def test_login_registration_and_writes_require_exact_origin(self):
        for origin in [None, 'https://evil.test', ORIGIN + '.evil.test', 'null']:
            self.assertEqual(self.client.call('POST', '/v1/auth/register',
                                            {'username': 'alice', 'password': PASSWORD}, origin=origin)['status'], 403)
        self.client.register()
        self.assertEqual(self.client.call('POST', '/v1/auth/logout', {}, origin=None)['status'], 403)
        self.assertEqual(self.client.call('POST', '/v1/auth/logout', {}, {'HTTP_SEC_FETCH_SITE': 'cross-site'})['status'], 403)

    def test_host_validation_and_cors_absence(self):
        self.assertEqual(self.client.call('GET', '/v1/auth/session', headers={'HTTP_HOST': 'evil.test'})['status'], 403)
        self.assertEqual(self.client.call('OPTIONS', '/v1/auth/register')['status'], 405)

    def test_closed_registration_is_default_and_cannot_be_overridden_in_body(self):
        app = App(self.store, Config(ORIGIN))
        client = Client(app)
        self.assertEqual(client.register()['status'], 403)
        self.assertEqual(client.call('POST', '/v1/auth/register', {'username': 'alice', 'password': PASSWORD,
                                                                 'allow_registration': True})['status'], 400)

    def test_invalid_and_overlong_credentials_rejected_before_hashing(self):
        for user, password in [('ab', PASSWORD), ('../alice', PASSWORD), ('a' * 65, PASSWORD),
                               ('alice', 'short'), ('alice', 'x' * 257), ('alice', '文' * 100),
                               ('alice', True), (None, PASSWORD)]:
            self.assertEqual(self.client.call('POST', '/v1/auth/register', {'username': user, 'password': password})['status'], 400)
        with self.store.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM users').fetchone()[0], 0)

    def test_missing_user_wrong_password_same_public_error_and_failures_are_limited(self):
        self.client.register()
        one = self.client.call('POST', '/v1/auth/login', {'username': 'missing', 'password': PASSWORD})
        two = self.client.call('POST', '/v1/auth/login', {'username': 'alice', 'password': 'wrong test passphrase'})
        self.assertEqual((one['status'], one['body']), (two['status'], two['body']))
        app = App(self.store, replace(self.config, auth_name_limit=2), clock=lambda: self.now)
        client = Client(app, peer='192.0.2.1')
        # alice already consumed registration + failed-login attempts.
        response = client.call('POST', '/v1/auth/login', {'username': 'alice', 'password': PASSWORD})
        self.assertEqual(response['status'], 429)
        self.assertIn('Retry-After', dict(response['headers']))
        self.now += 601
        self.assertEqual(client.call('POST', '/v1/auth/login', {'username': 'alice', 'password': PASSWORD})['status'], 200)

    def test_rate_bucket_growth_is_bounded(self):
        self.app.config = replace(self.config, max_rate_buckets=3)
        self.assertEqual(self.client.register()['status'], 201)
        response = Client(self.app, peer='192.0.2.2').register('bob')
        self.assertEqual(response['status'], 429)
        with self.store.connect() as db:
            self.assertLessEqual(db.execute('SELECT COUNT(*) FROM rate_limits').fetchone()[0], 3)

    def test_session_expiration_and_logout_revoke_the_old_cookie(self):
        self.client.register(); old = dict(self.client.cookies)
        self.client.call('POST', '/v1/auth/logout'); self.client.cookies = old
        self.assertEqual(self.client.call('GET', '/v1/auth/session')['status'], 401)
        self.client.call('POST', '/v1/auth/login', {'username': 'alice', 'password': PASSWORD})
        self.now += self.config.session_seconds
        self.assertEqual(self.client.call('GET', '/v1/auth/session')['status'], 401)

    def test_session_count_account_and_global_quotas(self):
        self.app.config = replace(self.config, max_sessions_per_user=1, max_users=1)
        self.client.register(); old = Client(self.app); old.cookies = dict(self.client.cookies)
        self.client.call('POST', '/v1/auth/login', {'username': 'alice', 'password': PASSWORD})
        self.assertEqual(old.call('GET', '/v1/auth/session')['status'], 401)
        self.assertEqual(Client(self.app).register('bob')['status'], 429)
        self.app.config = replace(self.config, max_sessions=1)
        self.assertEqual(Client(self.app).register('bob')['status'], 429)
        with self.store.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM users').fetchone()[0], 1)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM sessions').fetchone()[0], 1)

    def test_workspace_create_list_get_are_owner_scoped(self):
        self.client.register(); other = Client(self.app); other.register('bob')
        workspace = self.client.workspace()['body']['workspace']
        self.assertEqual(self.client.call('GET', f"/v1/workspaces/{workspace['id']}")['body']['workspace'], workspace)
        self.assertEqual(len(self.client.call('GET', '/v1/workspaces')['body']['items']), 1)
        self.assertEqual(other.call('GET', '/v1/workspaces')['body']['items'], [])
        for method, suffix in [('GET', ''), ('GET', '/instances'), ('POST', '/instances')]:
            response = other.call(method, f"/v1/workspaces/{workspace['id']}{suffix}", {})
            self.assertEqual(response['status'], 404)
        self.assertEqual(Client(self.app).call('GET', '/v1/workspaces')['status'], 401)

    def test_workspace_write_rejects_forged_owner_image_command_and_mount(self):
        self.client.register()
        for key in ['owner_id', 'workspace_id', 'image', 'command', 'mount', 'token', '__proto__']:
            response = self.client.call('POST', '/v1/workspaces', {'name': 'x', key: 'injected'},
                                        {'HTTP_IDEMPOTENCY_KEY': 'request_injected_1'})
            self.assertEqual(response['status'], 400)
        self.assertEqual(self.client.call('GET', '/v1/workspaces')['body']['items'], [])

    def test_workspace_idempotency_survives_restart_and_conflicting_replay_is_atomic(self):
        self.client.register(); first = self.client.workspace()
        self.assertEqual(first['status'], 201)
        reopened = App(Store(self.store.path.parent), self.config, clock=lambda: self.now)
        self.client.app = reopened
        replay = self.client.workspace()
        self.assertEqual(replay['status'], 200)
        self.assertEqual(replay['body'], first['body'])
        self.assertEqual(self.client.workspace('different')['status'], 409)
        self.assertEqual(len(self.client.call('GET', '/v1/workspaces')['body']['items']), 1)

    def test_concurrent_same_key_creates_one_workspace_and_scope_is_per_user(self):
        self.client.register()
        def create(_):
            client = Client(self.app); client.cookies = dict(self.client.cookies)
            return client.workspace()
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(create, range(8)))
        self.assertEqual(sum(result['status'] == 201 for result in results), 1)
        self.assertEqual(len({result['body']['workspace']['id'] for result in results}), 1)
        other = Client(self.app); other.register('bob')
        second = other.workspace()['body']['workspace']
        self.assertNotEqual(second['id'], results[0]['body']['workspace']['id'])

    def test_workspace_key_name_validation_and_quota(self):
        self.client.register()
        self.assertEqual(self.client.call('POST', '/v1/workspaces', {'name': 'x'})['status'], 400)
        for name in ['', ' ', 'x\nforged', 'x' * 81, '\ud800', False]:
            self.assertEqual(self.client.workspace(name)['status'], 400)
        self.app.config = replace(self.config, max_workspaces_per_user=1)
        self.assertEqual(self.client.workspace()['status'], 201)
        self.assertEqual(self.client.workspace('another', 'another_request_1')['status'], 429)
        self.assertEqual(self.client.workspace()['status'], 200)

    def test_bounded_pagination_has_no_duplicate_or_cross_owner_rows(self):
        self.client.register()
        ids = {self.client.workspace(str(i), f'request_number_{i:04}')['body']['workspace']['id'] for i in range(5)}
        seen, cursor = [], ''
        while True:
            page = self.client.call('GET', '/v1/workspaces?limit=2' + ('&cursor=' + cursor if cursor else ''))
            self.assertEqual(page['status'], 200)
            seen += [row['id'] for row in page['body']['items']]
            cursor = page['body']['cursor']
            if not cursor:
                break
        self.assertEqual(set(seen), ids); self.assertEqual(len(seen), len(ids))
        for query in ['limit=0', 'limit=101', 'limit=1&limit=2', 'owner_id=other', 'cursor=../x', 'limit=1&cursor=x&extra=y']:
            self.assertEqual(self.client.call('GET', '/v1/workspaces?' + query)['status'], 400)

    def test_request_json_limits_duplicates_and_unknown_fields(self):
        for raw in [b'[]', b'{', b'{"username":"a","username":"b"}', b'{"number":NaN}', b'\xff', b'[' * 2000]:
            self.assertEqual(self.client.call('POST', '/v1/auth/register', raw=raw)['status'], 400)
        self.assertEqual(self.client.call('POST', '/v1/auth/register', raw=b'x' * 16385)['status'], 413)
        for header, status in [({'CONTENT_TYPE': 'text/plain'}, 415), ({'CONTENT_LENGTH': '-1'}, 411),
                               ({'HTTP_TRANSFER_ENCODING': 'chunked'}, 400), ({'CONTENT_LENGTH': '100'}, 400)]:
            self.assertEqual(self.client.call('POST', '/v1/auth/register', raw=b'{}', headers=header)['status'], status)

    def test_cookie_ambiguity_is_rejected_and_errors_do_not_expose_backend_details(self):
        self.client.register()
        name, _ = self.config.cookie_names
        self.assertEqual(self.client.call('GET', '/v1/auth/session', headers={'HTTP_COOKIE': f'{name}=x; {name}=y'})['status'], 400)
        with patch.object(self.store, 'transaction', side_effect=sqlite3.DatabaseError('/private/path secret-value')):
            response = self.client.call('GET', '/v1/workspaces')
        self.assertEqual(response['status'], 503)
        self.assertNotIn('private', json.dumps(response)); self.assertNotIn('secret-value', json.dumps(response))

    def test_runtime_and_manager_are_explicitly_not_implemented(self):
        self.client.register(); workspace = self.client.workspace()['body']['workspace']
        for method, path in [('POST', f"/v1/workspaces/{workspace['id']}/instances"),
                             ('POST', '/v1/instances/example/start'), ('POST', '/v1/instances/example/purge'),
                             ('GET', '/v1/internal/instances')]:
            response = self.client.call(method, path, {})
            self.assertEqual(response['status'], 501)
            self.assertEqual(response['body']['error']['code'], 'unsupported')
        # A user session has no functioning manager/control authority.
        self.assertEqual(self.client.call('GET', '/v1/workspaces')['status'], 200)

    def test_retry_after_only_describes_auth_rate_limits_not_persistent_quotas(self):
        self.app.config = replace(self.config, max_workspaces_per_user=1)
        self.client.register()
        self.client.workspace()
        quota = self.client.workspace('Second', 'quota-request-key-0002')
        self.assertEqual(quota['status'], 429)
        self.assertEqual(quota['body']['error']['code'], 'quota')
        self.assertNotIn('Retry-After', dict(quota['headers']))
        self.app.config = replace(self.app.config, max_users=1)
        account_quota = Client(self.app).register('another-user')
        self.assertEqual(account_quota['status'], 429)
        self.assertEqual(account_quota['body']['error']['code'], 'quota')
        self.assertNotIn('Retry-After', dict(account_quota['headers']))
        self.app.config = replace(self.app.config, max_sessions=1)
        session_quota = self.client.call('POST', '/v1/auth/login', {'username': 'alice', 'password': PASSWORD})
        self.assertEqual(session_quota['status'], 429)
        self.assertEqual(session_quota['body']['error']['code'], 'quota')
        self.assertNotIn('Retry-After', dict(session_quota['headers']))
        self.app.config = replace(self.app.config, auth_peer_limit=1)
        limited = self.client.call('POST', '/v1/auth/login', {'username': 'alice', 'password': PASSWORD})
        self.assertEqual(limited['status'], 429)
        self.assertEqual(limited['body']['error']['code'], 'rate_limited')
        self.assertEqual(dict(limited['headers'])['Retry-After'], str(self.config.auth_window))

    def test_origin_configuration_requires_explicit_loopback_cookie_downgrade(self):
        for origin in ['http://example.test', 'https://user:pass@example.test', 'https://example.test/path', 'https://example.test?x=y']:
            with self.assertRaises(ValueError):
                Config(origin)
        with self.assertRaises(ValueError):
            Config('http://127.0.0.1:8080')
        config = Config('http://127.0.0.1:8080', insecure_local=True)
        self.assertTrue(config.cookie_names[0].startswith('ot_dev_'))
        with self.assertRaises(ValueError):
            Config('http://172.18.0.1:8080')
        with self.assertRaises(ValueError):
            Config('http://8.8.8.8:8080', insecure_local=True)
        with self.assertRaises(ValueError):
            Config('http://0.0.0.0:8080', insecure_local=True)
        private = Config('http://172.18.0.1:8080', insecure_local=True)
        self.assertTrue(private.cookie_names[0].startswith('ot_dev_'))

    def test_storage_rejects_symlinks_public_permissions_and_unknown_schema(self):
        root = Path(self.temp.name)
        public = root / 'public'; public.mkdir(mode=0o755)
        with self.assertRaises(ValueError):
            Store(public)
        link = root / 'link'; link.symlink_to(self.store.path.parent)
        with self.assertRaises(ValueError):
            Store(link)
        other = root / 'other'; other.mkdir(mode=0o700)
        (other / 'management.sqlite3').symlink_to(self.store.path)
        with self.assertRaises(OSError):
            Store(other)
        with self.store.connect() as db:
            db.execute('PRAGMA user_version=99')
        with self.assertRaises(ValueError):
            Store(self.store.path.parent)
        with self.store.connect() as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 99)


    def test_legacy_workspace_stream_still_served_by_the_platform(self):
        registered = self.client.register()
        user = registered['body']['user']['id']
        workspace = {'id': 'a' * 32}
        with self.store.transaction() as db:
            db.execute('INSERT INTO workspaces VALUES(?,?,?,?,?,?)',
                       (workspace['id'], user, 'w', self.now, 'k', 'r'))
        def generated(_stream):
            yield b'event: renew\ndata: {}\n\n'
        with patch('openteamily.events.EventStream.generate', generated):
            response = self.client.call('GET', f"/v1/workspaces/{workspace['id']}/events", parse='raw')
        self.assertEqual(response['status'], 200)
        headers = dict(response['headers'])
        self.assertIn('text/event-stream', headers['Content-Type'])
        self.assertEqual(headers['X-Accel-Buffering'], 'no')
        self.assertIn(b'event: renew', response['body'])


if __name__ == '__main__':
    unittest.main()
