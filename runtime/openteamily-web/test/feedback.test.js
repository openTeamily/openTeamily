import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { boot, volume } from './helpers.js'

const ALICE = '1'.repeat(32)
const BOB = '2'.repeat(32)
const W = 'a'.repeat(32)
const W2 = 'b'.repeat(32)
const TARGET = 'c'.repeat(32)
const as = (id) => { if (id) process.env.OPENTEAMILY_OWNER_USER_ID = id; else delete process.env.OPENTEAMILY_OWNER_USER_ID }
const dbFile = (vol) => join(vol.data, 'openteamily', 'features', 'feedback', 'feedback.sqlite3')

async function call(bot, op, payload) {
  return bot.endpoint(`feedback/${op}`, payload)
}

async function failure(bot, op, payload) {
  const result = await call(bot, op, payload)
  assert.equal(result.ok, false, JSON.stringify(result))
  assert.match(result.error.code, /^feedback\//)
  return result.error
}

const submit = (bot, payload) => call(bot, 'submit', { workspace_id: W, target_type: 'message', target_id: TARGET, kind: 'rating', score: 5, ...payload })

test('feedback feature loads in this DS-Bot with its own idempotent schema and indexes', async () => {
  as(null)
  const vol = volume()
  const first = await boot(vol)
  assert.ok(first.features.loaded.includes('feedback'), JSON.stringify(first.features.failed))
  assert.ok(existsSync(dbFile(vol)))
  const second = await boot(vol)
  assert.ok(second.features.loaded.includes('feedback'), JSON.stringify(second.features.failed))
  const db = new DatabaseSync(dbFile(vol))
  const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index')").all().map((row) => row.name))
  db.close()
  assert.ok(names.has('feedback'))
  for (const index of ['feedback_target', 'feedback_user', 'feedback_recent']) assert.ok(names.has(index), index)
  const listed = await call(second, 'list', { workspace_id: W })
  assert.deepEqual(listed.value.items, [])
})

test('rating and thumbs submissions round-trip with the full record shape', async () => {
  as(ALICE)
  const bot = await boot()
  const rating = (await submit(bot, { now: 100, score: 4, reason: 'helpful', comment: 'Clear and quick.' })).value.feedback
  assert.equal(rating.workspace_id, W)
  assert.equal(rating.user_id, ALICE)
  assert.equal(rating.target_type, 'message')
  assert.equal(rating.target_id, TARGET)
  assert.equal(rating.kind, 'rating')
  assert.equal(rating.score, 4)
  assert.equal(rating.reason, 'helpful')
  assert.equal(rating.comment, 'Clear and quick.')
  assert.equal(rating.created, 100)
  assert.equal(rating.updated, 100)
  const thumbs = (await submit(bot, { kind: 'thumbs', score: -1, reason: null, comment: null, now: 101 })).value.feedback
  assert.equal(thumbs.kind, 'thumbs')
  assert.equal(thumbs.score, -1)
  assert.notEqual(thumbs.id, rating.id)
})

test('repeated submission upserts by unique key without duplicating and keeps id/created', async () => {
  as(ALICE)
  const bot = await boot()
  const first = (await submit(bot, { score: 2, reason: 'slow', comment: 'First pass.', now: 100 })).value.feedback
  const second = (await submit(bot, { score: 5, reason: 'fast', comment: 'Second pass.', now: 200 })).value.feedback
  assert.equal(second.id, first.id)
  assert.equal(second.created, 100)
  assert.equal(second.updated, 200)
  assert.equal(second.score, 5)
  assert.equal(second.reason, 'fast')
  assert.equal(second.comment, 'Second pass.')
  const third = (await submit(bot, { score: 4, now: 300 })).value.feedback
  assert.equal(third.id, first.id)
  assert.equal(third.reason, null)
  assert.equal(third.comment, null)
  assert.equal((await call(bot, 'list', { workspace_id: W })).value.items.length, 1)
  const thumbs = (await submit(bot, { kind: 'thumbs', score: 1, now: 400 })).value.feedback
  assert.notEqual(thumbs.id, first.id)
  assert.equal((await call(bot, 'list', { workspace_id: W })).value.items.length, 2)
})

test('invalid target, kind and score values are rejected with typed errors', async () => {
  as(ALICE)
  const bot = await boot()
  for (const target_type of ['', 'chat', 'Message', null, 4, ['message']]) await failure(bot, 'submit', { workspace_id: W, target_type, target_id: TARGET, kind: 'rating', score: 5 })
  for (const target_id of ['', '   ', 'x'.repeat(129), null, 7]) await failure(bot, 'submit', { workspace_id: W, target_type: 'message', target_id, kind: 'rating', score: 5 })
  for (const kind of ['', 'like', 'RATING', null, ['rating']]) await failure(bot, 'submit', { workspace_id: W, target_type: 'message', target_id: TARGET, kind, score: 5 })
  for (const score of [0, 6, -1, true, 1.5, '5', null]) await failure(bot, 'submit', { workspace_id: W, target_type: 'message', target_id: TARGET, kind: 'rating', score })
  for (const score of [0, 2, -2, -1.5, true, '1', null]) await failure(bot, 'submit', { workspace_id: W, target_type: 'message', target_id: TARGET, kind: 'thumbs', score })
  assert.equal((await call(bot, 'list', { workspace_id: W })).value.items.length, 0)
})

test('oversize reason and comment are rejected and leave no rows behind', async () => {
  as(ALICE)
  const bot = await boot()
  await failure(bot, 'submit', { workspace_id: W, target_type: 'message', target_id: TARGET, kind: 'rating', score: 5, reason: 'r'.repeat(501) })
  await failure(bot, 'submit', { workspace_id: W, target_type: 'message', target_id: TARGET, kind: 'rating', score: 5, comment: 'c'.repeat(4001) })
  await failure(bot, 'submit', { workspace_id: W, target_type: 'message', target_id: TARGET, kind: 'rating', score: 5, reason: 42 })
  await failure(bot, 'submit', { workspace_id: W, target_type: 'message', target_id: TARGET, kind: 'rating', score: 5, comment: 42 })
  assert.equal((await call(bot, 'list', { workspace_id: W })).value.items.length, 0)
})

test('remove deletes only the caller\'s own record in the caller\'s workspace', async () => {
  as(ALICE)
  const bot = await boot()
  const alice = (await submit(bot, {})).value.feedback
  as(BOB)
  const bob = (await submit(bot, {})).value.feedback
  as(ALICE)
  assert.equal((await call(bot, 'remove', { workspace_id: W, id: bob.id })).value.removed, false)
  assert.equal((await call(bot, 'remove', { workspace_id: W2, id: alice.id })).value.removed, false)
  assert.equal((await call(bot, 'remove', { workspace_id: W, id: alice.id })).value.removed, true)
  assert.equal((await call(bot, 'remove', { workspace_id: W, id: alice.id })).value.removed, false)
  assert.equal((await call(bot, 'remove', { workspace_id: W, id: 'not-a-feedback-id' })).value.removed, false)
  as(BOB)
  assert.equal((await call(bot, 'remove', { workspace_id: W, id: bob.id })).value.removed, true)
})

test('list filters by target and user, and paginates newest-first without duplicates', async () => {
  as(ALICE)
  const bot = await boot()
  const created = []
  for (let index = 0; index < 5; index += 1) {
    created.push((await submit(bot, { target_id: String(index).padStart(32, '0'), now: 100 + index, score: (index % 5) + 1 })).value.feedback)
  }
  as(BOB)
  const bobAgent = (await submit(bot, { target_type: 'agent', target_id: 'b'.repeat(32), now: 200, score: 3 })).value.feedback
  as(ALICE)
  const first = (await call(bot, 'list', { workspace_id: W, limit: 2 })).value
  const second = (await call(bot, 'list', { workspace_id: W, limit: 2, cursor: first.cursor })).value
  const third = (await call(bot, 'list', { workspace_id: W, limit: 2, cursor: second.cursor })).value
  const combined = [...first.items, ...second.items, ...third.items]
  assert.equal(combined.length, 6)
  assert.equal(new Set(combined.map((row) => row.id)).size, 6)
  assert.deepEqual(combined.map((row) => row.id), [bobAgent, ...[...created].reverse()].map((row) => row.id))
  const target = (await call(bot, 'list', { workspace_id: W, target_type: 'message', target_id: created[2].target_id })).value
  assert.equal(target.items.length, 1)
  assert.ok(target.items.every((row) => row.target_type === 'message' && row.target_id === created[2].target_id))
  assert.equal((await call(bot, 'list', { workspace_id: W, target_type: 'message' })).value.items.length, 5)
  const own = (await call(bot, 'list', { workspace_id: W, user_id: ALICE, target_type: 'agent' })).value
  assert.equal(own.items.length, 0)
  const agents = (await call(bot, 'list', { workspace_id: W, target_type: 'agent' })).value
  assert.deepEqual(agents.items.map((row) => row.id), [bobAgent.id])
  await failure(bot, 'list', { workspace_id: W, target_type: 'chat' })
  await failure(bot, 'list', { workspace_id: W, target_type: 'message', target_id: '' })
  await failure(bot, 'list', { workspace_id: W, limit: 0 })
  await failure(bot, 'list', { workspace_id: W, limit: 101 })
  await failure(bot, 'list', { workspace_id: W, cursor: 'not-a-feedback-id' })
})

test('aggregate is workspace-scoped and reports counts, average, distribution and thumbs', async () => {
  as(ALICE)
  const bot = await boot()
  await submit(bot, { score: 5, now: 100 })
  as(BOB)
  await submit(bot, { score: 3, now: 101 })
  await submit(bot, { kind: 'thumbs', score: 1, now: 102 })
  as(ALICE)
  await submit(bot, { kind: 'thumbs', score: -1, now: 103 })
  as(ALICE)
  const result = (await call(bot, 'aggregate', { workspace_id: W, target_type: 'message', target_id: TARGET })).value
  assert.equal(result.count, 4)
  assert.equal(result.average, 4)
  assert.deepEqual(result.distribution, { 1: 0, 2: 0, 3: 1, 4: 0, 5: 1 })
  assert.equal(result.thumbs_up, 1)
  assert.equal(result.thumbs_down, 1)
  const empty = (await call(bot, 'aggregate', { workspace_id: W, target_type: 'message', target_id: 'z'.repeat(32) })).value
  assert.equal(empty.count, 0)
  assert.equal(empty.average, null)
  assert.deepEqual(empty.distribution, { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 })
  assert.equal(empty.thumbs_up, 0)
  assert.equal(empty.thumbs_down, 0)
  await failure(bot, 'aggregate', { workspace_id: W, target_type: 'chat', target_id: TARGET })
})

test('recent returns newest workspace records and never another workspace\'s rows', async () => {
  as(ALICE)
  const bot = await boot()
  const old = (await submit(bot, { target_id: '1'.repeat(32), now: 100 })).value.feedback
  const newer = (await submit(bot, { target_id: '2'.repeat(32), now: 300 })).value.feedback
  as(BOB)
  const middle = (await submit(bot, { target_id: '3'.repeat(32), now: 200 })).value.feedback
  const foreign = (await submit(bot, { workspace_id: W2, target_id: '4'.repeat(32), now: 400 })).value.feedback
  as(ALICE)
  const two = (await call(bot, 'recent', { workspace_id: W, limit: 2 })).value
  assert.deepEqual(two.items.map((row) => row.id), [newer.id, middle.id])
  const all = (await call(bot, 'recent', { workspace_id: W, limit: 10 })).value
  assert.deepEqual(all.items.map((row) => row.id), [newer.id, middle.id, old.id])
  assert.ok(!all.items.some((row) => row.id === foreign.id))
  const other = (await call(bot, 'recent', { workspace_id: W2, limit: 10 })).value
  assert.deepEqual(other.items.map((row) => row.id), [foreign.id])
  await failure(bot, 'recent', { workspace_id: W, limit: 0 })
})

test('feedback stays in this DS-Bot volume and is invisible to another DS-Bot', async () => {
  as(ALICE)
  const vol = volume()
  const first = await boot(vol)
  const created = (await submit(first, {})).value.feedback
  const again = await boot(vol)
  assert.equal((await call(again, 'list', { workspace_id: W })).value.items[0].id, created.id)
  const other = await boot()
  assert.equal((await call(other, 'list', { workspace_id: W })).value.items.length, 0)
  assert.equal((await call(other, 'aggregate', { workspace_id: W, target_type: 'message', target_id: TARGET })).value.count, 0)
})
