// Always-on agent rule/event/run core, ported from the unwired central module
// openteamily/proactive.py (#390): enabled rules match persisted events under a
// per-rule cooldown and daily budget, runs are queued and leased by a worker,
// and one bounded message can be recorded per run. It calls no model, runs no
// container and delivers nothing; "proactive" here is scheduling and matching.
//
// The central module was workspace-scoped because one server held every
// workspace. This DS-Bot volume holds exactly one owner, so rows carry
// ``owner_id`` and the caller can never name another account: a payload
// ``workspace_id`` is ignored and every lookup is scoped to this owner.
import { randomUUID } from 'node:crypto'
import { fail } from '../../src/store.js'

export const MAX_ID = 128
export const MAX_KIND = 64
export const MAX_NAME = 80
export const MAX_DEDUPE = 200
export const MAX_EVENT_PAYLOAD = 6000
export const MAX_RUN_PAYLOAD = 8000
export const MAX_RESULT = 8000
export const MAX_ERROR = 500
export const MAX_BODY = 4000
export const MAX_LIMIT = 100
export const MAX_COOLDOWN = 2592000
export const MAX_DAILY_BUDGET = 10000
export const MAX_LEASE = 604800
export const DAY = 86400
const TERMINAL = new Set(['succeeded', 'failed'])

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS proactive_rules (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL,
 name TEXT NOT NULL,
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 event_kind TEXT NOT NULL,
 source_type TEXT,
 conversation_id TEXT,
 agent_id TEXT,
 cooldown_seconds INTEGER NOT NULL CHECK(cooldown_seconds >= 0),
 daily_budget INTEGER NOT NULL CHECK(daily_budget >= 0),
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS proactive_rule_owner
 ON proactive_rules(owner_id, enabled, event_kind);
CREATE TABLE IF NOT EXISTS proactive_events (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL,
 kind TEXT NOT NULL,
 source_type TEXT NOT NULL,
 source_id TEXT NOT NULL,
 payload TEXT NOT NULL,
 dedupe_key TEXT NOT NULL,
 consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1)),
 created INTEGER NOT NULL,
 UNIQUE(owner_id, dedupe_key));
CREATE INDEX IF NOT EXISTS proactive_event_inbox
 ON proactive_events(owner_id, consumed, created, id);
CREATE TABLE IF NOT EXISTS proactive_runs (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL,
 rule_id TEXT NOT NULL REFERENCES proactive_rules(id) ON DELETE CASCADE,
 event_id TEXT NOT NULL REFERENCES proactive_events(id) ON DELETE CASCADE,
 status TEXT NOT NULL CHECK(status IN ('queued','claimed','succeeded','failed')),
 payload TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
 lease_until INTEGER,
 claim_token TEXT,
 result TEXT,
 error TEXT,
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL,
 finished INTEGER,
 UNIQUE(rule_id, event_id));
CREATE INDEX IF NOT EXISTS proactive_run_claim
 ON proactive_runs(owner_id, status, lease_until, created, id);
CREATE INDEX IF NOT EXISTS proactive_run_owner
 ON proactive_runs(owner_id, created, id);
CREATE TABLE IF NOT EXISTS proactive_messages (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL,
 run_id TEXT NOT NULL REFERENCES proactive_runs(id) ON DELETE CASCADE,
 conversation_id TEXT NOT NULL,
 body TEXT NOT NULL,
 created INTEGER NOT NULL,
 UNIQUE(run_id));
CREATE INDEX IF NOT EXISTS proactive_message_owner
 ON proactive_messages(owner_id, created, id);
`

const stamp = (value) => {
  if (!Number.isSafeInteger(value) || value < 0) fail('proactive/invalid', 'now must be a non-negative integer')
  return value
}

const text = (value, field, limit, allowEmpty = false) => {
  if (typeof value !== 'string') fail('proactive/invalid', `${field} must be a string`)
  if (!allowEmpty && value.trim().length === 0) fail('proactive/invalid', `${field} must not be empty`)
  if (value.length > limit) fail('proactive/invalid', `${field} exceeds ${limit} characters`)
  if (value.includes('\u0000')) fail('proactive/invalid', `${field} must not contain NUL`)
  return value
}

const optional = (value, field, limit) => (value === undefined || value === null || value === '' ? null : text(value, field, limit))

const payloadText = (value, limit) => {
  if (value === undefined) return '{}'
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('proactive/invalid', 'payload must be a JSON object')
  let encoded
  try {
    encoded = JSON.stringify(value)
  } catch {
    fail('proactive/invalid', 'payload is not JSON serializable')
  }
  if (encoded.length > limit) fail('proactive/invalid', `payload exceeds ${limit} characters`)
  return encoded
}

const parsed = (value, fallback) => {
  if (!value) return fallback
  try {
    const doc = JSON.parse(value)
    return doc !== null && typeof doc === 'object' && !Array.isArray(doc) ? doc : fallback
  } catch {
    return fallback
  }
}

export function ruleView(row) {
  return {
    id: row.id, owner_id: row.owner_id, name: row.name, enabled: row.enabled === 1,
    event_kind: row.event_kind, source_type: row.source_type, conversation_id: row.conversation_id,
    agent_id: row.agent_id, cooldown_seconds: row.cooldown_seconds, daily_budget: row.daily_budget,
    created: row.created, updated: row.updated,
  }
}

export function runView(row) {
  return {
    id: row.id, owner_id: row.owner_id, rule_id: row.rule_id, event_id: row.event_id,
    status: row.status, payload: parsed(row.payload, {}), attempts: row.attempts,
    lease_until: row.lease_until, result: row.result === null ? null : parsed(row.result, null),
    error: row.error, created: row.created, updated: row.updated, finished: row.finished,
  }
}

export function messageView(row) {
  return {
    id: row.id, owner_id: row.owner_id, run_id: row.run_id,
    conversation_id: row.conversation_id, body: row.body, created: row.created,
  }
}

function normalizeRule(rule) {
  if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) fail('proactive/invalid', 'rule must be an object')
  const id = rule.id === undefined || rule.id === null ? randomUUID().replaceAll('-', '') : text(rule.id, 'id', 64)
  const name = rule.name === undefined || rule.name === null ? 'rule' : text(rule.name, 'name', MAX_NAME)
  const enabled = rule.enabled === undefined ? true : rule.enabled
  if (enabled !== true && enabled !== false && enabled !== 0 && enabled !== 1) fail('proactive/invalid', 'enabled must be a boolean')
  const cooldown = rule.cooldown_seconds === undefined ? 0 : rule.cooldown_seconds
  if (!Number.isSafeInteger(cooldown) || cooldown < 0 || cooldown > MAX_COOLDOWN) fail('proactive/invalid', 'cooldown_seconds must be a bounded non-negative integer')
  const budget = rule.daily_budget === undefined ? 100 : rule.daily_budget
  if (!Number.isSafeInteger(budget) || budget < 0 || budget > MAX_DAILY_BUDGET) fail('proactive/invalid', 'daily_budget must be a bounded non-negative integer')
  return {
    id, name, enabled: enabled ? 1 : 0, event_kind: text(rule.event_kind, 'event_kind', MAX_KIND),
    source_type: optional(rule.source_type, 'source_type', MAX_KIND),
    conversation_id: optional(rule.conversation_id, 'conversation_id', MAX_ID),
    agent_id: optional(rule.agent_id, 'agent_id', MAX_ID),
    cooldown_seconds: cooldown, daily_budget: budget,
  }
}

// Insert or replace one rule. Passing rule.id updates that rule and keeps its
// created time; an id that already belongs to another account is refused.
export function saveRule(store, owner, rule, now) {
  const at = stamp(now)
  const item = normalizeRule(rule)
  const existing = store.get('SELECT owner_id, created FROM proactive_rules WHERE id=?', item.id)
  if (existing && existing.owner_id !== owner) fail('proactive/invalid', 'rule id belongs to another account')
  const created = existing ? existing.created : at
  store.run(
    `INSERT INTO proactive_rules
       (id, owner_id, name, enabled, event_kind, source_type, conversation_id, agent_id,
        cooldown_seconds, daily_budget, created, updated)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, enabled=excluded.enabled,
       event_kind=excluded.event_kind, source_type=excluded.source_type,
       conversation_id=excluded.conversation_id, agent_id=excluded.agent_id,
       cooldown_seconds=excluded.cooldown_seconds, daily_budget=excluded.daily_budget,
       updated=excluded.updated`,
    item.id, owner, item.name, item.enabled, item.event_kind, item.source_type,
    item.conversation_id, item.agent_id, item.cooldown_seconds, item.daily_budget, created, at,
  )
  return ruleView(store.get('SELECT * FROM proactive_rules WHERE id=?', item.id))
}

export function listRules(store, owner) {
  return store.all('SELECT * FROM proactive_rules WHERE owner_id=? ORDER BY created, id', owner).map(ruleView)
}

export function removeRule(store, owner, id) {
  const value = text(id, 'id', MAX_ID)
  return store.run('DELETE FROM proactive_rules WHERE owner_id=? AND id=?', owner, value).changes > 0
}

// Persist one event; (owner_id, dedupe_key) makes a replay return the first row
// instead of storing a second event or overwriting its payload.
export function recordEvent(store, owner, input, now) {
  const at = stamp(now)
  const kind = text(input.kind, 'kind', MAX_KIND)
  const sourceType = text(input.source_type, 'source_type', MAX_KIND)
  const sourceId = text(input.source_id, 'source_id', MAX_ID)
  const dedupeKey = text(input.dedupe_key, 'dedupe_key', MAX_DEDUPE)
  const body = payloadText(input.payload, MAX_EVENT_PAYLOAD)
  const existing = store.get('SELECT id FROM proactive_events WHERE owner_id=? AND dedupe_key=?', owner, dedupeKey)
  if (existing) return { id: existing.id, duplicate: true }
  const id = randomUUID().replaceAll('-', '')
  try {
    store.run(
      'INSERT INTO proactive_events (id, owner_id, kind, source_type, source_id, payload, dedupe_key, consumed, created) VALUES (?,?,?,?,?,?,?,0,?)',
      id, owner, kind, sourceType, sourceId, body, dedupeKey, at,
    )
  } catch (error) {
    const raced = store.get('SELECT id FROM proactive_events WHERE owner_id=? AND dedupe_key=?', owner, dedupeKey)
    if (!raced) throw error
    return { id: raced.id, duplicate: true }
  }
  return { id, duplicate: false }
}

function matches(rule, event, doc) {
  if (rule.event_kind !== event.kind) return false
  if (rule.source_type && rule.source_type !== event.source_type) return false
  if (rule.conversation_id) {
    let value = doc.conversation_id
    if (value === undefined && event.source_type === 'conversation') value = event.source_id
    if (value !== rule.conversation_id) return false
  }
  if (rule.agent_id) {
    let value = doc.agent_id
    if (value === undefined && event.source_type === 'agent') value = event.source_id
    if (value !== rule.agent_id) return false
  }
  return true
}

// Queue at most one run per (rule, event) for every unconsumed event that an
// enabled rule matches. An event is consumed once at least one run is created
// for it; events held only by cooldown or budget stay unconsumed for a later
// evaluation. ``budget`` caps how many runs one call may create.
export function evaluate(store, owner, now, budget = 100) {
  const at = stamp(now)
  if (!Number.isSafeInteger(budget) || budget < 0 || budget > 1000) fail('proactive/invalid', 'budget must be an integer between 0 and 1000')
  const rules = store.all('SELECT * FROM proactive_rules WHERE owner_id=? AND enabled=1 ORDER BY created, id', owner)
  const events = store.all('SELECT * FROM proactive_events WHERE owner_id=? AND consumed=0 ORDER BY created, id', owner)
  if (rules.length === 0 || events.length === 0 || budget === 0) return []
  const dayStart = Math.floor(at / DAY) * DAY
  const last = new Map()
  const counts = new Map()
  for (const rule of rules) {
    last.set(rule.id, store.get('SELECT MAX(created) AS newest FROM proactive_runs WHERE rule_id=?', rule.id).newest)
    counts.set(rule.id, store.get('SELECT COUNT(*) AS n FROM proactive_runs WHERE rule_id=? AND created>=? AND created<?', rule.id, dayStart, dayStart + DAY).n)
  }
  const created = []
  const consumed = []
  let made = 0
  return store.transaction(() => {
    for (const event of events) {
      if (made >= budget) break
      const doc = parsed(event.payload, {})
      let matched = false
      let truncated = false
      for (const rule of rules) {
        if (made >= budget) { truncated = true; break }
        if (!matches(rule, event, doc)) continue
        if (rule.cooldown_seconds && last.get(rule.id) !== null && at - last.get(rule.id) < rule.cooldown_seconds) continue
        if (counts.get(rule.id) >= rule.daily_budget) continue
        if (store.get('SELECT id FROM proactive_runs WHERE rule_id=? AND event_id=?', rule.id, event.id)) { matched = true; continue }
        const body = {
          rule: { id: rule.id, name: rule.name },
          event: { id: event.id, kind: event.kind, source_type: event.source_type, source_id: event.source_id, created: event.created, payload: doc },
          matched_at: at,
        }
        created.push(enqueueRun(store, owner, rule.id, event.id, body, at))
        made += 1
        last.set(rule.id, at)
        counts.set(rule.id, counts.get(rule.id) + 1)
        matched = true
      }
      if (matched && !truncated) consumed.push(event.id)
    }
    if (consumed.length > 0) {
      const marks = consumed.map(() => '?').join(',')
      store.run(`UPDATE proactive_events SET consumed=1 WHERE owner_id=? AND id IN (${marks})`, owner, ...consumed)
    }
    return created
  })
}

// Insert one run for a (rule, event) pair; a replay returns the existing row.
export function enqueueRun(store, owner, ruleId, eventId, payload, now, status = 'queued') {
  const at = stamp(now)
  const rule = text(ruleId, 'rule_id', MAX_ID)
  const event = text(eventId, 'event_id', MAX_ID)
  if (status !== 'queued' && status !== 'claimed') fail('proactive/invalid', 'status must be queued or claimed')
  const body = payloadText(payload, MAX_RUN_PAYLOAD)
  if (!store.get('SELECT id FROM proactive_rules WHERE owner_id=? AND id=?', owner, rule)) fail('proactive/invalid', 'unknown rule for this account')
  if (!store.get('SELECT id FROM proactive_events WHERE owner_id=? AND id=?', owner, event)) fail('proactive/invalid', 'unknown event for this account')
  const existing = store.get('SELECT * FROM proactive_runs WHERE rule_id=? AND event_id=?', rule, event)
  if (existing) return runView(existing)
  const id = randomUUID().replaceAll('-', '')
  try {
    store.run(
      `INSERT INTO proactive_runs
         (id, owner_id, rule_id, event_id, status, payload, attempts, lease_until, claim_token, result, error, created, updated, finished)
       VALUES (?,?,?,?,?,?,0,NULL,NULL,NULL,NULL,?,?,NULL)`,
      id, owner, rule, event, status, body, at, at,
    )
  } catch (error) {
    const raced = store.get('SELECT * FROM proactive_runs WHERE rule_id=? AND event_id=?', rule, event)
    if (!raced) throw error
    return runView(raced)
  }
  return runView(store.get('SELECT * FROM proactive_runs WHERE id=?', id))
}

// Lease up to ``limit`` queued or expired-claimed runs of this account. The
// lease is a claim token plus an expiry: a worker that dies mid-run leaves the
// row claimable again after ``leaseSeconds``.
export function claimRuns(store, owner, now, limit, leaseSeconds) {
  const at = stamp(now)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) fail('proactive/invalid', 'limit must be an integer between 1 and 1000')
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > MAX_LEASE) fail('proactive/invalid', 'lease_seconds must be a bounded positive integer')
  const token = randomUUID().replaceAll('-', '')
  const expires = at + leaseSeconds
  store.run(
    `UPDATE proactive_runs SET status='claimed', claim_token=?, lease_until=?, attempts=attempts+1, updated=?
     WHERE id IN (SELECT id FROM proactive_runs
                  WHERE owner_id=? AND (status='queued' OR (status='claimed' AND lease_until IS NOT NULL AND lease_until<=?))
                  ORDER BY created, id LIMIT ?)`,
    token, expires, at, owner, at, limit,
  )
  return store.all('SELECT * FROM proactive_runs WHERE claim_token=? AND owner_id=? ORDER BY created, id', token, owner).map(runView)
}

export function completeRun(store, owner, runId, status, result, now) {
  const at = stamp(now)
  const id = text(runId, 'run_id', MAX_ID)
  if (status !== 'succeeded' && status !== 'failed') fail('proactive/invalid', 'status must be succeeded or failed')
  const body = payloadText(result === undefined || result === null ? {} : result, MAX_RESULT)
  const row = store.get('SELECT * FROM proactive_runs WHERE id=? AND owner_id=?', id, owner)
  if (!row) return null
  if (TERMINAL.has(row.status)) return runView(row)
  store.run("UPDATE proactive_runs SET status=?, result=?, error=NULL, lease_until=NULL, claim_token=NULL, updated=?, finished=? WHERE id=? AND owner_id=?",
    status, body, at, at, id, owner)
  return runView(store.get('SELECT * FROM proactive_runs WHERE id=?', id))
}

// Record a failure. ``retryable`` returns the run to the queue with the error
// kept; a fatal failure finishes it. A terminal run is never overwritten.
export function failRun(store, owner, runId, error, now, retryable = true) {
  const at = stamp(now)
  const id = text(runId, 'run_id', MAX_ID)
  const message = text(error, 'error', MAX_ERROR)
  if (typeof retryable !== 'boolean') fail('proactive/invalid', 'retryable must be a boolean')
  const row = store.get('SELECT * FROM proactive_runs WHERE id=? AND owner_id=?', id, owner)
  if (!row) return null
  if (TERMINAL.has(row.status)) return runView(row)
  if (retryable) {
    store.run("UPDATE proactive_runs SET status='queued', error=?, lease_until=NULL, claim_token=NULL, updated=?, finished=NULL WHERE id=? AND owner_id=?",
      message, at, id, owner)
  } else {
    store.run("UPDATE proactive_runs SET status='failed', error=?, lease_until=NULL, claim_token=NULL, updated=?, finished=? WHERE id=? AND owner_id=?",
      message, at, at, id, owner)
  }
  return runView(store.get('SELECT * FROM proactive_runs WHERE id=?', id))
}

// One bounded message per run; replaying the same run returns the first message
// instead of storing or overwriting a second one.
export function recordMessage(store, owner, input, now) {
  const at = stamp(now)
  const runId = text(input.run_id, 'run_id', MAX_ID)
  const conversationId = text(input.conversation_id, 'conversation_id', MAX_ID)
  const body = text(input.body, 'body', MAX_BODY)
  const run = store.get('SELECT id FROM proactive_runs WHERE id=? AND owner_id=?', runId, owner)
  if (!run) fail('proactive/not-found', 'Unknown run')
  const existing = store.get('SELECT * FROM proactive_messages WHERE run_id=?', runId)
  if (existing) return messageView(existing)
  const id = randomUUID().replaceAll('-', '')
  try {
    store.run('INSERT INTO proactive_messages (id, owner_id, run_id, conversation_id, body, created) VALUES (?,?,?,?,?,?)',
      id, owner, runId, conversationId, body, at)
  } catch (error) {
    const raced = store.get('SELECT * FROM proactive_messages WHERE run_id=?', runId)
    if (!raced) throw error
    return messageView(raced)
  }
  return messageView(store.get('SELECT * FROM proactive_messages WHERE id=?', id))
}

// Keyset pagination over this account's messages in (created, id) order;
// ``cursor`` is the last id of the previous page.
export function listMessages(store, owner, limit = 100, cursor = null) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) fail('proactive/invalid', 'limit must be an integer between 1 and 100')
  if (cursor === undefined || cursor === null || cursor === '') {
    return store.all('SELECT * FROM proactive_messages WHERE owner_id=? ORDER BY created, id LIMIT ?', owner, limit).map(messageView)
  }
  const id = text(cursor, 'cursor', MAX_ID)
  const row = store.get('SELECT created, id FROM proactive_messages WHERE owner_id=? AND id=?', owner, id)
  if (!row) fail('proactive/invalid', 'unknown cursor')
  return store.all(
    'SELECT * FROM proactive_messages WHERE owner_id=? AND (created>? OR (created=? AND id>?)) ORDER BY created, id LIMIT ?',
    owner, row.created, row.created, row.id, limit,
  ).map(messageView)
}
