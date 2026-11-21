import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { stableJson } from '../../featurekit/http.js'
import { openStore } from '../../featurekit/store.js'

export const MAX_BODY_BYTES = 64 * 1024
export const MAX_NAME = 80
export const MAX_SECRET_REF = 200
export const MAX_TIMESTAMP = 20
export const MAX_EVENT_KIND = 80
export const DEFAULT_TOLERANCE = 300
export const DEFAULT_LIMIT = 20
export const MAX_LIMIT = 100
export const MAX_WORKSPACE = 200
export const MAX_ID = 100

const TIMESTAMP = /^[0-9]{1,20}$/
const SIGNATURE = /^[0-9a-fA-F]{64}$/
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/
const EVENT_KEYS = ['event_type', 'type', 'event', 'kind']
const textDecoder = new TextDecoder('utf-8', { fatal: true })

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  secret_ref TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  UNIQUE(workspace_id, name));
CREATE INDEX IF NOT EXISTS webhook_endpoint_list ON webhook_endpoints(workspace_id, id);
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  signature TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  received INTEGER NOT NULL,
  UNIQUE(workspace_id, endpoint_id, body_hash));
CREATE INDEX IF NOT EXISTS webhook_delivery_list ON webhook_deliveries(workspace_id, endpoint_id, id);
CREATE INDEX IF NOT EXISTS webhook_delivery_workspace ON webhook_deliveries(workspace_id, id);
PRAGMA user_version=1;
`

export const SCHEMA_SQL = SCHEMA

export function fail(code, message, status = 400) {
  throw Object.assign(new Error(message), { code: `webhooks/${code}`, status })
}

export function ensureSchema(db) {
  if (typeof db?.migrate === 'function') {
    db.migrate('webhooks', [SCHEMA])
    return
  }
  if (typeof db?.exec !== 'function') throw new TypeError('webhooks: a SQLite database is required')
  db.exec('PRAGMA foreign_keys=ON')
  db.exec(SCHEMA)
}

const nowSeconds = () => Math.floor(Date.now() / 1000)
const points = (value) => [...value].length
const isBytes = (value) => Buffer.isBuffer(value) || value instanceof Uint8Array || value instanceof ArrayBuffer
const isBufferObject = (value) => value && typeof value === 'object' && value.type === 'Buffer' && Array.isArray(value.data)
  && value.data.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
const toBuffer = (value) => Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : isBufferObject(value) ? value.data : value)

function bodyValue(payload) {
  if (payload === undefined || payload === null) return {}
  if (typeof payload !== 'object' || Array.isArray(payload)) fail('invalid', 'payload object required')
  return payload
}

function stringField(value, label, limit) {
  if (typeof value !== 'string') fail('invalid', `${label} must be a string`)
  const text = value.trim()
  if (points(text) < 1 || points(text) > limit || CONTROL.test(value)) {
    fail('invalid', `${label} must be 1..${limit} characters without control characters`)
  }
  return text
}

function workspaceValue(payload) {
  const value = payload.workspace_id
  if (typeof value !== 'string' || points(value) < 1 || points(value) > MAX_WORKSPACE || CONTROL.test(value)) {
    fail('invalid', `workspace_id must be 1..${MAX_WORKSPACE} characters without control characters`)
  }
  return value
}

function idValue(value, label) {
  if (typeof value !== 'string') fail('invalid', `${label} must be a string`)
  if (points(value) < 1 || points(value) > MAX_ID || CONTROL.test(value)) {
    fail('invalid', `${label} must be 1..${MAX_ID} characters without control characters`)
  }
  return value
}

function integerValue(value, label, fallback) {
  if (value === undefined || value === null) value = fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    fail('invalid', `${label} must be a non-negative integer`)
  }
  return value
}

function toleranceValue(value) {
  return integerValue(value, 'tolerance_seconds', DEFAULT_TOLERANCE)
}

function limitValue(value) {
  if (value === undefined || value === null) return DEFAULT_LIMIT
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    fail('invalid', `limit must be an integer in 1..${MAX_LIMIT}`)
  }
  return value
}

function cursorValue(value) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string' || points(value) > MAX_ID || CONTROL.test(value)) {
    fail('invalid', 'cursor must be a bounded string')
  }
  return value
}

function secretBytes(value) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8')
  if (isBytes(value) || isBufferObject(value)) return toBuffer(value)
  fail('invalid', 'webhook secret must be text or bytes')
}

function bodyBytes(value) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8')
  if (isBytes(value) || isBufferObject(value)) return toBuffer(value)
  fail('invalid', 'webhook body must be text or bytes')
}

function timestampText(value) {
  if (typeof value === 'number' && Number.isInteger(value) && !Number.isNaN(value)) return String(value)
  if (typeof value === 'string') return value
  fail('invalid', 'invalid webhook timestamp')
}

function signatureText(value) {
  if (isBytes(value) || isBufferObject(value)) value = toBuffer(value).toString('ascii')
  if (typeof value !== 'string' || !SIGNATURE.test(value)) fail('invalid', 'invalid webhook signature')
  return value
}

function parsePayload(bytes) {
  let text
  try {
    text = textDecoder.decode(bytes)
  } catch {
    fail('invalid', 'webhook body must be valid JSON')
  }
  try {
    return JSON.parse(text)
  } catch {
    fail('invalid', 'webhook body must be valid JSON')
  }
}

export function eventKind(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    for (const key of EVENT_KEYS) {
      const value = payload[key]
      if (typeof value !== 'string') continue
      const kind = value.trim()
      if (kind && points(kind) <= MAX_EVENT_KIND && !CONTROL.test(kind)) return kind
    }
  }
  return 'unknown'
}

export function sign(secret, timestamp, body) {
  const secretBuffer = secretBytes(secret)
  const timestampString = timestampText(timestamp)
  const bodyBuffer = bodyBytes(body)
  return createHmac('sha256', secretBuffer)
    .update(Buffer.from(`${timestampString}.`, 'utf8'))
    .update(bodyBuffer)
    .digest('hex')
}

export function verify(secret, timestamp, body, signature, now, toleranceSeconds = DEFAULT_TOLERANCE) {
  const tolerance = toleranceValue(toleranceSeconds)
  let secretBuffer
  let timestampString
  let bodyBuffer
  let signatureString
  try {
    secretBuffer = secretBytes(secret)
    timestampString = timestampText(timestamp)
    bodyBuffer = bodyBytes(body)
    signatureString = signatureText(signature)
  } catch {
    return false
  }
  if (!TIMESTAMP.test(timestampString)) return false
  if (typeof now === 'boolean') return false
  const nowNumber = typeof now === 'number' ? now : Number(now)
  if (!Number.isFinite(nowNumber)) return false
  const signedAt = Number(timestampString)
  if (!Number.isSafeInteger(signedAt)) return false
  if (Math.abs(nowNumber - signedAt) > tolerance) return false
  const expected = createHmac('sha256', secretBuffer)
    .update(Buffer.from(`${timestampString}.`, 'utf8'))
    .update(bodyBuffer)
    .digest()
  const supplied = Buffer.from(signatureString.toLowerCase(), 'hex')
  return supplied.length === expected.length && timingSafeEqual(expected, supplied)
}

const endpointView = (row) => ({
  id: row.id,
  workspace_id: row.workspace_id,
  name: row.name,
  secret_ref: row.secret_ref,
  enabled: Boolean(row.enabled),
  created: row.created,
  updated: row.updated,
})

const deliveryView = (row) => ({
  id: row.id,
  workspace_id: row.workspace_id,
  endpoint_id: row.endpoint_id,
  signature: row.signature,
  timestamp: row.timestamp,
  body_hash: row.body_hash,
  event_kind: row.event_kind,
  payload: JSON.parse(row.payload),
  received: row.received,
})

export function createWebhooks({ db, clock = nowSeconds } = {}) {
  if (!db) throw new TypeError('webhooks: a SQLite database is required')
  ensureSchema(db)
  const one = (sql, ...args) => (typeof db.prepare === 'function' ? db.prepare(sql).get(...args) : db.get(sql, ...args)) ?? null
  const all = (sql, ...args) => (typeof db.prepare === 'function' ? db.prepare(sql).all(...args) : db.all(sql, ...args))
  const run = (sql, ...args) => (typeof db.prepare === 'function' ? db.prepare(sql).run(...args) : db.run(sql, ...args))
  const transaction = (fn) => {
    if (typeof db.transaction === 'function') return db.transaction(fn)
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      db.exec('COMMIT')
      return result
    } catch (error) {
      try { db.exec('ROLLBACK') } catch {}
      throw error
    }
  }
  const loadEndpoint = (workspaceId, endpointId) => one(
    'SELECT * FROM webhook_endpoints WHERE id=? AND workspace_id=?',
    endpointId,
    workspaceId,
  )

  const endpoints = {
    async register(payload) {
      const p = bodyValue(payload)
      const workspaceId = workspaceValue(p)
      const name = stringField(p.name, 'name', MAX_NAME)
      const secretRef = stringField(p.secret_ref ?? p.secretRef, 'secret_ref', MAX_SECRET_REF)
      const stamp = integerValue(p.now, 'now', clock())
      const id = randomBytes(16).toString('hex')
      return transaction(() => {
        if (one('SELECT id FROM webhook_endpoints WHERE workspace_id=? AND name=?', workspaceId, name)) {
          fail('conflict', 'webhook endpoint name already exists', 409)
        }
        run(
          'INSERT INTO webhook_endpoints (id,workspace_id,name,secret_ref,enabled,created,updated) VALUES (?,?,?,?,1,?,?)',
          id, workspaceId, name, secretRef, stamp, stamp,
        )
        return endpointView(loadEndpoint(workspaceId, id))
      })
    },

    async list(payload) {
      const p = bodyValue(payload)
      const workspaceId = workspaceValue(p)
      const items = all('SELECT * FROM webhook_endpoints WHERE workspace_id=? ORDER BY id', workspaceId)
        .map(endpointView)
      return { items }
    },

    async disable(payload) {
      const p = bodyValue(payload)
      const workspaceId = workspaceValue(p)
      const endpointId = idValue(p.endpoint_id ?? p.id, 'endpoint_id')
      const stamp = integerValue(p.now, 'now', clock())
      return transaction(() => {
        const result = run(
          'UPDATE webhook_endpoints SET enabled=0, updated=? WHERE id=? AND workspace_id=?',
          stamp, endpointId, workspaceId,
        )
        if (Number(result?.changes ?? 0) !== 1) fail('not-found', 'webhook endpoint not found', 404)
        return endpointView(loadEndpoint(workspaceId, endpointId))
      })
    },

    async ingest(payload) {
      const p = bodyValue(payload)
      const workspaceId = workspaceValue(p)
      const endpointId = idValue(p.endpoint_id ?? p.id, 'endpoint_id')
      const stamp = integerValue(p.now, 'now', clock())
      const tolerance = toleranceValue(p.tolerance_seconds)
      const row = loadEndpoint(workspaceId, endpointId)
      if (!row) fail('forbidden', 'unknown webhook endpoint', 403)
      if (!row.enabled) fail('forbidden', 'webhook endpoint is disabled', 403)
      const body = bodyBytes(p.body ?? p.raw_body ?? p.rawBody)
      if (body.length > MAX_BODY_BYTES) fail('too-large', 'webhook body is too large', 413)
      if (!verify(p.secret, p.timestamp, body, p.signature, stamp, tolerance)) {
        fail('forbidden', 'invalid webhook signature or timestamp', 403)
      }
      const parsed = parsePayload(body)
      const bodyHash = createHash('sha256').update(body).digest('hex')
      const signature = signatureText(p.signature)
      const timestamp = timestampText(p.timestamp)
      return transaction(() => {
        const existing = one(
          'SELECT * FROM webhook_deliveries WHERE workspace_id=? AND endpoint_id=? AND body_hash=?',
          workspaceId, endpointId, bodyHash,
        )
        if (existing) return deliveryView(existing)
        const id = randomBytes(16).toString('hex')
        run(
          'INSERT INTO webhook_deliveries (id,workspace_id,endpoint_id,signature,timestamp,body_hash,event_kind,payload,received) '
          + 'VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id, endpoint_id, body_hash) DO NOTHING',
          id, workspaceId, endpointId, signature, timestamp, bodyHash, eventKind(parsed), stableJson(parsed), stamp,
        )
        return deliveryView(one(
          'SELECT * FROM webhook_deliveries WHERE workspace_id=? AND endpoint_id=? AND body_hash=?',
          workspaceId, endpointId, bodyHash,
        ))
      })
    },

    async deliveries(payload) {
      const p = bodyValue(payload)
      const workspaceId = workspaceValue(p)
      const limit = limitValue(p.limit)
      const cursor = cursorValue(p.cursor)
      const endpointId = p.endpoint_id === undefined || p.endpoint_id === null
        ? null
        : idValue(p.endpoint_id, 'endpoint_id')
      const rows = endpointId === null
        ? all('SELECT * FROM webhook_deliveries WHERE workspace_id=? AND id>? ORDER BY id LIMIT ?', workspaceId, cursor, limit + 1)
        : all('SELECT * FROM webhook_deliveries WHERE workspace_id=? AND endpoint_id=? AND id>? ORDER BY id LIMIT ?',
          workspaceId, endpointId, cursor, limit + 1)
      const items = rows.slice(0, limit).map(deliveryView)
      const next = rows.length > limit && items.length ? items[items.length - 1].id : null
      return { items, cursor: next, next_cursor: next }
    },
  }

  return { endpoints }
}

export const event_kind = eventKind
export const ensure_schema = ensureSchema

export default function webhooks(host) {
  const store = openStore(join(host.featureDir(), 'webhooks.sqlite3'))
  ensureSchema(store)
  return { endpoints: createWebhooks({ db: store.db }).endpoints, store }
}
