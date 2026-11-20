"""Onboarding automation recommendations and creation (issue #148)."""
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.store import Store
from openteamily.onboarding import LOOK_OPTIONS
from tests.test_management import Client, ORIGIN


class OnboardingAutomationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.app = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                       clock=lambda: 1800000000)
        self.alice = Client(self.app)
        self.alice.register('alice')
        self.bob = Client(self.app, peer='127.0.0.2')
        self.bob.register('bob')

    def onboard(self, role='产品经理', industry='科技与软件'):
        return self.alice.call('POST', '/v1/onboarding',
                               {'industry': industry, 'role': role, 'completed': True})

    def test_recommendations_and_creation(self):
        generic = self.alice.call('GET', '/v1/onboarding/recommendations')
        self.assertEqual(generic['status'], 200)
        self.assertIn('daily_brief', [item['template_id'] for item in generic['body']['items']])
        self.assertEqual(self.onboard()['status'], 201)
        tailored = self.alice.call('GET', '/v1/onboarding/recommendations')
        ids = [item['template_id'] for item in tailored['body']['items']]
        self.assertIn('deck_report', ids)
        created = self.alice.call('POST', '/v1/onboarding/automations',
                                  {'template_ids': ['deck_report', 'task_breakdown']})
        self.assertEqual(created['status'], 201, created)
        self.assertEqual(created['body']['workspace']['name'], '个人空间')
        self.assertEqual(len(created['body']['created']), 2)
        wid = created['body']['workspace']['id']
        listed = self.alice.call('GET', f'/v1/workspaces/{wid}/automations')
        self.assertEqual(listed['status'], 200)
        templates = sorted(item['template_id'] for item in listed['body']['items'])
        self.assertEqual(templates, ['deck_report', 'task_breakdown'])
        self.assertTrue(all(item['enabled'] is False for item in listed['body']['items']))
        replay = self.alice.call('POST', '/v1/onboarding/automations',
                                 {'template_ids': ['deck_report', 'task_breakdown']})
        self.assertEqual(replay['status'], 200)
        self.assertEqual(replay['body']['created'], [])
        self.assertEqual(len(replay['body']['skipped']), 2)
        with self.app.store.connect() as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 1)

    def test_existing_owned_workspace_is_reused(self):
        self.onboard()
        wid = self.alice.workspace('我的空间', 'request_example_0001')['body']['workspace']['id']
        created = self.alice.call('POST', '/v1/onboarding/automations',
                                  {'template_ids': ['daily_brief']})
        self.assertEqual(created['status'], 201, created)
        self.assertEqual(created['body']['workspace']['id'], wid)
        listed = self.alice.call('GET', f'/v1/workspaces/{wid}/automations')
        self.assertEqual(len(listed['body']['items']), 1)

    def test_validation_csrf_and_capacity(self):
        for body in (
            {'template_ids': []},
            {'template_ids': ['custom']},
            {'template_ids': ['daily_brief', 'daily_brief']},
            {'template_ids': ['daily_brief'] * 7},
            {'template_ids': ['unknown']},
            {'template_ids': [['daily_brief']]},
            {'template_ids': [123]},
            {'template_ids': [None]},
        ):
            self.assertEqual(self.alice.call('POST', '/v1/onboarding/automations', body)['status'], 400, body)
        self.assertEqual(self.alice.call('POST', '/v1/onboarding/automations',
                                         {'template_ids': ['daily_brief']}, csrf=False)['status'], 403)
        limited = App(Store(Path(self.temp.name) / 'limited'), Config(
            ORIGIN, allow_registration=True, max_automations_per_workspace=1), clock=lambda: 1800000000)
        client = Client(limited)
        client.register('alice')
        self.assertEqual(client.call('POST', '/v1/onboarding/automations',
                                     {'template_ids': ['daily_brief', 'task_breakdown']})['status'], 429)

    def test_ordinary_onboarding_never_creates_automations(self):
        self.onboard()
        self.assertEqual(self.alice.call('POST', '/v1/onboarding/picks',
                                        {'picks': ['daily-brief']})['status'], 200)
        look = {key: values[0] for key, values in LOOK_OPTIONS.items()}
        self.assertEqual(self.alice.call('POST', '/v1/onboarding/look', {'look': look})['status'], 200)
        # Skipping work context and completing the flow only save onboarding state.
        self.alice.call('POST', '/v1/onboarding', {'industry': '', 'role': '', 'completed': True})
        self.alice.call('GET', '/v1/onboarding')
        with self.app.store.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM automations').fetchone()[0], 0)

    def test_creation_cannot_target_someone_elses_workspace(self):
        bobs = self.bob.workspace('Bob only', 'bob_workspace_0001')['body']['workspace']['id']
        created = self.alice.call('POST', '/v1/onboarding/automations',
                                  {'template_ids': ['daily_brief']})
        self.assertEqual(created['status'], 201, created)
        self.assertNotEqual(created['body']['workspace']['id'], bobs)
        self.assertEqual(self.bob.call('GET', f'/v1/workspaces/{bobs}/automations')['body']['items'], [])
        self.assertEqual(Client(self.app).call('POST', '/v1/onboarding/automations',
                                             {'template_ids': ['daily_brief']})['status'], 401)

    def test_retry_at_capacity_does_not_duplicate_or_fail(self):
        limited = App(Store(Path(self.temp.name) / 'one'), Config(
            ORIGIN, allow_registration=True, max_automations_per_workspace=1), clock=lambda: 1800000000)
        client = Client(limited)
        client.register('alice')
        body = {'template_ids': ['daily_brief']}
        first = client.call('POST', '/v1/onboarding/automations', body)
        self.assertEqual(first['status'], 201, first)
        replay = client.call('POST', '/v1/onboarding/automations', body)
        self.assertEqual(replay['status'], 200, replay)
        self.assertEqual(replay['body']['created'], [])
        self.assertEqual(len(replay['body']['skipped']), 1)
        self.assertEqual(client.call('POST', '/v1/onboarding/automations',
                                   {'template_ids': ['task_breakdown']})['status'], 429)


if __name__ == '__main__':
    unittest.main()
