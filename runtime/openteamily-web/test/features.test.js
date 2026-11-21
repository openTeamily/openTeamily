import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
