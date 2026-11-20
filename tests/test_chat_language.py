"""The chat language preference has to reach the prompt, not stop at storage.

The fake provider in tests.test_agent_chat_infer is a local fixture; it is not a
real model vendor, a live container, or a Teamily comparison.
"""
import unittest

from openteamily.conversations import compose_prompt
from tests import test_agent_chat_infer as infer_tests


class ChatLanguageTests(unittest.TestCase):
    setUp = infer_tests.AgentChatInferTests.setUp
    online_agent = infer_tests.AgentChatInferTests.online_agent

    def conversations(self):
        return f'/v1/workspaces/{self.wid}/agents/{self.agent["id"]}/conversations'

    def conversation(self, key='chat-language-conv-01'):
        created = self.alice.call('POST', self.conversations(), {'title': '语言'},
                                  {'HTTP_IDEMPOTENCY_KEY': key})
        self.assertEqual(created['status'], 201, created)
        return created['body']['conversation']['id']

    def send(self, payload, key, cid=None):
        cid = cid or self.conversation()
        return self.alice.call(
            'POST', self.conversations() + '/' + cid + '/messages', payload,
            {'HTTP_IDEMPOTENCY_KEY': key})

    def prompts(self, runtime):
        tasks = runtime.call('GET', '/v1/agent/tasks')['body']['items']
        return [task['prompt'] for task in tasks]

    def test_compose_prompt_names_the_reply_language_without_changing_the_default(self):
        agent = {'name': '摘要助手', 'summary': '', 'instructions': 'Keep answers to one sentence.'}
        history = [{'role': 'user', 'body': '你好'}, {'role': 'assistant', 'body': '你好。'}]
        english = compose_prompt(agent, history, '今天有什么安排？', reply_language='English')
        self.assertIn('Reply in English.', english)
        self.assertIn('User: 你好', english)
        self.assertTrue(english.endswith('User: 今天有什么安排？'))
        self.assertLessEqual(len(english), 4000)
        default = compose_prompt(agent, history, '今天有什么安排？')
        self.assertNotIn('Reply in', default)
        self.assertEqual(default, compose_prompt(agent, history, '今天有什么安排？', reply_language=None))

    def test_a_message_request_carries_the_chat_language_into_the_prompt(self):
        _, runtime = self.online_agent()
        sent = self.send({'body': '你好', 'chat_language': 'en'}, 'chat-language-msg-0001')
        self.assertEqual(sent['status'], 201, sent)
        prompts = self.prompts(runtime)
        self.assertEqual(len(prompts), 1, prompts)
        self.assertIn('Reply in English.', prompts[0],
                      'the language field must reach the model; storing it is not enough')
        self.assertIn('User: 你好', prompts[0])

    def test_an_unsupported_chat_language_is_rejected_instead_of_ignored(self):
        _, runtime = self.online_agent()
        refused = self.send({'body': '你好', 'chat_language': 'klingon'}, 'chat-language-msg-0002')
        self.assertEqual(refused['status'], 400, refused)
        self.assertEqual(refused['body']['error']['code'], 'invalid')
        self.assertEqual(self.prompts(runtime), [], 'a refused message must not queue a model task')

    def test_the_stored_setting_applies_when_the_client_omits_the_field(self):
        saved = self.alice.call('POST', '/v1/settings',
                                {'revision': 0, 'changes': {'chat_language': 'ja'}})
        self.assertEqual(saved['status'], 200, saved)
        _, runtime = self.online_agent()
        sent = self.send({'body': 'こんにちは'}, 'chat-language-msg-0003')
        self.assertEqual(sent['status'], 201, sent)
        prompts = self.prompts(runtime)
        self.assertEqual(len(prompts), 1, prompts)
        self.assertIn('Reply in Japanese.', prompts[0],
                      'an account that already chose a language should not need an upgraded client')

    def test_auto_adds_no_language_instruction(self):
        _, runtime = self.online_agent()
        sent = self.send({'body': '你好', 'chat_language': 'auto'}, 'chat-language-msg-0004')
        self.assertEqual(sent['status'], 201, sent)
        prompts = self.prompts(runtime)
        self.assertEqual(len(prompts), 1, prompts)
        self.assertNotIn('Reply in', prompts[0], 'auto means the model keeps its own default')


if __name__ == '__main__':
    unittest.main()
