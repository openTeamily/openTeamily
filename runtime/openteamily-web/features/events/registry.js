// Outbound event subscription registry inside this user's DS-Bot (#490).
//
// Stores which workspace event kinds a future outbox should deliver where, the
// per-subscription filter the event must satisfy, and an idempotent record of
// delivery attempts. This module does not send HTTP, sign payloads, retry,
// queue an outbox or accept inbound webhooks.
//
// Hard rule 1 — endpoint safety. `endpoint` must be a public HTTPS URL. This
// registry refuses loopback, RFC1918, link-local, unique-local, unspecified and
// IPv4-mapped private literals plus `localhost`/`.local` names. A host name can
// still resolve to a private address later (DNS rebinding), so the outbox slice
// MUST re-run the address check on the resolved IP immediately before delivery;
// that recheck is a hard precondition of delivery, not of this registry.
//
// Hard rule 2 — secrets stay outside. `secret_ref` is an opaque pointer to a
// secret held elsewhere (a ``scheme://`` reference). A plaintext value, a
// `secret` field, or a bare key-looking string is refused; nothing secret is
// accepted, stored, or echoed by `view()`.
import { isIP } from 'node:net'
import { refuse, newId, nowSeconds, stableJson } from '../../featurekit/http.js'

// The kinds Bot Social emits (services/bot-social/src/openteamily/*.ts):
// artifact.shared, discover.published|conversation_started, follow.new,
// meeting.shared, messenger.mention|added|call, team.run_shared|join_request|
// member_joined|membership_changed|owner_transferred|removed|join_decided.
//
// This list is checked against the shipped notification catalog
// (features/notifications/templates.js `KINDS`) by
// test/event-kind-catalog.test.js, so a kind Bot Social starts emitting fails
// that test instead of being silently refused here. Never add a kind on one
// side only.
export const KINDS = Object.freeze([
  'artifact.shared', 'discover.conversation_started', 'discover.published', 'follow.new',
  'meeting.shared', 'messenger.added', 'messenger.call', 'messenger.mention',
  'team.join_decided', 'team.join_request', 'team.member_joined',
  'team.membership_changed', 'team.owner_transferred', 'team.removed', 'team.run_shared',
])
const KIND_SET = new Set(KINDS)

export const MAX_ENDPOINT = 2048
export const MAX_HOST = 253
export const MAX_NAME = 80
export const MAX_KINDS = 50
export const MAX_FILTER_KEYS = 20
export const MAX_FILTER_KEY = 64
export const MAX_FILTER_STRING = 256
export const MAX_FILTER_IN = 50
export const MAX_FILTER_JSON = 4096
export const MAX_SECRET_REF = 256
export const MAX_EVENT_KEY = 256
export const MAX_LIST = 1000

const CONTROL = /[\x00-\x1f\x7f-\x9f]/
const FILTER_KEY = /^[A-Za-z0-9_.-]{1,64}$/
const SECRET_REF = /^[a-z][a-z0-9+.-]*:\/\/[^\s]+$/i
const MISSING = Symbol('missing')
const OWNER = 'owner'

export const MIGRATIONS = [`
CREATE TABLE IF NOT EXISTS event_subscriptions (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL,
 name TEXT NOT NULL,
 endpoint TEXT NOT NULL,
 secret_ref TEXT,
 kinds TEXT NOT NULL,
 filters TEXT NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL,
 last_delivery INTEGER,
 UNIQUE(owner_id, name));
CREATE INDEX IF NOT EXISTS event_subscription_owner
 ON event_subscriptions(owner_id, enabled, id);
CREATE TABLE IF NOT EXISTS event_delivery_records (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL,
 subscription_id TEXT NOT NULL REFERENCES event_subscriptions(id) ON DELETE CASCADE,
 event_kind TEXT NOT NULL,
 event_key TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('delivered','failed')),
 created INTEGER NOT NULL,
 UNIQUE(owner_id, subscription_id, event_key));
CREATE INDEX IF NOT EXISTS event_delivery_record_lookup
 ON event_delivery_records(owner_id, subscription_id, created);
CREATE INDEX IF NOT EXISTS event_delivery_record_kind
 ON event_delivery_records(owner_id, event_kind, created);
`]

const invalid = (message) => refuse(400, 'events/invalid', message)
const notFound = (message = 'Subscription not found') => refuse(404, 'events/not-found', message)

function octets(host) {
  return host.split('.').map((part) => Number(part))
}

function privateIpv4(host) {
  const [a, b] = octets(host)
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a >= 224) return true // multicast + reserved
  return false
}

function privateIpv6(raw) {
  const host = raw.toLowerCase()
  if (host === '::' || host === '::1') return true
  if (/^::ffff:/.test(host)) {
    const tail = host.slice('::ffff:'.length)
    if (isIP(tail) === 4) return privateIpv4(tail)
    // ::ffff:7f00:1 — the last two hextets are the IPv4 address.
    const groups = tail.split(':')
    if (groups.length === 2) {
      const high = parseInt(groups[0], 16)
      const low = parseInt(groups[1], 16)
      if (Number.isInteger(high) && Number.isInteger(low)) {
        return privateIpv4([(high >> 8) & 255, high & 255, (low >> 8) & 255, low & 255].join('.'))
      }
    }
    return true
  }
  const first = parseInt(host.split(':')[0] || '0', 16)
  if (first >= 0xfc00 && first <= 0xfdff) return true // fc00::/7 unique local
  if (first >= 0xfe80 && first <= 0xfebf) return true // fe80::/10 link local
  return false
}

export function isPublicHost(hostname) {
  const name = String(hostname || '').toLowerCase().replace(/\.$/, '')
  if (!name) return false
  if (name === 'localhost' || name.endsWith('.localhost')) return false
  if (name.endsWith('.local')) return false
  const bare = name.startsWith('[') && name.endsWith(']') ? name.slice(1, -1) : name
  const version = isIP(bare)
  if (version === 4) return !privateIpv4(bare)
  if (version === 6) return !privateIpv6(bare)
  return true
}

export function validateEndpoint(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_ENDPOINT) {
    invalid('Endpoint must be a bounded HTTPS URL')
  }
  if (CONTROL.test(value) || /\s/.test(value)) invalid('Endpoint must not contain whitespace or control characters')
  // Require the host right after the scheme: https:///host must not be read as
  // https://host.
  if (!/^https:\/\/[^/]/i.test(value)) invalid('Endpoint must be an HTTPS URL with a host')
  let url
  try {
    url = new URL(value)
    void url.port // throws on an out-of-range port
  } catch {
    invalid('Endpoint is not a valid HTTPS URL')
  }
  if (url.protocol !== 'https:' || !url.hostname) invalid('Endpoint must be an HTTPS URL with a host')
  if (url.hostname.length > MAX_HOST) invalid('Endpoint host is too long')
  if (url.username !== '' || url.password !== '') invalid('Endpoint must not embed credentials; use secret_ref')
  if (url.hash) invalid('Endpoint must not contain a fragment')
  if (!isPublicHost(url.hostname)) {
    invalid('Endpoint must be a public HTTPS URL; loopback, private, link-local and .local hosts are refused')
  }
  return value
}

export function validateName(value) {
  if (typeof value !== 'string') invalid('Subscription name must be text')
  const name = value.trim()
  if (name.length < 1 || name.length > MAX_NAME || CONTROL.test(name)) {
    invalid('Subscription name must be 1-80 characters without control characters')
  }
  return name
}

function validateKind(value) {
  if (typeof value !== 'string') invalid('Event kind must be text')
  const kind = value.trim()
  if (!KIND_SET.has(kind)) invalid(`Unknown event kind: ${kind.slice(0, 64)}`)
  return kind
}

export function validateKinds(kinds) {
  if (!Array.isArray(kinds)) invalid('Kinds must be a list')
  const normalized = []
  for (const value of kinds) {
    const kind = validateKind(value)
    if (!normalized.includes(kind)) normalized.push(kind)
  }
  if (normalized.length < 1 || normalized.length > MAX_KINDS) invalid('Kinds must contain 1-50 distinct values')
  return normalized
}

export function validateSecretRef(value) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') invalid('secret_ref must be text')
  const reference = value.trim()
  if (reference.length < 1 || reference.length > MAX_SECRET_REF || CONTROL.test(reference)) {
    invalid('secret_ref must be 1-256 characters without control characters')
  }
  if (!SECRET_REF.test(reference)) {
    invalid('secret_ref must be an opaque scheme:// reference, never a plaintext secret')
  }
  // Hard rule 2 covers the reference itself: a pointer that embeds userinfo, a
  // query or a fragment carries secret material in plaintext, would be stored
  // verbatim and echoed back by view(). A pointer names where the secret lives,
  // it never carries it.
  let url
  try {
    url = new URL(reference)
  } catch {
    invalid('secret_ref must be an opaque scheme:// reference, never a plaintext secret')
  }
  if (url.username !== '' || url.password !== '') {
    invalid('secret_ref must not embed credentials; store a pointer to the secret instead')
  }
  if (url.search !== '' || url.hash !== '') {
    invalid('secret_ref must not carry a query or fragment; store a pointer to the secret instead')
  }
  return reference
}

function scalar(value) {
  if (value === null) return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid('Filter numbers must be finite')
    return value
  }
  if (typeof value === 'string') {
    if (value.length > MAX_FILTER_STRING || CONTROL.test(value)) {
      invalid('Filter strings must be at most 256 characters without controls')
    }
    return value
  }
  invalid('Filter values must be scalar JSON values')
}

export function normalizeFilters(filters) {
  if (filters === undefined || filters === null) filters = {}
  if (typeof filters !== 'object' || Array.isArray(filters) || Object.keys(filters).length > MAX_FILTER_KEYS) {
    invalid('Filters must be an object with at most 20 keys')
  }
  const normalized = {}
  for (const [key, value] of Object.entries(filters)) {
    if (typeof key !== 'string' || !FILTER_KEY.test(key) || key.length > MAX_FILTER_KEY) {
      invalid('Filter keys must be 1-64 letters, digits, dot, underscore or dash')
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (Object.keys(value).length !== 1 || !Array.isArray(value.in)) {
        invalid('Filter objects must have exactly an "in" list')
      }
      if (value.in.length < 1 || value.in.length > MAX_FILTER_IN) {
        invalid('Filter "in" lists must contain 1-50 values')
      }
      normalized[key] = { in: value.in.map(scalar) }
    } else {
      normalized[key] = scalar(value)
    }
  }
  const encoded = stableJson(normalized)
  if (encoded.length > MAX_FILTER_JSON) invalid('Filters exceed the 4096-character storage bound')
  return normalized
}

function enabledValue(value) {
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value === 0 || value === 1) return value
  invalid('enabled must be a boolean')
}

function parseJson(text) {
  try { return JSON.parse(text) } catch { return null }
}

export function view(row) {
  return {
    id: row.id,
    owner_id: row.owner_id,
    name: row.name,
    endpoint: row.endpoint,
    secret_ref: row.secret_ref,
    kinds: parseJson(row.kinds) ?? [],
    filters: parseJson(row.filters) ?? {},
    enabled: Boolean(row.enabled),
    created: row.created,
    updated: row.updated,
    last_delivery: row.last_delivery,
  }
}

function requireRow(store, owner, id) {
  const row = store.get('SELECT * FROM event_subscriptions WHERE owner_id=? AND id=?', owner, id)
  if (!row) notFound()
  return row
}

function fieldsOf(payload = {}, allowed) {
  const observed = Object.keys(payload ?? {})
  const unknown = observed.filter((key) => !allowed.includes(key))
  if (unknown.length) invalid('Unsupported subscription fields: ' + unknown.sort().join(', '))
}

export function createSubscription(store, payload = {}) {
  // The caller cannot name the account or the workspace in a single-owner
  // volume; these identity fields are ignored, never stored.
  fieldsOf(payload, ['name', 'endpoint', 'kinds', 'secret_ref', 'filters', 'owner_id', 'user_id', 'workspace_id'])
  const name = validateName(payload.name)
  const endpoint = validateEndpoint(payload.endpoint)
  const kinds = validateKinds(payload.kinds)
  const filters = normalizeFilters(payload.filters)
  const secretRef = validateSecretRef(payload.secret_ref)
  const now = nowSeconds()
  const id = newId()
  try {
    store.run(
      'INSERT INTO event_subscriptions (id,owner_id,name,endpoint,secret_ref,kinds,filters,enabled,created,updated,last_delivery) '
      + 'VALUES (?,?,?,?,?,?,?,1,?,?,NULL)',
      id, OWNER, name, endpoint, secretRef, JSON.stringify(kinds), stableJson(filters), now, now,
    )
  } catch (error) {
    if (/UNIQUE/i.test(String(error?.message))) refuse(409, 'events/conflict', 'Subscription name already exists for this owner')
    throw error
  }
  return view(requireRow(store, OWNER, id))
}

export function getSubscription(store, id) {
  if (typeof id !== 'string' || !id) notFound()
  return view(requireRow(store, OWNER, id))
}

export function listSubscriptions(store, payload = {}) {
  fieldsOf(payload, ['kinds', 'enabled'])
  const wanted = payload.kinds === undefined ? null : new Set(validateKinds(payload.kinds))
  const enabled = payload.enabled === undefined ? null : enabledValue(payload.enabled)
  let sql = 'SELECT * FROM event_subscriptions WHERE owner_id=?'
  const params = [OWNER]
  if (enabled !== null) { sql += ' AND enabled=?'; params.push(enabled) }
  sql += ' ORDER BY created,id LIMIT ?'
  params.push(MAX_LIST)
  let items = store.all(sql, ...params).map(view)
  if (wanted) items = items.filter((item) => item.kinds.some((kind) => wanted.has(kind)))
  return items
}

export function updateSubscription(store, payload = {}) {
  fieldsOf(payload, ['id', 'changes'])
  const row = requireRow(store, OWNER, payload.id)
  const changes = payload.changes ?? {}
  if (typeof changes !== 'object' || Array.isArray(changes)) invalid('changes must be an object')
  fieldsOf(changes, ['name', 'endpoint', 'kinds', 'filters', 'secret_ref', 'enabled'])
  if (!Object.keys(changes).length) return view(row)
  const columns = []
  const params = []
  if ('name' in changes) { columns.push('name=?'); params.push(validateName(changes.name)) }
  if ('endpoint' in changes) { columns.push('endpoint=?'); params.push(validateEndpoint(changes.endpoint)) }
  if ('kinds' in changes) { columns.push('kinds=?'); params.push(JSON.stringify(validateKinds(changes.kinds))) }
  if ('filters' in changes) { columns.push('filters=?'); params.push(stableJson(normalizeFilters(changes.filters))) }
  if ('secret_ref' in changes) { columns.push('secret_ref=?'); params.push(validateSecretRef(changes.secret_ref)) }
  if ('enabled' in changes) { columns.push('enabled=?'); params.push(enabledValue(changes.enabled)) }
  columns.push('updated=?')
  params.push(nowSeconds(), OWNER, payload.id)
  try {
    store.run('UPDATE event_subscriptions SET ' + columns.join(',') + ' WHERE owner_id=? AND id=?', ...params)
  } catch (error) {
    if (/UNIQUE/i.test(String(error?.message))) refuse(409, 'events/conflict', 'Subscription name already exists for this owner')
    throw error
  }
  return view(requireRow(store, OWNER, payload.id))
}

export function disableSubscription(store, id) {
  requireRow(store, OWNER, id)
  store.run('UPDATE event_subscriptions SET enabled=0, updated=? WHERE owner_id=? AND id=?', nowSeconds(), OWNER, id)
  return view(requireRow(store, OWNER, id))
}

export function deleteSubscription(store, id) {
  const row = store.get('SELECT id FROM event_subscriptions WHERE owner_id=? AND id=?', OWNER, id)
  if (!row) return false
  store.run('DELETE FROM event_delivery_records WHERE owner_id=? AND subscription_id=?', OWNER, id)
  return store.run('DELETE FROM event_subscriptions WHERE owner_id=? AND id=?', OWNER, id).changes > 0
}

function equal(actual, expected) {
  if (actual === MISSING) return false
  if (typeof actual === 'boolean' || typeof expected === 'boolean') {
    return typeof actual === 'boolean' && typeof expected === 'boolean' && actual === expected
  }
  return actual === expected
}

function filterMatches(filters, event) {
  for (const [key, expected] of Object.entries(filters)) {
    const actual = Object.prototype.hasOwnProperty.call(event, key) ? event[key] : MISSING
    if (expected && typeof expected === 'object' && Array.isArray(expected.in)) {
      if (!expected.in.some((candidate) => equal(actual, candidate))) return false
    } else if (!equal(actual, expected)) {
      return false
    }
  }
  return true
}

export function matchingSubscriptions(store, event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) invalid('Event must be an object')
  const eventKind = validateKind(event.kind)
  const rows = store.all(
    'SELECT * FROM event_subscriptions WHERE owner_id=? AND enabled=1 ORDER BY created,id LIMIT ?',
    OWNER, MAX_LIST,
  )
  return rows.filter((row) => {
    const kinds = parseJson(row.kinds) ?? []
    return kinds.includes(eventKind) && filterMatches(parseJson(row.filters) ?? {}, event)
  }).map(view)
}

export function recordDelivery(store, payload = {}) {
  fieldsOf(payload, ['subscription_id', 'event_kind', 'event_key', 'ok'])
  const row = requireRow(store, OWNER, payload.subscription_id)
  const eventKind = validateKind(payload.event_kind)
  const eventKey = payload.event_key
  if (typeof eventKey !== 'string' || eventKey.length < 1 || eventKey.length > MAX_EVENT_KEY || CONTROL.test(eventKey)) {
    invalid('Event key must be 1-256 characters without control characters')
  }
  const ok = payload.ok === undefined ? true : payload.ok
  if (typeof ok !== 'boolean') invalid('ok must be a boolean')
  const now = nowSeconds()
  const inserted = store.run(
    'INSERT OR IGNORE INTO event_delivery_records '
    + '(id,owner_id,subscription_id,event_kind,event_key,status,created) VALUES (?,?,?,?,?,?,?)',
    newId(), OWNER, row.id, eventKind, eventKey, ok ? 'delivered' : 'failed', now,
  ).changes > 0
  if (inserted) {
    store.run('UPDATE event_subscriptions SET last_delivery=? WHERE owner_id=? AND id=?', now, OWNER, row.id)
  }
  return inserted
}

function statsFor(store, owner, subscriptionId) {
  const row = store.get(
    'SELECT COUNT(*) AS total, '
    + "COALESCE(SUM(CASE WHEN status='delivered' THEN 1 ELSE 0 END),0) AS delivered, "
    + "COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END),0) AS failed "
    + 'FROM event_delivery_records WHERE owner_id=? AND subscription_id=?',
    owner, subscriptionId,
  )
  return { subscription_id: subscriptionId, delivered: row.delivered, failed: row.failed, total: row.total }
}

export function deliveryStats(store, subscriptionId) {
  if (subscriptionId !== undefined && subscriptionId !== null) {
    requireRow(store, OWNER, subscriptionId)
    return statsFor(store, OWNER, subscriptionId)
  }
  return store.all('SELECT id FROM event_subscriptions WHERE owner_id=? ORDER BY created,id LIMIT ?', OWNER, MAX_LIST)
    .map((row) => statsFor(store, OWNER, row.id))
}
