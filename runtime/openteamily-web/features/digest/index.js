// Per-user digest preferences, due selection, local assembly and run receipts.
//
// This feature decides *what* to summarize and *when* a digest is due, then
// stores the assembled plain-text summary so the same period is not recorded
// twice. Callers supply the candidate items; this module never reads
// notifications, proactive results, automations or works itself, and it does
// not send email, chat, webhook or any other message: `channel` is a stored
// label only. It does not call a model, rank by relevance, or invent prose.
// Everything is scoped to this DS-Bot's owner and to workspaces the owner can
// still reach through the personal binding or the active team list.
import { newId, openDatabase } from '../../src/store.js'
import { ownerId } from '../../featurekit/v1.js'

const CADENCES = ['daily', 'weekly', 'off']
const DEFAULT_CHANNEL = 'digest'
const HEX32 = /^[0-9a-f]{32}$/

const MAX_ITEMS = 50
const MAX_TITLE = 200
const MAX_ITEM_BODY = 500
const MAX_ITEM_HREF = 500
const MAX_BODY = 10000
const MAX_CHANNEL = 64
const MAX_KIND = 64
const MAX_PERIOD_KEY = 32
const MAX_ITEM_COUNT = 10000

const MAX_INPUT_ITEMS = 500
const MAX_TITLE_INPUT = 1000
const MAX_ITEM_BODY_INPUT = 10000
const MAX_HREF_INPUT = 2000

const SCHEMA = `
CREATE TABLE IF NOT EXISTS digest_prefs (
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  cadence TEXT NOT NULL CHECK(cadence IN ('daily','weekly','off')),
  hour_utc INTEGER NOT NULL CHECK(hour_utc BETWEEN 0 AND 23),
  channel TEXT NOT NULL,
  updated INTEGER NOT NULL,
  PRIMARY KEY(workspace_id,user_id));
CREATE INDEX IF NOT EXISTS digest_pref_due
  ON digest_prefs(enabled, cadence, hour_utc, workspace_id, user_id);
CREATE TABLE IF NOT EXISTS digest_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  period_key TEXT NOT NULL,
  item_count INTEGER NOT NULL CHECK(item_count >= 0),
  body TEXT NOT NULL,
  created INTEGER NOT NULL,
  UNIQUE(workspace_id,user_id,period_key));
CREATE INDEX IF NOT EXISTS digest_run_lookup
  ON digest_runs(workspace_id, user_id, period_key);
`

const invalid = (message) => Object.assign(new Error(message), { code: 'digest/invalid' })
const refuse = (code, message) => Object.assign(new Error(message), { code })

const prefView = (row) => ({
  workspace_id: row.workspace_id, user_id: row.user_id, enabled: row.enabled === 1,
  cadence: row.cadence, hour_utc: row.hour_utc, channel: row.channel, updated: row.updated,
})
const runView = (row) => ({
  id: row.id, workspace_id: row.workspace_id, user_id: row.user_id, period_key: row.period_key,
  item_count: row.item_count, body: row.body, created: row.created,
})

// epoch seconds only; the caller's `now` is the only clock this feature trusts.
function seconds(value, label = 'now') {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw invalid(`${label} must be epoch seconds`)
  return value
}

function moment(value, label = 'now') {
  return new Date(seconds(value, label) * 1000)
}

function text(value, label, limit, { required = true, singleLine = false } = {}) {
  if (typeof value !== 'string') throw invalid(`${label} must be text`)
  if (value.length > limit) throw invalid(`${label} exceeds ${limit} characters`)
  if (value.includes('\u0000')) throw invalid(`${label} contains a NUL character`)
  let cleaned = singleLine
    ? value.split(/\s+/).filter(Boolean).join(' ')
    : value.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  cleaned = [...cleaned].map((ch) => {
    const code = ch.codePointAt(0)
    return ch === '\n' || ch === '\t' || (code >= 32 && !(code >= 127 && code <= 159)) ? ch : ' '
  }).join('').trim()
  if (required && !cleaned) throw invalid(`${label} must not be empty`)
  return cleaned
}

const truncate = (value, limit) => (value.length <= limit ? value : value.slice(0, Math.max(0, limit - 1)) + '…')

// The body is plain text, never markup: caller-supplied angle brackets cannot
// be mistaken for an HTML fragment.
const render = (value) => value.replace(/</g, '‹').replace(/>/g, '›')

function periodKey(cadence, now) {
  if (cadence !== 'daily' && cadence !== 'weekly') throw invalid('cadence must be daily or weekly for a period key')
  const when = moment(now)
  if (cadence === 'weekly') {
    const target = new Date(Date.UTC(when.getUTCFullYear(), when.getUTCMonth(), when.getUTCDate()))
    target.setUTCDate(target.getUTCDate() - ((target.getUTCDay() + 6) % 7) + 3)
    const first = new Date(Date.UTC(target.getUTCFullYear(), 0, 4))
    first.setUTCDate(first.getUTCDate() - ((first.getUTCDay() + 6) % 7) + 3)
    const week = 1 + Math.round((target - first) / 604800000)
    return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
  }
  return when.toISOString().slice(0, 10)
}

const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0)

function normalItem(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('each item must be a mapping')
  if (typeof raw.kind !== 'string' || !raw.kind.trim()) return null
  if (typeof raw.title !== 'string' || !raw.title.trim()) return null
  const kind = truncate(text(raw.kind, 'kind', MAX_KIND, { singleLine: true }), MAX_KIND)
  const title = truncate(text(raw.title, 'item title', MAX_TITLE_INPUT, { singleLine: true }), MAX_TITLE)
  const body = raw.body === null || raw.body === undefined
    ? ''
    : truncate(text(raw.body, 'item body', MAX_ITEM_BODY_INPUT, { required: false }), MAX_ITEM_BODY)
  const href = raw.href === null || raw.href === undefined
    ? ''
    : truncate(text(raw.href, 'item href', MAX_HREF_INPUT, { required: false, singleLine: true }), MAX_ITEM_HREF)
  const created = typeof raw.created === 'number' && Number.isFinite(raw.created) ? Math.trunc(raw.created) : 0
  return { kind, title, body, created, href, read: Boolean(raw.read) }
}

const stamp = (created) => {
  const when = new Date(created * 1000)
  const pad = (value) => String(value).padStart(2, '0')
  return `${when.getUTCFullYear()}-${pad(when.getUTCMonth() + 1)}-${pad(when.getUTCDate())} `
    + `${pad(when.getUTCHours())}:${pad(when.getUTCMinutes())} UTC`
}

function itemLines(item) {
  const prefix = item.read ? '' : '[unread] '
  let headline = `- ${prefix}${render(item.title)}`
  if (item.created) headline += ' — ' + stamp(item.created)
  const lines = [headline]
  if (item.body) lines.push(...item.body.split('\n').map((line) => '  ' + render(line)))
  if (item.href) lines.push('  ' + render(item.href))
  return lines
}

// Group, sort and render caller-supplied items into a bounded plain-text body.
function assemble(items, cadence, now) {
  const key = periodKey(cadence, now)
  const groups = new Map()
  for (const raw of items) {
    const item = normalItem(raw)
    if (!item) continue
    if (!groups.has(item.kind)) groups.set(item.kind, [])
    groups.get(item.kind).push(item)
  }
  for (const group of groups.values()) {
    group.sort((left, right) => compare(Number(left.read), Number(right.read))
      || compare(right.created, left.created)
      || compare(left.title.toLowerCase(), right.title.toLowerCase())
      || compare(left.title, right.title)
      || compare(left.href, right.href)
      || compare(left.body, right.body))
  }

  const lines = [`Digest ${key}`, '']
  let used = lines[0].length + 2
  const sections = []
  let total = 0
  const kinds = [...groups.keys()].sort((left, right) => compare(left.toLowerCase(), right.toLowerCase()) || compare(left, right))
  for (const kind of kinds) {
    if (total >= MAX_ITEMS) break
    const rendered = []
    for (const item of groups.get(kind)) {
      if (total >= MAX_ITEMS) break
      const linesForItem = itemLines(item)
      let addition = linesForItem.reduce((sum, line) => sum + line.length + 1, 0)
      if (!rendered.length) addition += kind.length + 3
      if (used + addition > MAX_BODY) break
      if (!rendered.length) {
        lines.push(`[${kind}]`)
        used += kind.length + 3
      }
      lines.push(...linesForItem)
      used += linesForItem.reduce((sum, line) => sum + line.length + 1, 0)
      rendered.push({ ...item })
      total += 1
    }
    if (!rendered.length) continue
    lines.push('')
    used += 1
    sections.push({ kind, items: rendered })
  }

  if (total === 0) return { period_key: key, sections: [], body: '', item_count: 0 }
  let body = lines.join('\n').trim()
  if (body.length > MAX_BODY) body = body.slice(0, MAX_BODY)
  return { period_key: key, sections, body, item_count: total }
}

export default async function digest(host) {
  const db = await openDatabase(host, 'digest.sqlite3')
  db.exec(SCHEMA)
  const owner = ownerId()

  // The payload may restate the owner (`user_id`), never replace it.
  function caller(payload) {
    if (payload && Object.hasOwn(payload, 'user_id') && payload.user_id !== owner) {
      throw refuse('digest/foreign-user', 'A digest only covers the caller')
    }
    return owner
  }

  function workspace(payload) {
    const value = payload?.workspace_id
    if (typeof value !== 'string' || !HEX32.test(value)) throw invalid('workspace_id must be a 32-character id')
    return value
  }

  // Workspaces this DS-Bot may read: the personal binding plus the active team
  // list. When neither source answers, the feature fails closed.
  async function memberships() {
    let personal = null
    let personalAnswered = false
    try {
      personal = await host.call('agents/personal-binding', {})
      personalAnswered = true
    } catch { /* the agents feature could not answer */ }
    let teams = null
    let teamsAnswered = false
    try {
      teams = await host.call('teams/activeWorkspaces', {})
      teamsAnswered = true
    } catch { /* Bot Social could not answer */ }
    if (!personalAnswered && !teamsAnswered) throw refuse('workspace/unavailable', 'Workspace membership is unavailable right now')
    const ids = new Set()
    if (personal?.workspace_id) ids.add(personal.workspace_id)
    for (const item of Array.isArray(teams) ? teams : []) if (item?.id) ids.add(item.id)
    return ids
  }

  async function requireWorkspace(value) {
    const ids = await memberships()
    if (!ids.has(value)) throw refuse('workspace/not-found', 'This DS-Bot has no access to that workspace')
  }

  function prefOf(workspaceId, userId) {
    const row = db.prepare('SELECT * FROM digest_prefs WHERE workspace_id=? AND user_id=?').get(workspaceId, userId)
    return row ? prefView(row) : null
  }

  function recorded(workspaceId, userId, key) {
    return Boolean(db.prepare('SELECT 1 AS hit FROM digest_runs WHERE workspace_id=? AND user_id=? AND period_key=?').get(workspaceId, userId, key))
  }

  function dueAt(now) {
    const when = moment(now)
    const rows = db.prepare("SELECT * FROM digest_prefs WHERE user_id=? AND enabled=1 AND cadence IN ('daily','weekly') ORDER BY workspace_id").all(owner)
    const ready = []
    for (const row of rows) {
      if (when.getUTCHours() < row.hour_utc) continue
      const key = periodKey(row.cadence, now)
      if (recorded(row.workspace_id, owner, key)) continue
      ready.push({ ...prefView(row), period_key: key })
    }
    return ready
  }

  function buildFor(workspaceId, items, now) {
    if (!Array.isArray(items)) throw invalid('items must be a list')
    if (items.length > MAX_INPUT_ITEMS) throw invalid(`items exceeds ${MAX_INPUT_ITEMS} entries`)
    const pref = prefOf(workspaceId, owner)
    const cadence = pref && (pref.cadence === 'daily' || pref.cadence === 'weekly') ? pref.cadence : 'daily'
    return assemble(items, cadence, now)
  }

  function recordRun(workspaceId, key, body, itemCount, now) {
    const period = text(key, 'period_key', MAX_PERIOD_KEY, { singleLine: true })
    const content = text(body, 'body', MAX_BODY, { required: false })
    if (!Number.isInteger(itemCount) || itemCount < 0) throw invalid('item_count must be a non-negative integer')
    if (itemCount > MAX_ITEM_COUNT) throw invalid(`item_count exceeds ${MAX_ITEM_COUNT}`)
    const created = seconds(now)
    const result = db.prepare('INSERT OR IGNORE INTO digest_runs(id,workspace_id,user_id,period_key,item_count,body,created) VALUES(?,?,?,?,?,?,?)')
      .run(newId(), workspaceId, owner, period, itemCount, content, created)
    const row = db.prepare('SELECT * FROM digest_runs WHERE workspace_id=? AND user_id=? AND period_key=?').get(workspaceId, owner, period)
    return { run: runView(row), created: Number(result.changes) > 0 }
  }

  return {
    endpoints: {
      // Read this owner's preference for one workspace; `pref: null` when unset.
      async get(payload) {
        const userId = caller(payload)
        const workspaceId = workspace(payload)
        await requireWorkspace(workspaceId)
        return { pref: prefOf(workspaceId, userId) }
      },

      // Create or replace this owner's preference for one workspace.
      async set(payload) {
        const userId = caller(payload)
        const workspaceId = workspace(payload)
        const cadence = payload?.cadence
        if (!CADENCES.includes(cadence)) throw invalid('cadence must be daily, weekly or off')
        const hour = payload?.hour_utc
        if (typeof hour !== 'number' || !Number.isInteger(hour) || hour < 0 || hour > 23) throw invalid('hour_utc must be an integer from 0 to 23')
        const channel = text(payload?.channel ?? DEFAULT_CHANNEL, 'channel', MAX_CHANNEL, { singleLine: true })
        const enabled = payload?.enabled ?? true
        if (enabled !== true && enabled !== false) throw invalid('enabled must be a boolean')
        const updated = seconds(payload?.now)
        await requireWorkspace(workspaceId)
        db.prepare('INSERT INTO digest_prefs(workspace_id,user_id,enabled,cadence,hour_utc,channel,updated) VALUES(?,?,?,?,?,?,?) ON CONFLICT(workspace_id,user_id) DO UPDATE SET enabled=excluded.enabled,cadence=excluded.cadence,hour_utc=excluded.hour_utc,channel=excluded.channel,updated=excluded.updated')
          .run(workspaceId, userId, enabled ? 1 : 0, cadence, hour, channel, updated)
        return { pref: prefOf(workspaceId, userId) }
      },

      // Preferences ready at or after their UTC hour with no receipt for this period.
      async due(payload) {
        caller(payload)
        const now = seconds(payload?.now)
        const ids = await memberships()
        return { items: dueAt(now).filter((item) => ids.has(item.workspace_id)) }
      },

      // Assemble a digest body for caller-supplied items without storing it.
      async build(payload) {
        caller(payload)
        const workspaceId = workspace(payload)
        const now = seconds(payload?.now)
        await requireWorkspace(workspaceId)
        return { digest: buildFor(workspaceId, payload?.items, now) }
      },

      // Assemble and store one receipt per period; an empty digest is not recorded.
      async run(payload) {
        caller(payload)
        const workspaceId = workspace(payload)
        const now = seconds(payload?.now)
        await requireWorkspace(workspaceId)
        const built = buildFor(workspaceId, payload?.items, now)
        if (built.item_count === 0) return { run: null, created: false }
        return recordRun(workspaceId, built.period_key, built.body, built.item_count, now)
      },

      // This owner's receipts for one workspace, newest first.
      async runs(payload) {
        caller(payload)
        const workspaceId = workspace(payload)
        const limit = payload?.limit ?? 20
        if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid('limit must be an integer from 1 to 100')
        await requireWorkspace(workspaceId)
        const items = db.prepare('SELECT * FROM digest_runs WHERE workspace_id=? AND user_id=? ORDER BY created DESC, id DESC LIMIT ?')
          .all(workspaceId, owner, limit).map(runView)
        return { items }
      },
    },
  }
}
