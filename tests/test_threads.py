"""Thread persistence tests. In-process WSGI + temporary SQLite only.

The threads module is deliberately not wired into the management HTTP routes by
this slice, so these tests call its closed API against a real Store connection.
"""
from pathlib import Path
import tempfile
import unittest

from openteamily import threads
from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class ThreadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name).resolve() / 'state'
        self.now = 1800000000
        self.app = App(Store(self.path), Config(ORIGIN, allow_registration=True),
                       clock=lambda: self.now)
        self.alice = Client(self.app)
        self.alice.register('alice')
        self.bob = Client(self.app, peer='127.0.0.2')
        self.bob.register('bob')
        self.carol = Client(self.app, peer='127.0.0.3')
        self.carol.register('carol')
        self.wid = self.alice.workspace()['body']['workspace']['id']
        self.alice_id = self._user_id(self.alice)
        self.bob_id = self._user_id(self.bob)
        self.carol_id = self._user_id(self.carol)
        self.conv = 'conv-main'
        self.root = 'root-main'
        with self.app.store.connect() as db:
            threads.ensure_schema(db)

    def _user_id(self, client):
        return client.call('GET', '/v1/auth/session')['body']['user']['id']

    def tick(self):
        self.now += 1
        return self.now

    def create(self, workspace_id=None, conversation_id=None, root_message_id=None,
               created_by=None, title=None):
        with self.app.store.connect() as db:
            return threads.create_thread(
                db, workspace_id or self.wid, conversation_id or self.conv,
                root_message_id or self.root, created_by or self.alice_id,
                self.tick(), title)

    def reply(self, thread_id, author_id, body, workspace_id=None):
        with self.app.store.connect() as db:
            return threads.add_reply(db, workspace_id or self.wid, thread_id,
                                     author_id, body, self.tick())

    def view(self, thread_id, viewer_id, **kw):
        with self.app.store.connect() as db:
            return threads.thread_view(db, self.wid, thread_id, viewer_id, **kw)

    def listing(self, workspace_id=None, conversation_id=None, **kw):
        with self.app.store.connect() as db:
            return threads.list_threads(
                db, workspace_id or self.wid, conversation_id or self.conv, **kw)

    def test_schema_is_idempotent_and_has_thread_tables(self):
        with self.app.store.connect() as db:
            threads.ensure_schema(db)
            threads.ensure_schema(db)
            tables = {row[0] for row in db.execute(
                "SELECT name FROM sqlite_master WHERE type='table'")}
            indexes = {row[0] for row in db.execute(
                "SELECT name FROM sqlite_master WHERE type='index'")}
            self.assertLessEqual(
                {'message_threads', 'thread_replies', 'thread_reads'}, tables)
            self.assertLessEqual({
                'message_thread_conversation', 'thread_reply_list',
                'thread_reply_workspace', 'thread_read_updated'}, indexes)
        # A fresh connection can run it again without changing existing rows.
        with self.app.store.connect() as db:
            threads.ensure_schema(db)
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 1)

    def test_create_thread_and_duplicate_root_is_rejected(self):
        created = self.create(title='Launch notes')
        self.assertEqual(created['workspace_id'], self.wid)
        self.assertEqual(created['conversation_id'], self.conv)
        self.assertEqual(created['root_message_id'], self.root)
        self.assertEqual(created['created_by'], self.alice_id)
        self.assertEqual(created['title'], 'Launch notes')
        self.assertFalse(created['resolved'])
        self.assertEqual(created['reply_count'], 0)

        with self.app.store.connect() as db:
            with self.assertRaises(threads.ThreadExists):
                threads.create_thread(db, self.wid, self.conv, self.root,
                                      self.bob_id, self.tick())

        # The same root is allowed in another conversation or workspace.
        other_conversation = self.create(conversation_id='conv-other')
        bob_ws = self.bob.workspace('bob-space', 'threads-bob-workspace-0001')[
            'body']['workspace']['id']
        other_workspace = self.create(workspace_id=bob_ws)
        self.assertNotEqual(created['id'], other_conversation['id'])
        self.assertNotEqual(created['id'], other_workspace['id'])
        self.assertEqual(other_workspace['workspace_id'], bob_ws)

    def test_replies_order_and_page_by_cursor(self):
        thread = self.create()
        first = self.reply(thread['id'], self.alice_id, 'first')
        second = self.reply(thread['id'], self.alice_id, 'second')
        third = self.reply(thread['id'], self.bob_id, 'third')
        self.assertFalse(first['deleted'])
        self.assertEqual(second['thread_id'], thread['id'])

        page = self.view(thread['id'], self.bob_id, limit=2)
        self.assertEqual([item['body'] for item in page['replies']],
                         ['first', 'second'])
        self.assertEqual(page['thread']['reply_count'], 3)
        self.assertEqual(page['unread'], 2)

        following = self.view(thread['id'], self.bob_id, limit=2,
                              cursor=second['id'])
        self.assertEqual([item['body'] for item in following['replies']],
                         ['third'])
        self.assertEqual(following['thread']['reply_count'], 3)
        self.assertIsNone(self.view(thread['id'], self.bob_id,
                                    cursor='missing-reply'))

        # A cursor from a different thread cannot be used to skip this one.
        other = self.create(conversation_id='conv-other')
        other_reply = self.reply(other['id'], self.alice_id, 'elsewhere')
        self.assertIsNone(self.view(thread['id'], self.bob_id,
                                    cursor=other_reply['id']))
        self.assertGreater(third['created'], second['created'])

    def test_unread_is_per_user_and_mark_read_zeroes_it(self):
        thread = self.create()
        bob_reply = self.reply(thread['id'], self.bob_id, 'bob one')
        alice_reply = self.reply(thread['id'], self.alice_id, 'alice one')
        bob_second = self.reply(thread['id'], self.bob_id, 'bob two')

        self.assertEqual(self.view(thread['id'], self.alice_id)['unread'], 2)
        self.assertEqual(self.view(thread['id'], self.bob_id)['unread'], 1)

        listed = self.listing(viewer_id=self.alice_id)
        self.assertEqual(len(listed), 1)
        self.assertEqual(listed[0]['reply_count'], 3)
        self.assertEqual(listed[0]['unread'], 2)
        # Omitting a viewer uses the thread creator for the per-thread count.
        self.assertEqual(self.listing()[0]['unread'], 2)

        with self.app.store.connect() as db:
            state = threads.mark_read(db, self.wid, thread['id'],
                                      self.bob_id, bob_second['created'])
        self.assertEqual(state['user_id'], self.bob_id)
        self.assertEqual(state['last_read'], bob_second['created'])
        self.assertEqual(state['unread'], 0)
        self.assertEqual(self.view(thread['id'], self.bob_id)['unread'], 0)
        self.assertEqual(self.view(thread['id'], self.alice_id)['unread'], 2)

        later = self.reply(thread['id'], self.alice_id, 'alice two')
        self.assertEqual(self.view(thread['id'], self.bob_id)['unread'], 1)
        with self.app.store.connect() as db:
            old = threads.mark_read(db, self.wid, thread['id'],
                                    self.bob_id, alice_reply['created'])
        self.assertEqual(old['last_read'], bob_second['created'])
        self.assertEqual(old['unread'], 1)
        with self.app.store.connect() as db:
            state = threads.mark_read(db, self.wid, thread['id'],
                                      self.bob_id, later['created'])
        self.assertEqual(state['unread'], 0)

    def test_resolve_unresolve_and_list_filter(self):
        first = self.create(root_message_id='root-1')
        second = self.create(root_message_id='root-2')
        with self.app.store.connect() as db:
            resolved = threads.resolve_thread(db, self.wid, first['id'], self.tick())
        self.assertTrue(resolved['resolved'])

        unresolved = self.listing(include_resolved=False)
        self.assertEqual([item['id'] for item in unresolved], [second['id']])
        everything = self.listing(include_resolved=True)
        self.assertEqual({item['id'] for item in everything},
                         {first['id'], second['id']})

        with self.app.store.connect() as db:
            reopened = threads.resolve_thread(db, self.wid, first['id'],
                                              self.tick(), resolved=False)
        self.assertFalse(reopened['resolved'])
        self.assertEqual({item['id'] for item in self.listing(include_resolved=False)},
                         {first['id'], second['id']})
        with self.app.store.connect() as db:
            self.assertIsNone(threads.resolve_thread(
                db, self.wid, 'missing-thread', self.tick()))

    def test_soft_delete_hides_reply_and_reduces_visible_counts(self):
        thread = self.create()
        deleted_reply = self.reply(thread['id'], self.alice_id, 'remove me')
        kept = self.reply(thread['id'], self.bob_id, 'keep me')
        later = self.reply(thread['id'], self.alice_id, 'keep this too')

        with self.app.store.connect() as db:
            self.assertTrue(threads.delete_reply(
                db, self.wid, deleted_reply['id'], self.alice_id, self.tick()))

        page = self.view(thread['id'], self.bob_id)
        self.assertEqual([item['id'] for item in page['replies']],
                         [kept['id'], later['id']])
        # Counts describe visible replies; soft-deleted rows are retained but
        # are not counted as replies and do not contribute unread.
        self.assertEqual(page['thread']['reply_count'], 2)
        self.assertEqual(page['unread'], 1)
        self.assertEqual(self.listing()[0]['reply_count'], 2)
        with self.app.store.connect() as db:
            row = db.execute('SELECT deleted FROM thread_replies WHERE id=?',
                             (deleted_reply['id'],)).fetchone()
        self.assertEqual(row['deleted'], 1)

    def test_only_the_author_can_delete_a_reply(self):
        thread = self.create()
        reply = self.reply(thread['id'], self.alice_id, 'mine')
        with self.app.store.connect() as db:
            self.assertFalse(threads.delete_reply(
                db, self.wid, reply['id'], self.bob_id, self.tick()))
            self.assertFalse(threads.delete_reply(
                db, self.wid, reply['id'], self.carol_id, self.tick()))
            self.assertFalse(threads.delete_reply(
                db, 'another-workspace', reply['id'], self.alice_id, self.tick()))
            self.assertFalse(threads.delete_reply(
                db, self.wid, 'missing-reply', self.alice_id, self.tick()))
        self.assertEqual(len(self.view(thread['id'], self.bob_id)['replies']), 1)
        with self.app.store.connect() as db:
            self.assertTrue(threads.delete_reply(
                db, self.wid, reply['id'], self.alice_id, self.tick()))
        self.assertEqual(self.view(thread['id'], self.bob_id)['replies'], [])

    def test_workspace_isolation_and_refusals(self):
        thread = self.create()
        reply = self.reply(thread['id'], self.alice_id, 'private')
        bob_ws = self.bob.workspace('bob-space', 'threads-bob-workspace-0001')[
            'body']['workspace']['id']

        self.assertEqual(self.listing(workspace_id=bob_ws), [])
        with self.app.store.connect() as db:
            self.assertIsNone(threads.thread_view(
                db, bob_ws, thread['id'], self.bob_id))
            self.assertIsNone(threads.mark_read(
                db, bob_ws, thread['id'], self.bob_id, self.tick()))
            self.assertIsNone(threads.resolve_thread(
                db, bob_ws, thread['id'], self.tick()))
            self.assertFalse(threads.delete_reply(
                db, bob_ws, reply['id'], self.alice_id, self.tick()))
            with self.assertRaises(threads.ThreadNotFound):
                threads.add_reply(db, bob_ws, thread['id'], self.bob_id,
                                  'not mine', self.tick())
        # The same root may exist independently in another workspace.
        with self.app.store.connect() as db:
            other = threads.create_thread(
                db, bob_ws, self.conv, self.root, self.bob_id, self.tick())
        self.assertNotEqual(thread['id'], other['id'])
        self.assertEqual([item['id'] for item in self.listing(workspace_id=bob_ws)],
                         [other['id']])

    def test_oversize_reply_body_is_rejected_without_being_stored(self):
        thread = self.create()
        with self.app.store.connect() as db:
            for bad in ('', 'x' * (threads.BODY_MAX + 1), 'bad\x00body', 123):
                with self.assertRaises(ValueError):
                    threads.add_reply(db, self.wid, thread['id'],
                                      self.alice_id, bad, self.tick())
            exact = threads.add_reply(
                db, self.wid, thread['id'], self.alice_id,
                'x' * threads.BODY_MAX, self.tick())
        self.assertEqual(len(exact['body']), threads.BODY_MAX)
        self.assertEqual(len(self.view(thread['id'], self.alice_id)['replies']), 1)

    def test_title_bounds_and_validation(self):
        with self.app.store.connect() as db:
            untitled = threads.create_thread(
                db, self.wid, self.conv, 'root-none', self.alice_id, self.tick())
            exact = threads.create_thread(
                db, self.wid, self.conv, 'root-exact', self.alice_id,
                self.tick(), 'x' * threads.TITLE_MAX)
        self.assertIsNone(untitled['title'])
        self.assertEqual(len(exact['title']), threads.TITLE_MAX)

        with self.app.store.connect() as db:
            for index, bad in enumerate(
                    ('', '   ', 'x' * (threads.TITLE_MAX + 1),
                     'bad\x01title', 123)):
                with self.assertRaises(ValueError):
                    threads.create_thread(
                        db, self.wid, self.conv, 'root-bad-%d' % index,
                        self.alice_id, self.tick(), bad)
        self.assertEqual(len(self.listing()), 2)


if __name__ == '__main__':
    unittest.main()
