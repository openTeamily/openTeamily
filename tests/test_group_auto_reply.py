"""Group Agent 主动性: one automatic reply for an un-@ message, capped per hour.

A connected runtime is required to produce the reply; without one no request row
is created and the hourly count stays untouched. The fake provider is not used
here: the runtime client claims the queued task and reports its own text.
"""
import unittest

from tests import test_social as social_tests
from tests.test_runtime_connect import AgentClient


class GroupAutoReplyTests(unittest.TestCase):
    setUp = social_tests.SocialMessengerTests.setUp
    base = social_tests.SocialMessengerTests.base
    make_agent = social_tests.SocialMessengerTests.make_agent
    _user_id = social_tests.SocialMessengerTests._user_id

    def group(self, agents=None, key='auto-reply-group-0001'):
        ids = [self.make_agent()] if agents is None else agents
        created = self.alice.call(
            'POST', self.base(), {'kind': 'group', 'member_ids': [self.bob_id], 'agent_ids': ids},
            {'HTTP_IDEMPOTENCY_KEY': key})
        self.assertEqual(created['status'], 201, created)
        self.aid = ids[0] if ids else None
        self.cid = created['body']['conversation']['id']
        return self.base() + '/' + self.cid

    def connect(self, client=None):
        token = (client or self.alice).call('POST', '/v1/runtime-keys',
                                            {'name': 'auto-desk'})['body']['token']
        agent = AgentClient(self.app, token)
        self.assertIn(agent.call('POST', '/v1/agent/connect', {'hostname': 'auto-desk'})['status'],
                      (200, 201))
        return agent

    def toggle(self, path, enabled, client=None):
        return (client or self.alice).call('POST', path + '/auto-reply', {'enabled': enabled})

    def send(self, path, text, key):
        return self.alice.call('POST', path + '/messages', {'body': text},
                               {'HTTP_IDEMPOTENCY_KEY': key})

    def snapshot(self, path, client=None):
        return (client or self.alice).call('GET', path)

    def test_toggle_permissions_validation_and_persistence(self):
        path = self.group()
        state = self.alice.call('GET', path + '/auto-reply')['body']['auto_reply']
        self.assertEqual(state, {'enabled': False, 'can_manage': True, 'available': True,
                                 'agent_name': 'Group helper', 'used': 0, 'limit': 3,
                                 'window_seconds': 3600})
        self.assertFalse(self.bob.call('GET', path + '/auto-reply')['body']['auto_reply']['can_manage'])
        self.assertEqual(self.toggle(path, True, self.bob)['status'], 403)
        self.assertEqual(self.toggle(path, True, self.carol)['status'], 404)
        self.assertEqual(self.toggle(path, 'yes')['status'], 400)
        self.assertEqual(self.alice.call('POST', path + '/auto-reply', {})['status'], 400)
        empty = self.group(agents=[], key='auto-reply-group-0002')
        self.assertEqual(self.toggle(empty, True)['status'], 400)
        self.assertFalse(self.alice.call('GET', empty + '/auto-reply')['body']['auto_reply']['available'])
        enabled = self.toggle(path, True)
        self.assertEqual(enabled['status'], 200, enabled)
        self.assertTrue(enabled['body']['auto_reply']['enabled'])
        detail = self.snapshot(path)['body']
        self.assertTrue(detail['auto_reply']['enabled'])
        self.assertEqual(self.toggle(path, False)['body']['auto_reply']['enabled'], False)
        self.assertFalse(self.snapshot(path)['body']['auto_reply']['enabled'])

    def test_disabled_group_never_autoreplies(self):
        path = self.group()
        agent = self.connect()
        self.assertEqual(self.send(path, '这条没有点名任何人', 'auto-msg-00000001')['status'], 201)
        self.assertEqual(self.snapshot(path)['body']['agent_replies'], [])
        self.assertTrue(self.toggle(path, True)['body']['auto_reply']['enabled'])
        self.assertEqual(self.send(path, '开启后的第一条', 'auto-msg-00000002')['status'], 201)
        replies = self.snapshot(path)['body']['agent_replies']
        self.assertEqual(len(replies), 1, replies)
        self.assertEqual(replies[0]['status'], 'queued')
        self.assertEqual(replies[0]['agent_id'], self.aid)
        self.assertEqual(replies[0]['requested_by'],
                         self.alice.call('GET', '/v1/auth/session')['body']['user']['id'])
        tid = replies[0]['task_id']
        self.assertEqual(agent.call('POST', f'/v1/agent/tasks/{tid}/claim', {})['status'], 200)
        self.assertEqual(agent.call('POST', f'/v1/agent/tasks/{tid}/result', {
            'status': 'succeeded', 'result': {'text': '自动回复：收到'}})['status'], 200)
        detail = self.snapshot(path)['body']
        agent_messages = [item for item in detail['items'] if item.get('role') == 'agent']
        self.assertEqual([item['body'] for item in agent_messages], ['自动回复：收到'])
        self.assertEqual(detail['auto_reply']['used'], 1)

    def test_hourly_cap_three_and_at_mentions_are_not_automatic(self):
        path = self.group()
        agent = self.connect()
        self.toggle(path, True)
        for index in range(4):
            self.assertEqual(self.send(path, '未点名的消息 %d' % index,
                                       'auto-msg-cap-0000%d' % index)['status'], 201)
        replies = self.snapshot(path)['body']['agent_replies']
        self.assertEqual(len(replies), 3)
        self.assertEqual(self.snapshot(path)['body']['auto_reply']['used'], 3)
        for index, reply in enumerate(replies):
            tid = reply['task_id']
            agent.call('POST', f'/v1/agent/tasks/{tid}/claim', {})
            self.assertEqual(agent.call('POST', f'/v1/agent/tasks/{tid}/result', {
                'status': 'succeeded', 'result': {'text': '自动回复 %d' % index}})['status'], 200)
        detail = self.snapshot(path)['body']
        self.assertEqual(len([item for item in detail['items'] if item.get('role') == 'agent']), 3)
        # An explicit @agent message is a request to that agent, not an automatic one.
        self.send(path, '@Group helper 请回答这个', 'auto-msg-cap-00009')
        self.assertEqual(len(self.snapshot(path)['body']['agent_replies']), 3)
        # The window rolls over after an hour (the runtime heartbeats again so the
        # connection is not stale when the clock moves forward).
        self.now += 3601
        agent.call('POST', '/v1/agent/connect', {'hostname': 'auto-desk'})
        self.send(path, '下一小时的第一条', 'auto-msg-cap-00010')
        self.assertEqual(len(self.snapshot(path)['body']['agent_replies']), 4)
        self.assertEqual(self.snapshot(path)['body']['auto_reply']['used'], 1)

    def test_no_runtime_produces_nothing_and_keeps_the_count(self):
        path = self.group()
        self.toggle(path, True)
        self.send(path, '没有运行时连接', 'auto-msg-off-00001')
        detail = self.snapshot(path)['body']
        self.assertEqual(detail['agent_replies'], [])
        self.assertEqual(detail['auto_reply']['used'], 0)
        self.assertEqual([item['body'] for item in detail['items']], ['没有运行时连接'])

    def test_member_message_uses_the_runtime_the_workspace_already_has(self):
        path = self.group()
        agent = self.connect()
        self.toggle(path, True)
        sent = self.bob.call('POST', path + '/messages', {'body': '成员发的一条未点名消息'},
                             {'HTTP_IDEMPOTENCY_KEY': 'auto-msg-bob-00001'})
        self.assertEqual(sent['status'], 201, sent)
        replies = self.snapshot(path)['body']['agent_replies']
        self.assertEqual(len(replies), 1, replies)
        self.assertEqual(replies[0]['status'], 'queued')
        tid = replies[0]['task_id']
        self.assertEqual(agent.call('POST', f'/v1/agent/tasks/{tid}/claim', {})['status'], 200)
        self.assertEqual(agent.call('POST', f'/v1/agent/tasks/{tid}/result', {
            'status': 'succeeded', 'result': {'text': '自动回复：收到成员的消息'}})['status'], 200)
        detail = self.snapshot(path)['body']
        self.assertEqual([item['body'] for item in detail['items'] if item.get('role') == 'agent'],
                         ['自动回复：收到成员的消息'])
        self.assertEqual(detail['auto_reply']['used'], 1)
