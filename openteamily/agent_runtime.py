"""Stored agent-to-instance bindings and historical task migration data."""

SCHEMA = '''
CREATE TABLE IF NOT EXISTS workspace_agent_bindings (
 agent_id TEXT PRIMARY KEY REFERENCES workspace_agents(id) ON DELETE CASCADE,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 instance_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision >= 1),
 bound_by TEXT NOT NULL REFERENCES users(id),
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS workspace_agent_binding_instance
 ON workspace_agent_bindings(workspace_id, instance_id);
CREATE TABLE IF NOT EXISTS instance_runtime_keys (
 instance_id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 key_id TEXT NOT NULL UNIQUE REFERENCES runtime_keys(id),
 token_blob TEXT NOT NULL,
 issued_job_id TEXT NOT NULL,
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS agent_message_dispatch (
 message_id TEXT PRIMARY KEY REFERENCES agent_messages(id) ON DELETE CASCADE,
 source TEXT NOT NULL CHECK(source IN ('instance','connection')),
 instance_id TEXT,
 connection_id TEXT);
'''

def binding_view(row, status=None):
    data = {key: row[key] for key in (
        'agent_id', 'workspace_id', 'instance_id', 'revision', 'bound_by', 'created', 'updated')}
    if status is not None:
        data['status'] = status
    return data


def load_binding(db, workspace_id, agent_id):
    return db.execute(
        'SELECT * FROM workspace_agent_bindings WHERE agent_id=? AND workspace_id=?',
        (agent_id, workspace_id),
    ).fetchone()


def instance_key_ids(db):
    return {row['key_id'] for row in db.execute('SELECT key_id FROM instance_runtime_keys')}


def online_instance_connection(db, instance_id, now, stale):
    row = db.execute(
        'SELECT c.* FROM runtime_connections c '
        'JOIN instance_runtime_keys k ON k.key_id=c.key_id '
        'WHERE k.instance_id=? AND c.last_seen>?',
        (instance_id, now - stale),
    ).fetchone()
    return row


def attach_dispatch(db, message_id, source, instance_id, connection_id):
    db.execute(
        'INSERT INTO agent_message_dispatch VALUES(?,?,?,?)',
        (message_id, source, instance_id, connection_id),
    )


def load_dispatch(db, message_id):
    return db.execute(
        'SELECT * FROM agent_message_dispatch WHERE message_id=?', (message_id,)
    ).fetchone()


def message_dispatch_view(row):
    if row is None:
        return None
    data = {'source': row['source'], 'connection_id': row['connection_id']}
    if row['instance_id']:
        data['instance_id'] = row['instance_id']
    return data


def instance_usable(snapshot):
    if snapshot is None or snapshot.get('blocked'):
        return False
    if snapshot.get('desired') != 'running':
        return False
    if snapshot.get('error') is not None:
        return False
    return True
