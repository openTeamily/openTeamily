export function readToken(search) {
  return new URLSearchParams(String(search || '').replace(/^\?/, '')).get('token') || '';
}

export function validatePasswords(password, confirm) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) {
    return '密码需要 12–256 个字符。';
  }
  if (password !== confirm) return '两次输入的密码不一致。';
  return '';
}

export async function setPassword(token, password, fetcher = globalThis.fetch) {
  try {
    const response = await fetcher('/v1/auth/password/complete', {
      method: 'POST', credentials: 'same-origin', mode: 'same-origin', redirect: 'error',
      headers: {'Content-Type': 'application/json', 'Accept': 'application/json'},
      body: JSON.stringify({token, password}),
    });
    const body = await response.json().catch(() => ({}));
    if (response.status === 200) return {ok: true};
    const code = body?.error?.code;
    return {ok: false, message: code === 'invalid_token' ? '链接无效或已过期，请重新申请。'
      : code === 'invalid' ? '链接或密码格式不正确。' : '无法保存密码，请稍后再试。'};
  } catch {
    return {ok: false, message: '无法连接到本实例，请稍后再试。'};
  }
}

export function mount(document, navigate, fetcher = globalThis.fetch) {
  const form = document.getElementById('set-password-form');
  const lead = document.getElementById('set-password-lead');
  const status = document.getElementById('set-password-status');
  const button = document.getElementById('set-password-submit');
  const password = document.getElementById('set-password-value');
  const confirm = document.getElementById('set-password-confirm');
  if (!form || !lead) return;
  const token = readToken(globalThis.location && globalThis.location.search);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    lead.textContent = '这个设置密码链接无效或已过期。请回到注册页重新申请。';
    return;
  }
  lead.textContent = '链接已识别。设置密码后即可用邮箱和密码登录。';
  form.hidden = false;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (button.disabled || !form.reportValidity()) return;
    const message = validatePasswords(password.value, confirm.value);
    if (message) { status.textContent = message; password.focus(); return; }
    button.disabled = true;
    status.textContent = '正在保存密码…';
    const result = await setPassword(token, password.value, fetcher);
    button.disabled = false;
    password.value = '';
    confirm.value = '';
    if (result.ok) {
      status.textContent = '密码已保存，正在打开工作区…';
      navigate('/');
    } else {
      status.textContent = result.message;
      password.focus();
    }
  });
}

if (typeof document !== 'undefined') {
  mount(document, path => globalThis.location.assign(path));
}
