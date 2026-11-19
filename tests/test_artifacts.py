"""Workspace document artifacts. In-process WSGI only; not browser E2E."""
from dataclasses import replace
from pathlib import Path
import sqlite3
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class ArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'state'
        self.app = App(Store(self.path), Config(ORIGIN, allow_registration=True), clock=lambda: 1800000000)
        self.alice = Client(self.app)
        self.alice.register('alice')
        self.bob = Client(self.app, peer='127.0.0.2')
        self.bob.register('bob')
        self.wid = self.alice.workspace()['body']['workspace']['id']
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/members', {'username': 'bob', 'role': 'member'})

    def create(self, client=None, title='Notes', body='First draft.', key='artifact-create-0001', csrf=True, origin=None, **fields):
        payload = {'title': title, 'body': body, **fields}
        kw = {'csrf': csrf}
        if origin is not None:
            kw['origin'] = origin
        return (client or self.alice).call(
            'POST', f'/v1/workspaces/{self.wid}/artifacts', payload, {'HTTP_IDEMPOTENCY_KEY': key}, **kw
        )

    def test_create_list_read_and_edit_persist_in_sqlite(self):
        created = self.create()
        self.assertEqual(created['status'], 201, created)
        item = created['body']['artifact']
        self.assertEqual(item['kind'], 'document')
        self.assertEqual(item['title'], 'Notes')
        self.assertEqual(item['body'], 'First draft.')
        self.assertEqual(item['revision'], 1)
        self.assertEqual(item['created_by'], 'alice')
        listed = self.alice.call('GET', f'/v1/workspaces/{self.wid}/artifacts')
        self.assertEqual(listed['status'], 200)
        self.assertEqual(len(listed['body']['items']), 1)
        self.assertEqual(listed['body']['items'][0]['title'], 'Notes')
        self.assertNotIn('body', listed['body']['items'][0])
        seen = self.alice.call('GET', f'/v1/workspaces/{self.wid}/artifacts/{item["id"]}')
        self.assertEqual(seen['status'], 200)
        self.assertEqual(seen['body']['artifact']['body'], 'First draft.')
        saved = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/artifacts/{item["id"]}',
            {'revision': 1, 'changes': {'body': 'Revised draft.'}},
        )
        self.assertEqual(saved['status'], 200, saved)
        self.assertEqual(saved['body']['artifact']['body'], 'Revised draft.')
        self.assertEqual(saved['body']['artifact']['revision'], 2)
        stale = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/artifacts/{item["id"]}',
            {'revision': 1, 'changes': {'body': 'stale'}},
        )
        self.assertEqual(stale['status'], 409)
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            row = db.execute('SELECT title, body, kind, revision FROM artifacts WHERE id=?', (item['id'],)).fetchone()
        self.assertEqual(row, ('Notes', 'Revised draft.', 'document', 2))
        again = self.create()
        self.assertEqual(again['status'], 200)
        self.assertEqual(again['body']['artifact']['id'], item['id'])

    def test_favorites_are_private_persistent_and_do_not_change_the_document(self):
        artifact = self.create()['body']['artifact']
        aid = artifact['id']
        base = f'/v1/workspaces/{self.wid}/artifacts'
        path = base + f'/{aid}/favorite'
        first = self.alice.call('POST', path, {'enabled': True})
        self.assertEqual(first['status'], 200, first)
        self.assertEqual(self.alice.call('POST', path, {'enabled': True})['status'], 200)
        self.assertTrue(self.alice.call('GET', base)['body']['items'][0]['favorited'])
        self.assertFalse(self.bob.call('GET', base)['body']['items'][0]['favorited'])
        self.assertEqual(self.alice.call('POST', path, {'enabled': 'yes'})['status'], 400)
        self.assertEqual(self.alice.call('POST', path, {'enabled': False}, csrf=False)['status'], 403)
        self.assertEqual(self.alice.call('GET', base + f'/{aid}')['body']['artifact']['revision'], 1)
        with self.app.store.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM artifact_favorites WHERE artifact_id=?', (aid,)).fetchone()[0], 1)
        self.assertEqual(self.alice.call('POST', path, {'enabled': False})['body'], {'favorited': False})
        self.assertFalse(self.alice.call('GET', base)['body']['items'][0]['favorited'])

    def test_permissions_isolation_and_search(self):
        created = self.create()
        aid = created['body']['artifact']['id']
        self.assertEqual(self.bob.call('GET', f'/v1/workspaces/{self.wid}/artifacts')['status'], 200)
        self.assertEqual(self.bob.call('GET', f'/v1/workspaces/{self.wid}/artifacts/{aid}')['status'], 200)
        denied = self.bob.call(
            'POST', f'/v1/workspaces/{self.wid}/artifacts/{aid}',
            {'revision': 1, 'changes': {'body': 'bob rewrite'}},
        )
        self.assertEqual(denied['status'], 403)
        self.assertEqual(
            self.bob.call('POST', f'/v1/workspaces/{self.wid}/artifacts/{aid}/remove', {})['status'], 403
        )
        bob_doc = self.create(self.bob, title="Bob's note", body='From bob', key='artifact-create-bob-01')
        self.assertEqual(bob_doc['status'], 201, bob_doc)
        self.assertEqual(
            self.bob.call(
                'POST', f'/v1/workspaces/{self.wid}/artifacts/{bob_doc["body"]["artifact"]["id"]}',
                {'revision': 1, 'changes': {'body': 'Bob edited'}},
            )['status'],
            200,
        )
        outsider = Client(self.app, peer='127.0.0.3')
        outsider.register('carol')
        self.assertEqual(outsider.call('GET', f'/v1/workspaces/{self.wid}/artifacts')['status'], 404)
        self.assertEqual(outsider.call('GET', f'/v1/workspaces/{self.wid}/artifacts/{aid}')['status'], 404)
        self.assertEqual(outsider.call('POST', f'/v1/workspaces/{self.wid}/artifacts/{aid}/favorite', {'enabled': True})['status'], 404)
        self.assertEqual(
            outsider.call('POST', f'/v1/workspaces/{self.wid}/artifacts', {'title': 'Nope', 'body': 'x'},
                          {'HTTP_IDEMPOTENCY_KEY': 'artifact-create-carol1'})['status'],
            404,
        )
        other = self.alice.workspace(name='Other', key='request_example_0002')
        other_id = other['body']['workspace']['id']
        self.assertEqual(self.bob.call('GET', f'/v1/workspaces/{other_id}/artifacts')['status'], 404)
        found = self.alice.call('GET', f'/v1/workspaces/{self.wid}/artifacts?q=bob')
        self.assertEqual([item['title'] for item in found['body']['items']], ["Bob's note"])
        missing = self.alice.call('GET', f'/v1/workspaces/{self.wid}/artifacts?q=missing-term')
        self.assertEqual(missing['body']['items'], [])

    def test_search_paginates_matching_titles(self):
        # Default list pages are 20. If q were applied after an unfiltered
        # id page, a later match such as "Pad 24" could be skipped.
        for i in range(25):
            self.assertEqual(
                self.create(title=f'Pad {i:02d}', body=f'pad {i}', key=f'artifact-pad-{i:02d}-key')['status'],
                201,
            )
        for i, title in enumerate(('工作笔记甲', '工作笔记乙', '工作笔记丙', '其他记录')):
            self.assertEqual(
                self.create(title=title, body='zh', key=f'artifact-zh-{i:02d}-keyxx')['status'], 201
            )
        page = self.alice.call('GET', f'/v1/workspaces/{self.wid}/artifacts?q=工作笔记&limit=2')
        self.assertEqual(page['status'], 200)
        titles = [item['title'] for item in page['body']['items']]
        self.assertEqual(len(titles), 2)
        self.assertTrue(set(titles) <= {'工作笔记甲', '工作笔记乙', '工作笔记丙'})
        self.assertIsNotNone(page['body']['cursor'])
        later = self.alice.call(
            'GET', f'/v1/workspaces/{self.wid}/artifacts?q=工作笔记&limit=2&cursor={page["body"]["cursor"]}'
        )
        self.assertEqual(later['status'], 200)
        combined = titles + [item['title'] for item in later['body']['items']]
        self.assertEqual(set(combined), {'工作笔记甲', '工作笔记乙', '工作笔记丙'})
        self.assertIsNone(later['body']['cursor'])
        found = self.alice.call('GET', f'/v1/workspaces/{self.wid}/artifacts?q=Pad 24&limit=5')
        self.assertEqual(found['status'], 200)
        self.assertEqual([item['title'] for item in found['body']['items']], ['Pad 24'])
        self.assertIsNone(found['body']['cursor'])

    def test_rejects_unknown_kinds_csrf_and_keeps_schema_v1(self):
        self.assertEqual(self.create(kind='slideshow')['status'], 400)
        self.assertEqual(self.create(csrf=False)['status'], 403)
        self.assertEqual(self.create(origin='https://evil.test', key='artifact-create-0002')['status'], 403)
        self.app.config = replace(self.app.config, max_artifacts_per_workspace=1)
        first = self.create()
        self.assertEqual(first['status'], 201, first)
        self.assertEqual(self.create(title='Second', key='artifact-create-0003')['status'], 429)
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            db.execute('DROP TABLE artifacts')
        Store(self.path)
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 1)
            self.assertIsNotNone(db.execute("SELECT name FROM sqlite_master WHERE name='artifacts'").fetchone())

    def test_owner_can_edit_member_document_and_duplicate_titles_conflict(self):
        created = self.create(self.bob, title='Shared', body='v1', key='artifact-create-bob-02')
        aid = created['body']['artifact']['id']
        saved = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/artifacts/{aid}',
            {'revision': 1, 'changes': {'title': 'Shared by owner', 'body': 'v2'}},
        )
        self.assertEqual(saved['status'], 200, saved)
        self.assertEqual(saved['body']['artifact']['updated_by'], 'alice')
        clash = self.create(title='Shared by owner', body='other', key='artifact-create-0004')
        self.assertEqual(clash['status'], 409)


if __name__ == '__main__':
    unittest.main()


class ArtifactPreviewTests(unittest.TestCase):
    def row(self, **fields):
        base = {'body': '', 'render': None, 'media_mime': None, 'board_json': None,
                'slides_json': None, 'dashboard_json': None, 'title': 'T'}
        base.update(fields)
        return base

    def test_preview_is_text_only_and_bounded(self):
        from openteamily import artifacts
        kind = artifacts.public_kind
        try:
            artifacts.public_kind = lambda row: row['kind']
            doc = artifacts.preview(self.row(kind='document', body='# 标题\n\n' + '很长的一行' * 80 + '\n\n第二段'))
            self.assertEqual(doc['type'], 'document')
            self.assertEqual(doc['heading'], '标题')
            self.assertTrue(all(len(line) <= artifacts.PREVIEW_LINE_MAX for line in doc['lines']))
            shaped = artifacts.preview(self.row(kind='document', body='# Heading\n- Item\n> Quote\n```\ncode\n```\n' + 'line\n' * 20))
            self.assertEqual([block['type'] for block in shaped['blocks']][:4], ['heading', 'list', 'quote', 'code'])
            self.assertEqual(len(shaped['blocks']), 6)
            self.assertNotIn('```', str(shaped['blocks']))
            site = artifacts.preview(self.row(kind='website', body='<title>站点</title><script>alert(1)</script><h1>欢迎</h1><p>正文</p>'))
            self.assertEqual(site['type'], 'website')
            self.assertNotIn('alert', str(site))
            self.assertNotIn('<', str(site))
            self.assertIsNone(artifacts.preview(self.row(kind='media')))
        finally:
            artifacts.public_kind = kind
