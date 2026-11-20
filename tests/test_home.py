"""Signed-in home page and workspace overview. In-process WSGI only."""
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.settings_page import SettingsPage
from openteamily.store import Store
from tests.test_management import Client, ORIGIN
from tests.test_settings_page import RawClient


class HomePageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        api = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                  clock=lambda: 1800000000)
        self.api = api
        self.app = SettingsPage(api)
        self.raw = RawClient(self.app)
        self.client = Client(self.app)
        self.client.register('alice')
        self.wid = self.client.workspace()['body']['workspace']['id']

    def test_home_page_and_assets_are_served_with_strict_headers(self):
        page = self.raw.call('GET', '/')
        self.assertEqual(page['status'], 200)
        html = page['body'].decode()
        for ident in ('login-panel', 'main-panel', 'home-workspace', 'home-personal',
                      'home-actions', 'home-stats', 'home-conversations', 'home-artifacts',
                      'home-meetings'):
            self.assertIn('id="%s"' % ident, html)
        self.assertIn('欢迎回来', html)
        self.assertIn('最近对话', html)
        self.assertIn('href="/home/app.css"', html)
        self.assertIn('href="/look/app.css"', html)
        self.assertIn('default-src \'none\'', page['headers']['Content-Security-Policy'])
        self.assertEqual(page['headers']['Cache-Control'], 'no-store')
        self.assertEqual(self.raw.call('GET', '/home')['status'], 200)
        script = self.raw.call('GET', '/home/app.mjs')
        self.assertEqual(script['status'], 200)
        self.assertIn('spaceHref', script['body'].decode())
        self.assertEqual(self.raw.call('GET', '/home/app.css')['status'], 200)
        self.assertEqual(self.raw.call('GET', '/', origin='https://evil.test')['status'], 403)
        self.assertEqual(self.raw.call('GET', '/', query='x=1')['status'], 400)
        self.assertEqual(self.raw.call('POST', '/')['status'], 405)
        self.assertEqual(self.raw.call('GET', '/home/missing')['status'], 404)

    def test_overview_requires_membership_and_returns_real_summaries(self):
        agent = self.client.call(
            'POST', f'/v1/workspaces/{self.wid}/agents',
            {'name': '值班助手', 'summary': '简短回答'}, {'HTTP_IDEMPOTENCY_KEY': 'home-agent-000001'})
        self.assertEqual(agent['status'], 201, agent)
        aid = agent['body']['agent']['id']
        conv = self.client.call(
            'POST', f'/v1/workspaces/{self.wid}/agents/{aid}/conversations',
            {'title': '首页晨会'}, {'HTTP_IDEMPOTENCY_KEY': 'home-conv-000001'})
        self.assertEqual(conv['status'], 201, conv)
        artifact = self.client.call(
            'POST', f'/v1/workspaces/{self.wid}/artifacts',
            {'title': '首页文档', 'body': '不要出现在摘要里的正文'},
            {'HTTP_IDEMPOTENCY_KEY': 'home-artifact-000001'})
        self.assertEqual(artifact['status'], 201, artifact)
        meeting = self.client.call(
            'POST', f'/v1/workspaces/{self.wid}/meetings',
            {'title': '首页会议', 'transcript': '不要出现在摘要里的转写'},
            {'HTTP_IDEMPOTENCY_KEY': 'home-meeting-000001'})
        self.assertEqual(meeting['status'], 201, meeting)

        overview = self.client.call('GET', f'/v1/workspaces/{self.wid}/overview?limit=5')
        self.assertEqual(overview['status'], 200, overview)
        body = overview['body']
        self.assertEqual(body['workspace']['id'], self.wid)
        self.assertEqual(body['counts']['agents'], 1)
        self.assertEqual(body['counts']['artifacts'], 1)
        self.assertEqual(body['counts']['meetings'], 1)
        self.assertEqual(body['counts']['automations'], 0)
        self.assertEqual(body['unread_notifications'], 0)
        conversation = body['recent_conversations'][0]
        self.assertEqual((conversation['source'], conversation['title']), ('agent', '首页晨会'))
        self.assertEqual(conversation['agent_name'], '值班助手')
        self.assertNotIn('items', conversation)
        item = body['recent_artifacts'][0]
        self.assertEqual(item['title'], '首页文档')
        self.assertNotIn('body', item)
        meeting_item = body['recent_meetings'][0]
        self.assertEqual(meeting_item['title'], '首页会议')
        self.assertNotIn('transcript', meeting_item)
        self.assertNotIn('summary', meeting_item)
        self.assertNotIn('action_items', meeting_item)

        self.assertEqual(self.client.call('GET', f'/v1/workspaces/{self.wid}/overview?limit=11')['status'], 400)
        self.assertEqual(self.client.call('GET', f'/v1/workspaces/{self.wid}/overview?x=1')['status'], 400)
        self.assertEqual(self.client.call('POST', f'/v1/workspaces/{self.wid}/overview')['status'], 405)
        bob = Client(self.app, peer='127.0.0.2')
        bob.register('bob')
        self.assertEqual(bob.call('GET', f'/v1/workspaces/{self.wid}/overview')['status'], 404)


if __name__ == '__main__':
    unittest.main()
