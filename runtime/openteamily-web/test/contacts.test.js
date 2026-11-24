// Personal address book inside the user's own DS-Bot: contacts, groups and
// the search that the moved `contacts` page needs. The volume here is a fresh
// temp dir, so every test starts from an empty address book.
import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { boot, volume } from './helpers.js'

const call = async (bot, op, payload) => {
  const result = await bot.endpoint(`contacts/${op}`, payload)
  return result
}
const ok = async (bot, op, payload) => {
  const result = await call(bot, op, payload)
  assert.equal(result.ok, true, `${op} failed: ${JSON.stringify(result.error)}`)
  return result.value
}
const fails = async (bot, op, payload, code) => {
  const result = await call(bot, op, payload)
  assert.equal(result.ok, false, `${op} was expected to fail but returned ${JSON.stringify(result.value)}`)
  assert.equal(result.error.code, code, `${op} error code: ${JSON.stringify(result.error)}`)
  return result.error
}

const created = async (bot, payload = {}) => (await ok(bot, 'create', { display_name: 'Alice Smith', ...payload })).contact

test('migrations are idempotent and this owner keeps its rows across a reboot', async () => {
  const vol = volume()
  const first = await boot(vol)
  const contact = await created(first, { email: 'alice@example.com', tags: ['work'] })
  const rows = (await ok(first, 'list', {})).items
  assert.equal(rows.length, 1)

  // Same volume, fresh plugin boot: migrate runs again and must not lose or duplicate anything.
  const second = await boot(vol)
  const again = (await ok(second, 'get', { id: contact.id })).contact
  assert.equal(again.display_name, 'Alice Smith')
  assert.deepEqual(again.tags, ['work'])
  assert.equal((await ok(second, 'list', {})).items.length, 1)

  const db = new DatabaseSync(join(vol.data, 'openteamily', 'features', 'contacts', 'contacts.sqlite3'))
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name)
  assert.ok(tables.includes('contacts') && tables.includes('contact_groups') && tables.includes('contact_group_members'), tables.join(','))
  const applied = db.prepare("SELECT COUNT(*) AS n FROM ot_feature_migrations WHERE feature='contacts'").get()
  assert.equal(applied.n, 1)
  db.close()
})

test('create, get, update and delete round-trip through contacts/<op>', async () => {
  const bot = await boot()
  const contact = await created(bot, {
    email: 'Alice@Example.com', phone: '+86 138 0000 0000', company: 'Acme',
    notes: 'Met at a conference.', tags: ['work', 'friend', 'Work'],
  })
  assert.equal(contact.display_name, 'Alice Smith')
  assert.deepEqual(contact.tags, ['work', 'friend'])
  assert.equal(contact.email, 'alice@example.com', 'email is stored lowercased')
  assert.ok(contact.created > 0 && contact.created === contact.updated)

  const fetched = (await ok(bot, 'get', { id: contact.id })).contact
  assert.equal(fetched.email, 'alice@example.com')

  const updated = (await ok(bot, 'update', { id: contact.id, changes: {
    display_name: 'Alice B.', email: 'alice.b@example.com', phone: null, company: 'Acme Labs', tags: ['vip'],
  } })).contact
  assert.equal(updated.display_name, 'Alice B.')
  assert.equal(updated.email, 'alice.b@example.com')
  assert.equal(updated.phone, null)
  assert.equal(updated.company, 'Acme Labs')
  assert.deepEqual(updated.tags, ['vip'])
  assert.equal(updated.created, contact.created)
  assert.ok(updated.updated >= contact.created)

  await fails(bot, 'update', { id: contact.id, changes: { owner_id: 'someone' } }, 'contacts/invalid')
  await fails(bot, 'update', { id: contact.id, changes: {} }, 'contacts/invalid')

  assert.deepEqual(await ok(bot, 'delete', { id: contact.id }), { deleted: true })
  await fails(bot, 'get', { id: contact.id }, 'contacts/not-found')
  await fails(bot, 'delete', { id: contact.id }, 'contacts/not-found')
})

test('a duplicate email is refused and a blank email becomes null', async () => {
  const bot = await boot()
  await created(bot, { email: 'same@example.com' })
  await fails(bot, 'create', { display_name: 'Two', email: 'same@example.com' }, 'contacts/duplicate')
  await fails(bot, 'create', { display_name: 'Case', email: 'SAME@example.com' }, 'contacts/duplicate')

  const blank = await created(bot, { display_name: 'No Mail', email: '' })
  assert.equal(blank.email, null)
  const other = await created(bot, { display_name: 'Also No Mail', email: null })
  assert.equal(other.email, null, 'several contacts may have no email')
})

test('list finds name, email and company, and treats wildcards literally', async () => {
  const bot = await boot()
  await created(bot, { display_name: 'Alice Zhang', email: 'alice@example.com', company: 'Acme' })
  await created(bot, { display_name: 'Bob Li', email: 'bob@corp.example', company: 'Beta' })
  await created(bot, { display_name: 'Carol', email: 'carol@example.org', company: 'Acme Labs' })
  await created(bot, { display_name: '100% Real', email: 'literal@example.com' })

  const names = async (payload) => (await ok(bot, 'list', payload)).items.map((row) => row.display_name)
  assert.deepEqual(await names({ query: 'alice' }), ['Alice Zhang'])
  assert.deepEqual(await names({ query: 'CORP' }), ['Bob Li'])
  assert.deepEqual(await names({ query: 'Acme' }), ['Alice Zhang', 'Carol'])
  assert.deepEqual(await names({ query: '100%' }), ['100% Real'])
  assert.deepEqual(await names({ query: '_' }), [], 'underscore is not a wildcard')
})

test('the tag filter is case-insensitive and matches whole tags', async () => {
  const bot = await boot()
  await created(bot, { display_name: 'Friend', tags: ['friend', 'work'] })
  await created(bot, { display_name: 'Work', tags: ['work'] })
  await created(bot, { display_name: 'Other', tags: ['workmate'] })

  const names = async (payload) => (await ok(bot, 'list', payload)).items.map((row) => row.display_name)
  assert.deepEqual(await names({ tag: 'FRIEND' }), ['Friend'])
  assert.deepEqual(await names({ tag: 'work' }), ['Friend', 'Work'])
})

test('groups hold memberships, count them and refuse duplicate names', async () => {
  const bot = await boot()
  const friends = (await ok(bot, 'group-create', { name: 'Friends' })).group
  const work = (await ok(bot, 'group-create', { name: 'Work' })).group
  assert.equal(friends.contact_count, 0)
  await fails(bot, 'group-create', { name: 'Friends' }, 'contacts/duplicate')
  await fails(bot, 'group-create', { name: '' }, 'contacts/invalid')

  const alice = await created(bot, { display_name: 'Alice Smith' })
  const bob = await created(bot, { display_name: 'Bob Jones' })
  assert.deepEqual(await ok(bot, 'group-add', { group_id: friends.id, contact_id: alice.id }), { added: true })
  assert.deepEqual(await ok(bot, 'group-add', { group_id: friends.id, contact_id: alice.id }), { added: false })
  assert.deepEqual(await ok(bot, 'group-add', { group_id: work.id, contact_id: alice.id }), { added: true })
  assert.deepEqual(await ok(bot, 'group-add', { group_id: friends.id, contact_id: bob.id }), { added: true })

  const inFriends = (await ok(bot, 'list', { group_id: friends.id })).items.map((row) => row.display_name)
  assert.deepEqual(inFriends, ['Alice Smith', 'Bob Jones'])
  const counts = Object.fromEntries((await ok(bot, 'groups', {})).items.map((row) => [row.name, row.contact_count]))
  assert.deepEqual(counts, { Friends: 2, Work: 1 })

  const renamed = (await ok(bot, 'group-rename', { group_id: friends.id, name: 'Close Friends' })).group
  assert.equal(renamed.name, 'Close Friends')
  await fails(bot, 'group-rename', { group_id: friends.id, name: 'Work' }, 'contacts/duplicate')

  assert.deepEqual(await ok(bot, 'group-remove', { group_id: friends.id, contact_id: bob.id }), { removed: true })
  assert.deepEqual(await ok(bot, 'group-remove', { group_id: friends.id, contact_id: bob.id }), { removed: false })

  assert.deepEqual(await ok(bot, 'group-delete', { group_id: work.id }), { deleted: true })
  assert.equal((await ok(bot, 'groups', {})).items.length, 1)
  await fails(bot, 'group-delete', { group_id: work.id }, 'contacts/not-found')
})

test('deleting a contact drops its group memberships', async () => {
  const bot = await boot()
  const group = (await ok(bot, 'group-create', { name: 'Friends' })).group
  const contact = await created(bot)
  await ok(bot, 'group-add', { group_id: group.id, contact_id: contact.id })
  assert.equal((await ok(bot, 'groups', {})).items[0].contact_count, 1)

  await ok(bot, 'delete', { id: contact.id })
  assert.equal((await ok(bot, 'groups', {})).items[0].contact_count, 0)
  assert.deepEqual((await ok(bot, 'list', { group_id: group.id })).items, [])
})

test('a row left by another owner is invisible and cannot be edited', async () => {
  const vol = volume()
  const bot = await boot(vol)
  const mine = await created(bot, { display_name: 'Alice Private', email: 'private@example.com' })
  const group = (await ok(bot, 'group-create', { name: 'Alice Group' })).group

  const db = new DatabaseSync(join(vol.data, 'openteamily', 'features', 'contacts', 'contacts.sqlite3'))
  db.prepare('INSERT INTO contacts (id,owner_id,display_name,email,phone,company,notes,tags,linked_user_id,created,updated) '
    + 'VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('f'.repeat(32), 'another-owner', 'Bob Private', null, null, null, null, '[]', null, 1, 1)
  db.close()

  const names = (await ok(bot, 'list', {})).items.map((row) => row.display_name)
  assert.deepEqual(names, ['Alice Private'])
  await fails(bot, 'get', { id: 'f'.repeat(32) }, 'contacts/forbidden')
  await fails(bot, 'update', { id: 'f'.repeat(32), changes: { notes: 'x' } }, 'contacts/forbidden')
  await fails(bot, 'delete', { id: 'f'.repeat(32) }, 'contacts/forbidden')
  await fails(bot, 'group-add', { group_id: group.id, contact_id: 'f'.repeat(32) }, 'contacts/forbidden')
  // An id that is certain to be unallocated: flip the first hex digit of a real one.
  const missing = (mine.id[0] === '0' ? '1' : '0') + mine.id.slice(1)
  await fails(bot, 'get', { id: missing }, 'contacts/not-found')
})

test('invalid fields, tags and oversize values are refused', async () => {
  const bot = await boot()
  const bad = async (payload) => fails(bot, 'create', payload, 'contacts/invalid')
  await bad({ display_name: '' })
  await bad({ display_name: 'x'.repeat(81) })
  await bad({ display_name: 'bad\u0001name' })
  await bad({ display_name: 'X', email: 'not-an-email' })
  await bad({ display_name: 'X', email: 'a'.repeat(250) + '@example.com' })
  await bad({ display_name: 'X', phone: '1'.repeat(41) })
  await bad({ display_name: 'X', company: 'c'.repeat(121) })
  await bad({ display_name: 'X', notes: 'n'.repeat(2001) })
  for (const tags of ['friend', [''], ['   '], [1], ['ok', 1], ['x'.repeat(31)], Array.from({ length: 13 }, (_, i) => `tag${i}`), ['bad\u0001tag']]) {
    await bad({ display_name: 'X', tags })
  }
  const full = await created(bot, { display_name: 'Tags', tags: ['a'.repeat(30), ...Array.from({ length: 11 }, (_, i) => `tag${i}`)] })
  assert.equal(full.tags.length, 12)
  await fails(bot, 'update', { id: full.id, changes: { tags: ['bad\u0001tag'] } }, 'contacts/invalid')
})

test('cursor paging stays stable and works with a filter', async () => {
  const bot = await boot()
  for (const name of ['Charlie', 'Alice', 'Bob', 'Dave', 'Eve', 'Frank', 'Grace']) {
    await created(bot, { display_name: name, tags: ['team'] })
  }
  const expected = ['Alice', 'Bob', 'Charlie', 'Dave', 'Eve', 'Frank', 'Grace']
  const seen = []
  let cursor = null
  let pages = 0
  do {
    const page = await ok(bot, 'list', { limit: 2, ...(cursor ? { cursor } : {}) })
    assert.ok(page.items.length <= 2)
    seen.push(...page.items.map((row) => row.display_name))
    cursor = page.cursor
    pages += 1
  } while (cursor)
  assert.deepEqual(seen, expected)
  assert.equal(pages, 4)

  const tagged = await ok(bot, 'list', { tag: 'team', limit: 3 })
  assert.equal(tagged.items.length, 3)
  assert.ok(tagged.cursor, 'a full page must offer a cursor')
  const rest = await ok(bot, 'list', { tag: 'team', limit: 3, cursor: tagged.cursor })
  assert.equal(rest.items.length, 3)
  assert.ok(rest.cursor)
  const last = await ok(bot, 'list', { tag: 'team', limit: 3, cursor: rest.cursor })
  assert.equal(last.items.length, 1)
  assert.equal(last.cursor, null)

  for (const bad of ['not-a-cursor', '', 'e30']) {
    await fails(bot, 'list', { cursor: bad }, 'contacts/invalid')
  }
  for (const limit of [0, 101, true, '2']) {
    await fails(bot, 'list', { limit }, 'contacts/invalid')
  }
  await fails(bot, 'list', { query: 'q'.repeat(101) }, 'contacts/invalid')
})
