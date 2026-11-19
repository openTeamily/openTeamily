"""Onboarding steps 2-4 (issue #130): functional flow, not compared with Teamily. In-process only."""
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN

LOOK = {'color': '天空蓝', 'expression': '微笑', 'headwear': '耳机', 'glasses': '无', 'hand': '咖啡杯'}


class OnboardingStepTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.app = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                       clock=lambda: 1800000000)
        self.alice, self.bob = Client(self.app), Client(self.app, peer='127.0.0.2')
        self.alice.register('alice')
        self.bob.register('bob')

    def steps(self, client=None):
        return (client or self.alice).call('GET', '/v1/onboarding')['body']['steps']

    def test_apps_are_honestly_unconnected_and_recommendations_follow_industry(self):
        steps = self.steps()
        self.assertEqual(len(steps['apps']), 8)
        self.assertFalse(any(app['connected'] for app in steps['apps']))
        self.assertFalse(steps['compared'])
        self.assertEqual((steps['picks'], steps['look']), ([], None))
        generic = [item['key'] for item in steps['recommendations']]
        self.alice.call('POST', '/v1/onboarding', {'industry': '科技与软件', 'role': '产品经理', 'completed': True})
        tech = [item['key'] for item in self.steps()['recommendations']]
        self.assertEqual(tech[:2], ['release-notes', 'issue-triage'])
        self.assertEqual(tech[2:], generic)

    def test_picks_and_look_persist_per_user(self):
        saved = self.alice.call('POST', '/v1/onboarding/picks', {'picks': ['daily-brief', 'release-notes']})
        self.assertEqual((saved['status'], saved['body']['steps']['picks']), (200, ['daily-brief', 'release-notes']))
        looked = self.alice.call('POST', '/v1/onboarding/look', {'look': LOOK})
        self.assertEqual(looked['body']['steps']['look'], LOOK)
        self.assertEqual(looked['body']['steps']['picks'], ['daily-brief', 'release-notes'])
        self.assertEqual(self.steps()['look'], LOOK)
        self.assertEqual(self.steps(self.bob)['picks'], [])
        for bad in ({'picks': ['nope']}, {'picks': ['daily-brief', 'daily-brief']}, {'picks': 'daily-brief'},
                    {'picks': ['daily-brief'] * 7}):
            self.assertEqual(self.alice.call('POST', '/v1/onboarding/picks', bad)['status'], 400, bad)
        for bad in ({**LOOK, 'color': '金色'}, {k: v for k, v in LOOK.items() if k != 'hand'}, {**LOOK, 'x': '无'}):
            self.assertEqual(self.alice.call('POST', '/v1/onboarding/look', {'look': bad})['status'], 400, bad)
        self.assertEqual(self.alice.call('POST', '/v1/onboarding/look', {'look': LOOK, 'x': 1})['status'], 400)
        self.assertEqual(self.alice.call('GET', '/v1/onboarding/look')['status'], 405)
        self.assertEqual(self.alice.call('POST', '/v1/onboarding/picks', {'picks': []})['body']['steps']['look'], LOOK)
        anon = Client(self.app, peer='127.0.0.9')
        self.assertEqual(anon.call('POST', '/v1/onboarding/picks', {'picks': []})['status'], 401)


if __name__ == '__main__':
    unittest.main()
