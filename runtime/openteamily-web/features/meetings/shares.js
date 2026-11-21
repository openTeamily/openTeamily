import { idempotencyKey, pagination, refuse, requireBodyKeys } from '../../featurekit/http.js'
import { qs, sharedBotSocial } from '../../lib/c/bot-social.js'

const MEMBER_ID = /^[A-Za-z0-9._-]{1,80}$/

async function social(req, workspace, method, suffix, body) {
  const binding = await req.host.call('agents/personal-binding', {})
  const scope = binding?.workspace_id === workspace ? '/v1/ot' : `/v1/ot/workspaces/${workspace}`
  try {
    return await sharedBotSocial(req.host).request(method, scope + suffix, body)
  } catch (error) {
    const status = error?.status
    if (Number.isInteger(status) && status >= 400 && status < 500) {
      refuse(status, String(error.code || 'invalid').replace(/^social\//, ''), error.message)
    }
    refuse(503, 'unavailable', '暂时无法读取或分享会议纪要，请稍后重试。')
  }
}

async function recipients(req, workspace) {
  if (req.method !== 'GET') refuse(405, 'method', 'Only GET is supported')
  const conversation = req.query.get('conversation_id')
  if (!MEMBER_ID.test(conversation ?? '') || [...req.query.keys()].length !== 1) {
    refuse(400, 'invalid', '请选择会话。')
  }
  return {body:await social(req, workspace, 'GET', '/meeting-share-recipients' + qs({conversation_id:conversation}))}
}

async function shared(req, workspace) {
  if (req.method !== 'GET') refuse(405, 'method', 'Only GET is supported')
  const { limit, cursor } = pagination(req.query, ['sent'])
  const sent = req.query.get('sent') ?? undefined
  if (sent !== undefined && sent !== '1') refuse(400, 'invalid', '无效的分享记录查询。')
  return {body:await social(req, workspace, 'GET', '/meeting-shares' + qs({limit,cursor:cursor || undefined,sent}))}
}

async function receipt(req, workspace, shareId, revoke) {
  if (req.queryString) refuse(400, 'invalid', '无效的纪要分享请求。')
  if (!revoke && req.method === 'GET') {
    const result = await social(req, workspace, 'GET', '/meeting-shares/' + shareId)
    return {body:{...result, ...(req.ownerUsername ? {viewer_username:req.ownerUsername} : {})}}
  }
  if (revoke && req.method === 'POST') {
    requireBodyKeys(await req.json(), [])
    return {body:await social(req, workspace, 'POST', '/meeting-shares/' + shareId + '/revoke', {})}
  }
  refuse(405, 'method', 'Method not supported')
}

async function outgoing(req, workspace, meetingId) {
  if (req.method === 'GET') {
    const {limit,cursor} = pagination(req.query)
    return {body:await social(req, workspace, 'GET', '/meeting-shares' + qs({
      source_id:meetingId,limit,cursor:cursor || undefined,
    }))}
  }
  if (req.method !== 'POST' || req.queryString) refuse(405, 'method', 'Method not supported')
  const snapshot = req.store.get(`SELECT title,started_at,summary,action_items,revision
    FROM meetings WHERE workspace_id=? AND id=?`, workspace, meetingId)
  if (!snapshot) refuse(404, 'not_found', '找不到这份会议纪要。')
  const {revision,conversation_id,recipient_ids} = requireBodyKeys(await req.json(), ['revision','conversation_id','recipient_ids'])
  if (!Number.isSafeInteger(revision) || revision < 1 || typeof conversation_id !== 'string' || !MEMBER_ID.test(conversation_id)
      || !Array.isArray(recipient_ids) || recipient_ids.length < 1 || recipient_ids.length > 50
      || new Set(recipient_ids).size !== recipient_ids.length
      || recipient_ids.some(id => typeof id !== 'string' || !MEMBER_ID.test(id))) {
    refuse(400, 'invalid', '请选择会话、参会人和已保存版本。')
  }
  if (snapshot.revision !== revision) refuse(409, 'conflict', '纪要已更新。请刷新后分享当前保存版本。')
  const action_items = JSON.parse(snapshot.action_items)
  if (!snapshot.summary.trim() && !action_items.length) refuse(400, 'invalid', '请先保存摘要或行动项。')
  const result = await social(req, workspace, 'POST', '/meeting-shares', {
    ...snapshot, action_items, source_id:meetingId, conversation_id, recipient_ids, client_key:idempotencyKey(req.headers),
  })
  return {status:result.replayed ? 200 : 201,body:{meeting:result.meeting}}
}

export const shareRoutes = [
  {pattern:/^\/v1\/workspaces\/([0-9a-f]{32})\/meetings\/share-recipients$/, handle:recipients},
  {pattern:/^\/v1\/workspaces\/([0-9a-f]{32})\/meetings\/shared$/, handle:shared},
  {pattern:/^\/v1\/workspaces\/([0-9a-f]{32})\/meetings\/shared\/([0-9a-f]{32})(?:\/(revoke))?$/, handle:receipt},
  {pattern:/^\/v1\/workspaces\/([0-9a-f]{32})\/meetings\/([0-9a-f]{32})\/shares$/, handle:outgoing},
]
