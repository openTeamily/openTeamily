"""Transactional email templates.

The deployment supplies origin, sender, terms and privacy URLs through
configuration. No deployment hostname is embedded here. The HTML is
table-based with inline styles for email clients; every message also has a
plain-text alternative.
"""
from html import escape
from urllib.parse import urlsplit

BRAND = 'OpenTeamily'
INK = '#1f2a24'
MUTED = '#5a6861'
MUTED_2 = '#8a97a8'
LINE = '#e3e9e5'
BG = '#eef2ef'
CARD = '#ffffff'
SOFT = '#f7faf8'
ACCENT = '#097845'
FONT = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif"

VERIFY_SUBJECT = 'OpenTeamily 验证码 / verification code'
WELCOME_SUBJECT = '欢迎加入 OpenTeamily / Welcome to OpenTeamily'


def _origin(config):
    return (getattr(config, 'origin', '') or '').rstrip('/')


def _host(config):
    try:
        return urlsplit(_origin(config)).netloc
    except ValueError:
        return ''


def _link(config, url, label):
    value = escape(str(url or ''), quote=True)
    if not value:
        return f'《{escape(label)}》'
    return f'<a href="{value}" style="color:{ACCENT};text-decoration:underline;">《{escape(label)}》</a>'


def _support(config):
    return escape(str(getattr(config, 'mail_from', '') or ''), quote=True)


def _shell(config, preheader, eyebrow, title, content, footer_note):
    origin = escape(_origin(config) or '', quote=True)
    host = escape(_host(config) or '', quote=True)
    support = _support(config)
    support_line = (f'需要帮助？<a href="mailto:{support}" style="color:{MUTED};text-decoration:underline;">{support}</a>'
                    if support else '')
    return f'''<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="x-apple-disable-message-reformatting">
<title>{escape(title)}</title>
<style>
  @media (max-width:480px){{
    .ot-pad{{padding-left:20px!important;padding-right:20px!important}}
    .ot-code{{font-size:28px!important;letter-spacing:6px!important;padding:12px 16px!important}}
    .ot-title{{font-size:24px!important}}
  }}
</style>
</head>
<body style="margin:0;padding:0;background:{BG};">
<div style="display:none;font-size:1px;color:{BG};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">{escape(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:{BG};padding:28px 12px;">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:{CARD};border:1px solid {LINE};border-radius:16px;overflow:hidden;{FONT};">
<tr><td class="ot-pad" style="padding:28px 32px 0;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
    <td width="36" height="36" style="width:36px;height:36px;background:{ACCENT};border-radius:10px;color:#ffffff;font-size:14px;font-weight:800;line-height:36px;text-align:center;">OT</td>
    <td style="padding-left:11px;color:{INK};font-size:18px;font-weight:700;letter-spacing:-.02em;">{BRAND}</td>
  </tr></table>
</td></tr>
<tr><td class="ot-pad" style="padding:22px 32px 0;">
  <div style="color:{ACCENT};font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;">{escape(eyebrow)}</div>
  <h1 class="ot-title" style="margin:8px 0 0;color:{INK};font-size:27px;line-height:1.2;letter-spacing:-.03em;font-weight:700;">{escape(title)}</h1>
</td></tr>
{content}
<tr><td class="ot-pad" style="padding:18px 32px;background:{SOFT};border-top:1px solid {LINE};color:{MUTED_2};font-size:11px;line-height:1.65;">
  <div>{BRAND}{(' · ' + f'<a href="{origin}" style="color:{MUTED};text-decoration:none;">{host}</a>') if host else ''}</div>
  <div style="margin-top:4px;">{escape(footer_note)}</div>
  {f'<div style="margin-top:4px;">{support_line}</div>' if support_line else ''}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>'''


def verification(config, code, email):
    """Return (subject, text, html) for a verification code."""
    terms = _link(config, getattr(config, 'terms_url', ''), '服务条款')
    privacy = _link(config, getattr(config, 'privacy_url', ''), '隐私政策')
    safe_code = escape(str(code))
    safe_email = escape(str(email))
    content = f'''
<tr><td class="ot-pad" style="padding:16px 32px 0;">
  <p style="margin:0;color:{MUTED};font-size:15px;line-height:1.75;">你正在注册 OpenTeamily。请输入下面的验证码完成邮箱验证。验证码已发送至 <b style="color:{INK};">{safe_email}</b>。</p>
</td></tr>
<tr><td align="center" class="ot-pad" style="padding:24px 32px 18px;">
  <div class="ot-code" style="display:inline-block;padding:14px 24px;border:1px solid {LINE};border-radius:12px;background:{SOFT};color:{INK};font-size:32px;font-weight:700;letter-spacing:8px;line-height:1.2;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;">{safe_code}</div>
  <div style="margin-top:10px;color:{MUTED};font-size:13px;">10 分钟内有效 · 只能使用一次</div>
</td></tr>
<tr><td class="ot-pad" style="padding:0 32px 24px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid {LINE};border-radius:12px;background:{SOFT};">
    <tr><td style="padding:14px 16px;color:{MUTED};font-size:13px;line-height:1.75;">注册即表示你同意 {terms} 和 {privacy}，并同意我们向该邮箱发送账号验证、安全提醒和必要的服务通知。</td></tr>
  </table>
  <p style="margin:14px 0 0;color:{MUTED_2};font-size:12px;line-height:1.65;">如果这不是你本人操作，请忽略此邮件；你的邮箱不会被加入账号。</p>
</td></tr>'''
    text = (
        f'你正在注册 OpenTeamily。\n\n'
        f'验证码：{code}\n'
        '10 分钟内有效，只能使用一次。\n\n'
        f'注册即表示你同意《服务条款》{getattr(config, "terms_url", "") or ""} 和《隐私政策》{getattr(config, "privacy_url", "") or ""}，'
        '并同意我们向该邮箱发送账号验证、安全提醒和必要的服务通知。\n\n'
        '如果这不是你本人操作，请忽略此邮件。\n'
    )
    html = _shell(config, '你的 OpenTeamily 验证码 10 分钟内有效。', 'ACCOUNT SECURITY', '验证你的邮箱', content,
                  '这是一封账号安全邮件，无需退订。')
    return VERIFY_SUBJECT, text, html


def welcome(config, email, username, via='email'):
    """Return (subject, text, html) for a newly created account."""
    origin = _origin(config)
    safe_email = escape(str(email))
    safe_name = escape(str(username or email))
    if via == 'github':
        via_text = '你已通过 GitHub 登录并创建 OpenTeamily 账号。'
    elif via == 'oidc':
        via_text = '你已通过第三方登录并创建 OpenTeamily 账号。'
    else:
        via_text = '你的邮箱已验证，OpenTeamily 账号已创建。'
    terms = _link(config, getattr(config, 'terms_url', ''), '服务条款')
    privacy = _link(config, getattr(config, 'privacy_url', ''), '隐私政策')
    support = _support(config)
    chat = f'{origin}/chat'
    team = f'{origin}/team'
    agents = f'{origin}/agents'
    settings = f'{origin}/settings'
    content = f'''
<tr><td class="ot-pad" style="padding:16px 32px 0;">
  <p style="margin:0 0 10px;color:{MUTED};font-size:15px;line-height:1.75;">你好，<b style="color:{INK};">{safe_name}</b>，</p>
  <p style="margin:0;color:{MUTED};font-size:15px;line-height:1.75;">{escape(via_text)}你的账号 <b style="color:{INK};">{safe_email}</b> 已准备好。</p>
</td></tr>
<tr><td class="ot-pad" style="padding:22px 32px 6px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr>
      <td style="padding:0 5px 8px 0;width:50%;"><a href="{escape(chat, quote=True)}" style="display:block;padding:11px 12px;background:{ACCENT};color:#ffffff;border-radius:9px;text-align:center;font-size:13px;font-weight:700;text-decoration:none;">开始聊天</a></td>
      <td style="padding:0 0 8px 5px;width:50%;"><a href="{escape(team, quote=True)}" style="display:block;padding:11px 12px;background:{CARD};border:1px solid {LINE};color:{INK};border-radius:9px;text-align:center;font-size:13px;font-weight:700;text-decoration:none;">创建或加入团队</a></td>
    </tr>
    <tr>
      <td style="padding:0 5px 0 0;width:50%;"><a href="{escape(agents, quote=True)}" style="display:block;padding:11px 12px;background:{CARD};border:1px solid {LINE};color:{INK};border-radius:9px;text-align:center;font-size:13px;font-weight:700;text-decoration:none;">配置 Agent</a></td>
      <td style="padding:0 0 0 5px;width:50%;"><a href="{escape(settings, quote=True)}" style="display:block;padding:11px 12px;background:{CARD};border:1px solid {LINE};color:{INK};border-radius:9px;text-align:center;font-size:13px;font-weight:700;text-decoration:none;">账户设置</a></td>
    </tr>
  </table>
</td></tr>
<tr><td class="ot-pad" style="padding:14px 32px 0;">
  <p style="margin:0 0 6px;color:{INK};font-size:14px;font-weight:700;">接下来可以</p>
  <ul style="margin:0;padding-left:20px;color:{MUTED};font-size:13px;line-height:1.8;">
    <li>在团队中邀请成员，或让 Agent 加入工作区；</li>
    <li>创建第一个 Agent，配置模型、工具和运行环境；</li>
    <li>在设置中调整外观、语言和安全选项。</li>
  </ul>
</td></tr>
<tr><td class="ot-pad" style="padding:16px 32px 24px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid {LINE};border-radius:12px;background:{SOFT};">
    <tr><td style="padding:14px 16px;color:{MUTED};font-size:13px;line-height:1.75;">你已同意 {terms} 和 {privacy}。我们只会向该邮箱发送账号验证、安全提醒和必要的服务通知。</td></tr>
  </table>
  <p style="margin:14px 0 0;color:{MUTED_2};font-size:12px;line-height:1.65;">如果你没有创建这个账号，请立即联系{' ' + f'<a href="mailto:{support}" style="color:{MUTED};">{support}</a>' if support else '部署方'}。</p>
</td></tr>'''
    text = (
        f'你好，{username or email}，\n\n'
        f'{via_text}你的账号 {email} 已准备好。\n\n'
        f'开始聊天：{chat}\n'
        f'创建或加入团队：{team}\n'
        f'配置 Agent：{agents}\n'
        f'账户设置：{settings}\n\n'
        '你已同意服务条款和隐私政策。我们只会向该邮箱发送账号验证、安全提醒和必要的服务通知。\n\n'
        '如果这不是你本人操作，请联系部署方。\n'
    )
    html = _shell(config, '你的 OpenTeamily 账号已创建。', 'WELCOME', f'欢迎加入 {BRAND}', content,
                  '你收到这封邮件，是因为该邮箱创建了 OpenTeamily 账号。')
    return WELCOME_SUBJECT, text, html


PASSWORD_SUBJECT = '设置你的 OpenTeamily 密码 / Set your OpenTeamily password'


def password_setup(config, link, email, ttl_minutes=30):
    """Return (subject, text, html) for a single-use password setup link."""
    origin = _origin(config)
    host = _host(config)
    safe_email = escape(str(email))
    safe_link = escape(str(link or ''), quote=True)
    terms = _link(config, getattr(config, 'terms_url', ''), '服务条款')
    privacy = _link(config, getattr(config, 'privacy_url', ''), '隐私政策')
    support = _support(config)
    content = f'''
<tr><td class="ot-pad" style="padding:16px 32px 0;">
  <p style="margin:0;color:{MUTED};font-size:15px;line-height:1.75;">你好，</p>
  <p style="margin:8px 0 0;color:{MUTED};font-size:15px;line-height:1.75;">我们收到了为 <b style="color:{INK};">{safe_email}</b> 创建或设置 OpenTeamily 密码的请求。点击下面的按钮设置密码，然后就可以用邮箱和密码登录。</p>
</td></tr>
<tr><td align="center" class="ot-pad" style="padding:22px 32px 10px;">
  <a href="{safe_link}" style="display:inline-block;padding:13px 22px;border-radius:10px;background:{ACCENT};color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;">设置密码</a>
  <div style="margin-top:10px;color:{MUTED};font-size:13px;">{ttl_minutes} 分钟内有效 · 只能使用一次</div>
</td></tr>
<tr><td class="ot-pad" style="padding:6px 32px 4px;">
  <p style="margin:0;color:{MUTED_2};font-size:12px;line-height:1.7;">如果按钮无法打开，请复制这个链接到浏览器：<br><a href="{safe_link}" style="color:{MUTED};word-break:break-all;text-decoration:underline;">{safe_link}</a></p>
</td></tr>
<tr><td class="ot-pad" style="padding:16px 32px 24px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid {LINE};border-radius:12px;background:{SOFT};">
    <tr><td style="padding:14px 16px;color:{MUTED};font-size:13px;line-height:1.75;">设置密码即表示你同意 {terms} 和 {privacy}。我们只会向该邮箱发送账号验证、安全提醒和必要的服务通知。</td></tr>
  </table>
  <p style="margin:14px 0 0;color:{MUTED_2};font-size:12px;line-height:1.65;">如果这不是你本人操作，请忽略此邮件；链接过期后不会生效。需要帮助？{'<a href="mailto:' + support + '" style="color:' + MUTED + ';text-decoration:underline;">' + support + '</a>' if support else '请联系部署方'}。</p>
</td></tr>'''
    text = (
        f'你好，\n\n'
        f'我们收到了为 {email} 创建或设置 OpenTeamily 密码的请求。\n'
        f'请在 {ttl_minutes} 分钟内打开下面的链接设置密码（只能使用一次）：\n\n'
        f'{link}\n\n'
        f'设置密码即表示你同意《服务条款》{getattr(config, "terms_url", "") or ""} 和《隐私政策》{getattr(config, "privacy_url", "") or ""}。\n'
        f'我们只会向该邮箱发送账号验证、安全提醒和必要的服务通知。\n\n'
        '如果这不是你本人操作，请忽略此邮件。\n'
    )
    html = _shell(config, '设置你的 OpenTeamily 密码，链接 30 分钟内有效。', 'ACCOUNT SECURITY', '设置你的密码', content,
                  '这是一封账号安全邮件，无需退订。')
    return PASSWORD_SUBJECT, text, html
