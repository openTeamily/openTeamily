// Stream C: public agent homepages and team-run shares (fake Bot Social + in-process host.call).
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBotSocial, setSharedBotSocial } from '../lib/c/bot-social.js'
import homepages from '../features/homepages/index.js'
import shares from '../features/shares/index.js'

const SERVER = 'https://social.example.test'
const AGENT = { id: 'a'.repeat(32), name: 'Writer', summary: 'drafts', category: 'content-creation', quick_starts: ['outline this'], instructions: 'SECRET PROMPT never publish' }
const RUN = { id: 'b'.repeat(32), title: 'Q3 plan', goal: 'write the plan', status: 'succeeded', progress: { succeeded: 2, total: 2 },
  steps: [{ position: 0, agent_name: 'Writer', instruction: 'PRIVATE INSTR', status: 'succeeded', output: 'draft ok', error_code: 'x' }] }

function setup(calls, agents, runs) {
  const dir = mkdtempSync(join(tmpdir(), 'ot-c5-'))
  mkdirSync(join(dir, 'bot'))
  writeFileSync(join(dir, 'bot', 'flybot-social.json'), JSON.stringify({ token: 'ot-fake-token', server: SERVER }), { mode: 0o600 })
  const fetch = async (url, init) => {
    calls.push({ method: init.method, path: url.slice(SERVER.length), body: init.body ? JSON.parse(init.body) : undefined })
    return new Response(JSON.stringify({ id: 'otl_1', kind: 'agent', slug: 'writer', snapshot: JSON.stringify({ name: 'Writer' }), creator: { handle: 'ann.home' } }), { status: 200 })
  }
  setSharedBotSocial(createBotSocial({ server: SERVER, credentialsPath: join(dir, 'bot', 'flybot-social.json'), fetch }))
  const host = {
    dataDir: dir,
    async call(endpoint, payload) {
      if (endpoint === 'agents/get') { assert.equal(payload.id, AGENT.id); return { agent: agents ?? AGENT } }
      if (endpoint === 'team-runs/get') { assert.equal(payload.id, RUN.id); return { run: runs ?? RUN } }
      throw Object.assign(new Error(endpoint), { code: 'openteamily/not-found' })
    },
  }
  return host
}

test('homepage publish and get, and team-run share omit private fields', async () => {
  const calls = []
  const host = setup(calls)
  const H = homepages(host).endpoints
  const S = shares(host).endpoints
  await H.publish({ agent_id: AGENT.id, workspace_id: 'c'.repeat(32), slug: 'writer' }, { host })
  const page = await H.get({ slug: 'writer' }, { host })
  assert.equal(page.page.name, 'Writer')
  await S.publish({ team_id: 'ott_1', run_id: RUN.id, workspace_id: 'c'.repeat(32) }, { host })
  const putListing = calls.find((c) => c.method === 'PUT' && c.path === '/v1/ot/listings')
  const body = putListing.body
  assert.equal(body.kind, 'agent')
  assert.equal(body.ref, AGENT.id)
  assert.equal(body.title, 'Writer')
  assert.ok(!JSON.stringify(body).includes('SECRET'), 'instructions never published')
  const snap = JSON.parse(body.snapshot)
  assert.deepEqual(snap.quick_starts, ['outline this'])
  assert.ok(!('instructions' in snap))
  const share = calls.find((c) => c.path === '/v1/ot/teams/ott_1/shared-runs')
  assert.equal(share.method, 'PUT')
  assert.equal(share.body.run_ref, RUN.id)
  assert.equal(share.body.title, 'Q3 plan')
  assert.deepEqual(share.body.snapshot.steps[0], { position: 0, agent_name: 'Writer', status: 'succeeded', output: 'draft ok' })
  assert.ok(!JSON.stringify(share.body).includes('PRIVATE INSTR'), 'step instructions never shared')
  assert.ok(!JSON.stringify(share.body).includes('error_code'))
})
