"""Keep imported task results without restoring a management-plane executor."""
import json
from pathlib import Path
import tempfile
import unittest

from openteamily import dsbot_bundle
from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class RetiredTaskPlaneTests(unittest.TestCase):
    def test_archived_task_result_remains_importable_but_cannot_be_claimed(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory).resolve() / 'state'
            store = Store(state)
            owner, workspace, connection, conversation, task = (
                char * 32 for char in 'abcde'
            )
            with store.transaction() as db:
                db.execute('INSERT INTO users VALUES(?,?,?,1)', (owner, 'alice', 'unused'))
                db.execute('INSERT INTO workspaces VALUES(?,?,?,1,?,?)',
                           (workspace, owner, 'Alice', 'workspace-key', 'request-key'))
                db.execute("INSERT INTO runtime_keys VALUES('old-key',?,'Old runtime','hash','prefix',1,NULL,1)", (owner,))
                db.execute("INSERT INTO runtime_connections VALUES(?,?,'old-key','old-host',1,1)", (connection, owner))
                db.execute("INSERT INTO runtime_tasks VALUES(?,?,?,'infer','historic prompt','succeeded',?,1,2)",
                           (task, owner, connection, json.dumps({'text': 'Archived result'})))
                db.execute("INSERT INTO social_conversations VALUES(?,?,'group','Group',NULL,1,1,'group-key','group-request')",
                           (conversation, workspace))
                db.execute("INSERT INTO message_assists VALUES('assist',?,?,'message',?,1,'translate','',?,1,'assist-key','assist-request')",
                           (workspace, conversation, owner, task))

            reopened = Store(state)
            app = App(reopened, Config(ORIGIN))
            client = Client(app)
            for method, path in (
                ('POST', '/v1/agent/connect'),
                ('POST', f'/v1/agent/tasks/{task}/claim'),
                ('POST', f'/v1/agent/tasks/{task}/tools'),
                ('GET', '/v1/runtime-keys'),
                ('POST', '/v1/runtime/tasks'),
                ('GET', '/v1/composio/approvals'),
                ('POST', '/v1/mcp/servers'),
            ):
                with self.subTest(method=method, path=path):
                    self.assertEqual(client.call(method, path)['status'], 410)

            with reopened.connect() as db:
                bundle = dsbot_bundle.build(db, owner, 'message-assists', now=3)
                rows = json.loads(bundle['tables']['message_assists'])
                self.assertEqual([(r['task_status'], r['result_text']) for r in rows],
                                 [('succeeded', 'Archived result')])
                self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(), [])
