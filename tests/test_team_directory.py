"""Public team directory and search (issues #5 #86). Functional flow, not a Teamily comparison."""
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class TeamDirectoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = 1800000000
        self.app = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                       clock=lambda: self.now)
        self.owner, self.admin = Client(self.app), Client(self.app, peer='127.0.0.2')
        self.joiner, self.other = Client(self.app, peer='127.0.0.3'), Client(self.app, peer='127.0.0.4')
        for client, name in ((self.owner, 'owner'), (self.admin, 'admin'), (self.joiner, 'joiner'), (self.other, 'other')):
            client.register(name)
        self.wid = self.owner.workspace()['body']['workspace']['id']
        self.owner.call('POST', f'/v1/workspaces/{self.wid}/members', {'username': 'admin', 'role': 'admin'})
        self.base = f'/v1/workspaces/{self.wid}'

    def list_team(self, **body):
        return self.owner.call('POST', self.base + '/directory', {'listed': True, 'summary': '开源设计小组', **body})

    def test_listing_search_and_join_through_approval(self):
        self.assertEqual(self.joiner.call('GET', '/v1/team-directory')['body']['items'], [])
        self.assertEqual(self.admin.call('POST', self.base + '/directory', {'listed': True})['status'], 403)
        self.assertEqual(self.list_team()['body']['listing']['listed'], True)
        self.assertEqual(self.admin.call('GET', self.base + '/directory')['body']['listing']['summary'], '开源设计小组')
        self.assertEqual(self.joiner.call('GET', self.base + '/directory')['status'], 404)
        found = self.joiner.call('GET', '/v1/team-directory?q=%E8%AE%BE%E8%AE%A1')['body']['items']
        self.assertEqual([(t['workspace_id'], t['member_count'], t['membership']) for t in found],
                         [(self.wid, 2, None)])
        self.assertEqual(self.joiner.call('GET', '/v1/team-directory?q=nomatch')['body']['items'], [])
        self.assertEqual(self.joiner.call('GET', '/v1/team-directory?q=100%25')['body']['items'], [])
        self.assertEqual(self.admin.call('GET', '/v1/team-directory')['body']['items'][0]['membership'], 'member')
        asked = self.joiner.call('POST', f'/v1/team-directory/{self.wid}/join', {})
        self.assertEqual((asked['status'], asked['body']['join_request']['status']), (202, 'pending'))
        self.assertEqual(self.joiner.call('POST', f'/v1/team-directory/{self.wid}/join', {})['status'], 200)
        self.assertEqual(self.joiner.call('GET', '/v1/team-directory')['body']['items'][0]['membership'], 'pending')
        self.assertEqual(self.joiner.call('GET', self.base + '/members')['status'], 404)
        pending = self.admin.call('GET', self.base + '/join-requests')['body']['items']
        self.assertEqual(self.admin.call('POST', f'{self.base}/join-requests/{pending[0]["id"]}/approve', {})['status'], 200)
        self.assertEqual(self.joiner.call('GET', self.base + '/members')['status'], 200)
        self.assertEqual(self.joiner.call('POST', f'/v1/team-directory/{self.wid}/join', {})['status'], 409)
        self.assertEqual(self.owner.call('POST', f'/v1/team-directory/{self.wid}/join', {})['status'], 409)

    def test_unlist_spent_invite_and_validation(self):
        self.list_team()
        self.other.call('POST', f'/v1/team-directory/{self.wid}/join', {})
        self.assertEqual(self.owner.call('POST', self.base + '/directory', {'listed': False})['body']['listing'],
                         {'listed': False, 'summary': ''})
        self.assertEqual(self.joiner.call('GET', '/v1/team-directory')['body']['items'], [])
        self.assertEqual(self.joiner.call('POST', f'/v1/team-directory/{self.wid}/join', {})['status'], 404)
        invites = self.owner.call('GET', self.base + '/invites')['body']['items']
        self.assertTrue(all(i['revoked'] for i in invites))
        self.list_team()
        self.other.call('POST', f'/v1/team-directory/{self.wid}/join', {})
        with self.app.store.connect() as db:  # the listing invite expired: joining renews it
            db.execute('UPDATE workspace_invites SET expires=? WHERE revoked=0', (self.now,))
        self.assertEqual(self.joiner.call('POST', f'/v1/team-directory/{self.wid}/join', {})['status'], 202)
        renewed = self.owner.call('GET', self.base + '/invites')['body']['items']
        self.assertEqual((len(renewed), sum(not i['revoked'] for i in renewed)), (3, 1))
        for bad in ('/v1/team-directory?q=' + 'x' * 61, '/v1/team-directory?limit=0', '/v1/team-directory?x=1'):
            self.assertEqual(self.joiner.call('GET', bad)['status'], 400, bad)
        self.assertEqual(self.list_team(summary='x' * 201)['status'], 400)
        self.assertEqual(self.owner.call('POST', self.base + '/directory', {'listed': 'yes'})['status'], 400)
        self.assertEqual(self.joiner.call('POST', f'/v1/team-directory/{"0" * 32}/join', {})['status'], 404)
        anon = Client(self.app, peer='127.0.0.9')
        self.assertEqual(anon.call('GET', '/v1/team-directory')['status'], 401)


if __name__ == '__main__':
    unittest.main()
