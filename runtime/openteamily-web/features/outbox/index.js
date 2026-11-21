import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { FeatureError, stableJson } from '../../featurekit/http.js'
import { openStore } from '../../featurekit/store.js'

export const CHANNELS = Object.freeze(['email', 'webhook', 'push'])
export const STATUSES = Object.freeze(['pending', 'sending', 'sent', 'failed', 'dead'])
export const LIMITS = Object.freeze({
  RECIPIENT: 1024,
  SUBJECT: 512,
  BODY: 64 * 1024,
  PAYLOAD: 32 * 1024,
  IDEMPOTENCY_KEY: 200,
  ERROR: 2000,
  LIMIT: 1000,
  WORKSPACE: 200,
})
export const BASE_BACKOFF = 30
export const MAX_BACKOFF = 3600
export const DEFAULT_MAX_ATTEMPTS = 5

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS outbox_messages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN ('email','webhook','push')),
  recipient TEXT NOT NULL,
  subject TEXT,
  body TEXT NOT NULL,
  payload TEXT,
  idempotency_key TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','sending','sent','failed','dead')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK(max_attempts >= 1),
  next_attempt INTEGER NOT NULL,
  lease_until INTEGER,
  last_error TEXT,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  sent INTEGER,
  UNIQUE(workspace_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS outbox_messages_due
  ON outbox_messages(status, next_attempt, lease_until, created, id);
CREATE INDEX IF NOT EXISTS outbox_messages_workspace
  ON outbox_messages(workspace_id, status, created, id);
`

const fail = (code, message, status = 400) => {
  throw new FeatureError(status, `outbox/${code}`, message)
}

const nowSeconds = () => Math.floor(Date.now() / 1000)

export function ensureSchema(store) {
  store.migrate('outbox', [SCHEMA_SQL])
}

export function backoffSeconds(attempts) {
  const value = Number(attempts)
  const attempt = Number.isInteger(value) ? value : 1
  const exponent = Math.min(Math.max(attempt - 1, 0), 16)
  return Math.min(MAX_BACKOFF, BASE_BACKOFF * (2 ** exponent))
}

function integer(value, name, { fallback, min, max } = {}) {
  if (value === undefined || value === null) value = fallback
  else if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) value = Number(value)
  if (!Number.isInteger(value)) fail('invalid', `${name} must be an integer`)
  if (min !== undefined && value < min) fail('invalid', `${name} must be at least ${min}`)
  if (max !== undefined && value > max) fail('invalid', `${name} must be at most ${max}`)
  return value
}

function workspaceId(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > LIMITS.WORKSPACE) {
    fail('invalid', 'workspace_id is required')
  }
  return value
}

function optionalWorkspace(value) {
  return value === undefined || value === null ? null : workspaceId(value)
}

function textField(value, name, limit, { allowNone = false, allowEmpty = true } = {}) {
  if (value === undefined || value === null) {
    if (allowNone) return null
    fail('invalid', `${name} is required`)
  }
  if (typeof value !== 'string') fail('invalid', `${name} must be a string`)
  if (!allowEmpty && value.length === 0) fail('invalid', `${name} must not be empty`)
  if (value.length > limit) fail('too-large', `${name} exceeds ${limit} characters`, 413)
  return value
}

function serializePayload(value) {
  if (value === undefined || value === null) return null
  try {
    const checked = JSON.stringify(value, (key, item) => {
      if (typeof item === 'bigint' || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'undefined') {
        throw new TypeError('unsupported JSON value')
      }
      if (typeof item === 'number' && !Number.isFinite(item)) throw new TypeError('non-finite number')
      return item
    })
    if (typeof checked !== 'string') fail('invalid', 'payload must be JSON-serializable')
  } catch {
    fail('invalid', 'payload must be JSON-serializable')
  }
  const text = stableJson(value)
  if (text.length > LIMITS.PAYLOAD) fail('too-large', `payload exceeds ${LIMITS.PAYLOAD} characters`, 413)
  return text
}

function decodePayload(text) {
  if (text === null || text === undefined) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export function view(row) {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    channel: row.channel,
    recipient: row.recipient,
    subject: row.subject,
    body: row.body,
    payload: decodePayload(row.payload),
    idempotency_key: row.idempotency_key,
    status: row.status,
    attempts: row.attempts,
    max_attempts: row.max_attempts,
    next_attempt: row.next_attempt,
    lease_until: row.lease_until,
    last_error: row.last_error,
    created: row.created,
    updated: row.updated,
    sent: row.sent,
  }
}

const load = (store, id, workspace = null) => {
  if (typeof id !== 'string' || id.length < 1) fail('invalid', 'id is required')
  return workspace === null
    ? store.get('SELECT * FROM outbox_messages WHERE id=?', id)
    : store.get('SELECT * FROM outbox_messages WHERE id=? AND workspace_id=?', id, workspace)
}

export default function outboxFeature(host) {
  const store = openStore(join(host.featureDir(), 'outbox.sqlite3'))
  ensureSchema(store)

  const endpoints = {
    enqueue(payload) {
      const input = payload ?? {}
      const workspace = workspaceId(input.workspace_id)
      const channel = input.channel
      if (!CHANNELS.includes(channel)) fail('invalid', `channel must be one of ${CHANNELS.join(', ')}`)
      const recipient = textField(input.recipient, 'recipient', LIMITS.RECIPIENT, { allowEmpty: false })
      const subject = textField(input.subject, 'subject', LIMITS.SUBJECT, { allowNone: true })
      const body = textField(input.body, 'body', LIMITS.BODY)
      const messagePayload = serializePayload(input.payload)
      const idempotencyKey = textField(input.idempotency_key, 'idempotency_key', LIMITS.IDEMPOTENCY_KEY, {
        allowNone: true,
        allowEmpty: false,
      })
      const maxAttempts = integer(input.max_attempts, 'max_attempts', { fallback: DEFAULT_MAX_ATTEMPTS, min: 1 })
      const now = integer(input.now, 'now', { fallback: nowSeconds() })
      const id = randomBytes(16).toString('hex')

      store.run(
        'INSERT OR IGNORE INTO outbox_messages '
        + '(id,workspace_id,channel,recipient,subject,body,payload,idempotency_key,status,attempts,max_attempts,'
        + 'next_attempt,lease_until,last_error,created,updated,sent) '
        + 'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        id, workspace, channel, recipient, subject, body, messagePayload, idempotencyKey, 'pending',
        0, maxAttempts, now, null, null, now, now, null,
      )
      const row = idempotencyKey === null
        ? store.get('SELECT * FROM outbox_messages WHERE id=?', id)
        : store.get('SELECT * FROM outbox_messages WHERE workspace_id=? AND idempotency_key=?', workspace, idempotencyKey)
      return view(row)
    },

    claimDue(payload) {
      const input = payload ?? {}
      const now = integer(input.now, 'now', { fallback: nowSeconds() })
      const limit = integer(input.limit, 'limit', { fallback: 20, min: 0, max: LIMITS.LIMIT })
      const leaseSeconds = integer(input.lease_seconds, 'lease_seconds', { fallback: 60, min: 1 })
      const workspace = optionalWorkspace(input.workspace_id)
      if (limit === 0) return []

      return store.transaction((tx) => {
        const scoped = workspace === null ? '' : ' AND workspace_id=?'
        const scopeArg = workspace === null ? [] : [workspace]
        tx.run(
          'UPDATE outbox_messages SET status=?, lease_until=NULL, '
          + 'last_error=COALESCE(last_error, ?), updated=? '
          + 'WHERE status=? AND attempts >= max_attempts '
          + 'AND lease_until IS NOT NULL AND lease_until <= ?' + scoped,
          'dead', 'lease expired after final attempt', now, 'sending', now, ...scopeArg,
        )
        const rows = tx.all(
          'SELECT id FROM outbox_messages '
          + 'WHERE status IN (?,?,?) AND attempts < max_attempts '
          + 'AND next_attempt <= ? AND (lease_until IS NULL OR lease_until <= ?) '
          + 'AND (status <> ? OR lease_until IS NOT NULL)' + scoped
          + ' ORDER BY next_attempt, created, id LIMIT ?',
          'pending', 'failed', 'sending', now, now, 'sending', ...scopeArg, limit,
        )
        const ids = rows.map((row) => row.id)
        for (const id of ids) {
          tx.run(
            'UPDATE outbox_messages SET status=?, attempts=attempts+1, lease_until=?, updated=? WHERE id=?',
            'sending', now + leaseSeconds, now, id,
          )
        }
        if (!ids.length) return []
        return tx.all(
          `SELECT * FROM outbox_messages WHERE id IN (${ids.map(() => '?').join(',')}) `
          + 'ORDER BY next_attempt, created, id',
          ...ids,
        ).map(view)
      })
    },

    markSent(payload) {
      const input = payload ?? {}
      const now = integer(input.now, 'now', { fallback: nowSeconds() })
      const workspace = optionalWorkspace(input.workspace_id)
      return store.transaction((tx) => {
        const row = load(tx, input.id, workspace)
        if (!row) return null
        if (row.status === 'sent' || row.status === 'dead') return view(row)
        tx.run(
          'UPDATE outbox_messages SET status=?, sent=?, updated=?, lease_until=NULL, last_error=NULL WHERE id=?',
          'sent', now, now, row.id,
        )
        return view(tx.get('SELECT * FROM outbox_messages WHERE id=?', row.id))
      })
    },

    markFailed(payload) {
      const input = payload ?? {}
      const now = integer(input.now, 'now', { fallback: nowSeconds() })
      const workspace = optionalWorkspace(input.workspace_id)
      const retryable = input.retryable === undefined ? true : Boolean(input.retryable)
      const message = (input.error === undefined || input.error === null ? '' : String(input.error)).slice(0, LIMITS.ERROR)
      return store.transaction((tx) => {
        const row = load(tx, input.id, workspace)
        if (!row) return null
        if (row.status === 'sent' || row.status === 'dead') return view(row)
        const exhausted = !retryable || row.attempts >= row.max_attempts
        const status = exhausted ? 'dead' : 'failed'
        const nextAttempt = exhausted ? row.next_attempt : now + backoffSeconds(row.attempts)
        tx.run(
          'UPDATE outbox_messages SET status=?, next_attempt=?, lease_until=NULL, last_error=?, updated=? WHERE id=?',
          status, nextAttempt, message, now, row.id,
        )
        return view(tx.get('SELECT * FROM outbox_messages WHERE id=?', row.id))
      })
    },

    cancel(payload) {
      const input = payload ?? {}
      const now = integer(input.now, 'now', { fallback: nowSeconds() })
      const workspace = optionalWorkspace(input.workspace_id)
      return store.transaction((tx) => {
        const row = load(tx, input.id, workspace)
        if (!row) return null
        if (row.status === 'sent' || row.status === 'dead') return view(row)
        tx.run(
          'UPDATE outbox_messages SET status=?, lease_until=NULL, last_error=?, updated=? WHERE id=?',
          'dead', 'cancelled', now, row.id,
        )
        return view(tx.get('SELECT * FROM outbox_messages WHERE id=?', row.id))
      })
    },

    stats(payload) {
      const input = payload ?? {}
      const workspace = workspaceId(input.workspace_id)
      const counts = Object.fromEntries(STATUSES.map((status) => [status, 0]))
      for (const row of store.all(
        'SELECT status, COUNT(*) AS count FROM outbox_messages WHERE workspace_id=? GROUP BY status',
        workspace,
      )) {
        if (Object.hasOwn(counts, row.status)) counts[row.status] = Number(row.count)
      }
      counts.total = STATUSES.reduce((sum, status) => sum + counts[status], 0)
      return counts
    },

    list(payload) {
      const input = payload ?? {}
      const workspace = workspaceId(input.workspace_id)
      const status = input.status === undefined || input.status === null ? null : input.status
      if (status !== null && !STATUSES.includes(status)) fail('invalid', `status must be one of ${STATUSES.join(', ')}`)
      const limit = integer(input.limit, 'limit', { fallback: 50, min: 0, max: LIMITS.LIMIT })
      const cursor = input.cursor
      if (cursor !== undefined && cursor !== null && typeof cursor !== 'string') fail('invalid', 'cursor must be a string')
      if (limit === 0) return []

      let sql = 'SELECT * FROM outbox_messages WHERE workspace_id=?'
      const args = [workspace]
      if (status !== null) {
        sql += ' AND status=?'
        args.push(status)
      }
      if (cursor) {
        const cursorRow = store.get(
          'SELECT created, id FROM outbox_messages WHERE id=? AND workspace_id=?',
          cursor, workspace,
        )
        if (!cursorRow) {
          sql += ' AND id > ?'
          args.push(cursor)
        } else {
          sql += ' AND (created > ? OR (created = ? AND id > ?))'
          args.push(cursorRow.created, cursorRow.created, cursorRow.id)
        }
      }
      sql += ' ORDER BY created, id LIMIT ?'
      args.push(limit)
      return store.all(sql, ...args).map(view)
    },
  }

  return { endpoints, store }
}
