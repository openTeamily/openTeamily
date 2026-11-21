import { verifyBundle } from '../../featurekit/bundle.js'

export const COLUMNS = ['id', 'workspace_id', 'agent_id', 'name', 'token_hash', 'scope',
  'rate_per_minute', 'created', 'last_used', 'revoked']

export const IMPORT_TABLES = {
  agent_api_keys: COLUMNS,
  api_keys: COLUMNS,
}

const ID = /^[0-9a-f]{32}$/
const HASH = /^[0-9a-f]{64}$/
const NAME = /^[^\u0000-\u001f\u007f]{1,60}$/
const now = () => Math.floor(Date.now() / 1000)

function invalid(message) {
  throw Object.assign(new Error(message), { code: 'agent-api/invalid', status: 400 })
}

export function verifyOfficial(bundle) {
  if (!bundle || bundle.format !== 'openteamily-dsbot-import' || bundle.version !== 1) invalid('unsupported bundle format')
  if (bundle.feature !== 'agent-api') invalid('bundle feature mismatch')
  const raw = bundle.tables
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('bundle tables required')
  if (!Object.hasOwn(raw, 'agent_api_keys') && !Object.hasOwn(raw, 'api_keys')) invalid('agent API key table required')
  return verifyBundle(bundle, { name: 'agent-api', importTables: IMPORT_TABLES })
}

function rowView(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) invalid('invalid key row')
  const id = row.id
  const workspaceId = row.workspace_id
  const agentId = row.agent_id
  const name = row.name ?? row.label
  if (!ID.test(String(id ?? '')) || !ID.test(String(workspaceId ?? '')) || !ID.test(String(agentId ?? ''))) {
    invalid('invalid key identity')
  }
  if (typeof name !== 'string' || !NAME.test(name)) invalid('invalid key name')
  if (!HASH.test(String(row.token_hash ?? ''))) invalid('invalid token digest')
  const scope = row.scope ?? 'invoke'
  if (scope !== 'invoke') invalid('invalid key scope')
  const rate = row.rate_per_minute ?? 10
  if (!Number.isInteger(rate) || rate < 1 || rate > 60) invalid('invalid rate limit')
  const created = row.created ?? now()
  if (!Number.isInteger(created) || created < 0) invalid('invalid created time')
  const lastUsed = row.last_used ?? null
  if (lastUsed !== null && (!Number.isInteger(lastUsed) || lastUsed < 0)) invalid('invalid last used time')
  const revoked = row.revoked ?? 0
  if (!(revoked === 0 || revoked === 1 || revoked === false || revoked === true)) invalid('invalid revocation')
  return [id, workspaceId, agentId, name, row.token_hash, scope, rate, created, lastUsed, revoked ? 1 : 0]
}

export function importOfficialBundle(db, bundle) {
  const tables = verifyOfficial(bundle)
  const rows = tables.agent_api_keys ?? tables.api_keys ?? []
  const values = rows.map(rowView)
  const insert = db.prepare(`INSERT INTO api_keys (${COLUMNS.join(',')}) VALUES (${COLUMNS.map(() => '?').join(',')}) ON CONFLICT(id) DO NOTHING`)
  db.exec('BEGIN IMMEDIATE')
  try {
    let imported = 0
    for (const value of values) imported += Number(insert.run(...value).changes) || 0
    db.exec('COMMIT')
    return { imported, skipped: values.length - imported }
  } catch (error) {
    try { db.exec('ROLLBACK') } catch {}
    throw error
  }
}
