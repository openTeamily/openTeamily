// Web Push subscription registry inside this user's DS-Bot (#466): register one
// browser endpoint per device, list/read only this account's devices, revoke,
// and a bounded per-account row count. No VAPID signing, payload encryption or
// delivery lives here; the row is only where a notice would go.
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { boot, volume } from './helpers.js'
import { openStore } from '../featurekit/store.js'

const endpointFor = (n) => `https://push.example.test/send/${n}`
const key = (p256dh = 'BOrn0dPublicKeyMaterialForTestsOnly-0123456789', auth = 'auth-secret-material-0123456789') => ({ p256dh, auth })
const call = (bot, op, payload) => bot.endpoint(`push/${op}`, payload)
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
const featureStore = (bot) => openStore(join(bot.vol.data, 'openteamily', 'features', 'push', 'push.sqlite3'))
const rows = (bot) => {
  const store = featureStore(bot)
  try {
    return store.all('SELECT * FROM push_subscriptions ORDER BY endpoint')
  } finally {
    store.close()
  }
}

test('the push registry loads in this DS-Bot and keeps its own feature directory', async () => {
  const bot = await boot()
  assert.ok(bot.features.loaded.includes('push'), JSON.stringify(bot.features.failed))
  assert.ok(existsSync(join(bot.vol.data, 'openteamily', 'features', 'push', 'push.sqlite3')))
})

test('a device registers once per endpoint and re-registering updates it in place', async () => {
  const bot = await boot()
  const first = await value(bot, 'register', { endpoint: endpointFor(1), ...key(), user_agent: 'Mozilla/5.0 test browser' })
  assert.equal(first.subscription.user_id, 'owner')
  assert.equal(first.subscription.endpoint, endpointFor(1))
  assert.equal(first.subscription.p256dh, key().p256dh)
  assert.equal(first.subscription.user_agent, 'Mozilla/5.0 test browser')
  assert.equal(typeof first.subscription.id, 'string')

  // The caller cannot name the account: the row always belongs to this owner.
  const renamed = await value(bot, 'register', { endpoint: endpointFor(2), ...key(), user_id: 'someone-else' })
  assert.equal(renamed.subscription.user_id, 'owner')

  const rotated = await value(bot, 'register', {
    endpoint: endpointFor(1), p256dh: 'BRotatedPublicKeyMaterial-9876543210', auth: 'rotated-auth-material-9876543210',
  })
  assert.equal(rotated.subscription.id, first.subscription.id)
  assert.equal(rotated.subscription.created, first.subscription.created)
  assert.ok(rotated.subscription.updated >= first.subscription.updated)
  assert.equal(rotated.subscription.p256dh, 'BRotatedPublicKeyMaterial-9876543210')
  // Re-registering replaces the record instead of merging stale fields.
  assert.equal(rotated.subscription.user_agent, null)

  const listed = await value(bot, 'list', {})
  assert.deepEqual(listed.items.map((item) => item.endpoint).sort(), [endpointFor(1), endpointFor(2)])
  assert.equal(rows(bot).length, 2)
})

test('listing and reading expose only this account\'s devices', async () => {
  const bot = await boot()
  const mine = await value(bot, 'register', { endpoint: endpointFor(1), ...key() })
  await value(bot, 'register', { endpoint: endpointFor(2), ...key() })

  // A row another account wrote in this file must stay invisible and unreadable.
  const store = featureStore(bot)
  try {
    store.run(
      'INSERT INTO push_subscriptions (id,user_id,endpoint,p256dh,auth,user_agent,created,updated) VALUES (?,?,?,?,?,?,?,?)',
      'foreign-row', 'another-user', endpointFor(99), 'BForeignKeyMaterial-0000000000000000', 'foreign-auth-material', null, 1, 1,
    )
  } finally {
    store.close()
  }

  const listed = await value(bot, 'list', {})
  assert.equal(listed.items.length, 2)
  assert.ok(listed.items.every((item) => item.user_id === 'owner'))

  await refused(bot, 'get', { id: 'foreign-row' }, 'push/not-found')
  await refused(bot, 'get', { id: 'no-such-row' }, 'push/not-found')
  const read = await value(bot, 'get', { id: mine.subscription.id })
  assert.equal(read.subscription.endpoint, endpointFor(1))

  // A second account is a second volume: nothing crosses over.
  const other = await boot(volume())
  assert.deepEqual((await value(other, 'list', {})).items, [])
  await value(other, 'register', { endpoint: endpointFor(1), ...key() })
  const otherAgain = await value(other, 'list', {})
  assert.equal(otherAgain.items.length, 1)
  assert.equal(otherAgain.items[0].user_id, 'owner')
  assert.notEqual(otherAgain.items[0].id, mine.subscription.id)
  assert.equal(rows(bot).length, 3)
})

test('revoking removes the device immediately and revoking again is idempotent', async () => {
  const bot = await boot()
  const registered = await value(bot, 'register', { endpoint: endpointFor(1), ...key() })
  const id = registered.subscription.id

  const revoked = await value(bot, 'revoke', { id })
  assert.equal(revoked.revoked, true)
  assert.deepEqual((await value(bot, 'list', {})).items, [])
  await refused(bot, 'get', { id }, 'push/not-found')

  const again = await value(bot, 'revoke', { id })
  assert.equal(again.revoked, false)
  assert.equal(rows(bot).length, 0)

  // Revoking another account's row is a no-op, never a delete.
  const store = featureStore(bot)
  try {
    store.run(
      'INSERT INTO push_subscriptions (id,user_id,endpoint,p256dh,auth,user_agent,created,updated) VALUES (?,?,?,?,?,?,?,?)',
      'foreign-row', 'another-user', endpointFor(99), 'BForeignKeyMaterial-0000000000000000', 'foreign-auth-material', null, 1, 1,
    )
  } finally {
    store.close()
  }
  const foreign = await value(bot, 'revoke', { id: 'foreign-row' })
  assert.equal(foreign.revoked, false)
  assert.equal(rows(bot).length, 1)
})

test('invalid endpoints and key material are refused and leave no row behind', async () => {
  const bot = await boot()
  const badEndpoints = [
    undefined,
    42,
    '',
    'http://push.example.test/send/1',
    'push.example.test/send/1',
    'https://user:pass@push.example.test/send/1',
    'https://push.example.test/send/ 1',
    'https://push.example.test/send/\n1',
    'https://push.example.test/' + 'a'.repeat(2048),
  ]
  for (const endpoint of badEndpoints) {
    await refused(bot, 'register', { endpoint, ...key() }, 'push/invalid')
  }
  const badKeys = [
    { p256dh: undefined, auth: 'auth' },
    { p256dh: '', auth: 'auth' },
    { p256dh: 'B'.repeat(1025), auth: 'auth' },
    { p256dh: 'Bkey', auth: undefined },
    { p256dh: 'Bkey', auth: '' },
    { p256dh: 'Bkey', auth: 'a'.repeat(1025) },
    { p256dh: 'Bkey\n', auth: 'auth' },
  ]
  for (const material of badKeys) {
    await refused(bot, 'register', { endpoint: endpointFor(1), ...material }, 'push/invalid')
  }
  await refused(bot, 'register', { endpoint: endpointFor(1), ...key(), user_agent: 'u'.repeat(513) }, 'push/invalid')
  await refused(bot, 'register', { endpoint: endpointFor(1), ...key(), user_agent: 7 }, 'push/invalid')
  await refused(bot, 'get', { id: '' }, 'push/not-found')
  await refused(bot, 'revoke', { id: 3 }, 'push/not-found')

  assert.equal(rows(bot).length, 0)
})

test('one account holds at most 20 devices and can replace or free a slot', async () => {
  const bot = await boot()
  const registered = []
  for (let index = 0; index < 20; index += 1) {
    registered.push((await value(bot, 'register', { endpoint: endpointFor(index), ...key() })).subscription)
  }
  assert.equal(rows(bot).length, 20)

  await refused(bot, 'register', { endpoint: endpointFor(20), ...key() }, 'push/quota')
  assert.equal(rows(bot).length, 20)

  // An existing endpoint is still updatable at the cap.
  const updated = await value(bot, 'register', { endpoint: endpointFor(0), ...key('BRotatedAtCap-0000000000000000', 'rotated-auth') })
  assert.equal(updated.subscription.id, registered[0].id)
  assert.equal(rows(bot).length, 20)

  await value(bot, 'revoke', { id: registered[0].id })
  const replacement = await value(bot, 'register', { endpoint: endpointFor(20), ...key() })
  assert.equal(replacement.subscription.endpoint, endpointFor(20))
  assert.equal(rows(bot).length, 20)
})
