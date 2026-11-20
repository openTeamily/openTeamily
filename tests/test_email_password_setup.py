"""Email password setup and email-code login. In-process WSGI only."""
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN, PASSWORD


class FakeMailer:
    def __init__(self):
        self.links = []
        self.codes = []
        self.welcome = []

    def send_password_setup(self, to, link):
        self.links.append((to, link))

    def send_login_code(self, to, code):
        self.codes.append((to, code))

    def send_welcome(self, to, username, via='email'):
        self.welcome.append((to, username, via))


class EmailPasswordSetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'state'
        self.mailer = FakeMailer()
        self.app = App(Store(self.path), Config(
            ORIGIN, allow_registration=True, email_registration=True,
            mail_from='admin@example.test', terms_url='https://example.test/terms',
            privacy_url='https://example.test/privacy'), clock=lambda: 1800000000,
            mailer=self.mailer)
        self.alice = Client(self.app)
        self.alice.register('alice')

    def request(self, email, client=None):
        return (client or Client(self.app)).call(
            'POST', '/v1/auth/password/request',
            {'email': email, 'accept_terms': True})

    def token_from_link(self, link):
        return parse_qs(urlsplit(link).query)['token'][0]

    def complete(self, token, password, client=None):
        return (client or Client(self.app)).call(
            'POST', '/v1/auth/password/complete', {'token': token, 'password': password})

    def test_unknown_email_registers_with_a_password_setup_link(self):
        requested = self.request('new.user@example.com')
        self.assertEqual(requested['status'], 200, requested)
        self.assertEqual(len(self.mailer.links), 1)
        email, link = self.mailer.links[0]
        self.assertEqual(email, 'new.user@example.com')
        self.assertIn('/set-password?token=', link)
        token = self.token_from_link(link)
        self.assertRegex(token, r'^[A-Za-z0-9_-]{43}$')
        completed = self.complete(token, 'New synthetic passphrase #2026')
        self.assertEqual(completed['status'], 200, completed)
        self.assertTrue(completed['body']['registered'])
        username = completed['body']['user']['username']
        self.assertEqual(self.complete(token, 'New synthetic passphrase #2026')['status'], 400)
        login = Client(self.app)
        self.assertEqual(login.call('POST', '/v1/auth/login', {
            'username': username, 'password': 'New synthetic passphrase #2026'})['status'], 200)
        email_login = Client(self.app)
        self.assertEqual(email_login.call('POST', '/v1/auth/login', {
            'username': 'new.user@example.com', 'password': 'New synthetic passphrase #2026'})['status'], 200)

    def test_existing_user_can_set_a_password_and_keep_the_same_account(self):
        user = self.alice.call('GET', '/v1/auth/session')['body']['user']
        with self.app.store.transaction() as db:
            db.execute('INSERT INTO user_emails VALUES(?,?,1,?)',
                       (user['id'], 'alice@example.com', 1800000000))
        requested = self.request('alice@example.com')
        self.assertEqual(requested['status'], 200)
        token = self.token_from_link(self.mailer.links[-1][1])
        completed = self.complete(token, 'Rotated synthetic passphrase #2026')
        self.assertEqual(completed['status'], 200, completed)
        self.assertFalse(completed['body']['registered'])
        self.assertEqual(completed['body']['user']['id'], user['id'])
        login = Client(self.app)
        self.assertEqual(login.call('POST', '/v1/auth/login', {
            'username': 'alice@example.com', 'password': 'Rotated synthetic passphrase #2026'})['status'], 200)
        old = Client(self.app)
        self.assertEqual(old.call('POST', '/v1/auth/login', {
            'username': 'alice', 'password': PASSWORD})['status'], 401)

    def test_email_code_login_only_works_for_an_existing_account(self):
        user = self.alice.call('GET', '/v1/auth/session')['body']['user']
        with self.app.store.transaction() as db:
            db.execute('INSERT INTO user_emails VALUES(?,?,1,?)',
                       (user['id'], 'alice@example.com', 1800000000))
        started = Client(self.app).call('POST', '/v1/auth/email/login/start',
                                        {'email': 'alice@example.com'})
        self.assertEqual(started['status'], 200, started)
        self.assertEqual(self.mailer.codes[-1][0], 'alice@example.com')
        code = self.mailer.codes[-1][1]
        verified = Client(self.app).call('POST', '/v1/auth/email/login/verify',
                                         {'email': 'alice@example.com', 'code': code})
        self.assertEqual(verified['status'], 200, verified)
        self.assertEqual(verified['body']['user']['id'], user['id'])
        unknown_start = Client(self.app).call('POST', '/v1/auth/email/login/start',
                                              {'email': 'nobody@example.com'})
        self.assertEqual(unknown_start['status'], 200)
        sent = len(self.mailer.codes)
        self.assertEqual(Client(self.app).call('POST', '/v1/auth/email/login/verify',
                                               {'email': 'nobody@example.com', 'code': '000000'})['status'], 400)
        self.assertEqual(len(self.mailer.codes), sent)

    def test_validation_terms_and_password_bounds(self):
        client = Client(self.app)
        self.assertEqual(client.call('POST', '/v1/auth/password/request',
                                     {'email': 'not-an-email', 'accept_terms': True})['status'], 400)
        self.assertEqual(client.call('POST', '/v1/auth/password/request',
                                     {'email': 'x@example.com', 'accept_terms': False})['status'], 400)
        self.assertEqual(self.complete('x' * 43, 'short')['status'], 400)
        requested = self.request('valid@example.com')
        self.assertEqual(requested['status'], 200)
        token = self.token_from_link(self.mailer.links[-1][1])
        self.assertEqual(self.complete(token, 'short')['status'], 400)
        self.assertEqual(self.complete('x' * 43, 'A valid synthetic passphrase')['status'], 400)


if __name__ == '__main__':
    unittest.main()
