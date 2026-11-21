// Versioned consent ledger inside this user's DS-Bot (#489): documents,
// grant/withdraw per version, current status, require-all gates, history and
// hashed evidence. Every record belongs to this DS-Bot's owner; another
// volume never sees it.
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { boot, volume } from './helpers.js'

const nowSec = () => Math.floor(Date.now() / 1000)
const call = (bot, op, payload) => bot.endpoint(`consents/${op}`, payload)
const value = async (bot, op, payload) => {
  const result = await call(bot, op, payload)
  assert.equal(result.ok, true, JSON.stringify(result.error))
  return result.value
}
const refused = async (bot, op, payload, code) => {
  const result = await call(bot, op, payload)
  assert.equal(result.ok, false, `expected ${op} to be refused`)
  assert.equal(result.error.code, code, JSON.stringify(result.error))
  return result.error
}

test('the consent ledger loads in this DS-Bot and keeps its own feature directory', async () => {
  const bot = await boot()
  assert.ok(bot.features.loaded.includes('consents'), JSON.stringify(bot.features.failed))
  assert.ok(existsSync(join(bot.vol.data, 'openteamily', 'features', 'consents', 'consents.sqlite3')))
})

test('a document is registered once per effective time and becomes current only when effective', async () => {
  const bot = await boot()
  const at = nowSec()
  const first = await value(bot, 'register', { kind: 'terms', version: '1.0.0', effective: at - 1000 })
  assert.deepEqual(Object.keys(first.document).sort(), ['created', 'effective', 'kind', 'version'])
  assert.equal(first.document.effective, at - 1000)
  const replay = await value(bot, 'register', { kind: 'terms', version: '1.0.0', effective: at - 1000 })
  assert.deepEqual(replay.document, first.document)
  await refused(bot, 'register', { kind: 'terms', version: '1.0.0', effective: at }, 'consents/document-conflict')

  const future = await value(bot, 'register', { kind: 'terms', version: '2.0.0', effective: at + 3600 })
  assert.equal(future.document.version, '2.0.0')
  assert.equal((await value(bot, 'document', { kind: 'terms' })).document.version, '1.0.0')
  assert.equal((await value(bot, 'document', { kind: 'terms', at: at + 3600 })).document.version, '2.0.0')
  assert.equal((await value(bot, 'document', { kind: 'privacy' })).document, null)

  await refused(bot, 'register', { kind: 'other', version: '1.0.0', effective: at }, 'consents/unknown-kind')
  await refused(bot, 'register', { kind: 'terms', version: '1.0.0/other', effective: at }, 'consents/invalid')
  await refused(bot, 'register', { kind: 'terms', version: '1.0.0', effective: '1000' }, 'consents/invalid')
})

test('grant, withdraw and regrant replace the record in place and current status follows it', async () => {
  const bot = await boot()
  const at = nowSec()
  await value(bot, 'register', { kind: 'terms', version: '1.0.0', effective: at - 1000 })
  const granted = await value(bot, 'grant', { kind: 'terms', version: '1.0.0', method: 'web', evidence: { ticket: 'abc' } })
  assert.equal(granted.record.status, 'granted')
  assert.equal(granted.record.method, 'web')
  assert.equal(granted.record.user_id, 'owner')
  assert.match(granted.record.evidence_hash, /^[0-9a-f]{64}$/)
  let status = await value(bot, 'status', { kind: 'terms' })
  assert.equal(status.granted, true)
  assert.equal(status.required_version, '1.0.0')
  assert.equal(status.record.id, granted.record.id)

  const withdrawn = await value(bot, 'withdraw', { kind: 'terms', version: '1.0.0' })
  assert.equal(withdrawn.record.status, 'withdrawn')
  assert.equal((await value(bot, 'status', { kind: 'terms' })).granted, false)

  const again = await value(bot, 'grant', { kind: 'terms', version: '1.0.0', method: 'api', evidence: { ticket: 'def' } })
  assert.equal(again.record.id, granted.record.id)
  assert.equal(again.record.created, granted.record.created)
  assert.equal(again.record.method, 'api')
  assert.notEqual(again.record.evidence_hash, granted.record.evidence_hash)
  assert.equal((await value(bot, 'status', { kind: 'terms' })).granted, true)

  await refused(bot, 'withdraw', { kind: 'terms', version: '9.9.9' }, 'consents/record-not-found')
  await refused(bot, 'grant', { kind: 'terms', version: '9.9.9' }, 'consents/document-not-registered')
})

test('a version bump requires a new grant, measured at the document effective time', async () => {
  const { openStore } = await import('../featurekit/store.js')
  const ledger = await import('../features/consents/ledger.js')
  const store = openStore(join(volume().data, 'ledger.sqlite3'))
  ledger.migrate(store)
  ledger.registerDocument(store, 'terms', '1.0.0', 1000, 900)
  ledger.grant(store, 'owner', 'terms', '1.0.0', 1100)
  ledger.registerDocument(store, 'terms', '2.0.0', 2000, 1200)

  const old = ledger.currentStatus(store, 'owner', 'terms', 1500)
  assert.equal(old.required_version, '1.0.0')
  assert.equal(old.granted, true)
  const current = ledger.currentStatus(store, 'owner', 'terms', 2000)
  assert.equal(current.required_version, '2.0.0')
  assert.equal(current.record.version, '1.0.0')
  assert.equal(current.granted, false)
  assert.deepEqual(ledger.requireAll(store, 'owner', ['terms'], 2000), ['terms'])

  ledger.grant(store, 'owner', 'terms', '2.0.0', 2100)
  assert.equal(ledger.currentStatus(store, 'owner', 'terms', 2100).granted, true)
  assert.deepEqual(ledger.requireAll(store, 'owner', ['terms'], 2100), [])

  // Without a time, the newest registered document is the required version.
  ledger.registerDocument(store, 'terms', '3.0.0', 9000, 2200)
  assert.equal(ledger.currentStatus(store, 'owner', 'terms').required_version, '3.0.0')
  assert.equal(ledger.currentStatus(store, 'owner', 'terms').granted, false)
})

test('require-all reports missing kinds once, in the requested order', async () => {
  const { openStore } = await import('../featurekit/store.js')
  const ledger = await import('../features/consents/ledger.js')
  const store = openStore(join(volume().data, 'ledger.sqlite3'))
  ledger.migrate(store)
  for (const kind of ['terms', 'privacy', 'marketing']) ledger.registerDocument(store, kind, '1.0.0', 1000, 900)
  ledger.grant(store, 'owner', 'terms', '1.0.0', 1100)
  ledger.grant(store, 'owner', 'privacy', '1.0.0', 1200)
  assert.deepEqual(ledger.requireAll(store, 'owner', ['terms', 'privacy'], 1300), [])
  assert.deepEqual(ledger.requireAll(store, 'owner', ['terms', 'privacy', 'marketing'], 1300), ['marketing'])
  assert.deepEqual(ledger.requireAll(store, 'owner', ['terms', 'recording'], 1300), ['recording'])
  assert.deepEqual(ledger.requireAll(store, 'owner', ['marketing', 'marketing'], 1300), ['marketing'])
  ledger.grant(store, 'owner', 'marketing', '1.0.0', 1400)
  ledger.withdraw(store, 'owner', 'marketing', '1.0.0', 1500)
  assert.deepEqual(ledger.requireAll(store, 'owner', ['marketing'], 1500), ['marketing'])
  assert.deepEqual(ledger.requireAll(store, 'owner', [], 1500), [])
  assert.throws(() => ledger.requireAll(store, 'owner', 'terms', 1500), /iterable/)
  assert.throws(() => ledger.requireAll(store, 'owner', ['terms', 'not-a-kind'], 1500), /Unknown consent kind/)
})

test('history is newest update first when the ledger is driven with explicit times', async () => {
  const { openStore } = await import('../featurekit/store.js')
  const ledger = await import('../features/consents/ledger.js')
  const store = openStore(join(volume().data, 'ledger.sqlite3'))
  ledger.migrate(store)
  for (const kind of ['terms', 'privacy']) ledger.registerDocument(store, kind, '1.0.0', 1000, 900)
  const terms = ledger.grant(store, 'owner', 'terms', '1.0.0', 1100)
  const privacy = ledger.grant(store, 'owner', 'privacy', '1.0.0', 1200)
  const again = ledger.grant(store, 'owner', 'terms', '1.0.0', 1300)
  assert.deepEqual(ledger.listHistory(store, 'owner').map((row) => row.id), [again.id, privacy.id])
  assert.deepEqual(ledger.listHistory(store, 'owner', 'terms').map((row) => row.version), ['1.0.0'])
  assert.deepEqual(ledger.listHistory(store, 'owner', 'marketing'), [])
  assert.equal(again.id, terms.id)
  assert.equal(again.created, 1100)
  assert.equal(again.updated, 1300)
})

test('history is newest first, kind-filtered and never leaves this DS-Bot', async () => {
  const bot = await boot()
  const at = nowSec()
  for (const kind of ['terms', 'privacy']) await value(bot, 'register', { kind, version: '1.0.0', effective: at - 1000 })
  await value(bot, 'grant', { kind: 'terms', version: '1.0.0' })
  await value(bot, 'grant', { kind: 'privacy', version: '1.0.0' })
  const history = await value(bot, 'history', {})
  assert.deepEqual(history.items.map((row) => row.kind).sort(), ['privacy', 'terms'])
  assert.deepEqual((await value(bot, 'history', { kind: 'privacy' })).items.map((row) => row.kind), ['privacy'])
  assert.deepEqual((await value(bot, 'history', { kind: 'marketing' })).items, [])

  const other = await boot()
  assert.deepEqual((await value(other, 'history', {})).items, [])
  assert.equal((await value(other, 'status', { kind: 'terms' })).record, null)
  assert.equal((await value(other, 'status', { kind: 'terms' })).granted, false)
})

test('evidence is hashed; raw IP and user agent never reach the database', async () => {
  const bot = await boot()
  const at = nowSec()
  await value(bot, 'register', { kind: 'terms', version: '1.0.0', effective: at - 1000 })
  const evidence = { ip: '203.0.113.9', user_agent: 'Synthetic Consent Test/1.0', checkbox: true, nested: { b: 2, a: 1 } }
  const granted = await value(bot, 'grant', { kind: 'terms', version: '1.0.0', evidence })
  const { createHash } = await import('node:crypto')
  const canonical = JSON.stringify({ checkbox: true, ip: '203.0.113.9', nested: { a: 1, b: 2 }, user_agent: 'Synthetic Consent Test/1.0' })
  assert.equal(granted.record.evidence_hash, createHash('sha256').update(canonical, 'utf8').digest('hex'))
  const { openStore } = await import('../featurekit/store.js')
  const store = openStore(join(bot.vol.data, 'openteamily', 'features', 'consents', 'consents.sqlite3'))
  const rows = store.all('SELECT * FROM user_consents')
  assert.equal(rows.length, 1)
  assert.deepEqual(Object.keys(rows[0]).sort(), ['created', 'evidence_hash', 'id', 'kind', 'method', 'status', 'updated', 'user_id', 'version'])
  const dump = JSON.stringify(rows)
  assert.equal(dump.includes('203.0.113.9'), false)
  assert.equal(dump.includes('Synthetic Consent Test/1.0'), false)
  assert.equal((await value(bot, 'grant', { kind: 'terms', version: '1.0.0' })).record.evidence_hash, null)
})

test('invalid kinds, versions, methods, times and evidence are refused and write nothing', async () => {
  const bot = await boot()
  const at = nowSec()
  await value(bot, 'register', { kind: 'terms', version: '1.0.0', effective: at - 1000 })
  for (const kind of ['', 'Terms', 'other', null, true]) {
    await refused(bot, 'register', { kind, version: '1.0.0', effective: at }, 'consents/unknown-kind')
    await refused(bot, 'document', { kind }, 'consents/unknown-kind')
    await refused(bot, 'grant', { kind, version: '1.0.0' }, 'consents/unknown-kind')
    await refused(bot, 'withdraw', { kind, version: '1.0.0' }, 'consents/unknown-kind')
    await refused(bot, 'status', { kind }, 'consents/unknown-kind')
    if (kind !== null) await refused(bot, 'history', { kind }, 'consents/unknown-kind')
  }
  for (const version of ['', '..', '1.0.0/other', 'x'.repeat(65), 1, null, true]) {
    await refused(bot, 'register', { kind: 'terms', version, effective: at }, 'consents/invalid')
    await refused(bot, 'grant', { kind: 'terms', version }, 'consents/invalid')
  }
  for (const method of ['', 'web app', 'x'.repeat(33), null, 1]) {
    await refused(bot, 'grant', { kind: 'terms', version: '1.0.0', method }, 'consents/invalid')
  }
  for (const effective of [null, true, -1, '1000', 1.5]) {
    await refused(bot, 'register', { kind: 'terms', version: '2.0.0', effective }, 'consents/invalid')
  }
  // JSON transport cannot even carry these, so the guard is asserted on the ledger itself.
  const ledger = await import('../features/consents/ledger.js')
  for (const evidence of [{ value: Number.NaN }, { value: () => 1 }, { value: 1n }]) {
    assert.throws(() => ledger.evidenceHash(evidence), /Invalid consent evidence/)
  }
  await refused(bot, 'grant', { kind: 'terms', version: '1.0.0', evidence: { note: 'x'.repeat(8192) } }, 'consents/evidence-too-large')
  await refused(bot, 'require-all', { kinds: 'terms', at }, 'consents/invalid')
  await refused(bot, 'require-all', { kinds: ['terms', 'not-a-kind'], at }, 'consents/unknown-kind')

  const { openStore } = await import('../featurekit/store.js')
  const store = openStore(join(bot.vol.data, 'openteamily', 'features', 'consents', 'consents.sqlite3'))
  assert.equal(store.all('SELECT * FROM user_consents').length, 0)
  assert.equal(store.all('SELECT * FROM consent_documents').length, 1)
})

test('the caller cannot write a record for another user: identity is this DS-Bot owner', async () => {
  const bot = await boot()
  const at = nowSec()
  await value(bot, 'register', { kind: 'terms', version: '1.0.0', effective: at - 1000 })
  const granted = await value(bot, 'grant', { kind: 'terms', version: '1.0.0', user_id: 'someone-else' })
  assert.equal(granted.record.user_id, 'owner')
  const status = await value(bot, 'status', { kind: 'terms', user_id: 'someone-else' })
  assert.equal(status.record.user_id, 'owner')
  assert.equal(status.granted, true)
})
