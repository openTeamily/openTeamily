"""Public agent homepage tests (issue #6). In-process WSGI + temporary SQLite only.

These tests prove share-link access control and the recorded public
profile typography. They are not browser E2E, embeddable conversations,
a live container run, or Teamily parity.
"""
from pathlib import Path
import re
import sqlite3
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN
from tests.test_settings_page import RawClient


class AgentHomepageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'state'
        self.app = App(Store(self.path), Config(ORIGIN, allow_registration=True), clock=lambda: 1800000000)
        self.alice = Client(self.app)
        self.alice.register('alice')
        self.bob = Client(self.app, peer='127.0.0.2')
        self.bob.register('bob')
        self.carol = Client(self.app, peer='127.0.0.3')
        self.carol.register('carol')
        self.wid = self.alice.workspace()['body']['workspace']['id']
        self.guest = RawClient(self.app)

    def create(self, client=None, name='文档助手', summary='整理笔记', instructions='系统提示请保密。',
               key='agent-home-create-01'):
        client = client or self.alice
        created = client.call(
            'POST', f'/v1/workspaces/{self.wid}/agents',
            {'name': name, 'summary': summary, 'instructions': instructions},
            {'HTTP_IDEMPOTENCY_KEY': key})
        self.assertEqual(created['status'], 201, created)
        return created['body']['agent']

    def publish(self, client, agent_id, **kw):
        return client.call('POST', f'/v1/workspaces/{self.wid}/agents/{agent_id}/homepage', {}, **kw)

    def test_default_is_restricted_and_unknown_tokens_are_404(self):
        item = self.create()
        self.assertEqual(item['homepage'], {'visibility': 'restricted'})
        self.assertEqual(item['quick_starts'], [])
        self.assertNotIn('token', item)
        self.assertNotIn('token', item['homepage'])
        listed = self.alice.call('GET', f'/v1/workspaces/{self.wid}/agents')
        self.assertEqual(listed['body']['items'][0]['homepage']['visibility'], 'restricted')
        missing = self.guest.call('GET', '/a/' + ('A' * 43), origin=None)
        self.assertEqual(missing['status'], 404)
        self.assertNotIn('系统提示'.encode(), missing['body'])

    def test_publish_shows_token_once_and_public_page_hides_instructions(self):
        item = self.create()
        published = self.publish(self.alice, item['id'])
        self.assertEqual(published['status'], 201, published)
        home = published['body']['agent']['homepage']
        self.assertEqual(home['visibility'], 'public')
        self.assertEqual(home['prefix'], home['token'][:8])
        self.assertEqual(home['path'], '/a/' + home['token'])
        token = home['token']
        seen = self.alice.call('GET', f'/v1/workspaces/{self.wid}/agents/{item["id"]}')
        self.assertEqual(seen['status'], 200)
        self.assertEqual(seen['body']['agent']['homepage']['visibility'], 'public')
        self.assertEqual(seen['body']['agent']['homepage']['prefix'], token[:8])
        self.assertNotIn('token', seen['body']['agent']['homepage'])
        self.assertNotIn('path', seen['body']['agent']['homepage'])
        listed = self.alice.call('GET', f'/v1/workspaces/{self.wid}/agents/{item["id"]}/homepage')
        self.assertNotIn('token', listed['body']['agent']['homepage'])
        page = self.guest.call('GET', '/a/' + token, origin=None)
        self.assertEqual(page['status'], 200, page)
        html = page['body'].decode()
        self.assertIn('文档助手', html)
        self.assertIn('整理笔记', html)
        self.assertIn('OpenTeamily', html)
        self.assertIn('brand-mark', html)
        self.assertNotIn('OpenTeamily / FlyBot', html)
        self.assertIn('Agent profile', html)
        self.assertIn('Public page', html)
        self.assertIn('Talk via', html)
        self.assertIn('Web conversation', html)
        self.assertIn('Talk directly with 文档助手.', html)
        self.assertIn('Built with FlyBot', html)
        self.assertIn('Create your own Agent', html)
        self.assertIn('disabled', html)
        self.assertIn('未接通：公开主页不会发送消息。', html)
        self.assertIn('未接通：还没有开场提示。', html)
        self.assertIn('href="/agents"', html)
        self.assertIn('打开工作区智能体页。公开主页不会直接创建智能体。', html)
        self.assertIn('does not run a conversation', html)
        self.assertNotIn('Help me organize today\'s priorities', html)
        self.assertNotIn('Create something with my team', html)
        self.assertNotIn('Connect a messaging channel', html)
        self.assertNotIn('AVAILABLE NOW', html)
        self.assertNotIn('LIVE', html)
        self.assertIsNone(re.search(r'(?<!Open)Teamily', html))
        self.assertNotIn('系统提示请保密。', html)
        self.assertNotIn(item['id'], html)
        self.assertNotIn(self.wid, html)
        self.assertNotIn(token, html)
        self.assertIn('>文<', html)  # letter avatar, not a copied mark
        self.assertIn('text/html', page['headers']['Content-Type'])
        self.assertIn("frame-ancestors 'none'", page['headers']['Content-Security-Policy'])
        self.assertEqual(page['headers']['X-Frame-Options'], 'DENY')
        self.assertEqual(page['headers']['Cache-Control'], 'no-store')
        same_origin = self.guest.call('GET', '/a/' + token)
        self.assertEqual(same_origin['status'], 200)

    def test_members_can_read_but_only_owners_and_admins_publish(self):
        item = self.create()
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/members',
                        {'username': 'bob', 'role': 'member'})
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/members',
                        {'username': 'carol', 'role': 'admin'})
        self.assertEqual(self.publish(self.bob, item['id'])['status'], 403)
        self.assertEqual(self.bob.call('GET', f'/v1/workspaces/{self.wid}/agents/{item["id"]}/homepage')['status'], 200)
        outsider = Client(self.app, peer='127.0.0.4')
        outsider.register('drew')
        self.assertEqual(self.publish(outsider, item['id'])['status'], 404)
        self.assertEqual(
            outsider.call('GET', f'/v1/workspaces/{self.wid}/agents/{item["id"]}/homepage')['status'], 404)
        published = self.publish(self.carol, item['id'])
        self.assertEqual(published['status'], 201, published)
        token = published['body']['agent']['homepage']['token']
        self.assertEqual(self.guest.call('GET', '/a/' + token, origin=None)['status'], 200)
        member_view = self.bob.call('GET', f'/v1/workspaces/{self.wid}/agents/{item["id"]}')
        self.assertEqual(member_view['body']['agent']['homepage']['prefix'], token[:8])
        self.assertNotIn('token', member_view['body']['agent']['homepage'])

    def test_revoke_rotate_archive_and_csrf(self):
        item = self.create()
        first = self.publish(self.alice, item['id'])
        token = first['body']['agent']['homepage']['token']
        self.assertEqual(self.guest.call('GET', '/a/' + token, origin=None)['status'], 200)
        revoked = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/agents/{item["id"]}/homepage/revoke', {})
        self.assertEqual(revoked['status'], 200, revoked)
        self.assertEqual(revoked['body']['agent']['homepage'], {'visibility': 'restricted'})
        self.assertEqual(self.guest.call('GET', '/a/' + token, origin=None)['status'], 404)
        rotated = self.publish(self.alice, item['id'])
        self.assertEqual(rotated['status'], 201, rotated)
        new_token = rotated['body']['agent']['homepage']['token']
        self.assertNotEqual(new_token, token)
        self.assertEqual(self.guest.call('GET', '/a/' + token, origin=None)['status'], 404)
        self.assertEqual(self.guest.call('GET', '/a/' + new_token, origin=None)['status'], 200)
        archived = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/agents/{item["id"]}/archive', {'revision': 1})
        self.assertEqual(archived['status'], 200, archived)
        self.assertEqual(archived['body']['agent']['homepage'], {'visibility': 'restricted'})
        self.assertEqual(self.guest.call('GET', '/a/' + new_token, origin=None)['status'], 404)
        self.assertEqual(
            self.publish(self.alice, item['id'])['status'], 409)
        fresh = self.create(name='第二个', key='agent-home-create-02')
        self.assertEqual(self.publish(self.alice, fresh['id'], csrf=False)['status'], 403)
        self.assertEqual(
            self.publish(self.alice, fresh['id'], origin='https://evil.test')['status'], 403)
        anonymous = Client(self.app)
        self.assertEqual(self.publish(anonymous, fresh['id'])['status'], 401)
        self.assertEqual(self.guest.call('POST', '/a/' + ('B' * 43), origin=None)['status'], 400)
        self.assertEqual(self.guest.call('GET', '/a/' + ('B' * 43), query='x=1', origin=None)['status'], 400)

    def test_homepage_typography_escapes_name_and_omits_unverified_chrome(self):
        from openteamily.agents import render_homepage
        html = render_homepage({
            'name': '<Script>Bot',
            'summary': 'Hello & goodbye',
        })
        self.assertIn('&lt;Script&gt;Bot', html)
        self.assertIn('Hello &amp; goodbye', html)
        self.assertIn('>S<', html)
        self.assertNotIn('<Script>', html)
        self.assertIsNone(re.search(r'(?<!Open)Teamily', html))
        self.assertNotIn('AVAILABLE NOW', html)
        self.assertIn('placeholder="Message &lt;Script&gt;Bot on the web…"', html)
        self.assertIn('disabled', html)
        self.assertIn('未接通：还没有开场提示。', html)
        self.assertNotIn('Help me organize today\'s priorities', html)
        self.assertIn('href="/agents"', html)
        filled = render_homepage({
            'name': '<Script>Bot',
            'summary': 'Hello & goodbye',
        }, ['Ask & <script>alert(1)</script>', 'List what this assistant covers'])
        self.assertIn('Ask &amp; &lt;script&gt;alert(1)&lt;/script&gt;', filled)
        self.assertNotIn('<script>alert(1)</script>', filled)
        self.assertIn('List what this assistant covers', filled)
        self.assertIn('Quick starts', filled)
        self.assertIn('点击开场会在聊天里发起对话', filled)
        self.assertIn('href="/chat?start=0"', filled)
        self.assertIn('href="/chat?start=1"', filled)
        self.assertIn('未接通：公开主页不会发送消息。', filled)
        self.assertNotIn('Help me organize today\'s priorities', filled)

    def test_quick_starts_are_optional_public_strings_and_never_leak_instructions(self):
        item = self.create()
        url = f'/v1/workspaces/{self.wid}/agents/{item["id"]}'
        too_many = self.alice.call('POST', url, {
            'revision': 1,
            'quick_starts': ['one', 'two', 'three', 'four', 'five', 'six'],
        })
        self.assertEqual(too_many['status'], 400, too_many)
        invalid = self.alice.call('POST', url, {'revision': 1, 'quick_starts': 'not-a-list'})
        self.assertEqual(invalid['status'], 400, invalid)
        control = self.alice.call('POST', url, {'revision': 1, 'quick_starts': ['ok\x07']})
        # actual control char below
        control = self.alice.call('POST', url, {'revision': 1, 'quick_starts': ['ok' + chr(7)]})
        self.assertEqual(control['status'], 400, control)
        set_ = self.alice.call('POST', url, {
            'revision': 1,
            'quick_starts': [
                '  Ask how this fixture agent is organized  ',
                'Request a walkthrough of the directory',
            ],
        })
        self.assertEqual(set_['status'], 200, set_)
        self.assertEqual(set_['body']['agent']['quick_starts'], [
            'Ask how this fixture agent is organized',
            'Request a walkthrough of the directory',
        ])
        self.assertEqual(set_['body']['agent']['revision'], 2)
        kept = self.alice.call('POST', url, {'revision': 2, 'summary': '整理笔记，并说明范围'})
        self.assertEqual(kept['status'], 200, kept)
        self.assertEqual(kept['body']['agent']['quick_starts'], [
            'Ask how this fixture agent is organized',
            'Request a walkthrough of the directory',
        ])
        published = self.publish(self.alice, item['id'])
        self.assertEqual(published['status'], 201, published)
        token = published['body']['agent']['homepage']['token']
        page = self.guest.call('GET', '/a/' + token, origin=None)
        self.assertEqual(page['status'], 200, page)
        html = page['body'].decode()
        self.assertIn('Ask how this fixture agent is organized', html)
        self.assertIn('Request a walkthrough of the directory', html)
        self.assertIn('Quick starts', html)
        self.assertIn('Start a conversation', html)
        self.assertNotIn('系统提示请保密。', html)
        self.assertNotIn('Help me organize today\'s priorities', html)
        cleared = self.alice.call('POST', url, {'revision': 3, 'quick_starts': []})
        self.assertEqual(cleared['status'], 200, cleared)
        self.assertEqual(cleared['body']['agent']['quick_starts'], [])
        empty = self.guest.call('GET', '/a/' + token, origin=None)
        self.assertIn('未接通：还没有开场提示。', empty['body'].decode())
        self.assertNotIn('Ask how this fixture agent is organized', empty['body'].decode())
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/members',
                        {'username': 'bob', 'role': 'member'})
        member = self.bob.call('POST', url, {'revision': 4, 'quick_starts': ['Nope']})
        self.assertEqual(member['status'], 403, member)

    def test_existing_v1_database_gains_the_homepage_table(self):
        self.create()
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            db.execute('DROP TABLE workspace_agent_homepages')
            db.execute('DROP TABLE workspace_agent_quick_starts')
            db.commit()
        Store(self.path)
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 1)
            names = {
                row[0] for row in db.execute(
                    "SELECT name FROM sqlite_master WHERE name IN "
                    "('workspace_agent_homepages','workspace_agent_quick_starts')"
                )
            }
            self.assertEqual(names, {'workspace_agent_homepages', 'workspace_agent_quick_starts'})



    def test_homepage_quick_start_opens_a_member_conversation(self):
        item = self.create()
        updated = self.alice.call('POST', f'/v1/workspaces/{self.wid}/agents/{item["id"]}', {
            'revision': 1,
            'quick_starts': ['列出这个助手能做什么', '介绍目录怎么组织'],
        })
        self.assertEqual(updated['status'], 200, updated)
        published = self.publish(self.alice, item['id'])
        token = published['body']['agent']['homepage']['token']
        page = self.alice.call('GET', '/a/' + token, origin=None, parse='raw')
        self.assertEqual(page['status'], 200, page)
        html = page['body'].decode()
        self.assertIn('href="/chat?start=0"', html)
        self.assertIn('href="/chat?start=1"', html)
        self.assertNotIn(token, html)
        self.assertNotIn(item['id'], html)
        self.assertNotIn(self.wid, html)
        self.assertNotIn('系统提示请保密。', html)
        headers = {key: value for key, value in page['headers']}
        self.assertIn("frame-ancestors 'none'", headers['Content-Security-Policy'])
        self.assertIn('sandbox', headers['Content-Security-Policy'])
        self.assertIn("form-action 'none'", headers['Content-Security-Policy'])
        cookie_name = self.app.homepage_cookie_name()
        self.assertEqual(self.alice.cookies.get(cookie_name), token)
        started = self.alice.call(
            'POST', '/v1/agent-homepages/start', {'quick_start': 0},
            {'HTTP_IDEMPOTENCY_KEY': 'home-start-alice-0001'})
        self.assertEqual(started['status'], 201, started)
        conversation = started['body']['conversation']
        self.assertEqual(conversation['workspace_id'], self.wid)
        self.assertEqual(conversation['agent_id'], item['id'])
        self.assertEqual(started['body']['message']['body'], '列出这个助手能做什么')
        self.assertEqual(started['body']['message']['role'], 'user')
        self.assertEqual(conversation['title'], '列出这个助手能做什么')
        replay = self.alice.call(
            'POST', '/v1/agent-homepages/start', {'quick_start': 0},
            {'HTTP_IDEMPOTENCY_KEY': 'home-start-alice-0001'})
        self.assertEqual(replay['status'], 200, replay)
        self.assertEqual(replay['body']['conversation']['id'], conversation['id'])
        conflict = self.alice.call(
            'POST', '/v1/agent-homepages/start', {'quick_start': 1},
            {'HTTP_IDEMPOTENCY_KEY': 'home-start-alice-0001'})
        self.assertEqual(conflict['status'], 409, conflict)

    def test_homepage_quick_start_rejects_outsiders_and_invalid_input(self):
        item = self.create()
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/agents/{item["id"]}', {
            'revision': 1,
            'quick_starts': ['列出这个助手能做什么'],
        })
        token = self.publish(self.alice, item['id'])['body']['agent']['homepage']['token']
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/members',
                        {'username': 'bob', 'role': 'member'})
        self.assertEqual(self.bob.call('GET', '/a/' + token, origin=None, parse='raw')['status'], 200)
        member = self.bob.call(
            'POST', '/v1/agent-homepages/start', {'quick_start': 0},
            {'HTTP_IDEMPOTENCY_KEY': 'home-start-bob-0001'})
        self.assertEqual(member['status'], 201, member)
        self.assertEqual(member['body']['message']['body'], '列出这个助手能做什么')
        drew = Client(self.app, peer='127.0.0.4')
        drew.register('drew')
        self.assertEqual(drew.call('GET', '/a/' + token, origin=None, parse='raw')['status'], 200)
        outsider = drew.call(
            'POST', '/v1/agent-homepages/start', {'quick_start': 0},
            {'HTTP_IDEMPOTENCY_KEY': 'home-start-drew-0001'})
        self.assertEqual(outsider['status'], 404, outsider)
        missing = self.carol.call(
            'POST', '/v1/agent-homepages/start', {'quick_start': 0},
            {'HTTP_IDEMPOTENCY_KEY': 'home-start-carol-0001'})
        self.assertEqual(missing['status'], 400, missing)
        self.alice.call('GET', '/a/' + token, origin=None, parse='raw')
        self.assertEqual(self.alice.call(
            'POST', '/v1/agent-homepages/start', {'quick_start': 4},
            {'HTTP_IDEMPOTENCY_KEY': 'home-start-alice-bad-1'})['status'], 400)
        self.assertEqual(self.alice.call(
            'POST', '/v1/agent-homepages/start', {'quick_start': True},
            {'HTTP_IDEMPOTENCY_KEY': 'home-start-alice-bad-2'})['status'], 400)
        self.assertEqual(self.alice.call(
            'POST', '/v1/agent-homepages/start', {'quick_start': 0},
            {'HTTP_IDEMPOTENCY_KEY': 'home-start-alice-csrf'}, csrf=False)['status'], 403)
        anonymous = Client(self.app)
        self.assertEqual(anonymous.call(
            'POST', '/v1/agent-homepages/start', {'quick_start': 0},
            {'HTTP_IDEMPOTENCY_KEY': 'home-start-anon-0001'})['status'], 401)
        revoked = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/agents/{item["id"]}/homepage/revoke', {})
        self.assertEqual(revoked['status'], 200, revoked)
        gone = self.alice.call(
            'POST', '/v1/agent-homepages/start', {'quick_start': 0},
            {'HTTP_IDEMPOTENCY_KEY': 'home-start-alice-revoked'})
        self.assertEqual(gone['status'], 404, gone)


if __name__ == '__main__':
    unittest.main()
