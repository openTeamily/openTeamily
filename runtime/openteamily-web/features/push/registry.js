// Web Push device registry, ported from the unwired central module
// openteamily/push_subscriptions.py (#466): one row per browser endpoint of this
// DS-Bot's owner. It records where a notice may go; it never signs VAPID
// requests, encrypts payloads or talks to a push service, and it stores no
// account secret (p256dh/auth are the browser's own subscription key material).
import { randomUUID } from 'node:crypto'
import { fail } from '../../src/store.js'

export const MAX_ENDPOINT = 2048
export const MAX_KEY_MATERIAL = 1024
export const MAX_USER_AGENT = 512
export const MAX_SUBSCRIPTIONS = 20
const MAX_ID = 64

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS push_subscriptions (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL,
 endpoint TEXT NOT NULL,
 p256dh TEXT NOT NULL,
 auth TEXT NOT NULL,
 user_agent TEXT,
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL,
 UNIQUE(user_id, endpoint));
CREATE INDEX IF NOT EXISTS push_subscription_user
 ON push_subscriptions(user_id, updated);
`

// Control characters would let a stored value smuggle bytes into a log line, a
// header or the browser's atob() call; whitespace has no place in a URL or key.
const printable = (value) => ![...value].some((char) => {
  const code = char.codePointAt(0)
  return code < 0x20 || code === 0x7f
})

const endpointOf = (value) => {
  if (typeof value !== 'string' || value.length === 0) fail('push/invalid', 'Invalid push endpoint')
  if (value.length > MAX_ENDPOINT) fail('push/invalid', 'Push endpoint is too long')
  if (!printable(value) || /\s/.test(value)) fail('push/invalid', 'Invalid push endpoint')
  let url
  try {
    url = new URL(value)
  } catch {
    fail('push/invalid', 'Invalid push endpoint')
  }
  if (url.protocol !== 'https:' || !url.hostname) fail('push/invalid', 'Push endpoint must be an absolute https URL')
  if (url.username !== '' || url.password !== '') fail('push/invalid', 'Push endpoint must not carry user information')
  return value
}

const materialOf = (value, name) => {
  if (typeof value !== 'string' || value.length === 0) fail('push/invalid', `Invalid push ${name}`)
  if (value.length > MAX_KEY_MATERIAL) fail('push/invalid', `Push ${name} is too long`)
  if (!printable(value)) fail('push/invalid', `Invalid push ${name}`)
  return value
}

const userAgentOf = (value) => {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') fail('push/invalid', 'Invalid push user agent')
  if (value.length > MAX_USER_AGENT) fail('push/invalid', 'Push user agent is too long')
  if (!printable(value)) fail('push/invalid', 'Invalid push user agent')
  return value
}

const idOf = (value) => {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID || !printable(value)) {
    fail('push/not-found', 'Unknown push subscription')
  }
  return value
}

export function view(row) {
  return {
    id: row.id, user_id: row.user_id, endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth,
    user_agent: row.user_agent, created: row.created, updated: row.updated,
  }
}

// Insert or replace one endpoint for one account. ``user_id`` never comes from
// the payload: the caller is always this DS-Bot's owner. Registering an endpoint
// that is already held re-enables and rewrites the same row (same id/created) so
// a browser that re-subscribes does not exhaust the device cap.
export function register(store, owner, input, now) {
  const endpoint = endpointOf(input.endpoint)
  const p256dh = materialOf(input.p256dh, 'p256dh')
  const auth = materialOf(input.auth, 'auth')
  const userAgent = userAgentOf(input.user_agent)
  return store.transaction(() => {
    const existing = store.get('SELECT id FROM push_subscriptions WHERE user_id=? AND endpoint=?', owner, endpoint)
    if (existing) {
      store.run('UPDATE push_subscriptions SET p256dh=?, auth=?, user_agent=?, updated=? WHERE id=? AND user_id=?',
        p256dh, auth, userAgent, now, existing.id, owner)
      return view(store.get('SELECT * FROM push_subscriptions WHERE id=? AND user_id=?', existing.id, owner))
    }
    const count = store.get('SELECT COUNT(*) AS held FROM push_subscriptions WHERE user_id=?', owner).held
    if (count >= MAX_SUBSCRIPTIONS) fail('push/quota', 'This account already holds the maximum number of push subscriptions')
    const id = randomUUID().replaceAll('-', '')
    store.run(
      'INSERT INTO push_subscriptions (id,user_id,endpoint,p256dh,auth,user_agent,created,updated) VALUES (?,?,?,?,?,?,?,?)',
      id, owner, endpoint, p256dh, auth, userAgent, now, now,
    )
    return view(store.get('SELECT * FROM push_subscriptions WHERE id=? AND user_id=?', id, owner))
  })
}

// Every device this account holds, oldest first. A row written for another
// account in the same file is never returned.
export function list(store, owner) {
  return store.all('SELECT * FROM push_subscriptions WHERE user_id=? ORDER BY created, id', owner).map(view)
}

export function get(store, owner, id) {
  const row = store.get('SELECT * FROM push_subscriptions WHERE id=? AND user_id=?', idOf(id), owner)
  if (!row) fail('push/not-found', 'Unknown push subscription')
  return view(row)
}

// Delete one own device. Unknown or already-revoked ids stay a successful no-op
// so a page or worker retrying a removal does not have to special-case it.
export function revoke(store, owner, id) {
  const value = idOf(id)
  const result = store.run('DELETE FROM push_subscriptions WHERE id=? AND user_id=?', value, owner)
  return { id: value, revoked: result.changes === 1 }
}
