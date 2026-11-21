import { importPending } from '../../src/pending-import.js'
// Automations + scheduler inside the user's own DS-Bot (batch B2, replaces the
// server-side openteamily/automations.py + scheduler.py for moved users).
//
// - Definitions, editor state and run records live in this DS-Bot's own storage
//   (features/automations/automations.sqlite3 on the user's volume).
// - The clock runs here: a timer in the DS-Bot process evaluates every enabled
//   automation with the same slot rules as the server (schedule.js) and fires it.
// - A run is a real DS-Bot turn on this runtime (runtime service chatTurn) in that
//   automation's own native chat, so the reply, history, skills and tools are
//   DS-Bot's. No runtime_tasks row and no server queue are involved.
import { createHash } from 'node:crypto'
import { TEMPLATES, INTENTS } from './templates.js'
import { dueAt, normalizeSchedule, validSchedule } from './schedule.js'
import { newId } from '../../src/store.js'
import { automationsV1 } from './v1.js'
import { importOfficialBundle, recordLegacyRuns } from './migrate.js'

const nowSec = () => Math.floor(Date.now() / 1000)
export function refuse(status, code, message, details) {
  throw Object.assign(new Error(message), { code: `automations/${code}`, status, details })
}
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try { const value = fn(); db.exec('COMMIT'); return value } catch (error) { try { db.exec('ROLLBACK') } catch {} throw error }
}

// One DS-Bot turn through the runtime wrapper's chatTurn service (B1 contract).
export function dsBotTurn(host) {
  return async ({ conversation, prompt, requestId, skillScope }) => {
    const services = await host.runtime()
    if (typeof services?.chatTurn !== 'function') throw Object.assign(new Error('DS-Bot chat service unavailable'), { code: 'automations/runtime-unavailable' })
    const material = skillScope ? await host.call('skills/materialForScope', { scope: skillScope }) : { items: [] }
    const context = material.items.map(i => i.content).join('\n\n')
    const reply = await services.chatTurn(conversation, context ? `[User-approved instruction-only skills]\n${context}\n\n${prompt}` : prompt, requestId)
    return { text: reply?.text, session_id: reply?.sessionId ?? null, turn_id: reply?.turnId ?? null }
  }
}

export const MAX_AUTOMATIONS = 100
export const MAX_RUNS = 200
export const TICK_MS = 15_000
const SCOPES = new Set(['once', 'ongoing'])
const REMINDER = 'reminder'
const RESULT_TEXT = 8000
const IDEM = /^[A-Za-z0-9_-]{16,64}$/
const HEX32 = /^[0-9a-f]{32}$/
const USERNAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$/
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ot_automations (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, title TEXT NOT NULL, title_hash TEXT NOT NULL,
 prompt TEXT NOT NULL, template_id TEXT NOT NULL, schedule TEXT NOT NULL, participants TEXT NOT NULL,
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), revision INTEGER NOT NULL CHECK(revision >= 1),
 created INTEGER NOT NULL, updated INTEGER NOT NULL, key_hash TEXT NOT NULL, request_hash TEXT NOT NULL,
 intent TEXT NOT NULL DEFAULT '', scope TEXT NOT NULL DEFAULT 'once', agents TEXT NOT NULL DEFAULT '[]',
 compiled INTEGER NOT NULL DEFAULT 0, imported_from TEXT,
 UNIQUE(workspace_id, key_hash), UNIQUE(workspace_id, title_hash));
CREATE TABLE IF NOT EXISTS ot_automation_runs (
 id TEXT PRIMARY KEY, automation_id TEXT NOT NULL REFERENCES ot_automations(id) ON DELETE CASCADE,
 workspace_id TEXT NOT NULL, due_at INTEGER NOT NULL, started INTEGER NOT NULL, finished INTEGER,
 status TEXT NOT NULL CHECK(status IN ('queued','succeeded','failed','skipped')), error_code TEXT,
 dispatch TEXT NOT NULL, attempt_of TEXT, UNIQUE(automation_id, due_at));
CREATE INDEX IF NOT EXISTS ot_automation_run_list ON ot_automation_runs(automation_id, id);
CREATE TABLE IF NOT EXISTS ot_automation_retries (
 run_id TEXT NOT NULL, key_hash TEXT NOT NULL, new_run_id TEXT NOT NULL, created INTEGER NOT NULL,
 PRIMARY KEY(run_id, key_hash));
CREATE TABLE IF NOT EXISTS ot_automation_manual_runs (
 automation_id TEXT NOT NULL REFERENCES ot_automations(id) ON DELETE CASCADE,
 key_hash TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES ot_automation_runs(id) ON DELETE CASCADE,
 PRIMARY KEY(automation_id, key_hash));
`

const sha = (text) => createHash('sha256').update(String(text)).digest('hex')

export const validTitle = (v) => typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= 80 && !CONTROL.test(v)
export const validPrompt = (v) => typeof v === 'string' && v.length >= 1 && v.length <= 4000 && !v.includes('\u0000')
const validIntent = (v) => v === '' || Object.hasOwn(INTENTS, v)
const validAgents = (v) => {
  if (!Array.isArray(v) || v.length > 20) return false
  const seen = new Set()
  for (const name of v) {
    if (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 64 || name.includes('\u0000')) return false
    const key = name.trim().toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
  }
  return true
}
const validUsernames = (v) => {
  if (!Array.isArray(v) || v.length < 1 || v.length > 20) return false
  const seen = new Set()
  for (const name of v) {
    if (typeof name !== 'string' || !USERNAME.test(name) || seen.has(name.toLowerCase())) return false
    seen.add(name.toLowerCase())
  }
  return true
}

export function compilePrompt(templateId, intent, scope, schedule, participants, agents) {
  const template = TEMPLATES[templateId] ?? TEMPLATES.custom
  const lines = []
  if (template.prompt) lines.push(template.prompt)
  if (intent) lines.push('意图：' + (INTENTS[intent] ?? intent))
  lines.push(scope === 'once' ? '范围：只运行一次' : '范围：长期运行')
  const zone = schedule.time_zone ?? ''
  const when = {
    now: () => '时间：立即运行（只触发一次）',
    once: () => `时间：在 ${schedule.date} ${schedule.time}（${zone}）运行一次`,
    daily: () => `时间：每天 ${schedule.time}（${zone}）`,
    weekly: () => `时间：每周第 ${schedule.weekday} 天 ${schedule.time}（${zone}）`,
    monthly: () => `时间：每月 ${schedule.day} 日 ${schedule.time}（${zone}）`,
    weekdays: () => `时间：工作日 ${schedule.time}（${zone}）`,
  }[schedule.kind]
  lines.push(when ? when() : '时间：按给定安排')
  if (agents.length) lines.push('参与的智能体：' + agents.map((n) => n.trim()).join('、'))
  if (participants.length) lines.push('参与的成员：' + participants.join('、'))
  return lines.join('\n')
}

function view(row) {
  return {
    id: row.id, workspace_id: row.workspace_id, title: row.title, prompt: row.prompt, template_id: row.template_id,
    schedule: JSON.parse(row.schedule), participants: JSON.parse(row.participants), enabled: row.enabled === 1,
    revision: row.revision, created: row.created, updated: row.updated, intent: row.intent, scope: row.scope,
    agents: JSON.parse(row.agents), compiled: row.compiled === 1, served_by: 'ds-bot',
  }
}

export function runView(row) {
  let dispatch = {}
  try { dispatch = JSON.parse(row.dispatch) || {} } catch { dispatch = {} }
  let status = row.status
  if (row.error_code === 'cancelled') status = 'cancelled'
  else if (row.error_code === 'timeout') status = 'timeout'
  const out = {
    id: row.id, automation_id: row.automation_id, workspace_id: row.workspace_id, due_at: row.due_at < 0 ? row.started : row.due_at,
    started: row.started, finished: row.finished, status, error_code: row.error_code,
    ...(row.due_at < 0 ? { trigger: 'manual' } : {}),
    dispatch: { backend: 'ds-bot', ...(dispatch.ds_bot ? { ds_bot: dispatch.ds_bot } : {}) },
  }
  if (dispatch.result && typeof dispatch.result === 'object') out.result = dispatch.result
  return out
}

export function createAutomations({ db, turn, clock = nowSec, tickMs = TICK_MS, log = console.error, personalBinding }) {
  db.exec(SCHEMA)
  const inflight = new Map() // run id -> promise
  let timer = null

  const one = (sql, ...args) => db.prepare(sql).get(...args)
  const all = (sql, ...args) => db.prepare(sql).all(...args)
  const run = (sql, ...args) => db.prepare(sql).run(...args)

  const workspaceOf = (payload) => {
    const id = payload?.workspace_id
    if (typeof id !== 'string' || !HEX32.test(id)) refuse(400, 'invalid', 'workspace_id required')
    return id
  }
  const load = (workspaceId, id) => {
    if (typeof id !== 'string' || !HEX32.test(id)) refuse(404, 'not_found', 'Automation not found')
    const row = one('SELECT * FROM ot_automations WHERE id=? AND workspace_id=?', id, workspaceId)
    if (!row) refuse(404, 'not_found', 'Automation not found')
    return row
  }
  const loadRun = (row, runId) => {
    const item = typeof runId === 'string' && HEX32.test(runId)
      ? one('SELECT * FROM ot_automation_runs WHERE id=? AND automation_id=?', runId, row.id) : undefined
    if (!item) refuse(404, 'not_found', 'Automation run not found')
    return item
  }

  function finish(runId, status, error, patch) {
    const row = one('SELECT * FROM ot_automation_runs WHERE id=?', runId)
    if (!row || row.status !== 'queued') return row // cancelled meanwhile: keep the cancel
    let dispatch = {}
    try { dispatch = JSON.parse(row.dispatch) || {} } catch { dispatch = {} }
    Object.assign(dispatch, patch)
    run('UPDATE ot_automation_runs SET finished=?, status=?, error_code=?, dispatch=? WHERE id=?', clock(), status, error, JSON.stringify(dispatch), runId)
    return one('SELECT * FROM ot_automation_runs WHERE id=?', runId)
  }

  // Execute one queued run as a DS-Bot turn. Never throws.
  function execute(runId) {
    if (inflight.has(runId)) return inflight.get(runId)
    const job = (async () => {
      const item = one('SELECT r.*, a.title, a.prompt FROM ot_automation_runs r JOIN ot_automations a ON a.id=r.automation_id WHERE r.id=?', runId)
      if (!item || item.status !== 'queued') return
      try {
        const reply = await turn({
          skillScope: `automation:${item.workspace_id}:${item.automation_id}`,
          conversation: `automation:${item.automation_id}`,
          prompt: `[OpenTeamily 自动化 · ${item.title}]\n${item.prompt}`,
          requestId: `ot-automation:${runId}`,
        })
        const text = String(reply?.text ?? '').trim()
        if (!text) { finish(runId, 'failed', 'empty_reply', { result: { error: 'DS-Bot turn ended without a reply' } }); return }
        finish(runId, 'succeeded', null, {
          result: { text: text.slice(0, RESULT_TEXT), ...(typeof reply.model === 'string' ? { model: reply.model.slice(0, 200) } : {}) },
          ds_bot: { engine: 'ds-bot', session_id: reply.session_id ?? null, turn_id: reply.turn_id ?? null, bot_id: reply.bot_id ?? null, model_calls: reply.model_calls ?? null },
        })
      } catch (error) {
        const code = /runtime-unavailable$/.test(String(error?.code)) ? 'runtime_unavailable'
          : /timed out/i.test(String(error?.message)) ? 'timeout' : 'runtime_failed'
        finish(runId, 'failed', code, { result: { error: code === 'timeout' ? 'DS-Bot turn timed out' : 'DS-Bot turn failed; no automatic retry' } })
        log(`openteamily-web: automation run ${runId} failed (${code})`)
      }
    })().finally(() => inflight.delete(runId))
    inflight.set(runId, job)
    return job
  }

  function insertRun(row, due, attemptOf = null) {
    const count = one('SELECT COUNT(*) AS n FROM ot_automation_runs WHERE automation_id=?', row.id).n
    if (count >= MAX_RUNS) return null
    const id = newId()
    run('INSERT INTO ot_automation_runs VALUES(?,?,?,?,?,?,?,?,?,?)', id, row.id, row.workspace_id, due, clock(), null, 'queued', null, JSON.stringify({ backend: 'ds-bot' }), attemptOf)
    return id
  }

  // Evaluate every enabled automation (optionally one workspace) and fire due slots.
  function tick(workspaceId = null) {
    const now = clock()
    const rows = workspaceId
      ? all('SELECT * FROM ot_automations WHERE enabled=1 AND workspace_id=? ORDER BY id', workspaceId)
      : all('SELECT * FROM ot_automations WHERE enabled=1 ORDER BY id')
    const fired = []
    for (const row of rows) {
      const due = dueAt(JSON.parse(row.schedule), now)
      if (due === null) continue
      const id = tx(db, () => (one('SELECT id FROM ot_automation_runs WHERE automation_id=? AND due_at=?', row.id, due) ? null : insertRun(row, due)))
      if (!id) continue
      void execute(id)
      fired.push(runView(one('SELECT * FROM ot_automation_runs WHERE id=?', id)))
    }
    return fired
  }

  function start() {
    // Runs left queued by a previous process never got their DS-Bot turn: run them now.
    for (const { id } of all("SELECT id FROM ot_automation_runs WHERE status='queued' ORDER BY id")) void execute(id)
    try { tick() } catch (error) { log('openteamily-web: automation tick failed: ' + (error?.message ?? 'error')) }
    timer = setInterval(() => {
      try { tick() } catch (error) { log('openteamily-web: automation tick failed: ' + (error?.message ?? 'error')) }
    }, tickMs)
    timer.unref?.()
  }
  function stop() { if (timer) clearInterval(timer); timer = null }

  function createInTransaction(payload) {
    const workspaceId = workspaceOf(payload)
    const { title, template_id: templateId, schedule, participants: names } = payload
    const intent = payload.intent ?? ''
    const scope = payload.scope ?? 'once'
    const agents = payload.agents ?? []
    const enabled = payload.enabled === undefined ? templateId === REMINDER : payload.enabled
    if (!validTitle(title) || !Object.hasOwn(TEMPLATES, templateId) || !validSchedule(schedule) || !validUsernames(names)
      || !validIntent(intent) || !SCOPES.has(scope) || !validAgents(agents)) {
      refuse(400, 'invalid', 'Provide a title, prompt, template, schedule and participants')
    }
    if (typeof enabled !== 'boolean') refuse(400, 'invalid', 'enabled must be a boolean')
    const key = String(payload.idempotency_key ?? '')
    if (!IDEM.test(key)) refuse(400, 'invalid', 'Supply a 16–64 character Idempotency-Key')
    const sched = normalizeSchedule(schedule)
    const compiledPrompt = compilePrompt(templateId, intent, scope, sched, names, agents)
    let prompt = payload.prompt
    let compiled
    if (prompt === undefined || prompt === null || prompt === '') { prompt = compiledPrompt; compiled = true }
    else if (validPrompt(prompt)) compiled = prompt === compiledPrompt
    else refuse(400, 'invalid', 'Provide a title, prompt, template, schedule and participants')
    const clean = title.trim()
    const requestHash = sha(JSON.stringify({ agents, intent, participants: names, prompt, schedule: sched, scope, template_id: templateId, title: clean,
      ...(payload.enabled === undefined ? {} : { enabled }) }))
    const keyHash = sha(key)
    const existing = one('SELECT * FROM ot_automations WHERE workspace_id=? AND key_hash=?', workspaceId, keyHash)
    if (existing) {
      const replay = existing.template_id === REMINDER && templateId === REMINDER
      if (existing.request_hash !== requestHash && !replay) refuse(409, 'conflict', 'Idempotency key was used for a different request')
      return { status: 200, automation: view(existing) }
    }
    if (one('SELECT id FROM ot_automations WHERE workspace_id=? AND title_hash=?', workspaceId, sha(clean.toLowerCase()))) {
      refuse(409, 'conflict', 'An automation with this title already exists')
    }
    if (one('SELECT COUNT(*) AS n FROM ot_automations WHERE workspace_id=?', workspaceId).n >= MAX_AUTOMATIONS) refuse(429, 'quota', 'Automation capacity reached')
    const id = newId()
    const now = clock()
    run('INSERT INTO ot_automations (id, workspace_id, title, title_hash, prompt, template_id, schedule, participants, enabled, revision, created, updated, key_hash, request_hash, intent, scope, agents, compiled) VALUES(?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?)',
      id, workspaceId, clean, sha(clean.toLowerCase()), prompt, templateId, JSON.stringify(sched),
      JSON.stringify(names.map((username) => ({ username }))), enabled ? 1 : 0, now, now, keyHash, requestHash,
      intent, scope, JSON.stringify(agents.map((n) => n.trim())), compiled ? 1 : 0)
    return { status: 201, automation: view(one('SELECT * FROM ot_automations WHERE id=?', id)) }
  }

  function createOnboarding(payload) {
    const workspaceId = workspaceOf(payload)
    const ids = payload.template_ids
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 6 || new Set(ids).size !== ids.length
      || ids.some(id => typeof id !== 'string' || id === 'custom' || id === REMINDER || !Object.hasOwn(TEMPLATES, id))) {
      refuse(400, 'invalid', 'Provide 1–6 known automation templates')
    }
    return tx(db, () => {
      const created = [], skipped = []
      for (const id of ids) {
        const title = TEMPLATES[id].title
        if (one('SELECT 1 FROM ot_automations WHERE workspace_id=? AND title_hash=?', workspaceId, sha(title.toLowerCase()))) {
          skipped.push({ template_id: id, title })
          continue
        }
        const result = createInTransaction({
          workspace_id: workspaceId, title, template_id: id,
          schedule: { kind: 'daily', time: '09:00', time_zone: 'Asia/Shanghai' },
          participants: [payload.username], scope: 'ongoing', idempotency_key: 'onboarding-template-' + id,
        })
        if (result.status === 201) created.push({ id: result.automation.id, template_id: id, title })
        else skipped.push({ template_id: id, title })
      }
      return { status: created.length ? 201 : 200, created, skipped }
    })
  }

  function update(payload) {
    const workspaceId = workspaceOf(payload)
    return tx(db, () => {
      const row = load(workspaceId, payload.id)
      const { revision, changes } = payload
      if (!Number.isInteger(revision) || revision < 1 || !changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length) {
        refuse(400, 'invalid', 'Provide the current revision and a non-empty changes object')
      }
      const allowed = new Set(['title', 'prompt', 'schedule', 'participants', 'enabled', 'intent', 'scope', 'agents'])
      if (Object.keys(changes).some((k) => !allowed.has(k))) refuse(400, 'invalid', 'Unknown automation field')
      const current = view(row)
      if (revision !== current.revision) refuse(409, 'conflict', 'Automation changed elsewhere; reload and retry', { automation: current })
      const next = { ...current, participants: current.participants.map((p) => p.username) }
      const bad = () => refuse(400, 'invalid', 'Provide a title, prompt, template, schedule and participants')
      if ('title' in changes) { if (!validTitle(changes.title)) bad(); next.title = changes.title.trim() }
      if ('prompt' in changes) { if (!validPrompt(changes.prompt)) bad(); next.prompt = changes.prompt }
      if ('schedule' in changes) { if (!validSchedule(changes.schedule)) bad(); next.schedule = normalizeSchedule(changes.schedule) }
      if ('participants' in changes) { if (!validUsernames(changes.participants)) bad(); next.participants = changes.participants }
      if ('intent' in changes) { if (!validIntent(changes.intent)) bad(); next.intent = changes.intent }
      if ('scope' in changes) { if (!SCOPES.has(changes.scope)) bad(); next.scope = changes.scope }
      if ('agents' in changes) { if (!validAgents(changes.agents)) bad(); next.agents = changes.agents.map((n) => n.trim()) }
      if ('enabled' in changes) { if (typeof changes.enabled !== 'boolean') refuse(400, 'invalid', 'enabled must be a boolean'); next.enabled = changes.enabled }
      let compiled = current.compiled
      if ('prompt' in changes) compiled = false
      else if (compiled) next.prompt = compilePrompt(current.template_id, next.intent, next.scope, next.schedule, next.participants, next.agents)
      if (next.title !== current.title) {
        const clash = one('SELECT id FROM ot_automations WHERE workspace_id=? AND title_hash=? AND id<>?', workspaceId, sha(next.title.toLowerCase()), row.id)
        if (clash) refuse(409, 'conflict', 'An automation with this title already exists')
      }
      run('UPDATE ot_automations SET title=?, title_hash=?, prompt=?, schedule=?, participants=?, enabled=?, intent=?, scope=?, agents=?, compiled=?, revision=revision+1, updated=? WHERE id=?',
        next.title, sha(next.title.toLowerCase()), next.prompt, JSON.stringify(next.schedule),
        JSON.stringify(next.participants.map((username) => ({ username }))), next.enabled ? 1 : 0, next.intent, next.scope,
        JSON.stringify(next.agents), compiled ? 1 : 0, clock(), row.id)
      return { automation: view(one('SELECT * FROM ot_automations WHERE id=?', row.id)) }
    })
  }

  function list(payload) {
    const workspaceId = workspaceOf(payload)
    const needle = String(payload.q ?? '').trim().toLowerCase()
    if (needle.length > 80) refuse(400, 'invalid', 'Invalid automation request')
    const category = payload.category ?? ''
    if (category && !['work', 'life', 'custom', 'mine'].includes(category)) refuse(400, 'invalid', 'Invalid automation request')
    const me = String(payload.username ?? '').toLowerCase()
    const items = []
    for (const row of all('SELECT * FROM ot_automations WHERE workspace_id=? ORDER BY id', workspaceId)) {
      const item = view(row)
      if (needle && !item.title.toLowerCase().includes(needle) && !item.prompt.toLowerCase().includes(needle)) continue
      const template = TEMPLATES[item.template_id] ?? TEMPLATES.custom
      if (category === 'mine') { if (!item.participants.some((p) => p.username.toLowerCase() === me)) continue }
      else if (category && template.category !== category) continue
      items.push(item)
    }
    return { items }
  }

  function runs(payload) {
    const row = load(workspaceOf(payload), payload.id)
    const limit = payload.limit ?? 20
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) refuse(400, 'invalid', 'Invalid pagination parameters')
    const cursor = payload.cursor ?? ''
    if (cursor && !HEX32.test(cursor)) refuse(400, 'invalid', 'Invalid pagination parameters')
    const status = payload.status ?? ''
    if (status && !['queued', 'succeeded', 'failed', 'skipped'].includes(status)) refuse(400, 'invalid', 'Invalid run status')
    const after = cursor && loadRun(row, cursor)
    const params = [row.id]
    let filter = 'automation_id=?'
    if (status) { filter += ' AND status=?'; params.push(status) }
    if (after) { filter += ' AND (started,id)<(?,?)'; params.push(after.started, after.id) }
    const rows = all(`SELECT * FROM ot_automation_runs WHERE ${filter} ORDER BY started DESC, id DESC LIMIT ?`, ...params, limit + 1)
    return { items: rows.slice(0, limit).map(runView), cursor: rows.length > limit ? rows[limit - 1].id : null }
  }

  function runNow(payload) {
    const row = load(workspaceOf(payload), payload.id)
    const key = String(payload.idempotency_key ?? '')
    if (!IDEM.test(key)) refuse(400, 'invalid', 'Supply a 16–64 character Idempotency-Key')
    const keyHash = sha(key)
    const outcome = tx(db, () => {
      const prior = one(`SELECT r.* FROM ot_automation_manual_runs m JOIN ot_automation_runs r ON r.id=m.run_id
        WHERE m.automation_id=? AND m.key_hash=?`, row.id, keyHash)
      if (prior) return { status: 200, run: runView(prior) }
      if (one("SELECT 1 FROM ot_automation_runs WHERE automation_id=? AND status='queued'", row.id)) {
        refuse(409, 'already_running', '这条自动化正在运行。')
      }
      // Keep manual runs and scheduled slots distinct.
      const slot = Math.min(0, one('SELECT MIN(due_at) AS m FROM ot_automation_runs WHERE automation_id=?', row.id).m ?? 0) - 1
      const id = insertRun(row, slot)
      if (!id) refuse(429, 'quota', 'Automation run capacity reached')
      run('INSERT INTO ot_automation_manual_runs VALUES(?,?,?)', row.id, keyHash, id)
      return { status: 202, run: runView(one('SELECT * FROM ot_automation_runs WHERE id=?', id)) }
    })
    if (outcome.status === 202) void execute(outcome.run.id)
    return outcome
  }

  function cancel(payload) {
    const row = load(workspaceOf(payload), payload.id)
    const item = loadRun(row, payload.run_id)
    if (item.status !== 'queued') refuse(409, 'conflict', 'Automation run cannot be cancelled')
    run('UPDATE ot_automation_runs SET finished=?, status=?, error_code=?, dispatch=? WHERE id=?', clock(), 'failed', 'cancelled', JSON.stringify({ backend: 'ds-bot', result: { cancelled: true } }), item.id)
    return { run: runView(one('SELECT * FROM ot_automation_runs WHERE id=?', item.id)) }
  }

  function retry(payload) {
    const row = load(workspaceOf(payload), payload.id)
    const key = String(payload.idempotency_key ?? '')
    if (!IDEM.test(key)) refuse(400, 'invalid', 'Supply a 16–64 character Idempotency-Key')
    const item = loadRun(row, payload.run_id)
    const keyHash = sha('automation-retry:' + key)
    const outcome = tx(db, () => {
      const prior = one('SELECT * FROM ot_automation_retries WHERE run_id=? AND key_hash=?', item.id, keyHash)
      if (prior) {
        const again = one('SELECT * FROM ot_automation_runs WHERE id=?', prior.new_run_id)
        if (again) return { status: 200, run: runView(again) }
      }
      if (item.status !== 'failed') refuse(409, 'conflict', 'Only a failed run can be retried')
      // A retry is its own slot: one second after the latest slot of this automation.
      const latest = one('SELECT MAX(due_at) AS m FROM ot_automation_runs WHERE automation_id=?', row.id).m ?? 0
      const id = insertRun(row, Math.max(latest + 1, clock()), item.id)
      if (!id) refuse(429, 'quota', 'Automation run capacity reached')
      run('INSERT INTO ot_automation_retries VALUES(?,?,?,?)', item.id, keyHash, id, clock())
      return { status: 201, id }
    })
    if (outcome.run) return outcome
    void execute(outcome.id)
    return { status: 201, run: runView(one('SELECT * FROM ot_automation_runs WHERE id=?', outcome.id)), retried: runView(item) }
  }

  // Legacy rows (management export bundle for this user) imported idempotently by id.
  function importRows(payload) {
    const rows = Array.isArray(payload?.automations) ? payload.automations : null
    if (!rows || rows.length > MAX_AUTOMATIONS) refuse(400, 'invalid', 'automations list required')
    let imported = 0
    tx(db, () => {
      for (const r of rows) {
        if (!r || !HEX32.test(String(r.id)) || !HEX32.test(String(r.workspace_id)) || !validTitle(r.title) || !validPrompt(r.prompt)
          || !Object.hasOwn(TEMPLATES, r.template_id) || !validSchedule(r.schedule)) refuse(400, 'invalid', 'Invalid legacy automation row')
        if (one('SELECT id FROM ot_automations WHERE id=?', r.id)) continue
        const title = r.title.trim()
        if (one('SELECT id FROM ot_automations WHERE workspace_id=? AND title_hash=?', r.workspace_id, sha(title.toLowerCase()))) continue
        const participants = Array.isArray(r.participants) ? r.participants.filter((p) => p && USERNAME.test(String(p.username))).map((p) => ({ username: p.username })) : []
        run('INSERT INTO ot_automations (id, workspace_id, title, title_hash, prompt, template_id, schedule, participants, enabled, revision, created, updated, key_hash, request_hash, intent, scope, agents, compiled, imported_from) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          r.id, r.workspace_id, title, sha(title.toLowerCase()), r.prompt, r.template_id, JSON.stringify(normalizeSchedule(r.schedule)),
          JSON.stringify(participants), r.enabled ? 1 : 0, Number.isInteger(r.revision) && r.revision >= 1 ? r.revision : 1,
          Number(r.created) || clock(), Number(r.updated) || clock(), sha('import:' + r.id), sha('import:' + r.id),
          validIntent(r.intent ?? '') ? (r.intent ?? '') : '', SCOPES.has(r.scope) ? r.scope : 'once',
          JSON.stringify(validAgents(r.agents ?? []) ? (r.agents ?? []) : []), r.compiled ? 1 : 0, 'management')
        // The last legacy slot counts as already run, so a migrated schedule never fires twice.
        const due = dueAt(normalizeSchedule(r.schedule), clock())
        if (due !== null) run('INSERT OR IGNORE INTO ot_automation_runs VALUES(?,?,?,?,?,?,?,?,?,?)', newId(), r.id, r.workspace_id, due, clock(), clock(), 'skipped', 'migrated', JSON.stringify({ backend: 'ds-bot' }), null)
        imported += 1
      }
    })
    return { imported }
  }

  const endpoints = {
    'automations/templates': () => ({ items: Object.values(TEMPLATES).map((t) => ({ ...t })) }),
    'automations/list': list,
    'automations/get': (p) => ({ automation: view(load(workspaceOf(p), p?.id)) }),
    'automations/create': (p) => tx(db, () => createInTransaction(p)),
    'automations/createOnboarding': createOnboarding,
    'automations/update': update,
    'automations/remove': (p) => {
      const row = load(workspaceOf(p), p?.id)
      run('DELETE FROM ot_automations WHERE id=?', row.id)
      return { removed: view(row) }
    },
    'automations/runs': runs,
    'automations/runNow': runNow,
    'automations/run': (p) => ({ run: runView(loadRun(load(workspaceOf(p), p?.id), p?.run_id)) }),
    'automations/cancel': cancel,
    'automations/retry': retry,
    'automations/tick': (p) => ({ items: tick(workspaceOf(p)) }),
    'automations/import': importRows,
  }

  const ops = {}
  for (const [name, handler] of Object.entries(endpoints)) ops[name.slice('automations/'.length)] = handler
  ops.v1 = automationsV1({ endpoints: ops, log, personalBinding })
  ops.importRuns = (p) => ({ imported: recordLegacyRuns(db, p) })
  endpoints['automations/v1'] = ops.v1
  endpoints['automations/import-runs'] = ops.importRuns
  const migrate = async (bundle) => (bundle?.format === 'openteamily-dsbot-import' ? importOfficialBundle(ops, bundle) : ops.import(bundle))
  return { db, endpoints, ops, migrate, tick, start, stop, execute, inflight }
}

export default async function automations(host) {
  const { openDatabase } = await import('../../src/store.js')
  const db = await openDatabase(host, 'automations.sqlite3')
  const feature = createAutomations({ db, turn: dsBotTurn(host), log: host.log,
    personalBinding: () => host.call('agents/personal-binding', {}) })
  const imported = await importPending({ host, db, migrate: feature.migrate })
  // The clock starts once this user's DS-Bot is attached, so no slot fires into a
  // runtime that is still booting.
  if (!imported.some(item => item.status === 'rejected') && process.env.OPENTEAMILY_AUTOMATIONS_CLOCK !== '0') host.runtime({ timeoutMs: 10 * 60_000 }).then(() => feature.start(), () => feature.start())
  const ops = {}
  for (const [name, handler] of Object.entries(feature.ops)) {
    if (name !== 'createOnboarding') ops[name] = async (payload) => handler(payload ?? {})
  }
  ops.v1 = feature.ops.v1
  ops.importRuns = feature.ops.importRuns
  return { pages: ['automations'], endpoints: ops, migrate: feature.migrate }
}
