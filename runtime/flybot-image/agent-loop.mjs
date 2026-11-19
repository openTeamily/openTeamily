// Poll the management /v1/agent task API from a FlyBot container.
// Uses the lease-injected runtime key file. Never writes the token to stdout.
import { readFileSync } from 'node:fs'

export const DEFAULT_KEY_FILE = '/run/secrets/openteamily-runtime-key.json'

export function loadRuntimeKey(env = process.env, reader = readFileSync) {
  const path = env.OPENTEAMILY_RUNTIME_KEY_FILE || DEFAULT_KEY_FILE
  let raw
  try {
    raw = reader(path, { encoding: 'utf8' })
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
  if (!raw || !raw.trim()) return null
  const doc = JSON.parse(raw)
  if (!doc || typeof doc !== 'object') throw new Error('runtime key file is invalid')
  const origin = String(doc.origin || '')
  const token = String(doc.token || '')
  const hostname = String(doc.hostname || '')
  if (!origin.startsWith('http') || !token || !hostname) throw new Error('runtime key file is incomplete')
  return { origin, token, hostname }
}

function redact(value) {
  return String(value || '').replace(/[A-Za-z0-9_-]{16,}/g, '[redacted]')
}

async function call(origin, token, method, path, body) {
  const response = await fetch(origin + path, {
    method,
    signal: AbortSignal.timeout(20000),
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let parsed = {}
  try { parsed = await response.json() } catch { parsed = {} }
  if (!response.ok) {
    const error = new Error('agent request failed')
    error.status = response.status
    throw error
  }
  return parsed
}

export async function infer(modelApi, prompt, bridge = null, fetcher = globalThis.fetch) {
  const base = String(modelApi.base_url || '').replace(/\/+$/, '')
  const messages = [{ role: 'user', content: prompt }]
  const tools = bridge ? (await bridge.discover()).tools || [] : []
  for (let round = 0; round < 5; round += 1) {
    const response = await fetcher(base + '/chat/completions', {
      method: 'POST', signal: AbortSignal.timeout(30000),
      headers: { 'Authorization': 'Bearer ' + modelApi.api_key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelApi.model, messages,
        ...(tools.length ? {tools, parallel_tool_calls: false} : {}) }),
    })
    const parsed = await response.json()
    const message = parsed?.choices?.[0]?.message
    if (!response.ok || !message) throw new Error('model provider returned an unexpected body')
    if (!message.tool_calls?.length) {
      if (typeof message.content !== 'string') throw new Error('model response has no text')
      return message.content
    }
    if (!bridge || message.tool_calls.length > 4) throw new Error('tool call limit exceeded')
    // Provider text and tool outputs are untrusted data, not authorization.
    messages.push({role: 'assistant', content: message.content || null, tool_calls: message.tool_calls})
    for (const call of message.tool_calls) {
      const name = call.function?.name
      if (!tools.some(t => t.function.name === name)) throw new Error('tool was not discovered')
      const args = JSON.parse(call.function.arguments)
      const result = await bridge.execute(call.id, name, args)
      messages.push({role: 'tool', tool_call_id: call.id, content: JSON.stringify(result)})
    }
  }
  throw new Error('tool round limit exceeded')
}

export function toolBridge(origin, token, task, requester = call, {
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => Date.now(),
} = {}) {
  const path = `/v1/agent/tasks/${task.id}/tools`
  return {
    discover: () => requester(origin, token, 'POST', path, {}),
    async execute(callId, name, args) {
      const proposal = await requester(origin, token, 'POST', path + '/calls', {call_id: callId, name, arguments: args})
      let result = proposal.call
      // Every call (reads too) needs an explicit owner approval in settings.
      // No provider mutation is retried after timeout/unknown result.
      const deadline = Math.min(now() + 40000, (task.deadline || now() / 1000 + 40) * 1000 - 1000)
      while (['pending', 'approved'].includes(result.status) && now() < deadline) {
        await wait(1000)
        await requester(origin, token, 'POST', '/v1/agent/heartbeat', {})
        result = (await requester(origin, token, 'POST', path + '/calls/' + result.id, {})).call
      }
      return result.result || {error: 'tool_' + result.status, note: 'Await owner approval in Settings > App connectors; no implicit retry.'}
    },
  }
}

export async function runCycle(config, { requester = call, inferer = infer, once = true } = {}) {
  const { origin, token, hostname } = config
  await requester(origin, token, 'POST', '/v1/agent/connect', { hostname })
  await requester(origin, token, 'POST', '/v1/agent/heartbeat', {})
  const listed = await requester(origin, token, 'GET', '/v1/agent/tasks')
  const processed = []
  for (const task of listed.items || []) {
    const claimed = await requester(origin, token, 'POST', `/v1/agent/tasks/${task.id}/claim`, {})
    const payload = claimed.task || task
    let status = 'failed'
    let result = { error: 'unsupported task kind' }
    let modelApi
    try {
      if (payload.kind === 'echo') {
        status = 'succeeded'
        result = { echo: payload.prompt }
      } else if (payload.kind === 'infer') {
        const access = await requester(origin, token, 'POST', `/v1/agent/tasks/${payload.id}/model-access`, {})
        modelApi = access.model_api
        const bridge = access.connected_tools ? toolBridge(origin, token, payload, requester) : null
        const text = await inferer(modelApi, payload.prompt, bridge)
        status = 'succeeded'
        result = { text, model: modelApi && modelApi.model, source: modelApi && modelApi.source }
      }
    } catch (error) {
      status = 'failed'
      result = { error: 'infer failed' }
    } finally {
      if (modelApi) delete modelApi.api_key
    }
    await requester(origin, token, 'POST', `/v1/agent/tasks/${payload.id}/result`, { status, result })
    processed.push(payload.id)
  }
  return processed
}

export async function main(env = process.env, log = console.error) {
  let config
  try {
    config = loadRuntimeKey(env)
  } catch (error) {
    log('agent-loop: ' + redact(error && error.message))
    return 1
  }
  if (!config) {
    log('agent-loop: no runtime key file; skip management task loop')
    return 0
  }
  const poll = Math.max(1, Number(env.OPENTEAMILY_AGENT_POLL || 2))
  const once = env.OPENTEAMILY_AGENT_ONCE === '1'
  try {
    do {
      await runCycle(config)
      if (once) return 0
      await new Promise(resolve => setTimeout(resolve, poll * 1000))
    } while (true)
  } catch (error) {
    log('agent-loop: ' + redact(error && error.message))
    return 1
  }
}

const entry = process.argv[1] ? process.argv[1].endsWith('agent-loop.mjs') : false
if (entry && import.meta.url.endsWith('agent-loop.mjs')) {
  main().then(code => { if (code) process.exit(code) }, () => process.exit(1))
}
