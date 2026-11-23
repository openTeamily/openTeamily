import { nativeAgents } from './native.js'
import { importPending } from '../../src/pending-import.js'
// Workspace agents inside the user's own DS-Bot (batch B2; moved from
// openteamily/agents.py + the agent conversation dispatch in app.py).
// An agent is a named persona of this user's DS-Bot: its record lives in the
// DS-Bot's own storage, and every message to it is a native DS-Bot turn on its own
// session ('agent:<agent>:<conversation>'), so history, skills and tools are
// DS-Bot's. Public homepages and the discover listing are cross-user and move with
// Bot Social (phase C); this feature keeps only the owner's private data.
import { createHash } from 'node:crypto'
import { openDatabase, newId } from '../../src/store.js'
import { agentsV1 } from './v1.js'
import { importOfficialBundle } from './migrate.js'

export const CATEGORIES = ['content-creation', 'customer-support', 'data-analysis', 'design', 'education', 'engineering',
  'finance', 'it-security', 'investment', 'legal', 'life', 'marketing', 'operations', 'product', 'recruiting', 'research', 'sales']
export const LIMITS = { name: 80, summary: 500, instructions: 16000, quickStarts: 5, quickStart: 80, agents: 200, text: 20000 }
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/
const ID = /^[0-9a-f]{32}$/
const IDEM = /^[A-Za-z0-9_-]{16,64}$/
const sha = (t) => createHash('sha256').update(String(t)).digest('hex')
const now = () => Math.floor(Date.now() / 1000)

const SCHEMA = `
CREATE TABLE IF NOT EXISTS native_personal_binding (singleton INTEGER PRIMARY KEY CHECK(singleton=1), workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL, name_hash TEXT NOT NULL,
  summary TEXT NOT NULL, instructions TEXT NOT NULL, category TEXT, quick_starts TEXT NOT NULL DEFAULT '[]',
  revision INTEGER NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
  key_hash TEXT NOT NULL, request_hash TEXT NOT NULL, imported_from TEXT,
  UNIQUE(workspace_id, key_hash), UNIQUE(workspace_id, name_hash));
CREATE TABLE IF NOT EXISTS agent_conversations (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  title TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS agent_conversations_by_agent ON agent_conversations(agent_id, updated DESC, id);
CREATE TABLE IF NOT EXISTS agent_messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')), text TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL, meta TEXT NOT NULL DEFAULT '{}');
CREATE INDEX IF NOT EXISTS agent_messages_by_conversation ON agent_messages(conversation_id, created, id);
`

export function fail(code, message, status) { throw Object.assign(new Error(message), { code: `agents/${code}`, status }) }
const validName = (v) => typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= LIMITS.name && !CONTROL.test(v)
const validSummary = (v) => typeof v === 'string' && v.length <= LIMITS.summary && !CONTROL.test(v)
const validInstructions = (v) => typeof v === 'string' && v.length <= LIMITS.instructions && !CONTROL.test(v)
const validCategory = (v) => v === null || v === '' || CATEGORIES.includes(v)
const validQuickStarts = (v) => Array.isArray(v) && v.length <= LIMITS.quickStarts
  && v.every((t) => typeof t === 'string' && t.trim().length >= 1 && t.trim().length <= LIMITS.quickStart && !CONTROL.test(t))

// The persona header every turn carries (same order as conversations.compose_prompt).
export function composePrompt(agent, text, replyLanguage) {
  const parts = [`You are ${(agent.name || 'FlyBot').trim()}.`]
  if (replyLanguage) parts.push(`Reply in ${replyLanguage}.`)
  if (agent.summary?.trim()) parts.push(agent.summary.trim())
  if (agent.instructions?.trim()) parts.push(agent.instructions.trim())
  return `${parts.join('\n')}\n\nUser: ${text.trim()}`
}

export function view(row) {
  return { id: row.id, workspace_id: row.workspace_id, name: row.name, summary: row.summary, instructions: row.instructions,
    category: row.category || null, quick_starts: JSON.parse(row.quick_starts), revision: row.revision, created: row.created,
    updated: row.updated, archived: row.archived, native_bot_id: row.native_bot_id || null, native_name: row.native_name || null, native_deleted: row.native_deleted || false, served_by: 'ds-bot' }
}

export function createAgents({ db, host }) {
  db.exec(SCHEMA)
  db.function('ot_search_fold', { deterministic: true }, text => text.toLocaleLowerCase('en-US'))
  const native = nativeAgents({ host, db })
  const one = (sql, ...a) => db.prepare(sql).get(...a)
  const all = (sql, ...a) => db.prepare(sql).all(...a)
  const run = (sql, ...a) => db.prepare(sql).run(...a)
  const ws = (p) => { if (typeof p?.workspace_id !== 'string' || !ID.test(p.workspace_id)) fail('invalid', 'workspace_id required', 400); return p.workspace_id }
  const load = (workspaceId, id) => {
    const row = typeof id === 'string' && ID.test(id) ? one('SELECT * FROM agents WHERE id=? AND workspace_id=?', id, workspaceId) : undefined
    if (!row) fail('not-found', 'Agent not found', 404)
    return row
  }
  const loadAny = (id) => {
    const row = typeof id === 'string' && ID.test(id) ? one('SELECT * FROM agents WHERE id=?', id) : undefined
    if (!row) fail('not-found', 'Agent not found', 404)
    return row
  }
  const conversation = (agent, id) => {
    const row = typeof id === 'string' && ID.test(id) ? one('SELECT * FROM agent_conversations WHERE id=? AND agent_id=?', id, agent.id) : undefined
    if (!row) fail('not-found', 'Conversation not found', 404)
    return row
  }
  const conversationMessages = id => all('SELECT * FROM agent_messages WHERE conversation_id=? ORDER BY created, id', id)
    .map(message => ({ ...message, meta: JSON.parse(message.meta) }))

  // One DS-Bot turn as this agent. Shared by the external API and team runs.
  async function turn({ agent_id: agentId, key, text, request_id: requestId, reply_language: lang, context }) {
    const agent = await native.ensure(loadAny(agentId))
    if (agent.archived) fail('archived', 'Agent is archived', 409)
    if (typeof text !== 'string' || !text.trim() || text.length > LIMITS.text) fail('invalid', 'text must be 1–20000 characters', 400)
    const services = await host.runtime()
    if (typeof services?.chatTurn !== 'function') fail('runtime-unavailable', 'DS-Bot chat service unavailable', 503)
    const sessionKey = `agent:${agent.id}:${typeof key === 'string' && /^[A-Za-z0-9:_-]{1,96}$/.test(key) ? key : 'default'}`
    await host.call('skills/materialForScope', { scope: agent.workspace_id + ':' + agent.id })
    const mapping = await native.session(agent, sessionKey, agent.name)
    if (typeof services.nativeTurn !== 'function') fail('runtime-unavailable', 'Native Bot turn service unavailable', 503)
    const reply = await services.nativeTurn(mapping.native_bot_id, mapping.native_session_id, [typeof context === 'string' ? context.slice(0, 20000) : '', lang ? `Reply in ${lang}.\n\n${text}` : text].filter(Boolean).join('\n\n'), requestId || `ot-agent:${newId()}`)
    const out = String(reply?.text ?? '').trim()
    if (!out) fail('empty-reply', 'DS-Bot turn ended without a reply', 502)
    return { text: out, agent_id: agent.id, agent_name: agent.name, engine: 'ds-bot', session_key: sessionKey, session_id: reply.sessionId ?? null, turn_id: reply.turnId ?? null }
  }

  const endpoints = {
    async 'personal-binding'() { return one('SELECT workspace_id,agent_id FROM native_personal_binding WHERE singleton=1') || null },
    async 'adopt-personal-chat'(p, materialize = true) {
      const agent = load(ws(p), p.id)
      const binding = one('SELECT * FROM native_personal_binding WHERE singleton=1')
      if (binding && (binding.agent_id !== agent.id || binding.workspace_id !== agent.workspace_id)) fail('personal-binding-conflict', 'Personal agent is already explicitly bound', 409)
      const list = Array.isArray(p.conversations) ? p.conversations : (await host.call('chat/exportLegacy', {})).conversations
      db.exec('BEGIN')
      try {
        run('INSERT OR IGNORE INTO native_personal_binding VALUES(1,?,?)', agent.workspace_id, agent.id)
        const locked = one('SELECT * FROM native_personal_binding WHERE singleton=1')
        if (locked.agent_id !== agent.id || locked.workspace_id !== agent.workspace_id) fail('personal-binding-conflict', 'Personal binding changed during adoption', 409)
        for (const c of list) {
          if (!ID.test(c?.id || '')) fail('invalid', 'Invalid private conversation id', 400)
          const existing = one('SELECT agent_id FROM agent_conversations WHERE id=?', c.id)
          if (existing && existing.agent_id !== agent.id) fail('personal-binding-conflict', 'Private conversation belongs to another agent', 409)
          const stamp = v => Number(v) > 1e12 ? Math.floor(Number(v) / 1000) : Number(v) || now()
          run('INSERT OR IGNORE INTO agent_conversations VALUES(?,?,?,?,?)', c.id, agent.id, String(c.title || 'Personal chat').slice(0,120), stamp(c.created), stamp(c.updated))
          for (const m of c.messages || []) {
            if (!ID.test(m?.id || '') || !['user','assistant'].includes(m.role)) fail('invalid', 'Invalid private message', 400)
            const present = one('SELECT conversation_id FROM agent_messages WHERE id=?', m.id)
            if (present && present.conversation_id !== c.id) fail('personal-binding-conflict', 'Private message belongs to another conversation', 409)
            run('INSERT OR IGNORE INTO agent_messages VALUES(?,?,?,?,?,?,?)', m.id, c.id, m.role, String(m.text || ''), 'succeeded', stamp(m.created), JSON.stringify({...m.meta, legacy_chat_created:m.created}))
          }
        }
        db.exec('COMMIT')
      } catch (e) { db.exec('ROLLBACK'); throw e }
      // Boot import persists history before the runtime is attached. Reconciliation materializes it.
      if (!materialize) return { workspace_id: agent.workspace_id, agent_id: agent.id }
      for (const c of list) await native.session(agent, `agent:${agent.id}:${c.id}`, c.title)
      return { workspace_id: agent.workspace_id, agent_id:agent.id, native_bot_id:(await native.ensure(agent)).native_bot_id }
    },
    async reconcile() {
      const items = []
      for (const row of all('SELECT * FROM agents ORDER BY id')) {
        const a = await native.ensure(row)
        const sessions = []
        if (!a.native_deleted) for (const c of all('SELECT * FROM agent_conversations WHERE agent_id=?', row.id)) sessions.push(await native.session(a, `agent:${a.id}:${c.id}`, c.title))
        items.push({ agent_id: row.id, native_bot_id: a.native_bot_id, native_deleted: !!a.native_deleted, sessions })
      }
      return { items }
    },
    async groupActivity(p) {
      const { rt } = await host.runtime()
      const mappings = all('SELECT * FROM native_agent_sessions WHERE conversation_key LIKE ?', 'agent:%:social:' + String(p.conversation_id || ''))
      const active = mappings.filter(m => rt.live.get(m.session_id)?.turn !== undefined)
      return { running: active.length > 0, speaking: active.length ? one('SELECT bot_id FROM native_agent_objects WHERE agent_id=?', active[0].agent_id)?.bot_id || null : null }
    },
    byId: async p => ({ agent: view(await native.ensure(loadAny(p.id))) }),
    categories: async () => ({ items: CATEGORIES }),
    async list(p) {
      const workspaceId = ws(p)
      const needle = String(p.q ?? '').trim().toLowerCase()
      const archived = p.archived === true ? 1 : 0
      let rows = all('SELECT * FROM agents WHERE workspace_id=? AND archived=? ORDER BY id', workspaceId, archived)
      if (p.category) rows = rows.filter((r) => r.category === p.category)
      if (needle) rows = rows.filter((r) => r.name.toLowerCase().includes(needle) || r.summary.toLowerCase().includes(needle))
      return { items: await Promise.all(rows.map(async row => view(await native.ensure(row)))) }
    },
    get: async (p) => ({ agent: view(await native.ensure(load(ws(p), p.id))) }),
    async create(p) {
      const workspaceId = ws(p)
      const { name } = p
      const summary = p.summary ?? ''
      const instructions = p.instructions ?? ''
      const category = p.category ?? null
      const starts = p.quick_starts ?? []
      if (!validName(name) || !validSummary(summary) || !validInstructions(instructions) || !validCategory(category) || !validQuickStarts(starts)) {
        fail('invalid', 'Provide a name (≤80), summary (≤500) and instructions (≤16000)', 400)
      }
      if (!IDEM.test(String(p.idempotency_key ?? ''))) fail('invalid', 'Supply a 16–64 character Idempotency-Key', 400)
      const clean = name.trim()
      const keyHash = sha(p.idempotency_key)
      const requestHash = sha(JSON.stringify([clean, summary, instructions, category || null, starts.map((s) => s.trim())]))
      const prior = one('SELECT * FROM agents WHERE workspace_id=? AND key_hash=?', workspaceId, keyHash)
      if (prior) {
        if (prior.request_hash !== requestHash) fail('conflict', 'Idempotency key was used for a different request', 409)
        return { status: 200, agent: view(await native.ensure(prior)) }
      }
      if (one('SELECT id FROM agents WHERE workspace_id=? AND name_hash=?', workspaceId, sha(clean.toLowerCase()))) fail('conflict', 'An agent with this name already exists', 409)
      if (one('SELECT COUNT(*) AS n FROM agents WHERE workspace_id=?', workspaceId).n >= LIMITS.agents) fail('quota', 'Agent capacity reached', 429)
      const id = newId()
      const t = now()
      run('INSERT INTO agents (id, workspace_id, name, name_hash, summary, instructions, category, quick_starts, revision, created, updated, archived, key_hash, request_hash) VALUES(?,?,?,?,?,?,?,?,1,?,?,0,?,?)',
        id, workspaceId, clean, sha(clean.toLowerCase()), summary, instructions, category || null, JSON.stringify(starts.map((s) => s.trim())), t, t, keyHash, requestHash)
      return { status: 201, agent: view(await native.ensure(one('SELECT * FROM agents WHERE id=?', id))) }
    },
    async update(p) {
      const row = await native.ensure(load(ws(p), p.id))
      const { revision, changes } = p
      if (!Number.isInteger(revision) || !changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length) fail('invalid', 'Provide the current revision and a non-empty changes object', 400)
      const allowed = new Set(['name', 'summary', 'instructions', 'category', 'quick_starts'])
      if (Object.keys(changes).some((k) => !allowed.has(k))) fail('invalid', 'Unknown agent field', 400)
      if (revision !== row.revision) fail('conflict', 'Agent changed elsewhere; reload and retry', 409)
      const next = { name: row.name, summary: row.summary, instructions: row.instructions, category: row.category, quick_starts: JSON.parse(row.quick_starts) }
      if ('name' in changes) { if (!validName(changes.name)) fail('invalid', 'Invalid name', 400); next.name = changes.name.trim() }
      if ('summary' in changes) { if (!validSummary(changes.summary)) fail('invalid', 'Invalid summary', 400); next.summary = changes.summary }
      if ('instructions' in changes) { if (!validInstructions(changes.instructions)) fail('invalid', 'Invalid instructions', 400); next.instructions = changes.instructions }
      if ('category' in changes) { if (!validCategory(changes.category)) fail('invalid', 'Invalid category', 400); next.category = changes.category || null }
      if ('quick_starts' in changes) { if (!validQuickStarts(changes.quick_starts)) fail('invalid', 'Invalid quick starts', 400); next.quick_starts = changes.quick_starts.map((s) => s.trim()) }
      if (next.name !== row.name && one('SELECT id FROM agents WHERE workspace_id=? AND name_hash=? AND id<>?', row.workspace_id, sha(next.name.toLowerCase()), row.id)) fail('conflict', 'An agent with this name already exists', 409)
      await native.update(row, next)
      run('UPDATE agents SET name=?, name_hash=?, summary=?, instructions=?, category=?, quick_starts=?, revision=revision+1, updated=? WHERE id=?',
        next.name, sha(next.name.toLowerCase()), next.summary, next.instructions, next.category, JSON.stringify(next.quick_starts), now(), row.id)
      return { agent: view(await native.ensure(one('SELECT * FROM agents WHERE id=?', row.id))) }
    },
    async archive(p) {
      const row = await native.ensure(load(ws(p), p.id))
      const archived = p.archived === false ? 0 : 1
      await native.update(row, { archived: !!archived })
      run('UPDATE agents SET archived=?, revision=revision+1, updated=? WHERE id=?', archived, now(), row.id)
      return { agent: view(await native.ensure(one('SELECT * FROM agents WHERE id=?', row.id))) }
    },
    async conversations(p) {
      const agent = load(ws(p), p.id)
      const rows = all('SELECT * FROM agent_conversations WHERE agent_id=? ORDER BY updated DESC, id LIMIT 200', agent.id)
      return { items: await Promise.all(rows.map(async c => ({ ...c, ...await native.session(agent, `agent:${agent.id}:${c.id}`, c.title) }))) }
    },
    async conversationSummaries(p) {
      const workspaceId = ws(p)
      const ids = p.agent_ids
      if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== 'string' || !ID.test(id))) {
        fail('invalid', 'Provide at most 100 agent IDs', 400)
      }
      // Listing a conversation must not hydrate its native Session or import its history.
      const list = db.prepare(`SELECT c.id, c.agent_id, c.title, c.updated
        FROM agent_conversations c JOIN agents a ON a.id=c.agent_id
        WHERE c.agent_id=? AND a.workspace_id=?
        ORDER BY c.updated DESC, c.id LIMIT 200`)
      return { items: [...new Set(ids)].flatMap(id => list.all(id, workspaceId)) }
    },
    async 'conversation-create'(p) {
      const agent = load(ws(p), p.id)
      const title = typeof p.title === 'string' && p.title.trim() ? p.title.trim().slice(0, 120) : agent.name
      const row = { id: newId(), agent_id: agent.id, title, created: now(), updated: now() }
      run('INSERT INTO agent_conversations VALUES(?,?,?,?,?)', row.id, row.agent_id, row.title, row.created, row.updated)
      const mapping = await native.session(agent, `agent:${agent.id}:${row.id}`, row.title)
      return { status: 201, conversation: { ...row, ...mapping } }
    },
    async openConversation(p) {
      const agent = load(ws(p), p.id)
      const row = conversation(agent, p.conversation_id)
      const {native_name, ...mapping} = await native.session(agent, `agent:${agent.id}:${row.id}`, row.title)
      return {
        agent: view({...load(agent.workspace_id, agent.id), native_bot_id: mapping.native_bot_id, native_name}),
        conversation: {...row, ...mapping},
        items: conversationMessages(row.id),
      }
    },
    async searchMessages(p) {
      const workspaceId = ws(p)
      const { q, limit, position, cursor, conversation_id: conversationId = null } = p
      if (typeof q !== 'string' || q.length < 1 || q.length > 80 || CONTROL.test(q)
          || !Number.isInteger(limit) || limit < 1 || limit > 51
          || (conversationId !== null && !ID.test(conversationId))
          || (cursor && !ID.test(cursor))
          || (position && (!Array.isArray(position) || position.length !== 2
            || !Number.isSafeInteger(position[0]) || !ID.test(position[1])))) {
        fail('invalid', 'Invalid message search', 400)
      }
      const scope = `FROM agents a JOIN agent_conversations c ON c.agent_id=a.id
        JOIN agent_messages m ON m.conversation_id=c.id
        WHERE a.workspace_id=? AND (? IS NULL OR c.id=?)`
      const bindings = [workspaceId, conversationId, conversationId]
      let [created, id] = position || [null, null]
      if (cursor) {
        const row = one(`SELECT m.created ${scope} AND m.id=?`, ...bindings, cursor)
        if (!row) fail('invalid', 'Invalid search cursor', 400)
        created = row.created
        id = cursor
      }
      const comparison = p.ascending === true ? '>' : '<'
      const order = p.ascending === true ? 'ASC' : 'DESC'
      const linkFilter = p.links === true ? "AND (instr(m.text,'http://')>0 OR instr(m.text,'https://')>0)" : ''
      return { items: all(`SELECT m.id, c.id AS conversation_id, a.id AS agent_id, c.title, m.text AS body, m.created
        ${scope} AND instr(ot_search_fold(m.text),ot_search_fold(?))>0 ${linkFilter}
        AND (? IS NULL OR (m.created,m.id) ${comparison} (?,?))
        ORDER BY m.created ${order}, m.id ${order} LIMIT ?`, ...bindings, q, created, created, id, limit) }
    },
    async messages(p) {
      const agent = load(ws(p), p.id)
      const convo = conversation(agent, p.conversation_id)
      await native.session(agent, `agent:${agent.id}:${convo.id}`, convo.title)
      return { items: conversationMessages(convo.id) }
    },
    async saveMessage(p) {
      const agent = load(ws(p), p.id)
      const convo = conversation(agent, p.conversation_id)
      if (typeof p.message_id !== 'string' || !ID.test(p.message_id)) fail('invalid', 'Invalid message ID', 400)
      const row = one('SELECT * FROM agent_messages WHERE id=? AND conversation_id=?', p.message_id, convo.id)
      if (!row) fail('not-found', 'Message not found', 404)
      if (!['sent', 'succeeded'].includes(row.status) || !row.text.trim()) fail('conflict', 'Only completed text messages can be saved', 409)
      return host.call('artifacts/saveChatMessage', {
        workspace_id: agent.workspace_id, agent_id: agent.id, conversation_id: convo.id,
        conversation_title: convo.title, message_id: row.id, title: p.title, body: row.text,
      })
    },
    // Send one message to the agent: a native DS-Bot turn on this conversation's session.
    async send(p) {
      const agent = load(ws(p), p.id)
      const convo = conversation(agent, p.conversation_id)
      const text = typeof p.text === 'string' ? p.text.trim() : ''
      if (!text || text.length > LIMITS.text) fail('invalid', 'text must be 1–20000 characters', 400)
      const userId = newId()
      run('INSERT INTO agent_messages VALUES(?,?,?,?,?,?,?)', userId, convo.id, 'user', text, 'sent', now(), JSON.stringify({ nativePending:true }))
      const replyId = newId()
      try {
        const reply = await turn({ agent_id: agent.id, key: convo.id, text, request_id: `ot-agent:${userId}`, reply_language: p.reply_language, context: p.context })
        run('UPDATE agent_messages SET meta=? WHERE id=?', JSON.stringify({session_id:reply.session_id}), userId)
        run('INSERT INTO agent_messages VALUES(?,?,?,?,?,?,?)', replyId, convo.id, 'assistant', reply.text, 'succeeded', now(),
          JSON.stringify({ engine: 'ds-bot', session_id: reply.session_id, turn_id: reply.turn_id }))
      } catch (error) {
        run('UPDATE agent_messages SET meta=? WHERE id=?', '{}', userId)
        run('INSERT INTO agent_messages VALUES(?,?,?,?,?,?,?)', replyId, convo.id, 'assistant', '', 'failed', now(), JSON.stringify({ error: String(error?.code ?? 'agents/failed') }))
        run('UPDATE agent_conversations SET updated=? WHERE id=?', now(), convo.id)
        throw error
      }
      run('UPDATE agent_conversations SET updated=? WHERE id=?', now(), convo.id)
      const rows = all('SELECT * FROM agent_messages WHERE id IN (?,?) ORDER BY created, id', userId, replyId)
      return { message: rows.find((r) => r.id === userId), reply: { ...rows.find((r) => r.id === replyId), meta: JSON.parse(rows.find((r) => r.id === replyId).meta) } }
    },
    turn,

    async importHistory(bundle) {
      let conversations = 0, messages = 0
      for (const row of bundle?.conversations ?? []) {
        if (!row?.id || !row.agent_id || one('SELECT id FROM agent_conversations WHERE id=?', row.id)) continue
        if (!one('SELECT id FROM agents WHERE id=?', row.agent_id)) continue
        run('INSERT INTO agent_conversations VALUES(?,?,?,?,?)', row.id, row.agent_id, String(row.title || '新对话').slice(0, 120), Number(row.created) || now(), Number(row.updated) || now())
        conversations += 1
      }
      for (const row of bundle?.messages ?? []) {
        if (!row?.id || !row.conversation_id || one('SELECT id FROM agent_messages WHERE id=?', row.id)) continue
        if (!one('SELECT id FROM agent_conversations WHERE id=?', row.conversation_id)) continue
        const status = row.status === 'queued' || row.status === 'running' ? 'failed' : (row.status === 'sent' || row.status === 'succeeded' ? (row.role === 'user' ? 'sent' : 'succeeded') : (row.status || 'failed'))
        run('INSERT INTO agent_messages VALUES(?,?,?,?,?,?,?)', row.id, row.conversation_id, row.role === 'assistant' ? 'assistant' : 'user', row.body ?? row.text ?? '', status, Number(row.created) || now(), JSON.stringify({ imported: true, error_code: row.error_code ?? (status === 'failed' ? 'migrated' : undefined) }))
        messages += 1
      }
      return { conversations, messages }
    },
    // Legacy rows from the management export bundle (idempotent by id).
    async import(bundle) {
      const rows = Array.isArray(bundle?.agents) ? bundle.agents : null
      if (!rows || rows.length > LIMITS.agents) fail('invalid', 'agents list required', 400)
      let imported = 0
      for (const r of rows) {
        if (!r || !ID.test(String(r.id)) || !ID.test(String(r.workspace_id)) || !validName(r.name)) fail('invalid', 'Invalid legacy agent row', 400)
        if (one('SELECT id FROM agents WHERE id=?', r.id)) continue
        const name = r.name.trim()
        if (one('SELECT id FROM agents WHERE workspace_id=? AND name_hash=?', r.workspace_id, sha(name.toLowerCase()))) continue
        const starts = validQuickStarts(r.quick_starts ?? []) ? r.quick_starts ?? [] : []
        run('INSERT INTO agents (id, workspace_id, name, name_hash, summary, instructions, category, quick_starts, revision, created, updated, archived, key_hash, request_hash, imported_from) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          r.id, r.workspace_id, name, sha(name.toLowerCase()), validSummary(r.summary ?? '') ? r.summary ?? '' : '',
          validInstructions(r.instructions ?? '') ? r.instructions ?? '' : '', validCategory(r.category ?? null) ? r.category || null : null,
          JSON.stringify(starts), Number.isInteger(r.revision) && r.revision > 0 ? r.revision : 1, Number(r.created) || now(), Number(r.updated) || now(),
          r.archived ? 1 : 0, sha('import:' + r.id), sha('import:' + r.id), 'management')
        imported += 1
      }
      return { imported }
    },
  }
  endpoints.v1 = agentsV1({ endpoints, log: host?.log })
  const migrate = async (bundle) => (bundle?.format === 'openteamily-dsbot-import' ? importOfficialBundle(endpoints, bundle) : endpoints.import(bundle))
  return { endpoints, migrate }
}

export default async function agents(host) {
  const db = await openDatabase(host, 'agents.sqlite3')
  const { endpoints, migrate } = createAgents({ db, host })
  await importPending({ host, db, migrate })
  const timer = setTimeout(() => endpoints.reconcile().catch(() => host.log('native agent history reconciliation pending; retry agents/reconcile')), 10000)
  timer.unref?.()
  const wrapped = {}
  for (const [name, fn] of Object.entries(endpoints)) wrapped[name] = async (payload) => fn(payload ?? {})
  return { pages: ['agents'], endpoints: wrapped, migrate }
}
