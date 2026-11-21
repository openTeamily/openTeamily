// Stable platform-agent -> actual native roster object. The SQLite record is
// compatibility metadata, not an alternate executor. Native edits are pulled on
// reads; writes use the roster API and all turns target this Bot, never Chief.
import { adoptThread, importHistory } from './history.js'
import { createHash } from 'node:crypto'
import { startOpenPart } from '../../../ds-bot-upstream/ds-bot/src/host/threads.js'

export function nativeAgents({ host, db }) {
  db.exec(`CREATE TABLE IF NOT EXISTS native_agent_objects (
    agent_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL UNIQUE, last_name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS native_agent_sessions (
    conversation_key TEXT PRIMARY KEY, agent_id TEXT NOT NULL, session_id TEXT NOT NULL UNIQUE);`)
  const one = (sql, ...args) => db.prepare(sql).get(...args)
  const run = (sql, ...args) => db.prepare(sql).run(...args)
  let queue = Promise.resolve()
  const serial = fn => { const next = queue.then(fn, fn); queue = next.catch(() => {}); return next }
  const services = async () => { const s = await host.runtime(); await s.mainBot(); return s }
  const nativeName = (rt, row) => {
    const plain = row.name.slice(0, 40)
    const taken = Object.values(rt.state.bots).some(b => b.name === plain && b.openteamily?.agent_id !== row.id)
    return taken || row.name.length > 40 ? row.name.slice(0, 29) + '-' + row.id.slice(0, 10) : plain
  }
  async function ensure(row) {
    const s = await services(), { rt } = s
    const mapping = one('SELECT * FROM native_agent_objects WHERE agent_id=?', row.id)
    // Recover a create whose roster save completed before the mapping commit.
    let bot = mapping ? rt.botOf(mapping.bot_id) : Object.values(rt.state.bots).find(b => b.openteamily?.agent_id === row.id)
    if (!bot && mapping) {
      run('UPDATE agents SET archived=1 WHERE id=?', row.id)
      return { ...row, archived: 1, native_bot_id: mapping.bot_id, native_deleted: true }
    }
    if (!bot) {
      bot = await rt.createBot({ name: nativeName(rt, row), instructions: row.instructions, role: row.summary.slice(0, 24), pickModel: true })
      // Importing/creating an object is not permission to send a greeting.
      delete bot.kickoff
      bot.model = rt.botOf(await s.mainBot())?.model
      bot.capabilities = [...(rt.botOf(await s.mainBot())?.capabilities || [])]
      bot.openteamily = { agent_id: row.id, workspace_id: row.workspace_id, summary: row.summary, category: row.category, quick_starts: JSON.parse(row.quick_starts) }
      if (row.archived) bot.hidden = true
      await rt.save()
    }
    if (!mapping) run('INSERT OR IGNORE INTO native_agent_objects VALUES(?,?,?)', row.id, bot.id, bot.name)
    const lastName = mapping?.last_name || bot.name
    const nextName = bot.name !== lastName ? bot.name : row.name
    const changed = nextName !== row.name || bot.instructions !== row.instructions || Number(!!bot.hidden) !== row.archived
    if (changed) {
      const hash = createHash('sha256').update(nextName.toLowerCase()).digest('hex')
      const collision = one('SELECT id FROM agents WHERE workspace_id=? AND name_hash=? AND id<>?', row.workspace_id, hash, row.id)
      if (collision) throw Object.assign(new Error('Native Bot rename conflicts with workspace agent name'), { status: 409, code: 'agents/conflict' })
      // name_hash updated by the caller with the shared hashing rule.
      run('UPDATE agents SET name=?,name_hash=?,instructions=?,archived=?,revision=revision+1,updated=? WHERE id=?', nextName, hash, bot.instructions || '', Number(!!bot.hidden), Math.floor(Date.now()/1000), row.id)
    }
    run('UPDATE native_agent_objects SET last_name=? WHERE agent_id=?', bot.name, row.id)
    const current = one('SELECT * FROM agents WHERE id=?', row.id)
    return { ...current, native_bot_id: bot.id, native_name: bot.name }
  }
  async function update(row, patch) {
    const mapped = await ensure(row)
    if (mapped.native_deleted) throw Object.assign(new Error('Native Bot was deleted; it will not be silently recreated'), { status: 409, code: 'agents/native-deleted' })
    const { rt } = await services()
    const bot = rt.botOf(mapped.native_bot_id)
    const nativePatch = {}
    if (patch.name !== undefined) nativePatch.name = nativeName(rt, { ...row, name: patch.name })
    if (patch.instructions !== undefined) nativePatch.instructions = patch.instructions
    if (patch.summary !== undefined) nativePatch.role = patch.summary.slice(0,24)
    if (Object.keys(nativePatch).length) await rt.updateBot(bot.id, nativePatch)
    if (patch.archived !== undefined) await rt.setFlags(bot.id, { hidden: !!patch.archived })
    bot.openteamily = { ...bot.openteamily, ...Object.fromEntries(['summary','category','quick_starts'].filter(k => patch[k] !== undefined).map(k => [k,patch[k]])) }
    await rt.save()
    run('UPDATE native_agent_objects SET last_name=? WHERE agent_id=?', bot.name, row.id)
    return { native_bot_id: bot.id, native_name: bot.name }
  }
  async function session(row, key, title) {
    const mapped = await ensure(row)
    if (mapped.native_deleted) throw Object.assign(new Error('Native Bot was deleted'), { status: 409, code: 'agents/native-deleted' })
    const s = await services(), { rt } = s
    const bot = rt.botOf(mapped.native_bot_id)
    const reconcile = async () => {
      let m = one('SELECT * FROM native_agent_sessions WHERE conversation_key=?', key)
      const conversationId = key.slice(('agent:' + row.id + ':').length)
      const privateConversation = one('SELECT id FROM agent_conversations WHERE id=? AND agent_id=?', conversationId, row.id)
      const personal = privateConversation && one('SELECT 1 FROM native_personal_binding WHERE singleton=1 AND agent_id=? AND workspace_id=?', row.id, row.workspace_id)
      const legacyIds = [...new Set([s.legacySession?.(key), privateConversation ? s.legacySession?.(conversationId) : undefined, personal ? s.legacySession?.('plugin:' + conversationId) : undefined].filter(Boolean))]
      const adopted = []
      for (const legacyId of legacyIds) adopted.push(await adoptThread({ rt, source: rt.botOf(await s.mainBot()), target: bot, sessionId: legacyId }))
      bot.openteamily.sessionKeys ??= {}
      if (!m) {
        const recovered = bot.openteamily.sessionKeys[key]
        const sessionId = recovered || adopted[0] || await rt.createSession(title || row.name, { dir: rt.workDirOf({ botId: bot.id }) })
        if (!recovered && !adopted.length) { startOpenPart(bot, sessionId); rt.chatOwners.set(sessionId, bot.id) }
        bot.openteamily.sessionKeys[key] = sessionId
        await rt.save()
        run('INSERT INTO native_agent_sessions VALUES(?,?,?)', key, row.id, sessionId)
        m = { session_id: sessionId }
      } else if (adopted.length) await rt.save()
      const counts = await importHistory({ db, rt, ctx: s.ctx, bot, conversationId, sessionId: m.session_id, secondarySessionIds: adopted })
      return { ...m, history: counts }
    }
    const m = s.exclusive ? await s.exclusive(reconcile) : await reconcile()

    return { native_bot_id: mapped.native_bot_id, native_session_id: m.session_id, native_name: mapped.native_name }
  }
  return { ensure: row => serial(() => ensure(row)), update: (row,patch) => serial(() => update(row,patch)), session: (row,key,title) => serial(() => session(row,key,title)) }
}
