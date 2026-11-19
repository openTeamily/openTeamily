"""Shared Personal Agent look assets. In-process WSGI only."""
import unittest

from tests import test_settings_page as settings_page_tests


class LookAvatarPageTests(unittest.TestCase):
    def setUp(self):
        settings_page_tests.SettingsPageTests.setUp(self)

    def test_shared_assets_are_served_with_strict_headers(self):
        script = self.raw.call('GET', '/look/app.mjs')
        style = self.raw.call('GET', '/look/app.css')
        self.assertEqual(script['status'], 200)
        self.assertEqual(style['status'], 200)
        self.assertIn('javascript', script['headers']['Content-Type'])
        self.assertIn('text/css', style['headers']['Content-Type'])
        self.assertEqual(script['headers']['Cache-Control'], 'no-store')
        self.assertIn("default-src 'none'", script['headers']['Content-Security-Policy'])
        self.assertIn(b'createLookAvatar', script['body'])
        self.assertIn(b'.look-avatar', style['body'])
        self.assertEqual(self.raw.call('GET', '/look/app.mjs', origin='https://evil.test')['status'], 403)
        self.assertEqual(self.raw.call('GET', '/look/app.css', query='v=1')['status'], 400)
        self.assertEqual(self.raw.call('POST', '/look/app.css')['status'], 405)

    def test_both_pages_link_the_shared_stylesheet(self):
        for path in ('/agents', '/chat'):
            html = self.raw.call('GET', path)['body'].decode()
            self.assertIn('href="/look/app.css"', html, path)


if __name__ == '__main__':
    unittest.main()
