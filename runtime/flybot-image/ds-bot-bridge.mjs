// Native OpenTeamily services run inside the user's DS-Bot plugin. Its model
// provider holds a per-boot placeholder token and talks to this loopback proxy.
// Only the proxy resolves the user's model settings or the operator startup
// file and forwards the configured model name and secret to the upstream.
import { randomBytes } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { startOpenPart } from '../ds-bot-upstream/ds-bot/src/host/threads.js'
import { request as httpsRequest } from 'node:https'
import { STREAM_LIMIT, streamHttpTask, validateModelEndpoint } from './model-http-policy.mjs'
import { loadModelApi, redact } from './model-api.js'

export const MODEL_OVERRIDE = Symbol.for('openteamily.model-api.override')
export function userModelOverride(scope = globalThis) {
  const resolve = scope[MODEL_OVERRIDE]
  if (typeof resolve !== 'function') return null
  try { return resolve() || null } catch { return null }
}
export const PROVIDER = 'openteamily'
export const MODEL_ID = 'openteamily-model'
function modelInput(modelApi) {
  const model = String(modelApi?.model || '').toLowerCase()
  const isDeepSeekFlash = model === 'deepseek-flash' || model === 'deepseek-v4-flash-vision-exp'
    || /^deepseek-v4\.1-flash(?:-\d{4,8})?$/.test(model)
  return isDeepSeekFlash ? ['text','image'] : ['text']
}

function providerModel(input) {
  return {id:MODEL_ID,name:'OpenTeamily model',contextWindow:128000,maxTokens:8192,input}
}

export const DEFAULT_PORT = 18731
const BODY_LIMIT = 24 * 1024 * 1024

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > BODY_LIMIT) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value))
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': body.length, 'Cache-Control': 'no-store' })
  res.end(body)
}

// Forward one OpenAI chat-completions request to the configured upstream. The
// model name and credential always come from modelApi, never from DS-Bot.
export async function forwardModel(modelApi, raw, res, { httpRequester = httpRequest, httpsRequester = httpsRequest } = {}) {
  const httpTask = validateModelEndpoint(modelApi?.base_url, modelApi?.http_endpoint_grant)
  const base = httpTask ? modelApi.base_url : String(modelApi.base_url || '').replace(/\/+$/, '')
  let parsed
  try { parsed = JSON.parse(raw.toString('utf8')) } catch { return sendJson(res, 400, { error: { message: 'invalid JSON body' } }) }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return sendJson(res, 400, { error: { message: 'invalid body' } })
  parsed.model = modelApi.model
  const body = Buffer.from(JSON.stringify(parsed))
  const headers = {
    'Authorization': 'Bearer ' + modelApi.api_key,
    'Content-Type': 'application/json',
    'Accept': parsed.stream ? 'text/event-stream' : 'application/json',
    'Content-Length': body.length,
  }
  const relay = (status, upstreamHeaders, stream) => new Promise(resolve => {
    res.writeHead(status, { 'Content-Type': upstreamHeaders['content-type'] || 'application/json', 'Cache-Control': 'no-store' })
    let bytes = 0
    stream.on('data', chunk => { bytes += chunk.length; if (bytes > STREAM_LIMIT) stream.destroy(new Error('model response too large')) })
    res.on('close', () => { if (!res.writableFinished) stream.destroy() })
    stream.pipe(res)
    stream.on('end', resolve)
    stream.on('error', () => { res.destroy(); resolve() })
    stream.on('close', resolve)
  })
  const signal = AbortSignal.timeout(180000)
  if (httpTask) {
    return streamHttpTask(base, modelApi.http_endpoint_grant, { method: 'POST', redirect: 'error', headers, body, signal }, relay, httpRequester)
  }
  const url = new URL(base + '/chat/completions')
  const requester = url.protocol === 'https:' ? httpsRequester : httpRequester
  return new Promise((resolve, reject) => {
    const req = requester(url, { method: 'POST', headers, agent: false, signal }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400) { response.destroy(); reject(new Error('Model redirect rejected')); return }
      resolve(relay(response.statusCode, response.headers, response))
    })
    req.on('error', () => reject(new Error('model request failed')))
    req.end(body)
  })
}

// Loopback model server for the native DS-Bot provider.
export function createBridgeServer(state, { log = () => {}, forward = forwardModel } = {}) {
  return createServer(async (req, res) => {
    try {
      // Browsers attach Origin; nothing legitimate here does (DNS-rebinding guard).
      if (req.headers.origin !== undefined) return sendJson(res, 403, { error: { message: 'forbidden' } })
      const path = (req.url || '').split('?')[0]
      if (path === '/v1/models' && req.method === 'GET') {
        if (req.headers.authorization !== 'Bearer ' + state.token) return sendJson(res, 401, { error: { message: 'unauthorized' } })
        return sendJson(res, 200, { object: 'list', data: [{ id: MODEL_ID, object: 'model', owned_by: 'openteamily' }] })
      }
      if (path === '/v1/chat/completions' && req.method === 'POST') {
        if (req.headers.authorization !== 'Bearer ' + state.token) return sendJson(res, 401, { error: { message: 'unauthorized' } })
        const raw = await readBody(req)
        const modelApi = state.startupModel()
        if (!modelApi) return sendJson(res, 503, { error: { message: 'No model is configured for this OpenTeamily runtime yet.' } })
        try { await forward(modelApi, raw, res) } catch (error) {
          log('ds-bot-bridge: model upstream failed: ' + redact(error?.message || 'error'))
          if (!res.headersSent) sendJson(res, 502, { error: { message: 'upstream model request failed' } })
          else res.destroy()
        }
        return
      }
      sendJson(res, 404, { error: { message: 'not found' } })
    } catch (error) {
      if (!res.headersSent) sendJson(res, error?.status || 400, { error: { message: 'bad request' } })
    }
  })
}

// Wait for the DS-Bot turn that our requestId started; collect the Bot's text.
export function runTurn(rt, ctx, botId, text, requestId, timeoutMs = 170000, files = []) {
  return new Promise((resolve, reject) => {
    let sessionId
    let settled = false
    const parts = []
    let off = () => {}
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { off() } catch {}
      error ? reject(error) : resolve(value)
    }
    const timer = setTimeout(() => finish(new Error('DS-Bot turn timed out')), timeoutMs)
    const disposer = ctx.on('session/event', (session, event) => {
      if (settled) return
      if (event?.type === 'user/message' && event.data?.source?.rpcId === requestId) { sessionId = session.id; return }
      if (!sessionId || session?.id !== sessionId) return
      for (const item of rt.displayItems(session.id, [event]) ?? []) {
        if (item?.kind === 'bot' && typeof item.text === 'string' && item.text.trim()) parts.push(item.text)
      }
      if (event.type === 'turn/end') {
        const reply = parts.join('\n\n').trim()
        if (reply) finish(null, { text: reply, sessionId, turnId: event.data?.turnId ?? event.turnId ?? null })
        else finish(new Error(event.data?.error ? 'DS-Bot turn failed' : 'DS-Bot turn ended without a reply'))
      }
    })
    off = typeof disposer === 'function' ? disposer : () => disposer?.dispose?.()
    Promise.resolve(rt.sendUser({ sessionId: rt.chatOf(botId), content: [{ type: 'text', text }, ...files], requestId }))
      .catch(error => finish(error instanceof Error ? error : new Error('DS-Bot rejected the message')))
  })
}

export function createBridge(rt, { env = process.env, port } = {}) {
  const state = {
    token: randomBytes(24).toString('hex'),
    // The account's own model settings (B4 @openteamily/web model-api feature,
    // in-process, sealed at rest) win over the manager-mounted startup file.
    startupModel: () => { try { return userModelOverride() || loadModelApi(env) || null } catch { return null } },
  }
  const listenPort = port ?? (Number(env.OPENTEAMILY_BRIDGE_PORT) || DEFAULT_PORT)
  const baseURL = `http://127.0.0.1:${listenPort}/v1`
  let ready = null
  let hasImageInput
  let botId = null
  const chatsPath = join(env.DSH_HOME || '/data', 'openteamily-chats.json')
  let chats
  const loadChats = () => {
    if (chats) return chats
    try { chats = JSON.parse(readFileSync(chatsPath, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error; chats = {} }
    return chats
  }
  async function selectConversation(id) {
    if (!id) return
    const map = loadChats()
    if (map[id]) { await rt.switchPart(botId, map[id]); return }
    // Each OpenTeamily conversation gets a separate native DS-Bot chat/session.
    const bot = rt.botOf(botId)
    const freshId = await rt.createSession(bot.name, { dir: rt.workDirOf({ botId }) })
    startOpenPart(bot, freshId)
    rt.chatOwners.set(freshId, botId)
    await rt.save()
    await rt.applyModel(bot, { force: true })
    await rt.applyPermission(bot, freshId, undefined)
    map[id] = freshId
    writeFileSync(chatsPath + '.tmp', JSON.stringify(map), { mode: 0o600 })
    renameSync(chatsPath + '.tmp', chatsPath)
  }

  function effectiveInput() {
    return modelInput(state.startupModel())
  }

  async function saveInput(input) {
    await rt.saveProviderModels({provider:PROVIDER,models:[providerModel(input)]})
    hasImageInput = input.includes('image')
  }

  async function setup() {
    const input = effectiveInput()
    try {
      await rt.addProvider({ provider: PROVIDER, custom: true, api: 'openai-completions', name: 'OpenTeamily', baseURL,
        models:[providerModel(input)],key:state.token })
      hasImageInput = input.includes('image')
    } catch (error) {
      if (!/already set up/.test(String(error?.message))) throw error
      await rt.setProviderKey(PROVIDER,state.token)
      await saveInput(input)
    }
    await rt.bootstrap()
    botId = rt.state.mainBotIds.find(id => rt.botOf(id))
    if (!botId) throw new Error('DS-Bot has no Main Bot')
    // Remove the generated capability for the retired task MCP endpoint. The
    // native connector plugin manages its own separate capability (ot-apps).
    const retiredTools = rt.state.capabilities?.items?.['ot-tools']
    if (retiredTools?.kind === 'mcp' && retiredTools.transport === 'streamable-http'
      && /^http:\/\/127\.0\.0\.1:\d+\/mcp\?catalog=[a-f0-9]{16}$/.test(retiredTools.url)) {
      await rt.capabilityDelete('ot-tools', { ui: true })
    }
    const bot = rt.botOf(botId)
    if (!String(bot.model || '').endsWith('/' + MODEL_ID) && bot.model !== MODEL_ID) await rt.updateBot(botId, { model: MODEL_ID })
    return botId
  }
  const ensureSetup = () => (ready ??= setup().catch(error => { ready = null; throw error }))

  async function prepareModel() {
    await ensureSetup()
    const input = effectiveInput()
    if (input.includes('image') !== hasImageInput) await saveInput(input)
  }

  // Native turns share a queue because they switch the active DS-Bot part.
  let turnQueue = Promise.resolve()
  function exclusive(fn) {
    const run = turnQueue.then(() => fn())
    turnQueue = run.catch(() => {})
    return run
  }
  return {
    state, setup: ensureSetup, prepareModel, exclusive, selectConversation,
    legacySession: key => loadChats()[key], port: listenPort, baseURL, get botId() { return botId },
  }
}

// Plugin entry: start the model proxy on the loopback interface.
export function startBridge(rt, ctx, options = {}) {
  const log = options.log ?? console.error
  const bridge = createBridge(rt, options)
  const server = createBridgeServer(bridge.state, { log })
  server.on('error', error => log('ds-bot-bridge: loopback server error: ' + redact(error?.message || 'error')))
  server.listen(bridge.port, '127.0.0.1')
  const dispose = () => server.close()
  ctx.on?.('dispose', dispose)
  return { bridge, server, dispose }
}
