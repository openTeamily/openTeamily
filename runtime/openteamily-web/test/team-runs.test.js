import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAgents } from '../features/agents/index.js'
import { createTeamRuns, stages } from '../features/team-runs/index.js'
import { loadFeatures } from '../src/features.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const W = 'a'.repeat(32)
const settle = async (feature) => { for (let i = 0; i < 20 && feature.inflight.size; i += 1) await Promise.all(feature.inflight.values()) }

async function fixture(reply) {
  const turns = []
  const runtime = async () => ({ rt: {}, ctx: {}, chatTurn: async (key, text, rid) => { turns.push({ key, text, rid }); return reply ? reply(key, text) : { text: `out:${key.split(':')[4]}`, sessionId: 's', turnId: 't' } } })
  const table = {}
  const host = { identity: { instanceId: 'f'.repeat(32) }, runtime, call: async (name, payload) => { if (!table[name]) throw Object.assign(new Error('x'), { code: 'openteamily/not-found' }); return table[name](payload) } }
  const agents = createAgents({ db: new DatabaseSync(':memory:'), host }).endpoints
  for (const [k, v] of Object.entries(agents)) table[`agents/${k}`] = v
  const a = (await agents.create({ workspace_id: W, name: '研究', idempotency_key: 'a'.repeat(16) })).agent
  const b = (await agents.create({ workspace_id: W, name: '写作', idempotency_key: 'b'.repeat(16) })).agent
  const feature = createTeamRuns({ db: new DatabaseSync(':memory:'), host })
  return { feature, e: feature.endpoints, a, b, agents, turns }
}

const body = (a, b, extra = {}) => ({ workspace_id: W, title: '调研报告', goal: '写一份行业调研', idempotency_key: 'r'.repeat(16),
  steps: [{ agent_id: a.id, instruction: '收集资料', depends_on: [] }, { agent_id: a.id, instruction: '找数据', depends_on: [] },
    { agent_id: b.id, instruction: '成文', depends_on: [0, 1] }], ...extra })

test('a DAG runs every step as a DS-Bot turn of its agent, in dependency order', async () => {
  const { feature, e, a, b, turns } = await fixture()
  const made = await e.create(body(a, b))
  assert.equal(made.status, 201)
  assert.deepEqual(made.run.steps.map((s) => s.stage), [1, 1, 2])
  await settle(feature)
  const { run } = await e.get({ workspace_id: W, id: made.run.id })
  assert.equal(run.status, 'succeeded')
  assert.deepEqual(run.steps.map((s) => s.status), ['succeeded', 'succeeded', 'succeeded'])
  assert.equal(run.steps[2].ds_bot.engine, 'ds-bot')
  assert.equal(turns.length, 3)
  assert.ok(turns[2].key.startsWith(`agent:${b.id}:team-run:${made.run.id}:2`))
  assert.match(turns[2].text, /^You are 写作\./)
  assert.match(turns[2].text, /团队任务目标：写一份行业调研/)
  assert.match(turns[2].text, /\[第 1 步 · 研究\] out:0/)
  assert.match(turns[2].text, /\[第 2 步 · 研究\] out:1/)
  assert.equal((await e.create(body(a, b))).status, 200)
  await assert.rejects(e.create(body(a, b, { goal: '别的' })), (err) => err.status === 409)
  assert.equal((await e.list({ workspace_id: W })).items[0].progress.succeeded, 3)
})

test('a failed step blocks dependants; retry resets them and finishes the run', async () => {
  let failFirst = true
  const { feature, e, a, b } = await fixture((key) => {
    if (key.split(':')[4] === '0' && failFirst) { failFirst = false; throw new Error('DS-Bot turn timed out') }
    return { text: 'ok' }
  })
  const { run } = await e.create(body(a, b))
  await settle(feature)
  let now = (await e.get({ workspace_id: W, id: run.id })).run
  assert.equal(now.status, 'failed')
  assert.deepEqual(now.steps.map((s) => [s.status, s.error_code]), [['failed', 'timeout'], ['succeeded', null], ['blocked', null]])
  await e.retry({ workspace_id: W, id: run.id, position: 0 })
  await settle(feature)
  now = (await e.get({ workspace_id: W, id: run.id })).run
  assert.equal(now.status, 'succeeded')
  assert.equal(now.steps[0].attempts, 2)
  await assert.rejects(e.retry({ workspace_id: W, id: run.id, position: 1 }), (err) => err.status === 409)
})

test('cancel stops pending steps and ignores late replies; validation refuses bad graphs', async () => {
  const pending = []
  const release = () => { for (const r of pending.splice(0)) r({ text: 'late' }) }
  const { feature, e, a, b, agents } = await fixture(() => new Promise((r) => { pending.push(r) }))
  const { run } = await e.create(body(a, b))
  const cancelled = (await e.cancel({ workspace_id: W, id: run.id })).run
  assert.equal(cancelled.status, 'cancelled')
  await new Promise((r) => setImmediate(r))
  release()
  await settle(feature)
  const after = (await e.get({ workspace_id: W, id: run.id })).run
  assert.ok(after.steps.every((s) => s.status === 'cancelled'))
  await e.remove({ workspace_id: W, id: run.id })
  await assert.rejects(e.get({ workspace_id: W, id: run.id }), (err) => err.status === 404)
  const k = (n) => n.repeat(16)
  await assert.rejects(e.create(body(a, b, { idempotency_key: k('x'), steps: [{ agent_id: a.id, instruction: 'x', depends_on: [1] }, { agent_id: a.id, instruction: 'y', depends_on: [] }] })), /earlier steps/)
  await assert.rejects(e.create(body(a, b, { idempotency_key: k('y'), steps: [{ agent_id: a.id, instruction: 'x', depends_on: [] }] })), /2-8 steps/)
  await agents.archive({ workspace_id: W, id: b.id })
  await assert.rejects(e.create(body(a, b, { idempotency_key: k('z') })), /active workspace agent/)
  await assert.rejects(e['step-artifact']({ workspace_id: W, id: 'd'.repeat(32), position: 0 }), (err) => err.status === 404)
  assert.deepEqual(stages([{ position: 0, depends: '[]' }, { position: 1, depends: '[0]' }, { position: 2, depends: '[0,1]' }]), { 0: 1, 1: 2, 2: 3 })
})

test('team-runs loads through the extension point', async () => {
  process.env.OPENTEAMILY_AUTOMATIONS_CLOCK = '0'
  const { table, loaded } = await loadFeatures({ dir: join(HERE, '../features'), identity: { instanceId: 'e'.repeat(32) }, dataDir: mkdtempSync(join(tmpdir(), 'ot-tr-load-')), log: () => {} })
  assert.ok(loaded.includes('team-runs'))
  assert.ok(table['team-runs/create'] && table['team-runs/retry'])
})
