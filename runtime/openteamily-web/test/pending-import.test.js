import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { importPending } from '../src/pending-import.js'

test('boot imports only its feature; foreign targets retained; redelivery is idempotent', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ot-import-')), db = new DatabaseSync(':memory:')
  try {
    const dir = join(dataDir, 'openteamily', 'import'); mkdirSync(dir, { recursive: true })
    const host = { dataDir, name: 'agents', identity: { instanceId: 'a'.repeat(32) }, log() {} }
    const file = join(dir, 'agents-v1.bundle'), other = join(dir, 'automations-v1.bundle')
    const text = JSON.stringify({ feature: 'agents', instance_id: host.identity.instanceId })
    writeFileSync(file, text); writeFileSync(other, '{"feature":"automations"}')
    let calls = 0; const migrate = async () => { calls++ }
    await importPending({ host, db, migrate }); assert.equal(calls, 1); assert.equal(existsSync(file), false)
    writeFileSync(file, text); await importPending({ host, db, migrate }); assert.equal(calls, 1)
    assert.equal(existsSync(other), true)
    writeFileSync(file, JSON.stringify({ feature: 'agents', instance_id: 'b'.repeat(32) }))
    const rejected = await importPending({ host, db, migrate })
    assert.equal(rejected[0].status, 'rejected'); assert.equal(existsSync(file), true); assert.equal(calls, 1)
    // This private-volume boot surface explicitly accepts pre-binding legacy files.
    writeFileSync(file, JSON.stringify({ feature: 'agents' }))
    const legacy = await importPending({ host, db, migrate })
    assert.equal(legacy[0].status, 'imported'); assert.equal(existsSync(file), false); assert.equal(calls, 2)
  } finally { db.close(); rmSync(dataDir, { recursive: true, force: true }) }
})
