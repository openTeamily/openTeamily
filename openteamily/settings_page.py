"""Same-origin management pages for the /v1 APIs (settings and automations).

Serves only an exact asset allowlist. API security stays in App; this wrapper
does not interpret /v1 routes. Self-written; no upstream or Teamily source.
"""
import os
import re
from pathlib import Path
import stat
from urllib.parse import parse_qsl, urlsplit

from . import discover


class SettingsPage:
    ASSETS = {
        '/register': ('register', 'index.html', 'text/html; charset=utf-8'),
        '/register/app.mjs': ('register', 'app.mjs', 'text/javascript; charset=utf-8'),
        '/register/app.css': ('register', 'app.css', 'text/css; charset=utf-8'),
        '/set-password': ('set-password', 'index.html', 'text/html; charset=utf-8'),
        '/set-password/app.mjs': ('set-password', 'app.mjs', 'text/javascript; charset=utf-8'),
        '/set-password/app.css': ('set-password', 'app.css', 'text/css; charset=utf-8'),
        '/settings': ('settings', 'index.html', 'text/html; charset=utf-8'),
        '/settings/appearance': ('settings', 'index.html', 'text/html; charset=utf-8'),
        '/settings/language': ('settings', 'index.html', 'text/html; charset=utf-8'),
        '/settings/message-folding': ('settings', 'index.html', 'text/html; charset=utf-8'),
        '/settings/privacy': ('settings', 'index.html', 'text/html; charset=utf-8'),
        '/settings/shortcuts': ('settings', 'index.html', 'text/html; charset=utf-8'),
        '/settings/channels': ('settings', 'index.html', 'text/html; charset=utf-8'),
        '/settings/agent-access': ('settings', 'index.html', 'text/html; charset=utf-8'),
        '/settings/connectors': ('settings', 'index.html', 'text/html; charset=utf-8'),
        '/settings/skill-configuration': ('settings', 'index.html', 'text/html; charset=utf-8'),
        '/settings/custom-mcp.mjs': ('settings', 'custom-mcp.mjs', 'text/javascript; charset=utf-8'),
        '/settings/connected-tools.mjs': ('settings', 'connected-tools.mjs', 'text/javascript; charset=utf-8'),
        '/settings/app.mjs': ('settings', 'app.mjs', 'text/javascript; charset=utf-8'),
        '/settings/app.css': ('settings', 'app.css', 'text/css; charset=utf-8'),
        '/automations': ('automations', 'index.html', 'text/html; charset=utf-8'),
        '/automations/app.mjs': ('automations', 'app.mjs', 'text/javascript; charset=utf-8'),
        '/automations/app.css': ('automations', 'app.css', 'text/css; charset=utf-8'),
        '/team': ('team', 'index.html', 'text/html; charset=utf-8'),
        '/new/team': ('team', 'index.html', 'text/html; charset=utf-8'),
        '/team/app.mjs': ('team', 'app.mjs', 'text/javascript; charset=utf-8'),
        '/team/app.css': ('team', 'app.css', 'text/css; charset=utf-8'),
        '/members': ('members', 'index.html', 'text/html; charset=utf-8'),
        '/members/app.mjs': ('members', 'app.mjs', 'text/javascript; charset=utf-8'),
        '/members/app.css': ('members', 'app.css', 'text/css; charset=utf-8'),
        '/runtimes': ('runtimes', 'index.html', 'text/html; charset=utf-8'),
        '/runtimes/app.mjs': ('runtimes', 'app.mjs', 'text/javascript; charset=utf-8'),
        '/runtimes/app.css': ('runtimes', 'app.css', 'text/css; charset=utf-8'),
        '/artifacts': ('artifacts', 'index.html', 'text/html; charset=utf-8'),
        '/artifacts/app.mjs': ('artifacts', 'app.mjs', 'text/javascript; charset=utf-8'),
        '/artifacts/app.css': ('artifacts', 'app.css', 'text/css; charset=utf-8'),
        '/space': ('artifacts', 'index.html', 'text/html; charset=utf-8'),
        '/agents': ('agents', 'index.html', 'text/html; charset=utf-8'),
        '/agents/app.mjs': ('agents', 'app.mjs', 'text/javascript; charset=utf-8'),
        '/agents/app.css': ('agents', 'app.css', 'text/css; charset=utf-8'),
        '/memory': ('memory', 'index.html', 'text/html; charset=utf-8'),
        '/memory/app.mjs': ('memory', 'app.mjs', 'text/javascript; charset=utf-8'),
        '/memory/rich.mjs': ('memory', 'rich.mjs', 'text/javascript; charset=utf-8'),
        '/memory/app.css': ('memory', 'app.css', 'text/css; charset=utf-8'),
        '/install/flybot.sh': ('install', 'flybot.sh', 'text/plain; charset=utf-8'),
        '/install/flybot.ps1': ('install', 'flybot.ps1', 'text/plain; charset=utf-8'),
        '/shell/app.css': ('shell', 'app.css', 'text/css; charset=utf-8'),
        '/shell/app.mjs': ('shell', 'app.mjs', 'text/javascript; charset=utf-8'),
        '/shell/rich-editor.mjs': ('shell', 'rich-editor.mjs', 'text/javascript; charset=utf-8'),
        '/shell/thumb.mjs': ('shell', 'thumb.mjs', 'text/javascript; charset=utf-8'),
        '/shell/dsbot-api.mjs': ('shell', 'dsbot-api.mjs', 'text/javascript; charset=utf-8'),
        '/chat': ('chat', 'index.html', 'text/html; charset=utf-8'),
        '/chat/utilities.mjs': ('chat', 'utilities.mjs', 'text/javascript; charset=utf-8'),
        '/chat/app.mjs': ('chat', 'app.mjs', 'text/javascript; charset=utf-8'),
        '/chat/app.css': ('chat', 'app.css', 'text/css; charset=utf-8'),
        '/messenger': ('messenger', 'index.html', 'text/html; charset=utf-8'),
        '/messenger/app.mjs': ('messenger', 'app.mjs', 'text/javascript; charset=utf-8'),
        '/messenger/app.css': ('messenger', 'app.css', 'text/css; charset=utf-8'),
        '/discover': ('discover', 'index.html', 'text/html; charset=utf-8'),
        '/discover/app.mjs': ('discover', 'app.mjs', 'text/javascript; charset=utf-8'),
        '/discover/app.css': ('discover', 'app.css', 'text/css; charset=utf-8'),
        '/meetings': ('meetings', 'index.html', 'text/html; charset=utf-8'),
        '/meetings/app.mjs': ('meetings', 'app.mjs', 'text/javascript; charset=utf-8'),
        '/meetings/app.css': ('meetings', 'app.css', 'text/css; charset=utf-8'),
        '/profile': ('profile', 'index.html', 'text/html; charset=utf-8'),
        '/profile/edit': ('profile', 'index.html', 'text/html; charset=utf-8'),
        '/profile/app.mjs': ('profile', 'app.mjs', 'text/javascript; charset=utf-8'),
        '/onboarding': ('onboarding', 'index.html', 'text/html; charset=utf-8'),
        '/onboarding/app.mjs': ('onboarding', 'app.mjs', 'text/javascript; charset=utf-8'),
        '/onboarding/app.css': ('onboarding', 'app.css', 'text/css; charset=utf-8'),
        '/profile/app.css': ('profile', 'app.css', 'text/css; charset=utf-8'),
        '/download': ('download', 'index.html', 'text/html; charset=utf-8'),
        '/download/app.mjs': ('download', 'app.mjs', 'text/javascript; charset=utf-8'),
        '/guide': ('guide', 'index.html', 'text/html; charset=utf-8'),
        '/guide/app.mjs': ('guide', 'app.mjs', 'text/javascript; charset=utf-8'),
        '/guide/app.css': ('guide', 'app.css', 'text/css; charset=utf-8'),
        '/about': ('about', 'index.html', 'text/html; charset=utf-8'),
        '/about/app.css': ('about', 'app.css', 'text/css; charset=utf-8'),
        '/look/app.mjs': ('look', 'app.mjs', 'text/javascript; charset=utf-8'),
        '/look/app.css': ('look', 'app.css', 'text/css; charset=utf-8'),
        '/skills': ('skills', 'index.html', 'text/html; charset=utf-8'),
        '/skills/imports.mjs': ('skills', 'imports.mjs', 'text/javascript; charset=utf-8'),
        '/shell/workspace-events.mjs': ('shell', 'workspace-events.mjs', 'text/javascript; charset=utf-8'),
        '/skills/execution.mjs': ('skills', 'execution.mjs', 'text/javascript; charset=utf-8'),
        '/skills/app.mjs': ('skills', 'app.mjs', 'text/javascript; charset=utf-8'),
        '/skills/app.css': ('skills', 'app.css', 'text/css; charset=utf-8'),
        '/help': ('help', 'index.html', 'text/html; charset=utf-8'),
        '/terms': ('terms', 'index.html', 'text/html; charset=utf-8'),
        '/privacy': ('privacy', 'index.html', 'text/html; charset=utf-8'),
        '/docs/app.css': ('docs', 'app.css', 'text/css; charset=utf-8'),
        '/': ('home', 'index.html', 'text/html; charset=utf-8'),
        '/home': ('home', 'index.html', 'text/html; charset=utf-8'),
        '/home/app.mjs': ('home', 'app.mjs', 'text/javascript; charset=utf-8'),
        '/home/app.css': ('home', 'app.css', 'text/css; charset=utf-8'),
    }
    PREFIXES = ('/register', '/set-password', '/settings', '/automations', '/team', '/new', '/members', '/runtimes', '/artifacts', '/space', '/agents', '/memory', '/install', '/shell', '/chat', '/messenger', '/discover', '/onboarding', '/profile', '/meetings', '/download', '/guide', '/about', '/skills', '/home', '/help', '/terms', '/privacy', '/docs')
    CSP = ("default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; "
           "img-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'self'; "
           "frame-ancestors 'none'; object-src 'none'")

    def __init__(self, api):
        self.api = api
        self.root = Path(__file__).absolute().parent / 'static'

    @property
    def config(self):
        return self.api.config

    @config.setter
    def config(self, value):
        self.api.config = value


    def _bundle(self, env, start_response):
        from .flybot_bundle import build
        headers = [('Cache-Control', 'no-store'), ('X-Content-Type-Options', 'nosniff'),
                   ('Content-Security-Policy', self.CSP), ('Referrer-Policy', 'no-referrer'),
                   ('Cross-Origin-Resource-Policy', 'same-origin'),
                   ('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')]
        origin = self.api.config.origin
        if (env.get('HTTP_HOST') != urlsplit(origin).netloc
                or env.get('HTTP_ORIGIN', origin) != origin
                or env.get('HTTP_SEC_FETCH_SITE', '') not in ('', 'same-origin', 'none')):
            data = b'Same-origin request required'
            status, content_type = '403 Forbidden', 'text/plain; charset=utf-8'
        elif env.get('REQUEST_METHOD') not in ('GET', 'HEAD'):
            data = b'Use GET or HEAD'
            status, content_type = '405 Method Not Allowed', 'text/plain; charset=utf-8'
            headers.append(('Allow', 'GET, HEAD'))
        elif env.get('QUERY_STRING'):
            data = b'Queries not supported'
            status, content_type = '400 Bad Request', 'text/plain; charset=utf-8'
        else:
            try:
                data = build()
                status, content_type = '200 OK', 'application/octet-stream'
            except OSError:
                data = b'UI asset unavailable'
                status, content_type = '503 Service Unavailable', 'text/plain; charset=utf-8'
        headers += [('Content-Type', content_type), ('Content-Length', str(len(data))),
                    ('Content-Disposition', 'attachment; filename="flybot.pyz"')]
        start_response(status, headers)
        return [] if env.get('REQUEST_METHOD') == 'HEAD' else [data]

    def _asset(self, directory, name):
        # Never resolve user input into a filename. Reject symlinks, including the asset directory.
        folder = self.root / directory
        root_fd = os.open(folder, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=root_fd)
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_size > 262144:
                    raise OSError('Invalid asset')
                with os.fdopen(fd, 'rb', closefd=False) as file:
                    data = file.read(262145)
                if len(data) > 262144:
                    raise OSError('Invalid asset')
                return data
            finally:
                os.close(fd)
        finally:
            os.close(root_fd)

    def _unknown_page(self, path):
        return any(path == prefix or path.startswith(prefix + '/') for prefix in self.PREFIXES)

    def _query_allowed(self, path, query):
        # Only recorded HTML query allowlists may pass. CSS/JS and every
        # other management page still reject QUERY_STRING.
        if not query:
            return True
        if path in ('/space', '/artifacts'):
            # A result link selects a record; the API still authorizes every read.
            # Match the complete raw pair: no duplicates, extras, encoded keys,
            # traversal, or queries on the CSS/JS assets can slip through.
            identifier = r'[0-9a-f]{32}'
            if re.fullmatch(rf'workspace={identifier}&artifact={identifier}|artifact={identifier}&workspace={identifier}', query):
                return True
            # new=<kind> opens that 新建 editor (chat composer 创建 grid).
            return query in ('view=created', 'view=starred', 'view=memory', 'view=meetings',
                             'new=document', 'new=website', 'new=slides', 'new=dashboard',
                             'new=whiteboard')
        if path == '/automations':
            # template=<id> opens the editor prefilled from a known template;
            # runs=<filter> keeps the run-history filter shareable. The two are
            # one-shot and permanent respectively, so they never share a URL.
            if query in ('runs=all', 'runs=succeeded', 'runs=failed'):
                return True
            from .automations import TEMPLATES
            template = query[len('template='):] if query.startswith('template=') else ''
            return template in TEMPLATES and template != 'custom'
        if path == '/set-password':
            pairs = parse_qsl(query, keep_blank_values=True)
            return (len(pairs) == 1 and pairs[0][0] == 'token'
                    and re.fullmatch(r'[A-Za-z0-9_-]{43}', pairs[0][1]) is not None)
        if path == '/discover':
            if query in ('tab=agents', 'tab=agents&section=groups'):
                return True
            # The feed tab, category and search are shareable deep links. The
            # router only serves the screen; the page reads these itself, so the
            # allowlist is limited to the keys and values it can produce.
            seen = set()
            for key, value in parse_qsl(query, keep_blank_values=True):
                if key in seen or not value:
                    return False
                seen.add(key)
                if key == 'feed' and value not in ('following', 'collected'):
                    return False
                if key == 'kind' and value not in ('website', 'image', 'audio', 'slides', 'video'):
                    return False
                if key == 'q':
                    if len(value) > 80 or any(ord(ch) < 32 for ch in value):
                        return False
                elif key not in ('feed', 'kind'):
                    return False
            return bool(seen)
        if path == '/agents':
            slug = query[len('category='):] if query.startswith('category=') else ''
            return slug in discover.AGENT_CATEGORY_SLUGS
        if path == '/memory':
            return query in ('page=profile', 'page=todos')
        if path == '/guide':
            # Deep links: one non-empty q, one non-empty category, or both, each
            # named at most once. An unknown category id is served anyway and the
            # page falls back to 全部, so a stale link is not a 400. Every other
            # /guide query, and every query on the guide CSS/JS, still answers 400.
            pairs = parse_qsl(query, keep_blank_values=True)
            seen = set()
            for key, value in pairs:
                if key not in ('q', 'category') or not value or key in seen:
                    return False
                seen.add(key)
            return bool(seen)
        return False

    def __call__(self, env, start_response):
        path = env.get('PATH_INFO', '')
        if path == '/install/flybot.pyz':
            return self._bundle(env, start_response)
        if path not in self.ASSETS:
            if self._unknown_page(path):
                start_response('404 Not Found', [('Content-Type', 'text/plain; charset=utf-8'),
                                                 ('Cache-Control', 'no-store'),
                                                 ('Content-Length', '9')])
                return [] if env.get('REQUEST_METHOD') == 'HEAD' else [b'Not found']
            return self.api(env, start_response)
        headers = [('Cache-Control', 'no-store'), ('X-Content-Type-Options', 'nosniff'),
                   ('Content-Security-Policy', self.CSP), ('Referrer-Policy', 'no-referrer'),
                   ('Cross-Origin-Resource-Policy', 'same-origin'),
                   ('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')]
        content_type = 'text/plain; charset=utf-8'
        status, data = '404 Not Found', b'Not found'
        origin = self.api.config.origin
        if (env.get('HTTP_HOST') != urlsplit(origin).netloc
                or env.get('HTTP_ORIGIN', origin) != origin
                or env.get('HTTP_SEC_FETCH_SITE', '') not in ('', 'same-origin', 'none')):
            status, data = '403 Forbidden', b'Same-origin request required'
        elif env.get('REQUEST_METHOD') not in ('GET', 'HEAD'):
            status, data = '405 Method Not Allowed', b'Use GET or HEAD'
            headers.append(('Allow', 'GET, HEAD'))
        elif not self._query_allowed(path, env.get('QUERY_STRING', '')):
            status, data = '400 Bad Request', b'Queries not supported'
        elif path == '/messenger':
            status, data = '302 Found', b''
            headers.append(('Location', '/chat'))
            content_type = 'text/plain; charset=utf-8'
        else:
            directory, name, content_type = self.ASSETS[path]
            try:
                data = self._asset(directory, name)
                status = '200 OK'
            except OSError:
                status, data = '503 Service Unavailable', b'UI asset unavailable'
                content_type = 'text/plain; charset=utf-8'
        headers += [('Content-Type', content_type), ('Content-Length', str(len(data)))]
        start_response(status, headers)
        return [] if env.get('REQUEST_METHOD') == 'HEAD' else [data]
