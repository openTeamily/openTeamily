// Outbound event subscriptions inside this user's DS-Bot (#490): create/read/
// update/disable/delete subscriptions, match an event against them, and keep an
// idempotent delivery record. No HTTP delivery, signing, retry or outbox here.
//
// deliberately narrow: no page calls these yet. A future /settings panel plus
// an outbox worker (which must recheck the resolved endpoint address before
// delivery) are separate slices.
import { defineFeature } from '../../featurekit/feature.js'
import {
  MIGRATIONS, createSubscription, deleteSubscription, deliveryStats, disableSubscription,
  getSubscription, listSubscriptions, matchingSubscriptions, recordDelivery, updateSubscription,
} from './registry.js'

export default defineFeature({
  name: 'events',
  migrations: MIGRATIONS,
  endpoints: (context) => {
    const { store } = context
    return {
      async create(payload) {
        return { subscription: createSubscription(store, payload) }
      },
      async get(payload) {
        return { subscription: getSubscription(store, payload?.id) }
      },
      async list(payload) {
        return { items: listSubscriptions(store, payload) }
      },
      async update(payload) {
        return { subscription: updateSubscription(store, payload) }
      },
      async disable(payload) {
        return { subscription: disableSubscription(store, payload?.id) }
      },
      async delete(payload) {
        return { deleted: deleteSubscription(store, payload?.id) }
      },
      async matches(payload) {
        return { items: matchingSubscriptions(store, payload?.event) }
      },
      async record(payload) {
        return { recorded: recordDelivery(store, payload) }
      },
      async stats(payload) {
        const id = payload?.subscription_id
        return id === undefined || id === null
          ? { items: deliveryStats(store) }
          : { stats: deliveryStats(store, id) }
      },
    }
  },
})
