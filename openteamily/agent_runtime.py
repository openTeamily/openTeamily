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

def load_binding(db, workspace_id, agent_id):
    return db.execute(
        'SELECT * FROM workspace_agent_bindings WHERE agent_id=? AND workspace_id=?',
        (agent_id, workspace_id),
    ).fetchone()
