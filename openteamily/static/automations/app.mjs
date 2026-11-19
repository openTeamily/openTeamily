export function csrfCookie(source) {
  const match = /(?:^|;\s*)(?:__Host-ot_csrf|ot_dev_csrf)=([^;]+)/.exec(source || '');
  return match ? decodeURIComponent(match[1]) : '';
}

export function namesFromList(value) {
  if (!value || !String(value).trim()) return [];
  const seen = new Set();
  const names = [];
  for (const part of String(value).split(',')) {
    const name = part.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

export function scheduleFromForm(data) {
  const kind = data.get('kind') || 'now';
  const time_zone = data.get('time_zone') || 'Asia/Shanghai';
  if (kind === 'now') return {kind, time_zone};
  const schedule = {kind: kind === 'later' ? 'once' : kind, time: data.get('time') || '09:00', time_zone};
  if (kind === 'later') schedule.date = data.get('date') || '';
  if (kind === 'weekly') schedule.weekday = Number(data.get('weekday') || 1);
  if (kind === 'monthly') schedule.day = Number(data.get('day') || 1);
  return schedule;
}

export function readEditor(form) {
  const data = new FormData(form);
  return {
    title: (data.get('title') || '').trim(),
    template_id: data.get('template_id') || 'custom',
    intent: (data.get('intent') || '').trim(),
    scope: data.get('scope') || 'once',
    participants: namesFromList(data.get('participants')),
    agents: namesFromList(data.get('agents')),
    schedule: scheduleFromForm(data),
    prompt: data.get('prompt') || '',
    enabled: data.has('enabled'),
  };
}

export function tabCategory(value) {
  return value === 'work' || value === 'life' || value === 'mine' ? value : 'mine';
}

export function runStatusLabel(run) {
  if (!run) return '';
  if (run.status === 'succeeded') return '已完成';
  if (run.status === 'queued' && run.error_code === 'no_agent') return '等待已连接的代理';
  if (run.status === 'queued') return '运行中';
  if (run.status === 'cancelled') return '已取消';
  if (run.status === 'timeout') return '已超时';
  if (run.status === 'skipped') return '已跳过';
  if (run.status === 'failed') return '失败';
  return run.status || '';
}

export function runResultText(run) {
  if (run && run.result && typeof run.result.text === 'string') return run.result.text;
  return '';
}

// The two destructive controls on this page ask before they act. The wording is
// a pure function so it can be asserted without a DOM; it stays generic on
// purpose and never echoes a user-supplied title, which could make the question
// look like a different action.
export function deletePrompt(item) {
  return {question: '删除这条自动化？', confirmLabel: '确认'};
}

export function cancellationPrompt(run) {
  return {question: '取消这次运行？', confirmLabel: '确认取消'};
}


// `/automations?template=<id>` opens the editor prefilled from that template
// (used by the chat composer's 自动化 shortcuts).
export function templateFromSearch(search) {
  const value = new URLSearchParams(search || '').get('template') || '';
  return /^[a-z0-9_-]{1,64}$/.test(value) ? value : '';
}

export function catalogItems(templates, category, search) {
  const tab = tabCategory(category);
  if (tab !== 'work' && tab !== 'life') return [];
  const needle = (search || '').trim().toLowerCase();
  return (templates || []).filter(item => {
    if (!item || item.category !== tab) return false;
    if (!needle) return true;
    const hay = `${item.title || ''} ${item.prompt || ''}`.toLowerCase();
    return hay.includes(needle);
  });
}

export function draftFromTemplate(template, username) {
  const draft = {
    template_id: template && template.id ? template.id : 'custom',
    title: (template && template.title) || '',
    prompt: (template && template.prompt) || '',
    intent: '',
    scope: 'once',
    schedule: {kind: 'now', time_zone: 'Asia/Shanghai'},
    participants: username ? [username] : [],
    agents: [],
    enabled: false,
  };
  // Only 每日工作简报 had recorded defaults: 意图=监测, 时间=立即运行, 范围=单次.
  if (draft.template_id === 'daily_brief') draft.intent = 'monitor';
  return draft;
}

export function listQuery(category, search) {
  const params = new URLSearchParams();
  const tab = tabCategory(category);
  if (tab) params.set('category', tab);
  const needle = (search || '').trim();
  if (needle) params.set('q', needle);
  const text = params.toString();
  return text ? '?' + text : '';
}

function messageFor(error, fallback) {
  if (error && error.message) return error.message;
  return fallback;
}

function idempotencyKey() {
  const bytes = new Uint8Array(18);
  globalThis.crypto.getRandomValues(bytes);
  let text = '';
  for (const value of bytes) text += String.fromCharCode(value);
  return globalThis.btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function kindOf(schedule) {
  if (!schedule || !schedule.kind) return 'now';
  return schedule.kind === 'once' ? 'later' : schedule.kind;
}

const WEEKDAY_NAMES = ['一', '二', '三', '四', '五', '六', '日'];

function clampNumber(value, low, high, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.trunc(number), low), high);
}

// The list row says the same thing as the editor radios, and never leaks the
// stored kind (`now`, `once`, `daily`, ...) to the reader.
export function scheduleSummary(schedule, enabled) {
  const state = enabled ? '已启用' : '未启用';
  const kind = schedule && schedule.kind ? schedule.kind : 'now';
  const zone = (schedule && schedule.time_zone) || 'Asia/Shanghai';
  const time = (schedule && schedule.time) || '09:00';
  if (kind === 'now') return `立即运行 · ${state}`;
  if (kind === 'once' || kind === 'later') {
    const date = schedule && schedule.date ? `${schedule.date} ` : '';
    return `单次 ${date}${time}（${zone}）· ${state}`;
  }
  if (kind === 'daily') return `每天 ${time}（${zone}）· ${state}`;
  if (kind === 'weekdays') return `工作日 ${time}（${zone}）· ${state}`;
  if (kind === 'weekly') {
    const weekday = WEEKDAY_NAMES[clampNumber(schedule && schedule.weekday, 1, 7, 1) - 1];
    return `每周${weekday} ${time}（${zone}）· ${state}`;
  }
  if (kind === 'monthly') {
    const day = clampNumber(schedule && schedule.day, 1, 31, 1);
    return `每月 ${day} 日 ${time}（${zone}）· ${state}`;
  }
  return `已安排 · ${state}`;
}

function fillEditor(form, item, templates, username) {
  const schedule = (item && item.schedule) || {kind: 'now', time_zone: 'Asia/Shanghai'};
  const kind = kindOf(schedule);
  form.elements.template_id.value = (item && item.template_id) || 'custom';
  form.elements.intent.value = (item && item.intent) || '';
  form.elements.scope.value = (item && item.scope) || 'once';
  form.elements.participants.value = item && item.participants
    ? item.participants.map(row => row.username || row).join(', ')
    : (username || '');
  form.elements.agents.value = item && item.agents ? item.agents.join(', ') : '';
  for (const option of form.querySelectorAll('[name="kind"]')) {
    option.checked = option.value === kind;
  }
  form.elements.date.value = schedule.date || '';
  form.elements.time.value = schedule.time || '09:00';
  form.elements.weekday.value = String(schedule.weekday || 1);
  form.elements.day.value = String(schedule.day || 1);
  form.elements.time_zone.value = schedule.time_zone || 'Asia/Shanghai';
  form.elements.prompt.value = (item && item.prompt) || '';
  form.elements.enabled.checked = Boolean(item && item.enabled);
  form.elements.title.value = (item && item.title) || (templates.find(row => row.id === form.elements.template_id.value) || {}).title || '';
}


function setBusy(node, busy) {
  if (!node) return;
  if (busy) {
    if (typeof node.setAttribute === 'function') node.setAttribute('aria-busy', 'true');
    return;
  }
  if (typeof node.removeAttribute === 'function') node.removeAttribute('aria-busy');
}

function monogram(name) {
  const text = String(name || '').trim();
  const chars = Array.from(text);
  const label = (chars.slice(0, chars[0] && /[A-Za-z]/.test(chars[0]) ? 2 : 1).join('') || '?');
  let tone = 0;
  for (const ch of chars) tone += ch.codePointAt(0) || 0;
  return {label, tone: (tone % 6) + 1};
}

function renderList(items, list, empty, onOpen) {
  list.textContent = '';
  list.classList.remove('template-catalog');
  setBusy(list, false);
  empty.hidden = items.length > 0;
  for (const item of items) {
    const row = document.createElement('li');
    const mark = monogram(item.title);
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.dataset.tone = String(mark.tone);
    avatar.textContent = mark.label;
    const copy = document.createElement('div');
    copy.className = 'item-meta';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'link';
    open.textContent = item.title;
    open.addEventListener('click', () => onOpen(item));
    const meta = document.createElement('span');
    meta.className = 'item-schedule';
    meta.textContent = scheduleSummary(item.schedule, item.enabled);
    copy.appendChild(open);
    copy.appendChild(meta);
    const state = document.createElement('span');
    state.className = 'status-pill' + (item.enabled ? ' is-on' : '');
    state.textContent = item.enabled ? '已启用' : '未启用';
    row.appendChild(avatar);
    row.appendChild(copy);
    row.appendChild(state);
    list.appendChild(row);
  }
}


function renderCatalog(items, list, empty, onOpen) {
  list.textContent = '';
  list.classList.add('template-catalog');
  setBusy(list, false);
  empty.hidden = items.length > 0;
  for (const item of items) {
    const row = document.createElement('li');
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'catalog-card';
    const title = document.createElement('strong');
    title.textContent = item.title || '';
    const summary = document.createElement('span');
    summary.className = 'note';
    summary.textContent = item.prompt || '';
    open.appendChild(title);
    open.appendChild(summary);
    open.addEventListener('click', () => onOpen(item));
    row.appendChild(open);
    list.appendChild(row);
  }
}

export function mount(document, {fetcher = globalThis.fetch.bind(globalThis)} = {}) {
  const status = document.getElementById('status');
  const loginPanel = document.getElementById('login-panel');
  const mainPanel = document.getElementById('main-panel');
  const form = document.getElementById('editor-form');
  const listPanel = document.getElementById('list-panel');
  const workspaceSelect = document.getElementById('workspace');
  const search = document.getElementById('search');
  let currentUser = null;
  let workspaces = [];
  let templates = [];
  let current = null;
  let category = 'mine';
  let runTimer = 0;

  function show(kind, text) {
    status.dataset.kind = kind;
    status.textContent = text;
  }

  async function request(method, path, body, extraHeaders) {
    const headers = {'Accept': 'application/json', 'X-CSRF-Token': csrfCookie(document.cookie)};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (extraHeaders) Object.assign(headers, extraHeaders);
    const response = await fetcher(path, {
      method, headers, credentials: 'same-origin',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let parsed = {};
    try { parsed = await response.json(); } catch { parsed = {}; }
    return {status: response.status, body: parsed};
  }

  function workspaceId() {
    return workspaceSelect.value;
  }

  let pendingConfirm = null;
  let confirmSerial = 0;

  function closeConfirm({restoreFocus = true} = {}) {
    if (!pendingConfirm) return;
    const {box, trigger} = pendingConfirm;
    pendingConfirm = null;
    if (box && box.parentNode) box.parentNode.removeChild(box);
    if (trigger) {
      trigger.hidden = false;
      if (restoreFocus && typeof trigger.focus === 'function') trigger.focus();
    }
  }

  function openConfirm({parent, trigger, prompt, action}) {
    closeConfirm();
    const questionId = 'automation-confirm-question-' + (++confirmSerial);
    const box = document.createElement('span');
    box.className = 'row-confirm';
    box.setAttribute('role', 'alertdialog');
    box.setAttribute('aria-labelledby', questionId);
    const question = document.createElement('span');
    question.id = questionId;
    question.textContent = prompt.question;
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = '取消';
    cancel.dataset.confirmAction = 'cancel';
    cancel.addEventListener('click', () => closeConfirm());
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.textContent = prompt.confirmLabel;
    confirm.dataset.confirmAction = 'ok';
    confirm.addEventListener('click', () => {
      const run = action;
      closeConfirm();
      run();
    });
    box.appendChild(question);
    box.appendChild(cancel);
    box.appendChild(confirm);
    trigger.hidden = true;
    parent.appendChild(box);
    pendingConfirm = {box, trigger, action};
    if (typeof cancel.focus === 'function') cancel.focus();
  }

  // One question at a time; Esc is the keyboard way out and never acts.
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !pendingConfirm) return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    closeConfirm();
  });

  function stopRunPoll() {
    if (runTimer) {
      globalThis.clearInterval(runTimer);
      runTimer = 0;
    }
  }

  function renderRuns(items) {
    const list = document.getElementById('run-list');
    const empty = document.getElementById('run-empty');
    const panel = document.getElementById('run-panel');
    if (!list || !panel) return;
    panel.hidden = false;
    list.textContent = '';
    empty.hidden = items.length > 0;
    for (const item of items) {
      const row = document.createElement('li');
      const head = document.createElement('div');
      head.className = 'run-head';
      const status = document.createElement('strong');
      status.textContent = runStatusLabel(item);
      const pill = document.createElement('span');
      pill.className = 'status-pill' + (item.status === 'succeeded' ? ' is-on' : '');
      pill.textContent = item.status || '';
      const meta = document.createElement('span');
      meta.className = 'note';
      meta.textContent = item.error_code ? item.error_code : '';
      head.appendChild(status);
      head.appendChild(pill);
      head.appendChild(meta);
      if (item.status === 'queued' && current && current.id) {
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.textContent = '取消这次运行';
        cancel.addEventListener('click', () => {
          // The question is bound to the run it names: switching workspace or
          // automation later cannot retarget the request built from this snapshot.
          const target = {workspace: workspaceId(), automation: current.id, run: item.id};
          openConfirm({
            parent: head,
            trigger: cancel,
            prompt: cancellationPrompt(item),
            action: () => cancelRun(target),
          });
        });
        head.appendChild(cancel);
      }
      row.appendChild(head);
      const text = runResultText(item);
      if (text) {
        const pre = document.createElement('pre');
        pre.textContent = text;
        row.appendChild(pre);
        if (item.status === 'succeeded' && current && current.id) {
          const save = document.createElement('button');
          save.type = 'button';
          save.textContent = '保存到作品库';
          save.addEventListener('click', async () => {
            const result = await request('POST', `/v1/workspaces/${workspaceId()}/automations/${current.id}/runs/${item.id}/artifact`, {});
            if (result.status !== 200 && result.status !== 201) {
              show('error', messageFor(result.body.error, '保存到作品库失败。'));
              return;
            }
            show('ok', '已保存到作品库。');
          });
          row.appendChild(save);
        }
      }
      list.appendChild(row);
    }
  }

  async function cancelRun(target) {
    if (!target || !target.workspace || !target.automation || !target.run) return;
    const result = await request('POST', `/v1/workspaces/${target.workspace}/automations/${target.automation}/runs/${target.run}/cancel`, {});
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '取消失败。'));
      return;
    }
    show('ok', '已取消。');
    await loadRuns();
  }

  async function loadRuns() {
    const panel = document.getElementById('run-panel');
    if (!panel) return;
    if (!current || !current.id || !workspaceId()) {
      panel.hidden = true;
      stopRunPoll();
      return;
    }
    const listed = await request('GET', `/v1/workspaces/${workspaceId()}/automations/${current.id}/runs?limit=20`);
    if (listed.status !== 200) {
      show('error', messageFor(listed.body.error, '无法读取运行记录。'));
      return;
    }
    const items = listed.body.items || [];
    renderRuns(items);
    const pending = items.some(item => item.status === 'queued');
    if (pending && !runTimer) {
      runTimer = globalThis.setInterval(() => { loadRuns(); }, 3000);
    }
    if (!pending) stopRunPoll();
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

  function fillTemplates() {
    const select = form.elements.template_id;
    select.textContent = '';
    for (const item of templates) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.title;
      select.appendChild(option);
    }
  }

  function openEditor(item) {
    // A question belongs to the editor that raised it; entering another editor
    // drops the question instead of showing it again above a different item.
    closeConfirm({restoreFocus: false});
    current = item;
    listPanel.hidden = true;
    form.hidden = false;
    mainPanel.classList.add('is-editing');
    fillEditor(form, item, templates, currentUser && currentUser.username);
    document.getElementById('remove-automation').hidden = !item || !item.id;
    document.getElementById('tick-automation').hidden = !item || !item.id;
    loadRuns();
  }

  async function loadList() {
    const id = workspaceId();
    if (!id) return;
    const list = document.getElementById('automation-list');
    const empty = document.getElementById('list-empty');
    if (category === 'work' || category === 'life') {
      empty.textContent = '没有匹配的模板。';
      renderCatalog(
        catalogItems(templates, category, search.value),
        list,
        empty,
        item => openEditor(draftFromTemplate(item, currentUser && currentUser.username)),
      );
      return;
    }
    setBusy(list, true);
    list.textContent = '';
    empty.hidden = false;
    setBusy(empty, true);
    empty.textContent = '正在加载自动化…';
    const listed = await request('GET', `/v1/workspaces/${id}/automations${listQuery(category, search.value)}`);
    setBusy(empty, false);
    setBusy(list, false);
    if (listed.status !== 200) {
      empty.hidden = false;
      empty.textContent = messageFor(listed.body.error, '无法读取自动化列表。');
      show('error', messageFor(listed.body.error, '无法读取自动化列表。'));
      return;
    }
    empty.textContent = '这个分类下还没有自动化。';
    renderList(listed.body.items || [], list, empty, item => openEditor(item));
  }

  async function load() {
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
    const [space, catalog] = await Promise.all([
      request('GET', '/v1/workspaces?limit=100'),
      request('GET', '/v1/automation-templates'),
    ]);
    if (space.status !== 200) {
      show('error', messageFor(space.body.error, '无法读取工作区。'));
      return;
    }
    workspaces = space.body.items || [];
    templates = catalog.status === 200 ? (catalog.body.items || []) : [];
    fillTemplates();
    const previous = workspaceSelect.value;
    workspaceSelect.textContent = '';
    for (const item of workspaces) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.name;
      workspaceSelect.appendChild(option);
    }
    if (previous && [...workspaceSelect.options].some(option => option.value === previous)) {
      workspaceSelect.value = previous;
    }
    if (!workspaces.length) {
      document.getElementById('automation-list').textContent = '';
      document.getElementById('list-empty').hidden = false;
      document.getElementById('list-empty').textContent = '还没有工作区。';
      return;
    }
    document.getElementById('list-empty').textContent = '这个分类下还没有自动化。';
    form.hidden = true;
    listPanel.hidden = false;
    mainPanel.classList.remove('is-editing');
    await loadList();
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

  workspaceSelect.addEventListener('change', () => {
    closeConfirm({restoreFocus: false});
    loadList();
  });
  search.addEventListener('input', () => loadList());
  for (const tab of document.querySelectorAll('.tabs [data-category]')) {
    tab.addEventListener('click', async () => {
      category = tabCategory(tab.dataset.category);
      for (const button of document.querySelectorAll('.tabs [data-category]')) {
        button.setAttribute('aria-selected', button === tab ? 'true' : 'false');
      }
      form.hidden = true;
      listPanel.hidden = false;
      closeConfirm({restoreFocus: false});
      mainPanel.classList.remove('is-editing');
      const runPanel = document.getElementById('run-panel');
      if (runPanel) runPanel.hidden = true;
      stopRunPoll();
      await loadList();
    });
  }

  document.getElementById('new-automation').addEventListener('click', () => {
    const selected = (category === 'work' || category === 'life')
      ? templates.find(item => item.category === category)
      : null;
    openEditor(selected ? draftFromTemplate(selected, currentUser && currentUser.username) : null);
    form.elements.kind.value = form.elements.kind.value || 'now';
    const kind = (form.elements.kind.value) || 'now';
    for (const option of form.querySelectorAll('[name="kind"]')) option.checked = option.value === kind;
  });

  document.getElementById('cancel-editor').addEventListener('click', async () => {
    closeConfirm({restoreFocus: false});
    current = null;
    form.hidden = true;
    listPanel.hidden = false;
    mainPanel.classList.remove('is-editing');
    const runPanel = document.getElementById('run-panel');
    if (runPanel) runPanel.hidden = true;
    stopRunPoll();
    await loadList();
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const values = readEditor(form);
    if (!workspaceId()) {
      show('error', '先选择一个工作区。');
      return;
    }
    if (!values.title || !values.participants.length) {
      show('error', '请填写标题和至少一名参与成员。');
      return;
    }
    let result;
    if (current && current.id) {
      const changes = {
        title: values.title, prompt: values.prompt, schedule: values.schedule,
        participants: values.participants, enabled: values.enabled,
        intent: values.intent, scope: values.scope, agents: values.agents,
      };
      result = await request('POST', `/v1/workspaces/${workspaceId()}/automations/${current.id}`,
                             {revision: current.revision, changes});
    } else {
      result = await request('POST', `/v1/workspaces/${workspaceId()}/automations`, {
        title: values.title, prompt: values.prompt, template_id: values.template_id,
        schedule: values.schedule, participants: values.participants,
        intent: values.intent, scope: values.scope, agents: values.agents,
      }, {'Idempotency-Key': idempotencyKey()});
      if (result.status === 201 && values.enabled && result.body.automation) {
        const created = result.body.automation;
        result = await request('POST', `/v1/workspaces/${workspaceId()}/automations/${created.id}`,
                               {revision: created.revision, changes: {enabled: true}});
      }
    }
    if (result.status === 409) {
      show('error', '自动化已在别处更新，请重新打开后再保存。');
      await loadList();
      return;
    }
    if (result.status !== 200 && result.status !== 201) {
      show('error', messageFor(result.body.error, '保存失败。'));
      return;
    }
    current = result.body.automation;
    closeConfirm({restoreFocus: false});
    fillEditor(form, current, templates, currentUser && currentUser.username);
    document.getElementById('remove-automation').hidden = false;
    document.getElementById('tick-automation').hidden = false;
    show('ok', '已保存。若已启用，后台会在到期时运行。');
    await loadRuns();
  });

  document.getElementById('tick-automation').addEventListener('click', async () => {
    if (!workspaceId()) return;
    const result = await request('POST', `/v1/workspaces/${workspaceId()}/automations/tick`, {});
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '触发失败。'));
      return;
    }
    show('ok', '已请求触发一次。若已有在线代理，结果会出现在下方运行记录里。假提供方的输出不能当成真实模型已经验证。');
    await loadRuns();
  });

  const removeButton = document.getElementById('remove-automation');

  async function removeAutomation(target) {
    if (!target || !target.workspace || !target.automation) return;
    const result = await request('POST', `/v1/workspaces/${target.workspace}/automations/${target.automation}/remove`, {});
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '删除失败。'));
      return;
    }
    current = null;
    form.hidden = true;
    listPanel.hidden = false;
    mainPanel.classList.remove('is-editing');
    const runPanel = document.getElementById('run-panel');
    if (runPanel) runPanel.hidden = true;
    stopRunPoll();
    show('ok', '已删除。');
    await loadList();
  }

  removeButton.addEventListener('click', () => {
    if (!current || !current.id || !workspaceId()) return;
    // Bind the question to the automation and workspace it names right now.
    const target = {workspace: workspaceId(), automation: current.id};
    openConfirm({
      parent: removeButton.parentNode || form,
      trigger: removeButton,
      prompt: deletePrompt(current),
      action: () => removeAutomation(target),
    });
  });

  document.getElementById('logout-form').addEventListener('submit', async event => {
    event.preventDefault();
    const result = await request('POST', '/v1/auth/logout', {});
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '退出失败。'));
      return;
    }
    closeConfirm({restoreFocus: false});
    current = null;
    stopRunPoll();
    await load();
  });

  return load().then(() => {
    const view = document.defaultView;
    const wanted = templateFromSearch(view && view.location && view.location.search);
    if (!wanted || mainPanel.hidden || !workspaceId()) return;
    const template = templates.find(item => item.id === wanted);
    if (!template) return;
    openEditor(draftFromTemplate(template, currentUser && currentUser.username));
  });
}

if (globalThis.document && globalThis.document.getElementById('editor-form')) {
  mount(globalThis.document);
}
