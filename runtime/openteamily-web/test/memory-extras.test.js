import assert from 'node:assert/strict'
import test from 'node:test'
import { attachRuntime, detachRuntime } from '../src/host.js'
import { boot, key, WS } from './helpers.js'

const base = (rest = '') => `/v1/workspaces/${WS}/memory${rest}`

test('memory actions run in DS-Bot: create linked to a page, filter, update, conflict, remove', async () => {
  const bot = await boot()
  const call = (...args) => bot.call('memory', ...args)
  const page = (await call('POST', base(), { title: '项目甲', body: '要点' }, key())).body.page
  const k = key()
  const created = await call('POST', base('/actions'), { title: '发周报', notes: '周五', due_at: 1800000000, memory_page_id: page.id }, k)
  assert.equal(created.status, 201, JSON.stringify(created.body))
  assert.equal(created.body.action.memory_page_title, '项目甲')
  assert.equal((await call('POST', base('/actions'), { title: '发周报', notes: '周五', due_at: 1800000000, memory_page_id: page.id }, k)).status, 200)
  assert.equal((await call('POST', base('/actions'), { title: 'x', memory_page_id: 'f'.repeat(32) }, key())).status, 400)
  const action = created.body.action
  assert.equal((await call('GET', base('/actions?status=open'))).body.items.length, 1)
  assert.equal((await call('GET', base('/actions?status=bad'))).status, 400)
  const done = await call('POST', base(`/actions/${action.id}`), { revision: 1, changes: { status: 'done' } })
  assert.equal(done.body.action.status, 'done')
  assert.equal((await call('POST', base(`/actions/${action.id}`), { revision: 1, changes: { status: 'open' } })).status, 409)
  assert.equal((await call('GET', base('/actions?status=open'))).body.items.length, 0)
  assert.equal((await call('POST', base(`/actions/${action.id}/remove`), {})).status, 200)
})

test('links and the graph (topics, [[mentions]], manual links) are computed in DS-Bot', async () => {
  const bot = await boot()
  const call = (...args) => bot.call('memory', ...args)
  const a = (await call('POST', base(), { title: '甲', body: '见 [[乙]]', topics: ['客户'] }, key())).body.page
  const b = (await call('POST', base(), { title: '乙', body: '', topics: ['客户'] }, key())).body.page
  const c = (await call('POST', base(), { title: '丙', body: '' }, key())).body.page
  const link = await call('POST', base('/links'), { source: c.id, target: a.id }, key())
  assert.equal(link.status, 201)
  assert.equal((await call('POST', base('/links'), { source: a.id, target: c.id }, key())).status, 409)
  assert.equal((await call('POST', base('/links'), { source: a.id, target: a.id }, key())).status, 400)
  const graph = (await call('GET', base('/graph'))).body
  assert.deepEqual(graph.counts, { nodes: 3, edges: 2, topics: 1 })
  assert.deepEqual(graph.edges.map((edge) => edge.kind).sort(), ['manual', 'mention'])
  assert.equal(graph.topics[0].page_count, 2)
  assert.equal((await call('POST', base(`/links/${link.body.link.id}/remove`), {})).status, 200)
  assert.equal((await call('GET', base('/graph'))).body.counts.edges, 1)
  assert.ok(b.id)
})

test('profile and preferences belong to this DS-Bot owner and feed memory/personal', async () => {
  const bot = await boot()
  const call = (...args) => bot.call('memory', ...args)
  assert.equal((await call('GET', base('/profile'))).body.profile.revision, 0)
  const saved = await call('POST', base('/profile'), { revision: 0, professional: '产品经理', work_style: '早起', communication: '简洁' })
  assert.equal(saved.body.profile.revision, 1)
  assert.equal((await call('POST', base('/profile'), { revision: 0, professional: '', work_style: '', communication: '' })).status, 409)
  const pref = await call('POST', base('/preferences'), { text: '回复用中文' }, key())
  assert.equal(pref.status, 201)
  assert.equal((await call('POST', base('/preferences'), { text: '回复用中文 ' }, key())).status, 200, 'same text is not duplicated')
  assert.equal((await call('GET', base('/preferences'))).body.items.length, 1)
  const otherWorkspace = 'e'.repeat(32)
  const outside = `/v1/workspaces/${otherWorkspace}/memory`
  await call('POST', outside + '/profile', { revision: 0, professional: '另一工作区', work_style: '', communication: '' })
  await call('POST', outside + '/preferences', { text: '回复用德语' }, key())
  const personal = await bot.endpoint('memory/personal', {workspace_id:WS})
  assert.equal(personal.value.workspace_id,WS)
  assert.deepEqual(personal.value.preferences, ['回复用中文'])
  assert.equal(personal.value.profile.professional, '产品经理')
  const firstRevision = {revision:1, professional:'产品经理', communication:'简洁'}
  const raced = await Promise.all(['早会', '晚会'].map(work_style => call('POST', base('/profile'), {...firstRevision, work_style})))
  assert.deepEqual(raced.map(result => result.status).sort(), [200,409])
  assert.equal((await call('GET', base('/profile'))).body.profile.revision,2)
  assert.equal((await call('POST', base(`/preferences/${pref.body.preference.id}/remove`), {})).status, 200)
  assert.deepEqual((await bot.endpoint('memory/personal', {workspace_id:WS})).value.preferences, [])
  assert.deepEqual((await bot.endpoint('memory/personal', {workspace_id:otherWorkspace})).value.preferences, ['回复用德语'])
  assert.equal((await bot.endpoint('memory/personal', {})).ok,false)
  const other = await boot()
  assert.deepEqual((await other.endpoint('memory/personal', {workspace_id:WS})).value.preferences, [])
})

test('profile organization uses only this workspace and stays a draft during a concurrent edit', async () => {
  const bot = await boot()
  const call = (...args) => bot.call('memory', ...args)
  const profile = {revision:0,professional:'我做产品设计。',work_style:'',communication:'写短段落。'}
  const dream = (body = profile) => call('POST', base('/profile/dream'), body)
  assert.equal((await dream()).status,503)
  assert.equal((await dream({...profile,professional:'',communication:''})).body.error.code,'empty_profile')
  await call('POST', base('/preferences'), {text:'用中文回复'}, key())
  await call('POST', `/v1/workspaces/${'e'.repeat(32)}/memory/preferences`, {text:'另一工作区的秘密'}, key())

  let finish
  let active
  const started = new Promise(resolve => {active = resolve})
  const firstOutput = {professional:'产品设计。',work_style:'',communication:'用中文写短段落。'}
  let mode = 'invalid'
  attachRuntime({rt:{},ctx:{},async textOnly(prompt) {
    assert.match(prompt,/用中文回复/)
    assert.match(prompt,/我做产品设计/)
    assert.doesNotMatch(prompt,/另一工作区的秘密/)
    if (mode === 'invalid') return '{ "professional": "", "work_style": "", "communication": "" }'
    if (mode === 'race') {
      active()
      await new Promise(resolve => {finish = resolve})
    }
    return JSON.stringify(firstOutput)
  }})
  try {
    assert.equal((await dream()).body.error.code,'invalid_suggestion')
    mode = 'suggest'
    assert.deepEqual((await dream()).body.changes,[
      {field:'professional',text:'产品设计。'},
      {field:'communication',text:'用中文写短段落。'},
    ])
    assert.equal((await call('GET', base('/profile'))).body.profile.revision,0)
    mode = 'race'
    const stale = dream()
    await started
    const saved = await call('POST', base('/profile'), {...profile,professional:'保留用户更新。'})
    assert.equal(saved.status,200)
    finish()
    assert.equal((await stale).status,409)
    assert.equal((await call('GET', base('/profile'))).body.profile.professional,'保留用户更新。')
  } finally { detachRuntime() }
})

test('workspace capture waits for opt-in, proposes asynchronously and saves one traceable page', async () => {
  const {default: memoryFeature} = await import('../features/memory/index.js')
  const {mkdtempSync, rmSync} = await import('node:fs')
  const {tmpdir} = await import('node:os')
  const {join} = await import('node:path')
  const {setTimeout: delay} = await import('node:timers/promises')
  const dir = mkdtempSync(join(tmpdir(),'memory-capture-'))
  const source = {workspace_id:WS,agent_id:'b'.repeat(32),conversation_id:'c'.repeat(32),message_id:'d'.repeat(32)}
  let calls = 0
  const memory = memoryFeature({
    dataDir:dir, featureDir:()=>dir,
    async call(endpoint,payload) {
      assert.equal(endpoint,'agents/captureSource')
      assert.deepEqual(payload,source)
      return {title:'日常偏好',text:'以后给我的周报用三条要点。'}
    },
    currentRuntime:()=>({async backgroundTextOnly(prompt) {
      calls++
      assert.match(prompt,/周报用三条要点/)
      return JSON.stringify({title:'周报格式',body:'周报用三条要点。'})
    }}),
  })
  const route = (method,path,body) => memory.endpoints.v1({method,path,body})
  const path = base('/candidates')
  try {
    assert.equal((await route('GET',path)).body.enabled,false)
    assert.deepEqual(await memory.endpoints.enqueueCapture(source),{queued:false})
    assert.equal((await route('POST',path,{enabled:true})).body.enabled,true)
    assert.deepEqual(await memory.endpoints.enqueueCapture(source),{queued:true})
    assert.deepEqual(await memory.endpoints.enqueueCapture(source),{queued:false})
    assert.equal(calls,0)
    let list
    for (let i = 0; i < 100; i++) {
      list = (await route('GET',path)).body
      if (list.items.length) break
      await delay(50)
    }
    assert.equal(list.items.length,1)
    assert.equal(calls,1)
    assert.equal(list.items[0].source.message_id,source.message_id)
    assert.equal((await route('GET',`/v1/workspaces/${'e'.repeat(32)}/memory/candidates`)).body.items.length,0)
    const decision = {action:'save',title:'我的周报格式',body:'每份周报包含三条要点。'}
    const saved = await route('POST',path+'/'+source.message_id,decision)
    assert.equal(saved.status,201)
    assert.equal((await route('POST',path+'/'+source.message_id,decision)).body.page.id,saved.body.page.id)
    const page = (await route('GET',base('/'+saved.body.page.id))).body.page
    assert.equal(page.source.message_id,source.message_id)
    assert.equal(page.body,decision.body)
    assert.equal((await route('GET',path)).body.items.length,0)
    assert.equal((await route('POST',path,{enabled:false})).body.enabled,false)
    assert.deepEqual(await memory.endpoints.enqueueCapture({...source,message_id:'f'.repeat(32)}),{queued:false})
  } finally { memory.store.close(); rmSync(dir,{recursive:true,force:true}) }
})

test('selected history combines explicit context and remains separate from automatic capture', async () => {
  const {default: memoryFeature} = await import('../features/memory/index.js')
  const {mkdtempSync, rmSync} = await import('node:fs')
  const {tmpdir} = await import('node:os')
  const {join} = await import('node:path')
  const {setTimeout: delay} = await import('node:timers/promises')
  const dir = mkdtempSync(join(tmpdir(),'memory-history-'))
  const first = '1'.repeat(32), second = '2'.repeat(32)
  const scope = {workspace_id:WS,agent_id:'a'.repeat(32),conversation_id:'c'.repeat(32)}
  const texts = ['这条约定用于项目荔枝。','它的周报固定写三项行动。']
  let calls = 0
  const memory = memoryFeature({dataDir:dir,featureDir:()=>dir,
    async call(name,payload) {
      assert.equal(name,'agents/captureSource')
      assert.equal(payload.selected,true)
      assert.equal(payload.workspace_id,WS)
      return {title:'周报约定', text:payload.message_id===first ? texts[0] : texts[1]}
    },
    currentRuntime:()=>({async backgroundTextOnly(prompt) {
      calls++
      assert.deepEqual(JSON.parse(prompt.split('\n').at(-1)).messages,[{id:first,text:texts[0]},{id:second,text:texts[1]}])
      return JSON.stringify([{source_id:second,title:'荔枝周报',body:'荔枝项目周报固定写三项行动。'}])
    }}),
  })
  const path = base('/candidates')
  const v1 = (method,tail='',body) => memory.endpoints.v1({method,path:path+tail,body})
  const selection = {...scope,message_ids:[first,second]}
  try {
    assert.equal((await v1('GET')).body.enabled,false)
    assert.deepEqual(await memory.endpoints.enqueueHistory(selection),{queued:2,skipped:0,full:0})
    assert.deepEqual(await memory.endpoints.enqueueHistory(selection),{queued:0,skipped:2,full:0})
    assert.equal((await v1('POST','',{enabled:false})).body.enabled,false)
    assert.equal((await v1('GET')).body.queued,2)
    let listing
    for (let i=0; i<100; i++) {
      listing = (await v1('GET')).body
      if (listing.items.length) break
      await delay(50)
    }
    assert.equal(calls,1)
    assert.equal(listing.items.length,1)
    assert.equal(listing.items[0].source.message_id,second)
    assert.equal((await v1('POST','/'+second,{action:'ignore'})).body.ignored,true)
    assert.equal((await v1('GET')).body.items.length,0)
    assert.deepEqual(await memory.endpoints.enqueueHistory({...scope,message_ids:[second]}),{queued:0,skipped:1,full:0})
  } finally { memory.store.close(); rmSync(dir,{recursive:true,force:true}) }
})

test('group drafts recheck the full batch on save and hide when group access is lost', async () => {
  const {default: memoryFeature} = await import('../features/memory/index.js')
  const {mkdtempSync, rmSync} = await import('node:fs')
  const {tmpdir} = await import('node:os')
  const {join} = await import('node:path')
  const {setTimeout: delay} = await import('node:timers/promises')
  const dir = mkdtempSync(join(tmpdir(),'memory-group-'))
  const scope = {workspace_id:WS,conversation_id:'otc_group-fixture'}
  const input = [
    {id:'otm_context',revision:1,title:'发布群',author:'甲',text:'我们在讨论荔枝项目。'},
    {id:'otm_decision',revision:1,title:'发布群',author:'乙',text:'确定周五发布。'},
  ]
  let accessible = true
  const memory = memoryFeature({dataDir:dir,featureDir:()=>dir,
    async call(name,payload) {
      assert.equal(name,'messenger/captureSources')
      assert.equal(payload.workspace_id,WS)
      assert.equal(payload.conversation_id,scope.conversation_id)
      if (!accessible) throw new Error('Group inaccessible')
      return {items:input.filter(item => payload.message_ids.includes(item.id))}
    },
    currentRuntime:()=>({async backgroundTextOnly(prompt) {
      const {messages} = JSON.parse(prompt.split('\n').at(-1))
      assert.deepEqual(messages.map(item=>item.speaker),['甲','乙'])
      assert.deepEqual(messages.map(item=>item.text),input.map(item=>item.text))
      return JSON.stringify([{source_id:messages[1].id,title:'发布计划',body:'荔枝项目确定周五发布。'}])
    }}),
  })
  const path = base('/candidates')
  const v1 = (method,tail='',body) => memory.endpoints.v1({method,path:path+tail,body})
  const job = {...scope,messages:input.map(({id,revision})=>({id,revision}))}
  try {
    await assert.rejects(memory.endpoints.enqueueGroupHistory(job))
    assert.deepEqual(await memory.endpoints.enqueueGroupHistory(job,{internal:true}),{queued:2,skipped:0,full:0})
    let listing
    for(let i=0;i<100;i++) {
      listing = (await v1('GET')).body
      if (listing.items.length) break
      await delay(50)
    }
    const draft = listing.items[0]
    assert.equal(draft.source.kind,'group')
    assert.equal(draft.source.message_id,input[1].id)
    assert.equal(draft.source.conversation_id,scope.conversation_id)
    accessible = false
    assert.equal((await v1('GET')).body.items.length,0)
    const save = () => v1('POST','/'+draft.id,{action:'save',title:draft.title,body:draft.body})
    assert.equal((await save()).status,409)
    accessible = true
    input[0].revision = 2
    assert.equal((await save()).status,409, 'a supporting source changed')
    input[0].revision = 1
    const done = await save()
    assert.equal(done.status,201)
    assert.equal(done.body.page.source.message_id,input[1].id)
  } finally { memory.store.close(); rmSync(dir,{recursive:true,force:true}) }
})

test('automatic group capture has its own cursor and can be paused during extraction', async () => {
  const {default: memoryFeature} = await import('../features/memory/index.js')
  const {mkdtempSync, rmSync} = await import('node:fs')
  const {tmpdir} = await import('node:os')
  const {join} = await import('node:path')
  const {setTimeout: delay} = await import('node:timers/promises')
  const dir = mkdtempSync(join(tmpdir(),'memory-group-auto-'))
  const scope = {workspace_id:WS,conversation_id:'otc_auto-fixture'}
  const internal = {internal:true}
  const source = {id:'otm_new',revision:1,title:'发布群',author:'甲',text:'荔枝项目周五发布。'}
  const reads = []
  let extracted
  let finish
  const extracting = new Promise(resolve => { extracted = resolve })
  const release = new Promise(resolve => { finish = resolve })
  const memory = memoryFeature({dataDir:dir,featureDir:()=>dir,
    async call(endpoint,payload) {
      assert.equal(endpoint,'messenger/captureSources')
      assert.equal(payload.conversation_id,scope.conversation_id)
      if (payload.after !== undefined) {
        reads.push(payload.after)
        return {membership:17,cursor:43,items:[source]}
      }
      return {membership:17,cursor:42,items:payload.message_ids.length ? [source] : []}
    },
    currentRuntime:()=>({async backgroundTextOnly(prompt) {
      const {messages} = JSON.parse(prompt.split('\n').at(-1))
      assert.deepEqual(messages.map(item=>item.text),[source.text])
      extracted()
      await release
      return JSON.stringify([{source_id:messages[0].id,title:'发布决定',body:source.text}])
    }})})
  const list = (method='GET',body) => memory.endpoints.v1({method,path:base('/candidates'),body})
  try {
    await assert.rejects(memory.endpoints.setGroupCapture({...scope,enabled:true}))
    assert.deepEqual(await memory.endpoints.groupCaptureStatus(scope,internal),{enabled:false})
    const toggle = enabled => memory.endpoints.setGroupCapture({...scope,enabled},internal)
    assert.deepEqual(await toggle(true),{enabled:true})
    assert.deepEqual(await toggle(true),{enabled:true},'a retried enable preserves the cursor')
    assert.equal((await list()).body.group_capture,true)
    await Promise.race([extracting,delay(6000,null,{ref:false}).then(()=>assert.fail('Group capture did not start'))])
    assert.deepEqual(reads,[42])
    await list('POST',{enabled:false})
    assert.equal((await list()).body.queued,1,'the private-chat preference is independent')
    assert.equal(memory.store.get('SELECT cursor FROM memory_capture_groups').cursor,43)
    assert.deepEqual(await toggle(false),{enabled:false})
    finish()
    await delay(25)
    const paused = (await list()).body
    assert.equal(paused.group_capture,false)
    assert.equal(paused.queued,0)
    assert.deepEqual(paused.items,[])
  } finally { finish(); memory.store.close(); rmSync(dir,{recursive:true,force:true}) }
})

test('cross-workspace recall searches approved pages and actions using live membership', async () => {
  const {default: memoryFeature} = await import('../features/memory/index.js')
  const {mkdtempSync, rmSync} = await import('node:fs')
  const {tmpdir} = await import('node:os')
  const {join} = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(),'memory-authorized-recall-'))
  const team = 'b'.repeat(32), revoked = 'f'.repeat(32)
  let memberships = [{id:team,name:'Project team'}]
  const memory = memoryFeature({dataDir:dir,featureDir:()=>dir,async call(endpoint) {
    if (endpoint === 'agents/personal-binding') return {workspace_id:WS}
    assert.equal(endpoint,'teams/activeWorkspaces')
    if (!memberships) throw new Error('Membership service unavailable')
    return memberships
  }})
  const create = (workspaceId, path, body, key) => memory.endpoints.v1({
    method:'POST',path:`/v1/workspaces/${workspaceId}/memory${path}`,body,idempotency_key:key,
  })
  const params = {workspace_id:WS,query:'Launch action item'}
  try {
    const personal = await create(WS,'',{title:'Launch overview',body:'Personal notes'},'cross-recall-personal')
    const accessible = await create(team,'/actions',{title:'Launch handoff',notes:'Confirm the scope.',due_at:1803945600},'cross-recall-action')
    await create(revoked,'',{title:'Launch action item',body:'Unshared memo'},'cross-recall-revoked')
    assert.equal(personal.status,201)
    assert.equal(accessible.status,201)
    await assert.rejects(memory.endpoints.recallAcrossWorkspaces(params))
    const recall = () => memory.endpoints.recallAcrossWorkspaces(params,{internal:true})
    const matched = (await recall()).map(({page})=>page)
    assert.deepEqual(new Set(matched.map(page=>page.workspace_id)),new Set([WS,team]))
    const action = matched.find(page=>page.kind==='action')
    assert.equal(action.id,accessible.body.action.id)
    assert.match(action.facts,/open.*2027-03-02/)
    memberships = []
    assert.deepEqual((await recall()).map(({page})=>page.id),[personal.body.page.id])
    memberships = null
    assert.deepEqual((await recall()).map(({page})=>page.id),[personal.body.page.id])
  } finally { memory.store.close(); rmSync(dir,{recursive:true,force:true}) }
})
