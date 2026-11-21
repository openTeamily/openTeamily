"""Per-user digest preferences, due selection, assembly and run receipts.

In-process WSGI + temporary SQLite only. This module never sends a digest.
"""
from datetime import datetime, timezone
from pathlib import Path
import tempfile
import unittest

from openteamily import digest
from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


def at(year, month, day, hour=0, minute=0):
    return int(datetime(year, month, day, hour, minute, tzinfo=timezone.utc).timestamp())


def weekly_key(year, month, day):
    moment = datetime(year, month, day, tzinfo=timezone.utc)
    iso = moment.isocalendar()
    return f'{iso.year:04d}-W{iso.week:02d}'


class DigestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name).resolve() / 'state'
        self.now = at(2026, 11, 20, 8)
        self.app = App(Store(self.path), Config(ORIGIN, allow_registration=True),
                       clock=lambda: self.now)
        self.alice = Client(self.app)
        self.alice.register('alice')
        self.bob = Client(self.app, peer='127.0.0.2')
        self.bob.register('bob')
        self.wid = self.alice.workspace()['body']['workspace']['id']
        self.other_wid = self.alice.workspace(
            name='Other', key='request_example_0002')['body']['workspace']['id']
        with self.app.store.connect() as db:
            digest.ensure_schema(db)
            self.alice_id = db.execute(
                'SELECT id FROM users WHERE username=?', ('alice',)).fetchone()[0]
            self.bob_id = db.execute(
                'SELECT id FROM users WHERE username=?', ('bob',)).fetchone()[0]

    def test_schema_is_idempotent(self):
        with self.app.store.connect() as db:
            digest.ensure_schema(db)
            digest.ensure_schema(db)
            tables = {row[0] for row in db.execute(
                "SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertIn('digest_prefs', tables)
            self.assertIn('digest_runs', tables)
            pref_columns = [row[1] for row in db.execute('PRAGMA table_info(digest_prefs)')]
            self.assertEqual(pref_columns, [
                'workspace_id', 'user_id', 'enabled', 'cadence', 'hour_utc',
                'channel', 'updated',
            ])
            run_columns = [row[1] for row in db.execute('PRAGMA table_info(digest_runs)')]
            self.assertEqual(run_columns, [
                'id', 'workspace_id', 'user_id', 'period_key', 'item_count',
                'body', 'created',
            ])
            db.execute(
                'INSERT OR IGNORE INTO digest_prefs VALUES(?,?,?,?,?,?,?)',
                (self.wid, self.alice_id, 1, 'daily', 9, 'digest', self.now))
            db.execute(
                'INSERT OR IGNORE INTO digest_prefs VALUES(?,?,?,?,?,?,?)',
                (self.wid, self.alice_id, 1, 'daily', 9, 'digest', self.now))
            self.assertEqual(db.execute(
                'SELECT COUNT(*) FROM digest_prefs').fetchone()[0], 1)

    def test_set_and_get_pref(self):
        with self.app.store.connect() as db:
            saved = digest.set_pref(
                db, self.wid, self.alice_id, 'daily', 9, now=self.now)
            self.assertEqual(saved['cadence'], 'daily')
            self.assertEqual(saved['hour_utc'], 9)
            self.assertEqual(saved['channel'], 'digest')
            self.assertTrue(saved['enabled'])
            self.assertEqual(saved['updated'], self.now)
            self.assertEqual(digest.get_pref(db, self.wid, self.alice_id), saved)
            updated = digest.set_pref(
                db, self.wid, self.alice_id, 'weekly', 18,
                channel='email', enabled=False, now=self.now + 5)
            self.assertEqual(updated['cadence'], 'weekly')
            self.assertEqual(updated['hour_utc'], 18)
            self.assertEqual(updated['channel'], 'email')
            self.assertFalse(updated['enabled'])
            self.assertEqual(digest.get_pref(db, self.wid, self.alice_id), updated)
            self.assertIsNone(digest.get_pref(db, self.other_wid, self.alice_id))

    def test_invalid_cadence_hour_channel_and_enabled_are_rejected(self):
        with self.app.store.connect() as db:
            for cadence in ('hourly', 'monthly', '', 'DAILY'):
                with self.assertRaises(ValueError):
                    digest.set_pref(db, self.wid, self.alice_id, cadence, 9, now=self.now)
            for hour in (-1, 24, 9.0, '9', True):
                with self.assertRaises(ValueError):
                    digest.set_pref(db, self.wid, self.alice_id, 'daily', hour, now=self.now)
            with self.assertRaises(ValueError):
                digest.set_pref(db, self.wid, self.alice_id, 'daily', 9,
                                channel='', now=self.now)
            with self.assertRaises(ValueError):
                digest.set_pref(db, self.wid, self.alice_id, 'daily', 9,
                                channel='x' * (digest.MAX_CHANNEL + 1), now=self.now)
            with self.assertRaises(ValueError):
                digest.set_pref(db, self.wid, self.alice_id, 'daily', 9,
                                enabled='yes', now=self.now)
            self.assertIsNone(digest.get_pref(db, self.wid, self.alice_id))

    def test_due_only_at_or_after_hour_and_once_per_period(self):
        with self.app.store.connect() as db:
            digest.set_pref(db, self.wid, self.alice_id, 'daily', 9, now=self.now)
            self.assertEqual(digest.due(db, at(2026, 11, 20, 8, 59)), [])
            due = digest.due(db, at(2026, 11, 20, 9, 0))
            self.assertEqual(len(due), 1)
            self.assertEqual(due[0]['workspace_id'], self.wid)
            self.assertEqual(due[0]['period_key'], '2026-11-20')
            digest.record_run(db, self.wid, self.alice_id, due[0]['period_key'],
                              'body', 1, at(2026, 11, 20, 9, 1))
            self.assertEqual(digest.due(db, at(2026, 11, 20, 23, 59)), [])
            self.assertEqual(digest.due(db, at(2026, 11, 21, 8, 59)), [])
            next_day = digest.due(db, at(2026, 11, 21, 9, 0))
            self.assertEqual([item['period_key'] for item in next_day], ['2026-11-21'])
            digest.set_pref(db, self.wid, self.bob_id, 'daily', 0,
                            enabled=False, now=self.now)
            self.assertFalse(any(item['user_id'] == self.bob_id
                                 for item in digest.due(db, at(2026, 11, 22, 12))))
            digest.set_pref(db, self.wid, self.bob_id, 'off', 0, now=self.now)
            self.assertFalse(any(item['user_id'] == self.bob_id
                                 for item in digest.due(db, at(2026, 11, 22, 12))))

    def test_weekly_period_key_uses_utc_iso_week(self):
        self.assertEqual(weekly_key(2026, 11, 19), '2026-W47')
        with self.app.store.connect() as db:
            digest.set_pref(db, self.wid, self.alice_id, 'weekly', 12, now=self.now)
            self.assertEqual(digest.due(db, at(2026, 11, 19, 11, 59)), [])
            due = digest.due(db, at(2026, 11, 19, 12, 0))
            self.assertEqual([item['period_key'] for item in due], ['2026-W47'])
            digest.record_run(db, self.wid, self.alice_id, due[0]['period_key'],
                              'weekly body', 2, at(2026, 11, 19, 12, 1))
            self.assertEqual(digest.due(db, at(2026, 11, 20, 13, 0)), [])
            following = digest.due(db, at(2026, 11, 23, 12, 0))
            self.assertEqual([item['period_key'] for item in following], ['2026-W48'])

    def test_build_groups_sorts_caps_and_skips_empty(self):
        items = [
            {'kind': 'notification', 'title': 'Read notice', 'created': 30, 'read': True},
            {'kind': 'notification', 'title': 'Unread old', 'created': 10},
            {'kind': 'notification', 'title': 'Unread new', 'created': 20},
            {'kind': 'work', 'title': 'Work item', 'created': 5,
             'body': 'A short body.', 'href': '/w/one'},
            {'kind': 'automation', 'title': '   ', 'created': 1},
            {'kind': '', 'title': 'No kind', 'created': 1},
            {'kind': 'empty', 'title': '', 'created': 1},
        ]
        with self.app.store.connect() as db:
            digest.set_pref(db, self.wid, self.alice_id, 'daily', 9, now=self.now)
            built = digest.build(db, self.wid, self.alice_id, items, at(2026, 11, 20, 10))
        self.assertEqual(built['period_key'], '2026-11-20')
        self.assertEqual([section['kind'] for section in built['sections']],
                         ['notification', 'work'])
        self.assertEqual(
            [item['title'] for item in built['sections'][0]['items']],
            ['Unread new', 'Unread old', 'Read notice'])
        self.assertEqual([item['title'] for item in built['sections'][1]['items']],
                         ['Work item'])
        self.assertEqual(built['item_count'], 4)
        self.assertIn('Digest 2026-11-20', built['body'])
        self.assertIn('[notification]', built['body'])
        self.assertIn('/w/one', built['body'])
        self.assertLessEqual(len(built['body']), digest.MAX_BODY)

        many = [{'kind': f'k{kind}', 'title': f'{kind}-{index:02d}', 'created': index}
                for kind in range(3) for index in range(30)]
        with self.app.store.connect() as db:
            capped = digest.build(db, self.wid, self.alice_id, many, self.now)
        self.assertEqual(capped['item_count'], digest.MAX_ITEMS)
        self.assertEqual(sum(len(section['items']) for section in capped['sections']),
                         capped['item_count'])
        self.assertLessEqual(len(capped['body']), digest.MAX_BODY)

    def test_build_renders_plain_text_without_html(self):
        items = [{'kind': 'work', 'title': '<b>Alert</b>', 'created': 1,
                  'body': '<script>bad()</script>', 'href': '/w/<tag>'}]
        with self.app.store.connect() as db:
            built = digest.build(db, self.wid, self.alice_id, items, self.now)
        self.assertNotIn('<', built['body'])
        self.assertNotIn('>', built['body'])
        self.assertIn('Alert', built['body'])
        self.assertIn('bad()', built['body'])

    def test_record_run_is_idempotent(self):
        with self.app.store.connect() as db:
            first = digest.record_run(db, self.wid, self.alice_id, '2026-11-20',
                                      'first body', 3, self.now)
            second = digest.record_run(db, self.wid, self.alice_id, '2026-11-20',
                                       'second body', 9, self.now + 10)
            self.assertEqual(second['id'], first['id'])
            self.assertEqual(second['body'], 'first body')
            self.assertEqual(second['item_count'], 3)
            self.assertTrue(digest.already_recorded(
                db, self.wid, self.alice_id, '2026-11-20'))
            self.assertFalse(digest.already_recorded(
                db, self.other_wid, self.alice_id, '2026-11-20'))
            self.assertEqual(db.execute(
                'SELECT COUNT(*) FROM digest_runs').fetchone()[0], 1)

    def test_run_due_calls_collector_once_per_due_pref_and_skips_empty(self):
        with self.app.store.connect() as db:
            digest.set_pref(db, self.wid, self.alice_id, 'daily', 9, now=self.now)
            digest.set_pref(db, self.wid, self.bob_id, 'daily', 9, now=self.now)
        calls = []

        def collect(workspace_id, user_id, period_key):
            calls.append((workspace_id, user_id, period_key))
            if user_id == self.alice_id:
                return [{'kind': 'notification', 'title': 'Unread', 'created': 1}]
            return []

        with self.app.store.connect() as db:
            runs = digest.run_due(db, at(2026, 11, 20, 9, 0), collect)
        self.assertEqual(len(runs), 1)
        self.assertEqual(runs[0]['user_id'], self.alice_id)
        self.assertEqual(runs[0]['period_key'], '2026-11-20')
        self.assertEqual(len(calls), 2)
        self.assertEqual({call[1] for call in calls}, {self.alice_id, self.bob_id})
        self.assertTrue(all(call[0] == self.wid for call in calls))
        self.assertTrue(all(call[2] == '2026-11-20' for call in calls))
        with self.app.store.connect() as db:
            self.assertEqual(db.execute(
                'SELECT COUNT(*) FROM digest_runs').fetchone()[0], 1)

    def test_workspace_and_user_isolation(self):
        with self.app.store.connect() as db:
            digest.set_pref(db, self.wid, self.alice_id, 'daily', 9, now=self.now)
            digest.set_pref(db, self.other_wid, self.alice_id, 'daily', 9, now=self.now)
            due = digest.due(db, at(2026, 11, 20, 9, 0))
            self.assertEqual(len(due), 2)
            self.assertEqual({item['workspace_id'] for item in due},
                             {self.wid, self.other_wid})
            digest.record_run(db, self.wid, self.alice_id, '2026-11-20',
                              'only this workspace', 1, self.now)
            remaining = digest.due(db, at(2026, 11, 20, 9, 0))
            self.assertEqual([item['workspace_id'] for item in remaining],
                             [self.other_wid])
            self.assertTrue(digest.already_recorded(
                db, self.wid, self.alice_id, '2026-11-20'))
            self.assertFalse(digest.already_recorded(
                db, self.other_wid, self.alice_id, '2026-11-20'))
            digest.record_run(db, self.wid, self.bob_id, '2026-11-20',
                              'bob body', 2, self.now)
            self.assertFalse(digest.already_recorded(
                db, self.wid, self.alice_id, '2026-11-21'))
            self.assertEqual(digest.get_pref(db, self.wid, self.bob_id), None)

    def test_oversize_inputs_are_rejected(self):
        with self.app.store.connect() as db:
            digest.set_pref(db, self.wid, self.alice_id, 'daily', 9, now=self.now)
            with self.assertRaises(ValueError):
                digest.build(db, self.wid, self.alice_id,
                             [{'kind': 'work', 'title': 't' * (digest.MAX_TITLE_INPUT + 1)}],
                             self.now)
            with self.assertRaises(ValueError):
                digest.build(db, self.wid, self.alice_id,
                             [{'kind': 'work', 'title': 'ok',
                               'body': 'b' * (digest.MAX_ITEM_BODY_INPUT + 1)}],
                             self.now)
            with self.assertRaises(ValueError):
                digest.build(db, self.wid, self.alice_id,
                             [{'kind': 'work', 'title': 'ok'}] * (digest.MAX_INPUT_ITEMS + 1),
                             self.now)
            with self.assertRaises(ValueError):
                digest.record_run(db, self.wid, self.alice_id, '2026-11-20',
                                  'x' * (digest.MAX_BODY + 1), 1, self.now)
            self.assertEqual(db.execute(
                'SELECT COUNT(*) FROM digest_runs').fetchone()[0], 0)


if __name__ == '__main__':
    unittest.main()
