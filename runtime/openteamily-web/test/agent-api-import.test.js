import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import agentApi, { createAgentApi } from '../features/agent-api/index.js'
import { importOfficialBundle } from '../features/agent-api/migrate.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const W = 'a'.repeat(32)
const A = 'b'.repeat(32)
const INSTANCE = 'f'.repeat(32)
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

function bundle(rows, feature = 'agent-api') {
  const text = JSON.stringify(rows)
  const body = { format: 'openteamily-dsbot-import', version: 1, feature, tables: { agent_api_keys: text },
    manifest: { agent_api_keys: { rows: rows.length, sha256: sha(text) } } }
  return body
}

function row(id, token, { name = 'ci', rate = 10, revoked = 0 } = {}) {
  return { id, workspace_id: W, agent_id: A, name, token_hash: sha(token), scope: 'invoke', rate_per_minute: rate,
    created: 1_700_000_000, last_used: null, revoked }
}

function host(dataDir = mkdtempSync(join(tmpdir(), 'ot-agent-api-'))) {
  const tickets = []
  return {
    tickets,
    host: {
      name: 'agent-api',
      identity: { instanceId: INSTANCE },
      dataDir,
      featureDir() { const dir = join(dataDir, 'openteamily', 'features', 'agent-api'); mkdirSync(dir, { recursive: true }); return dir },
      log() {},
      runtime: async () => ({}),
      call: async (name, payload) => {
        if (name !== 'agents/turn') throw Object.assign(new Error('missing'), { code: 'openteamily/not-found' })
        tickets.push(payload)
        return { text: 'imported key reply', session_id: 's', turn_id: 't' }
      },
    },
  }
}

test('imported legacy key authenticates, keeps its rate limit, revocation and digest', async () => {
  const db = new DatabaseSync(':memory:')
  const { host: h, tickets } = host()
  const api = createAgentApi({ db, host: h, clock: () => 1_800_000_000 })
  const oldToken = 'L'.repeat(43), revokedToken = 'R'.repeat(43)
  const rows = [row('1'.repeat(32), oldToken, { name: 'legacy', rate: 1 }),
    row('2'.repeat(32), revokedToken, { name: 'revoked', revoked: 1 })]
  const value = bundle(rows)

  assert.deepEqual(importOfficialBundle(db, value), { imported: 2, skipped: 0 })
  assert.deepEqual(importOfficialBundle(db, value), { imported: 0, skipped: 2 })
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM api_keys').get().n, 2)
  const stored = db.prepare('SELECT * FROM api_keys WHERE id=?').get('1'.repeat(32))
  assert.equal(stored.token_hash, sha(oldToken))
  assert.equal(stored.rate_per_minute, 1)
  assert.equal(stored.name, 'legacy')

  const made = await api.endpoints.invoke({ token: oldToken, agent_id: A, prompt: 'hello', idempotency_key: 'i'.repeat(16) })
  assert.equal(made.status, 202)
  await Promise.all(api.inflight.values())
  const done = await api.endpoints.invocation({ token: oldToken, id: made.invocation.id })
  assert.equal(done.invocation.status, 'succeeded')
  assert.equal(done.invocation.reply, 'imported key reply')
  assert.equal(tickets.length, 1)
  await assert.rejects(
    api.endpoints.invoke({ token: oldToken, agent_id: A, prompt: 'again', idempotency_key: 'j'.repeat(16) }),
    (error) => error.status === 429)
  await assert.rejects(
    api.endpoints.invoke({ token: revokedToken, agent_id: A, prompt: 'no', idempotency_key: 'k'.repeat(16) }),
    (error) => error.status === 401)
})

test('a delivered bundle is imported at startup and the file is removed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ot-agent-api-boot-'))
  try {
    const { host: h } = host(dir)
    const oldToken = 'M'.repeat(43)
    const value = { ...bundle([row('3'.repeat(32), oldToken)]), instance_id: INSTANCE }
    const importDir = join(dir, 'openteamily', 'import')
    mkdirSync(importDir, { recursive: true })
    const file = join(importDir, 'agent-api-v1.bundle')
    writeFileSync(file, JSON.stringify(value))
    const feature = await agentApi(h)
    assert.equal(existsSync(file), false)
    const made = await feature.endpoints.invoke({ token: oldToken, agent_id: A, prompt: 'hello', idempotency_key: 'm'.repeat(16) })
    assert.equal(made.status, 202)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('missing, foreign and tampered bundles are rejected', () => {
  const db = new DatabaseSync(':memory:')
  createAgentApi({ db, host: host().host })
  assert.throws(() => importOfficialBundle(db, null))
  assert.throws(() => importOfficialBundle(db, bundle([], 'agents')))
  assert.throws(() => importOfficialBundle(db, { format: 'openteamily-dsbot-import', version: 1, feature: 'agent-api' }))
  assert.throws(() => importOfficialBundle(db, { format: 'openteamily-dsbot-import', version: 1, feature: 'agent-api', tables: {}, manifest: {} }))
  const value = bundle([row('4'.repeat(32), 'N'.repeat(43))])
  value.tables.agent_api_keys = '[]'
  assert.throws(() => importOfficialBundle(db, value))
  const invalid = bundle([{ ...row('5'.repeat(32), 'O'.repeat(43)), token_hash: 'plaintext-token' }])
  assert.throws(() => importOfficialBundle(db, invalid))
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM api_keys').get().n, 0)
})
