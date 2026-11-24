// Threaded annotations on workspace artifacts, inside the artifacts feature
// (retried from the retired openteamily/annotations.py; no second copy remains).
//
// A thread is pinned to one artifact revision and holds comments. Comments are
// soft-deleted by their author, and @mentions are extracted and stored on the
// comment. The artifact row is the real parent here: a thread refuses an unknown
// artifact, is scoped to its workspace, and is dropped with the artifact.
//
// Identity note: this volume belongs to one owner, so live writes are always
// attributed to ctx.owner. The author check below is still load-bearing — it
// compares the stored author with the caller before edit/delete — but on a
// single-owner volume every row this API writes carries that same author. It is
// not claimed as multi-user collaboration.
import { HEX32, newId, nowSeconds, refuse, validLongText } from '../../featurekit/http.js'
import { usernames } from './library.js'

export const BODY_MAX = 4000
export const ANCHOR_MAX = 1000
export const MAX_MENTIONS = 20
export const LIST_LIMIT = 50
export const MAX_LIMIT = 100

// The retired module's account rule: 3–64 characters, starting alphanumeric.
const USERNAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$/
// A mention must not be part of an e-mail address or another word, and trailing
// sentence punctuation is not part of the handle.
const MENTION = /(?<![\w@.])@([A-Za-z0-9][A-Za-z0-9_.-]{2,63})(?![\w-])/g

const THREAD_SELECT = `SELECT t.*,
  (SELECT COUNT(*) FROM annotation_comments c
    WHERE c.thread_id=t.id AND c.workspace_id=t.workspace_id AND c.deleted=0) AS comment_count
  FROM annotation_threads t`
const COMMENT_SELECT = 'SELECT c.* FROM annotation_comments c'

const invalid = (message) => refuse(400, 'annotations/invalid', message)
const notFound = (message) => refuse(404, 'annotations/not-found', message)
const forbidden = (message) => refuse(403, 'annotations/forbidden', message)

function textValue(value, name, limit, required = false) {
  if (value === undefined || value === null) {
    if (required) invalid(`${name} is required`)
    return null
  }
  if (typeof value !== 'string') invalid(`${name} must be text`)
  if (value.length > limit) invalid(`${name} exceeds its bound`)
  if (!validLongText(value, limit)) invalid(`${name} contains control characters`)
  if (required && !value.trim()) invalid(`${name} is required`)
  return value
}

const bodyValue = (value) => textValue(value, 'body', BODY_MAX, true)

function revisionValue(value) {
  // Number.isInteger is false for booleans and strings; JSON cannot distinguish
  // 1 from 1.0, so a JSON float with no fraction is accepted as the integer.
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    invalid('artifact_revision must be a non-negative integer')
  }
  return value
}

function limitValue(value) {
  if (value === undefined || value === null) return LIST_LIMIT
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    invalid('limit must be a positive integer')
  }
  return Math.min(value, MAX_LIMIT)
}

function cursorValue(value) {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string' || !HEX32.test(value)) invalid('cursor must be a thread id')
  return value
}

function workspaceValue(payload) {
  const workspace = payload?.workspace_id
  if (typeof workspace !== 'string' || !HEX32.test(workspace)) invalid('Provide a workspace_id')
  return workspace
}

function artifactValue(store, workspace, artifactId) {
  if (typeof artifactId !== 'string' || !HEX32.test(artifactId)) invalid('Provide an artifact_id')
  if (!store.get('SELECT 1 AS ok FROM artifacts WHERE id=? AND workspace_id=?', artifactId, workspace)) {
    notFound('Artifact not found')
  }
  return artifactId
}

function threadRow(store, workspace, threadId) {
  if (typeof threadId !== 'string' || !HEX32.test(threadId)) invalid('Provide a thread_id')
  return store.get(`${THREAD_SELECT} WHERE t.id=? AND t.workspace_id=?`, threadId, workspace)
}

function requireThread(store, workspace, threadId) {
  const row = threadRow(store, workspace, threadId)
  if (!row) notFound('Annotation thread not found')
  return row
}

function commentRow(store, workspace, commentId) {
  if (typeof commentId !== 'string' || !HEX32.test(commentId)) invalid('Provide a comment_id')
  return store.get(`${COMMENT_SELECT} WHERE c.id=? AND c.workspace_id=?`, commentId, workspace)
}

function requireComment(store, workspace, commentId) {
  const row = commentRow(store, workspace, commentId)
  if (!row) notFound('Annotation comment not found')
  return row
}

export function extractMentions(body) {
  const names = []
  const seen = new Set()
  for (const match of String(body ?? '').matchAll(MENTION)) {
    const name = match[1].replace(/\.+$/, '').toLowerCase()
    if (!USERNAME.test(name) || seen.has(name)) continue
    seen.add(name)
    names.push(name)
    if (names.length >= MAX_MENTIONS) break
  }
  return names
}

function decodeMentions(raw) {
  try {
    const value = JSON.parse(raw ?? '[]')
    if (!Array.isArray(value)) return []
    return value.filter((name) => typeof name === 'string' && USERNAME.test(name)).slice(0, MAX_MENTIONS)
  } catch {
    return []
  }
}

function commentView(store, row) {
  const name = usernames(store)
  return {
    id: row.id,
    thread_id: row.thread_id,
    workspace_id: row.workspace_id,
    author_id: row.author_id,
    author_username: name(row.author_id),
    body: row.body,
    mentions: decodeMentions(row.mentions),
    created: row.created,
    updated: row.updated,
    deleted: Boolean(row.deleted),
  }
}

function threadView(store, row, comments = null) {
  const name = usernames(store)
  const data = {
    id: row.id,
    workspace_id: row.workspace_id,
    artifact_id: row.artifact_id,
    artifact_revision: row.artifact_revision,
    anchor: row.anchor,
    resolved: Boolean(row.resolved),
    created_by: row.created_by,
    created_by_username: name(row.created_by),
    created: row.created,
    updated: row.updated,
    comment_count: row.comment_count,
  }
  if (comments) data.comments = comments
  return data
}

function commentsOf(store, workspace, threadId) {
  return store.all(
    `${COMMENT_SELECT} WHERE c.workspace_id=? AND c.thread_id=? AND c.deleted=0 ORDER BY c.id`,
    workspace, threadId,
  ).map((row) => commentView(store, row))
}

function fullThread(store, workspace, threadId) {
  const row = requireThread(store, workspace, threadId)
  return { thread: threadView(store, row, commentsOf(store, workspace, threadId)) }
}

function insertComment(store, workspace, threadId, author, body, now) {
  const mentions = extractMentions(body)
  const id = newId()
  store.run(
    'INSERT INTO annotation_comments '
    + '(id,thread_id,workspace_id,author_id,body,mentions,created,updated,deleted) '
    + 'VALUES(?,?,?,?,?,?,?,?,0)',
    id, threadId, workspace, author, body, JSON.stringify(mentions), now, now,
  )
  store.run('UPDATE annotation_threads SET updated=? WHERE id=? AND workspace_id=?', now, threadId, workspace)
  return store.get(`${COMMENT_SELECT} WHERE c.id=?`, id)
}

// Endpoint table for the artifacts feature. Keys stay inside this feature's
// namespace, so a page calls them as artifacts/annotations-*.
export function annotationEndpoints({ store, owner }) {
  const me = owner ?? 'owner'
  const inputOf = (payload) => (payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {})

  return {
    async 'annotations-create'(payload) {
      const input = inputOf(payload)
      const workspace = workspaceValue(input)
      const artifact = artifactValue(store, workspace, input.artifact_id)
      const revision = revisionValue(input.artifact_revision)
      const anchor = textValue(input.anchor, 'anchor', ANCHOR_MAX)
      const body = input.body === undefined || input.body === null ? null : bodyValue(input.body)
      const id = newId()
      const now = nowSeconds()
      store.transaction(() => {
        store.run(
          'INSERT INTO annotation_threads '
          + '(id,workspace_id,artifact_id,artifact_revision,anchor,resolved,created_by,created,updated) '
          + 'VALUES(?,?,?,?,?,0,?,?,?)',
          id, workspace, artifact, revision, anchor, me, now, now,
        )
        if (body !== null) insertComment(store, workspace, id, me, body, now)
      })
      return fullThread(store, workspace, id)
    },

    async 'annotations-list'(payload) {
      const input = inputOf(payload)
      const workspace = workspaceValue(input)
      const artifact = artifactValue(store, workspace, input.artifact_id)
      const revision = input.revision === undefined || input.revision === null ? null : revisionValue(input.revision)
      let resolved = null
      if (input.resolved !== undefined && input.resolved !== null) {
        if (typeof input.resolved !== 'boolean') invalid('resolved must be a boolean')
        resolved = input.resolved
      }
      const limit = limitValue(input.limit)
      const cursor = cursorValue(input.cursor)
      // Ordered by id (a random 32-hex value) so paging is stable but not
      // chronological; this is the retired module's order, kept for parity.
      let sql = `${THREAD_SELECT} WHERE t.workspace_id=? AND t.artifact_id=?`
      const args = [workspace, artifact]
      if (revision !== null) { sql += ' AND t.artifact_revision=?'; args.push(revision) }
      if (resolved !== null) { sql += ' AND t.resolved=?'; args.push(resolved ? 1 : 0) }
      if (cursor) { sql += ' AND t.id>?'; args.push(cursor) }
      sql += ' ORDER BY t.id ASC LIMIT ?'
      args.push(limit + 1)
      const rows = store.all(sql, ...args)
      return {
        items: rows.slice(0, limit).map((row) => threadView(store, row)),
        cursor: rows.length > limit ? rows[limit - 1].id : null,
      }
    },

    async 'annotations-get'(payload) {
      const input = inputOf(payload)
      return fullThread(store, workspaceValue(input), input.thread_id)
    },

    async 'annotations-resolve'(payload) {
      const input = inputOf(payload)
      const workspace = workspaceValue(input)
      const thread = requireThread(store, workspace, input.thread_id)
      let resolved = true
      if (input.resolved !== undefined && input.resolved !== null) {
        if (typeof input.resolved !== 'boolean') invalid('resolved must be a boolean')
        resolved = input.resolved
      }
      store.run(
        'UPDATE annotation_threads SET resolved=?, updated=? WHERE id=? AND workspace_id=?',
        resolved ? 1 : 0, nowSeconds(), thread.id, workspace,
      )
      return fullThread(store, workspace, thread.id)
    },

    async 'annotations-count'(payload) {
      const input = inputOf(payload)
      const workspace = workspaceValue(input)
      const artifact = artifactValue(store, workspace, input.artifact_id)
      const row = store.get(
        'SELECT COUNT(*) AS n FROM annotation_threads WHERE workspace_id=? AND artifact_id=? AND resolved=0',
        workspace, artifact,
      )
      return { open: row.n }
    },

    async 'annotations-comment-add'(payload) {
      const input = inputOf(payload)
      const workspace = workspaceValue(input)
      const thread = requireThread(store, workspace, input.thread_id)
      const body = bodyValue(input.body)
      let row
      store.transaction(() => { row = insertComment(store, workspace, thread.id, me, body, nowSeconds()) })
      return { comment: commentView(store, row) }
    },

    async 'annotations-comment-edit'(payload) {
      const input = inputOf(payload)
      const workspace = workspaceValue(input)
      const row = requireComment(store, workspace, input.comment_id)
      if (row.author_id !== me) forbidden('Only the comment author may edit it')
      if (row.deleted) notFound('Annotation comment was deleted')
      const body = bodyValue(input.body)
      const mentions = extractMentions(body)
      const now = nowSeconds()
      store.transaction(() => {
        store.run(
          'UPDATE annotation_comments SET body=?, mentions=?, updated=? WHERE id=? AND workspace_id=?',
          body, JSON.stringify(mentions), now, row.id, workspace,
        )
        store.run('UPDATE annotation_threads SET updated=? WHERE id=? AND workspace_id=?', now, row.thread_id, workspace)
      })
      return { comment: commentView(store, requireComment(store, workspace, row.id)) }
    },

    async 'annotations-comment-delete'(payload) {
      const input = inputOf(payload)
      const workspace = workspaceValue(input)
      const row = requireComment(store, workspace, input.comment_id)
      if (row.author_id !== me) forbidden('Only the comment author may delete it')
      const now = nowSeconds()
      store.transaction(() => {
        store.run(
          'UPDATE annotation_comments SET deleted=1, updated=? WHERE id=? AND workspace_id=?',
          now, row.id, workspace,
        )
        store.run('UPDATE annotation_threads SET updated=? WHERE id=? AND workspace_id=?', now, row.thread_id, workspace)
      })
      return { comment: commentView(store, requireComment(store, workspace, row.id)) }
    },
  }
}
