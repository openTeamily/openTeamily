// Legacy /v1 routes for /agents/ once the core stream flips that page into
// moved_pages. Homepage, discover and runtime-binding stay on the platform
// (cross-user / provision) and are not matched here.
import { FeatureError } from '../../featurekit/http.js'
import { createV1Endpoint } from '../../featurekit/v1.js'

const HEX = '([0-9a-f]{32})'

function wrap(fn) {
  return async (...args) => {
    try { return await fn(...args) } catch (error) {
      if (error instanceof FeatureError) throw error
      const code = String(error?.code ?? 'error').replace(/^agents\//, '')
      throw new FeatureError(error?.status ?? 500, code === 'not-found' ? 'not_found' : code.replace(/-/g, '_'), error?.message ?? 'Request failed')
    }
  }
}

const publicAgent = (agent) => ({ ...agent, archived: agent.archived ? 1 : 0, homepage: agent.homepage ?? { visibility: 'restricted' } })
const publicConversation = (row, workspaceId, agentId) => ({
  id: row.id, native_bot_id: row.native_bot_id || null, native_session_id: row.native_session_id || null, workspace_id: workspaceId, agent_id: agentId, title: row.title, created: row.created, updated: row.updated, preview: row.preview ?? '', unread_count: 0,
})
const publicMessage = (row, workspaceId, agentId) => {
  const status = row.status === 'sent' ? 'succeeded' : row.status
  let meta = row.meta
  if (typeof meta === 'string') try { meta = JSON.parse(meta) } catch { meta = {} }
  return {
    id: row.id, conversation_id: row.conversation_id, workspace_id: workspaceId, agent_id: agentId, role: row.role,
    body: row.text ?? row.body ?? '', status, created: row.created, updated: row.updated ?? row.created,
    task_id: null, error_code: meta?.error ? String(meta.error).replace(/^agents\//, '') : row.error_code ?? null, agent_revision: null,
  }
}

export function agentsV1({ endpoints, log }) {
  const call = (name, payload) => endpoints[name](payload)
  const routes = [
    { pattern: new RegExp(`^/v1/workspaces/${HEX}/agents/${HEX}/conversations/${HEX}/messages/${HEX}/artifact$`), handle: wrap(async () => { throw new FeatureError(503, 'unavailable', 'Saving a message to the works library is not in this DS-Bot yet') }) },
    { pattern: new RegExp(`^/v1/workspaces/${HEX}/agents/${HEX}/conversations/${HEX}/messages$`), handle: wrap(async (req, workspaceId, id, conversationId) => {
      if (req.method !== 'POST') throw new FeatureError(400, 'invalid', 'Invalid conversation request')
      const body = await req.json()
      const result = await call('send', { workspace_id: workspaceId, id, conversation_id: conversationId, text: body.body ?? body.text, reply_language: body.reply_language })
      return { status: 201, body: { message: publicMessage(result.message, workspaceId, id), reply: publicMessage(result.reply, workspaceId, id) } }
    }) },
    { pattern: new RegExp(`^/v1/workspaces/${HEX}/agents/${HEX}/conversations/${HEX}$`), handle: wrap(async (req, workspaceId, id, conversationId) => {
      if (req.method !== 'GET') throw new FeatureError(400, 'invalid', 'Invalid conversation request')
      const { agent } = await call('get', { workspace_id: workspaceId, id })
      const conversation = await call('conversation-get', { workspace_id: workspaceId, id, conversation_id: conversationId })
      const { items } = await call('messages', { workspace_id: workspaceId, id, conversation_id: conversationId })
      return { status: 200, body: { conversation: publicConversation(conversation, workspaceId, id), agent: publicAgent(agent), items: items.map((row) => publicMessage(row, workspaceId, id)) } }
    }) },
    { pattern: new RegExp(`^/v1/workspaces/${HEX}/agents/${HEX}/conversations$`), handle: wrap(async (req, workspaceId, id) => {
      if (req.method === 'GET') {
        const { items } = await call('conversations', { workspace_id: workspaceId, id })
        return { status: 200, body: { items: items.map((row) => publicConversation(row, workspaceId, id)), cursor: null } }
      }
      if (req.method === 'POST') {
        const body = await req.json()
        const result = await call('conversation-create', { workspace_id: workspaceId, id, title: body.title })
        return { status: result.status ?? 201, body: { conversation: publicConversation(result.conversation, workspaceId, id) } }
      }
      throw new FeatureError(400, 'invalid', 'Invalid conversation request')
    }) },
    { pattern: new RegExp(`^/v1/workspaces/${HEX}/agents/${HEX}/archive$`), handle: wrap(async (req, workspaceId, id) => {
      const body = await req.json()
      const { agent } = await call('get', { workspace_id: workspaceId, id })
      if (Number.isInteger(body.revision) && body.revision !== agent.revision) throw new FeatureError(409, 'conflict', 'Agent was updated; reload and retry')
      const result = await call('archive', { workspace_id: workspaceId, id })
      return { status: 200, body: { agent: publicAgent(result.agent) } }
    }) },
    { pattern: new RegExp(`^/v1/workspaces/${HEX}/agents(?:/${HEX})?$`), handle: wrap(async (req, workspaceId, id) => {
      if (!id && req.method === 'GET') {
        const includeArchived = req.query.get('include_archived') === '1'
        const active = await call('list', { workspace_id: workspaceId })
        const archived = includeArchived ? await call('list', { workspace_id: workspaceId, archived: true }) : { items: [] }
        const rows = [...active.items, ...archived.items].sort((a, b) => a.id.localeCompare(b.id))
        const cursor = req.query.get('cursor') || ''
        const limit = Math.min(Math.max(Number(req.query.get('limit') || 20), 1), 100)
        const sliced = rows.filter((row) => row.id > cursor).slice(0, limit + 1)
        return { status: 200, body: { items: sliced.slice(0, limit).map(publicAgent), cursor: sliced.length > limit ? sliced[limit - 1].id : null } }
      }
      if (!id && req.method === 'POST') {
        const body = await req.json()
        const result = await call('create', { ...body, workspace_id: workspaceId, idempotency_key: req.headers.get('idempotency-key') })
        return { status: result.status ?? 201, body: { agent: publicAgent(result.agent) } }
      }
      if (id && req.method === 'GET') {
        const { agent } = await call('get', { workspace_id: workspaceId, id })
        return { status: 200, body: { agent: publicAgent(agent) } }
      }
      if (id && req.method === 'POST') {
        const body = await req.json()
        const { revision, ...fields } = body
        const changes = {}
        for (const key of ['name', 'summary', 'instructions', 'category', 'quick_starts']) if (key in fields) changes[key] = fields[key]
        const result = await call('update', { workspace_id: workspaceId, id, revision, changes })
        return { status: 200, body: { agent: publicAgent(result.agent) } }
      }
      throw new FeatureError(400, 'invalid', 'Invalid agent request')
    }) },
  ]
  return createV1Endpoint({ feature: 'agents', routes, context: { log } })
}
