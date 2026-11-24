import assert from 'node:assert/strict'
import {setTimeout as delay} from 'node:timers/promises'
import {test} from 'node:test'
import {nativeGroupRelay} from '../lib/c/native-group-relay.js'

const cid = 'otc_' + '1'.repeat(26)
const mid = 'otm_' + '2'.repeat(26)
const old = 'otm_' + '3'.repeat(26)
const legacy = 'otm_' + '4'.repeat(26)
const mirrored = 'otm_' + '5'.repeat(26)
const conversationPath = '/v1/ot/conversations/' + cid
const messagesPath = conversationPath + '/messages'
const roundPath = conversationPath + '/native-rounds/' + mid
const owner = 'owner'
const seats = [
  {mine:true, agent_ref:'writer', owner:{owner_id:owner}},
  {mine:true, agent_ref:'reviewer', owner:{owner_id:owner}},
]

async function eventually(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return
    await delay(10)
  }
  assert.ok(check(), 'Expected relay state was not reached')
}

function fixture(t, {exchange, initialState, roster = seats, mode = 'default', people = [{owner_id:owner}], lines = [],
  history, seq = 2, page = [{id:old,seq:1,body:'此前的讨论',created_at:1_700_000_000_000,author:{kind:'member',name:'Member'}}],
} = {}) {
  let lineListener
  let dispose
  let busy = false
  let state = initialState
  const received = []
  const writes = []
  const opened = []
  const logged = [...lines]
  const members = ['writer', 'reviewer']
  const room = {id:'native-room', members, openteamily:{conversation_id:cid,
    ...(exchange ? {native_exchange:exchange} : {}),
    ...(history ? {native_history:history} : {}),
  }}
  const conversation = {id:cid,kind:'group',account_group:true,agents:roster,members:people,
    group_management:{owner_id:owner},group_agent_routing:{can_edit:true,policy:{mode}},
  }
  const item = {message_id:mid,conversation_id:cid,seq,body:'评审文档',agent_mentions:[{owner_id:owner,agent_id:'writer'}]}
  function addLine(line) {
    logged.push({...line,seq:(logged.at(-1)?.seq ?? 0) + 1})
    lineListener?.(room)
  }
  const rt = {
    state:{rooms:{[room.id]:room}},
    ctx:{on:(_event, cb) => {dispose = cb}},
    botOf:id => ({name:id,openteamily:{agent_id:id}}),
    sharedRoomCursor:() => logged.at(-1)?.seq ?? 0,
    workingInRoom:() => [],
    roomActive:() => busy,
    groupLinesAfter:async (_id, cursor) => logged.filter(line => line.seq > cursor),
    save:async options => {assert.deepEqual(options,{required:true})},
    logRoom:(_room, line) => addLine(line),
    onRoomLine:listener => {lineListener = listener},
    beginSharedRoomRound:async (roomId, input) => {
      busy = true
      opened.push({roomId,input})
      addLine({who:'User', text:input.text, openteamilyMessageId:input.sourceId})
    },
  }
  const raw = {
    get:async path => {
      if (path === '/v1/ot/native-group-inbox') return {items:state && state !== 'finished' ? [{...item,state}] : []}
      if (path === conversationPath) return conversation
      assert.equal(path, messagesPath + '?limit=40&before=' + seq)
      return {messages:page}
    },
    post:async (path, body) => {
      if (path === messagesPath) {
        received.push(body)
        if (body.native_round) state = 'queued'
        return {id:mid}
      }
      writes.push({path,body})
      if (path === roundPath + '/lines') return {id:mirrored}
      assert.equal(path, roundPath)
      if (body.action === 'start') {
        assert.equal(state, 'queued')
        state = 'running'
        return {started:true,state}
      }
      assert.equal(body.action, 'finish')
      state = 'finished'
      return {state}
    },
  }
  const relay = nativeGroupRelay({rt,raw,sync:async item => item,log:message => assert.fail(message)})
  t.after(() => dispose())
  const send = body => relay.send(data => raw.post(messagesPath,data), 'POST', messagesPath, {client_key:'abcdef', body:item.body, ...body})
  return {room,addLine, received, writes, opened, logged, send, setBusy:value => {busy = value}, state:() => state}
}

test('a plain shared group send starts the corresponding native room, then mirrors each Bot line once', async t => {
  const h = fixture(t)
  await h.send({group_agent_request:true, agent_mentions:[{owner_id:owner,agent_id:'writer'}]})
  await eventually(() => h.opened.length === 1)
  assert.equal(h.received[0].native_round, true)
  assert.deepEqual(h.opened, [{roomId:h.room.id,input:{text:'评审文档',sourceId:mid,mentions:['writer']}}])
  assert.deepEqual(h.logged.map(line => line.openteamilyMessageId), [old, mid])
  assert.equal(h.logged[0].time, 1_700_000_000_000)
  h.addLine({botId:'writer',kind:'working',text:'working'})
  h.addLine({botId:'writer',text:'@reviewer 请评审'})
  h.addLine({botId:'reviewer',text:'审完了'})
  h.setBusy(false)
  await eventually(() => h.state() === 'finished' && !h.room.openteamily.native_exchange)
  const published = h.writes.filter(item => item.path.endsWith('/lines')).map(item => item.body)
  assert.deepEqual(published.map(line => [line.agent_ref,line.body]), [['writer','@reviewer 请评审'], ['reviewer','审完了']])
  assert.equal(new Set(published.map(line => line.client_key)).size, 2)
  assert.deepEqual(h.room.openteamily.native_history.mirrored, [mirrored])
  assert.deepEqual(h.writes.map(item => item.body.action ?? 'line'), ['start','line','line','finish'])
})

test('restart publishes durable lines without opening a second round', async t => {
  const h = fixture(t,{initialState:'running',exchange:{id:mid,cursor:1,dispatched:true},
    lines:[{seq:2,botId:'reviewer',text:'recovered result'}]})
  await eventually(() => h.state() === 'finished')
  assert.equal(h.opened.length, 0)
  assert.deepEqual(h.writes.map(item => item.body.action ?? item.body.body), ['recovered result','finish'])
})

test('an unknown running round is finalized without rerunning tools', async t => {
  const h = fixture(t,{initialState:'running'})
  await eventually(() => h.state() === 'finished')
  assert.equal(h.opened.length, 0)
  assert.deepEqual(h.writes.map(item => item.body.action), ['finish'])
})

test('mixed owners, a missing native participant, mention-only policy and files use normal sends', async t => {
  const [multi, missing, mentionsOnly, file] = [
    fixture(t,{people:[{owner_id:owner},{owner_id:'other'}]}), fixture(t,{roster:seats.slice(0,1)}),
    fixture(t,{mode:'mentions'}), fixture(t),
  ]
  for (const h of [multi,missing,mentionsOnly]) await h.send()
  await file.send({attachment:{title:'file'}})
  for (const h of [multi,missing,mentionsOnly,file]) assert.equal(h.received[0].native_round, undefined)
})


test('later native rounds import missed shared lines without repeating native text', async t => {
  const h = fixture(t,{seq:5,initialState:'queued',history:{through:1,cursor:1,mirrored:[mirrored]},
    lines:[{seq:1,who:'Member',text:'old',openteamilyMessageId:old},
      {seq:2,who:'User',text:'already ran',openteamilyMessageId:'otm_'+'6'.repeat(26)},
      {seq:3,botId:'writer',text:'already mirrored'}],
    page:[{seq:1,id:old,body:'old'},
      {seq:2,id:'otm_'+'6'.repeat(26),body:'already ran'},
      {seq:3,id:mirrored,body:'already mirrored',author:{kind:'agent',agent_ref:'writer'}},
      {seq:4,id:legacy,body:'message posted between native rounds'}],
  })
  await eventually(() => h.opened.length === 1)
  assert.deepEqual(h.logged.map(line => line.text), ['old','already ran','already mirrored','message posted between native rounds','评审文档'])
  assert.deepEqual(h.room.openteamily.native_history,{through:4,cursor:4,mirrored:[mirrored]})
})
