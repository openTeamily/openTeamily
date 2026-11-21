// Stream C: Bot Social connection status and the user's shared profile/notifications.
import { compatHandler } from '../../lib/b4/compat.js'
import { sharedBotSocial, qs } from '../../lib/c/bot-social.js'
import { wrap } from '../../lib/c/legacy-v1.js'

export default function social(host) {
  const bs = () => sharedBotSocial(host)
  return {
    pages: ['contacts'],
    endpoints: {
      v1: compatHandler([
        { method: 'GET', path: /^\/v1\/contacts$/,
          handle: () => wrap(async () => {
            const [data, binding] = await Promise.all([bs().get('/v1/ot/contacts'), host.call('agents/personal-binding', {})])
            return [200, {...data, workspace_id: binding?.workspace_id ?? null}]
          }) },
        { method: 'GET', path: /^\/v1\/contacts\/lookup$/,
          handle: ({query}) => wrap(async () => {
            const values = new URLSearchParams(query).getAll('handle')
            return [200, await bs().get('/v1/ot/contacts/lookup' + qs({handle: values.length === 1 ? values[0] : ''}))]
          }) },
        { method: 'POST', path: /^\/v1\/contacts$/,
          handle: ({body}) => wrap(async () => [200, await bs().post('/v1/ot/contacts', {handle: body?.handle})]) },
        { method: 'POST', path: /^\/v1\/contacts\/(otcpt_[a-zA-Z0-9_-]{1,80})$/,
          handle: ({match, body}) => wrap(async () => [200, await bs().post('/v1/ot/contacts/' + match[1], {action: body?.action})]) },
        { method: 'GET', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/notifications$/,
          async handle({ match, query }) {
            const binding = await host.call?.('agents/personal-binding', {})
            const personal = binding?.workspace_id === match[1]
            if (!personal) await bs().get('/v1/ot/teams/by-workspace/' + match[1])
            const scope = personal ? {personal:'1'} : {workspace_id:match[1]}
            const data = await bs().get('/v1/ot/notifications' + qs({ limit: 200, ...scope, unread: new URLSearchParams(query).get('filter') === 'unread' ? '1' : undefined }))
            return [200, { items: data.notifications.map(n => ({ ...n.data, id: n.id, seq: n.seq, kind: n.kind, created: Math.floor(n.created_at / 1000), read: n.read })), unread_count: data.unread, limit: 200 }]
          } },
        { method: 'POST', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/notifications\/read$/,
          async handle({ match, body }) {
            const binding = await host.call?.('agents/personal-binding', {})
            const personal = binding?.workspace_id === match[1]
            if (!personal) await bs().get('/v1/ot/teams/by-workspace/' + match[1])
            const scope = personal ? {personal:true} : {workspace_id:match[1]}
            const result = await bs().post('/v1/ot/notifications/read', { notification_id: body?.notification_id, all: body?.all, ...scope })
            return [200, { unread_count: result.unread }]
          } },
      ]),
      status: async () => bs().status(),
      identity: async () => bs().identity(),
      profile: async () => bs().get('/v1/ot/me'),
      updateProfile: async (p) => bs().put('/v1/ot/profile', { display_name: p?.display_name, bio: p?.bio }),
      notifications: async (p) => bs().get('/v1/ot/notifications' + qs({ after: p?.after, limit: p?.limit })),
      readNotifications: async (p) => bs().post('/v1/ot/notifications/read', { up_to: p?.up_to }),
    },
  }
}
