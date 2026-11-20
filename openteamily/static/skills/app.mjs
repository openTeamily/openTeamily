import { mountImportedSkills } from './imports.mjs';
import { mountSkillExecution } from './execution.mjs';
import { csrfCookie } from '../agents/app.mjs';
// Original content packages are loaded from the authenticated catalogue; no fake page-local installation.
// The binding lifecycle below decides what a runtime may load. The reader's own
// library membership ("我的技能库") is a separate per-account record: it never grants
// model context and never reaches a runtime on its own.

const INSTALLED = '/v1/skills/installed';

export function filterSkills(items = [], query = '') {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return items.slice();
  return items.filter((item) => `${item.name} ${item.description || item.content || ''}`.toLowerCase().includes(needle));
}

export function skillCountLabel(shown, total) {
  return shown === total ? `共 ${total} 个技能` : `显示 ${shown} / ${total} 个技能`;
}

export function accountButtonLabel(installed) {
  return installed ? '移出我的技能库' : '加入我的技能库';
}

async function errorText(response, fallback) {
  try {
    const payload = await response.json();
    const message = payload && payload.error && payload.error.message;
    if (typeof message === 'string' && message) return message;
  } catch (failure) {
    return fallback;
  }
  return fallback;
}

function installSet(payload) {
  return new Set(payload && Array.isArray(payload.installed) ? payload.installed : []);
}

export async function readInstalled(fetcher = fetch) {
  const response = await fetcher(INSTALLED, {
    method: 'GET',
    credentials: 'same-origin',
    headers: {Accept: 'application/json'},
  });
  if (!response.ok) throw new Error(await errorText(response, '读取已安装技能失败，请重试'));
  return installSet(await response.json());
}

export async function writeInstalled(skillId, wanted, options = {}) {
  const fetcher = options.fetchImpl || fetch;
  const cookie = options.cookie !== undefined
    ? options.cookie
    : (typeof document === 'undefined' ? '' : document.cookie);
  const response = await fetcher(INSTALLED, {
    method: wanted ? 'POST' : 'DELETE',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfCookie(cookie),
    },
    body: JSON.stringify({skill: skillId}),
  });
  if (!response.ok) {
    throw new Error(await errorText(response, wanted ? '安装失败，请重试' : '卸载失败，请重试'));
  }
  return installSet(await response.json());
}

export function mountSkills(document, {fetcher = globalThis.fetch.bind(globalThis), read, write, catalogue: given} = {}) {
  const list = document.getElementById('skills-list'), input = document.getElementById('skills-search');
  if (!list || !input) return null;
  const error = document.getElementById('skills-error');
  const scope = document.getElementById('skills-scope');
  const permission = document.getElementById('skills-permission');
  let catalogue = given || [], bindings = [], busy = false;
  const installedSet = new Set();
  const account = {
    read: read || (() => readInstalled(fetcher)),
    write: write || ((skillId, wanted) => writeInstalled(skillId, wanted, {fetchImpl: fetcher, cookie: document.cookie})),
  };
  async function request(method,path,body,key) {
    const csrf = csrfCookie(document.cookie);
    const result = await fetcher(path,{method, credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf,...(key ? {'Idempotency-Key':key} : {})},body:body ? JSON.stringify(body) : undefined});
    const data = await result.json();
    if (!result.ok && result.status !== 200) throw new Error(data.error?.message || '请求失败。');
    return data;
  }
  const execution=mountSkillExecution(document,{request,scope});
  const imports=mountImportedSkills(document,{request,onChange:async()=>{
    const results=await Promise.all([request('GET','/v1/skills/catalog'),request('GET','/v1/skills/bindings')]);
    catalogue=results[0].items||[];bindings=results[1].items||[];render();await execution.refresh();
  }});
  function render() {
    execution.setSkills(catalogue,bindings);
    const matches = filterSkills(catalogue,input.value);
    const selected = scope ? scope.value : 'account';
    list.replaceChildren();
    for (const skill of matches) {
      const item = document.createElement('li'); item.className='skill-card';
      if (installedSet.has(skill.id)) item.className+=' is-in-library';
      const mark = document.createElement('span'); mark.className='skill-mark';mark.textContent=skill.name.slice(0,1);
      const copy = document.createElement('span');copy.className='skill-copy';
      const name = document.createElement('strong');name.textContent=skill.name;
      const status = document.createElement('p');
      const binding = bindings.find(b => b.scope === selected && b.skill_id === skill.id);
      if(binding)item.className+=' is-installed';
      status.textContent = binding && (binding.version!==skill.version || binding.digest!==skill.digest) ? '版本已变化；请阅读新内容并重新安装' : binding ? (binding.last_loaded_task ? '已安装；历史任务已有加载回执（新任务重新校验）' : '已安装；等待下次推理任务加载') : '未安装';
      const details = document.createElement('details'), summary = document.createElement('summary');summary.textContent='查看真实技能内容 · '+skill.version;
      const content = document.createElement('pre');content.style.whiteSpace='pre-wrap';content.textContent=skill.content;
      const digest = document.createElement('small');digest.textContent='SHA-256: '+skill.digest;
      details.append(summary,content,digest);copy.append(name,status,details);
      const button=document.createElement('button');button.type='button';button.className='skill-install';button.dataset.skill=skill.id;
      button.textContent=binding ? '卸载' : '安装';button.disabled=busy;button.setAttribute('aria-label',button.textContent+' '+skill.name);
      button.addEventListener('click',async () => {
        if (busy) return;
        if (!binding && !(permission && permission.checked)) { error.textContent='请先阅读技能内容并勾选允许将其作为模型上下文。'; return; }
        const wantedScope=selected;busy=true;error.textContent='';render();
        try {
          await request('POST','/v1/skills/bindings',{skill_id:skill.id,version:skill.version,digest:skill.digest,scope:wantedScope,enabled:!binding,permissions:['model_context']});
          bindings=(await request('GET','/v1/skills/bindings')).items || [];
          error.textContent=binding ? '已撤销绑定；新任务不可再加载该技能。已发往模型的内容无法撤回。' : '内容与绑定已安装；下次任务须通过运行时摘要校验及加载回执后才算已加载。';
        } catch(e) {error.textContent=e.message || '网络错误，结果未知，请刷新检查。';}
        finally {busy=false;render();}
      });
      const library = document.createElement('button');
      library.type='button';library.className='skill-library';library.dataset.library=skill.id;
      const inLibrary = installedSet.has(skill.id);
      library.textContent=accountButtonLabel(inLibrary);
      library.setAttribute('aria-pressed', inLibrary ? 'true' : 'false');
      library.setAttribute('aria-label', library.textContent + ' ' + skill.name);
      library.disabled=busy;
      library.addEventListener('click',async () => {
        if (busy) return;
        busy=true;library.disabled=true;error.textContent='';
        try {
          const next=await account.write(skill.id,!installedSet.has(skill.id));
          installedSet.clear();
          for (const value of next) installedSet.add(value);
        } catch(e) {error.textContent=e.message || '网络错误，结果未知，请刷新检查。';}
        finally {busy=false;render();}
      });
      if(skill.source==='user-imported'){
        const manage=document.createElement('button');manage.type='button';manage.textContent='管理版本';manage.addEventListener('click',()=>imports?.edit(skill));
        const revoke=document.createElement('button');revoke.type='button';revoke.textContent='撤销私有包';revoke.addEventListener('click',()=>imports?.revoke(skill));
        const download=document.createElement('a');download.textContent='下载 JSON 包';download.href='/v1/skills/packages/'+encodeURIComponent(skill.id)+'/versions/'+encodeURIComponent(skill.version);
        copy.append(manage,download,revoke);
      }
      item.append(mark,copy,button,library);
      if(binding){
        const current=binding.version===skill.version&&binding.digest===skill.digest;
        const use=document.createElement('button');use.type='button';use.textContent=current?'使用技能':'重新安装当前版本';use.className='skill-use';use.disabled=busy;
        use.addEventListener('click',async()=>{
          if(current){execution.selectSkill(skill.id);return;}
          if(busy)return;
          if(!permission.checked){error.textContent='请阅读新版本内容并确认模型上下文权限，再重新安装。';return;}
          busy=true;render();
          try{
            await request('POST','/v1/skills/bindings',{skill_id:skill.id,version:skill.version,digest:skill.digest,scope:scope.value,enabled:true,permissions:['model_context']});
            bindings=(await request('GET','/v1/skills/bindings')).items||[];permission.checked=false;error.textContent='新版本绑定已保存；等待实际任务加载，不复用旧版本回执。';
            await execution.refresh();
          }catch(e){error.textContent=e.message||'绑定结果未知，请刷新核对。';}
          finally{busy=false;render();}
        });item.append(use);
      }
      list.append(item);
    }
    const empty=document.getElementById('skills-empty');if(empty)empty.hidden=matches.length>0;
    const count=document.getElementById('skills-count');if(count)count.textContent=skillCountLabel(matches.length,catalogue.length);
  }
  async function load() {
    try {
      const results = await Promise.all([request('GET','/v1/skills/catalog'),request('GET','/v1/skills/bindings')]);
      const fetched=results[0].items || [];catalogue=fetched.length ? fetched : (given || []);bindings=results[1].items || [];
      try {
        installedSet.clear();
        for (const value of await account.read()) installedSet.add(value);
      } catch(e) {error.textContent=e.message || '读取我的技能库失败，请刷新重试。';}
      render();
      if (!scope) return;
      const options=new Map();
      for(const binding of bindings){
        if(binding.scope==='account'||options.has(binding.scope))continue;
        const option=document.createElement('option');option.value=binding.scope;option.textContent='已绑定智能体（可撤销） · '+binding.scope.slice(-8);scope.append(option);options.set(binding.scope,option);
      }
      const scopes=(await request('GET','/v1/skills/scopes')).items || [];
      for (const entry of scopes) {
        if(entry.scope==='account')continue;
        const option=options.get(entry.scope)||document.createElement('option');option.value=entry.scope;
        option.textContent=(entry.kind==='automation'?'自动化 · ':'智能体 · ')+entry.label;
        if(!options.has(entry.scope)){scope.append(option);options.set(entry.scope,option);}
      }
      await execution.refresh();
    } catch(e) {error.textContent=e.message || '技能读取失败，请刷新重试。';}
  }
  input.addEventListener('input',render);
  if (scope) scope.addEventListener('change',() => {if (permission) permission.checked=false;render();execution.refresh();});
  const ready=load();return {render,ready,installed:installedSet};
}

if (typeof document !== 'undefined') mountSkills(document);
