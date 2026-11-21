import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { boot, WS } from './helpers.js'
import { ensureSchema } from '../features/saved-searches/index.js'

const A = '1'.repeat(32)
const B = '2'.repeat(32)
const OTHER_WS = 'b'.repeat(32)
const NOW = 1800000000

const file = (vol) => join(vol.data, 'openteamily', 'features', 'saved-searches', 'saved-searches.sqlite3')

async function ok(bot, op, payload) {
  const result = await bot.endpoint(`saved-searches/${op}`, payload)
  assert.equal(result.ok, true, `${op}: ${JSON.stringify(result)}`)
  return result.value
}

async function error(bot, op, payload) {
  const result = await bot.endpoint(`saved-searches/${op}`, payload)
  assert.equal(result.ok, false, `${op} unexpectedly succeeded: ${JSON.stringify(result)}`)
  return result.error
}

async function fails(bot, op, payload, code = 'saved-searches/invalid') {
  const failure = await error(bot, op, payload)
  assert.equal(failure.code, code, JSON.stringify(failure))
  return failure
}

const create = (bot, overrides = {}) => ok(bot, 'create', {
  workspace_id: WS, owner_id: A, name: 'Budget watch', scope: 'messages', query: 'budget', now: NOW, ...overrides,
})
const get = (bot, id, overrides = {}) => ok(bot, 'get', { workspace_id: WS, id, ...overrides })
const list = (bot, overrides = {}) => ok(bot, 'list', { workspace_id: WS, ...overrides })
const update = (bot, id, overrides = {}) => ok(bot, 'update', { workspace_id: WS, owner_id: A, id, now: NOW, ...overrides })
const remove = (bot, id, overrides = {}) => ok(bot, 'delete', { workspace_id: WS, owner_id: A, id, ...overrides })
const record = (bot, id, payload = {}) => ok(bot, 'recordCheck', { workspace_id: WS, id, now: NOW, matched: 0, ...payload })
const due = (bot, overrides = {}) => ok(bot, 'dueForAlert', { now: NOW, ...overrides })
const stats = (bot, overrides = {}) => ok(bot, 'stats', { workspace_id: WS, ...overrides })

test('saved-searches schema is idempotent and keeps its own SQLite file', async () => {
  const bot = await boot()
  assert.ok(bot.features.loaded.includes('saved-searches'), JSON.stringify(bot.features.failed))
  const db = new DatabaseSync(file(bot.vol))
  ensureSchema(db)
  ensureSchema(db)
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name)
  assert.ok(tables.includes('saved_searches'))
  assert.ok(tables.includes('saved_search_runs'))
  assert.deepEqual(db.prepare('PRAGMA table_info(saved_searches)').all().map((row) => row.name), [
    'id', 'workspace_id', 'owner_id', 'name', 'scope', 'query', 'filters', 'alerts',
    'interval_seconds', 'last_checked', 'last_alert', 'created', 'updated',
  ])
  assert.deepEqual(db.prepare('PRAGMA table_info(saved_search_runs)').all().map((row) => row.name),
    ['id', 'search_id', 'workspace_id', 'matched', 'summary', 'created'])
  const indexes = db.prepare('PRAGMA index_list(saved_searches)').all().map((row) => row.name)
  for (const name of ['saved_search_owner', 'saved_search_scope', 'saved_search_due']) assert.ok(indexes.includes(name), name)
  const runIndexes = db.prepare('PRAGMA index_list(saved_search_runs)').all().map((row) => row.name)
  for (const name of ['saved_search_run_search', 'saved_search_run_workspace']) assert.ok(runIndexes.includes(name), name)
  db.close()
  const again = await boot(bot.vol)
  assert.ok(again.features.loaded.includes('saved-searches'), JSON.stringify(again.features.failed))
})

test('create, get and list saved searches for one owner', async () => {
  const bot = await boot()
  const first = await create(bot, { name: 'First', scope: 'messages', query: 'alpha', filters: { kind: 'agent' }, alerts: true, interval_seconds: 120 })
  const second = await create(bot, { name: 'Second', scope: 'works', query: 'beta', now: NOW + 10 })
  assert.equal(first.name, 'First')
  assert.equal(first.workspace_id, WS)
  assert.equal(first.owner_id, A)
  assert.deepEqual(first.filters, { kind: 'agent' })
  assert.equal(first.alerts, true)
  assert.equal(first.interval_seconds, 120)
  assert.equal(first.last_checked, null)
  assert.equal(first.last_alert, null)
  assert.deepEqual(await get(bot, first.id), first)
  const page = await list(bot)
  assert.deepEqual(page.items.map((item) => item.name), ['Second', 'First'])
  assert.equal(page.cursor, null)
  assert.deepEqual((await list(bot, { scope: 'works' })).items, [second])
  assert.deepEqual((await list(bot, { owner_id: B })).items, [])
})

test('only the owner may update or delete a saved search', async () => {
  const bot = await boot()
  const search = await create(bot)
  assert.equal(await update(bot, search.id, { owner_id: B, name: 'Hijacked' }), null)
  assert.equal((await get(bot, search.id)).name, 'Budget watch')
  assert.deepEqual(await remove(bot, search.id, { owner_id: B }), { deleted: false })
  await fails(bot, 'get', { workspace_id: WS, id: search.id, owner_id: B }, 'saved-searches/not-found')
  assert.ok(await get(bot, search.id))

  const updated = await update(bot, search.id, {
    name: 'Renamed', scope: 'agents', query: 'new query', filters: { agent: 'x' }, alerts: true, interval_seconds: 3600,
  })
  assert.equal(updated.name, 'Renamed')
  assert.equal(updated.scope, 'agents')
  assert.equal(updated.query, 'new query')
  assert.deepEqual(updated.filters, { agent: 'x' })
  assert.equal(updated.alerts, true)
  assert.equal(updated.interval_seconds, 3600)
  const run = await record(bot, search.id, { matched: 1 })
  assert.equal(run.search_id, search.id)
  assert.deepEqual(await remove(bot, search.id), { deleted: true })
  await fails(bot, 'get', { workspace_id: WS, id: search.id }, 'saved-searches/not-found')
  assert.equal(await record(bot, search.id, { matched: 1 }), null)
  assert.deepEqual(await stats(bot), { searches: 0, alerts: 0, runs: 0 })
})

test('duplicate names are rejected per workspace and owner but allowed for another owner', async () => {
  const bot = await boot()
  await create(bot, { name: 'Same' })
  await fails(bot, 'create', { workspace_id: WS, owner_id: A, name: 'Same', scope: 'messages', query: 'x', now: NOW }, 'saved-searches/conflict')
  await fails(bot, 'create', { workspace_id: WS, owner_id: A, name: '  Same  ', scope: 'messages', query: 'x', now: NOW }, 'saved-searches/conflict')
  const other = await create(bot, { owner_id: B, name: 'Same' })
  assert.equal(other.owner_id, B)
  await create(bot, { owner_id: A, workspace_id: OTHER_WS, name: 'Same' })
  const target = await create(bot, { name: 'Other' })
  await fails(bot, 'update', { workspace_id: WS, owner_id: A, id: target.id, now: NOW, name: 'Same' }, 'saved-searches/conflict')
})

test('invalid scope, interval, name, query, alerts and filters are typed errors', async () => {
  const bot = await boot()
  for (const scope of ['all', 'message', '', null]) await fails(bot, 'create', { workspace_id: WS, owner_id: A, name: 'x', scope, query: 'x', now: NOW })
  for (const interval_seconds of [59, 30 * 86400 + 1, true, '60', 60.5, null]) {
    await fails(bot, 'create', { workspace_id: WS, owner_id: A, name: 'x', scope: 'messages', query: 'x', interval_seconds, now: NOW })
  }
  for (const name of ['', '   ', 'x'.repeat(81), 'bad\x00name']) {
    await fails(bot, 'create', { workspace_id: WS, owner_id: A, name, scope: 'messages', query: 'x', now: NOW })
  }
  for (const query of ['', '   ', 'x'.repeat(201), 'bad\x00query']) {
    await fails(bot, 'create', { workspace_id: WS, owner_id: A, name: 'x', scope: 'messages', query, now: NOW })
  }
  for (const alerts of ['yes', 1, 0, null]) {
    await fails(bot, 'create', { workspace_id: WS, owner_id: A, name: 'x', scope: 'messages', query: 'x', alerts, now: NOW })
  }
  const search = await create(bot)
  await fails(bot, 'update', { workspace_id: WS, owner_id: A, id: search.id, now: NOW, scope: 'all' })
  await fails(bot, 'update', { workspace_id: WS, owner_id: A, id: search.id, now: NOW, interval_seconds: 59 })
  await fails(bot, 'update', { workspace_id: WS, owner_id: A, id: search.id, now: NOW, alerts: 'yes' })
})

test('filters round-trip as bounded plain JSON and oversize values are refused', async () => {
  const bot = await boot()
  const filters = { kind: 'agent', tags: ['a', 'b'], nested: { count: 1 } }
  const search = await create(bot, { filters })
  assert.deepEqual(search.filters, filters)
  assert.deepEqual((await get(bot, search.id)).filters, filters)
  assert.deepEqual((await create(bot, { name: 'No filters' })).filters, {})
  assert.deepEqual((await update(bot, search.id, { filters: null })).filters, {})
  const oversize = { blob: 'x'.repeat(5000) }
  await fails(bot, 'create', { workspace_id: WS, owner_id: A, name: 'Big', scope: 'messages', query: 'x', now: NOW, filters: oversize })
  await fails(bot, 'create', { workspace_id: WS, owner_id: A, name: 'List', scope: 'messages', query: 'x', now: NOW, filters: ['not', 'an', 'object'] })
  await fails(bot, 'update', { workspace_id: WS, owner_id: A, id: search.id, now: NOW, filters: oversize })
  await fails(bot, 'recordCheck', { workspace_id: WS, id: search.id, now: NOW, matched: 1, summary: 'x'.repeat(501) })
})

test('dueForAlert respects alerts, last check and interval', async () => {
  const bot = await boot()
  const fast = await create(bot, { name: 'Fast', alerts: true, interval_seconds: 60 })
  await create(bot, { name: 'Off', alerts: false, interval_seconds: 60 })
  const slow = await create(bot, { name: 'Slow', alerts: true, interval_seconds: 3600 })
  assert.deepEqual(new Set((await due(bot)).items.map((item) => item.id)), new Set([fast.id, slow.id]))
  await record(bot, fast.id, { now: NOW, matched: 0 })
  await record(bot, slow.id, { now: NOW, matched: 0 })
  assert.deepEqual((await due(bot, { now: NOW + 59 })).items, [])
  assert.deepEqual((await due(bot, { now: NOW + 61 })).items.map((item) => item.id), [fast.id])
  assert.deepEqual(new Set((await due(bot, { now: NOW + 3601 })).items.map((item) => item.id)), new Set([fast.id, slow.id]))
  await create(bot, { name: 'Extra', alerts: true, interval_seconds: 60 })
  assert.equal((await due(bot, { now: NOW + 3602, limit: 1 })).items.length, 1)
  await fails(bot, 'dueForAlert', { now: NOW, limit: 0 })
  await fails(bot, 'dueForAlert', { now: NOW, limit: 201 })
})

test('recordCheck stores runs and only advances last_alert when matched is positive', async () => {
  const bot = await boot()
  const search = await create(bot, { alerts: true, interval_seconds: 60 })
  const run = await record(bot, search.id, { matched: 0, summary: 'nothing found' })
  assert.equal(run.search_id, search.id)
  assert.equal(run.workspace_id, WS)
  assert.equal(run.matched, 0)
  assert.equal(run.summary, 'nothing found')
  let current = await get(bot, search.id)
  assert.equal(current.last_checked, NOW)
  assert.equal(current.last_alert, null)
  await record(bot, search.id, { now: NOW + 10, matched: 3, summary: 'hits' })
  current = await get(bot, search.id)
  assert.equal(current.last_checked, NOW + 10)
  assert.equal(current.last_alert, NOW + 10)
  await record(bot, search.id, { now: NOW + 20, matched: 0 })
  current = await get(bot, search.id)
  assert.equal(current.last_checked, NOW + 20)
  assert.equal(current.last_alert, NOW + 10)
  const db = new DatabaseSync(file(bot.vol))
  const runs = db.prepare('SELECT * FROM saved_search_runs WHERE search_id=? ORDER BY created, id').all(search.id)
  db.close()
  assert.deepEqual(runs.map((row) => row.created), [NOW, NOW + 10, NOW + 20])
  assert.deepEqual(runs.map((row) => row.matched), [0, 3, 0])
  assert.equal(await record(bot, '0'.repeat(32), { matched: 1 }), null)
  for (const matched of [-1, 10000001, true, 1.5, '1']) await fails(bot, 'recordCheck', { workspace_id: WS, id: search.id, now: NOW, matched })
})

test('workspace and owner isolation covers get, list, update, delete and recordCheck', async () => {
  const bot = await boot()
  const alice = await create(bot, { owner_id: A })
  const bobSame = await create(bot, { owner_id: B, name: 'Bob same' })
  const bobOther = await create(bot, { owner_id: B, workspace_id: OTHER_WS, name: 'Bob other' })
  await fails(bot, 'get', { workspace_id: OTHER_WS, id: alice.id }, 'saved-searches/not-found')
  await fails(bot, 'get', { workspace_id: WS, id: alice.id, owner_id: B }, 'saved-searches/not-found')
  assert.deepEqual(new Set((await list(bot)).items.map((item) => item.id)), new Set([alice.id, bobSame.id]))
  assert.deepEqual((await list(bot, { owner_id: A })).items.map((item) => item.id), [alice.id])
  assert.deepEqual((await list(bot, { workspace_id: OTHER_WS })).items.map((item) => item.id), [bobOther.id])
  assert.deepEqual(await remove(bot, alice.id, { owner_id: B }), { deleted: false })
  assert.deepEqual(await remove(bot, alice.id, { workspace_id: OTHER_WS }), { deleted: false })
  assert.equal(await update(bot, alice.id, { workspace_id: OTHER_WS, name: 'Nope' }), null)
  assert.equal(await record(bot, alice.id, { workspace_id: OTHER_WS, matched: 1 }), null)
  assert.deepEqual(await stats(bot, { owner_id: B }), { searches: 1, alerts: 0, runs: 0 })
})

test('list paging is stable, newest-first and bounded', async () => {
  const bot = await boot()
  const created = []
  for (let index = 0; index < 5; index += 1) created.push(await create(bot, { name: `Page ${index}`, now: NOW + index }))
  const seen = []
  let cursor = null
  for (;;) {
    const page = await list(bot, { limit: 2, cursor })
    assert.ok(page.items.length <= 2)
    seen.push(...page.items.map((item) => item.id))
    cursor = page.cursor
    if (cursor === null) break
  }
  assert.deepEqual(seen, [...created].reverse().map((item) => item.id))
  assert.equal(new Set(seen).size, 5)
  for (const limit of [0, 101]) await fails(bot, 'list', { workspace_id: WS, limit })
  await fails(bot, 'list', { workspace_id: WS, scope: 'all' })
})

test('stats counts this workspace, owner and current due searches', async () => {
  const bot = await boot()
  const first = await create(bot, { name: 'First', alerts: true })
  await create(bot, { name: 'Second' })
  await record(bot, first.id, { matched: 2, summary: 'two' })
  assert.deepEqual(await stats(bot, { owner_id: A }), { searches: 2, alerts: 1, runs: 1 })
  assert.deepEqual(await stats(bot, { owner_id: A, now: NOW }), { searches: 2, alerts: 1, runs: 1, due: 0 })
  assert.deepEqual(await stats(bot, { owner_id: B }), { searches: 0, alerts: 0, runs: 0 })
})
