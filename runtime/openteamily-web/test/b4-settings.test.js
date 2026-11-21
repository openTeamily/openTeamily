// B4 batch: settings, notification prefs (#284), onboarding and look run in
// the user's own DS-Bot plugin with the legacy /v1 contract.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import { API_PATH } from '../src/dispatch.js'
import { compatHandler } from '../lib/b4/compat.js'
import { createSettingsFeature, migrate, normalizeChanges, recommendedTemplateIds } from '../features/settings/settings.js'

const dataDir = () => mkdtempSync(join(tmpdir(), 'ot-b4-settings-'))
const feature = (dir = dataDir(), clock = () => 1000) => createSettingsFeature({ dir, clock })
const compat = f => compatHandler(f.legacy)
const call = (f, method, path, body, query = '') => compat(f)({ method, path, body, query })

test('settings: defaults, save, idempotent save and revision conflict', async () => {
  const f = feature()
  const first = await call(f, 'GET', '/v1/settings')
  assert.equal(first.status, 200)
  assert.equal(first.body.settings.revision, 0)
  assert.equal(first.body.settings.values.language, 'zh-CN')
  assert.equal(first.body.settings.values.chat_language, 'auto')
  const saved = await call(f, 'POST', '/v1/settings', { revision: 0, changes: { appearance: 'dark', chat_language: 'en' } })
  assert.equal(saved.status, 200)
  assert.deepEqual([saved.body.settings.revision, saved.body.settings.values.appearance], [1, 'dark'])
  assert.equal(f.chatLanguage(), 'en')
  const same = await call(f, 'POST', '/v1/settings', { revision: 1, changes: { appearance: 'dark' } })
  assert.equal(same.body.settings.revision, 1, 'unchanged values do not bump the revision')
  const stale = await call(f, 'POST', '/v1/settings', { revision: 0, changes: { appearance: 'light' } })
  assert.equal(stale.status, 409)
  assert.equal(stale.body.error.code, 'conflict')
  assert.equal(stale.body.error.current.revision, 1)
  for (const bad of [{ revision: 1, changes: {} }, { revision: 1, changes: { appearance: 'neon' } }, { revision: -1, changes: { appearance: 'dark' } },
    { revision: true, changes: { appearance: 'dark' } }, { revision: 1, changes: { appearance: 'dark' }, extra: 1 }, { revision: 1, changes: { appearance_start: '24:00' } }]) {
    const res = await call(f, 'POST', '/v1/settings', bad)
    assert.equal(res.status, 400, JSON.stringify(bad))
  }
  assert.equal((await call(f, 'GET', '/v1/settings', undefined, 'x=1')).status, 400)
})

test('settings: legacy aliases and stored-document migration match settings.py', () => {
  assert.deepEqual(normalizeChanges({ fold_long_messages: false }), { message_folding: 'none' })
  assert.deepEqual(normalizeChanges({ likes_visibility: 'private' }), { likes_visible: false })
  assert.equal(normalizeChanges({ fold_long_messages: true, message_folding: 'none' }), null)
  assert.deepEqual(migrate({ fold_long_messages: true, favorites_visibility: 'everyone', junk: 1, language: 'xx' }), { message_folding: 'standard', favorites_visible: true })
})

test('settings: persisted on the volume, private file, survives a restart', async () => {
  const dir = dataDir()
  const f = feature(dir)
  await call(f, 'POST', '/v1/settings', { revision: 0, changes: { send_shortcut: 'mod_enter' } })
  assert.equal(statSync(f.store.file).mode & 0o777, 0o600)
  const again = feature(dir)
  assert.equal((await call(again, 'GET', '/v1/settings')).body.settings.values.send_shortcut, 'mod_enter')
})

test('notification prefs (#284 port): defaults on, PUT validates and persists', async () => {
  const f = feature()
  const initial = await call(f, 'GET', '/v1/notification-prefs')
  assert.deepEqual(initial.body.prefs, { mentions: true, task_completion: true, artifacts: true })
  assert.deepEqual(initial.body.categories.map(c => c.key), ['mentions', 'task_completion', 'artifacts'])
  const off = await call(f, 'PUT', '/v1/notification-prefs', { changes: { mentions: false } })
  assert.equal(off.status, 200)
  assert.equal(off.body.prefs.mentions, false)
  assert.equal((await call(f, 'PUT', '/v1/notification-prefs', { changes: { spam: true } })).status, 400)
  assert.equal((await call(f, 'PUT', '/v1/notification-prefs', { changes: { mentions: 'no' } })).status, 400)
  assert.equal((await call(f, 'POST', '/v1/notification-prefs', { changes: { mentions: true } })).status, 405)
})

test('onboarding: create 201 then update 200, steps and look validation', async () => {
  const f = feature()
  const empty = await call(f, 'GET', '/v1/onboarding')
  assert.equal(empty.body.onboarding, null)
  assert.ok(empty.body.industries.length > 10)
  assert.equal(empty.body.steps.apps.every(app => app.connected === false), true)
  const created = await call(f, 'POST', '/v1/onboarding', { industry: ' 教育 ', role: '研究员', completed: false })
  assert.equal(created.status, 201)
  assert.equal(created.body.onboarding.industry, '教育')
  const updated = await call(f, 'POST', '/v1/onboarding', { industry: '教育', role: '研究员', completed: true })
  assert.deepEqual([updated.status, updated.body.onboarding.revision, updated.body.onboarding.completed], [200, 2, true])
  const recs = await call(f, 'GET', '/v1/onboarding/recommendations')
  assert.deepEqual(recs.body.items.map(i => i.template_id), recommendedTemplateIds('研究员'))
  assert.equal((await call(f, 'POST', '/v1/onboarding', { industry: '教育', role: 'x'.repeat(41), completed: true })).status, 400)
  const steps = await call(f, 'GET', '/v1/onboarding')
  const keys = steps.body.steps.recommendations.map(r => r.key)
  assert.equal(keys[0], 'lesson-outline', 'industry recommendations come first')
  const picked = await call(f, 'POST', '/v1/onboarding/picks', { picks: keys.slice(0, 2) })
  assert.deepEqual(picked.body.steps.picks, keys.slice(0, 2))
  assert.equal((await call(f, 'POST', '/v1/onboarding/picks', { picks: ['nope'] })).status, 400)
  assert.equal((await call(f, 'POST', '/v1/onboarding/picks', { picks: [keys[0], keys[0]] })).status, 400)
  const look = { color: '天空蓝', expression: '微笑', headwear: '无', glasses: '无', hand: '咖啡杯' }
  const saved = await call(f, 'POST', '/v1/onboarding/look', { look })
  assert.deepEqual(saved.body.steps.look, look)
  assert.deepEqual(saved.body.steps.picks, keys.slice(0, 2), 'saving the look keeps the picks')
  assert.equal((await call(f, 'POST', '/v1/onboarding/look', { look: { ...look, color: 'pink' } })).status, 400)
  assert.deepEqual((await f.endpoints.look()).look, look)
})

test('compat: unknown routes are not moved, writes refuse queries, bad requests 400', async () => {
  const f = feature()
  assert.equal((await call(f, 'GET', '/v1/memory/pages')).status, 404)
  assert.equal((await call(f, 'GET', '/v1/memory/pages')).body.error.code, 'not_moved')
  assert.equal((await call(f, 'POST', '/v1/settings', { revision: 0, changes: { appearance: 'dark' } }, 'a=1')).status, 400)
  assert.equal((await call(f, 'PATCH', '/v1/settings')).status, 400)
  assert.equal((await call(f, 'GET', '/v2/settings')).status, 400)
  assert.equal((await call(f, 'GET', '/v1/settingsX')).status, 404, 'routes match the whole path')
})

test('plugin dispatch serves the feature through POST /api/openteamily', async () => {
  const routes = new Map()
  const ctx = { connection: { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } } }, effect(fn) { fn() } }
  const dir = dataDir()
  const { features } = apply(ctx, { pagesDir: join(dir, 'absent'), dataDir: dir })
  assert.ok((await features).loaded.includes('settings'))
  const post = body => routes.get(API_PATH).fetch(new Request(`http://10.0.0.2:8080${API_PATH}`, { method: 'POST', body: JSON.stringify(body) }))
  const saved = await (await post({ endpoint: 'settings/v1', payload: { method: 'POST', path: '/v1/settings', body: { revision: 0, changes: { language: 'en' } } } })).json()
  assert.equal(saved.ok, true)
  assert.equal(saved.value.status, 200)
  const direct = await (await post({ endpoint: 'settings/get' })).json()
  assert.equal(direct.value.settings.values.language, 'en')
  const identity = await (await post({ endpoint: 'shell/identity' })).json()
  assert.equal(identity.value.served_by, 'ds-bot', 'core endpoints stay available')
})
