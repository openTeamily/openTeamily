"""Settings page serving tests. In-process WSGI only; not browser E2E."""
import io
from pathlib import Path
import tempfile
import unittest

from openteamily.app import App, Config
from openteamily.settings_page import SettingsPage
from openteamily.store import Store
from tests.test_management import Client, ORIGIN, PASSWORD


class RawClient:
    def __init__(self, app, peer='127.0.0.1'):
        self.app, self.peer = app, peer

    def call(self, method, path, origin=ORIGIN, host='management.test', site='', query=''):
        env = {'REQUEST_METHOD': method, 'PATH_INFO': path, 'QUERY_STRING': query,
               'HTTP_HOST': host, 'REMOTE_ADDR': self.peer, 'CONTENT_LENGTH': '0',
               'wsgi.input': io.BytesIO()}
        if origin is not None:
            env['HTTP_ORIGIN'] = origin
        if site:
            env['HTTP_SEC_FETCH_SITE'] = site
        result = {}
        def start(status, values):
            result['status'], result['headers'] = int(status.split()[0]), dict(values)
        result['body'] = b''.join(self.app(env, start))
        return result


class SettingsPageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        api = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                  clock=lambda: 1800000000)
        self.api = api
        self.app = SettingsPage(api)
        self.raw = RawClient(self.app)
        self.client = Client(self.app)
        self.client.register('alice')

    def test_page_and_assets_are_served_with_strict_headers(self):
        page = self.raw.call('GET', '/settings')
        self.assertEqual(page['status'], 200)
        html = page['body'].decode()
        self.assertIn('<h1>设置</h1>', html)
        self.assertIn('id="settings-index"', html)
        self.assertIn('账户与资料', html)
        self.assertIn('AI 与智能体设置', html)
        self.assertIn('偏好与安全', html)
        self.assertIn(b'/v1/settings', page['body'])
        self.assertIn('default-src \'none\'', page['headers']['Content-Security-Policy'])
        self.assertEqual(page['headers']['Cache-Control'], 'no-store')
        self.assertEqual(page['headers']['X-Content-Type-Options'], 'nosniff')
        script = self.raw.call('GET', '/settings/app.mjs')
        css = self.raw.call('GET', '/settings/app.css')
        self.assertEqual(script['status'], 200)
        self.assertEqual(css['status'], 200)
        self.assertIn('javascript', script['headers']['Content-Type'])
        head = self.raw.call('HEAD', '/settings')
        self.assertEqual(head['status'], 200)
        self.assertEqual(head['body'], b'')

    def test_composer_deep_links_pass_only_known_queries(self):
        for kind in ('document', 'website', 'slides', 'dashboard', 'whiteboard'):
            self.assertEqual(self.raw.call('GET', '/space', query='new=' + kind)['status'], 200, kind)
        self.assertEqual(self.raw.call('GET', '/space', query='new=image')['status'], 400)
        self.assertEqual(self.raw.call('GET', '/automations', query='template=daily_brief')['status'], 200)
        self.assertEqual(self.raw.call('GET', '/automations', query='template=custom')['status'], 400)
        self.assertEqual(self.raw.call('GET', '/automations', query='template=nope')['status'], 400)
        self.assertEqual(self.raw.call('GET', '/shell/thumb.mjs')['status'], 200)
        self.assertEqual(self.raw.call('GET', '/memory/rich.mjs')['status'], 200)
        self.assertEqual(self.raw.call('GET', '/shell/thumb.mjs', query='x=1')['status'], 400)

    def test_page_rejects_cross_origin_queries_and_writes(self):
        self.assertEqual(self.raw.call('GET', '/settings', origin='https://evil.test')['status'], 403)
        self.assertEqual(self.raw.call('GET', '/settings', host='evil.test')['status'], 403)
        self.assertEqual(self.raw.call('GET', '/settings', site='cross-site')['status'], 403)
        self.assertEqual(self.raw.call('GET', '/settings', query='q=1')['status'], 400)
        posted = self.raw.call('POST', '/settings')
        self.assertEqual(posted['status'], 405)
        self.assertEqual(posted['headers']['Allow'], 'GET, HEAD')
        self.assertEqual(self.raw.call('GET', '/settings/../settings.py')['status'], 404)
        self.assertEqual(self.raw.call('GET', '/settings/missing')['status'], 404)

    def test_wrapper_still_exposes_the_settings_api(self):
        response = self.client.call('GET', '/v1/settings')
        self.assertEqual(response['status'], 200)
        self.assertEqual(response['body']['settings']['revision'], 0)
        saved = self.client.call('POST', '/v1/settings', {'revision': 0, 'changes': {'appearance': 'dark'}})
        self.assertEqual(saved['status'], 200)
        self.assertEqual(saved['body']['settings']['values']['appearance'], 'dark')
        login = Client(self.app, peer='127.0.0.2')
        again = login.call('POST', '/v1/auth/login', {'username': 'alice', 'password': PASSWORD})
        self.assertEqual(again['status'], 200)

    def test_html_lists_only_documented_setting_keys(self):
        html = self.raw.call('GET', '/settings')['body'].decode()
        for name in ('appearance', 'appearance_schedule', 'language', 'chat_language', 'auto_translate',
                     'send_shortcut', 'message_folding', 'document_cards', 'link_previews',
                     'task_completion_reminders', 'likes_visible', 'favorites_visible'):
            self.assertIn(f'name="{name}"', html)
        self.assertIn('sunset_sunrise', html)
        self.assertIn('id="appearance"', html)
        light, dark, auto, system = (html.find(f'value="{name}"') for name in ('light', 'dark', 'auto', 'system'))
        self.assertTrue(-1 < light < dark < auto < system)
        self.assertLess(html.find('始终使用浅色主题。'), html.find('始终使用深色主题。'))
        self.assertIn('没有使用实际日出日落时刻', html)
        self.assertIn('暂按 22:00 至次日 06:00 为夜间', html)
        self.assertNotIn('会等你停止操作约 1 分钟再切换', html)
        self.assertIn('legend class="visually-hidden"', html)
        self.assertIn('settings-card-title', html)
        self.assertNotIn('name="fold_long_messages"', html)

    def test_overview_maps_existing_settings_and_omits_billing_chrome(self):
        html = self.raw.call('GET', '/settings')['body'].decode()
        self.assertIn('id="settings-index"', html)
        self.assertIn('id="whoami"', html)
        self.assertIn('href="/members"', html)
        self.assertIn('技能配置', html)
        self.assertIn('不用积分', html)
        self.assertNotIn('id="settings-usage-card"', html)
        self.assertNotIn('id="settings-upgrade"', html)
        self.assertNotIn('id="group-creator"', html)
        self.assertNotIn('id="group-billing"', html)
        self.assertNotIn('>升级</button>', html)
        for label in ('创作者与奖励', '套餐、账单与用量', '创作赚钱', '积分中心', '套餐与账单', '教育优惠认证', '兑换码'):
            self.assertNotIn(label, html)
        account = html.find('id="group-account"')
        ai = html.find('id="group-ai"')
        prefs = html.find('id="group-prefs"')
        support = html.find('id="group-support"')
        self.assertTrue(-1 < account < ai < prefs < support)
        self.assertIn('支持与法律', html)
        support_html = html[support:]
        self.assertIn('href="/about"', support_html)
        self.assertIn('href="/guide"', support_html)
        self.assertIn('href="/profile"', html)
        self.assertIn('href="/settings/language"', html)
        self.assertIn('href="/settings/channels"', html)
        self.assertIn('href="/settings/agent-access"', html)
        self.assertIn('href="#model-api"', html)
        self.assertIn('href="/settings/skill-configuration"', html)
        self.assertIn('href="/settings/connectors"', html)
        self.assertIn('href="/runtimes"', html)
        language = html.find('href="/settings/language"')
        channels = html.find('href="/settings/channels"')
        agent_api = html.find('href="/settings/agent-access"')
        model_api = html.find('href="#model-api"')
        skills = html.find('href="/settings/skill-configuration"')
        connectors = html.find('href="/settings/connectors"')
        runtimes = html.find('href="/runtimes"')
        self.assertTrue(-1 < language < channels < agent_api < model_api < skills < connectors < runtimes)
        self.assertIn('href="/settings/appearance"', html)
        self.assertIn('href="/settings/shortcuts"', html)
        self.assertIn('href="/settings/message-folding"', html)
        self.assertIn('href="/settings/privacy"', html)
        self.assertIn('系统语言', html)
        self.assertIn('始终使用浅色主题。', html)
        self.assertIn('选择长消息在对话里最先展示多少内容。', html)
        self.assertIn('保存更改', html)
        self.assertIn('name="link_previews"', html)
        self.assertIn('role="switch"', html)
        self.assertIn('settings-row-icon', html)
        self.assertIn('settings-row-chevron', html)
        self.assertNotIn('按对照把总览和已有设置子页分开', html)
        self.assertIn('class="visually-hidden"', html)
        self.assertNotIn('0m 后重置', html)
        self.assertNotIn('已赚取', html)
        self.assertNotIn('$CASH', html)
        self.assertNotIn('CREDIT', html)
        self.assertNotIn('剩余 100%', html)
        self.assertNotIn('Free 套餐', html)
        self.assertNotIn('href="/settings/subscription"', html)
        self.assertNotIn('href="/settings/credits-center"', html)
        self.assertNotIn('href="/pricing"', html)
        self.assertNotIn('Teamily Agent', html)
        self.assertNotIn('<img', html)
        # Isolated word「用量」must not return as a billing-row label.
        self.assertNotIn('>用量</span>', html)
        self.assertNotIn('5 小时窗口', html)

    def test_recorded_subpages_serve_the_same_settings_shell(self):
        for path in ('/settings/appearance', '/settings/language',
                     '/settings/message-folding', '/settings/privacy',
                     '/settings/shortcuts', '/settings/channels',
                     '/settings/agent-access', '/settings/connectors',
                     '/settings/skill-configuration'):
            page = self.raw.call('GET', path)
            self.assertEqual(page['status'], 200, path)
            html = page['body'].decode()
            self.assertIn('id="settings-index"', html)
            self.assertIn(f'data-settings-page="{path.rsplit("/", 1)[-1]}"', html)
            self.assertEqual(page['headers']['Cache-Control'], 'no-store')
        self.assertEqual(self.raw.call('GET', '/settings/missing')['status'], 404)
        self.assertEqual(self.raw.call('GET', '/settings/appearance', query='q=1')['status'], 400)

    def test_channel_agent_api_and_connectors_pages_use_recorded_empty_states(self):
        html = self.raw.call('GET', '/settings/channels')['body'].decode()
        self.assertIn('data-settings-page="channels"', html)
        self.assertIn('WeChat Official Account', html)
        self.assertIn('Apple iMessage', html)
        self.assertIn('Slack', html)
        self.assertIn('WhatsApp', html)
        channels = html[html.find('data-settings-page="channels"'):html.find('data-settings-page="agent-access"')]
        self.assertEqual(channels.count('+ 连接'), 4)
        self.assertEqual(html.count('title="未实现：OpenTeamily 还没有接入'), 4)
        self.assertIn('disabled', html)
        self.assertNotIn('Teamily Agent', html)
        agent = self.raw.call('GET', '/settings/agent-access')['body'].decode()
        for ident in ('gateway-workspace', 'gateway-key-list', 'gateway-invocation-list',
                      'gateway-keys-empty', 'gateway-invocations-empty'):
            self.assertIn('id="%s"' % ident, agent)
        self.assertIn('你的 agent 还没有向本实例之外开放。', agent)
        self.assertIn('没有已授权的 AI 客户端。', agent)
        self.assertIn('Claude Code', agent)
        connectors = self.raw.call('GET', '/settings/connectors')['body'].decode()
        self.assertIn('placeholder="搜索应用…"', connectors)
        self.assertIn('+ 添加 MCP 服务器', connectors)
        self.assertIn('id="add-mcp-server"', connectors)
        self.assertIn('id="mcp-dialog"', connectors)
        self.assertIn('在智能体里添加自定义 MCP 服务器', connectors)
        self.assertIn('打开你创建的智能体、Personal AI 或内置智能体的聊天。', connectors)
        self.assertIn('点输入框里的「连接器」。', connectors)
        self.assertIn('点搜索框旁的「+」。', connectors)
        self.assertIn('id="mcp-dialog-ack"', connectors)
        self.assertIn('知道了', connectors)
        self.assertIn('hidden role="dialog"', connectors)
        self.assertNotIn('disabled title="未实现：对照里「添加 MCP 服务器」', connectors)
        self.assertNotIn('已连接', connectors)
        self.assertIn('不会添加或连接服务器', connectors)
        self.assertIn('class="connector-search-icon"', connectors)
        self.assertEqual(connectors.count('class="connector-row"'), 39)
        # Rows start disabled until the user's own Composio key is loaded.
        self.assertEqual(connectors.count('>未配置 Composio<'), 32)  # 31 rows + key card badge
        self.assertEqual(connectors.count('data-state="unavailable">未接通<'), 8)
        self.assertEqual(connectors.count('disabled title="未配置 Composio：先在本页上方填入你自己的 Composio API key，才能连接。">+ 连接'), 31)
        self.assertEqual(connectors.count('disabled title="未接通：Composio 没有这个应用，暂时不能连接。">+ 连接'), 8)
        self.assertIn('id="composio-key-form"', connectors)
        self.assertIn('id="connectors-catalog"', connectors)
        self.assertIn('没有匹配的应用。', connectors)
        self.assertIn('id="connectors-empty"', connectors)
        self.assertNotIn('还没有可连接的应用目录。', connectors)
        for name in ('GitHub', 'Notion', 'monday.com', 'Hugging Face', 'Microsoft Learn',
                     'Cloudflare Docs', 'Mailbox', 'Slack', 'Amap'):
            self.assertIn(f'>{name}<', connectors)
        script = self.raw.call('GET', '/settings/app.mjs')['body'].decode()
        css = self.raw.call('GET', '/settings/app.css')['body'].decode()
        for blob in (connectors, script, css):
            for marker in ('Ov23liin4waZGLSJJgn5', 'DS_BOT_GITHUB_OAUTH_CLIENT_ID',
                           'githubcopilot.com', 'mcp.notion.com', 'mcp.slack.com',
                           'api.github.com/user', 'X-MCP-Toolsets', 'lbs.amap.com',
                           'huggingface.co/mcp', 'learn.microsoft.com/api/mcp',
                           'docs.mcp.cloudflare.com', 'mcp.amap.com', 'GITHUB_TOKEN'):
                self.assertNotIn(marker, blob)

    def test_preference_subpages_follow_recorded_copy(self):
        html = self.raw.call('GET', '/settings/appearance')['body'].decode()
        self.assertIn('settings-card-title">自动切换', html)
        self.assertIn('暂按 22:00 至次日 06:00 为夜间', html)
        self.assertIn('可选用「自定义时段」', html)
        self.assertIn('id="appearance-status"', html)
        self.assertIn('class="settings-appearance-status"', html)
        self.assertLess(html.find('id="appearance"'), html.find('id="appearance-status"'))
        self.assertLess(html.find('id="appearance-status"'), html.find('id="appearance-schedule-card"'))
        self.assertLess(html.find('</fieldset>', html.find('id="appearance"')), html.find('id="appearance-status"'))
        self.assertNotIn('可能相差一小时以上', html)
        self.assertNotIn('可能偏差一小时以上', html)
        self.assertNotIn('按系统浅色或深色偏好估算', html)
        self.assertNotIn('按你所在地的日落和日出', html)

        language = self.raw.call('GET', '/settings/language')['body'].decode()
        self.assertIn('系统语言', language)
        self.assertIn('聊天语言', language)
        self.assertIn('自动翻译消息', language)
        self.assertIn('跟随界面语言', language)
        self.assertIn('class="settings-field"', language)

        folding = self.raw.call('GET', '/settings/message-folding')['body'].decode()
        self.assertIn('‹ 设置', folding)
        self.assertIn('选择长消息在对话里最先展示多少内容。', folding)
        self.assertIn('长消息会把对话推得很高。', folding)
        self.assertIn('长文档收成卡片', folding)
        self.assertIn('含多个章节的消息会显示为卡片', folding)
        self.assertNotIn('折叠前展示多少内容', folding)
        self.assertNotIn('长消息会拉开推动聊天窗', folding)

        privacy = self.raw.call('GET', '/settings/privacy')['body'].decode()
        self.assertIn('‹ 隐私设置', privacy)
        self.assertIn('管理你的社交动态对他人的可见性', privacy)
        self.assertIn('点赞列表', privacy)
        self.assertIn('收藏列表', privacy)
        self.assertIn('允许他人查看你点赞的内容', privacy)
        self.assertIn('允许他人查看你收藏的内容', privacy)
        self.assertIn('id="save"', privacy)
        self.assertIn('disabled', privacy)
        self.assertNotIn('没有留下这一页的版式截图', privacy)

        shortcuts = self.raw.call('GET', '/settings/shortcuts')['body'].decode()
        self.assertIn('‹ 快捷键', shortcuts)
        self.assertIn('>消息<', shortcuts)
        self.assertIn('发送消息', shortcuts)
        self.assertIn('name="send_shortcut"', shortcuts)
        self.assertIn('>Enter<', shortcuts)
        self.assertIn('Ctrl + Enter', shortcuts)
        self.assertIn('换行', shortcuts)
        self.assertIn('id="newline-keys"', shortcuts)
        self.assertNotIn('没有留下这一页的版式截图', shortcuts)
        self.assertNotIn('Enter 发送', shortcuts)




if __name__ == '__main__':
    unittest.main()
