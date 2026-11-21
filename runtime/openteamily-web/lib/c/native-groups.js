// Bot Social is the one shared conversation store. A native roster room holds a
// stable pointer to it; native and plugin views read/write the SAME messages and
// membership, rather than copying a second chat log. No model call on import.
import { randomUUID } from 'node:crypto'
const installed = new WeakMap()

export function nativeGroupClient(host, raw) {
  async function install() {
    const s = host.currentRuntime?.()
    if (!s?.rt?.state) return null
    const { rt } = s
    if (installed.has(rt)) return installed.get(rt)
    const roomFor = id => rt.roomOf(id)?.openteamily?.conversation_id
    const syncOne = async conversation => {
      if (conversation?.kind !== 'group' || conversation.public_agent) return conversation
      let room = Object.values(rt.state.rooms).find(r => r.openteamily?.conversation_id === conversation.id)
      if (!room) {
        const id = await rt.createSession(conversation.title || 'OpenTeamily group')
        room = { id, name: conversation.title || 'OpenTeamily group', named: true, members: [], mode: 'admin', admin: null, createdAt: Date.now(), createdBy: null,
          origin: 'openteamily', openteamily: { conversation_id: conversation.id, team_id: conversation.team_id } }
        rt.state.rooms[id] = room
      }
      const locals = []
      for (const agent of conversation.agents || []) {
        if (!agent.mine) continue
        const { agent: mapped } = await host.call('agents/byId', { id: agent.agent_ref })
        if (!mapped.native_deleted && mapped.native_bot_id) locals.push(mapped.native_bot_id)
      }
      room.name = conversation.title || 'OpenTeamily group'
      room.members = locals
      room.remoteParticipants = (conversation.members || []).map(m => ({ id: m.owner_id, handle: m.handle, kind: 'human', remote: true, name: m.display_name || m.handle, platform_user_id: m.platform_user_id }))
      room.openteamily.team_id = conversation.team_id
      const announcement = await raw.get('/v1/ot/conversations/'+encodeURIComponent(conversation.id)+'/announcement')
      room.notice = announcement.announcement.body
      await rt.save()
      return { ...conversation, native_room_id: room.id, native_session_id: room.id }
    }
    let queue = Promise.resolve()
    const sync = conversation => { const next = queue.then(() => syncOne(conversation)); queue = next.catch(() => {}); return next }
    const originalMobile = rt.mobileEndpoint.bind(rt)
    rt.mobileEndpoint = async (endpoint, p) => {
      const cid = endpoint === 'room-chat' && roomFor(p?.roomId)
      if (!cid) return originalMobile(endpoint, p)
      await sync(await raw.get('/v1/ot/conversations/' + encodeURIComponent(cid)))
      const before = p?.cursor?.beforeSeq
      const data = await raw.get('/v1/ot/conversations/' + encodeURIComponent(cid) + '/messages?limit=100' + (Number.isInteger(before) ? '&before=' + before : ''))
      const activity = await host.call('agents/groupActivity', { conversation_id: cid })
      return { roomId: p.roomId, items: (data.messages || []).map(m => ({
        id: m.id, kind: m.mine === true ? 'user' : 'bot',
        name: m.author?.name || m.author?.display_name || m.author?.handle || '',
        text: m.retracted ? '' : m.body, time: m.created_at, source_message_id: m.id, revision: m.revision,
      })), cursor: data.messages?.[0]?.seq > 1 ? { beforeSeq: data.messages[0].seq } : null, running: activity.running, speaking: activity.speaking }
    }
    const originalSend = rt.sendUser.bind(rt)
    rt.sendUser = async p => {
      const cid = roomFor(p?.sessionId)
      if (!cid) return originalSend(p)
      if (!Array.isArray(p.content) || p.content.some(c => c.type !== 'text')) throw new Error('Shared groups currently accept text only')
      const result = await raw.post('/v1/ot/conversations/' + encodeURIComponent(cid) + '/messages', { body: p.content.map(c => c.text).join('\n'), client_key: String(p.requestId || randomUUID()).slice(0,80) })
      await sync(await raw.get('/v1/ot/conversations/' + encodeURIComponent(cid)))
      return result
    }
    const originalUpdate = rt.updateRoom.bind(rt)
    rt.updateRoom = async (id, patch, ...rest) => {
      const cid = roomFor(id)
      if (!cid) return originalUpdate(id, patch, ...rest)
      patch = Object.fromEntries(Object.entries(patch).filter(([,v]) => v !== undefined))
      if (patch.members) {
        const previous = rt.roomOf(id).members || []
        patch.add = patch.members.filter(bid => !previous.includes(bid))
        patch.remove = previous.filter(bid => !patch.members.includes(bid))
        delete patch.members
      }
      const allowed = new Set(['name','add','remove','notice','remoteParticipants'])
      if (Object.keys(patch).some(k => !allowed.has(k))) throw new Error('Change shared group settings in OpenTeamily; unsupported native changes are not applied locally')
      const base = '/v1/ot/conversations/' + encodeURIComponent(cid)
      if (patch.remoteParticipants !== undefined) {
        if (!Array.isArray(patch.remoteParticipants) || patch.remoteParticipants.length > 200 || patch.remoteParticipants.some(h => typeof h !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(h))) throw new Error('Provide member handles, not native Bot IDs')
        const current = await raw.get(base), me = await raw.get('/v1/ot/me')
        const wanted = [...new Set(patch.remoteParticipants)]
        if (!wanted.includes(me.handle)) throw new Error('Use Leave group to remove yourself')
        const previous = (current.members || []).map(m=>m.handle)
        for (const handle of wanted.filter(h=>!previous.includes(h))) await raw.post(base+'/members', {handle})
        for (const handle of previous.filter(h=>!wanted.includes(h))) await raw.del(base+'/members/'+encodeURIComponent(handle))
      }
      if (patch.name !== undefined) await raw.patch(base, { title: patch.name })
      for (const bid of patch.add || []) {
        const bot = rt.botOf(bid)
        if (!bot?.openteamily?.agent_id) throw new Error('Assign this native Bot to a workspace before adding it to a shared group')
        await raw.put(base + '/agents/' + encodeURIComponent(bot.openteamily.agent_id), { name: bot.name, auto_reply: false })
      }
      for (const bid of patch.remove || []) {
        const bot = rt.botOf(bid)
        if (bot?.openteamily?.agent_id) await raw.del(base + '/agents/' + encodeURIComponent(bot.openteamily.agent_id))
      }
      if (patch.notice !== undefined) {
        const current = await raw.get(base + '/announcement')
        await raw.post(base + '/announcement', { body: patch.notice, revision: current.announcement.revision })
      }
      const result = await sync(await raw.get(base))
      return { room: rt.roomOf(result.native_room_id), changes: [] }
    }
    const originalDelete = rt.deleteRoom.bind(rt)
    rt.deleteRoom = async id => {
      const cid = roomFor(id)
      if (cid) { const me = await raw.get('/v1/ot/me'); await raw.del('/v1/ot/conversations/' + encodeURIComponent(cid) + '/members/' + encodeURIComponent(me.handle)) }
      return originalDelete(id)
    }
    const api = { sync }
    installed.set(rt, api)
    return api
  }
  void install().catch(error => host.log?.('Native shared-group hooks unavailable: ' + String(error.code || 'error')))
  const request = async (method, path, body, options) => {
    const result = await raw.request(method, path, body, options)
    if (!path.startsWith('/v1/ot/conversations')) return result
    const api = await install()
    if (!api) return result
    if (Array.isArray(result?.conversations)) return { ...result, conversations: await Promise.all(result.conversations.map(api.sync)) }
    if (result?.kind === 'group' && result.id) return api.sync(result)
    return result
  }
  return { ...raw, request, get: (path,options) => request('GET',path,undefined,options), post: (path,b={}) => request('POST',path,b), put: (path,b={}) => request('PUT',path,b), patch: (path,b={}) => request('PATCH',path,b), del: path => request('DELETE',path) }
}
