import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, name, inject } from '../index.js'
import { resolvePagePath, PAGE_PATH, SERVED_BY_HEADER } from '../src/pages.js'
import { API_PATH, GATEWAY_PATH, LEGACY_PATH } from '../src/dispatch.js'
import { EVENTS_PATH } from '../src/events.js'
import { loadIdentity } from '../src/identity.js'

function fakeCtx() {
  const routes = new Map()
  const effects = []
  return {
    routes,
    effects,
    connection: { fetch: { register(route) { routes.set(route.path, route); return async () => routes.delete(route.path) } } },
    effect(fn, label) { effects.push(label); fn() },
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ot-web-'))
  const pages = join(root, 'pages')
  mkdirSync(join(pages, 'chat'), { recursive: true })
  mkdirSync(join(pages, 'home'), { recursive: true })
  mkdirSync(join(pages, 'shell'), { recursive: true })
  writeFileSync(join(pages, 'chat', 'index.html'), '<!doctype html><html><head><title>Chat</title></head><body>chat</body></html>')
  writeFileSync(join(pages, 'home', 'index.html'), '<html><head></head><body>home</body></html>')
  writeFileSync(join(pages, 'shell', 'app.css'), 'body{}')
  mkdirSync(join(pages, 'settings'), { recursive: true })
  writeFileSync(join(pages, 'settings', 'index.html'), '<html><head></head><body>settings</body></html>')
  writeFileSync(join(root, 'secret.txt'), 'outside')
  symlinkSync(join(root, 'secret.txt'), join(pages, 'shell', 'leak.txt'))
  const data = join(root, 'data')
  mkdirSync(data)
  return { root, pages, data }
}

const get = (route, path) => route.fetch(new Request(`http://10.0.0.2:8080${PAGE_PATH}?path=${encodeURIComponent(path)}`))
const post = (route, body) => route.fetch(new Request(`http://10.0.0.2:8080${API_PATH}`, { method: 'POST', body: JSON.stringify(body) }))

test('plugin identifies itself and only asks DSH for the connection service', () => {
  assert.equal(name, 'openteamily-web')
  assert.deepEqual(inject, ['connection'])
})

test('registers exact authenticated routes on the shared /api channel', () => {
  const { pages, data } = fixture()
  const ctx = fakeCtx()
  apply(ctx, { pagesDir: pages, dataDir: data })
  assert.deepEqual([...ctx.routes.keys()].sort(), [API_PATH, EVENTS_PATH, GATEWAY_PATH, LEGACY_PATH, PAGE_PATH].sort())
  assert.deepEqual(ctx.routes.get(PAGE_PATH).methods, ['GET'])
  assert.deepEqual(ctx.routes.get(API_PATH).methods, ['POST'])
  assert.deepEqual(ctx.routes.get(EVENTS_PATH).methods, ['GET'])
  for (const path of ctx.routes.keys()) assert.ok(path.startsWith('/api/'), 'DSH authenticates /api only')
})

test('serves pages from this runtime, marked with this runtime identity', async () => {
  const { pages, data } = fixture()
  const ctx = fakeCtx()
  const { identity } = apply(ctx, { pagesDir: pages, dataDir: data })
  const route = ctx.routes.get(PAGE_PATH)
  const chat = await get(route, '/chat/')
  assert.equal(chat.status, 200)
  assert.match(chat.headers.get('content-type'), /text\/html/)
  assert.equal(chat.headers.get(SERVED_BY_HEADER), `ds-bot; instance=${identity.instanceId}`)
  const html = await chat.text()
  assert.match(html, new RegExp(`<meta name="openteamily-instance" content="${identity.instanceId}">`))
  assert.match(html, /<head><meta name="openteamily-served-by" content="ds-bot">/)
  assert.equal((await get(route, '/')).status, 200)
  const css = await get(route, '/shell/app.css')
  assert.equal(css.status, 200)
  assert.match(css.headers.get('content-type'), /text\/css/)
})

test('refuses traversal, symlink escape, hidden and unknown files', async () => {
  const { pages, data } = fixture()
  const ctx = fakeCtx()
  apply(ctx, { pagesDir: pages, dataDir: data })
  const route = ctx.routes.get(PAGE_PATH)
  for (const bad of ['', 'chat/', '/../secret.txt', '/chat/../../secret.txt', '/shell/leak.txt', '/.git/', '/chat/%2e%2e/', '/chat//', '/chat/x.exe', '/nope/']) {
    assert.equal((await get(route, bad)).status, 404, bad)
  }
  assert.equal(resolvePagePath('/a\\b/'), null)
  assert.equal(resolvePagePath('/' + 'a'.repeat(300) + '/'), null)
})

test('extensionless settings subpaths serve the settings page, not 404', async () => {
  const { pages, data } = fixture()
  const ctx = fakeCtx()
  apply(ctx, { pagesDir: pages, dataDir: data })
  const route = ctx.routes.get(PAGE_PATH)
  for (const path of ['/settings', '/settings/', '/settings/connectors', '/settings/language']) {
    const response = await get(route, path)
    assert.equal(response.status, 200, path)
    assert.match(await response.text(), /settings/)
  }
  assert.deepEqual(resolvePagePath('/settings/connectors'), ['settings', 'index.html'])
  assert.deepEqual(resolvePagePath('/settings'), ['settings', 'index.html'])
  assert.deepEqual(resolvePagePath('/chat/app.mjs'), ['chat', 'app.mjs'])
  assert.equal(resolvePagePath('/settings/x.exe'), null)
  assert.equal((await get(route, '/settings/missing-asset.css')).status, 404)
})

test('dispatch answers shell/identity and rejects unknown endpoints', async () => {
  const { pages, data } = fixture()
  const ctx = fakeCtx()
  const { identity } = apply(ctx, { pagesDir: pages, dataDir: data })
  const route = ctx.routes.get(API_PATH)
  const ok = await (await post(route, { endpoint: 'shell/identity' })).json()
  assert.equal(ok.ok, true)
  assert.equal(ok.value.served_by, 'ds-bot')
  assert.equal(ok.value.instance_id, identity.instanceId)
  const missing = await (await post(route, { endpoint: 'constructor' })).json()
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'openteamily/not-found')
  const bad = await (await route.fetch(new Request('http://x/api/openteamily', { method: 'POST', body: 'nope' }))).json()
  assert.equal(bad.error.code, 'openteamily/invalid')
})

test('identity: manager id wins, otherwise one stable random id per volume', () => {
  const { data } = fixture()
  const manager = 'a'.repeat(32)
  assert.deepEqual({ ...loadIdentity({ env: { OPENTEAMILY_INSTANCE_ID: manager }, dataDir: data }) }, { instanceId: manager, source: 'manager' })
  const first = loadIdentity({ env: { OPENTEAMILY_INSTANCE_ID: 'not-hex' }, dataDir: data })
  const again = loadIdentity({ env: {}, dataDir: data })
  assert.equal(first.instanceId, again.instanceId)
  assert.match(first.instanceId, /^[0-9a-f]{32}$/)
  assert.equal(JSON.parse(readFileSync(join(data, 'openteamily', 'instance.json'), 'utf8')).instance_id, first.instanceId)
  const other = fixture()
  assert.notEqual(loadIdentity({ env: {}, dataDir: other.data }).instanceId, first.instanceId)
})

test('missing pages bundle answers 404, never an error page from elsewhere', async () => {
  const { root, data } = fixture()
  const ctx = fakeCtx()
  apply(ctx, { pagesDir: join(root, 'absent'), dataDir: data })
  assert.equal((await get(ctx.routes.get(PAGE_PATH), '/chat/')).status, 404)
})
