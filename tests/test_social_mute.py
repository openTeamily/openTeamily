"""Per-user conversation mute: hidden badge and mention list, messages stay readable.

The badge is suppressed instead of the read position being advanced, so turning
mute back off restores the count for messages that arrived while it was on.
"""
import unittest

from tests import test_social as social_tests


class SocialMuteTests(unittest.TestCase):
    setUp = social_tests.SocialMessengerTests.setUp
    base = social_tests.SocialMessengerTests.base
    create = social_tests.SocialMessengerTests.create
    _user_id = social_tests.SocialMessengerTests._user_id

    def dm(self):
        created = self.create(self.alice, 'dm', [self.bob_id], key='mute-dm-create-0001')
        self.assertEqual(created['status'], 201, created)
        self.cid = created['body']['conversation']['id']
        return self.base() + '/' + self.cid

    def send(self, client, path, text, key):
        sent = client.call('POST', path + '/messages', {'body': text},
                           {'HTTP_IDEMPOTENCY_KEY': key})
        self.assertEqual(sent['status'], 201, sent)
        return sent['body']['message']

    def mute(self, client, path, value=True):
        return client.call('POST', path + '/preferences', {'muted': value})

    def unread(self, client, path):
        listed = client.call('GET', self.base())
        item = next(row for row in listed['body']['items'] if row['id'] == self.cid)
        return item['unread_count'], item['muted']

    def test_mute_hides_badge_and_mentions_without_consuming_read_state(self):
        path = self.dm()
        self.send(self.bob, path, '@alice 请看一下这个', 'mute-message-key-00001')
        self.assertEqual(self.unread(self.alice, path), (1, False))
        notifications = self.alice.call('GET', f'/v1/workspaces/{self.wid}/notifications')
        self.assertEqual(notifications['body']['unread_count'], 1)
        muted = self.mute(self.alice, path)
        self.assertEqual(muted['status'], 200, muted)
        self.assertEqual(muted['body'], {'pinned': False, 'muted': True})
        self.assertEqual(self.unread(self.alice, path), (0, True))
        detail = self.alice.call('GET', path)
        self.assertEqual(detail['body']['conversation']['unread_count'], 0)
        self.assertEqual(detail['body']['conversation']['muted'], True)
        self.assertEqual([item['body'] for item in detail['body']['items']], ['@alice 请看一下这个'])
        self.assertEqual(self.alice.call('GET', f'/v1/workspaces/{self.wid}/notifications')['body'],
                         {'items': [], 'unread_count': 0, 'limit': 100})
        # New traffic while muted stays out of both counters.
        self.send(self.bob, path, '还有一条', 'mute-message-key-00002')
        self.assertEqual(self.unread(self.alice, path), (0, True))
        self.assertEqual(self.alice.call('GET', f'/v1/workspaces/{self.wid}/notifications')
                         ['body']['unread_count'], 0)
        # The setting survives a reload: a fresh read reports the stored value.
        self.assertEqual(self.alice.call('GET', path)['body']['conversation']['muted'], True)
        # Turning it off restores the count for everything that arrived meanwhile.
        restored = self.mute(self.alice, path, False)
        self.assertEqual(restored['body'], {'pinned': False, 'muted': False})
        self.assertEqual(self.unread(self.alice, path), (2, False))
        self.assertEqual(self.alice.call('GET', f'/v1/workspaces/{self.wid}/notifications')
                         ['body']['unread_count'], 1)
        # Bob's own view never had a mute row.
        # Bob wrote both messages, so his own view carries no unread badge.
        self.assertEqual(self.unread(self.bob, path), (0, False))

    def test_mute_is_per_user_per_conversation_and_validated(self):
        path = self.dm()
        self.send(self.bob, path, '你好', 'mute-message-key-00003')
        second = self.create(self.alice, 'group', [self.bob_id], key='mute-group-create-0001')['body']['conversation']
        group_path = self.base() + '/' + second['id']
        self.assertEqual(self.mute(self.alice, path)['status'], 200)
        self.assertEqual(self.unread(self.alice, path), (0, True))
        # A different conversation keeps its badge.
        self.send(self.bob, group_path, '@alice 群里', 'mute-message-key-00004')
        listed = self.alice.call('GET', self.base())['body']['items']
        by_id = {row['id']: row for row in listed}
        self.assertEqual(by_id[self.cid]['unread_count'], 0)
        self.assertEqual(by_id[second['id']]['unread_count'], 1)
        self.assertEqual(self.alice.call('GET', f'/v1/workspaces/{self.wid}/notifications')
                         ['body']['unread_count'], 1)
        # Pinned stays independent of mute.
        pinned = self.alice.call('POST', path + '/preferences', {'pinned': True})
        self.assertEqual(pinned['body'], {'pinned': True, 'muted': True})
        self.assertEqual(self.mute(self.alice, path, False)['body'], {'pinned': True, 'muted': False})
        # Only the member can set it; malformed payloads are refused.
        self.assertEqual(self.mute(self.bob, path, 'yes')['status'], 400)
        self.assertEqual(self.alice.call('POST', path + '/preferences', {})['status'], 400)
        self.assertEqual(self.alice.call('POST', path + '/preferences', {'pinned': None})['status'], 400)
        self.assertEqual(self.eve.call('POST', path + '/preferences', {'muted': True})['status'], 404)
