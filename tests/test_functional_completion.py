"""Consolidated functional capabilities; temporary SQLite/fake data only."""
import unittest
from tests import test_social as social_fixture
from tests.test_management import Client
from tests.test_artifact_media import multipart, PNG


class FunctionalCompletionTests(unittest.TestCase):
    setUp = social_fixture.SocialMessengerTests.setUp
    _user_id = social_fixture.SocialMessengerTests._user_id
    base = social_fixture.SocialMessengerTests.base
    create = social_fixture.SocialMessengerTests.create

    def media(self, client=None, key='functional-media-0001'):
        raw, content_type = multipart([('title', 'Functional photo'), ('kind', 'media')],
                                      [('file', 'photo.png', 'image/png', PNG)])
        result = (client or self.alice).call('POST', f'/v1/workspaces/{self.wid}/artifacts', raw=raw,
              headers={'CONTENT_TYPE': content_type, 'HTTP_IDEMPOTENCY_KEY': key})
        self.assertEqual(result['status'], 201, result)
        return result['body']['artifact']

    def test_discover_engagement_following_collection_are_real_and_private(self):
        item = self.media()
        publish = f'/v1/workspaces/{self.wid}/artifacts/{item["id"]}/discover'
        self.assertEqual(self.alice.call('POST', publish, {'slug': 'functional-photo'})['status'], 201)
        endpoint = '/v1/discover/works/functional-photo/engagement'
        anon = Client(self.app, peer='127.0.0.9')
        self.assertEqual(anon.call('POST', endpoint, {'action': 'like', 'enabled': True})['status'], 401)
        self.assertEqual(self.bob.call('POST', endpoint, {'action': 'like', 'enabled': True}, csrf=False)['status'], 403)
        for action in ('like', 'collect', 'follow'):
            for _ in range(2):  # absolute booleans are idempotent
                response = self.bob.call('POST', endpoint, {'action': action, 'enabled': True})
                self.assertEqual(response['status'], 200, response)
        state = self.bob.call('POST', endpoint, {'action': 'like', 'enabled': True})['body']
        self.assertEqual(state['likes'], 1)
        self.assertEqual(state['collections'], 1)
        self.assertTrue(state['following'])
        for tab in ('following', 'collected'):
            own = self.bob.call('GET', '/v1/discover/me/works?tab=' + tab)
            self.assertEqual([x['slug'] for x in own['body']['items']], ['functional-photo'])
            self.assertEqual(self.carol.call('GET', '/v1/discover/me/works?tab=' + tab)['body']['items'], [])
        self.assertEqual(self.alice.call('POST', endpoint, {'action': 'follow', 'enabled': True})['status'], 400)
        page = anon.call('GET', '/w/functional-photo', parse='raw')
        self.assertEqual(page['status'], 200)
        self.assertIn(b'/w/functional-photo/file', page['body'])
        self.assertEqual(anon.call('GET', '/w/functional-photo/file', parse='raw')['body'], PNG)
        public = anon.call('GET', '/v1/discover/works')['body']['items'][0]
        self.assertEqual(public['likes'], 1)
        self.assertFalse(public['liked'])
        self.assertNotIn(self.bob_id, str(public))
        self.assertEqual(self.bob.call('POST', endpoint, {'action': 'like', 'enabled': False})['body']['likes'], 0)
        self.alice.call('POST', publish + '/revoke', {})
        self.assertEqual(self.bob.call('GET', '/v1/discover/me/works?tab=following')['body']['items'], [])
        self.assertEqual(self.bob.call('POST', endpoint, {'action': 'like', 'enabled': True})['status'], 404)
        self.assertEqual(anon.call('GET', '/w/functional-photo/file')['status'], 404)

    def test_message_edit_retract_conflicts_permissions_and_search(self):
        cid = self.create(self.alice, 'dm', [self.bob_id])['body']['conversation']['id']
        base = self.base() + '/' + cid
        msg = self.alice.call('POST', base + '/messages', {'body': 'old secret phrase'},
                              {'HTTP_IDEMPOTENCY_KEY': 'functional-message-0001'})['body']['message']
        endpoint = base + '/messages/' + msg['id']
        self.assertEqual(self.bob.call('POST', endpoint + '/edit', {'revision': 1, 'body': 'no'})['status'], 403)
        self.assertEqual(self.alice.call('POST', endpoint + '/edit', {'revision': 1, 'body': 'new phrase'}, csrf=False)['status'], 403)
        edited = self.alice.call('POST', endpoint + '/edit', {'revision': 1, 'body': 'new phrase'})
        self.assertEqual(edited['status'], 200, edited)
        self.assertEqual(edited['body']['message']['revision'], 2)
        self.assertEqual(self.bob.call('GET', base)['body']['items'][0]['body'], 'new phrase')
        self.assertEqual(self.alice.call('POST', endpoint + '/edit', {'revision': 1, 'body': 'stale'})['status'], 409)
        self.assertEqual(self.alice.call('POST', endpoint + '/retract', {'revision': 2})['status'], 200)
        snapshot = self.bob.call('GET', base)['body']
        self.assertTrue(snapshot['items'][0]['retracted'])
        self.assertEqual(snapshot['items'][0]['body'], '')
        self.assertEqual(snapshot['conversation']['unread_count'], 0)
        hits = self.bob.call('GET', f'/v1/workspaces/{self.wid}/search/messages?q=phrase')['body']['items']
        self.assertEqual(hits, [])
        self.assertEqual(self.alice.call('POST', endpoint + '/edit', {'revision': 3, 'body': 'resurrect'})['status'], 409)

    def test_attachment_upload_link_download_replay_and_pin_isolation(self):
        item = self.media()
        cid = self.create(self.alice, 'dm', [self.bob_id])['body']['conversation']['id']
        base = self.base() + '/' + cid
        payload = {'body': '', 'artifact_id': item['id']}
        headers = {'HTTP_IDEMPOTENCY_KEY': 'functional-attach-message'}
        first = self.alice.call('POST', base + '/messages', payload, headers)
        self.assertEqual(first['status'], 201, first)
        second = self.alice.call('POST', base + '/messages', payload, headers)
        self.assertEqual(second['status'], 200)
        self.assertEqual(second['body']['message']['id'], first['body']['message']['id'])
        path = self.bob.call('GET', base)['body']['items'][0]['attachment']['path']
        self.assertEqual(self.bob.call('GET', path, parse='raw')['body'], PNG)
        self.assertEqual(self.eve.call('GET', path)['status'], 404)
        self.assertEqual(self.alice.call('POST', base + '/preferences', {'pinned': True})['status'], 200)
        self.assertTrue(self.alice.call('GET', self.base())['body']['items'][0]['pinned'])
        self.assertFalse(self.bob.call('GET', self.base())['body']['items'][0]['pinned'])
        self.assertEqual(self.eve.call('POST', base + '/preferences', {'pinned': True})['status'], 404)
        self.assertEqual(self.alice.call('POST', base + '/preferences', {'pinned': 'yes'})['status'], 400)

    def test_personal_memory_profile_revision_isolation_and_persistence(self):
        endpoint = f'/v1/workspaces/{self.wid}/memory/profile'
        self.assertEqual(self.alice.call('GET', endpoint)['body']['profile']['revision'], 0)
        payload = {'revision': 0, 'professional': '工程师', 'work_style': 'Async', 'communication': '中文'}
        self.assertEqual(self.alice.call('POST', endpoint, payload, csrf=False)['status'], 403)
        saved = self.alice.call('POST', endpoint, payload)
        self.assertEqual(saved['status'], 200, saved)
        self.assertEqual(saved['body']['profile']['revision'], 1)
        self.assertEqual(self.alice.call('POST', endpoint, payload)['status'], 409)
        self.assertEqual(self.bob.call('GET', endpoint)['body']['profile']['professional'], '')
        self.assertEqual(self.alice.call('GET', endpoint)['body']['profile']['professional'], '工程师')
        self.assertEqual(self.eve.call('GET', endpoint)['status'], 404)
        self.assertEqual(self.alice.call('POST', endpoint, {**payload, 'revision': 1, 'professional': 'x'*10001})['status'], 400)

    def test_resource_search_permissions_safe_links_and_files(self):
        item = self.media()
        cid = self.create(self.alice, 'dm', [self.bob_id])['body']['conversation']['id']
        self.alice.call('POST', self.base() + '/' + cid + '/messages',
                        {'body': 'Reference https://example.test/guide and javascript:alert(1)'},
                        {'HTTP_IDEMPOTENCY_KEY': 'functional-link-message'})
        endpoint = f'/v1/workspaces/{self.wid}/search/resources'
        links = self.bob.call('GET', endpoint + '?kind=links&q=example')
        self.assertEqual(links['status'], 200, links)
        self.assertEqual(links['body']['items'][0]['href'], 'https://example.test/guide')
        self.assertEqual(self.carol.call('GET', endpoint + '?kind=links&q=example')['body']['items'], [])
        files = self.bob.call('GET', endpoint + '?kind=files&q=photo')
        self.assertEqual(files['status'], 200, files)
        self.assertEqual(files['body']['items'][0]['id'], item['id'])
        self.assertEqual(self.eve.call('GET', endpoint + '?kind=files')['status'], 404)
        for query in ('kind=bogus', 'kind=files&limit=0', 'kind=links&cursor=bad', 'kind=files&kind=links'):
            self.assertEqual(self.alice.call('GET', endpoint + '?' + query)['status'], 400)
