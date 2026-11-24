// The independent guardrail capability: provenance/taint and DSH tool
// authorization decisions. It does not execute tools, transport approvals,
// detect DLP/injection or change any existing agent turn.
import { HEX32, refuse } from '../../featurekit/http.js'
import { classifySources, contractDescription, DEFAULT_POLICY, evaluateGuardrail } from './policy.js'

const validWorkspace = (value) => typeof value === 'string' && HEX32.test(value)

async function canAccess(host, workspace) {
  const binding = await host.call('agents/personal-binding', {}).catch(() => null)
  if (binding?.workspace_id === workspace) return true
  const teams = await host.call('teams/activeWorkspaces', {}).catch(() => [])
  return Array.isArray(teams) && teams.some(team => team?.id === workspace)
}

async function requireWorkspace(host, workspace) {
  if (!validWorkspace(workspace)) refuse(400, 'invalid', 'workspace_id must be 32 lowercase hex characters')
  if (!await canAccess(host, workspace)) refuse(404, 'not_found', 'Workspace not found')
  return workspace
}

export default function agentGuardrails(host) {
  return {
    endpoints: {
      async evaluate(payload) {
        await requireWorkspace(host, payload?.workspace_id)
        return evaluateGuardrail(payload)
      },

      async classify(payload) {
        await requireWorkspace(host, payload?.workspace_id)
        return classifySources(payload?.sources ?? [])
      },

      async policy(payload) {
        await requireWorkspace(host, payload?.workspace_id)
        return { policy: { ...DEFAULT_POLICY } }
      },

      async contract() {
        return contractDescription()
      },
    },
  }
}
