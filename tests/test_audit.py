"""Append-only audit log tests. Temporary SQLite only; no HTTP routes are wired."""
from pathlib import Path
import tempfile
import unittest

from openteamily import audit
from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class AuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name).resolve() / 'state'
        self.app = App(Store(self.path), Config(ORIGIN, allow_registration=True), clock=lambda: 1800000000)
        self.alice = Client(self.app)
        self.alice_id = self.alice.register('alice')['body']['user']['id']
        self.bob = Client(self.app, peer='127.0.0.2')
        self.bob_id = self.bob.register('bob')['body']['user']['id']
        self.wid = self.alice.workspace()['body']['workspace']['id']
        self.other = self.bob.workspace(name='Bob workspace', key='request_example_bob01')['body']['workspace']['id']
        with self.app.store.connect() as db:
            audit.ensure_schema(db)

    def add(self, workspace_id=None, actor_id=None, action='auth.login', outcome='success', now=100,
            target_type=None, target_id=None, request_id=None, metadata=None):
        workspace_id = self.wid if workspace_id is None else workspace_id
        actor_id = self.alice_id if actor_id is None else actor_id
        with self.app.store.connect() as db:
            return audit.record(
                db, workspace_id, actor_id, action, outcome, now,
                target_type=target_type, target_id=target_id,
                request_id=request_id, metadata=metadata,
            )

    def events(self, workspace_id=None, **kwargs):
        workspace_id = self.wid if workspace_id is None else workspace_id
        with self.app.store.connect() as db:
            return audit.list_events(db, workspace_id, **kwargs)

    def test_schema_is_idempotent(self):
        with self.app.store.connect() as db:
            audit.ensure_schema(db)
            audit.ensure_schema(db)
            columns = [row['name'] for row in db.execute('PRAGMA table_info(audit_events)')]
            indexes = {row['name'] for row in db.execute(
                "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='audit_events'")}
        self.assertEqual(columns, [
            'seq', 'workspace_id', 'actor_id', 'action', 'target_type', 'target_id',
            'outcome', 'request_id', 'metadata', 'created',
        ])
        self.assertTrue({
            'audit_event_workspace_created',
            'audit_event_actor_created',
            'audit_event_action_created',
        } <= indexes)

    def test_record_and_list_are_newest_first(self):
        first = self.add(action='auth.login', now=100, target_type='user', target_id='alice')
        second = self.add(action='admin.member.add', now=200, metadata={'role': 'admin'})
        third = self.add(action='runtime.key.revoke', now=300, request_id='req-3')
        listed = self.events()
        self.assertEqual([event['seq'] for event in listed], [third['seq'], second['seq'], first['seq']])
        self.assertEqual([event['created'] for event in listed], [300, 200, 100])
        self.assertEqual(listed[0]['request_id'], 'req-3')
        self.assertEqual(listed[1]['metadata'], {'role': 'admin'})
        self.assertEqual(listed[2]['target_type'], 'user')
        self.assertEqual(listed[2]['target_id'], 'alice')
        self.assertEqual(first['outcome'], 'success')
        with self.app.store.connect() as db:
            self.assertEqual(audit.get_event(db, self.wid, second['seq']), second)

    def test_action_actor_and_since_filters(self):
        login_old = self.add(action='auth.login', actor_id=self.alice_id, now=100)
        admin = self.add(action='admin.member.add', actor_id=self.alice_id, now=200)
        login_new = self.add(action='auth.login', actor_id=self.bob_id, now=300)
        self.assertEqual(
            [event['seq'] for event in self.events(action='auth.login')],
            [login_new['seq'], login_old['seq']],
        )
        self.assertEqual([event['seq'] for event in self.events(actor_id=self.bob_id)], [login_new['seq']])
        self.assertEqual(
            [event['seq'] for event in self.events(since=200)],
            [login_new['seq'], admin['seq']],
        )

    def test_cursor_paging(self):
        events = [self.add(action='orchestration.task.run', now=100 + index) for index in range(5)]
        first = self.events(limit=2)
        second = self.events(limit=2, cursor=first[-1]['seq'])
        third = self.events(limit=2, cursor=str(second[-1]['seq']))
        self.assertEqual([event['seq'] for event in first], [events[4]['seq'], events[3]['seq']])
        self.assertEqual([event['seq'] for event in second], [events[2]['seq'], events[1]['seq']])
        self.assertEqual([event['seq'] for event in third], [events[0]['seq']])
        combined = [event['seq'] for event in first + second + third]
        self.assertEqual(len(combined), len(set(combined)))
        self.assertEqual(combined, [event['seq'] for event in reversed(events)])

    def test_workspace_isolation_and_missing_get(self):
        mine = self.add(action='skill.secret.put', now=100)
        theirs = self.add(workspace_id=self.other, actor_id=self.bob_id,
                          action='skill.secret.put', now=200)
        self.assertEqual([event['seq'] for event in self.events()], [mine['seq']])
        self.assertEqual([event['seq'] for event in self.events(workspace_id=self.other)], [theirs['seq']])
        with self.app.store.connect() as db:
            self.assertIsNone(audit.get_event(db, self.wid, theirs['seq']))
            self.assertIsNone(audit.get_event(db, self.wid, 999999))
            self.assertEqual(audit.get_event(db, self.other, theirs['seq']), theirs)

    def test_nested_sensitive_metadata_is_redacted(self):
        event = self.add(action='connector.link', metadata={
            'password': 'top-secret-password',
            'ApiToken': 'top-secret-token',
            'nested': {'clientSecret': 'top-secret-client', 'keep': 'visible'},
            'items': [
                {'authorization': 'Bearer top-secret-auth'},
                {'cookie': 'sid=top-secret-cookie'},
                {'note': 'visible-note'},
            ],
            'tokens': ['top-secret-list'],
            'session_id': 'top-secret-session',
            'csrf': 'top-secret-csrf',
            'passwd': 'top-secret-passwd',
            'api_key': 'top-secret-key',
            'note': 'safe',
        })
        metadata = event['metadata']
        self.assertEqual(metadata['password'], '[REDACTED]')
        self.assertEqual(metadata['ApiToken'], '[REDACTED]')
        self.assertEqual(metadata['nested']['clientSecret'], '[REDACTED]')
        self.assertEqual(metadata['nested']['keep'], 'visible')
        self.assertEqual(metadata['items'][0]['authorization'], '[REDACTED]')
        self.assertEqual(metadata['items'][1]['cookie'], '[REDACTED]')
        self.assertEqual(metadata['items'][2]['note'], 'visible-note')
        self.assertEqual(metadata['tokens'], '[REDACTED]')
        self.assertEqual(metadata['session_id'], '[REDACTED]')
        self.assertEqual(metadata['csrf'], '[REDACTED]')
        self.assertEqual(metadata['passwd'], '[REDACTED]')
        self.assertEqual(metadata['api_key'], '[REDACTED]')
        self.assertEqual(metadata['note'], 'safe')
        with self.app.store.connect() as db:
            raw = db.execute('SELECT metadata FROM audit_events WHERE seq=?', (event['seq'],)).fetchone()[0]
        self.assertNotIn('top-secret', raw)

    def test_oversize_metadata_is_rejected(self):
        with self.app.store.connect() as db:
            with self.assertRaises(ValueError):
                audit.record(
                    db, self.wid, self.alice_id, 'auth.login', 'success', 100,
                    metadata={'blob': 'x' * (audit.MAX_METADATA_BYTES + 1)},
                )
        self.assertEqual(self.events(), [])

    def test_invalid_outcome_and_fields_are_rejected(self):
        with self.app.store.connect() as db:
            with self.assertRaises(ValueError):
                audit.record(db, self.wid, self.alice_id, 'auth.login', 'ok', 100)
            with self.assertRaises(ValueError):
                audit.record(db, self.wid, self.alice_id, 'Auth Login', 'success', 100)
            with self.assertRaises(ValueError):
                audit.record(db, self.wid, self.alice_id, 'auth.login', 'success', 100,
                             target_type='User Type')
            with self.assertRaises(ValueError):
                audit.record(db, '', self.alice_id, 'auth.login', 'success', 100)
        self.assertEqual(self.events(), [])

    def test_purge_before_respects_workspace_and_global(self):
        self.add(now=100, action='auth.login')
        self.add(now=200, action='auth.login')
        self.add(now=300, action='auth.login')
        self.add(workspace_id=self.other, actor_id=self.bob_id, now=100, action='admin.member.add')
        self.add(workspace_id=self.other, actor_id=self.bob_id, now=200, action='admin.member.add')
        with self.app.store.connect() as db:
            self.assertEqual(audit.purge_before(db, 200, workspace_id=self.wid), 1)
        self.assertEqual([event['created'] for event in self.events()], [300, 200])
        self.assertEqual([event['created'] for event in self.events(workspace_id=self.other)], [200, 100])
        with self.app.store.connect() as db:
            self.assertEqual(audit.purge_before(db, 200), 1)
        self.assertEqual([event['created'] for event in self.events(workspace_id=self.other)], [200])
        with self.app.store.connect() as db:
            self.assertEqual(audit.purge_before(db, 1000), 3)
        self.assertEqual(self.events(), [])
        self.assertEqual(self.events(workspace_id=self.other), [])

    def test_stats(self):
        self.add(action='auth.login', outcome='success', now=100)
        self.add(action='auth.login', outcome='denied', now=200)
        self.add(action='admin.member.add', outcome='success', now=300)
        self.add(action='runtime.key.revoke', outcome='error', now=400)
        with self.app.store.connect() as db:
            stats = audit.stats(db, self.wid)
            recent = audit.stats(db, self.wid, since=300)
        self.assertEqual(stats['workspace_id'], self.wid)
        self.assertEqual(stats['total'], 4)
        self.assertEqual(stats['by_outcome'], {'success': 2, 'denied': 1, 'error': 1})
        self.assertEqual(stats['by_action'], {
            'auth.login': 2, 'admin.member.add': 1, 'runtime.key.revoke': 1,
        })
        self.assertEqual(recent['total'], 2)
        self.assertEqual(recent['by_outcome'], {'success': 1, 'error': 1})


if __name__ == '__main__':
    unittest.main()
