// Consent ledger in the user's own DS-Bot (#489): terms/privacy/marketing/
// recording document versions, one grant/withdraw record per owner and version,
// current status, require-all gates and history. Data in
// /data/openteamily/features/consents/consents.sqlite3.
//
// The caller is always this DS-Bot's owner; a payload user_id is ignored, so a
// page or turn here cannot write a record for anyone else. Times are integer
// epoch seconds, like every other plugin feature (the owner's Python draft used
// the same integers; the deleted module never reached app.py or a route).
import { defineFeature } from '../../featurekit/feature.js'
import {
  SCHEMA, currentDocument, currentStatus, grant, listHistory, registerDocument, requireAll, withdraw,
} from './ledger.js'

const nowSec = () => Math.floor(Date.now() / 1000)
const body = (payload) => payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}

export default defineFeature({
  name: 'consents',
  migrations: [SCHEMA],
  endpoints: ({ store, owner }) => ({
    async register(payload) {
      const input = body(payload)
      return { document: registerDocument(store, input.kind, input.version, input.effective, nowSec()) }
    },
    // Which version is effective at ``at`` (default: now).
    async document(payload) {
      const input = body(payload)
      return { document: currentDocument(store, input.kind, input.at ?? nowSec()) }
    },
    async grant(payload) {
      const input = body(payload)
      return { record: grant(store, owner, input.kind, input.version, nowSec(), input.method === undefined ? 'web' : input.method, input.evidence ?? null) }
    },
    async withdraw(payload) {
      const input = body(payload)
      return { record: withdraw(store, owner, input.kind, input.version, nowSec()) }
    },
    // ``at`` applies the document effective time; without it the newest registered
    // document is the required version.
    async status(payload) {
      const input = body(payload)
      return currentStatus(store, owner, input.kind, input.at ?? null)
    },
    async history(payload) {
      const input = body(payload)
      return { items: listHistory(store, owner, input.kind ?? null) }
    },
    async 'require-all'(payload) {
      const input = body(payload)
      return { missing: requireAll(store, owner, input.kinds, input.at ?? nowSec()) }
    },
  }),
})
