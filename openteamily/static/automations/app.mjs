import { readWorkspaceChoices } from '../shell/dsbot-api.mjs';
import { spaceHref } from '../shell/thumb.mjs';

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

// A run that ended can be asked for again; a queued run is cancelled instead,
// and a finished success has nothing to re-run.
export function retryAllowed(run) {
  if (!run) return false;
  return run.status === 'failed' || run.status === 'cancelled' || run.status === 'timeout';
}

export function runResultText(run) {
  if (run && run.result && typeof run.result.text === 'string') return run.result.text;
  return '';
}

// A run row opens in place. The server already returns the status, the error
// code and a whitelisted result (automations.py run_view), so this page only
// has to name them; a run that left nothing says so instead of showing a blank.
export const RUN_DETAIL_EMPTY = '这次运行没有留下输出';

const RUN_ERROR_REASONS = Object.freeze({
  cancelled: '这次运行被取消了。',
  timeout: '这次运行超时，没有在时限内完成。',
  no_agent: '当前没有已连接的代理，运行还在排队。',
  provider_error: '模型提供方这次没有返回结果。',
  model_unconfigured: '这个运行时缺少模型 API 配置。',
  rate_limited: '被服务方限流，这次运行没有跑完。',
  forbidden: '当前工作区没有权限完成这次运行。',
  invalid: '这次运行的请求没有被接受，没有执行。',
});

export function runErrorReason(run) {
  if (!run) return '';
  const explicit = run.result && typeof run.result.error === 'string' ? run.result.error.trim() : '';
  if (explicit) return explicit;
  const code = typeof run.error_code === 'string' ? run.error_code : '';
  if (code && RUN_ERROR_REASONS[code]) return RUN_ERROR_REASONS[code];
  if (code) return `服务端只留下错误代码：${code}`;
  if (run.status === 'failed' || run.status === 'timeout' || run.status === 'cancelled') {
    return '这次运行没有成功，服务端也没有留下原因。';
  }
  return '';
}

export function runDetailFields(run) {
  const fields = [];
  if (!run) return fields;
  const text = runResultText(run);
  if (text) fields.push({label: '摘要', value: text});
  const code = typeof run.error_code === 'string' ? run.error_code : '';
  const reason = runErrorReason(run);
  if (code) fields.push({label: '状态码', value: code});
  if (reason) fields.push({label: '失败原因', value: reason});
  const result = run.result || {};
  if (typeof result.model === 'string' && result.model) fields.push({label: '模型', value: result.model});
  if (typeof result.source === 'string' && result.source) fields.push({label: '来源', value: result.source});
  const dispatch = run.dispatch || {};
  if (typeof dispatch.backend === 'string' && dispatch.backend) fields.push({label: '执行位置', value: dispatch.backend});
  if (typeof dispatch.task_id === 'string' && dispatch.task_id) fields.push({label: '任务', value: dispatch.task_id});
  return fields;
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

// `/automations?runs=failed` keeps the run-history filter across refresh,
// back/forward and sharing. One recorded value at a time; anything else is 全部.
export const RUN_FILTERS = Object.freeze(['all', 'succeeded', 'failed']);

export function runFilterFromSearch(search) {
  const value = new URLSearchParams(search || '').get('runs') || '';
  return value === 'succeeded' || value === 'failed' ? value : 'all';
}

export function runFilterSearchText(filter) {
  return filter === 'succeeded' || filter === 'failed' ? `?runs=${filter}` : '';
}

// The server filters on the stored status, and run_view reports cancelled and
// timed-out runs as their own status. 失败 therefore names all three, so the
// mirror here can never hide a row the server sent back for status=failed.
export function matchesRunFilter(item, filter) {
  if (filter === 'succeeded') return item.status === 'succeeded';
  if (filter === 'failed') return item.status === 'failed' || item.status === 'cancelled' || item.status === 'timeout';
  return true;
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

// The list row says the same thing as the schedule picker, and never leaks the
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

function fillEditor(form, item, username) {
  const schedule = (item && item.schedule) || {kind: 'now', time_zone: 'Asia/Shanghai'};
  const kind = kindOf(schedule);
  form.elements.template_id.value = (item && item.template_id) || 'custom';
  form.elements.intent.value = (item && item.intent) || '';
  form.elements.scope.value = (item && item.scope) || 'once';
  form.elements.participants.value = item && item.participants
    ? item.participants.map(row => row.username || row).join(', ')
    : (username || '');
  form.elements.agents.value = item && item.agents ? item.agents.join(', ') : '';
  form.elements.kind.value = kind;
  form.elements.date.value = schedule.date || '';
  form.elements.time.value = schedule.time || '09:00';
  form.elements.weekday.value = String(schedule.weekday || 1);
  form.elements.day.value = String(schedule.day || 1);
  form.elements.time_zone.value = schedule.time_zone || 'Asia/Shanghai';
  form.elements.prompt.value = (item && item.prompt) || '';
  form.elements.enabled.checked = Boolean(item && item.enabled);
  form.elements.title.value = item?.title || '';
  syncScheduleFields(form);
}

function syncScheduleFields(form) {
  const kind = form.elements.kind.value;
  for (const field of form.querySelectorAll('[data-schedule-kind]')) {
    const fieldKind = field.dataset.scheduleKind;
    field.hidden = fieldKind !== kind && !(fieldKind === 'timed' && kind !== 'now');
  }
  form.elements.date.required = kind === 'later';
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
  const runButton = document.getElementById('tick-automation');
  const runHistoryButton = document.getElementById('show-run-history');
  const runPanel = document.getElementById('run-panel');
  const runHeading = document.getElementById('run-heading');
  const runPages = document.getElementById('run-pages');
  const runNewer = document.getElementById('run-newer');
  const runOlder = document.getElementById('run-older');
  const newButton = document.getElementById('new-automation');
  const saveButton = document.getElementById('save-automation');
  const backButton = document.getElementById('cancel-editor');
  const tabs = document.querySelectorAll('.tabs [data-category]');
  const workspaceStatus = document.getElementById('workspace-status');
  let currentUser = null;
  let loadRequest = 0;
  let templates = [];
  let templateState = 'loading';
  let current = null;
  let draftSave = null;
  let category = 'mine';
  let runTimer = 0;
  let runRequest = 0;
  let listRequest = 0;
  let recentRuns = [];
  let runCursors = [''];
  let nextRunCursor = '';
  let activeRun = false;
  const savedRunResults = new Map();
  const savingRunResults = new Set();
  const manualKeys = new Map();
  const manualPending = new Set();
  const view = document.defaultView;
  const readSearch = () => (view && view.location && view.location.search) || '';
  let runFilter = runFilterFromSearch(readSearch());
  // Which rows the reader opened. Kept outside the render so the 3s poll and
  // the filter switches do not close a row under the reader.
  const expandedRuns = new Set();

  function pushRunFilter(filter) {
    const text = runFilterSearchText(filter);
    if (!view || !view.history || !view.location) return;
    if ((view.location.search || '') === text) return;
    const base = view.location.pathname || '/automations';
    view.history.pushState({runs: filter}, '', text ? base + text : base);
  }

  const RUN_FILTER_BUTTONS = {all: 'run-filter-all', succeeded: 'run-filter-succeeded', failed: 'run-filter-failed'};

  function syncRunFilters() {
    for (const [name, id] of Object.entries(RUN_FILTER_BUTTONS)) {
      const button = document.getElementById(id);
      if (button) button.setAttribute('aria-current', name === runFilter ? 'true' : 'false');
    }
  }

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
      globalThis.clearTimeout(runTimer);
      runTimer = 0;
    }
  }

  function resetRunPages() {
    runCursors = [''];
    nextRunCursor = '';
    if (runPages) runPages.hidden = true;
  }

  function setRunPageControls(loading = false) {
    if (runPages) runPages.hidden = !nextRunCursor && runCursors.length === 1;
    if (runNewer) runNewer.disabled = loading || runCursors.length === 1;
    if (runOlder) runOlder.disabled = loading || !nextRunCursor;
  }

  function showRunHistory() {
    runPanel?.scrollIntoView({block: 'start'});
    runHeading?.focus({preventScroll: true});
  }

  async function saveRunResult(button, item, target) {
    if (savingRunResults.has(item.id)) return;
    savingRunResults.add(item.id);
    button.disabled = true;
    button.textContent = '保存中…';
    const sameEditor = () => current?.id === target.automation && workspaceId() === target.workspace && !form.hidden;
    try {
      const result = await request('POST',
        `/v1/workspaces/${target.workspace}/automations/${target.automation}/runs/${item.id}/artifact`, {});
      const artifact = result.body.artifact?.id;
      if (![200, 201].includes(result.status) || !/^[0-9a-f]{32}$/.test(artifact || '')) {
        if (sameEditor()) show('error', messageFor(result.body.error, '保存到作品库失败。'));
        return;
      }
      savedRunResults.set(item.id, artifact);
      if (sameEditor()) {
        show('ok', '已保存到作品库。');
        if (!button.isConnected) {
          renderRuns(recentRuns);
          return;
        }
        const link = document.createElement('a');
        link.href = spaceHref(target.workspace, artifact);
        link.className = 'run-work-link';
        link.textContent = '打开作品';
        button.insertAdjacentElement('afterend', link);
        button.hidden = true;
        link.focus();
      }
    } catch {
      if (sameEditor()) show('error', '暂时无法确认是否已保存，可以重试。');
    } finally {
      savingRunResults.delete(item.id);
      if (sameEditor() && !button.isConnected && !savedRunResults.has(item.id)) renderRuns(recentRuns);
      button.disabled = false;
      button.textContent = '保存到作品库';
    }
  }

  function renderRuns(items) {
    const list = document.getElementById('run-list');
    const empty = document.getElementById('run-empty');
    const panel = document.getElementById('run-panel');
    if (!list || !panel) return;
    recentRuns = items;
    panel.hidden = false;
    list.textContent = '';
    const visible = items.filter(item => matchesRunFilter(item, runFilter));
    const filtering = runFilter !== 'all';
    empty.hidden = items.length > 0 || filtering;
    const filterEmpty = document.getElementById('run-filter-empty');
    if (filterEmpty) filterEmpty.hidden = !(filtering && visible.length === 0);
    for (const item of visible) {
      const row = document.createElement('li');
      row.className = 'run-row';
      const head = document.createElement('div');
      head.className = 'run-head';
      // The whole head is the toggle, so one click opens exactly one run.
      // Opening never fetches: the payload already carries what the detail shows.
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'run-toggle';
      const open = expandedRuns.has(item.id);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      const when = document.createElement('strong');
      when.textContent = item.started ? new Date(item.started * 1000).toLocaleString('zh-CN', {
        month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
      }) : '运行';
      const pill = document.createElement('span');
      pill.className = 'status-pill' + (item.status === 'succeeded' ? ' is-on' : '');
      pill.dataset.status = item.status || '';
      pill.textContent = runStatusLabel(item);
      toggle.appendChild(when);
      toggle.appendChild(pill);
      const detail = document.createElement('div');
      detail.className = 'run-detail';
      detail.hidden = !open;
      const fields = runDetailFields(item);
      if (fields.length) {
        const terms = document.createElement('dl');
        for (const field of fields) {
          const term = document.createElement('dt');
          term.textContent = field.label;
          const value = document.createElement('dd');
          value.textContent = field.value;
          terms.appendChild(term);
          terms.appendChild(value);
        }
        detail.appendChild(terms);
      } else {
        const note = document.createElement('p');
        note.className = 'note';
        note.textContent = RUN_DETAIL_EMPTY;
        detail.appendChild(note);
      }
      if (item.status === 'succeeded' && runResultText(item).trim() && current?.id) {
        const target = {workspace: workspaceId(), automation: current.id};
        const artifact = savedRunResults.get(item.id);
        const action = document.createElement(artifact ? 'a' : 'button');
        if (artifact) {
          action.href = spaceHref(target.workspace, artifact);
          action.className = 'run-work-link';
          action.textContent = '打开作品';
        } else {
          action.type = 'button';
          action.disabled = savingRunResults.has(item.id);
          action.textContent = action.disabled ? '保存中…' : '保存到作品库';
          action.addEventListener('click', () => saveRunResult(action, item, target));
        }
        detail.appendChild(action);
      }
      if (item.error_code === 'model_unconfigured') {
        const settings = document.createElement('a');
        settings.href = '/settings#model-api';
        settings.className = 'run-work-link';
        settings.textContent = '配置模型 API';
        detail.appendChild(settings);
      }
      toggle.addEventListener('click', () => {
        const next = !expandedRuns.has(item.id);
        if (next) expandedRuns.add(item.id);
        else expandedRuns.delete(item.id);
        detail.hidden = !next;
        toggle.setAttribute('aria-expanded', next ? 'true' : 'false');
      });
      head.appendChild(toggle);
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
      if (retryAllowed(item) && current && current.id) {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.textContent = '重新运行';
        retry.addEventListener('click', () => {
          // Bound to this run snapshot: retrying after switching automation
          // cannot retarget someone else's run.
          retryRun({workspace: workspaceId(), automation: current.id, run: item.id});
        });
        head.appendChild(retry);
      }
      row.appendChild(head);
      row.appendChild(detail);
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

  // A double click has to reuse one idempotency key, otherwise the server
  // queues the automation twice. The key is dropped once a retry lands, so a
  // deliberate later retry of the same run is a new attempt.
  const retryKeys = new Map();

  function retryKeyFor(runId) {
    if (!retryKeys.has(runId)) retryKeys.set(runId, idempotencyKey());
    return retryKeys.get(runId);
  }

  async function retryRun(target) {
    if (!target || !target.workspace || !target.automation || !target.run) return;
    const result = await request(
      'POST',
      `/v1/workspaces/${target.workspace}/automations/${target.automation}/runs/${target.run}/retry`,
      {}, {'Idempotency-Key': retryKeyFor(target.run)},
    );
    if (result.status !== 200 && result.status !== 201) {
      show('error', messageFor(result.body.error, '重新运行失败。'));
      return;
    }
    retryKeys.delete(target.run);
    show('ok', '已重新排队。');
    await loadRuns();
  }

  function scheduleRunPoll(pending) {
    if (!pending && !current?.enabled) return;
    runTimer = globalThis.setTimeout(() => {
      runTimer = 0;
      void loadRuns();
    }, pending ? 3000 : 12000);
  }

  async function loadRuns({cursors = runCursors, focus = false} = {}) {
    stopRunPoll();
    const panel = document.getElementById('run-panel');
    if (!panel) return;
    if (!current || !current.id || !workspaceId()) {
      panel.hidden = true;
      return;
    }
    const workspace = workspaceId(), automation = current.id;
    const seq = ++runRequest;
    const wanted = runFilter === 'all' ? '' : `&status=${runFilter}`;
    const cursor = cursors.at(-1);
    setRunPageControls(true);
    const listed = await request('GET', `/v1/workspaces/${workspace}/automations/${automation}/runs?limit=20${wanted}${cursor ? '&cursor=' + cursor : ''}`)
      .catch(() => ({status: 0, body: {}}));
    if (seq !== runRequest || workspaceId() !== workspace || current?.id !== automation || form.hidden) return;
    if (listed.status !== 200) {
      setRunPageControls();
      show('error', messageFor(listed.body.error, '无法读取运行记录。'));
      scheduleRunPoll(activeRun);
      return;
    }
    const items = listed.body.items || [];
    runCursors = cursors;
    nextRunCursor = /^[0-9a-f]{32}$/.test(listed.body.cursor || '') ? listed.body.cursor : '';
    setRunPageControls();
    renderRuns(items);
    if (focus) showRunHistory();
    activeRun = listed.body.has_pending === true || items.some(item => item.status === 'queued');
    runButton.disabled = activeRun || manualPending.has(automation);
    runButton.textContent = activeRun ? '运行中…' : '运行一次';
    scheduleRunPoll(activeRun);
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
    const selected = select.value;
    select.textContent = '';
    const available = templates.some(item => item.id === 'custom')
      ? templates : [{id: 'custom', title: '自定义'}, ...templates];
    for (const item of available) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.title;
      select.appendChild(option);
    }
    if (available.some(item => item.id === selected)) select.value = selected;
  }

  async function loadTemplates(seq) {
    templateState = 'loading';
    const catalog = await request('GET', '/v1/automation-templates').catch(() => ({status: 0}));
    if (seq !== loadRequest) return;
    templateState = catalog.status === 200 ? 'ready' : 'failed';
    templates = catalog.status === 200 ? (catalog.body.items || []) : [];
    fillTemplates();
    if (category !== 'mine' && !listPanel.hidden) await loadList();
  }

  function openEditor(item) {
    // A question belongs to the editor that raised it; entering another editor
    // drops the question instead of showing it again above a different item.
    closeConfirm({restoreFocus: false});
    current = item;
    draftSave = null;
    recentRuns = [];
    activeRun = false;
    resetRunPages();
    if (runHistoryButton) runHistoryButton.hidden = !item?.id;
    stopRunPoll();
    listPanel.hidden = true;
    form.hidden = false;
    mainPanel.classList.add('is-editing');
    fillEditor(form, item, currentUser && currentUser.username);
    form.elements.template_id.disabled = Boolean(item?.id);
    const heading = document.getElementById('editor-heading');
    if (heading) heading.textContent = item?.id ? item.title : '新建自动化';
    document.getElementById('remove-automation').hidden = !item || !item.id;
    runButton.hidden = !item?.id;
    runButton.disabled = Boolean(item?.id && manualPending.has(item.id));
    runButton.textContent = '运行一次';
    loadRuns();
  }

  function selectCategory(value) {
    category = value;
    for (const tab of tabs) {
      tab.setAttribute('aria-selected', tab.dataset.category === category ? 'true' : 'false');
    }
  }

  async function loadList() {
    const id = workspaceId();
    if (!id) return;
    const seq = ++listRequest;
    const list = document.getElementById('automation-list');
    const empty = document.getElementById('list-empty');
    if (category === 'work' || category === 'life') {
      empty.textContent = {
        loading: '正在加载模板…', failed: '无法加载模板。', ready: '没有匹配的模板。',
      }[templateState];
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
    if (seq !== listRequest || workspaceId() !== id) return;
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

  function fillWorkspaces(items) {
    const previous = workspaceId();
    workspaceSelect.textContent = '';
    for (const item of items) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.name;
      workspaceSelect.appendChild(option);
    }
    if (items.some(item => item.id === previous)) workspaceSelect.value = previous;
  }

  async function load() {
    const seq = ++loadRequest;
    newButton.disabled = true;
    workspaceStatus.textContent = '';
    const session = await request('GET', '/v1/auth/session');
    if (seq !== loadRequest) return;
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
    const catalog = loadTemplates(seq);
    const {initial: space, supplemental} = await readWorkspaceChoices(request, '/v1/workspaces?limit=100');
    if (seq !== loadRequest) return;
    if (space.status !== 200) {
      show('error', messageFor(space.body.error, '无法读取工作区。'));
      return catalog;
    }
    const items = space.body.items || [];
    fillWorkspaces(items);
    if (!items.length) {
      document.getElementById('automation-list').textContent = '';
      document.getElementById('list-empty').hidden = false;
      document.getElementById('list-empty').textContent = '还没有工作区。';
      return catalog;
    }
    newButton.disabled = false;
    document.getElementById('list-empty').textContent = '这个分类下还没有自动化。';
    form.hidden = true;
    listPanel.hidden = false;
    mainPanel.classList.remove('is-editing');
    void supplemental?.then(result => {
      if (seq !== loadRequest) return;
      if (result.status === 200) fillWorkspaces(result.body.items);
      else workspaceStatus.textContent = '团队工作区暂时无法加载。';
    });
    await Promise.all([loadList(), catalog]);
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
  runHistoryButton?.addEventListener('click', () => {
    if (runPanel?.hidden) void loadRuns({focus: true});
    else showRunHistory();
  });
  runNewer?.addEventListener('click', () => {
    if (runCursors.length > 1) void loadRuns({cursors: runCursors.slice(0, -1), focus: true});
  });
  runOlder?.addEventListener('click', () => {
    if (nextRunCursor) void loadRuns({cursors: [...runCursors, nextRunCursor], focus: true});
  });
  syncRunFilters();
  for (const [filter, id] of Object.entries(RUN_FILTER_BUTTONS)) {
    const button = document.getElementById(id);
    if (!button) continue;
    button.addEventListener('click', async () => {
      if (filter === runFilter) return;
      runFilter = filter;
      resetRunPages();
      syncRunFilters();
      pushRunFilter(filter);
      await loadRuns();
    });
  }
  if (view && typeof view.addEventListener === 'function') {
    view.addEventListener('popstate', () => {
      const wanted = runFilterFromSearch(readSearch());
      if (wanted === runFilter) return;
      runFilter = wanted;
      resetRunPages();
      syncRunFilters();
      loadRuns();
    });
  }
  for (const tab of tabs) {
    tab.addEventListener('click', async () => {
      selectCategory(tabCategory(tab.dataset.category));
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

  newButton.addEventListener('click', () => {
    openEditor(null);
  });
  form.elements.kind.addEventListener('change', () => syncScheduleFields(form));

  backButton.addEventListener('click', async () => {
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
    if (saveButton.disabled) return;
    const values = readEditor(form);
    const workspace = workspaceId();
    if (!workspace) {
      show('error', '先选择一个工作区。');
      return;
    }
    if (!values.title || !values.participants.length) {
      show('error', '请填写标题和至少一名参与成员。');
      return;
    }
    const item = current?.id ? current : null;
    const path = `/v1/workspaces/${workspace}/automations`;
    const {template_id, ...changes} = values;
    saveButton.disabled = true;
    backButton.disabled = true;
    saveButton.textContent = '保存中…';
    let result;
    try {
      if (item) {
        result = await request('POST', `${path}/${item.id}`, {revision: item.revision, changes});
      } else {
        const content = JSON.stringify([workspace, values]);
        if (draftSave?.content !== content) draftSave = {content, key: idempotencyKey()};
        result = await request('POST', path, {...changes, template_id}, {'Idempotency-Key': draftSave.key});
      }
    } catch {
      show('error', '暂时无法确认是否保存成功，请重试。');
      return;
    } finally {
      saveButton.disabled = false;
      backButton.disabled = false;
      saveButton.textContent = '保存';
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
    if (!item) {
      selectCategory('mine');
      search.value = '';
    }
    closeConfirm({restoreFocus: false});
    fillEditor(form, current, currentUser && currentUser.username);
    form.elements.template_id.disabled = true;
    const heading = document.getElementById('editor-heading');
    if (heading) heading.textContent = current.title;
    document.getElementById('remove-automation').hidden = false;
    runButton.hidden = false;
    if (runHistoryButton) runHistoryButton.hidden = false;
    show('ok', current.enabled ? '已保存，自动运行已启用。' : '已保存，自动运行未启用。');
    await loadRuns();
  });

  runButton.addEventListener('click', async () => {
    const workspace = workspaceId(), automation = current?.id;
    if (!workspace || !automation || runButton.disabled) return;
    const isCurrent = () => workspaceId() === workspace && current?.id === automation && !form.hidden;
    if (!manualKeys.has(automation)) manualKeys.set(automation, idempotencyKey());
    manualPending.add(automation);
    runButton.disabled = true;
    runButton.textContent = '正在提交…';
    try {
      const result = await request('POST', `/v1/workspaces/${workspace}/automations/${automation}/run`,
        {}, {'Idempotency-Key': manualKeys.get(automation)});
      if (result.status !== 200 && result.status !== 202) {
        if (isCurrent()) show('error', messageFor(result.body.error, '无法启动这条自动化。'));
        return;
      }
      manualKeys.delete(automation);
      if (!isCurrent()) return;
      const onLatest = runCursors.length === 1 && runFilter === 'all';
      runFilter = 'all';
      resetRunPages();
      syncRunFilters();
      pushRunFilter(runFilter);
      activeRun = result.body.run.status === 'queued';
      renderRuns([result.body.run, ...(onLatest ? recentRuns.filter(run => run.id !== result.body.run.id) : [])].slice(0, 20));
      show('ok', '已提交，结果会出现在运行记录中。');
      showRunHistory();
    } catch {
      if (isCurrent()) show('error', '暂时无法确认是否提交成功，可以重试。');
    } finally {
      manualPending.delete(automation);
      if (isCurrent()) {
        runButton.disabled = activeRun;
        runButton.textContent = runButton.disabled ? '运行中…' : '运行一次';
        await loadRuns();
      }
    }
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
    savedRunResults.clear();
    stopRunPoll();
    await load();
  });

  return load().then(() => {
    const view = document.defaultView;
    const wanted = templateFromSearch(view && view.location && view.location.search);
    if (!wanted || mainPanel.hidden || !workspaceId() || !form.hidden) return;
    const template = templates.find(item => item.id === wanted);
    if (!template) return;
    openEditor(draftFromTemplate(template, currentUser && currentUser.username));
  });
}

if (globalThis.document && globalThis.document.getElementById('editor-form')) {
  mount(globalThis.document);
}
