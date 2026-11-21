"""Task-scoped Composio tool broker. Credentials never leave the management plane.

Every execution, including reads, requires a one-shot approval by the connection
owner in the signed-in UI. Unknown/ambiguous outcomes are never retried. Runtime
keys authenticate the agent, not an owner supplied by a model. Group/automation/
gateway tasks do not receive personal app access. No changes to #124 protocol.
"""
import json
import re
from uuid import uuid4

from . import custom_mcp, composio, composio_principals, runtime_connect, members

SCHEMA = '''
CREATE TABLE IF NOT EXISTS connected_tool_owners (
 task_id TEXT PRIMARY KEY REFERENCES runtime_tasks(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS connected_tool_schemas (
 task_id TEXT NOT NULL REFERENCES runtime_tasks(id) ON DELETE CASCADE,
 name TEXT NOT NULL, connection_id TEXT NOT NULL,
 version TEXT NOT NULL, schema_json TEXT NOT NULL, key_blob TEXT NOT NULL,
 PRIMARY KEY(task_id,name));
CREATE TABLE IF NOT EXISTS connected_tool_calls (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES runtime_tasks(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id), call_id TEXT NOT NULL,
 name TEXT NOT NULL, connection_id TEXT NOT NULL, arguments TEXT NOT NULL,
 status TEXT NOT NULL, result TEXT, created INTEGER NOT NULL, expires INTEGER NOT NULL,
 UNIQUE(task_id,call_id));
'''
NAME = re.compile(r'[A-Z][A-Z0-9_]{1,127}')
CALL_ID = re.compile(r'[A-Za-z0-9_-]{1,128}')
MAX_CALLS = 8
MAX_ARGS = 12000
MAX_RESULT = 10000


class Fault(Exception):
    def __init__(self, status, code, message):
        self.status, self.code, self.message = status, code, message


def fail(status, code, message):
    raise Fault(status, code, message)


def authorize(db, connection, task_id, now, require_composio=True):
    runtime_key = db.execute('SELECT * FROM runtime_keys WHERE id=?', (connection['key_id'],)).fetchone()
    if runtime_key is None or runtime_key['revoked'] or (runtime_key['expires'] is not None and runtime_key['expires'] <= now):
        fail(401, 'unauthorized', 'Runtime key expired or revoked')
    task = runtime_connect.load_task(db, task_id, connection_id=connection['id'])
    meta = runtime_connect.load_meta(db, task_id)
    if task is None:
        fail(404, 'not_found', 'Runtime task not found')
    if task['kind'] != 'infer' or task['status'] != 'claimed' or meta is None or meta['deadline'] <= now:
        fail(409, 'task_inactive', 'Task is not active')
    # Only the same user's runtime may consume their own app credentials.
    user_id = composio_principals.authorized_user(db, task_id, connection['user_id'])
    if user_id is None:
        fail(403, 'tools_unavailable', 'Personal connected tools are not enabled for this task')
    if meta['workspace_id'] and members.load(db, meta['workspace_id'], user_id) is None:
        fail(403, 'forbidden', 'Workspace access was revoked')
    row = composio.load_key_row(db, user_id)
    if row is None and require_composio:
        fail(409, 'composio_not_configured', 'Add your own Composio API key first')
    return user_id, row, meta


def grant(db, task_id, user_id):
    # Called only from personal conversation dispatch or owner-submitted task API.
    db.execute('INSERT INTO connected_tool_owners VALUES(?,?)', (task_id, user_id))


def available(db, task_id):
    owner = db.execute('SELECT user_id FROM connected_tool_owners WHERE task_id=?', (task_id,)).fetchone()
    principal = composio_principals.load(db, task_id)
    uid = owner['user_id'] if owner else (principal['user_id'] if principal is not None and composio_principals.live(db, principal) else None)
    return bool(uid and (composio.load_key_row(db, uid) is not None or
                db.execute('SELECT 1 FROM custom_mcp_servers WHERE user_id=? LIMIT 1', (uid,)).fetchone()))


def scrub(value, secret):
    """Never echo our own key or typical provider credential fields."""
    if isinstance(value, dict):
        return {str(k): ('[redacted]' if str(k).lower() in
                ('api_key', 'access_token', 'refresh_token', 'authorization', 'password', 'client_secret')
                else scrub(v, secret)) for k, v in value.items()}
    if isinstance(value, list):
        return [scrub(v, secret) for v in value]
    if isinstance(value, str):
        return value.replace(secret, '[redacted]') if secret else value
    return value


def call_view(row, include_arguments=False):
    view = {k: row[k] for k in ('id', 'task_id', 'name', 'status', 'created', 'expires')}
    if include_arguments:
        view['arguments'] = json.loads(row['arguments'])
    if row['result']:
        view['result'] = json.loads(row['result'])
    return view


class Broker:
    def __init__(self, app):
        self.app, self.store = app, app.store

    def client(self, user_id):
        with self.store.connect() as db:
            secret = composio.user_key(self.store, db, user_id)
        if not secret:
            fail(409, 'composio_not_configured', 'Add your own Composio API key first')
        return composio.Client(secret, self.app.composio_transport), secret

    def discover(self, connection, task_id, now, search=None):
        with self.store.connect() as db:
            uid, key, _ = authorize(db, connection, task_id, now, require_composio=False)
            has_mcp = db.execute('SELECT 1 FROM custom_mcp_servers WHERE user_id=?', (uid,)).fetchone() is not None
        if not has_mcp:
            return self.discover_composio(connection, task_id, now, search)
        tools = self.discover_composio(connection, task_id, now, search)['tools'] if key is not None else []
        tools += custom_mcp.discover(self.app, connection, task_id, now, search)
        return {'tools': tools, 'requires_approval': True, 'note': 'Composio and custom MCP tools: every call requires one-shot owner approval.'}

    def discover_composio(self, connection, task_id, now, search=None):
        with self.store.connect() as db:
            user_id, key, _ = authorize(db, connection, task_id, now)
            key_blob = key['key_blob']
            rows = db.execute("SELECT * FROM composio_connections WHERE user_id=? AND status='ACTIVE' ORDER BY created,id LIMIT 4",
                              (user_id,)).fetchall()
        client, secret = self.client(user_id)
        discovered = []
        for row in rows:
            account = client.get_account(row['account_id'])
            if account.get('status') != 'ACTIVE' or account.get('user_id') not in (None, '', composio.composio_user_id(user_id)):
                continue
            page = client.tools(row['toolkit'], search)
            for item in page.get('items', [])[:20]:
                if not isinstance(item, dict):
                    continue
                name, params, version = item.get('slug'), item.get('input_parameters'), item.get('version')
                toolkit = item.get('toolkit') or {}
                if (not isinstance(name, str) or not NAME.fullmatch(name) or name.startswith(('COMPOSIO_', custom_mcp.PREFIX))
                        or not isinstance(toolkit, dict) or toolkit.get('slug', '').lower() != row['toolkit']
                        or not isinstance(params, dict) or not isinstance(version, str) or not version
                        or len(version) > 100 or item.get('is_deprecated')):
                    continue
                schema = scrub({'type': 'function', 'function': {'name': name,
                                'description': str(item.get('description', ''))[:1000], 'parameters': params}}, secret)
                raw = json.dumps(schema)
                if len(raw.encode()) > 16000:
                    continue
                with self.store.transaction() as db:
                    _, current_key, _ = authorize(db, connection, task_id, int(self.app.clock()))
                    current = db.execute("SELECT id FROM composio_connections WHERE id=? AND user_id=? AND status='ACTIVE'",
                                         (row['id'], user_id)).fetchone()
                    if current_key['key_blob'] != key_blob or current is None:
                        fail(409, 'connection_changed', 'Connection or key changed; discover again')
                    db.execute('INSERT OR IGNORE INTO connected_tool_schemas VALUES(?,?,?,?,?,?)',
                               (task_id, name, row['id'], version, raw, key_blob))
                if name not in [t['function']['name'] for t in discovered]:
                    discovered.append(schema)
        return {'tools': discovered, 'requires_approval': True, 'truncated': len(rows) == 4,
                'note': 'Featured tools, at most 4 accounts × 20 tools. Search can discover more. Every call needs owner approval.'}

    def propose(self, connection, task_id, body, now):
        if isinstance(body.get('name'), str) and body['name'].startswith(custom_mcp.PREFIX):
            return custom_mcp.propose(self.app, connection, task_id, body, now)
        name, args, call_id = body.get('name'), body.get('arguments'), body.get('call_id')
        if not isinstance(name, str) or not NAME.fullmatch(name) or not isinstance(args, dict) or not isinstance(call_id, str) or not CALL_ID.fullmatch(call_id):
            fail(400, 'invalid', 'Provide tool name, arguments and a stable call_id')
        arguments = json.dumps(args, separators=(',', ':'), sort_keys=True)
        if len(arguments.encode()) > MAX_ARGS:
            fail(413, 'invalid', 'Tool arguments exceed bound')
        with self.store.transaction() as db:
            user_id, key, meta = authorize(db, connection, task_id, now)
            schema = db.execute('SELECT * FROM connected_tool_schemas WHERE task_id=? AND name=?', (task_id, name)).fetchone()
            if schema is None or schema['key_blob'] != key['key_blob']:
                fail(403, 'tool_not_discovered', 'Tool is not in this task discovery grant')
            row = db.execute('SELECT * FROM connected_tool_calls WHERE task_id=? AND call_id=?', (task_id, call_id)).fetchone()
            if row:
                if row['name'] != name or row['arguments'] != arguments:
                    fail(409, 'conflict', 'call_id already refers to different arguments')
                return call_view(row)
            if db.execute('SELECT COUNT(*) FROM connected_tool_calls WHERE task_id=?', (task_id,)).fetchone()[0] >= MAX_CALLS:
                fail(429, 'quota', 'Task tool call capacity reached')
            cid = uuid4().hex
            db.execute('INSERT INTO connected_tool_calls VALUES(?,?,?,?,?,?,?,?,NULL,?,?)',
                       (cid, task_id, user_id, call_id, name, schema['connection_id'], arguments, 'pending', now, meta['deadline']))
            row = db.execute('SELECT * FROM connected_tool_calls WHERE id=?', (cid,)).fetchone()
        return call_view(row)

    def decide(self, user_id, cid, decision, now):
        if decision not in ('approve', 'deny'):
            fail(400, 'invalid', 'Choose approve or deny')
        with self.store.transaction() as db:
            row = db.execute('SELECT * FROM connected_tool_calls WHERE id=? AND user_id=?', (cid, user_id)).fetchone()
            if row is None:
                fail(404, 'not_found', 'Tool approval not found')
            task = runtime_connect.load_task(db, row['task_id'])
            if row['status'] != 'pending' or row['expires'] <= now or not task or task['status'] != 'claimed':
                fail(409, 'expired', 'Approval is no longer pending')
            db.execute('UPDATE connected_tool_calls SET status=? WHERE id=?',
                       ('approved' if decision == 'approve' else 'denied', cid))
            return call_view(db.execute('SELECT * FROM connected_tool_calls WHERE id=?', (cid,)).fetchone())

    def listing(self, user_id, now):
        with self.store.transaction() as db:
            db.execute("UPDATE connected_tool_calls SET status='expired' WHERE status IN ('pending','approved') AND (expires<=? OR task_id IN (SELECT id FROM runtime_tasks WHERE status!='claimed'))", (now,))
            rows = db.execute('SELECT * FROM connected_tool_calls WHERE user_id=? ORDER BY created DESC,id LIMIT 30', (user_id,)).fetchall()
            items = []
            key = composio.user_key(self.store, db, user_id)
            for row in rows:
                view = call_view(row, True)
                account = db.execute('SELECT toolkit, account_id FROM composio_connections WHERE id=? AND user_id=?',
                                     (row['connection_id'], user_id)).fetchone()
                task = runtime_connect.load_task(db, row['task_id'])
                if account is None:
                    mcp = db.execute('SELECT name,origin FROM custom_mcp_servers WHERE id=? AND user_id=?', (row['connection_id'], user_id)).fetchone()
                    account = {'toolkit': 'MCP: ' + mcp['name'], 'account_id': mcp['origin']} if mcp else None
                view['account'] = dict(account) if account else None
                view['prompt'] = task['prompt'][:1000] if task else ''
                items.append(scrub(view, key))
        return {'items': items}

    def run(self, connection, task_id, cid, now):
        with self.store.connect() as db:
            item = db.execute('SELECT name FROM connected_tool_calls WHERE id=? AND task_id=?', (cid, task_id)).fetchone()
        if item and item['name'].startswith(custom_mcp.PREFIX):
            return custom_mcp.run(self.app, connection, task_id, cid, now)
        # Atomically consume approval BEFORE external I/O. 'executing' is terminal
        # on crash/timeout: never implicitly retry a potentially side-effecting call.
        with self.store.transaction() as db:
            user_id, key, _ = authorize(db, connection, task_id, now)
            row = db.execute('SELECT * FROM connected_tool_calls WHERE id=? AND task_id=? AND user_id=?',
                             (cid, task_id, user_id)).fetchone()
            if row is None:
                fail(404, 'not_found', 'Tool call not found')
            if row['status'] != 'approved':
                return call_view(row)
            schema = db.execute('SELECT * FROM connected_tool_schemas WHERE task_id=? AND name=?', (task_id, row['name'])).fetchone()
            account = db.execute("SELECT * FROM composio_connections WHERE id=? AND user_id=? AND status='ACTIVE'",
                                 (row['connection_id'], user_id)).fetchone()
            if schema is None or account is None or schema['key_blob'] != key['key_blob']:
                fail(409, 'connection_changed', 'Connection or key changed; call blocked')
            db.execute("UPDATE connected_tool_calls SET status='executing' WHERE id=?", (cid,))
        client, secret = self.client(user_id)
        status, result = 'failed', {'error': 'tool_execution_failed_no_retry'}
        try:
            remote = client.get_account(account['account_id'])
            if remote.get('status') != 'ACTIVE' or remote.get('user_id') not in (None, '', composio.composio_user_id(user_id)):
                result = {'error': 'connection_not_active'}
            else:
                # Recheck after network status read, immediately before execution.
                with self.store.connect() as db:
                    _, current_key, _ = authorize(db, connection, task_id, int(self.app.clock()))
                    active = db.execute("SELECT id FROM composio_connections WHERE id=? AND user_id=? AND status='ACTIVE'",
                                        (account['id'], user_id)).fetchone()
                    if active is None or key['key_blob'] != current_key['key_blob']:
                        fail(409, 'connection_changed', 'Connection or key changed; call blocked')
                output = client.execute(row['name'], account['account_id'], composio.composio_user_id(user_id),
                                        schema['version'], json.loads(row['arguments']))
                safe = scrub(output, secret)
                raw = json.dumps(safe)
                result = safe if len(raw.encode()) <= MAX_RESULT else {'error': 'tool_output_too_large'}
                status = 'succeeded' if output.get('successful') is True and not result.get('error') else 'failed'
        except composio.ComposioError as error:
            # Timeout may have committed a mutation upstream. User must inspect
            # provider state before proposing a NEW call; never retry this id.
            status, result = 'unknown', {'error': error.code, 'note': 'Not retried; check provider state before another call.'}
        except Fault as error:
            result = {'error': error.code}
        with self.store.transaction() as db:
            db.execute('UPDATE connected_tool_calls SET status=?, result=? WHERE id=?', (status, json.dumps(result), cid))
            row = db.execute('SELECT * FROM connected_tool_calls WHERE id=?', (cid,)).fetchone()
        return call_view(row)
