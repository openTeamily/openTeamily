import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { boot, deliverBundle, key, legacyBundles, volume, WS } from './helpers.js'
import { attachRuntime, detachRuntime } from '../src/host.js'
import { setSharedBotSocial } from '../lib/c/bot-social.js'
import {waveBase64} from '../../../openteamily/static/meetings/audio.mjs'

const base = (id = '', ws = WS) => `/v1/workspaces/${ws}/meetings${id ? '/' + id : ''}`
const body = { title: '周会', attendees: ['alice', 'bob'], summary: '同步进度。', transcript: '讨论排期。', action_items: [{ text: '订会议室', owner: 'bob' }] }

test('meetings feature loads in this DS-Bot and keeps its data in its own feature directory', async () => {
  const bot = await boot()
  assert.ok(bot.features.loaded.includes('meetings'), JSON.stringify(bot.features.failed))
  assert.ok(existsSync(join(bot.vol.data, 'openteamily', 'features', 'meetings', 'meetings.sqlite3')))
  const routes = await bot.endpoint('meetings/routes')
  assert.equal(routes.ok, true)
  assert.ok(routes.value.routes.every((source) => source.startsWith('^\\/v1\\/workspaces')))
})

test('meetings run inside this DS-Bot: create, idempotent replay, list, read, update, export, remove', async () => {
  const bot = await boot()
  const call = (...args) => bot.call('meetings', ...args)
  const k = key()
  const created = await call('POST', base(), body, k)
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const meeting = created.body.meeting
  assert.equal(meeting.action_count, 1)
  assert.equal(meeting.done_count, 0)
  assert.equal((await call('POST', base(), body, k)).status, 200)
  assert.equal((await call('POST', base(), { ...body, title: '另一个' }, k)).status, 409)
  assert.equal((await call('POST', base(), body, key())).status, 409, 'duplicate title')
  assert.equal((await call('POST', base(), body)).status, 400, 'idempotency key required')
  assert.equal((await call('POST', base(), { ...body, title: '' }, key())).status, 400)

  const listed = await call('GET', base() + '?limit=20')
  assert.equal(listed.status, 200)
  assert.equal(listed.body.items.length, 1)
  assert.equal(listed.body.items[0].transcript, undefined)
  assert.equal((await call('GET', base() + '?bogus=1')).status, 400)
  assert.equal((await call('GET', base(meeting.id))).body.meeting.transcript, '讨论排期。')

  const stale = await call('POST', base(meeting.id), { revision: 9, changes: { summary: 'x' } })
  assert.equal(stale.status, 409)
  assert.equal(stale.body.error.current.revision, 1)
  const updated = await call('POST', base(meeting.id), { revision: 1, changes: { action_items: [{ text: '订会议室', owner: 'bob', done: true }] } })
  assert.equal(updated.status, 200)
  assert.equal(updated.body.meeting.revision, 2)
  assert.equal(updated.body.meeting.done_count, 1)

  const exported = await call('GET', base(meeting.id) + '/export')
  assert.equal(exported.status, 200)
  assert.match(exported.download.content_type, /text\/markdown/)
  assert.equal(exported.download.filename, `meeting-${meeting.id}.md`)
  assert.match(exported.text, /^# 周会/)
  assert.match(exported.text, /- \[x\] 订会议室（bob）/)

  assert.equal((await call('POST', base(meeting.id) + '/remove', {})).status, 200)
  assert.equal((await call('GET', base(meeting.id))).status, 404)
})

test('meeting shares publish only the saved summary and action items through the selected workspace', async t => {
  const bot = await boot()
  const call = (method, path, payload, sendKey) => bot.call('meetings',method,base(path),payload,sendKey)
  const created = await call('POST','',body,key())
  const meeting = created.body.meeting
  const receiptId = 'd'.repeat(32)
  const receipt = {id:receiptId,title:meeting.title,revision:1,started_at:meeting.started_at,
    organizer:'组织者',summary:body.summary,action_items:[{...body.action_items[0],done:false}],shared:true}
  const calls = []
  let sent = false
  setSharedBotSocial({async request(method,path,input) {
    calls.push({method,path,input})
    if (path.includes('/meeting-share-recipients')) return {items:[{id:'recipient-a',name:'参会人'}]}
    if (path.endsWith('/revoke')) return {revoked:true}
    if (method === 'POST') {
      const replayed = sent
      sent = true
      return {meeting:receipt,replayed}
    }
    if (path.endsWith(receiptId)) return {meeting:receipt}
    return {items:[receipt],cursor:null}
  }})
  t.after(() => setSharedBotSocial(undefined))
  const path = `${meeting.id}/shares`
  const recipients = {revision:1,conversation_id:'otc_group',recipient_ids:['recipient-a']}
  const shareKey = key()
  assert.equal((await call('POST',path,{...recipients,transcript:'never send this'},shareKey)).status,400)
  assert.equal((await call('POST',path,{...recipients,revision:2},shareKey)).status,409)
  assert.equal((await bot.call('meetings','POST',base(path,'b'.repeat(32)),recipients,shareKey)).status,404)
  assert.equal(calls.length,0)
  assert.deepEqual((await call('GET','share-recipients?conversation_id=otc_group')).body.items,[{id:'recipient-a',name:'参会人'}])
  assert.equal(calls.at(-1).path,`/v1/ot/workspaces/${WS}/meeting-share-recipients?conversation_id=otc_group`)
  assert.equal((await call('POST',path,recipients,shareKey)).status,201)
  assert.deepEqual(calls.at(-1),{method:'POST',path:`/v1/ot/workspaces/${WS}/meeting-shares`,input:{
    title:body.title,started_at:meeting.started_at,summary:body.summary,action_items:receipt.action_items,
    source_id:meeting.id,client_key:shareKey,...recipients,
  }})
  assert.equal((await call('POST',path,recipients,shareKey)).status,200)
  assert.equal((await call('GET',path)).body.items[0].id,receiptId)
  assert.match(calls.at(-1).path,new RegExp('source_id='+meeting.id))
  assert.equal((await call('GET','shared?limit=100')).body.items[0].id,receiptId)
  assert.equal((await call('GET',`shared/${receiptId}`)).body.meeting.summary,body.summary)
  assert.equal((await call('POST',`${meeting.id}/remove`,{})).status,200)
  assert.equal((await call('GET','shared?sent=1')).body.items[0].id,receiptId)
  assert.equal(calls.at(-1).path,`/v1/ot/workspaces/${WS}/meeting-shares?limit=20&sent=1`)
  assert.deepEqual((await call('POST',`shared/${receiptId}/revoke`,{})).body,{revoked:true})
  assert.equal((await call('GET','shared?source_id='+meeting.id)).status,400)
})

test('meeting speech prepares and uses the local provider in the signed-in runtime', async (t) => {
  const bot = await boot()
  const call = (method, path, body) => bot.call('meetings', method, base(path), body)
  assert.equal((await call('GET', 'speech')).body.phase, 'unavailable')
  let phase = 'unprepared'
  let location = 'host-local'
  let accepted = false
  let calls = 0
  const providerId = 'sensevoice-local'
  const speech = {
    snapshot: () => ({selection: {providerId}, providers: [{id: providerId, location, preparation: {phase}}]}),
    prepare(id) { assert.equal(id, providerId); accepted = true },
    resolve(spec) { return spec },
    async transcribe(spec, signal) {
      calls += 1
      assert.equal(spec.providerId, providerId)
      assert.equal(spec.audio.readUInt32LE(24), 16000)
      assert.equal(spec.audio.readInt16LE(44), -32768)
      assert.equal(signal.aborted, false)
      return {text: ' 周四发布 ' }
    },
  }
  attachRuntime({rt: {}, ctx: {get: name => name === 'speechToText' ? speech : undefined}})
  t.after(detachRuntime)
  const body = {audio_base64: waveBase64(new Float32Array([-1, 0, 1]))}
  assert.equal((await call('POST', 'transcribe', body)).status, 409)
  assert.deepEqual((await call('POST', 'speech', {})).body, {phase: 'checking', ready: false, progress: null})
  assert.equal(accepted, true)
  phase = 'ready'
  assert.equal((await call('GET', 'speech')).body.ready, true)
  assert.equal((await call('POST', 'transcribe', {audio_base64: 'AAAA'})).status, 400)
  assert.equal((await call('POST', 'transcribe', {audio_base64: waveBase64(new Float32Array(240001))})).status, 400)
  assert.deepEqual((await call('POST', 'transcribe', body)).body, {text: '周四发布'})
  assert.equal(calls, 1)
  location = 'cloud'
  assert.equal((await call('POST', 'transcribe', body)).status, 503)
  assert.equal(calls, 1)
  assert.deepEqual((await call('GET', '')).body.items, [])
})

test('meeting draft uses only the native text inference service and never saves without a separate request', async (t) => {
  const bot = await boot()
  const call = (method, id, body) => bot.call('meetings', method, base(id), body)
  const input = { title: '发布周会', attendees: ['小林'], transcript: '已决定周四上线。小林负责核对清单。' }
  const prompts = []
  let answer = '```json\n{"summary":"周四上线。","action_items":[{"text":"核对清单","owner":"小林","done":true}]}\n```'
  assert.equal((await call('POST', 'draft', input)).status, 503)
  attachRuntime({rt: {}, ctx: {}, textOnly: async prompt => { prompts.push(prompt); return answer }})
  t.after(detachRuntime)
  assert.equal((await call('POST', 'draft', {...input, transcript: ' '})).status, 400)
  assert.equal((await call('GET', 'draft')).status, 400)
  assert.equal(prompts.length, 0)
  const generated = await call('POST', 'draft', input)
  assert.equal(generated.status, 200)
  assert.deepEqual(generated.body.draft, { summary: '周四上线。', action_items: [
    {text: '核对清单', owner: '小林', done: false},
  ]})
  assert.deepEqual(JSON.parse(prompts[0].split('\n').at(-1)), input)
  assert.deepEqual((await call('GET', '')).body.items, [])
  answer = 'not JSON'
  assert.equal((await call('POST', 'draft', input)).status, 502)
  const transcript = '会议记录'.repeat(10000)
  const saved = await bot.call('meetings', 'POST', base(), {...input, ...generated.body.draft, transcript}, key())
  assert.equal(saved.status, 201)
  assert.equal(saved.body.meeting.transcript, transcript)
  assert.equal(((await bot.endpoint('meetings/search', {q: input.title})).value.items[0]).href,
    `/meetings#workspace=${WS}&meeting=${saved.body.meeting.id}`)
})

test('meeting data persists in this volume only; another DS-Bot never sees it', async () => {
  const vol = volume()
  const first = await boot(vol)
  const created = await first.call('meetings', 'POST', base(), body, key())
  const again = await boot(vol)
  assert.equal((await again.call('meetings', 'GET', base(created.body.meeting.id))).status, 200)
  const other = await boot()
  assert.equal((await other.call('meetings', 'GET', base(created.body.meeting.id))).status, 404)
  assert.equal((await other.call('meetings', 'GET', base())).body.items.length, 0)
})

test('unmoved and malformed /v1 targets are refused', async () => {
  const bot = await boot()
  assert.equal((await bot.call('meetings', 'GET', `/v1/workspaces/${WS}/automations`)).body.error.code, 'not_moved')
  for (const bad of ['/v1/workspaces/../meetings', '/x/meetings', '/v1/workspaces/%2e%2e/meetings', '//v1/']) {
    assert.equal((await bot.call('meetings', 'GET', bad)).status, 404, bad)
  }
  assert.equal((await bot.call('meetings', 'DELETE', base())).status, 404)
})

test('legacy meetings of one test account import into that account\'s DS-Bot, idempotently', async () => {
  const { bundles, expect } = legacyBundles(['meetings'])
  const vol = volume()
  deliverBundle(vol, 'meetings-1.bundle', bundles.meetings)
  const bot = await boot(vol)
  const routes = await bot.endpoint('meetings/routes')
  assert.deepEqual(routes.value.imported.map((item) => item.status), ['imported'])
  const wid = expect.workspace_id
  const read = await bot.call('meetings', 'GET', base(expect.meetings.meeting_id, wid))
  assert.equal(read.status, 200)
  assert.equal(read.body.meeting.title, expect.meetings.title)
  assert.equal(read.body.meeting.action_items[0].text, '订会议室')
  const titles = (await bot.call('meetings', 'GET', base('', wid))).body.items.map((item) => item.title)
  assert.ok(!titles.includes(expect.meetings.foreign_title), 'another account\'s meeting never enters this bundle')
  assert.equal(existsSync(join(vol.data, 'openteamily', 'import', 'meetings-1.bundle')), false)
  deliverBundle(vol, 'meetings-1.bundle', bundles.meetings)
  const again = await boot(vol)
  assert.deepEqual((await again.endpoint('meetings/routes')).value.imported.map((item) => item.status), ['already-imported'])
  const tampered = JSON.parse(bundles.meetings)
  tampered.tables.meetings = tampered.tables.meetings.replace('周会', '改过')
  const evil = volume()
  deliverBundle(evil, 'x.bundle', JSON.stringify(tampered))
  const rejected = await boot(evil)
  assert.equal((await rejected.endpoint('meetings/routes')).value.imported[0].status, 'rejected')
})
