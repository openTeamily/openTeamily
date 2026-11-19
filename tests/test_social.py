"""Human-to-human workspace messenger (issue #86). No agent or vendor is contacted."""
from dataclasses import replace
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class SocialMessengerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = 1800000000
        self.app = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                       clock=lambda: self.now)
        self.alice = Client(self.app)
        self.alice.register('alice')
        self.bob = Client(self.app, peer='127.0.0.2')
        self.bob.register('bob')
        self.carol = Client(self.app, peer='127.0.0.3')
        self.carol.register('carol')
        self.eve = Client(self.app, peer='127.0.0.4')
        self.eve.register('eve')
        self.wid = self.alice.workspace()['body']['workspace']['id']
        for client, username in ((self.bob, 'bob'), (self.carol, 'carol')):
            self.alice.call('POST', f'/v1/workspaces/{self.wid}/members',
                            {'username': username, 'role': 'member'})
        self.alice_id = self._user_id(self.alice)
        self.bob_id = self._user_id(self.bob)
        self.carol_id = self._user_id(self.carol)

    def _user_id(self, client):
        return client.call('GET', '/v1/auth/session')['body']['user']['id']

    def base(self, workspace_id=None):
        return f'/v1/workspaces/{workspace_id or self.wid}/social/conversations'

    def create(self, client, kind, member_ids, title=None, key='social-create-0001'):
        body = {'kind': kind, 'member_ids': member_ids}
        if title is not None:
            body['title'] = title
        return client.call('POST', self.base(), body, {'HTTP_IDEMPOTENCY_KEY': key})

    def test_direct_message_persists_both_ways_and_replays(self):
        created = self.create(self.alice, 'dm', [self.bob_id])
        self.assertEqual(created['status'], 201, created)
        conv = created['body']['conversation']
        self.assertEqual(conv['kind'], 'dm')
        self.assertEqual(conv['title'], 'bob')
        self.assertEqual({m['username'] for m in conv['members']}, {'alice', 'bob'})
        listed = self.bob.call('GET', self.base())
        self.assertEqual(listed['status'], 200)
        self.assertEqual([row['id'] for row in listed['body']['items']], [conv['id']])
        sent = self.alice.call(
            'POST', self.base() + f'/{conv["id"]}/messages', {'body': '你好 Bob'},
            {'HTTP_IDEMPOTENCY_KEY': 'social-msg-00001'})
        self.assertEqual(sent['status'], 201, sent)
        self.assertEqual(sent['body']['message']['body'], '你好 Bob')
        self.assertEqual(sent['body']['message']['user_id'], self._user_id(self.alice))
        reply = self.bob.call(
            'POST', self.base() + f'/{conv["id"]}/messages', {'body': '你好 Alice'},
            {'HTTP_IDEMPOTENCY_KEY': 'social-msg-00002'})
        self.assertEqual(reply['status'], 201, reply)
        snapshot = self.bob.call('GET', self.base() + f'/{conv["id"]}')
        self.assertEqual(snapshot['status'], 200)
        self.assertEqual([m['body'] for m in snapshot['body']['items']], ['你好 Bob', '你好 Alice'])
        replay = self.alice.call(
            'POST', self.base() + f'/{conv["id"]}/messages', {'body': '你好 Bob'},
            {'HTTP_IDEMPOTENCY_KEY': 'social-msg-00001'})
        self.assertEqual(replay['status'], 200)
        self.assertEqual(replay['body']['message']['id'], sent['body']['message']['id'])
        conflict = self.alice.call(
            'POST', self.base() + f'/{conv["id"]}/messages', {'body': '不同内容'},
            {'HTTP_IDEMPOTENCY_KEY': 'social-msg-00001'})
        self.assertEqual(conflict['status'], 409)
        second_dm = self.create(self.alice, 'dm', [self.bob_id], key='social-create-0009')
        self.assertEqual(second_dm['status'], 200)
        self.assertEqual(second_dm['body']['conversation']['id'], conv['id'])

    def test_group_conversation_and_isolation(self):
        created = self.create(self.bob, 'group', [self.alice_id, self.carol_id],
                              title='产品群', key='social-group-0001')
        self.assertEqual(created['status'], 201, created)
        conv = created['body']['conversation']
        self.assertEqual(conv['kind'], 'group')
        self.assertEqual(conv['title'], '产品群')
        self.assertEqual({m['username'] for m in conv['members']}, {'alice', 'bob', 'carol'})
        self.assertEqual(self.carol.call('GET', self.base() + f'/{conv["id"]}')['status'], 200)
        self.assertEqual(self.eve.call('GET', self.base() + f'/{conv["id"]}')['status'], 404)
        self.assertEqual(self.eve.call('GET', self.base())['status'], 404)
        self.assertEqual(self.eve.call(
            'POST', self.base() + f'/{conv["id"]}/messages', {'body': '外人'},
            {'HTTP_IDEMPOTENCY_KEY': 'social-msg-00003'})['status'], 404)
        outsider = self.create(self.alice, 'group', [self._user_id(self.eve)],
                               key='social-group-0002')
        self.assertEqual(outsider['status'], 400)

    def test_validation_and_cross_workspace(self):
        self.assertEqual(self.create(self.alice, 'channel', [self.bob_id])['status'], 400)
        self.assertEqual(self.create(self.alice, 'dm', [])['status'], 400)
        self.assertEqual(self.create(self.alice, 'dm', [self.bob_id, self.carol_id])['status'], 400)
        self.assertEqual(self.create(self.alice, 'dm', [self.alice_id])['status'], 400)
        missing_key = self.alice.call('POST', self.base(), {'kind': 'dm', 'member_ids': [self.bob_id]})
        self.assertEqual(missing_key['status'], 400)
        other = self.bob.workspace('bob-space', 'request_example_0002')['body']['workspace']['id']
        self.assertEqual(self.alice.call('GET', self.base(other))['status'], 404)
        self.assertEqual(self.create(self.alice, 'dm', [self.bob_id])['status'], 201)
        # A DM is deduplicated per workspace even under a different idempotency key.
        self.assertEqual(self.create(self.alice, 'dm', [self.bob_id], key='social-create-0003')['status'], 200)

    def make_agent(self, client=None, wid=None, name='Group helper'):
        return (client or self.alice).call(
            'POST', f'/v1/workspaces/{wid or self.wid}/agents', {'name': name},
            {'HTTP_IDEMPOTENCY_KEY': 'social-agent-create1'})['body']['agent']['id']

    def test_group_agent_members_persist_snapshot_list_and_idempotency(self):
        agent_id = self.make_agent()
        body = {'kind': 'group', 'member_ids': [self.bob_id], 'agent_ids': [agent_id]}
        headers = {'HTTP_IDEMPOTENCY_KEY': 'social-group-agent01'}
        created = self.alice.call('POST', self.base(), body, headers)
        self.assertEqual(created['status'], 201, created)
        conv = created['body']['conversation']
        self.assertEqual({m['user_id'] for m in conv['members']}, {self.alice_id, self.bob_id})
        self.assertEqual(conv['agent_members'], [
            {'agent_id': agent_id, 'name': 'Group helper', 'archived': 0, 'created': self.now}])
        # Reopen the same store; migration is repeatable and version stays 1.
        reopened = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                       clock=lambda: self.now)
        self.bob.app = reopened
        snapshot = self.bob.call('GET', self.base() + '/' + conv['id'])
        self.assertEqual(snapshot['body']['conversation']['agent_members'], conv['agent_members'])
        self.assertEqual(self.bob.call('GET', self.base())['body']['items'][0]['agent_members'],
                         conv['agent_members'])
        replay = self.alice.call('POST', self.base(), body, headers)
        self.assertEqual(replay['status'], 200)
        self.assertEqual(replay['body']['conversation']['id'], conv['id'])
        self.assertEqual(self.alice.call('POST', self.base(), {**body, 'agent_ids': []}, headers)['status'], 409)
        self.assertEqual(self.eve.call('GET', self.base() + '/' + conv['id'])['status'], 404)
        # Human messages still work, without triggering an agent task or reply.
        sent = self.bob.call('POST', self.base() + '/' + conv['id'] + '/messages', {'body': 'Hello'},
                             {'HTTP_IDEMPOTENCY_KEY': 'social-group-agent-msg1'})
        self.assertEqual(sent['status'], 201)
        self.assertEqual(len(self.bob.call('GET', self.base() + '/' + conv['id'])['body']['items']), 1)
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/agents/{agent_id}/archive', {'revision': 1})
        archived = self.bob.call('GET', self.base() + '/' + conv['id'])
        self.assertEqual(archived['body']['conversation']['agent_members'][0]['archived'], 1)
        with self.app.store.connect() as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 1)

    def test_existing_v1_store_adds_agent_table_without_changing_human_groups(self):
        old = self.create(self.alice, 'group', [self.bob_id])['body']['conversation']
        with self.app.store.connect() as db:
            db.execute('DROP TABLE social_agent_members')
            db.commit()
        Store(Path(self.temp.name) / 'state')
        snapshot = self.alice.call('GET', self.base() + '/' + old['id'])
        self.assertEqual(snapshot['status'], 200)
        self.assertEqual(snapshot['body']['conversation']['agent_members'], [])
        self.assertEqual(snapshot['body']['conversation']['members'], old['members'])
        # Legacy human-only idempotency hashes are not altered by an empty agent list.
        replay = self.alice.call('POST', self.base(), {
            'kind': 'group', 'member_ids': [self.bob_id], 'agent_ids': []},
            {'HTTP_IDEMPOTENCY_KEY': 'social-create-0001'})
        self.assertEqual(replay['status'], 200)
        self.assertEqual(replay['body']['conversation']['id'], old['id'])

    def test_agent_validation_preserves_human_and_dm_rules(self):
        agent_id = self.make_agent()
        other = self.eve.workspace()['body']['workspace']['id']
        foreign = self.make_agent(self.eve, other)
        base = {'kind': 'group', 'member_ids': [self.bob_id], 'agent_ids': [agent_id]}
        headers = {'HTTP_IDEMPOTENCY_KEY': 'social-group-agent02'}
        bad = [None, 'invalid', [agent_id, agent_id], ['z' * 32], ['f' * 32], [foreign]]
        for ids in bad:
            result = self.alice.call('POST', self.base(), {**base, 'agent_ids': ids}, headers)
            self.assertEqual(result['status'], 400, result)
            self.assertEqual(result['body']['error']['code'], 'invalid')
        for change in [{'member_ids': []}, {'member_ids': [self.alice_id]}, {'kind': 'dm'}]:
            self.assertEqual(self.alice.call('POST', self.base(), {**base, **change}, headers)['status'], 400)
        # Member capacity counts human and agent participants together.
        old = self.app.config
        self.app.config = replace(old, max_social_members_per_conversation=2)
        try:
            self.assertEqual(self.alice.call('POST', self.base(), base, headers)['status'], 429)
        finally:
            self.app.config = old
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/agents/{agent_id}/archive', {'revision': 1})
        self.assertEqual(self.alice.call('POST', self.base(), base, headers)['status'], 400)

    def test_listing_preview_is_last_authorized_snippet(self):
        created = self.create(self.alice, 'dm', [self.bob_id], key='social-preview-0001')
        self.assertEqual(created['status'], 201, created)
        conv = created['body']['conversation']
        self.assertEqual(conv['preview'], '')
        empty = self.alice.call('GET', self.base())
        self.assertEqual(empty['status'], 200)
        self.assertEqual(empty['body']['items'][0]['preview'], '')
        self.alice.call(
            'POST', self.base() + f'/{conv["id"]}/messages', {'body': '  第一句\n请看这里  '},
            {'HTTP_IDEMPOTENCY_KEY': 'social-preview-msg01'})
        mid = self.alice.call('GET', self.base())
        self.assertEqual(mid['body']['items'][0]['preview'], '第一句 请看这里')
        long_body = '预览' + ('很长的正文内容' * 30)
        self.bob.call(
            'POST', self.base() + f'/{conv["id"]}/messages', {'body': long_body},
            {'HTTP_IDEMPOTENCY_KEY': 'social-preview-msg02'})
        listed = self.alice.call('GET', self.base())
        self.assertEqual(listed['status'], 200)
        item = listed['body']['items'][0]
        self.assertEqual(item['id'], conv['id'])
        from openteamily.search import snippet
        self.assertEqual(item['preview'], snippet(long_body))
        self.assertLessEqual(len(item['preview']), 161)
        self.assertTrue(item['preview'].endswith('…'))
        self.assertNotIn(long_body, item['preview'])
        self.assertNotIn('body', item)
        snapshot = self.bob.call('GET', self.base() + f'/{conv["id"]}')
        self.assertEqual(snapshot['body']['conversation']['preview'], snippet(long_body))
        # A later conversation Eve cannot join should not appear in Eve's workspace list.
        self.assertEqual(self.eve.call('GET', self.base())['status'], 404)


if __name__ == '__main__':
    unittest.main()


    def test_unread_is_per_user_and_read_ack_is_snapshot_bounded(self):
        created = self.create(self.alice, 'dm', [self.bob_id])
        cid = created['body']['conversation']['id']
        base = self.base() + '/' + cid
        def send(client, key):
            return client.call('POST', base + '/messages', {'body': key},
                               {'HTTP_IDEMPOTENCY_KEY': key})['body']['message']['id']
        def unread(client):
            return client.call('GET', self.base())['body']['items'][0]['unread_count']
        first = send(self.alice, 'unread-message-0001')
        self.assertEqual(unread(self.alice), 0)
        self.assertEqual(unread(self.bob), 1)
        # Reading a snapshot is read-only and does not acknowledge it.
        self.assertEqual(self.bob.call('GET', base)['body']['conversation']['unread_count'], 1)
        self.assertEqual(unread(self.bob), 1)
        second = send(self.alice, 'unread-message-0002')
        ack = self.bob.call('POST', base + '/read', {'message_id': first})
        self.assertEqual(ack['status'], 200, ack)
        self.assertEqual(ack['body']['unread_count'], 1)
        self.assertEqual(self.bob.call('POST', base + '/read', {'message_id': second})['body']['unread_count'], 0)
        # Older acknowledgements cannot move the cursor backwards.
        self.assertEqual(self.bob.call('POST', base + '/read', {'message_id': first})['body']['unread_count'], 0)
        send(self.bob, 'unread-message-0003')
        self.assertEqual(unread(self.alice), 1)
        self.assertEqual(unread(self.bob), 0)
        # Cursor persists across a new App with the same private SQLite store.
        self.bob.app = App(self.app.store, Config(ORIGIN, allow_registration=True), clock=lambda: self.now)
        self.assertEqual(unread(self.bob), 0)

    def test_read_ack_permissions_csrf_and_cross_conversation_ids(self):
        cid = self.create(self.alice, 'dm', [self.bob_id])['body']['conversation']['id']
        base = self.base() + '/' + cid
        sent = self.alice.call('POST', base + '/messages', {'body': 'private'},
                               {'HTTP_IDEMPOTENCY_KEY': 'unread-private-0001'})['body']['message']['id']
        for client in (self.eve, self.carol):
            self.assertEqual(client.call('POST', base + '/read', {'message_id': sent})['status'], 404)
        self.assertEqual(self.bob.call('POST', base + '/read', {'message_id': sent}, csrf=False)['status'], 403)
        self.assertEqual(self.bob.call('POST', base + '/read', {'message_id': sent}, origin='https://evil.test')['status'], 403)
        self.assertEqual(self.bob.call('POST', base + '/read', {'message_id': 'bad'})['status'], 400)
        other = self.create(self.alice, 'dm', [self.carol_id], key='unread-other-create')['body']['conversation']['id']
        self.assertEqual(self.alice.call('POST', self.base() + '/' + other + '/read', {'message_id': sent})['status'], 404)
