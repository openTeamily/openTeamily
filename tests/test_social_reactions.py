"""Message reactions (issue #86 message tools). No agent or vendor is contacted."""
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class ReactionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.app = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                       clock=lambda: 1800000000)
        self.alice, self.bob, self.eve = (Client(self.app), Client(self.app, peer='127.0.0.2'),
                                          Client(self.app, peer='127.0.0.3'))
        for client, name in ((self.alice, 'alice'), (self.bob, 'bob'), (self.eve, 'eve')):
            client.register(name)
        self.wid = self.alice.workspace()['body']['workspace']['id']
        for name in ('bob', 'eve'):
            self.alice.call('POST', f'/v1/workspaces/{self.wid}/members', {'username': name, 'role': 'member'})
        bob_id = self.bob.call('GET', '/v1/auth/session')['body']['user']['id']
        self.base = f'/v1/workspaces/{self.wid}/social/conversations'
        self.cid = self.alice.call('POST', self.base, {'kind': 'dm', 'member_ids': [bob_id]},
                                   {'HTTP_IDEMPOTENCY_KEY': 'react-dm-000000001'})['body']['conversation']['id']
        self.mid = self.alice.call('POST', f'{self.base}/{self.cid}/messages', {'body': '方案已上传'},
                                   {'HTTP_IDEMPOTENCY_KEY': 'react-msg-00000001'})['body']['message']['id']
        self.path = f'{self.base}/{self.cid}/messages/{self.mid}/reactions'

    def snapshot(self, client):
        return client.call('GET', f'{self.base}/{self.cid}')['body']['items'][0]['reactions']

    def test_toggle_counts_mine_and_idempotency(self):
        self.assertEqual(self.snapshot(self.alice), [])
        first = self.bob.call('POST', self.path, {'emoji': '👍', 'active': True})
        self.assertEqual(first['status'], 200, first)
        self.assertEqual(first['body']['reactions'], [{'emoji': '👍', 'count': 1, 'mine': True}])
        self.bob.call('POST', self.path, {'emoji': '👍', 'active': True})  # idempotent
        self.alice.call('POST', self.path, {'emoji': '🎉', 'active': True})
        self.alice.call('POST', self.path, {'emoji': '👍', 'active': True})
        self.assertEqual(self.snapshot(self.bob), [{'emoji': '👍', 'count': 2, 'mine': True},
                                                   {'emoji': '🎉', 'count': 1, 'mine': False}])
        self.bob.call('POST', self.path, {'emoji': '👍', 'active': False})
        self.assertEqual(self.snapshot(self.bob), [{'emoji': '👍', 'count': 1, 'mine': False},
                                                   {'emoji': '🎉', 'count': 1, 'mine': False}])
        paged = self.bob.call('GET', f'{self.base}/{self.cid}/messages')['body']['items'][0]['reactions']
        self.assertEqual(len(paged), 2)

    def test_validation_membership_and_retraction(self):
        for bad in ({'emoji': '💩', 'active': True}, {'emoji': '👍'}, {'emoji': '👍', 'active': 1}, {}):
            self.assertEqual(self.bob.call('POST', self.path, bad)['status'], 400, bad)
        self.assertEqual(self.eve.call('POST', self.path, {'emoji': '👍', 'active': True})['status'], 404)
        missing = f'{self.base}/{self.cid}/messages/{"0" * 32}/reactions'
        self.assertEqual(self.bob.call('POST', missing, {'emoji': '👍', 'active': True})['status'], 404)
        self.assertIn(self.bob.call('POST', self.path, {'emoji': '👍', 'active': True}, csrf=False)['status'], (401, 403))
        self.bob.call('POST', self.path, {'emoji': '👍', 'active': True})
        self.alice.call('POST', f'{self.base}/{self.cid}/messages/{self.mid}/retract', {'revision': 1})
        self.assertEqual(self.snapshot(self.bob), [])
        self.assertEqual(self.bob.call('POST', self.path, {'emoji': '👀', 'active': True})['status'], 409)


if __name__ == '__main__':
    unittest.main()
