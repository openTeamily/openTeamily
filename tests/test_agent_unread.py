"""User-agent conversation unread (issues #4 #86). Labeled local fake provider; no vendor."""
import unittest

from tests import test_agent_chat_infer as infer_tests



class AgentUnreadTests(unittest.TestCase):
    setUp = infer_tests.AgentChatInferTests.setUp
    conversations = infer_tests.AgentChatInferTests.conversations
    online_agent = infer_tests.AgentChatInferTests.online_agent
    finish_infer = infer_tests.AgentChatInferTests.finish_infer

    def test_finished_reply_is_unread_until_acknowledged(self):
        conv_id = self.alice.call('POST', self.conversations(), {'title': '问答'},
                                  {'HTTP_IDEMPOTENCY_KEY': 'agent-unread-conv-01'})['body']['conversation']['id']
        _, agent = self.online_agent()
        sent = self.alice.call('POST', self.conversations() + f'/{conv_id}/messages', {'body': '你好'},
                               {'HTTP_IDEMPOTENCY_KEY': 'agent-unread-msg-001'})
        reply = sent['body']['reply']
        listed = self.alice.call('GET', self.conversations())['body']['items'][0]
        self.assertEqual(listed['unread_count'], 0)  # queued replies are not unread
        self.finish_infer(agent, reply['task_id'])
        # The list itself reconciles the finished task.
        self.assertEqual(self.alice.call('GET', self.conversations())['body']['items'][0]['unread_count'], 1)
        snap = self.alice.call('GET', self.conversations() + f'/{conv_id}')['body']
        self.assertEqual(snap['conversation']['unread_count'], 1)
        user_msg = [m for m in snap['items'] if m['role'] == 'user'][0]['id']
        partial = self.alice.call('POST', self.conversations() + f'/{conv_id}/read', {'message_id': user_msg})
        self.assertEqual(partial['body']['unread_count'], 1)
        done = self.alice.call('POST', self.conversations() + f'/{conv_id}/read', {'message_id': reply['id']})
        self.assertEqual(done['body']['unread_count'], 0)
        # Read position never moves backwards.
        self.alice.call('POST', self.conversations() + f'/{conv_id}/read', {'message_id': user_msg})
        self.assertEqual(self.alice.call('GET', self.conversations())['body']['items'][0]['unread_count'], 0)

    def test_validation_and_privacy(self):
        conv_id = self.alice.call('POST', self.conversations(), {'title': '问答'},
                                  {'HTTP_IDEMPOTENCY_KEY': 'agent-unread-conv-02'})['body']['conversation']['id']
        path = self.conversations() + f'/{conv_id}/read'
        self.assertEqual(self.alice.call('POST', path, {'message_id': 'x'})['status'], 400)
        self.assertEqual(self.alice.call('POST', path, {'message_id': '0' * 32})['status'], 404)
        self.assertEqual(self.bob.call('POST', path, {'message_id': '0' * 32})['status'], 404)
        self.assertIn(self.alice.call('POST', path, {'message_id': '0' * 32}, csrf=False)['status'], (401, 403))


if __name__ == '__main__':
    unittest.main()
