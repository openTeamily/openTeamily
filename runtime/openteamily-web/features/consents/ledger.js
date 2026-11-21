// Versioned consent ledger, ported from the unwired central module
// openteamily/consents.py (#489): document versions, per-owner grant/withdraw
// evidence and require-all gates. It is a small persistence ledger, not legal
// advice or a compliance certification. Evidence is hashed; raw IP addresses,
// user-agent strings and other submitted evidence are never stored.
import { createHash, randomUUID } from 'node:crypto'
import { fail } from '../../src/store.js'

export const KINDS = ['terms', 'privacy', 'marketing', 'recording']
export const STATUSES = ['granted', 'withdrawn']
export const MAX_EVIDENCE_BYTES = 8192
export const MAX_USER_ID = 128
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/
const METHOD = /^[a-z][a-z0-9_.-]{0,31}$/

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS consent_documents (
 kind TEXT NOT NULL CHECK(kind IN ('terms','privacy','marketing','recording')),
 version TEXT NOT NULL,
 effective INTEGER NOT NULL,
 created INTEGER NOT NULL,
 PRIMARY KEY(kind, version));
CREATE INDEX IF NOT EXISTS consent_documents_current
 ON consent_documents(kind, effective, created);
CREATE TABLE IF NOT EXISTS user_consents (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('terms','privacy','marketing','recording')),
 version TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('granted','withdrawn')),
 method TEXT NOT NULL,
 evidence_hash TEXT,
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL,
 UNIQUE(user_id, kind, version));
CREATE INDEX IF NOT EXISTS user_consents_history
 ON user_consents(user_id, kind, updated, created);
CREATE INDEX IF NOT EXISTS user_consents_kind
 ON user_consents(kind, user_id, updated);
`

export function migrate(store) {
  store.exec(SCHEMA)
}

const kindOf = (kind) => {
  if (!KINDS.includes(kind)) fail('consents/unknown-kind', 'Unknown consent kind')
  return kind
}
const versionOf = (version) => {
  if (typeof version !== 'string' || !VERSION.test(version)) fail('consents/invalid', 'Invalid consent document version')
  return version
}
const userOf = (user) => {
  if (typeof user !== 'string' || user.length < 1 || user.length > MAX_USER_ID) fail('consents/invalid', 'Invalid consent user')
  return user
}
const timeOf = (value, name) => {
  if (!Number.isSafeInteger(value) || value < 0) fail('consents/invalid', 'Invalid consent ' + name)
  return value
}
const methodOf = (method) => {
  if (typeof method !== 'string') fail('consents/invalid', 'Invalid consent method')
  const value = method.trim().toLowerCase()
  if (!METHOD.test(value)) fail('consents/invalid', 'Invalid consent method')
  return value
}

// Canonical evidence: sorted keys, compact separators, UTF-8 — the same shape the
// Python module hashed, so a stored hash keeps its meaning. Only JSON values are
// accepted; functions, symbols, BigInt and non-finite numbers are refused instead
// of being silently dropped or turned into null.
function canonical(value) {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('consents/invalid', 'Invalid consent evidence')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  const proto = typeof value === 'object' ? Object.getPrototypeOf(value) : null
  if (value && typeof value === 'object' && (proto === Object.prototype || proto === null)) {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
  }
  fail('consents/invalid', 'Invalid consent evidence')
}

export function evidenceHash(evidence) {
  if (evidence === undefined || evidence === null) return null
  const document = canonical(evidence)
  if (Buffer.byteLength(document, 'utf8') > MAX_EVIDENCE_BYTES) fail('consents/evidence-too-large', 'Consent evidence is too large')
  return createHash('sha256').update(document, 'utf8').digest('hex')
}

const documentView = (row) => row === null ? null
  : { kind: row.kind, version: row.version, effective: row.effective, created: row.created }

const recordView = (row) => row === null ? null : {
  id: row.id, user_id: row.user_id, kind: row.kind, version: row.version, status: row.status,
  method: row.method, evidence_hash: row.evidence_hash, created: row.created, updated: row.updated,
}

const findDocument = (store, kind, version = null) => version === null
  ? store.get('SELECT * FROM consent_documents WHERE kind=? ORDER BY effective DESC, created DESC, rowid DESC LIMIT 1', kind)
  : store.get('SELECT * FROM consent_documents WHERE kind=? AND version=?', kind, version)

export function registerDocument(store, kind, version, effective, now) {
  kind = kindOf(kind)
  version = versionOf(version)
  effective = timeOf(effective, 'effective time')
  now = timeOf(now, 'time')
  const row = findDocument(store, kind, version)
  if (row !== null) {
    if (row.effective !== effective) fail('consents/document-conflict', 'Consent document version already has a different effective time')
    return documentView(row)
  }
  store.run('INSERT INTO consent_documents(kind,version,effective,created) VALUES(?,?,?,?)', kind, version, effective, now)
  return documentView(findDocument(store, kind, version))
}

export function currentDocument(store, kind, now) {
  kind = kindOf(kind)
  now = timeOf(now, 'time')
  return documentView(store.get(
    'SELECT * FROM consent_documents WHERE kind=? AND effective<=? ORDER BY effective DESC, created DESC, rowid DESC LIMIT 1',
    kind, now,
  ))
}

export function grant(store, user, kind, version, now, method = 'web', evidence = null) {
  user = userOf(user)
  kind = kindOf(kind)
  version = versionOf(version)
  now = timeOf(now, 'time')
  method = methodOf(method)
  const hash = evidenceHash(evidence)
  if (findDocument(store, kind, version) === null) fail('consents/document-not-registered', 'Consent document version is not registered')
  store.run(
    'INSERT INTO user_consents(id,user_id,kind,version,status,method,evidence_hash,created,updated) '
    + "VALUES(?,?,?,?,'granted',?,?,?,?) "
    + 'ON CONFLICT(user_id,kind,version) DO UPDATE SET '
    + "status='granted', method=excluded.method, evidence_hash=excluded.evidence_hash, updated=excluded.updated",
    randomUUID().replaceAll('-', ''), user, kind, version, method, hash, now, now,
  )
  return recordView(store.get('SELECT * FROM user_consents WHERE user_id=? AND kind=? AND version=?', user, kind, version))
}

export function withdraw(store, user, kind, version, now) {
  user = userOf(user)
  kind = kindOf(kind)
  version = versionOf(version)
  now = timeOf(now, 'time')
  const result = store.run(
    "UPDATE user_consents SET status='withdrawn', updated=? WHERE user_id=? AND kind=? AND version=?",
    now, user, kind, version,
  )
  if (result.changes === 0) fail('consents/record-not-found', 'Consent record not found')
  return recordView(store.get('SELECT * FROM user_consents WHERE user_id=? AND kind=? AND version=?', user, kind, version))
}

// Latest record for a kind plus the required version and whether that version is
// granted. Without ``at`` the newest registered document is the required version.
export function currentStatus(store, user, kind, at = null) {
  user = userOf(user)
  kind = kindOf(kind)
  const document = at === null ? documentView(findDocument(store, kind)) : currentDocument(store, kind, timeOf(at, 'time'))
  const required = document === null ? null : document.version
  const record = recordView(store.get(
    'SELECT * FROM user_consents WHERE user_id=? AND kind=? ORDER BY updated DESC, created DESC, rowid DESC LIMIT 1',
    user, kind,
  ))
  const granted = record !== null && record.status === 'granted' && required === record.version
  return { record, required_version: required, granted }
}

export function listHistory(store, user, kind = null) {
  user = userOf(user)
  const rows = kind === null
    ? store.all('SELECT * FROM user_consents WHERE user_id=? ORDER BY updated DESC, created DESC, rowid DESC', user)
    : store.all('SELECT * FROM user_consents WHERE user_id=? AND kind=? ORDER BY updated DESC, created DESC, rowid DESC', user, kindOf(kind))
  return rows.map(recordView)
}

export function requireAll(store, user, kinds, now) {
  user = userOf(user)
  now = timeOf(now, 'time')
  if (typeof kinds === 'string' || !Array.isArray(kinds)) fail('consents/invalid', 'Consent kinds must be an iterable of kind names')
  for (const kind of kinds) kindOf(kind)
  const missing = []
  const seen = new Set()
  for (const kind of kinds) {
    if (seen.has(kind)) continue
    seen.add(kind)
    const document = currentDocument(store, kind, now)
    if (document === null) { missing.push(kind); continue }
    const row = store.get("SELECT 1 AS ok FROM user_consents WHERE user_id=? AND kind=? AND version=? AND status='granted'", user, kind, document.version)
    if (row === null) missing.push(kind)
  }
  return missing
}
