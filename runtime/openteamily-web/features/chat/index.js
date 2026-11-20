// Private chat with the personal agent, executed as native DS-Bot turns in the
// user's own DS-Bot (moved from conversations.py / personal.py / agent_memory.py).
// Each conversation is its own native DS-Bot session ('plugin:<id>').
import { openDatabase, newId, fail } from '../../src/store.js'
import { rank, noteBlock } from './recall.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')), text TEXT NOT NULL, created INTEGER NOT NULL, meta TEXT NOT NULL DEFAULT '{}');
CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages(conversation_id, created, id);
CREATE TABLE IF NOT EXISTS chat_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`
const ms = (value) => { const n = Number(value) || 0; return n > 0 && n < 1e12 ? Math.round(n * 1000) : Math.round(n) }
const clip = (value, max) => String(value ?? '').slice(0, max)
const ID = /^[0-9a-f]{32}$/
const now = () => Date.now()

export function composePrompt({ text, profile, notes }) {
  const parts = []
  if (profile?.instructions) parts.push(`(Owner's standing instructions for ${profile.name}: ${profile.instructions})`)
  if (notes) parts.push(notes)
  parts.push(text)
  return parts.join('\n\n')
}

export default function chat(host) {
  let db
  const database = async () => {
    if (!db) { db = await openDatabase(host, 'chat.sqlite3'); db.exec(SCHEMA) }
    return db
  }
  const conversation = async (id) => {
    if (typeof id !== 'string' || !ID.test(id)) fail('chat/invalid', 'conversation_id required')
    const row = (await database()).prepare('SELECT * FROM conversations WHERE id=?').get(id)
    if (!row) fail('chat/not-found', 'Conversation not found')
    return row
  }
  let queue = Promise.resolve()
  const serial = (fn) => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run }

  async function recall(text, profile) {
    if (profile?.recall === 'off') return { notes: '', refs: [] }
    let pages = []
    try { pages = await host.call('memory/pages', {}) } catch (error) { if (error?.code !== 'openteamily/not-found') throw error }
    const hits = rank(text, Array.isArray(pages) ? pages : [])
    return { notes: noteBlock(hits, text), refs: hits.map(({ page, score }) => ({ id: page.id, revision: page.revision ?? 1, title: page.title ?? '', score: Number(score.toFixed(3)) })) }
  }

  return {
    pages: ['chat'],
    endpoints: {
      async conversations() {
        return { items: (await database()).prepare('SELECT * FROM conversations ORDER BY updated DESC, id LIMIT 200').all() }
      },
      async create(payload) {
        const title = typeof payload?.title === 'string' && payload.title.trim() ? payload.title.trim().slice(0, 120) : 'New chat'
        const row = { id: newId(), title, created: now(), updated: now() }
        ;(await database()).prepare('INSERT INTO conversations VALUES(?,?,?,?)').run(row.id, row.title, row.created, row.updated)
        return row
      },
      async rename(payload) {
        await conversation(payload?.conversation_id)
        const title = typeof payload?.title === 'string' ? payload.title.trim().slice(0, 120) : ''
        if (!title) fail('chat/invalid', 'title required')
        ;(await database()).prepare('UPDATE conversations SET title=?, updated=? WHERE id=?').run(title, now(), payload.conversation_id)
        return conversation(payload.conversation_id)
      },
      async remove(payload) {
        await conversation(payload?.conversation_id)
        ;(await database()).prepare('DELETE FROM conversations WHERE id=?').run(payload.conversation_id)
        return { removed: true }
      },
      async messages(payload) {
        await conversation(payload?.conversation_id)
        const rows = (await database()).prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY created, id').all(payload.conversation_id)
        return { items: rows.map((r) => ({ ...r, meta: JSON.parse(r.meta) })) }
      },
      // One-time copy of this user's own platform chat history (the browser reads it
      // with the user's session and hands it to their own DS-Bot). Idempotent: legacy
      // ids are kept, so re-sending the same rows changes nothing.
      async importStatus() {
        const row = (await database()).prepare("SELECT value FROM chat_state WHERE key='legacy_import'").get()
        return row ? JSON.parse(row.value) : { done: false }
      },
      async import(payload) {
        const d = await database()
        const list = Array.isArray(payload?.conversations) ? payload.conversations : []
        if (list.length > 100) fail('chat/invalid', 'at most 100 conversations per call')
        // Finishing is not enough: an empty source may simply mean the platform
        // import bundle has not arrived yet. Only a positive receipt from the
        // source makes the legacy import permanently done.
        const receipt = payload?.receipt
        const complete = payload?.complete === true || (receipt !== undefined && receipt !== null && receipt !== false && receipt !== '')
        const done = payload?.finish === true && complete
        let conversations = 0
        let messages = 0
        d.exec('BEGIN')
        try {
          for (const c of list) {
            if (typeof c?.id !== 'string' || !ID.test(c.id)) fail('chat/invalid', 'conversation id must be 32 hex')
            const items = Array.isArray(c.messages) ? c.messages.slice(0, 2000) : []
            const created = ms(c.created) || now()
            const updated = Math.max(ms(c.updated) || created, ...items.map((m) => ms(m?.created)))
            conversations += Number(d.prepare('INSERT OR IGNORE INTO conversations VALUES(?,?,?,?)')
              .run(c.id, clip(c.title, 120).trim() || 'Imported chat', created, updated).changes)
            for (const m of items) {
              if (typeof m?.id !== 'string' || !ID.test(m.id) || !['user', 'assistant'].includes(m.role)) continue
              const text = clip(m.body, 20000)
              if (!text.trim()) continue
              messages += Number(d.prepare("INSERT OR IGNORE INTO messages VALUES(?,?,?,?,?,?)")
                .run(m.id, c.id, m.role, text, ms(m.created) || created, JSON.stringify({ imported: 'platform' })).changes)
            }
          }
          if (done) {
            const marker = { done: true, at: now() }
            if (receipt !== undefined && receipt !== true) marker.receipt = receipt
            d.prepare("INSERT OR REPLACE INTO chat_state VALUES('legacy_import', ?)").run(JSON.stringify(marker))
          }
          d.exec('COMMIT')
        } catch (error) { d.exec('ROLLBACK'); throw error }
        return { conversations, messages, done }
      },
      async send(payload) {
        const convo = await conversation(payload?.conversation_id)
        const text = typeof payload?.text === 'string' ? payload.text.trim() : ''
        if (!text || text.length > 20000) fail('chat/invalid', 'text must be 1–20000 characters')
        const services = await host.runtime()
        if (typeof services.chatTurn !== 'function') fail('chat/runtime-unavailable', 'DS-Bot chat is not available in this runtime')
        const d = await database()
        const userRow = { id: newId(), created: now() }
        d.prepare("INSERT INTO messages VALUES(?,?,'user',?,?,'{}')").run(userRow.id, convo.id, text, userRow.created)
        let profile = null
        try { profile = await host.call('personal/get', {}) } catch { profile = null }
        const { notes, refs } = await recall(text, profile)
        const prompt = composePrompt({ text, profile, notes })
        const turn = await serial(() => services.chatTurn('plugin:' + convo.id, prompt, 'otp:' + userRow.id))
        const reply = { id: newId(), created: now() }
        const meta = { engine: 'ds-bot', session_id: turn.sessionId ?? null, turn_id: turn.turnId ?? null, memory_refs: refs }
        d.prepare("INSERT INTO messages VALUES(?,?,'assistant',?,?,?)").run(reply.id, convo.id, String(turn.text ?? ''), reply.created, JSON.stringify(meta))
        d.prepare('UPDATE conversations SET updated=? WHERE id=?').run(reply.created, convo.id)
        return { user_message_id: userRow.id, reply: { id: reply.id, text: String(turn.text ?? ''), created: reply.created, meta } }
      },
    },
  }
}
