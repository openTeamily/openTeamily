// Calendar feature: private events, simple recurrence and reminder rows inside
// each user's own DS-Bot (port of the obsolete openteamily/calendar.py slice).
// No external calendar sync and no delivery worker: dueReminders exposes the
// rows a caller may deliver, markReminderFired records that it happened.
import { join } from 'node:path'
import { openStore } from '../../featurekit/store.js'
import { newId, nowSeconds, refuse } from '../../featurekit/http.js'
import { ownerId } from '../../featurekit/v1.js'

export const LIMITS = {
  TITLE_MAX: 200,
  LOCATION_MAX: 500,
  NOTES_MAX: 20000,
  REMINDER_USER_MAX: 128,
  MINUTES_MAX: 525600,
  MAX_TIME: 4102444800,
  MAX_REMINDERS: 100,
  MAX_OCCURRENCES: 1000,
  MAX_LIST_LIMIT: 500,
}
export const RECURRENCES = ['none', 'daily', 'weekly']
const CHANGES = new Set(['title', 'starts', 'ends', 'all_day', 'time_zone', 'location', 'notes', 'recurrence', 'until', 'reminders'])
const STRICT_CONTROL = /[\x00-\x1f\x7f]/
const TEXT_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f]/
const WEEKDAY = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }
const formatters = new Map()

const invalid = (message) => refuse(400, 'calendar/invalid', message)
const notFound = (message = 'Event not found') => refuse(404, 'calendar/not-found', message)
const isInt = (value) => Number.isInteger(value)
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key)

export const MIGRATIONS = [`CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  starts INTEGER NOT NULL,
  ends INTEGER NOT NULL,
  all_day INTEGER NOT NULL CHECK(all_day IN (0,1)),
  time_zone TEXT NOT NULL,
  location TEXT,
  notes TEXT,
  recurrence TEXT NOT NULL CHECK(recurrence IN ('none','daily','weekly')),
  until INTEGER,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  CHECK(starts < ends));
CREATE INDEX IF NOT EXISTS calendar_event_workspace ON calendar_events(workspace_id, starts, ends);
CREATE INDEX IF NOT EXISTS calendar_event_recurrence ON calendar_events(workspace_id, recurrence, until);
CREATE TABLE IF NOT EXISTS calendar_reminders (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  minutes_before INTEGER NOT NULL CHECK(minutes_before >= 0),
  fired INTEGER NOT NULL DEFAULT 0 CHECK(fired IN (0,1)),
  created INTEGER NOT NULL,
  UNIQUE(event_id, user_id, minutes_before));
CREATE INDEX IF NOT EXISTS calendar_reminder_event ON calendar_reminders(event_id, fired);
CREATE INDEX IF NOT EXISTS calendar_reminder_workspace ON calendar_reminders(workspace_id, fired);
PRAGMA user_version=1;`]

function formatter(zone) {
  let fmt = formatters.get(zone)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    })
    formatters.set(zone, fmt)
  }
  return fmt
}

export function validZone(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64 || STRICT_CONTROL.test(value)) return false
  try { formatter(value); return true } catch { return false }
}

export function partsIn(zone, ms) {
  const out = {}
  for (const { type, value } of formatter(zone).formatToParts(new Date(ms))) out[type] = value
  return {
    year: +out.year, month: +out.month, day: +out.day,
    hour: +out.hour % 24, minute: +out.minute, second: +out.second,
    isoWeekday: WEEKDAY[out.weekday],
  }
}

export function zonedEpoch(zone, year, month, day, hour, minute, second = 0) {
  const target = Date.UTC(year, month - 1, day, hour, minute, second)
  let guess = target
  for (let i = 0; i < 3; i += 1) {
    const p = partsIn(zone, guess)
    const diff = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - target
    if (diff === 0) break
    guess -= diff
  }
  return Math.floor(guess / 1000)
}

const dayNumber = (p) => Math.floor(Date.UTC(p.year, p.month - 1, p.day) / 86400000)
const daysBetween = (from, to) => dayNumber(to) - dayNumber(from)
const addDays = (p, days) => {
  const date = new Date(Date.UTC(p.year, p.month - 1, p.day + days))
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }
}
const safeZone = (zone) => (validZone(zone) ? zone : 'UTC')

const workspace = (value) => {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128 || STRICT_CONTROL.test(value)) invalid('Invalid workspace id')
  return value
}
const identifier = (value, name) => {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128 || STRICT_CONTROL.test(value)) invalid(`Invalid ${name}`)
  return value
}
const timestamp = (value, name) => {
  if (!isInt(value) || value < 0 || value > LIMITS.MAX_TIME) invalid(`Invalid ${name}`)
  return value
}
const titleOf = (value) => {
  if (typeof value !== 'string') invalid('Invalid title')
  const title = value.trim()
  if (title.length < 1 || title.length > LIMITS.TITLE_MAX || STRICT_CONTROL.test(title)) invalid('Invalid title')
  return title
}
const optionalText = (value, limit, name) => {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || value.length > limit) invalid(`Invalid ${name}`)
  if (TEXT_CONTROL.test(value)) invalid(`Invalid ${name}`)
  return value
}
const locationOf = (value) => {
  const text = optionalText(value, LIMITS.LOCATION_MAX, 'location')
  if (text === null) return null
  const trimmed = text.trim()
  if (STRICT_CONTROL.test(trimmed)) invalid('Invalid location')
  return trimmed || null
}
const notesOf = (value) => optionalText(value, LIMITS.NOTES_MAX, 'notes')
const allDayOf = (value) => {
  if (typeof value !== 'boolean') invalid('Invalid all_day')
  return value
}
const zoneOf = (value) => {
  if (!validZone(value)) invalid('Invalid time_zone')
  return value
}
const recurrenceOf = (value) => {
  if (!RECURRENCES.includes(value)) invalid('Invalid recurrence')
  return value
}
const untilOf = (value, starts) => {
  if (value === null || value === undefined) return null
  const until = timestamp(value, 'until')
  if (until < starts) invalid('until must not precede starts')
  return until
}

function remindersOf(value) {
  if (value === null || value === undefined) return []
  if (!Array.isArray(value)) invalid('Invalid reminders')
  if (value.length > LIMITS.MAX_REMINDERS) invalid('Too many reminders')
  const seen = new Set()
  const rows = []
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) invalid('Invalid reminder')
    const keys = Object.keys(item)
    if (keys.length !== 2 || !keys.includes('user_id') || !keys.includes('minutes_before')) invalid('Invalid reminder')
    const userId = identifier(item.user_id, 'reminder user_id')
    if (userId.length > LIMITS.REMINDER_USER_MAX) invalid('Invalid reminder user_id')
    const minutes = item.minutes_before
    if (!isInt(minutes) || minutes < 0 || minutes > LIMITS.MINUTES_MAX) invalid('Invalid reminder minutes_before')
    const dedupe = `${userId}\u0000${minutes}`
    if (seen.has(dedupe)) continue
    seen.add(dedupe)
    rows.push({ user_id: userId, minutes_before: minutes })
  }
  rows.sort((a, b) => (a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : a.minutes_before - b.minutes_before))
  return rows
}

const listLimit = (value) => {
  if (value === null || value === undefined) return 50
  if (!isInt(value) || value < 1) invalid('Invalid limit')
  return Math.min(value, LIMITS.MAX_LIST_LIMIT)
}
const listCursor = (value) => {
  if (value === null || value === undefined || value === '' || value === 0) return 0
  if (isInt(value) && value >= 0) return value
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return Number(value)
  return 0
}

function* occurrences(row, windowStart, windowEnd, maximum = LIMITS.MAX_OCCURRENCES) {
  const duration = row.ends - row.starts
  if (duration <= 0 || windowStart >= windowEnd) return
  if (row.recurrence === 'none') {
    if (row.starts < windowEnd && row.ends > windowStart) yield [0, row.starts, row.ends]
    return
  }
  const zone = safeZone(row.time_zone)
  const period = row.recurrence === 'daily' ? 1 : 7
  const base = partsIn(zone, row.starts * 1000)
  const lookback = Math.max(0, windowStart - duration)
  const target = partsIn(zone, lookback * 1000)
  let index = Math.max(0, Math.floor(daysBetween(base, target) / period) - 1)
  let count = 0
  while (count < maximum) {
    const local = addDays(base, index * period)
    const starts = zonedEpoch(zone, local.year, local.month, local.day, base.hour, base.minute, base.second)
    if (row.until !== null && row.until !== undefined && starts > row.until) break
    if (starts >= windowEnd) break
    const ends = starts + duration
    if (ends > windowStart) {
      yield [index, starts, ends]
      count += 1
    }
    index += 1
  }
}

function latestOccurrence(row, threshold) {
  if (row.starts > threshold) return null
  const duration = row.ends - row.starts
  if (row.recurrence === 'none') return [0, row.starts, row.ends]
  const zone = safeZone(row.time_zone)
  const period = row.recurrence === 'daily' ? 1 : 7
  const base = partsIn(zone, row.starts * 1000)
  const target = partsIn(zone, threshold * 1000)
  let index = Math.max(0, Math.floor(daysBetween(base, target) / period))
  if (row.until !== null && row.until !== undefined) {
    const localUntil = partsIn(zone, row.until * 1000)
    index = Math.min(index, Math.max(0, Math.floor(daysBetween(base, localUntil) / period)))
  }
  for (;;) {
    const local = addDays(base, (index + 1) * period)
    const starts = zonedEpoch(zone, local.year, local.month, local.day, base.hour, base.minute, base.second)
    const allowed = row.until === null || row.until === undefined || starts <= row.until
    if (starts <= threshold && allowed) index += 1
    else break
  }
  while (index >= 0) {
    const local = addDays(base, index * period)
    const starts = zonedEpoch(zone, local.year, local.month, local.day, base.hour, base.minute, base.second)
    const allowed = row.until === null || row.until === undefined || starts <= row.until
    if (starts <= threshold && allowed) return [index, starts, starts + duration]
    index -= 1
  }
  return null
}

const occurrenceView = (event, index, starts, ends) => {
  const data = { ...event, starts, ends }
  if (event.recurrence !== 'none') data.occurrence_index = index
  return data
}

export default function calendar(host) {
  const store = openStore(join(host.featureDir(), 'calendar.sqlite3'))
  store.migrate('calendar', MIGRATIONS)

  const eventRow = (workspaceId, id) => store.get('SELECT * FROM calendar_events WHERE id=? AND workspace_id=?', id, workspaceId)
  const reminderRows = (workspaceId, eventId) => store.all(
    'SELECT * FROM calendar_reminders WHERE workspace_id=? AND event_id=? ORDER BY user_id, minutes_before',
    workspaceId, eventId,
  )
  const reminderView = (row) => ({ user_id: row.user_id, minutes_before: row.minutes_before })
  const eventView = (row) => ({
    id: row.id,
    workspace_id: row.workspace_id,
    owner_id: row.owner_id,
    title: row.title,
    starts: row.starts,
    ends: row.ends,
    all_day: Boolean(row.all_day),
    time_zone: row.time_zone,
    location: row.location,
    notes: row.notes,
    recurrence: row.recurrence,
    until: row.until,
    created: row.created,
    updated: row.updated,
    reminders: reminderRows(row.workspace_id, row.id).map(reminderView),
  })
  const payloadObject = (payload) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) invalid('JSON object payload required')
    return payload
  }
  const load = (workspaceId, id) => {
    const row = eventRow(workspaceId, id)
    if (!row) notFound()
    return row
  }

  async function create(payload) {
    const body = payloadObject(payload)
    const workspaceId = workspace(body.workspace_id)
    const owner = identifier(body.owner_id ?? ownerId(), 'owner_id')
    const title = titleOf(body.title)
    const starts = timestamp(body.starts, 'starts')
    const ends = timestamp(body.ends, 'ends')
    if (starts >= ends) invalid('starts must be before ends')
    const now = timestamp(body.now ?? nowSeconds(), 'now')
    const zone = zoneOf(body.time_zone ?? 'UTC')
    const allDay = allDayOf(body.all_day ?? false)
    const location = locationOf(body.location ?? null)
    const notes = notesOf(body.notes ?? null)
    const recurrence = recurrenceOf(body.recurrence ?? 'none')
    const until = untilOf(body.until ?? null, starts)
    const reminders = remindersOf(body.reminders ?? [])
    const id = newId()
    return store.transaction(() => {
      store.run(
        `INSERT INTO calendar_events (id,workspace_id,owner_id,title,starts,ends,all_day,time_zone,location,notes,recurrence,until,created,updated)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, workspaceId, owner, title, starts, ends, allDay ? 1 : 0, zone, location, notes, recurrence, until, now, now,
      )
      for (const item of reminders) {
        store.run(
          'INSERT INTO calendar_reminders (id,workspace_id,event_id,user_id,minutes_before,fired,created) VALUES (?,?,?,?,?,0,?)',
          newId(), workspaceId, id, item.user_id, item.minutes_before, now,
        )
      }
      return { event: eventView(load(workspaceId, id)) }
    })
  }

  async function get(payload) {
    const body = payloadObject(payload)
    const workspaceId = workspace(body.workspace_id)
    const id = identifier(body.id ?? body.event_id, 'event_id')
    return { event: eventView(load(workspaceId, id)) }
  }

  async function update(payload) {
    const body = payloadObject(payload)
    const workspaceId = workspace(body.workspace_id)
    const id = identifier(body.id ?? body.event_id, 'event_id')
    const now = timestamp(body.now ?? nowSeconds(), 'now')
    const changes = body.changes === undefined
      ? Object.fromEntries(Object.entries(body).filter(([key]) => !['workspace_id', 'id', 'event_id', 'now'].includes(key)))
      : body.changes
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) invalid('Invalid changes')
    if (Object.keys(changes).some((key) => !CHANGES.has(key))) invalid('Invalid changes')
    return store.transaction(() => {
      const row = load(workspaceId, id)
      const keys = Object.keys(changes)
      if (!keys.length) return { event: eventView(row) }
      const starts = timestamp(has(changes, 'starts') ? changes.starts : row.starts, 'starts')
      const ends = timestamp(has(changes, 'ends') ? changes.ends : row.ends, 'ends')
      if (starts >= ends) invalid('starts must be before ends')
      const title = titleOf(has(changes, 'title') ? changes.title : row.title)
      const zone = zoneOf(has(changes, 'time_zone') ? changes.time_zone : row.time_zone)
      const allDay = allDayOf(has(changes, 'all_day') ? changes.all_day : Boolean(row.all_day))
      const location = has(changes, 'location') ? locationOf(changes.location) : row.location
      const notes = has(changes, 'notes') ? notesOf(changes.notes) : row.notes
      const recurrence = recurrenceOf(has(changes, 'recurrence') ? changes.recurrence : row.recurrence)
      const until = untilOf(has(changes, 'until') ? changes.until : row.until, starts)
      const reminders = has(changes, 'reminders') ? remindersOf(changes.reminders) : null
      const scheduleChanged = starts !== row.starts || zone !== row.time_zone || recurrence !== row.recurrence || until !== row.until
      store.run(
        `UPDATE calendar_events SET title=?,starts=?,ends=?,all_day=?,time_zone=?,location=?,notes=?,recurrence=?,until=?,updated=?
         WHERE id=? AND workspace_id=?`,
        title, starts, ends, allDay ? 1 : 0, zone, location, notes, recurrence, until, now, id, workspaceId,
      )
      if (scheduleChanged) {
        store.run('UPDATE calendar_reminders SET fired=0 WHERE workspace_id=? AND event_id=?', workspaceId, id)
      }
      if (reminders !== null) {
        const desired = new Set(reminders.map((item) => `${item.user_id}\u0000${item.minutes_before}`))
        for (const item of reminderRows(workspaceId, id)) {
          if (!desired.has(`${item.user_id}\u0000${item.minutes_before}`)) {
            store.run('DELETE FROM calendar_reminders WHERE id=? AND workspace_id=?', item.id, workspaceId)
          }
        }
        for (const item of reminders) {
          store.run(
            `INSERT OR IGNORE INTO calendar_reminders (id,workspace_id,event_id,user_id,minutes_before,fired,created)
             VALUES (?,?,?,?,?,0,?)`,
            newId(), workspaceId, id, item.user_id, item.minutes_before, now,
          )
        }
      }
      return { event: eventView(load(workspaceId, id)) }
    })
  }

  async function cancel(payload) {
    const body = payloadObject(payload)
    const workspaceId = workspace(body.workspace_id)
    const id = identifier(body.id ?? body.event_id, 'event_id')
    timestamp(body.now ?? nowSeconds(), 'now')
    return store.transaction(() => {
      const row = eventRow(workspaceId, id)
      if (!row) return { removed: false }
      store.run('DELETE FROM calendar_reminders WHERE workspace_id=? AND event_id=?', workspaceId, id)
      store.run('DELETE FROM calendar_events WHERE id=? AND workspace_id=?', id, workspaceId)
      return { removed: true }
    })
  }

  async function list(payload) {
    const body = payloadObject(payload)
    const workspaceId = workspace(body.workspace_id)
    const start = timestamp(body.start, 'start')
    const end = timestamp(body.end, 'end')
    if (start > end) invalid('start must not exceed end')
    const limit = listLimit(body.limit)
    const offset = listCursor(body.cursor)
    if (start === end) return { items: [], next_cursor: null }
    const rows = store.all(
      `SELECT * FROM calendar_events WHERE workspace_id=? AND
       ((recurrence='none' AND starts<? AND ends>?) OR (recurrence!='none' AND starts<=?))
       ORDER BY starts, id`,
      workspaceId, end, start, end,
    )
    const expanded = []
    for (const row of rows) {
      const event = eventView(row)
      for (const [index, occurrenceStart, occurrenceEnd] of occurrences(row, start, end)) {
        expanded.push([occurrenceStart, row.id, index, occurrenceView(event, index, occurrenceStart, occurrenceEnd)])
      }
    }
    expanded.sort((a, b) => a[0] - b[0]
      || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)
      || a[2] - b[2])
    const items = expanded.slice(offset, offset + limit).map((item) => item[3])
    const following = offset + items.length
    return { items, next_cursor: following < expanded.length ? String(following) : null }
  }

  async function upcoming(payload) {
    const body = payloadObject(payload)
    const workspaceId = workspace(body.workspace_id)
    const now = timestamp(body.now ?? nowSeconds(), 'now')
    const window = body.window_seconds ?? body.window ?? 86400
    if (!isInt(window) || window < 0 || window > LIMITS.MAX_TIME) invalid('Invalid window_seconds')
    const limit = listLimit(body.limit)
    const result = await list({ workspace_id: workspaceId, start: now, end: Math.min(LIMITS.MAX_TIME, now + window), limit })
    return { items: result.items }
  }

  async function dueReminders(payload) {
    const body = payloadObject(payload)
    const workspaceId = workspace(body.workspace_id)
    const now = timestamp(body.now ?? nowSeconds(), 'now')
    const limit = listLimit(body.limit)
    const rows = store.all(
      `SELECT r.id AS reminder_id, r.user_id AS reminder_user_id, r.minutes_before AS reminder_minutes_before, e.*
       FROM calendar_reminders r JOIN calendar_events e
       ON e.id=r.event_id AND e.workspace_id=r.workspace_id
       WHERE r.fired=0 AND r.workspace_id=? ORDER BY r.id`,
      workspaceId,
    )
    const due = []
    for (const row of rows) {
      const minutes = row.reminder_minutes_before
      const offset = minutes * 60
      const occurrence = latestOccurrence(row, now + offset)
      if (!occurrence) continue
      const [index, starts, ends] = occurrence
      const dueAt = starts - offset
      if (dueAt > now) continue
      due.push({
        id: row.reminder_id,
        reminder_id: row.reminder_id,
        workspace_id: row.workspace_id,
        event_id: row.id,
        user_id: row.reminder_user_id,
        minutes_before: minutes,
        starts,
        ends,
        due_at: dueAt,
        occurrence_index: index,
        title: row.title,
        time_zone: row.time_zone,
        all_day: Boolean(row.all_day),
      })
    }
    due.sort((a, b) => a.due_at - b.due_at || (a.reminder_id < b.reminder_id ? -1 : a.reminder_id > b.reminder_id ? 1 : 0))
    return { items: due.slice(0, limit) }
  }

  async function markReminderFired(payload) {
    const body = payloadObject(payload)
    const workspaceId = workspace(body.workspace_id)
    const reminderId = identifier(body.reminder_id ?? body.id, 'reminder_id')
    timestamp(body.now ?? nowSeconds(), 'now')
    const result = store.run(
      'UPDATE calendar_reminders SET fired=1 WHERE id=? AND workspace_id=? AND fired=0',
      reminderId, workspaceId,
    )
    return { fired: Number(result.changes) > 0 }
  }

  return {
    pages: [],
    endpoints: { create, update, cancel, get, list, upcoming, dueReminders, markReminderFired },
  }
}
