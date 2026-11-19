"""Group agent request completion notifications (issue #4). Uses the local runtime protocol only."""
import unittest

from tests import test_group_agent_reply as group_tests



class TaskCompletionNotificationTests(unittest.TestCase):
    setUp = group_tests.GroupAgentReplyTests.setUp
    _user_id = group_tests.GroupAgentReplyTests._user_id
    base = group_tests.GroupAgentReplyTests.base
    create = group_tests.GroupAgentReplyTests.create
    make_agent = group_tests.GroupAgentReplyTests.make_agent
    group = group_tests.GroupAgentReplyTests.group
    trigger = group_tests.GroupAgentReplyTests.trigger
    connect = group_tests.GroupAgentReplyTests.connect

    def inbox(self, client=None, query=''):
        return (client or self.alice).call('GET', f'/v1/workspaces/{self.wid}/notifications' + query)['body']

    def test_terminal_request_notifies_requester_only_and_is_read_by_opening(self):
        path = self.group()
        agent = self.connect()
        sent = self.trigger(path)
        tid, rid = sent['body']['reply']['task_id'], sent['body']['reply']['id']
        self.assertEqual(self.inbox()['unread_count'], 0)  # queued is not a completion
        agent.call('POST', f'/v1/agent/tasks/{tid}/claim', {})
        agent.call('POST', f'/v1/agent/tasks/{tid}/result', {'status': 'failed', 'result': {'error': 'secret-diag'}})
        # The notification poll itself reconciles the task without opening the group.
        body = self.inbox()
        self.assertEqual(body['unread_count'], 1)
        item = body['items'][0]
        self.assertEqual((item['kind'], item['id'], item['status'], item['actor_username']),
                         ('agent_reply', rid, 'failed', 'Group helper'))
        self.assertTrue(item['excerpt'].startswith('未能完成：'))
        self.assertNotIn('secret-diag', str(body))
        self.assertEqual(self.inbox(self.bob)['unread_count'], 0)  # bob did not ask
        marked = self.alice.call('POST', f'/v1/workspaces/{self.wid}/notifications/read', {'notification_id': rid})
        self.assertEqual(marked['body']['unread_count'], 0)
        self.assertEqual(self.inbox(query='?filter=unread')['items'], [])
        self.assertEqual(self.bob.call('POST', f'/v1/workspaces/{self.wid}/notifications/read',
                                       {'notification_id': rid})['status'], 404)

    def test_success_cleared_by_reading_conversation(self):
        path = self.group()
        agent = self.connect()
        tid = self.trigger(path, key='group-notify-ok-0001')['body']['reply']['task_id']
        agent.call('POST', f'/v1/agent/tasks/{tid}/claim', {})
        agent.call('POST', f'/v1/agent/tasks/{tid}/result', {'status': 'succeeded', 'result': {'text': '[FAKE] done'}})
        self.assertEqual(self.inbox()['unread_count'], 1)
        items = self.alice.call('GET', path)['body']['items']
        self.alice.call('POST', path + '/read', {'message_id': items[-1]['id']})
        self.assertEqual(self.inbox()['unread_count'], 0)


if __name__ == '__main__':
    unittest.main()
