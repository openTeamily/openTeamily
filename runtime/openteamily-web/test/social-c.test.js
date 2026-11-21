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
