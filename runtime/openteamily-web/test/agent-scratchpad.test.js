import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createAgentScratchpad } from '../features/agent-scratchpad/index.js'
import { LIMITS } from '../features/agent-scratchpad/store.js'

const W = 'a'.repeat(32)
const A = 'b'.repeat(32)
const R = 'c'.repeat(32)
const FOREIGN = 'd'.repeat(32)
const key = 'clients'.padEnd(16, 'x')

function fixture({ allowed = W } = {}) {
  const db = new DatabaseSync(join(mkdtempSync(join(tmpdir(), 'ot-scratchpad-')), 'scratchpad.sqlite3'))
  const clock = { value: 1760000000 }
  const host = {
    call: async (name) => {
      if (name === 'agents/personal-binding') return { workspace_id: allowed }
      if (name === 'teams/activeWorkspaces') return [{ id: allowed }]
      throw new Error('Unexpected endpoint ' + name)
    },
  }
  return { db, host, clock }
}

async function api(options) {
  const f = fixture(options)
  const created = await createAgentScratchpad({ host: f.host, db: f.db, clock: () => f.clock.value })
  return { ...f, ...created }
}

test('JSON and text entries round-trip with a revision and metadata', async () => {
  const f = await api()
  try {
    const created = await f.endpoints.put({
      workspace_id: W, scope: 'run:' + R, key: 'plan', value: { goal: 'ship' },
      visibility: 'run', owner_agent_id: A, owner_run_id: R, client_key: key,
    })
    assert.equal(created.status, 201)
    assert.equal(created.entry.revision, 1)
    assert.deepEqual(created.entry.value, { goal: 'ship' })
    assert.equal(created.entry.visibility, 'run')
    assert.equal(created.entry.owner_run_id, R)

    const text = await f.endpoints.put({
      workspace_id: W, scope: 'run:' + R, key: 'note', value: 'hello', content_type: 'text/plain',
    })
    assert.equal(text.status, 201)
    assert.equal((await f.endpoints.get({ workspace_id: W, scope: 'run:' + R, key: 'note' })).entry.value, 'hello')
    await assert.rejects(f.endpoints.get({ workspace_id: W, scope: 'run:' + R, key: 'missing' }), (error) => error.status === 404)
  } finally {
    f.db.close()
  }
})

test('CAS revisions detect stale writes and client_key replays the original entry', async () => {
  const f = await api()
  try {
    const first = await f.endpoints.put({
      workspace_id: W, scope: 'run:' + R, key: 'plan', value: { step: 1 }, expected_revision: 0, client_key: key,
    })
    const replay = await f.endpoints.put({
      workspace_id: W, scope: 'run:' + R, key: 'plan', value: { step: 1 }, expected_revision: 99, client_key: key,
    })
    assert.equal(replay.status, 200)
    assert.equal(replay.replayed, true)
    assert.equal(replay.entry.revision, first.entry.revision)
    await assert.rejects(f.endpoints.put({
      workspace_id: W, scope: 'run:' + R, key: 'plan', value: { step: 2 }, client_key: key,
    }), (error) => error.status === 409)

    const updated = await f.endpoints.put({
      workspace_id: W, scope: 'run:' + R, key: 'plan', value: { step: 2 }, expected_revision: 1,
    })
    assert.equal(updated.entry.revision, 2)
    await assert.rejects(f.endpoints.put({
      workspace_id: W, scope: 'run:' + R, key: 'plan', value: { step: 3 }, expected_revision: 1,
    }), (error) => error.status === 409 && error.current?.revision === 2)
    await assert.rejects(f.endpoints.put({
      workspace_id: W, scope: 'run:' + R, key: 'new', value: 'x', expected_revision: 1,
    }), (error) => error.status === 409)
  } finally {
    f.db.close()
  }
})

test('scope, prefix and cursor listing are stable; expiry hides entries and stats', async () => {
  const f = await api()
  try {
    for (const name of ['a', 'b', 'c']) {
      await f.endpoints.put({ workspace_id: W, scope: 'run:' + R, key: 'step.' + name, value: name })
    }
    await f.endpoints.put({ workspace_id: W, scope: 'other', key: 'step.d', value: 'd' })
    const first = await f.endpoints.list({ workspace_id: W, scope: 'run:' + R, prefix: 'step.', limit: 2 })
    assert.deepEqual(first.items.map(item => item.key), ['step.a', 'step.b'])
    const second = await f.endpoints.list({ workspace_id: W, scope: 'run:' + R, prefix: 'step.', limit: 2, cursor: first.cursor })
    assert.deepEqual(second.items.map(item => item.key), ['step.c'])

    await f.endpoints.put({
      workspace_id: W, scope: 'run:' + R, key: 'ephemeral', value: 'gone', expires_at: f.clock.value + 10,
    })
    f.clock.value += 20
    await assert.rejects(f.endpoints.get({ workspace_id: W, scope: 'run:' + R, key: 'ephemeral' }), (error) => error.status === 404)
    const listed = await f.endpoints.list({ workspace_id: W, scope: 'run:' + R })
    assert.equal(listed.items.some(item => item.key === 'ephemeral'), false)
    const stats = await f.endpoints.stats({ workspace_id: W })
    assert.equal(stats.total_entries, 4)
    assert.equal(stats.scopes.length, 2)
  } finally {
    f.db.close()
  }
})

test('remove honours revisions and missing entries fail closed', async () => {
  const f = await api()
  try {
    const made = await f.endpoints.put({ workspace_id: W, scope: 'run:' + R, key: 'plan', value: 'x' })
    await assert.rejects(f.endpoints.remove({ workspace_id: W, scope: 'run:' + R, key: 'plan', expected_revision: 99 }),
      (error) => error.status === 409)
    const removed = await f.endpoints.remove({ workspace_id: W, scope: 'run:' + R, key: 'plan', expected_revision: made.entry.revision })
    assert.equal(removed.removed.key, 'plan')
    await assert.rejects(f.endpoints.remove({ workspace_id: W, scope: 'run:' + R, key: 'plan' }), (error) => error.status === 404)
  } finally {
    f.db.close()
  }
})

test('invalid payloads, quotas and workspace isolation fail closed', async () => {
  const f = await api()
  try {
    await assert.rejects(f.endpoints.put({ workspace_id: W, scope: 'bad scope', key: 'k', value: 'x' }), (error) => error.status === 400)
    await assert.rejects(f.endpoints.put({ workspace_id: W, scope: 'run:' + R, key: 'k', value: 'x'.repeat(LIMITS.maxValueBytes + 1) }), (error) => error.status === 413)
    await assert.rejects(f.endpoints.put({ workspace_id: W, scope: 'run:' + R, key: 'k', value: 'x', expires_at: f.clock.value }), (error) => error.status === 400)
    await assert.rejects(f.endpoints.list({ workspace_id: W, scope: 'run:' + R, limit: 0 }), (error) => error.status === 400)
    const foreign = await api({ allowed: FOREIGN })
    try {
      await assert.rejects(foreign.endpoints.put({ workspace_id: W, scope: 'run:' + R, key: 'k', value: 'x' }), (error) => error.status === 404)
    } finally {
      foreign.db.close()
    }
  } finally {
    f.db.close()
  }
})

test('contract states the scratchpad boundary', async () => {
  const f = await api()
  try {
    const contract = await f.endpoints.contract()
    assert.equal(contract.schema, 'openteamily.agent-scratchpad.v1')
    assert.ok(contract.reuse.includes('DSH run/subagent identity'))
    assert.ok(contract.not_doing.includes('no agent execution'))
    assert.ok(contract.endpoints.includes('stats'))
  } finally {
    f.db.close()
  }
})
