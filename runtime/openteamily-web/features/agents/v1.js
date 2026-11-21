// Legacy /v1 routes for /agents/ once the core stream flips that page into
// moved_pages. Homepage, discover and runtime-binding stay on the platform
// (cross-user / provision) and are not matched here.
import { FeatureError } from '../../featurekit/http.js'
import { PRIVATE_FILE_BYTES, PRIVATE_FILE_COUNT } from './files.js'
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
  ...(typeof row.memory_recall === 'boolean' ? {memory_recall:row.memory_recall,memory_scope:row.memory_scope} : {}),
})
const publicMessage = (row, workspaceId, agentId) => {
  const status = row.status === 'sent' ? 'succeeded' : row.status
  let meta = row.meta
  if (typeof meta === 'string') try { meta = JSON.parse(meta) } catch { meta = {} }
  const attachments = (meta?.files || []).map(({title,mime,bytes}, index) => ({
    title,mime,bytes,path:`/v1/workspaces/${workspaceId}/agents/${agentId}/conversations/${row.conversation_id}/messages/${row.id}/files/${index}`,
  }))
  return {
    ...(attachments.length ? {attachments} : {}),
    ...(meta?.clientKey ? {client_key:meta.clientKey} : {}),
    ...(meta?.memory_refs?.length ? {memory_refs: meta.memory_refs} : {}),
    ...(meta?.memory_profile_workspace === workspaceId ? {memory_profile_workspace: workspaceId} : {}),
    id: row.id, conversation_id: row.conversation_id, workspace_id: workspaceId, agent_id: agentId, role: row.role,
    body: row.text ?? row.body ?? '', status, created: row.created, updated: row.updated ?? row.created,
    task_id: null, error_code: meta?.error ? String(meta.error).replace(/^agents\//, '') : row.error_code ?? null, agent_revision: null,
  }
}

export function agentsV1({ endpoints, log }) {
  const call = (name, payload) => endpoints[name](payload)
  const routes = [
    { pattern: new RegExp(`^/v1/workspaces/${HEX}/agents/${HEX}/conversations/${HEX}/messages/${HEX}/files/([0-3])$`),
      handle: wrap(async (req, workspaceId, id, conversationId, messageId, index) => {
        if (req.method !== 'GET') throw new FeatureError(405, 'method', 'Only GET is supported')
        const file = await call('attachment', {workspace_id:workspaceId,id,conversation_id:conversationId,message_id:messageId,index:Number(index)})
        const inline = file.mime.startsWith('image/') && req.query.get('download') !== '1'
        return {status:200, raw:file.data, filename:file.title, headers:{'content-type':file.mime}, inline}
      }) },
    { pattern: new RegExp(`^/v1/workspaces/${HEX}/agents/${HEX}/conversations/${HEX}/messages/${HEX}/artifact$`), handle: wrap(async (req, workspaceId, id, conversationId, messageId) => {
      if (req.method !== 'POST') throw new FeatureError(405, 'method', 'Only POST is supported')
      const body = await req.json()
      const {status, artifact} = await call('saveMessage', {workspace_id: workspaceId, id,
        conversation_id: conversationId, message_id: messageId, title: body.title})
      return {status, body: {artifact}}
    }) },
    { pattern: new RegExp(`^/v1/workspaces/${HEX}/agents/${HEX}/conversations/${HEX}/memory/capture$`), handle: wrap(async (req, workspaceId, id, conversationId) => {
      if (req.method !== 'POST') throw new FeatureError(405, 'method', 'Only POST is supported')
      const body = await req.json()
      return {status:202, body:await call('captureHistory', {workspace_id:workspaceId,id,conversation_id:conversationId,message_ids:body.message_ids})}
    }) },
    { pattern: new RegExp(`^/v1/workspaces/${HEX}/agents/${HEX}/conversations/${HEX}/messages$`), handle: wrap(async (req, workspaceId, id, conversationId) => {
      if (req.method !== 'POST') throw new FeatureError(400, 'invalid', 'Invalid conversation request')
      const body = await req.json(Math.ceil(PRIVATE_FILE_BYTES / 3) * 4 + PRIVATE_FILE_COUNT * 4 + 192*1024)
      const payload = {workspace_id:workspaceId,id,agent_id:id,conversation_id:conversationId,
        text:body.body ?? body.text,reply_language:body.reply_language,attachments:body.attachments,
        idempotency_key:req.headers.get('idempotency-key'),return_failed:true}
      const result = await call('send', payload)
      return { status: 201, body: { message: publicMessage(result.message, workspaceId, id), reply: publicMessage(result.reply, workspaceId, id) } }
    }) },
    { pattern: new RegExp(`^/v1/workspaces/${HEX}/agents/${HEX}/conversations/${HEX}$`), handle: wrap(async (req, workspaceId, id, conversationId) => {
      if (req.method === 'POST') {
        const body = await req.json()
        return {body:await call('setMemoryRecall', {workspace_id:workspaceId,id,conversation_id:conversationId,memory_recall:body.memory_recall,memory_scope:body.memory_scope})}
      }
      if (req.method !== 'GET') throw new FeatureError(400, 'invalid', 'Invalid conversation request')
      const { agent, conversation, items } = await call('openConversation', { workspace_id: workspaceId, id, conversation_id: conversationId })
      return { status: 200, body: { conversation: publicConversation(conversation, workspaceId, id), agent: publicAgent(agent), items: items.map((row) => publicMessage(row, workspaceId, id)) } }
    }) },
    { pattern: new RegExp(`^/v1/workspaces/${HEX}/agents/${HEX}/conversations$`), handle: wrap(async (req, workspaceId, id) => {
      if (req.method === 'GET') {
        const { items } = await call('conversations', { workspace_id: workspaceId, id })
        return { status: 200, body: { items: items.map((row) => publicConversation(row, workspaceId, id)), cursor: null } }
      }
      if (req.method === 'POST') {
        const body = await req.json()
        const result = await call('conversation-create', { workspace_id: workspaceId, id, title: body.title, memory_recall: body.memory_recall,memory_scope:body.memory_scope,
          idempotency_key: req.headers.get('idempotency-key') })
        return { status: result.status ?? 201, body: { conversation: publicConversation(result.conversation, workspaceId, id) } }
      }
      throw new FeatureError(400, 'invalid', 'Invalid conversation request')
    }) },
    { pattern: new RegExp(`^/v1/workspaces/${HEX}/agents/${HEX}/archive$`), handle: wrap(async (req, workspaceId, id) => {
      const body = await req.json()
      const { agent } = await call('get', { workspace_id: workspaceId, id })
      if (Number.isInteger(body.revision) && body.revision !== agent.revision) throw new FeatureError(409, 'conflict', 'Agent was updated; reload and retry')
      const result = await call('archive', { workspace_id: workspaceId, id, archived: body.archived })
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
        const items = sliced.slice(0, limit).map(publicAgent)
        const body = { items, cursor: sliced.length > limit ? sliced[limit - 1].id : null }
        if (req.query.get('include') === 'conversations') {
          const directory = await call('conversationSummaries', { workspace_id: workspaceId, agent_ids: items.map(item => item.id) })
          body.conversations = directory.items
        }
        return { status: 200, body }
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
