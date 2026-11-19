"""Runtimes / connection page serving tests. In-process WSGI only; not browser E2E."""
from pathlib import Path
import re
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.settings_page import SettingsPage
from openteamily.store import Store
from tests.test_management import Client, ORIGIN
from tests.test_settings_page import RawClient


class RuntimesPageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        api = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                  clock=lambda: 1800000000)
        self.app = SettingsPage(api)
        self.raw = RawClient(self.app)
        self.client = Client(self.app)
        self.client.register('alice')

    def test_page_and_install_helpers_are_served_with_strict_headers(self):
        page = self.raw.call('GET', '/runtimes')
        self.assertEqual(page['status'], 200)
        html = page['body'].decode()
        self.assertIn('连接', html)
        self.assertIn('托管云端 Agent', html)
        self.assertIn('托管电脑', html)
        self.assertIn('自托管 FlyBot', html)
        self.assertIn('已检测到的运行时', html)
        self.assertIn('id="runtime-back"', html)
        self.assertIn('href="/settings"', html)
        self.assertIn('id="detected-empty"', html)
        self.assertIn('还没有向本管理面登记过的 FlyBot 运行时', html)
        self.assertIn('runtime-badge', html)
        css = self.raw.call('GET', '/runtimes/app.css')['body'].decode()
        self.assertIn('margin-inline: auto', css)
        self.assertIn('.copy-row', css)
        self.assertIn('id="detect-runtimes"', html)
        self.assertIn('id="detected-list"', html)
        self.assertIn('id="open-connect"', html)
        self.assertIn('连接远程机器', html)
        self.assertIn('尚未配置', html)
        self.assertIn('未提供', html)
        self.assertIn('disabled', html)
        self.assertIn('不会扫描本机进程或局域网', html)
        self.assertNotIn('Teamily Desktop', html)
        self.assertNotIn('Teamily Computer', html)
        self.assertIn('连接一台机器', html)
        self.assertIn('生成 API key', html)
        self.assertIn('No API keys yet', html)
        self.assertIn('请先生成上方的 API key，再显示连接脚本。', html)
        self.assertIn('macOS / Linux', html)
        self.assertIn('Windows', html)
        self.assertIn('id="generate-key"', html)
        self.assertIn('id="daemon-pending"', html)
        self.assertIn('id="device-id"', html)
        self.assertIn('例如 macbook-pro', html)
        self.assertIn('name="name"', html)
        self.assertIn('name="expires"', html)
        self.assertIn('value="never"', html)
        self.assertIn('>Never<', html)
        self.assertIn('/v1/runtime-keys', html)
        self.assertIn('不要把安装脚本管道给 shell', html)
        self.assertIn('python3 flybot.pyz daemon start', html)
        self.assertIn('/install/flybot.pyz', html)
        self.assertIn('id="copy-install"', html)
        self.assertIn('id="copy-install-feedback"', html)
        # Anchor the live-region attributes to the feedback span itself: the page-level
        # #status also carries role="status", so a bare assertIn would pass even if the
        # span lost its own semantics.
        feedback_tag = re.search(r'<span[^>]*id="copy-install-feedback"[^>]*>', html)
        self.assertIsNotNone(feedback_tag, 'the copy feedback span is served')
        self.assertIn('role="status"', feedback_tag.group(0))
        self.assertIn('aria-live="polite"', feedback_tag.group(0))
        self.assertNotIn('curl -fsSL', html)
        self.assertNotIn('install.ps1', html.lower())
        self.assertNotIn('teamily-releases', html.lower())
        self.assertIn('/v1/runtime/tasks', html)
        self.assertNotIn('teamily.com', html.lower())
        self.assertIn('default-src \'none\'', page['headers']['Content-Security-Policy'])
        script_app = self.raw.call('GET', '/runtimes/app.mjs')
        self.assertEqual(script_app['status'], 200)
        self.assertIn(b'/v1/runtime/connections', script_app['body'])
        self.assertIn(b'export function summarizeConnections', script_app['body'])
        self.assertIn(b'detect-runtimes', script_app['body'])
        self.assertNotIn(b'innerHTML', script_app['body'])
        self.assertEqual(self.raw.call('GET', '/runtimes/app.css')['status'], 200)
        bundle = self.raw.call('GET', '/install/flybot.pyz')
        self.assertEqual(bundle['status'], 200)
        self.assertTrue(bundle['body'].startswith(b'#!/usr/bin/env python3\nPK'))
        self.assertNotIn(b'teamily.com', bundle['body'].lower())
        script = self.raw.call('GET', '/install/flybot.sh')
        self.assertEqual(script['status'], 200)
        text = script['body'].decode()
        self.assertIn('flybot.pyz', text)
        self.assertIn('Do not pipe this script into a shell', text)
        self.assertIn('flybot.pyz', text)
        self.assertNotIn('teamily.com', text.lower())
        self.assertIn('exit 1', text)
        windows = self.raw.call('GET', '/install/flybot.ps1')
        self.assertEqual(windows['status'], 200)
        self.assertNotIn(b'teamily.com', windows['body'].lower())
        self.assertEqual(self.raw.call('GET', '/runtimes/missing')['status'], 404)

    def test_page_rejects_cross_origin_queries_and_writes(self):
        self.assertEqual(self.raw.call('GET', '/runtimes', origin='https://evil.test')['status'], 403)
        self.assertEqual(self.raw.call('GET', '/runtimes', query='x=1')['status'], 400)
        self.assertEqual(self.raw.call('POST', '/runtimes')['status'], 405)
        self.assertEqual(self.raw.call('GET', '/install/flybot.sh', origin='https://evil.test')['status'], 403)

    def test_wrapper_still_exposes_runtime_keys(self):
        created = self.client.call('POST', '/v1/runtime-keys', {'name': 'desk'})
        self.assertEqual(created['status'], 201, created)
        self.assertIn('token', created['body'])
        listed = self.client.call('GET', '/v1/runtime-keys')
        self.assertEqual(listed['status'], 200)
        self.assertNotIn('token', listed['body']['items'][0])


if __name__ == '__main__':
    unittest.main()
