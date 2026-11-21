// Threaded annotations on workspace artifacts, served by the artifacts feature
// (this user's DS-Bot). Threads are pinned to an artifact revision, comments are
// soft-deleted by their author, and mentions are extracted from the body text.
// The retried contract lives in the retired openteamily/annotations.py; these
// tests exercise the plugin endpoints through POST /api/openteamily.
import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { boot, key, volume, WS } from './helpers.js'

const OTHER_WS = 'c'.repeat(32)
const OTHER_AUTHOR = 'b'.repeat(32)
const OWNER = 'owner' // ownerId() without OPENTEAMILY_OWNER_USER_ID

async function setup() {
  const bot = await boot()
  const created = await bot.endpoint('artifacts/create', {
    workspace_id: WS, title: '标注对象', body: '正文', kind: 'document', idempotency_key: key(),
  })
  assert.equal(created.ok, true, JSON.stringify(created))
  return { bot, artifactId: created.value.artifact.id }
}

async function ok(bot, endpoint, payload) {
  const result = await bot.endpoint(endpoint, payload)
  assert.equal(result.ok, true, `${endpoint} ${JSON.stringify(result)}`)
  return result.value
}

function store(bot) {
  return new DatabaseSync(join(bot.vol.data, 'openteamily', 'features', 'artifacts', 'artifacts.sqlite3'))
}

function threadRow(bot, id) {
  const db = store(bot)
  try { return db.prepare('SELECT * FROM annotation_threads WHERE id=?').get(id) ?? null } finally { db.close() }
}

function commentRows(bot, threadId) {
  const db = store(bot)
  try {
    return db.prepare('SELECT * FROM annotation_comments WHERE thread_id=? ORDER BY id').all(threadId)
  } finally { db.close() }
}

// Seed rows the live endpoints would never write: an old timestamp (so a later
// update is provably newer) and a comment whose author is another identity.
function seedForeignComment(bot, threadId, { created = 1000 } = {}) {
  const db = store(bot)
  try {
    const id = 'f'.repeat(32)
    db.prepare('INSERT INTO annotation_comments '
      + '(id,thread_id,workspace_id,author_id,body,mentions,created,updated,deleted) '
      + 'VALUES(?,?,?,?,?,?,?,?,0)').run(id, threadId, WS, OTHER_AUTHOR, '不是我的评论', '[]', created, created)
    db.prepare('UPDATE annotation_threads SET updated=? WHERE id=?').run(created, threadId)
    return id
  } finally { db.close() }
}

test('the artifacts feature serves annotations and records migration 4', async () => {
  const { bot, artifactId } = await setup()
  const listed = await ok(bot, 'artifacts/annotations-list', { workspace_id: WS, artifact_id: artifactId })
  assert.deepEqual(listed.items, [])
  assert.equal(listed.cursor, null)
  const db = store(bot)
  try {
    const versions = db.prepare('SELECT version FROM ot_feature_migrations WHERE feature=? ORDER BY version').all('artifacts')
    assert.deepEqual(versions.map((row) => row.version), [1, 2, 3, 4])
  } finally { db.close() }
})

test('threads are pinned to a revision, list in id order, and page with a cursor', async () => {
  const { bot, artifactId } = await setup()
  const ids = []
  for (let index = 0; index < 5; index += 1) {
    const value = await ok(bot, 'artifacts/annotations-create', {
      workspace_id: WS, artifact_id: artifactId, artifact_revision: index % 2 === 0 ? 0 : 1,
    })
    ids.push(value.thread.id)
  }
  const first = await ok(bot, 'artifacts/annotations-list', { workspace_id: WS, artifact_id: artifactId, limit: 2 })
  const second = await ok(bot, 'artifacts/annotations-list', { workspace_id: WS, artifact_id: artifactId, limit: 2, cursor: first.cursor })
  const third = await ok(bot, 'artifacts/annotations-list', { workspace_id: WS, artifact_id: artifactId, limit: 2, cursor: second.cursor })
  assert.deepEqual([first.items.length, second.items.length, third.items.length], [2, 2, 1])
  assert.equal(third.cursor, null)
  const combined = [...first.items, ...second.items, ...third.items].map((item) => item.id)
  assert.deepEqual(combined, [...combined].sort())
  assert.deepEqual(new Set(combined), new Set(ids))

  const revisionZero = await ok(bot, 'artifacts/annotations-list', {
    workspace_id: WS, artifact_id: artifactId, revision: 0,
  })
  assert.equal(revisionZero.items.length, 3)
  assert.ok(revisionZero.items.every((item) => item.artifact_revision === 0))
  const revisionOne = await ok(bot, 'artifacts/annotations-list', {
    workspace_id: WS, artifact_id: artifactId, revision: 1,
  })
  assert.equal(revisionOne.items.length, 2)
})

test('a first comment travels with its thread and mentions are extracted', async () => {
  const { bot, artifactId } = await setup()
  const created = await ok(bot, 'artifacts/annotations-create', {
    workspace_id: WS, artifact_id: artifactId, artifact_revision: 1,
    anchor: 'paragraph:2', body: 'First @bob',
  })
  const thread = created.thread
  assert.equal(thread.artifact_revision, 1)
  assert.equal(thread.anchor, 'paragraph:2')
  assert.equal(thread.resolved, false)
  assert.equal(thread.created_by, OWNER)
  assert.equal(thread.comment_count, 1)
  assert.equal(thread.comments.length, 1)
  assert.equal(thread.comments[0].body, 'First @bob')
  assert.equal(thread.comments[0].author_id, OWNER)
  assert.deepEqual(thread.comments[0].mentions, ['bob'])
  assert.ok(thread.comments[0].created > 0)
})

test('comment lifecycle keeps a soft-deleted row, excludes it from views, and gates on author', async () => {
  const { bot, artifactId } = await setup()
  const created = await ok(bot, 'artifacts/annotations-create', { workspace_id: WS, artifact_id: artifactId, artifact_revision: 1 })
  const threadId = created.thread.id

  const added = await ok(bot, 'artifacts/annotations-comment-add', {
    workspace_id: WS, thread_id: threadId, body: '检查这一段 @alice',
  })
  assert.deepEqual(added.comment.mentions, ['alice'])
  assert.equal(added.comment.deleted, false)

  const edited = await ok(bot, 'artifacts/annotations-comment-edit', {
    workspace_id: WS, comment_id: added.comment.id, body: '改过的正文',
  })
  assert.equal(edited.comment.body, '改过的正文')
  assert.deepEqual(edited.comment.mentions, [])
  assert.ok(edited.comment.updated >= added.comment.created)

  const foreign = seedForeignComment(bot, threadId)
  for (const endpoint of ['artifacts/annotations-comment-edit', 'artifacts/annotations-comment-delete']) {
    const payload = { workspace_id: WS, comment_id: foreign }
    if (endpoint.endsWith('edit')) payload.body = '偷改'
    const refused = await bot.endpoint(endpoint, payload)
    assert.equal(refused.ok, false, JSON.stringify(refused))
    assert.equal(refused.error.code, 'annotations/forbidden')
  }

  const db = store(bot)
  try { db.prepare('UPDATE annotation_threads SET updated=? WHERE id=?').run(1000, threadId) } finally { db.close() }
  const deleted = await ok(bot, 'artifacts/annotations-comment-delete', { workspace_id: WS, comment_id: added.comment.id })
  assert.equal(deleted.comment.deleted, true)
  assert.ok(deleted.comment.updated > 1000)
  assert.ok(threadRow(bot, threadId).updated > 1000)
  assert.equal(commentRows(bot, threadId).length, 2) // the edit is a soft delete, not a DELETE
  const detail = await ok(bot, 'artifacts/annotations-get', { workspace_id: WS, thread_id: threadId })
  assert.deepEqual(detail.thread.comments.map((item) => item.id), [foreign])
  assert.equal(detail.thread.comment_count, 1)

  const gone = await bot.endpoint('artifacts/annotations-comment-edit', {
    workspace_id: WS, comment_id: added.comment.id, body: '再改',
  })
  assert.equal(gone.ok, false)
  assert.equal(gone.error.code, 'annotations/not-found')
})

test('mentions are lowercase, de-duplicated, bounded, and ignore e-mail addresses', async () => {
  const { bot, artifactId } = await setup()
  const { thread } = await ok(bot, 'artifacts/annotations-create', { workspace_id: WS, artifact_id: artifactId, artifact_revision: 1 })
  const names = Array.from({ length: 25 }, (_, index) => `user${String(index).padStart(3, '0')}`)
  const body = `${names.map((name) => '@' + name).join(' ')} @USER000 a@bob.com @a @ab @bob.`
  const added = await ok(bot, 'artifacts/annotations-comment-add', { workspace_id: WS, thread_id: thread.id, body })
  assert.deepEqual(added.comment.mentions, names.slice(0, 20))
  assert.equal(added.comment.mentions.length, 20)
  assert.equal(new Set(added.comment.mentions).size, 20)
})

test('resolve, unresolve and the open count move together', async () => {
  const { bot, artifactId } = await setup()
  const created = []
  for (let index = 0; index < 3; index += 1) {
    created.push((await ok(bot, 'artifacts/annotations-create', {
      workspace_id: WS, artifact_id: artifactId, artifact_revision: 1,
    })).thread.id)
  }
  assert.equal((await ok(bot, 'artifacts/annotations-count', { workspace_id: WS, artifact_id: artifactId })).open, 3)
  const threadId = created[0]
  const seedDb = store(bot)
  try { seedDb.prepare('UPDATE annotation_threads SET updated=? WHERE id=?').run(1000, threadId) } finally { seedDb.close() }
  const resolved = await ok(bot, 'artifacts/annotations-resolve', { workspace_id: WS, thread_id: threadId })
  assert.equal(resolved.thread.resolved, true)
  assert.ok(threadRow(bot, threadId).updated > 1000)
  assert.equal((await ok(bot, 'artifacts/annotations-count', { workspace_id: WS, artifact_id: artifactId })).open, 2)
  const openOnly = await ok(bot, 'artifacts/annotations-list', {
    workspace_id: WS, artifact_id: artifactId, resolved: false,
  })
  assert.equal(openOnly.items.length, 2)
  const resolvedOnly = await ok(bot, 'artifacts/annotations-list', {
    workspace_id: WS, artifact_id: artifactId, resolved: true,
  })
  assert.deepEqual(resolvedOnly.items.map((item) => item.id), [threadId])
  const reopened = await ok(bot, 'artifacts/annotations-resolve', {
    workspace_id: WS, thread_id: threadId, resolved: false,
  })
  assert.equal(reopened.thread.resolved, false)
  assert.equal((await ok(bot, 'artifacts/annotations-count', { workspace_id: WS, artifact_id: artifactId })).open, 3)
})

test('a thread in another workspace is not found, even for the same artifact id', async () => {
  const { bot, artifactId } = await setup()
  const mine = await ok(bot, 'artifacts/annotations-create', {
    workspace_id: WS, artifact_id: artifactId, artifact_revision: 1, body: 'mine',
  })
  assert.equal((await ok(bot, 'artifacts/annotations-list', { workspace_id: WS, artifact_id: artifactId })).items.length, 1)
  // The same artifact id cannot belong to another workspace, so a list there is
  // not-found rather than a misleading empty page; a workspace that owns its own
  // artifact sees its own (empty) threads.
  const theirs = await bot.endpoint('artifacts/annotations-list', { workspace_id: OTHER_WS, artifact_id: artifactId })
  assert.equal(theirs.ok, false)
  assert.equal(theirs.error.code, 'annotations/not-found')
  const otherArtifact = (await bot.endpoint('artifacts/create', {
    workspace_id: OTHER_WS, title: '别人的作品', body: '正文', kind: 'document', idempotency_key: key(),
  })).value.artifact.id
  assert.deepEqual((await ok(bot, 'artifacts/annotations-list', {
    workspace_id: OTHER_WS, artifact_id: otherArtifact,
  })).items, [])
  for (const [endpoint, payload] of [
    ['artifacts/annotations-get', { workspace_id: OTHER_WS, thread_id: mine.thread.id }],
    ['artifacts/annotations-comment-add', { workspace_id: OTHER_WS, thread_id: mine.thread.id, body: 'leak' }],
    ['artifacts/annotations-resolve', { workspace_id: OTHER_WS, thread_id: mine.thread.id }],
  ]) {
    const refused = await bot.endpoint(endpoint, payload)
    assert.equal(refused.ok, false, JSON.stringify(refused))
    assert.equal(refused.error.code, 'annotations/not-found')
  }
  const comment = (await ok(bot, 'artifacts/annotations-comment-add', {
    workspace_id: WS, thread_id: mine.thread.id, body: 'mine only',
  })).comment
  for (const [endpoint, payload] of [
    ['artifacts/annotations-comment-edit', { workspace_id: OTHER_WS, comment_id: comment.id, body: 'leak' }],
    ['artifacts/annotations-comment-delete', { workspace_id: OTHER_WS, comment_id: comment.id }],
  ]) {
    const refused = await bot.endpoint(endpoint, payload)
    assert.equal(refused.ok, false, JSON.stringify(refused))
    assert.equal(refused.error.code, 'annotations/not-found')
  }
})

test('bounds and types are refused with a stable code', async () => {
  const { bot, artifactId } = await setup()
  const invalid = async (endpoint, payload) => {
    const result = await bot.endpoint(endpoint, payload)
    assert.equal(result.ok, false, `${endpoint} ${JSON.stringify(payload)} ${JSON.stringify(result)}`)
    assert.equal(result.error.code, 'annotations/invalid', `${endpoint} ${JSON.stringify(result)}`)
  }
  for (const artifact_revision of [-1, '1', 1.5, null, true]) {
    await invalid('artifacts/annotations-create', { workspace_id: WS, artifact_id: artifactId, artifact_revision })
  }
  await invalid('artifacts/annotations-create', { workspace_id: 'nope', artifact_id: artifactId, artifact_revision: 1 })
  await invalid('artifacts/annotations-create', { workspace_id: WS, artifact_id: 'nope', artifact_revision: 1 })
  await invalid('artifacts/annotations-create', {
    workspace_id: WS, artifact_id: artifactId, artifact_revision: 1, anchor: 'x'.repeat(1001),
  })
  await invalid('artifacts/annotations-create', {
    workspace_id: WS, artifact_id: artifactId, artifact_revision: 1, body: '',
  })
  await invalid('artifacts/annotations-create', {
    workspace_id: WS, artifact_id: artifactId, artifact_revision: 1, body: 'x'.repeat(4001),
  })
  await invalid('artifacts/annotations-create', {
    workspace_id: WS, artifact_id: artifactId, artifact_revision: 1, body: 'bad\u0001control',
  })
  await invalid('artifacts/annotations-list', { workspace_id: WS, artifact_id: artifactId, revision: -1 })
  await invalid('artifacts/annotations-list', { workspace_id: WS, artifact_id: artifactId, limit: 0 })
  await invalid('artifacts/annotations-list', { workspace_id: WS, artifact_id: artifactId, cursor: 'zzz' })
  const { thread } = await ok(bot, 'artifacts/annotations-create', {
    workspace_id: WS, artifact_id: artifactId, artifact_revision: 1, body: 'root',
  })
  for (const body of ['', '   ', 'x'.repeat(4001)]) {
    await invalid('artifacts/annotations-comment-add', { workspace_id: WS, thread_id: thread.id, body })
  }
  await invalid('artifacts/annotations-comment-edit', {
    workspace_id: WS, comment_id: thread.comments[0].id, body: 'x'.repeat(4001),
  })
  // 100 is the ceiling, not an error; 101 is clamped rather than refused.
  const clamped = await ok(bot, 'artifacts/annotations-list', { workspace_id: WS, artifact_id: artifactId, limit: 101 })
  assert.equal(clamped.items.length, 1)
})

test('an unknown artifact is not found and deleting the artifact drops its threads', async () => {
  const { bot, artifactId } = await setup()
  const missing = await bot.endpoint('artifacts/annotations-create', {
    workspace_id: WS, artifact_id: 'a'.repeat(32), artifact_revision: 1,
  })
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'annotations/not-found')

  const { thread } = await ok(bot, 'artifacts/annotations-create', {
    workspace_id: WS, artifact_id: artifactId, artifact_revision: 1, body: '会随作品删除',
  })
  await ok(bot, 'artifacts/annotations-comment-add', { workspace_id: WS, thread_id: thread.id, body: '第二条' })
  const removed = await bot.call('artifacts', 'POST', `/v1/workspaces/${WS}/artifacts/${artifactId}/remove`, {})
  assert.equal(removed.status, 200)
  const db = store(bot)
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM annotation_threads').get().n, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM annotation_comments').get().n, 0)
  } finally { db.close() }
})

test('migrations are idempotent and threads survive a reboot', async () => {
  const { bot, artifactId } = await setup()
  const { thread } = await ok(bot, 'artifacts/annotations-create', {
    workspace_id: WS, artifact_id: artifactId, artifact_revision: 1, body: '重登后还在',
  })
  const again = await boot(bot.vol)
  const listed = await ok(again, 'artifacts/annotations-list', { workspace_id: WS, artifact_id: artifactId })
  assert.deepEqual(listed.items.map((item) => item.id), [thread.id])
  const detail = await ok(again, 'artifacts/annotations-get', { workspace_id: WS, thread_id: thread.id })
  assert.equal(detail.thread.comments[0].body, '重登后还在')
  const db = store(again)
  try {
    const versions = db.prepare('SELECT version FROM ot_feature_migrations WHERE feature=? ORDER BY version').all('artifacts')
    assert.deepEqual(versions.map((row) => row.version), [1, 2, 3, 4])
  } finally { db.close() }
})

test('another volume keeps its own annotations', async () => {
  const first = await setup()
  const second = volume()
  const other = await boot(second)
  const created = await other.endpoint('artifacts/create', {
    workspace_id: WS, title: '别的卷', body: '正文', kind: 'document', idempotency_key: key(),
  })
  assert.equal(created.ok, true, JSON.stringify(created))
  const artifactId = created.value.artifact.id
  await ok(first.bot, 'artifacts/annotations-create', {
    workspace_id: WS, artifact_id: first.artifactId, artifact_revision: 1,
  })
  const theirs = await ok(other, 'artifacts/annotations-list', { workspace_id: WS, artifact_id: artifactId })
  assert.deepEqual(theirs.items, [])
  const db = store(first.bot)
  try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM annotation_threads').get().n, 1) } finally { db.close() }
  const otherDb = store(other)
  try { assert.equal(otherDb.prepare('SELECT COUNT(*) AS n FROM annotation_threads').get().n, 0) } finally { otherDb.close() }
})
