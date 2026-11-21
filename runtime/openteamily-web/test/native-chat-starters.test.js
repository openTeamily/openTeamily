import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { createAgents } from '../features/agents/index.js'

const WORKSPACE = '1'.repeat(32)
const OTHER_WORKSPACE = '2'.repeat(32)

function ownerRuntime(testContext) {
  const db = new DatabaseSync(':memory:')
  testContext.after(() => db.close())
  const bots = { main: { id: 'main', name: 'Main', capabilities: [] } }
  let botId = 0
  let sessions = 0
  const runtime = {
    mainBot: async () => 'main',
    rt: {
      state: { bots }, chatOwners: new Map(), botOf: id => bots[id],
      createBot: async fields => {
        const id = 'bot-' + ++botId
        bots[id] = { ...fields, id }
        return bots[id]
      },
      createSession: async () => 'session-' + ++sessions,
      workDirOf: () => '/fixture',
      updateBot: async (id, patch) => Object.assign(bots[id], patch),
      setFlags: async (id, flags) => Object.assign(bots[id], flags),
      save: async () => {},
    },
  }
  const { endpoints } = createAgents({ db, host: { runtime: async () => runtime, currentRuntime: () => runtime } })
  return {
    bots,
    sessions: () => sessions,
    request: (method, path, body, idempotency_key) => endpoints.v1({ method, path, body, idempotency_key }),
  }
}

const agentBase = workspace => `/v1/workspaces/${workspace}/agents`
const directory = (workspace, archived = false) => agentBase(workspace) + '?limit=100&include=conversations'
  + (archived ? '&include_archived=1' : '')

async function createAgent(runtime, workspace, name, quick_starts) {
  const response = await runtime.request('POST', agentBase(workspace), { name, quick_starts },
    'fixture-agent-' + name.replaceAll(' ', '-'))
  assert.equal(response.status, 201)
  return response.body.agent
}

async function openThread(runtime, agentPath) {
  const response = await runtime.request('POST', agentPath + '/conversations', { title: 'Fixture thread' }, 'fixture-conversation')
  assert.equal(response.status, 201)
  return agentPath + '/conversations/' + response.body.conversation.id
}

test('the owner’s native Chat directory and thread detail share the latest saved starter array', async t => {
  const runtime = ownerRuntime(t)
  const original = await createAgent(runtime, WORKSPACE, 'Owner agent', [' Outline this brief ', 'Ask for next steps'])
  const agentPath = agentBase(WORKSPACE) + '/' + original.id
  const first = await runtime.request('GET', directory(WORKSPACE))
  assert.equal(first.status, 200)
  assert.deepEqual(first.body.items.map(({ id, workspace_id, served_by, quick_starts }) =>
    ({ id, workspace_id, served_by, quick_starts })), [
    { id: original.id, workspace_id: WORKSPACE, served_by: 'ds-bot', quick_starts: ['Outline this brief', 'Ask for next steps'] },
  ])
  assert.deepEqual(first.body.conversations, [])
  assert.equal(runtime.sessions(), 0)

  const thread = await openThread(runtime, agentPath)
  const opened = await runtime.request('GET', thread)
  assert.equal(opened.status, 200)
  assert.deepEqual(opened.body.agent, first.body.items[0])
  assert.deepEqual(opened.body.items, [])

  const change = await runtime.request('POST', agentPath, { revision: original.revision, quick_starts: ['Review the revised plan'] })
  assert.equal(change.status, 200)
  const latest = await runtime.request('GET', thread)
  const listed = await runtime.request('GET', directory(WORKSPACE))
  assert.equal(listed.body.conversations.length, 1)
  assert.equal(listed.body.conversations[0].agent_id, original.id)
  assert.equal(latest.body.agent.revision, change.body.agent.revision)
  assert.deepEqual(latest.body.agent.quick_starts, ['Review the revised plan'])
  assert.deepEqual(listed.body.items[0].quick_starts, latest.body.agent.quick_starts)
  assert.equal(runtime.sessions(), 1)

  const cleared = await runtime.request('POST', agentPath, { revision: change.body.agent.revision, quick_starts: [] })
  assert.equal(cleared.status, 200)
  assert.deepEqual((await runtime.request('GET', thread)).body.agent.quick_starts, [])
  assert.deepEqual((await runtime.request('GET', directory(WORKSPACE))).body.items[0].quick_starts, [])
})

test('archived and deleted agents cannot supply starter chips from old Chat rows', async t => {
  const runtime = ownerRuntime(t)
  const agent = await createAgent(runtime, WORKSPACE, 'Archived agent', ['Saved archive starter'])
  const agentPath = agentBase(WORKSPACE) + '/' + agent.id
  const thread = await openThread(runtime, agentPath)
  const bot = runtime.bots[agent.native_bot_id]
  bot.hidden = true
  const hidden = await runtime.request('GET', thread)
  assert.equal(hidden.status, 200)
  assert.equal(hidden.body.agent.archived, 1)
  assert.deepEqual(hidden.body.agent.quick_starts, [])
  const archived = await runtime.request('GET', directory(WORKSPACE, true))
  assert.deepEqual(archived.body.items[0].quick_starts, [])
  const editor = await runtime.request('GET', agentPath)
  assert.equal(editor.body.agent.archived, 1)
  assert.deepEqual(editor.body.agent.quick_starts, ['Saved archive starter'])

  bot.hidden = false
  assert.deepEqual((await runtime.request('GET', agentPath)).body.agent.quick_starts, ['Saved archive starter'])
  delete runtime.bots[agent.native_bot_id]
  const stale = await runtime.request('GET', directory(WORKSPACE, true))
  assert.equal(stale.body.items[0].native_deleted, true)
  assert.deepEqual(stale.body.items[0].quick_starts, [])
  const removed = await runtime.request('GET', thread)
  assert.equal(removed.status, 409)
  assert.equal(removed.body.error.code, 'native_deleted')
  assert.equal(removed.body.agent, undefined)
})

test('private agent starters remain local to the account and workspace even for the same shared workspace ID', async t => {
  const owner = ownerRuntime(t)
  const other = ownerRuntime(t)
  const a = await createAgent(owner, WORKSPACE, 'First account', ['First account only'])
  const b = await createAgent(other, WORKSPACE, 'Second account', ['Second account only'])
  const anotherWorkspace = await createAgent(owner, OTHER_WORKSPACE, 'Other workspace', ['Other workspace only'])
  const agentPath = agentBase(WORKSPACE) + '/' + a.id
  const thread = await openThread(owner, agentPath)
  assert.deepEqual((await owner.request('GET', directory(WORKSPACE))).body.items.map(row => row.id), [a.id])
  assert.deepEqual((await owner.request('GET', directory(OTHER_WORKSPACE))).body.items.map(row => row.id), [anotherWorkspace.id])
  assert.deepEqual((await other.request('GET', directory(WORKSPACE))).body.items.map(row => row.id), [b.id])
  assert.equal((await owner.request('GET', thread.replace(WORKSPACE, OTHER_WORKSPACE))).status, 404)
  assert.equal((await other.request('GET', thread)).status, 404)
  assert.equal((await other.request('GET', agentPath)).status, 404)
  assert.deepEqual((await other.request('GET', directory(WORKSPACE))).body.conversations, [])
  assert.equal(other.sessions(), 0)
})
