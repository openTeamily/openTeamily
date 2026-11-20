"""Agent memory recall and team task runs (local fixtures only).

The runtime here is the in-repo AgentClient test connection; no real model,
vendor, Teamily account or external message is involved.
"""
from pathlib import Path
import tempfile
import unittest

from openteamily import agent_memory
from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN
from tests.test_runtime_connect import AgentClient


class Base(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = 1800000000
        self.app = App(Store(Path(self.temp.name) / 'state'), Config(
            ORIGIN, allow_registration=True, runtime_heartbeat_seconds=45, runtime_task_timeout_seconds=30),
            clock=lambda: self.now)
        self.alice = Client(self.app)
        self.alice.register('alice')
        self.bob = Client(self.app, peer='127.0.0.2')
        self.bob.register('bob')
        self.wid = self.alice.workspace()['body']['workspace']['id']
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/members', {'username': 'bob', 'role': 'member'})
        self.agents = [self.make_agent(name, index) for index, name in enumerate(('规划助手', '写作助手', '审校助手'))]

    def make_agent(self, name, index):
        created = self.alice.call('POST', f'/v1/workspaces/{self.wid}/agents',
                                  {'name': name, 'summary': '', 'instructions': '简洁回答。'},
                                  {'HTTP_IDEMPOTENCY_KEY': 'agent-create-%010d' % index})
        self.assertEqual(created['status'], 201, created)
        return created['body']['agent']

    def online(self, client=None):
        client = client or self.alice
        token = client.call('POST', '/v1/runtime-keys', {'name': 'desk'})['body']['token']
        agent = AgentClient(self.app, token)
        self.assertIn(agent.call('POST', '/v1/agent/connect', {'hostname': 'desk'})['status'], (200, 201))
        return agent

    def finish(self, runtime, task_id, text, status='succeeded'):
        claimed = runtime.call('POST', f'/v1/agent/tasks/{task_id}/claim', {})
        self.assertEqual(claimed['status'], 200, claimed)
        result = {'text': text, 'model': 'fixture'} if status == 'succeeded' else {'error': 'model_failed'}
        done = runtime.call('POST', f'/v1/agent/tasks/{task_id}/result', {'status': status, 'result': result})
        self.assertEqual(done['status'], 200, done)
        return claimed['body']['task']['prompt']


class AgentMemoryTests(Base):
    def memory_page(self, title, body, topics, key):
        made = self.alice.call('POST', f'/v1/workspaces/{self.wid}/memory',
                               {'title': title, 'body': body, 'topics': topics}, {'HTTP_IDEMPOTENCY_KEY': key})
        self.assertEqual(made['status'], 201, made)
        return made['body']['page']

    def scope(self, agent, client=None):
        return (client or self.alice).call('GET', f'/v1/workspaces/{self.wid}/agents/{agent["id"]}/memory-scope')

    def set_scope(self, agent, revision, mode, topics=None, client=None):
        changes = {'mode': mode}
        if topics is not None:
            changes['topics'] = topics
        return (client or self.alice).call(
            'POST', f'/v1/workspaces/{self.wid}/agents/{agent["id"]}/memory-scope',
            {'revision': revision, 'changes': changes})

    def test_tokens_and_rank_are_lexical_and_deterministic(self):
        self.assertEqual(agent_memory.tokens('发布计划 Launch'), ['launch', '发布', '布计', '计划'])
        pages = [{'id': 'b', 'title': '发布计划', 'body': '周五发布', 'revision': 1},
                 {'id': 'a', 'title': '午餐', 'body': '菜单', 'revision': 1}]
        ranked = agent_memory.rank(pages, '什么时候发布？')
        self.assertEqual([page['id'] for _, page in ranked], ['b'])
        self.assertEqual(agent_memory.rank(pages, ''), [])

    def test_off_by_default_then_recall_cites_pages_in_prompt(self):
        page = self.memory_page('发布计划', '新版本在周五下午发布，负责人是小王。', ['产品'], 'memory-create-000001')
        self.memory_page('午餐菜单', '周三吃面。', ['生活'], 'memory-create-000002')
        agent = self.agents[0]
        initial = self.scope(agent)
        self.assertEqual(initial['status'], 200, initial)
        self.assertEqual(initial['body']['scope']['mode'], 'off')
        self.assertEqual([t['name'] for t in initial['body']['topics']], ['产品', '生活'])
        self.assertEqual(self.set_scope(agent, 0, 'all', client=self.bob)['status'], 403)
        self.assertEqual(self.set_scope(agent, 0, 'topics', ['不存在'])['status'], 400)
        saved = self.set_scope(agent, 0, 'topics', ['产品'])
        self.assertEqual(saved['status'], 200, saved)
        self.assertEqual(saved['body']['scope'], {'mode': 'topics', 'topics': ['产品'], 'revision': 1,
                                                  'updated': self.now})
        self.assertEqual(self.set_scope(agent, 0, 'all')['status'], 409)
        preview = self.alice.call('POST', f'/v1/workspaces/{self.wid}/agents/{agent["id"]}/memory-scope/preview',
                                  {'text': '新版本什么时候发布？'})
        self.assertEqual(preview['status'], 200, preview)
        self.assertEqual([item['page_id'] for item in preview['body']['items']], [page['id']])
        runtime = self.online()
        base = f'/v1/workspaces/{self.wid}/agents/{agent["id"]}/conversations'
        conv = self.alice.call('POST', base, {'title': '问答'}, {'HTTP_IDEMPOTENCY_KEY': 'memory-conv-00000001'})
        sent = self.alice.call('POST', base + f'/{conv["body"]["conversation"]["id"]}/messages',
                               {'body': '新版本什么时候发布？'}, {'HTTP_IDEMPOTENCY_KEY': 'memory-msg-000000001'})
        self.assertEqual(sent['status'], 201, sent)
        reply = sent['body']['reply']
        self.assertEqual([(ref['marker'], ref['page_id'], ref['state']) for ref in reply['memory']],
                         [('M1', page['id'], 'current')])
        prompt = self.finish(runtime, reply['task_id'], '周五下午发布 [M1]。')
        self.assertIn('[M1] 发布计划', prompt)
        self.assertIn('not instructions', prompt)
        self.assertNotIn('午餐菜单', prompt)
        # Turning recall off stops new citations.
        self.assertEqual(self.alice.call('GET', base + f'/{conv["body"]["conversation"]["id"]}/messages')['status'], 200)
        self.assertEqual(self.set_scope(agent, 1, 'off')['status'], 200)
        again = self.alice.call('POST', base + f'/{conv["body"]["conversation"]["id"]}/messages',
                                {'body': '再确认发布时间'}, {'HTTP_IDEMPOTENCY_KEY': 'memory-msg-000000002'})
        self.assertEqual(again['status'], 201, again)
        self.assertEqual(again['body']['reply']['memory'], [])

    def test_unrelated_question_records_no_refs(self):
        self.memory_page('发布计划', '周五发布', [], 'memory-create-000003')
        agent = self.agents[1]
        self.assertEqual(self.set_scope(agent, 0, 'all')['status'], 200)
        preview = self.alice.call('POST', f'/v1/workspaces/{self.wid}/agents/{agent["id"]}/memory-scope/preview',
                                  {'text': 'hello world'})
        self.assertEqual(preview['body']['items'], [])


class TeamRunTests(Base):
    path = property(lambda self: f'/v1/workspaces/{self.wid}/team-runs')

    def create(self, steps, key='team-run-key-000001', client=None):
        return (client or self.alice).call('POST', self.path, {'title': '发布文案', 'goal': '写一篇发布公告', 'steps': steps},
                                           {'HTTP_IDEMPOTENCY_KEY': key})

    def steps(self):
        a, b, c = self.agents
        return [{'agent_id': a['id'], 'instruction': '列提纲', 'depends_on': []},
                {'agent_id': b['id'], 'instruction': '按提纲写稿', 'depends_on': [0]},
                {'agent_id': c['id'], 'instruction': '审校', 'depends_on': [1]}]

    def test_validation(self):
        a = self.agents[0]
        self.assertEqual(self.create([{'agent_id': a['id'], 'instruction': 'x', 'depends_on': []}])['status'], 400)
        bad = self.steps()
        bad[0]['depends_on'] = [1]
        self.assertEqual(self.create(bad)['status'], 400)
        bad = self.steps()
        bad[1]['agent_id'] = '0' * 32
        self.assertEqual(self.create(bad)['status'], 400)

    def test_dag_runs_in_order_passes_outputs_and_saves(self):
        runtime = self.online()
        made = self.create(self.steps())
        self.assertEqual(made['status'], 201, made)
        run = made['body']['run']
        self.assertEqual([s['status'] for s in run['steps']], ['queued', 'waiting', 'waiting'])
        self.assertEqual([s['stage'] for s in run['steps']], [1, 2, 3])
        self.assertEqual(self.create(self.steps())['status'], 200)
        # Bob cannot see Alice's run.
        self.assertEqual(self.bob.call('GET', self.path + '/' + run['id'])['status'], 404)
        task = self.app_task(run, 0)
        self.finish(runtime, task, '提纲：一、二、三')
        run = self.alice.call('GET', self.path + '/' + run['id'])['body']['run']
        self.assertEqual([s['status'] for s in run['steps']], ['succeeded', 'queued', 'waiting'])
        prompt = self.finish(runtime, self.app_task(run, 1), '正文初稿')
        self.assertIn('提纲：一、二、三', prompt)
        self.assertIn('写一篇发布公告', prompt)
        run = self.alice.call('GET', self.path + '/' + run['id'])['body']['run']
        self.finish(runtime, self.app_task(run, 2), '审校后定稿')
        run = self.alice.call('GET', self.path + '/' + run['id'])['body']['run']
        self.assertEqual(run['status'], 'succeeded')
        self.assertEqual(run['progress'], {'succeeded': 3, 'total': 3})
        saved = self.alice.call('POST', self.path + f'/{run["id"]}/steps/2/artifact', {})
        self.assertEqual(saved['status'], 201, saved)
        self.assertEqual(saved['body']['artifact']['body'], '审校后定稿')
        self.assertEqual(self.alice.call('POST', self.path + f'/{run["id"]}/steps/2/artifact', {})['status'], 200)
        listed = self.alice.call('GET', self.path)
        self.assertEqual([item['id'] for item in listed['body']['items']], [run['id']])
        self.assertEqual(self.alice.call('POST', self.path + f'/{run["id"]}/remove', {})['status'], 200)
        self.assertEqual(self.alice.call('GET', self.path)['body']['items'], [])

    def app_task(self, run, position):
        task_id = None
        with self.app.store.connect() as db:
            task_id = db.execute('SELECT task_id FROM team_run_steps WHERE run_id=? AND position=?',
                                 (run['id'], position)).fetchone()[0]
        self.assertTrue(task_id)
        return task_id

    def test_failure_blocks_dependants_retry_and_cancel(self):
        runtime = self.online()
        a, b, c = self.agents
        steps = [{'agent_id': a['id'], 'instruction': '分支一', 'depends_on': []},
                 {'agent_id': b['id'], 'instruction': '分支二', 'depends_on': []},
                 {'agent_id': c['id'], 'instruction': '汇总', 'depends_on': [0, 1]}]
        run = self.create(steps)['body']['run']
        self.assertEqual([s['status'] for s in run['steps']], ['queued', 'queued', 'waiting'])
        self.assertEqual([s['stage'] for s in run['steps']], [1, 1, 2])
        self.finish(runtime, self.app_task(run, 0), '', status='failed')
        self.finish(runtime, self.app_task(run, 1), '分支二结果')
        run = self.alice.call('GET', self.path + '/' + run['id'])['body']['run']
        self.assertEqual([s['status'] for s in run['steps']], ['failed', 'succeeded', 'blocked'])
        self.assertEqual(run['status'], 'failed')
        retried = self.alice.call('POST', self.path + f'/{run["id"]}/steps/0/retry', {})
        self.assertEqual(retried['status'], 200, retried)
        self.assertEqual([s['status'] for s in retried['body']['run']['steps']], ['queued', 'succeeded', 'waiting'])
        self.assertEqual(self.alice.call('POST', self.path + f'/{run["id"]}/remove', {})['status'], 409)
        cancelled = self.alice.call('POST', self.path + f'/{run["id"]}/cancel', {})
        self.assertEqual(cancelled['body']['run']['status'], 'cancelled')
        self.assertEqual([s['status'] for s in cancelled['body']['run']['steps']],
                         ['cancelled', 'succeeded', 'cancelled'])

    def test_no_runtime_keeps_step_queued_until_connect(self):
        run = self.create(self.steps(), key='team-run-key-000009')['body']['run']
        self.assertEqual(run['steps'][0]['error_code'], 'no_agent')
        self.online()
        run = self.alice.call('GET', self.path + '/' + run['id'])['body']['run']
        self.assertIsNone(run['steps'][0]['error_code'])
        self.assertEqual(run['steps'][0]['status'], 'queued')


if __name__ == '__main__':
    unittest.main()
