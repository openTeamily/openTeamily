// Stream C: AI team templates (#290). Applying a template creates (or reuses same-name)
// workspace agents in this user's DS-Bot and a Bot Social group with those agents attached.
// Explicit requests and ordinary messages use the native group reply policy.
import { compatHandler } from '../../lib/b4/compat.js'
import { Fault } from '../../lib/b4/http.js'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { sharedBotSocial } from '../../lib/c/bot-social.js'
import { wrap } from '../../lib/c/legacy-v1.js'

export const TEMPLATES = Object.freeze([
  { slug: 'product-squad', name: '产品研发小队', summary: '从需求到验收的三人小队。', agents: [
    { name: '产品经理助理', category: 'product', summary: '整理需求、拆分用户故事、写验收标准。', instructions: '你负责把成员的想法整理成清晰的需求：目标、用户故事、验收标准和优先级。信息不足时先提问。' },
    { name: '研发工程师助理', category: 'engineering', summary: '给出实现方案、接口设计和风险。', instructions: '你负责根据需求给出可执行的技术方案：模块划分、接口、数据结构、风险和工作量估计。不要编造已有代码。' },
    { name: '测试工程师助理', category: 'engineering', summary: '设计测试用例与回归清单。', instructions: '你负责根据需求和方案设计测试用例，覆盖正常、边界和异常路径，并列出回归检查项。' },
  ] },
  { slug: 'content-studio', name: '内容工作室', summary: '选题、写作到审校的内容流水线。', agents: [
    { name: '选题策划助理', category: 'content-creation', summary: '提出选题、角度和大纲。', instructions: '你负责根据目标读者提出选题和角度，并给出结构化大纲。说明每个选题的理由。' },
    { name: '文案写作助理', category: 'content-creation', summary: '按大纲写出初稿。', instructions: '你负责按给定大纲写初稿，语言自然、具体，不夸大，不编造数据或引用。' },
    { name: '审校编辑助理', category: 'content-creation', summary: '检查事实、逻辑与表达。', instructions: '你负责审校稿件：标出事实需核实处、逻辑跳跃和冗余表达，并给出修改建议。' },
  ] },
  { slug: 'research-desk', name: '研究小组', summary: '检索、分析与报告撰写。', agents: [
    { name: '资料整理助理', category: 'data-analysis', summary: '整理成员提供的资料和问题清单。', instructions: '你负责整理成员提供的资料，列出要点、来源和待解决问题。不要声称访问了未提供的资料。' },
    { name: '分析助理', category: 'data-analysis', summary: '比较方案并给出结论与依据。', instructions: '你负责基于已整理的资料做比较分析，明确结论、依据和不确定性。' },
    { name: '报告撰写助理', category: 'content-creation', summary: '把结论写成简洁报告。', instructions: '你负责把分析结论写成简洁报告：摘要、发现、建议和待确认事项。' },
  ] },
])

const publicView = (t) => ({ slug: t.slug, name: t.name, summary: t.summary, agents: t.agents.map((a) => ({ name: a.name, summary: a.summary, category: a.category })) })
const hash = value => createHash('sha256').update(value).digest('hex')
const roleConflict = name => new Fault(409, 'team_template_role_conflict',
  `“${name}”已归档或名称被占用。请到智能体页面恢复或重命名后再试。`)

async function socialRequest(request) {
  try { return await request() } catch (error) {
    const code = error?.code
    if (['social/not-connected', 'social/not-configured', 'social/unreachable'].includes(code) ||
        (code?.startsWith('social/') && error.status >= 500)) {
      throw new Fault(503, 'service_unavailable', '群聊服务暂时不可用，请重试。')
    }
    if (code?.startsWith('social/') && error.status >= 400 && error.status < 500) {
      return wrap(() => { throw error })
    }
    throw error
  }
}

export default function teamTemplates(host) {
  const bs = () => sharedBotSocial(host)
  const endpoints = {
      list: async () => ({ templates: TEMPLATES.map(publicView), create_entry: '/agents?tab=teams&new=1' }),
      async apply(p, call) {
        if (!call?.internal) throw new Fault(404, 'not_found', 'Internal endpoint')
        const tmpl = TEMPLATES.find((t) => t.slug === p?.slug)
        if (!tmpl) throw new Fault(404, 'not_found', '找不到这个群聊模板。')
        const workspace_id = p.workspace_id
        const { items: existing = [] } = await host.call('agents/templateRoles', {
          workspace_id, names: tmpl.agents.map(a => a.name),
        }).catch(error => {
          if (error?.code === 'agents/conflict') {
            throw new Fault(409, 'team_template_role_conflict', '模板角色名称有冲突，请到智能体页面检查后再试。')
          }
          throw error
        })
        for (const agent of existing) {
          if (agent.archived || agent.native_deleted) throw roleConflict(agent.name)
        }
        const byName = new Map(existing.map(agent => [agent.name, agent]))
        const roles = tmpl.agents.filter(role => !byName.has(role.name)).map(role => ({
          ...role, idempotency_key: hash(JSON.stringify(['team-template-role', workspace_id, tmpl.slug, role.name, p.idempotency_key])),
        }))
        if (roles.length) {
          const {items} = await host.call('agents/createTemplateRoles', {workspace_id, roles}).catch(error => {
            if (error?.code === 'agents/template-role-conflict') throw roleConflict(error.roleName)
            if (error?.code === 'agents/quota') {
              throw new Fault(429, 'team_template_agent_quota', '这个工作区已达到智能体数量上限。')
            }
            throw error
          })
          for (const agent of items) byName.set(agent.name, agent)
        }
        const agents = tmpl.agents.map(role => byName.get(role.name))
        const group = await socialRequest(() => bs().post('/v1/ot/conversations', {
          kind: 'group', title: p?.title || tmpl.name, team_id: p?.team_id || undefined,
          account_group: p?.account_group === true, members: p?.members ?? [],
          agents: agents.map(agent => ({agent_ref:agent.id, name:agent.name})),
          idempotency_key: p?.idempotency_key,
        }))
        return { template: publicView(tmpl), agents: agents.map((a) => ({ id: a.id, name: a.name, category: a.category })), conversation: group }
      },
  }
  const file = join(host.featureDir(), 'requests.json')
  const load = () => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch (e) { if (e.code === 'ENOENT') return {}; throw e } }
  let queue = Promise.resolve()
  endpoints.v1 = compatHandler([
    { method: 'GET', path: /^\/v1\/team-templates$/, handle: async () => [200, { items: TEMPLATES.map(publicView) }] },
    { method: 'POST', path: /^\/v1\/workspaces\/([0-9a-f]{32})\/team-templates\/([a-z0-9-]{3,40})$/,
      async handle({ match, body = {}, idempotency_key }) {
        if (!/^[A-Za-z0-9_-]{16,64}$/.test(idempotency_key || '')) throw new Fault(400, 'invalid', 'Supply an Idempotency-Key')
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Fault(400, 'invalid', 'Invalid request')
        if (body.title !== undefined && (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 80)) throw new Fault(400, 'invalid', 'Invalid title')
        if (body.member_ids !== undefined && (!Array.isArray(body.member_ids) || body.member_ids.length > 49 ||
            body.member_ids.some(id => typeof id !== 'string' || !id))) throw new Fault(400, 'invalid', 'Invalid members')
        const task = async () => {
          const binding = await host.call('agents/personal-binding', {})
          const personal = binding?.workspace_id === match[1]
          const team = personal ? null : await socialRequest(() => bs().get('/v1/ot/teams/by-workspace/' + match[1]))
          if (!personal && (!team?.id || !['owner', 'admin'].includes(team.role))) {
            throw new Fault(403, 'forbidden', '只有工作区所有者和管理员可以使用群聊模板。')
          }
          const key = hash(match[1] + ':' + idempotency_key)
          const fingerprint = JSON.stringify([match[2], body.title || '', [...(body.member_ids || [])].sort()])
          const requests = load()
          if (requests[key]) {
            if (requests[key].fingerprint !== fingerprint) throw new Fault(409, 'conflict', 'Idempotency key already used')
            return [200, requests[key].result]
          }
          let handles = body.member_ids || []
          if (handles.length && team) {
            const {members = []} = await socialRequest(() => bs().get('/v1/ot/teams/' + encodeURIComponent(team.id) + '/members'))
            handles = handles.map(id => {
              const member = members.find(m => !m.suspended && [m.platform_user_id, m.owner_id, m.handle].includes(id))
              if (!member) throw new Fault(400, 'invalid', 'Every member must belong to this workspace')
              return member.handle
            })
          }
          const result = await endpoints.apply({workspace_id:match[1], team_id:team?.id, account_group:personal, slug:match[2],
            title:body.title, members:handles, idempotency_key:key}, {internal:true})
          const out = { conversation: { ...result.conversation, workspace_id: match[1] }, created_agents: result.agents.map(a => a.id) }
          requests[key] = { fingerprint, result: out }
          writeFileSync(file + '.tmp', JSON.stringify(requests), { mode: 0o600 }); renameSync(file + '.tmp', file)
          return [201, out]
        }
        const next = queue.then(task, task); queue = next.catch(() => {}); return next
      } },
  ])
  return { endpoints }
}
