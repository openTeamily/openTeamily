// Legacy /v1 compatibility for Stream C pages (members, team, messenger, discover).
// When the core stream flips those pages onto the user's own DS-Bot, dsbot-api.mjs
// posts {endpoint:'<feature>/v1', payload:{method,path,body}} here. The handlers
// talk to Bot Social and return the Flask JSON shapes those pages already expect.
// Shared workspaces are Bot Social teams. The private workspace can also be
// listed from the personal-agent binding in this user's runtime.
import { createHash } from 'node:crypto'
import {workbookText} from '../../features/artifacts/workbook.js'
import { CATEGORIES as agentCategories, LIMITS as agentLimits } from '../../features/agents/index.js'
import { compatHandler } from '../b4/compat.js'
import { Fault } from '../b4/http.js'
import { ownerId } from '../../featurekit/v1.js'
import { sharedBotSocial, seg, qs } from './bot-social.js'
import { replyPrompt, selectGroupMemories } from './agent-replies.js'

const HEX = /^[0-9a-f]{32}$/
const WORK_LABELS = {
  document: '文档', spreadsheet:'电子表格', website: '网页', whiteboard: '白板', media: '媒体',
  image: '图片', audio: '音频', video: '视频', slides: '幻灯片', dashboard: '看板',
}

const unix = (ms) => {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n)
}

const usernameOf = (profile) => {
  const handle = String(profile?.handle || '').replace(/^@/, '')
  if (!handle) return profile?.display_name || ''
  return handle.endsWith('.home') ? handle.slice(0, -5) : handle
}

function userIdOf(profile, me, env) {
  if (profile?.platform_user_id && HEX.test(String(profile.platform_user_id))) return profile.platform_user_id
  const mine = me && (profile?.handle === me.handle || profile?.owner_id === me.owner_id || profile?.owner_id === me.ownerId)
  if (mine) {
    const id = ownerId(env)
    if (HEX.test(id)) return id
  }
  return profile?.owner_id || profile?.handle || ''
}

function memberItem(row, me, env) {
  return {
    user_id: userIdOf(row, me, env),
    username: usernameOf(row) || row.display_name || '',
    handle: row.handle || null,
    role: row.role,
    created: unix(row.joined_at || row.created_at),
    suspended: !!row.suspended,
  }
}

function inviteItem(row, workspaceId) {
  return {
    id: row.id,
    workspace_id: workspaceId || row.workspace_id || row.team_id,
    role: row.role,
    created: unix(row.created_at),
    expires: unix(row.expires_at),
    created_by: row.created_by || null,
    max_uses: row.max_uses,
    use_count: row.use_count,
    revoked: !!row.revoked,
    frozen: !!row.frozen,
    requires_approval: !!row.requires_approval,
  }
}

function requestItem(row, workspaceId) {
  return {
    id: row.id,
    workspace_id: workspaceId || row.workspace_id || row.team_id,
    user_id: row.member?.owner_id || row.member?.platform_user_id || row.owner_id,
    username: usernameOf(row.member || row),
    role: row.role,
    status: row.status,
    created: unix(row.created_at),
    decided: unix(row.decided_at) || null,
    decided_by: row.decided_by || null,
  }
}

function conversationItem(row, me, env, workspaceId) {
  const members = (row.members || []).map((m) => ({
    ...memberItem({ ...m, role: m.role || 'member' }, me, env),
  }))
  return {
    id: row.id,
    workspace_id: workspaceId,
    kind: row.kind,
    ...(row.public_agent ? {public_agent: row.public_agent} : {}),
    ...(row.direct ? {direct: row.direct} : {}),
    ...(row.account_group ? {account_group: true} : {}),
    native_room_id: row.native_room_id || null,
    native_session_id: row.native_session_id || null,
    title: row.title || '',
    created: unix(row.created_at),
    updated: unix(row.updated_at),
    activity_version: row.activity_version ?? null,
    last_seq: row.last_seq ?? 0,
    preview: row.last_message && !row.last_message.retracted ? (row.last_message.body || '') : '',
    unread_count: row.unread ?? 0,
    muted: !!row.muted,
    pinned: !!row.pinned,
    first_unread_seq: row.unread > 0 ? (row.read_seq || 0) + 1 : null,
    members,
    agent_members: (row.agents || []).map((a) => ({ id: a.agent_ref, name: a.name, auto_reply: !!a.auto_reply, mine: a.mine === true, owner_id: a.owner?.owner_id || '', owner_name: a.owner?.display_name || a.owner?.handle || '' })),
  }
}

function messageItem(row, me, env, workspaceId) {
  const author = row.author || { handle: null, owner_id: row.author_id, display_name: row.agent_name }
  const agent = row.author_kind === 'agent' || author.kind === 'agent'
  return {
    id: row.id,
    seq: row.seq,
    ...(row.mine && row.client_key ? {client_key: row.client_key} : {}),
    conversation_id: row.conversation_id,
    workspace_id: workspaceId,
    user_id: agent ? null : userIdOf(author, me, env),
    body: row.retracted ? '' : (row.body || ''),
    created: unix(row.created_at),
    revision: row.revision || 1,
    edited: unix(row.edited_at) || null,
    retracted: !!row.retracted,
    mode: row.mode || 'auto',
    ...(row.reactions?.length ? {reactions: row.reactions} : {}),
    ...(row.voice ? { voice: row.voice } : {}),
    ...(row.reply_preview ? {reply_preview: row.reply_preview} : {}),
    ...(row.forwarded_from ? {forwarded_from: row.forwarded_from} : {}),
    ...(row.reply_jobs?.length ? {reply_jobs: row.reply_jobs} : {}),
    ...(row.group_memory_refs?.length ? {group_memory_refs:row.group_memory_refs} : {}),
    ...(row.attachment ? { attachment: {...row.attachment, id: row.id,
      path: `/v1/workspaces/${workspaceId}/social/conversations/${seg(row.conversation_id)}/messages/${seg(row.id)}/file`,
    } } : {}),
    ...(agent ? { role: 'agent', agent_id: row.agent_ref || author.agent_ref, agent_name: row.agent_name || author.name, source: 'runtime_infer' } : {}),
  }
}

function workItem(row) {
  const kind = row.work_kind || (row.kind === 'work' ? 'document' : row.kind)
  return {
    slug: row.slug,
    title: row.title,
    kind,
    kind_label: WORK_LABELS[kind] || kind,
    author: usernameOf(row.creator) || row.creator?.display_name || '',
    updated: unix(row.updated_at),
    path: row.path || ('/w/' + row.slug),
    likes: row.likes ?? 0,
    collections: row.collections ?? 0,
    liked: !!row.liked,
    collected: !!row.collected,
    following: !!row.following,
    own_work: !!row.own,
  }
}

function agentItem(row) {
  return {
    slug: row.slug,
    name: row.title || row.name,
    summary: row.summary || '',
    category: row.category || '',
    creator: row.creator ? { handle: row.creator.handle, name: row.creator.display_name || usernameOf(row.creator) } : null,
    chat_enabled: row.chat_enabled === true,
    own_agent: row.own === true,
    updated: unix(row.updated_at),
    tags: [],
    members: [],
  }
}

function rethrow(error) {
  if (error instanceof Fault) throw error
  const raw = String(error?.code ?? '')
  const code = raw.replace(/^social\//, '')
  const status = Number(error?.status) || (
    code === 'not-configured' || code === 'not-connected' || raw === 'social/not-configured' || raw === 'social/not-connected' ? 503
      : code === 'unreachable' ? 503 : 500
  )
  const mapped = ({
    team_not_found: 'not_found',
    member_not_found: 'not_found',
    invite_not_found: 'not_found',
    invite_unusable: 'not_found',
    invalid_request: 'invalid',
    slug_taken: 'conflict',
    forbidden: 'forbidden',
    not_reachable: 'invalid',
    not_in_team: 'invalid',
    too_many_teams: 'quota',
    attachment_too_large: 'attachment_too_large',
    attachment_type_blocked: 'attachment_type_blocked',
    attachment_storage_full: 'attachment_storage_full',
    call_full: 'call_full',
    call_already_joined: 'call_already_joined',
    call_ended: 'call_ended',
    meeting_ended: 'meeting_ended',
    public_chat_closed: 'public_chat_closed',
    reply_unavailable: 'reply_unavailable',
  })[code] || (status === 404 ? 'not_found' : status === 403 ? 'forbidden' : status === 409 ? 'conflict' : status === 410 ? 'not_found' : status === 429 ? 'quota' : code || 'internal')
  throw new Fault(status === 410 ? 404 : status, mapped, error?.message || 'Bot Social request failed')
}

export async function wrap(fn) {
  try { return await fn() } catch (error) { rethrow(error) }
}

async function meOf(bs, env) {
  return bs.get('/v1/ot/me')
}

async function teamFor(bs, workspaceId, name, env) {
  if (!HEX.test(String(workspaceId || ''))) throw new Fault(400, 'invalid', 'Invalid workspace')
  // Workspace ownership is platform authority, never first-browser-call wins.
  // A verified migration must pre-link the team and preserve its full membership.
  try { return await bs.get(`/v1/ot/teams/by-workspace/${seg(workspaceId, 'workspace_id')}`) }
  catch (error) {
    if (error?.status === 404) throw new Fault(409, 'membership_migration_required', 'This workspace needs verified Bot Social membership migration; legacy data is unchanged')
    throw error
  }
}

function ttlDays(expiresIn) {
  const seconds = Number(expiresIn)
  if (!Number.isFinite(seconds) || seconds <= 0) return 7
  return Math.min(30, Math.max(1, Math.round(seconds / 86400) || 7))
}

function parseQuery(query) {
  return new URLSearchParams(String(query || '').replace(/^\?/, ''))
}

function client(host) {
  return sharedBotSocial(host)
}

function membersRoutes(host) {
  const env = process.env
  return [
    {
      method: 'GET', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/members$/,
      async handle({ match }) {
        return wrap(async () => {
          const bs = client(host)
          const team = await teamFor(bs, match[1], 'Workspace', env)
          const me = await meOf(bs, env)
          const data = await bs.get(`/v1/ot/teams/${seg(team.id, 'team_id')}/members`)
          return [200, { items: (data.members || []).map((m) => memberItem(m, me, env)) }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/members$/,
      async handle({ match, body }) {
        return wrap(async () => {
          const bs = client(host)
          const team = await teamFor(bs, match[1], 'Workspace', env)
          const me = await meOf(bs, env)
          const data = await bs.post(`/v1/ot/teams/${seg(team.id, 'team_id')}/members`, {
            handle: body?.username || body?.handle, role: body?.role,
          })
          // Bot Social returns the member; treat first-time add as 201 when we cannot tell.
          return [201, { member: memberItem(data, me, env) }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/members\/([A-Za-z0-9._-]{1,80})$/,
      async handle({ match, body }) {
        return wrap(async () => {
          const bs = client(host)
          const team = await teamFor(bs, match[1], 'Workspace', env)
          const me = await meOf(bs, env)
          const data = await bs.patch(`/v1/ot/teams/${seg(team.id, 'team_id')}/members/${seg(match[2], 'handle')}`, { role: body?.role })
          return [200, { member: memberItem(data, me, env) }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/members\/([A-Za-z0-9._-]{1,80})\/(remove|suspend|unsuspend)$/,
      async handle({ match }) {
        return wrap(async () => {
          const bs = client(host)
          const team = await teamFor(bs, match[1], 'Workspace', env)
          const me = await meOf(bs, env)
          const action = match[3]
          const path = `/v1/ot/teams/${seg(team.id, 'team_id')}/members/${seg(match[2], 'handle')}`
          if (action === 'remove') {
            await bs.del(path)
            return [200, {}]
          }
          const data = await bs.patch(path, { suspended: action === 'suspend' })
          return [200, { member: memberItem(data, me, env) }]
        })
      },
    },
  ]
}

function invitesRoutes(host) {
  const env = process.env
  return [
    {
      method: 'GET', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/invites$/,
      async handle({ match }) {
        return wrap(async () => {
          const bs = client(host)
          const team = await teamFor(bs, match[1], 'Workspace', env)
          const data = await bs.get(`/v1/ot/teams/${seg(team.id, 'team_id')}/invites`)
          return [200, { items: (data.invites || []).map((row) => inviteItem(row, match[1])) }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/invites$/,
      async handle({ match, body }) {
        return wrap(async () => {
          const bs = client(host)
          const team = await teamFor(bs, match[1], 'Workspace', env)
          const data = await bs.post(`/v1/ot/teams/${seg(team.id, 'team_id')}/invites`, {
            role: body?.role, ttl_days: ttlDays(body?.expires_in), max_uses: body?.max_uses,
            requires_approval: body?.requires_approval === true,
          })
          return [201, { invite: inviteItem(data.invite || data, match[1]), token: data.code }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/invites\/([A-Za-z0-9._-]{1,80})\/(revoke|freeze|unfreeze)$/,
      async handle({ match }) {
        return wrap(async () => {
          const bs = client(host)
          const team = await teamFor(bs, match[1], 'Workspace', env)
          const action = match[3]
          const patch = action === 'revoke' ? { revoked: true } : { frozen: action === 'freeze' }
          const data = await bs.patch(`/v1/ot/teams/${seg(team.id, 'team_id')}/invites/${seg(match[2], 'invite_id')}`, patch)
          return [200, { invite: inviteItem(data.invite || data, match[1]) }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/invites\/accept$/,
      async handle({ body }) {
        return wrap(async () => {
          const bs = client(host)
          const data = await bs.post('/v1/ot/invites/accept', { code: body?.token || body?.code })
          if (data.status === 'pending') {
            return [202, { join_request: { id: data.request_id, status: 'pending', team_id: data.team_id } }]
          }
          if (data.status === 'suspended') throw new Fault(403, 'forbidden', 'Your membership in this workspace is suspended')
          return [200, { workspace: { id: data.workspace_id || data.team_id }, member: { role: 'member' } }]
        })
      },
    },
    {
      method: 'GET', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/join-requests$/,
      async handle({ match }) {
        return wrap(async () => {
          const bs = client(host)
          const team = await teamFor(bs, match[1], 'Workspace', env)
          const data = await bs.get(`/v1/ot/teams/${seg(team.id, 'team_id')}/join-requests` + qs({ status: 'pending' }))
          return [200, { items: (data.requests || []).map((row) => requestItem(row, match[1])) }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/join-requests\/([A-Za-z0-9._-]{1,80})\/(approve|reject)$/,
      async handle({ match }) {
        return wrap(async () => {
          const bs = client(host)
          const team = await teamFor(bs, match[1], 'Workspace', env)
          const data = await bs.post(`/v1/ot/teams/${seg(team.id, 'team_id')}/join-requests/${seg(match[2], 'request_id')}`, {
            decision: match[3],
          })
          return [200, { join_request: requestItem(data.request || data, match[1]) }]
        })
      },
    },
    {
      method: 'GET', path: /^\/v1\/join-requests$/,
      async handle() {
        return wrap(async () => {
          const bs = client(host)
          const data = await bs.get('/v1/ot/join-requests/mine')
          return [200, { items: (data.requests || []).map((row) => requestItem(row)) }]
        })
      },
    },
  ]
}

function workspaceItem(team, me, env) {
  return {
    id: team.workspace_id,
    owner_id: userIdOf(team.owner || {}, me, env),
    name: team.name,
    created: unix(team.created_at),
    kind: team.slug ? 'team' : 'workspace',
    slug: team.slug || null,
    team_name: team.slug ? team.name : null,
    converted: false,
    role: team.role || null,
    member_count: team.member_count ?? 1,
  }
}

const IDEM = /^[A-Za-z0-9_-]{16,64}$/

function personalWorkspace(binding, env) {
  if (!HEX.test(binding?.workspace_id) || !HEX.test(binding?.agent_id)) return null
  const owner = ownerId(env)
  return {
    id: binding.workspace_id, owner_id: HEX.test(owner) ? owner : null,
    name: '个人工作区', created: 0, kind: 'personal', slug: null,
    team_name: null, converted: false, role: 'owner', member_count: 1,
  }
}

function teamsRoutes(host) {
  const env = process.env
  return [
    {
      method: 'GET', path: /^\/v1\/workspaces$/,
      async handle({ query }) {
        return wrap(async () => {
          const q = parseQuery(query)
          const binding = host.call('agents/personal-binding', {})
          if (q.get('scope') === 'personal') {
            const personal = personalWorkspace(await binding, env)
            return [200, { items: personal ? [personal] : [], cursor: null }]
          }
          const bs = client(host)
          const limit = Math.min(Math.max(Number(q.get('limit') || 20) || 20, 1), 100)
          const cursor = q.get('cursor') || ''
          const [me, data, localBinding] = await Promise.all([
            meOf(bs, env), bs.get('/v1/ot/workspaces'), binding,
          ])
          let rows = (data.workspaces || [])
            .filter((t) => HEX.test(String(t.workspace_id || '')))
            .map((t) => workspaceItem(t, me, env))
          const personal = personalWorkspace(localBinding, env)
          if (personal && !rows.some(row => row.id === personal.id)) rows.unshift(personal)
          if (cursor) {
            const at = rows.findIndex((row) => row.id === cursor)
            rows = at >= 0 ? rows.slice(at + 1) : []
          }
          const page = rows.slice(0, limit)
          return [200, { items: page, cursor: rows.length > limit ? page[page.length - 1].id : null }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/workspaces$/,
      async handle({ body, idempotency_key: key }) {
        return wrap(async () => {
          const name = typeof body?.name === 'string' ? body.name.trim() : ''
          if (!name || name.length > 80) throw new Fault(400, 'invalid', 'Workspace name must be 1–80 characters without controls')
          if (!IDEM.test(String(key || ''))) throw new Fault(400, 'invalid', 'Supply a 16–64 character Idempotency-Key')
          const bs = client(host)
          const [me, team] = await Promise.all([meOf(bs, env), bs.post('/v1/ot/workspaces', { name, idempotency_key: key })])
          return [201, { workspace: workspaceItem(team, me, env) }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/teams$/,
      async handle({ body, idempotency_key: key }) {
        return wrap(async () => {
          const name = typeof body?.name === 'string' ? body.name.trim() : ''
          const slug = body?.slug
          if (!name || !['new', 'convert'].includes(body?.mode)) throw new Fault(400, 'invalid', 'Provide a team name, a valid Team ID, and new or convert')
          if (!IDEM.test(String(key || ''))) throw new Fault(400, 'invalid', 'Supply a 16–64 character Idempotency-Key')
          const bs = client(host)
          const me = await meOf(bs, env)
          const team = body.mode === 'new'
            ? await bs.post('/v1/ot/workspaces', { name, slug, idempotency_key: key })
            : await bs.post(`/v1/ot/workspaces/${seg(body?.workspace_id, 'workspace_id')}/convert`, { name, slug })
          return [body.mode === 'new' ? 201 : 200, { workspace: { ...workspaceItem(team, me, env), converted: body.mode === 'convert' } }]
        })
      },
    },
    {
      method: 'GET', path: /^\/v1\/team-directory$/,
      async handle({ query }) {
        return wrap(async () => {
          const bs = client(host)
          const q = parseQuery(query)
          const data = await bs.get('/v1/ot/directory' + qs({ q: q.get('q'), limit: q.get('limit') }))
          return [200, {
            items: (data.teams || []).map((t) => ({
              name: t.name,
              summary: t.summary || '',
              member_count: t.member_count ?? 0,
              workspace_id: t.workspace_id || t.id,
              membership: t.membership || null,
            })),
          }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/team-directory\/([A-Za-z0-9._-]{1,80})\/join$/,
      async handle({ match }) {
        return wrap(async () => {
          const bs = client(host)
          const id = match[1]
          const teamId = HEX.test(id)
            ? (await bs.get(`/v1/ot/teams/by-workspace/${seg(id, 'workspace_id')}`)).id
            : id
          const data = await bs.post(`/v1/ot/directory/${seg(teamId, 'team_id')}/join`)
          if (data.status === 'pending') return [202, { join_request: { id: data.request_id, status: 'pending' } }]
          return [200, { status: data.status || 'member' }]
        })
      },
    },
    {
      method: 'GET', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/directory$/,
      async handle({ match }) {
        return wrap(async () => {
          const bs = client(host)
          const team = await teamFor(bs, match[1], 'Workspace', env)
          return [200, { listing: { listed: !!team.listed, summary: team.summary || '' } }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/directory$/,
      async handle({ match, body }) {
        return wrap(async () => {
          const bs = client(host)
          const team = await teamFor(bs, match[1], 'Workspace', env)
          const data = await bs.put(`/v1/ot/teams/${seg(team.id, 'team_id')}/listing`, {
            listed: body?.listed === true, summary: body?.summary,
          })
          return [200, { listing: { listed: !!data.listed, summary: data.summary || '' } }]
        })
      },
    },
  ]
}

const accountConversation = c => Boolean(c?.direct || c?.account_group)

async function messengerScope(host, bs, workspace, conversationId, messageId) {
  const binding = await host.call?.('agents/personal-binding', {})
  if (binding?.workspace_id !== workspace) {
    return {personal: false, team: await teamFor(bs, workspace, 'Workspace', process.env)}
  }
  if (!conversationId) return {personal: true}
  const path = '/v1/ot/conversations/' + seg(conversationId, 'conversation_id')
  const conversation = await bs.get(path)
  if (!conversation.public_agent && !accountConversation(conversation)) throw new Fault(404, 'not_found', '该会话不在个人工作区。')
  if (messageId) await bs.get('/v1/ot/messages/' + seg(messageId, 'message_id') + qs({conversation_id: conversationId}))
  return {personal: true, conversation}
}

async function requireGroupMemoryScope(host,bs,workspace,cid) {
  if (typeof workspace !== 'string' || !HEX.test(workspace)) throw new Fault(400,'invalid','无效的工作区。')
  const scope = await messengerScope(host,bs,workspace,cid)
  const group = scope.conversation || await bs.get('/v1/ot/conversations/' + cid)
  if (group.kind !== 'group' || group.public_agent || (scope.personal ? !group.account_group : group.team_id !== scope.team.id)) {
    throw new Fault(404,'not_found','该群聊不在当前工作区。')
  }
  return group
}

export async function shareGroupMemory(host, payload) {
  const {workspace_id,conversation_id,title,body,source_message_id,sources,client_key} = payload || {}
  const bs = client(host), cid = seg(conversation_id,'conversation_id')
  await requireGroupMemoryScope(host,bs,workspace_id,cid)
  return bs.post(`/v1/ot/conversations/${cid}/memories`,{title,body,source_message_id,sources,client_key})
}

export async function groupMemorySources(host, payload) {
  const {workspace_id:workspace, conversation_id:id, message_ids, after} = payload || {}
  if (typeof workspace !== 'string' || !HEX.test(workspace)) throw new Fault(400,'invalid','无效的工作区。')
  const cid = seg(id,'conversation_id')
  const binding = await host.call('agents/personal-binding', {})
  return client(host).post(`/v1/ot/conversations/${cid}/memory-sources`,{
    ...(binding?.workspace_id === workspace ? {} : {workspace_id:workspace}),
    ...(after === undefined ? {message_ids} : {after}),
  })
}

function messengerRoutes(host, wakeReplies) {
  const env = process.env
  const convPath = /^\/v1\/workspaces\/([0-9a-f]{32})\/social\/conversations$/
  const onePath = /^\/v1\/workspaces\/([0-9a-f]{32})\/social\/conversations\/([A-Za-z0-9._-]{1,80})$/
  return [
    {
      method: 'GET', path: convPath,
      async handle({ match, query }) {
        return wrap(async () => {
          const bs = client(host)
          const {personal, team} = await messengerScope(host, bs, match[1])
          const scope = {scope: personal ? 'personal' : 'member', team_id: team?.id}
          const q = parseQuery(query)
          if (q.get('view') === 'activity') {
            const data = await bs.get('/v1/ot/conversations' + qs({...scope, view: 'activity', since: q.get('since')}))
            return [200, data]
          }
          const me = await meOf(bs, env)
          const data = await bs.get('/v1/ot/conversations' + qs(scope))
          const items = (data.conversations || []).filter(c => personal ? (c.public_agent || accountConversation(c)) : !c.public_agent)
            .map(c => conversationItem(c, me, env, match[1]))
          return [200, { items, cursor: null }]
        })
      },
    },
    {
      method: 'POST', path: convPath,
      async handle({ match, body, idempotency_key }) {
        return wrap(async () => {
          const bs = client(host)
          const {personal, team} = await messengerScope(host, bs, match[1])
          const me = await meOf(bs, env)
          const kind = body?.kind
          const ids = Array.isArray(body?.member_ids) ? body.member_ids : []
          if (kind !== 'dm' && kind !== 'group') throw new Fault(400, 'invalid', '请选择会话类型。')
          let data
          if (kind === 'dm') {
            data = await bs.post('/v1/ot/conversations', { kind: 'dm', peer: ids[0] })
          } else {
            const agentIds = body?.agent_ids ?? []
            if (!Array.isArray(agentIds) || agentIds.length > 10) throw new Fault(400, 'invalid', '最多可选 10 个智能体。')
            const agents = await Promise.all([...new Set(agentIds)].map(async id => {
              const {agent} = await host.call('agents/get', {id, workspace_id: match[1]})
              if (agent.archived) throw new Fault(400, 'invalid', '请选择可用的智能体。')
              return {agent_ref:agent.id, name:String(agent.name).slice(0,40)}
            }))
            data = await bs.post('/v1/ot/conversations', {
              kind: 'group', title: body?.title, team_id: team?.id, account_group: personal,
              members: ids, agents, idempotency_key,
            })
          }
          const conversation = conversationItem(data, me, env, match[1])
          return [data.id && conversation.id ? 201 : 200, { conversation }]
        })
      },
    },
    {
      method: 'GET', path: onePath,
      async handle({ match }) {
        return wrap(async () => {
          const bs = client(host)
          const scope = await messengerScope(host, bs, match[1], match[2])
          const me = await meOf(bs, env)
          const conv = scope.conversation || await bs.get(`/v1/ot/conversations/${seg(match[2], 'conversation_id')}`)
          const page = await bs.get(`/v1/ot/conversations/${seg(match[2], 'conversation_id')}/messages` + qs({limit: 100, pins: 1}))
          return [200, {
            conversation: conversationItem(conv, me, env, match[1]),
            items: (page.messages || []).map((m) => messageItem({ ...m, conversation_id: conv.id }, me, env, match[1])),
            agent_replies: [],
            pinned_messages: page.pinned_messages || [],
            cursor: page.next_before ?? null,
          }]
        })
      },
    },
    {
      method: 'GET', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/social\/conversations\/([A-Za-z0-9._-]{1,80})\/messages$/,
      async handle({ match, query }) {
        return wrap(async () => {
          const bs = client(host)
          const scope = await messengerScope(host, bs, match[1], match[2])
          const me = await meOf(bs, env)
          const q = parseQuery(query)
          const page = await bs.get(`/v1/ot/conversations/${seg(match[2], 'conversation_id')}/messages` + qs({
            workspace_id: !scope.personal && q.get('scope') === 'workspace' ? match[1] : undefined,
            limit: q.get('limit'), before: q.get('before') || q.get('cursor'), around: q.get('around'), q: q.get('q'),
          }))
          return [200, {
            items: (page.messages || []).map(m => messageItem({ ...m, conversation_id: match[2] }, me, env, match[1])),
            cursor: page.next_before ?? null, has_newer: page.has_newer === true,
          }]
        })
      },
    },
    {
      method: 'GET', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/social\/conversations\/([A-Za-z0-9._-]{1,80})\/messages\/([A-Za-z0-9._-]{1,80})\/voice$/,
      async handle({ match }) {
        return wrap(async () => {
          const bs = client(host)
          await messengerScope(host, bs, match[1], match[2])
          const conversation = seg(match[2], 'conversation_id')
          const message = seg(match[3], 'message_id')
          return [200, await bs.get(`/v1/ot/conversations/${conversation}/messages/${message}/voice`)]
        })
      },
    },
    {
      method:'GET', path:/^\/v1\/workspaces\/([0-9a-f]{32})\/social\/conversations\/([A-Za-z0-9._-]{1,80})\/shared-memory$/,
      async handle({match}) {
        return wrap(async () => {
          const bs = client(host)
          await requireGroupMemoryScope(host,bs,match[1],match[2])
          const [shared, capture] = await Promise.all([
            bs.get(`/v1/ot/conversations/${match[2]}/memories`),
            host.call('memory/groupCaptureStatus',{workspace_id:match[1],conversation_id:match[2]}),
          ])
          return [200,{...shared,auto_capture:capture.enabled}]
        })
      },
    },
    {
      method:'POST', path:/^\/v1\/workspaces\/([0-9a-f]{32})\/social\/conversations\/([A-Za-z0-9._-]{1,80})\/shared-memory\/auto-capture$/,
      async handle({match,body}) {
        return wrap(async () => {
          if (typeof body?.enabled !== 'boolean') throw new Fault(400,'invalid','请选择是否自动提炼。')
          return [200,await host.call('memory/setGroupCapture',{
            workspace_id:match[1],conversation_id:match[2],enabled:body.enabled,
          })]
        })
      },
    },
    {
      method:'POST', path:/^\/v1\/workspaces\/([0-9a-f]{32})\/social\/conversations\/([A-Za-z0-9._-]{1,80})\/shared-memory\/([A-Za-z0-9._-]{1,80})\/remove$/,
      async handle({match}) {
        return wrap(async () => {
          const bs = client(host)
          await requireGroupMemoryScope(host,bs,match[1],match[2])
          return [200,await bs.del(`/v1/ot/conversations/${match[2]}/memories/${match[3]}`)]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/social\/conversations\/([A-Za-z0-9._-]{1,80})\/memory\/capture$/,
      async handle({match,body}) {
        return wrap(async () => {
          const message_ids = body?.message_ids
          if (!Array.isArray(message_ids) || !message_ids.length || !message_ids.every(id => typeof id === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(id))) {
            throw new Fault(400,'invalid','请选择 1 到 12 条群成员的文字消息。')
          }
          const scope = {workspace_id:match[1],conversation_id:match[2]}
          const {items} = await groupMemorySources(host,{...scope,message_ids})
          if (items.length !== message_ids.length) throw new Fault(409,'conflict','有消息已撤回、删除或无法用于提炼，请重新选择。')
          return [202,await host.call('memory/enqueueGroupHistory',{...scope,messages:items.map(({id,revision}) => ({id,revision}))})]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/social\/conversations\/([A-Za-z0-9._-]{1,80})\/messages$/,
      async handle({ match, body, idempotency_key }) {
        return wrap(async () => {
          const bs = client(host)
          const scope = await messengerScope(host, bs, match[1], match[2])
          let message = body
          if (body?.artifact_id !== undefined) {
            if (body.voice || body.attachment || scope.conversation?.public_agent) {
              throw new Fault(400, 'invalid', '请选择可以接收附件的群聊或单聊。')
            }
            const snapshot = await host.call('artifacts/chatAttachment', {workspace_id: match[1],
              artifact_id: body.artifact_id, revision: body.artifact_revision})
            message = {...body, body: snapshot.body, attachment: snapshot.attachment}
          }
          const me = await meOf(bs, env)
          const data = await bs.post(`/v1/ot/conversations/${seg(match[2], 'conversation_id')}/messages`, { body: message?.body, voice: message?.voice, attachment: message?.attachment, workspace: match[1], direct: accountConversation(scope.conversation), client_key: idempotency_key, mentions: message?.mentions, agent_mentions: message?.agent_mentions, reply_to: message?.reply_to, mode: message?.mode })
          if (data.reply_jobs?.some(job => job.status === 'queued')) wakeReplies()
          return [201, { message: messageItem({ ...data, conversation_id: match[2] }, me, env, match[1]) }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/social\/conversations\/([A-Za-z0-9._-]{1,80})\/read$/,
      async handle({ match, body }) {
        return wrap(async () => {
          const bs = client(host)
          await messengerScope(host, bs, match[1], match[2])
          const data = await bs.post(`/v1/ot/conversations/${seg(match[2], 'conversation_id')}/read`, body?.seq === undefined ? {} : { seq: body.seq })
          return [200, { unread_count: data.unread ?? 0 }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/social\/conversations\/([A-Za-z0-9._-]{1,80})\/preferences$/,
      async handle({ match, body }) {
        return wrap(async () => {
          const bs = client(host)
          await messengerScope(host, bs, match[1], match[2])
          const data = await bs.patch(`/v1/ot/conversations/${seg(match[2], 'conversation_id')}`, { pinned: body?.pinned, muted: body?.muted })
          return [200, { pinned: !!data.pinned, muted: !!data.muted }]
        })
      },
    },
  ]
}

// Remaining legacy messenger subroutes (message pin/react/edit/retract/delete/save,
// forward, group agents, manual agent replies). Agent replies run as one native
// turn on THIS user's DS-Bot; nothing falls back to the platform.
function messengerExtraRoutes(host, wakeReplies) {
  const env = process.env
  const base = '^\\/v1\\/workspaces\\/([0-9a-f]{32})\\/social\\/conversations\\/([A-Za-z0-9._-]{1,80})'
  const re = (tail) => new RegExp(base + tail + '$')
  const conv = (id) => `/v1/ot/conversations/${seg(id, 'conversation_id')}`
  const msg = (id) => `/v1/ot/messages/${seg(id, 'message_id')}`
  const page = async (bs, cid) => (await bs.get(`${conv(cid)}/messages` + qs({ limit: 100 }))).messages || []
  const findMessage = (bs, cid, mid) => bs.get(msg(mid) + qs({conversation_id: cid}))
  const callTeam = async (bs, workspace, cid) => {
    const scope = await messengerScope(host, bs, workspace, cid)
    if (scope.personal && !accountConversation(scope.conversation)) throw new Fault(404, 'not_found', '该会话没有通话功能。')
    return scope.team?.id
  }
  return [
    {
      method: 'POST', path: /^\/v1\/meeting-calls\/(create|preview|join|poll|signal|leave|end)$/,
      handle: ({ match, body }) => wrap(async () => [200, await client(host).post('/v1/ot/meeting-calls/' + match[1], body)]),
    },
    {
      method: 'POST', path: re('\\/messages\\/([A-Za-z0-9._-]{1,80})\\/agent-retry'),
      handle: ({match, body}) => wrap(async () => {
        const [, workspace, conversation, message] = match
        const bs = client(host)
        await messengerScope(host, bs, workspace, conversation)
        const result = await bs.post(conv(conversation) + '/messages/' + seg(message) + '/agent-retry', {job_id: body?.job_id})
        wakeReplies()
        return [200, result]
      }),
    },
    {
      method: 'GET', path: re('\\/messages\\/([A-Za-z0-9._-]{1,80})\\/file'),
      handle: ({ match, query }) => wrap(async () => {
        const [, workspace, conversation, message] = match
        const bs = client(host)
        const scope = await messengerScope(host, bs, workspace, conversation)
        const path = accountConversation(scope.conversation) ? conv(conversation) : `/v1/ot/workspaces/${workspace}/conversations/${seg(conversation)}`
        const file = await bs.get(path + '/messages/' + seg(message) + '/file')
        const inline = /^(image|audio|video)\//.test(file.mime) && new URLSearchParams(query).get('download') !== '1'
        return [200, null, {filename: file.title, content_type: file.mime, data: file.data, inline}]
      }),
    },
    {
      method: 'GET', path: re('\\/call'),
      handle: async ({ match }) => wrap(async () => {
        const bs = client(host)
        const teamId = await callTeam(bs, match[1], match[2])
        return [200, await bs.get(conv(match[2]) + '/call' + qs({team_id: teamId}))]
      }),
    },
    {
      method: 'POST', path: re('\\/call\\/(join|poll|signal|leave)'),
      handle: async ({ match, body }) => wrap(async () => {
        const bs = client(host)
        const teamId = await callTeam(bs, match[1], match[2])
        return [200, await bs.post(conv(match[2]) + '/call/' + match[3], {...body, team_id: teamId})]
      }),
    },
    ...['GET','POST'].map(method=>({method,path:re('\\/(translation|translations)'),
      async handle(p) {
        const result=await host.call('message-assists/v1',{method,path:p.match[0],body:p.body})
        return [result.status,result.body]
      },
    })),
    ...['GET','POST'].map(method=>({method,path:/^\/v1\/workspaces\/([0-9a-f]{32})\/social\/conversations\/([A-Za-z0-9._-]{1,80})\/assists$/,
      async handle(p){ const out=await host.call('message-assists/v1',{method,path:p.match[0],body:p.body,idempotency_key:p.idempotency_key});return [out.status,out.body] } })),
    ...['GET', 'POST'].map(method => ({ method, path: /^\/v1\/workspaces\/([0-9a-f]{32})\/social\/conversations\/([A-Za-z0-9._-]{1,80})\/announcement$/,
      handle: async ({ match, body }) => wrap(async () => {
        const bs = client(host); await messengerScope(host, bs, match[1], match[2])
        const path = '/v1/ot/conversations/' + encodeURIComponent(match[2]) + '/announcement'
        return [200, method === 'GET' ? await bs.get(path) : await bs.post(path, body)]
      }) })),
    {
      method: 'POST', path: re('\\/members'),
      async handle({ match, body }) {
        return wrap(async () => {
          const bs = client(host)
          const scope = await messengerScope(host, bs, match[1], match[2])
          const path = conv(match[2])
          const group = scope.conversation || await bs.get(path)
          if (scope.personal ? !group.account_group : group.team_id && group.team_id !== scope.team.id) {
            throw new Fault(404, 'not_found', 'Conversation not found in this workspace')
          }
          const updated = await bs.post(path + '/members', { handles: body?.member_ids ?? [], team_id: scope.team?.id })
          return [200, { conversation: conversationItem(updated, await meOf(bs, env), env, match[1]) }]
        })
      },
    },
    {
      method: 'POST', path: re('\\/messages\\/([A-Za-z0-9._-]{1,80})\\/pin'),
      async handle({ match, body }) {
        return wrap(async () => {
          const bs = client(host); await messengerScope(host, bs, match[1], match[2], match[3])
          const data = await bs.post(`${msg(match[3])}/pin`, { on: body?.pinned !== false })
          return [200, { pinned: data.pinned, pinned_messages: data.pinned_messages || [] }]
        })
      },
    },
    {
      method: 'POST', path: re('\\/messages\\/([A-Za-z0-9._-]{1,80})\\/reactions'),
      async handle({ match, body }) {
        return wrap(async () => {
          const bs = client(host); await messengerScope(host, bs, match[1], match[2], match[3])
          const data = await bs.post(`${msg(match[3])}/reactions`, { emoji: body?.emoji, on: body?.active !== false })
          return [200, { reactions: data.reactions || [] }]
        })
      },
    },
    {
      method: 'DELETE', path: re('\\/messages\\/([A-Za-z0-9._-]{1,80})'),
      async handle({ match }) {
        return wrap(async () => {
          const bs = client(host); await messengerScope(host, bs, match[1], match[2])
          await bs.post(`${msg(match[3])}/hide`, {conversation_id: match[2]})
          return [204, {}]
        })
      },
    },
    {
      method: 'POST', path: re('\\/messages\\/([A-Za-z0-9._-]{1,80})\\/(edit|retract)'),
      async handle({ match, body }) {
        return wrap(async () => {
          const bs = client(host); await messengerScope(host, bs, match[1], match[2], match[3])
          const me = await meOf(bs, env)
          if (match[4] === 'retract') {
            await bs.del(msg(match[3]))
            return [200, { message: messageItem({ ...(await findMessage(bs, match[2], match[3])), conversation_id: match[2] }, me, env, match[1]) }]
          }
          const data = await bs.patch(msg(match[3]), { body: body?.body })
          return [200, { message: messageItem({ ...data, conversation_id: match[2] }, me, env, match[1]) }]
        })
      },
    },
    {
      method: 'POST', path: re('\\/messages\\/([A-Za-z0-9._-]{1,80})\\/save'),
      async handle({ match, body }) {
        return wrap(async () => {
          const [, workspace, conversation, message] = match
          if (!Number.isInteger(body?.revision) || body.revision < 1) throw new Fault(400, 'invalid', 'Provide the message revision')
          const bs = client(host)
          const scope = await messengerScope(host, bs, workspace, conversation)
          const row = accountConversation(scope.conversation)
            ? {...await findMessage(bs, conversation, message), title: scope.conversation.title}
            : await bs.get(`/v1/ot/workspaces/${workspace}/conversations/${seg(conversation)}/messages/${seg(message)}`)
          if (row.retracted || row.attachment || row.voice || !row.body?.trim()) throw new Fault(409, 'conflict', '只能保存未撤回的文字消息。')
          if (row.revision !== body.revision) throw new Fault(409, 'conflict', '消息已修改，请刷新后再保存。')
          const {status, artifact} = await host.call('artifacts/saveChatMessage', {
            workspace_id: workspace, conversation_id: conversation, message_id: message,
            conversation_title: row.title, title: body.title, body: row.body,
          })
          return [status, {artifact}]
        })
      },
    },
    {
      method: 'POST', path: re('\\/forward'),
      async handle({ match, body, idempotency_key: key }) {
        return wrap(async () => {
          const bs = client(host)
          const {personal} = await messengerScope(host, bs, match[1])
          return [201, await bs.post(conv(match[2]) + '/forward', {
            message_ids: body?.message_ids, target_conversation_id: body?.target_conversation_id,
            workspace: personal ? undefined : match[1], request_key: key,
          })]
        })
      },
    },
    {
      method: 'POST', path: re('\\/agents'),
      async handle({ match, body }) {
        return wrap(async () => {
          const bs = client(host); await messengerScope(host, bs, match[1], match[2])
          const ids = Array.isArray(body?.agent_ids) ? body.agent_ids.slice(0, 10) : []
          if (!ids.length) throw new Fault(400, 'invalid', 'Provide agent_ids')
          for (const id of ids) {
            const { agent } = await host.call('agents/get', { id, workspace_id: match[1] })
            await bs.put(`${conv(match[2])}/agents/${seg(agent.id, 'agent_ref')}`, { name: String(agent.name).slice(0, 40), auto_reply: false })
          }
          return [201, { added: ids.length }]
        })
      },
    },
    {
      method: 'POST', path: re('\\/agents\\/([A-Za-z0-9._-]{1,80})\\/auto-reply'),
      async handle({ match, body }) {
        return wrap(async () => {
          if (typeof body?.auto_reply !== 'boolean') throw new Fault(400, 'invalid', 'Provide auto_reply as a boolean')
          const bs = client(host); await messengerScope(host, bs, match[1], match[2])
          const result = await bs.patch(`${conv(match[2])}/agents/${seg(match[3], 'agent_ref')}`, { auto_reply: body.auto_reply })
          return [200, { auto_reply: result.auto_reply }]
        })
      },
    },
    {
      method: 'POST', path: re('\\/agents\\/([A-Za-z0-9._:-]{1,80})\\/remove'),
      async handle({ match }) {
        return wrap(async () => {
          const bs = client(host); await messengerScope(host, bs, match[1], match[2])
          await bs.del(`${conv(match[2])}/agents/${seg(match[3], 'agent_ref')}`)
          return [200, { removed: true }]
        })
      },
    },
    {
      method: 'POST', path: re('\\/agent-replies'),
      async handle({ match, body, idempotency_key: key }) {
        return wrap(async () => {
          const bs = client(host); await messengerScope(host, bs, match[1], match[2])
          const ids = Array.isArray(body?.agent_ids) ? body.agent_ids.slice(0, 5) : []
          const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : ''
          if (!ids.length || !prompt || prompt.length > 4000) throw new Fault(400, 'invalid', 'Provide agent_ids and a 1–4000 character prompt')
          const services = host.currentRuntime?.()
          if (!services || typeof services.chatTurn !== 'function') throw new Fault(503, 'runtime_unavailable', 'DS-Bot chat service unavailable')
          const conversation = await bs.get(conv(match[2]))
          if (conversation.public_agent) throw new Fault(409, 'public_chat_fixed', '公开智能体会话会自动回复。')
          const context = (await page(bs, match[2])).slice(-12).map((m) => ({ author: m.author, body: m.body }))
          const memories = conversation.kind === 'group'
            ? selectGroupMemories(prompt,(await bs.get(`${conv(match[2])}/memories`)).items) : []
          const tag = String(key || Date.now()).slice(0, 40)
          const me = await meOf(bs, env)
          const replies = []
          for (const id of ids) {
            const agent = (conversation.agents || []).find((a) => a.agent_ref === id && a.mine)
            if (!agent) throw new Fault(404, 'not_found', 'That agent of yours is not in this group')
            const turn = await host.call('agents/turn', { agent_id: id, key: `social:${match[2]}`, text: replyPrompt({ agent_name: agent.name, conversation_title: conversation.title, mode: 'mention', context: [...context, { author: { display_name: me.display_name || 'member' }, body: prompt }] }, memories), request_id: `otr:${tag}:${id}` })
            const text = String(turn?.text ?? '').trim()
            if (!text) continue
            const posted = await bs.post(`${conv(match[2])}/agent-messages`, { agent_ref: id, body: text.slice(0, 4000), mode: 'mention', client_key: `m:${tag}:${id}`.slice(0, 80),
              ...(memories.length ? {group_memory_ids:memories.map(memory=>memory.id)} : {}),
            })
            replies.push(messageItem({ ...posted, conversation_id: match[2] }, me, env, match[1]))
          }
          return [201, { replies }]
        })
      },
    },
  ]
}

function remixInstructions(row) {
  if (!row?.snapshot) return ''
  try {
    const data = JSON.parse(row.snapshot)
    const instructions = data?.instructions
    return data?.version === 1 && typeof instructions === 'string' && instructions.length <= agentLimits.instructions
      ? instructions : ''
  } catch { return '' }
}

function remixTemplate(row) {
  const template = { name: row.title, summary: row.summary || '', category: agentCategories.includes(row.category) ? row.category : null,
    instructions: remixInstructions(row) }
  const revision = createHash('sha256').update(JSON.stringify([row.id, template])).digest('hex')
  return { ...template, revision }
}

function discoverRoutes(host) {
  const env = process.env
  const feed = (kind) => async ({ query }) => wrap(async () => {
    const bs = client(host)
    const q = parseQuery(query)
    const data = await bs.get('/v1/ot/discover' + qs({
      kind, tab: q.get('tab'), q: q.get('q'), work_kind: q.get('kind'),
      creator: q.get('creator'), category: q.get('category'),
      before: q.get('cursor'), limit: q.get('limit'),
    }))
    const items = (data.items || []).map((row) => (kind === 'agent' ? agentItem(row) : workItem(row)))
    return [200, { items, cursor: data.next_before ?? null }]
  })
  const workListing = async (bs, artifactId) => ((await bs.get('/v1/ot/listings/mine')).listings || []).find((l) => l.kind === 'work' && l.ref === artifactId)
  const workMeta = (row) => (row && row.listed ? { listed: true, slug: row.slug, updated: unix(row.updated_at), path: row.path } : { listed: false })
  return [
    // Publish a work (artifact on this DS-Bot) to the public Bot Social catalog (/w/<slug>).
    {
      method: 'GET', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/artifacts\/([0-9a-f]{32})\/discover$/,
      async handle({ match }) { return wrap(async () => [200, { discover: workMeta(await workListing(client(host), match[2])) }]) },
    },
    {
      method: 'POST', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/artifacts\/([0-9a-f]{32})\/discover$/,
      async handle({ match, body }) {
        return wrap(async () => {
          const bs = client(host)
          const got = await host.call('artifacts/v1', { method: 'GET', path: `/v1/workspaces/${match[1]}/artifacts/${match[2]}` })
          const artifact = got?.body?.artifact
          if (!artifact) throw new Fault(404, 'not_found', 'Artifact not found')
          const prior = await workListing(bs, match[2])
          const kind = ['document', 'website', 'whiteboard', 'media', 'slides', 'dashboard'].includes(artifact.kind) ? artifact.kind : 'document'
          const snapshot = artifact.kind === 'spreadsheet' && artifact.spreadsheet ? workbookText(artifact.spreadsheet) : String(artifact.body || '')
          const data = await bs.put('/v1/ot/listings', {
            kind: 'work', ref: match[2], slug: body?.slug, title: String(artifact.title || body?.slug).slice(0, 80),
            summary:snapshot.slice(0,300),work_kind:kind,snapshot:snapshot.slice(0,200000),
          })
          return [prior ? 200 : 201, { discover: workMeta(data) }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/artifacts\/([0-9a-f]{32})\/discover\/revoke$/,
      async handle({ match }) {
        return wrap(async () => {
          const bs = client(host)
          const row = await workListing(bs, match[2])
          if (row?.listed) await bs.del(`/v1/ot/listings/${seg(row.id, 'listing_id')}`)
          return [200, { discover: { listed: false } }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/discover\/agents\/([a-z0-9][a-z0-9-]{1,28}[a-z0-9])\/start$/,
      async handle({ match }) {
        return wrap(async () => {
          const binding = await host.call('agents/personal-binding', {})
          if (!HEX.test(binding?.workspace_id || '')) throw new Fault(409, 'no_personal_workspace', '请先打开个人工作区。')
          const result = await client(host).post(`/v1/ot/discover/${seg(match[1], 'slug')}/start`)
          return [200, { ...result, workspace_id: binding.workspace_id }]
        })
      },
    },
    ...['GET', 'POST'].map(method => ({
      method, path: /^\/v1\/discover\/agents\/([a-z0-9][a-z0-9-]{1,28}[a-z0-9])\/remix$/,
      async handle({ match, body, idempotency_key }) {
        return wrap(async () => {
          const bs = client(host)
          const row = await bs.get('/v1/ot/discover/' + seg(match[1], 'slug'))
          if (!row.listed || row.kind !== 'agent') throw new Fault(404, 'not_found', '该智能体已下架。')
          const template = remixTemplate(row)
          if (method === 'GET') return [200, { template }]
          if (body?.revision !== template.revision) throw new Fault(409, 'listing_changed', '发布内容已更新，请重新预览。')
          const workspaceId = body?.workspace_id
          if (!HEX.test(String(workspaceId || ''))) throw new Fault(400, 'invalid', '请选择工作区。')
          const binding = await host.call('agents/personal-binding', {})
          if (binding?.workspace_id !== workspaceId) await teamFor(bs, workspaceId, 'Workspace', env)
          try {
            const created = await host.call('agents/create', {
              workspace_id: workspaceId, idempotency_key, name: body?.name ?? template.name,
              summary: template.summary, category: template.category, instructions: template.instructions,
            })
            return [created.status, { agent: { id: created.agent.id, name: created.agent.name, workspace_id: workspaceId } }]
          } catch (error) {
            if (error?.status === 409) throw new Fault(409, 'name_conflict', '工作区已有同名智能体，请换个名称。')
            throw error
          }
        })
      },
    })),
    { method: 'GET', path: /^\/v1\/discover\/agents$/, handle: feed('agent') },
    { method: 'GET', path: /^\/v1\/discover\/works$/, handle: feed('work') },
    { method: 'GET', path: /^\/v1\/discover\/me\/works$/, handle: feed('work') },
    {
      method: 'POST', path: /^\/v1\/discover\/works\/([a-z0-9][a-z0-9-]{1,28}[a-z0-9])\/engagement$/,
      async handle({ match, body }) {
        return wrap(async () => {
          const bs = client(host)
          const listing = await bs.get(`/v1/ot/discover/${seg(match[1], 'slug')}`)
          const action = body?.action
          const on = body?.enabled !== false
          if (action === 'like') await bs.post(`/v1/ot/listings/${seg(listing.id, 'listing_id')}/like`, { on })
          else if (action === 'collect') await bs.post(`/v1/ot/listings/${seg(listing.id, 'listing_id')}/collect`, { on })
          else if (action === 'follow') await bs.post('/v1/ot/follows', { handle: listing.creator?.handle, on })
          else throw new Fault(400, 'invalid', 'Provide like/collect/follow and a boolean enabled')
          const fresh = await bs.get(`/v1/ot/discover/${seg(match[1], 'slug')}`)
          return [200, { likes: fresh.likes ?? 0, collections: fresh.collections ?? 0, liked: !!fresh.liked, collected: !!fresh.collected, following: !!fresh.following }]
        })
      },
    },
    {
      method: 'GET', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/agents\/([0-9a-f]{32})\/discover$/,
      async handle({ match }) {
        return wrap(async () => {
          const bs = client(host)
          const mine = await bs.get('/v1/ot/listings/mine')
          const row = (mine.listings || []).find((l) => l.kind === 'agent' && l.ref === match[2] && l.listed)
          const listing = row ? await bs.get('/v1/ot/discover/' + seg(row.slug, 'slug')) : null
          return [200, { discover: listing?.listed
            ? { listed: true, slug: row.slug, category: row.category, chat_enabled: row.chat_enabled === true, copy_instructions: Boolean(remixInstructions(listing)), updated: unix(row.updated_at) }
            : { listed: false } }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/agents\/([0-9a-f]{32})\/discover$/,
      async handle({ match, body }) {
        return wrap(async () => {
          const bs = client(host)
          const { agent } = await host.call('agents/get', { id: match[2], workspace_id: match[1] })
          if (!agent || agent.archived || agent.native_deleted) throw new Fault(404, 'not_found', '该智能体已归档。')
          if (body?.revision !== undefined && body.revision !== agent.revision) {
            throw new Fault(409, 'agent_changed', '智能体已更新，请刷新后重新预览。')
          }
          const instructions = body?.copy_instructions === true ? agent.instructions : ''
          const snapshot = instructions ? JSON.stringify({ version: 1, instructions }) : undefined
          const data = await bs.put('/v1/ot/listings', {
            kind: 'agent', ref: agent.id, slug: body?.slug, title: agent.name, summary: agent.summary,
            category: agent.category, snapshot, chat_enabled: body?.chat_enabled,
          })
          return [200, { discover: { listed: true, slug: data.slug, category: data.category,
            chat_enabled: data.chat_enabled === true, copy_instructions: Boolean(instructions), updated: unix(data.updated_at) } }]
        })
      },
    },
    {
      method: 'POST', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/agents\/([0-9a-f]{32})\/discover\/revoke$/,
      async handle({ match }) {
        return wrap(async () => {
          const bs = client(host)
          const mine = await bs.get('/v1/ot/listings/mine')
          const row = (mine.listings || []).find((l) => l.kind === 'agent' && l.ref === match[2])
          if (row) await bs.del(`/v1/ot/listings/${seg(row.id, 'listing_id')}`)
          return [200, { discover: { listed: false } }]
        })
      },
    },
  ]
}

export function membersV1(host) { return compatHandler(membersRoutes(host)) }
export function invitesV1(host) { return compatHandler(invitesRoutes(host)) }
export function teamsV1(host) { return compatHandler(teamsRoutes(host)) }
export function messengerV1(host, wakeReplies = () => {}) {
  return compatHandler([...messengerRoutes(host, wakeReplies), ...messengerExtraRoutes(host, wakeReplies)])
}
export function discoverV1(host) { return compatHandler(discoverRoutes(host)) }
