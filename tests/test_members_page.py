"""Members page serving tests. In-process WSGI only; not browser E2E."""
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.settings_page import SettingsPage
from openteamily.store import Store
from tests.test_management import Client, ORIGIN
from tests.test_settings_page import RawClient


class MembersPageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        api = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                  clock=lambda: 1800000000)
        self.app = SettingsPage(api)
        self.raw = RawClient(self.app)
        self.client = Client(self.app)
        self.client.register('alice')

    def test_page_and_assets_are_served_with_strict_headers(self):
        page = self.raw.call('GET', '/members')
        self.assertEqual(page['status'], 200)
        html = page['body'].decode()
        self.assertIn('成员', html)
        self.assertIn('name="username"', html)
        self.assertIn('name="role"', html)
        self.assertIn('name="token"', html)
        self.assertIn('/v1/workspaces', html)
        self.assertIn('/v1/invites/accept', html)
        self.assertIn('default-src \'none\'', page['headers']['Content-Security-Policy'])
        script = self.raw.call('GET', '/members/app.mjs')
        self.assertEqual(script['status'], 200)
        self.assertIn('发消息', script['body'].decode())
        self.assertIn('startDirectMessage', script['body'].decode())
        self.assertEqual(self.raw.call('GET', '/members/app.css')['status'], 200)
        self.assertEqual(self.raw.call('GET', '/members/missing')['status'], 404)

    def test_page_rejects_cross_origin_queries_and_writes(self):
        self.assertEqual(self.raw.call('GET', '/members', origin='https://evil.test')['status'], 403)
        self.assertEqual(self.raw.call('GET', '/members', query='x=1')['status'], 400)
        self.assertEqual(self.raw.call('POST', '/members')['status'], 405)

    def test_wrapper_still_exposes_members_and_invites(self):
        space = self.client.call('POST', '/v1/workspaces', {'name': 'Desk'},
                                 {'HTTP_IDEMPOTENCY_KEY': 'members-page-space-01'})
        self.assertEqual(space['status'], 201, space)
        wid = space['body']['workspace']['id']
        bob = Client(self.app)
        bob.register('bob')
        added = self.client.call('POST', f'/v1/workspaces/{wid}/members',
                                 {'username': 'bob', 'role': 'member'})
        self.assertEqual(added['status'], 201, added)
        listed = self.client.call('GET', f'/v1/workspaces/{wid}/members')
        self.assertEqual(listed['status'], 200)
        self.assertEqual([row['username'] for row in listed['body']['items']], ['alice', 'bob'])
        invited = self.client.call('POST', f'/v1/workspaces/{wid}/invites',
                                   {'role': 'member', 'expires_in': 600, 'max_uses': 1})
        self.assertEqual(invited['status'], 201, invited)
        self.assertIn('token', invited['body'])


if __name__ == '__main__':
    unittest.main()
