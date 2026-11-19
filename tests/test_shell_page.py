"""Shared management shell serving tests. In-process WSGI only; not browser E2E."""
import unittest

from tests import test_settings_page as settings_page_tests


PAGES = (
    '/settings', '/agents', '/chat', '/automations', '/artifacts', '/space',
    '/members', '/team', '/runtimes', '/memory', '/discover',
    '/profile', '/onboarding', '/meetings', '/download', '/guide',
)

CAPTURE_IDS = {
    '/settings': ('login-panel', 'username', 'password', 'settings-panel',
                  'whoami', 'model-key-state', 'model-api-form', 'settings-index'),
    '/agents': ('main-panel', 'agent-list', 'edit-form', 'chat-panel',
                'conversation-list', 'message-list', 'chat-form',
                'homepage-panel', 'publish-homepage', 'revoke-homepage',
                'manage-drawer', 'open-create'),
    '/discover': ('main-panel', 'feed-panel', 'feed-note', 'discover-list',
                  'discover-empty', 'manage-list', 'manage-empty', 'workspace'),
    '/chat': ('main-panel', 'session-pane', 'conversation-list',
              'chat-form', 'chat-body', 'message-list', 'chat-title'),
    '/automations': ('automation-list', 'editor-form', 'run-panel',
                     'run-list', 'run-empty'),
    '/artifacts': ('artifact-list', 'editor-form', 'media-image',
                   'board-canvas', 'website-preview', 'new-menu',
                   'new-artifact', 'list-empty', 'filter-panel',
                   'empty-starred', 'empty-memory', 'empty-meetings',
                   'meetings-chrome'),
    '/space': ('artifact-list', 'editor-form', 'media-image',
               'board-canvas', 'website-preview', 'new-menu',
               'new-artifact', 'list-empty', 'filter-panel',
               'empty-starred', 'empty-memory', 'empty-meetings',
               'meetings-chrome'),
    '/members': ('member-list', 'invite-list'),
    '/team': ('wizard-form', 'step-1', 'step-2', 'step-3', 'next', 'back',
               'submit', 'invite-skip'),
    '/runtimes': ('runtimes-panel', 'connect-panel', 'key-list',
                  'connection-list', 'issued-token', 'detect-runtimes',
                  'detected-list', 'hosted-agent-section',
                  'hosted-computer-section', 'local-runtime-section',
                  'generate-key', 'keys-empty', 'daemon-pending',
                  'daemon-command', 'device-id', 'install-unix',
                  'install-windows'),
    '/memory': ('main-panel', 'memory-list', 'editor-form',
                'search', 'new-page', 'graph-canvas', 'topic-list',
                'overview-panel', 'actions-panel', 'action-list',
                'profile-panel', 'dream-profile', 'dream-actions'),
    '/profile': ('main-panel', 'whoami', 'profile-username', 'profile-form',
                 'profile-name', 'profile-handle', 'profile-bio', 'profile-save'),

    '/onboarding': ('main-panel', 'onboarding-form', 'industry', 'role-choices',
                    'onboarding-save', 'onboarding-skip'),
    '/meetings': ('main-panel', 'meeting-list', 'meeting-form', 'meeting-title',
                  'meeting-started-at', 'action-list', 'save-meeting'),
    '/download': ('main-panel', 'download-web', 'download-runtime',
                  'download-unavailable', 'daemon-command'),
    '/guide': ('main-panel', 'whoami', 'guide-search', 'guide-categories',
               'guide-list', 'guide-count', 'guide-empty', 'guide-dialog',
               'guide-dialog-title', 'guide-dialog-body', 'guide-dialog-path',
               'view-list', 'view-graph'),
}


class ShellPageTests(unittest.TestCase):
    def setUp(self):
        settings_page_tests.SettingsPageTests.setUp(self)
    def test_shell_assets_are_served_with_strict_headers(self):
        css = self.raw.call('GET', '/shell/app.css')
        script = self.raw.call('GET', '/shell/app.mjs')
        self.assertEqual(css['status'], 200, css)
        self.assertEqual(script['status'], 200, script)
        self.assertIn('text/css', css['headers']['Content-Type'])
        self.assertIn('javascript', script['headers']['Content-Type'])
        for response in (css, script):
            self.assertIn("default-src 'none'", response['headers']['Content-Security-Policy'])
            self.assertEqual(response['headers']['Cache-Control'], 'no-store')
            self.assertEqual(response['headers']['X-Content-Type-Options'], 'nosniff')
            self.assertLessEqual(len(response['body']), 262144)
        self.assertIn(b'--ot-measure', css['body'])
        self.assertIn(b'[hidden]', css['body'])
        self.assertIn(b'display: none !important', css['body'])
        self.assertIn(b'.skip-link', css['body'])
        self.assertIn(b'body.app-workspace > .app-rail > a', css['body'])
        self.assertIn(b'font-size: 0.75rem', css['body'])
        self.assertNotIn(b'font-size: 0.62rem', css['body'])
        self.assertNotIn(b'teamily.com', css['body'].lower())
        self.assertNotIn(b'teamily.com', script['body'].lower())
        self.assertIn(b'export function resolveTheme', script['body'])
        self.assertIn(b'export function startShell', script['body'])
        self.assertIn(b'export function accountNameFromLabel', script['body'])
        self.assertIn(b'export function ensureOnboardingMenuItem', script['body'])
        self.assertIn(b'export function ensureChannelsAndConnectorsMenuItems', script['body'])
        self.assertIn('工作背景'.encode(), script['body'])
        self.assertIn(b'/onboarding', script['body'])
        self.assertIn('Agent 渠道'.encode(), script['body'])
        self.assertIn(b'/settings/channels', script['body'])
        self.assertIn('应用连接器'.encode(), script['body'])
        self.assertIn(b'/settings/connectors', script['body'])
        self.assertIn('已登录为'.encode(), script['body'])
        head = self.raw.call('HEAD', '/shell/app.css')
        self.assertEqual(head['status'], 200)
        self.assertEqual(head['body'], b'')
        self.assertEqual(self.raw.call('GET', '/shell/missing')['status'], 404)
        self.assertEqual(self.raw.call('GET', '/shell/../settings_page.py')['status'], 404)
        self.assertEqual(self.raw.call('GET', '/shell/app.css', origin='https://evil.test')['status'], 403)
        self.assertEqual(self.raw.call('POST', '/shell/app.css')['status'], 405)

    def test_management_pages_share_the_shell_and_keep_functional_ids(self):
        for path in PAGES:
            page = self.raw.call('GET', path)
            self.assertEqual(page['status'], 200, path)
            html = page['body'].decode()
            self.assertIn('href="/shell/app.css"', html, path)
            self.assertIn('src="/shell/app.mjs"', html, path)
            self.assertIn('class="skip-link"', html, path)
            self.assertIn('href="#main"', html, path)
            self.assertIn('id="main"', html, path)
            self.assertIn('OpenTeamily', html, path)
            self.assertIn('class="brand-mark"', html, path)
            self.assertIn('brand-glyph', html, path)
            self.assertNotIn('>FB</a>', html, path)
            self.assertTrue(
                'aria-label="管理导航"' in html or 'aria-label="应用导航"' in html, path)
            self.assertIn('<nav', html, path)
            self.assertIn('id="status"', html, path)
            self.assertNotIn('teamily.com', html.lower(), path)
            for ident in CAPTURE_IDS[path]:
                self.assertIn(f'id="{ident}"', html, f'{path} missing {ident}')
            self.assertIn('aria-label="应用导航"', html, path)
            self.assertIn('id="account-menu"', html, path)
            self.assertIn('id="account-menu-button"', html, path)
            self.assertIn('id="logout-form"', html, path)
            self.assertIn('所有设置', html, path)
            self.assertIn('href="/settings"', html, path)
            self.assertNotIn('积分中心', html, path)
            self.assertNotIn('套餐与账单', html, path)
            self.assertNotIn('contact@teamily.ai', html.lower(), path)
            self.assertIn('id="help-menu"', html, path)
            self.assertIn('查看我的资料', html, path)
            if path == '/onboarding':
                self.assertIn('href="/onboarding"', html, path)
                self.assertIn('工作背景', html, path)
            self.assertNotIn('>新手引导</a>', html, path)
            self.assertIn('href="/download"', html, path)
            self.assertIn('id="appearance-toggle"', html, path)
            self.assertIn('href="/discover"', html, path)
            self.assertNotIn('未实现：发现动态', html, path)
            self.assertIn("default-src 'none'", page['headers']['Content-Security-Policy'])
            if path == '/runtimes':
                self.assertIn('data-tab="connect"', html)
                self.assertIn('已检测到的运行时', html)
                self.assertIn('连接远程机器', html)
            if path == '/agents':
                self.assertIn('name="name"', html)
            if path in ('/artifacts', '/space'):
                self.assertIn('textarea', html)
                self.assertIn('href="/space"', html)
            if path == '/team':
                self.assertIn('<h1>', html)


if __name__ == '__main__':
    unittest.main()
