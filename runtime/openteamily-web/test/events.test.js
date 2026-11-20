import assert from 'node:assert/strict'
import test from 'node:test'
import { createEventsHandler, EVENTS_PATH } from '../src/events.js'

const WS = 'a'.repeat(32)
const URL = `http://10.0.0.2:8080${EVENTS_PATH}?workspace=${WS}`
const HEX64 = /^[a-f0-9]{64}$/

function frames(response) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const timeout = () => new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for SSE')), 1500)
    timer.unref?.()
  })
  return {
    async next(name) {
      for (;;) {
        const end = buffer.indexOf('\n\n')
        if (end !== -1) {
          const frame = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          if (!frame.trim()) continue
          const event = /^event: (.+)$/m.exec(frame)?.[1]
          const data = /^data: (.+)$/m.exec(frame)?.[1]
          if (name && event !== name) continue
          return { frame, event, data: data ? JSON.parse(data) : null }
        }
        const read = await Promise.race([reader.read(), timeout()])
        if (read.done) throw new Error('stream ended')
        buffer += decoder.decode(read.value, { stream: true })
      }
    },
    cancel() { return reader.cancel() },
  }
}

test('moved-page invalidations come from the DS-Bot feed, not the platform', async () => {
  let tap
  let unsubscribed = 0
  const runtime = {
    subscribeFeed(listener) {
      tap = listener
      return () => { unsubscribed++ }
    },
  }
  const handler = createEventsHandler({ getRuntime: () => runtime })
  const response = await handler(new Request(URL))
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^text\/event-stream/)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('x-accel-buffering'), 'no')

  const stream = frames(response)
  const initial = await stream.next('invalidate')
  assert.match(initial.data.version, HEX64)
  assert.deepEqual(Object.keys(initial.data.domains).sort(), ['artifacts', 'notifications', 'social'])
  for (const value of Object.values(initial.data.domains)) assert.match(value, HEX64)

  tap('message', { botId: 'b'.repeat(32), item: { id: 'm' } })
  const message = await stream.next('invalidate')
  assert.deepEqual(Object.keys(message.data.domains), ['social'])
  assert.match(message.data.version, HEX64)
  assert.match(message.data.domains.social, HEX64)
  assert.notEqual(message.data.domains.social, initial.data.domains.social)

  // Token deltas are not replayed and must not cause a browser refresh.
  tap('stream', { text: 'secret token' })
  tap('notice', {})
  const notice = await stream.next('invalidate')
  assert.deepEqual(Object.keys(notice.data.domains), ['notifications'])

  await stream.cancel()
  assert.equal(unsubscribed, 1)
})

test('the stream keeps the legacy lease/renew contract', async () => {
  const runtime = { subscribeFeed() { return () => {} } }
  const handler = createEventsHandler({ getRuntime: () => runtime, leaseMs: 40, heartbeatMs: 1000 })
  const stream = frames(await handler(new Request(URL)))
  await stream.next('invalidate')
  const renew = await stream.next('renew')
  assert.deepEqual(renew.data, {})
  await stream.cancel()
})

test('an unavailable runtime fails closed instead of using the platform stream', async () => {
  const handler = createEventsHandler({
    getRuntime: () => null,
    waitRuntime: async () => { throw Object.assign(new Error('not attached'), { code: 'openteamily/runtime-unavailable' }) },
  })
  const response = await handler(new Request(URL))
  assert.equal(response.status, 503)
  assert.equal((await response.json()).error.code, 'runtime-unavailable')

  const noFeed = createEventsHandler({ getRuntime: () => ({ rt: {}, ctx: {} }) })
  assert.equal((await noFeed(new Request(URL))).status, 503)
})

test('refuses wrong methods, missing workspaces and unknown query fields', async () => {
  const handler = createEventsHandler({ getRuntime: () => ({ subscribeFeed() { return () => {} } }) })
  assert.equal((await handler(new Request(URL, { method: 'POST' }))).status, 405)
  assert.equal((await handler(new Request(`http://10.0.0.2:8080${EVENTS_PATH}`))).status, 400)
  assert.equal((await handler(new Request(`http://10.0.0.2:8080${EVENTS_PATH}?workspace=${WS}&x=1`))).status, 400)
  assert.equal((await handler(new Request(`http://10.0.0.2:8080${EVENTS_PATH}?workspace=../x`))).status, 400)
})
