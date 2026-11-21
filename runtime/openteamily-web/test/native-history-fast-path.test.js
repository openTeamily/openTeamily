import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { importHistory } from '../features/agents/history.js'

test('opening or sending in a mapped conversation skips the native event scan', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(`CREATE TABLE agent_messages (id TEXT PRIMARY KEY, conversation_id TEXT, created INTEGER, meta TEXT);
      CREATE TABLE native_agent_events (message_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, event_seq INTEGER, source TEXT NOT NULL);
      INSERT INTO agent_messages VALUES ('earlier','c',1,'{}'), ('in-flight','c',2,'{"nativePending":true}');
      INSERT INTO native_agent_events VALUES ('earlier','s',5,'adopted');`)
    const rt = { eventsBackwards() { throw new Error('Mapped history must not be scanned') } }
    assert.deepEqual(await importHistory({ db, rt, conversationId: 'c', sessionId: 's' }), { imported: 0, matched: 0 })
  } finally {
    db.close()
  }
})
