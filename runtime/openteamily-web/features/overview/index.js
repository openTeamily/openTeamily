// Home summaries read actual per-user feature stores and Bot Social, not the
// management DB's obsolete copies. Counts traverse the real bounded collections.
import { compatHandler } from '../../lib/b4/compat.js'
import { Fault } from '../../lib/b4/http.js'
import { sharedBotSocial } from '../../lib/c/bot-social.js'

export default function overview(host) {
  const bs = () => sharedBotSocial(host)
  async function collection(feature, wid) {
    const rows = [], seen = new Set()
    let cursor = ''
    do {
      const out = await host.call(feature + '/v1', { method: 'GET', path: `/v1/workspaces/${wid}/${feature}?limit=50${cursor ? '&cursor=' + cursor : ''}` })
      if (out.status !== 200) throw new Fault(out.status || 503, out.body?.error?.code || 'unavailable', out.body?.error?.message || 'Summary source unavailable')
      rows.push(...(out.body.items || []))
      cursor = out.body.cursor
      if (cursor && seen.has(cursor)) throw new Fault(503, 'invalid_cursor', 'Summary source repeated a cursor')
      seen.add(cursor)
    } while (cursor)
    return rows
  }
  const summary = async wid => {
    const team = await bs().get('/v1/ot/teams/by-workspace/' + wid)
    const [agents, artifacts, meetings, automations, social, notices] = await Promise.all([
      host.call('agents/list', { workspace_id: wid }), collection('artifacts', wid), collection('meetings', wid),
      host.call('automations/list', { workspace_id: wid }), bs().get('/v1/ot/conversations'),
      bs().get('/v1/ot/notifications?limit=1&workspace_id=' + wid),
    ])
    const conversations = []
    for (const agent of agents.items || []) {
      const page = await host.call('agents/conversations', { workspace_id: wid, id: agent.id })
      conversations.push(...page.items.map(c => ({ ...c, source: 'agent', agent_name: agent.name })))
    }
    conversations.push(...(social.conversations || []).filter(c => c.team_id === team.id).map(c => ({ id: c.id, title: c.title, source: 'social', updated: Math.floor(c.updated_at/1000), unread_count: c.unread })))
    return { workspace: { id: wid, name: team.name, kind: team.kind || (team.slug ? 'team' : 'workspace') },
      recent_conversations: conversations, recent_artifacts: artifacts, recent_meetings: meetings,
      counts: { agents: agents.items.length, artifacts: artifacts.length, meetings: meetings.length, automations: automations.items.length },
      unread_notifications: notices.unread }
  }
  return { endpoints: { v1: compatHandler([{ method: 'GET', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/overview$/,
    async handle({ match, query }) {
      const q = new URLSearchParams(query), limit = Number(q.get('limit') || 5)
      if ([...q.keys()].some(k => k !== 'limit') || q.getAll('limit').length > 1 || !Number.isInteger(limit) || limit < 1 || limit > 10) throw new Fault(400, 'invalid', 'Provide a limit from 1 to 10')
      const data = await summary(match[1])
      const recent = rows => rows.sort((a,b) => (b.updated || b.created || 0) - (a.updated || a.created || 0)).slice(0,limit)
      return [200, { ...data, recent_conversations: recent(data.recent_conversations), recent_artifacts: recent(data.recent_artifacts), recent_meetings: recent(data.recent_meetings), limit }]
    } }]) } }
}
