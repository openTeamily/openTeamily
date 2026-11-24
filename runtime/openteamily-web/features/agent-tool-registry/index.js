// The independent tool-registry capability: project the live DSH tool schemas
// and merge owner metadata overlays. It never registers, executes or rewrites a
// tool and never changes the Agents feature or the runtime bridge.
import { openDatabase } from '../../src/store.js'
import { HEX32, refuse } from '../../featurekit/http.js'
import { createToolRegistry, validToolName } from './store.js'
import {
  contractDescription, describeTools, resolveAgentTools, toolStats,
} from './catalog.js'

const validWorkspace = (value) => typeof value === 'string' && HEX32.test(value)

async function canAccess(host, workspace) {
  const binding = await host.call('agents/personal-binding', {}).catch(() => null)
  if (binding?.workspace_id === workspace) return true
  const teams = await host.call('teams/activeWorkspaces', {}).catch(() => [])
  return Array.isArray(teams) && teams.some(team => team?.id === workspace)
}

export async function createAgentToolRegistry({ host, db, clock }) {
  const store = createToolRegistry(db, { clock })

  async function requireWorkspace(workspace) {
    if (!validWorkspace(workspace)) refuse(400, 'invalid', 'workspace_id must be 32 lowercase hex characters')
    if (!await canAccess(host, workspace)) refuse(404, 'not_found', 'Workspace not found')
    return workspace
  }

  async function readCatalog(payload) {
    const workspace = await requireWorkspace(payload?.workspace_id)
    const resolved = await resolveAgentTools(host, payload, workspace)
    const items = describeTools(resolved.tools, store.listOverlays(workspace))
    return { agent: resolved.agent, items, stats: toolStats(items), source: 'dsh' }
  }

  const endpoints = {
    async catalog(payload) {
      return readCatalog(payload)
    },

    async get(payload) {
      if (!validToolName(payload?.name)) refuse(400, 'invalid', 'Invalid tool name')
      const result = await readCatalog(payload)
      const item = result.items.find(tool => tool.name === payload.name)
      if (!item) refuse(404, 'not_found', 'Tool not found')
      return { agent: result.agent, tool: item }
    },

    async overlays(payload) {
      const workspace = await requireWorkspace(payload?.workspace_id)
      return { items: store.listOverlays(workspace) }
    },

    async overlay(payload) {
      const workspace = await requireWorkspace(payload?.workspace_id)
      if (!validToolName(payload?.name)) refuse(400, 'invalid', 'Invalid tool name')
      const item = store.getOverlay(workspace, payload.name)
      if (!item) refuse(404, 'not_found', 'Tool overlay not found')
      return { overlay: item }
    },

    async upsert(payload) {
      const workspace = await requireWorkspace(payload?.workspace_id)
      return { overlay: store.upsertOverlay(workspace, payload) }
    },

    async remove(payload) {
      const workspace = await requireWorkspace(payload?.workspace_id)
      return store.removeOverlay(workspace, payload?.name)
    },

    async stats(payload) {
      const result = await readCatalog(payload)
      return result.stats
    },

    async contract() {
      return contractDescription()
    },
  }

  return { endpoints, store }
}

export default async function agentToolRegistry(host) {
  const db = await openDatabase(host, 'agent-tool-registry.sqlite3')
  const { endpoints } = await createAgentToolRegistry({ host, db })
  return { endpoints }
}
