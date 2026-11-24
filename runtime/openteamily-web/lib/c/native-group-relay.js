import { createHash } from 'node:crypto'

const ROOM_ID = /^otc_[0-9A-HJKMNP-TV-Z]{26}$/
const MESSAGE_ID = /^otm_[0-9A-HJKMNP-TV-Z]{26}$/
const POLL_INTERVAL = 1500
const MAX_HISTORY = 40
const MAX_LINE = 4000
const revoked = new Set(['social/native_round_not_found', 'social/native_round_unavailable', 'social/conversation_not_found', 'social/agent_not_found'])
const messageRoute = /^\/v1\/ot\/conversations\/(otc_[0-9A-HJKMNP-TV-Z]{26})\/messages$/

function localRoom(rt, conversation, room) {
  const management = conversation?.group_management
  const candidates = conversation?.agents
  if (!room || !management || room.openteamily?.conversation_id !== conversation.id ||
      conversation.kind !== 'group' || conversation.account_group !== true || conversation.team_id ||
      conversation.public_agent || conversation.group_agent_routing?.can_edit !== true ||
      conversation.members?.length !== 1 || conversation.members[0].owner_id !== management.owner_id ||
      conversation.group_agent_routing?.policy?.mode === 'mentions' ||
      (!candidates || candidates.length < 2 || candidates.length > 12 || candidates.length !== room.members.length) ||
      !candidates.every(agent => agent.mine && agent.owner?.owner_id === management.owner_id)) return false
  const refs = new Set(room.members.map(id => rt.botOf(id)?.openteamily?.agent_id))
  return candidates.every(agent => refs.has(agent.agent_ref))
}

function eligibleMessage(method, path, body) {
  if (method !== 'POST' || !body || typeof body.body !== 'string' || !body.body.trim() || !body.client_key) return undefined
  const room = messageRoute.exec(path)?.[1]
  const permitted = ['body', 'mentions', 'agent_mentions', 'client_key', 'workspace', 'direct', 'group_agent_request']
  return room && Object.entries(body).every(([key, value]) => value == null || permitted.includes(key)) ? room : undefined
}

function exchangePath(room, message) {
  return `/v1/ot/conversations/${room.openteamily.conversation_id}/native-rounds/${message}`
}

export function nativeGroupRelay({ rt, raw, sync, log }) {
  if (typeof rt.beginSharedRoomRound !== 'function' || typeof rt.sharedRoomCursor !== 'function' ||
      typeof rt.workingInRoom !== 'function' || typeof rt.groupLinesAfter !== 'function') return null
  const activeLaunches = new Set()
  let running = false
  let requested = false
  let inboxPending = true
  let timer

  const findRoom = conversationId => Object.values(rt.state.rooms).find(room => room.openteamily?.conversation_id === conversationId)
  const agentByRef = room => new Map(room.members.map(id => [rt.botOf(id)?.openteamily?.agent_id, id]))
  const save = () => rt.save({required:true})
  const historyOf = room => room.openteamily.native_history ??= {through:0, cursor:0, mirrored:[]}
  const busy = room => activeLaunches.has(room.id) || rt.roomActive(room.id) || rt.workingInRoom(room).length > 0 || rt.roomBatchPending?.(room.id) === true

  async function send(post, method, path, body) {
    const id = eligibleMessage(method, path, body)
    if (!id || !findRoom(id) || rt.readOnly?.() !== undefined) return post(body)
    const conversation = await sync(await raw.get('/v1/ot/conversations/' + id))
    if (!localRoom(rt, conversation, findRoom(id))) return post(body)
    try {
      const result = await post({...body, native_round:true})
      wake()
      return result
    } catch (error) {
      // A roster can change between reading the group and committing a send.
      if (!['social/native_round_unavailable', 'social/native_round_conflict'].includes(error?.code)) throw error
      return post(body)
    }
  }

  async function seedHistory(room, item, bots) {
    const history = historyOf(room)
    if (history.through >= item.seq - 1) return
    const route = `/v1/ot/conversations/${item.conversation_id}/messages?limit=${MAX_HISTORY}&before=${item.seq}`
    const page = await raw.get(route)
    if (!Array.isArray(page?.messages)) throw new Error('Invalid shared group history')
    const kept = new Set(history.mirrored)
    for (const line of await rt.groupLinesAfter(room.id, history.cursor)) kept.add(line.openteamilyMessageId)
    for (const message of [...page.messages].sort((a,b) => a.seq - b.seq)) {
      if (message.seq <= history.through || kept.has(message.id) || message.retracted || !message.body ||
          !MESSAGE_ID.test(message.id) || message.seq >= item.seq) continue
      const botId = message.author?.kind === 'agent' ? bots.get(message.author.agent_ref) : undefined
      rt.logRoom(room, {
        who: botId ? rt.botOf(botId).name : (message.author?.name || message.author?.display_name || 'Member'),
        ...(botId ? {botId} : {}),
        text:message.body.slice(0, MAX_LINE).toWellFormed(),
        openteamilyMessageId:message.id,
        ...(Number.isFinite(message.created_at) ? {time:message.created_at} : {}),
      })
    }
    history.through = item.seq - 1
    history.cursor = rt.sharedRoomCursor(room.id)
    await save()
  }

  async function mirror(room, exchange) {
    const lines = await rt.groupLinesAfter(room.id, exchange.cursor)
    for (const line of lines) {
      if (line.kind === undefined && line.botId && room.members.includes(line.botId) && line.text?.trim()) {
        const ref = rt.botOf(line.botId)?.openteamily?.agent_id
        if (ref) {
          const key = createHash('sha256').update(JSON.stringify([room.id, line.seq])).digest('hex')
          const posted = await raw.post(exchangePath(room, exchange.id) + '/lines', {
            agent_ref:ref, body:line.text.trim().slice(0, MAX_LINE).toWellFormed(), client_key:'native:' + key,
          })
          const {mirrored} = historyOf(room)
          if (MESSAGE_ID.test(posted?.id || '') && !mirrored.includes(posted.id)) {
            mirrored.push(posted.id)
            if (mirrored.length > MAX_HISTORY) mirrored.shift()
          }
        }
      }
      exchange.cursor = Math.max(exchange.cursor, line.seq)
    }
    if (lines.length) await save()
  }

  async function clear(room, exchange) {
    if (room.openteamily.native_exchange !== exchange) return
    delete room.openteamily.native_exchange
    await save()
  }

  async function abandon(room, exchange, finish) {
    if (busy(room)) {
      await rt.stopRoomWork(room.id)
      if (busy(room)) return
    }
    if (finish) {
      try { await raw.post(exchangePath(room, exchange.id), {action:'finish'}) }
      catch (error) { if (!revoked.has(error?.code)) throw error }
    }
    await clear(room, exchange)
  }

  async function launch(room, item, bots) {
    const prior = room.openteamily.native_exchange
    if (prior?.dispatched) return
    const path = exchangePath(room, item.message_id)
    // A running item without this host's pre-claim marker may already have
    // performed tools. Finish it without risking a duplicate execution.
    if (item.state === 'running' && !prior) {
      await raw.post(path, {action:'finish'})
      return
    }
    const selected = Array.isArray(item.agent_mentions) ? item.agent_mentions.map(target => bots.get(target.agent_id)).filter(Boolean) : []
    await seedHistory(room, item, bots)
    const exchange = prior ?? {id:item.message_id, cursor:rt.sharedRoomCursor(room.id), dispatched:false}
    room.openteamily.native_exchange = exchange
    await save()
    if (item.state === 'queued') {
      const result = await raw.post(path, {action:'start'})
      if (result?.started !== true) {
        await clear(room, exchange)
        return
      }
    }
    // Commit before calling tools. A restart after this point can flush
    // durable native lines, but cannot start the same round a second time.
    exchange.dispatched = true
    await save()
    const conversation = await sync(await raw.get('/v1/ot/conversations/' + item.conversation_id))
    if (rt.state.rooms[room.id] !== room || !localRoom(rt, conversation, room)) {
      await abandon(room, exchange, true)
      return
    }
    activeLaunches.add(room.id)
    try {
      if (!item.agent_mentions?.length || selected.some(id => room.members.includes(id))) {
        await rt.beginSharedRoomRound(room.id, {text:item.body, sourceId:item.message_id, mentions:selected.length ? selected : undefined})
      }
    } finally {
      activeLaunches.delete(room.id)
      wake()
    }
  }

  async function tick() {
    if (running) { requested = true; return }
    if (rt.readOnly?.() !== undefined) return
    running = true
    try {
      const inbox = await raw.get('/v1/ot/native-group-inbox')
      if (!Array.isArray(inbox?.items)) return
      const items = inbox.items
      inboxPending = items.length > 0
      const byId = new Map(items.map(item => [item.message_id, item]))
      for (const room of Object.values(rt.state.rooms)) {
        const exchange = room.openteamily?.native_exchange
        if (!exchange || !MESSAGE_ID.test(exchange.id)) continue
        const item = byId.get(exchange.id)
        if (!item) {
          // Only running items are guaranteed to be included without a page
          // limit. A pre-claim marker can still be waiting for its queued item.
          if (exchange.dispatched) await abandon(room, exchange, true)
          else await clear(room, exchange)
          continue
        }
        if (!exchange.dispatched) continue
        try {
          await mirror(room, exchange)
          if (!busy(room)) {
            await raw.post(exchangePath(room, exchange.id), {action:'finish'})
            byId.delete(exchange.id)
            await clear(room, exchange)
          }
        } catch (error) {
          if (!revoked.has(error?.code)) { report(error); continue }
          byId.delete(exchange.id)
          await abandon(room, exchange, true)
        }
      }
      for (const item of items) {
        if (!byId.has(item.message_id) || !ROOM_ID.test(item.conversation_id) ||
            !MESSAGE_ID.test(item.message_id) || !Number.isSafeInteger(item.seq) ||
            !['queued', 'running'].includes(item.state) || typeof item.body !== 'string' || !item.body.trim()) continue
        let room = findRoom(item.conversation_id)
        if (room && (busy(room) || (room.openteamily.native_exchange && room.openteamily.native_exchange.id !== item.message_id))) continue
        try {
          const conversation = await sync(await raw.get('/v1/ot/conversations/' + item.conversation_id))
          room = findRoom(item.conversation_id)
          if (!localRoom(rt, conversation, room)) {
            if (room) await raw.post(exchangePath(room, item.message_id), {action:'finish'})
            continue
          }
          await launch(room, item, agentByRef(room))
        } catch (error) {
          const exchange = room?.openteamily.native_exchange
          if (revoked.has(error?.code) && exchange?.id === item.message_id) await abandon(room, exchange, true)
          else if (!revoked.has(error?.code) && error?.code !== 'social/native_round_busy') report(error)
        }
      }
    } catch (error) {
      report(error)
    } finally {
      running = false
      if (requested) {
        requested = false
        wake()
      }
    }
  }

  function report(error) {
    if (!['social/not-connected', 'social/not-configured', 'social/unreachable', 'social/unauthorized','social/http_404'].includes(error?.code)) {
      log('Native shared group relay will retry: ' + String(error?.code ?? 'error'))
    }
  }

  const wake = () => {
    inboxPending = true
    if (running) requested = true
    else if (timer === undefined) {
      timer = setTimeout(() => { timer = undefined; void tick() }, 0)
      timer.unref?.()
    }
  }
  const removeListener = rt.onRoomLine?.(room => {
    if (room.openteamily?.native_exchange?.dispatched) wake()
  })
  const interval = setInterval(() => {
    if (inboxPending || Object.values(rt.state.rooms).some(room => room.openteamily?.native_exchange)) wake()
  }, POLL_INTERVAL)
  interval.unref?.()
  rt.ctx?.on?.('dispose', () => {
    clearInterval(interval)
    clearTimeout(timer)
    removeListener?.()
  })
  wake()
  return {send}
}
