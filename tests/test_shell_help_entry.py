"""The account menu separates the page we have (功能指引) from the page we do not (帮助中心).

Every shell page's account menu carries a Help submenu. `#137` pointed its first item at `/guide`
but kept the name 「帮助中心」, so the entry promised a billing/support FAQ while the landing page
is a feature guide. These tests read the static pages as markup, not through a browser: a page must
offer exactly one link named 「功能指引」 to `/guide` with `role="menuitem"`, and the 「帮助中心」
slot may stay only as a disabled placeholder whose tooltip says it is not implemented — never as a
link to `/guide`. The placeholder keeps the first slot the target site gives it, with 功能指引 next.
A later shell page must carry the same pair or the count check fails. `/about` is a standalone article without the account menu, so it is left out of this list.
"""
from html.parser import HTMLParser
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
PAGES = sorted(
    path for path in (ROOT / 'openteamily' / 'static').glob('*/index.html')
    if path.parent.name != 'about'
)


class HelpMenu(HTMLParser):
    """Collect the entries of `<div id="help-menu">` as (tag, attrs, text) triples."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.inside = False
        self.depth = 0
        self.entries = []
        self._current = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if self.inside:
            if tag == 'div':
                self.depth += 1
            elif tag in ('a', 'button'):
                self._current = (tag, attrs, '')
        elif tag == 'div' and attrs.get('id') == 'help-menu':
            self.inside = True
            self.depth = 1

    def handle_endtag(self, tag):
        if not self.inside:
            return
        if tag == 'div':
            self.depth -= 1
            if self.depth == 0:
                self.inside = False
        elif tag in ('a', 'button') and self._current and self._current[0] == tag:
            self.entries.append((*self._current[:2], self._current[2].strip()))
            self._current = None

    def handle_data(self, data):
        if self.inside and self._current is not None:
            self._current = (*self._current[:2], self._current[2] + data)


def help_entries(page):
    parser = HelpMenu()
    parser.feed(page.read_text(encoding='utf-8'))
    return parser.entries


class ShellHelpEntryTests(unittest.TestCase):
    def test_every_shell_page_links_the_guide_under_its_own_name(self):
        self.assertEqual(len(PAGES), 17, f'expected the 17 shell pages, found {[str(p) for p in PAGES]}')
        for page in PAGES:
            with self.subTest(page=page):
                entries = help_entries(page)
                all_guide = [e for e in entries if e[0] == 'a' and e[1].get('href') == '/guide']
                self.assertEqual(
                    len(all_guide), 1,
                    f'{page}: the help menu has {len(all_guide)} links to /guide: {all_guide}')
                guides = [e for e in entries
                          if e[0] == 'a' and e[1].get('href') == '/guide' and e[2] == '功能指引']
                self.assertEqual(
                    len(guides), 1,
                    f'{page}: the help menu has no 「功能指引」 link to /guide: {entries}')
                tag, attrs, text = guides[0]
                self.assertEqual(text, '功能指引', f'{page}: the guide link is misnamed: {text!r}')
                self.assertEqual(attrs.get('role'), 'menuitem', f'{page}: the guide link is not a menu item: {attrs}')

    def test_the_help_center_slot_is_a_disabled_placeholder_not_a_guide_link(self):
        for page in PAGES:
            with self.subTest(page=page):
                entries = help_entries(page)
                center = [e for e in entries if '帮助中心' in e[2]]
                self.assertLessEqual(
                    len(center), 1,
                    f'{page}: the help menu repeats 「帮助中心」: {center}')
                for tag, attrs, text in center:
                    self.assertEqual(
                        tag, 'button',
                        f'{page}: 「帮助中心」 must not be a link while we have no help center: {(tag, attrs, text)}')
                    self.assertNotIn(
                        'href', attrs,
                        f'{page}: 「帮助中心」 still points somewhere: {attrs}')
                    self.assertIn(
                        'disabled', attrs,
                        f'{page}: the 「帮助中心」 placeholder is clickable: {attrs}')
                    self.assertTrue(
                        (attrs.get('title') or '').startswith('未实现'),
                        f'{page}: the 「帮助中心」 placeholder does not say it is unimplemented: {attrs}')
                if center:
                    self.assertEqual(
                        entries[0][2], '帮助中心',
                        f'{page}: 「帮助中心」 lost the first slot the target site gives it: {entries}')
                    self.assertEqual(
                        (entries[1][0], entries[1][1].get('href'), entries[1][2]),
                        ('a', '/guide', '功能指引'),
                        f'{page}: 「功能指引」 does not follow the help center slot: {entries}')


if __name__ == '__main__':
    unittest.main()
