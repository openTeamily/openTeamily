"""Invite approval, join requests and invite freeze (issue #5). No external service is contacted."""
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class InviteApprovalTests(unittest.TestCase):
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

    def invite(self, client=None, **extra):
        result = (client or self.owner).call('POST', self.base + '/invites',
                                             {'role': 'member', 'max_uses': 2, **extra})
        self.assertEqual(result['status'], 201, result)
        return result['body']

    def members(self):
        return {m['username'] for m in self.owner.call('GET', self.base + '/members')['body']['items']}

    def test_approval_flow_creates_membership_only_after_approval(self):
        issued = self.invite(requires_approval=True)
        self.assertTrue(issued['invite']['requires_approval'])
        asked = self.joiner.call('POST', '/v1/invites/accept', {'token': issued['token']})
        self.assertEqual(asked['status'], 202, asked)
        self.assertEqual(asked['body']['join_request']['status'], 'pending')
        self.assertNotIn('joiner', self.members())
        self.assertEqual(self.joiner.call('GET', self.base + '/members')['status'], 404)
        again = self.joiner.call('POST', '/v1/invites/accept', {'token': issued['token']})
        self.assertEqual(again['status'], 200)  # pending replay does not consume another use
        listed = self.owner.call('GET', self.base + '/invites')['body']['items'][0]
        self.assertEqual(listed['use_count'], 1)
        mine = self.joiner.call('GET', '/v1/join-requests')['body']['items']
        self.assertEqual([(r['status'], r['workspace_name']) for r in mine], [('pending', '示例工作区')])
        pending = self.admin.call('GET', self.base + '/join-requests')['body']['items']
        self.assertEqual([r['username'] for r in pending], ['joiner'])
        self.assertEqual(self.joiner.call('GET', self.base + '/join-requests')['status'], 404)
        approved = self.admin.call('POST', f'{self.base}/join-requests/{pending[0]["id"]}/approve', {})
        self.assertEqual(approved['status'], 200, approved)
        self.assertEqual(approved['body']['join_request']['status'], 'approved')
        self.assertIn('joiner', self.members())
        self.assertEqual(self.owner.call('POST', f'{self.base}/join-requests/{pending[0]["id"]}/reject', {})['status'], 409)
        self.assertEqual(self.owner.call('GET', self.base + '/join-requests')['body']['items'], [])
        self.assertEqual(len(self.owner.call('GET', self.base + '/join-requests?status=all')['body']['items']), 1)

    def test_reject_then_reapply_and_admin_limits(self):
        issued = self.invite(requires_approval=True)
        self.joiner.call('POST', '/v1/invites/accept', {'token': issued['token']})
        rid = self.owner.call('GET', self.base + '/join-requests')['body']['items'][0]['id']
        rejected = self.owner.call('POST', f'{self.base}/join-requests/{rid}/reject', {})
        self.assertEqual(rejected['body']['join_request']['status'], 'rejected')
        self.assertNotIn('joiner', self.members())
        reapplied = self.joiner.call('POST', '/v1/invites/accept', {'token': issued['token']})
        self.assertEqual(reapplied['status'], 202)
        # Two uses are now consumed; a third person cannot request.
        self.assertEqual(self.other.call('POST', '/v1/invites/accept', {'token': issued['token']})['status'], 404)
        admin_invite = self.invite(role='admin', requires_approval=True)
        self.other.call('POST', '/v1/invites/accept', {'token': admin_invite['token']})
        other_rid = [r for r in self.owner.call('GET', self.base + '/join-requests')['body']['items']
                     if r['username'] == 'other'][0]['id']
        self.assertEqual(self.admin.call('POST', f'{self.base}/join-requests/{other_rid}/approve', {})['status'], 403)
        self.assertEqual(self.owner.call('POST', f'{self.base}/join-requests/{"0" * 32}/approve', {})['status'], 404)
        self.assertEqual(self.owner.call('POST', self.base + '/invites',
                                         {'role': 'member', 'requires_approval': 'yes'})['status'], 400)
        self.assertIn(self.owner.call('POST', f'{self.base}/join-requests/{other_rid}/approve', {},
                                      csrf=False)['status'], (401, 403))

    def test_freeze_pauses_and_unfreeze_resumes_without_revoking(self):
        issued = self.invite()
        iid = issued['invite']['id']
        self.assertFalse(issued['invite']['requires_approval'])
        frozen = self.owner.call('POST', f'{self.base}/invites/{iid}/freeze', {})
        self.assertEqual((frozen['status'], frozen['body']['invite']['frozen'], frozen['body']['invite']['revoked']),
                         (200, True, 0))
        self.assertEqual(self.joiner.call('POST', '/v1/invites/accept', {'token': issued['token']})['status'], 409)
        self.assertEqual(self.owner.call('GET', self.base + '/invites')['body']['items'][0]['use_count'], 0)
        self.assertEqual(self.owner.call('POST', f'{self.base}/invites/{iid}/unfreeze', {})['body']['invite']['frozen'], False)
        self.assertEqual(self.joiner.call('POST', '/v1/invites/accept', {'token': issued['token']})['status'], 201)
        self.owner.call('POST', f'{self.base}/invites/{iid}/revoke', {})
        self.assertEqual(self.owner.call('POST', f'{self.base}/invites/{iid}/freeze', {})['status'], 409)
        admin_only = self.invite(role='admin')
        self.assertEqual(self.admin.call('POST', f'{self.base}/invites/{admin_only["invite"]["id"]}/freeze', {})['status'], 403)


if __name__ == '__main__':
    unittest.main()
