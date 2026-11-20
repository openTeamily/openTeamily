// Personal agent, built-in roster and their per-account migration, kept in the
// user's own DS-Bot (moved from openteamily/personal.py). The local record is a
// placeholder until the platform bundle is imported; a verified import replaces
// it with the account's original workspace/agent ids and fields, so /chat/ and
// /agents/ keep using the same personal agent after cutover.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { compatHandler } from '../../lib/b4/compat.js'
import { Fault } from '../../lib/b4/http.js'
import { ownerId } from '../../featurekit/v1.js'
import { openDatabase, fail, newId } from '../../src/store.js'
import { importPending } from '../../src/pending-import.js'

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

const FORMAT = 'openteamily-dsbot-import'
const ID = /^[0-9a-f]{32}$/
const REQUIRED_TABLES = ['workspace_agents', 'personal_agents', 'builtin_agents']
// Optional tables keep the importer compatible with older bundles and with
// bundles that carry the onboarding look through the settings table.
const TABLES = new Set([...REQUIRED_TABLES, 'ot_users', 'workspaces', 'personal_look', 'user_onboarding_steps'])
const sha = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex')
const now = () => Math.floor(Date.now() / 1000)
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const invalid = (message) => { throw Object.assign(new Error(message), { code: 'personal/invalid', status: 400 }) }

function personalName(username) {
  const name = `${username || 'user'}'s Personal Agent`
  return name.length <= 80 ? name : name.slice(0, 80)
}

function legacyAgent(row, workspaceId, owner, fallback = now()) {
  return {
    id: row.id,
    workspace_id: row.workspace_id ?? workspaceId,
    name: String(row.name ?? '').trim(),
    summary: String(row.summary ?? ''),
    instructions: String(row.instructions ?? ''),
    revision: Number.isInteger(row.revision) && row.revision > 0 ? row.revision : 1,
    created: Number(row.created) || fallback,
    updated: Number(row.updated) || Number(row.created) || fallback,
    created_by: row.created_by ?? owner,
    archived: row.archived ? 1 : 0,
    category: row.category ?? null,
    quick_starts: Array.isArray(row.quick_starts) ? row.quick_starts.filter((item) => typeof item === 'string').slice(0, 5) : [],
    homepage: row.homepage ?? { visibility: 'restricted' },
  }
}

function validAgent(row, { requireId = true } = {}) {
  if (!isObject(row)) return false
  if (requireId && !ID.test(String(row.id))) return false
  if (typeof row.name !== 'string' || !row.name.trim() || row.name.length > 80) return false
  if (typeof row.summary !== 'string' || row.summary.length > 500) return false
  if (typeof row.instructions !== 'string' || row.instructions.length > 16000) return false
  return true
}

export function verifyOfficial(bundle) {
  if (!isObject(bundle) || bundle.format !== FORMAT || bundle.version !== 1) invalid('unsupported bundle format')
  if (bundle.feature !== 'personal') invalid('bundle feature mismatch')
  if (!isObject(bundle.tables) || !isObject(bundle.manifest)) invalid('bundle tables required')
  for (const table of REQUIRED_TABLES) {
    if (!Object.hasOwn(bundle.tables, table) || !Object.hasOwn(bundle.manifest, table)) invalid(`missing table ${table}`)
  }
  const tables = {}
  for (const [table, text] of Object.entries(bundle.tables)) {
    if (!TABLES.has(table)) invalid(`table ${table} is not importable`)
    const entry = bundle.manifest[table]
    if (typeof text !== 'string' || !entry || entry.sha256 !== sha(text) || !Number.isInteger(entry.rows) || entry.rows < 0) invalid(`table ${table} digest mismatch`)
    let rows
    try { rows = JSON.parse(text) } catch { invalid(`table ${table} is not JSON`) }
    if (!Array.isArray(rows) || rows.length !== entry.rows) invalid(`table ${table} row count mismatch`)
    if (rows.length > 1000) invalid(`table ${table} is too large`)
    tables[table] = rows
  }
  for (const table of TABLES) if (!tables[table]) tables[table] = []
  return tables
}

function parsedLook(row) {
  if (row.look === null || row.look === undefined || row.look === '') return null
  let value = row.look
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { invalid('invalid personal look') }
  }
  if (!isObject(value)) invalid('invalid personal look')
  return value
}

function importedState(tables) {
  if (tables.ot_users.length > 1) invalid('multiple owners')
  const owner = tables.ot_users[0]?.id ?? null
  if (owner !== null && !ID.test(String(owner))) invalid('invalid owner')
  if (tables.personal_agents.length > 1) invalid('multiple personal agents')
  if (!tables.personal_agents.length) {
    if (tables.workspaces.length || tables.workspace_agents.length || tables.builtin_agents.length) invalid('personal mapping required')
    return null
  }
  const personal = tables.personal_agents[0]
  if (!ID.test(String(personal.user_id)) || !ID.test(String(personal.workspace_id)) || !ID.test(String(personal.agent_id))) invalid('invalid personal mapping')
  if (owner !== null && personal.user_id !== owner) invalid('owner mismatch')
  if (tables.workspaces.length !== 1) invalid('workspace mapping mismatch')
  const workspace = tables.workspaces[0]
  if (workspace.id !== personal.workspace_id || workspace.owner_id !== personal.user_id) invalid('workspace mapping mismatch')
  if (owner !== null && workspace.owner_id !== owner) invalid('owner mismatch')
  if (typeof workspace.name !== 'string' || !workspace.name.trim()) invalid('invalid workspace')

  const byId = new Map()
  for (const row of tables.workspace_agents) {
    if (!validAgent(row)) invalid('invalid agent')
    if (byId.has(row.id)) invalid('duplicate agent')
    if (row.workspace_id !== workspace.id) invalid('agent workspace mismatch')
    byId.set(row.id, row)
  }
  const personalAgent = byId.get(personal.agent_id)
  if (!personalAgent) invalid('personal agent missing')

  const builtinAgents = []
  const keys = new Set()
  const referenced = new Set([personal.agent_id])
  for (const row of tables.builtin_agents) {
    if (!ID.test(String(row.agent_id)) || row.workspace_id !== workspace.id) invalid('builtin workspace mismatch')
    if (typeof row.builtin_key !== 'string' || !row.builtin_key.trim() || keys.has(row.builtin_key)) invalid('invalid builtin key')
    const agent = byId.get(row.agent_id)
    if (!agent) invalid('builtin agent missing')
    keys.add(row.builtin_key)
    referenced.add(row.agent_id)
    builtinAgents.push({ key: row.builtin_key, agent: legacyAgent(agent, workspace.id, owner ?? personal.user_id) })
  }
  if ([...byId.keys()].some((id) => !referenced.has(id))) invalid('unexpected agent')

  const lookRows = tables.personal_look.length ? tables.personal_look : tables.user_onboarding_steps
  if (lookRows.length > 1) invalid('multiple personal looks')
  let hasLook = false
  let look = null
  if (lookRows.length) {
    const row = lookRows[0]
    if (row.user_id !== personal.user_id) invalid('look owner mismatch')
    hasLook = true
    look = parsedLook(row)
  }
  return {
    owner: personal.user_id,
    workspace: {
      id: workspace.id,
      name: workspace.name.trim(),
      kind: 'personal',
      owner_id: workspace.owner_id,
      created: Number(workspace.created) || now(),
    },
    agent: legacyAgent(personalAgent, workspace.id, owner ?? personal.user_id),
    builtin_agents: builtinAgents,
    hasLook,
    look,
  }
}

function fingerprint(tables) {
  const sorted = (rows) => [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  const source = {
    users: sorted(tables.ot_users.map((row) => [row.id, row.username])),
    workspaces: sorted(tables.workspaces.map((row) => [row.id, row.owner_id, row.name, row.created])),
    personal: sorted(tables.personal_agents.map((row) => [row.user_id, row.workspace_id, row.agent_id, row.created])),
    agents: sorted(tables.workspace_agents.map((row) => [row.id, row.workspace_id, row.name, row.summary, row.instructions,
      row.revision, row.created, row.updated, row.created_by, row.archived])),
    builtins: sorted(tables.builtin_agents.map((row) => [row.agent_id, row.workspace_id, row.builtin_key, row.created])),
    look: sorted((tables.personal_look.length ? tables.personal_look : tables.user_onboarding_steps)
      .map((row) => [row.user_id, row.look, row.updated])),
  }
  return sha(JSON.stringify(source))
}

export function createPersonalFeature({ dir, host = {}, clock = now }) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stateFile = join(dir, 'personal-agent.json')
  const profileFile = join(dir, 'profile.json')

  const readState = () => {
    try {
      const state = JSON.parse(readFileSync(stateFile, 'utf8'))
      return state && typeof state === 'object' && state.workspace && state.agent ? state : null
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }
  const writeState = (state) => {
    const tmp = `${stateFile}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 })
    renameSync(tmp, stateFile)
  }
  const readProfile = () => {
    try {
      const raw = JSON.parse(readFileSync(profileFile, 'utf8'))
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...DEFAULTS, ...raw } : { ...DEFAULTS }
    } catch (error) {
      if (error?.code === 'ENOENT') return { ...DEFAULTS }
      throw error
    }
  }
  const writeProfile = (profile) => {
    const tmp = `${profileFile}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(profile), { mode: 0o600 })
    renameSync(tmp, profileFile)
  }
  const call = async (endpoint, payload) => {
    if (typeof host.call !== 'function') return null
    return host.call(endpoint, payload)
  }
  const syncAgents = async (agents, remove = []) => {
    try {
      await call('agents/import', { agents, remove })
    } catch (error) {
      if (error?.code !== 'openteamily/not-found') host.log?.(`personal agent roster import pending: ${String(error?.message ?? error).slice(0, 120)}`)
    }
  }

  async function payload(state) {
    let look = null
    if (state.look_imported) look = state.look ?? null
    else {
      try { look = (await call('settings/look'))?.look ?? null } catch { look = null }
      if (look === null && Object.hasOwn(state, 'look')) look = state.look
    }
    return {
      personal_agent: {
        workspace: { id: state.workspace.id, name: state.workspace.name, kind: state.workspace.kind ?? 'personal' },
        agent: state.agent,
        look,
      },
      builtin_agents: state.builtin_agents.map((item) => ({ key: item.key, agent: item.agent })),
    }
  }

  async function ensure() {
    const existing = readState()
    if (existing) return { status: 200, state: existing }
    const owner = ownerId(process.env)
    const created = clock()
    const workspaceId = newId()
    const personalId = newId()
    const personalRow = legacyAgent({
      id: personalId, workspace_id: workspaceId, name: personalName(process.env.OPENTEAMILY_OWNER_USERNAME || 'user'),
      summary: PERSONAL_SUMMARY, instructions: PERSONAL_INSTRUCTIONS, revision: 1,
      created, updated: created, created_by: owner, archived: 0,
    }, workspaceId, owner, created)
    const builtins = BUILTINS.map(([key, name, summary, instructions]) => ({
      key,
      agent: legacyAgent({
        id: newId(), workspace_id: workspaceId, name, summary, instructions, revision: 1,
        created, updated: created, created_by: owner, archived: 0,
      }, workspaceId, owner, created),
    }))
    const state = {
      version: 2,
      workspace: { id: workspaceId, name: WORKSPACE_NAME, kind: 'personal', owner_id: owner, created },
      agent: personalRow,
      builtin_agents: builtins,
      created,
    }
    await syncAgents([personalRow, ...builtins.map((item) => item.agent)])
    const conversationId = newId()
    try {
      await call('agents/importHistory', {
        conversations: [{ id: conversationId, agent_id: personalId, title: 'Personal Agent', created, updated: created }],
        messages: [{ id: newId(), conversation_id: conversationId, role: 'assistant', body: WELCOME, status: 'succeeded', created }],
      })
    } catch (error) {
      if (error?.code !== 'openteamily/not-found') host.log?.(`personal welcome conversation pending: ${String(error?.message ?? error).slice(0, 120)}`)
    }
    writeState(state)
    return { status: 201, state }
  }

  async function migrate(bundle) {
    const tables = verifyOfficial(bundle)
    const source = fingerprint(tables)
    const prior = readState()
    if (!tables.personal_agents.length) return { status: 'noop', imported: false }
    if (prior?.imported?.fingerprint === source) return { status: 'already-imported', imported: false }

    const imported = importedState(tables)
    const next = {
      version: 2,
      workspace: imported.workspace,
      agent: imported.agent,
      builtin_agents: imported.builtin_agents,
      created: imported.workspace.created ?? imported.agent.created,
      imported: {
        fingerprint: source,
        at: clock(),
        user_id: imported.owner,
        workspace_id: imported.workspace.id,
        personal_agent_id: imported.agent.id,
      },
    }
    if (imported.hasLook) {
      next.look = imported.look
      next.look_imported = true
    } else if (prior && Object.hasOwn(prior, 'look')) {
      next.look = prior.look
      if (prior.look_imported) next.look_imported = true
    }
    writeState(next)

    const profile = readProfile()
    writeProfile({ ...profile, name: imported.agent.name, instructions: imported.agent.instructions })

    const keep = new Set([imported.agent.id, ...imported.builtin_agents.map((item) => item.agent.id)])
    const remove = prior
      ? [prior.agent.id, ...(prior.builtin_agents ?? []).map((item) => item.agent?.id)]
        .filter((id) => typeof id === 'string' && ID.test(id) && !keep.has(id))
      : []
    await syncAgents([imported.agent, ...imported.builtin_agents.map((item) => item.agent)], remove)
    return {
      status: 'imported',
      imported: true,
      workspace_id: imported.workspace.id,
      personal_agent_id: imported.agent.id,
      builtin_agents: imported.builtin_agents.length,
    }
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
    migrate,
    endpoints: {
      async get() {
        const raw = (() => {
          try { return JSON.parse(readFileSync(profileFile, 'utf8')) } catch (error) {
            if (error?.code === 'ENOENT') return null
            throw error
          }
        })()
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { ...DEFAULTS, ...raw }
        const state = readState()
        if (state?.imported) return { ...DEFAULTS, name: state.agent.name, instructions: state.agent.instructions }
        return { ...DEFAULTS }
      },
      async set(input) {
        if (!input || typeof input !== 'object') fail('personal/invalid', 'Object payload required')
        const next = readProfile()
        if (input.name !== undefined) {
          if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 60) fail('personal/invalid', 'Name must be 1–60 characters')
          next.name = input.name.trim()
        }
        if (input.instructions !== undefined) {
          if (typeof input.instructions !== 'string' || input.instructions.length > 4000) fail('personal/invalid', 'Instructions must be at most 4000 characters')
          next.instructions = input.instructions
        }
        if (input.recall !== undefined) {
          if (!['all', 'off'].includes(input.recall)) fail('personal/invalid', 'recall must be all or off')
          next.recall = input.recall
        }
        writeProfile(next)
        const state = readState()
        if (state) {
          const agent = { ...state.agent }
          if (input.name !== undefined) agent.name = next.name
          if (input.instructions !== undefined) agent.instructions = next.instructions
          writeState({ ...state, agent })
        }
        return next
      },
      async view() {
        const state = readState()
        return state ? payload(state) : { personal_agent: null }
      },
      async state() { return readState() },
      async import(input) { return migrate(input?.bundle ?? input) },
      async migrate(input) { return migrate(input?.bundle ?? input) },
      v1: compatHandler(routes),
    },
  }
}

export default async function personal(host) {
  const feature = createPersonalFeature({ dir: host.featureDir(), host })
  const db = await openDatabase(host, 'personal.sqlite3')
  await importPending({ host, db, migrate: feature.migrate })
  const wrapped = {}
  for (const [name, fn] of Object.entries(feature.endpoints)) wrapped[name] = async (payload) => fn(payload ?? {})
  return { pages: ['personal'], endpoints: wrapped, migrate: feature.migrate }
}
