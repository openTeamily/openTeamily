import assert from 'node:assert/strict'
import test from 'node:test'
import feature from '../features/agent-runtime-contract/index.js'
import {
  CONTRACT_VERSION, EVENT_TYPES, LIMITS, SCHEMA, ContractError,
  contractDescription, normalizeEvent, normalizeEvents, normalizeStream, validateEvent,
} from '../lib/agent-runtime/contract.js'

const RUN = 'a'.repeat(32)
const raw = (type, data = {}, extra = {}) => ({ type, time: 1760000000000, sessionId: 'session-1', data, ...extra })

test('contract v1 describes its schema, types and reuse boundaries', () => {
  const contract = contractDescription()
  assert.equal(contract.schema, SCHEMA)
  assert.equal(contract.version, CONTRACT_VERSION)
  assert.equal(contract.version, 1)
  assert.deepEqual(contract.event_types, [...EVENT_TYPES])
  assert.equal(contract.limits.maxEventsPerCall, LIMITS.maxEventsPerCall)
  assert.match(contract.reuse.dsh.join(' '), /tool\/call/)
  assert.match(contract.reuse.bot_social.join(' '), /policy/)
  assert.match(contract.not_in_contract.join(' '), /no tool\/subagent\/usage engine/)
})

test('turn, tool and subagent events normalize without copying DSH engines', () => {
  const events = normalizeEvents({ run_id: RUN, events: [
    raw('turn/start', { turn: 3, step: 1 }),
    raw('tool/call', { turn: 3, step: 1, callId: 'call-1', name: 'read_file', arguments: '{"path":"/tmp/x"}' }),
    raw('tool/result', { message: { toolCallId: 'call-1', isError: false, content: [{ type: 'text', text: 'ok' }] } }),
    raw('subagent/start', { childId: 'child-1', label: 'review' }),
    raw('subagent/end', { childId: 'child-1', stopReason: 'completed' }),
    raw('turn/end', { turn: 3, reason: { kind: 'completed' } }),
  ] })
  assert.deepEqual(events.events.map((event) => event.type), [
    'step.started', 'tool.call', 'tool.result', 'subagent.started', 'subagent.ended', 'step.completed',
  ])
  const tool = events.events[1]
  assert.equal(tool.tool_call_id, 'call-1')
  assert.deepEqual(tool.data.arguments, { path: '/tmp/x' })
  assert.equal(tool.actor.kind, 'tool')
  assert.equal(tool.actor.id, 'read_file')
  const result = events.events[2]
  assert.equal(result.tool_call_id, 'call-1')
  assert.equal(result.data.is_error, false)
  const child = events.events[3]
  assert.equal(child.subagent_id, 'child-1')
  assert.equal(child.data.label, 'review')
  assert.equal(events.next_sequence, 6)
})

test('turn endings preserve completed, failed and cancelled states', () => {
  const completed = normalizeEvent(RUN, raw('turn/end', { turn: 1, reason: { kind: 'completed' } }))[0]
  const aborted = normalizeEvent(RUN, raw('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } }))[0]
  const failed = normalizeEvent(RUN, raw('turn/end', { turn: 3, error: { code: 'boom' } }))[0]
  assert.equal(completed.type, 'step.completed')
  assert.equal(aborted.type, 'step.cancelled')
  assert.equal(failed.type, 'step.failed')
  assert.equal(failed.turn_id, '3')
})

test('assistant messages add usage and stream frames stay ordered', () => {
  const message = normalizeEvent(RUN, raw('assistant/message', {
    turn: 1, step: 2, message: { content: [{ type: 'text', text: 'hello' }] },
    usage: { inputTokens: 10, cacheReadTokens: 2, cacheWriteTokens: 0, outputTokens: 4 },
  }))
  assert.deepEqual(message.map((event) => event.type), ['assistant.message', 'usage'])
  assert.equal(message[0].data.text, 'hello')
  assert.equal(message[1].data.input, 10)
  assert.equal(message[1].data.output, 4)

  const stream = normalizeStream({ run_id: RUN, frames: [
    { time: 1, agent: { session: { id: 'session-1' } }, frame: { type: 'start', turn: 1, step: 1, attemptId: 'a-1' } },
    { time: 2, agent: { session: { id: 'session-1' } }, frame: { type: 'chunk', turn: 1, step: 1, attemptId: 'a-1', chunk: { type: 'reasoning-delta', text: 'think' } } },
    { time: 3, agent: { session: { id: 'session-1' } }, frame: { type: 'chunk', turn: 1, step: 1, attemptId: 'a-1', chunk: { type: 'text-delta', text: 'say' } } },
    { time: 4, agent: { session: { id: 'session-1' } }, frame: { type: 'end', turn: 1, step: 1, attemptId: 'a-1' } },
  ] })
  assert.deepEqual(stream.events.map((event) => event.type), [
    'assistant.attempt', 'reasoning.delta', 'assistant.delta', 'runtime.event',
  ])
  assert.equal(stream.events[0].data.attempt_id, 'a-1')
  assert.equal(stream.events[1].data.text, 'think')
  assert.equal(stream.events[2].data.text, 'say')
  assert.equal(stream.events[2].session_id, 'session-1')
})

test('redaction records paths and never mutates the DSH input', () => {
  const input = raw('tool/call', {
    callId: 'call-secret', name: 'http',
    arguments: { api_key: 'sk-live-secret', path: '/tmp/x' },
  })
  const before = JSON.stringify(input)
  const [event] = normalizeEvent(RUN, input)
  assert.equal(JSON.stringify(input), before)
  assert.equal(event.data.arguments.api_key, '[REDACTED]')
  assert.equal(event.data.arguments.path, '/tmp/x')
  assert.ok(event.redactions.includes('$.arguments.api_key'))

  const [result] = normalizeEvent(RUN, raw('tool/result', {
    message: { toolCallId: 'call-2', content: [{ type: 'text', text: 'Authorization: Bearer abc.def' }] },
  }))
  assert.equal(JSON.stringify(result.data).includes('abc.def'), false)
  assert.ok(result.redactions.some((path) => path.includes('result[0].text')))
})

test('bounds truncate large values and unknown DSH events remain visible', () => {
  const [large] = normalizeEvent(RUN, raw('tool/result', {
    message: { toolCallId: 'call-3', content: [{ type: 'text', text: 'x'.repeat(LIMITS.maxString + 1) }] },
  }))
  assert.equal(large.truncated, true)
  assert.match(large.data.result[0].text, /\[truncated\]$/)

  const [unknown] = normalizeEvent(RUN, raw('agent/unknown-event', { a: 1 }))
  assert.equal(unknown.type, 'runtime.event')
  assert.equal(unknown.data.dsh_type, 'agent/unknown-event')
  assert.deepEqual(unknown.data.payload, { a: 1 })
})

test('event identity is deterministic and stable per sequence', () => {
  const first = normalizeEvent(RUN, raw('heartbeat'), 7)[0]
  const again = normalizeEvent(RUN, raw('heartbeat'), 7)[0]
  const next = normalizeEvent(RUN, raw('heartbeat'), 8)[0]
  const otherRun = normalizeEvent('b'.repeat(32), raw('heartbeat'), 7)[0]
  assert.equal(first.event_id, again.event_id)
  assert.notEqual(first.event_id, next.event_id)
  assert.notEqual(first.event_id, otherRun.event_id)
  assert.equal(validateEvent(first), true)
})

test('invalid envelopes fail closed', () => {
  const event = normalizeEvent(RUN, raw('heartbeat'))[0]
  assert.throws(() => validateEvent({ ...event, event_id: 'otare_' + '0'.repeat(32) }), ContractError)
  assert.throws(() => validateEvent({ ...event, type: 'not.real' }), ContractError)
  assert.throws(() => normalizeEvents({ run_id: 'short', events: [raw('heartbeat')] }), ContractError)
  assert.throws(() => normalizeEvents({ run_id: RUN, events: [] }), ContractError)
  assert.throws(() => normalizeEvents({ run_id: RUN, events: Array.from({ length: LIMITS.maxEventsPerCall + 1 }, () => raw('heartbeat')) }), ContractError)
})

test('the stateless feature exposes contract, normalize and stream endpoints', async () => {
  const api = feature({})
  assert.equal((await api.endpoints.contract()).version, CONTRACT_VERSION)
  const normalized = await api.endpoints.normalize({ run_id: RUN, events: [raw('heartbeat')] })
  assert.equal(normalized.events[0].type, 'heartbeat')
  const stream = await api.endpoints.normalizeStream({ run_id: RUN, frames: [
    { agent: { session: { id: 'session-2' } }, frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'hi' }, attemptId: 'a-2', step: 1 } },
  ] })
  assert.equal(stream.events[0].type, 'assistant.delta')
  assert.equal(stream.events[0].data.text, 'hi')
})
