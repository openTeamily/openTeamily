// The event kinds a subscription may name must equal the kinds the shipped
// notification catalog knows (#2). Bot Social adds a kind, main adds it to
// features/notifications/templates.js, and these assertions are what make the
// events registry fail until it accepts the new kind: the registry keeps no
// unchecked second copy of the list.
import assert from 'node:assert/strict'
import test from 'node:test'
import { boot } from './helpers.js'
import { KINDS as EVENT_KINDS } from '../features/events/registry.js'
import { KINDS as NOTIFICATION_KINDS } from '../features/notifications/templates.js'

const ENDPOINT = 'https://hooks.example.test/openteamily/events'

test('the subscribable kinds equal the shipped notification catalog, in both directions', () => {
  // Sorted, so the comparison is about the set of names: a kind the catalog
  // ships but the registry refuses fails here, and so does a registry entry the
  // catalog does not ship.
  assert.deepEqual([...EVENT_KINDS].sort(), [...NOTIFICATION_KINDS].sort())
})

test('team.owner_transferred is subscribable through the API endpoint', async () => {
  const bot = await boot()
  const result = await bot.endpoint('events/create', {
    name: 'Owner transfer hook', endpoint: ENDPOINT, kinds: ['team.owner_transferred'],
  })
  assert.equal(result.ok, true, JSON.stringify(result.error))
  // Stored as named, and the response carries it back.
  assert.deepEqual(result.value.subscription.kinds, ['team.owner_transferred'])
  const stored = (await bot.endpoint('events/get', { id: result.value.subscription.id })).value.subscription
  assert.deepEqual(stored.kinds, ['team.owner_transferred'])
})

test('control: team.join_request is still accepted', async () => {
  const bot = await boot()
  const result = await bot.endpoint('events/create', {
    name: 'Join request hook', endpoint: ENDPOINT, kinds: ['team.join_request'],
  })
  assert.equal(result.ok, true, JSON.stringify(result.error))
  assert.deepEqual(result.value.subscription.kinds, ['team.join_request'])
})

test('a kind the catalog does not ship is still refused', async () => {
  const bot = await boot()
  const result = await bot.endpoint('events/create', {
    name: 'Bogus hook', endpoint: ENDPOINT, kinds: ['team.owner_deleted'],
  })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'events/invalid')
  assert.equal(result.error.message, 'Unknown event kind: team.owner_deleted')
})
