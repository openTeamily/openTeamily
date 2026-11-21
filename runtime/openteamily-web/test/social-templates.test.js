// Stream C: team templates (#290), bulk invites / role copy (#281), unread divider (#358).
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBotSocial, setSharedBotSocial } from '../lib/c/bot-social.js'
import teamTemplates, { TEMPLATES } from '../features/team-templates/index.js'
import invites from '../features/invites/index.js'
import members from '../features/members/index.js'
import messenger from '../features/messenger/index.js'

const SERVER = 'https://social.example.test'
function setup(calls, { existing = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ot-c6-'))
  mkdirSync(join(dir, 'bot'))
  writeFileSync(join(dir, 'bot', 'flybot-social.json'), JSON.stringify({ token: 'ot-fake-token', server: SERVER }), { mode: 0o600 })
  const fetch = async (url, init) => {
    const path = url.slice(SERVER.length)
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ method: init.method, path, body })
    if (init.method === 'GET' && path === '/v1/ot/conversations') {
      return new Response(JSON.stringify({ unread: 1, conversations: [{ id: 'otc_1', unread: 1, read_seq: 3, last_seq: 5 }] }))
    }
    if (path.includes('/messages')) return new Response(JSON.stringify({ read_seq: 3, last_seq: 5, messages: [] }))
    if (init.method === 'POST' && path === '/v1/ot/conversations') return new Response(JSON.stringify({ id: 'otc_9', title: '内容工作室' }))
    if (path.includes('/invites') && init.method === 'POST') return new Response(JSON.stringify({ code: 'x'.repeat(32), invite: { role: body.role } }))
    return new Response('{}')
  }
  setSharedBotSocial(createBotSocial({ server: SERVER, credentialsPath: join(dir, 'bot', 'flybot-social.json'), fetch }))
  let created = 0
  const host = {
    dataDir: dir,
    featureDir: () => dir,
    async call(endpoint, payload) {
      if (endpoint === 'agents/list') return { items: existing }
      if (endpoint === 'agents/create') { created++; return { agent: { id: `id${created}`, name: payload.name, category: payload.category } } }
      throw Object.assign(new Error(endpoint), { code: 'openteamily/not-found' })
    },
  }
  return host
}

test('list exposes the three public templates and the Discover create-team entry (#313)', async () => {
  const { templates, create_entry } = await teamTemplates(setup([])).endpoints.list()
  assert.equal(templates.length, 3)
  assert.deepEqual(templates.map((t) => t.slug), TEMPLATES.map((t) => t.slug))
  assert.ok(!JSON.stringify(templates).includes('你负责'), 'instructions are not listed')
  assert.equal(create_entry, '/agents?tab=teams&new=1')
})

test('apply creates missing agents, reuses same-name ones, and opens a group without auto-reply', async () => {
  const calls = []
  const existing = [{ id: 'reuse', name: '选题策划助理', category: 'content-creation', archived: 0 }]
  const host = setup(calls, { existing })
  const out = await teamTemplates(host).endpoints.apply({ slug: 'content-studio', workspace_id: 'c'.repeat(32) }, { host })
  assert.equal(out.agents.length, 3)
  assert.equal(out.agents[0].id, 'reuse')
  assert.equal(out.conversation.id, 'otc_9')
  const creates = calls.filter(c => c.method === 'POST' && c.path === '/v1/ot/conversations')
  assert.equal(creates.length, 1)
  assert.deepEqual(creates[0].body.agents.map(a => a.agent_ref), ['reuse','id1','id2'])
  assert.equal(calls.some(c => c.method === 'PUT'), false)
})

test('bulk invites, role copy, muted unread already excluded, and first_unread_seq (#281 #345 #358)', async () => {
  const calls = []
  const host = setup(calls)
  const many = await invites(host).endpoints.createMany({ team_id: 'ott_1', rows: [{ role: 'member' }, { role: 'admin' }] })
  assert.equal(many.invites.length, 2)
  assert.equal(calls.filter((c) => c.path === '/v1/ot/teams/ott_1/invites').length, 2)
  const roles = await members(host).endpoints.roles()
  assert.deepEqual(roles.roles.map((r) => r.role), ['owner', 'admin', 'member'])
  const list = await messenger(host).endpoints.list()
  assert.equal(list.conversations[0].first_unread_seq, 4)
  const page = await messenger(host).endpoints.messages({ conversation_id: 'otc_1' })
  assert.equal(page.first_unread_seq, 4)
})
