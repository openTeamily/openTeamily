"""Message tools: pinned messages and (multi-select) forwarding (issue #86). No vendor is contacted."""
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class MessageToolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.app = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                       clock=lambda: 1800000000)
        self.alice, self.bob, self.carol = Client(self.app), Client(self.app, peer='127.0.0.2'), Client(self.app, peer='127.0.0.3')
        for client, name in ((self.alice, 'alice'), (self.bob, 'bob'), (self.carol, 'carol')):
            client.register(name)
        self.wid = self.alice.workspace()['body']['workspace']['id']
        for name in ('bob', 'carol'):
            self.alice.call('POST', f'/v1/workspaces/{self.wid}/members', {'username': name, 'role': 'member'})
        ids = {n: c.call('GET', '/v1/auth/session')['body']['user']['id'] for n, c in
               (('bob', self.bob), ('carol', self.carol))}
        self.base = f'/v1/workspaces/{self.wid}/social/conversations'
        self.source = self.alice.call('POST', self.base, {'kind': 'dm', 'member_ids': [ids['bob']]},
                                      {'HTTP_IDEMPOTENCY_KEY': 'tools-dm-000000001'})['body']['conversation']['id']
        self.target = self.alice.call('POST', self.base, {'kind': 'group', 'member_ids': [ids['carol']], 'title': '私密源外的群'},
                                      {'HTTP_IDEMPOTENCY_KEY': 'tools-grp-00000001'})['body']['conversation']['id']
        self.n = 0

    def send(self, client, text, conv=None):
        self.n += 1
        return client.call('POST', f'{self.base}/{conv or self.source}/messages', {'body': text},
                           {'HTTP_IDEMPOTENCY_KEY': f'tools-msg-{self.n:08d}'})['body']['message']['id']

    def test_explicit_save_is_durable_idempotent_and_membership_checked(self):
        mid = self.send(self.bob, 'A durable decision')
        path = f'{self.base}/{self.source}/messages/{mid}/save'
        payload = {'title': 'Decision copy', 'revision': 1}
        self.assertEqual(self.carol.call('POST', path, payload)['status'], 404)
        self.assertEqual(self.alice.call('POST', path, payload, csrf=False)['status'], 403)
        self.assertEqual(self.alice.call('POST', path, {**payload, 'revision': 2})['status'], 409)
        saved = self.alice.call('POST', path, payload)
        self.assertEqual(saved['status'], 201, saved)
        aid = saved['body']['artifact']['id']
        again = self.bob.call('POST', path, payload)
        self.assertEqual(again['status'], 200, again)
        self.assertEqual(again['body']['artifact']['id'], aid)
        # The explicit workspace copy is readable by other workspace members.
        read = self.carol.call('GET', f'/v1/workspaces/{self.wid}/artifacts/{aid}')
        self.assertEqual(read['body']['artifact']['body'], 'A durable decision')
        self.bob.call('POST', f'{self.base}/{self.source}/messages/{mid}/retract', {'revision': 1})
        self.assertEqual(self.alice.call('POST', path, payload)['status'], 409)
        self.assertEqual(self.carol.call('GET', f'/v1/workspaces/{self.wid}/artifacts/{aid}')['status'], 200)
        # Reopen the store: the saved text and source survive app instances.
        reopened = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True), clock=lambda: 1800000000)
        with reopened.store.connect() as db:
            self.assertEqual(db.execute('SELECT body FROM artifacts WHERE id=?', (aid,)).fetchone()['body'], 'A durable decision')

    def test_pin_unpin_and_retraction(self):
        first, second = self.send(self.alice, '决议：周五上线'), self.send(self.bob, '收到')
        pinned = self.bob.call('POST', f'{self.base}/{self.source}/messages/{first}/pin', {'pinned': True})
        self.assertEqual(pinned['status'], 200, pinned)
        self.assertEqual([(p['message_id'], p['pinned_by_username']) for p in pinned['body']['pinned_messages']],
                         [(first, 'bob')])
        self.bob.call('POST', f'{self.base}/{self.source}/messages/{first}/pin', {'pinned': True})  # idempotent
        snap = self.alice.call('GET', f'{self.base}/{self.source}')['body']
        self.assertEqual([p['excerpt'] for p in snap['pinned_messages']], ['决议：周五上线'])
        self.assertEqual(self.alice.call('POST', f'{self.base}/{self.source}/messages/{first}/pin',
                                         {'pinned': False})['body']['pinned_messages'], [])
        self.alice.call('POST', f'{self.base}/{self.source}/messages/{second}/pin', {'pinned': True})
        self.bob.call('POST', f'{self.base}/{self.source}/messages/{second}/retract', {'revision': 1})
        self.assertEqual(self.alice.call('GET', f'{self.base}/{self.source}')['body']['pinned_messages'], [])
        self.assertEqual(self.alice.call('POST', f'{self.base}/{self.source}/messages/{second}/pin',
                                         {'pinned': True})['status'], 409)
        self.assertEqual(self.carol.call('POST', f'{self.base}/{self.source}/messages/{first}/pin',
                                         {'pinned': True})['status'], 404)
        self.assertEqual(self.alice.call('POST', f'{self.base}/{self.source}/messages/{first}/pin',
                                         {'pinned': 'yes'})['status'], 400)

    def test_multi_forward_preserves_order_author_and_privacy(self):
        a, b = self.send(self.alice, '第一条'), self.send(self.bob, '第二条')
        path = f'{self.base}/{self.source}/forward'
        body = {'message_ids': [b, a], 'target_conversation_id': self.target}
        headers = {'HTTP_IDEMPOTENCY_KEY': 'tools-fwd-00000001'}
        sent = self.alice.call('POST', path, body, headers)
        self.assertEqual(sent['status'], 201, sent)
        self.assertEqual([m['body'] for m in sent['body']['items']], ['第一条', '第二条'])
        self.assertEqual([m['forwarded_from'] for m in sent['body']['items']], [{'author': 'alice'}, {'author': 'bob'}])
        seen = self.carol.call('GET', f'{self.base}/{self.target}')['body']['items']
        self.assertEqual([(m['body'], m['forwarded_from']['author']) for m in seen],
                         [('第一条', 'alice'), ('第二条', 'bob')])
        self.assertNotIn(self.source, str(seen))
        replay = self.alice.call('POST', path, body, headers)
        self.assertEqual((replay['status'], len(replay['body']['items'])), (200, 2))
        self.assertEqual(len(self.carol.call('GET', f'{self.base}/{self.target}')['body']['items']), 2)
        self.assertEqual(self.alice.call('POST', path, {**body, 'message_ids': [a]}, headers)['status'], 409)

    def test_forward_validation_and_membership(self):
        a = self.send(self.alice, '原文')
        path = f'{self.base}/{self.source}/forward'
        key = {'HTTP_IDEMPOTENCY_KEY': 'tools-fwd-00000002'}
        # bob is not in the target group, so he cannot forward there.
        self.assertEqual(self.bob.call('POST', path, {'message_ids': [a], 'target_conversation_id': self.target}, key)['status'], 404)
        # carol cannot read the source.
        self.assertEqual(self.carol.call('POST', path, {'message_ids': [a], 'target_conversation_id': self.target}, key)['status'], 404)
        for bad in ({'message_ids': [], 'target_conversation_id': self.target},
                    {'message_ids': [a, a], 'target_conversation_id': self.target},
                    {'message_ids': [a], 'target_conversation_id': 'x'},
                    {'message_ids': ['0' * 32] * 21, 'target_conversation_id': self.target}):
            self.assertEqual(self.alice.call('POST', path, bad, key)['status'], 400, bad)
        self.assertEqual(self.alice.call('POST', path, {'message_ids': ['0' * 32], 'target_conversation_id': self.target},
                                         key)['status'], 404)
        self.assertEqual(self.alice.call('POST', path, {'message_ids': [a], 'target_conversation_id': self.target})['status'], 400)
        self.alice.call('POST', f'{self.base}/{self.source}/messages/{a}/retract', {'revision': 1})
        self.assertEqual(self.alice.call('POST', path, {'message_ids': [a], 'target_conversation_id': self.target},
                                         key)['status'], 409)


if __name__ == '__main__':
    unittest.main()
