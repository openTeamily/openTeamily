export function csrfCookie(source) {
  const match = /(?:^|;\s*)(?:__Host-ot_csrf|ot_dev_csrf)=([^;]+)/.exec(source || '');
  return match ? decodeURIComponent(match[1]) : '';
}

export const EXPIRY_SECONDS = {d7: 7 * 86400, d30: 30 * 86400, d90: 90 * 86400};

export function readKeyForm(form) {
  const data = new FormData(form);
  const body = {name: (data.get('name') || '').trim()};
  const period = data.get('expires') || 'never';
  if (period !== 'never' && EXPIRY_SECONDS[period]) body.expires_in = EXPIRY_SECONDS[period];
  return body;
}

export function canIssueKey(name) {
  return Boolean((name || '').trim());
}

export function installCommands(origin) {
  const base = (origin || '').replace(/\/$/, '');
  return {
    unix: `python3 -c 'from urllib.request import urlretrieve; urlretrieve("${base}/install/flybot.pyz", "flybot.pyz")'`,
    windows: `Invoke-WebRequest -Uri ${base}/install/flybot.pyz -OutFile flybot.pyz`,
    daemon: `python3 flybot.pyz daemon start --origin ${base} --key-file ./runtime-key`,
  };
}

export function readTestTask(form) {
  const data = new FormData(form);
  const kind = data.get('kind') === 'infer' ? 'infer' : 'echo';
  return {kind, prompt: (data.get('prompt') || '').trim()};
}

export function listItemHasSecret(item) {
  return Boolean(item && Object.prototype.hasOwnProperty.call(item, 'token'));
}

export function summarizeConnections(items) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  const online = list.filter(item => item.status === 'online');
  if (online.length) {
    return {kind: 'online', label: '在线', items: list, preview: online};
  }
  if (list.length) {
    return {kind: 'offline', label: '离线', items: list, preview: list};
  }
  return {kind: 'empty', label: '尚未连接本机或远程设备', items: [], preview: []};
}

const TASK_STATUS_TEXT = {
  queued: '排队中',
  claimed: '已领取',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
  timeout: '超时',
};

const TASK_PROMPT_LIMIT = 80;
const TASKS_EMPTY_TEXT = '还没有发到运行时的任务。发一个测试任务后会出现在这里。';

export function taskStatusText(task) {
  return TASK_STATUS_TEXT[task && task.status] || '未知';
}

export function taskPromptText(task) {
  const text = String((task && task.prompt) || '').replace(/\s+/g, ' ').trim();
  if (!text) return '（无内容）';
  return text.length > TASK_PROMPT_LIMIT ? text.slice(0, TASK_PROMPT_LIMIT) + '…' : text;
}

export function taskActions(task) {
  const status = task && task.status;
  return status === 'queued' || status === 'claimed' ? ['cancel'] : [];
}

function taskKindText(task) {
  if (task && task.kind === 'infer') return '推理';
  if (task && task.kind === 'echo') return '测试';
  return '任务';
}

function taskBadgeClass(task) {
  return task && task.status === 'succeeded' ? 'is-online' : 'is-pending';
}

export function lastSeenText(lastSeen, now) {
  const seen = Number(lastSeen);
  const at = Number(now);
  if (lastSeen === null || lastSeen === undefined || !Number.isFinite(seen) || !Number.isFinite(at)) return '未知';
  const seconds = Math.max(0, Math.floor(at - seen));
  if (seconds < 60) return '刚刚';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

export function connectionText(item, now) {
  const online = Boolean(item) && item.status === 'online';
  const when = lastSeenText(item && item.last_seen, now);
  if (when === '未知') return online ? '已连接（最后活跃时间未知）' : '在线时间未知';
  if (online) return when === '刚刚' ? '已连接（刚刚有活动）' : `已连接（最后活跃 ${when}）`;
  return when === '刚刚' ? '刚刚离线' : `最后在线 ${when}`;
}

function messageFor(error, fallback) {
  if (error && error.message) return error.message;
  return fallback;
}

function formatExpiry(expires) {
  if (!expires) return '永不过期';
  return '过期时间 ' + String(expires);
}

export function mount(document, {fetcher = globalThis.fetch.bind(globalThis), origin} = {}) {
  const status = document.getElementById('status');
  const loginPanel = document.getElementById('login-panel');
  const mainPanel = document.getElementById('main-panel');
  const runtimesPanel = document.getElementById('runtimes-panel');
  const connectPanel = document.getElementById('connect-panel');
  const host = origin || (globalThis.location && globalThis.location.origin) || '';
  let currentUser = null;
  let tab = 'runtimes';

  function show(kind, text) {
    status.dataset.kind = kind;
    status.textContent = text;
  }

  function showTab(name) {
    tab = name === 'connect' ? 'connect' : 'runtimes';
    runtimesPanel.hidden = tab !== 'runtimes';
    connectPanel.hidden = tab !== 'connect';
    for (const button of document.querySelectorAll('.tabs [data-tab]')) {
      button.setAttribute('aria-selected', button.dataset.tab === tab ? 'true' : 'false');
    }
  }

  function fillCommands() {
    const commands = installCommands(host);
    const unix = document.getElementById('install-unix');
    const windows = document.getElementById('install-windows');
    const daemon = document.getElementById('daemon-command');
    const localDaemon = document.getElementById('local-daemon-command');
    if (unix) unix.textContent = commands.unix;
    if (windows) windows.textContent = commands.windows;
    if (daemon) daemon.textContent = commands.daemon;
    if (localDaemon) localDaemon.textContent = commands.daemon;
  }

  async function request(method, path, body) {
    const headers = {'Accept': 'application/json', 'X-CSRF-Token': csrfCookie(document.cookie)};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetcher(path, {
      method, headers, credentials: 'same-origin',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let parsed = {};
    try { parsed = await response.json(); } catch { parsed = {}; }
    return {status: response.status, body: parsed};
  }

  async function renderProviders() {
    const box = document.getElementById('oidc-providers');
    if (!box) return;
    box.textContent = '';
    const listed = await request('GET', '/v1/auth/providers');
    if (listed.status !== 200 || !listed.body.items || !listed.body.items.length) return;
    for (const item of listed.body.items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = '使用 ' + item.label + ' 登录';
      button.addEventListener('click', async () => {
        const started = await request('POST', '/v1/auth/oidc/start', {provider: item.id});
        if (started.status !== 200 || !started.body.authorization_url) {
          show('error', messageFor(started.body.error, '无法开始第三方登录。'));
          return;
        }
        globalThis.location.assign(started.body.authorization_url);
      });
      box.appendChild(button);
    }
  }

  function hasUsableKey(items) {
    return (items || []).some((item) => item && !item.revoked && !listItemHasSecret(item));
  }

  function renderKeyDependent(items) {
    const usable = hasUsableKey(items);
    const pending = document.getElementById('daemon-pending');
    const script = document.getElementById('daemon-script');
    const apiBlock = document.getElementById('api-key-script-block');
    if (pending) pending.hidden = usable;
    if (script) script.hidden = !usable;
    if (apiBlock) apiBlock.hidden = usable;
  }

  function renderKeys(items) {
    const list = document.getElementById('key-list');
    const empty = document.getElementById('keys-empty');
    const rows = (items || []).filter((item) => !listItemHasSecret(item));
    list.textContent = '';
    if (empty) empty.hidden = rows.length > 0;
    for (const item of rows) {
      const row = document.createElement('li');
      const meta = document.createElement('span');
      const state = item.revoked ? '已撤销' : formatExpiry(item.expires);
      meta.textContent = `${item.name} · ${item.prefix}… · ${state}`;
      row.appendChild(meta);
      if (!item.revoked) {
        const revoke = document.createElement('button');
        revoke.type = 'button';
        revoke.textContent = '撤销';
        revoke.addEventListener('click', () => revokeKey(item));
        row.appendChild(revoke);
      }
      list.appendChild(row);
    }
    renderKeyDependent(rows);
  }

  async function revokeKey(item) {
    const result = await request('POST', `/v1/runtime-keys/${item.id}/revoke`, {});
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法撤销密钥。'));
      return;
    }
    show('ok', '已撤销密钥。');
    await loadKeys();
  }

  function connectionRow(item, now) {
    const row = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = item.hostname || 'flybot';
    const state = document.createElement('span');
    const online = item.status === 'online';
    state.className = 'runtime-badge ' + (online ? 'is-online' : 'is-offline');
    state.textContent = online ? '在线' : '离线';
    const seen = document.createElement('span');
    seen.textContent = connectionText(item, now);
    row.appendChild(name);
    row.appendChild(state);
    row.appendChild(seen);
    return row;
  }

  function renderConnections(items) {
    const list = document.getElementById('connection-list');
    const empty = document.getElementById('connections-empty');
    if (!list) return;
    const now = Math.floor(Date.now() / 1000);
    list.textContent = '';
    if (empty) empty.hidden = items.length > 0;
    for (const item of items) list.appendChild(connectionRow(item, now));
    renderDetected(items);
    renderLocalStatus(items);
  }

  function renderDetected(items) {
    const list = document.getElementById('detected-list');
    const empty = document.getElementById('detected-empty');
    if (!list) return;
    const now = Math.floor(Date.now() / 1000);
    list.textContent = '';
    if (empty) empty.hidden = items.length > 0;
    for (const item of items) list.appendChild(connectionRow(item, now));
  }

  function renderLocalStatus(items) {
    const summary = summarizeConnections(items);
    const card = document.getElementById('local-status-card');
    const label = document.getElementById('local-status-label');
    const detail = document.getElementById('local-status-detail');
    if (card) card.dataset.state = summary.kind;
    if (label) label.textContent = summary.label;
    const badge = document.getElementById('local-status-badge');
    if (badge) {
      badge.className = 'runtime-badge ' + (summary.kind === 'online' ? 'is-online' : 'is-offline');
      badge.textContent = summary.kind === 'online' ? '在线' : '离线';
    }
    if (!detail) return;
    if (summary.kind === 'empty') {
      detail.textContent = '请在「连接」里生成密钥，下载 flybot.pyz，在自己的机器上启动守护进程并用同一账号登记。OpenTeamily 没有官方桌面应用。';
      return;
    }
    const names = summary.preview.map(item => item.hostname || 'flybot').join('、');
    detail.textContent = summary.kind === 'online'
      ? `${names} 已连接。任务会发到这些机器。`
      : `${names} 已登记但不在线。请确认守护进程仍在运行。`;
  }

  function renderTasks(items) {
    const list = document.getElementById('task-list');
    const empty = document.getElementById('tasks-empty');
    if (!list) return;
    const rows = Array.isArray(items) ? items.filter(Boolean) : [];
    list.textContent = '';
    if (empty) {
      empty.hidden = rows.length > 0;
      empty.textContent = TASKS_EMPTY_TEXT;
    }
    for (const item of rows) {
      const row = document.createElement('li');
      const prompt = document.createElement('span');
      prompt.textContent = taskPromptText(item);
      const meta = document.createElement('span');
      meta.className = 'runtime-badge ' + taskBadgeClass(item);
      meta.textContent = `${taskKindText(item)} · ${taskStatusText(item)}`;
      row.appendChild(prompt);
      row.appendChild(meta);
      if (taskActions(item).includes('cancel')) {
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.textContent = '取消';
        cancel.addEventListener('click', () => cancelTask(item));
        row.appendChild(cancel);
      }
      list.appendChild(row);
    }
  }

  async function loadTasks() {
    const listed = await request('GET', '/v1/runtime/tasks');
    if (listed.status !== 200) {
      show('error', messageFor(listed.body.error, '无法读取运行时任务。'));
      return;
    }
    renderTasks(listed.body.items || []);
  }

  async function cancelTask(item) {
    const result = await request('POST', `/v1/runtime/tasks/${item.id}/cancel`);
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, result.status === 409 ? '这个任务已经不能再取消。' : '无法取消任务。'));
      return;
    }
    show('ok', '已取消任务。');
    await loadTasks();
  }

  async function detectRuntimes() {
    const connections = await request('GET', '/v1/runtime/connections');
    if (connections.status !== 200) {
      show('error', messageFor(connections.body.error, '无法检测已登记的运行时。'));
      return;
    }
    renderConnections(connections.body.items || []);
    show('ok', '已刷新向本管理面登记过的运行时。这不会扫描本机进程或局域网。');
  }

  async function loadKeys() {
    const listed = await request('GET', '/v1/runtime-keys');
    if (listed.status !== 200) {
      show('error', messageFor(listed.body.error, '无法读取运行时密钥。'));
      return;
    }
    const device = document.getElementById('device-id');
    if (device) {
      const value = listed.body.device_id || '';
      if ('value' in device) device.value = value;
      else device.textContent = value;
    }
    renderKeys(listed.body.items || []);
    const connections = await request('GET', '/v1/runtime/connections');
    if (connections.status === 200) renderConnections(connections.body.items || []);
  }

  async function load() {
    fillCommands();
    const session = await request('GET', '/v1/auth/session');
    if (session.status === 401) {
      loginPanel.hidden = false;
      mainPanel.hidden = true;
      show('', '');
      await renderProviders();
      return;
    }
    if (session.status !== 200) {
      show('error', messageFor(session.body.error, '无法读取会话。'));
      return;
    }
    currentUser = session.body.user;
    loginPanel.hidden = true;
    mainPanel.hidden = false;
    document.getElementById('whoami').textContent = currentUser.username;
    await loadKeys();
    await loadTasks();
  }

  document.getElementById('login-form').addEventListener('submit', async event => {
    event.preventDefault();
    const result = await request('POST', '/v1/auth/login', {
      username: document.getElementById('username').value,
      password: document.getElementById('password').value,
    });
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '登录失败。'));
      return;
    }
    document.getElementById('password').value = '';
    await load();
  });

  for (const button of document.querySelectorAll('.tabs [data-tab]')) {
    button.addEventListener('click', () => showTab(button.dataset.tab));
  }
  document.getElementById('open-connect').addEventListener('click', () => showTab('connect'));
  const detectButton = document.getElementById('detect-runtimes');
  if (detectButton) {
    detectButton.addEventListener('click', () => detectRuntimes());
  }
  const refreshTasks = document.getElementById('refresh-tasks');
  if (refreshTasks) {
    refreshTasks.addEventListener('click', () => loadTasks());
  }

  function syncGenerateButton() {
    const input = document.getElementById('key-name') || document.querySelector('#key-form [name="name"]');
    const button = document.getElementById('generate-key');
    if (button) button.disabled = !canIssueKey(input && input.value);
  }
  const keyName = document.getElementById('key-name') || document.querySelector('#key-form [name="name"]');
  if (keyName) {
    keyName.addEventListener('input', syncGenerateButton);
    keyName.addEventListener('change', syncGenerateButton);
  }
  syncGenerateButton();

  let installOs = 'unix';
  function showInstallOs(name) {
    installOs = name === 'windows' ? 'windows' : 'unix';
    const unix = document.getElementById('install-unix');
    const windows = document.getElementById('install-windows');
    const lang = document.getElementById('install-lang');
    if (unix) unix.hidden = installOs !== 'unix';
    if (windows) windows.hidden = installOs !== 'windows';
    if (lang) lang.textContent = installOs === 'windows' ? 'powershell' : 'shell';
    for (const button of document.querySelectorAll('.os-tabs [data-os]')) {
      button.setAttribute('aria-selected', button.getAttribute('data-os') === installOs ? 'true' : 'false');
    }
  }
  for (const button of document.querySelectorAll('.os-tabs [data-os]')) {
    button.addEventListener('click', () => showInstallOs(button.getAttribute('data-os')));
  }
  const copyInstall = document.getElementById('copy-install');
  const copyInstallFeedback = document.getElementById('copy-install-feedback');
  let copyInstallTimer = null;
  function markCopied() {
    if (!copyInstall) return;
    copyInstall.textContent = '已复制';
    if (copyInstallFeedback) {
      copyInstallFeedback.textContent = '已复制安装命令';
      copyInstallFeedback.hidden = false;
    }
    if (copyInstallTimer) clearTimeout(copyInstallTimer);
    copyInstallTimer = setTimeout(() => {
      copyInstall.textContent = '复制';
      if (copyInstallFeedback) {
        copyInstallFeedback.textContent = '';
        copyInstallFeedback.hidden = true;
      }
      copyInstallTimer = null;
    }, 2000);
  }
  if (copyInstall) {
    copyInstall.addEventListener('click', async () => {
      const unix = document.getElementById('install-unix');
      const windows = document.getElementById('install-windows');
      const text = ((installOs === 'windows' ? windows : unix) && (installOs === 'windows' ? windows : unix).textContent) || '';
      if (!text) return;
      try {
        if (!navigator.clipboard || !navigator.clipboard.writeText) {
          show('error', '这个浏览器不能复制到剪贴板，请手动复制命令。');
          return;
        }
        await navigator.clipboard.writeText(text);
        markCopied();
        show('ok', '已复制安装命令。');
      } catch {
        show('error', '无法复制，请手动复制命令。');
      }
    });
  }

  document.getElementById('key-form').addEventListener('submit', async event => {
    event.preventDefault();
    const values = readKeyForm(event.currentTarget);
    if (!canIssueKey(values.name)) {
      syncGenerateButton();
      show('error', '请填写密钥名称。');
      return;
    }
    const result = await request('POST', '/v1/runtime-keys', values);
    if (result.status !== 201) {
      show('error', messageFor(result.body.error, '无法生成密钥。'));
      return;
    }
    const box = document.getElementById('issued-token');
    box.hidden = false;
    box.textContent = result.body.token
      ? `密钥只显示一次：${result.body.token}`
      : '已生成密钥，但响应里没有令牌。';
    event.currentTarget.reset();
    syncGenerateButton();
    show('ok', '已生成密钥。完整密钥只显示这一次，列表只保留前缀。');
    await loadKeys();
  });

  const taskForm = document.getElementById('task-form');
  if (taskForm) {
    taskForm.addEventListener('submit', async event => {
      event.preventDefault();
      const values = readTestTask(event.currentTarget);
      if (!values.prompt) {
        show('error', '请填写测试内容。');
        return;
      }
      const result = await request('POST', '/v1/runtime/tasks', values);
      if (result.status !== 201) {
        show('error', messageFor(result.body.error, '无法发送任务。需要先启动守护进程。'));
        return;
      }
      const box = document.getElementById('task-result');
      box.hidden = false;
      box.textContent = '已排队，等待这台机器上的守护进程回传结果。下方「最近任务」会显示状态。';
      show('ok', '已发送测试任务。');
      event.currentTarget.reset();
      await loadTasks();
    });
  }

  document.getElementById('logout-form').addEventListener('submit', async event => {
    event.preventDefault();
    const result = await request('POST', '/v1/auth/logout', {});
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '退出失败。'));
      return;
    }
    await load();
  });

  return load();
}

if (globalThis.document && globalThis.document.getElementById('key-form')) {
  mount(globalThis.document);
}
