// Always-on agent rule/event/run core inside the owner's own DS-Bot (#390):
// save/list/remove rules, record events, evaluate them into queued runs, lease
// and finish runs, and record one bounded message per run.
// Data in /data/openteamily/features/proactive/proactive.sqlite3.
//
// The caller is always this DS-Bot's owner: a payload workspace_id is ignored
// and every row is scoped to ownerId(). Nothing here calls a model, runs a
// container or delivers a notification; that worker is a later slice.
import { defineFeature } from '../../featurekit/feature.js'
import {
  SCHEMA, claimRuns, completeRun, evaluate, failRun, listMessages, listRules, recordEvent,
  recordMessage, removeRule, saveRule,
} from './registry.js'

const nowSec = () => Math.floor(Date.now() / 1000)
const body = (payload) => payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}

export default defineFeature({
  name: 'proactive',
  migrations: [SCHEMA],
  endpoints: ({ store, owner }) => ({
    async 'save-rule'(payload) {
      return { rule: saveRule(store, owner, body(payload).rule, nowSec()) }
    },
    async rules() {
      return { items: listRules(store, owner) }
    },
    async 'remove-rule'(payload) {
      return { removed: removeRule(store, owner, body(payload).id) }
    },
    async 'record-event'(payload) {
      return { event: recordEvent(store, owner, body(payload), nowSec()) }
    },
    async evaluate(payload) {
      const budget = body(payload).budget
      return { runs: evaluate(store, owner, nowSec(), budget === undefined ? 100 : budget) }
    },
    async claim(payload) {
      const input = body(payload)
      return { runs: claimRuns(store, owner, nowSec(), input.limit, input.lease_seconds) }
    },
    async complete(payload) {
      const input = body(payload)
      return { run: completeRun(store, owner, input.run_id, input.status, input.result, nowSec()) }
    },
    async fail(payload) {
      const input = body(payload)
      const retryable = input.retryable === undefined ? true : input.retryable
      return { run: failRun(store, owner, input.run_id, input.error, nowSec(), retryable) }
    },
    async 'record-message'(payload) {
      return { message: recordMessage(store, owner, body(payload), nowSec()) }
    },
    async messages(payload) {
      const input = body(payload)
      return { items: listMessages(store, owner, input.limit === undefined ? 100 : input.limit, input.cursor ?? null) }
    },
  }),
})
