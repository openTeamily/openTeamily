"""Registration UI serving and unchanged authentication policy, synthetic only."""
from dataclasses import replace
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.settings_page import SettingsPage
from openteamily.store import Store
from tests.test_management import Client, ORIGIN, PASSWORD
from tests.test_settings_page import RawClient


class RegistrationPageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.api = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True))
        self.page = SettingsPage(self.api)
        self.raw = RawClient(self.page)
        self.client = Client(self.page)

    def test_form_assets_and_strict_headers(self):
        response = self.raw.call('GET', '/register')
        self.assertEqual(response['status'], 200)
        html = response['body'].decode()
        for marker in ('id="register-form"', 'action="/v1/auth/register"', 'method="post"',
                       'id="register-username"', 'id="register-password"', 'type="password"',
                       'autocomplete="new-password"', 'id="register-submit"'):
            self.assertIn(marker, html)
        self.assertNotIn('<script>', html)
        self.assertEqual(response['headers']['Cache-Control'], 'no-store')
        self.assertIn("form-action 'self'", response['headers']['Content-Security-Policy'])
        self.assertEqual(self.raw.call('HEAD', '/register')['body'], b'')
        for path in ('/register/app.mjs', '/register/app.css'):
            self.assertEqual(self.raw.call('GET', path)['status'], 200)
        self.assertEqual(self.raw.call('GET', '/register/missing')['status'], 404)

    def test_email_registration_and_set_password_pages(self):
        html = self.raw.call('GET', '/register')['body'].decode()
        for marker in ('id="email-register-form"', 'id="email-login-form"',
                       '发送设置密码链接', '邮箱验证码登录', 'id="email-register-terms"'):
            self.assertIn(marker, html)
        token = 'A' * 43
        page = self.raw.call('GET', '/set-password', query='token=' + token)
        self.assertEqual(page['status'], 200)
        page_html = page['body'].decode()
        self.assertIn('id="set-password-form"', page_html)
        self.assertIn('保存密码并登录', page_html)
        self.assertEqual(self.raw.call('GET', '/set-password/app.mjs')['status'], 200)
        self.assertEqual(self.raw.call('GET', '/set-password/app.css')['status'], 200)
        self.assertEqual(self.raw.call('GET', '/set-password', query='token=short')['status'], 400)
        self.assertEqual(self.raw.call('GET', '/set-password', query='x=1')['status'], 400)
        self.assertEqual(self.raw.call('GET', '/set-password', origin='https://evil.test')['status'], 403)
        self.assertEqual(self.raw.call('POST', '/set-password')['status'], 405)

    def test_page_policy_not_weakened(self):
        self.assertEqual(self.raw.call('GET', '/register', origin='https://evil.test')['status'], 403)
        self.assertEqual(self.raw.call('GET', '/register', host='evil.test')['status'], 403)
        self.assertEqual(self.raw.call('GET', '/register', site='cross-site')['status'], 403)
        self.assertEqual(self.raw.call('GET', '/register', query='next=https://evil.test')['status'], 400)
        self.assertEqual(self.raw.call('POST', '/register')['status'], 405)

    def test_existing_api_registers_session_but_preserves_csrf(self):
        result = self.client.register('registration-test')
        self.assertEqual(result['status'], 201)
        self.assertNotIn(PASSWORD, str(result))
        self.assertEqual(self.client.call('GET', '/v1/auth/session')['status'], 200)
        self.assertEqual(self.client.call('POST', '/v1/settings', {}, csrf=False)['status'], 403)

    def test_api_origin_registration_policy_and_validation(self):
        body = {'username': 'test-user', 'password': PASSWORD}
        self.assertEqual(self.client.call('POST', '/v1/auth/register', body, origin='https://evil.test')['status'], 403)
        self.assertEqual(self.client.call('POST', '/v1/auth/register', body, origin=None)['status'], 403)
        self.assertEqual(self.client.call('POST', '/v1/auth/register', {'username': 'a', 'password': PASSWORD})['status'], 400)
        self.api.config = replace(self.api.config, allow_registration=False)
        self.assertEqual(self.client.call('POST', '/v1/auth/register', body)['status'], 403)

    def test_public_policy_closed_default_and_no_account_counts_or_bootstrap_grants(self):
        self.api.config=replace(self.api.config,allow_registration=False)
        policy=self.client.call('GET','/v1/auth/policy')
        self.assertEqual(policy['status'],200);self.assertFalse(policy['body']['registration_open'])
        self.assertFalse(policy['body']['email_registration'])
        self.assertTrue(policy['body']['session_requires_https'])
        self.assertNotIn('user_count',policy['body']);self.assertNotIn('first_user',policy['body'])
        for path in ('/v1/auth/policy?registration_open=true','/v1/auth/policy?next=/'):
            self.assertEqual(self.client.call('GET',path)['status'],400)
        self.assertEqual(self.client.call('POST','/v1/auth/policy',{})['status'],400)
        self.assertEqual(self.client.register('not-created')['body']['error']['code'],'registration_closed')
        with self.api.store.connect() as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM users').fetchone()[0],0)

    def test_new_account_session_settings_personal_workspace_agent_actual_controlled_model_and_restart(self):
        # HTTP API + actual local controlled provider. NOT real-vendor/remote acceptance.
        from tests import test_message_utilities as provider_helpers
        from tests import test_skill_packages as skill_helpers
        from openteamily.flybot import handle_task
        import json
        registered=self.client.register('newuser');self.assertEqual(registered['status'],201,registered)
        uid=registered['body']['user']['id'];self.assertIsNone(self.api.operator_admin)
        self.assertEqual(self.client.call('GET','/v1/auth/session')['body']['user']['id'],uid)
        self.assertEqual(self.client.call('POST','/v1/settings',{'revision':0,'changes':{'appearance':'dark'}})['status'],200)
        personal=self.client.call('POST','/v1/personal-agent');self.assertEqual(personal['status'],201,personal)
        data=personal['body']['personal_agent'];wid=data['workspace']['id'];aid=data['agent']['id']
        self.assertIn(wid,[row['id'] for row in self.client.call('GET','/v1/workspaces?limit=100')['body']['items']])
        # A normal user owns only their own workspace, never another tenant or operator role.
        other=Client(self.api,peer='127.0.0.2');other.register('unrelated')
        self.assertEqual(other.call('GET',f'/v1/workspaces/{wid}/agents')['status'],404)
        self.assertEqual(other.call('POST',f'/v1/workspaces/{wid}/agents',{'name':'forbidden','summary':'','instructions':''},{'HTTP_IDEMPOTENCY_KEY':'registration-foreign001'})['status'],404)
        self.app,self.alice=self.api,self.client
        agent,seen=provider_helpers.UtilityTests.start_provider(self)
        base=f'/v1/workspaces/{wid}/agents/{aid}/conversations'
        conv=self.client.call('GET',base)['body']['items'][0]['id']
        made=self.client.call('POST',base+'/'+conv+'/messages',{'body':'Controlled onboarding fixture: summarize supplied data.'},{'HTTP_IDEMPOTENCY_KEY':'registration-infer001'})
        self.assertEqual(made['status'],201,made)
        task=agent.call('GET','/v1/agent/tasks')['body']['items'][0]
        self.assertEqual(agent.call('POST',f'/v1/agent/tasks/{task["id"]}/claim',{})['status'],200)
        status,result=handle_task(task,ORIGIN,'synthetic-fixture-only',requester=skill_helpers.SkillPackageTests.requester(self,agent))
        self.assertEqual(status,'succeeded',result)
        self.assertEqual(agent.call('POST',f'/v1/agent/tasks/{task["id"]}/result',{'status':status,'result':result})['status'],200)
        history=self.client.call('GET',base+'/'+conv)['body']['items']
        self.assertTrue(any(row['body']==result['text'] for row in history),history);self.assertEqual(seen['count'],1)
        self.client.call('POST','/v1/auth/logout',{});self.assertEqual(self.client.call('GET','/v1/auth/session')['status'],401)
        reopened=Client(App(Store(self.api.store.data_dir),self.api.config))
        self.assertEqual(reopened.call('POST','/v1/auth/login',{'username':'newuser','password':PASSWORD})['status'],200)
        self.assertEqual(reopened.call('GET','/v1/settings')['body']['settings']['values']['appearance'],'dark')
        self.assertEqual(reopened.call('POST','/v1/personal-agent')['body']['personal_agent']['agent']['id'],aid)

    def test_root_and_settings_have_prominent_registration_entry_and_matching_explicit_text_input(self):
        for path in ('/','/settings'):
            response=self.raw.call('GET',path);self.assertEqual(response['status'],200,response)
            html=response['body'].decode()
            self.assertIn('class="login-register-button" href="/register">注册新账户',html)
            self.assertRegex(html,r'<input[^>]*type="text"[^>]*name="username"')
            self.assertRegex(html,r'<input[^>]*name="password"[^>]*type="password"')


if __name__ == '__main__':
    unittest.main()
