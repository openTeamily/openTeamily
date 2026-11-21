// Stream C plugin features talk to Bot Social with this DS-Bot's own connector token.
// Fake Bot Social (fetch stub) and fixture credentials only.
import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBotSocial, setSharedBotSocial, seg } from '../lib/c/bot-social.js'
import social from '../features/social/index.js'
import teams from '../features/teams/index.js'
import members from '../features/members/index.js'
import invites from '../features/invites/index.js'

const TOKEN = 'ot-fake-connector-token-for-tests'
const SERVER = 'https://social.example.test'

function creds(server = SERVER) {
  const dir = mkdtempSync(join(tmpdir(), 'ot-c-'))
  mkdirSync(join(dir, 'bot'))
  const path = join(dir, 'bot', 'flybot-social.json')
  writeFileSync(path, JSON.stringify({ token: TOKEN, server, home: { id: 'bot_1', handle: 'ann.home' } }), { mode: 0o600 })
  return path
}

function fakeFetch(answer = () => ({ ok: true })) {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.authorization, body: init.body ? JSON.parse(init.body) : undefined })
    const a = answer(url, init)
    const [status, body] = Array.isArray(a) ? a : [200, a]
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }
  return { fetch, calls }
}

test('requests carry the saved connector token to exactly the configured server', async () => {
  const f = fakeFetch(() => ({ handle: 'ann.home', display_name: 'Ann' }))
  const bs = createBotSocial({ server: SERVER + '/', credentialsPath: creds(), fetch: f.fetch })
  const status = await bs.status()
  assert.equal(status.connected, true)
  assert.equal(status.handle, 'ann.home')
  assert.equal(f.calls[0].url, `${SERVER}/v1/ot/me`)
  assert.equal(f.calls[0].auth, `Bearer ${TOKEN}`)
  assert.ok(!JSON.stringify(status).includes(TOKEN), 'token never returned')
})

test('the same-site Bot Social sends authenticated requests over its private socket', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ot-soc-'))
  const socket = join(dir, 'social.sock')
  const requests = []
  const listener = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    requests.push({ method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() })
    res.writeHead(req.url === '/v1/ot/redirect' ? 307 : 200, { 'content-type': 'application/json', location: 'https://other.test' })
    res.end(JSON.stringify({ ok: true }))
  })
  listener.listen(socket)
  await once(listener, 'listening')
  t.after(() => {
    listener.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const f = fakeFetch()
  const bs = createBotSocial({
    server: SERVER, credentialsPath: creds(), fetch: f.fetch, localSocket: socket, localServer: SERVER,
  })
  assert.deepEqual(await bs.post('/v1/ot/teams', { name: 'Studio' }), { ok: true })
  assert.deepEqual([requests[0].method, requests[0].path, requests[0].headers.host, requests[0].headers.authorization],
    ['POST', '/v1/ot/teams', new URL(SERVER).host, `Bearer ${TOKEN}`])
  assert.deepEqual(JSON.parse(requests[0].body), { name: 'Studio' })
  await assert.rejects(bs.get('/v1/ot/redirect'), { code: 'social/unreachable' })
  assert.equal(f.calls.length, 0)

  const remote = 'https://other.test'
  const other = createBotSocial({
    server: remote, credentialsPath: creds(remote), fetch: f.fetch, localSocket: socket, localServer: SERVER,
  })
  assert.deepEqual(await other.get('/v1/ot/teams'), { ok: true })
  assert.equal(f.calls[0].url, remote + '/v1/ot/teams')
  assert.equal(requests.length, 2)
  const unavailable = createBotSocial({
    server: SERVER, credentialsPath: creds(), fetch: f.fetch, localSocket: join(dir, 'missing.sock'), localServer: SERVER,
  })
  await assert.rejects(unavailable.post('/v1/ot/teams', { name: 'Studio' }), { code: 'social/unreachable' })
  assert.equal(f.calls.length, 1)
})

test('no server, missing credentials or credentials for another server fail closed', async () => {
  const f = fakeFetch()
  const none = await createBotSocial({ server: async () => undefined, credentialsPath: creds(), fetch: f.fetch }).status()
  assert.deepEqual([none.connected, none.reason], [false, 'social/not-configured'])
  const other = await createBotSocial({ server: SERVER, credentialsPath: creds('https://other.test'), fetch: f.fetch }).status()
  assert.equal(other.reason, 'social/not-connected')
  const missing = await createBotSocial({ server: SERVER, credentialsPath: '/nonexistent/x.json', fetch: f.fetch }).status()
  assert.equal(missing.reason, 'social/not-connected')
  assert.equal(f.calls.length, 0, 'nothing is sent without a matching identity')
})

test('Bot Social errors map to typed codes without leaking the token', async () => {
  const f = fakeFetch(() => [404, { error: { code: 'team_not_found', message: 'no such team' } }])
  const bs = createBotSocial({ server: SERVER, credentialsPath: creds(), fetch: f.fetch })
  await assert.rejects(bs.get('/v1/ot/teams/x'), (e) => e.code === 'social/team_not_found' && !e.message.includes(TOKEN))
})

test('browser-supplied ids cannot reshape the Bot Social path', () => {
  assert.equal(seg('ott_01ABC'), 'ott_01ABC')
  for (const bad of ['../x', 'a/b', '', 'x?y', 'a b']) assert.throws(() => seg(bad), /invalid/)
})

test('teams, members, invites and social features map to the shared routes', async () => {
  const f = fakeFetch(() => ({ handle: 'ann.home' }))
  setSharedBotSocial(createBotSocial({ server: SERVER, credentialsPath: creds(), fetch: f.fetch }))
  const host = { dataDir: '/nonexistent' }
  const T = teams(host).endpoints, M = members(host).endpoints, I = invites(host).endpoints, S = social(host).endpoints
  await T.create({ name: 'Studio', slug: 'studio-a', summary: 's', extra: 'dropped' })
  await T.directory({ q: 'guild' })
  await T.setListing({ team_id: 'ott_1', listed: true })
  await M.setRole({ team_id: 'ott_1', handle: 'bea.home', role: 'admin' })
  await M.leave({ team_id: 'ott_1' })
  await I.create({ team_id: 'ott_1', requires_approval: true })
  await I.accept({ code: 'c'.repeat(32) })
  await I.decide({ team_id: 'ott_1', request_id: 'otjr_1', decision: 'approve' })
  await S.notifications({ after: 3 })
  const seen = f.calls.map((c) => `${c.method} ${c.url.slice(SERVER.length)}`)
  assert.deepEqual(seen, [
    'POST /v1/ot/teams',
    'GET /v1/ot/directory?q=guild',
    'PUT /v1/ot/teams/ott_1/listing',
    'PATCH /v1/ot/teams/ott_1/members/bea.home',
    'GET /v1/ot/me',
    'DELETE /v1/ot/teams/ott_1/members/ann.home',
    'POST /v1/ot/teams/ott_1/invites',
    'POST /v1/ot/invites/accept',
    'POST /v1/ot/teams/ott_1/join-requests/otjr_1',
    'GET /v1/ot/notifications?after=3',
  ])
  assert.deepEqual(f.calls[0].body, { name: 'Studio', slug: 'studio-a', summary: 's' })
  assert.equal(f.calls[6].body.requires_approval, true)
  assert.ok(f.calls.every((c) => c.auth === `Bearer ${TOKEN}`))
})

test('the native inbox requests recent scoped notices and constructs safe meeting and Discover links', async t => {
  const personal = 'a'.repeat(32)
  const team = 'b'.repeat(32)
  const share = 'c'.repeat(32)
  const item = (kind,data,seq) => ({kind,data,seq,id:`notice-${seq}`,created_at:4000,read:false})
  const f = fakeFetch((url,init) => {
    const scope = new URL(url).searchParams
    if (init.method === 'POST') return {unread:1}
    const scoped = scope.get('workspace_id')
    if (scoped && scoped !== team) return [404,{error:{code:'not_found',message:'workspace not found'}}]
    return {unread:4,notifications:[
      item('meeting.shared',{share_id:share,title:'纪要',organizer:'Alice',...(scoped ? {workspace_id:scoped}:{}),path:'//outside.test'},7),
      item('meeting.shared',{share_id:share,workspace_id:'d'.repeat(32)},6),
      item('discover.published',{slug:'design-log',kind:'work',title:'设计',creator:{display_name:'Bob'},path:'//outside.test'},5),
      item('discover.published',{slug:'helper-1',listing_kind:'agent',creator:{handle:'bob.home'}},4),
      item('discover.published',{slug:'../x',kind:'work',path:'//outside.test'},3),
    ]}
  })
  setSharedBotSocial(createBotSocial({server:SERVER,credentialsPath:creds(),fetch:f.fetch}))
  t.after(() => setSharedBotSocial(undefined))
  const endpoint = social({async call(name) {
    assert.equal(name,'agents/personal-binding')
    return {workspace_id:personal}
  }}).endpoints.v1
  const local = await endpoint({method:'GET',path:`/v1/workspaces/${personal}/notifications?filter=unread`})
  assert.equal(f.calls.at(-1).url,SERVER+'/v1/ot/notifications?limit=200&latest=1&personal=1&unread=1')
  assert.equal(local.status,200)
  assert.equal(local.body.unread_count,4)
  assert.deepEqual(local.body.items.map(row=>row.seq),[7,5,4,3])
  assert.equal(local.body.items[0].path,`/meetings#workspace=${personal}&shared=${share}`)
  assert.equal(local.body.items[0].workspace_id,personal)
  assert.equal(local.body.items[1].kind,'discover.published')
  assert.equal(local.body.items[1].listing_kind,'work')
  assert.equal(local.body.items[1].path,'/w/design-log')
  assert.equal(local.body.items[2].path,'/a/helper-1')
  assert.equal(local.body.items[3].path,undefined)
  const scoped = await endpoint({method:'GET',path:`/v1/workspaces/${team}/notifications`})
  assert.equal(f.calls.at(-1).url,SERVER+`/v1/ot/notifications?limit=200&latest=1&workspace_id=${team}`)
  assert.equal(scoped.body.items[0].path,`/meetings#workspace=${team}&shared=${share}`)
  const read = await endpoint({method:'POST',path:`/v1/workspaces/${team}/notifications/read`,body:{notification_id:'notice-7'}})
  assert.deepEqual(read,{status:200,body:{unread_count:1}})
  assert.deepEqual(f.calls.at(-1).body,{notification_id:'notice-7',workspace_id:team})
  assert.equal((await endpoint({method:'GET',path:`/v1/workspaces/${'e'.repeat(32)}/notifications`})).status,404)
  assert.equal(f.calls.length,4)
})

test('Space work notices map account messages to the recipient workspace and scope their read updates', async t => {
  const workspace = 'a'.repeat(32)
  const conversation = 'otc_' + 'B'.repeat(26)
  const message = 'otm_' + 'C'.repeat(26)
  const notice = {id:'fixture-notice',seq:8,kind:'artifact.shared',created_at:9500,read:false,
    data:{conversation_id:conversation,message_id:message,title:'排期表',actor_username:'Alice'}}
  const f = fakeFetch((url, init) => init.method === 'GET' ? {unread:3,notifications:[
    notice, {...notice,id:'malformed',data:{...notice.data,conversation_id:'../profile'}},
  ]} : {unread:0})
  setSharedBotSocial(createBotSocial({server:SERVER,credentialsPath:creds(),fetch:f.fetch}))
  t.after(() => setSharedBotSocial(undefined))
  const endpoint = social({async call() { return {workspace_id:workspace} }}).endpoints.v1
  const base = `/v1/workspaces/${workspace}/notifications`
  const list = await endpoint({method:'GET',path:base+'?kind=work&limit=1'})
  assert.deepEqual(list, {status:200,body:{limit:1,unread_count:3,items:[{
    id:'fixture-notice',seq:8,kind:'artifact.shared',created:9,read:false,
    conversation_id:conversation,message_id:message,workspace_id:workspace,title:'排期表',actor_username:'Alice',
    path:`/chat#workspace=${workspace}&social=${conversation}&message=${message}`,
  }]}})
  assert.equal(f.calls[0].url,SERVER+'/v1/ot/notifications?limit=1&latest=1&personal=1&kind=work')
  const read = await endpoint({method:'POST',path:base+'/read',body:{all:true,kind:'work'}})
  assert.deepEqual(read,{status:200,body:{unread_count:0}})
  assert.deepEqual(f.calls[1].body,{all:true,personal:true,kind:'work'})
  assert.equal((await endpoint({method:'GET',path:base+'?kind=work&kind=work'})).status,400)
  assert.equal((await endpoint({method:'POST',path:base+'/read',body:{all:true,kind:'unknown'}})).status,400)
  assert.equal(f.calls.length,2)
})
