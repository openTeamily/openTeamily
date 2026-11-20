"""Table definitions for agent memory recall and team runs (no imports, avoids cycles)."""

AGENT_MEMORY = '''
CREATE TABLE IF NOT EXISTS agent_memory_scopes (
 agent_id TEXT PRIMARY KEY REFERENCES workspace_agents(id) ON DELETE CASCADE,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 mode TEXT NOT NULL CHECK(mode IN ('off','all','topics')),
 topics TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision >= 1),
 updated INTEGER NOT NULL,
 updated_by TEXT NOT NULL REFERENCES users(id));
CREATE TABLE IF NOT EXISTS agent_message_memory (
 message_id TEXT NOT NULL REFERENCES agent_messages(id) ON DELETE CASCADE,
 page_id TEXT NOT NULL,
 title TEXT NOT NULL,
 revision INTEGER NOT NULL,
 rank INTEGER NOT NULL CHECK(rank >= 1 AND rank <= 3),
 PRIMARY KEY(message_id, page_id));
'''

TEAM_RUNS = '''
CREATE TABLE IF NOT EXISTS team_runs (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 title TEXT NOT NULL,
 goal TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','cancelled')),
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL,
 key_hash TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 UNIQUE(workspace_id, user_id, key_hash));
CREATE INDEX IF NOT EXISTS team_run_owner ON team_runs(workspace_id, user_id, created, id);
CREATE TABLE IF NOT EXISTS team_run_steps (
 run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE,
 position INTEGER NOT NULL CHECK(position >= 0 AND position < 8),
 agent_id TEXT NOT NULL,
 agent_name TEXT NOT NULL,
 instruction TEXT NOT NULL,
 depends TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('waiting','queued','running','succeeded','failed','blocked','cancelled')),
 task_id TEXT,
 error_code TEXT,
 output TEXT NOT NULL,
 attempts INTEGER NOT NULL CHECK(attempts >= 0),
 started INTEGER,
 finished INTEGER,
 PRIMARY KEY(run_id, position));
'''
