"""Voice messages: a recorded clip is an attachment plus its real duration.

The composer only had a disabled microphone, so a recording could not be sent
at all. This pins the server contract the player needs: the recording travels
as an ordinary media attachment, and the message records how long it is so the
bubble can show a play bar with a duration instead of a document card.
"""
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_artifact_media import multipart
from tests.test_management import Client, ORIGIN

# Smallest thing that sniffs as audio/ogg; not a playable file, only a fixture.
OGG = b'OggS' + b'\x00' * 40


class SocialVoiceMessageTests(unittest.TestCase):
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
        self.wid = self.alice.workspace()['body']['workspace']['id']
        self.alice.call('POST', f'/v1/workspaces/{self.wid}/members',
                        {'username': 'bob', 'role': 'member'})
        self.bob_id = self.bob.call('GET', '/v1/auth/session')['body']['user']['id']
        created = self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/social/conversations',
            {'kind': 'dm', 'member_ids': [self.bob_id]},
            {'HTTP_IDEMPOTENCY_KEY': 'voice-create-0001'})
        self.assertEqual(created['status'], 201, created)
        self.cid = created['body']['conversation']['id']

    def base(self):
        return f'/v1/workspaces/{self.wid}/social/conversations/{self.cid}/messages'

    def upload(self, key='voice-upload-0001'):
        raw, content_type = multipart([('title', 'voice-3s'), ('kind', 'media')],
                                      [('file', 'voice-3s.ogg', 'audio/ogg', OGG)])
        return self.alice.call(
            'POST', f'/v1/workspaces/{self.wid}/artifacts', raw=raw,
            headers={'CONTENT_TYPE': content_type, 'HTTP_IDEMPOTENCY_KEY': key,
                     'CONTENT_LENGTH': str(len(raw))})

    def send(self, body, key='voice-msg-000001'):
        return self.alice.call('POST', self.base(), body, {'HTTP_IDEMPOTENCY_KEY': key})

    def test_voice_message_keeps_its_duration_after_a_reload(self):
        uploaded = self.upload()
        self.assertEqual(uploaded['status'], 201, uploaded)
        artifact_id = uploaded['body']['artifact']['id']
        sent = self.send({'body': '', 'artifact_id': artifact_id, 'voice_ms': 3200})
        self.assertEqual(sent['status'], 201, sent)
        self.assertEqual(sent['body']['message']['voice'], {'duration_ms': 3200})
        self.assertTrue(sent['body']['message']['attachment']['path'])
        listed = self.bob.call('GET', self.base())
        self.assertEqual(listed['status'], 200)
        row = [item for item in listed['body']['items'] if item['id'] == sent['body']['message']['id']][0]
        self.assertEqual(row['voice'], {'duration_ms': 3200})

    def test_a_normal_message_has_no_voice(self):
        sent = self.send({'body': '文字消息'}, key='voice-msg-000002')
        self.assertEqual(sent['status'], 201, sent)
        self.assertIsNone(sent['body']['message']['voice'])

    def test_voice_without_a_recording_is_refused(self):
        sent = self.send({'body': '没有附件', 'voice_ms': 3000}, key='voice-msg-000003')
        self.assertEqual(sent['status'], 400, sent)

    def test_duration_must_be_a_bounded_positive_integer(self):
        uploaded = self.upload(key='voice-upload-0002')
        artifact_id = uploaded['body']['artifact']['id']
        for bad, key in ((-1, 'voice-msg-000010'), (0, 'voice-msg-000011'),
                         (600001, 'voice-msg-000012'), ('3s', 'voice-msg-000013')):
            sent = self.send({'body': '', 'artifact_id': artifact_id, 'voice_ms': bad}, key=key)
            self.assertEqual(sent['status'], 400, (bad, sent))


if __name__ == '__main__':
    unittest.main()
