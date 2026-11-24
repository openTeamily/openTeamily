// Outbound event subscriptions inside this user's DS-Bot (#490): which event
// kinds a future outbox should deliver where, per-subscription filters, and an
// idempotent delivery record. This slice stores and matches only. It does not
// send HTTP, sign payloads, retry, queue an outbox or accept inbound webhooks.
//
// Two hard rules this slice can already enforce and asserts here:
// - the endpoint must start as a public HTTPS URL: loopback, RFC1918, link-local,
//   unique-local, .local and bare private-IP literals are refused now. Because a
//   host name can resolve to a private address later (DNS rebinding), the outbox
//   slice MUST validate the resolved address again immediately before delivery;
//   that recheck is a hard precondition of delivery, not of this registry.
// - secret_ref is an opaque pointer held elsewhere. A plaintext secret is never
//   accepted, never stored and never echoed.
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { boot } from './helpers.js'
import { openStore } from '../featurekit/store.js'
import { KINDS } from '../features/events/registry.js'

// Every registered kind is accepted here. Whether the registry's list matches
// the kinds Bot Social emits is checked against the shipped notification
// catalog in test/event-kind-catalog.test.js, so this suite keeps no copy of
// that list of its own.
const S_KINDS = [...KINDS]

const ENDPOINT = 'https://hooks.example.test/openteamily/events'
const call = (bot, op, payload) => bot.endpoint(`events/${op}`, payload)
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
const featureStore = (bot) => openStore(join(bot.vol.data, 'openteamily', 'features', 'events', 'events.sqlite3'))
const rows = (bot) => {
  const store = featureStore(bot)
  try {
    return store.all('SELECT * FROM event_subscriptions ORDER BY name')
  } finally {
    store.close()
  }
}

test('the event registry loads in this DS-Bot and keeps its own feature directory', async () => {
  const bot = await boot()
  assert.ok(bot.features.loaded.includes('events'), JSON.stringify(bot.features.failed))
  assert.ok(existsSync(join(bot.vol.data, 'openteamily', 'features', 'events', 'events.sqlite3')))
})

test('a subscription is created, read, updated, disabled, listed and deleted', async () => {
  const bot = await boot()
  const created = (await value(bot, 'create', {
    name: 'Deploy hook', endpoint: ENDPOINT, kinds: ['artifact.shared', 'artifact.shared', 'meeting.shared'],
    secret_ref: 'vault://ot/hooks/deploy', filters: { actor_id: 'alice' },
  })).subscription
  assert.equal(created.owner_id, 'owner')
  assert.equal(created.name, 'Deploy hook')
  assert.equal(created.endpoint, ENDPOINT)
  assert.equal(created.secret_ref, 'vault://ot/hooks/deploy')
  assert.deepEqual(created.kinds, ['artifact.shared', 'meeting.shared'])
  assert.deepEqual(created.filters, { actor_id: 'alice' })
  assert.equal(created.enabled, true)
  assert.equal(created.last_delivery, null)
  assert.equal(typeof created.created, 'number')
  // The caller cannot name the account: every row belongs to this owner.
  const other = (await value(bot, 'create', {
    name: 'Social hook', endpoint: ENDPOINT, kinds: ['team.run_shared'], owner_id: 'someone-else', user_id: 'someone-else',
  })).subscription
  assert.equal(other.owner_id, 'owner')

  assert.deepEqual((await value(bot, 'get', { id: created.id })).subscription, created)
  const listed = (await value(bot, 'list', {})).items
  assert.deepEqual(listed.map((item) => item.name).sort(), ['Deploy hook', 'Social hook'])
  assert.deepEqual((await value(bot, 'list', { kinds: ['meeting.shared'] })).items.map((item) => item.id), [created.id])

  const updated = (await value(bot, 'update', {
    id: created.id,
    changes: {
      name: 'Deploy hook v2', endpoint: 'https://hooks2.example.test/e',
      kinds: ['artifact.shared'], filters: { severity: { in: ['high', 'critical'] } },
      secret_ref: 'vault://ot/hooks/deploy-v2', enabled: false,
    },
  })).subscription
  assert.equal(updated.name, 'Deploy hook v2')
  assert.equal(updated.endpoint, 'https://hooks2.example.test/e')
  assert.deepEqual(updated.kinds, ['artifact.shared'])
  assert.deepEqual(updated.filters, { severity: { in: ['high', 'critical'] } })
  assert.equal(updated.secret_ref, 'vault://ot/hooks/deploy-v2')
  assert.equal(updated.enabled, false)

  const disabled = (await value(bot, 'disable', { id: created.id })).subscription
  assert.equal(disabled.enabled, false)
  assert.equal((await value(bot, 'delete', { id: created.id })).deleted, true)
  assert.equal((await value(bot, 'delete', { id: created.id })).deleted, false)
  await refused(bot, 'get', { id: created.id }, 'events/not-found')
  assert.deepEqual((await value(bot, 'list', {})).items.map((item) => item.id), [other.id])
})

test('only public HTTPS endpoints are accepted, including the private-address literals', async () => {
  const bot = await boot()
  const refusedEndpoints = [
    'http://hooks.example.test/e',
    'ftp://hooks.example.test/e',
    'https:///missing-host',
    'https://user:password@hooks.example.test/e',
    'https://hooks.example.test/e#fragment',
    'https://hooks.example.test/e\nInjected: yes',
    'https://hooks.example.test/' + 'a'.repeat(2100),
    'https://127.0.0.1/e', 'https://127.15.0.9/e',
    'https://10.0.0.1/e', 'https://10.255.255.254/e',
    'https://172.16.0.1/e', 'https://172.31.255.255/e',
    'https://192.168.0.1/e', 'https://192.168.255.254/e',
    'https://169.254.169.254/latest/meta-data', 'https://0.0.0.0/e',
    'https://[::1]/e', 'https://[::ffff:127.0.0.1]/e',
    'https://[fc00::1]/e', 'https://[fd12:3456:789a::1]/e', 'https://[fe80::1]/e',
    'https://localhost/e', 'https://LOCALHOST/e', 'https://api.local/e', 'https://hooks.local./e',
  ]
  for (const endpoint of refusedEndpoints) {
    await refused(bot, 'create', { name: 'SSRF ' + endpoint.slice(0, 40), endpoint, kinds: ['artifact.shared'] }, 'events/invalid')
  }
  // Public hosts and public IP literals still work.
  const publicHost = (await value(bot, 'create', { name: 'Public host', endpoint: ENDPOINT, kinds: ['artifact.shared'] })).subscription
  const publicIp = (await value(bot, 'create', { name: 'Public IP', endpoint: 'https://8.8.8.8/hook', kinds: ['artifact.shared'] })).subscription
  assert.equal(publicHost.endpoint, ENDPOINT)
  assert.equal(publicIp.endpoint, 'https://8.8.8.8/hook')

  // A later update runs the same check; nothing is written on refusal.
  await refused(bot, 'update', { id: publicHost.id, changes: { endpoint: 'https://192.168.1.10/e' } }, 'events/invalid')
  assert.equal((await value(bot, 'get', { id: publicHost.id })).subscription.endpoint, ENDPOINT)
})

test('kinds must come from the kinds Bot Social emits today; unknown kinds are refused', async () => {
  const bot = await boot()
  for (const kind of S_KINDS) {
    const created = (await value(bot, 'create', {
      name: 'Hook ' + kind, endpoint: ENDPOINT, kinds: [kind],
    })).subscription
    assert.deepEqual(created.kinds, [kind])
  }
  for (const kinds of [
    [],
    ['artifact.created'],
    ['artifact.shared', 'not.a.kind'],
    'artifact.shared',
    [123],
  ]) {
    await refused(bot, 'create', { name: 'Bad kinds', endpoint: ENDPOINT, kinds }, 'events/invalid')
  }
  // Every registered kind can be subscribed at once; the stored list cannot be
  // renamed to an unknown kind later.
  assert.equal((await value(bot, 'create', { name: 'All kinds', endpoint: ENDPOINT, kinds: S_KINDS })).subscription.kinds.length, S_KINDS.length)
  const first = (await value(bot, 'list', {})).items[0]
  await refused(bot, 'update', { id: first.id, changes: { kinds: ['artifact.created'] } }, 'events/invalid')
})

test('filters normalize to a stable JSON and only accept scalar values or an "in" list', async () => {
  const bot = await boot()
  const first = (await value(bot, 'create', {
    name: 'Filtered A', endpoint: ENDPOINT, kinds: ['artifact.shared'],
    filters: { severity: { in: ['high', 'critical'] }, actor_id: 'alice', active: true, retries: 3 },
  })).subscription
  // Same input in a different key order is one stored shape; this is the form
  // the event matcher and a future outbox will compare.
  const second = (await value(bot, 'create', {
    name: 'Filtered B', endpoint: ENDPOINT, kinds: ['artifact.shared'],
    filters: { retries: 3, active: true, actor_id: 'alice', severity: { in: ['high', 'critical'] } },
  })).subscription
  assert.deepEqual(first.filters, second.filters)
  const store = featureStore(bot)
  let stored
  try {
    stored = store.all('SELECT id, filters FROM event_subscriptions ORDER BY name')
  } finally {
    store.close()
  }
  assert.equal(stored[0].filters, stored[1].filters)
  assert.equal(stored[0].filters, '{"active":true,"actor_id":"alice","retries":3,"severity":{"in":["high","critical"]}}')

  const manyKeys = {}
  for (let index = 0; index < 21; index += 1) manyKeys['k' + index] = 'x'
  for (const filters of [
    'not-an-object',
    { key: ['x'] },
    { key: { other: ['x'] } },
    { key: { in: [] } },
    { key: { in: list(51) } },
    { ['k'.repeat(65)]: 'x' },
    { key: 'x'.repeat(257) },
    { key: { nested: true } },
    manyKeys,
  ]) {
    await refused(bot, 'create', { name: 'Bad filters', endpoint: ENDPOINT, kinds: ['artifact.shared'], filters }, 'events/invalid')
  }
})

test('secret_ref is an opaque reference: no plaintext secret is accepted, stored or echoed', async () => {
  const bot = await boot()
  const created = (await value(bot, 'create', {
    name: 'Secret hook', endpoint: ENDPOINT, kinds: ['meeting.shared'],
    secret_ref: 'vault://ot/workspaces/w/hooks/1',
  })).subscription
  assert.equal(created.secret_ref, 'vault://ot/workspaces/w/hooks/1')
  assert.deepEqual(Object.keys(created).sort(), [
    'created', 'enabled', 'endpoint', 'filters', 'id', 'kinds', 'last_delivery', 'name', 'owner_id', 'secret_ref', 'updated',
  ])
  // A value that looks like a secret is refused instead of being stored as a reference.
  for (const secret_ref of ('sk-live-0123456789abcdef', 'BOrn0dSecretMaterialForTestsOnly0123456789', 'plainsecret')) {
    await refused(bot, 'create', { name: 'Plaintext', endpoint: ENDPOINT, kinds: ['meeting.shared'], secret_ref }, 'events/invalid')
  }
  // A literal secret field is an unsupported field, in create and in update.
  await refused(bot, 'create', { name: 'Plaintext', endpoint: ENDPOINT, kinds: ['meeting.shared'], secret: 'plaintext-value' }, 'events/invalid')
  await refused(bot, 'update', { id: created.id, changes: { secret: 'plaintext-value' } }, 'events/invalid')
  const store = featureStore(bot)
  try {
    const columns = store.all('PRAGMA table_info(event_subscriptions)').map((row) => row.name)
    assert.ok(!columns.includes('secret') && !columns.includes('secret_value') && !columns.includes('api_key'))
    const row = store.get('SELECT secret_ref FROM event_subscriptions WHERE id=?', created.id)
    assert.equal(row.secret_ref, 'vault://ot/workspaces/w/hooks/1')
  } finally {
    store.close()
  }
  assert.equal((await value(bot, 'update', { id: created.id, changes: { secret_ref: null } })).subscription.secret_ref, null)
})

test('a secret_ref that carries credentials or a token query is refused, not stored and not echoed', async () => {
  const bot = await boot()
  const created = (await value(bot, 'create', {
    name: 'Credential hook', endpoint: ENDPOINT, kinds: ['meeting.shared'],
    secret_ref: 'vault://ot/workspaces/w/hooks/2',
  })).subscription
  // Hard rule 2 covers the reference itself: a pointer that embeds userinfo or
  // a secret-carrying query would be stored verbatim and echoed by view().
  const embedded = [
    'https://user:pass@vault.example.test/x',
    'vault://user:pass@vault/x',
    's3://AKIAIOSFODNN7EXAMPLE:wJalrXUtnFEMI@bucket/x',
    'https://vault.example.test/x?token=ghp_0123456789abcdefghij',
    'vault://ot/hooks/x?password=hunter2',
    'vault://ot/hooks/x#hunter2',
  ]
  for (const secret_ref of embedded) {
    await refused(bot, 'create', { name: 'Embedded', endpoint: ENDPOINT, kinds: ['meeting.shared'], secret_ref }, 'events/invalid')
    await refused(bot, 'update', { id: created.id, changes: { secret_ref } }, 'events/invalid')
  }
  // The pointer itself is unchanged by those refusals and nothing was inserted.
  assert.equal((await value(bot, 'get', { id: created.id })).subscription.secret_ref, 'vault://ot/workspaces/w/hooks/2')
  assert.deepEqual(rows(bot).map((row) => row.secret_ref), ['vault://ot/workspaces/w/hooks/2'])
  // A plain pointer keeps working.
  assert.equal(
    (await value(bot, 'update', { id: created.id, changes: { secret_ref: 'vault://ot/hooks/x' } })).subscription.secret_ref,
    'vault://ot/hooks/x',
  )
})

test('matching intersects kind and filters, excludes disabled rows and never leaks another owner', async () => {
  const bot = await boot()
  const filtered = (await value(bot, 'create', {
    name: 'Filtered', endpoint: ENDPOINT, kinds: ['artifact.shared'],
    filters: { actor_id: 'u1', severity: { in: ['high', 'critical'] }, active: true },
  })).subscription
  const unfiltered = (await value(bot, 'create', { name: 'Unfiltered', endpoint: ENDPOINT, kinds: ['artifact.shared'] })).subscription
  const otherKind = (await value(bot, 'create', { name: 'Meetings', endpoint: ENDPOINT, kinds: ['meeting.shared'] })).subscription

  const hit = (await value(bot, 'matches', {
    event: { kind: 'artifact.shared', actor_id: 'u1', severity: 'high', active: true, extra: 'ignored' },
  })).items
  assert.deepEqual(hit.map((item) => item.id).sort(), [filtered.id, unfiltered.id].sort())
  assert.deepEqual((await value(bot, 'matches', { event: { kind: 'artifact.shared', actor_id: 'u2', severity: 'high', active: true } })).items.map((item) => item.id), [unfiltered.id])
  assert.deepEqual((await value(bot, 'matches', { event: { kind: 'artifact.shared', actor_id: 'u1', severity: 'low', active: true } })).items.map((item) => item.id), [unfiltered.id])
  assert.deepEqual((await value(bot, 'matches', { event: { kind: 'artifact.shared', actor_id: 'u1', active: true } })).items.map((item) => item.id), [unfiltered.id])
  // true and 1 are different JSON scalars; a missing field never matches.
  assert.deepEqual((await value(bot, 'matches', { event: { kind: 'artifact.shared', actor_id: 'u1', severity: 'high', active: 1 } })).items.map((item) => item.id), [unfiltered.id])
  assert.deepEqual((await value(bot, 'matches', { event: { kind: 'meeting.shared' } })).items.map((item) => item.id), [otherKind.id])
  await refused(bot, 'matches', { event: { kind: 'artifact.created' } }, 'events/invalid')

  // A foreign-owner row stored in this file stays invisible to matching and listing.
  const store = featureStore(bot)
  try {
    store.run(
      'INSERT INTO event_subscriptions (id,owner_id,name,endpoint,secret_ref,kinds,filters,enabled,created,updated,last_delivery) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      'foreign-row', 'another-user', 'Foreign', ENDPOINT, null, '["artifact.shared"]', '{}', 1, 1, 1, null,
    )
  } finally {
    store.close()
  }
  assert.deepEqual((await value(bot, 'matches', {
    event: { kind: 'artifact.shared', actor_id: 'u1', severity: 'high', active: true },
  })).items.map((item) => item.id).sort(), [filtered.id, unfiltered.id].sort())
  assert.ok(!(await value(bot, 'list', {})).items.some((item) => item.id === 'foreign-row'))
  await refused(bot, 'get', { id: 'foreign-row' }, 'events/not-found')

  await value(bot, 'disable', { id: filtered.id })
  assert.deepEqual((await value(bot, 'matches', { event: { kind: 'artifact.shared' } })).items.map((item) => item.id), [unfiltered.id])
})

test('delivery records are idempotent by event key and stats add up', async () => {
  const bot = await boot()
  const subscription = (await value(bot, 'create', { name: 'Delivery hook', endpoint: ENDPOINT, kinds: ['artifact.shared'] })).subscription
  assert.equal((await value(bot, 'record', { subscription_id: subscription.id, event_kind: 'artifact.shared', event_key: 'event-1' })).recorded, true)
  // A duplicate key keeps the first status and does not move last_delivery.
  assert.equal((await value(bot, 'record', { subscription_id: subscription.id, event_kind: 'artifact.shared', event_key: 'event-1' })).recorded, false)
  assert.equal((await value(bot, 'record', { subscription_id: subscription.id, event_kind: 'artifact.shared', event_key: 'event-2', ok: false })).recorded, true)
  const after = (await value(bot, 'get', { id: subscription.id })).subscription
  assert.equal(typeof after.last_delivery, 'number')
  assert.deepEqual((await value(bot, 'stats', { subscription_id: subscription.id })).stats, {
    subscription_id: subscription.id, delivered: 1, failed: 1, total: 2,
  })
  assert.deepEqual((await value(bot, 'stats', {})).items.map((item) => item.subscription_id), [subscription.id])
  await refused(bot, 'record', { subscription_id: 'missing', event_kind: 'artifact.shared', event_key: 'event-3' }, 'events/not-found')
  await refused(bot, 'record', { subscription_id: subscription.id, event_kind: 'artifact.created', event_key: 'event-3' }, 'events/invalid')
  await refused(bot, 'record', { subscription_id: subscription.id, event_kind: 'artifact.shared', event_key: '' }, 'events/invalid')

  await value(bot, 'delete', { id: subscription.id })
  const store = featureStore(bot)
  try {
    assert.equal(store.get('SELECT COUNT(*) AS n FROM event_delivery_records WHERE subscription_id=?', subscription.id).n, 0)
  } finally {
    store.close()
  }
})

test('names are unique per owner and a second owner does not collide', async () => {
  const bot = await boot()
  await value(bot, 'create', { name: 'Same name', endpoint: ENDPOINT, kinds: ['artifact.shared'] })
  await refused(bot, 'create', { name: 'Same name', endpoint: 'https://other.example.test/e', kinds: ['artifact.shared'] }, 'events/conflict')
  const store = featureStore(bot)
  try {
    store.run(
      'INSERT INTO event_subscriptions (id,owner_id,name,endpoint,secret_ref,kinds,filters,enabled,created,updated,last_delivery) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      'other-owner-row', 'someone-else', 'Same name', ENDPOINT, null, '["artifact.shared"]', '{}', 1, 1, 1, null,
    )
  } finally {
    store.close()
  }
  assert.equal(rows(bot).length, 2)
  // Naming another owner in the payload does not move the row: it still collides
  // with this owner's name.
  await refused(bot, 'create', { name: 'Same name', endpoint: ENDPOINT, kinds: ['artifact.shared'], owner_id: 'someone-else' }, 'events/conflict')
})

function list(count) {
  return Array.from({ length: count }, (_, index) => `v${index}`)
}
