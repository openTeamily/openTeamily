// #284 in the DS-Bot shape: a notification switch is only real if the inbox
// read path honours it. The preferences live in the settings feature
// (settings.js notificationPrefs); the listing is built here.
//
// The mapping is driven by the kinds Bot Social actually produces
// (`git grep "ot.notify(" services/bot-social/src`): twelve kinds, of which only
// `messenger.mention` is a mention. There is no task-completion or artifact
// notice today, and `discover.published` is a follow notice ("someone you follow
// published"), so it must survive every filter here — hiding follow rows when
// the work switch is off would be a behaviour bug, not a feature.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSettingsFeature } from '../features/settings/settings.js'
import { compatHandler } from '../lib/b4/compat.js'
import { setSharedBotSocial } from '../lib/c/bot-social.js'
import social, { notificationPage } from '../features/social/index.js'

const WS = 'a'.repeat(32)
const INBOX = `/v1/workspaces/${WS}/notifications`
const PREFS = '/v1/notification-prefs'

const row = (id, kind, read, data = {}) => ({
  id, seq: Number(id.slice(1)), kind, read, created_at: 1700000000000,
  data: { conversation_id: 'c'.repeat(32), ...data },
})

// One row per interesting kind: the only mention Bot Social can produce, a
// follow notice that must never be collateral damage, a team notice, and a read
// row so the unread accounting is visible.
const inbox = () => ({
  unread: 4,
  notifications: [
    row('n1', 'messenger.mention', false, { excerpt: '@ann 看一下这个' }),
    row('n2', 'discover.published', false, { listing_id: 'l1', title: '周报' }),
    row('n3', 'team.member_joined', false),
    row('n4', 'messenger.added', true),
    // No producer emits this kind today (the twelve kinds Bot Social writes are
    // listed above the map); the artifacts library already names the kind
    // (`features/artifacts/library.js`), so the row proves the map is wired for it
    // while the filter still changes nothing in production.
    row('n5', 'artifact', false, { title: '周报草稿' }),
  ],
})

test('提及我 off drops the mention row and the matching unread, and nothing else', () => {
  const page = notificationPage(inbox(), { mentions: false, task_completion: true, artifacts: true })
  assert.deepEqual(page.items.map(item => item.kind),
                   ['discover.published', 'team.member_joined', 'messenger.added', 'artifact'])
  assert.equal(page.unread_count, 3, 'only the mention unread left the count')
  assert.equal(page.limit, 200)
})

test('作品通知 off drops only the work row: a follow notice and a team notice survive', () => {
  const page = notificationPage(inbox(), { mentions: true, task_completion: false, artifacts: false })
  assert.deepEqual(page.items.map(item => item.id), ['n1', 'n2', 'n3', 'n4'],
                   'discover.published, team.member_joined and messenger.added are all kept')
  assert.deepEqual(page.items.map(item => item.kind),
                   ['messenger.mention', 'discover.published', 'team.member_joined', 'messenger.added'],
                   'only the artifact row is a work notice')
  assert.equal(page.unread_count, 3, 'the artifact row was unread, so the count drops by exactly one')
})

test('提及我 back on shows the same row again, so the filter never drops data', () => {
  const off = notificationPage(inbox(), { mentions: false })
  assert.deepEqual(off.items.map(item => item.id), ['n2', 'n3', 'n4', 'n5'])
  const on = notificationPage(inbox(), { mentions: true })
  assert.deepEqual(on.items.map(item => item.id), ['n1', 'n2', 'n3', 'n4', 'n5'], 'the same rows come back')
  assert.deepEqual(on.items.find(item => item.id === 'n1'),
                   { conversation_id: 'c'.repeat(32), excerpt: '@ann 看一下这个',
                     id: 'n1', seq: 1, kind: 'messenger.mention',
                     created: 1700000000, read: false })
  assert.equal(on.unread_count, 4)
})

test('defaults keep every row and the unread count Bot Social reported', () => {
  const page = notificationPage(inbox(), {})
  assert.deepEqual(page.items.map(item => item.id), ['n1', 'n2', 'n3', 'n4', 'n5'])
  assert.equal(page.unread_count, 4)
  assert.equal(page.limit, 200)
})

// The pure function could be right while the handler never calls it, so one test
// goes through the endpoint and a real settings feature.
const settingsCall = (f, method, path, body) => compatHandler(f.legacy)({ method, path, body, query: '' })

function fakeBotSocial(data) {
  return {
    request: async (method, path) => {
      assert.equal(method, 'GET', 'the inbox only reads here')
      assert.match(path, /^\/v1\/ot\/notifications\?/)
      const unreadOnly = /[?&]unread=1(?:&|$)/.test(path)
      return unreadOnly
        ? { unread: data.notifications.filter(n => !n.read).length, notifications: data.notifications.filter(n => !n.read) }
        : data
    },
  }
}

test('the inbox endpoint filters by the stored preference, and restores on switch back', async () => {
  setSharedBotSocial(fakeBotSocial(inbox()))
  const f = createSettingsFeature({ dir: mkdtempSync(join(tmpdir(), 'ot-notify-prefs-')) })
  const host = {
    dataDir: mkdtempSync(join(tmpdir(), 'ot-notify-host-')),
    call: async (name) => {
      if (name === 'agents/personal-binding') return { workspace_id: WS }
      if (name === 'settings/notificationPrefs') return (await settingsCall(f, 'GET', PREFS)).body
      throw new Error('unexpected endpoint ' + name)
    },
  }
  const list = async (query = '') => (await social(host).endpoints.v1({ method: 'GET', path: INBOX, query })).body
  assert.deepEqual((await list()).items.map(item => item.id), ['n1', 'n2', 'n3', 'n4', 'n5'])
  assert.equal((await settingsCall(f, 'PUT', PREFS, { changes: { mentions: false } })).status, 200)
  const off = await list()
  assert.deepEqual(off.items.map(item => item.id), ['n2', 'n3', 'n4', 'n5'])
  assert.equal(off.unread_count, 3)
  assert.equal((await settingsCall(f, 'PUT', PREFS, { changes: { mentions: true } })).status, 200)
  const on = await list()
  assert.deepEqual(on.items.map(item => item.id), ['n1', 'n2', 'n3', 'n4', 'n5'])
  assert.equal(on.unread_count, 4)
})
