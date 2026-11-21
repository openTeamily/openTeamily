import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { EventEmitter, once } from 'node:events'
import { PassThrough } from 'node:stream'
import {
  createBridge, createBridgeServer, forwardModel, runTurn, startBridge, MODEL_ID,
  userModelOverride, MODEL_OVERRIDE,
} from '../runtime/flybot-image/ds-bot-bridge.mjs'

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
const close = server => new Promise(resolve => server.close(resolve))

test('loopback proxy uses the configured model and key; DS-Bot holds a per-boot token', async () => {
  const seen = []
  const upstream = createServer((req, res) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      seen.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(raw) })
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n')
    })
  })
  const upstreamPort = await listen(upstream)
  const modelApi = { base_url: `http://127.0.0.1:${upstreamPort}/v1`, model: 'real-model', api_key: 'synthetic-model-key' }
  let model = modelApi
  const state = { token: 'placeholder-token', startupModel: () => model }
  const proxy = createBridgeServer(state)
  const port = await listen(proxy)
  const url = `http://127.0.0.1:${port}`
  try {
    assert.equal((await fetch(url + '/v1/chat/completions', { method: 'POST', body: '{}' })).status, 401)
    const models = await (await fetch(url + '/v1/models', { headers: { authorization: 'Bearer placeholder-token' } })).json()
    assert.equal(models.data[0].id, MODEL_ID)
    const response = await fetch(url + '/v1/chat/completions', { method: 'POST',
      headers: { authorization: 'Bearer placeholder-token', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL_ID, stream: true, messages: [{ role: 'user', content: 'x' }] }) })
    assert.equal(response.status, 200)
    assert.match(await response.text(), /\[DONE\]/)
    assert.equal(seen[0].path, '/v1/chat/completions')
    assert.equal(seen[0].auth, 'Bearer synthetic-model-key')
    assert.equal(seen[0].body.model, 'real-model')
    assert.equal((await fetch(url + '/mcp', { method: 'POST', body: '{}' })).status, 404)
    model = null
    const idle = await fetch(url + '/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer placeholder-token' }, body: '{}' })
    assert.equal(idle.status, 503)
  } finally { await close(proxy); await close(upstream) }
})

test('exact-HTTP grant: redirects are rejected and only the granted path is used', async () => {
  const base = 'http://8.8.8.8:8080/v1'
  const modelApi = { base_url: base, model: 'm', api_key: 'k', http_endpoint_grant: { base_url: base, format: 'openteamily.exact-http-task.v1' } }
  const requests = []
  const fake = status => (options, onResponse) => {
    requests.push(options)
    const req = new EventEmitter()
    req.end = () => {
      const response = new PassThrough()
      response.statusCode = status
      response.headers = { 'content-type': 'application/json' }
      onResponse(response)
      response.end('{"ok":true}')
    }
    req.destroy = () => {}
    return req
  }
  const res = { headersSent: false, writeHead() { this.headersSent = true }, destroy() {}, chunks: [] }
  await assert.rejects(forwardModel(modelApi, Buffer.from('{}'), res, { httpRequester: fake(302) }), /redirect/)
  assert.equal(requests[0].path, '/v1/chat/completions')
  assert.equal(requests[0].agent, false)
  assert.equal(requests[0].family, 4)
  const wrong = { ...modelApi, http_endpoint_grant: { base_url: 'http://8.8.4.4:8080/v1', format: 'openteamily.exact-http-task.v1' } }
  await assert.rejects(forwardModel(wrong, Buffer.from('{}'), res, { httpRequester: fake(200) }), /grant/)
})

function fakeRuntime() {
  const ctx = new EventEmitter()
  const on = ctx.on.bind(ctx)
  ctx.on = (name, fn) => { on(name, fn); return () => ctx.off(name, fn) }
  const log = []
  let bridgeState
  const bot = { id: 'bot1', model: undefined }
  const rt = {
    state: { mainBotIds: ['bot1'] },
    botOf: id => (id === 'bot1' ? bot : undefined),
    chatOf: () => 'chat1',
    addProvider: async body => { log.push(['addProvider', body.provider, body.baseURL, body.key === bridgeState.token]) },
    setProviderKey: async () => {},
    bootstrap: async () => { log.push(['bootstrap']) },
    updateBot: async (id, patch) => { log.push(['updateBot', patch.model]); bot.model = 'openteamily/' + patch.model },
    capabilityDelete: async (name, opts) => {
      log.push(['delete', name, opts.ui])
      delete rt.state.capabilities.items[name]
    },
    displayItems: (_sid, [event]) => (event.type === 'assistant/message' ? [{ kind: 'bot', text: event.data.text }] : []),
    sendUser: async ({ sessionId, content, requestId }) => {
      log.push(['sendUser', sessionId, content[0].text, requestId])
      setImmediate(() => {
        const session = { id: sessionId }
        ctx.emit('session/event', session, { type: 'turn/start' })
        ctx.emit('session/event', session, { type: 'user/message', data: { source: { rpcId: requestId } } })
        ctx.emit('session/event', session, { type: 'assistant/message', data: { text: 'reply from DS-Bot' } })
        ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 't1' } })
      })
    },
  }
  return { rt, ctx, log, bind: state => { bridgeState = state } }
}

test('the DeepSeek Flash vision model updates a retained provider and follows account changes', async () => {
  const fake = fakeRuntime()
  const bridge = createBridge(fake.rt, { port: 1 })
  fake.bind(bridge.state)
  let model = 'DeepSeek-V4.1-Flash-1017'
  bridge.state.startupModel = () => ({model})
  fake.rt.addProvider = async () => { throw new Error('openteamily is already set up') }
  const updates = []
  fake.rt.saveProviderModels = async ({provider,models}) => updates.push([provider,models[0].input])
  await bridge.prepareModel()
  await bridge.prepareModel()
  assert.deepEqual(updates,[['openteamily',['text','image']]])
  model = 'another-text-only-model'
  await bridge.prepareModel()
  model = 'deepseek-flash'
  await bridge.prepareModel()
  assert.deepEqual(updates,[
    ['openteamily',['text','image']], ['openteamily',['text']], ['openteamily',['text','image']],
  ])
})

test('a provisioned DS-Bot starts its native proxy and runs a turn without polling retired routes', async t => {
  const origins = []
  const management = createServer((req, res) => {
    origins.push(req.url)
    res.writeHead(410).end('{}')
  })
  const managementPort = await listen(management)
  t.after(async () => { management.closeAllConnections(); await close(management) })
  const home = mkdtempSync(join(tmpdir(), 'ot-native-only-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const keyFile = join(home, 'runtime-key.json')
  writeFileSync(keyFile, JSON.stringify({
    origin: 'http://127.0.0.1:' + managementPort,
    token: 'synthetic-runtime-key', hostname: 'native-fixture',
  }))
  const fake = fakeRuntime()
  const rt = fake.rt
  rt.state.capabilities = { items: {
    'ot-tools': { kind: 'mcp', transport: 'streamable-http', url: 'http://127.0.0.1:18731/mcp?catalog=0123456789abcdef' },
    'ot-apps': { kind: 'mcp', transport: 'streamable-http', url: 'http://127.0.0.1:3022/mcp' },
  } }
  const value = startBridge(rt, fake.ctx, {
    env: { DSH_HOME: home, OPENTEAMILY_RUNTIME_KEY_FILE: keyFile },
    port: 0,
    log: () => {},
  })
  t.after(async () => {
    const stopped = once(value.server, 'close')
    value.dispose()
    value.server.closeAllConnections()
    await stopped
  })
  fake.bind(value.bridge.state)
  await once(value.server, 'listening')
  const models = await fetch('http://127.0.0.1:' + value.server.address().port + '/v1/models', {
    headers: { authorization: 'Bearer ' + value.bridge.state.token },
  })
  assert.equal(models.status, 200)
  const turn = await value.bridge.exclusive(async () => {
    await value.bridge.prepareModel()
    return runTurn(rt, fake.ctx, value.bridge.botId, 'native hello', 'native-fixture')
  })
  assert.equal(turn.text, 'reply from DS-Bot')
  assert.deepEqual(fake.log.find(entry => entry[0] === 'sendUser'), ['sendUser', 'chat1', 'native hello', 'native-fixture'])
  assert.deepEqual(fake.log.filter(entry => entry[0] === 'delete'), [['delete', 'ot-tools', true]])
  assert.deepEqual(Object.keys(rt.state.capabilities.items), ['ot-apps'])
  assert.deepEqual(origins, [])
})

test('separate conversations use separate native DS-Bot threads and reuse persisted mapping', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ot-chats-'))
  const fake = fakeRuntime()
  const bot = fake.rt.botOf('bot1')
  let created = 0
  fake.rt.chatOf = () => bot.sessionId || bot.id
  fake.rt.createSession = async () => 'session-' + (++created)
  fake.rt.workDirOf = () => '/data/workspace'
  fake.rt.chatOwners = new Map()
  fake.rt.save = async () => {}
  fake.rt.applyModel = async () => {}
  fake.rt.applyPermission = async () => {}
  fake.rt.switchPart = async (_id, sid) => { bot.sessionId = sid }
  const bridge = createBridge(fake.rt, { env: { DSH_HOME: home }, port: 1 })
  fake.bind(bridge.state)
  try {
    await bridge.setup()
    await bridge.selectConversation('conv-a')
    const a = fake.rt.chatOf('bot1')
    await bridge.selectConversation('conv-b')
    assert.notEqual(fake.rt.chatOf('bot1'), a)
    await bridge.selectConversation('conv-a')
    assert.equal(fake.rt.chatOf('bot1'), a)
    const restarted = createBridge(fake.rt, { env: { DSH_HOME: home }, port: 1 })
    fake.bind(restarted.state)
    await restarted.setup()
    await restarted.selectConversation('conv-a')
    assert.equal(fake.rt.chatOf('bot1'), a)
    assert.equal(created, 2)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('B4: the account model override from @openteamily/web wins, failures fall back to none', () => {
  const scope = {}
  assert.equal(userModelOverride(scope), null)
  scope[MODEL_OVERRIDE] = () => ({ provider: 'openai', base_url: 'https://models.example/v1', model: 'm', api_key: 'k'.repeat(12), source: 'user' })
  assert.equal(userModelOverride(scope).source, 'user')
  scope[MODEL_OVERRIDE] = () => { throw new Error('sealed value is corrupt') }
  assert.equal(userModelOverride(scope), null)
  scope[MODEL_OVERRIDE] = () => null
  assert.equal(userModelOverride(scope), null)
})
