"""Threaded comments and likes on public Discover works.

In-process SQLite only. The module is persistence/API code; workspace
membership and whether a work is still publicly listed are caller concerns.
"""
from pathlib import Path
import tempfile
import unittest

from openteamily import work_comments
from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class WorkCommentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name).resolve() / 'state'
        self.now = 1800000000
        self.app = App(Store(self.path), Config(ORIGIN, allow_registration=True),
                       clock=lambda: self.now)
        self.alice = Client(self.app)
        self.bob = Client(self.app, peer='127.0.0.2')
        self.carol = Client(self.app, peer='127.0.0.3')
        self.alice_id = self.alice.register('alice')['body']['user']['id']
        self.bob_id = self.bob.register('bob')['body']['user']['id']
        self.carol_id = self.carol.register('carol')['body']['user']['id']
        self.wid = self.alice.workspace()['body']['workspace']['id']
        self.wid2 = self.alice.workspace(
            '第二个工作区', key='request_second_0002')['body']['workspace']['id']
        self.work = 'a' * 32
        self.other_work = 'b' * 32
        with self.app.store.connect() as db:
            work_comments.ensure_schema(db)

    def add(self, body='hello', *, wid=None, work=None, author=None, now=None, parent=None):
        with self.app.store.connect() as db:
            return work_comments.add_comment(
                db, wid or self.wid, work or self.work, author or self.alice_id,
                body, self.now if now is None else now, parent_id=parent)

    def list(self, *, wid=None, work=None, limit=20, cursor=None, viewer=None):
        with self.app.store.connect() as db:
            return work_comments.list_comments(
                db, wid or self.wid, work or self.work, limit, cursor, viewer_id=viewer)

    def test_schema_is_idempotent_and_has_expected_columns_and_indexes(self):
        with self.app.store.connect() as db:
            work_comments.ensure_schema(db)
            work_comments.ensure_schema(db)
            comments = {row['name'] for row in db.execute('PRAGMA table_info(work_comments)')}
            likes = {row['name'] for row in db.execute('PRAGMA table_info(work_comment_likes)')}
            indexes = {row['name'] for row in db.execute(
                "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'work_comment%'")}
            self.assertEqual(comments, {
                'id', 'workspace_id', 'work_id', 'author_id', 'parent_id', 'body',
                'deleted', 'created', 'updated'})
            self.assertEqual(likes, {'comment_id', 'user_id', 'created'})
            self.assertIn('work_comment_work', indexes)
            self.assertIn('work_comment_parent', indexes)
            self.assertIn('work_comment_like_user', indexes)
            main = {row['name'] for row in db.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'work_comment%'")}
            self.assertEqual(main, {'work_comments', 'work_comment_likes'})
        created = self.add('still here')
        with self.app.store.connect() as db:
            work_comments.ensure_schema(db)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM work_comments').fetchone()[0], 1)
        self.assertEqual(self.list()['items'][0]['id'], created['id'])

    def test_add_root_and_one_level_reply(self):
        root = self.add('  root body  ')
        self.assertEqual(root['body'], 'root body')
        self.assertIsNone(root['parent_id'])
        self.assertFalse(root['deleted'])
        self.assertEqual(root['created'], self.now)
        reply = self.add('reply body', parent=root['id'], author=self.bob_id, now=self.now + 1)
        self.assertEqual(reply['parent_id'], root['id'])
        self.assertEqual(reply['author_id'], self.bob_id)
        listed = self.list(viewer=self.bob_id)
        self.assertEqual(listed['items'][0]['reply_count'], 1)
        self.assertEqual(listed['items'][0]['replies'][0]['id'], reply['id'])

    def test_invalid_parent_and_deeper_reply_rejected(self):
        root = self.add()
        reply = self.add(parent=root['id'])
        for parent in ('f' * 32, reply['id']):
            with self.assertRaises(ValueError):
                self.add(parent=parent)
        with self.assertRaises(ValueError):
            self.add(parent=root['id'], work=self.other_work)
        with self.assertRaises(ValueError):
            self.add(parent=root['id'], wid=self.wid2)
        with self.app.store.connect() as db:
            work_comments.delete_comment(db, self.wid, self.work, root['id'],
                                         self.alice_id, self.now + 2)
        with self.assertRaises(ValueError):
            self.add(parent=root['id'])

    def test_list_orders_roots_and_pages_with_keyset_cursor(self):
        first = self.add('first', now=self.now)
        second = self.add('second', now=self.now + 1)
        third = self.add('third', now=self.now + 2)
        page = self.list(limit=2)
        self.assertEqual([item['id'] for item in page['items']], [first['id'], second['id']])
        self.assertIsNotNone(page['cursor'])
        rest = self.list(limit=2, cursor=page['cursor'])
        self.assertEqual([item['id'] for item in rest['items']], [third['id']])
        self.assertIsNone(rest['cursor'])
        for limit in (0, -1, work_comments.LIST_MAX + 1, True, '2'):
            with self.assertRaises(ValueError):
                self.list(limit=limit)
        with self.assertRaises(ValueError):
            self.list(cursor='not-a-cursor')
        with self.assertRaises(ValueError):
            self.list(cursor='1800000000.nothex')

    def test_reply_previews_are_bounded_and_deleted_replies_are_hidden(self):
        root = self.add('root', now=self.now)
        replies = [self.add('r%d' % index, parent=root['id'], now=self.now + index + 1)
                   for index in range(work_comments.REPLY_PREVIEW + 2)]
        item = self.list()['items'][0]
        self.assertEqual(item['reply_count'], work_comments.REPLY_PREVIEW + 2)
        self.assertEqual(len(item['replies']), work_comments.REPLY_PREVIEW)
        with self.app.store.connect() as db:
            work_comments.delete_comment(db, self.wid, self.work, replies[0]['id'],
                                         self.alice_id, self.now + 20)
        item = self.list()['items'][0]
        self.assertEqual(item['reply_count'], work_comments.REPLY_PREVIEW + 1)
        self.assertNotIn(replies[0]['id'], [reply['id'] for reply in item['replies']])

    def test_edit_and_delete_are_author_only(self):
        root = self.add('before', author=self.alice_id)
        with self.app.store.connect() as db:
            with self.assertRaises(PermissionError):
                work_comments.edit_comment(db, self.wid, self.work, root['id'],
                                           self.bob_id, 'stolen', self.now + 1)
            with self.assertRaises(PermissionError):
                work_comments.delete_comment(db, self.wid, self.work, root['id'],
                                             self.bob_id, self.now + 1)
            edited = work_comments.edit_comment(db, self.wid, self.work, root['id'],
                                                self.alice_id, ' after ', self.now + 2)
            self.assertEqual(edited['body'], 'after')
            self.assertEqual(edited['updated'], self.now + 2)
            with self.assertRaises(ValueError):
                work_comments.edit_comment(db, self.wid, self.work, 'f' * 32,
                                           self.alice_id, 'missing', self.now + 3)
            deleted = work_comments.delete_comment(db, self.wid, self.work, root['id'],
                                                   self.alice_id, self.now + 4)
            self.assertTrue(deleted['deleted'])
            self.assertEqual(db.execute(
                'SELECT deleted, body FROM work_comments WHERE id=?', (root['id'],)).fetchone()[0], 1)
            again = work_comments.delete_comment(db, self.wid, self.work, root['id'],
                                                 self.alice_id, self.now + 5)
            self.assertTrue(again['deleted'])
            with self.assertRaises(ValueError):
                work_comments.edit_comment(db, self.wid, self.work, root['id'],
                                           self.alice_id, 'too late', self.now + 6)

    def test_soft_deleted_root_hides_the_thread_and_count(self):
        root = self.add('root')
        reply = self.add('reply', parent=root['id'])
        self.assertEqual(self._count(), 2)
        with self.app.store.connect() as db:
            work_comments.delete_comment(db, self.wid, self.work, reply['id'],
                                         self.alice_id, self.now + 1)
        self.assertEqual(self._count(), 1)
        self.assertEqual(self.list()['items'][0]['reply_count'], 0)
        with self.app.store.connect() as db:
            work_comments.delete_comment(db, self.wid, self.work, root['id'],
                                         self.alice_id, self.now + 2)
        self.assertEqual(self.list()['items'], [])
        self.assertEqual(self._count(), 0)
        with self.app.store.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM work_comments').fetchone()[0], 2)

    def test_like_is_idempotent_and_viewer_flag_is_per_caller(self):
        root = self.add()
        with self.app.store.connect() as db:
            first = work_comments.like_comment(db, self.wid, self.work, root['id'],
                                               self.bob_id, self.now)
            again = work_comments.like_comment(db, self.wid, self.work, root['id'],
                                               self.bob_id, self.now)
        self.assertEqual(first, {'comment_id': root['id'], 'likes': 1, 'liked': True})
        self.assertEqual(again, first)
        with self.app.store.connect() as db:
            work_comments.like_comment(db, self.wid, self.work, root['id'],
                                       self.carol_id, self.now)
        bob_view = self.list(viewer=self.bob_id)['items'][0]
        carol_view = self.list(viewer=self.carol_id)['items'][0]
        anon_view = self.list()['items'][0]
        self.assertEqual((bob_view['likes'], bob_view['liked']), (2, True))
        self.assertEqual((carol_view['likes'], carol_view['liked']), (2, True))
        self.assertEqual((anon_view['likes'], anon_view['liked']), (2, False))
        with self.app.store.connect() as db:
            self.assertEqual(work_comments.unlike_comment(
                db, self.wid, self.work, root['id'], self.bob_id, self.now)['likes'], 1)
            self.assertEqual(work_comments.unlike_comment(
                db, self.wid, self.work, root['id'], self.bob_id, self.now)['likes'], 1)
        self.assertFalse(self.list(viewer=self.bob_id)['items'][0]['liked'])
        with self.app.store.connect() as db:
            with self.assertRaises(ValueError):
                work_comments.like_comment(db, self.wid, self.work, 'f' * 32,
                                           self.bob_id, self.now)

    def test_workspace_and_work_isolation(self):
        mine = self.add('mine')
        same_work_other_workspace = self.add('elsewhere', wid=self.wid2, work=self.work)
        other_work = self.add('other work', work=self.other_work)
        self.assertEqual([item['id'] for item in self.list()['items']], [mine['id']])
        self.assertEqual([item['id'] for item in self.list(wid=self.wid2)['items']],
                         [same_work_other_workspace['id']])
        self.assertEqual([item['id'] for item in self.list(work=self.other_work)['items']],
                         [other_work['id']])
        self.assertEqual(self._count(), 1)
        self.assertEqual(self._count(work=self.other_work), 1)
        with self.app.store.connect() as db:
            for wid, work in ((self.wid2, self.work), (self.wid, self.other_work)):
                with self.assertRaises(ValueError):
                    work_comments.edit_comment(db, wid, work, mine['id'],
                                               self.alice_id, 'cross tenant', self.now + 1)
                with self.assertRaises(ValueError):
                    work_comments.delete_comment(db, wid, work, mine['id'],
                                                 self.alice_id, self.now + 1)
                with self.assertRaises(ValueError):
                    work_comments.like_comment(db, wid, work, mine['id'],
                                               self.bob_id, self.now)
        self.assertEqual(self.list()['items'][0]['body'], 'mine')

    def test_oversize_and_invalid_bodies_are_rejected(self):
        for body in ('', '   ', 'x' * (work_comments.BODY_MAX + 1), 'bad\x00body', 7, None):
            with self.assertRaises(ValueError):
                self.add(body)
        self.assertEqual(self.list()['items'], [])
        accepted = self.add('x' * work_comments.BODY_MAX)
        self.assertEqual(len(accepted['body']), work_comments.BODY_MAX)

    def test_comment_count_includes_visible_roots_and_replies(self):
        first = self.add('one', now=self.now)
        self.add('two', now=self.now + 1)
        self.add('reply', parent=first['id'], now=self.now + 2)
        self.assertEqual(self._count(), 3)
        with self.app.store.connect() as db:
            work_comments.delete_comment(db, self.wid, self.work, first['id'],
                                         self.alice_id, self.now + 3)
        self.assertEqual(self._count(), 1)

    def _count(self, *, wid=None, work=None):
        with self.app.store.connect() as db:
            return work_comments.comment_count(db, wid or self.wid, work or self.work)


if __name__ == '__main__':
    unittest.main()
