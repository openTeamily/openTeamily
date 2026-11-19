"""External Agent API gateway (issues #11 #2).

Self-written for OpenTeamily. A workspace owner/admin issues a per-agent API key
(shown once, stored as a SHA-256 digest) with a fixed ``invoke`` scope and a
per-minute rate limit. External callers use ``Authorization: Bearer`` without
cookies or Origin to queue an invocation through the existing runtime infer
task path and poll its status. No vendor is contacted by OpenTeamily itself;
replies only exist when the owner's connected runtime completes the task.
OAuth clients, streaming and webhooks are not implemented.
"""
import re

SCHEMA = '''
CREATE TABLE IF NOT EXISTS agent_api_keys (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 agent_id TEXT NOT NULL REFERENCES workspace_agents(id) ON DELETE CASCADE,
 name TEXT NOT NULL,
 token_hash TEXT NOT NULL UNIQUE,
 scope TEXT NOT NULL CHECK(scope IN ('invoke')),
 rate_per_minute INTEGER NOT NULL CHECK(rate_per_minute BETWEEN 1 AND 60),
 created INTEGER NOT NULL,
 created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 last_used INTEGER,
 revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)));
CREATE INDEX IF NOT EXISTS agent_api_key_list ON agent_api_keys(workspace_id, agent_id, id);
CREATE TABLE IF NOT EXISTS agent_api_rate (
 key_id TEXT NOT NULL REFERENCES agent_api_keys(id) ON DELETE CASCADE,
 window INTEGER NOT NULL,
 count INTEGER NOT NULL,
 PRIMARY KEY(key_id, window));
CREATE TABLE IF NOT EXISTS agent_api_invocations (
 id TEXT PRIMARY KEY,
 key_id TEXT NOT NULL REFERENCES agent_api_keys(id) ON DELETE CASCADE,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 agent_id TEXT NOT NULL REFERENCES workspace_agents(id) ON DELETE CASCADE,
 prompt TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
 task_id TEXT,
 error_code TEXT,
 body TEXT NOT NULL DEFAULT '',
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL,
 key_hash TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 UNIQUE(key_id, key_hash));
'''

NAME = re.compile(r'[^\x00-\x1f\x7f]{1,60}')
MAX_KEYS_PER_AGENT = 10
DEFAULT_RATE = 10
ERRORS = ('no_agent', 'quota', 'timeout', 'cancelled', 'empty_reply', 'runtime_failed', 'task_missing')


def key_view(row):
    return {key: row[key] for key in ('id', 'workspace_id', 'agent_id', 'name', 'scope', 'rate_per_minute',
                                      'created', 'created_by', 'last_used')} | {'revoked': bool(row['revoked'])}


def invocation_view(row):
    data = {key: row[key] for key in ('id', 'agent_id', 'status', 'error_code', 'created', 'updated')}
    data['reply'] = row['body'] if row['status'] == 'succeeded' else None
    return data


def consume_rate(db, key, now):
    """Fixed one-minute window counter; returns False when the key is over its limit."""
    window = now // 60
    db.execute('DELETE FROM agent_api_rate WHERE key_id=? AND window<?', (key['id'], window))
    row = db.execute('SELECT count FROM agent_api_rate WHERE key_id=? AND window=?', (key['id'], window)).fetchone()
    if row is not None and row['count'] >= key['rate_per_minute']:
        return False
    db.execute('INSERT INTO agent_api_rate VALUES(?,?,1) ON CONFLICT(key_id, window) DO UPDATE SET count=count+1',
               (key['id'], window))
    return True
