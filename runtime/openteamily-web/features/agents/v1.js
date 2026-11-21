// Legacy /v1 routes for /agents/ once the core stream flips that page into
// moved_pages. Homepage, discover and runtime-binding stay on the platform
// (cross-user / provision) and are not matched here.
import { FeatureError } from '../../featurekit/http.js'
import { PRIVATE_FILE_BYTES, PRIVATE_FILE_COUNT } from './files.js'
import { createV1Endpoint } from '../../featurekit/v1.js'
import { CHAT_LANGUAGE_NAMES } from '../settings/settings.js'

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
const chatAgent = (agent) => publicAgent(agent.archived || agent.native_deleted ? {...agent, quick_starts: []} : agent)
const publicConversation = (row, workspaceId, agentId) => ({
  id: row.id, native_bot_id: row.native_bot_id || null, native_session_id: row.native_session_id || null, workspace_id: workspaceId, agent_id: agentId, title: row.title, created: row.created, updated: row.updated, preview: row.preview ?? '', unread_count: 0,
  ...(typeof row.memory_recall === 'boolean' ? {memory_recall:row.memory_recall,memory_scope:row.memory_scope} : {}),
})
const publicFile = ({title,mime,bytes,resource}, index, workspaceId, agentId, conversationId, messageId) => ({
  title,mime,bytes,path:`/v1/workspaces/${workspaceId}/agents/${agentId}/conversations/${conversationId}/messages/${messageId}/files/${index}`,
  ...(resource ? {resource} : {}),
})
const publicMessage = (row, workspaceId, agentId) => {
  const status = row.status === 'sent' ? 'succeeded' : row.status
  let meta = row.meta
  if (typeof meta === 'string') try { meta = JSON.parse(meta) } catch { meta = {} }
  const attachments = (meta?.files || []).map((file, index) => publicFile(file, index, workspaceId, agentId, row.conversation_id, row.id))
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
    { pattern: new RegExp(`^/v1/workspaces/${HEX}/agents/${HEX}/conversations/${HEX}/reply-progress$`),
      handle: wrap(async (req, workspaceId, id, conversationId) => {
        if (req.method !== 'GET') throw new FeatureError(405, 'method', 'Only GET is supported')
        const [key, extra] = req.query.getAll('key')
        if (!key || extra !== undefined || [...req.query.keys()].length !== 1) {
          throw new FeatureError(400, 'invalid', 'Supply one message send key')
        }
        return {body:await call('replyProgress', {workspace_id:workspaceId,id,conversation_id:conversationId,key})}
      }) },
    { pattern: new RegExp(`^/v1/workspaces/${HEX}/agents/${HEX}/conversations/${HEX}/attachments$`),
      handle: wrap(async (req, workspaceId, id, conversationId) => {
        if (req.method !== 'GET') throw new FeatureError(405, 'method', 'Only GET is supported')
        for (const name of req.query.keys()) {
          if (!['kind','q','cursor','limit'].includes(name) || req.query.getAll(name).length !== 1) {
            throw new FeatureError(400, 'invalid', 'Invalid attachment search parameter')
          }
        }
        const limit = req.query.get('limit') ?? '20'
        if (!/^[0-9]{1,2}$/.test(limit)) throw new FeatureError(400, 'invalid', 'Invalid attachment search limit')
        const result = await call('listAttachments', {workspace_id:workspaceId,id,conversation_id:conversationId,
          kind:req.query.get('kind'),q:req.query.get('q') ?? '',cursor:req.query.get('cursor') ?? '',limit:Number(limit)})
        return {body:{items:result.items.map(({message_id,created_at,slot,...file}) => ({
          message_id,created_at,attachment:{id:`${message_id}:${slot}`,...publicFile(file,slot,workspaceId,id,conversationId,message_id)},
        })),next_cursor:result.next_cursor}}
      }) },
    { pattern: new RegExp(`^/v1/workspaces/${HEX}/agents/${HEX}/conversations/${HEX}/messages/${HEX}/files/([0-3])$`),
      handle: wrap(async (req, workspaceId, id, conversationId, messageId, index) => {
        if (req.method !== 'GET') throw new FeatureError(405, 'method', 'Only GET is supported')
        const file = await call('attachment', {workspace_id:workspaceId,id,conversation_id:conversationId,message_id:messageId,index:Number(index)})
        const inline = /^(image|audio|video)\//.test(file.mime) && req.query.get('download') !== '1'
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
      const code = body.chat_language
      const replyLanguage = typeof code === 'string' && Object.hasOwn(CHAT_LANGUAGE_NAMES, code)
        ? CHAT_LANGUAGE_NAMES[code] : body.reply_language
      const payload = {workspace_id:workspaceId,id,agent_id:id,conversation_id:conversationId,
        text:body.body ?? body.text,reply_language:replyLanguage,attachments:body.attachments,
        idempotency_key:req.headers.get('idempotency-key'),return_failed:true}
      const project = result => ({message:publicMessage(result.message, workspaceId, id),
        reply:publicMessage(result.reply, workspaceId, id)})
      if (body.artifact_id !== undefined) {
        const staged = Promise.withResolvers()
        const sending = call('send', {...payload,artifact_id:body.artifact_id,artifact_revision:body.artifact_revision,
          onAccepted:result => staged.resolve({status:202,body:project(result)})})
        return Promise.race([staged.promise,sending.then(result => ({status:201,body:project(result)}))])
      }
      const result = await call('send', payload)
      return {status:201,body:project(result)}
    }) },
    { pattern: new RegExp(`^/v1/workspaces/${HEX}/agents/${HEX}/conversations/${HEX}$`), handle: wrap(async (req, workspaceId, id, conversationId) => {
      if (req.method === 'POST') {
        const body = await req.json()
        return {body:await call('setMemoryRecall', {workspace_id:workspaceId,id,conversation_id:conversationId,memory_recall:body.memory_recall,memory_scope:body.memory_scope})}
      }
      if (req.method !== 'GET') throw new FeatureError(400, 'invalid', 'Invalid conversation request')
      const { agent, conversation, items } = await call('openConversation', { workspace_id: workspaceId, id, conversation_id: conversationId })
      return { status: 200, body: { conversation: publicConversation(conversation, workspaceId, id), agent: chatAgent(agent), items: items.map((row) => publicMessage(row, workspaceId, id)) } }
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
      const result = await call('archive', { workspace_id: workspaceId, id })
      return { status: 200, body: { agent: publicAgent(result.agent) } }
    }) },
    { pattern: new RegExp(`^/v1/workspaces/${HEX}/agents(?:/${HEX})?$`), handle: wrap(async (req, workspaceId, id) => {
      if (!id && req.method === 'GET') {
        const includeArchived = req.query.get('include_archived') === '1'
        const includeConversations = req.query.get('include') === 'conversations'
        const active = await call('list', { workspace_id: workspaceId })
        const archived = includeArchived ? await call('list', { workspace_id: workspaceId, archived: true }) : { items: [] }
        const rows = [...active.items, ...archived.items].sort((a, b) => a.id.localeCompare(b.id))
        const cursor = req.query.get('cursor') || ''
        const limit = Math.min(Math.max(Number(req.query.get('limit') || 20), 1), 100)
        const sliced = rows.filter((row) => row.id > cursor).slice(0, limit + 1)
        const items = sliced.slice(0, limit).map(includeConversations ? chatAgent : publicAgent)
        const body = { items, cursor: sliced.length > limit ? sliced[limit - 1].id : null }
        if (includeConversations) {
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
