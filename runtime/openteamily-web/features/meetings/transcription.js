// Consent-aware meeting transcript sessions and speaker-labelled segments
// (legacy openteamily/transcription.py). They run inside this DS-Bot and share
// the meetings feature's private SQLite file; the owner of this DS-Bot is the
// only actor. This module stores and serves transcripts: it never captures
// audio/video, runs an ASR engine, diarizes a stream, joins calls or uses the
// network. A session must be started with explicit consent; withdrawing it marks
// the session failed and blocks further appends. Search is a bounded literal
// LIKE scan, not a ranking or semantic search, and it only covers sessions whose
// consent remains.
import { CONTROL, newId, refuse, requireBodyKeys } from '../../featurekit/http.js'

export const LIMITS = {
  MEETING_MAX: 128, LANGUAGE_MAX: 35, SPEAKER_MAX: 80, TEXT_MAX: 8000, QUERY_MAX: 200,
  LIMIT_MAX: 200, MAX_MS: 7 * 24 * 60 * 60 * 1000, LIMIT_DEFAULT: 100, SEARCH_DEFAULT: 50,
  BODY: 512 * 1024,
}

const LANGUAGE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,34}$/
const SESSION_FIELDS = ['meeting_id', 'language', 'consent', 'consent_by']
const SEGMENT_FIELDS = ['speaker_id', 'start_ms', 'end_ms', 'text', 'confidence']

const isInt = (value) => Number.isInteger(value)
const strip = (value) => value.trim()
const validToken = (value, maximum) => typeof value === 'string' && strip(value).length >= 1
  && value.length <= maximum && !CONTROL.test(value)
const validText = (value, maximum) => typeof value === 'string' && strip(value).length >= 1
  && value.length <= maximum && !CONTROL.test(value)
const validLanguage = (value) => typeof value === 'string' && LANGUAGE_RE.test(strip(value))
const validConfidence = (value) => value === undefined || value === null
  || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1)

export const sessionView = (row) => row && {
  id: row.id, workspace_id: row.workspace_id, meeting_id: row.meeting_id, created_by: row.created_by,
  language: row.language, status: row.status, consent: Boolean(row.consent), consent_by: row.consent_by,
  consent_at: row.consent_at, started: row.started, ended: row.ended, created: row.created, updated: row.updated,
}

export const segmentView = (row) => row && {
  id: row.id, session_id: row.session_id, workspace_id: row.workspace_id, speaker_id: row.speaker_id,
  start_ms: row.start_ms, end_ms: row.end_ms, text: row.text, confidence: row.confidence, created: row.created,
}

const load = (store, workspaceId, sessionId) => store.get(
  'SELECT * FROM transcription_sessions WHERE id=? AND workspace_id=?', sessionId, workspaceId)

function requireSession(store, workspaceId, sessionId) {
  const row = load(store, workspaceId, sessionId)
  if (!row) refuse(404, 'not_found', 'Transcript session not found')
  return row
}

function readable(req) {
  if (req.queryString) refuse(400, 'invalid', 'Queries are not supported')
}

function onlyPost(req) {
  if (req.method !== 'POST' || req.queryString) refuse(400, 'invalid', 'Invalid transcript request')
}

function parseLimit(raw, fallback) {
  if (raw === null) return fallback
  if (!/^[0-9]{1,3}$/.test(raw)) refuse(400, 'invalid_limit', 'Limit is out of bounds')
  const limit = Number(raw)
  if (limit < 1 || limit > LIMITS.LIMIT_MAX) refuse(400, 'invalid_limit', 'Limit is out of bounds')
  return limit
}

function parseMs(raw) {
  if (raw === null) return null
  if (!/^[0-9]{1,15}$/.test(raw)) refuse(400, 'invalid_time_range', 'Invalid filter time range')
  return Number(raw)
}

function queryKeys(req, allowed) {
  const keys = [...req.query.keys()]
  if (keys.some((key) => !allowed.includes(key) || req.query.getAll(key).length !== 1)) {
    refuse(400, 'invalid', 'Invalid query parameters')
  }
}

async function createSession(req, workspaceId) {
  onlyPost(req)
  const body = requireBodyKeys(await req.json(LIMITS.BODY), SESSION_FIELDS)
  const { meeting_id: meetingId, language = 'en', consent = false, consent_by: consentBy } = body
  if (typeof consent !== 'boolean') refuse(400, 'invalid_consent', 'Consent must be a boolean')
  if (!consent) refuse(403, 'consent_required', 'Transcript consent is required')
  if (!validToken(meetingId, LIMITS.MEETING_MAX)) refuse(400, 'invalid_meeting', 'Invalid meeting id')
  if (!validLanguage(language)) refuse(400, 'invalid_language', 'Invalid language tag')
  if (consentBy !== undefined && consentBy !== null && !validToken(consentBy, LIMITS.MEETING_MAX)) {
    refuse(400, 'invalid_user', 'Invalid consenting user id')
  }
  const consenting = consentBy ?? req.owner
  const id = newId()
  const now = req.now
  req.store.run(
    'INSERT INTO transcription_sessions (id, workspace_id, meeting_id, created_by, language, status, consent, consent_by, consent_at, started, ended, created, updated) '
    + 'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    id, workspaceId, strip(meetingId), req.owner, strip(language), 'recording', 1, consenting, now, now, null, now, now,
  )
  return { status: 201, body: { session: sessionView(load(req.store, workspaceId, id)) } }
}

function getSession(req, workspaceId, sessionId) {
  if (req.method !== 'GET') refuse(400, 'invalid', 'Invalid transcript request')
  readable(req)
  return { body: { session: sessionView(requireSession(req.store, workspaceId, sessionId)) } }
}

async function appendSegment(req, workspaceId, sessionId) {
  onlyPost(req)
  const row = requireSession(req.store, workspaceId, sessionId)
  if (!row.consent) refuse(403, 'consent_required', 'Transcript consent is required')
  if (row.status !== 'recording') refuse(409, 'not_recording', 'Transcript session is not recording')
  const body = requireBodyKeys(await req.json(LIMITS.BODY), SEGMENT_FIELDS)
  const { speaker_id: speakerId, start_ms: startMs, end_ms: endMs, text, confidence } = body
  if (!validToken(speakerId, LIMITS.SPEAKER_MAX)) refuse(400, 'invalid_speaker', 'Invalid speaker id')
  if (!isInt(startMs) || !isInt(endMs)) refuse(400, 'invalid_time_range', 'Segment times must be integers')
  if (startMs < 0 || endMs <= startMs || endMs > LIMITS.MAX_MS) {
    refuse(400, 'invalid_time_range', 'Segment time range is out of bounds')
  }
  if (!validText(text, LIMITS.TEXT_MAX)) refuse(400, 'invalid_text', 'Segment text is empty or too long')
  if (!validConfidence(confidence)) refuse(400, 'invalid_confidence', 'Confidence must be between 0 and 1')
  const last = req.store.get(
    'SELECT start_ms, end_ms FROM transcript_segments WHERE workspace_id=? AND session_id=? ORDER BY start_ms DESC, id DESC LIMIT 1',
    workspaceId, sessionId,
  )
  if (last && startMs < last.end_ms) refuse(409, 'overlap', 'Segments must be ordered and non-overlapping')
  const id = newId()
  req.store.run(
    'INSERT INTO transcript_segments (id, session_id, workspace_id, speaker_id, start_ms, end_ms, text, confidence, created) VALUES (?,?,?,?,?,?,?,?,?)',
    id, sessionId, workspaceId, strip(speakerId), startMs, endMs, text, confidence ?? null, req.now,
  )
  return {
    status: 201,
    body: { segment: segmentView(req.store.get('SELECT * FROM transcript_segments WHERE id=? AND workspace_id=?', id, workspaceId)) },
  }
}

function finalize(req, workspaceId, sessionId) {
  onlyPost(req)
  const row = requireSession(req.store, workspaceId, sessionId)
  if (row.status !== 'pending' && row.status !== 'recording') {
    refuse(409, 'not_recording', 'Transcript session cannot be finalized')
  }
  req.store.run('UPDATE transcription_sessions SET status=?, ended=?, updated=? WHERE id=? AND workspace_id=?',
    'transcribed', req.now, req.now, sessionId, workspaceId)
  return { body: { session: sessionView(load(req.store, workspaceId, sessionId)) } }
}

function fail(req, workspaceId, sessionId) {
  onlyPost(req)
  const row = requireSession(req.store, workspaceId, sessionId)
  if (row.status === 'transcribed') refuse(409, 'not_recording', 'A finalized session cannot fail')
  req.store.run('UPDATE transcription_sessions SET status=?, ended=?, updated=? WHERE id=? AND workspace_id=?',
    'failed', req.now, req.now, sessionId, workspaceId)
  return { body: { session: sessionView(load(req.store, workspaceId, sessionId)) } }
}

function withdraw(req, workspaceId, sessionId) {
  onlyPost(req)
  requireSession(req.store, workspaceId, sessionId)
  req.store.run(
    'UPDATE transcription_sessions SET consent=0, status=?, ended=COALESCE(ended, ?), updated=? WHERE id=? AND workspace_id=?',
    'failed', req.now, req.now, sessionId, workspaceId,
  )
  return { body: { session: sessionView(load(req.store, workspaceId, sessionId)) } }
}

function remove(req, workspaceId, sessionId) {
  onlyPost(req)
  requireSession(req.store, workspaceId, sessionId)
  req.store.run('DELETE FROM transcript_segments WHERE workspace_id=? AND session_id=?', workspaceId, sessionId)
  req.store.run('DELETE FROM transcription_sessions WHERE id=? AND workspace_id=?', sessionId, workspaceId)
  return { body: { removed: true } }
}

function listSegments(req, workspaceId, sessionId) {
  if (req.method !== 'GET') refuse(400, 'invalid', 'Invalid transcript request')
  queryKeys(req, ['limit', 'cursor', 'start_ms', 'end_ms'])
  const limit = parseLimit(req.query.get('limit'), LIMITS.LIMIT_DEFAULT)
  const startMs = parseMs(req.query.get('start_ms'))
  const endMs = parseMs(req.query.get('end_ms'))
  const cursor = req.query.get('cursor') ?? ''
  if (cursor.length > 64) refuse(400, 'invalid_cursor', 'Invalid cursor')
  if (!load(req.store, workspaceId, sessionId)) return { body: { items: [], cursor: null } }
  let tail = ''
  const args = [workspaceId, sessionId]
  if (startMs !== null) {
    tail += ' AND end_ms > ?'
    args.push(startMs)
  }
  if (endMs !== null) {
    tail += ' AND start_ms < ?'
    args.push(endMs)
  }
  if (cursor) {
    const seat = req.store.get(
      'SELECT start_ms FROM transcript_segments WHERE id=? AND workspace_id=? AND session_id=?',
      cursor, workspaceId, sessionId,
    )
    if (!seat) return { body: { items: [], cursor: null } }
    tail += ' AND (start_ms > ? OR (start_ms = ? AND id > ?))'
    args.push(seat.start_ms, seat.start_ms, cursor)
  }
  const rows = req.store.all(
    'SELECT * FROM transcript_segments WHERE workspace_id=? AND session_id=?' + tail + ' ORDER BY start_ms, id LIMIT ?',
    ...args, limit + 1,
  )
  const items = rows.slice(0, limit).map(segmentView)
  return { body: { items, cursor: rows.length > limit ? items[items.length - 1].id : null } }
}

function searchTranscripts(req, workspaceId) {
  if (req.method !== 'GET') refuse(400, 'invalid', 'Invalid transcript request')
  queryKeys(req, ['q', 'limit'])
  const query = req.query.get('q') ?? ''
  if (!strip(query) || query.trim().length > LIMITS.QUERY_MAX || CONTROL.test(query)) {
    refuse(400, 'invalid_query', 'Invalid search query')
  }
  const limit = parseLimit(req.query.get('limit'), LIMITS.SEARCH_DEFAULT)
  const like = '%' + query.trim().replace(/[\\%_]/g, (char) => '\\' + char) + '%'
  const rows = req.store.all(
    'SELECT g.*, s.meeting_id AS meeting_id FROM transcript_segments g '
    + 'JOIN transcription_sessions s ON s.id=g.session_id AND s.workspace_id=g.workspace_id '
    + "WHERE g.workspace_id=? AND s.consent=1 AND g.text LIKE ? ESCAPE '\\' "
    + 'ORDER BY g.start_ms, g.id LIMIT ?',
    workspaceId, like, limit,
  )
  return { body: { items: rows.map((row) => ({ ...segmentView(row), meeting_id: row.meeting_id })) } }
}

async function action(req, workspaceId, sessionId, name) {
  if (!['finalize', 'fail', 'withdraw', 'remove'].includes(name)) return null
  requireBodyKeys(await req.json(LIMITS.BODY), [])
  if (name === 'finalize') return finalize(req, workspaceId, sessionId)
  if (name === 'fail') return fail(req, workspaceId, sessionId)
  if (name === 'withdraw') return withdraw(req, workspaceId, sessionId)
  return remove(req, workspaceId, sessionId)
}

const WORKSPACE = '([0-9a-f]{32})'
const SESSION = '([0-9a-f]{32})'

export const transcriptionMigrations = [`CREATE TABLE IF NOT EXISTS transcription_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  meeting_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  language TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'recording', 'transcribed', 'failed')),
  consent INTEGER NOT NULL CHECK(consent IN (0, 1)),
  consent_by TEXT,
  consent_at INTEGER,
  started INTEGER,
  ended INTEGER,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS transcription_session_workspace ON transcription_sessions(workspace_id, id);
CREATE INDEX IF NOT EXISTS transcription_session_meeting ON transcription_sessions(workspace_id, meeting_id, created);
CREATE TABLE IF NOT EXISTS transcript_segments (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  speaker_id TEXT NOT NULL,
  start_ms INTEGER NOT NULL CHECK(start_ms >= 0),
  end_ms INTEGER NOT NULL CHECK(end_ms > start_ms),
  text TEXT NOT NULL,
  confidence REAL CHECK(confidence IS NULL OR (confidence >= 0.0 AND confidence <= 1.0)),
  created INTEGER NOT NULL,
  UNIQUE(session_id, start_ms, speaker_id));
CREATE INDEX IF NOT EXISTS transcript_segment_session ON transcript_segments(workspace_id, session_id, start_ms, id);
CREATE INDEX IF NOT EXISTS transcript_segment_speaker ON transcript_segments(workspace_id, session_id, speaker_id, start_ms);`]

export const transcriptionRoutes = [
  { pattern: new RegExp(`^/v1/workspaces/${WORKSPACE}/meetings/transcripts/search$`), handle: (req, workspaceId) => searchTranscripts(req, workspaceId) },
  { pattern: new RegExp(`^/v1/workspaces/${WORKSPACE}/meetings/transcripts$`), handle: (req, workspaceId) => createSession(req, workspaceId) },
  { pattern: new RegExp(`^/v1/workspaces/${WORKSPACE}/meetings/transcripts/${SESSION}$`), handle: (req, workspaceId, sessionId) => getSession(req, workspaceId, sessionId) },
  { pattern: new RegExp(`^/v1/workspaces/${WORKSPACE}/meetings/transcripts/${SESSION}/segments$`), handle: (req, workspaceId, sessionId) => (req.method === 'GET' ? listSegments(req, workspaceId, sessionId) : appendSegment(req, workspaceId, sessionId)) },
  { pattern: new RegExp(`^/v1/workspaces/${WORKSPACE}/meetings/transcripts/${SESSION}/(finalize|fail|withdraw|remove)$`), handle: (req, workspaceId, sessionId, name) => action(req, workspaceId, sessionId, name) },
]
