// The independent context-budget capability: estimate, allocate and pack the
// context the OpenTeamily plugin assembles. It revises no DSH compaction, agent
// feature, runtime bridge or existing route.
import { contractDescription, estimateTokens, packContext, LIMITS } from './budget.js'
import { refuse } from '../../featurekit/http.js'

export default function agentContext(host) {
  return {
    endpoints: {
      contract: async () => contractDescription(),
      estimate: async (payload) => {
        const text = payload?.text
        if (typeof text !== 'string' || text.length > LIMITS.maxContentChars) {
          refuse(400, 'context/invalid', 'text must be a string within the content limit')
        }
        return { tokens: estimateTokens(text), chars: text.length }
      },
      pack: async (payload) => packContext(payload),
    },
  }
}
