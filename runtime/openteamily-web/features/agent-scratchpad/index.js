// The independent shared scratchpad for multi-agent runs. It is a CAS store;
// it does not start agents, tools or subagents and does not modify team-runs.
import { openDatabase } from '../../src/store.js'
import { HEX32, refuse } from '../../featurekit/http.js'
import { createScratchpad } from './store.js'

const validWorkspace = (value) => typeof value === 'string' && HEX32.test(value)

async function canAccess(host, workspace) {
  const binding = await host.call('agents/personal-binding', {}).catch(() => null)
  if (binding?.workspace_id === workspace) return true
  const teams = await host.call('teams/activeWorkspaces', {}).catch(() => [])
  return Array.isArray(teams) && teams.some(team => team?.id === workspace)
}

export async function createAgentScratchpad({ host, db, clock }) {
  const store = createScratchpad(db, { clock })

  async function requireWorkspace(workspace) {
    if (!validWorkspace(workspace)) refuse(400, 'invalid', 'workspace_id must be 32 lowercase hex characters')
    if (!await canAccess(host, workspace)) refuse(404, 'not_found', 'Workspace not found')
    return workspace
  }

  const endpoints = {
    async put(payload) {
      const workspace = await requireWorkspace(payload?.workspace_id)
      return store.put(workspace, payload)
    },

    async get(payload) {
      const workspace = await requireWorkspace(payload?.workspace_id)
      const entry = store.get(workspace, payload?.scope, payload?.key)
      if (!entry) refuse(404, 'not_found', 'Scratchpad entry not found')
      return { entry }
    },

    async list(payload) {
      const workspace = await requireWorkspace(payload?.workspace_id)
      return store.list(workspace, payload)
    },

    async remove(payload) {
      const workspace = await requireWorkspace(payload?.workspace_id)
      return store.remove(workspace, payload)
    },

    async stats(payload) {
      const workspace = await requireWorkspace(payload?.workspace_id)
      return store.stats(workspace, payload)
    },

    async contract() {
      return {
        schema: 'openteamily.agent-scratchpad.v1',
        version: 1,
        limits: { max_value_bytes: 256 * 1024, max_entries: 1000, max_scope_entries: 200, max_list: 100 },
        visibilities: ['private', 'run', 'workspace'],
        endpoints: ['put', 'get', 'list', 'remove', 'stats', 'contract'],
        reuse: ['DSH run/subagent identity', 'agent-runs run_id/session metadata', 'agent-runtime-contract event identity concepts'],
        new_in_this_feature: ['CAS revisioned shared state', 'client_key replay', 'scope/prefix listing', 'expiry and quotas'],
        not_doing: ['no agent execution', 'no subagent control', 'no tool execution', 'no lease/claim protocol yet', 'no UI'],
      }
    },
  }

  return { endpoints, store }
}

export default async function agentScratchpad(host) {
  const db = await openDatabase(host, 'agent-scratchpad.sqlite3')
  const { endpoints } = await createAgentScratchpad({ host, db })
  return { endpoints }
}
