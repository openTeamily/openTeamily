"""Workspace meeting notes and action items (issue #212). In-process WSGI."""
from dataclasses import replace
from pathlib import Path
import sqlite3
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class MeetingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'state'
        self.app = App(Store(self.path), Config(ORIGIN, allow_registration=True),
                       clock=lambda: 1800000000)
        self.alice = Client(self.app)
        self.alice.register('alice')
        self.bob = Client(self.app, peer='127.0.0.2')
        self.bob.register('bob')
        self.eve = Client(self.app, peer='127.0.0.3')
        self.eve.register('eve')
        self.wid = self.alice.workspace()['body']['workspace']['id']
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/members', {'username': 'bob', 'role': 'member'})

    def base(self, meeting_id=''):
        return f'/v1/workspaces/{self.wid}/meetings{("/" + meeting_id) if meeting_id else ""}'

    def create(self, client=None, key='meeting-create-0001', **fields):
        body = {'title': '周会', 'attendees': ['alice', 'bob'], 'summary': '同步进度。',
                'transcript': '大家讨论了排期。',
                'action_items': [{'text': '订会议室', 'owner': 'bob'}]}
        body.update(fields)
        return (client or self.alice).call('POST', self.base(), body, {'HTTP_IDEMPOTENCY_KEY': key})

    def test_create_list_read_update_remove(self):
        created = self.create()
        self.assertEqual(created['status'], 201, created)
        meeting = created['body']['meeting']
        self.assertEqual(meeting['title'], '周会')
        self.assertEqual(meeting['started_at'], 1800000000)
        self.assertEqual(meeting['action_count'], 1)
        self.assertEqual(meeting['done_count'], 0)
        replay = self.create()
        self.assertEqual(replay['status'], 200)
        self.assertEqual(replay['body']['meeting']['id'], meeting['id'])
        conflict = self.create(title='另一个会')
        self.assertEqual(conflict['status'], 409)
        duplicate = self.create(key='meeting-create-0002')
        self.assertEqual(duplicate['status'], 409)
        listed = self.alice.call('GET', self.base() + '?limit=20')
        self.assertEqual(listed['status'], 200)
        item = listed['body']['items'][0]
        self.assertEqual(item['title'], '周会')
        self.assertNotIn('transcript', item)
        self.assertNotIn('action_items', item)
        self.assertEqual(item['action_count'], 1)
        seen = self.alice.call('GET', self.base(meeting['id']))
        self.assertEqual(seen['body']['meeting']['transcript'], '大家讨论了排期。')
        updated = self.alice.call('POST', self.base(meeting['id']), {
            'revision': 1,
            'changes': {'summary': '已确认排期。', 'action_items': [
                {'text': '订会议室', 'owner': 'bob', 'done': True},
                {'text': '发会议纪要', 'owner': 'alice'}]}})
        self.assertEqual(updated['status'], 200, updated)
        self.assertEqual(updated['body']['meeting']['revision'], 2)
        self.assertEqual(updated['body']['meeting']['done_count'], 1)
        stale = self.alice.call('POST', self.base(meeting['id']), {'revision': 1, 'changes': {'summary': 'x'}})
        self.assertEqual(stale['status'], 409)
        same = self.alice.call('POST', self.base(meeting['id']), {'revision': 2, 'changes': {'summary': '已确认排期。'}})
        self.assertEqual(same['status'], 200)
        self.assertEqual(same['body']['meeting']['revision'], 2)
        removed = self.alice.call('POST', self.base(meeting['id']) + '/remove', {})
        self.assertEqual(removed['status'], 200)
        self.assertEqual(self.alice.call('GET', self.base(meeting['id']))['status'], 404)
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 1)

    def test_permissions_and_bounds(self):
        bob_meeting = self.create(self.bob, key='meeting-create-bob01', title='Bob 的会')
        self.assertEqual(bob_meeting['status'], 201)
        mid = bob_meeting['body']['meeting']['id']
        self.assertEqual(self.alice.call('POST', self.base(mid), {
            'revision': 1, 'changes': {'summary': 'owner edit'}})['status'], 200)
        alice_meeting = self.create(key='meeting-create-alice2', title='Alice 的会')
        amid = alice_meeting['body']['meeting']['id']
        self.assertEqual(self.bob.call('POST', self.base(amid), {
            'revision': 1, 'changes': {'summary': 'member edit'}})['status'], 403)
        self.assertEqual(self.bob.call('POST', self.base(amid) + '/remove', {})['status'], 403)
        self.assertEqual(self.eve.call('GET', self.base())['status'], 404)
        bad = [
            {'title': ''},
            {'title': 'x' * 121},
            {'started_at': True},
            {'started_at': 4102444801},
            {'attendees': ['a', 'A']},
            {'attendees': ['x' * 81]},
            {'transcript': 'x' * 40001},
            {'summary': 'x' * 8001},
            {'action_items': [{'text': ''}]},
            {'action_items': [{'text': 'x', 'done': 'yes'}]},
            {'action_items': [{'text': 'x'} for _ in range(51)]},
        ]
        for index, fields in enumerate(bad):
            payload = {'title': '坏%d' % index}
            payload.update(fields)
            self.assertEqual(self.create(key='meeting-bad-%04d' % index, **payload)['status'], 400, fields)
        self.assertEqual(self.alice.call('POST', self.base(), {'title': 'x'}, csrf=False)['status'], 403)

    def test_capacity(self):
        limited = App(Store(Path(self.temp.name) / 'limited'), Config(
            ORIGIN, allow_registration=True, max_meetings_per_workspace=1), clock=lambda: 1800000000)
        client = Client(limited)
        client.register('alice')
        wid = client.workspace()['body']['workspace']['id']
        base = f'/v1/workspaces/{wid}/meetings'
        self.assertEqual(client.call('POST', base, {'title': '一'}, {'HTTP_IDEMPOTENCY_KEY': 'meeting-cap-0001'})['status'], 201)
        self.assertEqual(client.call('POST', base, {'title': '二'}, {'HTTP_IDEMPOTENCY_KEY': 'meeting-cap-0002'})['status'], 429)


if __name__ == '__main__':
    unittest.main()
