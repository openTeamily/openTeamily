// Stream C discover feature maps to the shared catalog routes (fake Bot Social).
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBotSocial, setSharedBotSocial } from '../lib/c/bot-social.js'
import discover from '../features/discover/index.js'
import { createDispatch } from '../src/dispatch.js'

const SERVER = 'https://social.example.test'

test('profile social sends only actor-scoped queries and explicit follow requests', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ot-profile-social-'))
  const credentialsPath = join(dir, 'connector.json')
  writeFileSync(credentialsPath, JSON.stringify({token:'profile-fixture',server:SERVER}), {mode:0o600})
  const calls = []
  setSharedBotSocial(createBotSocial({server:SERVER,credentialsPath,fetch:async (url, init) => {
    assert.equal(init.headers.authorization,'Bearer profile-fixture')
    calls.push({url:url.slice(SERVER.length), method:init.method, body:init.body && JSON.parse(init.body)})
    if (init.method === 'GET') return Response.json({items:[],next_cursor:null})
    return Response.json(url.endsWith('/notifications') ? {enabled:false} : {following:false})
  }}))
  const route = discover({dataDir:dir}).endpoints.v1
  const path = '/v1/profile/social'
  assert.deepEqual(await route({method:'GET',path:path+'?view=followers&q=Ann%20Lee&limit=20',owner_id:'forged'}), {
    status:200,body:{items:[],next_cursor:null},
  })
  assert.equal((await route({method:'GET',path:path+'?view=liked&owner_id=other'})).status,400)
  assert.equal((await route({method:'GET',path:path+'?view=liked&view=following'})).status,400)
  assert.equal((await route({method:'POST',path,body:{handle:'ann.home',on:true,owner_id:'other'}})).status,400)
  assert.equal((await route({method:'POST',path,body:{handle:'ann.home',on:'false'}})).status,400)
  assert.deepEqual(await route({method:'POST',path,body:{handle:'ann.home',on:false}}), {
    status:200,body:{following:false},
  })
  const notices = '/v1/profile/follow-work'
  assert.equal((await route({method:'GET',path:notices+'?view=liked'})).status,400)
  assert.equal((await route({method:'GET',path:notices+'?cursor=abc'})).status,200)
  assert.deepEqual(await route({method:'POST',path:notices,body:{handle:'ann.home',enabled:false}}), {
    status:200,body:{enabled:false},
  })
  assert.deepEqual(calls,[
    {url:'/v1/ot/profile/social?view=followers&q=Ann+Lee&limit=20',method:'GET',body:undefined},
    {url:'/v1/ot/follows',method:'POST',body:{handle:'ann.home',on:false}},
    {url:'/v1/ot/profile/social?view=work-notices&cursor=abc',method:'GET',body:undefined},
    {url:'/v1/ot/follows/notifications',method:'POST',body:{handle:'ann.home',enabled:false}},
  ])
})

test('native Discover feeds and work detail bind the viewer to the trusted request account', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ot-discover-viewer-'))
  const credentialsPath = join(dir, 'connector.json')
  writeFileSync(credentialsPath, JSON.stringify({ token: 'ot-fake-token', server: SERVER }), { mode: 0o600 })
  const fetch = async url => new URL(url).pathname.endsWith('/detail')
    ? Response.json({
      work: {kind: 'work', listed: true, slug: 'trusted-work', title: 'Work', liked: true},
      previous: null, next: {slug: 'next-work', title: 'Next'},
      viewer_username: 'service-value',
    })
    : Response.json({items: [], viewer_username: 'service-value'})
  setSharedBotSocial(createBotSocial({server: SERVER, credentialsPath, fetch}))
  const dispatch = createDispatch({endpoints: {'discover/v1': discover({dataDir: dir}).endpoints.v1}})
  async function viewer(path, header) {
    const response = await dispatch(new Request('http://runtime/api/openteamily', {
      method: 'POST',
      headers: header === undefined ? {} : {'x-ot-owner-username': header},
      body: JSON.stringify({endpoint: 'discover/v1', payload: {method: 'GET', path, viewer_username: 'client-value'}}),
    }))
    const {ok, value} = await response.json()
    assert.equal(ok, true)
    assert.equal(value.status, 200)
    return value.body.viewer_username
  }
  assert.equal(await viewer('/v1/discover/works?limit=12', 'trusted.viewer'), 'trusted.viewer')
  assert.equal(await viewer('/v1/discover/me/works?tab=collected', 'trusted.viewer'), 'trusted.viewer')
  assert.equal(await viewer('/v1/discover/works', 'not a username'), undefined)
  assert.equal(await viewer('/v1/discover/works'), undefined)
  assert.equal(await viewer('/v1/discover/agents', 'trusted.viewer'), 'trusted.viewer')
  assert.equal(await viewer('/v1/discover/agents'), undefined)
  assert.equal(await viewer('/v1/discover/works/trusted-work?tab=collected', 'trusted.viewer'), 'trusted.viewer')
  assert.equal(await viewer('/v1/discover/works/trusted-work?tab=following', 'bad name'), undefined)
  assert.equal(await viewer('/v1/discover/works/trusted-work'), undefined)
})

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

test('native public agent starts pass only the selected listing identity and retain stale-listing errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ot-cd-public-composer-'))
  const credentialsPath = join(dir, 'connector.json')
  writeFileSync(credentialsPath, JSON.stringify({token:'ot-fake-token',server:SERVER}), {mode:0o600})
  const id = 'otl_' + 'A'.repeat(26)
  const stale = 'otl_' + 'B'.repeat(26)
  const calls = []
  setSharedBotSocial(createBotSocial({server:SERVER,credentialsPath,fetch:async (url, init) => {
    const input = JSON.parse(init.body)
    assert.equal(url, SERVER + '/v1/ot/discover/draft-agent/start')
    calls.push(input)
    if (input.listing_id === stale) {
      return Response.json({error:{code:'public_agent_changed',message:'Listing changed'}}, {status:409})
    }
    return Response.json({conversation_id:'otc_current',created:true})
  }}))
  const workspace = 'a'.repeat(32)
  const native = discover({dataDir:dir,async call(endpoint) {
    assert.equal(endpoint, 'agents/personal-binding')
    return {workspace_id:workspace}
  }}).endpoints.v1
  const start = body => native({method:'POST',path:'/v1/discover/agents/draft-agent/start',body})
  assert.equal((await start({listing_id:id,message:'private draft'})).status, 400)
  assert.equal((await start({listing_id:id,quick_start:0,quick_start_version:'a'.repeat(64)})).status, 400)
  assert.equal((await start({listing_id:'otl_fake'})).status, 400)
  const opened = await start({listing_id:id})
  assert.equal(opened.status, 200)
  assert.deepEqual(opened.body, {conversation_id:'otc_current',created:true,workspace_id:workspace})
  const moved = await start({listing_id:stale})
  assert.equal(moved.status, 409)
  assert.equal(moved.body.error.code, 'public_agent_changed')
  assert.deepEqual(calls, [{listing_id:id},{listing_id:stale}])
})

test('native Discover forwards popularity cursors separately and publishes only the selected saved 3D revision', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ot-cd-models-'))
  const credentialsPath = join(dir, 'connector.json')
  writeFileSync(credentialsPath, JSON.stringify({token: 'fixture', server: SERVER}), {mode: 0o600})
  const workspace = 'a'.repeat(32)
  const artifact = '3'.repeat(32)
  const cursor = 'd'.repeat(32) + '.12'
  const kind = 'model/gltf-binary'
  const published = {id: 'entry', kind: 'work', work_kind: 'model3d', slug: 'vase', title: '陶瓷花瓶', listed: true}
  const modelData = Buffer.from('published GLB fixture').toString('base64')
  let review = false
  const fetch = async (url, init) => {
    const target = new URL(url)
    if (target.pathname === '/v1/ot/discover') {
      if (target.searchParams.has('before')) {
        assert.equal(target.searchParams.get('before'), '123')
        assert.equal(target.searchParams.has('sort'), false)
        return Response.json({items: [], next_before: 100})
      }
      assert.equal(target.searchParams.get('kind'), 'work')
      assert.equal(target.searchParams.get('sort'), 'popular')
      assert.equal(target.searchParams.get('work_kind'), 'model3d')
      assert.equal(target.searchParams.get('cursor'), cursor)
      return review
        ? Response.json({error: {code: 'popularity_expired', message: 'refresh'}}, {status: 409})
        : Response.json({items: [{...published, model_data: modelData}], next_cursor: cursor})
    }
    if (target.pathname === '/v1/ot/listings/mine') return Response.json({listings: []})
    assert.equal(target.pathname, '/v1/ot/listings')
    assert.equal(init.method, 'PUT')
    assert.deepEqual(JSON.parse(init.body), {
      kind: 'work', ref: artifact, slug: 'vase', title: '陶瓷花瓶',
      summary: '', work_kind: 'model3d', snapshot: '', model_data: modelData,
    })
    return Response.json(published)
  }
  setSharedBotSocial(createBotSocial({server: SERVER, credentialsPath, fetch}))
  const call = discover({
    dataDir: dir,
    async call(endpoint, input) {
      if (endpoint === 'artifacts/v1') {
        assert.equal(input.path, `/v1/workspaces/${workspace}/artifacts/${artifact}`)
        return {body: {artifact: {kind: 'media', title: '陶瓷花瓶', revision: 5, media: {mime: kind}}}}
      }
      assert.equal(endpoint, 'artifacts/chatAttachment')
      assert.deepEqual(input, {workspace_id: workspace, artifact_id: artifact, revision: 5})
      return {attachment: {mime: kind, data: modelData}}
    },
  }).endpoints.v1
  const feed = '/v1/discover/me/works?sort=popular&kind=model3d&cursor=' + cursor
  const results = await call({method: 'GET', path: feed})
  assert.equal(results.body.items[0].kind, 'model3d')
  assert.equal(results.body.items[0].model_data, undefined)
  assert.equal(results.body.cursor, cursor)
  assert.equal((await call({method: 'GET', path: '/v1/discover/me/works?cursor=123'})).body.cursor, 100)
  review = true
  const expired = await call({method: 'GET', path: feed})
  assert.equal(expired.status, 409)
  assert.equal(expired.body.error.code, 'popularity_expired')
  const saved = await call({method: 'POST', path: `/v1/workspaces/${workspace}/artifacts/${artifact}/discover`, body: {slug: 'vase'}})
  assert.equal(saved.status, 201)
  assert.equal(saved.body.discover.listed, true)
})

test('native work detail and comment routes forward the personal connector and return public projections', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ot-cd-comments-'))
  const credentialsPath = join(dir, 'connector.json')
  writeFileSync(credentialsPath, JSON.stringify({token: 'commenter-fixture', server: SERVER}), {mode: 0o600})
  const upstream = '/v1/ot/discover/writer-demo'
  const root = '/v1/discover/works/writer-demo'
  const id = 'otwc_' + '0'.repeat(26)
  const key = 'comment-key-2026-11'
  const comment = {
    id, parent_id: null, body: '欢迎交流', created_at: 1_790_000_000_000,
    author: {handle: 'writer.home', name: '作者', platform_user_id: 'private'},
    mine: true, can_remove: true, removed: false, reply_count: 0, likes: 0, liked: false,
    owner_id: 'private',
  }
  let creates = 0
  const fetch = async (url, init) => {
    assert.equal(init.headers.authorization, 'Bearer commenter-fixture')
    const path = url.slice(SERVER.length)
    if (path === upstream + '/detail?tab=collected&q=design&work_kind=model3d') return Response.json({
      work: {kind: 'work', listed: true, slug: 'writer-demo', title: '参考作品', comment_count: 1, snapshot: 'private instruction'},
      previous: null, next: {slug: 'other-work', title: '另一件作品', owner_id: 'private'},
    })
    if (path === upstream + '/comments?parent_id=' + id + '&cursor=100.' + id + '&limit=12') {
      return Response.json({items: [comment], cursor: null, comment_count: 1})
    }
    if (path === upstream + '/comments') {
      assert.equal(init.method, 'POST')
      assert.deepEqual(JSON.parse(init.body), {body: '欢迎交流', client_key: key})
      return Response.json({comment, comment_count: 1, replayed: creates++ > 0})
    }
    if (path === upstream + '/comments/' + id + '/like') {
      assert.deepEqual(JSON.parse(init.body), {enabled: true})
      return Response.json({comment: {...comment, liked: true, likes: 1}})
    }
    assert.equal(path, upstream + '/comments/' + id + '/remove')
    return Response.json({comment_count: 0})
  }
  setSharedBotSocial(createBotSocial({server: SERVER, credentialsPath, fetch}))
  const call = (method, path, body, idempotency_key) =>
    discover({dataDir: dir}).endpoints.v1({method, path, body, idempotency_key})

  const detail = (await call('GET', root + '?tab=collected&q=design&kind=model3d')).body
  assert.equal(detail.work.comment_count, 1)
  assert.ok(!Object.hasOwn(detail.work, 'snapshot'))
  assert.equal(detail.previous, null)
  assert.deepEqual(detail.next, {slug: 'other-work', title: '另一件作品'})
  assert.equal((await call('GET', root + '?cursor=12')).status, 400)
  assert.equal((await call('GET', root + '?sort=popular&sort=latest')).status, 400)
  const page = await call('GET', root + '/comments?parent_id=' + id + '&cursor=100.' + id + '&limit=12')
  assert.equal(page.status, 200)
  assert.deepEqual(page.body.items[0].author, {handle: 'writer.home', name: '作者'})
  assert.ok(!Object.hasOwn(page.body.items[0], 'owner_id'))
  assert.equal((await call('POST', root + '/comments', {body: comment.body})).status, 400)
  assert.equal((await call('POST', root + '/comments', {body: comment.body}, key)).status, 201)
  assert.equal((await call('POST', root + '/comments', {body: comment.body}, key)).status, 200)
  const update = await call('POST', root + '/comments/' + id + '/like', {enabled: true})
  assert.equal(update.body.comment.liked, true)
  assert.equal((await call('POST', root + '/comments/' + id + '/remove', {})).body.comment_count, 0)
  assert.equal((await call('GET', root + '/comments?limit=1&limit=2')).status, 400)
})

test('native website publication copies the authorized saved HTML and exposes only site availability in detail', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ot-cd-website-'))
  const records = []
  const credentialsPath = join(dir, 'connector.json')
  writeFileSync(credentialsPath, JSON.stringify({token: 'publisher', server: SERVER}), {mode: 0o600})
  const workspace = 'b'.repeat(32)
  const artifact = 'c'.repeat(32)
  const html = '<h1>本地计数器</h1><p>点按增加数值。</p><script>document.title = "script fixture"</script>'
  const listing = {kind: 'work', work_kind: 'website', listed: true, slug: 'local-counter', title: '本地计数器', site_available: true}
  const site = createBotSocial({server: SERVER, credentialsPath, async fetch(url, init) {
    records.push([init.method, new URL(url).pathname, init.body ? JSON.parse(init.body) : null])
    if (url.endsWith('/mine')) return Response.json({listings: []})
    if (url.endsWith('/detail')) return Response.json({work: {...listing, site_html: html}})
    return Response.json(listing)
  }})
  setSharedBotSocial(site)
  const run = discover({dataDir: dir, async call(endpoint, data) {
    assert.equal(endpoint, 'artifacts/v1')
    assert.equal(data.path, `/v1/workspaces/${workspace}/artifacts/${artifact}`)
    return {body: {artifact: {id: artifact, title: '本地计数器', kind: 'website', revision: 2, body: html}}}
  }}).endpoints.v1
  const publish = await run({
    method: 'POST', path: `/v1/workspaces/${workspace}/artifacts/${artifact}/discover`,
    body: {slug: 'local-counter', site_html: 'request override'},
  })
  assert.equal(publish.status, 201)
  assert.deepEqual(records.find(([method]) => method === 'PUT')?.[2], {
    kind: 'work', ref: artifact, slug: 'local-counter', title: '本地计数器',
    summary: '本地计数器\n点按增加数值。', work_kind: 'website', site_html: html,
  })
  const detail = await run({method: 'GET', path: '/v1/discover/works/local-counter'})
  assert.equal(detail.body.work.site_available, true)
  assert.equal(Object.hasOwn(detail.body.work, 'site_html'), false)
  assert.equal(JSON.stringify(detail).includes('script fixture'), false)
})
