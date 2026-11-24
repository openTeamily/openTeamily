// Digest feature: per-user preferences, due selection, plain-text assembly and
// run receipts, all inside this DS-Bot's own feature database. The module never
// sends a digest and never calls a model: `channel` is a stored label only.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { setSharedBotSocial } from '../lib/c/bot-social.js'
import { ownerId } from '../featurekit/v1.js'
import { boot } from './helpers.js'

const WS = 'a'.repeat(32)
const OTHER = 'b'.repeat(32)
const STRANGER = 'd'.repeat(32)
const OWNER = ownerId()
const FOREIGN = OWNER === 'b'.repeat(32) ? 'c'.repeat(32) : 'b'.repeat(32)
const MAX_ITEMS = 50
const MAX_BODY = 10000
const MAX_TITLE_INPUT = 1000
const MAX_ITEM_BODY_INPUT = 10000
const MAX_INPUT_ITEMS = 500
// UTC epoch seconds, the only clock these endpoints compare against.
const at = (year, month, day, hour = 0, minute = 0) => Math.floor(Date.UTC(year, month - 1, day, hour, minute) / 1000)
const NOW = at(2026, 11, 20, 8)

function network(workspaces = [WS, OTHER]) {
  return {
    async request(method, path) {
      if (method === 'GET' && path === '/v1/ot/workspaces') {
        return { workspaces: workspaces.map(id => ({ workspace_id: id, name: id.slice(0, 4) })) }
      }
      throw new Error(`Unexpected Bot Social ${method} ${path}`)
    },
  }
}

async function bot(t, workspaces) {
  setSharedBotSocial(network(workspaces))
  t.after(() => setSharedBotSocial(undefined))
  return boot()
}

async function ok(target, endpoint, payload) {
  const reply = await target.endpoint(endpoint, payload)
  assert.equal(reply.ok, true, `${endpoint} failed: ${JSON.stringify(reply.error)}`)
  return reply.value
}

async function code(target, endpoint, payload) {
  const reply = await target.endpoint(endpoint, payload)
  assert.equal(reply.ok, false, `${endpoint} should have been refused, got ${JSON.stringify(reply.value)}`)
  return reply.error.code
}

const prefBody = (changes = {}) => ({ workspace_id: WS, cadence: 'daily', hour_utc: 9, now: NOW, ...changes })

test('digest opens its own database next to the DS-Bot volume and creates both tables once', async t => {
  const app = await bot(t)
  await ok(app, 'digest/get', { workspace_id: WS })
  assert.ok(app.features.loaded.includes('digest'), JSON.stringify(app.features.failed))
  const file = join(app.vol.data, 'openteamily', 'features', 'digest', 'digest.sqlite3')
  assert.ok(existsSync(file), 'digest.sqlite3 is missing')
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(file, { readOnly: true })
  t.after(() => db.close())
  const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name)
  assert.deepEqual(columns('digest_prefs'),
    ['workspace_id', 'user_id', 'enabled', 'cadence', 'hour_utc', 'channel', 'updated'])
  assert.deepEqual(columns('digest_runs'),
    ['id', 'workspace_id', 'user_id', 'period_key', 'item_count', 'body', 'created'])
  await ok(app, 'digest/set', prefBody())
  await ok(app, 'digest/set', prefBody())
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM digest_prefs').get().n, 1)
})

test('get is empty before a preference exists and then returns exactly what set stored', async t => {
  const app = await bot(t)
  assert.deepEqual(await ok(app, 'digest/get', { workspace_id: WS }), { pref: null })
  const saved = (await ok(app, 'digest/set', prefBody())).pref
  assert.equal(saved.workspace_id, WS)
  assert.equal(saved.user_id, OWNER, 'a digest preference belongs to this DS-Bot owner')
  assert.equal(saved.cadence, 'daily')
  assert.equal(saved.hour_utc, 9)
  assert.equal(saved.channel, 'digest')
  assert.equal(saved.enabled, true)
  assert.equal(saved.updated, NOW)
  assert.deepEqual((await ok(app, 'digest/get', { workspace_id: WS })).pref, saved)

  const updated = (await ok(app, 'digest/set',
    prefBody({ cadence: 'weekly', hour_utc: 18, channel: 'email', enabled: false, now: NOW + 5 }))).pref
  assert.equal(updated.cadence, 'weekly')
  assert.equal(updated.hour_utc, 18)
  assert.equal(updated.channel, 'email')
  assert.equal(updated.enabled, false)
  assert.equal(updated.updated, NOW + 5)
  assert.deepEqual((await ok(app, 'digest/get', { workspace_id: WS })).pref, updated)
  assert.deepEqual(await ok(app, 'digest/get', { workspace_id: OTHER }), { pref: null })
})

test('cadence, hour, channel and enabled outside their allowed values are refused and store nothing', async t => {
  const app = await bot(t)
  for (const cadence of ['hourly', 'monthly', '', 'DAILY']) {
    assert.equal(await code(app, 'digest/set', prefBody({ cadence })), 'digest/invalid', cadence)
  }
  for (const hour_utc of [-1, 24, 9.5, '9', true]) {
    assert.equal(await code(app, 'digest/set', prefBody({ hour_utc })), 'digest/invalid', String(hour_utc))
  }
  for (const channel of ['', 'x'.repeat(65)]) {
    assert.equal(await code(app, 'digest/set', prefBody({ channel })), 'digest/invalid', JSON.stringify(channel))
  }
  for (const enabled of ['yes', 1]) {
    assert.equal(await code(app, 'digest/set', prefBody({ enabled })), 'digest/invalid', String(enabled))
  }
  for (const now of [undefined, NOW + 0.5, String(NOW)]) {
    assert.equal(await code(app, 'digest/set', prefBody({ now })), 'digest/invalid', String(now))
  }
  assert.deepEqual(await ok(app, 'digest/get', { workspace_id: WS }), { pref: null })
})

test('due turns a preference ready at its UTC hour exactly once per period', async t => {
  const app = await bot(t)
  await ok(app, 'digest/set', prefBody())
  assert.deepEqual((await ok(app, 'digest/due', { now: at(2026, 11, 20, 8, 59) })).items, [])
  const due = (await ok(app, 'digest/due', { now: at(2026, 11, 20, 9, 0) })).items
  assert.equal(due.length, 1)
  assert.equal(due[0].workspace_id, WS)
  assert.equal(due[0].user_id, OWNER)
  assert.equal(due[0].period_key, '2026-11-20')
  const run = await ok(app, 'digest/run', {
    workspace_id: WS, now: at(2026, 11, 20, 9, 1),
    items: [{ kind: 'notification', title: 'Unread', created: 1 }],
  })
  assert.equal(run.created, true)
  assert.deepEqual((await ok(app, 'digest/due', { now: at(2026, 11, 20, 23, 59) })).items, [])
  assert.deepEqual((await ok(app, 'digest/due', { now: at(2026, 11, 21, 8, 59) })).items, [])
  const next = (await ok(app, 'digest/due', { now: at(2026, 11, 21, 9, 0) })).items
  assert.deepEqual(next.map(item => item.period_key), ['2026-11-21'])

  await ok(app, 'digest/set', prefBody({ enabled: false }))
  assert.deepEqual((await ok(app, 'digest/due', { now: at(2026, 11, 22, 12) })).items, [])
  await ok(app, 'digest/set', prefBody({ cadence: 'off' }))
  assert.deepEqual((await ok(app, 'digest/due', { now: at(2026, 11, 22, 12) })).items, [])
})

test('weekly digests use the UTC ISO week for their period key', async t => {
  const app = await bot(t)
  await ok(app, 'digest/set', prefBody({ cadence: 'weekly', hour_utc: 12 }))
  assert.deepEqual((await ok(app, 'digest/due', { now: at(2026, 11, 19, 11, 59) })).items, [])
  const due = (await ok(app, 'digest/due', { now: at(2026, 11, 19, 12, 0) })).items
  assert.deepEqual(due.map(item => item.period_key), ['2026-W47'])
  await ok(app, 'digest/run', { workspace_id: WS, now: at(2026, 11, 19, 12, 1), items: [{ kind: 'work', title: 'One' }] })
  assert.deepEqual((await ok(app, 'digest/due', { now: at(2026, 11, 20, 13, 0) })).items, [])
  const following = (await ok(app, 'digest/due', { now: at(2026, 11, 23, 12, 0) })).items
  assert.deepEqual(following.map(item => item.period_key), ['2026-W48'])
})

test('build groups by kind, puts unread first, skips blank entries and caps the whole body', async t => {
  const app = await bot(t)
  await ok(app, 'digest/set', prefBody())
  const items = [
    { kind: 'notification', title: 'Read notice', created: 30, read: true },
    { kind: 'notification', title: 'Unread old', created: 10 },
    { kind: 'notification', title: 'Unread new', created: 20 },
    { kind: 'work', title: 'Work item', created: 5, body: 'A short body.', href: '/w/one' },
    { kind: 'automation', title: '   ', created: 1 },
    { kind: '', title: 'No kind', created: 1 },
    { kind: 'empty', title: '', created: 1 },
  ]
  const built = (await ok(app, 'digest/build', { workspace_id: WS, items, now: at(2026, 11, 20, 10) })).digest
  assert.equal(built.period_key, '2026-11-20')
  assert.deepEqual(built.sections.map(section => section.kind), ['notification', 'work'])
  assert.deepEqual(built.sections[0].items.map(item => item.title), ['Unread new', 'Unread old', 'Read notice'])
  assert.deepEqual(built.sections[1].items.map(item => item.title), ['Work item'])
  assert.equal(built.item_count, 4)
  assert.match(built.body, /Digest 2026-11-20/)
  assert.match(built.body, /\[notification\]/)
  assert.match(built.body, /\/w\/one/)
  assert.ok(built.body.length <= MAX_BODY)

  const many = []
  for (let kind = 0; kind < 3; kind++) {
    for (let index = 0; index < 30; index++) {
      many.push({ kind: `k${kind}`, title: `${kind}-${String(index).padStart(2, '0')}`, created: index })
    }
  }
  const capped = (await ok(app, 'digest/build', { workspace_id: WS, items: many, now: NOW })).digest
  assert.equal(capped.item_count, MAX_ITEMS)
  assert.equal(capped.sections.reduce((sum, section) => sum + section.items.length, 0), capped.item_count)
  assert.ok(capped.body.length <= MAX_BODY)
})

test('the assembled body is plain text even when an item carries markup', async t => {
  const app = await bot(t)
  const built = (await ok(app, 'digest/build', {
    workspace_id: WS, now: NOW,
    items: [{ kind: 'work', title: '<b>Alert</b>', created: 1, body: '<script>bad()</script>', href: '/w/<tag>' }],
  })).digest
  assert.equal(built.body.includes('<'), false, built.body)
  assert.equal(built.body.includes('>'), false, built.body)
  assert.match(built.body, /Alert/)
  assert.match(built.body, /bad\(\)/)
})

test('run records one receipt per period and replays the first one unchanged', async t => {
  const app = await bot(t)
  const items = [{ kind: 'notification', title: 'Unread', created: 1 }]
  const first = await ok(app, 'digest/run', { workspace_id: WS, items, now: NOW })
  assert.equal(first.created, true)
  assert.equal(first.run.period_key, '2026-11-20')
  assert.equal(first.run.item_count, 1)
  const replay = await ok(app, 'digest/run',
    { workspace_id: WS, items: [{ kind: 'work', title: 'Later' }], now: NOW + 600 })
  assert.equal(replay.created, false)
  assert.equal(replay.run.id, first.run.id)
  assert.equal(replay.run.body, first.run.body)
  assert.equal(replay.run.item_count, 1)
  const listed = (await ok(app, 'digest/runs', { workspace_id: WS })).items
  assert.equal(listed.length, 1)
})

test('run with nothing to summarize records no receipt and leaves the digest due', async t => {
  const app = await bot(t)
  await ok(app, 'digest/set', prefBody({ hour_utc: 0 }))
  const empty = await ok(app, 'digest/run', { workspace_id: WS, items: [], now: NOW })
  assert.deepEqual(empty, { run: null, created: false })
  // Blank titles and unknown kinds are not digest content either.
  const blanks = await ok(app, 'digest/run',
    { workspace_id: WS, items: [{ kind: 'work', title: '   ' }, { title: 'No kind' }], now: NOW })
  assert.deepEqual(blanks, { run: null, created: false })
  assert.deepEqual((await ok(app, 'digest/runs', { workspace_id: WS })).items, [])
  assert.deepEqual((await ok(app, 'digest/due', { now: NOW })).items.map(item => item.period_key), ['2026-11-20'])
})

test('a digest only ever covers the owner, the given workspace and reachable workspaces', async t => {
  const app = await bot(t)
  await ok(app, 'digest/set', prefBody())
  await ok(app, 'digest/set', prefBody({ workspace_id: OTHER }))
  const due = (await ok(app, 'digest/due', { now: at(2026, 11, 20, 9, 0) })).items
  assert.deepEqual(due.map(item => item.workspace_id).sort(), [WS, OTHER].sort())
  assert.ok(due.every(item => item.user_id === OWNER))

  const run = await ok(app, 'digest/run', { workspace_id: WS, now: at(2026, 11, 20, 9, 1), items: [{ kind: 'work', title: 'Only here' }] })
  assert.equal(run.created, true)
  assert.deepEqual((await ok(app, 'digest/due', { now: at(2026, 11, 20, 9, 0) })).items.map(item => item.workspace_id), [OTHER])
  assert.deepEqual((await ok(app, 'digest/runs', { workspace_id: OTHER })).items, [])

  // A workspace this DS-Bot cannot reach is a 404, never an empty list.
  assert.equal(await code(app, 'digest/get', { workspace_id: STRANGER }), 'workspace/not-found')
  assert.equal(await code(app, 'digest/set', prefBody({ workspace_id: STRANGER })), 'workspace/not-found')
  assert.equal(await code(app, 'digest/build', { workspace_id: STRANGER, items: [], now: NOW }), 'workspace/not-found')
  assert.equal(await code(app, 'digest/run', { workspace_id: STRANGER, items: [{ kind: 'work', title: 'x' }], now: NOW }), 'workspace/not-found')

  // Another person's user id is refused outright: nothing is written or read for it.
  assert.equal(await code(app, 'digest/set', prefBody({ user_id: FOREIGN })), 'digest/foreign-user')
  assert.equal(await code(app, 'digest/get', { workspace_id: WS, user_id: FOREIGN }), 'digest/foreign-user')
  assert.equal(await code(app, 'digest/due', { now: NOW, user_id: FOREIGN }), 'digest/foreign-user')
  assert.equal(await code(app, 'digest/runs', { workspace_id: WS, user_id: FOREIGN }), 'digest/foreign-user')
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(app.vol.data, 'openteamily', 'features', 'digest', 'digest.sqlite3'))
  t.after(() => db.close())
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM digest_prefs WHERE user_id=?').get(FOREIGN).n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM digest_runs WHERE user_id=?').get(FOREIGN).n, 0)
  // Rows left behind for someone else by an import stay invisible too.
  db.prepare('INSERT INTO digest_prefs VALUES(?,?,?,?,?,?,?)').run(WS, FOREIGN, 1, 'daily', 0, 'digest', NOW)
  db.prepare('INSERT INTO digest_runs VALUES(?,?,?,?,?,?,?)').run('f'.repeat(32), WS, FOREIGN, '2026-11-20', 4, 'their body', NOW)
  const foreignDue = (await ok(app, 'digest/due', { now: NOW })).items
  assert.equal(foreignDue.some(item => item.user_id === FOREIGN), false)
  assert.equal((await ok(app, 'digest/runs', { workspace_id: WS })).items.some(item => item.user_id === FOREIGN), false)
  assert.deepEqual((await ok(app, 'digest/get', { workspace_id: WS })).pref.user_id, OWNER)
})

test('an unreachable workspace directory fails closed instead of guessing the caller may read it', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'ot-digest-standalone-'))
  const offline = async () => { throw Object.assign(new Error('Bot Social is offline'), { code: 'social/offline' }) }
  const host = { dataDir: dir, featureDir: () => dir, log: () => {}, identity: {}, call: offline }
  const { default: digestFeature } = await import('../features/digest/index.js')
  const feature = await digestFeature(host)
  await assert.rejects(feature.endpoints.get({ workspace_id: WS }), error => error.code === 'workspace/unavailable')
  await assert.rejects(feature.endpoints.set(prefBody()), error => error.code === 'workspace/unavailable')
})

test('oversize input is refused before anything is stored', async t => {
  const app = await bot(t)
  await ok(app, 'digest/set', prefBody())
  assert.equal(await code(app, 'digest/build', { workspace_id: WS, now: NOW, items: [{ kind: 'work', title: 't'.repeat(MAX_TITLE_INPUT + 1) }] }), 'digest/invalid')
  assert.equal(await code(app, 'digest/build', { workspace_id: WS, now: NOW, items: [{ kind: 'work', title: 'ok', body: 'b'.repeat(MAX_ITEM_BODY_INPUT + 1) }] }), 'digest/invalid')
  assert.equal(await code(app, 'digest/build', { workspace_id: WS, now: NOW, items: [{ kind: 'k'.repeat(65), title: 'ok' }] }), 'digest/invalid')
  const tooMany = Array.from({ length: MAX_INPUT_ITEMS + 1 }, () => ({ kind: 'work', title: 'ok' }))
  assert.equal(await code(app, 'digest/build', { workspace_id: WS, now: NOW, items: tooMany }), 'digest/invalid')
  assert.equal(await code(app, 'digest/run', { workspace_id: WS, now: NOW, items: tooMany }), 'digest/invalid')
  assert.deepEqual((await ok(app, 'digest/runs', { workspace_id: WS })).items, [])
  assert.equal(await code(app, 'digest/runs', { workspace_id: WS, limit: 0 }), 'digest/invalid')
  assert.equal(await code(app, 'digest/runs', { workspace_id: WS, limit: 101 }), 'digest/invalid')
  assert.equal(await code(app, 'digest/build', { workspace_id: WS, now: NOW, items: 'not a list' }), 'digest/invalid')
})

test('runs lists only the owner receipts, newest first and within the limit', async t => {
  const app = await bot(t)
  const items = [{ kind: 'notification', title: 'Unread', created: 1 }]
  for (const day of [20, 21, 22]) {
    const reply = await ok(app, 'digest/run', { workspace_id: WS, items, now: at(2026, 11, day, 9) })
    assert.equal(reply.created, true)
  }
  const listed = (await ok(app, 'digest/runs', { workspace_id: WS })).items
  assert.deepEqual(listed.map(run => run.period_key), ['2026-11-22', '2026-11-21', '2026-11-20'])
  assert.ok(listed.every(run => run.user_id === OWNER && run.workspace_id === WS))
  assert.deepEqual((await ok(app, 'digest/runs', { workspace_id: WS, limit: 2 })).items.map(run => run.period_key), ['2026-11-22', '2026-11-21'])
})
