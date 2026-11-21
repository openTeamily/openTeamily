// Personal agent profile, kept in the user's own DS-Bot (moved from personal.py).
// The legacy `/v1/personal-agent` API is served here so /chat/ and /agents/ pages
// no longer call the central platform once they are cut over.
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { compatHandler } from '../../lib/b4/compat.js'
import { Fault } from '../../lib/b4/http.js'
import { ownerId } from '../../featurekit/v1.js'
import { fail, newId } from '../../src/store.js'

const DEFAULTS = Object.freeze({ name: 'My assistant', instructions: '', recall: 'all' })
const WORKSPACE_NAME = '个人空间'
const PERSONAL_SUMMARY = 'Your Cross-context Super AI Agent.'
const PERSONAL_INSTRUCTIONS = '你是用户的个人智能体，跨对话记住用户的目标与偏好，主动提供清晰、可执行的帮助。'
const WELCOME = '你们已经是好友了，可以开始聊天啦！'
const BUILTINS = Object.freeze([
  ['teamily-agent', 'Teamily Agent', 'Teamily 平台助手', '帮助用户了解和使用平台功能。'],
  ['content-creator', 'Content Creator', '内容创作助手', '协助起草、改写和润色内容。'],
  ['finance-assistant', 'Finance Assistant', '财务助手', '帮助整理预算、账单与财务问题。'],
  ['health-assistant', 'Health Assistant', '健康助手', '提供一般性的健康与运动建议。'],
  ['ai-stock-assistant', 'AI Stock Assistant', 'AI 股票助手', '帮助整理市场信息与投资研究。'],
  ['market-research', 'Market Research', '市场调研助手', '协助收集和整理市场调研资料。'],
  ['travel-planner', 'Travel Planner', '旅行规划助手', '帮助规划行程、预算与路线。'],
  ['accounting-assistant', 'Accounting Assistant', '会计助手', '帮助整理账目与报销。'],
  ['slides-assistant', 'Slides Assistant', '演示文稿助手', '帮助组织演示文稿结构与要点。'],
  ['webpage-developer', 'Webpage Developer', '网页开发助手', '帮助搭建和修改小型网页。'],
])
const now = () => Math.floor(Date.now() / 1000)
const ownerName = () => String(process.env.OPENTEAMILY_OWNER_USERNAME || 'user').slice(0, 60) || 'user'

function personalName(username) {
  const name = `${username}'s Personal Agent`
  return name.length <= 80 ? name : name.slice(0, 80)
}

function legacyAgent(row, workspaceId, owner) {
  return {
    id: row.id,
    workspace_id: row.workspace_id ?? workspaceId,
    name: row.name,
    summary: row.summary ?? '',
    instructions: row.instructions ?? '',
    revision: row.revision ?? 1,
    created: row.created ?? now(),
    updated: row.updated ?? row.created ?? now(),
    created_by: row.created_by ?? owner,
    archived: row.archived ? 1 : 0,
    category: row.category ?? null,
    quick_starts: Array.isArray(row.quick_starts) ? row.quick_starts : [],
    homepage: row.homepage ?? { visibility: 'restricted' },
  }
}

export default function personal(host) {
  const file = () => join(host.featureDir(), 'profile.json')
  const stateFile = () => join(host.featureDir(), 'personal-agent.json')
  const read = () => {
    try { return { ...DEFAULTS, ...JSON.parse(readFileSync(file(), 'utf8')) } } catch { return { ...DEFAULTS } }
  }
  const readState = () => {
    try {
      const state = JSON.parse(readFileSync(stateFile(), 'utf8'))
      return state && typeof state === 'object' && state.workspace && state.agent ? state : null
    } catch { return null }
  }
  const writeState = (state) => {
    writeFileSync(stateFile() + '.tmp', JSON.stringify(state), { mode: 0o600 })
    renameSync(stateFile() + '.tmp', stateFile())
  }
  const call = async (endpoint, payload) => {
    if (typeof host.call !== 'function') return null
    return host.call(endpoint, payload)
  }

  async function payload(state) {
    let look = null
    try {
      const saved = await call('settings/look')
      look = saved?.look ?? null
    } catch { look = null }
    return {
      personal_agent: { workspace: state.workspace, agent: state.agent, look },
      builtin_agents: state.builtin_agents.map((item) => ({ key: item.key, agent: item.agent })),
    }
  }

  async function ensure() {
    const existing = readState()
    if (existing) return { status: 200, state: existing }
    const owner = ownerId(process.env)
    const created = now()
    const workspaceId = newId()
    const personalId = newId()
    const personalRow = legacyAgent({
      id: personalId, workspace_id: workspaceId, name: personalName(ownerName()),
      summary: PERSONAL_SUMMARY, instructions: PERSONAL_INSTRUCTIONS, revision: 1,
      created, updated: created, created_by: owner, archived: 0, category: null, quick_starts: [],
    }, workspaceId, owner)
    const builtins = BUILTINS.map(([key, name, summary, instructions]) => {
      const agent = legacyAgent({
        id: newId(), workspace_id: workspaceId, name, summary, instructions, revision: 1,
        created, updated: created, created_by: owner, archived: 0, category: null, quick_starts: [],
      }, workspaceId, owner)
      return { key, agent }
    })
    try {
      await call('agents/import', { agents: [personalRow, ...builtins.map((item) => item.agent)] })
    } catch (error) {
      if (error?.code !== 'openteamily/not-found') throw error
    }
    const conversationId = newId()
    try {
      await call('agents/importHistory', {
        conversations: [{ id: conversationId, agent_id: personalId, title: 'Personal Agent', created, updated: created }],
        messages: [{ id: newId(), conversation_id: conversationId, role: 'assistant', body: WELCOME, status: 'succeeded', created }],
      })
    } catch (error) {
      if (error?.code !== 'openteamily/not-found') throw error
    }
    const state = {
      workspace: { id: workspaceId, name: WORKSPACE_NAME, kind: 'personal' },
      agent: personalRow,
      builtin_agents: builtins,
      created,
    }
    writeState(state)
    return { status: 201, state }
  }

  const routes = [
    {
      method: 'GET', path: /^\/v1\/personal-agent$/,
      async handle({ query }) {
        if (query) throw new Fault(400, 'invalid', 'Invalid personal agent request')
        const state = readState()
        return [200, state ? await payload(state) : { personal_agent: null }]
      },
    },
    {
      method: 'POST', path: /^\/v1\/personal-agent$/,
      async handle() {
        const { status, state } = await ensure()
        return [status, await payload(state)]
      },
    },
  ]

  return {
    endpoints: {
      async get() { return read() },
      async set(payload) {
        if (!payload || typeof payload !== 'object') fail('personal/invalid', 'Object payload required')
        const next = read()
        if (payload.name !== undefined) {
          if (typeof payload.name !== 'string' || !payload.name.trim() || payload.name.length > 60) fail('personal/invalid', 'Name must be 1–60 characters')
          next.name = payload.name.trim()
        }
        if (payload.instructions !== undefined) {
          if (typeof payload.instructions !== 'string' || payload.instructions.length > 4000) fail('personal/invalid', 'Instructions must be at most 4000 characters')
          next.instructions = payload.instructions
        }
        if (payload.recall !== undefined) {
          if (!['all', 'off'].includes(payload.recall)) fail('personal/invalid', 'recall must be all or off')
          next.recall = payload.recall
        }
        writeFileSync(file() + '.tmp', JSON.stringify(next), { mode: 0o600 })
        renameSync(file() + '.tmp', file())
        return next
      },
      v1: compatHandler(routes),
    },
  }
}
