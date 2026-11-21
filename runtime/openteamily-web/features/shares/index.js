// Stream C: share a team run with a team. The run executes in this user's DS-Bot (features/team-runs);
// only a teammate-visible snapshot (title, goal, status, step names/outputs) is published to Bot Social.
import { sharedBotSocial, seg } from '../../lib/c/bot-social.js'

function snapshotOf(run) {
  return {
    progress: run.progress ?? null,
    steps: (run.steps ?? []).map((s) => ({
      position: s.position, agent_name: s.agent_name, status: s.status, output: String(s.output ?? '').slice(0, 2000),
    })),
  }
}

export default function shares(host) {
  const bs = () => sharedBotSocial(host)
  const path = (p) => `/v1/ot/teams/${seg(p?.team_id, 'team_id')}/shared-runs`
  return {
    endpoints: {
      async publish(p, call) {
        const caller = call?.host ?? host
        const { run } = await caller.call('team-runs/get', { id: p?.run_id, workspace_id: p?.workspace_id })
        return bs().put(path(p), {
          run_ref: run.id, title: run.title, goal: run.goal, status: run.status, snapshot: snapshotOf(run),
        })
      },
      list: async (p) => bs().get(path(p)),
      get: async (p) => bs().get(`${path(p)}/${seg(p?.share_id, 'share_id')}`),
      unshare: async (p) => bs().del(`${path(p)}/${seg(p?.share_id, 'share_id')}`),
    },
  }
}
