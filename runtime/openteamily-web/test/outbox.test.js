import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import feature, {
  BASE_BACKOFF,
  LIMITS,
  MAX_BACKOFF,
  backoffSeconds,
} from '../features/outbox/index.js'

const WS = 'a'.repeat(32)
const OTHER = 'b'.repeat(32)

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ot-outbox-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const host = {
    featureDir() {
      const dir = join(root, 'openteamily', 'features', 'outbox')
      mkdirSync(dir, { recursive: true })
      return dir
    },
    dataDir: root,
    log() {},
  }
  const loaded = feature(host)
  return { root, host, loaded, e: loaded.endpoints }
}

const enqueue = (e, fields = {}) => e.enqueue({
  workspace_id: WS,
  channel: 'email',
  recipient: 'alice@example.test',
  body: 'A durable message.',
  now: 1000,
  ...fields,
})

const rejects = (fn, code) => assert.throws(fn, (error) => {
  assert.equal(error.code, code)
  return true
})

test('schema migration is idempotent and keeps the outbox in its own feature directory', (t) => {
  const first = fixture(t)
  assert.ok(existsSync(join(first.root, 'openteamily', 'features', 'outbox', 'outbox.sqlite3')))
  assert.equal(enqueue(first.e).status, 'pending')
  const second = feature(first.host)
  assert.equal(second.endpoints.stats({ workspace_id: WS }).pending, 1)
  assert.equal(second.endpoints.list({ workspace_id: WS }).length, 1)
  assert.equal(second.endpoints.enqueue({ workspace_id: WS, channel: 'email', recipient: 'b@example.test', body: 'x', now: 1001, idempotency_key: 'same' }).status, 'pending')
  assert.equal(second.endpoints.enqueue({ workspace_id: WS, channel: 'email', recipient: 'c@example.test', body: 'y', now: 1002, idempotency_key: 'same' }).recipient, 'b@example.test')
})

test('enqueue is idempotent by workspace and key and decodes payloads', (t) => {
  const { e } = fixture(t)
  const first = enqueue(e, { idempotency_key: 'welcome-0001', payload: { b: 2, a: ['x'] } })
  const replay = enqueue(e, { idempotency_key: 'welcome-0001', body: 'Changed body', payload: { changed: true } })
  assert.equal(replay.id, first.id)
  assert.equal(replay.body, first.body)
  assert.deepEqual(replay.payload, { a: ['x'], b: 2 })
  assert.equal(e.list({ workspace_id: WS, limit: 10 }).length, 1)
  const other = enqueue(e, { workspace_id: OTHER, idempotency_key: 'welcome-0001' })
  assert.notEqual(other.id, first.id)
  assert.equal(e.stats({ workspace_id: WS }).total, 1)
  assert.equal(e.stats({ workspace_id: OTHER }).total, 1)
})

test('invalid channels and workspace ids are rejected', (t) => {
  const { e } = fixture(t)
  for (const channel of ['sms', 'EMAIL', '', null, undefined]) rejects(() => enqueue(e, { channel }), 'outbox/invalid')
  for (const workspace_id of [undefined, null, '', 42, 'x'.repeat(201)]) rejects(() => enqueue(e, { workspace_id }), 'outbox/invalid')
  assert.equal(e.stats({ workspace_id: WS }).total, 0)
})

test('claimDue leases only due work and prevents a double claim', (t) => {
  const { e } = fixture(t)
  const due = enqueue(e, { now: 1000 })
  const later = enqueue(e, { now: 2000, body: 'Later message' })
  const claimed = e.claimDue({ now: 1500, limit: 10, lease_seconds: 60 })
  assert.deepEqual(claimed.map((row) => row.id), [due.id])
  assert.equal(claimed[0].status, 'sending')
  assert.equal(claimed[0].attempts, 1)
  assert.equal(claimed[0].lease_until, 1560)
  assert.deepEqual(e.claimDue({ now: 1500, limit: 10 }), [])
  assert.deepEqual(e.claimDue({ now: 1059, lease_seconds: 60 }), [])
  assert.equal(e.stats({ workspace_id: WS }).sending, 1)
  e.markSent({ id: due.id, now: 1500 })
  assert.deepEqual(e.claimDue({ now: 2000, limit: 10 }).map((row) => row.id), [later.id])
})

test('an expired lease is reclaimable, even after another workspace has due work', (t) => {
  const { e } = fixture(t)
  const item = enqueue(e, { now: 1000 })
  assert.equal(e.claimDue({ now: 1000, lease_seconds: 60 }).length, 1)
  const reclaimed = e.claimDue({ now: 1060, lease_seconds: 60 })
  assert.deepEqual(reclaimed.map((row) => row.id), [item.id])
  assert.equal(reclaimed[0].attempts, 2)
  assert.equal(reclaimed[0].lease_until, 1120)
  assert.deepEqual(e.claimDue({ now: 1000, workspace_id: OTHER, lease_seconds: 60 }), [])
})

test('markSent is terminal and an already sent row cannot be failed or cancelled', (t) => {
  const { e } = fixture(t)
  const item = enqueue(e, { now: 1000 })
  e.claimDue({ now: 1000 })
  const sent = e.markSent({ id: item.id, now: 1001 })
  assert.equal(sent.status, 'sent')
  assert.equal(sent.sent, 1001)
  assert.equal(sent.lease_until, null)
  assert.equal(e.markFailed({ id: item.id, error: 'late', now: 1002 }).status, 'sent')
  assert.equal(e.cancel({ id: item.id, now: 1002 }).status, 'sent')
  assert.deepEqual(e.claimDue({ now: 100000 }), [])
  assert.equal(e.stats({ workspace_id: WS }).sent, 1)
})

test('retryable failures use deterministic exponential backoff and then die at max attempts', (t) => {
  const { e } = fixture(t)
  assert.equal(backoffSeconds(1), 30)
  assert.equal(backoffSeconds(2), 60)
  assert.equal(backoffSeconds(3), 120)
  assert.equal(backoffSeconds(20), MAX_BACKOFF)
  const item = enqueue(e, { now: 1000, max_attempts: 3 })
  e.claimDue({ now: 1000 })
  const failed = e.markFailed({ id: item.id, error: 'temporary failure', now: 1000, retryable: true })
  assert.equal(failed.status, 'failed')
  assert.equal(failed.attempts, 1)
  assert.equal(failed.next_attempt, 1000 + BASE_BACKOFF)
  assert.equal(failed.last_error, 'temporary failure')
  assert.equal(failed.lease_until, null)
  assert.deepEqual(e.claimDue({ now: 1000 + BASE_BACKOFF - 1 }), [])
  assert.deepEqual(e.claimDue({ now: 1000 + BASE_BACKOFF }).map((row) => row.id), [item.id])
  const second = e.markFailed({ id: item.id, error: 'still temporary', now: 1030, retryable: true })
  assert.equal(second.status, 'failed')
  assert.equal(second.next_attempt, 1030 + 60)
  assert.deepEqual(e.claimDue({ now: 1090 }).map((row) => row.id), [item.id])
  const dead = e.markFailed({ id: item.id, error: 'last failure', now: 1090, retryable: true })
  assert.equal(dead.status, 'dead')
  assert.equal(dead.attempts, 3)
  assert.equal(e.claimDue({ now: 100000 }).length, 0)
  assert.equal(e.stats({ workspace_id: WS }).dead, 1)
})

test('non-retryable failures are dead immediately', (t) => {
  const { e } = fixture(t)
  const item = enqueue(e, { now: 1000, max_attempts: 5 })
  e.claimDue({ now: 1000 })
  const dead = e.markFailed({ id: item.id, error: 'permanent failure', now: 1001, retryable: false })
  assert.equal(dead.status, 'dead')
  assert.equal(dead.last_error, 'permanent failure')
  assert.deepEqual(e.claimDue({ now: 100000 }), [])
  assert.equal(e.stats({ workspace_id: WS }).dead, 1)
})

test('cancel is terminal, idempotent and scoped to the workspace when supplied', (t) => {
  const { e } = fixture(t)
  const item = enqueue(e, { now: 1000 })
  assert.equal(e.cancel({ id: item.id, workspace_id: OTHER, now: 1001 }), null)
  const cancelled = e.cancel({ id: item.id, workspace_id: WS, now: 1001 })
  assert.equal(cancelled.status, 'dead')
  assert.equal(cancelled.last_error, 'cancelled')
  assert.deepEqual(e.claimDue({ now: 100000 }), [])
  assert.equal(e.cancel({ id: 'missing-id', now: 1002 }), null)
  assert.equal(e.cancel({ id: item.id, now: 1003 }).status, 'dead')
})

test('stats are workspace-scoped and include zero counts', (t) => {
  const { e } = fixture(t)
  enqueue(e, { now: 5000, body: 'Pending' })
  enqueue(e, { now: 1000, body: 'Sending' })
  e.claimDue({ now: 1000, limit: 10 })
  const sent = enqueue(e, { now: 1000, body: 'Sent' })
  e.claimDue({ now: 1001, limit: 10 })
  e.markSent({ id: sent.id, now: 1002 })
  const failed = enqueue(e, { now: 1000, body: 'Failed' })
  e.claimDue({ now: 1002, limit: 10 })
  e.markFailed({ id: failed.id, error: 'temporary', now: 1002, retryable: true })
  enqueue(e, { workspace_id: OTHER, now: 1000, body: 'Other workspace' })
  const stats = e.stats({ workspace_id: WS })
  assert.equal(stats.pending, 1)
  assert.equal(stats.sending, 1)
  assert.equal(stats.sent, 1)
  assert.equal(stats.failed, 1)
  assert.equal(stats.dead, 0)
  assert.equal(stats.total, 4)
  assert.equal(e.stats({ workspace_id: OTHER }).total, 1)
  assert.equal(e.stats({ workspace_id: OTHER }).sent, 0)
})

test('list filters, isolates and paginates without leaking another workspace', (t) => {
  const { e } = fixture(t)
  const first = enqueue(e, { now: 1000, body: 'First' })
  const second = enqueue(e, { now: 1001, body: 'Second' })
  const third = enqueue(e, { now: 1002, body: 'Third' })
  enqueue(e, { workspace_id: OTHER, now: 1003, body: 'Other' })
  assert.deepEqual(e.list({ workspace_id: WS, limit: 2 }).map((row) => row.id), [first.id, second.id])
  assert.deepEqual(e.list({ workspace_id: WS, limit: 2, cursor: second.id }).map((row) => row.id), [third.id])
  e.claimDue({ now: 1000, limit: 1 })
  assert.deepEqual(e.list({ workspace_id: WS, status: 'sending', limit: 10 }).map((row) => row.id), [first.id])
  assert.deepEqual(e.list({ workspace_id: OTHER }).map((row) => row.body), ['Other'])
  rejects(() => e.list({ workspace_id: WS, status: 'unknown' }), 'outbox/invalid')
  rejects(() => e.list({ workspace_id: WS, limit: -1 }), 'outbox/invalid')
})

test('oversize or non-JSON fields are rejected with a typed error', (t) => {
  const { e } = fixture(t)
  const cases = [
    [{ recipient: 'a'.repeat(LIMITS.RECIPIENT + 1) }, 'outbox/too-large'],
    [{ subject: 's'.repeat(LIMITS.SUBJECT + 1) }, 'outbox/too-large'],
    [{ body: 'b'.repeat(LIMITS.BODY + 1) }, 'outbox/too-large'],
    [{ payload: { blob: 'p'.repeat(LIMITS.PAYLOAD + 1) } }, 'outbox/too-large'],
    [{ idempotency_key: 'k'.repeat(LIMITS.IDEMPOTENCY_KEY + 1) }, 'outbox/too-large'],
    [{ payload: { when: 1n } }, 'outbox/invalid'],
  ]
  for (const [fields, code] of cases) rejects(() => enqueue(e, fields), code)
  const circular = {}
  circular.self = circular
  rejects(() => enqueue(e, { payload: circular }), 'outbox/invalid')
  assert.equal(e.stats({ workspace_id: WS }).total, 0)
})

test('markSent and markFailed respect a supplied workspace scope', (t) => {
  const { e } = fixture(t)
  const item = enqueue(e, { now: 1000 })
  e.claimDue({ now: 1000 })
  assert.equal(e.markSent({ id: item.id, workspace_id: OTHER, now: 1001 }), null)
  assert.equal(e.markFailed({ id: item.id, workspace_id: OTHER, error: 'x', now: 1001 }), null)
  assert.equal(e.markSent({ id: item.id, workspace_id: WS, now: 1001 }).status, 'sent')
  assert.equal(e.stats({ workspace_id: WS }).sent, 1)
})
