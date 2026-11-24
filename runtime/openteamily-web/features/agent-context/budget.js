// OpenTeamily Agent Context Budget v1.
//
// DSH already owns native session compaction (parts.js / steward.js). This
// module budgets the context that the OpenTeamily plugin assembles itself:
// instructions, memory, files, tool descriptions and the user turn. It never
// replaces DSH compaction and never calls a model.
import { refuse } from '../../featurekit/http.js'

export const PRIORITIES = Object.freeze(['critical', 'high', 'normal', 'low'])
export const LIMITS = Object.freeze({
  minContextWindow: 1024,
  maxContextWindow: 2_000_000,
  maxSections: 32,
  maxContentChars: 1_000_000,
  maxCitationsPerSection: 50,
  defaultOutputReserve: 8192,
})
const NAME = /^[a-z][a-z0-9_-]{0,39}$/
const CONTROL = /[\u0000]/
const SEPARATOR = '\n\n'

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const integer = (value) => Number.isSafeInteger(value) && value >= 0
const text = (value, maximum) => typeof value === 'string' && value.length <= maximum && !CONTROL.test(value)

// DSH's own text heuristic: a CJK code point costs about one token, other text
// about a third. This is deliberately conservative and provider-independent.
export function estimateTokens(value) {
  let tokens = 0
  for (const character of String(value ?? '')) {
    tokens += character.codePointAt(0) > 0x2e7f ? 1 : 0.34
  }
  return Math.ceil(tokens)
}

export function truncateToTokens(value, maximum) {
  if (maximum <= 0) return ''
  if (estimateTokens(value) <= maximum) return value
  const chars = Array.from(String(value))
  let low = 0
  let high = chars.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (estimateTokens(chars.slice(0, middle).join('')) <= maximum) low = middle
    else high = middle - 1
  }
  return chars.slice(0, low).join('')
}

function section(value, index, contextWindow) {
  if (!isObject(value)) refuse(400, 'context/invalid', `sections[${index}] must be an object`)
  const allowed = new Set(['name', 'priority', 'content', 'max_tokens', 'citations'])
  const extra = Object.keys(value).filter((key) => !allowed.has(key))
  if (extra.length) refuse(400, 'context/invalid', `Unknown section fields: ${extra.slice(0, 5).join(', ')}`)
  if (typeof value.name !== 'string' || !NAME.test(value.name)) {
    refuse(400, 'context/invalid', `sections[${index}].name must match ${NAME}`)
  }
  if (typeof value.content !== 'string' || value.content.length > LIMITS.maxContentChars || CONTROL.test(value.content)) {
    refuse(400, 'context/invalid', `sections[${index}].content is invalid or too large`)
  }
  const priority = value.priority ?? 'normal'
  if (!PRIORITIES.includes(priority)) refuse(400, 'context/invalid', `sections[${index}].priority is invalid`)
  if (value.max_tokens !== undefined && (!integer(value.max_tokens) || value.max_tokens < 1 || value.max_tokens > contextWindow)) {
    refuse(400, 'context/invalid', `sections[${index}].max_tokens is invalid`)
  }
  const citations = value.citations ?? []
  if (!Array.isArray(citations) || citations.length > LIMITS.maxCitationsPerSection) {
    refuse(400, 'context/invalid', `sections[${index}].citations must be a bounded list`)
  }
  const normalizedCitations = citations.map((citation, citationIndex) => {
    if (!isObject(citation)) refuse(400, 'context/invalid', `citations[${citationIndex}] must be an object`)
    const keys = new Set(['id', 'revision', 'title', 'kind'])
    const extra = Object.keys(citation).filter((key) => !keys.has(key))
    if (extra.length) refuse(400, 'context/invalid', `Unknown citation fields: ${extra.slice(0, 5).join(', ')}`)
    if (typeof citation.id !== 'string' || !citation.id || citation.id.length > 128 || CONTROL.test(citation.id)) {
      refuse(400, 'context/invalid', `citations[${citationIndex}].id is invalid`)
    }
    if (!integer(citation.revision)) refuse(400, 'context/invalid', `citations[${citationIndex}].revision is invalid`)
    if (citation.title !== undefined && !text(citation.title, 200)) refuse(400, 'context/invalid', `citations[${citationIndex}].title is invalid`)
    if (citation.kind !== undefined && !text(citation.kind, 40)) refuse(400, 'context/invalid', `citations[${citationIndex}].kind is invalid`)
    return {
      id: citation.id,
      revision: citation.revision,
      ...(citation.title !== undefined ? { title: citation.title } : {}),
      ...(citation.kind !== undefined ? { kind: citation.kind } : {}),
    }
  })
  return {
    name: value.name,
    priority,
    content: value.content,
    tokens: estimateTokens(value.content),
    max_tokens: value.max_tokens ?? null,
    citations: normalizedCitations,
  }
}

function allocate(group, remaining) {
  const caps = group.map((item) => Math.min(item.tokens, item.max_tokens ?? item.tokens))
  const total = caps.reduce((sum, value) => sum + value, 0)
  if (total <= remaining) return caps
  if (remaining <= 0 || total === 0) return caps.map(() => 0)
  const exact = caps.map((cap) => (remaining * cap) / total)
  const allocation = exact.map(Math.floor)
  let left = remaining - allocation.reduce((sum, value) => sum + value, 0)
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value), cap: caps[index] }))
    .filter((item) => item.cap > 0 && allocation[item.index] < item.cap)
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index)
  for (const item of order) {
    if (left <= 0) break
    allocation[item.index] += 1
    left -= 1
  }
  return allocation.map((value, index) => Math.min(value, caps[index]))
}

export function packContext(payload) {
  if (!isObject(payload)) refuse(400, 'context/invalid', 'Provide a JSON object')
  const contextWindow = payload.context_window
  if (!Number.isSafeInteger(contextWindow) || contextWindow < LIMITS.minContextWindow || contextWindow > LIMITS.maxContextWindow) {
    refuse(400, 'context/invalid', `context_window must be ${LIMITS.minContextWindow}-${LIMITS.maxContextWindow}`)
  }
  const fallbackReserve = Math.min(LIMITS.defaultOutputReserve, Math.floor(contextWindow / 8))
  const outputReserve = payload.output_reserve ?? fallbackReserve
  if (!Number.isSafeInteger(outputReserve) || outputReserve < 0 || outputReserve >= contextWindow) {
    refuse(400, 'context/invalid', 'output_reserve must be a non-negative integer below context_window')
  }
  const rawSections = payload.sections
  if (!Array.isArray(rawSections) || !rawSections.length || rawSections.length > LIMITS.maxSections) {
    refuse(400, 'context/invalid', `sections must contain 1-${LIMITS.maxSections} items`)
  }
  const sections = rawSections.map((value, index) => section(value, index, contextWindow))
  const names = new Set()
  for (const item of sections) {
    if (names.has(item.name)) refuse(400, 'context/invalid', `Duplicate section name: ${item.name}`)
    names.add(item.name)
  }

  const separatorToken = estimateTokens(SEPARATOR)
  const separatorTotal = separatorToken * Math.max(0, sections.length - 1)
  const available = contextWindow - outputReserve - separatorTotal
  if (available <= 0) refuse(413, 'context/overflow', 'Context window is smaller than the output reserve and separators')

  const critical = sections.filter((item) => item.priority === 'critical')
  const criticalAllowance = (item) => Math.min(item.tokens, item.max_tokens ?? item.tokens)
  const criticalTokens = critical.reduce((sum, item) => sum + criticalAllowance(item), 0)
  if (criticalTokens > available) {
    refuse(413, 'context/overflow', 'Critical sections exceed the available context budget', {
      required: criticalTokens + separatorTotal,
      available: contextWindow - outputReserve,
      context_window: contextWindow,
    })
  }

  const allocation = new Map()
  for (const item of critical) allocation.set(item.name, criticalAllowance(item))
  let remaining = available - criticalTokens
  for (const priority of ['high', 'normal', 'low']) {
    const group = sections.filter((item) => item.priority === priority)
    if (!group.length) continue
    const values = allocate(group, remaining)
    group.forEach((item, index) => allocation.set(item.name, values[index]))
    remaining -= values.reduce((sum, value) => sum + value, 0)
  }

  const finalSections = sections.map((item) => {
    const allowance = Math.min(allocation.get(item.name) ?? 0, item.tokens)
    const content = allowance >= item.tokens ? item.content : truncateToTokens(item.content, allowance)
    const finalTokens = estimateTokens(content)
    return {
      name: item.name,
      priority: item.priority,
      original_tokens: item.tokens,
      final_tokens: finalTokens,
      kept: finalTokens > 0,
      truncated: finalTokens < item.tokens,
      content,
      citations: item.citations,
    }
  })
  const kept = finalSections.filter((item) => item.kept)
  const finalSeparators = separatorToken * Math.max(0, kept.length - 1)
  const used = kept.reduce((sum, item) => sum + item.final_tokens, 0) + finalSeparators
  const dropped = finalSections.filter((item) => !item.kept).map((item) => ({
    name: item.name,
    original_tokens: item.original_tokens,
    reason: 'budget',
  }))
  const warnings = finalSections
    .filter((item) => item.truncated)
    .map((item) => `${item.name} truncated from ${item.original_tokens} to ${item.final_tokens} tokens`)
  const citations = kept.flatMap((item) => item.citations.map((citation) => ({
    section: item.name,
    ...citation,
    section_truncated: item.truncated,
  })))
  return {
    prompt: kept.map((item) => item.content).join(SEPARATOR),
    sections: finalSections.map(({ citations: _citations, ...item }) => item),
    citations,
    budget: {
      context_window: contextWindow,
      output_reserve: outputReserve,
      available: contextWindow - outputReserve,
      used,
      remaining: Math.max(0, contextWindow - outputReserve - used),
      separator_tokens: finalSeparators,
    },
    dropped,
    warnings,
    truncated: finalSections.some((item) => item.truncated) || dropped.length > 0,
  }
}

export function contractDescription() {
  return {
    schema: 'openteamily.agent-context.v1',
    version: 1,
    estimator: 'DSH heuristic: code point > 0x2e7f costs 1 token, other text 0.34, ceil',
    priorities: [...PRIORITIES],
    limits: { ...LIMITS },
    section: { name: NAME.source, content_max_chars: LIMITS.maxContentChars, citations_max: LIMITS.maxCitationsPerSection },
    reuse: ['DSH parts.js/steward.js native compaction', 'agent-runtime-contract citation shape', 'DSH text.js token heuristic'],
    new_in_this_feature: ['section budgets', 'priority allocation', 'deterministic truncation', 'citation-preserving context pack', 'overflow diagnostics'],
    not_doing: ['no model call', 'no native compaction replacement', 'no retrieval or reranking', 'no persistence', 'no UI'],
  }
}
