import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createAgentToolRegistry } from '../features/agent-tool-registry/index.js'
import { inferRisk, inferSideEffect, sourceOf } from '../features/agent-tool-registry/catalog.js'

const W = 'a'.repeat(32)
const A = 'b'.repeat(32)
const FOREIGN = 'c'.repeat(32)
const tools = [
  { name: 'read_file', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  { name: 'write_file', description: 'write a file', parameters: { type: 'object', properties: {} } },
  { name: 'mcp__github__create_issue', description: 'create an issue', parameters: { type: 'object', properties: {} } },
  { name: 'run_shell', description: 'run a command', parameters: { type: 'object', properties: {} } },
  { name: 'opaque_tool', description: 'opaque', parameters: { type: 'object', properties: {} } },
]

function fixture({ allowed = W, toolList = tools } = {}) {
  const db = new DatabaseSync(join(mkdtempSync(join(tmpdir(), 'ot-tool-registry-')), 'tools.sqlite3'))
  const agent = { id: 'agent-session', name: 'Agent' }
  const bots = {
    'bot-agent': { id: 'bot-agent', sessionId: 's-agent', openteamily: { workspace_id: W, agent_id: A } },
    main: { id: 'main', sessionId: 's-main' },
  }
  const ctx = { tools: { schemas: (value) => value?.id === 'agent-session' ? toolList : [] } }
  const rt = {
    state: { bots, mainBotIds: ['main'] },
    chatOwners: new Map([['s-agent', 'bot-agent'], ['s-main', 'main']]),
    botOf: id => bots[id],
    chatOf: id => bots[id]?.sessionId,
    resolveAgent: async () => agent,
  }
  const host = {
    log: () => {},
    runtime: async () => ({ rt, ctx }),
    call: async (name) => {
      if (name === 'agents/personal-binding') return { workspace_id: allowed }
      if (name === 'teams/activeWorkspaces') return [{ id: allowed }]
      throw new Error('Unexpected endpoint ' + name)
    },
  }
  return { db, host, ctx, rt, agent, bots }
}

async function api(options) {
  const f = fixture(options)
  const created = await createAgentToolRegistry({ host: f.host, db: f.db, clock: () => 1760000000 })
  return { ...f, ...created }
}

test('DSH tool schemas project into a sorted live catalog with inferred metadata', async () => {
  const f = await api()
  try {
    const result = await f.endpoints.catalog({ workspace_id: W })
    assert.equal(result.source, 'dsh')
    assert.deepEqual(result.items.map(item => item.name), [
      'mcp__github__create_issue', 'opaque_tool', 'read_file', 'run_shell', 'write_file',
    ])
    const byName = Object.fromEntries(result.items.map(item => [item.name, item]))
    assert.equal(byName.read_file.risk, 'read')
    assert.equal(byName.read_file.side_effect, 'read_only')
    assert.equal(byName.read_file.annotations.read_only_hint, true)
    assert.equal(byName.write_file.risk, 'write')
    assert.equal(byName.mcp__github__create_issue.source, 'mcp')
    assert.equal(byName.mcp__github__create_issue.risk, 'external')
    assert.equal(byName.run_shell.risk, 'dangerous')
    assert.equal(byName.opaque_tool.risk, 'unknown')
    assert.equal(result.stats.total, 5)
  } finally {
    f.db.close()
  }
})

test('owner overlays override risk, side_effect, capability, enabled and note', async () => {
  const f = await api()
  try {
    const first = await f.endpoints.upsert({
      workspace_id: W, name: 'write_file', revision: 0,
      risk: 'dangerous', side_effect: 'write', capability: 'filesystem.write', enabled: false, note: 'use only with approval',
    })
    assert.equal(first.overlay.revision, 1)
    assert.equal(first.overlay.enabled, false)

    const catalog = await f.endpoints.catalog({ workspace_id: W })
    const tool = catalog.items.find(item => item.name === 'write_file')
    assert.equal(tool.risk, 'dangerous')
    assert.equal(tool.capability, 'filesystem.write')
    assert.equal(tool.enabled, false)
    assert.equal(tool.note, 'use only with approval')
    assert.equal(tool.overlay, true)
    assert.equal(tool.revision, 1)

    const second = await f.endpoints.upsert({
      workspace_id: W, name: 'write_file', revision: 1, enabled: true,
    })
    assert.equal(second.overlay.revision, 2)
    assert.equal(second.overlay.risk, 'dangerous')
    assert.equal(second.overlay.enabled, true)

    await assert.rejects(f.endpoints.upsert({
      workspace_id: W, name: 'write_file', revision: 1, risk: 'read',
    }), (error) => error.status === 409)

    const overlays = await f.endpoints.overlays({ workspace_id: W })
    assert.equal(overlays.items.length, 1)
    assert.equal((await f.endpoints.overlay({ workspace_id: W, name: 'write_file' })).overlay.revision, 2)
    assert.deepEqual(await f.endpoints.remove({ workspace_id: W, name: 'write_file' }), { removed: 'write_file' })
    assert.equal((await f.endpoints.overlays({ workspace_id: W })).items.length, 0)
  } finally {
    f.db.close()
  }
})

test('agent and session resolution stay workspace-scoped', async () => {
  const f = await api()
  try {
    const byAgent = await f.endpoints.catalog({ workspace_id: W, agent_id: A })
    assert.equal(byAgent.agent.session_id, 's-agent')
    const bySession = await f.endpoints.catalog({ workspace_id: W, session_id: 's-agent' })
    assert.equal(bySession.agent.id, 'agent-session')
    const main = await f.endpoints.catalog({ workspace_id: W })
    assert.equal(main.agent.session_id, 's-main')
    await assert.rejects(f.endpoints.catalog({ workspace_id: W, session_id: 's-main' }), (error) => error.status === 404)
    await assert.rejects(f.endpoints.catalog({ workspace_id: W, agent_id: 'd'.repeat(32) }), (error) => error.status === 404)

    const foreign = await api({ allowed: FOREIGN })
    try {
      await assert.rejects(foreign.endpoints.catalog({ workspace_id: W }), (error) => error.status === 404)
      await assert.rejects(foreign.endpoints.upsert({ workspace_id: W, name: 'read_file', revision: 0 }), (error) => error.status === 404)
    } finally {
      foreign.db.close()
    }
  } finally {
    f.db.close()
  }
})

test('invalid names, missing tools, stale overlays and oversized schemas fail closed', async () => {
  const f = await api({
    toolList: [{ name: 'big_tool', parameters: { type: 'object', blob: 'x'.repeat(40_000) } }],
  })
  try {
    const catalog = await f.endpoints.catalog({ workspace_id: W, agent_id: A })
    assert.equal(catalog.items[0].schema_truncated, true)
    assert.equal(catalog.items[0].parameters, null)
    await assert.rejects(f.endpoints.get({ workspace_id: W, name: 'missing', agent_id: A }), (error) => error.status === 404)
    await assert.rejects(f.endpoints.get({ workspace_id: W, name: 'bad name', agent_id: A }), (error) => error.status === 400)
    await assert.rejects(f.endpoints.upsert({ workspace_id: W, name: 'bad name', revision: 0 }), (error) => error.status === 400)
    await assert.rejects(f.endpoints.upsert({ workspace_id: W, name: 'big_tool', revision: 2 }), (error) => error.status === 409)
  } finally {
    f.db.close()
  }
})

test('contract states the tool ownership boundary', async () => {
  const f = await api()
  try {
    const contract = await f.endpoints.contract()
    assert.equal(contract.schema, 'openteamily.agent-tool-registry.v1')
    assert.ok(contract.reuse.includes('DSH ctx.tools.schemas(agent)'))
    assert.ok(contract.not_doing.includes('no tool execution'))
    assert.deepEqual([inferRisk('read_file'), inferSideEffect('read'), sourceOf('mcp__x__y')], ['read', 'read_only', 'mcp'])
  } finally {
    f.db.close()
  }
})
