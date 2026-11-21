// Stream C discover feature maps to the shared catalog routes (fake Bot Social).
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBotSocial, setSharedBotSocial } from '../lib/c/bot-social.js'
import discover from '../features/discover/index.js'

const SERVER = 'https://social.example.test'

test('discover endpoints publish only the whitelisted projection and browse the shared feed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ot-cd-'))
  mkdirSync(join(dir, 'bot'))
  writeFileSync(join(dir, 'bot', 'flybot-social.json'), JSON.stringify({ token: 'ot-fake-token', server: SERVER }), { mode: 0o600 })
  const calls = []
  const fetch = async (url, init) => { calls.push({ method: init.method, path: url.slice(SERVER.length), body: init.body ? JSON.parse(init.body) : undefined }); return new Response('{}') }
  setSharedBotSocial(createBotSocial({ server: SERVER, credentialsPath: join(dir, 'bot', 'flybot-social.json'), fetch }))
  const E = discover({ dataDir: dir }).endpoints
  await E.publish({ kind: 'agent', ref: 'bot_1', slug: 'writer', title: 'Writer', instructions: 'SECRET PROMPT', memory: 'private' })
  await E.feed({ tab: 'following', q: 'deck' })
  await E.like({ listing_id: 'otl_1' })
  await E.collect({ listing_id: 'otl_1', on: false })
  await E.follow({ handle: 'ann.home' })
  await E.get({ slug: 'writer' })
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
    'PUT /v1/ot/listings', 'GET /v1/ot/discover?tab=following&q=deck', 'POST /v1/ot/listings/otl_1/like',
    'POST /v1/ot/listings/otl_1/collect', 'POST /v1/ot/follows', 'GET /v1/ot/discover/writer',
  ])
  assert.ok(!JSON.stringify(calls[0].body).includes('SECRET'), 'instructions are never published')
  assert.ok(!('memory' in calls[0].body))
  assert.equal(calls[3].body.on, false)
})

test('catalog publication is explicit and remix copies the previewed release in the destination runtime', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ot-cd-remix-'))
  const credentialsPath = join(dir, 'connector.json')
  writeFileSync(credentialsPath, JSON.stringify({ token: 'ot-fake-token', server: SERVER }), { mode: 0o600 })
  const workspaceId = 'a'.repeat(32)
  const agentId = 'b'.repeat(32)
  const agent = {
    id: agentId, name: 'Writer', summary: 'Draft assistance', category: 'design',
    instructions: 'Released writing instructions', revision: 5, memory: 'PRIVATE MEMORY',
    quick_starts: ['Preview this plan'],
  }
  let row
  const created = []
  const fetch = async (url, init) => {
    const path = url.slice(SERVER.length)
    if (path === '/v1/ot/listings' && init.method === 'PUT') {
      row = { id: 'listing-1', listed: true, ...JSON.parse(init.body) }
      return Response.json(row)
    }
    if (path === '/v1/ot/discover/writer') return Response.json(row)
    if (path === '/v1/ot/listings/mine') return Response.json({listings:[row]})
    if (path === '/v1/ot/discover/writer/start') {
      assert.deepEqual(JSON.parse(init.body), {quick_start:0, quick_start_version:'a'.repeat(64)})
      return Response.json({conversation_id:'test-thread', draft_text:'Preview this plan'})
    }
    if (path === '/v1/ot/discover?kind=agent&q=Draft&creator=alice.home&category=design') {
      return Response.json({ items: [{ ...row, creator: {handle: 'alice.home', display_name: 'Alice'} }] })
    }
    throw new Error('Unexpected request: ' + path)
  }
  setSharedBotSocial(createBotSocial({ server: SERVER, credentialsPath, fetch }))
  const E = discover({
    dataDir: dir,
    async call(endpoint, payload) {
      if (endpoint === 'agents/get') {
        assert.deepEqual(payload, { id: agentId, workspace_id: workspaceId })
        return { agent }
      }
      if (endpoint === 'agents/personal-binding') return { workspace_id: workspaceId }
      assert.equal(endpoint, 'agents/create')
      created.push(payload)
      return { status: 201, agent: { id: 'c'.repeat(32), name: payload.name } }
    },
  }).endpoints
  const publish = '/v1/workspaces/' + workspaceId + '/agents/' + agentId + '/discover'
  const remix = '/v1/discover/agents/writer/remix'
  const call = (method, path, body) => E.v1({ method, path, body, idempotency_key: 'a-valid-remix-key' })
  assert.equal((await call('POST', publish, { slug: 'writer' })).status, 200)
  assert.equal(row.snapshot, undefined)
  assert.equal((await call('GET', remix)).body.template.instructions, '')
  const publicStart = '/v1/discover/agents/writer/start'
  const quick = {quick_start:0, quick_start_version:'a'.repeat(64)}
  assert.equal((await call('POST', publicStart, {...quick, body:'Forged'})).status, 400)
  assert.deepEqual((await call('POST', publicStart, quick)).body,
    {conversation_id:'test-thread', draft_text:'Preview this plan', workspace_id:workspaceId})
  assert.equal((await call('POST', publish, {slug:'writer', publish_quick_starts:'yes'})).status, 400)
  assert.equal((await call('POST', publish, {slug:'writer', publish_quick_starts:true})).body.discover.publish_quick_starts,true)
  assert.deepEqual(JSON.parse(row.snapshot), {version:1, quick_starts:agent.quick_starts})
  assert.equal((await call('GET', publish)).body.discover.publish_quick_starts,true)

  assert.equal((await call('POST', publish, { slug: 'writer', revision: 5, copy_instructions: true })).status, 200)
  assert.equal(row.category, 'design')
  assert.doesNotMatch(JSON.stringify(row), /PRIVATE MEMORY/)
  const feed = await call('GET', '/v1/discover/agents?q=Draft&category=design&creator=alice.home')
  assert.deepEqual(feed.body.items[0].creator, { handle: 'alice.home', name: 'Alice' })
  assert.equal('snapshot' in feed.body.items[0], false)
  const {template} = (await call('GET', remix)).body
  assert.equal(template.instructions, agent.instructions)
  assert.equal((await call('POST', remix, {
    revision: template.revision, workspace_id: workspaceId, name: 'My writer', instructions: 'Override ignored',
  })).status, 201)
  assert.deepEqual(created, [{
    workspace_id: workspaceId, idempotency_key: 'a-valid-remix-key', name: 'My writer',
    summary: agent.summary, category: agent.category, instructions: agent.instructions,
  }])
  assert.equal((await call('POST', publish, { slug: 'writer', revision: 4, copy_instructions: true })).status, 409)
  assert.equal((await call('POST', publish, { slug: 'writer', copy_instructions: false })).status, 200)
  assert.equal((await call('POST', remix, { revision: template.revision, workspace_id: workspaceId })).status, 409)
  row.listed = false
  assert.equal((await call('GET', remix)).status, 404)
  assert.equal(created.length, 1)
})
