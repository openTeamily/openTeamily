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

test('search/all spans memory and meetings in this DS-Bot', async () => {
  const bot = await boot()
  await bot.call('memory', 'POST', `/v1/workspaces/${WS}/memory`, { title: '季度目标', body: '增长 20%' }, key())
  await bot.call('meetings', 'POST', `/v1/workspaces/${WS}/meetings`, { title: '季度复盘', summary: '回顾目标' }, key())
  const all = await bot.endpoint('search/all', { q: '季度' })
  assert.equal(all.ok, true, JSON.stringify(all))
  assert.deepEqual(all.value.items.map((item) => item.kind).sort(), ['meeting', 'memory'])
  assert.equal((await bot.endpoint('search/all', { q: '' })).ok, false)
})
