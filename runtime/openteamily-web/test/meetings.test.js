import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { boot, deliverBundle, key, legacyBundles, volume, WS } from './helpers.js'
import { attachRuntime, detachRuntime } from '../src/host.js'
import {waveBase64} from '../../../openteamily/static/meetings/audio.mjs'

const base = (id = '', ws = WS) => `/v1/workspaces/${ws}/meetings${id ? '/' + id : ''}`
const body = { title: '周会', attendees: ['alice', 'bob'], summary: '同步进度。', transcript: '讨论排期。', action_items: [{ text: '订会议室', owner: 'bob' }] }

test('meetings feature loads in this DS-Bot and keeps its data in its own feature directory', async () => {
  const bot = await boot()
  assert.ok(bot.features.loaded.includes('meetings'), JSON.stringify(bot.features.failed))
  assert.ok(existsSync(join(bot.vol.data, 'openteamily', 'features', 'meetings', 'meetings.sqlite3')))
  const routes = await bot.endpoint('meetings/routes')
  assert.equal(routes.ok, true)
  assert.ok(routes.value.routes.every((source) => source.startsWith('^\\/v1\\/workspaces')))
})

test('meetings run inside this DS-Bot: create, idempotent replay, list, read, update, export, remove', async () => {
  const bot = await boot()
  const call = (...args) => bot.call('meetings', ...args)
  const k = key()
  const created = await call('POST', base(), body, k)
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const meeting = created.body.meeting
  assert.equal(meeting.action_count, 1)
  assert.equal(meeting.done_count, 0)
  assert.equal((await call('POST', base(), body, k)).status, 200)
  assert.equal((await call('POST', base(), { ...body, title: '另一个' }, k)).status, 409)
  assert.equal((await call('POST', base(), body, key())).status, 409, 'duplicate title')
  assert.equal((await call('POST', base(), body)).status, 400, 'idempotency key required')
  assert.equal((await call('POST', base(), { ...body, title: '' }, key())).status, 400)

  const listed = await call('GET', base() + '?limit=20')
  assert.equal(listed.status, 200)
  assert.equal(listed.body.items.length, 1)
  assert.equal(listed.body.items[0].transcript, undefined)
  assert.equal((await call('GET', base() + '?bogus=1')).status, 400)
  assert.equal((await call('GET', base(meeting.id))).body.meeting.transcript, '讨论排期。')

  const stale = await call('POST', base(meeting.id), { revision: 9, changes: { summary: 'x' } })
  assert.equal(stale.status, 409)
  assert.equal(stale.body.error.current.revision, 1)
  const updated = await call('POST', base(meeting.id), { revision: 1, changes: { action_items: [{ text: '订会议室', owner: 'bob', done: true }] } })
  assert.equal(updated.status, 200)
  assert.equal(updated.body.meeting.revision, 2)
  assert.equal(updated.body.meeting.done_count, 1)

  const exported = await call('GET', base(meeting.id) + '/export')
  assert.equal(exported.status, 200)
  assert.match(exported.download.content_type, /text\/markdown/)
  assert.equal(exported.download.filename, `meeting-${meeting.id}.md`)
  assert.match(exported.text, /^# 周会/)
  assert.match(exported.text, /- \[x\] 订会议室（bob）/)

  assert.equal((await call('POST', base(meeting.id) + '/remove', {})).status, 200)
  assert.equal((await call('GET', base(meeting.id))).status, 404)
})

test('meeting speech prepares and uses the local provider in the signed-in runtime', async (t) => {
  const bot = await boot()
  const call = (method, path, body) => bot.call('meetings', method, base(path), body)
  assert.equal((await call('GET', 'speech')).body.phase, 'unavailable')
  let phase = 'unprepared'
  let location = 'host-local'
  let accepted = false
  let calls = 0
  const providerId = 'sensevoice-local'
  const speech = {
    snapshot: () => ({selection: {providerId}, providers: [{id: providerId, location, preparation: {phase}}]}),
    prepare(id) { assert.equal(id, providerId); accepted = true },
    resolve(spec) { return spec },
    async transcribe(spec, signal) {
      calls += 1
      assert.equal(spec.providerId, providerId)
      assert.equal(spec.audio.readUInt32LE(24), 16000)
      assert.equal(spec.audio.readInt16LE(44), -32768)
      assert.equal(signal.aborted, false)
      return {text: ' 周四发布 ' }
    },
  }
  attachRuntime({rt: {}, ctx: {get: name => name === 'speechToText' ? speech : undefined}})
  t.after(detachRuntime)
  const body = {audio_base64: waveBase64(new Float32Array([-1, 0, 1]))}
  assert.equal((await call('POST', 'transcribe', body)).status, 409)
  assert.deepEqual((await call('POST', 'speech', {})).body, {phase: 'checking', ready: false, progress: null})
  assert.equal(accepted, true)
  phase = 'ready'
  assert.equal((await call('GET', 'speech')).body.ready, true)
  assert.equal((await call('POST', 'transcribe', {audio_base64: 'AAAA'})).status, 400)
  assert.equal((await call('POST', 'transcribe', {audio_base64: waveBase64(new Float32Array(240001))})).status, 400)
  assert.deepEqual((await call('POST', 'transcribe', body)).body, {text: '周四发布'})
  assert.equal(calls, 1)
  location = 'cloud'
  assert.equal((await call('POST', 'transcribe', body)).status, 503)
  assert.equal(calls, 1)
  assert.deepEqual((await call('GET', '')).body.items, [])
})

test('meeting draft uses only the native text inference service and never saves without a separate request', async (t) => {
  const bot = await boot()
  const call = (method, id, body) => bot.call('meetings', method, base(id), body)
  const input = { title: '发布周会', attendees: ['小林'], transcript: '已决定周四上线。小林负责核对清单。' }
  const prompts = []
  let answer = '```json\n{"summary":"周四上线。","action_items":[{"text":"核对清单","owner":"小林","done":true}]}\n```'
  assert.equal((await call('POST', 'draft', input)).status, 503)
  attachRuntime({rt: {}, ctx: {}, textOnly: async prompt => { prompts.push(prompt); return answer }})
  t.after(detachRuntime)
  assert.equal((await call('POST', 'draft', {...input, transcript: ' '})).status, 400)
  assert.equal((await call('GET', 'draft')).status, 400)
  assert.equal(prompts.length, 0)
  const generated = await call('POST', 'draft', input)
  assert.equal(generated.status, 200)
  assert.deepEqual(generated.body.draft, { summary: '周四上线。', action_items: [
    {text: '核对清单', owner: '小林', done: false},
  ]})
  assert.deepEqual(JSON.parse(prompts[0].split('\n').at(-1)), input)
  assert.deepEqual((await call('GET', '')).body.items, [])
  answer = 'not JSON'
  assert.equal((await call('POST', 'draft', input)).status, 502)
  const transcript = '会议记录'.repeat(10000)
  const saved = await bot.call('meetings', 'POST', base(), {...input, ...generated.body.draft, transcript}, key())
  assert.equal(saved.status, 201)
  assert.equal(saved.body.meeting.transcript, transcript)
  assert.equal(((await bot.endpoint('meetings/search', {q: input.title})).value.items[0]).href,
    `/meetings#workspace=${WS}&meeting=${saved.body.meeting.id}`)
})

test('meeting data persists in this volume only; another DS-Bot never sees it', async () => {
  const vol = volume()
  const first = await boot(vol)
  const created = await first.call('meetings', 'POST', base(), body, key())
  const again = await boot(vol)
  assert.equal((await again.call('meetings', 'GET', base(created.body.meeting.id))).status, 200)
  const other = await boot()
  assert.equal((await other.call('meetings', 'GET', base(created.body.meeting.id))).status, 404)
  assert.equal((await other.call('meetings', 'GET', base())).body.items.length, 0)
})

test('unmoved and malformed /v1 targets are refused', async () => {
  const bot = await boot()
  assert.equal((await bot.call('meetings', 'GET', `/v1/workspaces/${WS}/automations`)).body.error.code, 'not_moved')
  for (const bad of ['/v1/workspaces/../meetings', '/x/meetings', '/v1/workspaces/%2e%2e/meetings', '//v1/']) {
    assert.equal((await bot.call('meetings', 'GET', bad)).status, 404, bad)
  }
  assert.equal((await bot.call('meetings', 'DELETE', base())).status, 404)
})

test('legacy meetings of one test account import into that account\'s DS-Bot, idempotently', async () => {
  const { bundles, expect } = legacyBundles(['meetings'])
  const vol = volume()
  deliverBundle(vol, 'meetings-1.bundle', bundles.meetings)
  const bot = await boot(vol)
  const routes = await bot.endpoint('meetings/routes')
  assert.deepEqual(routes.value.imported.map((item) => item.status), ['imported'])
  const wid = expect.workspace_id
  const read = await bot.call('meetings', 'GET', base(expect.meetings.meeting_id, wid))
  assert.equal(read.status, 200)
  assert.equal(read.body.meeting.title, expect.meetings.title)
  assert.equal(read.body.meeting.action_items[0].text, '订会议室')
  const titles = (await bot.call('meetings', 'GET', base('', wid))).body.items.map((item) => item.title)
  assert.ok(!titles.includes(expect.meetings.foreign_title), 'another account\'s meeting never enters this bundle')
  assert.equal(existsSync(join(vol.data, 'openteamily', 'import', 'meetings-1.bundle')), false)
  deliverBundle(vol, 'meetings-1.bundle', bundles.meetings)
  const again = await boot(vol)
  assert.deepEqual((await again.endpoint('meetings/routes')).value.imported.map((item) => item.status), ['already-imported'])
  const tampered = JSON.parse(bundles.meetings)
  tampered.tables.meetings = tampered.tables.meetings.replace('周会', '改过')
  const evil = volume()
  deliverBundle(evil, 'x.bundle', JSON.stringify(tampered))
  const rejected = await boot(evil)
  assert.equal((await rejected.endpoint('meetings/routes')).value.imported[0].status, 'rejected')
})

// --- transcript sessions (legacy openteamily/transcription.py → meetings feature) ---
const transcripts = (id = '', ws = WS) => `/v1/workspaces/${ws}/meetings/transcripts${id ? '/' + id : ''}`
const WS2 = 'b'.repeat(32)
const sessionInput = { meeting_id: 'meeting-1', language: 'zh-CN', consent: true }
const startTranscript = async (bot, extra = {}, ws = WS) => {
  const created = await bot.call('meetings', 'POST', transcripts('', ws), { ...sessionInput, ...extra })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  return created.body.session
}
const appendSegment = (bot, id, fields = {}, ws = WS) => bot.call('meetings', 'POST', transcripts(id, ws) + '/segments', {
  speaker_id: 'alice', start_ms: 0, end_ms: 1000, text: 'hello', ...fields,
})
const segmentPage = (bot, id, query = {}, ws = WS) => bot.call('meetings', 'GET', transcripts(id, ws) + '/segments?' + new URLSearchParams(query))

test('transcript sessions are consent-gated, feature-local and survive a reboot', async () => {
  const vol = volume()
  const bot = await boot(vol)
  assert.ok(bot.features.loaded.includes('meetings'), JSON.stringify(bot.features.failed))
  const refused = await bot.call('meetings', 'POST', transcripts('', WS), { meeting_id: 'meeting-1' })
  assert.equal(refused.status, 403)
  assert.equal(refused.body.error.code, 'consent_required')
  const wrong = await bot.call('meetings', 'POST', transcripts('', WS), { meeting_id: 'meeting-1', consent: 'yes' })
  assert.equal(wrong.body.error.code, 'invalid_consent')
  const session = await startTranscript(bot)
  assert.equal(session.status, 'recording')
  assert.equal(session.consent, true)
  assert.equal(session.consent_by, 'owner')
  assert.equal(session.language, 'zh-CN')
  assert.equal(session.meeting_id, 'meeting-1')
  assert.ok(session.started > 0)
  assert.equal(session.ended, null)
  const again = await boot(vol)
  const read = await again.call('meetings', 'GET', transcripts(session.id))
  assert.equal(read.status, 200)
  assert.equal(read.body.session.id, session.id)
  assert.equal(read.body.session.status, 'recording')
  const db = new DatabaseSync(join(vol.data, 'openteamily', 'features', 'meetings', 'meetings.sqlite3'))
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name)
  assert.ok(tables.includes('transcription_sessions') && tables.includes('transcript_segments'))
  assert.deepEqual(db.prepare("SELECT version FROM ot_feature_migrations WHERE feature='meetings' ORDER BY version").all().map((row) => row.version), [1, 2])
  db.close()
})

test('transcript segments stay ordered and non-overlapping with bounded confidence', async () => {
  const bot = await boot()
  const session = await startTranscript(bot)
  const first = await appendSegment(bot, session.id)
  assert.equal(first.status, 201, JSON.stringify(first.body))
  assert.equal(first.body.segment.text, 'hello')
  assert.equal(first.body.segment.confidence, null)
  const second = await appendSegment(bot, session.id, { speaker_id: 'bob', start_ms: 1000, end_ms: 2000, text: 'second' })
  assert.equal(second.status, 201)
  for (const fields of [{ start_ms: 1500, end_ms: 2500 }, { start_ms: 500, end_ms: 800 }]) {
    const overlap = await appendSegment(bot, session.id, fields)
    assert.equal(overlap.status, 409, JSON.stringify(fields))
    assert.equal(overlap.body.error.code, 'overlap')
  }
  for (const [start, end] of [[-1, 1000], [1000, 1000], [2000, 1500], [0, 604800001], [true, 1000], ['0', 1000]]) {
    const bad = await appendSegment(bot, session.id, { start_ms: start, end_ms: end })
    assert.equal(bad.status, 400, JSON.stringify([start, end]))
    assert.equal(bad.body.error.code, 'invalid_time_range')
  }
  const low = await appendSegment(bot, session.id, { start_ms: 2000, end_ms: 3000, confidence: 0 })
  assert.equal(low.body.segment.confidence, 0)
  const high = await appendSegment(bot, session.id, { start_ms: 3000, end_ms: 4000, confidence: 1 })
  assert.equal(high.body.segment.confidence, 1)
  for (const confidence of [-0.01, 1.01, 'high', true]) {
    const bad = await appendSegment(bot, session.id, { start_ms: 4000, end_ms: 5000, confidence })
    assert.equal(bad.status, 400, String(confidence))
    assert.equal(bad.body.error.code, 'invalid_confidence')
  }
  assert.equal((await segmentPage(bot, session.id)).body.items.length, 4)
})

test('transcript sessions finalize, fail and withdraw consent as terminal states', async () => {
  const bot = await boot()
  const session = await startTranscript(bot)
  await appendSegment(bot, session.id)
  const final = await bot.call('meetings', 'POST', transcripts(session.id) + '/finalize', {})
  assert.equal(final.status, 200)
  assert.equal(final.body.session.status, 'transcribed')
  assert.ok(final.body.session.ended >= final.body.session.started)
  const late = await appendSegment(bot, session.id, { start_ms: 1000, end_ms: 2000 })
  assert.equal(late.status, 409)
  assert.equal(late.body.error.code, 'not_recording')
  assert.equal((await bot.call('meetings', 'POST', transcripts(session.id) + '/finalize', {})).body.error.code, 'not_recording')
  const second = await startTranscript(bot, { meeting_id: 'meeting-2' })
  const failed = await bot.call('meetings', 'POST', transcripts(second.id) + '/fail', {})
  assert.equal(failed.body.session.status, 'failed')
  assert.equal((await appendSegment(bot, second.id)).body.error.code, 'not_recording')
  const third = await startTranscript(bot, { meeting_id: 'meeting-3' })
  await appendSegment(bot, third.id)
  const withdrawn = await bot.call('meetings', 'POST', transcripts(third.id) + '/withdraw', {})
  assert.equal(withdrawn.body.session.consent, false)
  assert.equal(withdrawn.body.session.status, 'failed')
  assert.ok(withdrawn.body.session.ended >= withdrawn.body.session.started)
  const blocked = await appendSegment(bot, third.id, { start_ms: 1000, end_ms: 2000 })
  assert.equal(blocked.status, 403)
  assert.equal(blocked.body.error.code, 'consent_required')
  assert.equal((await segmentPage(bot, third.id)).body.items.length, 1)
})

test('transcript segments page by cursor and filter by time range', async () => {
  const bot = await boot()
  const session = await startTranscript(bot)
  const ids = []
  for (let index = 0; index < 5; index += 1) {
    const made = await appendSegment(bot, session.id, { start_ms: index * 1000, end_ms: index * 1000 + 1000, text: 'segment-' + index })
    ids.push(made.body.segment.id)
  }
  const first = await segmentPage(bot, session.id, { limit: '2' })
  assert.deepEqual(first.body.items.map((item) => item.id), ids.slice(0, 2))
  assert.equal(first.body.cursor, ids[1])
  const second = await segmentPage(bot, session.id, { limit: '2', cursor: first.body.cursor })
  assert.deepEqual(second.body.items.map((item) => item.id), ids.slice(2, 4))
  const third = await segmentPage(bot, session.id, { limit: '2', cursor: second.body.cursor })
  assert.deepEqual(third.body.items.map((item) => item.id), ids.slice(4))
  assert.equal(third.body.cursor, null)
  assert.deepEqual((await segmentPage(bot, session.id, { limit: '2', cursor: ids[4] })).body.items, [])
  assert.deepEqual((await segmentPage(bot, session.id, { start_ms: '2000', end_ms: '4000' })).body.items.map((item) => item.start_ms), [2000, 3000])
  assert.deepEqual((await segmentPage(bot, session.id, { start_ms: '3500' })).body.items.map((item) => item.start_ms), [3000, 4000])
  assert.deepEqual((await segmentPage(bot, session.id, { cursor: 'missing' })).body.items, [])
  for (const limit of ['0', '201', '-1', 'x']) {
    const bad = await segmentPage(bot, session.id, { limit })
    assert.equal(bad.status, 400, limit)
    assert.equal(bad.body.error.code, 'invalid_limit')
  }
  assert.equal((await segmentPage(bot, session.id, { start_ms: '-1' })).body.error.code, 'invalid_time_range')
  assert.equal((await segmentPage(bot, session.id, { bogus: '1' })).status, 400)
  assert.equal((await segmentPage(bot, session.id, { cursor: 'x'.repeat(65) })).body.error.code, 'invalid_cursor')
})

test('transcript search is literal, consent-aware and workspace-scoped', async () => {
  const bot = await boot()
  const searchPath = (ws = WS) => transcripts('search', ws)
  const search = (query, extra = '', ws = WS) => bot.call('meetings', 'GET', searchPath(ws) + '?q=' + encodeURIComponent(query) + extra)
  const first = await startTranscript(bot, { meeting_id: 'meeting-search-1' })
  await appendSegment(bot, first.id, { start_ms: 0, end_ms: 1000, text: 'Alpha budget review' })
  await appendSegment(bot, first.id, { start_ms: 1000, end_ms: 2000, text: 'Beta 100% done' })
  const second = await startTranscript(bot, { meeting_id: 'meeting-search-2' })
  await appendSegment(bot, second.id, { start_ms: 0, end_ms: 1000, text: 'Alpha in second session' })
  const foreign = await startTranscript(bot, { meeting_id: 'meeting-search-3' }, WS2)
  await appendSegment(bot, foreign.id, { start_ms: 0, end_ms: 1000, text: 'Alpha elsewhere' }, WS2)
  const hits = await search('alpha')
  assert.equal(hits.status, 200)
  assert.equal(hits.body.items.length, 2)
  assert.deepEqual(new Set(hits.body.items.map((item) => item.session_id)), new Set([first.id, second.id]))
  assert.ok(hits.body.items.every((item) => item.meeting_id))
  assert.deepEqual((await search('alpha', '', WS2)).body.items.map((item) => item.session_id), [foreign.id])
  assert.deepEqual((await search('100%')).body.items.map((item) => item.text), ['Beta 100% done'])
  for (const query of ['', '   ', 'x'.repeat(201)]) {
    const bad = await search(query)
    assert.equal(bad.status, 400, query.length)
    assert.equal(bad.body.error.code, 'invalid_query')
  }
  assert.equal((await search('alpha', '&limit=0')).body.error.code, 'invalid_limit')
  await bot.call('meetings', 'POST', transcripts(second.id) + '/withdraw', {})
  assert.deepEqual((await search('alpha')).body.items.map((item) => item.session_id), [first.id])
})

test('deleting a transcript session cascades and never crosses workspaces', async () => {
  const bot = await boot()
  const session = await startTranscript(bot)
  await appendSegment(bot, session.id)
  await appendSegment(bot, session.id, { start_ms: 1000, end_ms: 2000 })
  assert.equal((await bot.call('meetings', 'GET', transcripts(session.id, WS2))).status, 404)
  assert.equal((await appendSegment(bot, session.id, {}, WS2)).status, 404)
  assert.deepEqual((await segmentPage(bot, session.id, {}, WS2)).body.items, [])
  assert.deepEqual((await bot.call('meetings', 'GET', transcripts('search', WS2) + '?q=hello')).body.items, [])
  assert.equal((await bot.call('meetings', 'POST', transcripts(session.id, WS2) + '/remove', {})).status, 404)
  assert.equal((await bot.call('meetings', 'POST', transcripts(session.id) + '/remove', {})).status, 200)
  assert.equal((await bot.call('meetings', 'GET', transcripts(session.id))).status, 404)
  assert.deepEqual((await segmentPage(bot, session.id)).body.items, [])
  assert.equal((await bot.call('meetings', 'POST', transcripts(session.id) + '/remove', {})).status, 404)
  const db = new DatabaseSync(join(bot.vol.data, 'openteamily', 'features', 'meetings', 'meetings.sqlite3'))
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM transcript_segments WHERE session_id=?').get(session.id).n, 0)
  db.close()
})

test('transcript input bounds reject oversize and control text', async () => {
  const bot = await boot()
  assert.equal((await bot.call('meetings', 'POST', transcripts('', WS), { meeting_id: 'meeting-1', consent: true, language: 'x'.repeat(36) })).body.error.code, 'invalid_language')
  assert.equal((await bot.call('meetings', 'POST', transcripts('', WS), { meeting_id: 'x'.repeat(129), consent: true })).body.error.code, 'invalid_meeting')
  const session = await startTranscript(bot)
  const cases = [
    [{ speaker_id: 'x'.repeat(81), text: 'ok', start_ms: 0, end_ms: 1000 }, 'invalid_speaker'],
    [{ text: 'x'.repeat(8001), start_ms: 1000, end_ms: 2000 }, 'invalid_text'],
    [{ text: '   ', start_ms: 2000, end_ms: 3000 }, 'invalid_text'],
    [{ text: 'bad\u0000text', start_ms: 3000, end_ms: 4000 }, 'invalid_text'],
  ]
  for (const [fields, code] of cases) {
    const bad = await appendSegment(bot, session.id, fields)
    assert.equal(bad.status, 400, JSON.stringify(fields))
    assert.equal(bad.body.error.code, code)
  }
  assert.deepEqual((await segmentPage(bot, session.id)).body.items, [])
})
