// Artifacts feature (stream B3): the works library runs inside this user's
// DS-Bot. artifacts/create is the in-process entry B2 team runs call to store
// a finished step's output. Legacy /v1 studio routes, media, boards, slides,
// dashboards, history, export and authenticated share records are served here;
// public /share/<token> pages are rendered by Bot Social (snapshot published here).
import { defineFeature } from '../../featurekit/feature.js'
import { HEX32, digest, refuse } from '../../featurekit/http.js'
import { createArtifact, createMedia, exportBytes, listFiles, load, PER_WORKSPACE, search, uniqueTitle } from './library.js'
import { IMPORT_TABLES, MIGRATIONS } from './schema.js'
import { routes } from './routes.js'
import { importMedia } from './media.js'
import { emptyBoard, MAX_GENERATED_VIDEO_BYTES, MAX_MEDIA_BYTES, publicKind, validTitle } from './model.js'
import { sniffMime } from './render.js'
import { GLB_MIME, MAX_GLB_BYTES } from '../../lib/glb.js'
import { exportOffice } from './office.js'
import { decodeStructured } from './structured.js'

function generatedMedia(ctx, input, call, type, mime, extension, limit) {
  if (!call?.internal) refuse(404, 'not_found', 'Internal endpoint')
  const {workspace_id: workspace, job_id: id, data, title} = input ?? {}
  if (!HEX32.test(workspace || '') || !HEX32.test(id || '')) refuse(400, 'invalid', 'Invalid generation')
  const key = type + '-' + id
  const saved = ctx.store.get('SELECT id FROM artifacts WHERE workspace_id=? AND key_hash=?', workspace, digest('artifact:' + key))
  if (saved || data === undefined) return saved
  if (!Buffer.isBuffer(data) || !data.length || data.length > limit || sniffMime(data) !== mime) {
    refuse(400, 'invalid', 'Invalid generated media')
  }
  const suffix = id.slice(0, 8)
  const result = createMedia(ctx, workspace, {title: `${title} · ${suffix}`, data, filename: `${type}-${suffix}.${extension}`, mime, key})
  return {id: result.body.artifact.id}
}

export { PER_WORKSPACE }

export default defineFeature({
  name: 'artifacts',
  pages: ['artifacts'],
  migrations: MIGRATIONS,
  importTables: IMPORT_TABLES,
  afterImport: importMedia,
  routes,
  search,
  endpoints: (context) => {
    const ctx = { ...context, featureDir: context.host.featureDir() }
    return {
    async create(payload) {
      const input = payload ?? {}
      const result = createArtifact(ctx, input.workspace_id, input, input.idempotency_key)
      return { artifact: result.body.artifact }
    },
    async generatedImage(input, call) {
      return generatedMedia(ctx, input, call, 'image', 'image/png', 'png', MAX_MEDIA_BYTES)
    },
    async generatedVideo(input, call) {
      return generatedMedia(ctx, input, call, 'video', 'video/mp4', 'mp4', MAX_GENERATED_VIDEO_BYTES)
    },
    async generatedMusic(input, call) {
      return generatedMedia(ctx, input, call, 'music', 'audio/mpeg', 'mp3', MAX_MEDIA_BYTES)
    },
    async generatedModel3d(input, call) {
      return generatedMedia(ctx, input, call, 'model3d', GLB_MIME, 'glb', MAX_GLB_BYTES)
    },
    async generatedWebsite(input, call) {
      if (!call?.internal) refuse(404, 'not_found', 'Internal endpoint')
      const {workspace_id: workspace, job_id: id, title, body} = input ?? {}
      if (!HEX32.test(workspace || '') || !HEX32.test(id || '')) refuse(400, 'invalid', 'Invalid generation')
      const key = 'website-' + id
      const saved = ctx.store.get('SELECT id FROM artifacts WHERE workspace_id=? AND key_hash=?', workspace, digest('artifact:' + key))
      if (saved || body === undefined) return saved
      if (!validTitle(title)) refuse(400, 'invalid', 'Invalid website title')
      const name = uniqueTitle(ctx.store, workspace, title.trim(), id)
      const result = createArtifact(ctx, workspace, {kind: 'website', title: name, body}, key)
      return {id: result.body.artifact.id}
    },
    async saveChatMessage(input, call) {
      if (!call?.internal) refuse(403, 'forbidden', 'Save chat messages from their conversation')
      const { workspace_id: workspace, conversation_id, message_id, agent_id, conversation_title, body } = input
      const title = input.title ?? (body.replace(/\s+/g, ' ').trim().slice(0, 60) || '消息记录')
      const source = {kind: 'agent_message', id: message_id, conversation_id, agent_id, conversation_title}
      const key = agent_id ? 'msg-save-' + digest(message_id).slice(0, 48)
        : ('msg-save-' + message_id).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64)
      const result = createArtifact(ctx, workspace, {kind: 'document', title, body, source}, key, {reuseChatSource: true})
      return {status: result.status, artifact: result.body.artifact}
    },
    async saveAutomationRun(input, call) {
      if (!call?.internal) refuse(403, 'forbidden', 'Save results from their automation run')
      const { workspace_id: workspace, automation_id, automation_title, run_id, body } = input ?? {}
      if (![workspace, automation_id, run_id].every(id => typeof id === 'string' && HEX32.test(id)) || !validTitle(automation_title)) {
        refuse(400, 'invalid', 'Invalid automation result')
      }
      const source = {kind: 'automation_run', id: run_id, automation_id, automation_title}
      const title = uniqueTitle(ctx.store, workspace, `${automation_title} · 运行结果`, run_id)
      const result = createArtifact(ctx, workspace, {kind: 'document', title, body, source}, 'automation-run-' + run_id, {reuseSource: true})
      return {status: result.status, artifact: result.body.artifact}
    },
    async chatAttachment(input, call) {
      if (!call?.internal) refuse(403, 'forbidden', 'Send saved works from an authenticated conversation')
      const {workspace_id: workspace, artifact_id: id, revision} = input ?? {}
      if (!HEX32.test(workspace || '') || !HEX32.test(id || '') || !Number.isSafeInteger(revision) || revision < 1) {
        refuse(400, 'invalid', '请选择作品的已保存版本。')
      }
      const current = load(ctx.store, workspace, id)
      if (!current) refuse(404, 'not_found', '无法找到这个作品。')
      const fromVersion = current.revision !== revision
      const row = fromVersion
        ? ctx.store.get('SELECT * FROM artifact_versions WHERE artifact_id=? AND revision=?', id, revision)
        : current
      if (!row) refuse(404, 'not_found', '该版本已不可发送，请刷新作品列表。')
      let kind = fromVersion ? row.kind : publicKind(row)
      if (fromVersion && kind === 'document') kind = decodeStructured(row.body)[0] || kind
      const officeFormat = {document:'docx', slides:'pptx', dashboard:'xlsx', spreadsheet:'xlsx'}[kind]
      let file
      if (officeFormat) {
        const result = exportOffice(row, officeFormat, fromVersion)
        file = {payload: result.payload, mime: result.contentType, extension: officeFormat}
      } else if (kind === 'whiteboard') {
        file = {payload: (fromVersion ? row.board : row.board_json) || JSON.stringify(emptyBoard()),
          mime: 'application/json', extension: 'json'}
      } else {
        const result = exportBytes(row, ctx.featureDir, workspace, fromVersion)
        const extensions = {'image/jpeg':'jpg', 'audio/mpeg':'mp3', [GLB_MIME]: 'glb'}
        const extension = extensions[result.contentType] || result.contentType.split('/').at(-1)
        file = {payload: result.payload, mime: kind === 'website' ? 'text/plain' : result.contentType,
          extension: kind === 'website' ? 'txt' : extension}
      }
      const bytes = Buffer.from(file.payload)
      if (bytes.length > 8 * 1024 * 1024) refuse(413, 'attachment_too_large', '附件不能超过 8 MB。')
      const title = row.title.replace(/[.\/\\]/g, '_').trim()
      return {body: `${row.title} · 版本 ${revision}`, attachment: {
        title: `${title}-v${revision}.${file.extension}`, mime: file.mime, data: bytes.toString('base64'),
        resource: {kind,title:row.title,revision},
      }}
    },
    async files(payload) {
      const workspaceId = payload?.workspace_id
      if (typeof workspaceId !== 'string' || !HEX32.test(workspaceId)) refuse(400, 'invalid', 'Provide a workspace_id')
      const text = String(payload?.q ?? '')
      const cursor = String(payload?.cursor ?? '')
      const limit = Math.min(Math.max(Number(payload?.limit) || 20, 1), 51)
      if (text.length > 80 || (cursor && !HEX32.test(cursor))) refuse(400, 'invalid', 'Invalid resource search parameters')
      return { items: listFiles(ctx.store, workspaceId, text, cursor, limit) }
    },
  } },
})
