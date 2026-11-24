import assert from 'node:assert/strict'
import test from 'node:test'
import feature from '../features/agent-guardrails/index.js'
import { classifySources, evaluateGuardrail, DEFAULT_POLICY, POLICY_VERSION } from '../features/agent-guardrails/policy.js'

const W = 'a'.repeat(32)
const FOREIGN = 'c'.repeat(32)
const source = (provenance, id = provenance) => ({ id, provenance })

function evaluator(allowed = W) {
  return feature({
    call: async (name) => {
      if (name === 'agents/personal-binding') return { workspace_id: allowed }
      if (name === 'teams/activeWorkspaces') return [{ id: allowed }]
      throw new Error('Unexpected endpoint ' + name)
    },
  })
}

test('provenance classification separates trusted, semi and untrusted sources', () => {
  const result = classifySources([
    source('system'), source('user'), source('memory'), source('artifact'), source('mcp'), source('web'),
  ])
  assert.equal(result.highest, 'untrusted')
  assert.equal(result.tainted, true)
  assert.deepEqual(result.counts, { untrusted: 2, semi: 2, trusted: 2 })
  assert.deepEqual(result.untrusted.map(item => item.provenance), ['mcp', 'web'])
  assert.equal(result.semi.every(item => item.trust === 'semi'), true)
})

test('trusted read-only tools are allowed', () => {
  const result = evaluateGuardrail({
    sources: [source('user')],
    tool: { name: 'read_file', risk: 'read', side_effect: 'read_only' },
  })
  assert.equal(result.decision, 'allow')
  assert.ok(result.reasons.includes('tool:read_only'))
  assert.equal(result.policy_version, POLICY_VERSION)
})

test('untrusted external tools require approval and approval scope must match', () => {
  const base = {
    sources: [source('mcp'), source('web')],
    tool: { name: 'send_email', risk: 'external', side_effect: 'external' },
  }
  const pending = evaluateGuardrail(base)
  assert.equal(pending.decision, 'require_approval')
  assert.ok(pending.reasons.includes('taint:untrusted'))
  assert.ok(pending.reasons.includes('tool:external'))
  const scoped = evaluateGuardrail({ ...base, approval: { granted: true, scope: 'external' } })
  assert.equal(scoped.decision, 'allow')
  assert.ok(scoped.reasons.includes('approval:granted'))
  const wrongScope = evaluateGuardrail({ ...base, approval: { granted: true, scope: 'write' } })
  assert.equal(wrongScope.decision, 'require_approval')
})

test('secret capabilities are denied even with approval', () => {
  const result = evaluateGuardrail({
    sources: [source('user')],
    tool: { name: 'read_secret', risk: 'read', side_effect: 'read_only', capability: 'secret.read' },
    approval: { granted: true, scope: '*' },
  })
  assert.equal(result.decision, 'deny')
  assert.ok(result.reasons.includes('capability:secret'))
})

test('owner policy can deny what approval would otherwise allow', () => {
  const result = evaluateGuardrail({
    sources: [source('web')],
    tool: { name: 'send_email', risk: 'external', side_effect: 'external' },
    policy: { untrusted_external: 'deny' },
    approval: { granted: true, scope: 'external' },
  })
  assert.equal(result.decision, 'deny')
  assert.ok(result.reasons.includes('policy:untrusted_external'))
})

test('semi-trusted writes require approval while trusted writes are allowed', () => {
  const semi = evaluateGuardrail({
    sources: [source('memory')],
    tool: { name: 'write_file', risk: 'write', side_effect: 'write' },
  })
  assert.equal(semi.decision, 'require_approval')
  const trusted = evaluateGuardrail({
    sources: [source('user')],
    tool: { name: 'write_file', risk: 'write', side_effect: 'write' },
  })
  assert.equal(trusted.decision, 'allow')
})

test('dangerous tools always require approval; unknown tools use user intent', () => {
  const dangerous = evaluateGuardrail({
    sources: [source('user')],
    tool: { name: 'run_shell', risk: 'dangerous', side_effect: 'write' },
  })
  assert.equal(dangerous.decision, 'require_approval')
  const unknownPending = evaluateGuardrail({
    sources: [source('user')],
    tool: { name: 'opaque_tool', risk: 'unknown', side_effect: 'unknown' },
  })
  assert.equal(unknownPending.decision, 'require_approval')
  const unknownIntent = evaluateGuardrail({
    sources: [source('user')],
    tool: { name: 'opaque_tool', risk: 'unknown', side_effect: 'unknown' },
    user_intent: true,
  })
  assert.equal(unknownIntent.decision, 'allow')
  assert.ok(unknownIntent.reasons.includes('intent:user'))
})

test('decision hashes are deterministic and invalid input fails closed', () => {
  const payload = {
    sources: [source('mcp')],
    tool: { name: 'list_issues', risk: 'external', side_effect: 'external' },
    approval: { granted: false, scope: 'external' },
  }
  assert.equal(evaluateGuardrail(payload).decision_hash, evaluateGuardrail(payload).decision_hash)
  assert.throws(() => classifySources([{ provenance: 'not-real' }]), (error) => error.status === 400)
  assert.throws(() => classifySources([source('mcp', 'dup'), source('web', 'dup')]), (error) => error.status === 400)
  assert.throws(() => evaluateGuardrail({ sources: [], tool: { name: 'x', risk: 'bad' } }), (error) => error.status === 400)
  assert.throws(() => evaluateGuardrail({ sources: [], tool: { name: 'x' }, policy: { untrusted_external: 'allow' } }), (error) => error.status === 400)
  assert.throws(() => evaluateGuardrail({ sources: [], tool: { name: 'x' }, approval: { granted: true, scope: 'bad' } }), (error) => error.status === 400)
  assert.throws(() => evaluateGuardrail({ sources: [], tool: { name: 'x' }, user_intent: 'yes' }), (error) => error.status === 400)
})

test('feature endpoints require workspace access and describe the policy', async () => {
  const api = evaluator()
  const result = await api.endpoints.evaluate({
    workspace_id: W, sources: [source('user')], tool: { name: 'read_file', risk: 'read', side_effect: 'read_only' },
  })
  assert.equal(result.decision, 'allow')
  const classified = await api.endpoints.classify({ workspace_id: W, sources: [source('web')] })
  assert.equal(classified.highest, 'untrusted')
  const policy = await api.endpoints.policy({ workspace_id: W })
  assert.equal(policy.policy.untrusted_external, DEFAULT_POLICY.untrusted_external)
  const contract = await api.endpoints.contract()
  assert.ok(contract.reuse.includes('Bot Social policy.ts / untrusted.ts concepts'))
  assert.ok(contract.not_doing.includes('no DLP or injection detector'))
  const foreign = evaluator(FOREIGN)
  await assert.rejects(foreign.endpoints.evaluate({
    workspace_id: W, sources: [], tool: { name: 'x', risk: 'read', side_effect: 'read_only' },
  }), (error) => error.status === 404)
})
