// Automation schedule semantics, ported from openteamily/automations.py so a
// schedule fires at the same slot inside the user's DS-Bot as it did on the
// server: only the latest slot counts, missed earlier days are not backfilled.
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const KINDS = new Set(['now', 'once', 'daily', 'weekly', 'monthly', 'weekdays'])
const WEEKDAY = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }
const formatters = new Map()

export function validZone(zone) {
  if (typeof zone !== 'string' || zone.length < 1 || zone.length > 64) return false
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true } catch { return false }
}

function formatter(zone) {
  let fmt = formatters.get(zone)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' })
    formatters.set(zone, fmt)
  }
  return fmt
}

export function partsIn(zone, ms) {
  const out = {}
  for (const { type, value } of formatter(zone).formatToParts(new Date(ms))) out[type] = value
  return { year: +out.year, month: +out.month, day: +out.day, hour: +out.hour % 24, minute: +out.minute, second: +out.second, isoWeekday: WEEKDAY[out.weekday] }
}

// Unix seconds of a wall-clock time in zone (same resolution as zoneinfo for
// non-ambiguous times).
export function zonedEpoch(zone, year, month, day, hour, minute) {
  const target = Date.UTC(year, month - 1, day, hour, minute)
  let guess = target
  for (let i = 0; i < 3; i += 1) {
    const p = partsIn(zone, guess)
    const diff = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - target
    if (diff === 0) break
    guess -= diff
  }
  return Math.floor(guess / 1000)
}

const validDate = (text) => {
  if (typeof text !== 'string' || !DATE.test(text)) return false
  const [y, m, d] = text.split('-').map(Number)
  const at = new Date(Date.UTC(y, m - 1, d))
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d
}

export function validSchedule(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  let { kind } = value
  if (kind === 'later') { kind = 'once'; value = { ...value, kind } }
  if (!KINDS.has(kind) || !validZone(value.time_zone)) return false
  const keys = new Set(Object.keys(value))
  const same = (want) => keys.size === want.length && want.every((k) => keys.has(k))
  if (kind === 'now') return same(['kind', 'time_zone'])
  if (typeof value.time !== 'string' || !TIME.test(value.time)) return false
  const want = ['kind', 'time', 'time_zone']
  if (kind === 'once') { if (!validDate(value.date)) return false; want.push('date') }
  if (kind === 'weekly') { if (!Number.isInteger(value.weekday) || value.weekday < 1 || value.weekday > 7) return false; want.push('weekday') }
  if (kind === 'monthly') { if (!Number.isInteger(value.day) || value.day < 1 || value.day > 31) return false; want.push('day') }
  return same(want)
}

export function normalizeSchedule(value) {
  const kind = value.kind === 'later' ? 'once' : value.kind
  const out = { kind, time_zone: value.time_zone }
  if (kind !== 'now') out.time = value.time
  if (kind === 'once') out.date = value.date
  if (kind === 'weekly') out.weekday = value.weekday
  if (kind === 'monthly') out.day = value.day
  return out
}

// The current slot's unix time if it is due at nowTs, otherwise null.
export function dueAt(schedule, nowTs) {
  if (!schedule || !validZone(schedule.time_zone)) return null
  const zone = schedule.time_zone
  const { kind } = schedule
  if (kind === 'now') return 0
  if (typeof schedule.time !== 'string' || !TIME.test(schedule.time)) return null
  const [hour, minute] = schedule.time.split(':').map(Number)
  if (kind === 'once') {
    if (!validDate(schedule.date)) return null
    const [y, m, d] = schedule.date.split('-').map(Number)
    const ts = zonedEpoch(zone, y, m, d, hour, minute)
    return nowTs >= ts ? ts : null
  }
  const now = partsIn(zone, nowTs * 1000)
  if (kind === 'weekly' && now.isoWeekday !== schedule.weekday) return null
  if (kind === 'weekdays' && now.isoWeekday > 5) return null
  if (kind === 'monthly' && (!Number.isInteger(schedule.day) || now.day !== schedule.day)) return null
  if (!['daily', 'weekly', 'weekdays', 'monthly'].includes(kind)) return null
  const ts = zonedEpoch(zone, now.year, now.month, now.day, hour, minute)
  return nowTs >= ts ? ts : null
}
