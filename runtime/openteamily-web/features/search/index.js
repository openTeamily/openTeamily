// Search feature (stream B3): message and resource search over this owner's
// own data, executed inside the user's DS-Bot (legacy search.py and
// app.py search_messages/search_resources). Personal-chat messages come from
// the chat feature and workspace-agent conversation history (including imported
// rows) from the agents feature's search hook; files come from the artifacts
// feature, and notes from the memory/meetings/artifacts '<name>/search'
// endpoints, all via host.call; a feature that is not present contributes
// nothing. Shared (social) messages live in Bot Social and are searched there
// (stream C).
import { CONTROL, HEX32, refuse } from '../../featurekit/http.js'
import { defineFeature } from '../../featurekit/feature.js'

export const QUERY_MAX = 80
export const KINDS = ['all', 'agent', 'social']
const SNIPPET_MAX = 160
const MAX_CONVERSATIONS = 200
const AGENT_SEARCH_LIMIT = 5000
const casefold = (v) => String(v).toLocaleLowerCase('en-US')
export const snippet = (body) => { const t = String(body ?? '').split(/\s+/).filter(Boolean).join(' '); return t.length <= SNIPPET_MAX ? t : t.slice(0, SNIPPET_MAX) + '…' }
const validQuery = (v) => typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= QUERY_MAX && !CONTROL.test(v)

async function optional(host, endpoint, payload) {
  try { return await host.call(endpoint, payload) } catch (error) {
    if (error?.code === 'openteamily/not-found') return null
    throw error
  }
}

const seconds = (value) => Math.floor(Number(value ?? 0) / (Number(value) > 1e12 ? 1000 : 1))

async function chatMessages(host) {
  const listed = await optional(host, 'chat/conversations', {})
  const conversations = (listed?.items ?? []).slice(0, MAX_CONVERSATIONS)
  const rows = []
  for (const convo of conversations) {
    const messages = await optional(host, 'chat/messages', { conversation_id: convo.id })
    for (const message of messages?.items ?? []) {
      rows.push({ id: message.id, conversation_id: convo.id, title: convo.title, body: message.text ?? '', created: seconds(message.created) })
    }
  }
  return rows
}

async function workspaceAgentMessages(host, workspaceId) {
  if (typeof workspaceId !== 'string' || !HEX32.test(workspaceId)) return []
  const found = await optional(host, 'agents/search', { workspace_id: workspaceId, limit: AGENT_SEARCH_LIMIT })
  return (found?.items ?? []).map((row) => ({
    id: row.id, conversation_id: row.conversation_id, title: row.title, agent_name: row.agent_name,
    body: row.body ?? row.text ?? '', created: seconds(row.created),
  }))
}

// All of this owner's private-chat and workspace-agent messages as legacy search
// rows. Missing chat or agents features simply contribute no rows.
export async function agentMessages(host, workspaceId) {
  const [chat, agents] = await Promise.all([chatMessages(host), workspaceAgentMessages(host, workspaceId)])
  return [...chat, ...agents].sort((a, b) => a.created - b.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

const after = (rows, cursor) => {
  if (!cursor) return rows
  const index = rows.findIndex((row) => row.id === cursor)
  if (index < 0) refuse(400, 'invalid', 'Invalid search parameters')
  return rows.slice(index + 1)
}

export function parseMessageQuery(query) {
  const allowed = new Set(['q', 'kind', 'limit', 'cursor', 'conversation_id'])
  if ([...query.keys()].some((k) => !allowed.has(k) || query.getAll(k).length !== 1)) refuse(400, 'invalid', 'Invalid search parameters')
  const text = query.get('q') ?? ''
  const kind = query.get('kind') ?? 'all'
  const limit = query.get('limit') ?? '20'
  const conversationId = query.get('conversation_id')
  const cursor = query.get('cursor') ?? ''
  if (!validQuery(text) || !KINDS.includes(kind) || !/^[0-9]{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 50
      || (conversationId !== null && !HEX32.test(conversationId)) || (cursor && !HEX32.test(cursor))) refuse(400, 'invalid', 'Invalid search parameters')
  return { text: text.trim(), kind, limit: Number(limit), conversationId, cursor }
}

async function messages(req, workspaceId) {
  if (req.method !== 'GET') refuse(405, 'method', 'Only GET is supported')
  const { text, kind, limit, conversationId, cursor } = parseMessageQuery(req.query)
  let rows = kind === 'social' ? [] : await agentMessages(req.host, workspaceId)
  if (conversationId) rows = rows.filter((row) => row.conversation_id === conversationId)
  const needle = casefold(text)
  rows = after(rows, cursor).filter((row) => casefold(row.body).includes(needle))
  const page = rows.slice(0, limit + 1)
  const items = page.slice(0, limit).map((row) => ({ kind: 'agent', conversation_id: row.conversation_id, message_id: row.id,
    title: row.agent_name || row.title || '对话', snippet: snippet(row.body), created: row.created }))
  return { body: { items, cursor: page.length > limit ? page[limit - 1].id : null } }
}

const URL_RE = /https?:\/\/[^\s<>"']+/

async function resources(req, workspaceId) {
  if (req.method !== 'GET') refuse(405, 'method', 'Only GET is supported')
  const q = req.query
  const allowed = new Set(['q', 'kind', 'cursor', 'limit'])
  if ([...q.keys()].some((k) => !allowed.has(k) || q.getAll(k).length !== 1)) refuse(400, 'invalid', 'Invalid resource search parameters')
  const text = q.get('q') ?? ''
  const kind = q.get('kind') ?? ''
  const cursor = q.get('cursor') ?? ''
  const limit = q.get('limit') ?? '20'
  if (!['files', 'links'].includes(kind) || text.length > 80 || [...text].some((c) => c.charCodeAt(0) < 32)
      || !/^[0-9]{1,2}$/.test(limit) || Number(limit) < 1 || Number(limit) > 50 || (cursor && !HEX32.test(cursor))) {
    refuse(400, 'invalid', 'Invalid resource search parameters')
  }
  const n = Number(limit)
  if (kind === 'files') {
    const files = await optional(req.host, 'artifacts/files', { workspace_id: workspaceId, q: text, cursor, limit: n + 1 })
    const rows = files?.items ?? []
    return { body: { items: rows.slice(0, n), cursor: rows.length > n ? rows[n - 1].id : null } }
  }
  const needle = casefold(text || 'http')
  const rows = after(await agentMessages(req.host, workspaceId), cursor).filter((row) => casefold(row.body).includes(needle))
  const page = rows.slice(0, n)
  const items = []
  for (const row of page) {
    const match = URL_RE.exec(row.body)
    if (match) items.push({ id: row.id, title: row.title || '消息链接', preview: match[0].replace(/[.,;:!?)\]}，。]+$/, ''), href: match[0].replace(/[.,;:!?)\]}，。]+$/, '') })
  }
  return { body: { items, cursor: rows.length > n ? page.at(-1).id : null } }
}

export default defineFeature({
  name: 'search',
  routes: [
    { pattern: /^\/v1\/workspaces\/([0-9a-f]{32})\/search\/messages$/, handle: messages },
    { pattern: /^\/v1\/workspaces\/([0-9a-f]{32})\/search\/resources$/, handle: resources },
  ],
  endpoints: ({ host }) => ({
    // One query across this owner's moved notes: memory, meetings, artifacts.
    async all(payload) {
      const q = String(payload?.q ?? '').trim()
      if (!validQuery(q)) throw Object.assign(new Error('q must be 1–80 characters'), { code: 'search/invalid' })
      const limit = Math.min(Math.max(Number(payload?.limit) || 20, 1), 50)
      const groups = await Promise.all(['memory', 'meetings', 'artifacts'].map((name) => optional(host, `${name}/search`, { q, limit })))
      const items = groups.flatMap((group) => group?.items ?? []).sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0)).slice(0, limit)
      return { items }
    },
  }),
})
