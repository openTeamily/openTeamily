// Web Push subscription registry inside the owner's own DS-Bot (#466):
// register a browser endpoint, list/read this account's devices, revoke one.
// Data in /data/openteamily/features/push/push.sqlite3.
//
// The caller is always this DS-Bot's owner; a payload user_id is ignored. Times
// are integer epoch seconds, like every other plugin feature. Nothing here signs,
// encrypts or delivers a notification.
import { defineFeature } from '../../featurekit/feature.js'
import { SCHEMA, get, list, register, revoke } from './registry.js'

const nowSec = () => Math.floor(Date.now() / 1000)
const body = (payload) => payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}

export default defineFeature({
  name: 'push',
  migrations: [SCHEMA],
  endpoints: ({ store, owner }) => ({
    async register(payload) {
      return { subscription: register(store, owner, body(payload), nowSec()) }
    },
    async list() {
      return { items: list(store, owner) }
    },
    async get(payload) {
      return { subscription: get(store, owner, body(payload).id) }
    },
    async revoke(payload) {
      return revoke(store, owner, body(payload).id)
    },
  }),
})
