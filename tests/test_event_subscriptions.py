"""Outbound event subscription registry, matching and delivery bookkeeping tests.

In-process WSGI + temporary SQLite only. These tests never send HTTP and never
place a secret value in the database; ``secret_ref`` is only an opaque pointer.
"""
from pathlib import Path
import tempfile
import unittest

from openteamily import event_subscriptions
from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


ENDPOINT = 'https://hooks.example.test/openteamily/events'


class EventSubscriptionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name).resolve() / 'state'
        self.app = App(Store(self.path), Config(ORIGIN, allow_registration=True), clock=lambda: 1800000000)
        self.alice = Client(self.app)
        self.alice.register('alice')
        self.wid = self.alice.workspace()['body']['workspace']['id']
        with self.app.store.connect() as db:
            event_subscriptions.ensure_schema(db)
        self.bob = Client(self.app, peer='127.0.0.2')
        self.bob.register('bob')
        self.other_wid = self.bob.workspace(
            name='Other workspace', key='request_other_0001')['body']['workspace']['id']

    def create(self, name='Deploy hook', endpoint=ENDPOINT, kinds=None, wid=None, now=1800000000, **kw):
        with self.app.store.connect() as db:
            return event_subscriptions.create_subscription(
                db, wid or self.wid, name, endpoint, now,
                ['artifact.created'] if kinds is None else kinds, **kw)

    def get(self, subscription_id, wid=None):
        with self.app.store.connect() as db:
            return event_subscriptions.get(db, wid or self.wid, subscription_id)

    def test_schema_is_idempotent_and_has_expected_columns_and_indexes(self):
        with self.app.store.connect() as db:
            event_subscriptions.ensure_schema(db)
            event_subscriptions.ensure_schema(db)
            tables = {row['name'] for row in db.execute(
                "SELECT name FROM sqlite_master WHERE type='table'")}
            indexes = {row['name'] for row in db.execute(
                "SELECT name FROM sqlite_master WHERE type='index'")}
            subscriptions = {row['name'] for row in db.execute(
                'PRAGMA table_info(event_subscriptions)')}
            deliveries = {row['name'] for row in db.execute(
                'PRAGMA table_info(event_delivery_records)')}
        self.assertIn('event_subscriptions', tables)
        self.assertIn('event_delivery_records', tables)
        self.assertEqual(subscriptions, {
            'id', 'workspace_id', 'name', 'endpoint', 'secret_ref', 'kinds', 'filters',
            'enabled', 'created', 'updated', 'last_delivery'})
        self.assertEqual(deliveries, {
            'id', 'workspace_id', 'subscription_id', 'event_kind', 'event_key',
            'status', 'created'})
        self.assertTrue({'event_subscription_workspace', 'event_delivery_record_lookup',
                         'event_delivery_record_kind'} <= indexes)

    def test_create_get_update_list_disable_and_delete(self):
        created = self.create(name='Deploy hook', kinds=['artifact.created', 'artifact.updated'],
                              secret_ref='vault://ot/hooks/deploy',
                              filters={'actor_id': 'alice'})
        self.assertEqual(created['name'], 'Deploy hook')
        self.assertEqual(created['endpoint'], ENDPOINT)
        self.assertEqual(created['secret_ref'], 'vault://ot/hooks/deploy')
        self.assertEqual(created['kinds'], ['artifact.created', 'artifact.updated'])
        self.assertEqual(created['filters'], {'actor_id': 'alice'})
        self.assertTrue(created['enabled'])
        self.assertIsNone(created['last_delivery'])
        self.assertEqual(created['created'], 1800000000)
        self.assertEqual(created['updated'], 1800000000)
        self.assertEqual(self.get(created['id']), created)

        second = self.create(name='Social hook', kinds=['social.message'])
        with self.app.store.connect() as db:
            listed = event_subscriptions.list(db, self.wid)
        self.assertEqual({item['name'] for item in listed}, {'Deploy hook', 'Social hook'})

        with self.app.store.connect() as db:
            by_kind = event_subscriptions.list(db, self.wid, kinds=['artifact.updated'])
            disabled = event_subscriptions.list(db, self.wid, enabled=False)
        self.assertEqual([item['id'] for item in by_kind], [created['id']])
        self.assertEqual(disabled, [])

        with self.app.store.connect() as db:
            updated = event_subscriptions.update_subscription(
                db, self.wid, created['id'], 1800000001, changes={
                    'name': 'Deploy hook v2',
                    'endpoint': 'https://hooks2.example.test/e',
                    'kinds': ['artifact.created'],
                    'filters': {'severity': {'in': ['high', 'critical']}},
                    'secret_ref': 'vault://ot/hooks/deploy-v2',
                    'enabled': False,
                })
        self.assertEqual(updated['name'], 'Deploy hook v2')
        self.assertEqual(updated['endpoint'], 'https://hooks2.example.test/e')
        self.assertEqual(updated['kinds'], ['artifact.created'])
        self.assertEqual(updated['filters'], {'severity': {'in': ['high', 'critical']}})
        self.assertEqual(updated['secret_ref'], 'vault://ot/hooks/deploy-v2')
        self.assertFalse(updated['enabled'])
        self.assertEqual(updated['updated'], 1800000001)
        self.assertEqual(self.get(created['id']), updated)

        with self.app.store.connect() as db:
            disabled_view = event_subscriptions.disable(db, self.wid, created['id'], 1800000002)
        self.assertFalse(disabled_view['enabled'])
        self.assertEqual(disabled_view['updated'], 1800000002)

        with self.app.store.connect() as db:
            enabled_view = event_subscriptions.update_subscription(
                db, self.wid, created['id'], 1800000003, enabled=True)
        self.assertTrue(enabled_view['enabled'])

        with self.app.store.connect() as db:
            self.assertTrue(event_subscriptions.delete(db, self.wid, created['id']))
        self.assertIsNone(self.get(created['id']))
        with self.app.store.connect() as db:
            self.assertFalse(event_subscriptions.delete(db, self.wid, created['id']))
            self.assertEqual([item['id'] for item in event_subscriptions.list(db, self.wid)],
                             [second['id']])

    def test_invalid_endpoint_kinds_name_and_secret_ref_are_rejected(self):
        for endpoint in (
                'http://hooks.example.test/e',
                'ftp://hooks.example.test/e',
                'https:///missing-host',
                'https://user:password@hooks.example.test/e',
                'https://hooks.example.test/e\nInjected: yes',
                'https://' + 'a' * 2049,
                'https://hooks.example.test/' + 'a' * 2100):
            with self.subTest(endpoint=endpoint[:60]):
                with self.assertRaises(ValueError):
                    self.create(endpoint=endpoint)
        for kinds in (
                [],
                'artifact.created',
                ['artifact.created', ''],
                ['bad kind'],
                [123],
                [f'kind.{index}' for index in range(51)]):
            with self.subTest(kinds=kinds):
                with self.assertRaises(ValueError):
                    self.create(kinds=kinds)
        for name in ('', 'x' * 81, 'bad\x00name'):
            with self.subTest(name=name):
                with self.assertRaises(ValueError):
                    self.create(name=name)
        for secret_ref in (123, 'x' * 257, 'bad\x00ref'):
            with self.subTest(secret_ref=secret_ref):
                with self.assertRaises(ValueError):
                    self.create(secret_ref=secret_ref)
        with self.app.store.connect() as db:
            self.assertEqual(event_subscriptions.list(db, self.wid), [])

    def test_matches_by_kind_and_enabled_state(self):
        artifacts = self.create(name='Artifact hook',
                                kinds=['artifact.created', 'artifact.updated'])
        social = self.create(name='Social hook', kinds=['social.message'])
        with self.app.store.connect() as db:
            art_matches = event_subscriptions.matches(
                db, self.wid, {'kind': 'artifact.created', 'artifact_id': 'a1'})
            social_matches = event_subscriptions.matches(
                db, self.wid, {'kind': 'social.message', 'conversation_id': 'c1'})
            none = event_subscriptions.matches(db, self.wid, {'kind': 'meeting.created'})
        self.assertEqual([item['id'] for item in art_matches], [artifacts['id']])
        self.assertEqual([item['id'] for item in social_matches], [social['id']])
        self.assertEqual(none, [])
        with self.app.store.connect() as db:
            event_subscriptions.disable(db, self.wid, artifacts['id'], 1800000001)
            self.assertEqual(event_subscriptions.matches(
                db, self.wid, {'kind': 'artifact.created'}), [])
            event_subscriptions.update_subscription(
                db, self.wid, artifacts['id'], 1800000002, enabled=True)
            self.assertEqual([item['id'] for item in event_subscriptions.matches(
                db, self.wid, {'kind': 'artifact.created'})], [artifacts['id']])

    def test_filter_equality_and_in_lists(self):
        filtered = self.create(name='Filtered', filters={
            'actor_id': 'u1',
            'severity': {'in': ['high', 'critical']},
            'active': True,
        })
        unfiltered = self.create(name='Unfiltered', filters={})
        with self.app.store.connect() as db:
            hit = event_subscriptions.matches(db, self.wid, {
                'kind': 'artifact.created', 'actor_id': 'u1',
                'severity': 'high', 'active': True, 'extra': 'ignored'})
            self.assertEqual({item['id'] for item in hit}, {filtered['id'], unfiltered['id']})
            self.assertEqual({item['id'] for item in event_subscriptions.matches(db, self.wid, {
                'kind': 'artifact.created', 'actor_id': 'u2',
                'severity': 'high', 'active': True})}, {unfiltered['id']})
            self.assertEqual({item['id'] for item in event_subscriptions.matches(db, self.wid, {
                'kind': 'artifact.created', 'actor_id': 'u1',
                'severity': 'low', 'active': True})}, {unfiltered['id']})
            self.assertEqual({item['id'] for item in event_subscriptions.matches(db, self.wid, {
                'kind': 'artifact.created', 'actor_id': 'u1', 'active': True})}, {unfiltered['id']})
            self.assertEqual({item['id'] for item in event_subscriptions.matches(db, self.wid, {
                'kind': 'artifact.created', 'actor_id': 'u1',
                'severity': 'critical', 'active': 1})}, {unfiltered['id']})

    def test_record_delivery_is_idempotent_and_delivery_stats(self):
        subscription = self.create(name='Delivery hook', kinds=['artifact.created'])
        with self.app.store.connect() as db:
            self.assertTrue(event_subscriptions.record_delivery(
                db, self.wid, subscription['id'], 'artifact.created', 'event-1', 1800000010))
            self.assertFalse(event_subscriptions.record_delivery(
                db, self.wid, subscription['id'], 'artifact.created', 'event-1', 1800000011))
            self.assertFalse(event_subscriptions.record_delivery(
                db, self.wid, subscription['id'], 'artifact.created', 'event-1', 1800000012,
                ok=False))
        self.assertEqual(self.get(subscription['id'])['last_delivery'], 1800000010)
        with self.app.store.connect() as db:
            self.assertTrue(event_subscriptions.record_delivery(
                db, self.wid, subscription['id'], 'artifact.created', 'event-2', 1800000013,
                ok=False))
            one = event_subscriptions.delivery_stats(db, self.wid, subscription['id'])
            all_stats = event_subscriptions.delivery_stats(db, self.wid)
        self.assertEqual(one, {'subscription_id': subscription['id'],
                               'delivered': 1, 'failed': 1, 'total': 2})
        self.assertEqual([item for item in all_stats if item['subscription_id'] == subscription['id']],
                         [one])
        self.assertEqual(self.get(subscription['id'])['last_delivery'], 1800000013)
        with self.app.store.connect() as db:
            for args in (
                    (self.wid, subscription['id'], 'bad kind', 'event-3', 1800000014),
                    (self.wid, subscription['id'], 'artifact.created', '', 1800000014),
                    (self.wid, 'missing-subscription', 'artifact.created', 'event-3', 1800000014)):
                with self.subTest(args=args):
                    with self.assertRaises((ValueError, LookupError)):
                        event_subscriptions.record_delivery(db, *args)
            with self.assertRaises(ValueError):
                event_subscriptions.record_delivery(
                    db, self.wid, subscription['id'], 'artifact.created', 'event-4', 1800000014,
                    ok='yes')
            with self.assertRaises(LookupError):
                event_subscriptions.delivery_stats(db, self.wid, 'missing-subscription')

    def test_workspace_isolation_for_read_write_match_and_delete(self):
        mine = self.create(name='Shared name', kinds=['artifact.created'])
        theirs = self.create(name='Shared name', kinds=['artifact.created'],
                             wid=self.other_wid, endpoint='https://other.example.test/e')
        self.assertIsNone(self.get(mine['id'], wid=self.other_wid))
        self.assertIsNone(self.get(theirs['id'], wid=self.wid))
        with self.app.store.connect() as db:
            self.assertEqual([item['id'] for item in event_subscriptions.list(db, self.wid)],
                             [mine['id']])
            self.assertEqual([item['id'] for item in event_subscriptions.list(db, self.other_wid)],
                             [theirs['id']])
            self.assertEqual([item['id'] for item in event_subscriptions.matches(
                db, self.wid, {'kind': 'artifact.created'})], [mine['id']])
            self.assertEqual([item['id'] for item in event_subscriptions.matches(
                db, self.other_wid, {'kind': 'artifact.created'})], [theirs['id']])
            with self.assertRaises(LookupError):
                event_subscriptions.record_delivery(
                    db, self.other_wid, mine['id'], 'artifact.created', 'event-1', 1800000010)
            with self.assertRaises(LookupError):
                event_subscriptions.delivery_stats(db, self.other_wid, mine['id'])
            self.assertFalse(event_subscriptions.delete(db, self.other_wid, mine['id']))
            stats = event_subscriptions.delivery_stats(db, self.other_wid)
        self.assertIsNotNone(self.get(mine['id']))
        self.assertEqual({item['subscription_id'] for item in stats}, {theirs['id']})
        with self.app.store.connect() as db:
            with self.assertRaises(LookupError):
                event_subscriptions.create_subscription(
                    db, 'missing-workspace', 'Hook', ENDPOINT, 1800000000, ['artifact.created'])

    def test_oversize_filters_and_endpoint_are_rejected(self):
        with self.assertRaises(ValueError):
            self.create(endpoint='https://hooks.example.test/' + 'a' * 2100)
        bad_filters = (
            'not-a-dict',
            {f'key{index}': 'value' for index in range(21)},
            {'k' * 65: 'value'},
            {'field': {'in': list(range(51))}},
            {'field': 'x' * 257},
            {'field': {'other': ['x']}},
            {'field': ['x']},
            {'field': float('inf')},
            {f'k{index}': 'x' * 256 for index in range(20)},
        )
        for filters in bad_filters:
            with self.subTest(filters=str(filters)[:80]):
                with self.assertRaises(ValueError):
                    self.create(filters=filters)
        with self.app.store.connect() as db:
            self.assertEqual(event_subscriptions.list(db, self.wid), [])

    def test_secret_ref_is_only_a_reference_and_plaintext_secret_is_not_accepted(self):
        subscription = self.create(name='Secret hook',
                                   secret_ref='vault://ot/workspaces/w/hooks/1')
        self.assertEqual(subscription['secret_ref'], 'vault://ot/workspaces/w/hooks/1')
        self.assertNotIn('secret', subscription)
        self.assertNotIn('secret_value', subscription)
        self.assertNotIn('vault://ot/workspaces/w/hooks/1', subscription['endpoint'])
        with self.app.store.connect() as db:
            columns = {row['name'] for row in db.execute(
                'PRAGMA table_info(event_subscriptions)')}
            row = db.execute('SELECT secret_ref FROM event_subscriptions WHERE id=?',
                             (subscription['id'],)).fetchone()
        self.assertNotIn('secret', columns)
        self.assertNotIn('api_key', columns)
        self.assertEqual(row['secret_ref'], 'vault://ot/workspaces/w/hooks/1')
        with self.assertRaises(TypeError):
            self.create(name='Plaintext hook', secret='plaintext-value')
        with self.app.store.connect() as db:
            with self.assertRaises(ValueError):
                event_subscriptions.update_subscription(
                    db, self.wid, subscription['id'], 1800000001,
                    changes={'secret': 'plaintext-value'})
            cleared = event_subscriptions.update_subscription(
                db, self.wid, subscription['id'], 1800000002,
                changes={'secret_ref': None})
        self.assertIsNone(cleared['secret_ref'])

    def test_kinds_are_normalized_and_names_are_unique_per_workspace(self):
        created = self.create(name='Normalized', kinds=[
            ' artifact.created ', 'artifact.created', 'artifact.updated'])
        self.assertEqual(created['kinds'], ['artifact.created', 'artifact.updated'])
        with self.assertRaises(ValueError):
            self.create(name='Normalized', endpoint='https://other.example.test/e')
        other = self.create(name='Normalized', wid=self.other_wid,
                            endpoint='https://other.example.test/e')
        self.assertNotEqual(created['id'], other['id'])
        second = self.create(name='Second', kinds=['social.message'])
        with self.app.store.connect() as db:
            with self.assertRaises(ValueError):
                event_subscriptions.update_subscription(
                    db, self.wid, second['id'], 1800000001, name='Normalized')
        self.assertEqual(self.get(second['id'])['name'], 'Second')

    def test_delete_removes_delivery_records(self):
        subscription = self.create(name='Deleted hook')
        with self.app.store.connect() as db:
            event_subscriptions.record_delivery(
                db, self.wid, subscription['id'], 'artifact.created', 'event-1', 1800000010)
            self.assertTrue(event_subscriptions.delete(db, self.wid, subscription['id']))
            records = db.execute(
                'SELECT COUNT(*) FROM event_delivery_records WHERE workspace_id=? AND subscription_id=?',
                (self.wid, subscription['id'])).fetchone()[0]
            stats = event_subscriptions.delivery_stats(db, self.wid)
        self.assertEqual(records, 0)
        self.assertEqual(stats, [])


if __name__ == '__main__':
    unittest.main()
