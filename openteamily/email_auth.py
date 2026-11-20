"""Email password setup and email-code login.

Registration by email sends a single-use *set-password* link; a six-digit email
code is only for logging in to an existing account. The module never stores a
plaintext token/code, never returns one to the client and never logs a code or
SMTP credential.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import re
import secrets
import smtplib
import ssl
import time
from email.message import EmailMessage
from email.utils import formatdate, make_msgid
from urllib.parse import quote

from . import email_templates, oidc
from .security import digest, password_hash, password_matches

SCHEMA = '''
CREATE TABLE IF NOT EXISTS email_codes (
 email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires INTEGER NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, ip_hash TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS email_code_created ON email_codes(created);
CREATE TABLE IF NOT EXISTS email_sends (
 email TEXT NOT NULL, created INTEGER NOT NULL, ip_hash TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS email_send_email ON email_sends(email, created);
CREATE INDEX IF NOT EXISTS email_send_ip ON email_sends(ip_hash, created);
CREATE TABLE IF NOT EXISTS user_consents (
 user_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL,
 version TEXT NOT NULL, accepted INTEGER NOT NULL, PRIMARY KEY(user_id, kind));
CREATE TABLE IF NOT EXISTS password_setup_tokens (
 token_hash TEXT PRIMARY KEY,
 email TEXT NOT NULL,
 user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
 expires INTEGER NOT NULL,
 created INTEGER NOT NULL,
 used INTEGER NOT NULL DEFAULT 0 CHECK(used IN (0,1)),
 ip_hash TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS password_setup_email ON password_setup_tokens(email, created);
'''

CODE_RE = re.compile(r'[0-9]{6}')
TOKEN_RE = re.compile(r'[A-Za-z0-9_-]{43}')


def _refuse(status, code, message, retry_after=None):
    from .app import APIError
    error = APIError(status, code, message)
    error.retry_after = retry_after
    raise error


def valid_password(value):
    if not isinstance(value, str) or not 12 <= len(value) <= 256:
        return False
    try:
        return len(value.encode('utf-8')) <= 256
    except UnicodeError:
        return False


class SmtpMailer:
    """Small stdlib SMTP sender; all values come from deployment configuration."""

    def __init__(self, config):
        self.config = config

    def _send(self, to, subject, text, body):
        message = EmailMessage()
        message['From'] = self.config.mail_from
        message['To'] = to
        message['Subject'] = subject
        message['Date'] = formatdate(localtime=False)
        message['Message-ID'] = make_msgid(domain=self.config.mail_from.split('@', 1)[-1] or None)
        message['Auto-Submitted'] = 'auto-generated'
        message['Reply-To'] = self.config.mail_from
        message.set_content(text)
        message.add_alternative(body, subtype='html')
        context = ssl.create_default_context()
        if self.config.smtp_port == 465:
            server = smtplib.SMTP_SSL(self.config.smtp_host, self.config.smtp_port,
                                      timeout=20, context=context)
        else:
            server = smtplib.SMTP(self.config.smtp_host, self.config.smtp_port, timeout=20)
            server.starttls(context=context)
        try:
            if self.config.smtp_user:
                server.login(self.config.smtp_user, self.config.smtp_password)
            server.send_message(message)
        finally:
            try:
                server.quit()
            except Exception:
                pass

    def send_password_setup(self, to, link):
        subject, text, body = email_templates.password_setup(
            self.config, link, to, self.config.password_setup_ttl // 60)
        self._send(to, subject, text, body)

    def send_login_code(self, to, code):
        subject, text, body = email_templates.verification(self.config, code, to)
        self._send(to, subject, text, body)

    def send_welcome(self, to, username, via='email'):
        subject, text, body = email_templates.welcome(self.config, to, username, via)
        self._send(to, subject, text, body)


class EmailAuth:
    def __init__(self, app, mailer=None):
        self.app = app
        self.mailer = mailer or SmtpMailer(app.config)

    @property
    def config(self):
        return self.app.config

    def _email(self, body):
        value = body.get('email')
        if not isinstance(value, str):
            _refuse(400, 'invalid', '请输入邮箱地址')
        email = value.strip().lower()
        if not oidc.valid_email(email):
            _refuse(400, 'invalid', '请输入有效邮箱地址')
        return email

    def _token_hash(self, token):
        key = oidc.wrapping_key(self.app.store)
        return hmac.new(key, ('password-setup\0' + token).encode('utf-8'), hashlib.sha256).hexdigest()

    def _code_hash(self, email, code):
        key = oidc.wrapping_key(self.app.store)
        return hmac.new(key, f'{email}\0{code}'.encode('utf-8'), hashlib.sha256).hexdigest()

    def _peer_hash(self, env):
        return digest(str(env.get('REMOTE_ADDR', ''))[:128])

    def _send_limit(self, db, email, peer, now):
        db.execute('DELETE FROM email_sends WHERE created<=?', (now - 3600,))
        if db.execute('SELECT COUNT(*) FROM email_sends WHERE email=?', (email,)).fetchone()[0] >= self.config.email_per_hour:
            _refuse(429, 'rate_limited', '邮件发送过于频繁，请稍后再试')
        if db.execute('SELECT COUNT(*) FROM email_sends WHERE ip_hash=?', (peer,)).fetchone()[0] >= self.config.email_ip_per_hour:
            _refuse(429, 'rate_limited', '邮件发送过于频繁，请稍后再试')
        row = db.execute('SELECT MAX(created) AS created FROM email_sends WHERE email=?', (email,)).fetchone()
        if row is not None and row['created'] is not None and now - row['created'] < self.config.email_resend_seconds:
            _refuse(429, 'resend_wait', '请稍后再获取新邮件',
                    retry_after=self.config.email_resend_seconds - (now - row['created']))

    def request_password(self, env, now, body):
        if not self.config.email_registration:
            _refuse(403, 'registration_closed', '邮箱注册尚未开放')
        if body.get('accept_terms') is not True:
            _refuse(400, 'terms_required', '请先同意服务条款和隐私政策')
        email = self._email(body)
        self.app.rate_limit(env, 'email-password:' + email, now)
        peer = self._peer_hash(env)
        token = secrets.token_urlsafe(32)
        token_hash = self._token_hash(token)
        with self.app.store.transaction() as db:
            self._send_limit(db, email, peer, now)
            owner = db.execute('SELECT user_id FROM user_emails WHERE email=?', (email,)).fetchone()
            user_id = owner['user_id'] if owner is not None else None
            db.execute('DELETE FROM password_setup_tokens WHERE email=? OR expires<=?', (email, now))
            db.execute('INSERT INTO password_setup_tokens(token_hash,email,user_id,expires,created,used,ip_hash) '
                       'VALUES(?,?,?,?,?,0,?)',
                       (token_hash, email, user_id, now + self.config.password_setup_ttl, now, peer))
            db.execute('INSERT INTO email_sends(email,created,ip_hash) VALUES(?,?,?)', (email, now, peer))
        link = self.config.origin.rstrip('/') + '/set-password?token=' + quote(token)
        try:
            self.mailer.send_password_setup(email, link)
        except Exception:
            with self.app.store.transaction() as db:
                db.execute('DELETE FROM password_setup_tokens WHERE token_hash=?', (token_hash,))
            _refuse(503, 'mail_unavailable', '设置密码邮件暂时无法发送，请稍后再试')
        return 200, {'ok': True, 'expires_in': self.config.password_setup_ttl}, []

    def complete_password(self, env, now, body):
        token = body.get('token')
        password = body.get('password')
        if not isinstance(token, str) or TOKEN_RE.fullmatch(token) is None or not valid_password(password):
            _refuse(400, 'invalid', '链接无效或密码不符合要求')
        token_hash = self._token_hash(token)
        self.app.rate_limit(env, 'password-complete:' + token_hash[:16], now)
        failure = None
        headers = None
        registered = False
        user = None
        with self.app.store.transaction() as db:
            row = db.execute('SELECT * FROM password_setup_tokens WHERE token_hash=?', (token_hash,)).fetchone()
            if row is None or row['used'] or row['expires'] <= now:
                failure = (400, 'invalid_token', '设置密码链接无效或已过期')
            else:
                email = row['email']
                user_id = row['user_id']
                if user_id is None:
                    if db.execute('SELECT COUNT(*) FROM users').fetchone()[0] >= self.config.max_users:
                        failure = (429, 'quota', '实例账户数量已达上限')
                    else:
                        user_id = secrets.token_hex(16)
                        base = oidc.username_for(email, user_id)
                        username, suffix = base, 0
                        while db.execute('SELECT id FROM users WHERE username=?', (username,)).fetchone():
                            suffix += 1
                            username = (base[:28] + '-' + str(suffix))[:64]
                        db.execute('INSERT INTO users VALUES(?,?,?,?)',
                                   (user_id, username, password_hash(password), now))
                        db.execute('INSERT INTO user_emails VALUES(?,?,1,?)', (user_id, email, now))
                        registered = True
                else:
                    db.execute('UPDATE users SET password_hash=? WHERE id=?',
                               (password_hash(password), user_id))
                    db.execute('UPDATE user_emails SET verified=1 WHERE user_id=? AND email=?',
                               (user_id, email))
                if failure is None:
                    db.execute('UPDATE password_setup_tokens SET used=1 WHERE token_hash=?', (token_hash,))
                    db.execute('DELETE FROM password_setup_tokens WHERE email=? AND token_hash<>?',
                               (email, token_hash))
                    db.execute('INSERT OR REPLACE INTO user_consents VALUES(?,?,?,?)',
                               (user_id, 'terms', self.config.terms_url or 'v1', now))
                    user = db.execute('SELECT id, username FROM users WHERE id=?', (user_id,)).fetchone()
                    headers = self.app.new_session(db, user_id, now)
        if failure is not None:
            _refuse(*failure)
        if registered and user is not None:
            try:
                self.mailer.send_welcome(row['email'], user['username'], 'email')
            except Exception:
                pass
        return 200, {'user': {'id': user['id'], 'username': user['username']},
                     'registered': registered}, headers

    def start_login(self, env, now, body):
        if not self.config.email_registration:
            _refuse(403, 'registration_closed', '邮箱登录尚未开放')
        email = self._email(body)
        self.app.rate_limit(env, 'email-login:' + email, now)
        peer = self._peer_hash(env)
        with self.app.store.transaction() as db:
            self._send_limit(db, email, peer, now)
            owner = db.execute('SELECT user_id FROM user_emails WHERE email=?', (email,)).fetchone()
            code = f'{secrets.randbelow(1000000):06d}'
            if owner is not None:
                db.execute('INSERT INTO email_codes(email,code_hash,expires,attempts,created,ip_hash) '
                           'VALUES(?,?,?,0,?,?) ON CONFLICT(email) DO UPDATE SET '
                           'code_hash=excluded.code_hash, expires=excluded.expires, attempts=0, '
                           'created=excluded.created, ip_hash=excluded.ip_hash',
                           (email, self._code_hash(email, code), now + self.config.email_code_ttl, now, peer))
            db.execute('INSERT INTO email_sends(email,created,ip_hash) VALUES(?,?,?)', (email, now, peer))
        if owner is not None:
            try:
                self.mailer.send_login_code(email, code)
            except Exception:
                with self.app.store.transaction() as db:
                    db.execute('DELETE FROM email_codes WHERE email=?', (email,))
                _refuse(503, 'mail_unavailable', '登录邮件暂时无法发送，请稍后再试')
        return 200, {'ok': True, 'expires_in': self.config.email_code_ttl}, []

    def verify_login(self, env, now, body):
        if not self.config.email_registration:
            _refuse(403, 'registration_closed', '邮箱登录尚未开放')
        email = self._email(body)
        code = body.get('code')
        if not isinstance(code, str) or CODE_RE.fullmatch(code.strip()) is None:
            _refuse(400, 'invalid_code', '验证码不正确或已过期')
        code = code.strip()
        self.app.rate_limit(env, 'email-login-verify:' + email, now)
        failure = None
        headers = None
        user = None
        with self.app.store.transaction() as db:
            row = db.execute('SELECT * FROM email_codes WHERE email=?', (email,)).fetchone()
            owner = db.execute('SELECT user_id FROM user_emails WHERE email=?', (email,)).fetchone()
            if row is None or owner is None or row['expires'] <= now:
                failure = (400, 'invalid_code', '验证码不正确或已过期')
            elif row['attempts'] >= self.config.email_code_attempts:
                db.execute('DELETE FROM email_codes WHERE email=?', (email,))
                failure = (429, 'too_many_attempts', '验证码尝试次数过多，请重新获取')
            elif not hmac.compare_digest(row['code_hash'], self._code_hash(email, code)):
                db.execute('UPDATE email_codes SET attempts=attempts+1 WHERE email=?', (email,))
                failure = (400, 'invalid_code', '验证码不正确或已过期')
            else:
                db.execute('DELETE FROM email_codes WHERE email=?', (email,))
                user = db.execute('SELECT id, username FROM users WHERE id=?', (owner['user_id'],)).fetchone()
                if user is None:
                    failure = (400, 'invalid_code', '验证码不正确或已过期')
                else:
                    headers = self.app.new_session(db, user['id'], now)
        if failure is not None:
            _refuse(*failure)
        return 200, {'user': {'id': user['id'], 'username': user['username']}}, headers
