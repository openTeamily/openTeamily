"""Workspace retention policy, planning and callback execution tests.

In-process App/Store + temporary SQLite only. The module under test never
deletes stored workspace data itself; these tests use a synthetic callback.
"""
import json
from pathlib import Path
import tempfile
import unittest

from openteamily import retention
from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class RetentionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name).resolve() / 'state'
        self.now = 2_000_000_000
        self.app = App(Store(self.path), Config(ORIGIN, allow_registration=True),
                       clock=lambda: self.now)
        self.alice = Client(self.app)
        self.alice.register('alice')
        self.bob = Client(self.app, peer='127.0.0.2')
        self.bob.register('bob')
        self.wid = self.alice.workspace()['body']['workspace']['id']
        self.other = self.alice.workspace(
            name='Other', key='request_example_0002')['body']['workspace']['id']
        with self.app.store.connect() as db:
            retention.ensure_schema(db)

    def test_schema_is_idempotent_and_has_required_columns(self):
        with self.app.store.connect() as db:
            retention.ensure_schema(db)
            retention.ensure_schema(db)
            policy_columns = {
                row['name'] for row in db.execute('PRAGMA table_info(retention_policies)')
            }
            self.assertTrue({
                'workspace_id', 'data_class', 'ttl_seconds', 'enabled',
                'legal_hold', 'created', 'updated',
            } <= policy_columns)
            run_columns = {
                row['name'] for row in db.execute('PRAGMA table_info(retention_runs)')
            }
            self.assertTrue({
                'id', 'workspace_id', 'counts', 'deleted', 'failed', 'created',
            } <= run_columns)
            indexes = {
                row['name'] for row in db.execute(
                    "SELECT name FROM sqlite_master WHERE type='index' "
                    "AND tbl_name='retention_policies'")
            }
            self.assertTrue(indexes)

    def test_set_get_list_update_and_delete_policy(self):
        with self.app.store.connect() as db:
            created = retention.set_policy(db, self.wid, 'messages', 100, self.now)
            self.assertEqual(created['workspace_id'], self.wid)
            self.assertEqual(created['data_class'], 'messages')
            self.assertEqual(created['ttl_seconds'], 100)
            self.assertTrue(created['enabled'])
            self.assertFalse(created['legal_hold'])
            self.assertEqual(created['created'], self.now)
            self.assertEqual(created['updated'], self.now)
            self.assertEqual(
                retention.get_policy(db, self.wid, 'messages'), created)

            updated = retention.set_policy(
                db, self.wid, 'messages', 200, self.now + 5,
                enabled=False, legal_hold=True)
            self.assertEqual(updated['ttl_seconds'], 200)
            self.assertFalse(updated['enabled'])
            self.assertTrue(updated['legal_hold'])
            self.assertEqual(updated['created'], self.now)
            self.assertEqual(updated['updated'], self.now + 5)

            retention.set_policy(db, self.wid, 'artifacts', 50, self.now)
            listed = retention.list_policies(db, self.wid)
            self.assertEqual(
                [item['data_class'] for item in listed], ['artifacts', 'messages'])

            self.assertTrue(retention.delete_policy(db, self.wid, 'messages'))
            self.assertIsNone(retention.get_policy(db, self.wid, 'messages'))
            self.assertEqual(
                [item['data_class'] for item in retention.list_policies(db, self.wid)],
                ['artifacts'])
            self.assertFalse(retention.delete_policy(db, self.wid, 'messages'))

    def test_ttl_boundary_is_inclusive_at_exact_cutoff(self):
        with self.app.store.connect() as db:
            retention.set_policy(db, self.wid, 'messages', 100, self.now)
            rows = [
                {'id': 'c', 'data_class': 'messages', 'created': self.now - 101},
                {'id': 'b', 'data_class': 'messages', 'created': self.now - 99},
                {'id': 'a', 'data_class': 'messages', 'created': self.now - 100},
            ]
            planned = retention.plan(db, self.wid, rows, self.now)
            self.assertEqual(planned['delete'], ['a', 'c'])
            self.assertEqual([item['id'] for item in planned['keep']], ['b'])
            self.assertEqual(planned['keep'][0]['reason'], 'not_due')
            self.assertEqual(planned['unknown_policy'], [])
            self.assertEqual(planned['legal_hold'], [])

    def test_disabled_policy_keeps_expired_rows(self):
        with self.app.store.connect() as db:
            retention.set_policy(
                db, self.wid, 'messages', 1, self.now, enabled=False)
            rows = [{'id': 'old', 'data_class': 'messages', 'created': self.now - 50}]
            planned = retention.plan(db, self.wid, rows, self.now)
            self.assertEqual(planned['delete'], [])
            self.assertEqual(
                planned['keep'], [{'id': 'old', 'reason': 'disabled'}])
            self.assertEqual(planned['unknown_policy'], [])
            self.assertEqual(planned['legal_hold'], [])

    def test_policy_legal_hold_keeps_all_rows(self):
        with self.app.store.connect() as db:
            retention.set_policy(
                db, self.wid, 'messages', 1, self.now, legal_hold=True)
            rows = [
                {'id': 'b', 'data_class': 'messages', 'created': self.now - 90},
                {'id': 'a', 'data_class': 'messages', 'created': self.now - 50},
            ]
            planned = retention.plan(db, self.wid, rows, self.now)
            self.assertEqual(planned['delete'], [])
            self.assertEqual(planned['keep'], [])
            self.assertEqual(planned['unknown_policy'], [])
            self.assertEqual(planned['legal_hold'], ['a', 'b'])

    def test_row_legal_hold_wins_over_policy_and_unknown_class(self):
        with self.app.store.connect() as db:
            retention.set_policy(db, self.wid, 'messages', 1, self.now)
            rows = [
                {'id': 'held', 'data_class': 'messages',
                 'created': self.now - 50, 'legal_hold': True},
                {'id': 'free', 'data_class': 'messages', 'created': self.now - 50},
                {'id': 'held-unknown', 'data_class': 'archives',
                 'created': self.now - 50, 'legal_hold': True},
            ]
            planned = retention.plan(db, self.wid, rows, self.now)
            self.assertEqual(planned['delete'], ['free'])
            self.assertEqual(planned['legal_hold'], ['held', 'held-unknown'])
            self.assertEqual(planned['unknown_policy'], [])

    def test_unknown_class_is_reported_not_deleted(self):
        with self.app.store.connect() as db:
            retention.set_policy(db, self.wid, 'messages', 1, self.now)
            rows = [
                {'id': 'z', 'data_class': 'archives', 'created': self.now - 50},
                {'id': 'a', 'data_class': 'logs', 'created': self.now - 50},
                {'id': 'live', 'data_class': 'messages', 'created': self.now - 50},
            ]
            planned = retention.plan(db, self.wid, rows, self.now)
            self.assertEqual(planned['delete'], ['live'])
            self.assertEqual(planned['unknown_policy'], ['a', 'z'])
            self.assertEqual(planned['keep'], [])
            self.assertEqual(planned['legal_hold'], [])

    def test_plan_ordering_is_deterministic_across_buckets(self):
        with self.app.store.connect() as db:
            retention.set_policy(db, self.wid, 'messages', 10, self.now)
            retention.set_policy(
                db, self.wid, 'logs', 10, self.now, enabled=False)
            retention.set_policy(
                db, self.wid, 'media', 10, self.now, legal_hold=True)
            rows = [
                {'id': 'z', 'data_class': 'messages', 'created': self.now - 20},
                {'id': 'm', 'data_class': 'logs', 'created': self.now - 20},
                {'id': 'y', 'data_class': 'other', 'created': self.now - 20},
                {'id': 'x', 'data_class': 'media', 'created': self.now - 20},
                {'id': 'a', 'data_class': 'messages', 'created': self.now - 20},
                {'id': 'b', 'data_class': 'logs', 'created': self.now - 20},
                {'id': 'c', 'data_class': 'other', 'created': self.now - 20},
                {'id': 'd', 'data_class': 'media', 'created': self.now - 20},
                {'id': 'w', 'data_class': 'messages', 'created': self.now - 20,
                 'legal_hold': True},
            ]
            planned = retention.plan(db, self.wid, rows, self.now)
            self.assertEqual(planned['delete'], ['a', 'z'])
            self.assertEqual(
                [item['id'] for item in planned['keep']], ['b', 'm'])
            self.assertEqual(planned['unknown_policy'], ['c', 'y'])
            self.assertEqual(planned['legal_hold'], ['d', 'w', 'x'])

    def test_execute_calls_callback_only_for_delete_and_counts_failures(self):
        with self.app.store.connect() as db:
            retention.set_policy(db, self.wid, 'messages', 10, self.now)
            rows = [
                {'id': 'keep', 'data_class': 'messages', 'created': self.now - 5},
                {'id': 'ok1', 'data_class': 'messages', 'created': self.now - 20},
                {'id': 'bad', 'data_class': 'messages', 'created': self.now - 30},
                {'id': 'ok2', 'data_class': 'messages', 'created': self.now - 40},
                {'id': 'held', 'data_class': 'messages',
                 'created': self.now - 50, 'legal_hold': True},
                {'id': 'unknown', 'data_class': 'archives',
                 'created': self.now - 60},
            ]
            planned = retention.plan(db, self.wid, rows, self.now)
            self.assertEqual(planned['delete'], ['bad', 'ok1', 'ok2'])
            calls = []

            def delete_fn(item_id):
                calls.append(item_id)
                if item_id == 'bad':
                    raise RuntimeError('synthetic delete failure')

            result = retention.execute(
                db, self.wid, planned, delete_fn, self.now + 1)
            self.assertEqual(
                result, {'attempted': 3, 'deleted': 2, 'failed': 1})
            self.assertEqual(calls, ['bad', 'ok1', 'ok2'])
            self.assertEqual(rows[0], {
                'id': 'keep', 'data_class': 'messages', 'created': self.now - 5})

            stats = retention.stats(db, self.wid)
            self.assertEqual(len(stats['policies']), 1)
            last = stats['last_run']
            self.assertEqual(last['workspace_id'], self.wid)
            self.assertEqual(last['counts'], {'messages': 3})
            self.assertEqual(last['deleted'], 2)
            self.assertEqual(last['failed'], 1)
            self.assertEqual(last['created'], self.now + 1)
            raw = db.execute(
                'SELECT id, workspace_id, counts, deleted, failed, created '
                'FROM retention_runs WHERE workspace_id=?', (self.wid,)).fetchone()
            self.assertEqual(raw['id'], last['id'])
            self.assertEqual(json.loads(raw['counts']), {'messages': 3})
            self.assertEqual((raw['deleted'], raw['failed']), (2, 1))

    def test_workspace_isolation_for_policies_plans_runs_and_stats(self):
        rows = [{'id': 'old', 'data_class': 'messages', 'created': self.now - 50}]
        with self.app.store.connect() as db:
            retention.set_policy(db, self.wid, 'messages', 10, self.now)
            retention.set_policy(db, self.other, 'messages', 1000, self.now)
            self.assertEqual(
                retention.get_policy(db, self.wid, 'messages')['ttl_seconds'], 10)
            self.assertEqual(
                retention.get_policy(db, self.other, 'messages')['ttl_seconds'],
                1000)
            self.assertEqual(
                [item['workspace_id'] for item in retention.list_policies(db, self.wid)],
                [self.wid])
            self.assertEqual(
                retention.plan(db, self.wid, rows, self.now)['delete'], ['old'])
            self.assertEqual(
                retention.plan(db, self.other, rows, self.now)['delete'], [])

            planned = retention.plan(db, self.wid, rows, self.now)
            retention.execute(db, self.wid, planned, lambda item: None, self.now)
            self.assertIsNotNone(retention.stats(db, self.wid)['last_run'])
            self.assertIsNone(retention.stats(db, self.other)['last_run'])

            self.assertTrue(retention.delete_policy(db, self.wid, 'messages'))
            self.assertIsNone(retention.get_policy(db, self.wid, 'messages'))
            self.assertIsNotNone(
                retention.get_policy(db, self.other, 'messages'))

    def test_invalid_data_class_and_ttl_are_rejected(self):
        with self.app.store.connect() as db:
            for data_class in ('', 'Messages', 'two words', 'a.b', 'a' * 65,
                               None, 123):
                with self.assertRaises(ValueError):
                    retention.set_policy(
                        db, self.wid, data_class, 100, self.now)
            for ttl_seconds in (0, -1, True, 1.5, '60', None,
                                retention.MAX_TTL_SECONDS + 1):
                with self.assertRaises(ValueError):
                    retention.set_policy(
                        db, self.wid, 'messages', ttl_seconds, self.now)
            with self.assertRaises(ValueError):
                retention.get_policy(db, self.wid, 'Bad')
            with self.assertRaises(ValueError):
                retention.delete_policy(db, self.wid, '')
            with self.assertRaises(ValueError):
                retention.plan(db, self.wid, [
                    {'id': 'a', 'data_class': 'Bad', 'created': self.now},
                ], self.now)
            self.assertEqual(retention.list_policies(db, self.wid), [])

    def test_oversize_ids_and_row_lists_are_rejected_before_callbacks(self):
        with self.app.store.connect() as db:
            retention.set_policy(db, self.wid, 'messages', 1, self.now)
            too_long = 'x' * (retention.MAX_ID_LENGTH + 1)
            for bad_id in (too_long, '', None, 5, 'a\x00b', 'a\nb', ' padded '):
                with self.assertRaises(ValueError):
                    retention.plan(db, self.wid, [
                        {'id': bad_id, 'data_class': 'messages',
                         'created': self.now - 10},
                    ], self.now)

            calls = []
            with self.assertRaises(ValueError):
                retention.execute(
                    db, self.wid, {'delete': [too_long]}, calls.append, self.now)
            self.assertEqual(calls, [])

            rows = [
                {'id': f'id-{index}', 'data_class': 'messages',
                 'created': self.now - 10}
                for index in range(retention.MAX_ROWS + 1)
            ]
            with self.assertRaises(ValueError):
                retention.plan(db, self.wid, rows, self.now)
            with self.assertRaises(ValueError):
                retention.execute(
                    db, self.wid, {'delete': [f'id-{index}' for index in range(
                        retention.MAX_ROWS + 1)]}, calls.append, self.now)
            self.assertEqual(calls, [])
            self.assertIsNone(retention.stats(db, self.wid)['last_run'])


if __name__ == '__main__':
    unittest.main()
