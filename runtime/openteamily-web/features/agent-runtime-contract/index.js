// The first OpenTeamily Agent Runtime capability: a stable event contract.
//
// This feature is intentionally read-only and stateless. It exposes the
// contract description and lets a caller normalize DSH session events or
// assistant-stream frames without touching the Agents feature, the runtime
// bridge, or any existing route. Later runtime features persist these events.
import {
  contractDescription,
  normalizeEvents,
  normalizeStream,
} from '../../lib/agent-runtime/contract.js'

export default function agentRuntimeContract(host) {
  return {
    endpoints: {
      contract: async () => contractDescription(),
      normalize: async (payload) => normalizeEvents(payload),
      normalizeStream: async (payload) => normalizeStream(payload),
    },
  }
}
