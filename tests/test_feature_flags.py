"""Feature flag persistence, validation and deterministic bucketing tests."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from openteamily import feature_flags
from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class FeatureFlagTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name).resolve() / 'state'
        self.now = 1800000000
        self.app = App(Store(self.path), Config(ORIGIN, allow_registration=True), clock=lambda: self.now)
        self.alice = Client(self.app)
        self.alice_id = self.alice.register('alice')['body']['user']['id']
        self.bob = Client(self.app, peer='127.0.0.2')
        self.bob_id = self.bob.register('bob')['body']['user']['id']
        self.carol = Client(self.app, peer='127.0.0.3')
        self.carol_id = self.carol.register('carol')['body']['user']['id']
        self.wid = self.alice.workspace()['body']['workspace']['id']
        self.wid2 = self.alice.workspace(name='Other', key='request_example_0002')['body']['workspace']['id']
        with self.app.store.connect() as db:
            feature_flags.ensure_schema(db)

    def test_schema_is_idempotent_and_has_expected_columns(self):
        with self.app.store.connect() as db:
            feature_flags.ensure_schema(db)
            feature_flags.define_flag(db, 'kept.flag-1', self.now)
            feature_flags.ensure_schema(db)
            columns = [row['name'] for row in db.execute('PRAGMA table_info(feature_flags)')]
            found = db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='feature_flags'").fetchone()
            kept = feature_flags.get_flag(db, 'kept.flag-1')
        self.assertEqual(columns, [
            'key', 'enabled', 'rollout_percent', 'allow_users', 'allow_workspaces',
            'description', 'created', 'updated',
        ])
        self.assertIsNotNone(found)
        self.assertIsNotNone(kept)

    def test_define_get_list_and_delete(self):
        with self.app.store.connect() as db:
            first = feature_flags.define_flag(
                db, 'alpha', self.now, enabled=True, rollout_percent=25,
                allow_users=['user-a'], allow_workspaces=['workspace-a'], description='Alpha flag',
            )
            second = feature_flags.define_flag(db, 'beta', self.now + 1)
            self.assertEqual(first['key'], 'alpha')
            self.assertIs(first['enabled'], True)
            self.assertEqual(first['rollout_percent'], 25)
            self.assertEqual(first['allow_users'], ['user-a'])
            self.assertEqual(first['allow_workspaces'], ['workspace-a'])
            self.assertEqual(first['description'], 'Alpha flag')
            self.assertEqual(first['created'], self.now)
            self.assertEqual(first['updated'], self.now)
            self.assertEqual(feature_flags.get_flag(db, 'alpha'), first)
            self.assertIsNone(feature_flags.get_flag(db, 'missing'))
            self.assertEqual([item['key'] for item in feature_flags.list_flags(db)], ['alpha', 'beta'])
            page = feature_flags.list_flags(db, limit=1)
            self.assertEqual([item['key'] for item in page], ['alpha'])
            rest = feature_flags.list_flags(db, limit=1, cursor=page[-1]['key'])
            self.assertEqual([item['key'] for item in rest], ['beta'])
            self.assertTrue(feature_flags.delete_flag(db, 'alpha'))
            self.assertIsNone(feature_flags.get_flag(db, 'alpha'))
            self.assertFalse(feature_flags.delete_flag(db, 'alpha'))
            self.assertEqual(feature_flags.list_flags(db), [second])

    def test_define_upserts_full_definition_and_preserves_created(self):
        with self.app.store.connect() as db:
            feature_flags.define_flag(
                db, 'upsert', self.now, enabled=True, rollout_percent=90,
                allow_users=['user-a'], allow_workspaces=['workspace-a'], description='old',
            )
            changed = feature_flags.define_flag(
                db, 'upsert', self.now + 10, enabled=False, rollout_percent=5,
                allow_users=None, allow_workspaces=['workspace-b'], description='new',
            )
        self.assertIs(changed['enabled'], False)
        self.assertEqual(changed['rollout_percent'], 5)
        self.assertEqual(changed['allow_users'], [])
        self.assertEqual(changed['allow_workspaces'], ['workspace-b'])
        self.assertEqual(changed['description'], 'new')
        self.assertEqual(changed['created'], self.now)
        self.assertEqual(changed['updated'], self.now + 10)

    def test_set_flag_updates_only_supplied_fields(self):
        with self.app.store.connect() as db:
            feature_flags.define_flag(
                db, 'partial', self.now, enabled=True, rollout_percent=10,
                allow_users=['user-a'], allow_workspaces=['workspace-a'], description='keep',
            )
            changed = feature_flags.set_flag(db, 'partial', self.now + 1, rollout_percent=50)
            self.assertIs(changed['enabled'], True)
            self.assertEqual(changed['rollout_percent'], 50)
            self.assertEqual(changed['allow_users'], ['user-a'])
            self.assertEqual(changed['allow_workspaces'], ['workspace-a'])
            self.assertEqual(changed['description'], 'keep')
            self.assertEqual(changed['updated'], self.now + 1)
            changed = feature_flags.set_flag(db, 'partial', self.now + 2, allow_users=['user-b'])
            self.assertEqual(changed['allow_users'], ['user-b'])
            self.assertEqual(changed['rollout_percent'], 50)
            self.assertEqual(changed['description'], 'keep')
            unchanged = feature_flags.set_flag(db, 'partial', self.now + 3)
            self.assertEqual(unchanged['updated'], self.now + 2)
            self.assertIs(feature_flags.set_flag(
                db, 'partial', self.now + 4, enabled=False
            )['enabled'], False)
            with self.assertRaises(KeyError):
                feature_flags.set_flag(db, 'missing', self.now, enabled=True)

    def test_invalid_key_rollout_allowlists_and_description_are_rejected(self):
        with self.app.store.connect() as db:
            for key in ('', 'Upper', 'has space', 'slash/key', 'tab\tkey', 'é', 'a' * 65):
                with self.assertRaises(ValueError):
                    feature_flags.define_flag(db, key, self.now)
            for rollout in (-1, 101, '10', 1.5, True):
                with self.assertRaises(ValueError):
                    feature_flags.define_flag(db, 'bad-rollout', self.now, rollout_percent=rollout)
            feature_flags.define_flag(db, 'valid-rollout', self.now, rollout_percent=0)
            feature_flags.define_flag(db, 'valid-rollout-100', self.now, rollout_percent=100)
            with self.assertRaises(ValueError):
                feature_flags.set_flag(db, 'Bad Key', self.now, enabled=True)
            with self.assertRaises(ValueError):
                feature_flags.set_flag(db, 'valid-rollout', self.now, rollout_percent=101)
            with self.assertRaises(ValueError):
                feature_flags.define_flag(db, 'bad-enabled', self.now, enabled=1)
            with self.assertRaises(ValueError):
                feature_flags.define_flag(db, 'bad-users', self.now, allow_users='user-a')
            with self.assertRaises(ValueError):
                feature_flags.define_flag(db, 'bad-users-item', self.now, allow_users=[1])
            with self.assertRaises(ValueError):
                feature_flags.define_flag(db, 'bad-users-long', self.now, allow_users=['x' * 129])
            with self.assertRaises(ValueError):
                feature_flags.define_flag(db, 'bad-users-count', self.now, allow_users=['x'] * 1001)
            with self.assertRaises(ValueError):
                feature_flags.define_flag(db, 'bad-workspaces', self.now, allow_workspaces={'workspace-a'})
            with self.assertRaises(ValueError):
                feature_flags.define_flag(db, 'bad-description', self.now, description='x' * 2001)
            with self.assertRaises(ValueError):
                feature_flags.define_flag(db, 'bad-description-type', self.now, description=123)
            self.assertIsNone(feature_flags.get_flag(db, 'Upper'))
            self.assertEqual(feature_flags.list_flags(db), [
                feature_flags.get_flag(db, 'valid-rollout'),
                feature_flags.get_flag(db, 'valid-rollout-100'),
            ])

    def test_bucket_is_deterministic_stable_and_in_range(self):
        key, user_id, workspace_id = 'checkout', 'user-123', 'workspace-456'
        expected = int(
            hashlib.sha256(f'{key}:{user_id}:{workspace_id}'.encode()).hexdigest()[:8], 16
        ) % 100
        self.assertEqual(feature_flags.bucket(key, user_id, workspace_id), expected)
        for _ in range(25):
            self.assertEqual(feature_flags.bucket(key, user_id, workspace_id), expected)
        self.assertEqual(feature_flags.bucket(key), feature_flags.bucket(key))
        for index in range(100):
            value = feature_flags.bucket('rollout', f'user-{index}', f'workspace-{index}')
            self.assertIsInstance(value, int)
            self.assertGreaterEqual(value, 0)
            self.assertLess(value, 100)

    def test_rollout_zero_is_off_and_hundred_is_on_when_enabled(self):
        with self.app.store.connect() as db:
            feature_flags.define_flag(db, 'off', self.now, enabled=True, rollout_percent=0)
            feature_flags.define_flag(db, 'on', self.now, enabled=True, rollout_percent=100)
            feature_flags.define_flag(db, 'on-but-disabled', self.now, enabled=False, rollout_percent=100)
            for index in range(30):
                self.assertFalse(feature_flags.is_enabled(
                    db, 'off', user_id=f'user-{index}', workspace_id=f'workspace-{index}'
                ))
                self.assertTrue(feature_flags.is_enabled(
                    db, 'on', user_id=f'user-{index}', workspace_id=f'workspace-{index}'
                ))
                self.assertFalse(feature_flags.is_enabled(
                    db, 'on-but-disabled', user_id=f'user-{index}', workspace_id=f'workspace-{index}'
                ))

    def test_partial_rollout_matches_deterministic_bucket(self):
        with self.app.store.connect() as db:
            feature_flags.define_flag(db, 'gradual', self.now, enabled=True, rollout_percent=37)
            for index in range(100):
                user_id, workspace_id = f'user-{index}', f'workspace-{index}'
                expected = feature_flags.bucket('gradual', user_id, workspace_id) < 37
                self.assertEqual(
                    feature_flags.is_enabled(db, 'gradual', user_id=user_id, workspace_id=workspace_id),
                    expected,
                )

    def test_user_and_workspace_allowlists_override_zero_rollout(self):
        with self.app.store.connect() as db:
            feature_flags.define_flag(
                db, 'user-allow', self.now, enabled=True, rollout_percent=0,
                allow_users=[self.alice_id],
            )
            self.assertTrue(feature_flags.is_enabled(
                db, 'user-allow', user_id=self.alice_id, workspace_id=self.wid
            ))
            self.assertFalse(feature_flags.is_enabled(
                db, 'user-allow', user_id=self.bob_id, workspace_id=self.wid
            ))
            self.assertFalse(feature_flags.is_enabled(
                db, 'user-allow', workspace_id=self.wid
            ))
            feature_flags.define_flag(
                db, 'workspace-allow', self.now, enabled=True, rollout_percent=0,
                allow_workspaces=[self.wid],
            )
            self.assertTrue(feature_flags.is_enabled(
                db, 'workspace-allow', user_id=self.bob_id, workspace_id=self.wid
            ))
            self.assertFalse(feature_flags.is_enabled(
                db, 'workspace-allow', user_id=self.bob_id, workspace_id=self.wid2
            ))
            self.assertFalse(feature_flags.is_enabled(
                db, 'workspace-allow', user_id=self.bob_id
            ))

    def test_disabled_flag_overrides_allowlists(self):
        with self.app.store.connect() as db:
            feature_flags.define_flag(
                db, 'blocked', self.now, enabled=False, rollout_percent=100,
                allow_users=[self.alice_id], allow_workspaces=[self.wid],
            )
            self.assertFalse(feature_flags.is_enabled(
                db, 'blocked', user_id=self.alice_id, workspace_id=self.wid
            ))
            feature_flags.set_flag(db, 'blocked', self.now + 1, enabled=True)
            self.assertTrue(feature_flags.is_enabled(
                db, 'blocked', user_id=self.alice_id, workspace_id=self.wid2
            ))
            self.assertTrue(feature_flags.is_enabled(
                db, 'blocked', user_id=self.carol_id, workspace_id=self.wid
            ))

    def test_unknown_flag_returns_explicit_default(self):
        with self.app.store.connect() as db:
            self.assertFalse(feature_flags.is_enabled(db, 'missing'))
            self.assertTrue(feature_flags.is_enabled(db, 'missing', default=True))
            self.assertFalse(feature_flags.is_enabled(
                db, 'missing', user_id=self.alice_id, workspace_id=self.wid, default=False
            ))
            self.assertTrue(feature_flags.is_enabled(
                db, 'missing', user_id=self.alice_id, workspace_id=self.wid, default=True
            ))

    def test_user_and_workspace_inputs_are_separate(self):
        with self.app.store.connect() as db:
            feature_flags.define_flag(db, 'separate', self.now, enabled=True, rollout_percent=100)
            one = feature_flags.bucket('separate', user_id=self.alice_id, workspace_id=self.wid)
            two = feature_flags.bucket('separate', user_id=self.bob_id, workspace_id=self.wid)
            three = feature_flags.bucket('separate', user_id=self.alice_id, workspace_id=self.wid2)
            self.assertEqual(one, feature_flags.bucket('separate', self.alice_id, self.wid))
            self.assertEqual(one, int(hashlib.sha256(
                f'separate:{self.alice_id}:{self.wid}'.encode()
            ).hexdigest()[:8], 16) % 100)
            self.assertEqual(two, int(hashlib.sha256(
                f'separate:{self.bob_id}:{self.wid}'.encode()
            ).hexdigest()[:8], 16) % 100)
            self.assertEqual(three, int(hashlib.sha256(
                f'separate:{self.alice_id}:{self.wid2}'.encode()
            ).hexdigest()[:8], 16) % 100)
            feature_flags.define_flag(
                db, 'alice-only', self.now, enabled=True, rollout_percent=0,
                allow_users=[self.alice_id],
            )
            self.assertTrue(feature_flags.is_enabled(
                db, 'alice-only', user_id=self.alice_id, workspace_id=self.wid
            ))
            self.assertFalse(feature_flags.is_enabled(
                db, 'alice-only', user_id=self.bob_id, workspace_id=self.wid
            ))
            self.assertFalse(feature_flags.is_enabled(
                db, 'alice-only', workspace_id=self.wid
            ))

    def test_allowlists_round_trip_through_json(self):
        with self.app.store.connect() as db:
            flag = feature_flags.define_flag(
                db, 'roundtrip', self.now,
                allow_users=['user-a', 'user-b', 'user-a'],
                allow_workspaces=['workspace-a', 'workspace-b'],
                description='Round trip',
            )
            self.assertEqual(flag['allow_users'], ['user-a', 'user-b'])
            self.assertEqual(flag['allow_workspaces'], ['workspace-a', 'workspace-b'])
            row = db.execute(
                'SELECT allow_users, allow_workspaces FROM feature_flags WHERE key=?',
                ('roundtrip',),
            ).fetchone()
            self.assertEqual(json.loads(row['allow_users']), ['user-a', 'user-b'])
            self.assertEqual(json.loads(row['allow_workspaces']), ['workspace-a', 'workspace-b'])
            changed = feature_flags.set_flag(
                db, 'roundtrip', self.now + 1,
                allow_users=['user-c'], allow_workspaces=['workspace-c'],
            )
            self.assertEqual(changed['allow_users'], ['user-c'])
            self.assertEqual(changed['allow_workspaces'], ['workspace-c'])
            cleared = feature_flags.define_flag(
                db, 'roundtrip', self.now + 2, allow_users=None, allow_workspaces=None,
            )
            self.assertEqual(cleared['allow_users'], [])
            self.assertEqual(cleared['allow_workspaces'], [])
            row = db.execute(
                'SELECT allow_users, allow_workspaces FROM feature_flags WHERE key=?',
                ('roundtrip',),
            ).fetchone()
            self.assertEqual(json.loads(row['allow_users']), [])
            self.assertEqual(json.loads(row['allow_workspaces']), [])


if __name__ == '__main__':
    unittest.main()
