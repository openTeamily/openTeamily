import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { boot, WS } from './helpers.js'
import { createRetention, ensureSchema, LIMITS, MAX_TTL_SECONDS } from '../features/retention/index.js'

const OTHER = 'b'.repeat(32)
const NOW = 2_000_000_000
const file = (vol) => join(vol.data, 'openteamily', 'features', 'retention', 'retention.sqlite3')

async function ok(bot, op, payload) {
  const result = await bot.endpoint(`retention/${op}`, payload)
  assert.equal(result.ok, true, `${op}: ${JSON.stringify(result)}`)
  return result.value
}

async function fails(bot, op, payload, code = 'retention/invalid') {
  const result = await bot.endpoint(`retention/${op}`, payload)
  assert.equal(result.ok, false, `${op} unexpectedly succeeded: ${JSON.stringify(result)}`)
  assert.equal(result.error.code, code, JSON.stringify(result.error))
  return result.error
}

const set = (bot, data_class, ttl_seconds, overrides = {}) => ok(bot, 'setPolicy', {
  workspace_id: WS, data_class, ttl_seconds, now: NOW, ...overrides,
})
const get = (bot, data_class, workspace_id = WS) => ok(bot, 'getPolicy', { workspace_id, data_class })
const list = (bot, workspace_id = WS) => ok(bot, 'listPolicies', { workspace_id })
const remove = (bot, data_class, workspace_id = WS) => ok(bot, 'deletePolicy', { workspace_id, data_class })
const plan = (bot, rows, overrides = {}) => ok(bot, 'plan', { workspace_id: WS, rows, now: NOW, ...overrides })
const record = (bot, planned, overrides = {}) => ok(bot, 'recordRun', {
  workspace_id: WS, plan: planned, deleted: 0, failed: 0, now: NOW + 1, ...overrides,
})
const stats = (bot, workspace_id = WS) => ok(bot, 'stats', { workspace_id })

function memory() {
  const db = new DatabaseSync(':memory:')
  const feature = createRetention({ db, clock: () => NOW })
  return { db, e: feature.endpoints }
}

test('retention schema is idempotent, indexed and lives in its own SQLite file', async () => {
  const bot = await boot()
  assert.ok(bot.features.loaded.includes('retention'), JSON.stringify(bot.features.failed))
  assert.ok(existsSync(file(bot.vol)))
  const db = new DatabaseSync(file(bot.vol))
  ensureSchema(db)
  ensureSchema(db)
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name)
  assert.ok(tables.includes('retention_policies'))
  assert.ok(tables.includes('retention_runs'))
  assert.deepEqual(db.prepare('PRAGMA table_info(retention_policies)').all().map((row) => row.name), [
    'workspace_id', 'data_class', 'ttl_seconds', 'enabled', 'legal_hold', 'created', 'updated',
  ])
  assert.deepEqual(db.prepare('PRAGMA table_info(retention_runs)').all().map((row) => row.name), [
    'id', 'workspace_id', 'summary', 'deleted', 'failed', 'created',
  ])
  const policyIndexes = db.prepare('PRAGMA index_list(retention_policies)').all().map((row) => row.name)
  assert.ok(policyIndexes.includes('retention_policy_workspace'))
  const runIndexes = db.prepare('PRAGMA index_list(retention_runs)').all().map((row) => row.name)
  assert.ok(runIndexes.includes('retention_run_workspace'))
  db.close()
  const again = await boot(bot.vol)
  assert.ok(again.features.loaded.includes('retention'), JSON.stringify(again.features.failed))
})

test('set, get, list, update and delete one workspace policy', async () => {
  const bot = await boot()
  const created = await set(bot, 'messages', 100)
  assert.deepEqual(created, {
    workspace_id: WS, data_class: 'messages', ttl_seconds: 100, enabled: true,
    legal_hold: false, created: NOW, updated: NOW,
  })
  assert.deepEqual(await get(bot, 'messages'), created)

  const updated = await set(bot, 'messages', 200, { now: NOW + 5, enabled: false, legal_hold: true })
  assert.equal(updated.ttl_seconds, 200)
  assert.equal(updated.enabled, false)
  assert.equal(updated.legal_hold, true)
  assert.equal(updated.created, NOW)
  assert.equal(updated.updated, NOW + 5)

  await set(bot, 'artifacts', 50)
  const listed = await list(bot)
  assert.deepEqual(listed.map((item) => item.data_class), ['artifacts', 'messages'])

  assert.equal(await remove(bot, 'messages'), true)
  assert.equal(await get(bot, 'messages'), null)
  assert.deepEqual((await list(bot)).map((item) => item.data_class), ['artifacts'])
  assert.equal(await remove(bot, 'messages'), false)
})

test('a row exactly at the TTL cutoff is kept and one second past it is deleted', async () => {
  const bot = await boot()
  await set(bot, 'messages', 100)
  const planned = await plan(bot, [
    { id: 'c', data_class: 'messages', created: NOW - 101 },
    { id: 'b', data_class: 'messages', created: NOW - 99 },
    { id: 'a', data_class: 'messages', created: NOW - 100 },
  ])
  assert.deepEqual(planned.delete, ['c'])
  assert.deepEqual(planned.keep, [
    { id: 'a', reason: 'not_due' },
    { id: 'b', reason: 'not_due' },
  ])
  assert.deepEqual(planned.unknown_policy, [])
  assert.deepEqual(planned.legal_hold, [])
})

test('disabled policies and legal holds keep rows instead of deleting them', async () => {
  const bot = await boot()
  await set(bot, 'messages', 1, { enabled: false })
  const disabled = await plan(bot, [{ id: 'old', data_class: 'messages', created: NOW - 50 }])
  assert.deepEqual(disabled.delete, [])
  assert.deepEqual(disabled.keep, [{ id: 'old', reason: 'disabled' }])

  await set(bot, 'media', 1, { legal_hold: true })
  const held = await plan(bot, [
    { id: 'b', data_class: 'media', created: NOW - 90 },
    { id: 'a', data_class: 'media', created: NOW - 50 },
  ])
  assert.deepEqual(held.delete, [])
  assert.deepEqual(held.keep, [])
  assert.deepEqual(held.legal_hold, ['a', 'b'])
})

test('a row legal hold wins even for an unknown class', async () => {
  const bot = await boot()
  await set(bot, 'messages', 1)
  const planned = await plan(bot, [
    { id: 'held', data_class: 'messages', created: NOW - 50, legal_hold: true },
    { id: 'free', data_class: 'messages', created: NOW - 50 },
    { id: 'held-unknown', data_class: 'archives', created: NOW - 50, legal_hold: true },
  ])
  assert.deepEqual(planned.delete, ['free'])
  assert.deepEqual(planned.legal_hold, ['held', 'held-unknown'])
  assert.deepEqual(planned.unknown_policy, [])
})

test('unknown classes are reported and never deleted', async () => {
  const bot = await boot()
  await set(bot, 'messages', 1)
  const planned = await plan(bot, [
    { id: 'z', data_class: 'archives', created: NOW - 50 },
    { id: 'a', data_class: 'logs', created: NOW - 50 },
    { id: 'live', data_class: 'messages', created: NOW - 50 },
  ])
  assert.deepEqual(planned.delete, ['live'])
  assert.deepEqual(planned.unknown_policy, ['a', 'z'])
  assert.deepEqual(planned.keep, [])
  assert.deepEqual(planned.legal_hold, [])
})

test('plan ordering is deterministic across every bucket', async () => {
  const bot = await boot()
  await set(bot, 'messages', 10)
  await set(bot, 'logs', 10, { enabled: false })
  await set(bot, 'media', 10, { legal_hold: true })
  const planned = await plan(bot, [
    { id: 'z', data_class: 'messages', created: NOW - 20 },
    { id: 'm', data_class: 'logs', created: NOW - 20 },
    { id: 'y', data_class: 'other', created: NOW - 20 },
    { id: 'x', data_class: 'media', created: NOW - 20 },
    { id: 'a', data_class: 'messages', created: NOW - 20 },
    { id: 'b', data_class: 'logs', created: NOW - 20 },
    { id: 'c', data_class: 'other', created: NOW - 20 },
    { id: 'd', data_class: 'media', created: NOW - 20 },
    { id: 'w', data_class: 'messages', created: NOW - 20, legal_hold: true },
  ])
  assert.deepEqual(planned.delete, ['a', 'z'])
  assert.deepEqual(planned.keep, [{ id: 'b', reason: 'disabled' }, { id: 'm', reason: 'disabled' }])
  assert.deepEqual(planned.unknown_policy, ['c', 'y'])
  assert.deepEqual(planned.legal_hold, ['d', 'w', 'x'])
})

test('execute records the plan without deleting rows; recordRun stores the caller outcome', async () => {
  const bot = await boot()
  await set(bot, 'messages', 10)
  const planned = await plan(bot, [
    { id: 'keep', data_class: 'messages', created: NOW - 5 },
    { id: 'ok1', data_class: 'messages', created: NOW - 20 },
    { id: 'bad', data_class: 'messages', created: NOW - 30 },
    { id: 'ok2', data_class: 'messages', created: NOW - 40 },
    { id: 'held', data_class: 'messages', created: NOW - 50, legal_hold: true },
    { id: 'unknown', data_class: 'archives', created: NOW - 60 },
  ])
  assert.deepEqual(planned.delete, ['bad', 'ok1', 'ok2'])

  const executed = await ok(bot, 'execute', { workspace_id: WS, plan: planned, now: NOW })
  assert.deepEqual(executed, planned)
  assert.equal((await stats(bot)).last_run, null)

  const recorded = await record(bot, planned, { deleted: 2, failed: 1 })
  assert.equal(recorded.workspace_id, WS)
  assert.deepEqual(recorded.summary, { messages: 3 })
  assert.equal(recorded.deleted, 2)
  assert.equal(recorded.failed, 1)
  assert.equal(recorded.created, NOW + 1)

  const current = await stats(bot)
  assert.deepEqual(current.policies.map((item) => item.data_class), ['messages'])
  assert.deepEqual(current.last_run, recorded)

  const db = new DatabaseSync(file(bot.vol))
  const raw = db.prepare('SELECT id, workspace_id, summary, deleted, failed, created FROM retention_runs WHERE workspace_id=?').get(WS)
  db.close()
  assert.equal(raw.id, recorded.id)
  assert.equal(raw.summary, '{"messages":3}')
  assert.equal(raw.deleted, 2)
  assert.equal(raw.failed, 1)
})

test('execute may record supplied outcomes and rejects an invalid plan before any run', async () => {
  const bot = await boot()
  await set(bot, 'messages', 10)
  const planned = await plan(bot, [{ id: 'a', data_class: 'messages', created: NOW - 20 }])
  const recorded = await ok(bot, 'execute', {
    workspace_id: WS, plan: planned, deleted: 1, failed: 0, now: NOW + 2,
  })
  assert.deepEqual(recorded.summary, { messages: 1 })
  assert.equal((await stats(bot)).last_run.created, NOW + 2)

  await fails(bot, 'execute', { workspace_id: WS, plan: { delete: ['x'.repeat(LIMITS.ID + 1)] }, now: NOW })
  await fails(bot, 'execute', { workspace_id: WS, plan: { delete: 'not-a-list' }, now: NOW })
  await fails(bot, 'plan', { workspace_id: WS, rows: 'not-a-list', now: NOW })
  const before = (await stats(bot)).last_run
  assert.equal(before.created, NOW + 2)
})

test('workspace isolation covers policies, plans, runs and stats', async () => {
  const bot = await boot()
  const rows = [{ id: 'old', data_class: 'messages', created: NOW - 50 }]
  await set(bot, 'messages', 10)
  await set(bot, 'messages', 1000, { workspace_id: OTHER })
  assert.equal((await get(bot, 'messages')).ttl_seconds, 10)
  assert.equal((await get(bot, 'messages', OTHER)).ttl_seconds, 1000)
  assert.deepEqual((await list(bot)).map((item) => item.workspace_id), [WS])
  assert.deepEqual((await plan(bot, rows)).delete, ['old'])
  assert.deepEqual((await plan(bot, rows, { workspace_id: OTHER })).delete, [])

  const planned = await plan(bot, rows)
  await record(bot, planned, { deleted: 1 })
  assert.ok((await stats(bot)).last_run)
  assert.equal((await stats(bot, OTHER)).last_run, null)

  assert.equal(await remove(bot, 'messages'), true)
  assert.equal(await get(bot, 'messages'), null)
  assert.ok(await get(bot, 'messages', OTHER))
})

test('data classes, TTL bounds, flags and timestamps are validated', async () => {
  const bot = await boot()
  for (const data_class of ['', 'Messages', 'two words', 'a.b', 'a'.repeat(65), 'bad\nclass', null, 123]) {
    await fails(bot, 'setPolicy', { workspace_id: WS, data_class, ttl_seconds: 100, now: NOW })
  }
  for (const ttl_seconds of [0, -1, true, 1.5, '60', null, MAX_TTL_SECONDS + 1]) {
    await fails(bot, 'setPolicy', { workspace_id: WS, data_class: 'messages', ttl_seconds, now: NOW })
  }
  await fails(bot, 'getPolicy', { workspace_id: WS, data_class: 'Bad' })
  await fails(bot, 'deletePolicy', { workspace_id: WS, data_class: '' })
  await fails(bot, 'plan', {
    workspace_id: WS,
    rows: [{ id: 'a', data_class: 'Bad', created: NOW }],
    now: NOW,
  })
  await fails(bot, 'setPolicy', { workspace_id: WS, data_class: 'messages', ttl_seconds: 100, now: NOW, enabled: 'yes' })
  await fails(bot, 'setPolicy', { workspace_id: WS, data_class: 'messages', ttl_seconds: 100, now: NOW, legal_hold: 2 })
  await fails(bot, 'setPolicy', { workspace_id: WS, data_class: 'messages', ttl_seconds: 100, now: 1.5 })
  assert.deepEqual(await list(bot), [])
})

test('oversize ids, rows and plan deletes are rejected before recording anything', async () => {
  const { db, e } = memory()
  e.setPolicy({ workspace_id: WS, data_class: 'messages', ttl_seconds: 1, now: NOW })
  const tooLong = 'x'.repeat(LIMITS.ID + 1)
  for (const bad of [tooLong, '', null, 5, 'a\u0000b', 'a\nb', ' padded ']) {
    assert.throws(() => e.plan({
      workspace_id: WS, rows: [{ id: bad, data_class: 'messages', created: NOW - 10 }], now: NOW,
    }), (error) => error.code === 'retention/invalid')
    assert.throws(() => e.execute({
      workspace_id: WS, plan: { delete: [bad] }, now: NOW,
    }), (error) => error.code === 'retention/invalid')
  }
  const rows = Array.from({ length: LIMITS.ROWS + 1 }, (_, index) => ({
    id: `id-${index}`, data_class: 'messages', created: NOW - 10,
  }))
  assert.throws(() => e.plan({ workspace_id: WS, rows, now: NOW }), (error) => error.code === 'retention/too-large')
  assert.throws(() => e.execute({
    workspace_id: WS, plan: { delete: rows.map((row) => row.id) }, now: NOW,
  }), (error) => error.code === 'retention/too-large')
  assert.equal(e.stats({ workspace_id: WS }).last_run, null)
  db.close()
})

test('policies may be disabled and legally held with 0/1 flags like the legacy module', async () => {
  const bot = await boot()
  const policy = await set(bot, 'messages', 1, { enabled: 0, legal_hold: 1 })
  assert.equal(policy.enabled, false)
  assert.equal(policy.legal_hold, true)
  const planned = await plan(bot, [
    { id: 'a', data_class: 'messages', created: NOW - 50, legal_hold: 0 },
  ])
  assert.deepEqual(planned.delete, [])
  assert.deepEqual(planned.legal_hold, ['a'])
})
