"""Per-user DS-Bot import bundles (docs/DSBOT_PLUGIN_ARCHITECTURE.md §5)."""
import base64
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest

from openteamily import dsbot_bundle
from openteamily.store import Store


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(os.path.realpath(self.temp.name))
        self.store = Store(root / 'state')
        self.alice, self.bob = 'a' * 32, 'b' * 32
        self.wid, self.bob_wid = '1' * 32, '2' * 32
        with self.store.transaction() as db:
            for user, name in ((self.alice, 'alice'), (self.bob, 'bob')):
                db.execute('INSERT INTO users VALUES(?,?,?,?)', (user, name, 'x', 1))
            for wid, owner, key in ((self.wid, self.alice, 'k1'), (self.bob_wid, self.bob, 'k2')):
                db.execute('INSERT INTO workspaces VALUES(?,?,?,?,?,?)', (wid, owner, 'w', 1, key, key))

    def user(self, db, name):
        return db.execute('SELECT id FROM users WHERE username=?', (name,)).fetchone()[0]

    def agent(self, db, aid, wid, owner):
        db.execute('INSERT INTO workspace_agents VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
                   (aid, wid, 'agent', 'h-' + aid, '', '', 1, 1, 1, owner, 0, 'kh-' + aid, 'rh-' + aid))

    def test_meetings_bundle_is_scoped_to_one_account_and_verifiable(self):
        with self.store.transaction() as db:
            for user, wid, title, mid in ((self.alice, self.wid, '周会', 'c' * 32),
                                           (self.bob, self.bob_wid, 'bob 的会', 'd' * 32)):
                db.execute('INSERT INTO meetings VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                           (mid, wid, title, hashlib.sha256(title.encode()).hexdigest(), 0, '[]', '', '',
                            '[]', 1, 1, 1, user, user, 'k-' + mid, 'r-' + mid))
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
        schedule = json.dumps({'kind': 'daily', 'time': '09:00', 'time_zone': 'Asia/Shanghai'})
        with self.store.transaction() as db:
            for user, wid, title, aid, name, ident in (
                    (self.alice, self.wid, '晨报', 'e' * 32, '文档助手', 'auto-1'),
                    (self.bob, self.bob_wid, 'bob 的报', 'f' * 32, 'bob 助手', 'auto-2')):
                db.execute('INSERT INTO automations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                           ('a' + ident, wid, title, hashlib.sha256(title.encode()).hexdigest(), '汇总。',
                            'custom', schedule, '[]', 1, 1, 1, 1, 'k-' + ident, 'r-' + ident))
                self.agent(db, aid, wid, user)
                db.execute('UPDATE workspace_agents SET name=? WHERE id=?', (name, aid))
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
        digest = hashlib.sha256(png).hexdigest()
        with self.store.transaction() as db:
            for user, wid, title, aid, ident in (
                    (self.alice, self.wid, '周报', '1' * 32, 'a1'),
                    (self.alice, self.wid, 'cover', '2' * 32, 'a2'),
                    (self.bob, self.bob_wid, 'bob 的文档', '3' * 32, 'b1')):
                db.execute('INSERT INTO artifacts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
                           (aid, wid, title, hashlib.sha256(title.encode()).hexdigest(), 'document', '正文',
                            1, 1, 1, user, user, 'k-' + ident, 'r-' + ident))
            db.execute('INSERT INTO artifact_media VALUES(?,?,?,?,?)', ('2' * 32, 'image/png', len(png), digest, 'dot.png'))
        media_dir = Path(self.store.data_dir) / 'artifact-objects' / self.wid
        media_dir.mkdir(parents=True, exist_ok=True)
        (media_dir / digest).write_bytes(png)
        with self.store.connect() as db:
            bundle = dsbot_bundle.build(db, self.user(db, 'alice'), 'artifacts', now=1,
                                        data_dir=self.store.data_dir)
        rows = json.loads(bundle['tables']['artifacts'])
        self.assertEqual(sorted(row['title'] for row in rows), ['cover', '周报'])
        self.assertTrue(all(row['workspace_id'] == self.wid for row in rows))
        media = json.loads(bundle['media'])
        self.assertEqual(len(media), 1)
        self.assertEqual(bundle['manifest']['media']['rows'], 1)
        self.assertEqual(bundle['manifest']['media']['sha256'],
                         hashlib.sha256(bundle['media'].encode('utf-8')).hexdigest())
        self.assertEqual(base64.b64decode(media[0]['data']), png)


class AgentApiBundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(os.path.realpath(self.temp.name))
        self.store = Store(root / 'state')
        self.alice, self.bob = 'a' * 32, 'b' * 32
        self.wid, self.bob_wid = '1' * 32, '2' * 32
        self.agent, self.bob_agent = 'c' * 32, 'd' * 32
        with self.store.transaction() as db:
            for user, name in ((self.alice, 'alice'), (self.bob, 'bob')):
                db.execute('INSERT INTO users VALUES(?,?,?,?)', (user, name, 'x', 1))
            for wid, owner, key in ((self.wid, self.alice, 'k1'), (self.bob_wid, self.bob, 'k2')):
                db.execute('INSERT INTO workspaces VALUES(?,?,?,?,?,?)', (wid, owner, 'w', 1, key, key))
            for aid, wid, owner in ((self.agent, self.wid, self.alice), (self.bob_agent, self.bob_wid, self.bob)):
                db.execute('INSERT INTO workspace_agents VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
                           (aid, wid, 'agent', 'h-' + aid, '', '', 1, 1, 1, owner, 0,
                            'kh-' + aid, 'rh-' + aid))

    def key(self, db, kid, wid, aid, token, name, rate, revoked, created):
        db.execute('INSERT INTO agent_api_keys VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                   (kid, wid, aid, name, hashlib.sha256(token.encode()).hexdigest(), 'invoke',
                    rate, created, self.alice, 7, revoked))

    def test_agent_api_bundle_is_scoped_to_the_owner_and_has_no_plaintext(self):
        alice_token, bob_token = 'A' * 43, 'B' * 43
        with self.store.transaction() as db:
            self.key(db, 'e' * 32, self.wid, self.agent, alice_token, 'ci', 7, 0, 11)
            self.key(db, 'f' * 32, self.wid, self.agent, 'C' * 43, 'old', 2, 1, 12)
            self.key(db, '9' * 32, self.bob_wid, self.bob_agent, bob_token, 'bob-key', 3, 0, 13)
            bundle = dsbot_bundle.build(db, self.alice, 'agent-api', now=1)
        rows = json.loads(bundle['tables']['agent_api_keys'])
        self.assertEqual([row['id'] for row in rows], ['e' * 32, 'f' * 32])
        self.assertEqual({row['workspace_id'] for row in rows}, {self.wid})
        self.assertEqual({row['agent_id'] for row in rows}, {self.agent})
        self.assertEqual([row['name'] for row in rows], ['ci', 'old'])
        self.assertEqual([row['rate_per_minute'] for row in rows], [7, 2])
        self.assertEqual([row['revoked'] for row in rows], [0, 1])
        self.assertEqual([row['token_hash'] for row in rows],
                         [hashlib.sha256(alice_token.encode()).hexdigest(),
                          hashlib.sha256(('C' * 43).encode()).hexdigest()])
        self.assertNotIn('created_by', rows[0])
        text = dsbot_bundle.dumps(bundle)
        self.assertNotIn(alice_token, text)
        self.assertNotIn(bob_token, text)
        self.assertNotIn('C' * 43, text)
        self.assertEqual(bundle['feature'], 'agent-api')
        self.assertEqual(bundle['manifest']['agent_api_keys']['rows'], 2)
        self.assertEqual(bundle['manifest']['agent_api_keys']['sha256'],
                         hashlib.sha256(bundle['tables']['agent_api_keys'].encode()).hexdigest())
        with self.store.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM agent_api_keys').fetchone()[0], 3,
                             'legacy rows are left untouched')

    def test_agent_api_bundle_rejects_unknown_feature(self):
        with self.store.connect() as db:
            with self.assertRaises(ValueError):
                dsbot_bundle.build(db, self.alice, 'agent-api-nope')


class PersonalBootstrapTests(unittest.TestCase):
    def test_personal_bootstrap_seeds_only_initial_roster_and_welcome(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        store = Store(Path(temp.name) / 'state')
        app = App(store, Config(ORIGIN, allow_registration=True), clock=lambda: 1800000000)
        alice, bob = Client(app), Client(app, peer='127.0.0.2')
        self.assertEqual(alice.register('alice')['status'], 201)
        self.assertEqual(bob.register('bob')['status'], 201)
        private = alice.call('POST', '/v1/personal-agent', {})['body']['personal_agent']
        other = bob.call('POST', '/v1/personal-agent', {})['body']['personal_agent']
        with store.connect() as db:
            aid = db.execute("SELECT id FROM users WHERE username='alice'").fetchone()[0]
            bundle = dsbot_bundle.build_personal_bootstrap(db, aid, 'a' * 32, 1800000000)
        self.assertEqual(bundle['instance_id'], 'a' * 32)
        tables = {name: json.loads(raw) for name, raw in bundle['tables'].items()}
        self.assertEqual(tables['personal_agents'][0]['user_id'], aid)
        self.assertTrue(all(a['workspace_id'] == private['workspace']['id'] for a in tables['workspace_agents']))
        self.assertEqual(len(tables['workspace_agents']), 11)
        self.assertEqual(len(tables['agent_messages']), 1)
        self.assertEqual(tables['agent_messages'][0]['agent_id'], private['agent']['id'])
        self.assertNotIn(other['workspace']['id'], str(bundle))
        for name, raw in bundle['tables'].items():
            self.assertEqual(bundle['manifest'][name]['sha256'], hashlib.sha256(raw.encode()).hexdigest())

if __name__ == '__main__':
    unittest.main()
