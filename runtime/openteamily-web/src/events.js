// GET /api/openteamily/events?workspace=<32 hex>
//
// The moved-page live-update stream, served by this user's own DS-Bot. DSH
// authenticates the browser session before this route runs; the plugin is a
// single-owner runtime, so the workspace id only scopes browser bookkeeping.
//
// The browser contract is the legacy one from openteamily/events.py: bounded
// SSE `invalidate` events carrying a 64-hex version and 64-hex domain
// fingerprints, `renew` at lease end, plus heartbeat/comment lines. This is an
// invalidation source, never message or token replay. It adapts the DS-Bot live
// feed (`hello`/`revision`/`live`/`message`/`room`/`notice`) and deliberately
// ignores `stream` token deltas.
import { createHash } from 'node:crypto'
import { currentRuntime, runtime as waitForRuntime } from './host.js'

export const EVENTS_PATH = '/api/openteamily/events'
export const MAX_QUEUED = 64
const WORKSPACE = /^[0-9a-f]{32}$/
const DOMAINS = ['social', 'artifacts', 'notifications']
const FEED_DOMAINS = {
  revision: DOMAINS,
  live: DOMAINS,
  message: ['social'],
  room: ['social'],
  notice: ['notifications'],
}
const encoder = new TextEncoder()
const hash = (value) => createHash('sha256').update(String(value)).digest('hex')

function failure(status, code, message) {
  return new Response(JSON.stringify({ error: { code, message, details: {} } }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

// runtime getters are injectable so the route can fail closed in tests and in a
// runtime that has not attached its DS-Bot handle yet.
export function createEventsHandler({
  getRuntime = currentRuntime,
  waitRuntime = waitForRuntime,
  waitTimeoutMs = 2_000,
  leaseMs = 20_000,
  heartbeatMs = 5_000,
} = {}) {
  return async (request) => {
    const url = new URL(request.url)
    if (request.method !== 'GET') return failure(405, 'method', 'Events require GET')
    for (const key of url.searchParams.keys()) {
      if (key !== 'workspace') return failure(400, 'invalid', 'Unknown events query parameter')
    }
    const workspace = url.searchParams.get('workspace') || ''
    if (!WORKSPACE.test(workspace)) return failure(400, 'invalid', 'workspace must be 32 lowercase hex characters')

    let runtime = getRuntime()
    if (!runtime) {
      try { runtime = await waitRuntime({ timeoutMs: waitTimeoutMs }) } catch { runtime = null }
    }
    if (!runtime || typeof runtime.subscribeFeed !== 'function') {
      // Never silently fall back to the platform: the page is on this DS-Bot.
      return failure(503, 'runtime-unavailable', 'DS-Bot live updates are not available')
    }
    return stream(runtime, request, { leaseMs, heartbeatMs })
  }
}

function stream(rt, request, { leaseMs, heartbeatMs }) {
  let controller
  let closed = false
  let counter = 0
  let heartbeat
  let lease
  let unsubscribe = () => {}

  const close = () => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    clearTimeout(lease)
    try { unsubscribe() } catch { /* feed taps are isolated */ }
    try { controller?.close() } catch { /* already closed or errored */ }
  }
  const raw = (text) => {
    if (closed) return
    if ((controller?.desiredSize ?? 0) < -MAX_QUEUED) { close(); return }
    try { controller.enqueue(encoder.encode(text)) } catch { close() }
  }
  const invalidate = (domains) => {
    const tick = ++counter
    const data = {
      version: hash(tick),
      domains: Object.fromEntries(domains.map((domain) => [domain, hash(domain + ':' + tick)])),
    }
    raw(`id: ${data.version}\nevent: invalidate\ndata: ${JSON.stringify(data)}\n\n`)
  }

  const body = new ReadableStream({
    start(own) {
      controller = own
      raw('retry: 3000\n: connected\n\n')
      invalidate(DOMAINS)
      try {
        unsubscribe = rt.subscribeFeed((event) => {
          const domains = FEED_DOMAINS[event]
          if (domains) invalidate(domains)
        })
      } catch {
        raw('event: unavailable\ndata: {"code":"temporarily_unavailable"}\n\n')
        close()
        return
      }
      heartbeat = setInterval(() => raw(': heartbeat\n\n'), heartbeatMs)
      heartbeat.unref?.()
      lease = setTimeout(() => {
        raw('event: renew\ndata: {}\n\n')
        close()
      }, leaseMs)
      request.signal?.addEventListener('abort', close, { once: true })
    },
    cancel() { close() },
  })
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    },
  })
}
