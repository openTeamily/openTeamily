// Shared scratchpad for multi-agent runs. It is a CAS/revisioned key-value
// store, not an execution engine. DSH still owns sessions, subagents and tools.
import { HEX32, digest, refuse, stableJson } from '../../featurekit/http.js'

export const LIMITS = Object.freeze({
  maxValueBytes: 256 * 1024,
  maxEntries: 1000,
  maxScopeEntries: 200,
  maxList: 100,
})
export const VISIBILITIES = Object.freeze(['private', 'run', 'workspace'])
export const CONTENT_TYPES = Object.freeze(['application/json', 'text/plain'])
const SCOPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/
const CLIENT_KEY = /^[A-Za-z0-9_-]{16,64}$/
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const CURSOR = /^[A-Za-z0-9_-]{1,400}$/

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_scratchpad (
  workspace_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  revision INTEGER NOT NULL,
  value TEXT NOT NULL,
  value_bytes INTEGER NOT NULL,
  content_type TEXT NOT NULL CHECK(content_type IN ('application/json','text/plain')),
  visibility TEXT NOT NULL CHECK(visibility IN ('private','run','workspace')),
  owner_agent_id TEXT,
  owner_run_id TEXT,
  client_key TEXT,
  request_hash TEXT,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  expires INTEGER,
  PRIMARY KEY(workspace_id, scope, key)
);
CREATE INDEX IF NOT EXISTS agent_scratchpad_list ON agent_scratchpad(workspace_id, scope, key);
CREATE INDEX IF NOT EXISTS agent_scratchpad_expiry ON agent_scratchpad(workspace_id, expires);
`

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value, maximum) => typeof value === 'string' && value.length <= maximum && !CONTROL.test(value)
const validId = (value) => typeof value === 'string' && HEX32.test(value)

function valueOf(payload) {
  const contentType = payload.content_type ?? (typeof payload.value === 'string' ? 'text/plain' : 'application/json')
  if (!CONTENT_TYPES.includes(contentType)) refuse(400, 'invalid', 'content_type is invalid')
  let serialized
  if (contentType === 'text/plain') {
    if (typeof payload.value !== 'string') refuse(400, 'invalid', 'text/plain value must be a string')
    serialized = payload.value
  } else {
    try { serialized = JSON.stringify(payload.value) } catch { refuse(400, 'invalid', 'JSON value is not serializable') }
    if (serialized === undefined) refuse(400, 'invalid', 'JSON value is required')
  }
  const bytes = Buffer.byteLength(serialized, 'utf8')
  if (bytes > LIMITS.maxValueBytes) refuse(413, 'too_large', `value must be at most ${LIMITS.maxValueBytes} bytes`)
  return { contentType, serialized, bytes }
}

function parseValue(row) {
  return row.content_type === 'text/plain' ? row.value : JSON.parse(row.value)
}

export function view(row) {
  if (!row) return null
  return {
    workspace_id: row.workspace_id,
    scope: row.scope,
    key: row.key,
    revision: row.revision,
    value: parseValue(row),
    content_type: row.content_type,
    value_bytes: row.value_bytes,
    visibility: row.visibility,
    owner_agent_id: row.owner_agent_id,
    owner_run_id: row.owner_run_id,
    created: row.created,
    updated: row.updated,
    expires_at: row.expires,
  }
}

function encodeCursor(scope, key) {
  return Buffer.from(JSON.stringify([scope, key]), 'utf8').toString('base64url')
}

function decodeCursor(value) {
  if (value === '' || value === undefined || value === null) return null
  if (!CURSOR.test(value)) refuse(400, 'invalid', 'Invalid cursor')
  try {
    const parts = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (!Array.isArray(parts) || parts.length !== 2 || !SCOPE.test(parts[0]) || !KEY.test(parts[1])) throw new Error()
    return parts
  } catch {
    refuse(400, 'invalid', 'Invalid cursor')
  }
}

export function createScratchpad(db, { clock = () => Math.floor(Date.now() / 1000) } = {}) {
  db.exec(SCHEMA)
  const one = (sql, ...args) => db.prepare(sql).get(...args) ?? null
  const all = (sql, ...args) => db.prepare(sql).all(...args)
  const run = (sql, ...args) => db.prepare(sql).run(...args)
  const now = () => Math.max(0, Math.floor(clock()))

  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const value = fn()
      db.exec('COMMIT')
      return value
    } catch (error) {
      try { db.exec('ROLLBACK') } catch {}
      throw error
    }
  }

  function sweep(workspaceId) {
    run('DELETE FROM agent_scratchpad WHERE workspace_id=? AND expires IS NOT NULL AND expires<=?', workspaceId, now())
  }

  function requireRow(workspaceId, scope, key) {
    const row = one('SELECT * FROM agent_scratchpad WHERE workspace_id=? AND scope=? AND key=?', workspaceId, scope, key)
    if (row && row.expires !== null && row.expires <= now()) {
      run('DELETE FROM agent_scratchpad WHERE workspace_id=? AND scope=? AND key=?', workspaceId, scope, key)
      return null
    }
    return row
  }

  function get(workspaceId, scope, key) {
    if (!validId(workspaceId) || !SCOPE.test(scope) || !KEY.test(key)) refuse(400, 'invalid', 'Invalid scratchpad identity')
    return view(requireRow(workspaceId, scope, key))
  }

  function put(workspaceId, payload) {
    if (!validId(workspaceId)) refuse(400, 'invalid', 'workspace_id must be 32 lowercase hex characters')
    const scope = payload?.scope
    const key = payload?.key
    if (typeof scope !== 'string' || !SCOPE.test(scope)) refuse(400, 'invalid', 'scope is invalid')
    if (typeof key !== 'string' || !KEY.test(key)) refuse(400, 'invalid', 'key is invalid')
    const { contentType, serialized, bytes } = valueOf(payload)
    const visibility = payload.visibility ?? 'run'
    if (!VISIBILITIES.includes(visibility)) refuse(400, 'invalid', 'visibility is invalid')
    const ownerAgent = payload.owner_agent_id ?? null
    const ownerRun = payload.owner_run_id ?? null
    if (ownerAgent !== null && !validId(ownerAgent)) refuse(400, 'invalid', 'owner_agent_id is invalid')
    if (ownerRun !== null && !validId(ownerRun)) refuse(400, 'invalid', 'owner_run_id is invalid')
    const clientKey = payload.client_key ?? null
    if (clientKey !== null && !CLIENT_KEY.test(clientKey)) refuse(400, 'invalid', 'client_key is invalid')
    const expected = payload.expected_revision ?? 0
    if (!Number.isSafeInteger(expected) || expected < 0) refuse(400, 'invalid', 'expected_revision is invalid')
    const expires = payload.expires_at ?? null
    if (expires !== null && (!Number.isSafeInteger(expires) || expires <= now())) {
      refuse(400, 'invalid', 'expires_at must be a future integer timestamp')
    }
    const requestHash = digest(stableJson({ scope, key, value: serialized, content_type: contentType, visibility,
      owner_agent_id: ownerAgent, owner_run_id: ownerRun, expires_at: expires }))
    return transaction(() => {
      sweep(workspaceId)
      const current = requireRow(workspaceId, scope, key)
      if (current && clientKey && current.client_key === clientKey) {
        if (current.request_hash !== requestHash) refuse(409, 'conflict', 'client_key was used for a different value', view(current))
        return { status: 200, entry: view(current), replayed: true }
      }
      if (current) {
        if (current.revision !== expected) refuse(409, 'conflict', 'Scratchpad entry changed elsewhere', view(current))
        const next = current.revision + 1
        run(`UPDATE agent_scratchpad SET revision=?, value=?, value_bytes=?, content_type=?, visibility=?,
          owner_agent_id=?, owner_run_id=?, client_key=?, request_hash=?, updated=?, expires=?
          WHERE workspace_id=? AND scope=? AND key=?`,
        next, serialized, bytes, contentType, visibility, ownerAgent, ownerRun, clientKey, requestHash, now(), expires,
        workspaceId, scope, key)
        return { status: 200, entry: view(requireRow(workspaceId, scope, key)), replayed: false }
      }
      if (expected !== 0) refuse(409, 'conflict', 'Scratchpad entry does not exist at that revision')
      const total = one('SELECT COUNT(*) AS n FROM agent_scratchpad WHERE workspace_id=?', workspaceId).n
      if (total >= LIMITS.maxEntries) refuse(429, 'quota', 'Scratchpad entry quota reached')
      const scoped = one('SELECT COUNT(*) AS n FROM agent_scratchpad WHERE workspace_id=? AND scope=?', workspaceId, scope).n
      if (scoped >= LIMITS.maxScopeEntries) refuse(429, 'quota', 'Scratchpad scope quota reached')
      run(`INSERT INTO agent_scratchpad
        (workspace_id,scope,key,revision,value,value_bytes,content_type,visibility,owner_agent_id,owner_run_id,
         client_key,request_hash,created,updated,expires)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      workspaceId, scope, key, 1, serialized, bytes, contentType, visibility, ownerAgent, ownerRun,
      clientKey, requestHash, now(), now(), expires)
      return { status: 201, entry: view(requireRow(workspaceId, scope, key)), replayed: false }
    })
  }

  function list(workspaceId, payload = {}) {
    if (!validId(workspaceId)) refuse(400, 'invalid', 'workspace_id must be 32 lowercase hex characters')
    const limit = Number(payload.limit ?? 20)
    if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.maxList) refuse(400, 'invalid', 'limit is invalid')
    const scope = payload.scope ?? null
    if (scope !== null && (typeof scope !== 'string' || !SCOPE.test(scope))) refuse(400, 'invalid', 'scope is invalid')
    const prefix = payload.prefix ?? null
    if (prefix !== null && (typeof prefix !== 'string' || !KEY.test(prefix))) refuse(400, 'invalid', 'prefix is invalid')
    const cursor = decodeCursor(payload.cursor)
    sweep(workspaceId)
    const where = ['workspace_id=?']
    const args = [workspaceId]
    if (scope) { where.push('scope=?'); args.push(scope) }
    if (prefix) { where.push('key>=?'); where.push('key<?'); args.push(prefix, prefix + '\uffff') }
    if (cursor) { where.push('(scope,key)>(?,?)'); args.push(cursor[0], cursor[1]) }
    const rows = all(`SELECT * FROM agent_scratchpad WHERE ${where.join(' AND ')} ORDER BY scope,key LIMIT ?`, ...args, limit + 1)
    const items = rows.slice(0, limit).map(view)
    const last = items.at(-1)
    return { items, cursor: rows.length > limit && last ? encodeCursor(last.scope, last.key) : null }
  }

  function remove(workspaceId, payload) {
    if (!validId(workspaceId)) refuse(400, 'invalid', 'workspace_id must be 32 lowercase hex characters')
    const scope = payload?.scope
    const key = payload?.key
    if (typeof scope !== 'string' || !SCOPE.test(scope) || typeof key !== 'string' || !KEY.test(key)) {
      refuse(400, 'invalid', 'Invalid scratchpad identity')
    }
    return transaction(() => {
      const current = requireRow(workspaceId, scope, key)
      if (!current) refuse(404, 'not_found', 'Scratchpad entry not found')
      const expected = payload.expected_revision
      if (expected !== undefined && (!Number.isSafeInteger(expected) || expected !== current.revision)) {
        refuse(409, 'conflict', 'Scratchpad entry changed elsewhere', view(current))
      }
      run('DELETE FROM agent_scratchpad WHERE workspace_id=? AND scope=? AND key=?', workspaceId, scope, key)
      return { removed: { scope, key, revision: current.revision } }
    })
  }

  function stats(workspaceId, payload = {}) {
    if (!validId(workspaceId)) refuse(400, 'invalid', 'workspace_id must be 32 lowercase hex characters')
    const scope = payload.scope ?? null
    if (scope !== null && (typeof scope !== 'string' || !SCOPE.test(scope))) refuse(400, 'invalid', 'scope is invalid')
    sweep(workspaceId)
    const rows = all(`SELECT scope,COUNT(*) AS entries,COALESCE(SUM(value_bytes),0) AS bytes
      FROM agent_scratchpad WHERE workspace_id=? ${scope ? 'AND scope=?' : ''} GROUP BY scope`,
    ...(scope ? [workspaceId, scope] : [workspaceId]))
    return {
      scopes: rows,
      total_entries: rows.reduce((sum, row) => sum + row.entries, 0),
      total_bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
    }
  }

  return { get, put, list, remove, stats }
}
