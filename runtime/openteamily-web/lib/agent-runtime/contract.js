// OpenTeamily Agent Runtime Contract v1.
//
// DSH already emits the low-level execution events this contract consumes:
// turn/start, assistant/attempt, assistant/message, tool/call, tool/result,
// subagent/start, subagent/end, llm/retry-started, turn/end, plus the
// agent/assistant-stream frames used by the runtime bridge. Bot Social already
// owns the cross-user audit, policy, approval and webhook primitives.
//
// This module does not reimplement any of those engines. It defines the stable
// OpenTeamily envelope that later runtime features (trace, usage, stream,
// context, policy, evals) persist and expose. Keeping the envelope independent
// of DSH's raw event names is what lets the runtime layer evolve without
// forking the pinned upstream tree.
import { createHash } from 'node:crypto'

export const CONTRACT_VERSION = 1
export const SCHEMA = 'openteamily.agent-runtime.event.v1'

export const EVENT_TYPES = Object.freeze([
  'run.started',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'step.started',
  'step.completed',
  'step.failed',
  'step.cancelled',
  'step.retried',
  'assistant.attempt',
  'assistant.delta',
  'reasoning.delta',
  'assistant.message',
  'message.user',
  'tool.call',
  'tool.result',
  'subagent.started',
  'subagent.ended',
  'usage',
  'approval.required',
  'approval.resolved',
  'heartbeat',
  'runtime.event',
])

export const ACTOR_KINDS = Object.freeze(['agent', 'tool', 'subagent', 'system', 'human', 'model'])

export const LIMITS = Object.freeze({
  maxEventsPerCall: 500,
  maxEventBytes: 64 * 1024,
  maxDataBytes: 48 * 1024,
  maxString: 16 * 1024,
  maxArray: 200,
  maxKeys: 200,
  maxDepth: 8,
})

const RUN_ID = /^[0-9a-f]{32}$/
const EVENT_ID = /^otare_[0-9a-f]{32}$/
const SAFE_ID = /^[A-Za-z0-9._:/-]{0,128}$/
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const SECRET_KEY = /(?:^|[_-])(?:api[_-]?key|apikey|authorization|cookie|password|passwd|secret|token|access[_-]?key|private[_-]?key|client[_-]?secret|credential|session[_-]?key)(?:$|[_-])/i
const SECRET_VALUE = [
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/i,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bxox[abp]-[A-Za-z0-9-]{10,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/,
]

export class ContractError extends Error {
  constructor(message, code = 'agent-runtime/contract') {
    super(message)
    this.name = 'ContractError'
    this.code = code
    this.status = 400
  }
}

const refuse = (message, code) => { throw new ContractError(message, code) }
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const integer = (value) => Number.isSafeInteger(value) && value >= 0
const text = (value, maximum = 256) => typeof value === 'string' && value.length <= maximum && !CONTROL.test(value)
const nullableId = (value) => value === null || value === undefined || (typeof value === 'string' && SAFE_ID.test(value))
const atOf = (raw) => {
  for (const value of [raw?.time, raw?.at, raw?.timestamp, raw?.data?.time]) if (integer(value)) return value
  return 0
}
const turnOf = (data) => integer(data?.turn) ? String(data.turn) : (text(data?.turnId, 128) ? data.turnId : null)
const stepOf = (data) => integer(data?.step) ? data.step : (integer(data?.turn) ? data.turn : null)
const callIdOf = (data) => {
  for (const value of [data?.callId, data?.subCallId, data?.message?.toolCallId, data?.toolCallId]) {
    if (text(value, 128)) return value
  }
  return null
}
const subagentIdOf = (data) => {
  for (const value of [data?.childId, data?.id, data?.subagentId]) if (text(value, 128)) return value
  return null
}

export function stableEventId(runId, sequence, type, at) {
  return 'otare_' + createHash('sha256')
    .update([runId, sequence, type, at].join('\0'), 'utf8')
    .digest('hex').slice(0, 32)
}

function secretPath(path) {
  const last = String(path).split('.').at(-1)?.replace(/\[\d+\]$/, '') ?? ''
  return SECRET_KEY.test(last)
}

export function redactValue(value, path = '$', state = { redactions: [], depth: 0 }) {
  if (state.depth > LIMITS.maxDepth) return '[MaxDepth]'
  if (typeof value === 'string') {
    if (secretPath(path)) {
      state.redactions.push(path)
      return '[REDACTED]'
    }
    for (const pattern of SECRET_VALUE) {
      if (pattern.test(value)) {
        state.redactions.push(path)
        return '[REDACTED]'
      }
    }
    return value
  }
  if (Array.isArray(value)) {
    return value.slice(0, LIMITS.maxArray).map((item, index) =>
      redactValue(item, `${path}[${index}]`, { ...state, depth: state.depth + 1 }))
  }
  if (!isObject(value)) return value
  const entries = Object.entries(value).slice(0, LIMITS.maxKeys)
  const out = {}
  for (const [key, item] of entries) {
    if (SECRET_KEY.test(key)) {
      out[key] = '[REDACTED]'
      state.redactions.push(`${path}.${key}`)
      continue
    }
    out[key] = redactValue(item, `${path}.${key}`, { ...state, depth: state.depth + 1 })
  }
  return out
}

function bound(value, path = '$', state = { truncated: false }, depth = 0) {
  if (depth > LIMITS.maxDepth) {
    state.truncated = true
    return '[MaxDepth]'
  }
  if (typeof value === 'string' && value.length > LIMITS.maxString) {
    state.truncated = true
    return value.slice(0, LIMITS.maxString) + '…[truncated]'
  }
  if (Array.isArray(value)) {
    if (value.length > LIMITS.maxArray) state.truncated = true
    return value.slice(0, LIMITS.maxArray).map((item, index) =>
      bound(item, `${path}[${index}]`, state, depth + 1))
  }
  if (!isObject(value)) return value
  const entries = Object.entries(value)
  if (entries.length > LIMITS.maxKeys) state.truncated = true
  const out = {}
  for (const [key, item] of entries.slice(0, LIMITS.maxKeys)) {
    out[key] = bound(item, `${path}.${key}`, state, depth + 1)
  }
  return out
}

function bbox(value) {
  const redaction = { redactions: [], depth: 0 }
  const redacted = redactValue(value, '$', redaction)
  const state = { truncated: false }
  let data = bound(redacted, '$', state)
  let bytes = Buffer.byteLength(JSON.stringify(data), 'utf8')
  if (bytes > LIMITS.maxDataBytes) {
    state.truncated = true
    data = { truncated: true, bytes, preview: JSON.stringify(data).slice(0, LIMITS.maxDataBytes) }
    bytes = Buffer.byteLength(JSON.stringify(data), 'utf8')
  }
  return { data, redactions: redaction.redactions, truncated: state.truncated, bytes }
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text).join('')
}

function usageOf(value) {
  if (!value || typeof value !== 'object') return null
  const usage = {
    input: value.inputTokens ?? value.input ?? 0,
    cache_read: value.cacheReadTokens ?? value.cache_read ?? 0,
    cache_write: value.cacheWriteTokens ?? value.cache_write ?? 0,
    output: value.outputTokens ?? value.output ?? 0,
  }
  for (const key of Object.keys(usage)) if (!integer(usage[key])) usage[key] = 0
  if (text(value.provider, 128)) usage.provider = value.provider
  if (text(value.model, 128)) usage.model = value.model
  return usage
}

function usageChunk(stream) {
  if (!Array.isArray(stream)) return null
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (record?.type === 'chunk' && record.chunk?.type === 'usage') return record.chunk.usage
  }
  return null
}

function argumentsOf(value) {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}

function partial(type, raw, fields = {}) {
  return {
    type,
    at: atOf(raw),
    session_id: text(raw?.sessionId, 128) ? raw.sessionId : (text(raw?.session_id, 128) ? raw.session_id : null),
    turn_id: turnOf(raw?.data),
    step: stepOf(raw?.data),
    tool_call_id: callIdOf(raw?.data),
    subagent_id: subagentIdOf(raw?.data),
    actor: { kind: 'system' },
    data: raw?.data ?? {},
    ...fields,
  }
}

function mapDshEvent(raw) {
  if (!isObject(raw) || !text(raw.type, 80)) refuse('Each DSH event needs a type')
  const type = raw.type
  const data = isObject(raw.data) ? raw.data : {}
  switch (type) {
    case 'turn/start':
      return [partial('step.started', raw, { actor: { kind: 'agent' } })]
    case 'turn/end': {
      const reason = data.reason ?? data.error ?? null
      const aborted = reason?.kind === 'aborted' || data.aborted === true
      const failed = Boolean(data.error) || (reason?.kind !== undefined && reason.kind !== 'completed' && !aborted)
      const name = aborted ? 'step.cancelled' : failed ? 'step.failed' : 'step.completed'
      const usage = usageOf(data.usage) ?? usageOf(data.usageReport)
      return [partial(name, raw, { actor: { kind: 'agent' }, data: { reason, ...(usage ? { usage } : {}) } })]
    }
    case 'llm/retry-started':
      return [partial('step.retried', raw, { actor: { kind: 'model' }, data: {
        turn: data.turn ?? null, step: data.step ?? null, count: data.count ?? null,
      } })]
    case 'assistant/attempt':
      return [partial('assistant.attempt', raw, { actor: { kind: 'model' }, data: {
        attempt_id: text(data.attemptId, 128) ? data.attemptId : null,
        step: stepOf(data), turn: data.turn ?? null,
      } })]
    case 'assistant/message': {
      const usage = usageOf(data.usage) ?? usageOf(usageChunk(data.stream))
      const events = [partial('assistant.message', raw, { actor: { kind: 'agent' }, data: {
        text: textOf(data.message?.content),
        ...(text(data.attemptId, 128) ? { attempt_id: data.attemptId } : {}),
      } })]
      if (usage) events.push(partial('usage', raw, { actor: { kind: 'model' }, data: usage }))
      return events
    }
    case 'user/message': {
      const content = data.content ?? data.message?.content
      const events = [partial('message.user', raw, { actor: { kind: 'human' }, data: {
        text: textOf(content),
        ...(text(data.requestId, 128) ? { request_id: data.requestId } : {}),
      } })]
      return events
    }
    case 'tool/call':
      return [partial('tool.call', raw, { actor: { kind: 'tool', id: text(data.name, 128) ? data.name : undefined }, data: {
        tool: text(data.name, 128) ? data.name : 'unknown',
        arguments: argumentsOf(data.arguments),
      } })]
    case 'tool/ptc-dispatch-start':
      return [partial('tool.call', raw, { actor: { kind: 'tool', id: text(data.name, 128) ? data.name : undefined }, data: {
        tool: text(data.name, 128) ? data.name : 'unknown',
        arguments: argumentsOf(data.arguments ?? {}),
      } })]
    case 'tool/ptc-dispatch':
      return [partial('tool.result', raw, { actor: { kind: 'tool' }, data: {
        is_error: false, result: data.result ?? data,
      } })]
    case 'tool/result': {
      const message = data.message ?? {}
      return [partial('tool.result', raw, { actor: { kind: 'tool' }, data: {
        is_error: Boolean(message.isError ?? data.isError),
        result: message.content ?? data.result ?? message,
      } })]
    }
    case 'subagent/start':
    case 'subagent/catalog':
      return [partial('subagent.started', raw, { actor: { kind: 'subagent' }, data: {
        child_id: subagentIdOf(data),
        ...(text(data.label, 160) ? { label: data.label } : {}),
      } })]
    case 'subagent/end':
      return [partial('subagent.ended', raw, { actor: { kind: 'subagent' }, data: {
        child_id: subagentIdOf(data),
        stop_reason: text(data.stopReason, 160) ? data.stopReason : null,
        ...(typeof data.closing === 'string' ? { closing: data.closing } : {}),
      } })]
    case 'usage': {
      const usage = usageOf(data.usage ?? data)
      return usage ? [partial('usage', raw, { actor: { kind: 'model' }, data: usage })] : []
    }
    case 'approval/request':
    case 'approval.required':
      return [partial('approval.required', raw, { actor: { kind: 'system' }, data: {
        approval_id: data.approvalId ?? data.id ?? null,
        tool: data.tool ?? null,
        reason: data.reason ?? null,
        expires_at: data.expiresAt ?? data.expires_at ?? null,
      } })]
    case 'approval/decision':
    case 'approval.resolved':
      return [partial('approval.resolved', raw, { actor: { kind: 'human' }, data: {
        approval_id: data.approvalId ?? data.id ?? null,
        decision: data.decision ?? data.outcome ?? null,
      } })]
    case 'heartbeat':
      return [partial('heartbeat', raw, { actor: { kind: 'system' }, data: {} })]
    default:
      return [partial('runtime.event', raw, { actor: { kind: 'system' }, data: {
        dsh_type: type,
        payload: data,
      } })]
  }
}

function finalize(runId, sequence, item) {
  const type = EVENT_TYPES.includes(item.type) ? item.type : 'runtime.event'
  const at = integer(item.at) ? item.at : 0
  const actor = isObject(item.actor) && ACTOR_KINDS.includes(item.actor.kind)
    ? { kind: item.actor.kind, ...(text(item.actor.id, 128) ? { id: item.actor.id } : {}) }
    : { kind: 'system' }
  const boxed = bbox(item.data ?? {})
  return {
    schema: SCHEMA,
    version: CONTRACT_VERSION,
    event_id: stableEventId(runId, sequence, type, at),
    run_id: runId,
    sequence,
    type,
    at,
    session_id: text(item.session_id, 128) ? item.session_id : null,
    turn_id: nullableId(item.turn_id) ? item.turn_id : null,
    step: integer(item.step) ? item.step : null,
    tool_call_id: text(item.tool_call_id, 128) ? item.tool_call_id : null,
    subagent_id: text(item.subagent_id, 128) ? item.subagent_id : null,
    actor,
    data: boxed.data,
    redactions: [...new Set(boxed.redactions)].sort(),
    truncated: boxed.truncated,
  }
}

export function normalizeEvent(runId, raw, startSequence = 0) {
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) refuse('run_id must be 32 lowercase hex characters')
  if (!integer(startSequence)) refuse('sequence must be a non-negative integer')
  return mapDshEvent(raw).map((item, index) => finalize(runId, startSequence + index, item))
}

export function normalizeStreamFrame(runId, raw, startSequence = 0) {
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) refuse('run_id must be 32 lowercase hex characters')
  if (!integer(startSequence)) refuse('sequence must be a non-negative integer')
  const frame = raw?.frame
  if (!isObject(frame) || !text(frame.type, 40)) refuse('Each stream item needs a frame')
  const base = {
    session_id: raw?.session?.id ?? raw?.sessionId ?? raw?.session_id ?? raw?.agent?.session?.id ?? null,
    data: frame,
  }
  if (frame.type === 'start') {
    return [finalize(runId, startSequence, {
      ...base, type: 'assistant.attempt', at: atOf(raw), actor: { kind: 'model' },
      data: { attempt_id: frame.attemptId ?? null, step: frame.step ?? null, turn: frame.turn ?? null },
    })]
  }
  if (frame.type === 'chunk' && frame.chunk?.type === 'text-delta' && typeof frame.chunk.text === 'string') {
    return [finalize(runId, startSequence, {
      ...base, type: 'assistant.delta', at: atOf(raw), actor: { kind: 'agent' },
      data: { text: frame.chunk.text, attempt_id: frame.attemptId ?? null, step: frame.step ?? null },
    })]
  }
  if (frame.type === 'chunk' && frame.chunk?.type === 'reasoning-delta' && typeof frame.chunk.text === 'string') {
    return [finalize(runId, startSequence, {
      ...base, type: 'reasoning.delta', at: atOf(raw), actor: { kind: 'agent' },
      data: { text: frame.chunk.text, attempt_id: frame.attemptId ?? null, step: frame.step ?? null },
    })]
  }
  return [finalize(runId, startSequence, {
    ...base, type: 'runtime.event', at: atOf(raw), actor: { kind: 'system' },
    data: { dsh_type: 'agent/assistant-stream', frame },
  })]
}

export function normalizeEvents(payload) {
  if (!isObject(payload)) refuse('Provide a JSON object')
  const runId = payload.run_id
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) refuse('run_id must be 32 lowercase hex characters')
  if (!Array.isArray(payload.events) || !payload.events.length || payload.events.length > LIMITS.maxEventsPerCall) {
    refuse(`events must contain 1-${LIMITS.maxEventsPerCall} DSH events`)
  }
  const events = []
  let sequence = 0
  for (const raw of payload.events) {
    for (const event of normalizeEvent(runId, raw, sequence)) {
      validateEvent(event)
      events.push(event)
      sequence += 1
    }
  }
  return { schema: SCHEMA, version: CONTRACT_VERSION, run_id: runId, events, next_sequence: sequence }
}

export function normalizeStream(payload) {
  if (!isObject(payload)) refuse('Provide a JSON object')
  const runId = payload.run_id
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) refuse('run_id must be 32 lowercase hex characters')
  if (!Array.isArray(payload.frames) || !payload.frames.length || payload.frames.length > LIMITS.maxEventsPerCall) {
    refuse(`frames must contain 1-${LIMITS.maxEventsPerCall} stream items`)
  }
  const events = []
  let sequence = 0
  for (const raw of payload.frames) {
    for (const event of normalizeStreamFrame(runId, raw, sequence)) {
      validateEvent(event)
      events.push(event)
      sequence += 1
    }
  }
  return { schema: SCHEMA, version: CONTRACT_VERSION, run_id: runId, events, next_sequence: sequence }
}

export function validateEvent(event) {
  if (!isObject(event)) refuse('Event must be an object')
  if (event.schema !== SCHEMA) refuse('Unsupported event schema')
  if (event.version !== CONTRACT_VERSION) refuse('Unsupported event version')
  if (typeof event.run_id !== 'string' || !RUN_ID.test(event.run_id)) refuse('Invalid run_id')
  if (typeof event.event_id !== 'string' || !EVENT_ID.test(event.event_id)) refuse('Invalid event_id')
  if (!integer(event.sequence)) refuse('Invalid sequence')
  if (!EVENT_TYPES.includes(event.type)) refuse('Invalid event type')
  if (!integer(event.at)) refuse('Invalid event time')
  if (!nullableId(event.session_id)) refuse('Invalid session_id')
  if (!nullableId(event.turn_id)) refuse('Invalid turn_id')
  if (event.step !== null && !integer(event.step)) refuse('Invalid step')
  if (!nullableId(event.tool_call_id)) refuse('Invalid tool_call_id')
  if (!nullableId(event.subagent_id)) refuse('Invalid subagent_id')
  if (!isObject(event.actor) || !ACTOR_KINDS.includes(event.actor.kind)) refuse('Invalid actor')
  if (event.actor.id !== undefined && !text(event.actor.id, 128)) refuse('Invalid actor id')
  if (!isObject(event.data)) refuse('Event data must be an object')
  if (!Array.isArray(event.redactions) || event.redactions.length > LIMITS.maxKeys) refuse('Invalid redactions')
  if (typeof event.truncated !== 'boolean') refuse('Invalid truncated flag')
  if (Buffer.byteLength(JSON.stringify(event), 'utf8') > LIMITS.maxEventBytes) refuse('Event exceeds the size limit')
  const expected = stableEventId(event.run_id, event.sequence, event.type, event.at)
  if (event.event_id !== expected) refuse('event_id does not match the stable identity')
  return true
}

export function contractDescription() {
  return {
    schema: SCHEMA,
    version: CONTRACT_VERSION,
    event_types: [...EVENT_TYPES],
    actor_kinds: [...ACTOR_KINDS],
    limits: { ...LIMITS },
    redaction: {
      keys: 'api_key, authorization, cookie, password, secret, token, private_key, client_secret, credential, session_key',
      values: ['Bearer …', 'sk-…', 'ghp_…', 'xox…', 'AKIA…', 'private key blocks'],
    },
    reuse: {
      dsh: ['session/event', 'agent/assistant-stream', 'tool/call', 'tool/result', 'subagent/start', 'subagent/end', 'usage', 'permission', 'approval', 'compaction', 'resume'],
      bot_social: ['audit', 'policy', 'untrusted', 'approvals', 'presence', 'webhooks'],
    },
    new_in_contract: [
      'stable OpenTeamily event envelope',
      'DSH event normalization',
      'deterministic event identity',
      'bounded payloads',
      'secret redaction with recorded paths',
    ],
    not_in_contract: [
      'no tool/subagent/usage engine',
      'no persistence or routes yet',
      'no execution behavior change',
    ],
  }
}
