// Feedback (port of openteamily/feedback.py) for this user's own DS-Bot.
//
// Feedback is persisted locally in /data/openteamily/features/feedback and is
// never sent anywhere or used to train/rank anything. Records are private to a
// workspace: list/aggregate/recent only read the requested workspace, and remove
// only deletes the caller's own row in that workspace.
//
// Actor and workspace semantics:
// * The actor is this DS-Bot's owner. When the manager supplies
//   OPENTEAMILY_OWNER_USER_ID (or the platform later attaches it), payload
//   user_id is only accepted when it equals that owner. Without a configured
//   owner id this is a single-tenant runtime, so an explicit local author id may
//   be supplied for legacy imports/tests; otherwise the row is owned by 'owner'.
// * workspace_id is supplied by the caller (the page's workspace), falling back
//   to OPENTEAMILY_WORKSPACE_ID and then this DS-Bot's instance id.
// * list is workspace-wide by default so an owner can review a target; pass
//   user_id to restrict it to one author. aggregate and recent are always
//   workspace-scoped and ignore authors.
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { openStore } from '../../featurekit/store.js'
import { HEX32, refuse } from '../../featurekit/http.js'
import { ownerId } from '../../featurekit/v1.js'

export const TARGET_TYPES = Object.freeze(['message', 'task', 'agent', 'work'])
export const KINDS = Object.freeze(['rating', 'thumbs'])
export const RATING_SCORES = Object.freeze([1, 2, 3, 4, 5])
export const THUMB_SCORES = Object.freeze([-1, 1])
export const DISTRIBUTION_SCORES = RATING_SCORES
export const TARGET_ID_MAX = 128
export const REASON_MAX = 500
export const COMMENT_MAX = 4000
export const LIMIT_MAX = 100
export const DEFAULT_LIMIT = 20

const ID_MAX = 128
const NUL = '\u0000'
const COLUMNS = ['id', 'workspace_id', 'user_id', 'target_type', 'target_id', 'kind', 'score', 'reason', 'comment', 'created', 'updated']

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS feedback (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL,
 user_id TEXT NOT NULL,
 target_type TEXT NOT NULL CHECK(target_type IN ('message','task','agent','work')),
 target_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('rating','thumbs')),
 score INTEGER NOT NULL,
 reason TEXT,
 comment TEXT,
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL,
 CHECK((kind='rating' AND score BETWEEN 1 AND 5) OR (kind='thumbs' AND score IN (-1,1))),
 UNIQUE(workspace_id, user_id, target_type, target_id, kind));
CREATE INDEX IF NOT EXISTS feedback_target ON feedback(workspace_id, target_type, target_id, created, id);
CREATE INDEX IF NOT EXISTS feedback_user ON feedback(workspace_id, user_id, created, id);
CREATE INDEX IF NOT EXISTS feedback_recent ON feedback(workspace_id, created, id);
`

export function ensureSchema(store) {
  store.exec(SCHEMA)
}

const isText = (value, maximum) => typeof value === 'string' && value.length >= 1 && value.length <= maximum && !value.includes(NUL)
const validOptionalText = (value, maximum) => value === undefined || value === null || (typeof value === 'string' && value.length <= maximum && !value.includes(NUL))
const fail = (code, message, status = 400) => refuse(status, `feedback/${code}`, message)
const nowSeconds = () => Math.floor(Date.now() / 1000)

export function view(row) {
  return Object.fromEntries(COLUMNS.map((key) => [key, row[key] ?? null]))
}

function validateWorkspace(value) {
  if (!isText(value, ID_MAX)) fail('invalid-workspace', 'workspace_id required')
  return value
}

function validateUserId(value) {
  if (!isText(value, ID_MAX)) fail('invalid-user', 'Invalid user_id')
  return value
}

function validateTarget(targetType, targetId) {
  if (typeof targetType !== 'string' || !TARGET_TYPES.includes(targetType)) fail('invalid-target', 'Invalid target type')
  if (!isText(targetId, TARGET_ID_MAX) || !targetId.trim()) fail('invalid-target', 'Invalid target id')
  return { targetType, targetId }
}

function validateKind(kind) {
  if (typeof kind !== 'string' || !KINDS.includes(kind)) fail('invalid-kind', 'Invalid feedback kind')
  return kind
}

function validateScore(kind, score) {
  if (!Number.isInteger(score) || typeof score !== 'number') fail('invalid-score', 'Invalid feedback score')
  if (kind === 'rating' && !RATING_SCORES.includes(score)) fail('invalid-score', 'Rating score must be between 1 and 5')
  if (kind === 'thumbs' && !THUMB_SCORES.includes(score)) fail('invalid-score', 'Thumbs score must be -1 or 1')
  return score
}

function validateOptionalText(value, maximum) {
  if (value !== undefined && value !== null && typeof value !== 'string') fail('invalid-text', 'Text must be a string')
  if (!validOptionalText(value, maximum)) fail('too-large', `Text must be at most ${maximum} characters`, 413)
  return value ?? null
}

function validateTimestamp(value) {
  if (!Number.isInteger(value) || value < 0) fail('invalid', 'Invalid timestamp')
  return value
}

function validateLimit(value) {
  if (value === undefined || value === null) return DEFAULT_LIMIT
  if (!Number.isInteger(value) || value < 1 || value > LIMIT_MAX) fail('invalid-limit', `limit must be an integer from 1 to ${LIMIT_MAX}`)
  return value
}

function workspaceOf(host, payload, env) {
  const value = payload?.workspace_id ?? env.OPENTEAMILY_WORKSPACE_ID ?? host?.identity?.instanceId ?? 'owner'
  return validateWorkspace(value)
}

function authorOf(payload, env) {
  const configured = ownerId(env)
  const requested = payload?.user_id
  if (configured !== 'owner') {
    if (requested !== undefined && requested !== null && requested !== configured) fail('forbidden', 'Feedback belongs to this DS-Bot owner', 403)
    return configured
  }
  if (requested === undefined || requested === null) return 'owner'
  return validateUserId(requested)
}

function timestampOf(payload, clock) {
  return payload?.now === undefined || payload?.now === null ? clock() : validateTimestamp(payload.now)
}

export function createFeedback({ store, host = {}, env = process.env, clock = nowSeconds }) {
  ensureSchema(store)

  const endpoints = {
    async submit(payload) {
      const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
      const workspaceId = workspaceOf(host, p, env)
      const userId = authorOf(p, env)
      const { targetType, targetId } = validateTarget(p.target_type, p.target_id)
      const kind = validateKind(p.kind)
      const score = validateScore(kind, p.score)
      const reason = validateOptionalText(p.reason, REASON_MAX)
      const comment = validateOptionalText(p.comment, COMMENT_MAX)
      const at = timestampOf(p, clock)
      store.run(`INSERT INTO feedback (${COLUMNS.join(',')}) VALUES (${COLUMNS.map(() => '?').join(',')})
        ON CONFLICT(workspace_id, user_id, target_type, target_id, kind)
        DO UPDATE SET score=excluded.score, reason=excluded.reason, comment=excluded.comment, updated=excluded.updated`,
      randomBytes(16).toString('hex'), workspaceId, userId, targetType, targetId, kind, score, reason, comment, at, at)
      const feedback = view(store.get('SELECT * FROM feedback WHERE workspace_id=? AND user_id=? AND target_type=? AND target_id=? AND kind=?',
        workspaceId, userId, targetType, targetId, kind))
      return { feedback, ...feedback }
    },

    async remove(payload) {
      const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
      const workspaceId = workspaceOf(host, p, env)
      const userId = authorOf(p, env)
      const id = p.id ?? p.feedback_id
      if (!isText(id, ID_MAX)) return { removed: false, id: id ?? null }
      const result = store.run('DELETE FROM feedback WHERE id=? AND workspace_id=? AND user_id=?', id, workspaceId, userId)
      return { removed: Number(result.changes) > 0, id }
    },

    async list(payload) {
      const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
      const workspaceId = workspaceOf(host, p, env)
      const limit = validateLimit(p.limit)
      let sql = 'SELECT * FROM feedback WHERE workspace_id=?'
      const args = [workspaceId]
      if (p.target_type !== undefined && p.target_type !== null) {
        if (typeof p.target_type !== 'string' || !TARGET_TYPES.includes(p.target_type)) fail('invalid-target', 'Invalid target type')
        sql += ' AND target_type=?'
        args.push(p.target_type)
      }
      if (p.target_id !== undefined && p.target_id !== null) {
        if (!isText(p.target_id, TARGET_ID_MAX) || !p.target_id.trim()) fail('invalid-target', 'Invalid target id')
        sql += ' AND target_id=?'
        args.push(p.target_id)
      }
      if (p.user_id !== undefined && p.user_id !== null) {
        sql += ' AND user_id=?'
        args.push(validateUserId(p.user_id))
      }
      let offset = null
      if (p.offset !== undefined && p.offset !== null) {
        if (!Number.isInteger(p.offset) || p.offset < 0) fail('invalid-cursor', 'Invalid offset')
        offset = p.offset
      }
      if (p.cursor !== undefined && p.cursor !== null && p.cursor !== '') {
        if (offset !== null) fail('invalid-cursor', 'cursor and offset are mutually exclusive')
        if (typeof p.cursor !== 'string' || !HEX32.test(p.cursor)) fail('invalid-cursor', 'Invalid cursor')
        const anchor = store.get('SELECT created, id FROM feedback WHERE id=? AND workspace_id=?', p.cursor, workspaceId)
        if (!anchor) return { items: [], cursor: null }
        sql += ' AND (created<? OR (created=? AND id<?))'
        args.push(anchor.created, anchor.created, anchor.id)
      }
      sql += ' ORDER BY created DESC, id DESC LIMIT ?'
      args.push(limit + 1)
      if (offset !== null) {
        sql += ' OFFSET ?'
        args.push(offset)
      }
      const rows = store.all(sql, ...args)
      const items = rows.slice(0, limit).map(view)
      return { items, cursor: rows.length > limit ? items[items.length - 1].id : null }
    },

    async aggregate(payload) {
      const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
      const workspaceId = workspaceOf(host, p, env)
      const { targetType, targetId } = validateTarget(p.target_type, p.target_id)
      const rows = store.all(`SELECT kind, score, COUNT(*) AS amount FROM feedback
        WHERE workspace_id=? AND target_type=? AND target_id=? GROUP BY kind, score`, workspaceId, targetType, targetId)
      const distribution = Object.fromEntries(DISTRIBUTION_SCORES.map((score) => [score, 0]))
      let count = 0
      let ratings = 0
      let ratingTotal = 0
      let thumbsUp = 0
      let thumbsDown = 0
      for (const row of rows) {
        const amount = Number(row.amount) || 0
        count += amount
        if (row.kind === 'rating') {
          distribution[row.score] = amount
          ratings += amount
          ratingTotal += Number(row.score) * amount
        } else if (Number(row.score) === 1) thumbsUp += amount
        else thumbsDown += amount
      }
      const aggregate = {
        count,
        average: ratings ? ratingTotal / ratings : null,
        distribution,
        thumbs_up: thumbsUp,
        thumbs_down: thumbsDown,
      }
      return { ...aggregate, aggregate }
    },

    async recent(payload) {
      const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
      const workspaceId = workspaceOf(host, p, env)
      const limit = validateLimit(p.limit)
      const rows = store.all('SELECT * FROM feedback WHERE workspace_id=? ORDER BY created DESC, id DESC LIMIT ?', workspaceId, limit)
      return { items: rows.map(view) }
    },
  }

  return { endpoints }
}

export default function feedback(host) {
  const store = openStore(join(host.featureDir(), 'feedback.sqlite3'))
  store.migrate('feedback', [SCHEMA])
  return createFeedback({ store, host })
}
