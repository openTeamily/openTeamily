import { createLegacyDispatch, LEGACY_PATH } from '../src/dispatch.js'
import { triangleGlb } from './fixtures/triangle-glb.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { boot, deliverBundle, key, legacyBundles, volume, WS } from './helpers.js'

const base = (rest = '', ws = WS) => `/v1/workspaces/${ws}/artifacts${rest}`
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

test('artifacts feature loads in this DS-Bot and keeps its data in its own feature directory', async () => {
  const bot = await boot()
  assert.ok(bot.features.loaded.includes('artifacts'), JSON.stringify(bot.features.failed))
  assert.ok(existsSync(join(bot.vol.data, 'openteamily', 'features', 'artifacts', 'artifacts.sqlite3')))
})

test('document, website, slides, dashboard and whiteboard CRUD, favorites, versions, export and restore run in this DS-Bot', async () => {
  const bot = await boot()
  const call = (...args) => bot.call('artifacts', ...args)
  const created = await call('POST', base(), { title: '周报', body: '本周完成迁移。', kind: 'document' }, key())
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const doc = created.body.artifact
  assert.equal(doc.kind, 'document')
  assert.equal(doc.body, '本周完成迁移。')
  const listed = await call('GET', base() + '?q=周报')
  assert.equal(listed.body.items.length, 1)
  assert.equal(listed.body.items[0].body, undefined)
  assert.equal(listed.body.items[0].preview.type, 'document')
  assert.equal((await call('GET', base('/' + doc.id))).body.artifact.body, '本周完成迁移。')

  const stale = await call('POST', base('/' + doc.id), { revision: 9, changes: { body: 'x' } })
  assert.equal(stale.status, 409)
  assert.equal(stale.body.error.current.revision, 1)
  const edited = await call('POST', base('/' + doc.id), { revision: 1, changes: { body: '本周合入插件。' } })
  assert.equal(edited.body.artifact.revision, 2)
  const fav = await call('POST', base(`/${doc.id}/favorite`), { enabled: true })
  assert.equal(fav.body.favorited, true)
  assert.equal((await call('GET', base())).body.items[0].favorited, true)

  const history = await call('GET', base(`/${doc.id}/versions`))
  assert.ok(history.body.items.some((item) => item.revision === 1))
  const exported = await call('GET', base(`/${doc.id}/export`))
  assert.equal(exported.status, 200)
  assert.match(exported.download.content_type, /text\/plain/)
  assert.match(exported.text, /本周合入插件/)
  const office = await call('GET', base(`/${doc.id}/export?format=docx`))
  assert.equal(office.status, 200, JSON.stringify(office.body))
  assert.match(office.download.content_type, /wordprocessingml/)
  assert.equal((await call('GET', base(`/${doc.id}/export?format=xlsx`))).body.error.code, 'unsupported_export')
  const restored = await call('POST', base(`/${doc.id}/restore`), { revision: 2, to: 1 })
  assert.equal(restored.body.artifact.body, '本周完成迁移。')
  assert.equal(restored.body.artifact.revision, 3)

  const site = await call('POST', base(), { title: '站点', body: '<h1>你好</h1><script>alert(1)</script>', kind: 'website' }, key())
  assert.equal(site.body.artifact.kind, 'website')
  const preview = await call('GET', base(`/${site.body.artifact.id}/preview`))
  assert.equal(preview.status, 200)
  assert.match(preview.text, /你好/)
  assert.doesNotMatch(preview.text, /<script>/)

  const slides = await call('POST', base(), { title: '路演', kind: 'slides', slides: { schema: 'openteamily.slides.v1', slides: [{ title: '第一页', bullets: ['要点'] }] } }, key())
  assert.equal(slides.body.artifact.kind, 'slides')
  assert.equal(slides.body.artifact.slides.slides[0].title, '第一页')
  const board = await call('POST', base(), { title: '草图', kind: 'whiteboard', board: { schema: 'openteamily.whiteboard.v1', width: 800, height: 600, strokes: [] } }, key())
  assert.equal(board.body.artifact.kind, 'whiteboard')
  const dash = await call('POST', base(), { title: '指标', kind: 'dashboard', dashboard: { schema: 'openteamily.dashboard.v1', widgets: [{ type: 'metric', title: '人数', value: '12', note: '' }] } }, key())
  assert.equal(dash.body.artifact.kind, 'dashboard')

  const share = await call('POST', base(`/${doc.id}/shares`), {})
  assert.equal(share.status, 201)
  assert.match(share.body.share.path, /^\/share\//)
  assert.equal(share.body.share.token.length, 43)
  const listedShares = await call('GET', base(`/${doc.id}/shares`))
  assert.equal(listedShares.body.items.length, 1)
  const revoked = await call('POST', base(`/${doc.id}/shares/${share.body.share.id}/revoke`), {})
  assert.equal(revoked.body.share.revoked, true)

  assert.equal((await call('POST', base(`/${doc.id}/remove`), {})).status, 200)
  assert.equal((await call('GET', base('/' + doc.id))).status, 404)
})

test('media upload is stored in this DS-Bot feature directory and is listed for resource search', async () => {
  const bot = await boot()
  const call = (...args) => bot.call('artifacts', ...args)
  const created = await call('POST', base(), {
    _multipart: true,
    fields: { title: '封面', kind: 'media' },
    files: { file: { filename: 'dot.png', content_type: 'image/png', data: PNG.toString('base64') } },
  }, key())
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const item = created.body.artifact
  assert.equal(item.kind, 'media')
  assert.equal(item.media.filename, 'dot.png')
  assert.equal(item.media.mime, 'image/png')
  const objects = join(bot.vol.data, 'openteamily', 'features', 'artifacts', 'objects', WS)
  assert.ok(existsSync(objects))
  const file = await call('GET', base(`/${item.id}/file`))
  assert.equal(file.status, 200)
  assert.equal(file.download.content_type, 'image/png')
  const files = await bot.endpoint('artifacts/files', { workspace_id: WS, q: '封面', limit: 20 })
  assert.equal(files.ok, true)
  assert.equal(files.value.items[0].id, item.id)
  assert.match(files.value.items[0].href, /\/file$/)
  const viaSearch = await bot.call('search', 'GET', `/v1/workspaces/${WS}/search/resources?kind=files&q=封面`)
  assert.equal(viaSearch.status, 200)
  assert.equal(viaSearch.body.items[0].id, item.id)
  const all = await bot.endpoint('search/all', { q: '封面' })
  assert.equal(all.value.items[0].kind, 'artifact')
})

test('artifact data stays in this volume; another DS-Bot never sees it', async () => {
  const vol = volume()
  const first = await boot(vol)
  const created = await first.call('artifacts', 'POST', base(), { title: '仅此卷', body: '私有', kind: 'document' }, key())
  assert.equal((await boot(vol).then((bot) => bot.call('artifacts', 'GET', base('/' + created.body.artifact.id)))).status, 200)
  const other = await boot()
  assert.equal((await other.call('artifacts', 'GET', base('/' + created.body.artifact.id))).status, 404)
  assert.equal((await other.call('artifacts', 'GET', base())).body.items.length, 0)
})

test('Space activity tracks saved revisions and favorites only in this owner and workspace', async () => {
  const bot = await boot()
  const another = await boot()
  const secondWorkspace = 'b'.repeat(32)
  const call = (...args) => bot.call('artifacts', ...args)
  const activity = async (id, workspace = WS) => {
    const result = await call('GET', base('/activity', workspace) + (id ? '?artifact=' + id : ''))
    assert.equal(result.status, 200)
    assert.match(result.body.version, /^[a-f0-9]{64}$/)
    return result.body
  }
  const before = await activity()
  assert.deepEqual(Object.keys(before), ['version'])
  const otherScope = await activity(null, secondWorkspace)
  assert.notEqual(otherScope.version, before.version)

  const created = await call('POST', base(), {title: 'Private work', body: 'Unexposed draft'}, key())
  assert.equal(created.status, 201)
  const id = created.body.artifact.id
  const createdActivity = await activity(id)
  assert.deepEqual(Object.keys(createdActivity), ['version', 'revision'])
  assert.equal(createdActivity.revision, 1)
  assert.notEqual(createdActivity.version, before.version)
  const filtered = await call('GET', base() + '?q=empty&limit=1')
  assert.equal(filtered.body.items.length, 0)
  assert.equal(filtered.body.activity_version, createdActivity.version)
  assert.deepEqual(await activity(id, secondWorkspace), {version: otherScope.version, revision: null})

  const foreign = await another.call('artifacts', 'GET', base('/activity') + '?artifact=' + id)
  assert.deepEqual(foreign.body, {version: before.version, revision: null})
  await call('POST', base('/' + id), {revision: 1, changes: {title: 'Edited'}})
  const edited = await activity(id)
  assert.equal(edited.revision, 2)
  assert.notEqual(edited.version, createdActivity.version)

  await call('POST', base(`/${id}/favorite`), {enabled: true})
  const favorite = await activity(id)
  assert.equal(favorite.revision, edited.revision)
  assert.notEqual(favorite.version, edited.version)
  await call('POST', base(`/${id}/favorite`), {enabled: true})
  assert.deepEqual(await activity(id), favorite)
  await call('POST', base(`/${id}/remove`), {})
  assert.deepEqual(await activity(id), {version: before.version, revision: null})
  for (const query of ['?foo=bar', '?artifact=bad', '?artifact=' + id + '&artifact=' + id]) {
    assert.equal((await call('GET', base('/activity') + query)).status, 400)
  }
  assert.equal((await call('POST', base('/activity'), {})).status, 400)
})

test('chat and automation sources attach on create and are idempotent by source', async () => {
  const bot = await boot()
  const payload = {
    title: '对话存档', body: '结论。', kind: 'document',
    source: { kind: 'agent_message', id: 'b'.repeat(32), conversation_id: 'c'.repeat(32), conversation_title: '周报助手' },
  }
  const first = await bot.endpoint('artifacts/create', { ...payload, workspace_id: WS, idempotency_key: key() })
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.equal(first.value.artifact.source.kind, 'agent_message')
  assert.equal(first.value.artifact.source.conversation_title, '周报助手')
  const again = await bot.endpoint('artifacts/create', { ...payload, title: '另一标题', workspace_id: WS, idempotency_key: key() })
  assert.equal(again.value.artifact.id, first.value.artifact.id)
})

test('one test account\'s legacy artifacts import into its DS-Bot only', async () => {
  const { bundles, expect } = legacyBundles(['artifacts'])
  const vol = volume()
  deliverBundle(vol, 'artifacts-1.bundle', bundles.artifacts)
  const bot = await boot(vol)
  assert.deepEqual((await bot.endpoint('artifacts/routes')).value.imported.map((item) => item.status), ['imported'])
  const wid = expect.workspace_id
  const item = await bot.call('artifacts', 'GET', `/v1/workspaces/${wid}/artifacts/${expect.artifacts.artifact_id}`)
  assert.equal(item.status, 200)
  assert.equal(item.body.artifact.body, expect.artifacts.body)
  const listed = await bot.call('artifacts', 'GET', `/v1/workspaces/${wid}/artifacts?q=bob`)
  assert.equal(listed.body.items.length, 0)
  const other = await boot()
  assert.equal((await other.call('artifacts', 'GET', `/v1/workspaces/${wid}/artifacts/${expect.artifacts.artifact_id}`)).status, 404)
})

test('chat attachments export the selected saved version and require an internal caller', async () => {
  const bot = await boot()
  const created = await bot.call('artifacts','POST',base(),{title:'发给群聊',kind:'document',body:'Saved version one'},key())
  const artifact = created.body.artifact
  const input = {workspace_id:WS,artifact_id:artifact.id,revision:1}
  assert.equal((await bot.endpoint('artifacts/chatAttachment',input)).error.code, 'forbidden')
  await bot.call('artifacts','POST',base('/'+artifact.id),{revision:1,changes:{title:'新标题',body:'Saved version two'}})
  const resolve = data => bot.features.table['artifacts/chatAttachment'](data,{internal:true})
  const snapshot = await resolve(input)
  const historical = await bot.call('artifacts','GET',base('/'+artifact.id+'/versions/1/export?format=docx'))
  assert.deepEqual(Buffer.from(snapshot.attachment.data,'base64'),Buffer.from(historical.download.data,'base64'))
  assert.equal(snapshot.body,'发给群聊 · 版本 1')
  assert.equal(snapshot.attachment.title,'发给群聊-v1.docx')
  assert.deepEqual(snapshot.attachment.resource,{kind:'document',title:'发给群聊',revision:1})
  const updated = (await resolve({...input,revision:2})).attachment
  assert.deepEqual(updated.resource,{kind:'document',title:'新标题',revision:2})
  assert.notEqual(updated.data,snapshot.attachment.data)
  await assert.rejects(resolve({...input,workspace_id:'f'.repeat(32)}),error=>error.status===404)
  await assert.rejects(resolve({...input,revision:3}),error=>error.status===404)
  const examples = [
    [{title:'网页',kind:'website',body:'<h1>标题</h1><script>alert(1)</script>'}, 'txt', /text\/plain/],
    [{title:'白板',kind:'whiteboard'}, 'json', /application\/json/],
    [{title:'幻灯片',kind:'slides',slides:{schema:'openteamily.slides.v1',slides:[{title:'开场',bullets:['计划']}]}}, 'pptx', /presentationml/],
    [{title:'工作表',kind:'dashboard',dashboard:{schema:'openteamily.dashboard.v1',widgets:[{type:'metric',title:'参会人数',value:'3',note:''}]}}, 'xlsx', /spreadsheetml/],
    [{_multipart:true,fields:{title:'封面图'},files:{file:{filename:'dot.png',content_type:'image/png',data:PNG.toString('base64')}}}, 'png', /image\/png/],
  ]
  for (const [payload, suffix, mime] of examples) {
    const result = await bot.call('artifacts','POST',base(),payload,key())
    assert.equal(result.status,201,JSON.stringify(result.body))
    const {attachment} = await resolve({...input,artifact_id:result.body.artifact.id})
    assert.ok(attachment.title.endsWith('.' + suffix))
    assert.match(attachment.mime,mime)
    assert.deepEqual(attachment.resource,{kind:result.body.artifact.kind,title:result.body.artifact.title,revision:1})
    if (suffix === 'txt') assert.doesNotMatch(Buffer.from(attachment.data,'base64').toString(), /<script>/)
  }
})

test('native workbook versions preserve distinct worksheets and Excel treats unsupported formulas as text', async () => {
  const bot = await boot()
  const call = (...args) => bot.call('artifacts', ...args)
  const spreadsheet = {schema:'openteamily.spreadsheet.v1',sheets:[
    {name:'明细',rows:[['商品','金额'],['笔','12.50'],['胶水','7'],['总计','=sum(B2:B3)']]},
    {name:'库存',rows:[['编号','备注'],['00123','=HYPERLINK("https://example.test/","link")']]},
  ]}
  const payload = {title:'采购清单',kind:'spreadsheet',spreadsheet}
  const invalid = await call('POST',base(),{
    ...payload,spreadsheet:{...spreadsheet,sheets:[{name:'Sheet',rows:[]},{name:'sheet',rows:[]}]},
  },key())
  assert.equal(invalid.status,400)
  const created = await call('POST',base(),payload,key())
  assert.equal(created.status,201,JSON.stringify(created.body))
  const {artifact} = created.body
  const route = '/' + artifact.id
  assert.equal(artifact.kind,'spreadsheet')
  assert.deepEqual(artifact.spreadsheet,spreadsheet)
  assert.equal((await call('GET',base())).body.items[0].spreadsheet,undefined)
  const updated = structuredClone(spreadsheet)
  updated.sheets[0].rows[1][1] = '15'
  assert.equal((await call('POST',base(route),{revision:1,changes:{spreadsheet:updated}})).body.artifact.revision,2)
  const stale = await call('POST',base(route),{revision:1,changes:{spreadsheet}})
  assert.equal(stale.status,409)
  const historical = await call('GET',base(route+'/versions/1/export'))
  assert.equal(historical.status,200)
  assert.match(historical.download.content_type,/spreadsheetml/)
  const bytes = Buffer.from(historical.download.data,'base64')
  const parts = new Map()
  for (let offset=0; bytes.readUInt32LE(offset) === 0x04034b50;) {
    const nameAt = offset+30
    const dataAt = nameAt+bytes.readUInt16LE(offset+26)+bytes.readUInt16LE(offset+28)
    const next = dataAt+bytes.readUInt32LE(offset+18)
    parts.set(bytes.toString('utf8',nameAt,dataAt),inflateRawSync(bytes.subarray(dataAt,next)).toString())
    offset = next
  }
  assert.match(parts.get('xl/workbook.xml'),/name="明细".*name="库存"/)
  assert.match(parts.get('xl/worksheets/sheet1.xml'),/<c r="B2"><v>12\.50<\/v><\/c>/)
  assert.match(parts.get('xl/worksheets/sheet1.xml'),/<f>SUM\(B2:B3\)<\/f>/)
  assert.match(parts.get('xl/worksheets/sheet2.xml'),/<t xml:space="preserve">00123<\/t>/)
  assert.match(parts.get('xl/worksheets/sheet2.xml'),/<t xml:space="preserve">=HYPERLINK/)
  assert.doesNotMatch(parts.get('xl/worksheets/sheet2.xml'),/<f>/)
  const attachment = await bot.features.table['artifacts/chatAttachment']({
    workspace_id:WS,artifact_id:artifact.id,revision:1,
  },{internal:true})
  assert.equal(attachment.attachment.title,'采购清单-v1.xlsx')
  assert.equal(attachment.attachment.data,historical.download.data)
  const restored = await call('POST',base(route+'/restore'),{revision:2,to:1})
  assert.equal(restored.body.artifact.revision,3)
  assert.deepEqual(restored.body.artifact.spreadsheet,spreadsheet)
  const preview = await call('GET',base(route+'/preview'))
  assert.match(preview.text,/<td>12\.50<\/td>/)
})

test('generated MP4 above the ordinary media upload limit can be viewed, exported and sent', async () => {
  const bot = await boot()
  const resolve = bot.features.table['artifacts/generatedVideo']
  const job_id = '7'.repeat(32)
  const payload = {workspace_id: WS, job_id}
  const video = Buffer.alloc(2 * 1024 * 1024 + 20)
  video.write('ftypisom', 4)
  await assert.rejects(resolve({...payload, title: '未授权', data: video}, {}), error => error.status === 404)
  await assert.rejects(resolve({...payload, title: '格式错误', data: PNG}, {internal: true}), error => error.status === 400)
  const saved = await resolve({...payload, title: '生成视频', data: video}, {internal: true})
  assert.equal((await resolve(payload, {internal: true})).id, saved.id)
  const content = await bot.call('artifacts', 'GET', base('/' + saved.id + '/file'))
  assert.equal(content.download.inline, true)
  assert.equal(content.download.content_type, 'video/mp4')
  assert.deepEqual(Buffer.from(content.download.data, 'base64'), video)
  const exported = await bot.call('artifacts', 'GET', base('/' + saved.id + '/export'))
  assert.equal(exported.download.data, content.download.data)
  const share = await bot.features.table['artifacts/chatAttachment']({
    workspace_id: WS, artifact_id: saved.id, revision: 1,
  }, {internal: true})
  assert.equal(share.attachment.mime, 'video/mp4')
  assert.equal(share.attachment.data, content.download.data)
})

test('generated MP3 is saved once and keeps the original bytes for playback and sharing', async () => {
  const bot = await boot()
  const resolve = bot.features.table['artifacts/generatedMusic']
  const payload = {workspace_id: WS, job_id: '8'.repeat(32)}
  const music = Buffer.alloc(576)
  music.set([0xff, 0xfa, 0xb4, 0x04])
  await assert.rejects(resolve({...payload, title: '未授权', data: music}, {}), error => error.status === 404)
  await assert.rejects(resolve({...payload, title: '格式错误', data: PNG}, {internal: true}), error => error.status === 400)
  const {id} = await resolve({...payload, title: '生成音乐', data: music}, {internal: true})
  assert.equal((await resolve(payload, {internal: true})).id, id)
  assert.equal((await resolve({...payload, title: '重复音乐', data: music}, {internal: true})).id, id)
  const content = await bot.call('artifacts', 'GET', base('/' + id + '/file'))
  assert.equal(content.download.inline, true)
  assert.equal(content.download.content_type, 'audio/mpeg')
  assert.deepEqual(Buffer.from(content.download.data, 'base64'), music)
  const share = await bot.features.table['artifacts/chatAttachment']({
    workspace_id: WS, artifact_id: id, revision: 1,
  }, {internal: true})
  assert.equal(share.attachment.mime, 'audio/mpeg')
  assert.match(share.attachment.title, /\.mp3$/)
  assert.equal(share.attachment.data, content.download.data)
})

test('generated GLB can be viewed, downloaded and attached to chat above the usual media limit', async () => {
  const bot = await boot()
  const generate = bot.features.table['artifacts/generatedModel3d']
  const request = {workspace_id: WS, job_id: '9'.repeat(32)}
  const data = triangleGlb({byteLength: 2 * 1024 * 1024 + 4})
  await assert.rejects(generate({...request, title: '未授权', data}, {}), {status: 404})
  const {id} = await generate({...request, title: '3D 模型', data}, {internal: true})
  assert.equal((await generate(request, {internal: true})).id, id)
  const view = await bot.call('artifacts', 'GET', base('/' + id + '/file'))
  assert.equal(view.download.inline, true)
  assert.equal(view.download.content_type, 'model/gltf-binary')
  assert.deepEqual(Buffer.from(view.download.data, 'base64'), data)
  const exported = await bot.call('artifacts', 'GET', base('/' + id + '/export'))
  assert.equal(exported.download.data, view.download.data)
  const share = await bot.features.table['artifacts/chatAttachment']({
    workspace_id: WS, artifact_id: id, revision: 1,
  }, {internal: true})
  assert.equal(share.attachment.mime, 'model/gltf-binary')
  assert.match(share.attachment.title, /\.glb$/)
  assert.equal(share.attachment.data, view.download.data)
})


test('generated website is saved as an editable artifact and can be recovered by job ID', async () => {
  const bot = await boot()
  const generate = bot.features.table['artifacts/generatedWebsite']
  const request = {workspace_id: WS, job_id: 'b'.repeat(32)}
  const internal = {internal: true}
  const html = '<!doctype html><title>Demo</title><button>Count</button>'
  await assert.rejects(generate({...request, title: 'Demo', body: html}, {}), {status: 404})
  assert.equal(await generate(request, internal), null)
  const saved = await generate({...request, title: 'Demo', body: html}, internal)
  assert.equal((await generate(request, internal)).id, saved.id)
  assert.equal((await generate({...request, title: 'Retry', body: html}, internal)).id, saved.id)
  const detail = await bot.call('artifacts', 'GET', base('/' + saved.id))
  assert.equal(detail.status, 200)
  assert.equal(detail.body.artifact.kind, 'website')
  assert.equal(detail.body.artifact.title, 'Demo')
  assert.equal(detail.body.artifact.body, html)
  assert.equal(detail.body.artifact.revision, 1)
})

test('website iframe renders only the selected saved revision with an opaque script sandbox', async () => {
  const bot = await boot()
  const html = '<!doctype html><title>Demo</title><button>Count</button><script>document.title = "Active"</script>'
  const site = await bot.call('artifacts', 'POST', base(), { title: '互动网页', kind: 'website', body: html }, key())
  assert.equal(site.status, 201, JSON.stringify(site.body))
  const path = base('/' + site.body.artifact.id)
  const dispatch = createLegacyDispatch({ endpoints: bot.features.table })
  const open = (path, query = '') => {
    const url = new URL(LEGACY_PATH, 'http://127.0.0.1')
    url.search = new URLSearchParams({ feature: 'artifacts', path, query })
    return dispatch(new Request(url))
  }
  const preview = await open(path + '/preview', 'revision=1')
  assert.equal(preview.status, 200)
  assert.equal(await preview.text(), html)
  assert.equal(preview.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.equal(preview.headers.get('cache-control'), 'private, no-store')
  assert.equal(preview.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(preview.headers.get('referrer-policy'), 'no-referrer')
  const csp = preview.headers.get('content-security-policy')
  assert.match(csp, /(?:^|; )sandbox allow-scripts(?:;|$)/)
  assert.match(csp, /frame-ancestors 'self'/)
  assert.match(csp, /connect-src 'none'/)
  assert.match(csp, /form-action 'none'/)
  assert.doesNotMatch(csp, /allow-same-origin|allow-top-navigation|allow-popups/)

  const staticPreview = await open(path + '/preview')
  assert.equal(staticPreview.status, 200)
  assert.doesNotMatch(await staticPreview.text(), /<script>/)
  assert.doesNotMatch(staticPreview.headers.get('content-security-policy'), /allow-scripts/)
  const exported = await open(path + '/export')
  assert.equal(exported.status, 200)
  assert.match(exported.headers.get('content-disposition'), /^attachment/)
  assert.doesNotMatch(exported.headers.get('content-security-policy'), /allow-scripts/)
  assert.equal((await open(path + '/preview', 'revision=1&revision=1')).status, 400)
  assert.equal((await open(path + '/preview', 'revision=2')).status, 409)

  const updated = await bot.call('artifacts', 'POST', path, { revision: 1, changes: { body: '<h1>Saved again</h1>' } })
  assert.equal(updated.status, 200)
  assert.equal((await open(path + '/preview', 'revision=1')).status, 409)
  assert.equal(await (await open(path + '/preview', 'revision=2')).text(), '<h1>Saved again</h1>')
  assert.equal((await open(base('/' + site.body.artifact.id + '/preview', 'b'.repeat(32)), 'revision=2')).status, 404)
})
