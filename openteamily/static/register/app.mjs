// Credentials stay in form memory and the existing same-origin auth API only.
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

async function postJson(url, body, fetcher = globalThis.fetch) {
  try {
    const response = await fetcher(url, {
      method: 'POST', credentials: 'same-origin', mode: 'same-origin', redirect: 'error',
      headers: {'Content-Type': 'application/json', 'Accept': 'application/json'},
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    return {status: response.status, body: payload};
  } catch {
    return {status: 0, body: {}};
  }
}

export async function requestPasswordSetup(email, fetcher = globalThis.fetch) {
  const result = await postJson('/v1/auth/password/request', {email, accept_terms: true}, fetcher);
  if (result.status === 200) return {ok: true, message: '如果该邮箱可以注册或设置密码，我们已发送设置密码链接。请检查收件箱和垃圾邮件。'};
  const code = result.body?.error?.code;
  const messages = {
    terms_required: '请先勾选同意服务条款和隐私政策。',
    rate_limited: '操作过于频繁，请稍后再试。',
    resend_wait: '请稍后再获取新的邮件。',
    registration_closed: '本实例尚未开放邮箱注册。',
    mail_unavailable: '邮件暂时无法发送，请稍后再试。',
  };
  return {ok: false, message: messages[code] || '无法发送邮件，请稍后再试。'};
}

export async function requestEmailLoginCode(email, fetcher = globalThis.fetch) {
  const result = await postJson('/v1/auth/email/login/start', {email}, fetcher);
  if (result.status === 200) return {ok: true, message: '如果该邮箱已有账户，登录验证码已发送。请检查收件箱和垃圾邮件。'};
  const code = result.body?.error?.code;
  const messages = {
    rate_limited: '操作过于频繁，请稍后再试。',
    resend_wait: '请稍后再获取新的验证码。',
    registration_closed: '本实例尚未开放邮箱登录。',
    mail_unavailable: '邮件暂时无法发送，请稍后再试。',
  };
  return {ok: false, message: messages[code] || '无法发送验证码，请稍后再试。'};
}

export async function loginWithEmailCode(email, code, fetcher = globalThis.fetch) {
  const result = await postJson('/v1/auth/email/login/verify', {email, code}, fetcher);
  if (result.status === 200) return {ok: true};
  const error = result.body?.error?.code;
  return {ok: false, message: error === 'too_many_attempts' ? '尝试次数过多，请重新获取。' : '验证码不正确或已过期。'};
}

export function mountRegistration(document, navigate, fetcher = globalThis.fetch) {
  const form = document.getElementById('register-form');
  const button = document.getElementById('register-submit');
  const status = document.getElementById('register-status');
  const username = document.getElementById('register-username');
  const password = document.getElementById('register-password');
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
  const emailRegisterForm = document.getElementById('email-register-form');
  const emailRegisterSend = document.getElementById('email-register-send');
  const emailRegisterStatus = document.getElementById('email-register-status');
  const emailRegisterAddress = document.getElementById('email-register-address');
  const emailRegisterTerms = document.getElementById('email-register-terms');
  if (emailRegisterForm && emailRegisterSend) {
    emailRegisterSend.addEventListener('click', async () => {
      if (emailRegisterSend.disabled) return;
      if (!emailRegisterForm.reportValidity()) return;
      if (!emailRegisterTerms || !emailRegisterTerms.checked) {
        emailRegisterStatus.textContent = '请先勾选同意服务条款和隐私政策。';
        return;
      }
      emailRegisterSend.disabled = true;
      emailRegisterStatus.textContent = '正在发送设置密码链接…';
      const result = await requestPasswordSetup(emailRegisterAddress.value.trim().toLowerCase(), fetcher);
      emailRegisterSend.disabled = false;
      emailRegisterStatus.textContent = result.message;
    });
  }
  const emailLoginForm = document.getElementById('email-login-form');
  const emailLoginSend = document.getElementById('email-login-send');
  const emailLoginStatus = document.getElementById('email-login-status');
  const emailLoginAddress = document.getElementById('email-login-address');
  const emailLoginCode = document.getElementById('email-login-code');
  if (emailLoginForm && emailLoginSend) {
    emailLoginSend.addEventListener('click', async () => {
      if (emailLoginSend.disabled) return;
      if (!emailLoginForm.reportValidity()) return;
      emailLoginSend.disabled = true;
      emailLoginStatus.textContent = '正在发送验证码…';
      const result = await requestEmailLoginCode(emailLoginAddress.value.trim().toLowerCase(), fetcher);
      emailLoginSend.disabled = false;
      emailLoginStatus.textContent = result.message;
    });
    emailLoginForm.addEventListener('submit', async event => {
      event.preventDefault();
      if (!emailLoginForm.reportValidity()) return;
      const result = await loginWithEmailCode(emailLoginAddress.value.trim().toLowerCase(),
        emailLoginCode.value.trim(), fetcher);
      if (result.ok) {
        emailLoginStatus.textContent = '登录成功，正在打开工作区…';
        navigate('/');
      } else {
        emailLoginStatus.textContent = result.message;
        emailLoginCode.focus();
      }
    });
  }
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
      navigate('/');
    } else {
      status.textContent = result.message;
      password.focus();
    }
  });
}

if (typeof document !== 'undefined') {
  mountRegistration(document, path => globalThis.location.assign(path));
}
