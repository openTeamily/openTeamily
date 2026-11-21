// Read-only share links for one memory page (#299), served by the memory feature
// inside this user's DS-Bot; the public page itself is rendered by Bot Social
// from a snapshot keyed by sha256('share:' + token), so the token never leaves
// this volume and a stranger needs no session to read that one page.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { setSharedBotSocial } from '../lib/c/bot-social.js'
import { boot, key, WS } from './helpers.js'

const WS_B = 'b'.repeat(32)
const hash = (token) => createHash('sha256').update('share:' + token).digest('hex')
const pagePath = (pageId, workspace = WS) => `/v1/workspaces/${workspace}/memory/${pageId}`
const sharePath = (pageId, workspace = WS) => pagePath(pageId, workspace) + '/share'
const tokenFrom = (share) => String(share?.path ?? '').split('/').pop()

// The owner's DS-Bot talks to Bot Social for the public snapshot; this fake
// keeps the two endpoints the memory feature uses and mirrors GET /share/<token>.
function fakeSocial() {
  const rows = new Map()
  const calls = []
  function published(token) {
    const row = rows.get(hash(token))
    if (!row || row.revoked) return null
    return row
  }
  const client = {
    rows,
    calls,
    published,
    async request(method, path, body) {
      calls.push({ method, path, body })
      if (method === 'PUT' && path === '/v1/ot/public-shares') {
        rows.set(body.token_hash, { ...body, revoked: false })
        return { published: true }
      }
      const target = /^\/v1\/ot\/public-shares\/([0-9a-f]{64})$/.exec(path)
      if (method === 'DELETE' && target) {
        const row = rows.get(target[1])
        if (!row) return { revoked: true }
        rows.set(target[1], { ...row, revoked: true })
        return { revoked: true }
      }
      throw new Error(`unexpected ${method} ${path}`)
    },
    get(path, options) { return this.request('GET', path, undefined, options) },
    put(path, body = {}) { return this.request('PUT', path, body) },
    del(path) { return this.request('DELETE', path) },
  }
  return client
}

function useFakeSocial(t) {
  const social = fakeSocial()
  setSharedBotSocial(social)
  t.after(() => setSharedBotSocial(undefined))
  return social
}

async function mkPage(bot, title, body, workspace = WS) {
  const made = await bot.call('memory', 'POST', `/v1/workspaces/${workspace}/memory`, { title, body, topics: [] }, key())
  assert.equal(made.status, 201, JSON.stringify(made.body))
  return made.body.page
}

test('sharing one memory page returns one read-only link and publishes only a token hash', async (t) => {
  const social = useFakeSocial(t)
  const bot = await boot()
  const page = await mkPage(bot, '季度计划', '第三季度把迁移收口。')
  const made = await bot.call('memory', 'POST', sharePath(page.id), {})
  assert.equal(made.status, 201, JSON.stringify(made.body))
  const share = made.body.share
  const token = tokenFrom(share)
  assert.match(token, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(share.path, '/share/' + token)
  assert.equal(share.active, true)
  assert.equal(share.revoked, false)
  assert.equal(share.token_hash, undefined)
  const publishes = social.calls.filter((call) => call.method === 'PUT')
  assert.equal(publishes.length, 1)
  assert.equal(publishes[0].body.token_hash, hash(token))
  assert.doesNotMatch(JSON.stringify(publishes[0].body), new RegExp(token))
  assert.equal(publishes[0].body.kind, 'memory')
  assert.equal(publishes[0].body.title, '季度计划')
  assert.match(publishes[0].body.body, /迁移收口/)
})

test('a signed-out reader sees exactly that one page, and only through GET', async (t) => {
  const social = useFakeSocial(t)
  const bot = await boot()
  const page = await mkPage(bot, '客服口径', '退款先确认订单号。', WS)
  await mkPage(bot, '内部预算', '这一页不该出现在分享页里。', WS)
  const share = (await bot.call('memory', 'POST', sharePath(page.id), {})).body.share
  const token = tokenFrom(share)
  const row = social.published(token)
  assert.equal(row.title, '客服口径')
  assert.match(row.body, /退款先确认订单号/)
  assert.doesNotMatch(row.body, /内部预算/)
  assert.equal(row.ref, page.id)
  // The public surface answers GET only; there is no write verb on the token.
  await assert.rejects(() => social.request('POST', '/share/' + token, {}), /unexpected POST/)
  assert.equal(social.published(token)?.revoked, false)
})

test('the state read survives a reload without ever repeating the link', async (t) => {
  useFakeSocial(t)
  const bot = await boot()
  const page = await mkPage(bot, '周会纪要', '记录要点。')
  const share = (await bot.call('memory', 'POST', sharePath(page.id), {})).body.share
  const seen = await bot.call('memory', 'GET', sharePath(page.id))
  assert.equal(seen.status, 200, JSON.stringify(seen.body))
  assert.equal(seen.body.share.active, true)
  assert.equal(seen.body.share.revoked, false)
  assert.equal(seen.body.share.path, undefined)
  assert.equal(seen.body.share.token, undefined)
  assert.equal(seen.body.share.token_hash, undefined)
  assert.equal(seen.body.share.prefix, share.prefix)
  const other = await mkPage(bot, '未分享页', '没有任何链接。')
  const none = await bot.call('memory', 'GET', sharePath(other.id))
  assert.equal(none.status, 200)
  assert.equal(none.body.share, null)
})

test('revoking kills the link immediately and repeating the revoke is idempotent', async (t) => {
  const social = useFakeSocial(t)
  const bot = await boot()
  const page = await mkPage(bot, '撤销演示', '撤销后 404。')
  const share = (await bot.call('memory', 'POST', sharePath(page.id), {})).body.share
  const token = tokenFrom(share)
  assert.ok(social.published(token))
  const revoked = await bot.call('memory', 'POST', sharePath(page.id) + '/revoke', {})
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body))
  assert.equal(revoked.body.share.revoked, true)
  assert.equal(revoked.body.share.active, false)
  assert.equal(social.published(token), null)
  assert.equal(social.calls.filter((call) => call.method === 'DELETE').length, 1)
  const again = await bot.call('memory', 'POST', sharePath(page.id) + '/revoke', {})
  assert.equal(again.status, 200, JSON.stringify(again.body))
  assert.equal(again.body.share.revoked, true)
  const state = await bot.call('memory', 'GET', sharePath(page.id))
  assert.equal(state.body.share.revoked, true)
  const never = await mkPage(bot, '从没分享', '撤销不存在的链接。')
  const missing = await bot.call('memory', 'POST', sharePath(never.id) + '/revoke', {})
  assert.equal(missing.status, 404)
})

test('a token cannot reach a page in another workspace, and each page keeps its own link', async (t) => {
  const social = useFakeSocial(t)
  const bot = await boot()
  const mine = await mkPage(bot, '甲工作区', '甲的正文。', WS)
  const other = await mkPage(bot, '乙工作区', '乙的正文。', WS_B)
  // A page id from another workspace is not addressable through this workspace.
  assert.equal((await bot.call('memory', 'POST', sharePath(other.id, WS), {})).status, 404)
  assert.equal((await bot.call('memory', 'GET', sharePath(other.id, WS))).status, 404)
  const mineShare = (await bot.call('memory', 'POST', sharePath(mine.id, WS), {})).body.share
  const otherShare = (await bot.call('memory', 'POST', sharePath(other.id, WS_B), {})).body.share
  const mineRow = social.published(tokenFrom(mineShare))
  const otherRow = social.published(tokenFrom(otherShare))
  assert.equal(mineRow.title, '甲工作区')
  assert.equal(otherRow.title, '乙工作区')
  assert.doesNotMatch(mineRow.body, /乙的正文/)
  assert.notEqual(hash(tokenFrom(mineShare)), hash(tokenFrom(otherShare)))
  // The state read is scoped to the workspace it was asked for.
  assert.equal((await bot.call('memory', 'GET', sharePath(mine.id, WS))).body.share.active, true)
  assert.equal((await bot.call('memory', 'GET', sharePath(mine.id, WS_B))).status, 404)
})

test('sharing again replaces the link, and an edited page republishes the snapshot', async (t) => {
  const social = useFakeSocial(t)
  const bot = await boot()
  const page = await mkPage(bot, '持续更新', '第一版。')
  const first = (await bot.call('memory', 'POST', sharePath(page.id), {})).body.share
  const firstToken = tokenFrom(first)
  const second = (await bot.call('memory', 'POST', sharePath(page.id), {})).body.share
  const secondToken = tokenFrom(second)
  assert.notEqual(secondToken, firstToken)
  assert.equal(social.published(firstToken), null)
  assert.ok(social.published(secondToken))
  const edited = await bot.call('memory', 'POST', pagePath(page.id), { revision: page.revision, changes: { body: '第二版正文。' } })
  assert.equal(edited.status, 200, JSON.stringify(edited.body))
  assert.match(social.published(secondToken).body, /第二版正文/)
  const state = await bot.call('memory', 'GET', sharePath(page.id))
  assert.equal(state.body.share.active, true)
})

test('deleting the page takes its public snapshot down', async (t) => {
  const social = useFakeSocial(t)
  const bot = await boot()
  const page = await mkPage(bot, '待删除', '删除后链接也要 404。')
  const share = (await bot.call('memory', 'POST', sharePath(page.id), {})).body.share
  const token = tokenFrom(share)
  assert.equal((await bot.call('memory', 'POST', pagePath(page.id) + '/remove', {})).status, 200)
  assert.equal(social.published(token), null)
})

test('without a reachable Bot Social no link is created and nothing is left shared', async (t) => {
  const social = useFakeSocial(t)
  social.request = async () => { throw new Error('disconnected') }
  social.put = (path, body = {}) => social.request('PUT', path, body)
  const bot = await boot()
  const page = await mkPage(bot, '离线', '在线了再分享。')
  const made = await bot.call('memory', 'POST', sharePath(page.id), {})
  assert.equal(made.status, 503, JSON.stringify(made.body))
  assert.equal((await bot.call('memory', 'GET', sharePath(page.id))).body.share, null)
})

test('a failed snapshot delete keeps the share active and revoke answers 503 until it really goes', async (t) => {
  const social = useFakeSocial(t)
  const bot = await boot()
  const page = await mkPage(bot, '撤不下来', '失败的撤销不能假装成功。')
  const share = (await bot.call('memory', 'POST', sharePath(page.id), {})).body.share
  const token = tokenFrom(share)
  const request = social.request
  social.request = async (method, path, body, options) => {
    if (method === 'DELETE') throw new Error('disconnected')
    return request.call(social, method, path, body, options)
  }
  const failed = await bot.call('memory', 'POST', sharePath(page.id) + '/revoke', {})
  assert.equal(failed.status, 503, JSON.stringify(failed.body))
  assert.match(String(failed.body?.error?.message), /snapshot|not taken down|retry|Bot Social/i)
  // The link is still live, so the local record must not claim it is revoked.
  const state = await bot.call('memory', 'GET', sharePath(page.id))
  assert.equal(state.body.share.active, true)
  assert.equal(state.body.share.revoked, false)
  assert.ok(social.published(token))
  // Once Bot Social answers again the same revoke finishes the job.
  social.request = request
  const retried = await bot.call('memory', 'POST', sharePath(page.id) + '/revoke', {})
  assert.equal(retried.status, 200, JSON.stringify(retried.body))
  assert.equal(retried.body.share.revoked, true)
  assert.equal(social.published(token), null)
})

test('a failed retire of the old link after resharing is reported, not silently claimed', async (t) => {
  const social = useFakeSocial(t)
  const bot = await boot()
  const page = await mkPage(bot, '重新分享', '旧链接撤不掉要说出来。')
  const first = (await bot.call('memory', 'POST', sharePath(page.id), {})).body.share
  const firstToken = tokenFrom(first)
  const request = social.request
  social.request = async (method, path, body, options) => {
    if (method === 'DELETE') throw new Error('disconnected')
    return request.call(social, method, path, body, options)
  }
  const second = await bot.call('memory', 'POST', sharePath(page.id), {})
  assert.equal(second.status, 201, JSON.stringify(second.body))
  assert.deepEqual(second.body.warnings, ['old_share_still_live'])
  const secondToken = tokenFrom(second.body.share)
  // The new link works; the old one is still live and its row still says active.
  assert.ok(social.published(secondToken))
  assert.ok(social.published(firstToken))
  social.request = request
  const state = await bot.call('memory', 'GET', sharePath(page.id))
  assert.equal(state.body.share.active, true)
  const revoked = await bot.call('memory', 'POST', sharePath(page.id) + '/revoke', {})
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body))
  const live = social.rows
  assert.equal([...live.values()].filter((row) => !row.revoked).length, 0)
})
