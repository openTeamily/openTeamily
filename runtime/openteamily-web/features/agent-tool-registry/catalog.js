// Read the live DSH tool schemas and merge the owner's metadata overlays.
// DSH remains the only owner of tool registration and execution.
import { HEX32, refuse } from '../../featurekit/http.js'

export const LIMITS = Object.freeze({ maxTools: 500, maxDescription: 2000, maxSchemaBytes: 32 * 1024 })
const NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/
const READ = /(?:^|[._:-])(?:read|get|list|search|find|fetch|view|status|describe|inspect|query|check|lookup|download)(?:$|[._:-])/i
const WRITE = /(?:^|[._:-])(?:create|update|write|send|post|put|patch|set|edit|move|rename|add|attach|connect|grant|revoke)(?:$|[._:-])/i
const DANGEROUS = /(?:^|[._:-])(?:exec|execute|shell|run|spawn|delete|remove|drop|payment|pay|book|invite|share|upload)(?:$|[._:-])/i

export function inferRisk(name, annotations = {}) {
  if (annotations?.readOnlyHint === true) return 'read'
  if (String(name).startsWith('mcp__')) return 'external'
  if (DANGEROUS.test(name)) return 'dangerous'
  if (WRITE.test(name)) return 'write'
  if (READ.test(name)) return 'read'
  return 'unknown'
}

export function inferSideEffect(risk) {
  if (risk === 'read') return 'read_only'
  if (risk === 'external') return 'external'
  if (risk === 'write' || risk === 'dangerous') return 'write'
  return 'unknown'
}

export function sourceOf(name) {
  if (String(name).startsWith('mcp__')) return 'mcp'
  if (/^cua_|^computer_/.test(String(name))) return 'computer'
  return 'builtin'
}

function toolView(tool) {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) refuse(400, 'tool/invalid', 'DSH tool schema must be an object')
  if (typeof tool.name !== 'string' || !NAME.test(tool.name)) refuse(400, 'tool/invalid', 'DSH tool has an invalid name')
  const description = typeof tool.description === 'string' ? tool.description.slice(0, LIMITS.maxDescription) : ''
  const parameters = tool.parameters ?? tool.inputSchema ?? { type: 'object', properties: {} }
  let schema = parameters
  let schemaBytes = Buffer.byteLength(JSON.stringify(parameters), 'utf8')
  let schemaTruncated = false
  if (schemaBytes > LIMITS.maxSchemaBytes) {
    schema = null
    schemaTruncated = true
  }
  const risk = inferRisk(tool.name, tool.annotations)
  return {
    name: tool.name,
    source: sourceOf(tool.name),
    description,
    parameters: schema,
    schema_bytes: schemaBytes,
    schema_truncated: schemaTruncated,
    risk,
    side_effect: inferSideEffect(risk),
    capability: null,
    enabled: true,
    overlay: false,
    revision: 0,
    annotations: {
      read_only_hint: tool.annotations?.readOnlyHint === true,
      destructive_hint: tool.annotations?.destructiveHint === true,
      idempotent_hint: tool.annotations?.idempotentHint === true,
    },
  }
}

export function describeTools(tools, overlays = []) {
  if (!Array.isArray(tools)) refuse(503, 'tool/unavailable', 'DSH tool schemas are unavailable')
  if (tools.length > LIMITS.maxTools) refuse(413, 'tool/too_many', `DSH returned more than ${LIMITS.maxTools} tools`)
  const byName = new Map()
  for (const tool of tools) {
    const view = toolView(tool)
    byName.set(view.name, view)
  }
  for (const overlay of overlays) {
    const item = byName.get(overlay.name)
    if (!item) continue
    byName.set(item.name, {
      ...item,
      risk: overlay.risk,
      side_effect: overlay.side_effect,
      capability: overlay.capability,
      enabled: overlay.enabled,
      note: overlay.note,
      overlay: true,
      revision: overlay.revision,
    })
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function toolService(ctx, agent) {
  const service = ctx?.tools ?? agent?.ctx?.tools
  return typeof service?.schemas === 'function' ? service : null
}

export async function resolveAgentTools(host, payload, workspace) {
  const { rt, ctx } = await host.runtime({ timeoutMs: 15_000 })
  let agent = null
  let sessionId = typeof payload?.session_id === 'string' ? payload.session_id : null
  if (sessionId) {
    const botId = rt?.chatOwners?.get?.(sessionId)
    const bot = botId ? rt?.botOf?.(botId) : undefined
    if (!bot?.openteamily || bot.openteamily.workspace_id !== workspace) {
      refuse(404, 'not_found', 'Agent session not found')
    }
    agent = await rt.resolveAgent(sessionId)
  } else if (payload?.agent_id !== undefined) {
    if (typeof payload.agent_id !== 'string' || !HEX32.test(payload.agent_id)) {
      refuse(400, 'invalid', 'agent_id must be 32 lowercase hex characters')
    }
    const bots = Object.values(rt?.state?.bots ?? {})
    const bot = bots.find(item => item?.openteamily?.agent_id === payload.agent_id
      && item.openteamily.workspace_id === workspace)
    if (!bot) refuse(404, 'not_found', 'Agent not found')
    sessionId = rt.chatOf?.(bot.id) ?? bot.sessionId ?? null
    if (!sessionId) refuse(404, 'not_found', 'Agent has no active session')
    agent = await rt.resolveAgent(sessionId)
  } else {
    const mainId = (rt?.state?.mainBotIds ?? []).find(id => rt.botOf?.(id))
    if (!mainId) refuse(404, 'not_found', 'Main Bot is not available')
    sessionId = rt.chatOf?.(mainId) ?? rt.botOf?.(mainId)?.sessionId ?? null
    if (!sessionId) refuse(404, 'not_found', 'Main Bot has no active session')
    agent = await rt.resolveAgent(sessionId)
  }
  if (!agent) refuse(404, 'not_found', 'Agent is not available')
  const service = toolService(ctx, agent)
  if (!service) refuse(503, 'tool/unavailable', 'DSH tool service is unavailable')
  let tools
  try { tools = await service.schemas(agent) } catch { refuse(503, 'tool/unavailable', 'DSH tool schemas could not be read') }
  return {
    agent: {
      id: agent.id ?? null,
      name: agent.name ?? null,
      session_id: sessionId,
      workspace_id: workspace,
    },
    tools,
  }
}

export function toolStats(items) {
  const byRisk = { read: 0, write: 0, external: 0, dangerous: 0, unknown: 0 }
  const bySource = { builtin: 0, mcp: 0, computer: 0 }
  for (const item of items) {
    byRisk[item.risk] = (byRisk[item.risk] ?? 0) + 1
    bySource[item.source] = (bySource[item.source] ?? 0) + 1
  }
  return { total: items.length, enabled: items.filter(item => item.enabled).length, by_risk: byRisk, by_source: bySource }
}

export function contractDescription() {
  return {
    schema: 'openteamily.agent-tool-registry.v1',
    version: 1,
    limits: { ...LIMITS },
    risks: ['read', 'write', 'external', 'dangerous', 'unknown'],
    side_effects: ['read_only', 'write', 'external', 'unknown'],
    reuse: ['DSH ctx.tools.schemas(agent)', 'DSH tool schema/annotations', 'DSH tool registration/execution'],
    new_in_this_feature: ['live tool catalog projection', 'owner risk/side-effect/capability overlays', 'revisioned overlay store', 'tool stats'],
    not_doing: ['no tool registration', 'no tool execution', 'no permission enforcement', 'no MCP/connector implementation', 'no UI'],
  }
}
