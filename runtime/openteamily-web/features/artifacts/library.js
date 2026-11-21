// Works-library operations (legacy artifacts.py + app.py artifact_*), executed
// inside this user's DS-Bot. Share records live here; the public /share/<token>
// page is rendered by the dedicated Bot Social from a published snapshot.
import { createHash, randomBytes } from 'node:crypto'
import { digest, HEX32, newId, nowSeconds, refuse, stableJson } from '../../featurekit/http.js'
import {
  emptyBoard, emptyDashboard, emptySlides, MEDIA_MIMES, preview, PREFIX_LEN, publicKind, ROW_SELECT, SHARE_CSP, sourceView,
  TITLE_MAX, titleHash, TOKEN, validBody, validTitle,
} from './model.js'
import { attachMedia, mediaDigests, readMediaBytes, unlinkMedia, writeMedia } from './media.js'
import {
  applyBoardOperations, boardJson, dashboardJson, decodeBoard, decodeDashboard, decodeSlides, decodeStructured,
  normalizeBoard, normalizeDashboard, normalizeSlides, slidesJson,
} from './structured.js'
import { cleanFilename, exportFilename, exportHeaders, renderBoardSvg, renderDashboardPage, renderPage, renderSlidesPage, renderWebsitePage, sniffMime } from './render.js'
import { exportOffice } from './office.js'
import {decodeWorkbook,emptyWorkbook,normalizeWorkbook} from './workbook.js'
export const PER_WORKSPACE = 50
export const MAX_VERSIONS = 100
export const MAX_SHARES = 10
export const KEY = /^[A-Za-z0-9_-]{16,64}$/
const OFFICE = new Set(['docx', 'pdf', 'xlsx', 'pptx'])

export function usernames(store) {
  const map = new Map(store.all('SELECT id, username FROM ot_users').map((row) => [row.id, row.username]))
  const fallback = process.env.OPENTEAMILY_OWNER_USERNAME || store.get('SELECT username FROM ot_users WHERE is_owner=1 LIMIT 1')?.username || 'me'
  return (id) => map.get(id) ?? fallback
}

const named = (store, row) => {
  if (!row) return null
  const user = usernames(store)
  return { ...row, created_by_username: user(row.created_by), updated_by_username: user(row.updated_by) }
}

export const canEdit = (role, userId, row) => role === 'owner' || role === 'admin' || row.created_by === userId

export function load(store, workspaceId, id) {
  return named(store, store.get(ROW_SELECT + 'WHERE a.id=? AND a.workspace_id=?', id, workspaceId))
}

export function listing(store, workspaceId, cursor, limit, needle = '') {
  let rows = store.all(ROW_SELECT + 'WHERE a.workspace_id=? ORDER BY a.id', workspaceId).map((row) => named(store, row))
  if (needle) rows = rows.filter((row) => row.title.toLocaleLowerCase('en-US').includes(needle))
  if (cursor) rows = rows.filter((row) => row.id > cursor)
  return rows.slice(0, limit)
}

export function view(row, includeBody = true, { favorited } = {}) {
  const user = (field) => row[field + '_username'] ?? row[field]
  const data = {
    id: row.id, workspace_id: row.workspace_id, title: row.title, kind: publicKind(row),
    revision: row.revision, created: row.created, updated: row.updated,
    created_by: user('created_by'), updated_by: user('updated_by'),
  }
  const source = sourceView(row)
  if (source) data.source = source
  const kind = data.kind
  if (kind === 'media') data.media = { mime: row.media_mime, bytes: row.media_bytes, filename: row.media_filename }
  else if (kind === 'whiteboard' && includeBody) data.board = decodeBoard(row.board_json) ?? emptyBoard()
  else if (kind === 'slides' && includeBody) data.slides = decodeSlides(row.slides_json) ?? emptySlides()
  else if (kind === 'dashboard' && includeBody) data.dashboard = decodeDashboard(row.dashboard_json) ?? emptyDashboard()
  else if (kind === 'spreadsheet' && includeBody) data.spreadsheet = decodeWorkbook(row.spreadsheet_json) ?? emptyWorkbook()
  else if (includeBody && (kind === 'document' || kind === 'website')) data.body = row.body
  if (!includeBody) {
    const thumb = preview(row, { decodeBoard, decodeSlides, decodeDashboard })
    if (thumb != null) data.preview = thumb
  }
  if (favorited !== undefined) data.favorited = favorited
  return data
}

export function setRender(store, artifactId, kind) {
  store.run('DELETE FROM artifact_meta WHERE artifact_id=?', artifactId)
  if (kind === 'website') store.run('INSERT INTO artifact_meta VALUES(?,?)', artifactId, 'website')
}

export function attachBoard(store, artifactId, board) {
  const payload = boardJson(board)
  if (payload == null) return false
  store.run('DELETE FROM artifact_boards WHERE artifact_id=?', artifactId)
  store.run('INSERT INTO artifact_boards VALUES(?,?)', artifactId, payload)
  return true
}
export function attachSlides(store, artifactId, deck) {
  const payload = slidesJson(deck)
  if (payload == null) return false
  store.run('DELETE FROM artifact_slides WHERE artifact_id=?', artifactId)
  store.run('INSERT INTO artifact_slides VALUES(?,?)', artifactId, payload)
  return true
}
export function attachDashboard(store, artifactId, dashboard) {
  const payload = dashboardJson(dashboard)
  if (payload == null) return false
  store.run('DELETE FROM artifact_dashboards WHERE artifact_id=?', artifactId)
  store.run('INSERT INTO artifact_dashboards VALUES(?,?)', artifactId, payload)
  return true
}

function attachWorkbook(store,id,workbook) {
  store.run(`INSERT INTO artifact_spreadsheets VALUES(?,?) ON CONFLICT(artifact_id)
    DO UPDATE SET workbook=excluded.workbook`,id,JSON.stringify(workbook))
}

export function recordVersion(store, row) {
  const kind = publicKind(row)
  const storedKind = ['slides','dashboard','spreadsheet'].includes(kind) ? 'document' : kind
  let body = ''
  if (kind === 'slides') body = row.slides_json || slidesJson(emptySlides()) || ''
  else if (kind === 'dashboard') body = row.dashboard_json || dashboardJson(emptyDashboard()) || ''
  else if (kind === 'spreadsheet') body = row.spreadsheet_json
  else if (kind === 'document' || kind === 'website') body = row.body ?? ''
  store.run(
    'INSERT OR IGNORE INTO artifact_versions VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    row.id, row.revision, row.title, storedKind, body,
    kind === 'whiteboard' ? row.board_json : null,
    kind === 'media' ? row.media_mime : null,
    kind === 'media' ? row.media_bytes : null,
    kind === 'media' ? row.media_sha256 : null,
    kind === 'media' ? row.media_filename : null,
    row.updated, row.updated_by,
  )
}

export function saved(store, workspaceId, artifactId, status) {
  const row = load(store, workspaceId, artifactId)
  recordVersion(store, row)
  return { status, body: { artifact: view(row) } }
}

export function uniqueTitle(store, workspaceId, title, suffix) {
  let candidate = title
  if (!validTitle(candidate)) candidate = (title.slice(0, TITLE_MAX - 9) + '-' + suffix.slice(0, 8)).replace(/^-+|-+$/g, '')
  if (!store.get('SELECT id FROM artifacts WHERE workspace_id=? AND title_hash=?', workspaceId, titleHash(candidate))) return candidate
  let fallback = (title.slice(0, TITLE_MAX - 9) + '-' + suffix.slice(0, 8)).trim()
  if (!validTitle(fallback)) fallback = suffix.slice(0, TITLE_MAX)
  return fallback
}

export function versionView(row, includeBody = true, store) {
  const user = store ? usernames(store) : (id) => id
  let kind = row.kind
  const data = { revision: row.revision, title: row.title, kind, created: row.created, created_by: row.created_by_username ?? user(row.created_by) }
  if (kind === 'media') {
    data.media = { mime: row.mime, bytes: row.byte_count, filename: row.filename }
  } else {
    const [structuredKind, structured] = kind === 'document' ? decodeStructured(row.body) : [null, null]
    if (structured) {
      data.kind = structuredKind
      if (includeBody) data[structuredKind] = structured
    } else if (includeBody) {
      if (kind === 'whiteboard') data.board = decodeBoard(row.board) ?? emptyBoard()
      else data.body = row.body
    }
  }
  return data
}

export function sameAsVersion(row, snapshot) {
  if (row.title !== snapshot.title) return false
  const currentKind = publicKind(row)
  if (['slides','dashboard','spreadsheet'].includes(currentKind)) {
    const [structuredKind, structured] = snapshot.kind === 'document' ? decodeStructured(snapshot.body) : [null, null]
    if (structuredKind !== currentKind) return false
    if (currentKind === 'spreadsheet') return row.spreadsheet_json === JSON.stringify(structured)
    return currentKind === 'slides' ? row.slides_json === slidesJson(structured) : row.dashboard_json === dashboardJson(structured)
  }
  if (currentKind !== snapshot.kind) return false
  if (snapshot.kind === 'media') return row.media_sha256 === snapshot.sha256 && row.media_filename === snapshot.filename
  if (snapshot.kind === 'whiteboard') return row.board_json === snapshot.board
  return row.body === snapshot.body
}

function attachKind(store, id, kind, { board, slides, dashboard } = {}) {
  setRender(store, id, kind)
  if (board && !attachBoard(store, id, board)) refuse(400, 'invalid', 'Provide a whiteboard title and board')
  if (slides && !attachSlides(store, id, slides)) refuse(400, 'invalid', 'Provide valid slide content')
  if (dashboard && !attachDashboard(store, id, dashboard)) refuse(400, 'invalid', 'Provide valid dashboard content')
}

function attachSource(store, id, workspaceId, now, source) {
  if (!source) return
  if (source.kind === 'agent_message') {
    store.run('INSERT INTO artifact_chat_sources(artifact_id, workspace_id, conversation_id, message_id, agent_id, created, conversation_title) VALUES(?,?,?,?,?,?,?)',
      id, workspaceId, source.conversation_id, source.id ?? source.message_id, source.agent_id ?? null, now, source.conversation_title ?? null)
    return
  }
  if (source.kind === 'automation_run' || source.kind === 'agent_task') {
    store.run('INSERT INTO artifact_sources VALUES(?,?,?,?,?,?,?,?)',
      id, workspaceId, source.kind, source.id, source.automation_id ?? null, source.automation_title ?? null, source.task_kind ?? null, now)
  }
}

function existingSource(store, workspaceId, source) {
  if (!source) return null
  if (source.kind === 'agent_message') {
    const row = store.get('SELECT artifact_id FROM artifact_chat_sources WHERE workspace_id=? AND message_id=?', workspaceId, source.id ?? source.message_id)
    return row ? load(store, workspaceId, row.artifact_id) : null
  }
  if (source.kind === 'automation_run' || source.kind === 'agent_task') {
    const row = store.get('SELECT artifact_id FROM artifact_sources WHERE workspace_id=? AND source_kind=? AND source_id=?', workspaceId, source.kind, source.id)
    return row ? load(store, workspaceId, row.artifact_id) : null
  }
  return null
}

export function createArtifact(ctx, workspaceId, input, key, {reuseChatSource = false, reuseSource = false} = {}) {
  const { store, owner, featureDir } = ctx
  if (typeof workspaceId !== 'string' || !HEX32.test(workspaceId)) refuse(400, 'invalid', 'Provide a workspace_id')
  const title = input.title
  const content = input.body ?? ''
  const kind = input.kind ?? 'document'
  let board, slides, dashboard, spreadsheet
  if (kind === 'media') refuse(400, 'invalid', 'Upload media as multipart form data')
  if (kind === 'whiteboard') {
    board = normalizeBoard(input.board || emptyBoard())
    if (!board || !validTitle(title) || (content && !validBody(content))) refuse(400, 'invalid', 'Provide a whiteboard title and board')
  } else if (kind === 'slides') {
    slides = normalizeSlides(input.slides || emptySlides())
    if (!slides || !slides.slides.length || !validTitle(title) || (content && !validBody(content))) refuse(400, 'invalid', 'Provide a slide title and at least one slide')
  } else if (kind === 'dashboard') {
    dashboard = normalizeDashboard(input.dashboard || emptyDashboard())
    if (!dashboard || !dashboard.widgets.length || !validTitle(title) || (content && !validBody(content))) refuse(400, 'invalid', 'Provide a dashboard title and at least one widget')
  } else if (kind === 'spreadsheet') {
    spreadsheet = normalizeWorkbook(input.spreadsheet ?? emptyWorkbook())
    if (!spreadsheet || !validTitle(title) || content) refuse(400,'invalid','请填写有效的表格标题和工作表。')
  } else if (kind !== 'document' && kind !== 'website' || !validTitle(title) || !validBody(content)) {
    refuse(400, 'invalid', 'Provide a document or website title and body')
  }
  const trimmed = title.trim()
  const bodyText = validBody(content) ? content : ''
  if (!KEY.test(key ?? '')) refuse(400, 'invalid', 'Supply a 16–64 character Idempotency-Key')
  const payload = { title: trimmed, body: bodyText, kind }
  if (board) payload.board = board
  if (slides) payload.slides = slides
  if (dashboard) payload.dashboard = dashboard
  if (spreadsheet) payload.spreadsheet = spreadsheet
  const keyHash = digest('artifact:' + key)
  const requestHash = digest(stableJson(payload))
  return store.transaction(() => {
    const source = input.source
    const already = existingSource(store, workspaceId, source)
    // Saved source snapshots survive later edits and title changes.
    if (already && (reuseChatSource || reuseSource)) return { status: 200, body: { artifact: view(already) } }
    const prior = store.get('SELECT * FROM artifacts WHERE workspace_id=? AND key_hash=?', workspaceId, keyHash)
    if (prior) {
      const row = load(store, workspaceId, prior.id)
      // Older Bot Social saves used the same key without recording the source.
      if (reuseChatSource && !source.agent_id && !row.chat_message_id && !row.source_kind && publicKind(row) === 'document') {
        const first = store.get('SELECT body FROM artifact_versions WHERE artifact_id=? AND revision=1', row.id)
        if (first?.body === bodyText) {
          attachSource(store, row.id, workspaceId, row.created, source)
          return { status: 200, body: { artifact: view(load(store, workspaceId, row.id)) } }
        }
      }
      if (prior.request_hash !== requestHash) refuse(409, 'conflict', 'Idempotency key was used for a different request')
      return { status: 200, body: { artifact: view(row) } }
    }
    if (already) return { status: 200, body: { artifact: view(already) } }
    const hash = titleHash(trimmed)
    if (store.get('SELECT id FROM artifacts WHERE workspace_id=? AND title_hash=?', workspaceId, hash)) {
      refuse(409, 'conflict', 'A document with this title already exists')
    }
    if (store.get('SELECT COUNT(*) AS n FROM artifacts WHERE workspace_id=?', workspaceId).n >= PER_WORKSPACE) {
      refuse(429, 'quota', 'Artifact capacity reached')
    }
    const id = newId()
    const now = nowSeconds()
    store.run('INSERT INTO artifacts VALUES(?,?,?,?,?,?,1,?,?,?,?,?,?)',
      id, workspaceId, trimmed, hash, 'document', bodyText, now, now, owner, owner, keyHash, requestHash)
    attachKind(store, id, kind, { board, slides, dashboard })
    if (spreadsheet) attachWorkbook(store,id,spreadsheet)
    attachSource(store, id, workspaceId, now, source)
    void featureDir
    return saved(store, workspaceId, id, 201)
  })
}

export function createMedia(ctx, workspaceId, { title, data, filename, mime, key }) {
  const { store, owner, featureDir } = ctx
  if (typeof workspaceId !== 'string' || !HEX32.test(workspaceId)) refuse(400, 'invalid', 'Provide a workspace_id')
  if (!validTitle(title)) refuse(400, 'invalid', 'Provide a document title and body')
  const trimmed = title.trim()
  if (!KEY.test(key ?? '')) refuse(400, 'invalid', 'Supply a 16–64 character Idempotency-Key')
  const sniffed = sniffMime(data)
  if (!sniffed || !MEDIA_MIMES.has(sniffed) || (mime && mime !== sniffed && !MEDIA_MIMES.has(mime))) {
    refuse(400, 'invalid', 'Upload a supported media file')
  }
  const used = sniffed
  const name = cleanFilename(filename)
  const sha = createHash('sha256').update(data).digest('hex')
  const payload = { title: trimmed, kind: 'media', sha256: sha, mime: used, filename: name }
  const keyHash = digest('artifact:' + key)
  const requestHash = digest(stableJson(payload))
  return store.transaction(() => {
    const prior = store.get('SELECT * FROM artifacts WHERE workspace_id=? AND key_hash=?', workspaceId, keyHash)
    if (prior) {
      if (prior.request_hash !== requestHash) refuse(409, 'conflict', 'Idempotency key was used for a different request')
      return { status: 200, body: { artifact: view(load(store, workspaceId, prior.id)) } }
    }
    const hash = titleHash(trimmed)
    if (store.get('SELECT id FROM artifacts WHERE workspace_id=? AND title_hash=?', workspaceId, hash)) {
      refuse(409, 'conflict', 'A document with this title already exists')
    }
    if (store.get('SELECT COUNT(*) AS n FROM artifacts WHERE workspace_id=?', workspaceId).n >= PER_WORKSPACE) {
      refuse(429, 'quota', 'Artifact capacity reached')
    }
    let stored
    try { stored = writeMedia(featureDir, workspaceId, data) } catch { refuse(503, 'unavailable', 'Storage is temporarily unavailable') }
    if (stored !== sha) refuse(500, 'internal', 'Internal service error')
    const id = newId()
    const now = nowSeconds()
    store.run('INSERT INTO artifacts VALUES(?,?,?,?,?,?,1,?,?,?,?,?,?)',
      id, workspaceId, trimmed, hash, 'document', '', now, now, owner, owner, keyHash, requestHash)
    attachMedia(store, id, used, data.length, sha, name)
    return saved(store, workspaceId, id, 201)
  })
}

export function updateArtifact(ctx, row, changes, revision) {
  const { store, owner } = ctx
  if (!Number.isInteger(revision) || revision < 0 || revision > 2 ** 31 || !changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length) {
    refuse(400, 'invalid', 'Provide the current revision and a non-empty changes object')
  }
  const kind = publicKind(row)
  const allowed = ['title', ...({
    whiteboard:['board','operations'], slides:['slides'], dashboard:['dashboard'],
    spreadsheet:['spreadsheet'], media:[],
  }[kind] ?? ['body'])]
  if (Object.keys(changes).some((key) => !allowed.includes(key))) refuse(400, 'invalid', 'Unknown artifact field')
  if (revision !== row.revision) refuse(409, 'conflict', 'Document changed elsewhere; reload and retry', view(row))
  let title = row.title
  let content = row.body
  let board = kind === 'whiteboard' ? decodeBoard(row.board_json) : null
  let slides = kind === 'slides' ? decodeSlides(row.slides_json) : null
  let dashboard = kind === 'dashboard' ? decodeDashboard(row.dashboard_json) : null
  let workbook = kind === 'spreadsheet' ? decodeWorkbook(row.spreadsheet_json) : null
  if ('title' in changes) {
    if (!validTitle(changes.title)) refuse(400, 'invalid', 'Provide a document title and body')
    title = changes.title.trim()
  }
  if ('body' in changes) {
    if (!validBody(changes.body)) refuse(400, 'invalid', 'Provide a document title and body')
    content = changes.body
  }
  if ('board' in changes) {
    board = normalizeBoard(changes.board)
    if (!board) refuse(400, 'invalid', 'Provide a valid board')
  }
  if ('operations' in changes) {
    board = applyBoardOperations(board || emptyBoard(), changes.operations)
    if (!board) refuse(400, 'invalid', 'Provide valid board operations')
  }
  if ('slides' in changes) {
    slides = normalizeSlides(changes.slides)
    if (!slides || !slides.slides.length) refuse(400, 'invalid', 'Provide at least one valid slide')
  }
  if ('dashboard' in changes) {
    dashboard = normalizeDashboard(changes.dashboard)
    if (!dashboard || !dashboard.widgets.length) refuse(400, 'invalid', 'Provide at least one valid dashboard widget')
  }
  if ('spreadsheet' in changes) {
    workbook = normalizeWorkbook(changes.spreadsheet)
    if (!workbook) refuse(400,'invalid','工作表名称重复、包含非法字符，或表格超出容量。')
  }
  let unchanged = title === row.title && content === row.body
  if (kind === 'whiteboard') unchanged = title === row.title && boardJson(board) === row.board_json
  else if (kind === 'slides') unchanged = title === row.title && slidesJson(slides) === row.slides_json
  else if (kind === 'dashboard') unchanged = title === row.title && dashboardJson(dashboard) === row.dashboard_json
  else if (kind === 'spreadsheet') unchanged = title === row.title && JSON.stringify(workbook) === row.spreadsheet_json
  if (unchanged) return { status: 200, body: { artifact: view(row) } }
  return ctx.store.transaction(() => {
    guardVersions(store, row.id)
    const hash = titleHash(title)
    if (title !== row.title && store.get('SELECT id FROM artifacts WHERE workspace_id=? AND title_hash=? AND id!=?', row.workspace_id, hash, row.id)) {
      refuse(409, 'conflict', 'A document with this title already exists')
    }
    store.run('UPDATE artifacts SET title=?, title_hash=?, body=?, revision=?, updated=?, updated_by=? WHERE id=?',
      title, hash, content, row.revision + 1, nowSeconds(), owner, row.id)
    if (kind === 'whiteboard' && !attachBoard(store, row.id, board)) refuse(400, 'invalid', 'Provide a valid board')
    if (kind === 'slides' && !attachSlides(store, row.id, slides)) refuse(400, 'invalid', 'Provide valid slide content')
    if (kind === 'dashboard' && !attachDashboard(store, row.id, dashboard)) refuse(400, 'invalid', 'Provide valid dashboard content')
    if (kind === 'spreadsheet') attachWorkbook(store,row.id,workbook)
    return saved(store, row.workspace_id, row.id, 200)
  })
}

export function replaceMedia(ctx, row, { title, data, filename, mime, revision }) {
  const { store, owner, featureDir } = ctx
  if (!Number.isInteger(revision) || revision !== row.revision) {
    if (!Number.isInteger(revision)) refuse(400, 'invalid', 'Provide the current revision and a media file')
    refuse(409, 'conflict', 'Document changed elsewhere; reload and retry', view(row))
  }
  let newTitle = row.title
  if (title) {
    if (!validTitle(title)) refuse(400, 'invalid', 'Provide a document title and body')
    newTitle = title.trim()
  }
  const sniffed = sniffMime(data)
  if (!sniffed || !MEDIA_MIMES.has(sniffed)) refuse(400, 'invalid', 'Upload a supported media file')
  const name = cleanFilename(filename)
  return store.transaction(() => {
    const hash = titleHash(newTitle)
    if (newTitle !== row.title && store.get('SELECT id FROM artifacts WHERE workspace_id=? AND title_hash=? AND id!=?', row.workspace_id, hash, row.id)) {
      refuse(409, 'conflict', 'A document with this title already exists')
    }
    guardVersions(store, row.id)
    let digestHex
    try { digestHex = writeMedia(featureDir, row.workspace_id, data) } catch { refuse(503, 'unavailable', 'Storage is temporarily unavailable') }
    const previous = row.media_sha256
    store.run('UPDATE artifacts SET title=?, title_hash=?, revision=?, updated=?, updated_by=? WHERE id=?',
      newTitle, hash, row.revision + 1, nowSeconds(), owner, row.id)
    attachMedia(store, row.id, sniffed, data.length, digestHex, name)
    if (previous && previous !== digestHex) unlinkMedia(featureDir, store, row.workspace_id, previous)
    return saved(store, row.workspace_id, row.id, 200)
  })
}

function guardVersions(store, artifactId) {
  if (store.get('SELECT COUNT(*) AS n FROM artifact_versions WHERE artifact_id=?', artifactId).n >= MAX_VERSIONS) {
    refuse(429, 'quota', 'Version capacity reached')
  }
}

export function restoreArtifact(ctx, row, revision, to) {
  const { store, owner } = ctx
  if (!Number.isInteger(revision) || !Number.isInteger(to) || to < 1 || to > 2 ** 31 || revision < 0 || revision > 2 ** 31) {
    refuse(400, 'invalid', 'Provide the current revision and a version to restore')
  }
  if (revision !== row.revision) refuse(409, 'conflict', 'Document changed elsewhere; reload and retry', view(row))
  const snapshot = store.get('SELECT * FROM artifact_versions WHERE artifact_id=? AND revision=?', row.id, to)
  if (!snapshot) refuse(404, 'not_found', 'Version not found')
  if (sameAsVersion(row, snapshot)) return { status: 200, body: { artifact: view(row) } }
  return store.transaction(() => {
    guardVersions(store, row.id)
    const title = snapshot.title
    const hash = titleHash(title)
    if (title !== row.title && store.get('SELECT id FROM artifacts WHERE workspace_id=? AND title_hash=? AND id!=?', row.workspace_id, hash, row.id)) {
      refuse(409, 'conflict', 'A document with this title already exists')
    }
    let kind = snapshot.kind
    let structured = null
    if (kind === 'document') {
      const decoded = decodeStructured(snapshot.body)
      if (decoded[0]) { kind = decoded[0]; structured = decoded[1] }
    }
    const content = kind === 'document' || kind === 'website' ? snapshot.body : ''
    store.run('UPDATE artifacts SET title=?, title_hash=?, body=?, revision=?, updated=?, updated_by=? WHERE id=?',
      title, hash, content, row.revision + 1, nowSeconds(), owner, row.id)
    setRender(store, row.id, kind)
    const clear = (...tables) => { for (const table of tables) store.run(`DELETE FROM ${table} WHERE artifact_id=?`, row.id) }
    if (kind !== 'spreadsheet') clear('artifact_spreadsheets')
    if (kind === 'spreadsheet') {
      attachWorkbook(store,row.id,structured)
      clear('artifact_media','artifact_boards','artifact_slides','artifact_dashboards')
    } else if (kind === 'slides') {
      if (!attachSlides(store, row.id, structured)) refuse(400, 'invalid', 'Provide valid slide content')
      clear('artifact_media', 'artifact_boards', 'artifact_dashboards')
    } else if (kind === 'dashboard') {
      if (!attachDashboard(store, row.id, structured)) refuse(400, 'invalid', 'Provide valid dashboard content')
      clear('artifact_media', 'artifact_boards', 'artifact_slides')
    } else if (kind === 'whiteboard') {
      if (!attachBoard(store, row.id, decodeBoard(snapshot.board) ?? emptyBoard())) refuse(400, 'invalid', 'Provide a valid board')
      clear('artifact_slides', 'artifact_dashboards')
    } else if (kind === 'media') {
      attachMedia(store, row.id, snapshot.mime, snapshot.byte_count, snapshot.sha256, snapshot.filename)
      clear('artifact_slides', 'artifact_dashboards')
    } else {
      clear('artifact_media', 'artifact_boards', 'artifact_slides', 'artifact_dashboards')
    }
    return saved(store, row.workspace_id, row.id, 200)
  })
}

export function exportBytes(row, featureDir, workspaceId, fromVersion = false) {
  const kind = fromVersion ? row.kind : publicKind(row)
  const title = row.title
  const revision = row.revision
  if (kind === 'media') {
    const mime = fromVersion ? row.mime : row.media_mime
    const digestHex = fromVersion ? row.sha256 : row.media_sha256
    const filename = fromVersion ? row.filename : row.media_filename
    const expected = fromVersion ? row.byte_count : row.media_bytes
    const payload = readMediaBytes(featureDir, workspaceId, digestHex, expected, mime)
    return { payload, contentType: mime, filename: exportFilename(title, kind, revision, filename), headers: exportHeaders(mime, exportFilename(title, kind, revision, filename)) }
  }
  let structuredKind = null, structured = null
  if (kind === 'slides') { structuredKind = 'slides'; structured = decodeSlides(row.slides_json) }
  else if (kind === 'dashboard') { structuredKind = 'dashboard'; structured = decodeDashboard(row.dashboard_json) }
  else if (fromVersion && kind === 'document') [structuredKind, structured] = decodeStructured(row.body)
  if (kind === 'spreadsheet' || structuredKind === 'spreadsheet') {
    const result = exportOffice(row,'xlsx',fromVersion)
    return {...result,headers:exportHeaders(result.contentType,result.filename)}
  }
  if (structured) {
    const html = structuredKind === 'slides' ? renderSlidesPage(title, structured) : renderDashboardPage(title, structured)
    const name = exportFilename(title, structuredKind, revision)
    return { payload: html, contentType: 'text/html; charset=utf-8', filename: name, headers: exportHeaders('text/html; charset=utf-8', name) }
  }
  if (kind === 'website') {
    const name = exportFilename(title, kind, revision)
    return { payload: renderWebsitePage(title, row.body), contentType: 'text/html; charset=utf-8', filename: name, headers: exportHeaders('text/html; charset=utf-8', name) }
  }
  if (kind === 'whiteboard') {
    const raw = fromVersion ? row.board : row.board_json
    const board = decodeBoard(raw) ?? emptyBoard()
    const name = exportFilename(title, kind, revision)
    return { payload: renderBoardSvg(board), contentType: 'image/svg+xml; charset=utf-8', filename: name, headers: exportHeaders('image/svg+xml; charset=utf-8', name) }
  }
  const body = typeof row.body === 'string' ? row.body : ''
  const name = exportFilename(title, kind, revision)
  return { payload: body, contentType: 'text/plain; charset=utf-8', filename: name, headers: exportHeaders('text/plain; charset=utf-8', name) }
}


export function exportResult(row, featureDir, workspaceId, fromVersion, format) {
  if (format && OFFICE.has(format)) {
    try {
      const result = exportOffice(row, format, fromVersion)
      return { status: 200, raw: result.payload, headers: exportHeaders(result.contentType, result.filename), filename: result.filename }
    } catch (error) {
      refuse(400, 'unsupported_export', String(error?.message ?? error))
    }
  }
  if (format) refuse(400, 'invalid', 'Unsupported export format')
  try {
    const result = exportBytes(row, featureDir, workspaceId, fromVersion)
    return { status: 200, raw: result.payload, headers: result.headers, filename: result.filename }
  } catch {
    refuse(404, 'not_found', 'Artifact not found')
  }
}

export function parseExportFormat(query) {
  if (!query || ![...query.keys()].length) return null
  const keys = [...query.keys()]
  const format = query.get('format') ?? 'original'
  if (keys.some((k) => k !== 'format') || query.getAll('format').length > 1 || !['original', 'docx', 'pdf', 'xlsx', 'pptx'].includes(format)) {
    refuse(400, 'invalid', keys.length > 1 || (query.has('format') && !['original', 'docx', 'pdf', 'xlsx', 'pptx'].includes(format)) ? (OFFICE.has(format) ? 'Unsupported export format' : 'Provide only one export format') : 'Unsupported export format')
  }
  return format === 'original' ? null : format
}

export function opaque() { return randomBytes(32).toString('base64url') }

export function shareView(row, { includeToken = false, token = null, store } = {}) {
  const user = store ? usernames(store) : () => null
  const data = {
    id: row.id, artifact_id: row.artifact_id, workspace_id: row.workspace_id, prefix: row.token_prefix,
    created: row.created, created_by: row.created_by_username ?? user(row.created_by),
    expires: row.expires, revoked: Boolean(row.revoked), scope: 'read',
  }
  if (includeToken && token) { data.token = token; data.path = '/share/' + token }
  return data
}

export function listShares(store, artifactId) {
  return store.all('SELECT * FROM artifact_shares WHERE artifact_id=? ORDER BY id', artifactId)
}

export function createShare(store, row, owner, now, expiresIn) {
  let expires = null
  if (expiresIn != null) {
    if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 2592000) refuse(400, 'invalid', 'expires_in must be 1..2592000 seconds')
    expires = now + expiresIn
  }
  const active = store.get('SELECT COUNT(*) AS n FROM artifact_shares WHERE artifact_id=? AND revoked=0 AND (expires IS NULL OR expires>?)', row.id, now).n
  if (active >= MAX_SHARES) refuse(429, 'quota', 'Share capacity reached')
  const token = opaque()
  const id = newId()
  store.run('INSERT INTO artifact_shares VALUES(?,?,?,?,?,?,?,?,0,NULL)',
    id, row.id, row.workspace_id, digest('share:' + token), token.slice(0, PREFIX_LEN), now, owner, expires)
  const item = store.get('SELECT * FROM artifact_shares WHERE id=? AND artifact_id=?', id, row.id)
  return { status: 201, body: { share: shareView(item, { includeToken: true, token, store }) } }
}

export function revokeShare(store, artifactId, shareId, now) {
  const item = store.get('SELECT * FROM artifact_shares WHERE id=? AND artifact_id=?', shareId, artifactId)
  if (!item) refuse(404, 'not_found', 'Share not found')
  store.run('UPDATE artifact_shares SET revoked=1, revoked_at=? WHERE id=? AND revoked=0', now, item.id)
  return { status: 200, body: { share: shareView(store.get('SELECT * FROM artifact_shares WHERE id=?', shareId), { store }) } }
}

export function content(row, featureDir, { preview: asPreview = false } = {}) {
  const kind = publicKind(row)
  if (kind === 'media' && !asPreview) {
    try {
      const payload = readMediaBytes(featureDir, row.workspace_id, row.media_sha256, row.media_bytes, row.media_mime)
      const name = cleanFilename(row.media_filename || 'file')
      return {
        status: 200, raw: payload, inline: true,
        headers: {
          'content-type': row.media_mime,
          'content-security-policy': "default-src 'none'; sandbox; frame-ancestors 'self'; object-src 'none'",
          'content-disposition': 'inline; filename="' + name + '"',
        },
        filename: name,
      }
    } catch { refuse(404, 'not_found', 'Artifact not found') }
  }
  const html = renderPage(row)
  return {
    status: 200, raw: html,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': SHARE_CSP,
    },
    filename: 'artifact.html',
  }
}

export function listFiles(store, workspaceId, text, cursor, limit) {
  const rows = store.all(
    "SELECT a.id, a.title, md.filename, md.mime FROM artifacts a JOIN artifact_media md ON md.artifact_id=a.id WHERE a.workspace_id=? AND a.id>? AND instr(lower(a.title || ' ' || md.filename), lower(?))>0 ORDER BY a.id LIMIT ?",
    workspaceId, cursor || '', text, limit,
  )
  return rows.map((row) => ({
    id: row.id, title: row.title, preview: row.filename + ' · ' + row.mime,
    href: '/v1/workspaces/' + workspaceId + '/artifacts/' + row.id + '/file',
  }))
}

export function search(store, needle, limit) {
  const like = '%' + needle.replace(/[\\%_]/g, (c) => '\\' + c) + '%'
  return store.all(ROW_SELECT + "WHERE a.title LIKE ? ESCAPE '\\' OR a.body LIKE ? ESCAPE '\\' ORDER BY a.updated DESC LIMIT ?", like, like, limit)
    .map((row) => ({ kind: 'artifact', id: row.id, workspace_id: row.workspace_id, title: row.title, snippet: (row.body || row.title).slice(0, 160), updated: row.updated, href: `/artifacts/?artifact=${row.id}` }))
}

export { HEX32, mediaDigests, unlinkMedia, TOKEN }
