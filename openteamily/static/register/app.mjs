// Credentials stay in form memory and the existing same-origin auth API only.
import {publicAgentIntentFromHash, publicAgentContinuation} from '../shell/public-agent-link.mjs';
const MESSAGES = {
  registration_closed: '本实例尚未开放注册，请联系实例管理员。',
  conflict: '此用户名不可用，请选择其他用户名。',
  rate_limited: '尝试次数过多，请稍后再试。',
  invalid: '请检查用户名和密码格式。',
  quota: '本实例账户数量已达上限。',
};

export async function registerAccount(username, password, fetcher = globalThis.fetch) {
  try {
    const response = await fetcher('/v1/auth/register', {
      method: 'POST', credentials: 'same-origin', mode: 'same-origin', redirect: 'error',
      headers: {'Content-Type': 'application/json', 'Accept': 'application/json'},
      body: JSON.stringify({username, password}),
    });
    if (response.status === 201) {
      try {
        const session=await fetcher('/v1/auth/session',{method:'GET',credentials:'same-origin',mode:'same-origin',redirect:'error',headers:{Accept:'application/json'}});
        const data=await session.json();
        if(session.status===200&&data?.user?.id&&data.user.username===username.trim().toLowerCase())return {ok:true};
      }catch{}
      return {ok:false,created:true,message:'账户已创建，但登录会话尚未确认。请使用本实例 HTTPS 地址，允许同源 Cookie，然后尝试登录；不要重复注册。'};
    }
    const body = await response.json().catch(() => ({}));
    // Never render arbitrary backend bodies or exceptions (which may echo input).
    const code = body?.error?.code;
    return {ok: false, message: Object.hasOwn(MESSAGES, code) ? MESSAGES[code] : '未能创建账户，请稍后重试。'};
  } catch {
    return {ok: false, message: '无法连接到本实例，请稍后重试。'};
  }
}

export function mountRegistration(document, navigate, fetcher = globalThis.fetch) {
  const form = document.getElementById('register-form');
  const button = document.getElementById('register-submit');
  const status = document.getElementById('register-status');
  const username = document.getElementById('register-username');
  const password = document.getElementById('register-password');
  const continuation = publicAgentContinuation(publicAgentIntentFromHash(document.defaultView?.location?.hash));
  const login = document.querySelector?.('a[href="/login"]');
  if (login && continuation) login.href = '/login' + continuation;
  const helpButton=document.getElementById('help-menu-button'),helpMenu=document.getElementById('help-menu');
  helpButton?.addEventListener('click',()=>{if(helpMenu){helpMenu.hidden=!helpMenu.hidden;helpButton.setAttribute('aria-expanded',String(!helpMenu.hidden));}});
  let attempted=false;
  const policy=document.getElementById('register-policy');
  if(policy)Promise.resolve(fetcher('/v1/auth/policy',{method:'GET',credentials:'same-origin',mode:'same-origin',redirect:'error'})).then(async response=>{
    const data=await response.json();
    if(attempted)return;
    if(response.status!==200||typeof data.registration_open!=='boolean')throw new Error('policy');
    policy.textContent=data.registration_open?'本实例已开放注册。创建的是普通账户；个人工作区在登录后初始化。':'本实例当前关闭公开注册。请联系管理员确认 --open-registration；此页面不会绕过注册策略。';
  }).catch(()=>{if(!attempted)policy.textContent='无法读取注册策略。请检查实例 HTTPS / 反向代理配置，或联系管理员。';});
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (button.disabled || !form.reportValidity()) return;
    attempted=true;
    button.disabled = true;
    status.textContent = '正在创建账户…';
    const result = await registerAccount(username.value, password.value, fetcher);
    password.value = '';
    button.disabled = false;
    if (result.ok) {
      status.textContent = '账户和登录会话已确认，正在初始化个人工作区…';
      navigate(continuation ? '/login' + continuation : '/');
    } else {
      status.textContent = result.message;
      password.focus();
    }
  });
}

if (typeof document !== 'undefined') {
  mountRegistration(document, path => globalThis.location.assign(path));
}
