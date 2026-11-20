"""Opt-in public agent catalog (issue #87). Public listing is a whitelisted projection."""
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class DiscoverTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = 1800000000
        self.app = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                       clock=lambda: self.now)
        self.alice = Client(self.app)
        self.alice.register('alice')
        self.bob = Client(self.app, peer='127.0.0.2')
        self.bob.register('bob')
        self.eve = Client(self.app, peer='127.0.0.3')
        self.eve.register('eve')
        self.anon = Client(self.app, peer='127.0.0.9')
        self.wid = self.alice.workspace()['body']['workspace']['id']
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/members',
                        {'username': 'bob', 'role': 'member'})
        self.agent = self._agent(self.alice, '值班助手', '简短的中文回答', 'secret instructions')

    def _agent(self, client, name, summary, instructions):
        created = client.call(
            'POST', f'/v1/workspaces/{self.wid}/agents',
            {'name': name, 'summary': summary, 'instructions': instructions},
            {'HTTP_IDEMPOTENCY_KEY': 'discover-agent-' + name.encode().hex()[:24]})
        self.assertEqual(created['status'], 201, created)
        return created['body']['agent']

    def publish(self, client, agent, slug, workspace_id=None):
        return client.call('POST', f'/v1/workspaces/{workspace_id or self.wid}/agents/{agent["id"]}/discover',
                           {'slug': slug})

    def test_publish_lists_only_the_public_projection(self):
        empty = self.anon.call('GET', '/v1/discover/agents')
        self.assertEqual(empty['status'], 200)
        self.assertEqual(empty['body']['items'], [])
        published = self.publish(self.alice, self.agent, 'on-call')
        self.assertEqual(published['status'], 201, published)
        self.assertEqual(published['body']['discover']['slug'], 'on-call')
        self.assertTrue(published['body']['discover']['listed'])
        listed = self.anon.call('GET', '/v1/discover/agents')
        self.assertEqual(listed['status'], 200)
        self.assertEqual(len(listed['body']['items']), 1)
        item = listed['body']['items'][0]
        self.assertEqual(item['slug'], 'on-call')
        self.assertEqual(item['name'], '值班助手')
        self.assertEqual(item['summary'], '简短的中文回答')
        self.assertEqual(set(item), {'slug', 'name', 'summary', 'updated'})
        self.assertNotIn('secret instructions', str(listed['body']))
        self.assertNotIn(self.wid, str(listed['body']))
        search = self.anon.call('GET', '/v1/discover/agents?q=中文')
        self.assertEqual(len(search['body']['items']), 1)
        self.assertEqual(self.anon.call('GET', '/v1/discover/agents?q=missing')['body']['items'], [])
        read = self.alice.call('GET', f'/v1/workspaces/{self.wid}/agents/{self.agent["id"]}/discover')
        self.assertEqual(read['body']['discover']['slug'], 'on-call')
        again = self.publish(self.alice, self.agent, 'on-call')
        self.assertEqual(again['status'], 200)

    def test_permissions_conflict_and_validation(self):
        self.assertEqual(self.publish(self.bob, self.agent, 'bob-slug')['status'], 403)
        self.assertEqual(self.publish(self.eve, self.agent, 'eve-slug')['status'], 404)
        self.assertEqual(self.publish(self.alice, self.agent, 'Bad Slug')['status'], 400)
        self.assertEqual(self.publish(self.alice, self.agent, 'settings')['status'], 400)
        self.assertEqual(self.publish(self.alice, self.agent, 'on-call')['status'], 201)
        other = self._agent(self.alice, '另一个', '', '')
        conflict = self.publish(self.alice, other, 'on-call')
        self.assertEqual(conflict['status'], 409)
        revoked = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/agents/{self.agent["id"]}/discover/revoke', {})
        self.assertEqual(revoked['status'], 200)
        self.assertFalse(revoked['body']['discover']['listed'])
        self.assertEqual(self.anon.call('GET', '/v1/discover/agents')['body']['items'], [])
        self.assertEqual(self.bob.call(
            'POST', f'/v1/workspaces/{self.wid}/agents/{self.agent["id"]}/discover/revoke', {})['status'], 403)

    def test_archived_agents_and_pagination(self):
        agents = [self._agent(self.alice, 'A' + str(i), '', '') for i in range(3)]
        for index, agent in enumerate(agents):
            self.assertEqual(self.publish(self.alice, agent, 'agent-' + str(index))['status'], 201)
        page = self.anon.call('GET', '/v1/discover/agents?limit=2')
        self.assertEqual([row['slug'] for row in page['body']['items']], ['agent-0', 'agent-1'])
        self.assertEqual(page['body']['cursor'], 'agent-1')
        rest = self.anon.call('GET', '/v1/discover/agents?limit=2&cursor=agent-1')
        self.assertEqual([row['slug'] for row in rest['body']['items']], ['agent-2'])
        archived = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/agents/{agents[0]["id"]}/archive', {'revision': 1})
        self.assertEqual(archived['status'], 200, archived)
        listed = self.anon.call('GET', '/v1/discover/agents?limit=10')
        self.assertNotIn('agent-0', [row['slug'] for row in listed['body']['items']])
        self.assertEqual(self.publish(self.alice, agents[0], 'archived-slug')['status'], 409)
        self.assertEqual(self.anon.call('GET', '/v1/discover/agents?limit=0')['status'], 400)
        self.assertEqual(self.anon.call('GET', '/v1/discover/agents?cursor=BAD')['status'], 400)
        self.assertEqual(self.anon.call('POST', '/v1/discover/agents')['status'], 405)


if __name__ == '__main__':
    unittest.main()


class DiscoverCatalogPageTests(unittest.TestCase):
    def test_recorded_agents_query_and_unknown_queries(self):
        from tests.test_chat_page import ChatPageTests
        case = ChatPageTests()
        case.setUp()
        try:
            feed = case.raw.call('GET', '/discover', query='')
            self.assertEqual(feed['status'], 200)
            feed_text = feed['body'].decode()
            for marker in ('id="feed-panel"', 'id="feed-query"', '搜索动态、创作者…', '关注', '动态',
                           'id="feed-following-empty"', '关注列表暂无动态',
                           '你关注的人发布动态后会显示在这里。',
                           'id="feed-activity-empty"', 'id="feed-grid"',
                           'id="feed-note"', '也不会展示奖励活动或推荐内容', 'id="catalog-view" hidden',
                           'href="/discover?tab=agents"', '热门', '3D 作品', 'AI 与科技', '美容'):
                self.assertIn(marker, feed_text, marker)
            self.assertIn('hidden', feed_text.split('id="feed-following-empty"', 1)[1].split('>', 1)[0])
            feed_filters = feed_text.split('class="feed-filters"', 1)[1].split('id="feed-following-empty"', 1)[0]
            self.assertIn('class="feed-filter-all"', feed_filters)
            self.assertIn('>全部<', feed_filters)
            self.assertIn('aria-current="true"', feed_filters.split('>全部<', 1)[0].rsplit('<button', 1)[1])
            self.assertNotIn('aria-label="全部"', feed_filters.split('class="feed-filter-all"', 1)[1].split('>', 1)[0])
            self.assertNotIn('没有单独标出文字', feed_filters)
            self.assertNotRegex(feed_filters, r'class="feed-filter-all"[^>]*></button>')
            activity_empty = feed_text.split('id="feed-activity-empty"', 1)[1].split('id="feed-note"', 1)[0]
            self.assertNotIn('hidden', activity_empty.split('>', 1)[0])
            self.assertIn('data-empty="true"', activity_empty)
            self.assertNotIn('id="feed-note"', activity_empty)
            self.assertNotIn('积分中心', feed_text)
            self.assertNotIn('最多领取', feed_text)
            self.assertNotIn('CREDITS', feed_text)
            self.assertNotIn('没有对照截图', feed_text)
            self.assertNotIn('href="/d/', feed_text)
            page = case.raw.call('GET', '/discover', query='tab=agents')
            self.assertEqual(page['status'], 200)
            text = page['body'].decode()
            for marker in ('id="catalog-query"', 'id="catalog-more"', 'id="catalog-count"',
                           'id="catalog-manage" hidden', 'id="catalog-tab-teams"', 'AI 团队', 'id="feed-panel"',
                           'id="catalog-filter-search"', 'id="catalog-filter-more"',
                           'id="catalog-creator"', 'aria-label="搜索分类"', 'aria-label="更多分类"',
                           '分类和创建者筛选未接通：公共目录没有对应字段。'):
                self.assertIn(marker, text, marker)
            filters = text.split('id="catalog-filters"', 1)[1].split('id="teams-filters"', 1)[0]
            categories = [
                '全部', 'Content Creation', 'Customer Support', 'Data Analysis', 'Design',
                'Education', 'Engineering', 'Finance', 'IT &amp; Security', 'Investment',
                'Legal', 'Life', 'Marketing',
            ]
            positions = [filters.index('>' + label + '<') for label in categories]
            self.assertEqual(positions, sorted(positions))
            self.assertIn('aria-current="true"', filters.split('>全部<', 1)[0].rsplit('<button', 1)[1])
            self.assertGreaterEqual(filters.count(' disabled '), 15)
            scroll = filters.split('class="catalog-filter-scroll"', 1)[1].split('</div>', 1)[0]
            self.assertIn('>Marketing<', scroll)
            self.assertNotIn('id="catalog-filter-search"', scroll)
            self.assertNotIn('id="catalog-filter-more"', scroll)
            self.assertIn('id="catalog-filter-search"', filters.split('</div>', 1)[1])
            creator = text.split('id="catalog-creator"', 1)[1].split('</button>', 1)[0]
            self.assertIn('disabled', creator)
            self.assertIn('创建者', creator)
            self.assertNotRegex(creator, r'(?i)teamily|积分|credits')
            self.assertIn('class="visually-hidden"', text.split('id="catalog-filter-note"', 1)[1].split('>', 1)[0])
            self.assertNotIn('href="/d/', text)
            self.assertNotIn('AI 团队（未接通）', text)
            teams = case.raw.call('GET', '/discover', query='tab=agents&section=groups')
            self.assertEqual(teams['status'], 200)
            teams_text = teams['body'].decode()
            team_filters = teams_text.split('id="teams-filters"', 1)[1].split('id="catalog-creator"', 1)[0]
            team_categories = [
                'All', 'Marketing', 'Engineering', 'IT &amp; Security', 'Content Creation',
                'Operations', 'Product', 'Data Analysis', 'Design', 'Research',
                'Investment', 'Education', 'Life', 'Sales',
            ]
            team_positions = [team_filters.index('>' + label + '<') for label in team_categories]
            self.assertEqual(team_positions, sorted(team_positions))
            team_scroll = team_filters.split('class="catalog-filter-scroll"', 1)[1].split('</div>', 1)[0]
            self.assertIn('>Sales<', team_scroll)
            self.assertNotIn('id="teams-filter-more"', team_scroll)
            self.assertIn('id="teams-filter-more"', team_filters.split('</div>', 1)[1])
            self.assertIn('aria-current="true"', team_filters.split('>All<', 1)[0].rsplit('<button', 1)[1])
            self.assertIn('+ 创建我的 AI 团队', teams_text)
            self.assertIn('data-teams-placeholder="搜索 AI 团队......"', teams_text)
            self.assertIn('公开 AI 团队目录还没有接口', teams_text)
            self.assertNotRegex(teams_text, r'(?i)Teamily AI|Full-Stack Delivery Guild|积分|credits')
            self.assertIn('hidden', teams_text.split('id="teams-filters"', 1)[1].split('>', 1)[0])
            for query in ('tab=teams', 'tab=agents&x=1', 'tab=agents&tab=agents',
                          'tab=agents&section=teams', 'section=groups'):
                self.assertEqual(case.raw.call('GET', '/discover', query=query)['status'], 400)
            # The feed tab, category and search are shareable deep links; the
            # page router only serves the screen and never reads them itself.
            for query in ('feed=following', 'feed=collected', 'feed=following&kind=video',
                          'q=cat', 'kind=image&q=cat', 'feed=following&kind=image&q=cat',
                          'q=%E4%B8%AD%E6%96%87&kind=audio'):
                self.assertEqual(case.raw.call('GET', '/discover', query=query)['status'], 200, query)
            for query in ('feed=activity', 'feed=bogus', 'feed=', 'kind=bogus', 'kind=',
                          'feed=following&feed=collected', 'q=' + 'a' * 81,
                          'feed=following&x=1', 'tab=agents&feed=following'):
                self.assertEqual(case.raw.call('GET', '/discover', query=query)['status'], 400, query)
            self.assertEqual(case.raw.call('GET', '/settings/not-a-page')['status'], 404)
        finally:
            case.doCleanups()
