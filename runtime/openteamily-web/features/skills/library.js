// Immutable package versions and binding metadata live with this runtime.
// Effective instructions are real native DS-Bot capabilities, not a server list.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { compatHandler } from '../../lib/b4/compat.js'
import { Fault } from '../../lib/b4/http.js'
import { openJsonStore } from '../../lib/b4/json-store.js'
import { importJsonBundles } from '../../lib/b4/importer.js'
import { sharedBotSocial } from '../../lib/c/bot-social.js'
const builtin = JSON.parse(readFileSync(new URL('./catalog.json', import.meta.url), 'utf8'))
const sha = s => createHash('sha256').update(s).digest('hex')
const now = () => Math.floor(Date.now()/1000)
const reject = (status,message) => { throw new Fault(status,'package_rejected',message) }
function validate(v) {
  const required = ['id','name','version','content','format','permissions']
  if (!v || typeof v !== 'object' || required.some(k => v[k] === undefined) || Object.keys(v).some(k => ![...required,'digest','source'].includes(k))) reject(400,'Only declarative instruction manifests are accepted')
  if (!/^import-[a-z0-9][a-z0-9-]{1,39}$/.test(v.id) || typeof v.name !== 'string' || !v.name.trim() || v.name.length > 120 || !/^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$/.test(v.version) || typeof v.content !== 'string' || !v.content.length || v.content.length > 6000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v.name+v.content) || JSON.stringify(v.permissions) !== '["model_context"]' || v.format !== 'openteamily.prompt-skill.v2' || (v.source && v.source !== 'user-imported')) reject(400,'Use a bounded import- manifest, x.y.z version and only model_context permission')
  const digest = sha(v.content)
  if (v.digest && v.digest !== digest) reject(409,'Content digest mismatch')
  return { id:v.id,name:v.name,version:v.version,content:v.content,format:v.format,permissions:v.permissions,digest,source:'user-imported' }
}
export function skillLibrary(host, { boundName }) {
  const store = openJsonStore(host.featureDir(), 'library', () => ({ packages:{}, bindings:[], installed:[], imports:[] }))
  importJsonBundles({ dataDir: host.dataDir, feature: { name:'skills', importTables:{ imported_skill_heads:[], imported_skill_versions:[], skill_bindings:[], skill_installs:[] } }, store,
    apply(d,t) {
      for (const h of t.imported_skill_heads || []) {
        if (d.packages[h.skill_id]) continue
        const versions = (t.imported_skill_versions || []).filter(v => v.skill_id === h.skill_id).map(v => ({ manifest:validate(JSON.parse(v.manifest)),created:v.created }))
        d.packages[h.skill_id] = { version:h.version, revision:h.revision,active:!!h.active,versions }
      }
      if (!d.bindings.length) d.bindings = (t.skill_bindings || []).map(({scope,skill_id,version,digest,installed}) => ({scope,skill_id,version,digest,installed}))
      if (!d.installed.length) d.installed = (t.skill_installs || []).map(v => v.skill_id)
    }, log: () => host.log('skill library import rejected; bundle retained') })
  const catalog = () => [...builtin, ...Object.values(store.read().packages).filter(p => p.active).map(p => p.versions.find(v => v.manifest.version === p.version).manifest)]
  const metadata = id => { const p=store.read().packages[id]; if (!p) reject(404,'Package not found'); return { id,version:p.version,revision:p.revision,active:p.active,versions:p.versions.map(v => ({version:v.manifest.version,digest:v.manifest.digest,created:v.created})).reverse() } }
  async function target(scope) {
    const s = await host.runtime()
    if (scope === 'account') return { rt:s.rt, botId:await s.mainBot() }
    const m = /^(?:(automation):)?([0-9a-f]{32}):([0-9a-f]{32})$/.exec(scope || '')
    if (!m) throw new Fault(400,'invalid','Invalid skill scope')
    const binding = await host.call('agents/personal-binding', {})
    if (binding?.workspace_id !== m[2]) {
      const team = await sharedBotSocial(host).get('/v1/ot/teams/by-workspace/'+m[2])
      if (!['owner','admin'].includes(team.role)) throw new Fault(403,'forbidden','Scope requires workspace administration')
    }
    if (m[1]) { await host.call('automations/get',{workspace_id:m[2],id:m[3]}); return { rt:s.rt, automation:true } }
    const { agent } = await host.call('agents/get',{workspace_id:m[2],id:m[3]})
    if (!agent.native_bot_id || agent.native_deleted) throw new Fault(409,'native_deleted','Native Bot unavailable')
    return { rt:s.rt, botId:agent.native_bot_id }
  }
  const material = scope => {
    const d=store.read(), active=catalog(), wanted = new Set(d.bindings.filter(b => (b.scope === 'account' || b.scope === scope) && active.some(i => i.id === b.skill_id && i.version === b.version && i.digest === b.digest)).map(b => b.skill_id))
    for (const id of d.installed) wanted.add(id)
    return active.filter(i => wanted.has(i.id))
  }
  async function sync(scope='account') {
    const {rt,botId,automation}=await target(scope), items=material(scope)
    for (const i of items) await rt.capabilitySave({name:boundName(i.id),kind:'skill',description:i.name,content:i.content},{ui:true})
    if (automation) return items
    const wanted=new Set(items.map(i => boundName(i.id)))
    for (const name of wanted) if (!(rt.botOf(botId)?.capabilities || []).includes(name)) await rt.changeCapabilityAttachment('attach',{name},botId)
    for (const name of [...(rt.botOf(botId)?.capabilities || [])]) if (name.startsWith('ot-bound-') && !wanted.has(name)) await rt.changeCapabilityAttachment('detach',{name},botId)
    return items
  }
  async function syncAll() {
    await sync('account')
    const {rt}=await host.runtime()
    for(const bot of Object.values(rt.state.bots)) {
      if(!bot.openteamily?.agent_id)continue
      const wanted=new Set(material(bot.openteamily.workspace_id+':'+bot.openteamily.agent_id).map(i=>boundName(i.id)))
      for(const i of material(bot.openteamily.workspace_id+':'+bot.openteamily.agent_id)) await rt.capabilitySave({name:boundName(i.id),kind:'skill',description:i.name,content:i.content},{ui:true})
      for(const name of wanted)if(!(bot.capabilities||[]).includes(name))await rt.changeCapabilityAttachment('attach',{name},bot.id)
      for(const name of [...(bot.capabilities||[])])if(name.startsWith('ot-bound-')&&!wanted.has(name))await rt.changeCapabilityAttachment('detach',{name},bot.id)
    }
  }
  let queue=Promise.resolve()
  const serial=fn => {const p=queue.then(fn,fn);queue=p.catch(()=>{});return p}
  const routes=[
    {method:'GET',path:/^\/v1\/skills\/scopes$/,handle:async()=>{
      const listed = await host.call('teams/v1', {method:'GET',path:'/v1/workspaces?limit=100'})
      if (listed.status !== 200) throw new Fault(listed.status, 'workspaces_unavailable', 'Could not list workspaces')
      const items=[{scope:'account',kind:'account',workspace_id:null,label:'我的账户'}]
      for(const {id:workspaceId, role, name} of listed.body.items){
        if(!['owner','admin'].includes(role))continue
        const [agents,automations]=await Promise.all([host.call('agents/list',{workspace_id:workspaceId}),host.call('automations/list',{workspace_id:workspaceId})])
        items.push(...agents.items.map(a=>({scope:workspaceId+':'+a.id,kind:'agent',workspace_id:workspaceId,id:a.id,label:name+' / '+a.name,administration:true})),...automations.items.map(a=>({scope:'automation:'+workspaceId+':'+a.id,kind:'automation',workspace_id:workspaceId,id:a.id,label:name+' / '+a.title,administration:true})))
      }
      return [200,{items}]
    }},
    {method:'GET',path:/^\/v1\/skills\/catalog$/,handle:async()=>[200,{items:catalog()}]},
    {method:'GET',path:/^\/v1\/skills\/bindings$/,handle:async()=>{await syncAll();return [200,{items:store.read().bindings}]}},
    {method:'POST',path:/^\/v1\/skills\/bindings$/,handle:async({body:b})=>serial(async()=>{
      const item=catalog().find(i=>i.id===b?.skill_id)
      if(!item || typeof b.enabled!=='boolean' || JSON.stringify(b.permissions)!=='["model_context"]') throw new Fault(400,'invalid','Select a known package, scope and explicit model_context permission')
      if(item.version!==b.version || item.digest!==b.digest) throw new Fault(409,'conflict','Package version/digest changed')
      await target(b.scope)
      const d=store.read(), others=d.bindings.filter(x=>x.scope!==b.scope || x.skill_id!==item.id)
      if(b.enabled && (others.length>=200 || new Set([...others.map(x=>x.skill_id),item.id]).size>10)) throw new Fault(429,'quota','Binding capacity reached')
      store.update(d=>{d.bindings=b.enabled?[...others,{scope:b.scope,skill_id:item.id,version:item.version,digest:item.digest,installed:now()}]:others})
      await syncAll(); return [200,{enabled:b.enabled,scope:b.scope,skill_id:item.id}]
    })},
    ...['GET','POST','DELETE'].map(method=>({method,path:/^\/v1\/skills\/installed$/,handle:async({body})=>serial(async()=>{
      if(method!=='GET') {
        if(!builtin.some(i=>i.id===body?.skill)) throw new Fault(400,'invalid','Select a bundled catalog skill')
        store.update(d=>{d.installed=method==='POST'?[...new Set([...d.installed,body.skill])]:d.installed.filter(id=>id!==body.skill)})
      }
      await syncAll();return [200,{installed:store.read().installed}]
    })})),
    {method:'GET',path:/^\/v1\/skills\/packages$/,handle:async()=>[200,{items:Object.keys(store.read().packages).map(metadata)}]},
    {method:'POST',path:/^\/v1\/skills\/packages$/,handle:async({body:b})=>serial(async()=>{
      const item=validate(b?.package), p=store.read().packages[item.id]
      if(b.consent!==true || !Number.isInteger(b.revision) || b.revision!==(p?.revision||0)) reject(409,'Provide current revision and explicit consent')
      const old=p?.versions.find(v=>v.manifest.version===item.version)
      if(old && JSON.stringify(old.manifest)!==JSON.stringify(item)) reject(409,'Versions are immutable')
      const newer=!p || item.version.split('.').map(n=>+n).reduce((v,n)=>v*10000+n,0)>p.version.split('.').map(n=>+n).reduce((v,n)=>v*10000+n,0)
      if(!newer && !(old&&p.active&&p.version===item.version)) reject(409,'Import a newer version; revoked versions cannot regain availability')
      if(!p && Object.keys(store.read().packages).length>=25 || p?.versions.length>=10 && !old) reject(429,'Package capacity reached')
      if(newer)store.update(d=>{d.packages[item.id]={version:item.version,revision:b.revision+1,active:true,versions:[...(p?.versions||[]),{manifest:item,created:now()}]}})
      await syncAll();return [200,{package:item,...metadata(item.id),installed:false}]
    })},
    {method:'GET',path:/^\/v1\/skills\/packages\/(import-[a-z0-9][a-z0-9-]{1,39})(?:\/versions)?$/,handle:async({match})=>[200,metadata(match[1])]},
    {method:'GET',path:/^\/v1\/skills\/packages\/(import-[a-z0-9][a-z0-9-]{1,39})\/versions\/([0-9.]+)$/,handle:async({match})=>{
      const p=store.read().packages[match[1]], v=p?.versions.find(v=>v.manifest.version===match[2]);if(!v)reject(404,'Version not found')
      return [200,v.manifest]
    }},
    {method:'POST',path:/^\/v1\/skills\/packages\/(import-[a-z0-9][a-z0-9-]{1,39})\/revoke$/,handle:async({match,body})=>serial(async()=>{
      const p=metadata(match[1]);if(body?.revision!==p.revision)reject(409,'Package changed; reload')
      if(p.active)store.update(d=>{d.packages[p.id].active=false;d.packages[p.id].revision++;d.bindings=d.bindings.filter(b=>b.skill_id!==p.id)})
      await syncAll();return [200,metadata(p.id)]
    })},
  ]
  return { v1:compatHandler(routes), materialForScope: async p=>({items:await sync(p?.scope||'account')}), syncAll }
}
