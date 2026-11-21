// Personal address book: this owner's contacts, groups and search, stored on
// the user's own DS-Bot volume under /data/openteamily/features/contacts/.
// It replaces the platform module `openteamily/contacts.py`, which had no
// router and was never reachable; this is the same capability behind the
// plugin endpoint contract (docs/DSBOT_PLUGIN_ARCHITECTURE.md §2.1).
//
// Not the same thing as `features/social`'s contacts: that one is the
// cross-user connection list (`/v1/contacts` → Bot Social) and owns the
// `contacts` page. This feature is the private address book (names, email,
// phone, tags, groups) and ships no page of its own yet.
//
// Scope is one account: defineFeature hands us that owner and every statement
// is filtered by owner_id, so a stale row left on the volume by someone else is
// invisible and cannot be edited (contacts/forbidden, never another owner's
// fields). There is no sharing, import/export or address-book sync here.
//
// One deliberate narrowing against the platform module this replaces: the
// platform could verify `linked_user_id` against its `users` table. A per-user
// volume has no such table, so the field is stored as an opaque reference
// (1–64 characters) and is not resolved.
//
// Endpoints: contacts/<op> — create, get, update, delete, list, groups,
// group-create, group-rename, group-delete, group-add, group-remove.
import { FeatureError, newId, nowSeconds } from '../../featurekit/http.js'
import { defineFeature } from '../../featurekit/feature.js'

export const MIGRATIONS = [`
CREATE TABLE IF NOT EXISTS contacts (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL,
 display_name TEXT NOT NULL,
 email TEXT,
 phone TEXT,
 company TEXT,
 notes TEXT,
 tags TEXT NOT NULL DEFAULT '[]',
 linked_user_id TEXT,
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL,
 UNIQUE(owner_id, email));
CREATE INDEX IF NOT EXISTS contact_owner_name ON contacts(owner_id, display_name, id);
CREATE INDEX IF NOT EXISTS contact_owner_email ON contacts(owner_id, email);
CREATE TABLE IF NOT EXISTS contact_groups (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL,
 name TEXT NOT NULL,
 created INTEGER NOT NULL,
 UNIQUE(owner_id, name));
CREATE INDEX IF NOT EXISTS contact_group_owner ON contact_groups(owner_id, name);
CREATE TABLE IF NOT EXISTS contact_group_members (
 group_id TEXT NOT NULL REFERENCES contact_groups(id) ON DELETE CASCADE,
 contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
 PRIMARY KEY(group_id, contact_id));
CREATE INDEX IF NOT EXISTS contact_group_member_contact
 ON contact_group_members(contact_id, group_id);
`]

export const DISPLAY_MAX = 80
export const EMAIL_MAX = 254
export const PHONE_MAX = 40
export const COMPANY_MAX = 120
export const NOTES_MAX = 2000
export const TAG_MAX = 12
export const TAG_LEN = 30
export const QUERY_MAX = 100
export const LIMIT_DEFAULT = 50
export const LIMIT_MAX = 100
const CURSOR_MAX = 512
const LINKED_MAX = 64
const CHANGE_FIELDS = ['display_name', 'email', 'phone', 'company', 'notes', 'tags', 'linked_user_id']
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f]/
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const GROUP_SELECT = 'SELECT g.*, (SELECT COUNT(*) FROM contact_group_members m WHERE m.group_id=g.id) AS contact_count '
  + 'FROM contact_groups g '

const invalid = (message) => { throw new FeatureError(400, 'contacts/invalid', message) }
const notFound = (message) => { throw new FeatureError(404, 'contacts/not-found', message) }
const forbidden = (message) => { throw new FeatureError(403, 'contacts/forbidden', message) }
const duplicate = (message) => { throw new FeatureError(409, 'contacts/duplicate', message) }

function displayName(value) {
  if (typeof value !== 'string') invalid('display name must be text')
  const text = value.trim()
  if (text.length < 1 || text.length > DISPLAY_MAX || CONTROL.test(text)) invalid('display name is invalid')
  return text
}

function optionalText(value, label, maximum) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || value.length > maximum || CONTROL.test(value)) invalid(`${label} is invalid`)
  const text = value.trim()
  return text || null
}

function email(value) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') invalid('email must be text')
  const text = value.trim().toLowerCase()
  if (!text) return null
  if (text.length > EMAIL_MAX || CONTROL.test(text) || !EMAIL.test(text)) invalid('email is invalid')
  return text
}

function tags(value) {
  if (value === null || value === undefined) return []
  if (!Array.isArray(value)) invalid('tags must be a list')
  if (value.length > TAG_MAX) invalid('too many tags')
  const result = []
  const seen = new Set()
  for (const tag of value) {
    if (typeof tag !== 'string') invalid('tags must be text')
    const text = tag.trim()
    if (text.length < 1 || text.length > TAG_LEN || CONTROL.test(text)) invalid('tag is invalid')
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(text)
  }
  return result
}

function linkedUser(value) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') invalid('linked_user_id must be text')
  const text = value.trim()
  if (!text) return null
  if (text.length > LINKED_MAX || CONTROL.test(text)) invalid('linked_user_id is invalid')
  return text
}

function groupName(value) {
  if (typeof value !== 'string') invalid('group name must be text')
  const text = value.trim()
  if (text.length < 1 || text.length > DISPLAY_MAX || CONTROL.test(text)) invalid('group name is invalid')
  return text
}

const tagList = (raw) => {
  try {
    const value = JSON.parse(raw ?? '[]')
    return Array.isArray(value) ? value : []
  } catch { return [] }
}

const likeEscape = (text) => text
  .replace(/\\/g, () => '\\\\')
  .replace(/%/g, () => '\\%')
  .replace(/_/g, () => '\\_')

function encodeCursor(name, contactId) {
  return Buffer.from(JSON.stringify({ name, id: contactId }), 'utf8').toString('base64url')
}

function decodeCursor(token) {
  if (typeof token !== 'string' || !token || token.length > CURSOR_MAX) invalid('invalid cursor')
  let value
  try {
    value = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))
  } catch { invalid('invalid cursor') }
  const keys = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort() : []
  if (keys.length !== 2 || keys[0] !== 'id' || keys[1] !== 'name'
      || typeof value.name !== 'string' || typeof value.id !== 'string' || !value.id) invalid('invalid cursor')
  return { name: value.name, id: value.id }
}

export function view(row) {
  return {
    id: row.id,
    owner_id: row.owner_id,
    display_name: row.display_name,
    email: row.email,
    phone: row.phone,
    company: row.company,
    notes: row.notes,
    tags: tagList(row.tags),
    linked_user_id: row.linked_user_id,
    created: row.created,
    updated: row.updated,
  }
}

const groupView = (row) => ({
  id: row.id,
  owner_id: row.owner_id,
  name: row.name,
  created: row.created,
  contact_count: row.contact_count,
})

function loadContact(store, owner, contactId) {
  if (typeof contactId !== 'string' || !contactId) invalid('contact id is required')
  const row = store.get('SELECT * FROM contacts WHERE id=?', contactId)
  if (!row) notFound('contact not found')
  if (row.owner_id !== owner) forbidden('contact belongs to another owner')
  return row
}

function loadGroup(store, owner, groupId) {
  if (typeof groupId !== 'string' || !groupId) invalid('group id is required')
  const row = store.get(GROUP_SELECT + 'WHERE g.id=?', groupId)
  if (!row) notFound('group not found')
  if (row.owner_id !== owner) forbidden('group belongs to another owner')
  return row
}

const isUnique = (error) => /UNIQUE constraint failed/.test(String(error?.message ?? error))

export function createContact(store, owner, payload, now = nowSeconds()) {
  const id = newId()
  try {
    store.run(
      'INSERT INTO contacts (id,owner_id,display_name,email,phone,company,notes,tags,linked_user_id,created,updated) '
      + 'VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      id, owner, displayName(payload?.display_name), email(payload?.email),
      optionalText(payload?.phone, 'phone', PHONE_MAX),
      optionalText(payload?.company, 'company', COMPANY_MAX),
      optionalText(payload?.notes, 'notes', NOTES_MAX),
      JSON.stringify(tags(payload?.tags)),
      linkedUser(payload?.linked_user_id), now, now,
    )
  } catch (error) {
    if (isUnique(error)) duplicate('duplicate email for owner')
    throw error
  }
  return view(loadContact(store, owner, id))
}

export function getContact(store, owner, contactId) {
  return view(loadContact(store, owner, contactId))
}

export function updateContact(store, owner, contactId, changes, now = nowSeconds()) {
  const row = loadContact(store, owner, contactId)
  if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length) {
    invalid('changes must be a non-empty object')
  }
  if (Object.keys(changes).some((key) => !CHANGE_FIELDS.includes(key))) invalid('unsupported contact field')
  const data = {
    display_name: row.display_name,
    email: row.email,
    phone: row.phone,
    company: row.company,
    notes: row.notes,
    tags: tagList(row.tags),
    linked_user_id: row.linked_user_id,
  }
  if ('display_name' in changes) data.display_name = displayName(changes.display_name)
  if ('email' in changes) data.email = email(changes.email)
  if ('phone' in changes) data.phone = optionalText(changes.phone, 'phone', PHONE_MAX)
  if ('company' in changes) data.company = optionalText(changes.company, 'company', COMPANY_MAX)
  if ('notes' in changes) data.notes = optionalText(changes.notes, 'notes', NOTES_MAX)
  if ('tags' in changes) data.tags = tags(changes.tags)
  if ('linked_user_id' in changes) data.linked_user_id = linkedUser(changes.linked_user_id)
  try {
    store.run(
      'UPDATE contacts SET display_name=?, email=?, phone=?, company=?, notes=?, tags=?, linked_user_id=?, updated=? '
      + 'WHERE id=? AND owner_id=?',
      data.display_name, data.email, data.phone, data.company, data.notes,
      JSON.stringify(data.tags), data.linked_user_id, now, contactId, owner,
    )
  } catch (error) {
    if (isUnique(error)) duplicate('duplicate email for owner')
    throw error
  }
  return getContact(store, owner, contactId)
}

export function deleteContact(store, owner, contactId) {
  loadContact(store, owner, contactId)
  return store.transaction(() => {
    store.run('DELETE FROM contact_group_members WHERE contact_id=?', contactId)
    return store.run('DELETE FROM contacts WHERE id=? AND owner_id=?', contactId, owner).changes > 0
  })
}

export function listContacts(store, owner, options = {}) {
  const limit = options.limit === undefined || options.limit === null ? LIMIT_DEFAULT : options.limit
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > LIMIT_MAX) {
    invalid(`limit must be an integer from 1 to ${LIMIT_MAX}`)
  }
  const where = ['c.owner_id=?']
  const params = [owner]
  if (options.query !== undefined && options.query !== null) {
    if (typeof options.query !== 'string') invalid('query must be text')
    const text = options.query.trim()
    if (text.length > QUERY_MAX) invalid('query is too long')
    if (text) {
      const pattern = '%' + likeEscape(text.toLowerCase()) + '%'
      where.push("(lower(c.display_name) LIKE ? ESCAPE '\\' OR lower(c.email) LIKE ? ESCAPE '\\' "
        + "OR lower(c.company) LIKE ? ESCAPE '\\')")
      params.push(pattern, pattern, pattern)
    }
  }
  if (options.tag !== undefined && options.tag !== null) {
    if (typeof options.tag !== 'string') invalid('tag must be text')
    const text = options.tag.trim()
    if (!text || text.length > TAG_LEN || CONTROL.test(text)) invalid('tag is invalid')
    where.push('EXISTS (SELECT 1 FROM json_each(c.tags) j WHERE lower(j.value)=lower(?))')
    params.push(text)
  }
  if (options.group_id !== undefined && options.group_id !== null) {
    loadGroup(store, owner, options.group_id)
    where.push('EXISTS (SELECT 1 FROM contact_group_members m WHERE m.contact_id=c.id AND m.group_id=?)')
    params.push(options.group_id)
  }
  if (options.cursor !== undefined && options.cursor !== null) {
    const { name, id } = decodeCursor(options.cursor)
    where.push('(lower(c.display_name)>? OR (lower(c.display_name)=? AND c.id>?))')
    params.push(name, name, id)
  }
  const rows = store.all(
    'SELECT c.*, lower(c.display_name) AS sort_name FROM contacts c WHERE ' + where.join(' AND ')
    + ' ORDER BY lower(c.display_name), c.id LIMIT ?',
    ...params, limit + 1,
  )
  let cursor = null
  let page = rows
  if (rows.length > limit) {
    page = rows.slice(0, limit)
    const last = page[page.length - 1]
    cursor = encodeCursor(last.sort_name, last.id)
  }
  return { items: page.map(view), cursor }
}

export function createGroup(store, owner, name, now = nowSeconds()) {
  const id = newId()
  try {
    store.run('INSERT INTO contact_groups (id,owner_id,name,created) VALUES(?,?,?,?)', id, owner, groupName(name), now)
  } catch (error) {
    if (isUnique(error)) duplicate('duplicate group name for owner')
    throw error
  }
  return groupView(loadGroup(store, owner, id))
}

export function renameGroup(store, owner, groupId, name) {
  loadGroup(store, owner, groupId)
  try {
    store.run('UPDATE contact_groups SET name=? WHERE id=? AND owner_id=?', groupName(name), groupId, owner)
  } catch (error) {
    if (isUnique(error)) duplicate('duplicate group name for owner')
    throw error
  }
  return groupView(loadGroup(store, owner, groupId))
}

export function deleteGroup(store, owner, groupId) {
  loadGroup(store, owner, groupId)
  return store.transaction(() => {
    store.run('DELETE FROM contact_group_members WHERE group_id=?', groupId)
    return store.run('DELETE FROM contact_groups WHERE id=? AND owner_id=?', groupId, owner).changes > 0
  })
}

export function addToGroup(store, owner, groupId, contactId) {
  loadGroup(store, owner, groupId)
  loadContact(store, owner, contactId)
  return store.run('INSERT OR IGNORE INTO contact_group_members (group_id,contact_id) VALUES(?,?)', groupId, contactId).changes > 0
}

export function removeFromGroup(store, owner, groupId, contactId) {
  loadGroup(store, owner, groupId)
  loadContact(store, owner, contactId)
  return store.run('DELETE FROM contact_group_members WHERE group_id=? AND contact_id=?', groupId, contactId).changes > 0
}

export function listGroups(store, owner) {
  return store.all(GROUP_SELECT + 'WHERE g.owner_id=? ORDER BY lower(g.name), g.id', owner).map(groupView)
}

export default defineFeature({
  name: 'contacts',
  migrations: MIGRATIONS,
  endpoints: ({ store, owner }) => ({
    async create(payload) { return { contact: createContact(store, owner, payload) } },
    async get(payload) { return { contact: getContact(store, owner, payload?.id) } },
    async update(payload) { return { contact: updateContact(store, owner, payload?.id, payload?.changes) } },
    async delete(payload) { return { deleted: deleteContact(store, owner, payload?.id) } },
    async list(payload) { return listContacts(store, owner, payload ?? {}) },
    async groups() { return { items: listGroups(store, owner) } },
    async 'group-create'(payload) { return { group: createGroup(store, owner, payload?.name) } },
    async 'group-rename'(payload) { return { group: renameGroup(store, owner, payload?.group_id, payload?.name) } },
    async 'group-delete'(payload) { return { deleted: deleteGroup(store, owner, payload?.group_id) } },
    async 'group-add'(payload) { return { added: addToGroup(store, owner, payload?.group_id, payload?.contact_id) } },
    async 'group-remove'(payload) { return { removed: removeFromGroup(store, owner, payload?.group_id, payload?.contact_id) } },
  }),
})
