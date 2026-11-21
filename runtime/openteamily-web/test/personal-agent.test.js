import assert from 'node:assert/strict'
import test from 'node:test'
import { boot } from './helpers.js'

test('personal legacy /v1 creates the same envelope once on this DS-Bot', async () => {
  const app = await boot()
  assert.deepEqual((await app.call('personal', 'GET', '/v1/personal-agent')).body, { personal_agent: null })
  const created = await app.call('personal', 'POST', '/v1/personal-agent')
  assert.equal(created.status, 201)
  const personal = created.body.personal_agent
  assert.equal(personal.workspace.name, '个人空间')
  assert.equal(personal.workspace.kind, 'personal')
  assert.match(personal.agent.name, /Personal Agent$/)
  assert.equal(personal.agent.summary, 'Your Cross-context Super AI Agent.')
  assert.equal(created.body.builtin_agents.length, 10)
  assert.deepEqual(created.body.builtin_agents.map((item) => item.key).slice(0, 3),
    ['teamily-agent', 'content-creator', 'finance-assistant'])
  const again = await app.call('personal', 'POST', '/v1/personal-agent')
  assert.equal(again.status, 200)
  assert.equal(again.body.personal_agent.workspace.id, personal.workspace.id)
  assert.equal(again.body.personal_agent.agent.id, personal.agent.id)
  assert.deepEqual((await app.call('personal', 'GET', '/v1/personal-agent')).body, created.body)
  const bad = await app.call('personal', 'GET', '/v1/personal-agent?unexpected=1')
  assert.equal(bad.status, 400)
  assert.equal(bad.body.error.code, 'invalid')
})

test('the retired homepage start is not claimed by the homepages feature', async () => {
  const app = await boot()
  const result = await app.endpoint('homepages/v1', { method: 'POST', path: '/v1/agent-homepages/start', body: { quick_start: 0 } })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'openteamily/not-found')
})
