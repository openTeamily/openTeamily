// Memory feature (stream B3): memory pages, revisions/restore, export, 做梦,
// actions, links, graph, profile and preferences run inside this user's DS-Bot;
// data in /data/openteamily/features/memory.
// memory/pages serves chat recall (#378) in-process via host.call;
// memory/personal gives the owner's preferences and profile for DS-Bot turns.
import { defineFeature } from '../../featurekit/feature.js'
import { IMPORT_TABLES, MIGRATIONS } from './schema.js'
import { allPages, recallAcrossWorkspaces, routes as pageRoutes, search } from './pages.js'
import { personal, routes as extraRoutes } from './extras.js'
import { actor } from './common.js'
import { captureRoutes, captureWorker } from './capture.js'
import { actionDraftRoutes } from './action-drafts.js'

export default defineFeature({
  name: 'memory',
  pages: ['memory'],
  migrations: MIGRATIONS,
  importTables: IMPORT_TABLES,
  routes: [...actionDraftRoutes, ...extraRoutes, ...pageRoutes, ...captureRoutes],
  search,
  endpoints: ({ store, owner, host }) => ({
    ...captureWorker({store,host}),
    async pages(payload) { return allPages(store, payload) },
    async recallAcrossWorkspaces(payload,call) {
      if (!call?.internal) throw Object.assign(new Error('Internal endpoint'),{code:'memory/not-found'})
      return recallAcrossWorkspaces(store,host,payload)
    },
    async personal(payload) { return personal(store, actor({ store, owner }), payload) },
  }),
})
