"""Per-user Personal Agent and built-in roster (issue #130). In-process WSGI only."""
from dataclasses import replace
from pathlib import Path
import sqlite3
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class PersonalAgentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'state'
        self.app = App(Store(self.path), Config(ORIGIN, allow_registration=True),
                       clock=lambda: 1800000000)
        self.alice = Client(self.app)
        self.alice.register('alice')
        self.bob = Client(self.app, peer='127.0.0.2')
        self.bob.register('bob')

    def test_ensure_creates_personal_space_agent_and_roster_once(self):
        before = self.alice.call('GET', '/v1/personal-agent')
        self.assertEqual(before['status'], 200)
        self.assertIsNone(before['body']['personal_agent'])
        created = self.alice.call('POST', '/v1/personal-agent')
        self.assertEqual(created['status'], 201, created)
        personal = created['body']['personal_agent']
        self.assertEqual(personal['workspace']['name'], '个人空间')
        self.assertEqual(personal['workspace']['kind'], 'personal')
        self.assertEqual(personal['agent']['name'], "alice's Personal Agent")
        self.assertEqual(personal['agent']['summary'], 'Your Cross-context Super AI Agent.')
        self.assertEqual(len(created['body']['builtin_agents']), 10)
        names = [item['agent']['name'] for item in created['body']['builtin_agents']]
        self.assertIn('Teamily Agent', names)
        self.assertIn('Travel Planner', names)
        self.assertIn('Webpage Developer', names)
        again = self.alice.call('POST', '/v1/personal-agent')
        self.assertEqual(again['status'], 200)
        self.assertEqual(again['body']['personal_agent']['workspace']['id'],
                         personal['workspace']['id'])
        self.assertEqual(again['body']['personal_agent']['agent']['id'],
                         personal['agent']['id'])
        listed = self.alice.call('GET', '/v1/workspaces?limit=100')
        self.assertEqual(len(listed['body']['items']), 1)
        self.assertEqual(listed['body']['items'][0]['name'], '个人空间')
        conversations = self.alice.call(
            'GET', f"/v1/workspaces/{personal['workspace']['id']}/agents/"
                   f"{personal['agent']['id']}/conversations")
        self.assertEqual(conversations['status'], 200, conversations)
        self.assertEqual(len(conversations['body']['items']), 1)
        conv = conversations['body']['items'][0]
        snapshot = self.alice.call(
            'GET', f"/v1/workspaces/{personal['workspace']['id']}/agents/"
                   f"{personal['agent']['id']}/conversations/{conv['id']}")
        self.assertEqual(snapshot['status'], 200, snapshot)
        self.assertEqual(snapshot['body']['items'][0]['body'], '你们已经是好友了，可以开始聊天啦！')
        self.assertEqual(snapshot['body']['items'][0]['role'], 'assistant')
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 1)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM workspace_agents').fetchone()[0], 11)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM builtin_agents').fetchone()[0], 10)

    def test_personal_look_is_exposed_only_to_its_owner(self):
        look = {'color': '天空蓝', 'expression': '微笑', 'headwear': '耳机',
                'glasses': '无', 'hand': '咖啡杯'}
        alice = self.alice.call('POST', '/v1/personal-agent')['body']['personal_agent']
        self.assertIsNone(alice['look'])
        saved = self.alice.call('POST', '/v1/onboarding/look', {'look': look})
        self.assertEqual(saved['status'], 200, saved)
        got = self.alice.call('GET', '/v1/personal-agent')['body']['personal_agent']
        self.assertEqual(got['look'], look)
        self.assertEqual(got['agent']['id'], alice['agent']['id'])
        bob = self.bob.call('POST', '/v1/personal-agent')['body']['personal_agent']
        self.assertIsNone(bob['look'])
        self.assertNotEqual(bob['agent']['id'], alice['agent']['id'])

    def test_personal_space_is_isolated_per_user(self):
        alice = self.alice.call('POST', '/v1/personal-agent')['body']['personal_agent']
        bob = self.bob.call('POST', '/v1/personal-agent')['body']['personal_agent']
        self.assertNotEqual(alice['workspace']['id'], bob['workspace']['id'])
        self.assertNotEqual(alice['agent']['id'], bob['agent']['id'])
        self.assertEqual(self.bob.call('GET', f"/v1/workspaces/{alice['workspace']['id']}/agents")['status'], 404)
        alice_conversations = self.alice.call(
            'GET', f"/v1/workspaces/{alice['workspace']['id']}/agents/"
                   f"{alice['agent']['id']}/conversations")['body']['items']
        self.assertEqual(self.bob.call(
            'GET', f"/v1/workspaces/{alice['workspace']['id']}/agents/"
                   f"{alice['agent']['id']}/conversations/{alice_conversations[0]['id']}")['status'], 404)

    def test_workspace_quota_and_csrf(self):
        limited = App(Store(Path(self.temp.name) / 'limited'), Config(ORIGIN, allow_registration=True,
                                                                    max_workspaces_per_user=1),
                      clock=lambda: 1800000000)
        alice = Client(limited)
        alice.register('alice')
        alice.workspace()
        self.assertEqual(alice.call('POST', '/v1/personal-agent')['status'], 429)
        fresh = App(Store(Path(self.temp.name) / 'csrf'), Config(ORIGIN, allow_registration=True),
                    clock=lambda: 1800000000)
        client = Client(fresh)
        client.register('alice')
        self.assertEqual(client.call('POST', '/v1/personal-agent', csrf=False)['status'], 403)


if __name__ == '__main__':
    unittest.main()
