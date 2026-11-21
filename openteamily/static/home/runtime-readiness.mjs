export function csrfCookie(source) {
  const match = /(?:^|;\s*)(?:__Host-ot_csrf|ot_dev_csrf)=([^;]+)/.exec(source || '');
  return match ? decodeURIComponent(match[1]) : '';
}

const signupSessionKey = 'ot-expected-signup-session';
const signupLifetimeMs = 5 * 60 * 1000;
const platformUserId = /^[0-9a-f]{32}$/;
export const signupSessionError = '账户已创建，但登录会话尚未确认。请使用本实例 HTTPS 地址，允许同源 Cookie，然后尝试登录；不要重复注册。';

export function rememberSignupSession(view, id, now = Date.now()) {
  if (typeof id !== 'string' || !platformUserId.test(id)) return false;
  try {
    if (!view?.sessionStorage) return false;
    view.sessionStorage.setItem(signupSessionKey, JSON.stringify({id, expires: now + signupLifetimeMs}));
    return true;
  } catch {
    return false;
  }
}

export function takeSignupSession(view, now = Date.now()) {
  try {
    const stored = view.sessionStorage.getItem(signupSessionKey);
    if (!stored) return null;
    view.sessionStorage.removeItem(signupSessionKey);
    const {id, expires} = JSON.parse(stored);
    return typeof id === 'string' && platformUserId.test(id)
      && Number.isFinite(expires) && expires > now && expires <= now + signupLifetimeMs ? id : null;
  } catch {
    return null;
  }
}

export async function waitForRuntime(read, {delay = ms => new Promise(resolve => setTimeout(resolve, ms)), attempts = 66} = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt) await delay(attempt <= 30 ? 1000 : 3000);
    const reply = await read().catch(() => null);
    if (reply?.status === 401) return 'signed-out';
    const state = reply?.body?.state;
    if (reply?.status === 200 && ['ready', 'unmanaged', 'unavailable', 'setup'].includes(state)) return state;
  }
  return 'timeout';
}
