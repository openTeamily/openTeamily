import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { dueAt, validSchedule, zonedEpoch } from '../features/automations/schedule.js'
import { createAutomations, dsBotTurn } from '../features/automations/automations.js'
import { TEMPLATES } from '../features/automations/templates.js'
import { featureHost, loadFeatures, registerFeature } from '../src/features.js'
import artifactsFeature from '../features/artifacts/index.js'
import { attachRuntime, detachRuntime } from '../src/host.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const W = 'a'.repeat(32)
const flush = () => new Promise((r) => setImmediate(r))

function fixture(turn, at = 1_800_000_000, saveArtifact) {
  const clock = { now: at }
  const calls = []
  const feature = createAutomations({
    personalBinding: async () => ({workspace_id: W}),
    saveArtifact,
    db: new DatabaseSync(join(mkdtempSync(join(tmpdir(), 'ot-auto-')), 'a.sqlite3')), clock: () => clock.now, log: () => {},
    turn: turn ?? (async (args) => { calls.push(args); return { text: 'DS-Bot did it', model: 'm', session_id: 's1', turn_id: 't1', bot_id: 'bot1', model_calls: 1 } }),
  })
  return { feature, clock, calls, e: feature.endpoints }
}

test('a successful native run saves a durable, idempotent document from its own output', async () => {
  const table = {}
  const host = featureHost({name: 'artifacts', identity: {instanceId: W},
    dataDir: mkdtempSync(join(tmpdir(), 'ot-auto-artifacts-')), table})
  const artifacts = artifactsFeature(host)
  registerFeature(table, 'artifacts', artifacts)
  const {e, feature} = fixture(undefined, undefined, payload => host.call('artifacts/saveAutomationRun', payload))
  const {automation} = e['automations/create']({workspace_id: W, title: '保存工作简报', participants: ['alice'],
    template_id: 'custom', schedule: {kind: 'now', time_zone: 'UTC'},
    prompt: 'Summarize the day.', idempotency_key: 'create-save-run-001'})
  const {run} = e['automations/runNow']({workspace_id: W, id: automation.id, idempotency_key: 'start-save-run-001'})
  await feature.inflight.get(run.id)
  const path = `/v1/workspaces/${W}/automations/${automation.id}/runs/${run.id}/artifact`
  const save = () => e['automations/v1']({method: 'POST', path, body: {body: 'caller cannot override output'}})
  const first = await save()
  assert.equal(first.status, 201)
  const {artifact} = first.body
  assert.equal(artifact.body, 'DS-Bot did it')
  assert.equal(artifact.source.kind, 'automation_run')
  assert.equal(artifact.source.id, run.id)
  assert.equal(artifact.source.automation_id, automation.id)
  const repeat = await save()
  assert.equal(repeat.status, 200)
  assert.equal(repeat.body.artifact.id, artifact.id)
  assert.equal((await e['automations/v1']({method: 'GET', path})).status, 405)
  assert.equal((await e['automations/v1']({method: 'POST', path: path.replace(W, 'b'.repeat(32))})).status, 404)
  await assert.rejects(() => artifacts.endpoints.saveAutomationRun({}, {internal: false}), /Save results/)
})

test('schedule slots match the server rules across time zones', () => {
  const zone = 'Asia/Shanghai'
  const nine = zonedEpoch(zone, 2027, 1, 4, 9, 0) // Monday
  assert.equal(nine, Date.UTC(2027, 0, 4, 1, 0) / 1000)
  assert.equal(dueAt({ kind: 'daily', time: '09:00', time_zone: zone }, nine - 1), null)
  assert.equal(dueAt({ kind: 'daily', time: '09:00', time_zone: zone }, nine + 60), nine)
  assert.equal(dueAt({ kind: 'weekly', weekday: 1, time: '09:00', time_zone: zone }, nine + 5), nine)
  assert.equal(dueAt({ kind: 'weekly', weekday: 2, time: '09:00', time_zone: zone }, nine + 5), null)
  assert.equal(dueAt({ kind: 'weekdays', time: '09:00', time_zone: zone }, nine + 5), nine)
  assert.equal(dueAt({ kind: 'monthly', day: 4, time: '09:00', time_zone: zone }, nine + 5), nine)
  assert.equal(dueAt({ kind: 'once', date: '2027-01-04', time: '09:00', time_zone: zone }, nine), nine)
  assert.equal(dueAt({ kind: 'now', time_zone: zone }, nine), 0)
  assert.equal(validSchedule({ kind: 'daily', time: '25:00', time_zone: zone }), false)
  assert.equal(validSchedule({ kind: 'once', date: '2027-02-30', time: '09:00', time_zone: zone }), false)
  assert.equal(validSchedule({ kind: 'daily', time: '09:00', time_zone: 'Nowhere/City' }), false)
  assert.equal(validSchedule({ kind: 'later', date: '2027-02-03', time: '09:00', time_zone: 'UTC' }), true)
})

test('templates stay in step with the Python source', () => {
  const py = readFileSync(join(HERE, '../../../openteamily/automations.py'), 'utf8')
  const ids = [...py.matchAll(/^ {4}'([a-z_]+)': \{/gm)].map((m) => m[1])
  assert.deepEqual(Object.keys(TEMPLATES), ids)
})

test('create is idempotent, titles are unique, updates check revision', async () => {
  const { e } = fixture()
  const body = { workspace_id: W, title: '每日简报', template_id: 'daily_brief', schedule: { kind: 'daily', time: '09:00', time_zone: 'Asia/Shanghai' }, participants: ['alice'], idempotency_key: 'k'.repeat(16) }
  const made = e['automations/create'](body)
  assert.equal(made.status, 201)
  assert.equal(made.automation.enabled, false)
  assert.equal(made.automation.compiled, true)
  assert.match(made.automation.prompt, /每天 09:00/)
  assert.equal(e['automations/create'](body).status, 200)
  assert.throws(() => e['automations/create']({ ...body, title: '别的' }), /different request/)
  assert.throws(() => e['automations/create']({ ...body, idempotency_key: 'j'.repeat(16) }), /already exists/)
  const id = made.automation.id
  const up = e['automations/update']({ workspace_id: W, id, revision: 1, changes: { enabled: true, scope: 'ongoing' } })
  assert.equal(up.automation.revision, 2)
  assert.match(up.automation.prompt, /长期运行/)
  assert.throws(() => e['automations/update']({ workspace_id: W, id, revision: 1, changes: { enabled: false } }), (err) => err.status === 409)
  assert.equal(e['automations/list']({ workspace_id: W, category: 'work' }).items.length, 1)
  assert.equal(e['automations/list']({ workspace_id: W, category: 'life' }).items.length, 0)
  assert.equal(e['automations/list']({ workspace_id: 'b'.repeat(32) }).items.length, 0)
})

test('the mine tab lists saved automations for the signed-in runtime owner', async () => {
  const { e } = fixture()
  const draft = { workspace_id: W, template_id: 'custom', prompt: 'Respond once',
    schedule: { kind: 'now', time_zone: 'UTC' } }
  const { automation } = e['automations/create']({
    ...draft, title: '我的任务', participants: ['alice'], idempotency_key: 'a'.repeat(16),
  })
  e['automations/create']({
    ...draft, title: '其他人的任务', participants: ['bobby'], idempotency_key: 'b'.repeat(16),
  })
  const path = `/v1/workspaces/${W}/automations?category=mine`
  const request = new Request('https://example.test', { headers: { 'x-ot-owner-username': 'Alice' } })
  const result = await e['automations/v1']({ path }, { request })
  assert.equal(result.status, 200)
  assert.deepEqual(result.body.items.map(item => item.id), [automation.id])
})

test('creating a scheduled automation can save it enabled in the same request', async () => {
  const { e } = fixture()
  const request = {
    method: 'POST', path: `/v1/workspaces/${W}/automations`, idempotency_key: 'e'.repeat(16),
    body: { title: '每周检查', template_id: 'custom', prompt: 'Check the report', participants: ['alice'],
      schedule: { kind: 'weekly', weekday: 1, time: '09:00', time_zone: 'UTC' }, enabled: true },
  }
  const created = await e['automations/v1'](request)
  assert.equal(created.status, 201)
  assert.equal(created.body.automation.enabled, true)
  assert.equal(created.body.automation.revision, 1)
  const retried = await e['automations/v1'](request)
  assert.equal(retried.status, 200)
  assert.equal(retried.body.automation.id, created.body.automation.id)
  assert.equal((await e['automations/v1']({...request, body: {...request.body, enabled: false}})).status, 409)
})

test('a due schedule fires inside DS-Bot once per slot and records the DS-Bot reply', async () => {
  const at = zonedEpoch('UTC', 2027, 1, 4, 9, 1)
  const { e, calls, feature, clock } = fixture(null, at)
  const { automation } = e['automations/create']({ workspace_id: W, title: '提醒', template_id: 'reminder', schedule: { kind: 'daily', time: '09:00', time_zone: 'UTC' }, participants: ['alice'], idempotency_key: 'r'.repeat(16) })
  assert.equal(automation.enabled, true)
  const fired = feature.tick()
  assert.equal(fired.length, 1)
  assert.equal(feature.tick().length, 0, 'same slot never fires twice')
  await Promise.all(feature.inflight.values())
  assert.equal(calls.length, 1)
  assert.equal(calls[0].conversation, `automation:${automation.id}`)
  assert.match(calls[0].prompt, /到点提醒我/)
  const { items } = e['automations/runs']({ workspace_id: W, id: automation.id })
  assert.equal(items[0].status, 'succeeded')
  assert.equal(items[0].result.text, 'DS-Bot did it')
  assert.equal(items[0].dispatch.backend, 'ds-bot')
  assert.equal(items[0].dispatch.ds_bot.session_id, 's1')
  clock.now += 86400
  assert.equal(feature.tick().length, 1, 'next day fires again')
})

test('manual execution queues only the named automation and leaves its scheduled slot free', async () => {
  let finishTurn
  const calls = []
  const { e, feature } = fixture(args => new Promise(resolve => { calls.push(args); finishTurn = resolve }))
  const draft = {workspace_id: W, template_id: 'custom', prompt: 'Respond once', participants: ['alice'],
    schedule: {kind: 'now', time_zone: 'UTC'}}
  const {automation: target} = e['automations/create']({...draft, title: '手动', idempotency_key: 'm'.repeat(16)})
  const {automation: other} = e['automations/create']({...draft, title: '其他', idempotency_key: 'o'.repeat(16)})
  const req = {method: 'POST', path: `/v1/workspaces/${W}/automations/${target.id}/run`,
    body: {}, idempotency_key: 'q'.repeat(16)}
  const accepted = await e['automations/v1'](req)
  assert.equal(accepted.status, 202)
  assert.equal(accepted.body.run.trigger, 'manual')
  assert.equal((await e['automations/v1'](req)).body.run.id, accepted.body.run.id)
  assert.equal((await e['automations/v1']({...req, idempotency_key: 'x'.repeat(16)})).status, 409)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].conversation, `automation:${target.id}`)
  finishTurn({text: '完成'})
  await Promise.all(feature.inflight.values())
  assert.equal(e['automations/runs']({workspace_id: W, id: other.id}).items.length, 0)
  assert.equal(e['automations/get']({workspace_id: W, id: target.id}).automation.enabled, false)
  e['automations/update']({workspace_id: W, id: target.id, revision: 1, changes: {enabled: true}})
  assert.equal(feature.tick().length, 1)
  finishTurn({text: '定时完成'})
  await Promise.all(feature.inflight.values())
  assert.equal(e['automations/runs']({workspace_id: W, id: target.id}).items.length, 2)
})

test('failed runs are recorded; retry is idempotent; queued runs can be cancelled', async () => {
  let fail = true
  let release
  const { e, feature } = fixture(async () => {
    if (fail) throw Object.assign(new Error('x'), { code: 'openteamily/runtime-unavailable' })
    await new Promise((r) => { release = r })
    return { text: 'ok' }
  })
  const { automation } = e['automations/create']({ workspace_id: W, title: '现在', template_id: 'custom', prompt: 'do it', schedule: { kind: 'now', time_zone: 'UTC' }, participants: ['alice'], idempotency_key: 'n'.repeat(16) })
  e['automations/update']({ workspace_id: W, id: automation.id, revision: 1, changes: { enabled: true } })
  feature.tick()
  await Promise.all(feature.inflight.values())
  const [failed] = e['automations/runs']({ workspace_id: W, id: automation.id }).items
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error_code, 'runtime_unavailable')
  fail = false
  const retried = e['automations/retry']({ workspace_id: W, id: automation.id, run_id: failed.id, idempotency_key: 'x'.repeat(16) })
  assert.equal(retried.status, 201)
  assert.equal(e['automations/retry']({ workspace_id: W, id: automation.id, run_id: failed.id, idempotency_key: 'x'.repeat(16) }).run.id, retried.run.id)
  await flush()
  const cancelled = e['automations/cancel']({ workspace_id: W, id: automation.id, run_id: retried.run.id })
  assert.equal(cancelled.run.status, 'cancelled')
  release()
  await Promise.all(feature.inflight.values())
  assert.equal(e['automations/run']({ workspace_id: W, id: automation.id, run_id: retried.run.id }).run.status, 'cancelled', 'late reply keeps the cancel')
})

test('legacy import is idempotent and never re-fires the already-run slot', () => {
  const at = zonedEpoch('UTC', 2027, 1, 4, 9, 30)
  const { e, feature, calls } = fixture(null, at)
  const row = { id: 'c'.repeat(32), workspace_id: W, title: '迁移', prompt: 'p', template_id: 'custom', schedule: { kind: 'daily', time: '09:00', time_zone: 'UTC' }, participants: [{ username: 'alice' }], enabled: true, revision: 3 }
  assert.equal(e['automations/import']({ automations: [row] }).imported, 1)
  assert.equal(e['automations/import']({ automations: [row] }).imported, 0)
  assert.equal(feature.tick().length, 0)
  assert.equal(calls.length, 0)
  assert.equal(e['automations/get']({ workspace_id: W, id: row.id }).automation.revision, 3)
})

test('the feature loads through the extension point and runs turns via the DS-Bot chatTurn service', async () => {
  process.env.OPENTEAMILY_AUTOMATIONS_CLOCK = '0'
  const data = mkdtempSync(join(tmpdir(), 'ot-auto-load-'))
  const { table, loaded } = await loadFeatures({ dir: join(HERE, '../features'), identity: { instanceId: 'e'.repeat(32) }, dataDir: data, log: () => {} })
  assert.ok(loaded.includes('automations'))
  const made = await table['automations/create']({ workspace_id: W, title: 'X', template_id: 'custom', prompt: 'p', schedule: { kind: 'now', time_zone: 'UTC' }, participants: ['alice'], idempotency_key: 'l'.repeat(16) })
  assert.equal(made.status, 201)
  assert.equal((await table['automations/templates']()).items.length, Object.keys(TEMPLATES).length)
  const seen = []
  attachRuntime({ rt: {}, ctx: {}, chatTurn: async (key, text, rid) => { seen.push([key, rid]); return { text: 'hi', sessionId: 's', turnId: 't' } } })
  const turn = dsBotTurn({ runtime: async () => (await import('../src/host.js')).runtime() })
  const reply = await turn({ conversation: 'automation:1', prompt: 'p', requestId: 'r' })
  assert.deepEqual(seen, [['automation:1', 'r']])
  assert.equal(reply.session_id, 's')
  detachRuntime()
  attachRuntime({ rt: {}, ctx: {} })
  await assert.rejects(turn({ conversation: 'c', prompt: 'p' }), (err) => err.code === 'automations/runtime-unavailable')
  detachRuntime()
})



test('v1 lists templates and automations in the legacy /v1 shape', async () => {
  const { e } = fixture()
  const templates = await e['automations/v1']({ method: 'GET', path: '/v1/automation-templates' })
  assert.equal(templates.status, 200)
  assert.ok(templates.body.items.some((item) => item.id === 'custom'))
  const created = await e['automations/v1']({
    method: 'POST', path: `/v1/workspaces/${W}/automations`,
    idempotency_key: 'a'.repeat(20),
    body: { title: '晨报', prompt: '汇总。', template_id: 'custom', schedule: { kind: 'daily', time: '09:00', time_zone: 'Asia/Shanghai' }, participants: ['alice'] },
  })
  assert.equal(created.status, 201, created.body)
  const id = created.body.automation.id
  const listed = await e['automations/v1']({ method: 'GET', path: `/v1/workspaces/${W}/automations` })
  assert.equal(listed.body.items[0].id, id)
  const got = await e['automations/v1']({ method: 'GET', path: `/v1/workspaces/${W}/automations/${id}` })
  assert.equal(got.body.automation.title, '晨报')
  const updated = await e['automations/v1']({ method: 'POST', path: `/v1/workspaces/${W}/automations/${id}`, body: { revision: 1, changes: { enabled: true } } })
  assert.equal(updated.body.automation.enabled, true)
  const unknown = await e['automations/v1']({ method: 'GET', path: `/v1/workspaces/${W}/meetings` })
  assert.equal(unknown.status, 404)
  assert.equal(unknown.body.error.code, 'not_moved')
})

test('official import bundle marks the current slot skipped and does not re-import', async () => {
  const { createHash } = await import('node:crypto')
  const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
  const at = zonedEpoch('UTC', 2027, 1, 4, 9, 30)
  const { e, feature } = fixture(null, at)
  const automations = [{
    id: 'c'.repeat(32), workspace_id: W, title: '旧报', title_hash: 'x', prompt: '汇总。', template_id: 'custom',
    schedule: { kind: 'daily', time: '09:00', time_zone: 'UTC' }, participants: [{ username: 'alice' }], enabled: 1, revision: 1, created: 1, updated: 1,
  }]
  const text = JSON.stringify(automations)
  const bundle = { format: 'openteamily-dsbot-import', version: 1, feature: 'automations', created: 1,
    tables: { automations: text }, manifest: { automations: { rows: 1, sha256: sha(text) } } }
  const first = await feature.migrate(bundle)
  assert.equal(first.imported, 1)
  assert.equal(e['automations/list']({ workspace_id: W }).items[0].title, '旧报')
  const runs = e['automations/runs']({ workspace_id: W, id: 'c'.repeat(32) })
  assert.ok(runs.items.some((row) => row.status === 'skipped' && row.error_code === 'migrated'))
  assert.equal(feature.tick().length, 0)
  assert.equal((await feature.migrate(bundle)).imported, 0)
})

test('onboarding creates a paused automation in DS-Bot and skips retries', async () => {
  const { e } = fixture()
  const request = {method: 'POST', path: '/v1/onboarding/automations',
    body: {workspace_id: W, template_ids: ['daily_brief'], username: 'alice'}}
  const denied = await e['automations/v1']({...request, body: {...request.body, workspace_id: 'b'.repeat(32)}})
  assert.equal(denied.status, 403)
  const result = await e['automations/v1'](request)
  assert.equal(result.status, 201)
  const id = result.body.created[0].id
  assert.equal(e['automations/get']({workspace_id: W, id}).automation.enabled, false)
  const retry = await e['automations/v1'](request)
  assert.equal(retry.status, 200)
  assert.deepEqual(retry.body.created, [])
  assert.equal(retry.body.skipped[0].template_id, 'daily_brief')
})
