"""Self-service account deletion (issue #345). In-process WSGI, no new tables."""
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN, PASSWORD


class AccountDeleteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.app = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                       clock=lambda: 1800000000)
        self.alice = Client(self.app)
        self.alice.register('alice')

    def delete(self, typed, client=None):
        return (client or self.alice).call('POST', '/v1/account/delete', {'username': typed}, parse='raw')

    def test_delete_ends_the_session_frees_the_username_and_returns_no_content(self):
        response = self.delete('alice')
        self.assertEqual(response['status'], 204, response)
        self.assertEqual(response['body'], b'', '204 must not carry a body')
        self.assertEqual(self.alice.call('GET', '/v1/auth/session')['status'], 401)
        fresh = Client(self.app)
        self.assertEqual(fresh.register('alice')['status'], 201,
                         'the username must be reusable after deletion')
        self.assertEqual(fresh.call('GET', '/v1/auth/session')['status'], 200)

    def test_a_wrong_username_is_refused_and_deletes_nothing(self):
        response = self.delete('bob')
        self.assertEqual(response['status'], 400, response)
        self.assertIn(b'confirmation_mismatch', response['body'])
        self.assertEqual(self.alice.call('GET', '/v1/auth/session')['status'], 200)
        self.assertEqual(self.alice.call('GET', '/v1/profile')['status'], 200)
        login = Client(self.app).call('POST', '/v1/auth/login',
                                      {'username': 'alice', 'password': PASSWORD})
        self.assertEqual(login['status'], 200, 'the account must still exist after a mismatch')

    def test_an_account_that_still_owns_a_workspace_is_refused_not_half_deleted(self):
        self.assertEqual(self.alice.workspace()['status'], 201)
        response = self.delete('alice')
        self.assertEqual(response['status'], 409, response)
        self.assertIn(b'account_in_use', response['body'])
        self.assertEqual(self.alice.call('GET', '/v1/auth/session')['status'], 200,
                         'a refused deletion must keep the session')
        self.assertEqual(self.alice.call('GET', '/v1/workspaces?limit=100')['body']['items'][0]['name'],
                         '示例工作区')

    def test_the_delete_route_needs_a_csrf_token(self):
        response = self.alice.call('POST', '/v1/account/delete', {'username': 'alice'},
                                   csrf=False, parse='raw')
        self.assertEqual(response['status'], 403, response)
        self.assertEqual(self.alice.call('GET', '/v1/auth/session')['status'], 200)


if __name__ == '__main__':
    unittest.main()
