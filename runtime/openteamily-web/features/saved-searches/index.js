// Saved searches inside the user's own DS-Bot (moved from the legacy Python
// saved_searches module). This feature stores each workspace owner's saved
// query/filter record and records the outcome of checks made by a caller. It
// does not execute searches or deliver alerts: a caller runs the query and
// reports the matched count through saved-searches/recordCheck.
import { openDatabase, newId } from '../../src/store.js'
import { stableJson } from '../../featurekit/http.js'
import { ownerId } from '../../featurekit/v1.js'

export const SCOPES = ['messages', 'works', 'agents', 'artifacts']
export const NAME_MAX = 80
export const QUERY_MAX = 200
export const FILTERS_MAX = 4096
export const SUMMARY_MAX = 500
export const MATCHED_MAX = 10000000
export const INTERVAL_MIN = 60
export const INTERVAL_MAX = 30 * 86400
export const LIST_LIMIT_MAX = 100
export const DUE_LIMIT_MAX = 200

const DEFAULT_INTERVAL = 86400
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/
const has = (value, key) => Object.hasOwn(value, key)
const points = (value) => [...value].length

const SCHEMA = `
CREATE TABLE IF NOT EXISTS saved_searches (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('messages','works','agents','artifacts')),
  query TEXT NOT NULL,
  filters TEXT NOT NULL DEFAULT '{}',
  alerts INTEGER NOT NULL DEFAULT 0 CHECK(alerts IN (0,1)),
  interval_seconds INTEGER NOT NULL DEFAULT 86400,
  last_checked INTEGER,
  last_alert INTEGER,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  UNIQUE(workspace_id, owner_id, name));
CREATE INDEX IF NOT EXISTS saved_search_owner ON saved_searches(workspace_id, owner_id, id);
CREATE INDEX IF NOT EXISTS saved_search_scope ON saved_searches(workspace_id, scope, id);
CREATE INDEX IF NOT EXISTS saved_search_due ON saved_searches(alerts, last_checked);
CREATE TABLE IF NOT EXISTS saved_search_runs (
  id TEXT PRIMARY KEY,
  search_id TEXT NOT NULL REFERENCES saved_searches(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  matched INTEGER NOT NULL,
  summary TEXT,
  created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS saved_search_run_search ON saved_search_runs(search_id, created, id);
CREATE INDEX IF NOT EXISTS saved_search_run_workspace ON saved_search_runs(workspace_id, created, id);
`

export function ensureSchema(db) {
  db.exec('PRAGMA foreign_keys=ON')
  db.exec(SCHEMA)
}

export function fail(code, message, status = 400) {
  throw Object.assign(new Error(message), { code: `saved-searches/${code}`, status })
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)

function plainJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(plainJson)
  if (isPlainObject(value)) return Object.values(value).every(plainJson)
  return false
}

function idValue(value, label) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 100 || CONTROL.test(value)) {
    fail('invalid', `${label} must be 1..100 characters without control characters`)
  }
  return value
}

function nameValue(value) {
  if (typeof value !== 'string') fail('invalid', 'name must be a string')
  const name = value.trim()
  if (points(name) < 1 || points(name) > NAME_MAX || CONTROL.test(value)) {
    fail('invalid', `name must be 1..${NAME_MAX} characters without control characters`)
  }
  return name
}

function queryValue(value) {
  if (typeof value !== 'string') fail('invalid', 'query must be a string')
  if (points(value.trim()) < 1 || points(value.trim()) > QUERY_MAX || CONTROL.test(value)) {
    fail('invalid', `query must be 1..${QUERY_MAX} characters without control characters`)
  }
  return value
}

function scopeValue(value) {
  if (!SCOPES.includes(value)) fail('invalid', `scope must be one of ${SCOPES.join(', ')}`)
  return value
}

function intervalValue(value) {
  if (!Number.isInteger(value) || value < INTERVAL_MIN || value > INTERVAL_MAX) {
    fail('invalid', `interval_seconds must be ${INTERVAL_MIN}..${INTERVAL_MAX}`)
  }
  return value
}

function alertValue(value) {
  if (typeof value !== 'boolean') fail('invalid', 'alerts must be a boolean')
  return value ? 1 : 0
}

function filtersValue(value) {
  if (value === undefined || value === null) return '{}'
  if (!isPlainObject(value) || !plainJson(value)) fail('invalid', 'filters must be a plain JSON object')
  let encoded
  try {
    encoded = stableJson(value)
  } catch {
    fail('invalid', 'filters must be JSON serializable')
  }
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded, 'utf8') > FILTERS_MAX) {
    fail('invalid', `filters exceed ${FILTERS_MAX} bytes`)
  }
  return encoded
}

function summaryValue(value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || points(value) > SUMMARY_MAX) {
    fail('invalid', `summary must be at most ${SUMMARY_MAX} characters`)
  }
  return value
}

function matchedValue(value) {
  if (!Number.isInteger(value) || value < 0 || value > MATCHED_MAX) {
    fail('invalid', `matched must be an integer in 0..${MATCHED_MAX}`)
  }
  return value
}

function timestampValue(value, label = 'timestamp') {
  if (!Number.isInteger(value)) fail('invalid', `${label} must be an integer`)
  return value
}

function limitValue(value, maximum, fallback) {
  if (value === undefined || value === null) return fallback
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    fail('invalid', `limit must be 1..${maximum}`)
  }
  return value
}

function view(row) {
  let filters = {}
  try {
    const parsed = JSON.parse(row.filters)
    if (isPlainObject(parsed)) filters = parsed
  } catch { /* stored rows are validated; fall back to an empty object */ }
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    owner_id: row.owner_id,
    name: row.name,
    scope: row.scope,
    query: row.query,
    filters,
    alerts: Boolean(row.alerts),
    interval_seconds: row.interval_seconds,
    last_checked: row.last_checked,
    last_alert: row.last_alert,
    created: row.created,
    updated: row.updated,
  }
}

const runView = (row) => ({
  id: row.id,
  search_id: row.search_id,
  workspace_id: row.workspace_id,
  matched: row.matched,
  summary: row.summary,
  created: row.created,
})

export function createSavedSearches({ db, clock = () => Math.floor(Date.now() / 1000), defaultOwner = 'owner' }) {
  ensureSchema(db)
  const one = (sql, ...args) => db.prepare(sql).get(...args) ?? null
  const all = (sql, ...args) => db.prepare(sql).all(...args)
  const run = (sql, ...args) => db.prepare(sql).run(...args)
  const body = (payload) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('invalid', 'payload object required')
    return payload
  }
  const workspace = (payload) => idValue(payload.workspace_id, 'workspace_id')
  const owner = (payload) => idValue(payload.owner_id ?? defaultOwner, 'owner_id')
  const load = (workspaceId, id) => (typeof id === 'string'
    ? one('SELECT * FROM saved_searches WHERE workspace_id=? AND id=?', workspaceId, id)
    : null)
  const transaction = (fn) => {
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

  const endpoints = {
    async create(payload) {
      const p = body(payload)
      const workspaceId = workspace(p)
      const ownerIdValue = owner(p)
      const name = nameValue(p.name)
      const scope = scopeValue(p.scope)
      const query = queryValue(p.query)
      const encoded = filtersValue(has(p, 'filters') ? p.filters : undefined)
      const alerts = has(p, 'alerts') ? alertValue(p.alerts) : 0
      const interval = has(p, 'interval_seconds') ? intervalValue(p.interval_seconds) : DEFAULT_INTERVAL
      const stamp = timestampValue(p.now ?? clock(), 'now')
      const id = newId()
      return transaction(() => {
        if (one('SELECT id FROM saved_searches WHERE workspace_id=? AND owner_id=? AND name=?', workspaceId, ownerIdValue, name)) {
          fail('conflict', 'duplicate saved search name for this owner', 409)
        }
        run(`INSERT INTO saved_searches
          (id,workspace_id,owner_id,name,scope,query,filters,alerts,interval_seconds,last_checked,last_alert,created,updated)
          VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL,?,?)`,
        id, workspaceId, ownerIdValue, name, scope, query, encoded, alerts, interval, stamp, stamp)
        return view(one('SELECT * FROM saved_searches WHERE id=?', id))
      })
    },

    async get(payload) {
      const p = body(payload)
      const workspaceId = workspace(p)
      const row = load(workspaceId, p.id)
      if (!row) fail('not-found', 'Saved search not found', 404)
      if (has(p, 'owner_id') && p.owner_id !== undefined && p.owner_id !== null
          && row.owner_id !== idValue(p.owner_id, 'owner_id')) {
        fail('not-found', 'Saved search not found', 404)
      }
      return view(row)
    },

    async list(payload) {
      const p = body(payload)
      const workspaceId = workspace(p)
      const limit = limitValue(p.limit, LIST_LIMIT_MAX, 20)
      const clauses = ['workspace_id=?']
      const params = [workspaceId]
      if (has(p, 'owner_id') && p.owner_id !== undefined && p.owner_id !== null) {
        clauses.push('owner_id=?')
        params.push(idValue(p.owner_id, 'owner_id'))
      }
      if (has(p, 'scope') && p.scope !== undefined && p.scope !== null) {
        clauses.push('scope=?')
        params.push(scopeValue(p.scope))
      }
      if (typeof p.cursor === 'string' && p.cursor) {
        const seat = one('SELECT created FROM saved_searches WHERE workspace_id=? AND id=?', workspaceId, p.cursor)
        if (seat) {
          clauses.push('(created < ? OR (created = ? AND id < ?))')
          params.push(seat.created, seat.created, p.cursor)
        }
      }
      const rows = all('SELECT * FROM saved_searches WHERE ' + clauses.join(' AND ')
        + ' ORDER BY created DESC, id DESC LIMIT ?', ...params, limit + 1)
      const items = rows.slice(0, limit).map(view)
      return { items, cursor: rows.length > limit ? items[items.length - 1].id : null }
    },

    async update(payload) {
      const p = body(payload)
      const workspaceId = workspace(p)
      const ownerIdValue = owner(p)
      const id = typeof p.id === 'string' ? p.id : null
      if (!id) return null
      const stamp = timestampValue(p.now ?? clock(), 'now')
      const sets = []
      const params = []
      let name = null
      if (has(p, 'name') && p.name !== undefined) {
        name = nameValue(p.name)
        sets.push('name=?')
        params.push(name)
      }
      if (has(p, 'scope') && p.scope !== undefined) {
        sets.push('scope=?')
        params.push(scopeValue(p.scope))
      }
      if (has(p, 'query') && p.query !== undefined) {
        sets.push('query=?')
        params.push(queryValue(p.query))
      }
      if (has(p, 'filters') && p.filters !== undefined) {
        sets.push('filters=?')
        params.push(filtersValue(p.filters))
      }
      if (has(p, 'alerts') && p.alerts !== undefined) {
        sets.push('alerts=?')
        params.push(alertValue(p.alerts))
      }
      if (has(p, 'interval_seconds') && p.interval_seconds !== undefined) {
        sets.push('interval_seconds=?')
        params.push(intervalValue(p.interval_seconds))
      }
      sets.push('updated=?')
      params.push(stamp)
      return transaction(() => {
        if (!one('SELECT id FROM saved_searches WHERE workspace_id=? AND id=? AND owner_id=?', workspaceId, id, ownerIdValue)) {
          return null
        }
        if (name !== null && one('SELECT id FROM saved_searches WHERE workspace_id=? AND owner_id=? AND name=? AND id<>?',
          workspaceId, ownerIdValue, name, id)) {
          fail('conflict', 'duplicate saved search name for this owner', 409)
        }
        run('UPDATE saved_searches SET ' + sets.join(',') + ' WHERE workspace_id=? AND id=? AND owner_id=?',
          ...params, workspaceId, id, ownerIdValue)
        return view(one('SELECT * FROM saved_searches WHERE workspace_id=? AND id=?', workspaceId, id))
      })
    },

    async delete(payload) {
      const p = body(payload)
      const workspaceId = workspace(p)
      const ownerIdValue = owner(p)
      const id = typeof p.id === 'string' ? p.id : null
      if (!id) return { deleted: false }
      return transaction(() => {
        if (!one('SELECT id FROM saved_searches WHERE workspace_id=? AND id=? AND owner_id=?', workspaceId, id, ownerIdValue)) {
          return { deleted: false }
        }
        run('DELETE FROM saved_search_runs WHERE workspace_id=? AND search_id=?', workspaceId, id)
        run('DELETE FROM saved_searches WHERE workspace_id=? AND id=? AND owner_id=?', workspaceId, id, ownerIdValue)
        return { deleted: true }
      })
    },

    async dueForAlert(payload) {
      const p = body(payload)
      const stamp = timestampValue(p.now ?? clock(), 'now')
      const limit = limitValue(p.limit, DUE_LIMIT_MAX, 50)
      const clauses = ['alerts=1', '(last_checked IS NULL OR last_checked + interval_seconds <= ?)']
      const params = [stamp]
      if (has(p, 'workspace_id') && p.workspace_id !== undefined && p.workspace_id !== null) {
        clauses.push('workspace_id=?')
        params.push(idValue(p.workspace_id, 'workspace_id'))
      }
      if (has(p, 'owner_id') && p.owner_id !== undefined && p.owner_id !== null) {
        clauses.push('owner_id=?')
        params.push(idValue(p.owner_id, 'owner_id'))
      }
      const rows = all('SELECT * FROM saved_searches WHERE ' + clauses.join(' AND ')
        + ' ORDER BY last_checked IS NOT NULL, last_checked, created, id LIMIT ?', ...params, limit)
      return { items: rows.map(view) }
    },

    async recordCheck(payload) {
      const p = body(payload)
      const workspaceId = workspace(p)
      const matched = matchedValue(p.matched)
      const summary = summaryValue(p.summary)
      const stamp = timestampValue(p.now ?? clock(), 'now')
      const id = typeof p.id === 'string' ? p.id : null
      if (!id) return null
      const runId = newId()
      return transaction(() => {
        if (!load(workspaceId, id)) return null
        if (matched > 0) {
          run('UPDATE saved_searches SET last_checked=?, last_alert=? WHERE workspace_id=? AND id=?',
            stamp, stamp, workspaceId, id)
        } else {
          run('UPDATE saved_searches SET last_checked=? WHERE workspace_id=? AND id=?', stamp, workspaceId, id)
        }
        run('INSERT INTO saved_search_runs (id,search_id,workspace_id,matched,summary,created) VALUES (?,?,?,?,?,?)',
          runId, id, workspaceId, matched, summary, stamp)
        return runView(one('SELECT * FROM saved_search_runs WHERE id=?', runId))
      })
    },

    async stats(payload) {
      const p = body(payload)
      const workspaceId = workspace(p)
      const stamp = p.now === undefined || p.now === null ? null : timestampValue(p.now, 'now')
      const clauses = ['workspace_id=?']
      const params = [workspaceId]
      const ownerFilter = has(p, 'owner_id') && p.owner_id !== undefined && p.owner_id !== null
      if (ownerFilter) {
        clauses.push('owner_id=?')
        params.push(idValue(p.owner_id, 'owner_id'))
      }
      const where = clauses.join(' AND ')
      const counts = one('SELECT COUNT(*) AS searches, COALESCE(SUM(alerts),0) AS alerts FROM saved_searches WHERE ' + where, ...params)
      const runs = ownerFilter
        ? one('SELECT COUNT(*) AS runs FROM saved_search_runs r JOIN saved_searches s ON s.id=r.search_id AND s.workspace_id=r.workspace_id '
          + 'WHERE r.workspace_id=? AND s.owner_id=?', workspaceId, params[params.length - 1]).runs
        : one('SELECT COUNT(*) AS runs FROM saved_search_runs WHERE workspace_id=?', workspaceId).runs
      const data = { searches: counts.searches, alerts: counts.alerts, runs }
      if (stamp !== null) {
        data.due = one('SELECT COUNT(*) AS due FROM saved_searches WHERE ' + where
          + ' AND alerts=1 AND (last_checked IS NULL OR last_checked + interval_seconds <= ?)', ...params, stamp).due
      }
      return data
    },
  }

  return { db, endpoints }
}

export default async function savedSearches(host) {
  const db = await openDatabase(host, 'saved-searches.sqlite3')
  const feature = createSavedSearches({ db, defaultOwner: ownerId() })
  return { endpoints: feature.endpoints }
}
