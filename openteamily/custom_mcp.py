"""Per-user remote MCP broker. Only public HTTPS:443, pinned DNS, no redirects.

Secrets stay wrapped on management. DS-Bot sees tool schemas and task-scoped
approval proposals, never the upstream URL, session token or bearer credential.
Streamable HTTP (JSON/SSE responses) only; no local commands or stdio servers.
"""
import hashlib
import http.client
import ipaddress
import json
import re
import socket
import ssl
from urllib.parse import urlsplit
from uuid import uuid4

from . import model_api

SCHEMA = '''
CREATE TABLE IF NOT EXISTS custom_mcp_servers (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name TEXT NOT NULL, origin TEXT NOT NULL, config_blob TEXT NOT NULL,
 revision INTEGER NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL);
'''
WRAP = 'custom-mcp.wrap'
LIMIT = 262144
PREFIX = 'OTMCP_'


def fault(status, code, message):
    from .connected_tools import Fault
    raise Fault(status, code, message)


def endpoint(value):
    if not isinstance(value, str) or len(value) > 512 or re.search(r'[\x00-\x20\\]', value):
        fault(400, 'mcp_endpoint', 'Use a public HTTPS MCP URL without credentials or query')
    try:
        u = urlsplit(value)
        host = u.hostname.encode('idna').decode('ascii') if u.hostname else ''
        if u.scheme != 'https' or not host or u.port not in (None, 443) or u.username or u.password or u.query or u.fragment:
            raise ValueError()
        if host.endswith('.') or host.lower() == 'localhost' or host.lower().endswith(('.localhost', '.local', '.internal')):
            raise ValueError()
        try:
            ip = ipaddress.ip_address(host)
        except ValueError:
            ip = None
        if ip is not None and not public_ip(ip):
            raise ValueError()
        return host, u.path or '/'
    except (ValueError, UnicodeError):
        fault(400, 'mcp_endpoint', 'Use a public HTTPS:443 MCP endpoint; private networks are blocked')


def public_ip(ip):
    # Exclude IPv6 translation/tunnel space (including NAT64) as well as the
    # standard non-public ranges; only native global-unicast IPv6 is eligible.
    if ip.version == 6 and ip not in ipaddress.ip_network('2000::/3'):
        return False
    return ip.is_global and not (ip.is_multicast or ip.is_reserved or ip.is_loopback or ip.is_link_local or ip.is_unspecified or ip.is_private) and not getattr(ip, 'ipv4_mapped', None) and not getattr(ip, 'sixtofour', None) and not getattr(ip, 'teredo', None)


class PinnedHTTPS(http.client.HTTPSConnection):
    def __init__(self, host, address):
        super().__init__(host, 443, timeout=12, context=ssl.create_default_context())
        self.address = address

    def connect(self):
        # No proxy, redirects or second hostname lookup after policy validation.
        raw = socket.create_connection((self.address, 443), self.timeout)
        try:
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
        except Exception:
            raw.close()
            raise


def transport(url, headers, body):
    host, path = endpoint(url)
    try:
        addresses = {r[4][0] for r in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)}
        if not addresses or not all(public_ip(ipaddress.ip_address(a)) for a in addresses):
            fault(400, 'mcp_network', 'MCP DNS resolved to a blocked address')
        c = PinnedHTTPS(host, sorted(addresses)[0])
        try:
            c.request('POST', path, body, headers)
            r = c.getresponse()
            data = r.read(LIMIT + 1)
            if len(data) > LIMIT:
                fault(502, 'mcp_response', 'MCP response exceeded size limit')
            return r.status, dict((k.lower(), v) for k, v in r.getheaders()), data
        finally:
            c.close()
    except (OSError, ValueError, http.client.HTTPException):
        fault(502, 'mcp_transport', 'MCP network request failed; not retried')


def secret_config(store, row):
    return json.loads(model_api.unwrap(model_api.wrapping_key(store, WRAP), row['config_blob']))


def view(row):
    return {k: row[k] for k in ('id', 'name', 'origin', 'revision', 'created', 'updated')}


def save(store, db, uid, body, now):
    sid = body.get('id') or uuid4().hex
    if not isinstance(sid, str) or not re.fullmatch(r'[0-9a-f]{32}', sid):
        fault(400, 'invalid', 'Invalid MCP server id')
    old = db.execute('SELECT * FROM custom_mcp_servers WHERE id=? AND user_id=?', (sid, uid)).fetchone()
    if body.get('id') and old is None:
        fault(404, 'not_found', 'MCP server not found')
    if old is None and db.execute('SELECT COUNT(*) FROM custom_mcp_servers WHERE user_id=?', (uid,)).fetchone()[0] >= 4:
        fault(429, 'quota', 'At most four custom MCP servers per user')
    name, url = body.get('name'), body.get('url')
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 60 or any(ord(c) < 32 for c in name):
        fault(400, 'invalid', 'Use a 1-60 character server name')
    host, _ = endpoint(url)
    previous = secret_config(store, old) if old else {}
    token = body.get('bearer_token', previous.get('bearer_token', ''))
    if not isinstance(token, str) or len(token) > 4096 or any(ord(c) < 33 or ord(c) > 126 for c in token):
        fault(400, 'invalid', 'Invalid MCP bearer token')
    # Never silently forward a stored credential to a changed endpoint.
    if old and url != previous.get('url') and 'bearer_token' not in body:
        fault(400, 'mcp_endpoint_changed', 'Supply or clear the bearer token when changing endpoint')
    blob = model_api.wrap(model_api.wrapping_key(store, WRAP), json.dumps({'url': url, 'bearer_token': token}))
    revision = old['revision'] + 1 if old else 1
    db.execute('INSERT OR REPLACE INTO custom_mcp_servers VALUES(?,?,?,?,?,?,?,?)',
               (sid, uid, name.strip(), 'https://' + host, blob, revision, old['created'] if old else now, now))
    # Any outstanding grant for old config is invalidated by blob mismatch.
    return view(db.execute('SELECT * FROM custom_mcp_servers WHERE id=?', (sid,)).fetchone())


class Client:
    def __init__(self, config, sender=None):
        self.config, self.send, self.session = config, sender or transport, None

    def rpc(self, method, params=None, notification=False):
        headers = {'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-03-26'}
        if self.config.get('bearer_token'):
            headers['Authorization'] = 'Bearer ' + self.config['bearer_token']
        if self.session:
            headers['Mcp-Session-Id'] = self.session
        mid = uuid4().hex
        message = {'jsonrpc': '2.0', 'method': method, 'params': params or {}}
        if not notification:
            message['id'] = mid
        try:
            status, rh, raw = self.send(self.config['url'], headers, json.dumps(message).encode())
        except Exception as exc:
            from .connected_tools import Fault
            if isinstance(exc, Fault):
                raise
            fault(502, 'mcp_transport', 'MCP request failed; not retried')
        if status not in (200, 202, 204) or len(raw) > LIMIT:
            fault(502, 'mcp_response', 'MCP rejected request or returned an oversized response')
        session = rh.get('mcp-session-id')
        if session:
            if len(session) > 256 or re.search(r'[^\x21-\x7e]', session):
                fault(502, 'mcp_response', 'Invalid MCP session')
            self.session = session
        if notification:
            return {}
        try:
            if 'text/event-stream' in rh.get('content-type', ''):
                messages = [json.loads(e[5:].strip()) for e in raw.decode().splitlines() if e.startswith('data:')]
                document = next(v for v in messages if isinstance(v, dict) and v.get('id') == mid)
            else:
                document = json.loads(raw)
            if document.get('id') != mid or document.get('jsonrpc') != '2.0' or not isinstance(document.get('result'), dict):
                raise ValueError()
            return document['result']
        except (ValueError, StopIteration, AttributeError, UnicodeError):
            fault(502, 'mcp_response', 'MCP returned an invalid response')

    def initialize(self):
        self.rpc('initialize', {'protocolVersion': '2025-03-26', 'capabilities': {}, 'clientInfo': {'name': 'OpenTeamily', 'version': '1.0.0'}})
        self.rpc('notifications/initialized', notification=True)
        return self


def discover(app, connection, task_id, now, search=None):
    from . import connected_tools as ct
    with app.store.connect() as db:
        uid, _, _ = ct.authorize(db, connection, task_id, now, require_composio=False)
        rows = db.execute('SELECT * FROM custom_mcp_servers WHERE user_id=? ORDER BY id LIMIT 4', (uid,)).fetchall()
    result = []
    for row in rows:
        config = secret_config(app.store, row)
        client = Client(config, app.mcp_transport).initialize()
        tools = client.rpc('tools/list').get('tools', [])
        if not isinstance(tools, list):
            fault(502, 'mcp_response', 'Invalid MCP tool list')
        for t in tools[:20]:
            if not isinstance(t, dict) or not isinstance(t.get('name'), str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,128}', t['name']) or not isinstance(t.get('inputSchema'), dict):
                continue
            name = PREFIX + hashlib.sha256((row['id'] + ':' + t['name']).encode()).hexdigest()[:24].upper()
            schema = ct.scrub({'type': 'function', 'function': {'name': name, 'description': (row['name'] + ': ' + str(t.get('description', t['name'])))[:1000], 'parameters': t['inputSchema']}}, config.get('bearer_token', ''))
            if len(json.dumps(schema).encode()) > 16000 or (search and search.lower() not in json.dumps(schema).lower()):
                continue
            with app.store.transaction() as db:
                ct.authorize(db, connection, task_id, int(app.clock()), require_composio=False)
                current = db.execute('SELECT * FROM custom_mcp_servers WHERE id=? AND user_id=?', (row['id'], uid)).fetchone()
                if current is None or current['config_blob'] != row['config_blob']:
                    fault(409, 'connection_changed', 'MCP configuration changed')
                db.execute('INSERT OR IGNORE INTO connected_tool_schemas VALUES(?,?,?,?,?,?)', (task_id, name, row['id'], t['name'], json.dumps(schema), row['config_blob']))
            result.append(schema)
    return result


def propose(app, connection, tid, body, now):
    from . import connected_tools as ct
    name, args, callid = body.get('name'), body.get('arguments'), body.get('call_id')
    if not isinstance(name, str) or not ct.NAME.fullmatch(name) or not isinstance(args, dict) or not isinstance(callid, str) or not ct.CALL_ID.fullmatch(callid):
        fault(400, 'invalid', 'Provide tool name, arguments and stable call_id')
    raw = json.dumps(args, sort_keys=True, separators=(',', ':'))
    if len(raw.encode()) > ct.MAX_ARGS:
        fault(413, 'invalid', 'Tool arguments exceed bound')
    with app.store.transaction() as db:
        uid, _, meta = ct.authorize(db, connection, tid, now, require_composio=False)
        schema = db.execute('SELECT * FROM connected_tool_schemas WHERE task_id=? AND name=?', (tid, name)).fetchone()
        server = db.execute('SELECT * FROM custom_mcp_servers WHERE id=? AND user_id=?', (schema['connection_id'], uid)).fetchone() if schema else None
        if server is None or schema['key_blob'] != server['config_blob']:
            fault(403, 'tool_not_discovered', 'MCP tool is not in this task grant')
        old = db.execute('SELECT * FROM connected_tool_calls WHERE task_id=? AND call_id=?', (tid, callid)).fetchone()
        if old:
            if old['name'] != name or old['arguments'] != raw:
                fault(409, 'conflict', 'call_id already refers to different arguments')
            return ct.call_view(old)
        if db.execute('SELECT COUNT(*) FROM connected_tool_calls WHERE task_id=?', (tid,)).fetchone()[0] >= ct.MAX_CALLS:
            fault(429, 'quota', 'Tool call limit reached')
        cid = uuid4().hex
        db.execute('INSERT INTO connected_tool_calls VALUES(?,?,?,?,?,?,?,?,NULL,?,?)', (cid, tid, uid, callid, name, server['id'], raw, 'pending', now, meta['deadline']))
        return ct.call_view(db.execute('SELECT * FROM connected_tool_calls WHERE id=?', (cid,)).fetchone())


def run(app, connection, tid, cid, now):
    from . import connected_tools as ct
    with app.store.transaction() as db:
        uid, _, _ = ct.authorize(db, connection, tid, now, require_composio=False)
        row = db.execute('SELECT * FROM connected_tool_calls WHERE id=? AND task_id=? AND user_id=?', (cid, tid, uid)).fetchone()
        if row is None:
            fault(404, 'not_found', 'MCP call not found')
        if row['status'] != 'approved':
            return ct.call_view(row)
        schema = db.execute('SELECT * FROM connected_tool_schemas WHERE task_id=? AND name=?', (tid, row['name'])).fetchone()
        server = db.execute('SELECT * FROM custom_mcp_servers WHERE id=? AND user_id=?', (row['connection_id'], uid)).fetchone()
        if schema is None or server is None or schema['key_blob'] != server['config_blob']:
            fault(409, 'connection_changed', 'MCP connection changed; call blocked')
        db.execute("UPDATE connected_tool_calls SET status='executing' WHERE id=?", (cid,))
    # Consume before network, never retry executing/unknown calls.
    config = secret_config(app.store, server)
    status, output = 'unknown', {'error': 'mcp_failed_no_retry'}
    try:
        client = Client(config, app.mcp_transport).initialize()
        with app.store.connect() as db:
            ct.authorize(db, connection, tid, int(app.clock()), require_composio=False)
            current = db.execute('SELECT config_blob FROM custom_mcp_servers WHERE id=? AND user_id=?', (server['id'], uid)).fetchone()
            if current is None or current['config_blob'] != server['config_blob']:
                fault(409, 'connection_changed', 'MCP connection changed; call blocked')
        output = ct.scrub(client.rpc('tools/call', {'name': schema['version'], 'arguments': json.loads(row['arguments'])}), config.get('bearer_token', ''))
        if len(json.dumps(output).encode()) > ct.MAX_RESULT:
            output = {'error': 'mcp_output_too_large'}
        status = 'failed' if output.get('isError') or output.get('error') else 'succeeded'
    except ct.Fault as error:
        output = {'error': error.code, 'note': 'Not retried; check remote state before another call.'}
    with app.store.transaction() as db:
        db.execute('UPDATE connected_tool_calls SET status=?,result=? WHERE id=?', (status, json.dumps(output), cid))
        return ct.call_view(db.execute('SELECT * FROM connected_tool_calls WHERE id=?', (cid,)).fetchone())
