// Registry metadata overlays for tools that DSH already owns. This store never
// registers, executes or rewrites a tool: it only records the owner's risk
// classification, side-effect class, capability and enabled flag.
import { HEX32, refuse } from '../../featurekit/http.js'

const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/
const RISKS = Object.freeze(['read', 'write', 'external', 'dangerous', 'unknown'])
const SIDE_EFFECTS = Object.freeze(['read_only', 'write', 'external', 'unknown'])
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_tool_overlays (
  workspace_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  revision INTEGER NOT NULL,
  risk TEXT NOT NULL CHECK(risk IN ('read','write','external','dangerous','unknown')),
  side_effect TEXT NOT NULL CHECK(side_effect IN ('read_only','write','external','unknown')),
  capability TEXT,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  note TEXT,
  updated INTEGER NOT NULL,
  PRIMARY KEY(workspace_id, tool_name)
);
CREATE INDEX IF NOT EXISTS agent_tool_overlays_workspace ON agent_tool_overlays(workspace_id, tool_name);
`

const validWorkspace = (value) => typeof value === 'string' && HEX32.test(value)
const validName = (value) => typeof value === 'string' && TOOL_NAME.test(value)
export const validToolName = validName
const text = (value, maximum) => value === null || value === undefined
  || (typeof value === 'string' && value.length <= maximum && !CONTROL.test(value))

export function viewOverlay(row) {
  if (!row) return null
  return {
    workspace_id: row.workspace_id,
    name: row.tool_name,
    revision: row.revision,
    risk: row.risk,
    side_effect: row.side_effect,
    capability: row.capability,
    enabled: Boolean(row.enabled),
    note: row.note,
    updated: row.updated,
  }
}

export function createToolRegistry(db, { clock = () => Math.floor(Date.now() / 1000) } = {}) {
  db.exec(SCHEMA)
  const one = (sql, ...args) => db.prepare(sql).get(...args) ?? null
  const all = (sql, ...args) => db.prepare(sql).all(...args)
  const run = (sql, ...args) => db.prepare(sql).run(...args)
  const now = () => Math.max(0, Math.floor(clock()))

  function listOverlays(workspaceId) {
    if (!validWorkspace(workspaceId)) refuse(400, 'invalid', 'workspace_id must be 32 lowercase hex characters')
    return all('SELECT * FROM agent_tool_overlays WHERE workspace_id=? ORDER BY tool_name', workspaceId).map(viewOverlay)
  }

  function getOverlay(workspaceId, name) {
    if (!validWorkspace(workspaceId)) refuse(400, 'invalid', 'workspace_id must be 32 lowercase hex characters')
    if (!validName(name)) refuse(400, 'invalid', 'Invalid tool name')
    return viewOverlay(one('SELECT * FROM agent_tool_overlays WHERE workspace_id=? AND tool_name=?', workspaceId, name))
  }

  function upsertOverlay(workspaceId, payload) {
    if (!validWorkspace(workspaceId)) refuse(400, 'invalid', 'workspace_id must be 32 lowercase hex characters')
    if (!validName(payload?.name)) refuse(400, 'invalid', 'Invalid tool name')
    const current = getOverlay(workspaceId, payload.name)
    const revision = payload.revision ?? 0
    if (!Number.isSafeInteger(revision) || revision < 0) refuse(400, 'invalid', 'revision must be a non-negative integer')
    if (current && revision !== current.revision) {
      refuse(409, 'conflict', 'Tool overlay changed elsewhere; reload and retry', current)
    }
    if (!current && revision !== 0) refuse(409, 'conflict', 'New tool overlay must start at revision 0')
    const risk = payload.risk ?? current?.risk ?? 'unknown'
    const sideEffect = payload.side_effect ?? current?.side_effect ?? 'unknown'
    const enabled = payload.enabled ?? current?.enabled ?? true
    const capability = payload.capability === undefined ? (current?.capability ?? null) : payload.capability
    const note = payload.note === undefined ? (current?.note ?? null) : payload.note
    if (!RISKS.includes(risk)) refuse(400, 'invalid', 'Invalid risk')
    if (!SIDE_EFFECTS.includes(sideEffect)) refuse(400, 'invalid', 'Invalid side_effect')
    if (typeof enabled !== 'boolean') refuse(400, 'invalid', 'enabled must be boolean')
    if (!text(capability, 120)) refuse(400, 'invalid', 'capability must be at most 120 characters')
    if (!text(note, 500)) refuse(400, 'invalid', 'note must be at most 500 characters')
    const next = (current?.revision ?? 0) + 1
    run(`INSERT INTO agent_tool_overlays
      (workspace_id,tool_name,revision,risk,side_effect,capability,enabled,note,updated)
      VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(workspace_id,tool_name) DO UPDATE SET
        revision=excluded.revision, risk=excluded.risk, side_effect=excluded.side_effect,
        capability=excluded.capability, enabled=excluded.enabled, note=excluded.note, updated=excluded.updated`,
    workspaceId, payload.name, next, risk, sideEffect, capability, Number(enabled), note, now())
    return viewOverlay(one('SELECT * FROM agent_tool_overlays WHERE workspace_id=? AND tool_name=?', workspaceId, payload.name))
  }

  function removeOverlay(workspaceId, name) {
    if (!validWorkspace(workspaceId)) refuse(400, 'invalid', 'workspace_id must be 32 lowercase hex characters')
    if (!validName(name)) refuse(400, 'invalid', 'Invalid tool name')
    const current = getOverlay(workspaceId, name)
    if (!current) refuse(404, 'not_found', 'Tool overlay not found')
    run('DELETE FROM agent_tool_overlays WHERE workspace_id=? AND tool_name=?', workspaceId, name)
    return { removed: current.name }
  }

  return { listOverlays, getOverlay, upsertOverlay, removeOverlay, risks: RISKS, sideEffects: SIDE_EFFECTS }
}
