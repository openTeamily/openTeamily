// Skills live in the user's own DS-Bot as native capabilities attached to the
// Main Bot (moved from skill_installs.py / skill_execution.py). Instruction-only.
import { createHash } from 'node:crypto'
import { fail } from '../../src/store.js'
import { skillLibrary } from './library.js'
import { skillRunsV1 } from './runs.js'

const NAME = /^[a-z0-9][a-z0-9-]{1,47}$/
const PREFIX = 'ot-user-skill-'
const BOUND = 'ot-bound-'
const SKILL_ID = /^[a-z0-9][a-z0-9_.-]{0,79}$/i
const DIGEST = /^[0-9a-f]{64}$/
// DS-Bot's native validator caps the complete capability name at 32 chars and
// permits only single hyphens. Keep existing valid names; hash the full source
// identity otherwise (never truncate into collisions or weaken native validation).
const nativeName = (prefix, id) => {
  const name = prefix + String(id).toLowerCase()
  return name.length <= 32 && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)
    ? name : prefix + createHash('sha256').update(String(id)).digest('hex').slice(0, 32 - prefix.length)
}
export const boundName = (id) => nativeName(BOUND, id)
export const userSkillName = (slug) => nativeName(PREFIX, slug)

export default function skills(host) {
  const library = skillLibrary(host, { boundName })
  const runs = skillRunsV1(host, { boundName, userSkillName })
  const ready = async () => {
    const services = await host.runtime()
    if (typeof services.mainBot !== 'function') fail('skills/runtime-unavailable', 'DS-Bot skills are not available in this runtime')
    const botId = await services.mainBot()
    return { rt: services.rt, botId }
  }
  return {
    pages: ['skills'],
    endpoints: {
      v1: async p => { const result=await library.v1(p); return result.status === 404 && result.body?.error?.code === 'not_moved' ? runs(p) : result },
      materialForScope: library.materialForScope,
      reconcile: async () => { await library.syncAll(); return { reconciled: true } },
      async list() {
        const { rt, botId } = await ready()
        const attached = [...(rt.botOf(botId)?.capabilities ?? [])].filter((name) => typeof name === 'string')
        return { items: attached.filter((name) => name.startsWith('ot-')).sort().map((name) => ({ name, source: name.startsWith(PREFIX) ? 'user' : name.startsWith(BOUND) ? 'bound' : 'openteamily' })) }
      },
      async save(payload) {
        const slug = String(payload?.name ?? '')
        if (!NAME.test(slug)) fail('skills/invalid', 'name: 2–48 lowercase letters, digits or dashes')
        const content = typeof payload?.content === 'string' ? payload.content : ''
        if (!content.trim() || content.length > 20000) fail('skills/invalid', 'content must be 1–20000 characters')
        const description = String(payload?.description ?? slug).slice(0, 200)
        const { rt, botId } = await ready()
        const name = userSkillName(slug)
        await rt.capabilitySave({ name, kind: 'skill', description, content }, { ui: true })
        if (!(rt.botOf(botId)?.capabilities ?? []).includes(name)) await rt.changeCapabilityAttachment('attach', { name }, botId)
        return { name, attached: true }
      },
      // The user's effective skill set for private chat (account bindings + library),
      // read by the browser from the platform catalogue and materialized here as native
      // DS-Bot skills. Content must match its catalogue digest; others are detached.
      async sync(payload) {
        const items = Array.isArray(payload?.items) ? payload.items : null
        if (!items || items.length > 100) fail('skills/invalid', 'items: at most 100 skills')
        const wanted = new Map()
        for (const item of items) {
          if (!SKILL_ID.test(String(item?.id ?? '')) || !DIGEST.test(String(item?.digest ?? ''))) fail('skills/invalid', 'skill id and digest required')
          const content = typeof item.content === 'string' ? item.content : ''
          if (!content || content.length > 65536) fail('skills/invalid', 'skill content required')
          if (createHash('sha256').update(content, 'utf8').digest('hex') !== item.digest) fail('skills/digest-mismatch', `skill ${item.id} does not match its digest`)
          wanted.set(boundName(item.id), item)
        }
        const { rt, botId } = await ready()
        const attachedNow = () => new Set(rt.botOf(botId)?.capabilities ?? [])
        for (const [name, item] of wanted) {
          const description = `${String(item.name ?? item.id).slice(0, 80)} (OpenTeamily skill ${item.id} v${String(item.version ?? '').slice(0, 20)}, instruction-only)`.slice(0, 200)
          await rt.capabilitySave({ name, kind: 'skill', description, content: item.content }, { ui: true })
          if (!attachedNow().has(name)) await rt.changeCapabilityAttachment('attach', { name }, botId)
        }
        for (const name of attachedNow()) {
          if (typeof name === 'string' && name.startsWith(BOUND) && !wanted.has(name)) await rt.changeCapabilityAttachment('detach', { name }, botId)
        }
        return { attached: [...wanted.keys()].sort() }
      },
      async remove(payload) {
        const slug = String(payload?.name ?? '')
        if (!NAME.test(slug)) fail('skills/invalid', 'invalid name')
        const { rt, botId } = await ready()
        const name = userSkillName(slug)
        if ((rt.botOf(botId)?.capabilities ?? []).includes(name)) await rt.changeCapabilityAttachment('detach', { name }, botId)
        return { removed: true }
      },
    },
  }
}
