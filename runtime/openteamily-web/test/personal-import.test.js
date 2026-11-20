import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { boot, deliverBundle } from './helpers.js'

const OWNER = 'a'.repeat(32)
const WS = '1'.repeat(32)
const PERSONAL = '2'.repeat(32)
const LOOK = { color: '天空蓝', expression: '微笑', headwear: '耳机', glasses: '无', hand: '咖啡杯' }
const BUILTINS = [
  ['teamily-agent', 'Teamily Agent', 'Teamily 平台助手', '帮助用户了解和使用平台功能。'],
  ['content-creator', 'Content Creator', '内容创作助手', '协助起草、改写和润色内容。'],
  ['finance-assistant', 'Finance Assistant', '财务助手', '帮助整理预算、账单与财务问题。'],
  ['health-assistant', 'Health Assistant', '健康助手', '提供一般性的健康与运动建议。'],
  ['ai-stock-assistant', 'AI Stock Assistant', 'AI 股票助手', '帮助整理市场信息与投资研究。'],
  ['market-research', 'Market Research', '市场调研助手', '协助收集和整理市场调研资料。'],
  ['travel-planner', 'Travel Planner', '旅行规划助手', '帮助规划行程、预算与路线。'],
  ['accounting-assistant', 'Accounting Assistant', '会计助手', '帮助整理账目与报销。'],
  ['slides-assistant', 'Slides Assistant', '演示文稿助手', '帮助组织演示文稿结构与要点。'],
  ['webpage-developer', 'Webpage Developer', '网页开发助手', '帮助搭建和修改小型网页。'],
]
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

function agent(id, name, summary, instructions, created = 1700000000, updated = 1700000100) {
  return { id, workspace_id: WS, name, summary, instructions, revision: 2, created, updated, created_by: OWNER, archived: 0 }
}

function personalBundle() {
  const personal = agent(PERSONAL, "alice's Personal Agent", 'Your Cross-context Super AI Agent.',
    '你是用户的个人智能体，跨对话记住用户的目标与偏好。')
  const builtins = BUILTINS.map(([key, name, summary, instructions], index) => ({
    key, row: agent((index + 3).toString(16).repeat(32).slice(0, 32), name, summary, instructions),
  }))
  const rows = {
    ot_users: [{ id: OWNER, username: 'alice' }],
    workspaces: [{ id: WS, owner_id: OWNER, name: '个人空间', created: 1700000000 }],
    workspace_agents: [personal, ...builtins.map((item) => item.row)],
    personal_agents: [{ user_id: OWNER, workspace_id: WS, agent_id: PERSONAL, created: 1700000000 }],
    builtin_agents: builtins.map(({ key, row }) => ({ agent_id: row.id, workspace_id: WS, builtin_key: key, created: 1700000000 })),
    personal_look: [{ user_id: OWNER, look: JSON.stringify(LOOK), updated: 1700000200 }],
  }
  const bundle = { format: 'openteamily-dsbot-import', version: 1, feature: 'personal', created: 1700000300, tables: {}, manifest: {} }
  for (const [name, value] of Object.entries(rows)) {
    bundle.tables[name] = JSON.stringify(value)
    bundle.manifest[name] = { rows: value.length, sha256: sha(bundle.tables[name]) }
  }
  return { bundle, rows, personal, builtins }
}

test('fresh accounts keep the existing local personal-agent creation behavior', async () => {
  const app = await boot()
  assert.deepEqual((await app.call('personal', 'GET', '/v1/personal-agent')).body, { personal_agent: null })
  const created = await app.call('personal', 'POST', '/v1/personal-agent')
  assert.equal(created.status, 201)
  assert.equal(created.body.personal_agent.workspace.name, '个人空间')
  assert.equal(created.body.personal_agent.workspace.kind, 'personal')
  assert.match(created.body.personal_agent.agent.name, /Personal Agent$/)
  assert.equal(created.body.builtin_agents.length, 10)
  const again = await app.call('personal', 'POST', '/v1/personal-agent')
  assert.equal(again.status, 200)
  assert.equal(again.body.personal_agent.workspace.id, created.body.personal_agent.workspace.id)
  assert.equal(again.body.personal_agent.agent.id, created.body.personal_agent.agent.id)
  assert.deepEqual((await app.call('personal', 'GET', '/v1/personal-agent')).body, created.body)
})

test('personal bundle import replaces a local placeholder, preserves imported fields and is idempotent', async () => {
  let app = await boot()
  const local = (await app.call('personal', 'POST', '/v1/personal-agent')).body
  assert.notEqual(local.personal_agent.workspace.id, WS)
  const { bundle, personal, builtins } = personalBundle()
  const text = JSON.stringify(bundle)
  deliverBundle(app.vol, 'personal-v1.bundle', text)
  assert.equal(existsSync(join(app.vol.data, 'openteamily', 'import', 'personal-v1.bundle')), true)
  app = await boot(app.vol)
  assert.equal(existsSync(join(app.vol.data, 'openteamily', 'import', 'personal-v1.bundle')), false)

  const view = (await app.call('personal', 'GET', '/v1/personal-agent')).body
  assert.equal(view.personal_agent.workspace.id, WS)
  assert.equal(view.personal_agent.workspace.name, '个人空间')
  assert.equal(view.personal_agent.workspace.kind, 'personal')
  assert.equal(view.personal_agent.agent.id, PERSONAL)
  assert.equal(view.personal_agent.agent.name, personal.name)
  assert.equal(view.personal_agent.agent.instructions, personal.instructions)
  assert.equal(view.personal_agent.agent.created, personal.created)
  assert.equal(view.personal_agent.agent.updated, personal.updated)
  assert.deepEqual(view.personal_agent.look, LOOK)
  assert.deepEqual(view.builtin_agents.map((item) => item.key), builtins.map((item) => item.key))
  assert.deepEqual(view.builtin_agents.map((item) => item.agent.id), builtins.map((item) => item.row.id))
  assert.equal(new Set(view.builtin_agents.map((item) => item.agent.name)).size, 10)
  assert.equal(view.builtin_agents.some((item) => item.agent.id === local.personal_agent.agent.id), false)
  const profile = await app.endpoint('personal/get', {})
  assert.equal(profile.value.name, personal.name)
  assert.equal(profile.value.instructions, personal.instructions)

  // Same bundle re-delivery is a no-op; the imported member identity stays stable.
  deliverBundle(app.vol, 'personal-v1.bundle', text)
  app = await boot(app.vol)
  const again = (await app.call('personal', 'GET', '/v1/personal-agent')).body
  assert.deepEqual(again, view)
})

test('re-delivery with the same migrated rows keeps local edits made after import', async () => {
  let app = await boot()
  const { bundle } = personalBundle()
  deliverBundle(app.vol, 'personal-v1.bundle', JSON.stringify(bundle))
  app = await boot(app.vol)
  await app.call('personal', 'POST', '/v1/personal-agent')
  await app.endpoint('personal/set', { name: 'Owner renamed', instructions: 'Owner instructions.' })
  const bumped = { ...bundle, created: bundle.created + 1 }
  deliverBundle(app.vol, 'personal-v1.bundle', JSON.stringify(bumped))
  app = await boot(app.vol)
  const profile = await app.endpoint('personal/get', {})
  assert.equal(profile.value.name, 'Owner renamed')
  assert.equal(profile.value.instructions, 'Owner instructions.')
  const view = (await app.call('personal', 'GET', '/v1/personal-agent')).body
  assert.equal(view.personal_agent.agent.id, PERSONAL)
})

test('missing, tampered or cross-owner personal bundles are rejected', async () => {
  const app = await boot()
  const { bundle } = personalBundle()
  const importBundle = async (value) => app.endpoint('personal/import', { bundle: value })

  assert.equal((await importBundle(undefined)).ok, false)
  assert.equal((await importBundle({ ...bundle, feature: 'agents' })).ok, false)
  assert.equal((await importBundle({ format: 'openteamily-dsbot-import', version: 1, feature: 'personal', tables: {}, manifest: {} })).ok, false)
  const tampered = { ...bundle, tables: { ...bundle.tables, workspace_agents: '[]' } }
  assert.equal((await importBundle(tampered)).ok, false)
  const missing = { ...bundle, tables: { ...bundle.tables }, manifest: { ...bundle.manifest } }
  delete missing.tables.builtin_agents
  delete missing.manifest.builtin_agents
  assert.equal((await importBundle(missing)).ok, false)
  const mixed = {
    tables: { ...bundle.tables },
    manifest: { ...bundle.manifest },
  }
  const foreign = JSON.parse(bundle.tables.workspaces)
  foreign[0].owner_id = 'b'.repeat(32)
  mixed.tables.workspaces = JSON.stringify(foreign)
  mixed.manifest.workspaces = { rows: foreign.length, sha256: sha(mixed.tables.workspaces) }
  assert.equal((await importBundle(mixed)).ok, false)
  assert.deepEqual((await app.call('personal', 'GET', '/v1/personal-agent')).body, { personal_agent: null })
})
