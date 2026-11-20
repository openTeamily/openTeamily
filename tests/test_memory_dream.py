"""The memory page's 做梦 proposes one real consolidation and never changes data on ignore."""
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.settings_page import SettingsPage
from openteamily.store import Store
from tests.test_management import Client, ORIGIN

BODY = '第一条正文。\n\n这一条重复了。\n\n这一条重复了。\n\n最后一条正文。'
CLEAN = '只有一段正文，没有重复。'


class MemoryDreamTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        api = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                  clock=lambda: 1800000000)
        self.app = SettingsPage(api)
        self.client = Client(self.app)
        self.client.register('alice')
        workspace = self.client.call('POST', '/v1/workspaces', {'name': 'Dream'},
                                     {'HTTP_IDEMPOTENCY_KEY': 'memory-dream-space-0001'})
        self.wid = workspace['body']['workspace']['id']
        created = self.client.call('POST', f'/v1/workspaces/{self.wid}/memory',
                                   {'title': 'Brief', 'body': BODY},
                                   {'HTTP_IDEMPOTENCY_KEY': 'memory-dream-page-0001'})
        self.pid = created['body']['page']['id']

    def page(self):
        seen = self.client.call('GET', f'/v1/workspaces/{self.wid}/memory/{self.pid}')
        return seen['body']['page']

    def dream(self):
        return self.client.call('POST', f'/v1/workspaces/{self.wid}/memory/{self.pid}/dream')

    def decide(self, sid, action):
        return self.client.call('POST', f'/v1/workspaces/{self.wid}/memory/{self.pid}/dream/{sid}',
                                {'action': action})

    def test_dream_proposes_merging_the_duplicate_paragraph(self):
        dreamed = self.dream()
        self.assertEqual(dreamed['status'], 200, dreamed)
        suggestion = dreamed['body']['suggestion']
        self.assertEqual(suggestion['kind'], 'merge_paragraphs')
        self.assertIn('重复', suggestion['summary'])
        self.assertEqual(suggestion['status'], 'open')

    def test_accept_merges_the_two_paragraphs_and_keeps_a_history_row(self):
        suggestion = self.dream()['body']['suggestion']
        accepted = self.decide(suggestion['id'], 'accept')
        self.assertEqual(accepted['status'], 200, accepted)
        self.assertEqual(accepted['body']['suggestion']['status'], 'accepted')
        self.assertEqual(accepted['body']['page']['body'], '第一条正文。\n\n这一条重复了。\n\n最后一条正文。')
        self.assertEqual(accepted['body']['page']['revision'], 2)
        self.assertEqual(accepted['body']['applied']['removed'], '这一条重复了。')
        again = self.page()
        self.assertEqual(again['body'], accepted['body']['page']['body'])

    def test_ignore_leaves_the_page_untouched(self):
        suggestion = self.dream()['body']['suggestion']
        ignored = self.decide(suggestion['id'], 'ignore')
        self.assertEqual(ignored['status'], 200, ignored)
        self.assertEqual(ignored['body']['suggestion']['status'], 'ignored')
        self.assertEqual(ignored['body']['page']['body'], BODY)
        self.assertEqual(self.page()['revision'], 1)

    def test_a_page_without_repeats_says_so_instead_of_inventing_work(self):
        updated = self.client.call('POST', f'/v1/workspaces/{self.wid}/memory/{self.pid}',
                                   {'revision': 1, 'changes': {'body': CLEAN}})
        self.assertEqual(updated['status'], 200, updated)
        dreamed = self.dream()
        self.assertEqual(dreamed['status'], 200, dreamed)
        self.assertIsNone(dreamed['body']['suggestion'])
        self.assertIn('没有', dreamed['body']['message'])

    def test_a_stranger_cannot_consolidate_the_page(self):
        other = Client(self.app)
        other.register('bob')
        self.assertEqual(other.call('POST', f'/v1/workspaces/{self.wid}/memory/{self.pid}/dream')['status'], 404)
