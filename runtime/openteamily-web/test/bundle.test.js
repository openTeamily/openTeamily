import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineFeature } from '../featurekit/feature.js'
import { verifyBundle } from '../featurekit/bundle.js'

const IID = 'c'.repeat(32)
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const SPEC = {
  name: 'demo',
  migrations: ['CREATE TABLE items (id TEXT PRIMARY KEY, value TEXT NOT NULL)'],
  importTables: { items: ['id', 'value'] },
}

function bundle(rows, instanceId = IID) {
  const text = JSON.stringify(rows)
  const out = {
    format: 'openteamily-dsbot-import', version: 1, feature: 'demo',
    tables: { items: text }, manifest: { items: { rows: rows.length, sha256: sha(text) } },
  }
  if (instanceId !== null) out.instance_id = instanceId
  return out
}

function host(dataDir) {
  const dir = join(dataDir, 'openteamily', 'features', 'demo')
  mkdirSync(dir, { recursive: true })
  return { name: 'demo', identity: { instanceId: IID }, dataDir, featureDir: () => dir, log: () => {} }
}

function deliver(dataDir, value) {
  const dir = join(dataDir, 'openteamily', 'import')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'demo.bundle')
  writeFileSync(file, JSON.stringify(value))
  return file
}

test('featurekit verifies the bundle instance id; legacy needs an explicit opt-in', () => {
  const rows = [{ id: 'a', value: 'one' }]
  assert.deepEqual(verifyBundle(bundle(rows), SPEC, { instanceId: IID }), { items: rows })
  assert.throws(() => verifyBundle(bundle(rows, 'd'.repeat(32)), SPEC, { instanceId: IID }), /import target mismatch/)
  assert.throws(() => verifyBundle(bundle(rows), SPEC, { instanceId: 'd'.repeat(32) }), /import target mismatch/)
  assert.throws(() => verifyBundle(bundle(rows, null), SPEC, { instanceId: IID }), /import target missing/)
  assert.deepEqual(verifyBundle(bundle(rows, null), SPEC, { instanceId: IID, requireInstanceId: false }), { items: rows })
})

test('featurekit boot import uses the host identity and retries after a target rejection', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ot-bundle-'))
  const wrong = deliver(dataDir, bundle([{ id: 'a', value: 'one' }], 'd'.repeat(32)))
  const first = defineFeature(SPEC)(host(dataDir))
  assert.deepEqual(first.imported.map((item) => item.status), ['rejected'])
  assert.match(first.imported[0].reason, /import target mismatch/)
  assert.equal(existsSync(wrong), true, 'rejected bundle is retained for retry')
  assert.equal(first.store.get('SELECT 1 AS ok FROM items WHERE id=?', 'a'), null)
  first.store.close()

  deliver(dataDir, bundle([{ id: 'a', value: 'one' }]))
  const second = defineFeature(SPEC)(host(dataDir))
  assert.deepEqual(second.imported.map((item) => item.status), ['imported'])
  assert.equal(second.store.get('SELECT value FROM items WHERE id=?', 'a').value, 'one')
  second.store.close()
})

test('featurekit uses manager routing identity when present', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ot-bundle-'))
  deliver(dataDir, bundle([{ id: 'r', value: 'route' }]))
  const feature = defineFeature(SPEC)({ ...host(dataDir), identity: { instanceId: 'e'.repeat(32), routingInstanceId: IID } })
  assert.deepEqual(feature.imported.map((item) => item.status), ['imported'])
  assert.equal(feature.store.get('SELECT value FROM items WHERE id=?', 'r').value, 'route')
  feature.store.close()
})

test('featurekit migrate() also verifies the bundle target', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ot-bundle-'))
  const feature = defineFeature(SPEC)(host(dataDir))
  await assert.rejects(feature.migrate(bundle([{ id: 'c', value: 'three' }], 'd'.repeat(32))), /import target mismatch/)
  const result = await feature.migrate(bundle([{ id: 'c', value: 'three' }]))
  assert.deepEqual(result, { skipped: false, rows: 1 })
  assert.equal(feature.store.get('SELECT value FROM items WHERE id=?', 'c').value, 'three')
  feature.store.close()
})

test('featurekit boot import rejects legacy bundles without an explicit legacy path', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ot-bundle-'))
  const file = deliver(dataDir, bundle([{ id: 'b', value: 'two' }], null))
  const feature = defineFeature(SPEC)(host(dataDir))
  assert.deepEqual(feature.imported.map((item) => item.status), ['rejected'])
  assert.match(feature.imported[0].reason, /import target missing/)
  assert.equal(existsSync(file), true)
  feature.store.close()
})
