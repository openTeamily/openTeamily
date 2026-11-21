import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { skillLibrary } from '../features/skills/library.js'
import { setSharedBotSocial } from '../lib/c/bot-social.js'

test('local personal skill material does not require a Bot Social team', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ot-personal-skills-'))
  t.after(() => rmSync(dataDir, { recursive: true }))
  const workspace = 'a'.repeat(32)
  const agent = 'b'.repeat(32)
  const shared = 'c'.repeat(32)
  let socialCalls = 0
  setSharedBotSocial({ async request(method, path) {
    assert.equal(method, 'GET')
    assert.equal(path, '/v1/ot/teams/by-workspace/' + shared)
    socialCalls++
    return {role: 'member'}
  } })
  t.after(() => setSharedBotSocial(undefined))
  const host = {
    featureDir: () => dataDir, dataDir,
    runtime: async () => ({rt: {botOf: () => ({capabilities: []})}}),
    async call(endpoint, payload) {
      if (endpoint === 'agents/personal-binding') return {workspace_id: workspace, agent_id: agent}
      if (endpoint === 'teams/v1') return {status: 200, body: {items: [{id: workspace, role: 'owner', name: '个人工作区'}]}}
      assert.equal(payload.workspace_id, workspace)
      if (endpoint === 'agents/list') return {items: [{id: agent, name: '助手'}]}
      if (endpoint === 'automations/list') return {items: []}
      assert.equal(endpoint, 'agents/get')
      assert.equal(payload.id, agent)
      return {agent: {native_bot_id: 'personal'}}
    },
  }
  const library = skillLibrary(host, {boundName: id => 'ot-bound-' + id})
  assert.deepEqual(await library.materialForScope({scope: workspace + ':' + agent}), {items: []})
  const scopes = await library.v1({method: 'GET', path: '/v1/skills/scopes'})
  assert.equal(scopes.status, 200)
  assert.deepEqual(scopes.body.items.map(item => item.scope), ['account', workspace + ':' + agent])
  assert.equal(socialCalls, 0)
  await assert.rejects(library.materialForScope({scope: shared + ':' + agent}), /Scope requires workspace administration/)
  assert.equal(socialCalls, 1)
})
