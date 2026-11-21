// DSH plugin entry: OpenTeamily inside the user's own DS-Bot.
// Registers two exact, DSH-authenticated Fetch routes on the shared /api channel:
//   GET  /api/openteamily/page?path=/chat/   the OpenTeamily pages bundled in the image
//   POST /api/openteamily                    {endpoint: '<feature>/<op>', payload}
// DSH applies its Host/Origin fence and browser-session authentication before
// either handler runs; this plugin adds no authentication bypass of its own.
// Features: features/<name>/index.js (src/features.js), never edits to this file.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPageHandler, PAGE_PATH } from './src/pages.js'
import { createDispatch, API_PATH, createGatewayDispatch, GATEWAY_PATH, createLegacyDispatch, LEGACY_PATH } from './src/dispatch.js'
import { loadIdentity } from './src/identity.js'
import { loadFeatures } from './src/features.js'

export const name = 'openteamily-web'
export const inject = ['connection']

const HERE = dirname(fileURLToPath(import.meta.url))

export function apply(ctx, config = {}) {
  if (!ctx?.connection?.fetch?.register || !ctx?.effect) {
    throw new Error('openteamily-web: dsh connection fetch registry is required')
  }
  const dataDir = config.dataDir ?? process.env.DSH_HOME ?? '/data'
  const identity = loadIdentity({ env: process.env, dataDir })
  const pagesDir = config.pagesDir ?? join(HERE, 'pages')
  const features = loadFeatures({ dir: config.featuresDir ?? join(HERE, 'features'), identity, dataDir })
  const page = createPageHandler({
    pagesDir, identity,
    async getSystemLanguage() {
      const { table } = await features
      const result = await table['settings/get']?.()
      return result?.settings?.values?.language
    },
  })
  const dispatch = createDispatch({ endpoints: async () => (await features).table })
  ctx.effect(() => ctx.connection.fetch.register({
    path: PAGE_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: page,
  }), 'openteamily-web: page route')
  ctx.effect(() => ctx.connection.fetch.register({
    path: API_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: dispatch,
  }), 'openteamily-web: api route')
  // External Agent API: the platform forwards /v1/gateway/* here (cookie = this
  // DS-Bot's launch session; token = X-OT-Gateway-Token, already bound to this instance).
  ctx.effect(() => ctx.connection.fetch.register({
    path: GATEWAY_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: createGatewayDispatch({ endpoints: async () => (await features).table }),
  }), 'openteamily-web: external agent api')
  ctx.effect(() => ctx.connection.fetch.register({
    path: LEGACY_PATH,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    requestBody: 'buffered',
    fetch: createLegacyDispatch({ endpoints: async () => (await features).table }),
  }), 'openteamily-web: legacy /v1')
  return { identity, features }
}

export { attachRuntime } from './src/host.js'
