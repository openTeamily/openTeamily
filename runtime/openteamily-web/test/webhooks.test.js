import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, createHmac } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { boot, WS } from './helpers.js'
import {
  MAX_BODY_BYTES,
  ensureSchema,
  eventKind,
  sign,
  verify,
} from '../features/webhooks/index.js'

const OTHER = 'b'.repeat(32)
const SECRET = 'whsec_synthetic_test_secret_do_not_persist'
const SECRET_REF = 'vault:kv/webhooks/ci'
const NOW = 1800000000

const file = (bot) => join(bot.vol.data, 'openteamily', 'features', 'webhooks', 'webhooks.sqlite3')

async function ok(bot, op, payload) {
  const result = await bot.endpoint(`webhooks/${op}`, payload)
  assert.equal(result.ok, true, `${op}: ${JSON.stringify(result)}`)
  return result.value
}

async function fails(bot, op, payload, code) {
  const result = await bot.endpoint(`webhooks/${op}`, payload)
  assert.equal(result.ok, false, `${op} unexpectedly succeeded: ${JSON.stringify(result)}`)
  if (code) assert.equal(result.error.code, code, JSON.stringify(result.error))
  return result.error
}

const register = (bot, overrides = {}) => ok(bot, 'register', {
  workspace_id: WS, name: 'ci', secret_ref: SECRET_REF, now: NOW, ...overrides,
})

const ingest = (bot, endpointId, body, overrides = {}) => {
  const timestamp = String(overrides.timestamp ?? NOW)
  return ok(bot, 'ingest', {
    workspace_id: WS,
    endpoint_id: endpointId,
    body,
    timestamp,
    signature: overrides.signature ?? sign(overrides.secret ?? SECRET, timestamp, body),
    secret: overrides.secret ?? SECRET,
    now: NOW,
    ...overrides,
  })
}

const deliveries = (bot, overrides = {}) => ok(bot, 'deliveries', { workspace_id: WS, ...overrides })

test('webhooks schema is idempotent, bounded and stores only a secret reference', async () => {
  const bot = await boot()
  assert.ok(bot.features.loaded.includes('webhooks'), JSON.stringify(bot.features.failed))
  assert.ok(existsSync(file(bot)))
  const db = new DatabaseSync(file(bot))
  ensureSchema(db)
  ensureSchema(db)
  assert.deepEqual(db.prepare('PRAGMA table_info(webhook_endpoints)').all().map((row) => row.name), [
    'id', 'workspace_id', 'name', 'secret_ref', 'enabled', 'created', 'updated',
  ])
  assert.deepEqual(db.prepare('PRAGMA table_info(webhook_deliveries)').all().map((row) => row.name), [
    'id', 'workspace_id', 'endpoint_id', 'signature', 'timestamp', 'body_hash', 'event_kind', 'payload', 'received',
  ])
  const endpointColumns = db.prepare('PRAGMA table_info(webhook_endpoints)').all().map((row) => row.name)
  const deliveryColumns = db.prepare('PRAGMA table_info(webhook_deliveries)').all().map((row) => row.name)
  assert.ok(!endpointColumns.includes('secret'))
  assert.ok(!deliveryColumns.includes('secret'))
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name)
  assert.ok(tables.includes('webhook_endpoints'))
  assert.ok(tables.includes('webhook_deliveries'))
  db.close()
  const again = await boot(bot.vol)
  assert.ok(again.features.loaded.includes('webhooks'), JSON.stringify(again.features.failed))
})

test('register, list and disable are workspace-scoped and bounded', async () => {
  const bot = await boot()
  const endpoint = await register(bot)
  assert.equal(endpoint.id.length, 32)
  assert.equal(endpoint.workspace_id, WS)
  assert.equal(endpoint.name, 'ci')
  assert.equal(endpoint.secret_ref, SECRET_REF)
  assert.equal(endpoint.enabled, true)
  assert.equal(endpoint.created, NOW)
  assert.equal(endpoint.updated, NOW)

  assert.deepEqual((await ok(bot, 'list', { workspace_id: WS })).items.map((item) => item.id), [endpoint.id])
  assert.deepEqual((await ok(bot, 'list', { workspace_id: OTHER })).items, [])
  await fails(bot, 'register', { workspace_id: WS, name: ' ci ', secret_ref: 'vault:other', now: NOW }, 'webhooks/conflict')
  for (const name of ['', '   ', 'x'.repeat(81), 'bad\u0000name']) {
    await fails(bot, 'register', { workspace_id: WS, name, secret_ref: SECRET_REF, now: NOW }, 'webhooks/invalid')
  }
  for (const secretRef of ['', '   ', 'x'.repeat(201), 'bad\u0001ref']) {
    await fails(bot, 'register', { workspace_id: WS, name: 'bounded', secret_ref: secretRef, now: NOW }, 'webhooks/invalid')
  }

  const disabled = await ok(bot, 'disable', { workspace_id: WS, endpoint_id: endpoint.id, now: NOW + 5 })
  assert.equal(disabled.enabled, false)
  assert.equal(disabled.updated, NOW + 5)
  const again = await ok(bot, 'disable', { workspace_id: WS, endpoint_id: endpoint.id, now: NOW + 6 })
  assert.equal(again.enabled, false)
  await fails(bot, 'disable', { workspace_id: OTHER, endpoint_id: endpoint.id, now: NOW }, 'webhooks/not-found')
})

test('sign and verify use HMAC-SHA256 over <timestamp>.<raw body> in constant time', () => {
  const body = Buffer.from('{"type":"issue.created","data":{"number":7}}')
  const timestamp = String(NOW)
  assert.equal(sign(SECRET, timestamp, body).length, 64)
  assert.equal(sign(SECRET, timestamp, body), sign(SECRET, timestamp, body.toString('utf8')))
  assert.equal(sign(SECRET, timestamp, body), sign(Buffer.from(SECRET), Number(timestamp), body))
  assert.ok(/^[0-9a-f]{64}$/.test(sign(SECRET, timestamp, body)))
  assert.equal(verify(SECRET, timestamp, body, sign(SECRET, timestamp, body), NOW), true)
  assert.equal(verify(SECRET, timestamp, body, sign(SECRET, timestamp, body).toUpperCase(), NOW), true)
  assert.equal(verify(Buffer.from(SECRET), timestamp, body, sign(SECRET, timestamp, body), NOW), true)
  assert.equal(verify(SECRET, timestamp, body, sign(SECRET, timestamp, body), String(NOW)), true)
  const manual = createHmac('sha256', SECRET).update(`${timestamp}.`).update(body).digest('hex')
  assert.equal(sign(SECRET, timestamp, body), manual)
})

test('valid deliveries are normalized, event kinds derive safely and payloads round-trip', async () => {
  const bot = await boot()
  const endpoint = await register(bot)
  const body = Buffer.from('{"type":"issue.created","data":{"number":7}}')
  const timestamp = String(NOW)
  const signature = sign(SECRET, timestamp, body)
  const delivery = await ingest(bot, endpoint.id, body)
  assert.equal(delivery.workspace_id, WS)
  assert.equal(delivery.endpoint_id, endpoint.id)
  assert.equal(delivery.signature, signature)
  assert.equal(delivery.timestamp, timestamp)
  assert.equal(delivery.body_hash, createHash('sha256').update(body).digest('hex'))
  assert.equal(delivery.event_kind, 'issue.created')
  assert.deepEqual(delivery.payload, { type: 'issue.created', data: { number: 7 } })
  assert.equal(delivery.received, NOW)
  assert.deepEqual((await deliveries(bot)).items, [delivery])

  const cases = [
    ['{"event":"push"}', 'push'],
    ['{"event_type":"order.created"}', 'order.created'],
    ['{"kind":"heartbeat"}', 'heartbeat'],
    ['{"data":{}}', 'unknown'],
    ['{"type":""}', 'unknown'],
    ['{"type":5}', 'unknown'],
    ['[]', 'unknown'],
    ['"text"', 'unknown'],
  ]
  for (const [raw, kind] of cases) assert.equal(await ingest(bot, endpoint.id, Buffer.from(raw)).then((item) => item.event_kind), kind, raw)
  assert.equal((await deliveries(bot, { limit: 100 })).items.length, cases.length + 1)
  assert.equal(eventKind({ type: 'x'.repeat(81) }), 'unknown')
  assert.equal(eventKind({ event: '  spaced  ' }), 'spaced')
})

test('tampered bodies, wrong secrets and malformed signatures are rejected without a delivery', async () => {
  const bot = await boot()
  const endpoint = await register(bot)
  const body = Buffer.from('{"event":"push","ref":"main"}')
  const timestamp = String(NOW)
  const signature = sign(SECRET, timestamp, body)
  const tampered = Buffer.from('{"event":"push","ref":"evil"}')
  assert.equal(verify(SECRET, timestamp, tampered, signature, NOW), false)
  assert.equal(verify('wrong-secret', timestamp, body, signature, NOW), false)
  const badHex = (signature[0] === '0' ? '1' : '0') + signature.slice(1)
  assert.equal(verify(SECRET, timestamp, body, badHex, NOW), false)
  for (const malformed of ['', 'zz'.repeat(32), signature.slice(0, -1), signature + '0', null, 123]) {
    assert.equal(verify(SECRET, timestamp, body, malformed, NOW), false)
  }
  await fails(bot, 'ingest', { workspace_id: WS, endpoint_id: endpoint.id, body: tampered, timestamp, signature, secret: SECRET, now: NOW }, 'webhooks/forbidden')
  await fails(bot, 'ingest', { workspace_id: WS, endpoint_id: endpoint.id, body, timestamp, signature: badHex, secret: SECRET, now: NOW }, 'webhooks/forbidden')
  assert.deepEqual((await deliveries(bot)).items, [])
})

test('stale, future, oversized and malformed timestamps are rejected; the 300s boundary is inclusive', async () => {
  const bot = await boot()
  const endpoint = await register(bot)
  const body = Buffer.from('{"kind":"tick"}')
  for (const timestamp of [NOW - 301, NOW + 301, 'abc', '', '-1', '1'.repeat(21), `${NOW}x`, null]) {
    const text = timestamp === null ? String(NOW) : String(timestamp)
    const signature = sign(SECRET, text, body)
    assert.equal(verify(SECRET, timestamp, body, signature, NOW), false, String(timestamp))
  }
  await fails(bot, 'ingest', { workspace_id: WS, endpoint_id: endpoint.id, body, timestamp: NOW - 301, signature: sign(SECRET, String(NOW - 301), body), secret: SECRET, now: NOW }, 'webhooks/forbidden')
  await fails(bot, 'ingest', { workspace_id: WS, endpoint_id: endpoint.id, body, timestamp: NOW + 301, signature: sign(SECRET, String(NOW + 301), body), secret: SECRET, now: NOW }, 'webhooks/forbidden')
  for (const timestamp of [NOW - 300, NOW + 300]) {
    const text = String(timestamp)
    assert.equal(verify(SECRET, text, body, sign(SECRET, text, body), NOW), true)
  }
  assert.equal(verify(SECRET, String(NOW - 10), body, sign(SECRET, String(NOW - 10), body), NOW, 10), true)
  assert.equal(verify(SECRET, String(NOW - 11), body, sign(SECRET, String(NOW - 11), body), NOW, 10), false)
  assert.throws(() => verify(SECRET, String(NOW), body, sign(SECRET, String(NOW), body), NOW, -1), (error) => error.code === 'webhooks/invalid')
  assert.deepEqual((await deliveries(bot)).items, [])
})

test('replaying the same body on one endpoint is idempotent; another endpoint gets its own row', async () => {
  const bot = await boot()
  const endpoint = await register(bot)
  const body = Buffer.from('{"event_type":"invoice.paid","invoice":42}')
  const first = await ingest(bot, endpoint.id, body)
  const second = await ingest(bot, endpoint.id, body)
  assert.deepEqual(second, first)
  const replayTimestamp = String(NOW + 1)
  const replaySignature = sign(SECRET, replayTimestamp, body)
  const third = await ingest(bot, endpoint.id, body, { timestamp: replayTimestamp, signature: replaySignature })
  assert.deepEqual(third, first)
  assert.equal((await deliveries(bot)).items.length, 1)

  const other = await register(bot, { name: 'other' })
  const separate = await ingest(bot, other.id, body)
  assert.notEqual(separate.id, first.id)
  assert.equal((await deliveries(bot)).items.length, 2)
  assert.deepEqual((await deliveries(bot, { endpoint_id: endpoint.id })).items.map((item) => item.id), [first.id])
})

test('invalid JSON never becomes a delivery, even with a valid signature', async () => {
  const bot = await boot()
  const endpoint = await register(bot)
  for (const raw of ['not json', '', '\xff', '{"broken":', '{"value":NaN}', '{"value":Infinity}', '{"value":-Infinity}']) {
    const body = Buffer.from(raw, 'latin1')
    await fails(bot, 'ingest', {
      workspace_id: WS, endpoint_id: endpoint.id, body, timestamp: String(NOW),
      signature: sign(SECRET, String(NOW), body), secret: SECRET, now: NOW,
    }, 'webhooks/invalid')
  }
  assert.deepEqual((await deliveries(bot)).items, [])
})

test('the 64 KiB body limit is enforced at the boundary', async () => {
  const bot = await boot()
  const endpoint = await register(bot)
  const prefix = Buffer.from('{"x":"')
  const suffix = Buffer.from('"}')
  const oversize = Buffer.concat([prefix, Buffer.alloc(MAX_BODY_BYTES + 1 - prefix.length - suffix.length, 0x61), suffix])
  assert.ok(oversize.length > MAX_BODY_BYTES)
  await fails(bot, 'ingest', {
    workspace_id: WS, endpoint_id: endpoint.id, body: oversize, timestamp: String(NOW),
    signature: sign(SECRET, String(NOW), oversize), secret: SECRET, now: NOW,
  }, 'webhooks/too-large')
  const boundary = Buffer.concat([prefix, Buffer.alloc(MAX_BODY_BYTES - prefix.length - suffix.length, 0x61), suffix])
  assert.equal(boundary.length, MAX_BODY_BYTES)
  const event = await ingest(bot, endpoint.id, boundary)
  assert.equal(event.body_hash, createHash('sha256').update(boundary).digest('hex'))
  assert.equal((await deliveries(bot)).items.length, 1)
})

test('workspace isolation covers register, list, ingest and deliveries', async () => {
  const bot = await boot()
  const endpoint = await register(bot)
  const body = Buffer.from('{"type":"isolated"}')
  await ingest(bot, endpoint.id, body)
  assert.deepEqual((await deliveries(bot, { workspace_id: OTHER })).items, [])
  const other = await register(bot, { workspace_id: OTHER })
  assert.deepEqual((await deliveries(bot, { workspace_id: OTHER })).items, [])
  await fails(bot, 'ingest', {
    workspace_id: OTHER, endpoint_id: endpoint.id, body, timestamp: String(NOW),
    signature: sign(SECRET, String(NOW), body), secret: SECRET, now: NOW,
  }, 'webhooks/forbidden')
  assert.deepEqual((await deliveries(bot, { workspace_id: WS })).items.length, 1)
  assert.deepEqual((await deliveries(bot, { workspace_id: OTHER, endpoint_id: other.id })).items, [])
  assert.deepEqual((await ok(bot, 'list', { workspace_id: WS })).items.map((item) => item.id), [endpoint.id])
  assert.deepEqual((await ok(bot, 'list', { workspace_id: OTHER })).items.map((item) => item.id), [other.id])
})

test('deliveries page by id, filter by endpoint and never leak another workspace', async () => {
  const bot = await boot()
  const endpoint = await register(bot)
  const bodies = [Buffer.from('{"type":"one"}'), Buffer.from('{"type":"two"}'), Buffer.from('{"type":"three"}')]
  const first = await ingest(bot, endpoint.id, bodies[0])
  const second = await ingest(bot, endpoint.id, bodies[1])
  const third = await ingest(bot, endpoint.id, bodies[2])
  const expected = [first.id, second.id, third.id].sort()
  const page1 = await deliveries(bot, { endpoint_id: endpoint.id, limit: 2 })
  assert.equal(page1.items.length, 2)
  assert.equal(page1.cursor, page1.items[1].id)
  const page2 = await deliveries(bot, { endpoint_id: endpoint.id, limit: 2, cursor: page1.cursor })
  assert.equal(page2.items.length, 1)
  assert.equal(page2.cursor, null)
  assert.deepEqual([...page1.items, ...page2.items].map((item) => item.id).sort(), expected)
  const all = await deliveries(bot, { limit: 100 })
  assert.equal(all.items.length, 3)
  assert.deepEqual(all.items.map((item) => item.id).sort(), expected)
  for (const limit of [0, 101, -1, true, 1.5]) {
    await fails(bot, 'deliveries', { workspace_id: WS, limit }, 'webhooks/invalid')
  }
})

test('disabled or unknown endpoints reject ingestion even with a valid signature', async () => {
  const bot = await boot()
  const endpoint = await register(bot)
  await ok(bot, 'disable', { workspace_id: WS, endpoint_id: endpoint.id, now: NOW })
  const body = Buffer.from('{"type":"disabled"}')
  const timestamp = String(NOW)
  const signature = sign(SECRET, timestamp, body)
  assert.equal(verify(SECRET, timestamp, body, signature, NOW), true)
  await fails(bot, 'ingest', { workspace_id: WS, endpoint_id: endpoint.id, body, timestamp, signature, secret: SECRET, now: NOW }, 'webhooks/forbidden')
  await fails(bot, 'ingest', { workspace_id: WS, endpoint_id: 'missing-endpoint', body, timestamp, signature, secret: SECRET, now: NOW }, 'webhooks/forbidden')
  assert.deepEqual((await deliveries(bot)).items, [])
})

test('the plaintext signing secret is never persisted', async () => {
  const bot = await boot()
  const endpoint = await register(bot)
  await ingest(bot, endpoint.id, Buffer.from('{"type":"secret.check","note":"no signing key here"}'))
  const db = new DatabaseSync(file(bot))
  assert.equal(db.prepare('SELECT secret_ref FROM webhook_endpoints WHERE id=?').get(endpoint.id).secret_ref, SECRET_REF)
  const endpointDump = JSON.stringify(db.prepare('SELECT * FROM webhook_endpoints').all())
  const deliveryDump = JSON.stringify(db.prepare('SELECT * FROM webhook_deliveries').all())
  db.close()
  assert.ok(!endpointDump.includes(SECRET))
  assert.ok(!deliveryDump.includes(SECRET))
  for (const suffix of ['', '-wal', '-shm']) {
    const path = file(bot) + suffix
    if (!existsSync(path)) continue
    assert.ok(!readFileSync(path).includes(Buffer.from(SECRET)), `secret must not appear in ${path}`)
  }
})
