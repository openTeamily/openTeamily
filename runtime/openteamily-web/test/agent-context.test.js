import assert from 'node:assert/strict'
import test from 'node:test'
import feature from '../features/agent-context/index.js'
import { estimateTokens, packContext, truncateToTokens, LIMITS } from '../features/agent-context/budget.js'

const section = (name, content, extra = {}) => ({ name, content, ...extra })
const pack = (sections, extra = {}) => packContext({ context_window: 4096, output_reserve: 512, sections, ...extra })

test('the estimator is the DSH heuristic and is conservative', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('abcd'), 2)
  assert.equal(estimateTokens('你好'), 2)
  assert.ok(estimateTokens('hello 世界') >= 4)
  assert.equal(truncateToTokens('你好世界', 2), '你好')
  assert.equal(truncateToTokens('abc', 0), '')
})

test('a pack under budget keeps every section and preserves citations', () => {
  const result = pack([
    section('system', 'You are a careful agent.'),
    section('user', 'Summarize the note.'),
    section('memory', 'The project is called OpenTeamily.', {
      citations: [{ id: 'page-1', revision: 3, title: 'Project' }],
    }),
  ])
  assert.equal(result.truncated, false)
  assert.deepEqual(result.dropped, [])
  assert.equal(result.sections.length, 3)
  assert.equal(result.sections.every(item => item.kept), true)
  assert.equal(result.citations.length, 1)
  assert.equal(result.citations[0].section, 'memory')
  assert.equal(result.citations[0].revision, 3)
  assert.match(result.prompt, /OpenTeamily/)
  assert.equal(result.budget.context_window, 4096)
  assert.ok(result.budget.used <= result.budget.available)
})

test('low-priority context is truncated before critical context, deterministically', () => {
  const long = 'x'.repeat(20_000)
  const input = {
    context_window: 2048, output_reserve: 128,
    sections: [
      section('system', 'system rules', { priority: 'critical' }),
      section('user', 'user request', { priority: 'critical' }),
      section('history', long, { priority: 'normal' }),
      section('memory', long, { priority: 'low' }),
    ],
  }
  const first = packContext(input)
  const second = packContext(input)
  assert.equal(first.truncated, true)
  assert.equal(JSON.stringify(first), JSON.stringify(second))
  const byName = Object.fromEntries(first.sections.map(item => [item.name, item]))
  assert.equal(byName.system.truncated, false)
  assert.equal(byName.user.truncated, false)
  assert.equal(byName.memory.kept, false)
  assert.equal(byName.history.kept, true)
  assert.ok(byName.history.final_tokens < byName.history.original_tokens)
  assert.ok(first.budget.used <= first.budget.available)
})

test('critical sections that cannot fit fail closed with overflow diagnostics', () => {
  assert.throws(() => packContext({
    context_window: 1024, output_reserve: 0,
    sections: [section('system', 'x'.repeat(10_000), { priority: 'critical' })],
  }), (error) => error.status === 413 && error.code === 'context/overflow')
})

test('section max_tokens caps allocation and invalid payloads are refused', () => {
  const capped = pack([
    section('system', 'rules', { priority: 'critical' }),
    section('memory', 'x'.repeat(5000), { priority: 'low', max_tokens: 20 }),
  ], { context_window: 4096, output_reserve: 128 })
  assert.equal(capped.sections.find(item => item.name === 'memory').final_tokens <= 20, true)

  assert.throws(() => packContext({ context_window: 10, sections: [section('user', 'x')] }), (error) => error.status === 400)
  assert.throws(() => pack([section('User', 'x')]), (error) => error.status === 400)
  assert.throws(() => pack([section('user', 'x'), section('user', 'y')]), (error) => error.status === 400)
  assert.throws(() => pack([section('user', 'x', { priority: 'urgent' })]), (error) => error.status === 400)
  assert.throws(() => pack([section('user', 'x', { citations: [{ id: 'p', revision: -1 }] })]), (error) => error.status === 400)
})

test('the feature exposes estimate, pack and contract without persistence or execution', async () => {
  const api = feature({})
  assert.equal((await api.endpoints.estimate({ text: '你好' })).tokens, 2)
  const result = await api.endpoints.pack({
    context_window: 2048, output_reserve: 128,
    sections: [section('user', 'hello')],
  })
  assert.match(result.prompt, /hello/)
  const contract = await api.endpoints.contract()
  assert.equal(contract.schema, 'openteamily.agent-context.v1')
  assert.ok(contract.reuse.includes('DSH parts.js/steward.js native compaction'))
  assert.ok(contract.not_doing.includes('no native compaction replacement'))
  assert.equal(contract.limits.maxSections, LIMITS.maxSections)
})
