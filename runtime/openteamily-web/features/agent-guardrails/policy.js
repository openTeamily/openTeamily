// OpenTeamily agent guardrails v1: provenance/taint and tool-authorization
// decisions. This is not a DLP or prompt-injection detector; Bot Social already
// owns those. This module consumes provenance labels for DSH tool calls and
// decides allow / require_approval / deny.
import { createHash } from 'node:crypto'
import { refuse } from '../../featurekit/http.js'

export const POLICY_VERSION = 'openteamily.agent-guardrails.v1'
export const PROVENANCES = Object.freeze(['system', 'user', 'memory', 'artifact', 'meeting', 'mcp', 'web', 'subagent', 'tool', 'model'])
export const TRUST = Object.freeze({
  system: 'trusted', user: 'trusted',
  memory: 'semi', artifact: 'semi', meeting: 'semi',
  mcp: 'untrusted', web: 'untrusted', subagent: 'untrusted', tool: 'untrusted', model: 'untrusted',
})
export const RISKS = Object.freeze(['read', 'write', 'external', 'dangerous', 'unknown'])
export const SIDE_EFFECTS = Object.freeze(['read_only', 'write', 'external', 'unknown'])
export const DEFAULT_POLICY = Object.freeze({
  untrusted_external: 'require_approval',
  untrusted_write: 'require_approval',
  untrusted_dangerous: 'require_approval',
  untrusted_unknown: 'require_approval',
  secret_capabilities: 'deny',
  external_always_approval: true,
  dangerous_always_approval: true,
})
const POLICY_KEYS = new Set(Object.keys(DEFAULT_POLICY))
const SEVERITIES = new Set(['require_approval', 'deny'])
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const SECRET_CAPABILITY = /(?:^|[._:-])(?:secret|credential|password|token|api[_-]?key|private[_-]?key)(?:$|[._:-])/i

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value, maximum) => typeof value === 'string' && value.length <= maximum && !CONTROL.test(value)
const unique = values => [...new Set(values)]

function sourceView(value, index) {
  if (!isObject(value)) refuse(400, 'guardrail/invalid', `sources[${index}] must be an object`)
  const keys = new Set(['id', 'provenance', 'label'])
  const extra = Object.keys(value).filter(key => !keys.has(key))
  if (extra.length) refuse(400, 'guardrail/invalid', `Unknown source fields: ${extra.slice(0, 5).join(', ')}`)
  if (!PROVENANCES.includes(value.provenance)) {
    refuse(400, 'guardrail/invalid', `sources[${index}].provenance is invalid`)
  }
  const id = value.id ?? `source-${index}`
  if (!text(id, 128) || !id) refuse(400, 'guardrail/invalid', `sources[${index}].id is invalid`)
  if (value.label !== undefined && !text(value.label, 200)) {
    refuse(400, 'guardrail/invalid', `sources[${index}].label is invalid`)
  }
  return {
    id,
    provenance: value.provenance,
    trust: TRUST[value.provenance],
    ...(value.label !== undefined ? { label: value.label } : {}),
  }
}

export function classifySources(sources) {
  if (!Array.isArray(sources) || sources.length > 64) {
    refuse(400, 'guardrail/invalid', 'sources must be a list of at most 64 items')
  }
  const items = sources.map(sourceView)
  const ids = new Set()
  for (const item of items) {
    if (ids.has(item.id)) refuse(400, 'guardrail/invalid', `Duplicate source id: ${item.id}`)
    ids.add(item.id)
  }
  const untrusted = items.filter(item => item.trust === 'untrusted')
  const semi = items.filter(item => item.trust === 'semi')
  const trusted = items.filter(item => item.trust === 'trusted')
  return {
    sources: items,
    untrusted,
    semi,
    trusted,
    counts: { untrusted: untrusted.length, semi: semi.length, trusted: trusted.length },
    highest: untrusted.length ? 'untrusted' : semi.length ? 'semi' : 'trusted',
    tainted: untrusted.length > 0 || semi.length > 0,
  }
}

function toolView(value) {
  if (!isObject(value)) refuse(400, 'guardrail/invalid', 'tool must be an object')
  const keys = new Set(['name', 'risk', 'side_effect', 'capability'])
  const extra = Object.keys(value).filter(key => !keys.has(key))
  if (extra.length) refuse(400, 'guardrail/invalid', `Unknown tool fields: ${extra.slice(0, 5).join(', ')}`)
  if (typeof value.name !== 'string' || !TOOL_NAME.test(value.name)) refuse(400, 'guardrail/invalid', 'tool.name is invalid')
  const risk = value.risk ?? 'unknown'
  const sideEffect = value.side_effect ?? 'unknown'
  if (!RISKS.includes(risk)) refuse(400, 'guardrail/invalid', 'tool.risk is invalid')
  if (!SIDE_EFFECTS.includes(sideEffect)) refuse(400, 'guardrail/invalid', 'tool.side_effect is invalid')
  if (value.capability !== undefined && !text(value.capability, 120)) {
    refuse(400, 'guardrail/invalid', 'tool.capability is invalid')
  }
  return {
    name: value.name,
    risk,
    side_effect: sideEffect,
    ...(value.capability !== undefined ? { capability: value.capability } : {}),
  }
}

function policyView(value) {
  if (value === undefined) return { ...DEFAULT_POLICY }
  if (!isObject(value)) refuse(400, 'guardrail/invalid', 'policy must be an object')
  const extra = Object.keys(value).filter(key => !POLICY_KEYS.has(key))
  if (extra.length) refuse(400, 'guardrail/invalid', `Unknown policy fields: ${extra.slice(0, 5).join(', ')}`)
  const policy = { ...DEFAULT_POLICY, ...value }
  for (const key of ['untrusted_external', 'untrusted_write', 'untrusted_dangerous', 'untrusted_unknown']) {
    if (!SEVERITIES.has(policy[key])) refuse(400, 'guardrail/invalid', `policy.${key} must be require_approval or deny`)
  }
  if (policy.secret_capabilities !== 'deny') refuse(400, 'guardrail/invalid', 'policy.secret_capabilities must be deny')
  for (const key of ['external_always_approval', 'dangerous_always_approval']) {
    if (typeof policy[key] !== 'boolean') refuse(400, 'guardrail/invalid', `policy.${key} must be boolean`)
  }
  return policy
}

function approvalView(value) {
  if (value === undefined) return { granted: false, scope: null }
  if (!isObject(value)) refuse(400, 'guardrail/invalid', 'approval must be an object')
  const extra = Object.keys(value).filter(key => !['granted', 'scope'].includes(key))
  if (extra.length) refuse(400, 'guardrail/invalid', `Unknown approval fields: ${extra.slice(0, 5).join(', ')}`)
  if (typeof value.granted !== 'boolean') refuse(400, 'guardrail/invalid', 'approval.granted must be boolean')
  const scope = value.scope ?? null
  if (scope !== null && !['external', 'write', 'dangerous', 'unknown', '*'].includes(scope)) {
    refuse(400, 'guardrail/invalid', 'approval.scope is invalid')
  }
  return { granted: value.granted, scope }
}

const scopeMatches = (scope, risk) => scope === '*' || scope === null || scope === risk

function decide(taint, tool, policy, userIntent, approval) {
  const reasons = []
  if (taint.untrusted.length) reasons.push('taint:untrusted')
  else if (taint.semi.length) reasons.push('taint:semi')
  if (taint.sources.some(source => source.provenance === 'mcp')) reasons.push('source:mcp')
  if (taint.sources.some(source => source.provenance === 'web')) reasons.push('source:web')
  const secret = tool.capability !== undefined && SECRET_CAPABILITY.test(tool.capability)
  if (secret) return { decision: 'deny', reasons: unique([...reasons, 'capability:secret']) }

  const approved = approval.granted && scopeMatches(approval.scope, tool.risk)
  const fromPolicy = (decision, reason) => {
    if (decision === 'deny') return { decision: 'deny', reasons: unique([...reasons, reason]) }
    if (decision === 'require_approval') {
      return approved
        ? { decision: 'allow', reasons: unique([...reasons, reason, 'approval:granted']) }
        : { decision: 'require_approval', reasons: unique([...reasons, reason]) }
    }
    return { decision: 'allow', reasons: unique([...reasons, reason]) }
  }

  if (tool.risk === 'read' && tool.side_effect === 'read_only') {
    return { decision: 'allow', reasons: unique([...reasons, 'tool:read_only']) }
  }
  if (tool.risk === 'external' || tool.side_effect === 'external') {
    const taintedExternal = taint.highest !== 'trusted'
    if (taintedExternal) reasons.push('tool:external')
    const policyDecision = taintedExternal
      ? policy.untrusted_external
      : policy.external_always_approval ? 'require_approval' : 'allow'
    return fromPolicy(policyDecision, taintedExternal ? 'policy:untrusted_external' : 'tool:external')
  }
  if (tool.risk === 'dangerous') {
    const taintedDangerous = taint.highest !== 'trusted'
    if (taintedDangerous) reasons.push('tool:dangerous')
    const policyDecision = taintedDangerous
      ? policy.untrusted_dangerous
      : policy.dangerous_always_approval ? 'require_approval' : 'allow'
    return fromPolicy(policyDecision, taintedDangerous ? 'policy:untrusted_dangerous' : 'tool:dangerous')
  }
  if (tool.risk === 'write') {
    return taint.highest === 'trusted'
      ? { decision: 'allow', reasons: unique([...reasons, 'tool:write']) }
      : fromPolicy(policy.untrusted_write, 'policy:untrusted_write')
  }
  if (taint.highest !== 'trusted') return fromPolicy(policy.untrusted_unknown, 'policy:untrusted_unknown')
  if (userIntent) return { decision: 'allow', reasons: unique([...reasons, 'intent:user']) }
  return approved
    ? { decision: 'allow', reasons: unique([...reasons, 'tool:unknown', 'approval:granted']) }
    : { decision: 'require_approval', reasons: unique([...reasons, 'tool:unknown']) }
}

export function evaluateGuardrail(payload) {
  if (!isObject(payload)) refuse(400, 'guardrail/invalid', 'Provide a JSON object')
  const taint = classifySources(payload.sources ?? [])
  const tool = toolView(payload.tool)
  const policy = policyView(payload.policy)
  const approval = approvalView(payload.approval)
  if (payload.user_intent !== undefined && typeof payload.user_intent !== 'boolean') {
    refuse(400, 'guardrail/invalid', 'user_intent must be boolean')
  }
  const userIntent = payload.user_intent === true
  const result = decide(taint, tool, policy, userIntent, approval)
  const fingerprint = createHash('sha256').update(JSON.stringify({
    sources: taint.sources, tool, policy, user_intent: userIntent, approval,
  }), 'utf8').digest('hex')
  return {
    policy_version: POLICY_VERSION,
    decision: result.decision,
    reasons: result.reasons,
    taint,
    tool,
    policy,
    approval,
    user_intent: userIntent,
    decision_hash: fingerprint,
  }
}

export function contractDescription() {
  return {
    schema: POLICY_VERSION,
    version: 1,
    provenances: [...PROVENANCES],
    trust: { ...TRUST },
    risks: [...RISKS],
    side_effects: [...SIDE_EFFECTS],
    default_policy: { ...DEFAULT_POLICY },
    decisions: ['allow', 'require_approval', 'deny'],
    reuse: ['Bot Social policy.ts / untrusted.ts concepts', 'DSH tool risk/permission metadata', 'agent-tool-registry risk/side_effect shape'],
    new_in_this_feature: ['provenance/taint summary', 'tool-authorization decision', 'approval scope matching', 'deterministic decision hash'],
    not_doing: ['no DLP or injection detector', 'no tool execution', 'no approval transport', 'no model call', 'no persistence or UI'],
  }
}
