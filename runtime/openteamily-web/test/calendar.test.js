import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { boot, volume } from './helpers.js'

const WS = 'a'.repeat(32)
const WS2 = 'b'.repeat(32)
const ALICE = '1'.repeat(32)
const BOB = '2'.repeat(32)
const NOW = 1800000000

const ok = async (bot, op, payload) => {
  const reply = await bot.endpoint(`calendar/${op}`, payload)
  assert.equal(reply.ok, true, JSON.stringify(reply.error))
  return reply.value
}

const fail = async (bot, op, payload, code = 'calendar/invalid') => {
  const reply = await bot.endpoint(`calendar/${op}`, payload)
  assert.equal(reply.ok, false, `${op} unexpectedly succeeded`)
  assert.equal(reply.error.code, code)
  return reply.error
}

const event = (overrides = {}) => ({
  workspace_id: WS,
  owner_id: ALICE,
  title: 'Planning',
  starts: NOW + 3600,
  ends: NOW + 7200,
  now: NOW,
  ...overrides,
})

const dbPath = (vol) => join(vol.data, 'openteamily', 'features', 'calendar', 'calendar.sqlite3')

test('calendar feature loads with its own SQLite file in this DS-Bot volume', async () => {
  const bot = await boot()
  assert.ok(bot.features.loaded.includes('calendar'), JSON.stringify(bot.features.failed))
  assert.ok(existsSync(dbPath(bot.vol)))
})

test('calendar schema is idempotent and keeps the required tables and indexes', async () => {
  const vol = volume()
  await boot(vol)
  await boot(vol)
  const db = new DatabaseSync(dbPath(vol))
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name)
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((row) => row.name)
    const columns = db.prepare('PRAGMA table_info(calendar_events)').all().map((row) => row.name)
    const reminderColumns = db.prepare('PRAGMA table_info(calendar_reminders)').all().map((row) => row.name)
    for (const name of ['calendar_events', 'calendar_reminders']) assert.ok(tables.includes(name))
    for (const name of ['calendar_event_workspace', 'calendar_event_recurrence', 'calendar_reminder_event', 'calendar_reminder_workspace']) assert.ok(indexes.includes(name))
    assert.deepEqual(columns, ['id', 'workspace_id', 'owner_id', 'title', 'starts', 'ends', 'all_day', 'time_zone', 'location', 'notes', 'recurrence', 'until', 'created', 'updated'])
    assert.deepEqual(reminderColumns, ['id', 'workspace_id', 'event_id', 'user_id', 'minutes_before', 'fired', 'created'])
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1)
  } finally {
    db.close()
  }
})

test('create and get return a normalized event with a minimal reminder view', async () => {
  const bot = await boot()
  const created = await ok(bot, 'create', event({
    title: '  Planning  ',
    time_zone: 'Asia/Shanghai',
    all_day: true,
    location: '  Room 1  ',
    notes: 'Agenda\nDetails',
    reminders: [
      { user_id: ALICE, minutes_before: 15 },
      { user_id: BOB, minutes_before: 5 },
    ],
  }))
  const item = created.event
  assert.equal(item.title, 'Planning')
  assert.equal(item.time_zone, 'Asia/Shanghai')
  assert.equal(item.all_day, true)
  assert.equal(item.location, 'Room 1')
  assert.equal(item.notes, 'Agenda\nDetails')
  assert.equal(item.created, NOW)
  assert.equal(item.updated, NOW)
  assert.deepEqual(item.reminders, [
    { user_id: ALICE, minutes_before: 15 },
    { user_id: BOB, minutes_before: 5 },
  ])
  const fetched = await ok(bot, 'get', { workspace_id: WS, id: item.id })
  assert.deepEqual(fetched.event, item)
  await fail(bot, 'get', { workspace_id: WS, id: 'missing' }, 'calendar/not-found')
})

test('invalid time zones, ranges, recurrence, until, types and text are rejected', async () => {
  const bot = await boot()
  const cases = [
    { time_zone: 'Not/AZone' },
    { time_zone: '' },
    { starts: NOW + 20, ends: NOW + 20 },
    { starts: NOW + 30, ends: NOW + 20 },
    { starts: -1 },
    { ends: 'later' },
    { recurrence: 'monthly' },
    { until: NOW },
    { all_day: 1 },
    { title: '' },
    { notes: 'bad\x01notes' },
    { reminders: [{ user_id: ALICE, minutes_before: -1 }] },
    { reminders: [{ user_id: ALICE, minutes_before: 525601 }] },
    { reminders: [{ user_id: '', minutes_before: 5 }] },
    { reminders: [{ user_id: ALICE, minutes_before: 5, extra: 1 }] },
  ]
  for (const changes of cases) {
    await fail(bot, 'create', event(changes))
  }
  const listed = await ok(bot, 'list', { workspace_id: WS, start: 0, end: 4102444800, limit: 10 })
  assert.deepEqual(listed.items, [])
})

test('oversize title, location, notes and reminder lists are rejected', async () => {
  const bot = await boot()
  await fail(bot, 'create', event({ title: 'x'.repeat(201) }))
  await fail(bot, 'create', event({ location: 'x'.repeat(501) }))
  await fail(bot, 'create', event({ notes: 'x'.repeat(20001) }))
  await fail(bot, 'create', event({ reminders: Array.from({ length: 101 }, (_, i) => ({ user_id: `u${i}`, minutes_before: 5 })) }))
})

test('reminders are created, deduplicated and start unfired', async () => {
  const bot = await boot()
  const created = await ok(bot, 'create', event({
    reminders: [
      { user_id: ALICE, minutes_before: 10 },
      { user_id: ALICE, minutes_before: 10 },
      { user_id: BOB, minutes_before: 5 },
    ],
  }))
  assert.equal(created.event.reminders.length, 2)
  const db = new DatabaseSync(dbPath(bot.vol))
  try {
    const rows = db.prepare('SELECT * FROM calendar_reminders WHERE workspace_id=? AND event_id=?').all(WS, created.event.id)
    assert.equal(rows.length, 2)
    assert.ok(rows.every((row) => row.fired === 0))
    assert.equal(new Set(rows.map((row) => `${row.user_id}:${row.minutes_before}`)).size, 2)
  } finally {
    db.close()
  }
})

test('list expands only overlapping events and pages with a stable cursor', async () => {
  const bot = await boot()
  const before = (await ok(bot, 'create', event({ title: 'Before', starts: NOW - 500, ends: NOW - 400, now: NOW }))).event
  const overlap = (await ok(bot, 'create', event({ title: 'Overlap', starts: NOW - 100, ends: NOW + 50, now: NOW }))).event
  const middle = (await ok(bot, 'create', event({ title: 'Middle', starts: NOW + 50, ends: NOW + 150, now: NOW }))).event
  const inside = (await ok(bot, 'create', event({ title: 'Inside', starts: NOW + 100, ends: NOW + 200, now: NOW }))).event
  const after = (await ok(bot, 'create', event({ title: 'After', starts: NOW + 250, ends: NOW + 300, now: NOW }))).event
  const first = await ok(bot, 'list', { workspace_id: WS, start: NOW, end: NOW + 250, limit: 2 })
  assert.deepEqual(first.items.map((item) => item.id), [overlap.id, middle.id])
  assert.equal(first.next_cursor, '2')
  const second = await ok(bot, 'list', { workspace_id: WS, start: NOW, end: NOW + 250, limit: 2, cursor: first.next_cursor })
  assert.deepEqual(second.items.map((item) => item.id), [inside.id])
  assert.equal(second.next_cursor, null)
  assert.deepEqual((await ok(bot, 'list', { workspace_id: WS, start: NOW, end: NOW })).items, [])
  const empty = await ok(bot, 'list', { workspace_id: WS, start: NOW, end: NOW + 250, limit: 10 })
  assert.deepEqual(empty.items.map((item) => item.id), [overlap.id, middle.id, inside.id])
  assert.ok(!empty.items.some((item) => [before.id, after.id].includes(item.id)))
  assert.ok(empty.items.every((item) => !('occurrence_index' in item)))
})

test('daily and weekly recurrence expand with until and occurrence indexes', async () => {
  const bot = await boot()
  const dailyBase = Date.UTC(2027, 0, 1, 9) / 1000
  const daily = (await ok(bot, 'create', event({
    title: 'Daily', starts: dailyBase, ends: dailyBase + 3600, now: NOW,
    time_zone: 'UTC', recurrence: 'daily', until: dailyBase + 5 * 86400,
  }))).event
  const dailyItems = (await ok(bot, 'list', { workspace_id: WS, start: dailyBase, end: dailyBase + 3 * 86400, limit: 20 })).items
  assert.deepEqual(dailyItems.map((item) => item.starts), [dailyBase, dailyBase + 86400, dailyBase + 2 * 86400])
  assert.deepEqual(dailyItems.map((item) => item.occurrence_index), [0, 1, 2])
  assert.ok(dailyItems.every((item) => item.id === daily.id))
  const capped = (await ok(bot, 'list', { workspace_id: WS, start: dailyBase, end: dailyBase + 20 * 86400, limit: 20 })).items
  assert.equal(capped.length, 6)
  assert.equal(capped.at(-1).starts, dailyBase + 5 * 86400)

  const weeklyBase = Date.UTC(2027, 0, 4, 9) / 1000
  const weekly = (await ok(bot, 'create', event({
    title: 'Weekly', starts: weeklyBase, ends: weeklyBase + 3600, now: NOW,
    time_zone: 'UTC', recurrence: 'weekly', until: weeklyBase + 21 * 86400,
  }))).event
  const weeklyItems = (await ok(bot, 'list', { workspace_id: WS, start: weeklyBase, end: weeklyBase + 22 * 86400, limit: 20 })).items
    .filter((item) => item.id === weekly.id)
  assert.deepEqual(weeklyItems.map((item) => item.starts), [weeklyBase, weeklyBase + 7 * 86400, weeklyBase + 14 * 86400, weeklyBase + 21 * 86400])
})

test('daily recurrence preserves local wall-clock time across DST', async () => {
  const bot = await boot()
  const base = Date.UTC(2027, 2, 13, 14) / 1000
  await ok(bot, 'create', event({
    title: 'DST daily', starts: base, ends: base + 3600, now: NOW,
    time_zone: 'America/New_York', recurrence: 'daily',
  }))
  const items = (await ok(bot, 'list', { workspace_id: WS, start: base, end: base + 2 * 86400, limit: 10 })).items
  assert.equal(items.length, 3)
  assert.equal(items[1].starts - items[0].starts, 23 * 3600)
  assert.equal(items[1].starts, Date.UTC(2027, 2, 14, 13) / 1000)
})

test('recurrence occurrence expansion is capped at 1000 per event', async () => {
  const bot = await boot()
  const base = Date.UTC(2020, 0, 1, 9) / 1000
  await ok(bot, 'create', event({ title: 'Ancient daily', starts: base, ends: base + 3600, now: NOW, time_zone: 'UTC', recurrence: 'daily' }))
  const first = await ok(bot, 'list', { workspace_id: WS, start: base, end: base + 3650 * 86400, limit: 500 })
  assert.equal(first.items.length, 500)
  assert.equal(first.next_cursor, '500')
  const second = await ok(bot, 'list', { workspace_id: WS, start: base, end: base + 3650 * 86400, limit: 500, cursor: first.next_cursor })
  assert.equal(second.items.length, 500)
  assert.equal(second.next_cursor, null)
})

test('upcoming uses the requested window and limit', async () => {
  const bot = await boot()
  const soon = (await ok(bot, 'create', event({ title: 'Soon', starts: NOW + 100, ends: NOW + 200, now: NOW }))).event
  const later = (await ok(bot, 'create', event({ title: 'Later', starts: NOW + 86400 + 100, ends: NOW + 86400 + 200, now: NOW }))).event
  const found = await ok(bot, 'upcoming', { workspace_id: WS, now: NOW, window_seconds: 86400, limit: 10 })
  assert.deepEqual(found.items.map((item) => item.id), [soon.id])
  assert.ok(!found.items.some((item) => item.id === later.id))
  const limited = await ok(bot, 'upcoming', { workspace_id: WS, now: NOW, window_seconds: 86400, limit: 1 })
  assert.equal(limited.items.length, 1)
})

test('dueReminders returns due occurrences, excludes fired, and marks fired once per workspace', async () => {
  const bot = await boot()
  const due = (await ok(bot, 'create', event({
    title: 'Due event', starts: NOW + 600, ends: NOW + 1200, now: NOW,
    reminders: [{ user_id: ALICE, minutes_before: 15 }],
  }))).event
  const future = (await ok(bot, 'create', event({
    title: 'Future event', starts: NOW + 7200, ends: NOW + 7800, now: NOW,
    reminders: [{ user_id: BOB, minutes_before: 5 }],
  }))).event
  const found = await ok(bot, 'dueReminders', { workspace_id: WS, now: NOW })
  assert.deepEqual(found.items.map((item) => item.event_id), [due.id])
  const item = found.items[0]
  assert.equal(item.workspace_id, WS)
  assert.equal(item.user_id, ALICE)
  assert.equal(item.minutes_before, 15)
  assert.equal(item.starts, NOW + 600)
  assert.equal(item.due_at, NOW - 300)
  assert.equal(item.id, item.reminder_id)
  assert.equal(item.occurrence_index, 0)
  assert.deepEqual(await ok(bot, 'markReminderFired', { workspace_id: WS, reminder_id: item.id, now: NOW }), { fired: true })
  assert.deepEqual(await ok(bot, 'markReminderFired', { workspace_id: WS, reminder_id: item.id, now: NOW }), { fired: false })
  assert.deepEqual((await ok(bot, 'dueReminders', { workspace_id: WS, now: NOW })).items, [])
  const atTime = await ok(bot, 'dueReminders', { workspace_id: WS, now: NOW + 6900 })
  assert.deepEqual(atTime.items.map((entry) => entry.event_id), [future.id])
  assert.deepEqual(await ok(bot, 'markReminderFired', { workspace_id: WS2, reminder_id: atTime.items[0].id, now: NOW }), { fired: false })
})

test('update reschedules reminders, resets fired flags and replaces reminders', async () => {
  const bot = await boot()
  const created = (await ok(bot, 'create', event({
    starts: NOW + 7200, ends: NOW + 7800, now: NOW,
    reminders: [{ user_id: ALICE, minutes_before: 60 }],
  }))).event
  assert.deepEqual((await ok(bot, 'dueReminders', { workspace_id: WS, now: NOW })).items, [])
  const moved = await ok(bot, 'update', {
    workspace_id: WS, id: created.id, now: NOW + 1,
    changes: { starts: NOW + 600, ends: NOW + 1200 },
  })
  assert.equal(moved.event.starts, NOW + 600)
  assert.equal(moved.event.updated, NOW + 1)
  const due = await ok(bot, 'dueReminders', { workspace_id: WS, now: NOW })
  assert.deepEqual(due.items.map((item) => item.event_id), [created.id])
  await ok(bot, 'markReminderFired', { workspace_id: WS, reminder_id: due.items[0].id, now: NOW })
  assert.deepEqual((await ok(bot, 'dueReminders', { workspace_id: WS, now: NOW })).items, [])

  await ok(bot, 'update', { workspace_id: WS, id: created.id, now: NOW + 2, changes: { starts: NOW + 7200, ends: NOW + 7800 } })
  assert.deepEqual((await ok(bot, 'dueReminders', { workspace_id: WS, now: NOW })).items, [])
  await ok(bot, 'update', { workspace_id: WS, id: created.id, now: NOW + 3, changes: { starts: NOW + 600, ends: NOW + 1200 } })
  assert.deepEqual((await ok(bot, 'dueReminders', { workspace_id: WS, now: NOW })).items.map((item) => item.event_id), [created.id])

  const replaced = await ok(bot, 'update', {
    workspace_id: WS, id: created.id, now: NOW + 4,
    changes: { reminders: [{ user_id: BOB, minutes_before: 10 }] },
  })
  assert.deepEqual(replaced.event.reminders, [{ user_id: BOB, minutes_before: 10 }])
})

test('update validation is bounded and unknown changes are refused', async () => {
  const bot = await boot()
  const created = (await ok(bot, 'create', event())).event
  await fail(bot, 'update', { workspace_id: WS, id: created.id, changes: { unknown: 1 } })
  await fail(bot, 'update', { workspace_id: WS, id: created.id, changes: { starts: NOW + 7200, ends: NOW + 7200 } })
  await fail(bot, 'update', { workspace_id: WS, id: created.id, changes: { time_zone: 'Invalid/Zone' } })
  await fail(bot, 'update', { workspace_id: WS, id: created.id, changes: { notes: 'x'.repeat(20001) } })
  await fail(bot, 'update', { workspace_id: WS2, id: created.id, changes: { title: 'Nope' } }, 'calendar/not-found')
})

test('cancel hides the event and its reminders', async () => {
  const bot = await boot()
  const created = (await ok(bot, 'create', event({
    title: 'Cancel me', starts: NOW + 100, ends: NOW + 200, now: NOW,
    reminders: [{ user_id: ALICE, minutes_before: 5 }],
  }))).event
  assert.deepEqual((await ok(bot, 'dueReminders', { workspace_id: WS, now: NOW })).items.map((item) => item.event_id), [created.id])
  assert.deepEqual(await ok(bot, 'cancel', { workspace_id: WS, id: created.id, now: NOW }), { removed: true })
  await fail(bot, 'get', { workspace_id: WS, id: created.id }, 'calendar/not-found')
  assert.deepEqual((await ok(bot, 'upcoming', { workspace_id: WS, now: NOW, window_seconds: 86400, limit: 10 })).items, [])
  assert.deepEqual((await ok(bot, 'dueReminders', { workspace_id: WS, now: NOW })).items, [])
  assert.deepEqual(await ok(bot, 'cancel', { workspace_id: WS, id: created.id, now: NOW }), { removed: false })
  const db = new DatabaseSync(dbPath(bot.vol))
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_reminders WHERE event_id=?').get(created.id).n, 0)
  } finally {
    db.close()
  }
})

test('workspace isolation hides events, reminders and mutations from other workspaces', async () => {
  const bot = await boot()
  const first = (await ok(bot, 'create', event({ title: 'Alice event' }))).event
  const second = (await ok(bot, 'create', event({
    workspace_id: WS2, owner_id: BOB, title: 'Bob event',
    reminders: [{ user_id: BOB, minutes_before: 5 }],
  }))).event
  const aliceItems = (await ok(bot, 'list', { workspace_id: WS, start: NOW, end: NOW + 86400, limit: 50 })).items
  const bobItems = (await ok(bot, 'list', { workspace_id: WS2, start: NOW, end: NOW + 86400, limit: 50 })).items
  assert.deepEqual(aliceItems.map((item) => item.id), [first.id])
  assert.deepEqual(bobItems.map((item) => item.id), [second.id])
  await fail(bot, 'get', { workspace_id: WS, id: second.id }, 'calendar/not-found')
  await fail(bot, 'get', { workspace_id: WS2, id: first.id }, 'calendar/not-found')
  await fail(bot, 'update', { workspace_id: WS, id: second.id, changes: { title: 'Cross workspace' } }, 'calendar/not-found')
  assert.deepEqual(await ok(bot, 'cancel', { workspace_id: WS, id: second.id, now: NOW }), { removed: false })
  assert.equal((await ok(bot, 'get', { workspace_id: WS2, id: second.id })).event.title, 'Bob event')
  const bobDue = await ok(bot, 'dueReminders', { workspace_id: WS2, now: NOW + 7200 - 300 })
  assert.deepEqual(bobDue.items.map((item) => item.event_id), [second.id])
  assert.deepEqual((await ok(bot, 'dueReminders', { workspace_id: WS, now: NOW + 7200 - 300 })).items, [])
})

test('calendar data persists in this volume and is invisible to another DS-Bot', async () => {
  const vol = volume()
  const first = await boot(vol)
  const created = (await ok(first, 'create', event())).event
  const again = await boot(vol)
  assert.deepEqual((await ok(again, 'get', { workspace_id: WS, id: created.id })).event, created)
  const other = await boot()
  await fail(other, 'get', { workspace_id: WS, id: created.id }, 'calendar/not-found')
  assert.deepEqual((await ok(other, 'list', { workspace_id: WS, start: NOW, end: NOW + 86400, limit: 50 })).items, [])
})

test('list, upcoming and dueReminders reject invalid bounds, limits and payloads', async () => {
  const bot = await boot()
  await fail(bot, 'list', { workspace_id: WS, start: 10, end: 5 })
  await fail(bot, 'list', { workspace_id: WS, start: 0, end: 10, limit: 0 })
  await fail(bot, 'list', { workspace_id: '', start: 0, end: 10 })
  await fail(bot, 'upcoming', { workspace_id: WS, now: NOW, window_seconds: -1 })
  await fail(bot, 'dueReminders', { workspace_id: WS, now: NOW, limit: 0 })
  await fail(bot, 'create', null)
})
