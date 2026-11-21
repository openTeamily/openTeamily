import {csrfCookie, waitForRuntime} from './runtime-readiness.mjs';

const title = document.getElementById('runtime-title');
const status = document.getElementById('runtime-status');
const retry = document.getElementById('runtime-retry');

async function read() {
  const response = await fetch('/v1/auth/runtime-readiness', {
    headers: {Accept: 'application/json'}, redirect: 'error', signal: AbortSignal.timeout(8000),
  });
  return {status: response.status, body: await response.json()};
}

async function start() {
  retry.hidden = true;
  title.textContent = '正在启动你的专属智能体';
  status.textContent = '就绪后会自动打开你要访问的页面。';
  let state = await waitForRuntime(read);
  if (state === 'setup') {
    const result = await fetch('/v1/personal-agent', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: {Accept: 'application/json', 'X-CSRF-Token': csrfCookie(document.cookie)},
    }).catch(() => null);
    state = result?.ok ? await waitForRuntime(read) : 'unavailable';
  }
  if (state === 'signed-out') {
    location.replace('/login');
  } else if (state === 'ready') {
    if (location.pathname === '/runtime-starting') location.replace('/chat');
    else location.reload();
  } else {
    title.textContent = '专属智能体暂未就绪';
    status.textContent = state === 'timeout' ? '还在启动，请稍后重试。' : '暂时无法连接到你的智能体，请稍后重试。';
    retry.hidden = false;
  }
}

retry.addEventListener('click', start);
start();
