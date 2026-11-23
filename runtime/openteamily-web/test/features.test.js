import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { apply } from '../index.js'
import { PAGE_PATH } from '../src/pages.js'
import { loadFeatures, registerFeature } from '../src/features.js'
import { attachRuntime, detachRuntime, runtime } from '../src/host.js'
import { createDispatch } from '../src/dispatch.js'

const identity = { instanceId: 'c'.repeat(32) }

function featuresDir(files) {
  const root = mkdtempSync(join(tmpdir(), 'ot-features-'))
  for (const [name, source] of Object.entries(files)) {
    mkdirSync(join(root, name), { recursive: true })
    writeFileSync(join(root, name, 'index.js'), source)
  }
  return root
}

test('features register namespaced endpoints; a broken feature is skipped, others load', async () => {
  const dir = featuresDir({
    alpha: "export default (host) => ({ endpoints: { ping: async (p) => ({ pong: p, dir: host.featureDir() }) } })",
    broken: "throw new Error('boom')",
    'Bad_Name': "export default () => ({ endpoints: {} })",
    nofactory: "export const x = 1",
  })
  const data = mkdtempSync(join(tmpdir(), 'ot-data-'))
  const logs = []
  const { table, loaded, failed } = await loadFeatures({ dir, identity, dataDir: data, log: (m) => logs.push(m) })
  assert.deepEqual(loaded, ['alpha'])
  assert.deepEqual(failed.map((f) => f.name).sort(), ['Bad_Name', 'broken', 'nofactory'])
  assert.deepEqual(Object.keys(table), ['alpha/ping'])
  const value = await table['alpha/ping'](7)
  assert.equal(value.pong, 7)
  assert.equal(value.dir, join(data, 'openteamily', 'features', 'alpha'))
})

test('native documents include saved appearance without waiting for another feature to initialize', async () => {
  const coordination = mkdtempSync(join(tmpdir(), 'ot-startup-'))
  const gate = join(coordination, 'gate.mjs')
  writeFileSync(gate, 'export const block = Promise.withResolvers(); export const entered = Promise.withResolvers()')
  const latch = await import(pathToFileURL(gate).href)
  const dir = featuresDir({
    settings: "export default () => ({ endpoints: { get: async () => ({settings: {values: {language: 'en',appearance:'dark'}}}) } })",
    deferred: "export default async () => { const g = await import(" + JSON.stringify(pathToFileURL(gate).href) + "); g.entered.resolve(); await g.block.promise; return {endpoints:{}} }",
  })
  const routes = new Map()
  const ctx = {
    connection: {fetch: {register: route => routes.set(route.path, route)}},
    effect: fn => fn(),
  }
  const pagesDir = fileURLToPath(new URL('../../../openteamily/static/', import.meta.url))
  const {features} = apply(ctx, {pagesDir, featuresDir:dir, dataDir:coordination})
  try {
    await latch.entered.promise
    const response = await Promise.race([
      routes.get(PAGE_PATH).fetch(new Request('http://host' + PAGE_PATH + '?path=%2Fchat')),
      new Promise((_, reject) => setTimeout(() => reject(Error('Chat waited for an unrelated feature')), 3000).unref()),
    ])
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-language'), 'en')
    assert.match(await response.text(), /<html data-shell-appearance="dark" data-theme-resolved="dark" data-shell-language="en" lang="en">/)
    const memory = await routes.get(PAGE_PATH).fetch(new Request('http://host' + PAGE_PATH + '?path=%2Fmemory'))
    assert.equal(memory.headers.get('cache-control'), 'no-store')
    assert.match(await memory.text(), /<html data-shell-appearance="dark" data-theme-resolved="dark" data-shell-language="en"/)
  } finally {
    latch.block.resolve()
    assert.deepEqual((await features).loaded, ['settings','deferred'])
  }
})

test('duplicate and malformed endpoints are refused', () => {
  const table = {}
  registerFeature(table, 'one', { endpoints: { a: async () => 1 } })
  assert.throws(() => registerFeature(table, 'one', { endpoints: { a: async () => 2 } }), /duplicate/)
  assert.throws(() => registerFeature(table, 'two', { endpoints: { '../x': async () => 2 } }), /invalid endpoint/)
  assert.throws(() => registerFeature(table, 'two', { endpoints: { ok: 'nope' } }), /invalid endpoint/)
})

test('runtime() resolves once the DS-Bot wrapper attaches, and times out otherwise', async () => {
  detachRuntime()
  await assert.rejects(runtime({ timeoutMs: 20 }), /not attached/)
  const pending = runtime({ timeoutMs: 1000 })
  const rt = { bots: [] }
  const ctx = {}
  attachRuntime({ rt, ctx })
  assert.equal((await pending).rt, rt)
  assert.equal((await runtime()).ctx, ctx)
  detachRuntime()
})

test('dispatch passes payload and call context, maps thrown codes', async () => {
  const dispatch = createDispatch({ endpoints: {
    'x/echo': async (payload, call) => ({ payload, hasRequest: call.request instanceof Request }),
    'x/fail': async () => { throw Object.assign(new Error('nope'), { code: 'x/denied' }) },
  } })
  const call = (body) => dispatch(new Request('http://h/api/openteamily', { method: 'POST', body: JSON.stringify(body) })).then((r) => r.json())
  assert.deepEqual(await call({ endpoint: 'x/echo', payload: { a: 1 } }), { ok: true, value: { payload: { a: 1 }, hasRequest: true } })
  const failed = await call({ endpoint: 'x/fail' })
  assert.equal(failed.error.code, 'x/denied')
})
