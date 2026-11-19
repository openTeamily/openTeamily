"""AI agent team templates (issues #7 #89). Creating a team never calls a runtime or vendor."""
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN


class TeamTemplateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.app = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                       clock=lambda: 1800000000)
        self.owner, self.member = Client(self.app), Client(self.app, peer='127.0.0.2')
        self.owner.register('owner')
        self.member.register('member')
        self.wid = self.owner.workspace()['body']['workspace']['id']
        self.owner.call('POST', f'/v1/workspaces/{self.wid}/members', {'username': 'member', 'role': 'member'})
        self.member_id = self.member.call('GET', '/v1/auth/session')['body']['user']['id']
        self.path = f'/v1/workspaces/{self.wid}/team-templates/product-squad'

    def apply(self, client=None, body=None, key='team-template-00001', path=None):
        return (client or self.owner).call('POST', path or self.path, body or {}, {'HTTP_IDEMPOTENCY_KEY': key})

    def test_catalog_lists_self_written_templates(self):
        listed = self.member.call('GET', '/v1/team-templates')
        self.assertEqual(listed['status'], 200)
        slugs = [item['slug'] for item in listed['body']['items']]
        self.assertEqual(slugs, ['product-squad', 'content-studio', 'research-desk'])
        self.assertTrue(all(len(item['agents']) == 3 for item in listed['body']['items']))
        self.assertNotIn('instructions', listed['body']['items'][0]['agents'][0])

    def test_apply_creates_agents_and_group_with_idempotent_replay(self):
        created = self.apply(body={'member_ids': [self.member_id]})
        self.assertEqual(created['status'], 201, created)
        conv = created['body']['conversation']
        self.assertEqual((conv['kind'], conv['title']), ('group', '产品研发小队'))
        self.assertEqual({a['name'] for a in conv['agent_members']}, {'产品经理助理', '研发工程师助理', '测试工程师助理'})
        self.assertEqual(len(created['body']['created_agents']), 3)
        self.assertEqual({m['username'] for m in conv['members']}, {'owner', 'member'})
        listed = self.owner.call('GET', f'/v1/workspaces/{self.wid}/agents?limit=100')['body']['items']
        self.assertEqual(len(listed), 3)
        self.assertIn(conv['id'], [c['id'] for c in self.member.call(
            'GET', f'/v1/workspaces/{self.wid}/social/conversations')['body']['items']])
        replay = self.apply(body={'member_ids': [self.member_id]})
        self.assertEqual((replay['status'], replay['body']['conversation']['id']), (200, conv['id']))
        self.assertEqual(self.apply(body={'title': '别的'})['status'], 409)
        # A second team reuses the same-name agents instead of duplicating them.
        again = self.apply(body={'title': '第二小队'}, key='team-template-00002')
        self.assertEqual((again['status'], again['body']['created_agents']), (201, []))
        self.assertEqual(len(self.owner.call('GET', f'/v1/workspaces/{self.wid}/agents?limit=100')['body']['items']), 3)

    def test_permissions_and_validation(self):
        self.assertEqual(self.apply(self.member)['status'], 403)
        self.assertEqual(self.apply(path=f'/v1/workspaces/{self.wid}/team-templates/nope-team')['status'], 404)
        self.assertEqual(self.owner.call('POST', self.path, {}, {})['status'], 400)
        self.assertEqual(self.apply(body={'member_ids': ['0' * 32]})['status'], 400)
        self.assertEqual(self.apply(body={'title': ''})['status'], 201)  # empty title falls back to template name
        outsider = Client(self.app, peer='127.0.0.9')
        outsider.register('outsider')
        self.assertEqual(self.apply(outsider, key='team-template-00003')['status'], 404)
        self.assertIn(self.owner.call('POST', self.path, {}, {'HTTP_IDEMPOTENCY_KEY': 'team-template-00004'},
                                      csrf=False)['status'], (401, 403))


if __name__ == '__main__':
    unittest.main()
