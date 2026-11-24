// Workspace data-retention policy records and deterministic purge planning,
// moved from the legacy central openteamily/retention.py module into this
// user's own DS-Bot. Policies and run records live in
// /data/openteamily/features/retention; nothing is shared with the platform or
// another user's volume.
//
// This feature never deletes workspace rows, writes caller files or calls the
// network. `plan` computes a deterministic decision from caller-supplied row
// metadata. `execute` is a dry-run receipt that returns the same plan and
// refuses to delete anything: endpoints cannot pass the legacy Python
// `delete_fn` callback, so the caller performs its own deletions and then
// reports the outcome through `recordRun`. `recordRun` stores the audit row
// (class counts plus deleted/failed) used by `stats`.
import { openDatabase } from '../../src/store.js'
import { FeatureError, stableJson } from '../../featurekit/http.js'
import { randomBytes } from 'node:crypto'

export const LIMITS = Object.freeze({ ID: 256, ROWS: 10000 })
export const MAX_ID_LENGTH = LIMITS.ID
export const MAX_ROWS = LIMITS.ROWS
export const MIN_TTL_SECONDS = 1
export const MAX_TTL_SECONDS = 10 * 365 * 24 * 60 * 60
export const DATA_CLASS = /^[a-z][a-z0-9_]{0,63}$/
export const REASON_DISABLED = 'disabled'
export const REASON_NOT_DUE = 'not_due'

const CONTROL = /[\x00-\x1f\x7f]/

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS retention_policies (
  workspace_id TEXT NOT NULL,
  data_class TEXT NOT NULL,
  ttl_seconds INTEGER NOT NULL CHECK(ttl_seconds > 0),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  legal_hold INTEGER NOT NULL CHECK(legal_hold IN (0,1)),
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  PRIMARY KEY(workspace_id, data_class));
CREATE INDEX IF NOT EXISTS retention_policy_workspace
  ON retention_policies(workspace_id, data_class);
CREATE TABLE IF NOT EXISTS retention_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  deleted INTEGER NOT NULL CHECK(deleted >= 0),
  failed INTEGER NOT NULL CHECK(failed >= 0),
  created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS retention_run_workspace
  ON retention_runs(workspace_id, created, id);
`

export const SCHEMA_SQL = SCHEMA

export function fail(code, message, status = 400) {
  throw new FeatureError(status, `retention/${code}`, message)
}

export function ensureSchema(db) {
  if (typeof db?.migrate === 'function') {
    db.migrate('retention', [SCHEMA])
    return
  }
  if (typeof db?.exec !== 'function') throw new TypeError('retention: a SQLite database is required')
  db.exec('PRAGMA foreign_keys=ON')
  db.exec(SCHEMA)
}

const nowSeconds = () => Math.floor(Date.now() / 1000)
const body = (payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('invalid', 'payload object required')
  return payload
}

function textId(value, label) {
  if (typeof value !== 'string' || value.length < 1 || value.length > LIMITS.ID
      || value !== value.trim() || CONTROL.test(value)) {
    fail('invalid', `${label} must be a non-empty bounded string without surrounding whitespace or control characters`)
  }
  return value
}

const workspaceValue = (payload) => textId(payload.workspace_id, 'workspace_id')

function dataClassValue(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64
      || !DATA_CLASS.test(value) || value !== value.trim() || CONTROL.test(value)) {
    fail('invalid', 'data_class must match [a-z][a-z0-9_]{0,63}')
  }
  return value
}

function ttlValue(value) {
  if (!Number.isInteger(value) || value < MIN_TTL_SECONDS || value > MAX_TTL_SECONDS) {
    fail('invalid', `ttl_seconds must be an integer from ${MIN_TTL_SECONDS} to ${MAX_TTL_SECONDS}`)
  }
  return value
}

function flagValue(value, label) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number' && (value === 0 || value === 1)) return Boolean(value)
  fail('invalid', `${label} must be a boolean`)
}

function timestampValue(value, label) {
  if (!Number.isSafeInteger(value)) fail('invalid', `${label} must be an integer Unix timestamp`)
  return value
}

function countValue(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > LIMITS.ROWS) {
    fail('invalid', `${label} must be an integer in 0..${LIMITS.ROWS}`)
  }
  return value
}

function summaryValue(value) {
  if (value === undefined || value === null) return {}
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { fail('invalid', 'summary must be a JSON object') }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid', 'summary must be a JSON object')
  }
  const clean = {}
  for (const [dataClass, count] of Object.entries(value)) {
    if (DATA_CLASS.test(dataClass) && !CONTROL.test(dataClass)
        && Number.isInteger(count) && count >= 0 && count <= LIMITS.ROWS) {
      clean[dataClass] = count
    }
  }
  return clean
}

const policyView = (row) => ({
  workspace_id: row.workspace_id,
  data_class: row.data_class,
  ttl_seconds: row.ttl_seconds,
  enabled: Boolean(row.enabled),
  legal_hold: Boolean(row.legal_hold),
  created: row.created,
  updated: row.updated,
})

function runView(row) {
  let summary = {}
  try {
    const parsed = JSON.parse(row.summary)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) summary = parsed
  } catch { /* stored runs are written as JSON; fall back to an empty summary */ }
  const view = {
    id: row.id,
    workspace_id: row.workspace_id,
    summary,
    deleted: row.deleted,
    failed: row.failed,
    created: row.created,
  }
  // Legacy naming compatibility for in-process callers.
  Object.defineProperty(view, 'counts', { value: summary, enumerable: false })
  return view
}

const planKey = (workspaceId, plan) => stableJson({
  workspace_id: workspaceId,
  delete: plan.delete,
  keep: plan.keep,
  unknown_policy: plan.unknown_policy,
  legal_hold: plan.legal_hold,
})

function idList(value, label) {
  if (!Array.isArray(value)) fail('invalid', `${label} must be a list`)
  if (value.length > LIMITS.ROWS) fail('too-large', `${label} must contain at most ${LIMITS.ROWS} items`, 413)
  return value.map((item) => textId(item, 'id'))
}

function normalizedPlan(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid', 'plan must be an object')
  if (!Array.isArray(value.delete)) fail('invalid', 'plan.delete must be a list')
  if (value.delete.length > LIMITS.ROWS) fail('too-large', `plan.delete must contain at most ${LIMITS.ROWS} items`, 413)
  const keep = value.keep === undefined ? [] : value.keep
  if (!Array.isArray(keep)) fail('invalid', 'plan.keep must be a list')
  if (keep.length > LIMITS.ROWS) fail('too-large', `plan.keep must contain at most ${LIMITS.ROWS} items`, 413)
  return {
    delete: value.delete.map((item) => textId(item, 'id')),
    keep: keep.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) fail('invalid', 'each keep entry must be an object')
      return { id: textId(item.id, 'id'), reason: textId(item.reason, 'reason') }
    }),
    unknown_policy: idList(value.unknown_policy === undefined ? [] : value.unknown_policy, 'plan.unknown_policy'),
    legal_hold: idList(value.legal_hold === undefined ? [] : value.legal_hold, 'plan.legal_hold'),
  }
}

export function createRetention({ db, clock = nowSeconds } = {}) {
  if (!db) throw new TypeError('retention: a SQLite database is required')
  ensureSchema(db)
  const prepared = typeof db.prepare === 'function'
  const one = prepared
    ? (sql, ...args) => db.prepare(sql).get(...args) ?? null
    : (sql, ...args) => db.get(sql, ...args) ?? null
  const all = prepared
    ? (sql, ...args) => db.prepare(sql).all(...args)
    : (sql, ...args) => db.all(sql, ...args)
  const run = prepared
    ? (sql, ...args) => db.prepare(sql).run(...args)
    : (sql, ...args) => db.run(sql, ...args)
  const transaction = typeof db.transaction === 'function'
    ? (fn) => db.transaction(fn)
    : (fn) => {
      db.exec('BEGIN IMMEDIATE')
      try {
        const result = fn()
        db.exec('COMMIT')
        return result
      } catch (error) {
        try { db.exec('ROLLBACK') } catch { /* already rolled back */ }
        throw error
      }
    }

  // Plan decisions are deterministic; remember per-class counts so an execute
  // receipt or a later recordRun can keep the legacy class-count summary even
  // though the plan crosses the API as plain JSON.
  const planSummaries = new Map()
  const rememberPlan = (workspaceId, plan, counts) => {
    const key = planKey(workspaceId, plan)
    const prior = planSummaries.get(key)
    // Identical plan receipts with different class counts are ambiguous; do not
    // guess a summary for the later caller.
    const value = prior && prior.signature !== stableJson(counts) ? { signature: null, counts: {} }
      : { signature: stableJson(counts), counts: { ...counts } }
    planSummaries.set(key, value)
    if (planSummaries.size > 1000) planSummaries.delete(planSummaries.keys().next().value)
  }
  const recallPlan = (workspaceId, plan) => planSummaries.get(planKey(workspaceId, plan))?.counts ?? {}

  const listPolicies = (workspaceId) => {
    const items = all('SELECT * FROM retention_policies WHERE workspace_id=? ORDER BY data_class', workspaceId)
      .map(policyView)
    // In-process aliases; the endpoint still serializes as the legacy list.
    Object.defineProperty(items, 'items', { value: items, enumerable: false })
    Object.defineProperty(items, 'policies', { value: items, enumerable: false })
    return items
  }

  const getPolicy = (workspaceId, dataClass) => {
    const row = one('SELECT * FROM retention_policies WHERE workspace_id=? AND data_class=?', workspaceId, dataClass)
    return row === null ? null : policyView(row)
  }

  const setPolicy = (payload) => {
    const p = body(payload)
    const workspaceId = workspaceValue(p)
    const dataClass = dataClassValue(p.data_class)
    const ttl = ttlValue(p.ttl_seconds)
    const stamp = timestampValue(p.now ?? clock(), 'now')
    const enabled = p.enabled === undefined ? true : flagValue(p.enabled, 'enabled')
    const legalHold = p.legal_hold === undefined ? false : flagValue(p.legal_hold, 'legal_hold')
    run(
      'INSERT INTO retention_policies '
      + '(workspace_id,data_class,ttl_seconds,enabled,legal_hold,created,updated) '
      + 'VALUES(?,?,?,?,?,?,?) '
      + 'ON CONFLICT(workspace_id,data_class) DO UPDATE SET '
      + 'ttl_seconds=excluded.ttl_seconds,enabled=excluded.enabled,'
      + 'legal_hold=excluded.legal_hold,updated=excluded.updated',
      workspaceId, dataClass, ttl, Number(enabled), Number(legalHold), stamp, stamp,
    )
    return getPolicy(workspaceId, dataClass)
  }

  const getPolicyEndpoint = (payload) => {
    const p = body(payload)
    return getPolicy(workspaceValue(p), dataClassValue(p.data_class))
  }

  const listPoliciesEndpoint = (payload) => listPolicies(workspaceValue(body(payload)))

  const deletePolicy = (payload) => {
    const p = body(payload)
    const workspaceId = workspaceValue(p)
    const dataClass = dataClassValue(p.data_class)
    return Number(run(
      'DELETE FROM retention_policies WHERE workspace_id=? AND data_class=?',
      workspaceId, dataClass,
    ).changes) > 0
  }

  const plan = (payload) => {
    const p = body(payload)
    const workspaceId = workspaceValue(p)
    const stamp = timestampValue(p.now ?? clock(), 'now')
    if (!Array.isArray(p.rows)) fail('invalid', 'rows must be a list')
    if (p.rows.length > LIMITS.ROWS) fail('too-large', `rows must contain at most ${LIMITS.ROWS} items`, 413)

    const policies = new Map(
      all('SELECT * FROM retention_policies WHERE workspace_id=?', workspaceId)
        .map((row) => [row.data_class, row]),
    )
    const remove = []
    const keep = []
    const unknown = []
    const held = []
    const counts = {}

    for (const row of p.rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) fail('invalid', 'each row must be an object')
      const id = textId(row.id, 'id')
      const dataClass = dataClassValue(row.data_class)
      const created = timestampValue(row.created, 'created')
      const rowHold = row.legal_hold === undefined ? false : flagValue(row.legal_hold, 'legal_hold')

      if (rowHold) {
        held.push(id)
        continue
      }
      const policy = policies.get(dataClass)
      if (!policy) {
        unknown.push(id)
        continue
      }
      if (policy.legal_hold) {
        held.push(id)
        continue
      }
      if (!policy.enabled) {
        keep.push({ id, reason: REASON_DISABLED })
        continue
      }
      // Expiry is strict: a row exactly at the cutoff (age === ttl_seconds) is
      // kept, and only age > ttl_seconds is planned for deletion.
      if (stamp - created <= policy.ttl_seconds) {
        keep.push({ id, reason: REASON_NOT_DUE })
        continue
      }
      remove.push(id)
      counts[dataClass] = (counts[dataClass] ?? 0) + 1
    }

    remove.sort()
    unknown.sort()
    held.sort()
    keep.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

    const result = { delete: remove, keep, unknown_policy: unknown, legal_hold: held }
    rememberPlan(workspaceId, result, counts)
    Object.defineProperty(result, 'counts', { value: counts, enumerable: false })
    Object.defineProperty(result, 'data_class_counts', { value: counts, enumerable: false })
    return result
  }

  const recordRun = (payload) => {
    const p = body(payload)
    const workspaceId = workspaceValue(p)
    const stamp = timestampValue(p.now ?? clock(), 'now')
    const hasPlan = p.plan !== undefined || Array.isArray(p.delete)
    const planValue = hasPlan
      ? normalizedPlan(p.plan === undefined ? p : p.plan)
      : { delete: [], keep: [], unknown_policy: [], legal_hold: [] }
    const attempted = planValue.delete.length
    const deleted = p.deleted === undefined ? 0 : countValue(p.deleted, 'deleted')
    const failed = p.failed === undefined ? 0 : countValue(p.failed, 'failed')
    if (hasPlan && deleted + failed > attempted) fail('invalid', 'deleted plus failed cannot exceed planned deletions')
    const supplied = p.summary ?? p.counts
    const counts = supplied === undefined
      ? (hasPlan ? recallPlan(workspaceId, planValue) : {})
      : summaryValue(supplied)
    const id = randomBytes(16).toString('hex')
    transaction(() => {
      run(
        'INSERT INTO retention_runs(id,workspace_id,summary,deleted,failed,created) VALUES(?,?,?,?,?,?)',
        id, workspaceId, stableJson(counts), deleted, failed, stamp,
      )
    })
    return runView(one('SELECT * FROM retention_runs WHERE id=? AND workspace_id=?', id, workspaceId))
  }

  const execute = (payload) => {
    const p = body(payload)
    const workspaceId = workspaceValue(p)
    const stamp = timestampValue(p.now ?? clock(), 'now')
    const planValue = normalizedPlan(p.plan === undefined ? p : p.plan)
    // With caller-reported outcomes, record them exactly like the legacy
    // callback would; otherwise this is a dry-run plan receipt.
    if (['deleted', 'failed', 'summary', 'counts'].some((key) => Object.hasOwn(p, key))) {
      return recordRun({ ...p, workspace_id: workspaceId, plan: planValue, now: stamp })
    }
    const counts = recallPlan(workspaceId, planValue)
    rememberPlan(workspaceId, planValue, counts)
    const result = planValue
    Object.defineProperties(result, {
      plan: { value: result, enumerable: false },
      attempted: { value: result.delete.length, enumerable: false },
      deleted: { value: 0, enumerable: false },
      failed: { value: 0, enumerable: false },
      counts: { value: counts, enumerable: false },
    })
    return result
  }

  const stats = (payload) => {
    const workspaceId = workspaceValue(body(payload))
    const row = one(
      'SELECT * FROM retention_runs WHERE workspace_id=? ORDER BY created DESC, rowid DESC LIMIT 1',
      workspaceId,
    )
    return {
      policies: listPolicies(workspaceId),
      last_run: row === null ? null : runView(row),
    }
  }

  return {
    db,
    endpoints: {
      setPolicy,
      getPolicy: getPolicyEndpoint,
      listPolicies: listPoliciesEndpoint,
      deletePolicy,
      plan,
      execute,
      recordRun,
      stats,
    },
  }
}

export default async function retention(host) {
  const db = await openDatabase(host, 'retention.sqlite3')
  const feature = createRetention({ db })
  return { endpoints: feature.endpoints }
}
