import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { boot, key, WS } from './helpers.js'
import { setSharedBotSocial } from '../lib/c/bot-social.js'

// The search path should read the native agent ledger without starting a model turn.
function seedChat(bot, workspace = WS, prefix = 'a') {
  const agent = (prefix + 'e').repeat(16)
  const conversation = (prefix + 'f').repeat(16)
  const db = new DatabaseSync(join(bot.vol.data, 'openteamily', 'features', 'agents', 'agents.sqlite3'))
  const ids = ['1','2','3'].map(index => (prefix + index).repeat(16))
  try {
    db.prepare(`INSERT INTO agents (id, workspace_id, name, name_hash, summary, instructions, revision, created,
      updated, key_hash, request_hash) VALUES (?, ?, '周报助手', ?, '', '', 1, 1, 1, ?, ?)`).run(agent, workspace, agent, agent, agent)
    db.prepare('INSERT INTO agent_conversations VALUES (?,?,?,?,?)').run(conversation, agent, '周报助手', 1, 1)
    const insert = db.prepare(`INSERT INTO agent_messages (id, conversation_id, role, text, status, created)
      VALUES (?, ?, ?, ?, 'succeeded', ?)`)
    for (const [i, text] of ['帮我写周报', '好的，周报草稿见 https://example.com/report。', '谢谢'].entries()) {
      insert.run(ids[i], conversation, i % 2 ? 'assistant' : 'user', text, 1800000000 + i)
    }
  } finally {
    db.close()
  }
  return { agent, conversation, ids }
}

test('the session directory lists only the selected workspace conversations without a native runtime', async () => {
  const bot = await boot()
  const local = seedChat(bot)
  const other = seedChat(bot, 'b'.repeat(32), 'b')
  const result = await bot.endpoint('agents/conversationSummaries', {
    workspace_id: WS, agent_ids: [local.agent, other.agent, local.agent],
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(result.value.items, [{id:local.conversation, agent_id:local.agent, title:'周报助手', updated:1}])
})

test('message search runs in DS-Bot over this owner\'s own conversations', async () => {
  const bot = await boot()
  assert.ok(bot.features.loaded.includes('search'), JSON.stringify(bot.features.failed))
  const { agent, conversation, ids } = seedChat(bot)
  seedChat(bot, 'b'.repeat(32), 'b')
  const call = (path) => bot.call('search', 'GET', path)
  const found = await call(`/v1/workspaces/${WS}/search/messages?q=周报&kind=agent&limit=1`)
  assert.equal(found.status, 200, JSON.stringify(found.body))
  assert.deepEqual(found.body.items.map((item) => item.message_id), [ids[0]])
  assert.equal(found.body.items[0].agent_id, agent)
  assert.equal(found.body.items[0].title, '周报助手')
  assert.equal(found.body.items[0].created, 1800000000)
  assert.equal(found.body.cursor, ids[0])
  const next = await call(`/v1/workspaces/${WS}/search/messages?q=周报&limit=1&cursor=${ids[0]}`)
  assert.deepEqual(next.body.items.map((item) => item.message_id), [ids[1]])
  assert.deepEqual((await call(`/v1/workspaces/${WS}/search/messages?q=周报&conversation_id=${conversation}`))
    .body.items.map(item => item.message_id), ids.slice(0, 2))
  assert.equal((await call(`/v1/workspaces/${WS}/search/messages?q=周报&conversation_id=${'f'.repeat(32)}`)).body.items.length, 0)
  assert.equal((await call(`/v1/workspaces/${WS}/search/messages?q=`)).status, 400)
  assert.equal((await call(`/v1/workspaces/${WS}/search/messages?q=x&bogus=1`)).status, 400)
  const links = await call(`/v1/workspaces/${WS}/search/resources?kind=links&q=`)
  assert.deepEqual(links.body.items.map((item) => item.href), ['https://example.com/report'])
  const files = await call(`/v1/workspaces/${WS}/search/resources?kind=files&q=x`)
  assert.equal(files.status, 200)
  const other = await boot()
  assert.equal((await other.call('search', 'GET', `/v1/workspaces/${WS}/search/messages?q=周报&kind=agent`)).body.items.length, 0)
})

test('global search merges private history and Bot Social results without skipping a source', async (t) => {
  const bot = await boot()
  const { ids } = seedChat(bot)
  seedChat(bot, 'b'.repeat(32), 'b')
  const shared = [1800000002000, 1800000001000, 1800000000500].map((created_ms, index) => ({
    cursor: created_ms + ':' + (100 - index),
    conversation_id: 'group', title: '讨论组', message_id: 'shared-' + index, body: '讨论周报', created_ms,
  }))
  const requested = []
  let unavailable = false
  setSharedBotSocial({async request(method, raw) {
    assert.equal(method, 'GET')
    const url = new URL(raw, 'http://bot-social.test')
    assert.equal(url.pathname, `/v1/ot/workspaces/${WS}/messages/search`)
    assert.equal(url.searchParams.get('q'), '周报')
    if (unavailable) throw new Error('disconnected')
    const before = url.searchParams.get('before')
    requested.push(before)
    const from = before === null ? 0 : shared.findIndex(row => row.cursor === before) + 1
    return {items: shared.slice(from, from + Number(url.searchParams.get('limit')))}
  }})
  t.after(() => setSharedBotSocial(undefined))
  const call = (suffix = '') => bot.call('search', 'GET', `/v1/workspaces/${WS}/search/messages?q=周报&limit=2${suffix}`)
  const first = await call()
  assert.deepEqual(first.body.items.map(item => item.message_id), [shared[0].message_id, ids[1]])
  const second = await call('&cursor=' + first.body.cursor)
  assert.deepEqual(second.body.items.map(item => item.message_id), [shared[1].message_id, shared[2].message_id])
  const last = await call('&cursor=' + second.body.cursor)
  assert.deepEqual(last.body.items.map(item => item.message_id), [ids[0]])
  assert.equal(last.body.cursor, null)
  assert.deepEqual(requested, [null, shared[0].cursor, shared[2].cursor])
  assert.equal((await call('&cursor=s1.e30')).status, 400)
  unavailable = true
  const partial = await call()
  assert.deepEqual(partial.body.items.map(item => item.message_id), [ids[1], ids[0]])
  assert.ok(partial.body.warning)
  assert.equal((await call('&kind=social')).status, 503)
})

test('saving an authorized chat message creates one private versioned document with provenance', async (t) => {
  const bot = await boot()
  const local = seedChat(bot)
  const foreign = seedChat(bot, 'b'.repeat(32), 'b')
  const saveAgent = `/v1/workspaces/${WS}/agents/${local.agent}/conversations/${local.conversation}/messages/`
  assert.equal((await bot.call('agents', 'POST', saveAgent + foreign.ids[1] + '/artifact', {})).status, 404)
  const first = await bot.call('agents', 'POST', saveAgent + local.ids[1] + '/artifact', {title: 'Private note'})
  assert.equal(first.status, 201, JSON.stringify(first.body))
  const privateArtifact = first.body.artifact
  assert.equal(privateArtifact.body, '好的，周报草稿见 https://example.com/report。')
  assert.equal(privateArtifact.source.agent_id, local.agent)
  assert.equal(privateArtifact.source.conversation_id, local.conversation)
  const snapshot = await bot.call('artifacts', 'GET', `/v1/workspaces/${WS}/artifacts/${privateArtifact.id}/versions/1`)
  assert.equal(snapshot.body.version.body, privateArtifact.body)
  const duplicate = await bot.call('agents', 'POST', saveAgent + local.ids[1] + '/artifact', {title: 'Renamed retry'})
  assert.equal(duplicate.status, 200)
  assert.equal(duplicate.body.artifact.id, privateArtifact.id)
  assert.equal(duplicate.body.artifact.title, 'Private note')

  const sharedId = 'otm_history_1', oldId = 'otm_old_copy', sharedConversation = 'otc_product'
  let revision = 2
  let text = 'Historical shared message'
  const old = await bot.endpoint('artifacts/create', {workspace_id: WS, kind: 'document',
    title: 'Existing copy title', body: 'Older saved text', idempotency_key: 'msg-save-' + oldId})
  assert.equal(old.ok, true)
  setSharedBotSocial({async request(method, path) {
    assert.equal(method, 'GET')
    if (path.endsWith('/' + oldId)) return {body: 'Older saved text', revision: 1, title: 'Product team'}
    assert.equal(path, `/v1/ot/workspaces/${WS}/conversations/${sharedConversation}/messages/${sharedId}`)
    return {body: text, revision, title: 'Product team'}
  }})
  t.after(() => setSharedBotSocial(undefined))
  const saveShared = `/v1/workspaces/${WS}/social/conversations/${sharedConversation}/messages/${sharedId}/save`
  const save = (title, revision) => bot.call('messenger', 'POST', saveShared, {title, revision})
  assert.equal((await save('Shared note', 1)).status, 409)
  const shared = await save('Shared note', 2)
  assert.equal(shared.status, 201, JSON.stringify(shared.body))
  assert.deepEqual(shared.body.artifact.source, {
    kind: 'agent_message', id: sharedId, conversation_id: sharedConversation, conversation_title: 'Product team',
  })
  revision += 1
  text = 'Edited shared message'
  const again = await save('Edited title', revision)
  assert.equal(again.status, 200)
  assert.equal(again.body.artifact.id, shared.body.artifact.id)
  assert.equal(again.body.artifact.body, 'Historical shared message')
  const reused = await bot.call('messenger', 'POST', saveShared.replace(sharedId, oldId), {
    title: 'Different title after upgrade', revision: 1,
  })
  assert.equal(reused.status, 200)
  assert.equal(reused.body.artifact.id, old.value.artifact.id)
  assert.equal(reused.body.artifact.source.id, oldId)
  const other = await boot()
  const docs = `/v1/workspaces/${WS}/artifacts`
  assert.equal((await bot.call('artifacts', 'GET', docs)).body.items.length, 3)
  assert.equal((await other.call('artifacts', 'GET', docs + '/' + privateArtifact.id)).status, 404)
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
