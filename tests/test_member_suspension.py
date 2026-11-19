"""Member suspension (issue #5): suspended members lose workspace access until resumed."""
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class SuspensionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.app = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                       clock=lambda: 1800000000)
        self.owner, self.admin, self.member = Client(self.app), Client(self.app, peer='127.0.0.2'), Client(self.app, peer='127.0.0.3')
        for client, name in ((self.owner, 'owner'), (self.admin, 'admin'), (self.member, 'member')):
            client.register(name)
        self.wid = self.owner.workspace()['body']['workspace']['id']
        self.base = f'/v1/workspaces/{self.wid}'
        self.owner.call('POST', self.base + '/members', {'username': 'admin', 'role': 'admin'})
        self.owner.call('POST', self.base + '/members', {'username': 'member', 'role': 'member'})
        self.ids = {n: c.call('GET', '/v1/auth/session')['body']['user']['id'] for n, c in
                    (('owner', self.owner), ('admin', self.admin), ('member', self.member))}

    def test_suspend_blocks_access_and_unsuspend_restores(self):
        self.assertEqual(self.member.call('GET', self.base + '/members')['status'], 200)
        done = self.admin.call('POST', f'{self.base}/members/{self.ids["member"]}/suspend', {})
        self.assertEqual((done['status'], done['body']['member']['suspended']), (200, True), done)
        self.assertEqual(self.member.call('GET', self.base + '/members')['status'], 404)
        self.assertEqual(self.member.call('GET', self.base + '/social/conversations')['status'], 404)
        self.assertNotIn(self.wid, [w['id'] for w in self.member.call('GET', '/v1/workspaces?limit=100')['body']['items']])
        listed = {m['username']: m.get('suspended') for m in self.owner.call('GET', self.base + '/members')['body']['items']}
        self.assertEqual(listed['member'], True)
        self.assertEqual(listed['admin'], False)
        # Suspended members cannot be added to new conversations.
        created = self.owner.call('POST', self.base + '/social/conversations',
                                  {'kind': 'dm', 'member_ids': [self.ids['member']]},
                                  {'HTTP_IDEMPOTENCY_KEY': 'suspend-dm-000001'})
        self.assertEqual(created['status'], 400)
        # Re-accepting an invite does not bypass suspension.
        token = self.owner.call('POST', self.base + '/invites', {'role': 'member'})['body']['token']
        self.assertEqual(self.member.call('POST', '/v1/invites/accept', {'token': token})['status'], 403)
        resumed = self.owner.call('POST', f'{self.base}/members/{self.ids["member"]}/unsuspend', {})
        self.assertEqual(resumed['body']['member']['suspended'], False)
        self.assertEqual(self.member.call('GET', self.base + '/members')['status'], 200)

    def test_permissions(self):
        # Admins cannot suspend admins (including themselves).
        self.assertEqual(self.admin.call('POST', f'{self.base}/members/{self.ids["admin"]}/suspend', {})['status'], 403)
        self.assertEqual(self.member.call('POST', f'{self.base}/members/{self.ids["admin"]}/suspend', {})['status'], 403)
        other_admin = Client(self.app, peer='127.0.0.9')
        other_admin.register('second')
        self.owner.call('POST', self.base + '/members', {'username': 'second', 'role': 'admin'})
        self.assertEqual(other_admin.call('POST', f'{self.base}/members/{self.ids["admin"]}/suspend', {})['status'], 403)
        self.assertEqual(self.owner.call('POST', f'{self.base}/members/{self.ids["owner"]}/suspend', {})['status'], 404)
        self.assertEqual(self.owner.call('POST', f'{self.base}/members/{self.ids["admin"]}/suspend', {})['status'], 200)
        self.assertEqual(self.admin.call('GET', self.base + '/members')['status'], 404)
        self.assertIn(self.owner.call('POST', f'{self.base}/members/{self.ids["admin"]}/unsuspend', {}, csrf=False)['status'],
                      (401, 403))


if __name__ == '__main__':
    unittest.main()
