"""Per-user DS-Bot import bundles (docs/DSBOT_PLUGIN_ARCHITECTURE.md §5)."""
import base64
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from openteamily import dsbot_bundle
from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = Store(Path(self.temp.name) / 'state')
        self.app = App(self.store, Config(ORIGIN, allow_registration=True), clock=lambda: 1800000000)
        self.alice, self.bob = Client(self.app), Client(self.app, peer='127.0.0.2')
        self.alice.register('alice')
        self.bob.register('bob')
        self.wid = self.alice.workspace()['body']['workspace']['id']
        self.bob_wid = self.bob.workspace(key='request_example_0002')['body']['workspace']['id']

    def user(self, db, name):
        return db.execute('SELECT id FROM users WHERE username=?', (name,)).fetchone()[0]

    def test_meetings_bundle_is_scoped_to_one_account_and_verifiable(self):
        for client, wid, title, key in ((self.alice, self.wid, '周会', 'bundle-meeting-0001'),
                                         (self.bob, self.bob_wid, 'bob 的会', 'bundle-meeting-0002')):
            self.assertEqual(client.call('POST', f'/v1/workspaces/{wid}/meetings', {'title': title},
                                         {'HTTP_IDEMPOTENCY_KEY': key})['status'], 201)
        with self.store.connect() as db:
            bundle = dsbot_bundle.build(db, self.user(db, 'alice'), 'meetings', now=1)
            before = db.execute('SELECT COUNT(*) FROM meetings').fetchone()[0]
        self.assertEqual(bundle['format'], dsbot_bundle.FORMAT)
        text = bundle['tables']['meetings']
        self.assertEqual(bundle['manifest']['meetings'],
                         {'rows': 1, 'sha256': hashlib.sha256(text.encode('utf-8')).hexdigest()})
        rows = json.loads(text)
        self.assertEqual([row['title'] for row in rows], ['周会'])
        self.assertEqual(rows[0]['workspace_id'], self.wid)
        self.assertEqual(before, 2, 'legacy rows are left untouched')
        self.assertEqual(json.loads(dsbot_bundle.dumps(bundle)), bundle)
        with self.assertRaises(ValueError):
            dsbot_bundle.build(db, 'x', 'nope')



    def test_automations_and_agents_bundles_are_scoped_to_one_account(self):
        schedule = {'kind': 'daily', 'time': '09:00', 'time_zone': 'Asia/Shanghai'}
        for client, wid, title, key in ((self.alice, self.wid, '晨报', 'bundle-auto-0001'),
                                        (self.bob, self.bob_wid, 'bob 的报', 'bundle-auto-0002')):
            self.assertEqual(client.call('POST', f'/v1/workspaces/{wid}/automations',
                                         {'title': title, 'prompt': '汇总。', 'template_id': 'custom',
                                          'schedule': schedule, 'participants': [client is self.alice and 'alice' or 'bob']},
                                         {'HTTP_IDEMPOTENCY_KEY': key})['status'], 201)
        for client, wid, name, key in ((self.alice, self.wid, '文档助手', 'bundle-agent-0001xxxx'),
                                       (self.bob, self.bob_wid, 'bob 助手', 'bundle-agent-0002xxxx')):
            self.assertEqual(client.call('POST', f'/v1/workspaces/{wid}/agents',
                                         {'name': name, 'summary': '整理', 'instructions': '先列要点。'},
                                         {'HTTP_IDEMPOTENCY_KEY': key})['status'], 201)
        with self.store.connect() as db:
            auto = dsbot_bundle.build(db, self.user(db, 'alice'), 'automations', now=1)
            agents = dsbot_bundle.build(db, self.user(db, 'alice'), 'agents', now=1)
            before_auto = db.execute('SELECT COUNT(*) FROM automations').fetchone()[0]
            before_agents = db.execute('SELECT COUNT(*) FROM workspace_agents').fetchone()[0]
        titles = [row['title'] for row in json.loads(auto['tables']['automations'])]
        self.assertEqual(titles, ['晨报'])
        self.assertEqual(auto['feature'], 'automations')
        self.assertEqual(auto['manifest']['automations']['rows'], 1)
        names = [row['name'] for row in json.loads(agents['tables']['workspace_agents'])]
        self.assertEqual(names, ['文档助手'])
        self.assertEqual(agents['feature'], 'agents')
        self.assertEqual(before_auto, 2, 'legacy rows are left untouched')
        self.assertEqual(before_agents, 2, 'legacy rows are left untouched')

    def test_artifacts_bundle_is_scoped_to_one_account_and_includes_media(self):
        png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')
        for client, wid, title, key in ((self.alice, self.wid, '周报', 'bundle-artifact-0001'),
                                         (self.bob, self.bob_wid, 'bob 的文档', 'bundle-artifact-0002')):
            self.assertEqual(client.call('POST', f'/v1/workspaces/{wid}/artifacts',
                                         {'title': title, 'body': '正文', 'kind': 'document'},
                                         {'HTTP_IDEMPOTENCY_KEY': key})['status'], 201)
        boundary = '----ot-test-boundary'
        raw = (
            f'--{boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\ncover\r\n'
            f'--{boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nmedia\r\n'
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="dot.png"\r\n'
            f'Content-Type: image/png\r\n\r\n'
        ).encode() + png + f'\r\n--{boundary}--\r\n'.encode()
        uploaded = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/artifacts', raw=raw, headers={
                'CONTENT_TYPE': f'multipart/form-data; boundary={boundary}',
                'HTTP_IDEMPOTENCY_KEY': 'bundle-artifact-media01',
            })
        self.assertEqual(uploaded['status'], 201, uploaded)
        with self.store.connect() as db:
            bundle = dsbot_bundle.build(db, self.user(db, 'alice'), 'artifacts', now=1, data_dir=self.store.data_dir)
        rows = json.loads(bundle['tables']['artifacts'])
        self.assertEqual(sorted(row['title'] for row in rows), ['cover', '周报'])
        self.assertTrue(all(row['workspace_id'] == self.wid for row in rows))
        media = json.loads(bundle['media'])
        self.assertEqual(len(media), 1)
        self.assertEqual(bundle['manifest']['media']['rows'], 1)
        self.assertEqual(bundle['manifest']['media']['sha256'],
                         hashlib.sha256(bundle['media'].encode('utf-8')).hexdigest())
        self.assertEqual(base64.b64decode(media[0]['data']), png)





class PersonalBundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = Store(Path(self.temp.name) / 'state')
        self.app = App(self.store, Config(ORIGIN, allow_registration=True), clock=lambda: 1800000000)
        self.alice, self.bob = Client(self.app), Client(self.app, peer='127.0.0.2')
        self.alice.register('alice')
        self.bob.register('bob')

    def user(self, db, name):
        return db.execute('SELECT id FROM users WHERE username=?', (name,)).fetchone()[0]

    def test_personal_bundle_is_scoped_to_one_account_and_excludes_other_users(self):
        look = {'color': '天空蓝', 'expression': '微笑', 'headwear': '耳机',
                'glasses': '无', 'hand': '咖啡杯'}
        alice = self.alice.call('POST', '/v1/personal-agent')['body']['personal_agent']
        bob = self.bob.call('POST', '/v1/personal-agent')['body']['personal_agent']
        with self.store.connect() as db:
            db.execute('INSERT INTO user_onboarding_steps VALUES(?,?,?,?)',
                       (self.user(db, 'alice'), '[]', json.dumps(look), 1800000000))
            bundle = dsbot_bundle.build(db, self.user(db, 'alice'), 'personal', now=1)
            bob_bundle = dsbot_bundle.build(db, self.user(db, 'bob'), 'personal', now=1)
        self.assertEqual(bundle['feature'], 'personal')
        tables = bundle['tables']
        for name, text in tables.items():
            self.assertEqual(bundle['manifest'][name],
                             {'rows': len(json.loads(text)),
                              'sha256': hashlib.sha256(text.encode('utf-8')).hexdigest()})
        personal = json.loads(tables['personal_agents'])
        builtins = json.loads(tables['builtin_agents'])
        agents = json.loads(tables['workspace_agents'])
        workspaces = json.loads(tables['workspaces'])
        users = json.loads(tables['ot_users'])
        self.assertEqual(len(personal), 1)
        self.assertEqual(personal[0]['workspace_id'], alice['workspace']['id'])
        self.assertEqual(personal[0]['agent_id'], alice['agent']['id'])
        self.assertEqual(len(builtins), 10)
        self.assertEqual(len(agents), 11)
        self.assertEqual({row['workspace_id'] for row in agents}, {alice['workspace']['id']})
        self.assertIn(alice['agent']['id'], {row['id'] for row in agents})
        self.assertEqual([row['id'] for row in workspaces], [alice['workspace']['id']])
        self.assertEqual([row['username'] for row in users], ['alice'])
        look_rows = json.loads(tables['personal_look'])
        self.assertEqual(len(look_rows), 1)
        self.assertEqual(json.loads(look_rows[0]['look']), look)
        bob_ids = {bob['workspace']['id'], bob['agent']['id']}
        alice_ids = {alice['workspace']['id'], alice['agent']['id']}
        self.assertTrue(alice_ids.isdisjoint(bob_ids))
        serialised = dsbot_bundle.dumps(bundle)
        self.assertNotIn(bob['workspace']['id'], serialised)
        self.assertNotIn(bob['agent']['id'], serialised)
        bob_personal = json.loads(bob_bundle['tables']['personal_agents'])
        self.assertEqual(bob_personal[0]['workspace_id'], bob['workspace']['id'])
        self.assertEqual(bob_personal[0]['agent_id'], bob['agent']['id'])


if __name__ == '__main__':
    unittest.main()
