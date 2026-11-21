// Always-on agent rule/event/run core inside this user's DS-Bot (#390): rules
// match persisted events under cooldowns and daily budgets, runs are queued,
// leased, completed or failed, and one bounded message can be recorded per run.
// No LLM call, no container, no delivery: this is scheduling and matching only.
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { boot, volume } from './helpers.js'
import { openStore } from '../featurekit/store.js'

// The registry functions take an explicit clock, so the time-travel cases call
// them directly; the endpoint cases call the feature the way a page will.
const registry = () => import('../features/proactive/registry.js')

const NOW = 1800000000
const call = (bot, op, payload) => bot.endpoint(`proactive/${op}`, payload)
const value = async (bot, op, payload) => {
  const result = await call(bot, op, payload)
  assert.equal(result.ok, true, JSON.stringify(result.error))
  return result.value
}
const refused = async (bot, op, payload, code) => {
  const result = await call(bot, op, payload)
  assert.equal(result.ok, false, `expected ${op} to be refused`)
  assert.equal(result.error.code, code, JSON.stringify(result.error))
  return result.error
}
const rule = (changes = {}) => ({ name: 'Watch', event_kind: 'message', cooldown_seconds: 0, daily_budget: 100, ...changes })
const featureStore = (bot) => openStore(join(bot.vol.data, 'openteamily', 'features', 'proactive', 'proactive.sqlite3'))

test('the proactive core loads in this DS-Bot and keeps its own feature directory', async () => {
  const bot = await boot()
  assert.ok(bot.features.loaded.includes('proactive'), JSON.stringify(bot.features.failed))
  assert.ok(existsSync(join(bot.vol.data, 'openteamily', 'features', 'proactive', 'proactive.sqlite3')))
})

test('a rule is saved, updated in place and removed, and the payload cannot name another workspace', async () => {
  const bot = await boot()
  const created = (await value(bot, 'save-rule', { rule: rule({ workspace_id: 'another-workspace' }) })).rule
  assert.equal(created.owner_id, 'owner')
  assert.equal(created.enabled, true)

  const updated = (await value(bot, 'save-rule', { rule: rule({ id: created.id, name: 'After', enabled: false }) })).rule
  assert.equal(updated.id, created.id)
  assert.equal(updated.name, 'After')
  assert.equal(updated.enabled, false)
  assert.ok(updated.created <= updated.updated)

  assert.deepEqual((await value(bot, 'rules', {})).items.map((item) => item.name), ['After'])

  const second = (await value(bot, 'save-rule', { rule: rule({ id: created.id, name: 'Again', enabled: true }) })).rule
  assert.equal(second.id, created.id)
  assert.equal((await value(bot, 'remove-rule', { id: created.id })).removed, true)
  assert.equal((await value(bot, 'remove-rule', { id: created.id })).removed, false)
  assert.deepEqual((await value(bot, 'rules', {})).items, [])

  await refused(bot, 'save-rule', { rule: rule({ name: 'n'.repeat(81) }) }, 'proactive/invalid')
  await refused(bot, 'save-rule', { rule: rule({ cooldown_seconds: -1 }) }, 'proactive/invalid')
  await refused(bot, 'save-rule', { rule: rule({ daily_budget: 10001 }) }, 'proactive/invalid')
  await refused(bot, 'save-rule', { rule: rule({ enabled: 'yes' }) }, 'proactive/invalid')
})

test('events dedupe per dedupe_key and keep the first payload', async () => {
  const bot = await boot()
  const first = await value(bot, 'record-event', {
    kind: 'message', source_type: 'conversation', source_id: 'conv-1', payload: { text: 'first' }, dedupe_key: 'd1',
  })
  assert.equal(first.event.duplicate, false)
  const replay = await value(bot, 'record-event', {
    kind: 'message', source_type: 'conversation', source_id: 'conv-1', payload: { text: 'changed' }, dedupe_key: 'd1',
  })
  assert.equal(replay.event.id, first.event.id)
  assert.equal(replay.event.duplicate, true)
  const other = await value(bot, 'record-event', {
    kind: 'message', source_type: 'conversation', source_id: 'conv-1', payload: {}, dedupe_key: 'd2',
  })
  assert.notEqual(other.event.id, first.event.id)

  const store = featureStore(bot)
  try {
    assert.equal(store.get('SELECT COUNT(*) AS n FROM proactive_events').n, 2)
    assert.match(store.get('SELECT payload FROM proactive_events WHERE id=?', first.event.id).payload, /first/)
  } finally {
    store.close()
  }

  await refused(bot, 'record-event', {
    kind: 'message', source_type: 'conversation', source_id: 'conv-1', payload: { text: 'x'.repeat(7000) }, dedupe_key: 'big',
  }, 'proactive/invalid')
  await refused(bot, 'record-event', { kind: '', source_type: 'conversation', source_id: 'c', dedupe_key: 'k' }, 'proactive/invalid')
})

test('evaluation matches kind and optional scope, and leaves unmatched events for a later rule', async () => {
  const bot = await boot()
  const all = (await value(bot, 'save-rule', { rule: rule() })).rule
  const conversation = (await value(bot, 'save-rule', {
    rule: rule({ name: 'Conversation', source_type: 'conversation', conversation_id: 'conv-1' }),
  })).rule
  const agent = (await value(bot, 'save-rule', { rule: rule({ name: 'Agent', agent_id: 'agent-1' }) })).rule
  const disabled = (await value(bot, 'save-rule', { rule: rule({ name: 'Disabled', enabled: false }) })).rule

  const one = (await value(bot, 'record-event', {
    kind: 'message', source_type: 'conversation', source_id: 'conv-1',
    payload: { conversation_id: 'conv-1', agent_id: 'agent-1' }, dedupe_key: 'e1',
  })).event.id
  const two = (await value(bot, 'record-event', {
    kind: 'message', source_type: 'conversation', source_id: 'conv-2', payload: { conversation_id: 'conv-2' }, dedupe_key: 'e2',
  })).event.id
  const ignored = (await value(bot, 'record-event', {
    kind: 'other', source_type: 'conversation', source_id: 'conv-1', payload: {}, dedupe_key: 'e3',
  })).event.id

  const runs = (await value(bot, 'evaluate', { budget: 10 })).runs
  const pairs = new Set(runs.map((run) => `${run.rule_id}:${run.event_id}`))
  assert.equal(runs.length, 4)
  for (const pair of [`${all.id}:${one}`, `${all.id}:${two}`, `${conversation.id}:${one}`, `${agent.id}:${one}`]) {
    assert.ok(pairs.has(pair), pair)
  }
  assert.ok(!pairs.has(`${disabled.id}:${one}`))

  const store = featureStore(bot)
  try {
    assert.equal(store.get('SELECT consumed FROM proactive_events WHERE id=?', ignored).consumed, 0)
  } finally {
    store.close()
  }

  const later = (await value(bot, 'save-rule', { rule: rule({ name: 'Other', event_kind: 'other' }) })).rule
  const next = (await value(bot, 'evaluate', {})).runs
  assert.deepEqual(next.map((run) => [run.rule_id, run.event_id]), [[later.id, ignored]])
  assert.equal((await value(bot, 'evaluate', {})).runs.length, 0)
})

test('cooldown holds an event and the daily budget resets on the next UTC day', async () => {
  const { evaluate, recordEvent, saveRule } = await registry()
  const bot = await boot()
  const store = featureStore(bot)
  try {
    const cooled = saveRule(store, 'owner', rule({ cooldown_seconds: 3600 }), NOW)
    const first = recordEvent(store, 'owner', {
      kind: 'message', source_type: 'conversation', source_id: 'conv-1', payload: {}, dedupe_key: 'c1',
    }, NOW).id
    const second = recordEvent(store, 'owner', {
      kind: 'message', source_type: 'conversation', source_id: 'conv-1', payload: {}, dedupe_key: 'c2',
    }, NOW + 10).id
    assert.equal(evaluate(store, 'owner', NOW).length, 1)
    assert.deepEqual(evaluate(store, 'owner', NOW + 10), [])
    assert.equal(store.get('SELECT consumed FROM proactive_events WHERE id=?', second).consumed, 0)
    const released = evaluate(store, 'owner', NOW + 3600)
    assert.deepEqual(released.map((run) => [run.rule_id, run.event_id]), [[cooled.id, second]])
    assert.equal(store.get('SELECT consumed FROM proactive_events WHERE id=?', second).consumed, 1)
    assert.equal(store.get('SELECT COUNT(*) AS n FROM proactive_runs').n, 2)
    assert.ok(first)

    saveRule(store, 'owner', rule({ id: cooled.id, name: 'Cooled', cooldown_seconds: 3600, enabled: false }), NOW + 5)
    const budgeted = saveRule(store, 'owner', rule({ name: 'Budget', daily_budget: 2 }), NOW)
    for (let index = 0; index < 3; index += 1) {
      recordEvent(store, 'owner', {
        kind: 'message', source_type: 'conversation', source_id: 'conv-9', payload: {}, dedupe_key: `b${index}`,
      }, NOW + index)
    }
    assert.equal(evaluate(store, 'owner', NOW + 2, 10).length, 2)
    assert.deepEqual(evaluate(store, 'owner', NOW + 3), [])
    const held = store.get('SELECT COUNT(*) AS n FROM proactive_events WHERE consumed=0').n
    assert.equal(held, 1)
    assert.equal(evaluate(store, 'owner', NOW + 86400).length, 1)
    assert.equal(store.get('SELECT COUNT(*) AS n FROM proactive_runs').n, 5)
    assert.ok(budgeted)
  } finally {
    store.close()
  }
})

test('claiming leases a run, blocks a second claim before expiry and retries the attempt after it', async () => {
  const { claimRuns, evaluate, recordEvent, saveRule } = await registry()
  const bot = await boot()
  const store = featureStore(bot)
  try {
    const saved = saveRule(store, 'owner', rule(), NOW)
    const event = recordEvent(store, 'owner', {
      kind: 'message', source_type: 'conversation', source_id: 'conv-1', payload: {}, dedupe_key: 'lease',
    }, NOW).id
    recordEvent(store, 'owner', {
      kind: 'message', source_type: 'conversation', source_id: 'conv-1', payload: {}, dedupe_key: 'lease-2',
    }, NOW)
    const runs = evaluate(store, 'owner', NOW, 1)
    assert.equal(runs.length, 1)
    assert.equal(runs[0].rule_id, saved.id)
    assert.ok(event)

    const claimed = claimRuns(store, 'owner', NOW, 10, 60)
    assert.equal(claimed.length, 1)
    assert.equal(claimed[0].status, 'claimed')
    assert.equal(claimed[0].attempts, 1)
    assert.equal(claimed[0].claim_token, undefined)
    assert.deepEqual(claimRuns(store, 'owner', NOW + 59, 10, 60), [])
    const expired = claimRuns(store, 'owner', NOW + 61, 10, 60)
    assert.deepEqual(expired.map((run) => [run.id, run.attempts]), [[claimed[0].id, 2]])

    assert.throws(() => claimRuns(store, 'owner', NOW, 0, 60), /limit/)
    assert.throws(() => claimRuns(store, 'owner', NOW, 10, 0), /lease_seconds/)
  } finally {
    store.close()
  }
})

test('completion is idempotent, a retryable failure requeues and a fatal one finishes', async () => {
  const { claimRuns, completeRun, evaluate, failRun, recordEvent, saveRule } = await registry()
  const bot = await boot()
  const store = featureStore(bot)
  try {
    const saved = saveRule(store, 'owner', rule(), NOW)
    const queued = (key) => recordEvent(store, 'owner', {
      kind: 'message', source_type: 'conversation', source_id: 'conv-1', payload: {}, dedupe_key: key,
    }, NOW).id
    const firstEvent = queued('done')
    evaluate(store, 'owner', NOW)
    const run = store.get('SELECT * FROM proactive_runs WHERE event_id=?', firstEvent)
    claimRuns(store, 'owner', NOW, 10, 60)
    const completed = completeRun(store, 'owner', run.id, 'succeeded', { text: 'ok' }, NOW + 1)
    assert.equal(completed.status, 'succeeded')
    assert.deepEqual(completed.result, { text: 'ok' })
    assert.equal(completed.finished, NOW + 1)
    assert.equal(completed.lease_until, null)
    assert.deepEqual(completeRun(store, 'owner', run.id, 'failed', { text: 'later' }, NOW + 2), completed)
    assert.equal(completeRun(store, 'owner', 'no-such-run', 'succeeded', {}, NOW), null)

    const retryEvent = queued('retry')
    evaluate(store, 'owner', NOW)
    const retryRun = store.get('SELECT * FROM proactive_runs WHERE event_id=?', retryEvent)
    claimRuns(store, 'owner', NOW, 10, 60)
    const failed = failRun(store, 'owner', retryRun.id, 'timeout', NOW + 2, true)
    assert.equal(failed.status, 'queued')
    assert.equal(failed.error, 'timeout')
    assert.equal(failed.finished, null)
    claimRuns(store, 'owner', NOW + 2, 10, 60)
    const fatal = failRun(store, 'owner', retryRun.id, 'fatal', NOW + 3, false)
    assert.equal(fatal.status, 'failed')
    assert.equal(fatal.error, 'fatal')
    assert.equal(fatal.finished, NOW + 3)
    assert.deepEqual(failRun(store, 'owner', retryRun.id, 'ignored', NOW + 4, false), fatal)
    assert.ok(saved)
  } finally {
    store.close()
  }
})

test('one bounded message per run and keyset pagination over this account\'s messages', async () => {
  const { evaluate, recordEvent, recordMessage, saveRule } = await registry()
  const bot = await boot()
  const store = featureStore(bot)
  try {
    saveRule(store, 'owner', rule(), NOW)
    const events = []
    for (let index = 0; index < 3; index += 1) {
      events.push(recordEvent(store, 'owner', {
        kind: 'message', source_type: 'conversation', source_id: 'conv-1', payload: {}, dedupe_key: `page-${index}`,
      }, NOW).id)
    }
    assert.equal(evaluate(store, 'owner', NOW).length, 3)
    const runIds = events.map((event) => store.get('SELECT id FROM proactive_runs WHERE event_id=?', event).id)
    runIds.forEach((runId, index) => {
      recordMessage(store, 'owner', { run_id: runId, conversation_id: 'conv-1', body: `body-${index}` }, NOW + index)
    })
    const replay = recordMessage(store, 'owner', { run_id: runIds[0], conversation_id: 'conv-1', body: 'different' }, NOW + 9)
    assert.equal(replay.body, 'body-0')
    assert.equal(store.get('SELECT COUNT(*) AS n FROM proactive_messages').n, 3)

    const endpoints = (await value(bot, 'messages', { limit: 2 })).items
    assert.deepEqual(endpoints.map((item) => item.body), ['body-0', 'body-1'])
    const rest = (await value(bot, 'messages', { limit: 2, cursor: endpoints[1].id })).items
    assert.deepEqual(rest.map((item) => item.body), ['body-2'])

    await refused(bot, 'messages', { limit: 101 }, 'proactive/invalid')
    await refused(bot, 'messages', { limit: 2, cursor: 'no-such-message' }, 'proactive/invalid')
    await refused(bot, 'record-message', { run_id: 'no-such-run', conversation_id: 'conv-1', body: 'x' }, 'proactive/not-found')
    await refused(bot, 'record-message', { run_id: runIds[0], conversation_id: 'conv-1', body: 'x'.repeat(4001) }, 'proactive/invalid')
  } finally {
    store.close()
  }

  // A second account is a second volume: no rules, events, runs or messages cross over.
  const other = await boot(volume())
  assert.deepEqual((await value(other, 'rules', {})).items, [])
  assert.deepEqual((await value(other, 'messages', {})).items, [])
})
