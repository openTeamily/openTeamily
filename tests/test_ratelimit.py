"""Persistent fixed-window rate limiter tests.

In-process temporary SQLite only. These tests exercise the standalone
``openteamily.ratelimit`` module; no HTTP route is wired here.
"""
from pathlib import Path
import tempfile
import unittest

from openteamily import ratelimit
from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class RateLimitTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name).resolve() / 'state'
        self.now = 1800000000
        self.app = App(Store(self.path), Config(ORIGIN, allow_registration=True), clock=lambda: self.now)
        self.alice = Client(self.app)
        self.assertEqual(self.alice.register('alice')['status'], 201)
        workspace = self.alice.workspace()
        self.assertEqual(workspace['status'], 201, workspace)
        self.wid = workspace['body']['workspace']['id']
        with self.app.store.connect() as db:
            ratelimit.ensure_schema(db)

    def key(self, name='api'):
        return f'workspace:{self.wid}:{name}'

    def test_schema_is_idempotent_and_leaves_legacy_table_alone(self):
        with self.app.store.connect() as db:
            legacy_before = db.execute('SELECT COUNT(*) FROM rate_limits').fetchone()[0]
            ratelimit.ensure_schema(db)
            ratelimit.ensure_schema(db)
            names = {row['name'] for row in db.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )}
            self.assertIn('rate_buckets', names)
            self.assertIn('rate_limits', names)
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 1)
            columns = [row['name'] for row in db.execute('PRAGMA table_info(rate_buckets)')]
            self.assertEqual(columns, ['key', 'window_start', 'used', 'updated'])
            self.assertEqual(db.execute('SELECT COUNT(*) FROM rate_limits').fetchone()[0], legacy_before)

    def test_allows_up_to_limit_then_denies_with_retry_after(self):
        key = self.key()
        with self.app.store.connect() as db:
            first = ratelimit.hit(db, key, 3, 60, self.now)
            second = ratelimit.hit(db, key, 3, 60, self.now)
            third = ratelimit.hit(db, key, 3, 60, self.now)
            denied = ratelimit.hit(db, key, 3, 60, self.now)
        self.assertEqual(first, {'allowed': True, 'remaining': 2, 'limit': 3,
                                 'reset_at': self.now + 60, 'retry_after': 0})
        self.assertEqual(second['remaining'], 1)
        self.assertEqual(third['remaining'], 0)
        self.assertEqual(denied, {'allowed': False, 'remaining': 0, 'limit': 3,
                                  'reset_at': self.now + 60, 'retry_after': 60})
        with self.app.store.connect() as db:
            still_denied = ratelimit.hit(db, key, 3, 60, self.now + 59)
            self.assertFalse(still_denied['allowed'])
            self.assertEqual(still_denied['retry_after'], 1)
            reset = ratelimit.hit(db, key, 3, 60, self.now + 60)
            self.assertTrue(reset['allowed'])
            self.assertEqual(reset['remaining'], 2)
            self.assertEqual(reset['reset_at'], self.now + 120)

    def test_cost_consumes_multiple_units(self):
        key = self.key()
        with self.app.store.connect() as db:
            first = ratelimit.hit(db, key, 5, 60, self.now, cost=2)
            second = ratelimit.hit(db, key, 5, 60, self.now, cost=3)
            denied = ratelimit.hit(db, key, 5, 60, self.now, cost=1)
        self.assertTrue(first['allowed'])
        self.assertEqual(first['remaining'], 3)
        self.assertTrue(second['allowed'])
        self.assertEqual(second['remaining'], 0)
        self.assertFalse(denied['allowed'])
        self.assertEqual(denied['retry_after'], 60)

    def test_peek_never_consumes(self):
        key = self.key()
        with self.app.store.connect() as db:
            empty = ratelimit.peek(db, key, 3, 60, self.now)
            self.assertEqual(empty, {'allowed': True, 'remaining': 3, 'limit': 3,
                                     'reset_at': self.now + 60, 'retry_after': 0})
            ratelimit.hit(db, key, 3, 60, self.now)
            after_one = ratelimit.peek(db, key, 3, 60, self.now)
            self.assertEqual(after_one['remaining'], 2)
            ratelimit.hit(db, key, 3, 60, self.now)
            full = ratelimit.peek(db, key, 3, 60, self.now)
            self.assertEqual(full['remaining'], 1)
            self.assertTrue(full['allowed'])
            third = ratelimit.hit(db, key, 3, 60, self.now)
            self.assertTrue(third['allowed'])
            denied = ratelimit.peek(db, key, 3, 60, self.now)
            self.assertFalse(denied['allowed'])
            self.assertEqual(denied['remaining'], 0)
            self.assertEqual(denied['retry_after'], 60)
            fresh = ratelimit.peek(db, key, 3, 60, self.now + 60)
            self.assertTrue(fresh['allowed'])
            self.assertEqual(fresh['remaining'], 3)

    def test_reset_clears_one_key_and_reports_whether_present(self):
        key, other = self.key('api'), self.key('webhook')
        with self.app.store.connect() as db:
            ratelimit.hit(db, key, 1, 60, self.now)
            ratelimit.hit(db, other, 1, 60, self.now)
            self.assertTrue(ratelimit.reset(db, key))
            self.assertFalse(ratelimit.reset(db, key))
            self.assertTrue(ratelimit.hit(db, key, 1, 60, self.now)['allowed'])
            self.assertFalse(ratelimit.hit(db, other, 1, 60, self.now)['allowed'])

    def test_cleanup_removes_only_rows_older_than_cutoff(self):
        with self.app.store.connect() as db:
            ratelimit.hit(db, self.key('old'), 5, 60, 1000)
            ratelimit.hit(db, self.key('new'), 5, 60, 2000)
            removed = ratelimit.cleanup(db, 1500, now=3000)
            self.assertEqual(removed, 1)
            remaining = {row['key'] for row in db.execute('SELECT key FROM rate_buckets')}
            self.assertEqual(remaining, {self.key('new')})
            self.assertEqual(ratelimit.cleanup(db, 1500), 0)
            self.assertEqual(ratelimit.cleanup(db, 2001), 1)

    def test_invalid_inputs_are_rejected(self):
        with self.app.store.connect() as db:
            for bad_key in ('', None, 1, 'x\x00y', 'k' * (ratelimit.MAX_KEY_LENGTH + 1)):
                with self.assertRaises(ValueError):
                    ratelimit.hit(db, bad_key, 1, 60, self.now)
            for bad_limit in (0, -1, True, 1.5, ratelimit.MAX_LIMIT + 1):
                with self.assertRaises(ValueError):
                    ratelimit.hit(db, self.key(), bad_limit, 60, self.now)
            for bad_window in (0, -1, True, 1.5, ratelimit.MAX_WINDOW_SECONDS + 1):
                with self.assertRaises(ValueError):
                    ratelimit.hit(db, self.key(), 2, bad_window, self.now)
            for bad_cost in (0, -1, True, 1.5, 3):
                with self.assertRaises(ValueError):
                    ratelimit.hit(db, self.key(), 2, 60, self.now, cost=bad_cost)
            for bad_now in (-1, 1.5, True, None):
                with self.assertRaises(ValueError):
                    ratelimit.hit(db, self.key(), 2, 60, bad_now)
            with self.assertRaises(ValueError):
                ratelimit.peek(db, '', 2, 60, self.now)
            with self.assertRaises(ValueError):
                ratelimit.reset(db, None)
            with self.assertRaises(ValueError):
                ratelimit.cleanup(db, 1.5)
            with self.assertRaises(ValueError):
                ratelimit.cleanup(db, 10, now=1.5)

    def test_independent_keys_are_isolated(self):
        first, second = self.key('first'), self.key('second')
        with self.app.store.connect() as db:
            self.assertTrue(ratelimit.hit(db, first, 1, 60, self.now)['allowed'])
            self.assertFalse(ratelimit.hit(db, first, 1, 60, self.now)['allowed'])
            self.assertTrue(ratelimit.hit(db, second, 1, 60, self.now)['allowed'])
            self.assertEqual(ratelimit.peek(db, second, 1, 60, self.now)['remaining'], 0)
            ratelimit.reset(db, second)
            self.assertTrue(ratelimit.hit(db, second, 1, 60, self.now)['allowed'])
            self.assertFalse(ratelimit.hit(db, first, 1, 60, self.now)['allowed'])

    def test_hit_many_is_all_or_nothing(self):
        a, b = self.key('a'), self.key('b')
        with self.app.store.connect() as db:
            first = ratelimit.hit_many(db, [(a, 2, 60, 1), (b, 2, 60, 1)], self.now)
            self.assertTrue(all(result['allowed'] for result in first))
            self.assertEqual([result['remaining'] for result in first], [1, 1])
            second = ratelimit.hit_many(db, [(a, 2, 60, 1), (b, 2, 60, 1)], self.now)
            self.assertTrue(all(result['allowed'] for result in second))
            self.assertEqual([result['remaining'] for result in second], [0, 0])
            rejected = ratelimit.hit_many(db, [(a, 2, 60, 1), (b, 2, 60, 1)], self.now)
            self.assertTrue(all(not result['allowed'] for result in rejected))
            self.assertEqual([result['remaining'] for result in rejected], [0, 0])
            self.assertEqual([result['retry_after'] for result in rejected], [60, 60])
            self.assertEqual([row['used'] for row in db.execute(
                'SELECT used FROM rate_buckets ORDER BY key')], [2, 2])
            self.assertTrue(ratelimit.reset(db, b))
            mixed = ratelimit.hit_many(db, [(a, 2, 60, 1), (b, 2, 60, 1)], self.now)
            self.assertTrue(all(not result['allowed'] for result in mixed))
            self.assertEqual([result['remaining'] for result in mixed], [0, 2])
            self.assertEqual(ratelimit.peek(db, b, 2, 60, self.now)['remaining'], 2)
            self.assertTrue(ratelimit.hit(db, b, 2, 60, self.now)['allowed'])
            self.assertTrue(ratelimit.hit(db, b, 2, 60, self.now)['allowed'])
            fresh = ratelimit.hit_many(db, [(a, 2, 60, 1), (b, 2, 60, 1)], self.now + 60)
            self.assertTrue(all(result['allowed'] for result in fresh))
            self.assertEqual([result['remaining'] for result in fresh], [1, 1])

    def test_hit_many_counts_duplicate_keys_and_rejects_conflicting_windows(self):
        key = self.key('dupe')
        with self.app.store.connect() as db:
            rejected = ratelimit.hit_many(db, [(key, 3, 60, 2), (key, 3, 60, 2)], self.now)
            self.assertTrue(all(not result['allowed'] for result in rejected))
            self.assertEqual(ratelimit.peek(db, key, 3, 60, self.now)['remaining'], 3)
            accepted = ratelimit.hit_many(db, [(key, 3, 60, 2), (key, 3, 60, 1)], self.now)
            self.assertTrue(all(result['allowed'] for result in accepted))
            self.assertEqual(ratelimit.peek(db, key, 3, 60, self.now)['remaining'], 0)
            with self.assertRaises(ValueError):
                ratelimit.hit_many(db, [(key, 3, 60, 1), (key, 3, 30, 1)], self.now)
            with self.assertRaises(ValueError):
                ratelimit.hit_many(db, [('bad', 3, 60)], self.now)
            with self.assertRaises(ValueError):
                ratelimit.hit_many(db, [('x', 3, 60, 1, 2)], self.now)

    def test_state_persists_across_store_reopen(self):
        key = self.key('persist')
        with self.app.store.connect() as db:
            self.assertTrue(ratelimit.hit(db, key, 2, 60, self.now)['allowed'])
        restarted = App(Store(self.path), Config(ORIGIN, allow_registration=True), clock=lambda: self.now)
        with restarted.store.connect() as db:
            ratelimit.ensure_schema(db)
            self.assertEqual(ratelimit.peek(db, key, 2, 60, self.now)['remaining'], 1)
            self.assertTrue(ratelimit.hit(db, key, 2, 60, self.now)['allowed'])
            self.assertFalse(ratelimit.hit(db, key, 2, 60, self.now)['allowed'])

    def test_hit_uses_a_savepoint_inside_an_outer_transaction(self):
        key = self.key('tx')
        with self.app.store.transaction() as db:
            self.assertTrue(ratelimit.hit(db, key, 1, 60, self.now)['allowed'])
            self.assertFalse(ratelimit.hit(db, key, 1, 60, self.now)['allowed'])
        with self.app.store.connect() as db:
            self.assertEqual(ratelimit.peek(db, key, 1, 60, self.now)['remaining'], 0)
        with self.assertRaises(RuntimeError):
            with self.app.store.transaction() as db:
                ratelimit.hit(db, self.key('rolled'), 1, 60, self.now)
                raise RuntimeError('rollback')
        with self.app.store.connect() as db:
            self.assertEqual(ratelimit.peek(db, self.key('rolled'), 1, 60, self.now)['remaining'], 1)


if __name__ == '__main__':
    unittest.main()
