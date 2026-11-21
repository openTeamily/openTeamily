// Stream C: Bot Social connection status and the user's shared profile/notifications.
import { compatHandler } from '../../lib/b4/compat.js'
import { sharedBotSocial, qs } from '../../lib/c/bot-social.js'
import { wrap } from '../../lib/c/legacy-v1.js'

// #284: a notification switch is only real if this read path honours it. The
// preferences are stored by the settings feature (settings.js notificationPrefs),
// so the inbox asks that feature instead of keeping a second copy.
//
// The category map follows the kinds Bot Social actually produces
// (`git grep "ot.notify(" services/bot-social/src`: messenger.mention,
// messenger.added, messenger.call, discover.published,
// discover.conversation_started, follow.new, team.run_shared, team.join_request,
// team.member_joined, team.membership_changed, team.removed, team.join_decided).
// Only `messenger.mention` is a mention; none of them is a task-completion or
// artifact notice, so both of those filters are forward-looking and change no
// visible row today. `discover.published` and `follow.new` are follow notices
// ("someone you follow published"), not work notices — hiding them under 作品通知
// would drop rows the user never asked to mute. A kind absent from this map is
// never hidden, so a new Bot Social kind shows up unless someone maps it here.
const NOTIFY_CATEGORY = {
  'messenger.mention': 'mentions',
  // No producer writes this kind yet; the artifacts feature already names it
  // (features/artifacts/library.js), so the switch is wired for the day it ships.
  artifact: 'artifacts',
}

// The listing body for the inbox: Bot Social rows projected to the shape the
// Bot Social page reads, minus the categories the user switched off. A hidden row
// must not keep the badge up, so once anything is filtered the count is the
// unread rows this page actually shows; Bot Social caps one page at 200 rows, so
// that is exact for the common case and never higher than the listing.
export function notificationPage(data, prefs = {}) {
  const items = (data?.notifications ?? []).map(n => ({
    ...n.data, id: n.id, seq: n.seq, kind: n.kind,
    created: Math.floor(n.created_at / 1000), read: n.read,
  }))
  const shown = items.filter(item => prefs[NOTIFY_CATEGORY[item.kind]] !== false)
  const unreadCount = shown.length === items.length ? (data?.unread ?? 0) : shown.filter(item => !item.read).length
  return { items: shown, unread_count: unreadCount, limit: 200 }
}

export default function social(host) {
  const bs = () => sharedBotSocial(host)
  // A runtime without the settings feature has no switches to read, so it shows
  // every row rather than silently hiding one.
  async function notificationPrefs() {
    try { return (await host.call('settings/notificationPrefs', {}))?.prefs ?? {} }
    catch { return {} }
  }
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
            return [200, notificationPage(data, await notificationPrefs())]
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
