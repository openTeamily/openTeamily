"""Browser-facing provisioning maintains one owner-scoped Compose runtime."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.lifecycle import Lifecycle, RuntimePolicy
from openteamily.security import digest, opaque
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class RuntimePerUserTests(unittest.TestCase):
    def test_distinct_workspaces_and_keys_reuse_the_owners_compose_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            store = Store(Path(directory) / 'state')
            policy = RuntimePolicy(backend_mode='compose', image_ref='example/runtime@sha256:' + 'a' * 64)
            runtime = Lifecycle(store, policy)
            app = App(store, Config(ORIGIN, allow_registration=True), lifecycle=runtime)
            alice, bob = Client(app), Client(app, peer='127.0.0.2')
            alice_id, bob_id = ('a' * 32, 'b' * 32)
            home, team, bob_home = ('1' * 32, '2' * 32, '3' * 32)
            with store.transaction() as db:
                for client, uid, name in [(alice, alice_id, 'alice'), (bob, bob_id, 'bob')]:
                    db.execute('INSERT INTO users VALUES (?,?,?,?)', (uid, name, 'unused', 1))
                    token, csrf = opaque(), opaque()
                    db.execute('INSERT INTO sessions VALUES (?,?,?,?,?)',
                               (digest(token), digest(csrf), uid, 2100000000, 1))
                    client.cookies.update(zip(app.config.cookie_names, (token, csrf)))
                for wid, owner in [(home, alice_id), (team, alice_id), (bob_home, bob_id)]:
                    db.execute('INSERT INTO workspaces VALUES (?,?,?,?,?,?)',
                               (wid, owner, 'Workspace ' + wid[0], 1, digest(wid), digest(wid)))
                db.execute('INSERT INTO workspace_members VALUES (?,?,?,?,?)',
                           (home, bob_id, 'admin', 1, alice_id))
                db.execute('INSERT INTO workspace_members VALUES (?,?,?,?,?)',
                           (team, bob_id, 'admin', 1, alice_id))

            with ThreadPoolExecutor(max_workers=2) as pool:
                first, second = list(pool.map(lambda pair: runtime.create(alice_id, *pair), [
                    (home, 'create-runtime-home'), (team, 'create-runtime-team'),
                ]))
            self.assertEqual(sum(created for created, _ in [first, second]), 1)
            iid = first[1]['instance']['id']
            self.assertEqual(second[1]['instance']['id'], iid)
            reused = alice.call('POST', f'/v1/workspaces/{team}/instances', {},
                                {'HTTP_IDEMPOTENCY_KEY': 'third-runtime-request'})
            self.assertEqual(reused['status'], 200)
            self.assertEqual(reused['body']['instance']['id'], iid)
            self.assertEqual(alice.call('GET', f'/v1/instances/{iid}')['status'], 200)
            bobs = bob.call('POST', f'/v1/workspaces/{bob_home}/instances', {},
                            {'HTTP_IDEMPOTENCY_KEY': 'create-runtime-home'})
            self.assertEqual(bobs['status'], 201)
            self.assertNotEqual(bobs['body']['instance']['id'], iid)
            self.assertNotEqual(bobs['body']['instance']['volume_ref'], first[1]['instance']['volume_ref'])
            self.assertEqual(bob.call('GET', f'/v1/instances/{iid}')['status'], 404)
            shared = bob.call('GET', f'/v1/workspaces/{home}/instances')
            self.assertEqual([row['id'] for row in shared['body']['items']],
                             [bobs['body']['instance']['id']])
            for wid in (home, team):
                rows = alice.call('GET', f'/v1/workspaces/{wid}/instances')
                self.assertEqual(rows['status'], 200)
                self.assertEqual([row['id'] for row in rows['body']['items']], [iid])
