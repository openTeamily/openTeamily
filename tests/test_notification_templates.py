"""Localized notification template catalog and renderer tests.

These tests exercise only in-process SQLite storage and rendering. They never
send a notification or contact a translation service.
"""
from pathlib import Path
import tempfile
import unittest

from openteamily import notification_templates as templates
from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN

NOW = 1800000000


class NotificationTemplateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name).resolve() / 'state'
        self.app = App(Store(self.path), Config(ORIGIN, allow_registration=True),
                       clock=lambda: NOW)
        self.client = Client(self.app)
        self.assertEqual(self.client.register('alice')['status'], 201)
        with self.app.store.connect() as db:
            templates.ensure_schema(db)

    def register(self, kind='welcome', locale='en', version=1,
                 subject='Hello {name}', body='Welcome, {name}!',
                 variables=('name',), now=NOW, enabled=True):
        with self.app.store.connect() as db:
            return templates.register_template(
                db, kind, locale, version, subject, body, now,
                variables=variables, enabled=enabled)

    def get(self, kind='welcome', locale='en', version=None):
        with self.app.store.connect() as db:
            return templates.get_template(db, kind, locale, version)

    def listed(self, kind=None, locale=None):
        with self.app.store.connect() as db:
            return templates.list_templates(db, kind, locale)

    def disable(self, kind='welcome', locale='en', version=None):
        with self.app.store.connect() as db:
            return templates.disable_template(db, kind, locale, version)

    def render(self, kind='welcome', locale='en', values=None,
               fallback_locale='en'):
        with self.app.store.connect() as db:
            return templates.render(db, kind, locale, values or {},
                                    fallback_locale=fallback_locale)

    def test_schema_is_idempotent_and_has_expected_shape(self):
        with self.app.store.connect() as db:
            templates.ensure_schema(db)
            templates.ensure_schema(db)
            table = db.execute(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='notification_templates'"
            ).fetchone()
            columns = {row['name']: row for row in db.execute(
                'PRAGMA table_info(notification_templates)')}
            indexes = {row['name'] for row in db.execute(
                "SELECT name FROM sqlite_master WHERE type='index' "
                "AND tbl_name='notification_templates'")}
        self.assertIsNotNone(table)
        self.assertEqual(set(columns), {
            'id', 'kind', 'locale', 'version', 'subject', 'body',
            'variables', 'enabled', 'created'})
        self.assertIn('UNIQUE(kind,locale,version)', table['sql'].replace(' ', ''))
        self.assertTrue(any('lookup' in name for name in indexes), indexes)
        self.assertEqual(columns['enabled']['dflt_value'], '1')

    def test_register_get_latest_and_explicit_version(self):
        first = self.register(version=1, subject='One {name}')
        second = self.register(version=2, subject='Two {name}', body='Second {name}')
        self.assertEqual(first['version'], 1)
        self.assertEqual(second['version'], 2)
        self.assertEqual(self.get()['version'], 2)
        self.assertEqual(self.get(version=1)['subject'], 'One {name}')
        self.assertEqual(self.get(version=99), None)
        self.assertEqual(self.get(locale='fr'), None)

    def test_duplicate_registration_is_idempotent_only_for_identical_content(self):
        first = self.register()
        again = self.register()
        self.assertEqual(again['id'], first['id'])
        with self.app.store.connect() as db:
            self.assertEqual(db.execute(
                'SELECT COUNT(*) FROM notification_templates').fetchone()[0], 1)
        with self.assertRaises(ValueError):
            self.register(subject='Changed {name}')
        with self.assertRaises(ValueError):
            self.register(enabled=False)
        self.assertEqual(self.get()['subject'], 'Hello {name}')

    def test_disable_one_version_or_the_latest(self):
        self.register(version=1)
        second = self.register(version=2)
        self.assertTrue(self.disable(version=1))
        self.assertFalse(self.disable(version=1))
        self.assertFalse(self.get(version=1)['enabled'])
        self.assertEqual(self.get()['version'], second['version'])
        self.assertTrue(self.disable())
        self.assertFalse(self.get(version=2)['enabled'])
        self.assertIsNone(self.get())
        self.assertFalse(self.disable())

    def test_list_filters_by_kind_and_locale_in_version_order(self):
        self.register(kind='welcome', locale='en', version=1, subject='W1 {name}')
        self.register(kind='welcome', locale='en', version=2, subject='W2 {name}')
        self.register(kind='welcome', locale='fr', version=1, subject='Bienvenue {name}')
        self.register(kind='reminder', locale='en', version=1, subject='Reminder {name}')
        self.disable(kind='reminder', locale='en', version=1)
        everything = self.listed()
        self.assertEqual(len(everything), 4)
        self.assertEqual([item['version'] for item in self.listed(kind='welcome', locale='en')],
                         [2, 1])
        self.assertEqual({item['locale'] for item in self.listed(kind='welcome')},
                         {'en', 'fr'})
        self.assertEqual([item['kind'] for item in self.listed(locale='en')],
                         ['reminder', 'welcome', 'welcome'])
        self.assertFalse(self.listed(kind='reminder')[0]['enabled'])
        self.assertEqual(self.listed(kind='missing'), [])

    def test_render_substitutes_plain_text_without_recursive_expansion(self):
        self.register(subject='Hi {name}', body='{name}: {message}',
                      variables=('name', 'message'))
        result = self.render(values={'name': '<b>Alice</b>', 'message': 'Use {name} literally'})
        self.assertEqual(result, {
            'subject': 'Hi <b>Alice</b>',
            'body': '<b>Alice</b>: Use {name} literally',
            'locale': 'en',
            'missing': [],
        })

    def test_html_is_stored_and_rendered_literally(self):
        self.register(subject='<b>{name}</b>', body='<script>{name}</script>')
        result = self.render(values={'name': '<i>Alice</i>'})
        self.assertEqual(result['subject'], '<b><i>Alice</i></b>')
        self.assertEqual(result['body'], '<script><i>Alice</i></script>')

    def test_missing_required_variables_are_reported_and_left_as_placeholders(self):
        self.register(subject='Hi {name}', body='{name} has {count} items',
                      variables=('name', 'count'))
        result = self.render(values={'name': 'Alice'})
        self.assertEqual(result['missing'], ['count'])
        self.assertEqual(result['body'], 'Alice has {count} items')
        result = self.render(values={'name': 'Alice', 'count': None})
        self.assertEqual(result['missing'], ['count'])

    def test_render_uses_fallback_locale_and_reports_the_locale_used(self):
        self.register(locale='en', subject='English {name}')
        self.register(locale='fr', subject='Francais {name}')
        self.assertEqual(self.render(locale='fr', values={'name': 'A'})['locale'], 'fr')
        result = self.render(locale='de', values={'name': 'A'}, fallback_locale='en')
        self.assertEqual(result['locale'], 'en')
        self.assertEqual(result['subject'], 'English A')
        with self.app.store.connect() as db:
            templates.disable_template(db, 'welcome', 'fr')
        fallback = self.render(locale='fr', values={'name': 'A'}, fallback_locale='en')
        self.assertEqual((fallback['locale'], fallback['subject']), ('en', 'English A'))
        with self.assertRaises(LookupError):
            self.render(locale='ja', values={'name': 'A'}, fallback_locale='de')

    def test_locale_isolation_keeps_same_kind_separate(self):
        self.register(locale='en', subject='English {name}', body='English body')
        self.register(locale='zh-CN', subject='Chinese {name}', body='Chinese body')
        self.assertEqual(self.get(locale='en')['body'], 'English body')
        self.assertEqual(self.get(locale='zh-CN')['body'], 'Chinese body')
        self.assertEqual(self.render(locale='zh-CN', values={'name': 'A'})['body'],
                         'Chinese body')
        self.assertIsNone(self.get(locale='ja'))

    def test_malformed_placeholders_and_invalid_inputs_are_rejected(self):
        for subject, body in (('Hi {name', 'body'), ('Hi name}', 'body'),
                              ('Hi {}', 'body'), ('Hi {bad-name}', 'body'),
                              ('Hi {Name}', 'body')):
            with self.assertRaises(ValueError, msg=(subject, body)):
                self.register(subject=subject, body=body)
        with self.assertRaises(ValueError):
            self.register(subject='Hi {name}', body='Hello', variables=())
        with self.assertRaises(ValueError):
            self.register(variables=('bad name',))
        with self.assertRaises(ValueError):
            self.register(kind='Bad Kind')
        with self.assertRaises(ValueError):
            self.register(locale='not_a_locale')
        with self.assertRaises(ValueError):
            self.register(version=0)
        with self.assertRaises(ValueError):
            self.register(version=True)
        with self.assertRaises(ValueError):
            self.register(subject='x' * (templates.MAX_SUBJECT + 1))
        with self.assertRaises(ValueError):
            self.register(body='x' * (templates.MAX_BODY + 1))
        with self.assertRaises(ValueError):
            self.register(variables=tuple('v%d' % i for i in range(templates.MAX_VARIABLES + 1)),
                          subject=' '.join('{%s}' % ('v%d' % i)
                                           for i in range(templates.MAX_VARIABLES + 1)))

    def test_render_rejects_oversize_and_non_scalar_values(self):
        self.register()
        with self.assertRaises(ValueError):
            self.render(values={'name': 'x' * (templates.MAX_VALUE + 1)})
        with self.assertRaises(ValueError):
            self.render(values={'name': ['Alice']})
        with self.assertRaises(ValueError):
            self.render(values={1: 'Alice'})

    def test_parameterized_lookup_treats_quotes_as_data(self):
        self.register(kind='welcome', locale='en', subject="O'Reilly {name}")
        with self.app.store.connect() as db:
            self.assertEqual(db.execute(
                'SELECT subject FROM notification_templates WHERE kind=?',
                ("welcome' OR 1=1 --",)).fetchone(), None)
        self.assertEqual(self.get()['subject'], "O'Reilly {name}")


if __name__ == '__main__':
    unittest.main()
