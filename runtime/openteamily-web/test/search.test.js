import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { loadFeatures } from '../src/features.js'
import { boot, key, WS } from './helpers.js'

const hex = (n) => String(n).repeat(32).slice(0, 32)

// Import workspace-agent history through the same endpoints the cutover uses.
async function seedAgentHistory(bot, { workspace = WS, name = '导入助手', agentId = hex(1),
  conversationId = hex(2), title = '旧对话', messages = [] } = {}) {
  const imported = await bot.endpoint('agents/import', { agents: [{ id: agentId, workspace_id: workspace,
    name, summary: '导入的智能体', instructions: '', revision: 1, created: 1700000000, updated: 1700000000 }] })
  assert.equal(imported.ok, true, JSON.stringify(imported))
  const history = await bot.endpoint('agents/importHistory', { conversations: [{ id: conversationId, agent_id: agentId,
    title, created: 1700000000, updated: 1700000100 }], messages })
  assert.equal(history.ok, true, JSON.stringify(history))
  return { agentId, conversationId }
}

// Seed chat history directly in the chat feature's own store (a real send needs a running DS-Bot).
async function seedChat(bot) {
  const convo = await bot.endpoint('chat/create', { title: '周报助手' })
  assert.equal(convo.ok, true, JSON.stringify(convo))
  const db = new DatabaseSync(join(bot.vol.data, 'openteamily', 'features', 'chat', 'chat.sqlite3'))
  const insert = db.prepare('INSERT INTO messages (id, conversation_id, role, text, created) VALUES (?,?,?,?,?)')
  const ids = []
  for (const [i, text] of ['帮我写周报', '好的，周报草稿见 https://example.com/report。', '谢谢'].entries()) {
    const id = String(i + 1).repeat(32).slice(0, 32)
    insert.run(id, convo.value.id, i % 2 ? 'assistant' : 'user', text, 1800000000000 + i * 1000)
    ids.push(id)
  }
  db.close()
  return { conversation: convo.value.id, ids }
}

test('message search runs in DS-Bot over this owner\'s own conversations', async () => {
  const bot = await boot()
  assert.ok(bot.features.loaded.includes('search'), JSON.stringify(bot.features.failed))
  const { conversation, ids } = await seedChat(bot)
  const call = (path) => bot.call('search', 'GET', path)
  const found = await call(`/v1/workspaces/${WS}/search/messages?q=周报&limit=1`)
  assert.equal(found.status, 200, JSON.stringify(found.body))
  assert.deepEqual(found.body.items.map((item) => item.message_id), [ids[0]])
  assert.equal(found.body.items[0].title, '周报助手')
  assert.equal(found.body.items[0].created, 1800000000)
  assert.equal(found.body.cursor, ids[0])
  const next = await call(`/v1/workspaces/${WS}/search/messages?q=周报&limit=1&cursor=${ids[0]}`)
  assert.deepEqual(next.body.items.map((item) => item.message_id), [ids[1]])
  assert.equal((await call(`/v1/workspaces/${WS}/search/messages?q=周报&conversation_id=${'f'.repeat(32)}`)).body.items.length, 0)
  assert.equal((await call(`/v1/workspaces/${WS}/search/messages?q=周报&kind=social`)).body.items.length, 0)
  assert.equal((await call(`/v1/workspaces/${WS}/search/messages?q=`)).status, 400)
  assert.equal((await call(`/v1/workspaces/${WS}/search/messages?q=x&bogus=1`)).status, 400)
  const links = await call(`/v1/workspaces/${WS}/search/resources?kind=links&q=`)
  assert.deepEqual(links.body.items.map((item) => item.href), ['https://example.com/report'])
  const files = await call(`/v1/workspaces/${WS}/search/resources?kind=files&q=x`)
  assert.equal(files.status, 200)
  const other = await boot()
  assert.equal((await other.call('search', 'GET', `/v1/workspaces/${WS}/search/messages?q=周报`)).body.items.length, 0)
  assert.ok(conversation)
})

test('imported agent conversation history is searchable with its source id', async () => {
  const bot = await boot()
  const agentId = hex(10), conversationId = hex(11), first = hex(12), second = hex(13)
  await seedAgentHistory(bot, { agentId, conversationId, name: '导入助手', messages: [
    { id: first, conversation_id: conversationId, role: 'user', body: '导入的季度总结 第一段', status: 'sent', created: 1800000000 },
    { id: second, conversation_id: conversationId, role: 'assistant', body: '导入的季度总结 第二段 https://example.com/imported', status: 'succeeded', created: 1800000001 },
    { id: hex(14), conversation_id: conversationId, role: 'user', body: '无关内容', status: 'sent', created: 1800000002 },
  ] })
  const call = (path) => bot.call('search', 'GET', path)
  const found = await call(`/v1/workspaces/${WS}/search/messages?q=季度总结&limit=1`)
  assert.equal(found.status, 200, JSON.stringify(found.body))
  assert.deepEqual(found.body.items.map((item) => [item.kind, item.message_id, item.conversation_id, item.title, item.created]),
    [['agent', first, conversationId, '导入助手', 1800000000]])
  assert.equal(found.body.cursor, first)
  const next = await call(`/v1/workspaces/${WS}/search/messages?q=季度总结&limit=1&cursor=${first}`)
  assert.deepEqual(next.body.items.map((item) => item.message_id), [second])
  const links = await call(`/v1/workspaces/${WS}/search/resources?kind=links&q=季度总结`)
  assert.deepEqual(links.body.items.map((item) => item.href), ['https://example.com/imported'])
  const hook = await bot.endpoint('agents/search', { workspace_id: WS, q: '季度总结', limit: 1 })
  assert.equal(hook.ok, true, JSON.stringify(hook))
  assert.deepEqual(hook.value.items.map((item) => item.id), [first])
  assert.equal(hook.value.cursor, first)
  const hookNext = await bot.endpoint('agents/search', { workspace_id: WS, q: '季度总结', limit: 1, cursor: first })
  assert.deepEqual(hookNext.value.items.map((item) => item.id), [second])
})

test('agent history search stays inside the requested workspace', async () => {
  const bot = await boot()
  const foreignWorkspace = 'b'.repeat(32), foreignConversation = hex(21), foreignMessage = hex(22)
  await seedAgentHistory(bot, { workspace: foreignWorkspace, name: '外部助手', agentId: hex(23), conversationId: foreignConversation, messages: [
    { id: foreignMessage, conversation_id: foreignConversation, role: 'user', body: '跨工作区机密', status: 'sent', created: 1800000000 },
  ] })
  const ownConversation = hex(24), ownMessage = hex(25)
  await seedAgentHistory(bot, { name: '本区助手', agentId: hex(26), conversationId: ownConversation, messages: [
    { id: ownMessage, conversation_id: ownConversation, role: 'user', body: '本工作区可见', status: 'sent', created: 1800000001 },
  ] })
  const call = (path) => bot.call('search', 'GET', path)
  assert.equal((await call(`/v1/workspaces/${WS}/search/messages?q=跨工作区机密`)).body.items.length, 0)
  assert.equal((await call(`/v1/workspaces/${WS}/search/messages?q=跨工作区机密&conversation_id=${foreignConversation}`)).body.items.length, 0)
  const own = await call(`/v1/workspaces/${WS}/search/messages?q=本工作区可见`)
  assert.deepEqual(own.body.items.map((item) => item.message_id), [ownMessage])
})

test('imported agent history respects the page bound and cursor', async () => {
  const bot = await boot()
  const conversationId = hex(30)
  const ids = [hex(40), hex(41), hex(42), hex(43), hex(44)]
  await seedAgentHistory(bot, { agentId: hex(31), conversationId, name: '分页助手', messages: ids.map((id, index) => ({
    id, conversation_id: conversationId, role: index % 2 ? 'assistant' : 'user', body: `分页检索 ${index}`,
    status: index % 2 ? 'succeeded' : 'sent', created: 1800000100 + index,
  })) })
  const call = (cursor = '') => bot.call('search', 'GET',
    `/v1/workspaces/${WS}/search/messages?q=分页检索&limit=2${cursor ? `&cursor=${cursor}` : ''}`)
  const firstPage = await call()
  assert.deepEqual(firstPage.body.items.map((item) => item.message_id), ids.slice(0, 2))
  assert.equal(firstPage.body.cursor, ids[1])
  const secondPage = await call(ids[1])
  assert.deepEqual(secondPage.body.items.map((item) => item.message_id), ids.slice(2, 4))
  assert.equal(secondPage.body.cursor, ids[3])
  const thirdPage = await call(ids[3])
  assert.deepEqual(thirdPage.body.items.map((item) => item.message_id), ids.slice(4))
  assert.equal(thirdPage.body.cursor, null)
  assert.equal((await bot.call('search', 'GET', `/v1/workspaces/${WS}/search/messages?q=分页检索&limit=51`)).status, 400)
})

test('message search keeps chat results when the agents feature is absent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ot-search-no-agents-'))
  const dir = join(root, 'features'), data = join(root, 'data')
  mkdirSync(data)
  const proxy = (name, source) => {
    mkdirSync(join(dir, name), { recursive: true })
    writeFileSync(join(dir, name, 'index.js'), `export { default } from ${JSON.stringify(pathToFileURL(source).href)}\n`)
  }
  proxy('search', fileURLToPath(new URL('../features/search/index.js', import.meta.url)))
  proxy('chat', fileURLToPath(new URL('../features/chat/index.js', import.meta.url)))
  const { table, loaded } = await loadFeatures({ dir, identity: { instanceId: 'd'.repeat(32) }, dataDir: data, log: () => {} })
  assert.ok(loaded.includes('search'))
  assert.ok(!loaded.includes('agents'))
  const conversation = await table['chat/create']({ title: '无智能体聊天' })
  const messageId = hex(50)
  const db = new DatabaseSync(join(data, 'openteamily', 'features', 'chat', 'chat.sqlite3'))
  db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)').run(messageId, conversation.id, 'user', '仍然可以搜索', 1800000000, '{}')
  db.close()
  const result = await table['search/v1']({ method: 'GET', path: `/v1/workspaces/${WS}/search/messages?q=仍然可以搜索` })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.deepEqual(result.body.items.map((item) => item.message_id), [messageId])
})

test('search/all spans memory and meetings in this DS-Bot', async () => {
  const bot = await boot()
  await bot.call('memory', 'POST', `/v1/workspaces/${WS}/memory`, { title: '季度目标', body: '增长 20%' }, key())
  await bot.call('meetings', 'POST', `/v1/workspaces/${WS}/meetings`, { title: '季度复盘', summary: '回顾目标' }, key())
  const all = await bot.endpoint('search/all', { q: '季度' })
  assert.equal(all.ok, true, JSON.stringify(all))
  assert.deepEqual(all.value.items.map((item) => item.kind).sort(), ['meeting', 'memory'])
  assert.equal((await bot.endpoint('search/all', { q: '' })).ok, false)
})
