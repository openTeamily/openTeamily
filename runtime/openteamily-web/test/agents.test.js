import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createAgents, composePrompt, CATEGORIES } from '../features/agents/index.js'
import { loadFeatures } from '../src/features.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const W = 'a'.repeat(32)

function fixture(chatTurn) {
  const turns = []
  const host = { runtime: async () => ({ rt: {}, ctx: {}, chatTurn: chatTurn ?? (async (key, text, rid) => { turns.push({ key, text, rid }); return { text: `DS-Bot reply ${turns.length}`, sessionId: 's-' + key, turnId: 't' } }) }) }
  const created = createAgents({ db: new DatabaseSync(join(mkdtempSync(join(tmpdir(), 'ot-agents-')), 'a.sqlite3')), host })
  return { e: created.endpoints, turns, migrate: created.migrate }
}

test('categories stay in step with the Python source', () => {
  const py = readFileSync(join(HERE, '../../../openteamily/agents.py'), 'utf8')
  const block = py.slice(py.indexOf('CATEGORIES = ('), py.indexOf(')', py.indexOf('CATEGORIES = (')))
  assert.deepEqual([...block.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]), CATEGORIES)
})

test('agent CRUD: idempotent create, unique names, revisions, archive, search', async () => {
  const { e } = fixture()
  const body = { workspace_id: W, name: '研究员', summary: '查资料', instructions: '只给有出处的结论', category: 'research', quick_starts: ['帮我查'], idempotency_key: 'k'.repeat(16) }
  const made = await e.create(body)
  assert.equal(made.status, 201)
  assert.equal(made.agent.served_by, 'ds-bot')
  assert.equal((await e.create(body)).status, 200)
  await assert.rejects(e.create({ ...body, summary: 'x' }), /different request/)
  await assert.rejects(e.create({ ...body, idempotency_key: 'j'.repeat(16) }), /already exists/)
  await assert.rejects(e.create({ ...body, category: 'nope', idempotency_key: 'm'.repeat(16) }), (err) => err.status === 400)
  const id = made.agent.id
  const up = await e.update({ workspace_id: W, id, revision: 1, changes: { name: '资深研究员' } })
  assert.equal(up.agent.revision, 2)
  await assert.rejects(e.update({ workspace_id: W, id, revision: 1, changes: { summary: 'y' } }), (err) => err.status === 409)
  assert.equal((await e.list({ workspace_id: W, q: '资深' })).items.length, 1)
  await e.archive({ workspace_id: W, id })
  assert.equal((await e.list({ workspace_id: W })).items.length, 0)
  assert.equal((await e.list({ workspace_id: W, archived: true })).items.length, 1)
  await e.archive({ workspace_id: W, id, archived: false })
  assert.equal((await e.list({ workspace_id: W, category: 'research' })).items.length, 1)
  await assert.rejects(e.get({ workspace_id: 'b'.repeat(32), id }), (err) => err.code === 'agents/not-found')
})

test('messages to an agent are native DS-Bot turns on that conversation\'s own session', async () => {
  const { e, turns } = fixture()
  const { agent } = await e.create({ workspace_id: W, name: '助手', summary: '', instructions: 'Keep answers to one sentence.', idempotency_key: 'a'.repeat(16) })
  const { conversation } = await e['conversation-create']({ workspace_id: W, id: agent.id })
  const sent = await e.send({ workspace_id: W, id: agent.id, conversation_id: conversation.id, text: '你好' })
  assert.equal(sent.reply.text, 'DS-Bot reply 1')
  assert.equal(sent.reply.meta.engine, 'ds-bot')
  assert.equal(turns[0].key, `agent:${agent.id}:${conversation.id}`)
  assert.match(turns[0].text, /^You are 助手\.\nKeep answers to one sentence\.\n\nUser: 你好$/)
  assert.equal(turns[0].rid, `ot-agent:${sent.message.id}`)
  assert.equal((await e.messages({ workspace_id: W, id: agent.id, conversation_id: conversation.id })).items.length, 2)
  await e.archive({ workspace_id: W, id: agent.id })
  await assert.rejects(e.send({ workspace_id: W, id: agent.id, conversation_id: conversation.id, text: 'x' }), (err) => err.code === 'agents/archived')
})

test('without the DS-Bot chat service a send fails closed and is recorded', async () => {
  const host = { runtime: async () => ({ rt: {}, ctx: {} }) }
  const { endpoints: e } = createAgents({ db: new DatabaseSync(':memory:'), host })
  const { agent } = await e.create({ workspace_id: W, name: 'A', idempotency_key: 'b'.repeat(16) })
  const { conversation } = await e['conversation-create']({ workspace_id: W, id: agent.id })
  await assert.rejects(e.send({ workspace_id: W, id: agent.id, conversation_id: conversation.id, text: 'x' }), (err) => err.code === 'agents/runtime-unavailable')
  const items = (await e.messages({ workspace_id: W, id: agent.id, conversation_id: conversation.id })).items
  assert.deepEqual(items.map((m) => m.status), ['sent', 'failed'])
})

test('legacy import is idempotent; persona header order matches the server', async () => {
  const { e } = fixture()
  const row = { id: 'c'.repeat(32), workspace_id: W, name: '旧', summary: 's', instructions: 'i', revision: 4, archived: 0 }
  assert.equal((await e.import({ agents: [row] })).imported, 1)
  assert.equal((await e.import({ agents: [row] })).imported, 0)
  assert.equal((await e.get({ workspace_id: W, id: row.id })).agent.revision, 4)
  assert.equal(composePrompt({ name: 'N', summary: 'S', instructions: 'I' }, ' q ', 'Chinese'), 'You are N.\nReply in Chinese.\nS\nI\n\nUser: q')
})

test('agents load through the extension point', async () => {
  process.env.OPENTEAMILY_AUTOMATIONS_CLOCK = '0'
  const { table, loaded } = await loadFeatures({ dir: join(HERE, '../features'), identity: { instanceId: 'e'.repeat(32) }, dataDir: mkdtempSync(join(tmpdir(), 'ot-agents-load-')), log: () => {} })
  assert.ok(loaded.includes('agents'))
  assert.ok(table['agents/turn'] && table['agents/send'] && table['agents/conversation-create'])
})



test('v1 lists agents and conversations in the legacy /v1 shape', async () => {
  const { e } = fixture()
  const created = await e.v1({
    method: 'POST', path: `/v1/workspaces/${W}/agents`,
    idempotency_key: 'a'.repeat(20),
    body: { name: '文档助手', summary: '整理', instructions: '先列要点。' },
  })
  assert.equal(created.status, 201, created.body)
  const id = created.body.agent.id
  assert.equal(created.body.agent.homepage.visibility, 'restricted')
  const listed = await e.v1({ method: 'GET', path: `/v1/workspaces/${W}/agents?limit=100` })
  assert.equal(listed.body.items[0].id, id)
  const convo = await e.v1({ method: 'POST', path: `/v1/workspaces/${W}/agents/${id}/conversations`, body: { title: '新对话' } })
  assert.equal(convo.status, 201)
  const cid = convo.body.conversation.id
  const sent = await e.v1({
    method: 'POST', path: `/v1/workspaces/${W}/agents/${id}/conversations/${cid}/messages`,
    body: { body: '你好' },
  })
  assert.equal(sent.status, 201)
  assert.equal(sent.body.message.body, '你好')
  assert.equal(sent.body.reply.role, 'assistant')
  const opened = await e.v1({ method: 'GET', path: `/v1/workspaces/${W}/agents/${id}/conversations/${cid}` })
  assert.equal(opened.body.items[0].body, '你好')
  const homepage = await e.v1({ method: 'POST', path: `/v1/workspaces/${W}/agents/${id}/homepage`, body: {} })
  assert.equal(homepage.status, 404)
  assert.equal(homepage.body.error.code, 'not_moved')
})


test('official agents bundle imports once including history', async () => {
  const { createHash } = await import('node:crypto')
  const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
  const table = (rows) => {
    const text = JSON.stringify(rows)
    return { text, manifest: { rows: rows.length, sha256: sha(text) } }
  }
  const aid = 'c'.repeat(32), cid = 'd'.repeat(32), mid = 'e'.repeat(32)
  const agents = table([{ id: aid, workspace_id: W, name: '旧助手', summary: '整理', instructions: '先列要点。', revision: 1, created: 1, updated: 1, archived: 0 }])
  const convos = table([{ id: cid, workspace_id: W, agent_id: aid, user_id: 'u'.repeat(32), title: '旧对话', created: 1, updated: 1 }])
  const messages = table([{ id: mid, conversation_id: cid, workspace_id: W, agent_id: aid, user_id: 'u'.repeat(32), role: 'user', body: '你好', status: 'succeeded', created: 1, updated: 1, seq: 1 }])
  const bundle = { format: 'openteamily-dsbot-import', version: 1, feature: 'agents', created: 1,
    tables: { workspace_agents: agents.text, agent_conversations: convos.text, agent_messages: messages.text },
    manifest: { workspace_agents: agents.manifest, agent_conversations: convos.manifest, agent_messages: messages.manifest } }
  const { e, migrate } = fixture()
  const first = await migrate(bundle)
  assert.equal(first.imported, 1)
  assert.equal((await e.list({ workspace_id: W })).items[0].name, '旧助手')
  assert.equal((await e.messages({ workspace_id: W, id: aid, conversation_id: cid })).items[0].text, '你好')
  assert.equal((await migrate(bundle)).imported, 0)
})

test('official personal history is durable before the native runtime attaches', async () => {
  const { createHash } = await import('node:crypto')
  const aid = 'c'.repeat(32), cid = 'd'.repeat(32)
  const tables = Object.fromEntries(Object.entries({
    workspace_agents: [{id: aid, workspace_id: W, name: 'Personal Agent'}],
    personal_agents: [{agent_id: aid, workspace_id: W}],
  }).map(([name, rows]) => [name, JSON.stringify(rows)]))
  const manifest = Object.fromEntries(Object.entries(tables).map(([name, text]) => [
    name, {rows: 1, sha256: createHash('sha256').update(text).digest('hex')},
  ]))
  const db = new DatabaseSync(':memory:')
  const host = {
    call: async (endpoint) => {
      assert.equal(endpoint, 'chat/exportLegacy')
      return {conversations: [{id: cid, title: 'Retained history'}]}
    },
    runtime: async () => { throw new Error('runtime has not attached') },
  }
  const {endpoints, migrate} = createAgents({db, host})
  const bundle = {format: 'openteamily-dsbot-import', version: 1, feature: 'agents', tables, manifest}
  await migrate(bundle)
  await migrate(bundle)
  assert.deepEqual({...await endpoints['personal-binding']()}, {agent_id: aid, workspace_id: W})
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM agent_conversations WHERE id=?').get(cid).count, 1)
})
