"""Versioned consent ledger tests. Temporary SQLite only; no external calls."""
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from openteamily import consents
from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


DEFAULT = object()


class ConsentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name).resolve() / 'state'
        self.app = App(Store(self.path), Config(ORIGIN, allow_registration=True), clock=lambda: 1800000000)
        self.alice_client = Client(self.app)
        self.alice_client.register('alice')
        self.bob_client = Client(self.app, peer='127.0.0.2')
        self.bob_client.register('bob')
        with self.app.store.connect() as db:
            consents.ensure_schema(db)
            self.alice = db.execute("SELECT id FROM users WHERE username='alice'").fetchone()[0]
            self.bob = db.execute("SELECT id FROM users WHERE username='bob'").fetchone()[0]

    def register(self, kind='terms', version='1.0.0', effective=1000, now=1000):
        with self.app.store.connect() as db:
            return consents.register_document(db, kind, version, effective, now)

    def grant(self, user=DEFAULT, kind='terms', version='1.0.0', now=1100, method='web', evidence=None):
        with self.app.store.connect() as db:
            return consents.grant(db, self.alice if user is DEFAULT else user, kind, version, now,
                                  method=method, evidence=evidence)

    def withdraw(self, user=DEFAULT, kind='terms', version='1.0.0', now=1200):
        with self.app.store.connect() as db:
            return consents.withdraw(db, self.alice if user is DEFAULT else user, kind, version, now)

    def status(self, user=DEFAULT, kind='terms', now=None):
        with self.app.store.connect() as db:
            user = self.alice if user is DEFAULT else user
            if now is None:
                return consents.current_status(db, user, kind)
            return consents.current_status(db, user, kind, now=now)

    def history(self, user=DEFAULT, kind=None):
        with self.app.store.connect() as db:
            return consents.list_history(db, self.alice if user is DEFAULT else user, kind)

    def current(self, kind='terms', now=1000):
        with self.app.store.connect() as db:
            return consents.current_document(db, kind, now)

    def missing(self, kinds, now=1000, user=DEFAULT):
        with self.app.store.connect() as db:
            return consents.require_all(db, self.alice if user is DEFAULT else user, kinds, now)

    def test_schema_is_idempotent_and_enforces_constraints(self):
        with self.app.store.connect() as db:
            consents.ensure_schema(db)
            consents.ensure_schema(db)
            names = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type IN ('table','index')")}
            self.assertIn('consent_documents', names)
            self.assertIn('user_consents', names)
            self.assertIn('consent_documents_current', names)
            self.assertIn('user_consents_history', names)
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("INSERT INTO consent_documents(kind,version,effective,created) VALUES('other','1',0,0)")
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("INSERT INTO consent_documents(kind,version,effective,created) VALUES('terms','1',0,0)")
                db.execute("INSERT INTO consent_documents(kind,version,effective,created) VALUES('terms','1',0,0)")
        with self.app.store.connect() as db:
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("INSERT INTO user_consents(id,user_id,kind,version,status,method,evidence_hash,created,updated) "
                           "VALUES('x',?,'terms','1','pending','web',NULL,0,0)", (self.alice,))
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("INSERT INTO user_consents(id,user_id,kind,version,status,method,evidence_hash,created,updated) "
                           "VALUES('x',?,'terms','1','granted','web',NULL,0,0)", (self.alice,))
                db.execute("INSERT INTO user_consents(id,user_id,kind,version,status,method,evidence_hash,created,updated) "
                           "VALUES('y',?,'terms','1','withdrawn','web',NULL,0,0)", (self.alice,))

    def test_register_and_current_document_respect_effective_time(self):
        first = self.register('terms', '1.0.0', effective=1000, now=900)
        self.assertEqual(first, {'kind': 'terms', 'version': '1.0.0', 'effective': 1000, 'created': 900})
        self.assertEqual(self.register('terms', '2.0.0', effective=2000, now=950)['effective'], 2000)
        self.assertIsNone(self.current('terms', 999))
        self.assertEqual(self.current('terms', 1000)['version'], '1.0.0')
        self.assertEqual(self.current('terms', 1999)['version'], '1.0.0')
        self.assertEqual(self.current('terms', 2000)['version'], '2.0.0')
        self.assertEqual(self.register('terms', '1.0.0', 1000, 999), first)
        with self.assertRaises(ValueError):
            self.register('terms', '1.0.0', 3000, 1000)
        self.assertEqual(self.current('privacy', 3000), None)

    def test_grant_withdraw_regrant_and_current_status(self):
        self.register('terms', '1.0.0', effective=1000)
        record = self.grant(now=1100, method='web', evidence={'ticket': 'abc'})
        self.assertEqual(record['status'], 'granted')
        self.assertEqual(record['method'], 'web')
        self.assertEqual(record['created'], 1100)
        self.assertEqual(record['updated'], 1100)
        self.assertEqual(len(record['evidence_hash']), 64)
        status = self.status(now=1100)
        self.assertTrue(status['granted'])
        self.assertEqual(status['required_version'], '1.0.0')
        self.assertEqual(status['record']['id'], record['id'])
        withdrawn = self.withdraw(now=1200)
        self.assertEqual(withdrawn['status'], 'withdrawn')
        self.assertEqual(withdrawn['updated'], 1200)
        self.assertFalse(self.status(now=1200)['granted'])
        again = self.grant(now=1300, method='api', evidence={'ticket': 'def'})
        self.assertEqual(again['id'], record['id'])
        self.assertEqual(again['created'], 1100)
        self.assertEqual(again['updated'], 1300)
        self.assertEqual(again['method'], 'api')
        self.assertNotEqual(again['evidence_hash'], record['evidence_hash'])
        self.assertTrue(self.status(now=1300)['granted'])
        with self.assertRaises(ValueError):
            self.withdraw(version='9.9.9', now=1400)

    def test_version_bump_requires_a_new_grant(self):
        self.register('terms', '1.0.0', effective=1000)
        self.grant(version='1.0.0', now=1100)
        self.register('terms', '2.0.0', effective=2000, now=1200)
        old = self.status(now=1500)
        self.assertEqual(old['required_version'], '1.0.0')
        self.assertTrue(old['granted'])
        current = self.status(now=2000)
        self.assertEqual(current['required_version'], '2.0.0')
        self.assertEqual(current['record']['version'], '1.0.0')
        self.assertFalse(current['granted'])
        self.assertEqual(self.missing(['terms'], now=2000), ['terms'])
        self.grant(version='2.0.0', now=2100)
        self.assertTrue(self.status(now=2100)['granted'])
        self.assertEqual(self.missing(['terms'], now=2100), [])

    def test_current_status_without_now_uses_latest_registered_document(self):
        self.register('terms', '1.0.0', effective=1000)
        self.grant(version='1.0.0', now=1100)
        self.register('terms', '2.0.0', effective=9000, now=1200)
        status = self.status()
        self.assertEqual(status['required_version'], '2.0.0')
        self.assertFalse(status['granted'])

    def test_require_all_missing_and_present(self):
        for kind in ('terms', 'privacy', 'marketing'):
            self.register(kind, '1.0.0', effective=1000)
        self.grant(kind='terms', now=1100)
        self.grant(kind='privacy', now=1200)
        self.assertEqual(self.missing(['terms', 'privacy'], now=1300), [])
        self.assertEqual(self.missing(['terms', 'privacy', 'marketing'], now=1300), ['marketing'])
        self.assertEqual(self.missing(['terms', 'recording'], now=1300), ['recording'])
        self.assertEqual(self.missing(['marketing', 'marketing'], now=1300), ['marketing'])
        self.grant(kind='marketing', now=1400)
        self.withdraw(kind='marketing', now=1500)
        self.assertEqual(self.missing(['marketing'], now=1500), ['marketing'])
        self.assertEqual(self.missing([], now=1500), [])

    def test_history_is_newest_first_filtered_and_user_isolated(self):
        for kind in ('terms', 'privacy', 'marketing'):
            self.register(kind, '1.0.0', effective=1000)
        self.register('terms', '2.0.0', effective=1000, now=1000)
        terms_v1 = self.grant(kind='terms', version='1.0.0', now=1100)
        privacy = self.grant(kind='privacy', version='1.0.0', now=1200)
        terms_v2 = self.grant(kind='terms', version='2.0.0', now=1300)
        self.assertEqual([row['id'] for row in self.history()], [terms_v2['id'], privacy['id'], terms_v1['id']])
        self.assertEqual([row['version'] for row in self.history(kind='terms')], ['2.0.0', '1.0.0'])
        self.assertEqual(self.history(kind='marketing'), [])
        bob_record = self.grant(user=self.bob, kind='terms', version='2.0.0', now=1400)
        self.assertEqual([row['id'] for row in self.history(user=self.bob)], [bob_record['id']])
        self.assertNotIn(bob_record['id'], [row['id'] for row in self.history()])
        self.assertTrue(self.status(user=self.bob, kind='terms', now=1400)['granted'])
        self.assertFalse(self.status(kind='terms', now=1400)['record']['id'] == bob_record['id'])

    def test_evidence_is_hashed_and_raw_evidence_is_not_stored(self):
        self.register('terms', '1.0.0', effective=1000)
        evidence = {'ip': '203.0.113.9', 'user_agent': 'Synthetic Consent Test/1.0', 'checkbox': True}
        record = self.grant(now=1100, evidence=evidence)
        canonical = json.dumps(evidence, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
        self.assertEqual(record['evidence_hash'], hashlib.sha256(canonical).hexdigest())
        with self.app.store.connect() as db:
            row = db.execute('SELECT * FROM user_consents WHERE id=?', (record['id'],)).fetchone()
            self.assertEqual(row['evidence_hash'], record['evidence_hash'])
            self.assertEqual(set(row.keys()), {'id', 'user_id', 'kind', 'version', 'status', 'method',
                                               'evidence_hash', 'created', 'updated'})
            dump = '\n'.join(db.iterdump())
        self.assertNotIn('203.0.113.9', dump)
        self.assertNotIn('Synthetic Consent Test/1.0', dump)
        self.assertEqual(self.grant(now=1200)['evidence_hash'], None)

    def test_invalid_kind_version_method_user_and_time_are_rejected(self):
        self.register('terms', '1.0.0', effective=1000)
        for kind in ('', 'Terms', 'other', None, True):
            with self.subTest(kind=kind):
                with self.assertRaises(ValueError):
                    self.register(kind, '1.0.0', 1000, 1000)
                with self.assertRaises(ValueError):
                    self.current(kind, 1000)
                with self.assertRaises(ValueError):
                    self.grant(kind=kind)
                with self.assertRaises(ValueError):
                    self.withdraw(kind=kind)
                with self.assertRaises(ValueError):
                    self.status(kind=kind)
                if kind is not None:
                    with self.assertRaises(ValueError):
                        self.history(kind=kind)
                with self.assertRaises(ValueError):
                    self.missing([kind])
        for version in ('', '..', '1.0.0/other', 'x' * 65, 1, None, True, '1.0.0\n'):
            with self.subTest(version=version):
                with self.assertRaises(ValueError):
                    self.register('terms', version, 1000, 1000)
                with self.assertRaises(ValueError):
                    self.grant(version=version)
                with self.assertRaises(ValueError):
                    self.withdraw(version=version)
        for method in ('', 'web app', 'x' * 33, None, 1):
            with self.subTest(method=method):
                with self.assertRaises(ValueError):
                    self.grant(method=method)
        for user in ('', None, 1, 'x' * 129):
            with self.subTest(user=user):
                with self.assertRaises(ValueError):
                    self.grant(user=user)
                with self.assertRaises(ValueError):
                    self.withdraw(user=user)
                with self.assertRaises(ValueError):
                    self.status(user=user)
                with self.assertRaises(ValueError):
                    self.history(user=user)
                with self.assertRaises(ValueError):
                    self.missing(['terms'], user=user)
        for now in (None, True, -1, '1000', 1.0):
            with self.subTest(now=now):
                with self.assertRaises(ValueError):
                    self.register('terms', '2.0.0', 1000, now)
                with self.assertRaises(ValueError):
                    self.grant(now=now)
                with self.assertRaises(ValueError):
                    self.withdraw(now=now)
                with self.assertRaises(ValueError):
                    self.missing(['terms'], now=now)
        for effective in (None, True, -1, '1000', 1.0):
            with self.subTest(effective=effective):
                with self.assertRaises(ValueError):
                    self.register('terms', '3.0.0', effective, 1000)
        with self.assertRaises(ValueError):
            self.grant(version='9.9.9')
        with self.assertRaises(ValueError):
            self.missing('terms')
        with self.assertRaises(ValueError):
            self.missing(['terms', 'not-a-kind'])
        with self.app.store.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM user_consents').fetchone()[0], 0)

    def test_oversize_and_non_json_evidence_are_rejected(self):
        self.register('terms', '1.0.0', effective=1000)
        for evidence in ({'note': 'x' * consents.MAX_EVIDENCE_BYTES},
                         {'value': float('nan')}, {'value': object()}, {'value': {1, 2}}):
            with self.subTest(evidence=type(evidence)):
                with self.assertRaises(ValueError):
                    self.grant(evidence=evidence)
        with self.app.store.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM user_consents').fetchone()[0], 0)


if __name__ == '__main__':
    unittest.main()
