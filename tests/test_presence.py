"""Ephemeral chat presence leases: who is online and who is typing.

In-process SQLite only. The module is not wired to HTTP routes here; callers are
responsible for authorising workspace/conversation access before calling it.
"""
from pathlib import Path
import tempfile
import unittest
from uuid import uuid4

from openteamily.app import App, Config
from openteamily.store import Store
from openteamily import presence
from tests.test_management import Client, ORIGIN


class PresenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = 1800000000
        self.path = Path(self.temp.name).resolve() / 'state'
        self.app = App(Store(self.path), Config(ORIGIN, allow_registration=True),
                       clock=lambda: self.now)
        self.alice = Client(self.app)
        self.alice.register('alice')
        self.bob = Client(self.app, peer='127.0.0.2')
        self.bob.register('bob')
        self.wid = self.alice.workspace()['body']['workspace']['id']
        self.other_wid = self.bob.workspace('bob-space', 'request_example_0002')['body']['workspace']['id']
        self.alice_id = self._user_id(self.alice)
        self.bob_id = self._user_id(self.bob)
        self.cid = uuid4().hex
        self.other_cid = uuid4().hex
        with self.app.store.connect() as db:
            presence.ensure_schema(db)

    def _user_id(self, client):
        return client.call('GET', '/v1/auth/session')['body']['user']['id']

    def test_schema_is_idempotent_and_has_expected_shape(self):
        with self.app.store.connect() as db:
            presence.ensure_schema(db)
            presence.ensure_schema(db)
            columns = {row['name']: row for row in db.execute(
                'PRAGMA table_info(presence_leases)')}
            self.assertEqual(set(columns), {
                'workspace_id', 'conversation_id', 'user_id', 'kind', 'expires', 'updated'})
            self.assertEqual([name for name, row in sorted(
                columns.items(), key=lambda item: item[1]['pk'])
                if row['pk']], ['workspace_id', 'conversation_id', 'user_id', 'kind'])
            indexes = {row['name']: row for row in db.execute(
                'PRAGMA index_list(presence_leases)')}
            self.assertTrue(any(
                [item['name'] for item in db.execute(
                    f'PRAGMA index_info("{name}")')]
                == ['workspace_id', 'conversation_id', 'expires']
                for name in indexes))

    def test_heartbeat_upserts_and_extends_expiry_without_duplicate_rows(self):
        with self.app.store.connect() as db:
            first = presence.heartbeat(
                db, self.wid, self.cid, self.alice_id, 'online', self.now, ttl_seconds=30)
            self.assertEqual(first['expires'], self.now + 30)
            second = presence.heartbeat(
                db, self.wid, self.cid, self.alice_id, 'online', self.now + 10, ttl_seconds=30)
            self.assertEqual(second['expires'], self.now + 40)
            self.assertGreater(second['expires'], first['expires'])
            for offset in range(1, 5):
                presence.heartbeat(
                    db, self.wid, self.cid, self.alice_id, 'online',
                    self.now + offset, ttl_seconds=30)
            self.assertEqual(db.execute(
                'SELECT COUNT(*) FROM presence_leases WHERE workspace_id=? AND conversation_id=? '
                'AND user_id=? AND kind=?',
                (self.wid, self.cid, self.alice_id, 'online')).fetchone()[0], 1)
            rows = presence.list_active(db, self.wid, self.cid, self.now + 20)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['user_id'], self.alice_id)
        self.assertEqual(rows[0]['kind'], 'online')

    def test_list_active_excludes_expired_leases(self):
        with self.app.store.connect() as db:
            presence.heartbeat(db, self.wid, self.cid, self.alice_id, 'online',
                               self.now, ttl_seconds=10)
        with self.app.store.connect() as db:
            active = presence.list_active(db, self.wid, self.cid, self.now + 9)
            self.assertEqual([row['user_id'] for row in active], [self.alice_id])
            self.assertEqual(presence.list_active(db, self.wid, self.cid, self.now + 10), [])
            self.assertEqual(presence.list_active(db, self.wid, self.cid, self.now + 100), [])

    def test_clear_by_user_and_kind_does_not_touch_other_leases(self):
        with self.app.store.connect() as db:
            presence.heartbeat(db, self.wid, self.cid, self.alice_id, 'online', self.now)
            presence.heartbeat(db, self.wid, self.cid, self.alice_id, 'typing', self.now)
            presence.heartbeat(db, self.wid, self.cid, self.bob_id, 'online', self.now)
            self.assertEqual(presence.clear(
                db, self.wid, self.cid, self.alice_id, 'typing', self.now), 1)
            remaining = presence.list_active(db, self.wid, self.cid, self.now)
            self.assertEqual({(row['user_id'], row['kind']) for row in remaining},
                             {(self.alice_id, 'online'), (self.bob_id, 'online')})
            self.assertEqual(presence.clear(
                db, self.wid, self.cid, self.alice_id, now=self.now), 1)
            remaining = presence.list_active(db, self.wid, self.cid, self.now)
            self.assertEqual([(row['user_id'], row['kind']) for row in remaining],
                             [(self.bob_id, 'online')])
            self.assertEqual(presence.clear(
                db, self.wid, self.cid, self.alice_id, now=self.now), 0)

    def test_sweep_expired_removes_only_expired_leases(self):
        with self.app.store.connect() as db:
            presence.heartbeat(db, self.wid, self.cid, self.alice_id, 'online',
                               self.now, ttl_seconds=10)
            presence.heartbeat(db, self.wid, self.cid, self.bob_id, 'typing',
                               self.now, ttl_seconds=100)
            self.assertEqual(presence.sweep_expired(db, self.now + 20), 1)
            self.assertEqual(presence.sweep_expired(db, self.now + 20), 0)
            remaining = presence.list_active(db, self.wid, self.cid, self.now + 20)
            self.assertEqual([(row['user_id'], row['kind']) for row in remaining],
                             [(self.bob_id, 'typing')])
            self.assertEqual(presence.sweep_expired(db, self.now + 100), 1)
            self.assertEqual(presence.list_active(db, self.wid, self.cid, self.now + 100), [])

    def test_is_typing_is_lease_and_kind_aware(self):
        with self.app.store.connect() as db:
            self.assertFalse(presence.is_typing(db, self.wid, self.cid, self.alice_id, self.now))
            presence.heartbeat(db, self.wid, self.cid, self.alice_id, 'online',
                               self.now, ttl_seconds=60)
            self.assertFalse(presence.is_typing(db, self.wid, self.cid, self.alice_id, self.now))
            presence.heartbeat(db, self.wid, self.cid, self.alice_id, 'typing',
                               self.now, ttl_seconds=10)
            self.assertTrue(presence.is_typing(
                db, self.wid, self.cid, self.alice_id, self.now + 9))
            self.assertFalse(presence.is_typing(
                db, self.wid, self.cid, self.alice_id, self.now + 10))
            self.assertFalse(presence.is_typing(
                db, self.wid, self.cid, self.bob_id, self.now))
            self.assertFalse(presence.is_typing(
                db, self.wid, self.other_cid, self.alice_id, self.now))

    def test_invalid_kind_and_ttl_are_rejected(self):
        with self.app.store.connect() as db:
            for kind in ('away', 'ONLINE', '', None, 1):
                with self.assertRaises(ValueError):
                    presence.heartbeat(db, self.wid, self.cid, self.alice_id, kind, self.now)
            for ttl in (0, -1, presence.MAX_TTL_SECONDS + 1, '30', None, True, 1.5):
                with self.assertRaises(ValueError):
                    presence.heartbeat(db, self.wid, self.cid, self.alice_id, 'online',
                                       self.now, ttl_seconds=ttl)
            with self.assertRaises(ValueError):
                presence.list_active(db, self.wid, self.cid, self.now, 'away')
            with self.assertRaises(ValueError):
                presence.clear(db, self.wid, self.cid, self.alice_id, 'away')

    def test_conversation_and_workspace_isolation(self):
        with self.app.store.connect() as db:
            presence.heartbeat(db, self.wid, self.cid, self.alice_id, 'typing', self.now)
            presence.heartbeat(db, self.wid, self.other_cid, self.bob_id, 'typing', self.now)
            presence.heartbeat(db, self.other_wid, self.cid, self.alice_id, 'typing', self.now)
            first = presence.list_active(db, self.wid, self.cid, self.now)
            self.assertEqual([row['user_id'] for row in first], [self.alice_id])
            second = presence.list_active(db, self.wid, self.other_cid, self.now)
            self.assertEqual([row['user_id'] for row in second], [self.bob_id])
            self.assertEqual(presence.list_active(
                db, self.other_wid, self.cid, self.now)[0]['user_id'], self.alice_id)
            self.assertEqual(presence.clear(
                db, self.wid, self.cid, self.alice_id, now=self.now), 1)
            self.assertFalse(presence.is_typing(
                db, self.wid, self.cid, self.alice_id, self.now))
            self.assertTrue(presence.is_typing(
                db, self.other_wid, self.cid, self.alice_id, self.now))
            self.assertTrue(presence.is_typing(
                db, self.wid, self.other_cid, self.bob_id, self.now))

    def test_ids_are_bounded(self):
        with self.app.store.connect() as db:
            for bad in ('', 'x' * (presence.ID_MAX + 1), None, 123, 'bad\x00id'):
                with self.assertRaises(ValueError):
                    presence.heartbeat(db, bad, self.cid, self.alice_id,
                                       'online', self.now)
                with self.assertRaises(ValueError):
                    presence.heartbeat(db, self.wid, bad, self.alice_id,
                                       'online', self.now)
                with self.assertRaises(ValueError):
                    presence.heartbeat(db, self.wid, self.cid, bad,
                                       'online', self.now)


if __name__ == '__main__':
    unittest.main()
