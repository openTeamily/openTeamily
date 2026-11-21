import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { createAgents } from '../features/agents/index.js'
import { createLegacyDispatch } from '../src/dispatch.js'

const workspace = 'a'.repeat(32)
const root = `/v1/workspaces/${workspace}/agents`
const createRuntime = () => {
  const bots = {main:{id:'main',name:'Main',capabilities:[]}}
  const events = new Map()
  const stored = new Map()
  let count = 0
  const rt = {
    state:{bots}, botOf:id => bots[id], chatOwners:new Map(), save:async () => {},
    createBot:async ({name,instructions}) => (bots.agent = {id:'agent',name,instructions,capabilities:[]}),
    createSession:async () => 'native-session',
    workDirOf:() => '/fixture',
    resolveAgent:async sid => ({session:{id:sid}}),
    async* eventsBackwards(sid) { yield* events.get(sid) || [] },
  }
  return {
    rt, ctx:{sessions:{flush:async () => {}}},
    mainBot:async () => 'main',
    chatTurn:async () => {},
    readNativeAttachment:async ({ref}) => stored.get(ref.id),
    async nativeTurn(bot,sid,prompt,key,{files,onStaged}) {
      const file = files[0]
      assert.equal(bot,'agent')
      assert.equal(sid,'native-session')
      assert.match(prompt,/only from the file/)
      assert.equal(file.data.toString(),'only from the file')
      count++
      stored.set('file',file.data)
      onStaged([{title:file.title,mime:file.mime,bytes:file.data.length,ref:{id:'file'}}])
      events.set(sid,[
        {type:'user/message',seq:1,time:1000,data:{content:[{type:'text',text:prompt},{type:'file'}],source:{rpcId:key}}},
        {type:'assistant/message',seq:2,time:1001,data:{message:{content:[{type:'text',text:'Read attached file'}]}}},
      ])
      return {text:'Read attached file',sessionId:sid,turnId:1}
    },
    get count() { return count },
  }
}

test('private agent files survive reconnect, with one native turn and workspace-scoped downloads', async () => {
  const db = new DatabaseSync(':memory:')
  const runtime = createRuntime()
  const host = {runtime:async () => runtime, call:async (name) => assert.equal(name,'skills/materialForScope')}
  const {endpoints:e} = createAgents({db,host})
  const {agent} = await e.create({workspace_id:workspace,name:'Reader',idempotency_key:'a'.repeat(20)})
  const {conversation} = await e['conversation-create']({workspace_id:workspace,id:agent.id})
  const convo = `${root}/${agent.id}/conversations/${conversation.id}`
  const dispatch = createLegacyDispatch({endpoints:{'agents/v1':e.v1}})
  const request = (path, options) => {
    const url = new URL('http://dsbot/api/openteamily/legacy')
    url.searchParams.set('feature','agents')
    url.searchParams.set('path',path)
    return dispatch(new Request(url,options))
  }
  const send = (body = 'Read the attached file') => {
    const form = new FormData()
    form.set('body',body)
    form.append('file',new Blob(['only from the file'],{type:'text/plain'}),'笔记.txt')
    return request(convo+'/messages',{method:'POST',headers:{'Idempotency-Key':'file-send-key-12345'},body:form})
  }
  const [first,retry] = await Promise.all([send(),send()])
  assert.equal(first.status,201)
  assert.equal(retry.status,201)
  const data = await first.json()
  assert.equal(data.reply.body,'Read attached file')
  assert.equal((await retry.json()).message.id,data.message.id)
  assert.equal((await send('Edited after uploading')).status,409)
  assert.equal(runtime.count,1)
  const reopened = await (await request(convo)).json()
  assert.equal(reopened.items.length,2)
  const [attachment] = reopened.items[0].attachments
  assert.equal(attachment.title,'笔记.txt')
  assert.equal(attachment.bytes,18)
  assert.equal(attachment.ref,undefined)
  const file = await request(attachment.path)
  assert.equal(file.status,200)
  assert.match(file.headers.get('content-disposition'),/^attachment;/)
  assert.equal(await file.text(),'only from the file')
  assert.equal((await request(attachment.path.replace(workspace,'b'.repeat(32)))).status,404)
  db.close()
})
