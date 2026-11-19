"""@mention notification center (issues #4 #86). No agent, vendor or push service is contacted."""
from pathlib import Path
import tempfile
import unittest

from openteamily import notifications
from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class MentionParsingTests(unittest.TestCase):
    def test_boundaries(self):
        self.assertEqual(notifications.mentioned_names('@bob 看一下 @carol。@bob'), ['bob', 'carol'])
        self.assertEqual(notifications.mentioned_names('mail bob@example.com'), [])
        self.assertEqual(notifications.mentioned_names('ping @bob.'), ['bob'])
        self.assertEqual(notifications.mentioned_names('@@bob'), [])
        self.assertEqual(notifications.mentioned_names('（@bob）'), ['bob'])


class MentionNotificationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = 1800000000
        self.app = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                       clock=lambda: self.now)
        self.alice, self.bob = Client(self.app), Client(self.app, peer='127.0.0.2')
        self.carol, self.eve = Client(self.app, peer='127.0.0.3'), Client(self.app, peer='127.0.0.4')
        for client, name in ((self.alice, 'alice'), (self.bob, 'bob'), (self.carol, 'carol'), (self.eve, 'eve')):
            client.register(name)
        self.wid = self.alice.workspace()['body']['workspace']['id']
        for name in ('bob', 'carol', 'eve'):
            self.alice.call('POST', f'/v1/workspaces/{self.wid}/members', {'username': name, 'role': 'member'})
        ids = {name: c.call('GET', '/v1/auth/session')['body']['user']['id']
               for name, c in (('alice', self.alice), ('bob', self.bob), ('carol', self.carol), ('eve', self.eve))}
        self.ids = ids
        self.base = f'/v1/workspaces/{self.wid}/social/conversations'
        self.conv = self.alice.call('POST', self.base, {'kind': 'group', 'member_ids': [ids['bob'], ids['carol']],
                                                         'title': '项目群'},
                                    {'HTTP_IDEMPOTENCY_KEY': 'notify-group-00001'})['body']['conversation']['id']
        self.inbox = f'/v1/workspaces/{self.wid}/notifications'
        self.keys = 0

    def send(self, client, body, conv=None):
        self.keys += 1
        return client.call('POST', f'{self.base}/{conv or self.conv}/messages', {'body': body},
                           {'HTTP_IDEMPOTENCY_KEY': f'notify-msg-{self.keys:08d}'})

    def test_mentions_notify_members_only_once_and_never_the_author_or_outsiders(self):
        sent = self.send(self.alice, '@bob @carol @eve @alice 请看方案，@bob')
        self.assertEqual(sent['status'], 201, sent)
        bob = self.bob.call('GET', self.inbox)
        self.assertEqual(bob['status'], 200, bob)
        self.assertEqual(bob['body']['unread_count'], 1)
        item = bob['body']['items'][0]
        self.assertEqual((item['kind'], item['actor_username'], item['conversation_title'], item['read']),
                         ('mention', 'alice', '项目群', False))
        self.assertEqual(item['message_id'], sent['body']['message']['id'])
        self.assertEqual(self.carol.call('GET', self.inbox)['body']['unread_count'], 1)
        # eve is a workspace member but not in the group; the author never notifies herself.
        self.assertEqual(self.eve.call('GET', self.inbox)['body']['items'], [])
        self.assertEqual(self.alice.call('GET', self.inbox)['body']['items'], [])

    def test_idempotent_replay_does_not_duplicate(self):
        headers = {'HTTP_IDEMPOTENCY_KEY': 'notify-replay-0001'}
        path = f'{self.base}/{self.conv}/messages'
        self.assertEqual(self.alice.call('POST', path, {'body': '@bob hi'}, headers)['status'], 201)
        self.assertEqual(self.alice.call('POST', path, {'body': '@bob hi'}, headers)['status'], 200)
        self.assertEqual(self.bob.call('GET', self.inbox)['body']['unread_count'], 1)

    def test_mark_one_all_and_conversation_read(self):
        first = self.send(self.alice, '@bob first')['body']['message']
        self.send(self.carol, '@bob second')
        items = self.bob.call('GET', self.inbox)['body']['items']
        self.assertEqual([i['excerpt'] for i in items], ['@bob second', '@bob first'])
        marked = self.bob.call('POST', self.inbox + '/read', {'notification_id': items[1]['id']})
        self.assertEqual(marked['body']['unread_count'], 1)
        unread = self.bob.call('GET', self.inbox + '?filter=unread')['body']['items']
        self.assertEqual([i['excerpt'] for i in unread], ['@bob second'])
        # Another user cannot mark bob's notification.
        self.assertEqual(self.carol.call('POST', self.inbox + '/read', {'notification_id': items[0]['id']})['status'], 404)
        self.assertEqual(self.bob.call('POST', self.inbox + '/read', {'all': True})['body']['unread_count'], 0)
        self.send(self.alice, '@bob third')
        latest = self.bob.call('GET', f'{self.base}/{self.conv}')['body']['items'][-1]
        self.bob.call('POST', f'{self.base}/{self.conv}/read', {'message_id': first['id']})
        self.assertEqual(self.bob.call('GET', self.inbox)['body']['unread_count'], 1)
        self.bob.call('POST', f'{self.base}/{self.conv}/read', {'message_id': latest['id']})
        self.assertEqual(self.bob.call('GET', self.inbox)['body']['unread_count'], 0)

    def test_retracted_message_hides_and_validation(self):
        sent = self.send(self.alice, '@bob 临时')['body']['message']
        self.assertEqual(self.alice.call('POST', f'{self.base}/{self.conv}/messages/{sent["id"]}/retract',
                                         {'revision': 1})['status'], 200)
        self.assertEqual(self.bob.call('GET', self.inbox)['body'], {'items': [], 'unread_count': 0, 'limit': 100})
        for bad in ({}, {'all': False}, {'notification_id': 'x'}, {'all': True, 'notification_id': '0' * 32}):
            self.assertEqual(self.bob.call('POST', self.inbox + '/read', bad)['status'], 400, bad)
        self.assertEqual(self.bob.call('GET', self.inbox + '?filter=bogus')['status'], 400)
        other = self.eve.workspace('eve-space', 'request_example_0009')['body']['workspace']['id']
        self.assertEqual(self.bob.call('GET', f'/v1/workspaces/{other}/notifications')['status'], 404)

    def test_write_requires_csrf_and_store_reopens(self):
        self.send(self.alice, '@bob persisted')
        self.assertIn(self.bob.call('POST', self.inbox + '/read', {'all': True}, csrf=False)['status'], (401, 403))
        reopened = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                       clock=lambda: self.now)
        self.bob.app = reopened
        self.assertEqual(self.bob.call('GET', self.inbox)['body']['unread_count'], 1)


if __name__ == '__main__':
    unittest.main()
