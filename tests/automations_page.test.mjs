import assert from 'node:assert/strict';
import test from 'node:test';
import {cancellationPrompt, catalogItems, csrfCookie, deletePrompt, draftFromTemplate, inlineToggleState, listQuery, matchesRunFilter, mount, namesFromList, readEditor, RUN_DETAIL_EMPTY, runDetailFields, runErrorReason, runFilterFromSearch, runFilterSearchText, runResultText, runStatusLabel, scheduleFromForm, scheduleSummary, tabCategory, toggleChanges} from '../openteamily/static/automations/app.mjs';

test('csrfCookie reads host-bound and development cookie names only', () => {
  assert.equal(csrfCookie('__Host-ot_csrf=token-a'), 'token-a');
  assert.equal(csrfCookie('ot_dev_session=x; ot_dev_csrf=token-b'), 'token-b');
  assert.equal(csrfCookie('csrf=nope; other=1'), '');
});

test('listQuery encodes tab and search', () => {
  assert.equal(listQuery('mine', ''), '?category=mine');
  assert.equal(listQuery('work', '  brief '), '?category=work&q=brief');
  assert.equal(tabCategory('life'), 'life');
  assert.equal(tabCategory('other'), 'mine');
});

test('scheduleFromForm and namesFromList map editor fields', () => {
  const fake = {
    get(name) {
      return {
        kind: 'monthly', time: '10:15', time_zone: 'UTC', day: '16',
        weekday: '1', date: '2026-11-20',
      }[name];
    },
  };
  assert.deepEqual(scheduleFromForm(fake), {kind: 'monthly', time: '10:15', time_zone: 'UTC', day: 16});
  assert.deepEqual(namesFromList('alice, Bob, alice'), ['alice', 'Bob']);
});

test('readEditor collects tag fields', () => {
  const values = {
    title: ' Brief ', template_id: 'daily_brief', intent: '晨报', scope: 'ongoing',
    participants: 'alice, bob', agents: 'brief-bot', kind: 'weekdays',
    time: '09:00', time_zone: 'Asia/Shanghai', prompt: 'hello',
  };
  const fake = {
    get(name) { return values[name]; },
    has(name) { return name === 'enabled'; },
  };
  const original = globalThis.FormData;
  globalThis.FormData = class { constructor() { return fake; } };
  try {
    assert.deepEqual(readEditor({}), {
      title: 'Brief', template_id: 'daily_brief', intent: '晨报', scope: 'ongoing',
      participants: ['alice', 'bob'], agents: ['brief-bot'],
      schedule: {kind: 'weekdays', time: '09:00', time_zone: 'Asia/Shanghai'},
      prompt: 'hello', enabled: true,
    });
  } finally {
    globalThis.FormData = original;
  }
});

test('runStatusLabel and runResultText describe durable run rows', () => {
  assert.equal(runStatusLabel({status: 'succeeded'}), '已完成');
  assert.equal(runStatusLabel({status: 'queued', error_code: 'no_agent'}), '等待已连接的代理');
  assert.equal(runStatusLabel({status: 'timeout'}), '已超时');
  assert.equal(runResultText({result: {text: 'brief from fake provider'}}), 'brief from fake provider');
  assert.equal(runResultText({result: {}}), '');
});

test('catalogItems filters recorded work and life templates', () => {
  const templates = [
    {id: 'custom', title: '自定义', category: 'custom', prompt: ''},
    {id: 'daily_brief', title: '每日工作简报', category: 'work', prompt: '汇总当天要处理的事项。'},
    {id: 'birthday_reminder', title: '生日和纪念日提醒', category: 'life', prompt: '在日期到来前提醒我。'},
    {id: 'habit_reminder', title: '健康和习惯提醒', category: 'life', prompt: '在约定的时间提醒我。'},
  ];
  assert.deepEqual(catalogItems(templates, 'work', '').map(item => item.id), ['daily_brief']);
  assert.deepEqual(catalogItems(templates, 'life', '习惯').map(item => item.id), ['habit_reminder']);
  assert.deepEqual(catalogItems(templates, 'mine', ''), []);
});

test('draftFromTemplate uses recorded daily brief defaults only', () => {
  assert.deepEqual(draftFromTemplate({
    id: 'daily_brief', title: '每日工作简报', prompt: '汇总当天要处理的事项。',
  }, 'alice'), {
    template_id: 'daily_brief', title: '每日工作简报', prompt: '汇总当天要处理的事项。',
    intent: 'monitor', scope: 'once',
    schedule: {kind: 'now', time_zone: 'Asia/Shanghai'},
    participants: ['alice'], agents: [], enabled: false,
  });
  const life = draftFromTemplate({
    id: 'birthday_reminder', title: '生日和纪念日提醒', prompt: '提前提醒。',
  }, 'alice');
  assert.equal(life.intent, '');
  assert.equal(life.scope, 'once');
  assert.equal(life.schedule.kind, 'now');
});

class FakeNode {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = {};
    this.handlers = {};
    this.dataset = {};
    this.className = '';
    this.hidden = false;
    this.value = '';
    this.classList = {add() {}, remove() {}, contains() { return false; }};
    this._text = '';
  }
  get textContent() {
    if (this.children.length) return this.children.map(child => child.textContent).join('');
    return this._text;
  }
  set textContent(value) {
    this.children = [];
    this._text = String(value);
  }
  get options() { return this.children.filter(child => child.tagName === 'OPTION'); }
  get elements() {
    if (this._elements) return this._elements;
    this._elements = {};
    // The editor form reads every named control through form.elements; the
    // template select also needs appendChild/options so fillTemplates works.
    for (const name of ['intent', 'scope', 'participants', 'agents', 'date', 'time', 'weekday',
      'day', 'time_zone', 'prompt', 'enabled', 'title']) {
      this._elements[name] = new FakeNode('input');
    }
    this._elements.template_id = new FakeNode('select');
    this._elements.kind = new FakeNode('select');
    return this._elements;
  }
  addEventListener(type, handler) { (this.handlers[type] ||= []).push(handler); }
  appendChild(child) {
    this.children.push(child);
    child.parentNode = this;
    if (this.tagName === 'SELECT' && !this.value) this.value = child.value || '';
    return child;
  }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }
  focus() { this.focused = true; }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
  querySelectorAll() { return []; }
  querySelector() { return new FakeNode(); }
}

function fakeDocument() {
  const elements = new Map();
  const tags = {'editor-form': 'form', workspace: 'select', search: 'input'};
  const doc = {
    cookie: '',
    handlers: {},
    addEventListener(type, handler) { (doc.handlers[type] ||= []).push(handler); },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeNode(tags[id] || 'div'));
      return elements.get(id);
    },
    createElement(tag) { return new FakeNode(tag); },
    querySelectorAll() { return []; },
    querySelector() { return new FakeNode(); },
  };
  return {doc, elements};
}

async function mountList(items) {
  const {doc, elements} = fakeDocument();
  const calls = [];
  const fetcher = async (path, options = {}) => {
    calls.push(`${options.method || 'GET'} ${path}`);
    if (path === '/v1/auth/session') return {status: 200, json: async () => ({user: {username: 'alice'}})};
    if (path === '/v1/workspaces?scope=personal') return {status: 200, json: async () => ({items: []})};
    if (path === '/v1/workspaces?limit=100') return {status: 200, json: async () => ({items: [{id: 'ws1', name: '团队'}]})};
    if (path === '/v1/automation-templates') return {status: 200, json: async () => ({items: []})};
    if (path === '/v1/workspaces/ws1/automations?category=mine') return {status: 200, json: async () => ({items})};
    throw new Error('unexpected ' + path);
  };
  const saved = globalThis.document;
  globalThis.document = doc;
  try {
    await mount(doc, {fetcher});
  } finally {
    if (saved === undefined) delete globalThis.document; else globalThis.document = saved;
  }
  return {list: elements.get('automation-list'), calls};
}

test('personal automations are available while the team workspaces and templates load', async () => {
  const {doc, elements} = fakeDocument();
  const {promise: catalog, resolve: resolveCatalog} = Promise.withResolvers();
  const {promise: teams, resolve: resolveTeams} = Promise.withResolvers();
  const respond = body => ({status: 200, json: async () => body});
  const fetcher = async path => {
    if (path === '/v1/auth/session') return respond({user: {username: 'alice'}});
    if (path === '/v1/workspaces?scope=personal') return respond({items: [{id: 'ws1', name: '个人工作区'}]});
    if (path === '/v1/workspaces?limit=100') return teams;
    if (path === '/v1/automation-templates') return catalog;
    if (path === '/v1/workspaces/ws1/automations?category=mine') {
      return respond({items: [{id: 'a1', title: '每日简报', schedule: {kind: 'now'}}]});
    }
    throw new Error('unexpected ' + path);
  };
  const saved = globalThis.document;
  globalThis.document = doc;
  const mounted = mount(doc, {fetcher});
  try {
    await flush();
    assert.equal(elements.get('new-automation').disabled, false);
    assert.match(elements.get('automation-list').textContent, /每日简报/);
    resolveTeams(respond({items: [{id: 'team', name: '团队'}]}));
    await flush();
    const picker = elements.get('workspace');
    assert.equal(picker.value, 'ws1');
    assert.deepEqual(picker.options.map(option => option.value), ['ws1', 'team']);
  } finally {
    resolveTeams(respond({items: []}));
    resolveCatalog(respond({items: []}));
    await mounted;
    if (saved === undefined) delete globalThis.document; else globalThis.document = saved;
  }
});

test('scheduleSummary writes the editor wording for every recorded schedule kind', () => {
  assert.equal(scheduleSummary({kind: 'now', time_zone: 'Asia/Shanghai'}, true), '立即运行 · 已启用');
  assert.equal(scheduleSummary({kind: 'now', time_zone: 'UTC'}, false), '立即运行 · 未启用');
  assert.equal(scheduleSummary({kind: 'daily', time: '09:00', time_zone: 'Asia/Shanghai'}, true), '每天 09:00（Asia/Shanghai）· 已启用');
  assert.equal(scheduleSummary({kind: 'daily', time: '18:00', time_zone: 'UTC'}, true), '每天 18:00（UTC）· 已启用');
  assert.equal(scheduleSummary({kind: 'weekly', time: '09:00', weekday: 4, time_zone: 'Asia/Shanghai'}, true), '每周四 09:00（Asia/Shanghai）· 已启用');
  assert.equal(scheduleSummary({kind: 'weekdays', time: '08:30', time_zone: 'Asia/Shanghai'}, true), '工作日 08:30（Asia/Shanghai）· 已启用');
  assert.equal(scheduleSummary({kind: 'monthly', time: '09:00', day: 16, time_zone: 'Asia/Shanghai'}, true), '每月 16 日 09:00（Asia/Shanghai）· 已启用');
  assert.equal(scheduleSummary({kind: 'once', date: '2026-11-20', time: '09:00', time_zone: 'Asia/Shanghai'}, true), '单次 2026-11-20 09:00（Asia/Shanghai）· 已启用');
  assert.equal(scheduleSummary({kind: 'later', date: '2026-11-20', time: '08:00', time_zone: 'UTC'}, true), '单次 2026-11-20 08:00（UTC）· 已启用');
  assert.equal(scheduleSummary({kind: 'daily', time: '09:00', time_zone: 'Asia/Shanghai'}, false), '每天 09:00（Asia/Shanghai）· 未启用');
  assert.equal(scheduleSummary(null, false), '立即运行 · 未启用');
  assert.equal(scheduleSummary({kind: 'mystery', time_zone: 'UTC'}, true).includes('mystery'), false, 'an unknown kind is never echoed to the reader');
});

test('list rows describe the schedule instead of printing the internal kind', async () => {
  const {list} = await mountList([
    {id: 'a1', title: '每日简报', enabled: true, schedule: {kind: 'daily', time: '09:00', time_zone: 'Asia/Shanghai'}},
    {id: 'a2', title: '周报', enabled: true, schedule: {kind: 'weekly', time: '09:00', weekday: 4, time_zone: 'Asia/Shanghai'}},
    {id: 'a3', title: '一次性提醒', enabled: true, schedule: {kind: 'once', date: '2026-11-20', time: '09:00', time_zone: 'Asia/Shanghai'}},
    {id: 'a4', title: '立即运行的任务', enabled: true, schedule: {kind: 'now', time_zone: 'Asia/Shanghai'}},
    {id: 'a5', title: '每月复盘', enabled: false, schedule: {kind: 'monthly', time: '18:00', day: 16, time_zone: 'UTC'}},
  ]);
  const rows = list.children.map(row => row.textContent);
  assert.match(rows[0], /每日简报/);
  assert.match(rows[0], /每天 09:00（Asia\/Shanghai）· 已启用/);
  assert.match(rows[1], /周报/);
  assert.match(rows[1], /每周四 09:00（Asia\/Shanghai）· 已启用/);
  assert.match(rows[2], /一次性提醒/);
  assert.match(rows[2], /单次 2026-11-20 09:00（Asia\/Shanghai）· 已启用/);
  assert.match(rows[3], /立即运行的任务/);
  assert.match(rows[3], /立即运行 · 已启用/);
  assert.match(rows[4], /每月复盘/);
  assert.match(rows[4], /每月 16 日 18:00（UTC）· 未启用/);
  const joined = list.textContent;
  assert.doesNotMatch(joined, /(?:^|\s)(?:now|later|once|daily|weekly|monthly|weekdays)(?=\s|$)/u,
    `the list must not print an internal schedule kind: ${joined}`);
});
const flush = () => new Promise(resolve => setImmediate(resolve));

const AUTOMATION = {
  id: 'a1', title: '每日简报', enabled: true,
  schedule: {kind: 'now', time_zone: 'Asia/Shanghai'},
};

function postCount(calls, fragment) {
  return calls.filter(entry => entry.startsWith('POST ') && entry.includes(fragment)).length;
}

// Stub poll timers while the editor is mounted in Node.
function holdRunPolling(schedule = () => 0) {
  const saved = {setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout};
  globalThis.setTimeout = schedule;
  globalThis.clearTimeout = () => {};
  return () => {
    globalThis.setTimeout = saved.setTimeout;
    globalThis.clearTimeout = saved.clearTimeout;
  };
}

async function mountEditor({items = [AUTOMATION], runs = [], workspaces = [{id: 'ws1', name: '团队'}],
  search = '', pushes = [], windowHandlers = {}, schedulePoll, getRuns} = {}) {
  // The click handlers resolve `document` and the run poll from globals, so both
  // stay installed until the test calls restore().
  const restorePolling = holdRunPolling(schedulePoll);
  const {doc, elements} = fakeDocument();
  const view = {
    location: {search},
    history: {pushState(state, title, url) { pushes.push(url); view.location.search = url; }},
    addEventListener(type, handler) { (windowHandlers[type] ||= []).push(handler); },
  };
  doc.defaultView = view;
  const calls = [];
  const fetcher = async (path, options = {}) => {
    const method = options.method || 'GET';
    calls.push(`${method} ${path}`);
    if (path === '/v1/auth/session') return {status: 200, json: async () => ({user: {username: 'alice'}})};
    if (path === '/v1/workspaces?scope=personal') return {status: 200, json: async () => ({items: []})};
    if (path === '/v1/workspaces?limit=100') return {status: 200, json: async () => ({items: workspaces})};
    if (path === '/v1/automation-templates') return {status: 200, json: async () => ({items: []})};
    const listed = path.match(/^\/v1\/workspaces\/([^/]+)\/automations\?category=mine$/);
    if (method === 'GET' && listed) return {status: 200, json: async () => ({items})};
    const listedRuns = path.match(/^\/v1\/workspaces\/([^/]+)\/automations\/([^/]+)\/runs\?limit=20(?:&status=([a-z]+))?$/);
    if (method === 'GET' && listedRuns) {
      const wanted = listedRuns[3] || '';
      const allRows = getRuns ? await getRuns() : runs;
      const rows = allRows.filter(item => !wanted || item.status === wanted);
      return {status: 200, json: async () => ({items: listedRuns[2] === 'a1' ? rows : []})};
    }
    if (method === 'POST' && /^\/v1\/workspaces\/[^/]+\/automations\/[^/]+\/remove$/.test(path)) {
      return {status: 200, json: async () => ({})};
    }
    if (method === 'POST' && /^\/v1\/workspaces\/[^/]+\/automations\/[^/]+\/runs\/[^/]+\/cancel$/.test(path)) {
      return {status: 200, json: async () => ({})};
    }
    if (method === 'POST' && /^\/v1\/workspaces\/[^/]+\/automations\/[^/]+$/.test(path)) {
      return {status: 200, json: async () => ({automation: {...AUTOMATION, title: '新的标题', revision: 2}})};
    }
    throw new Error('unexpected ' + method + ' ' + path);
  };
  const saved = globalThis.document;
  globalThis.document = doc;
  await mount(doc, {fetcher});
  return {
    doc, elements, calls, view,
    restore() {
      if (saved === undefined) delete globalThis.document; else globalThis.document = saved;
      restorePolling();
    },
  };
}

// A list row is `li > [avatar, copy > [open, schedule], state]`; the open
// button is the only control in a row that carries a click handler.
function openButtonIn(row) {
  const button = row.children.flatMap(node => [node, ...(node.children || [])])
    .find(node => node.handlers && node.handlers.click);
  assert.ok(button, 'the list row must offer a button that opens the automation');
  return button;
}

async function openFirst(elements) {
  const list = elements.get('automation-list');
  assert.ok(list.children.length, 'the list must render the automation before it can be opened');
  openButtonIn(list.children[0]).handlers.click[0]();
  await flush();
}

test('run polling waits for the current request and keeps watching an enabled schedule', async () => {
  const timers = [];
  const {promise: nextRuns, resolve: resolveNext} = Promise.withResolvers();
  let requests = 0;
  const queued = {id: 'r1', status: 'queued', started: 1795085700};
  const succeeded = {...queued, status: 'succeeded'};
  const {elements, restore} = await mountEditor({
    schedulePoll(callback, delay) {
      timers.push({callback, delay});
      return timers.length;
    },
    getRuns: () => ++requests === 1 ? [queued] : nextRuns,
  });
  try {
    await openFirst(elements);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 3000);
    timers.shift().callback();
    await flush();
    assert.equal(requests, 2);
    assert.equal(timers.length, 0, 'a slow request must have time to finish');
    resolveNext([succeeded]);
    await flush();
    assert.match(elements.get('run-list').textContent, /已完成/);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 12000, 'an enabled task still watches for scheduled runs');
  } finally {
    resolveNext([succeeded]);
    restore();
  }
});

function alertdialogIn(parent) {
  return parent.children.find(node => node.getAttribute('role') === 'alertdialog');
}

function labelledQuestion(box) {
  return box.children.find(node => node.id === box.getAttribute('aria-labelledby'));
}

test('删除先在原位问一次，确认前 0 请求、确认后恰好 1 次 remove', async () => {
  const {elements, calls, restore} = await mountEditor();
  try {
    await openFirst(elements);
    const form = elements.get('editor-form');
    const remove = elements.get('remove-automation');
    remove.handlers.click[0]();
    await flush();
    assert.equal(postCount(calls, '/remove'), 0,
      'clicking 删除 must not send the remove request before the user confirms');
    const box = alertdialogIn(form);
    assert.ok(box, 'clicking 删除 must put an alertdialog where the 删除 button was');
    const question = labelledQuestion(box);
    assert.ok(question, 'the alertdialog must label itself through aria-labelledby');
    assert.equal(question.textContent, '删除这条自动化？');
    const labels = box.children.map(node => node.textContent);
    assert.ok(labels.includes('取消'), 'the delete question must offer 取消');
    assert.ok(labels.includes('确认'), 'the delete question must offer 确认');
    assert.equal(remove.hidden, true, 'the 删除 button is replaced by the question while it is open');
    const cancel = box.children.find(node => node.textContent === '取消');
    assert.equal(cancel.focused, true, 'focus must start on 取消, the safe choice');
    box.children.find(node => node.textContent === '确认').handlers.click[0]();
    await flush();
    assert.equal(postCount(calls, '/remove'), 1, 'confirming must send exactly one remove request');
    assert.equal(elements.get('status').textContent, '已删除。');
    assert.equal(elements.get('editor-form').hidden, true, 'a confirmed delete returns to the list');
    assert.equal(alertdialogIn(form), undefined);
  } finally { restore(); }
});

test('取消运行先在原位问一次，确认前 0 请求、确认后恰好 1 次 cancel', async () => {
  const {elements, calls, restore} = await mountEditor({runs: [{id: 'r1', status: 'queued'}]});
  try {
    await openFirst(elements);
    const runList = elements.get('run-list');
    const runRow = runList.children[0];
    const head = runRow.children[0];
    const trigger = head.children.find(node => node.textContent === '取消这次运行');
    assert.ok(trigger, 'a queued run must offer 取消这次运行');
    trigger.handlers.click[0]();
    await flush();
    assert.equal(postCount(calls, '/cancel'), 0,
      'clicking 取消这次运行 must not send the cancel request before the user confirms');
    const box = alertdialogIn(head);
    assert.ok(box, 'clicking 取消这次运行 must put an alertdialog in the run row');
    const question = labelledQuestion(box);
    assert.equal(question.textContent, '取消这次运行？');
    const confirm = box.children.find(node => node.textContent === '确认取消');
    assert.ok(confirm, 'the run question must offer 确认取消');
    assert.equal(box.children.find(node => node.textContent === '取消').focused, true);
    confirm.handlers.click[0]();
    await flush();
    assert.equal(postCount(calls, '/cancel'), 1, 'confirming must send exactly one cancel request');
    assert.equal(elements.get('status').textContent, '已取消。');
  } finally { restore(); }
});

test('Esc 与取消都只关闭问句、0 请求，并把焦点还给触发按钮', async () => {
  const {doc, elements, calls, restore} = await mountEditor();
  try {
    await openFirst(elements);
    const form = elements.get('editor-form');
    const remove = elements.get('remove-automation');
    remove.handlers.click[0]();
    await flush();
    assert.ok(doc.handlers.keydown && doc.handlers.keydown.length,
      'the page has no Escape handler, so Esc cannot close the delete question');
    doc.handlers.keydown[0]({key: 'Escape', preventDefault() {}});
    await flush();
    assert.equal(postCount(calls, '/remove'), 0, 'Esc must close the delete question without sending a request');
    assert.equal(remove.hidden, false, 'Esc must bring the 删除 button back');
    assert.equal(remove.focused, true, 'Esc must return focus to the 删除 button it replaced');
    assert.equal(alertdialogIn(form), undefined);

    remove.focused = false;
    remove.handlers.click[0]();
    await flush();
    const box = alertdialogIn(form);
    box.children.find(node => node.textContent === '取消').handlers.click[0]();
    await flush();
    assert.equal(postCount(calls, '/remove'), 0, 'the 取消 button must close the delete question without sending a request');
    assert.equal(remove.focused, true, 'the 取消 button must return focus to the 删除 button');
    assert.equal(alertdialogIn(form), undefined);
  } finally { restore(); }
});

test('deletePrompt and cancellationPrompt carry the confirmation wording', () => {
  assert.deepEqual(deletePrompt({id: 'a1', title: '每日简报'}), {
    question: '删除这条自动化？', confirmLabel: '确认',
  });
  assert.deepEqual(cancellationPrompt({id: 'r1', status: 'queued'}), {
    question: '取消这次运行？', confirmLabel: '确认取消',
  });
});

test('切工作区后问句关闭，残留确认也只能打到快照里的工作区', async () => {
  const {elements, calls, restore} = await mountEditor({
    workspaces: [{id: 'ws1', name: '团队'}, {id: 'ws2', name: '另一个团队'}],
  });
  try {
    await openFirst(elements);
    const form = elements.get('editor-form');
    const remove = elements.get('remove-automation');
    remove.handlers.click[0]();
    await flush();
    assert.equal(labelledQuestion(alertdialogIn(form)).textContent, '删除这条自动化？');
    const staleConfirm = alertdialogIn(form).children.find(node => node.textContent === '确认');

    const select = elements.get('workspace');
    select.value = 'ws2';
    select.handlers.change[0]();
    await flush();

    assert.equal(alertdialogIn(form), undefined,
      'changing workspace must close the question that belongs to ws1, not leave it open on ws2');
    assert.equal(postCount(calls, '/workspaces/ws2/'), 0,
      'changing workspace itself must never send a request for ws2');

    staleConfirm.handlers.click[0]();
    await flush();
    assert.equal(postCount(calls, '/workspaces/ws2/'), 0,
      'a confirm that is still reachable must use the workspace snapshotted when it opened, never ws2');
    assert.equal(postCount(calls, '/workspaces/ws1/automations/a1/remove'), 1,
      'the confirm must delete the automation it asked about, in the workspace it asked about');
  } finally { restore(); }
});

test('返回列表再打开第二条时旧问句不跟随，确认也不删第二条', async () => {
  const {elements, calls, restore} = await mountEditor({
    items: [AUTOMATION, {id: 'a2', title: '周报', enabled: true, schedule: {kind: 'now', time_zone: 'Asia/Shanghai'}}],
  });
  try {
    await openFirst(elements);
    const form = elements.get('editor-form');
    const remove = elements.get('remove-automation');
    remove.handlers.click[0]();
    await flush();
    const staleConfirm = alertdialogIn(form).children.find(node => node.textContent === '确认');

    elements.get('cancel-editor').handlers.click[0]();
    await flush();
    assert.equal(alertdialogIn(form), undefined,
      'returning to the list must close the question instead of hiding it inside the form');
    assert.notEqual(remove.focused, true,
      'leaving the editor must not move focus onto the 删除 button, which is about to be hidden');

    const list = elements.get('automation-list');
    assert.equal(list.children.length, 2, 'the list must still offer both automations');
    openButtonIn(list.children[1]).handlers.click[0]();
    await flush();
    assert.equal(alertdialogIn(form), undefined,
      'opening the second automation must not bring the first automation question back');
    assert.equal(postCount(calls, '/remove'), 0, 'opening the second automation must send no remove request');

    staleConfirm.handlers.click[0]();
    await flush();
    assert.equal(postCount(calls, '/automations/a2/remove'), 0,
      'a confirm must never delete the second automation the user was never asked about');
    assert.equal(postCount(calls, '/automations/a1/remove'), 1,
      'a leftover confirm may only act on the automation it asked about');
  } finally { restore(); }
});

test('取消运行的问句同样绑定快照，切工作区后确认也不改道', async () => {
  const {elements, calls, restore} = await mountEditor({
    workspaces: [{id: 'ws1', name: '团队'}, {id: 'ws2', name: '另一个团队'}],
    runs: [{id: 'r1', status: 'queued'}],
  });
  try {
    await openFirst(elements);
    const head = elements.get('run-list').children[0].children[0];
    const trigger = head.children.find(node => node.textContent === '取消这次运行');
    trigger.handlers.click[0]();
    await flush();
    const staleConfirm = alertdialogIn(head).children.find(node => node.textContent === '确认取消');

    const select = elements.get('workspace');
    select.value = 'ws2';
    select.handlers.change[0]();
    await flush();
    assert.equal(postCount(calls, '/workspaces/ws2/'), 0,
      'changing workspace itself must never send a request for ws2');

    staleConfirm.handlers.click[0]();
    await flush();
    assert.equal(postCount(calls, '/workspaces/ws2/'), 0,
      'a run cancel confirm must use the workspace snapshotted when it opened, never ws2');
    assert.equal(postCount(calls, '/v1/workspaces/ws1/automations/a1/runs/r1/cancel'), 1,
      'the run question must cancel exactly the run it named, in the workspace it named');
  } finally { restore(); }
});

test('保存成功后旧问句关闭，不会在已保存的编辑器里重问', async () => {
  const {elements, calls, restore} = await mountEditor();
  const savedFormData = globalThis.FormData;
  try {
    await openFirst(elements);
    const form = elements.get('editor-form');
    elements.get('remove-automation').handlers.click[0]();
    await flush();
    assert.ok(alertdialogIn(form), 'the delete question must be open before the save happens');

    const values = {
      title: '新的标题', template_id: 'custom', intent: '', scope: 'once',
      participants: 'alice', agents: '', kind: 'now', time_zone: 'Asia/Shanghai', prompt: '',
    };
    globalThis.FormData = class {
      constructor() { return {get(name) { return values[name] || ''; }, has() { return false; }}; }
    };
    form.handlers.submit[0]({preventDefault() {}});
    await flush();

    assert.equal(postCount(calls, '/automations/a1/remove'), 0,
      'saving must not carry out a delete question that was left open');
    assert.equal(alertdialogIn(form), undefined,
      'a successful save must close the delete question instead of re-showing it in the saved editor');
  } finally {
    if (savedFormData === undefined) delete globalThis.FormData; else globalThis.FormData = savedFormData;
    restore();
  }
});

import { templateFromSearch } from '../openteamily/static/automations/app.mjs';

test('?template= accepts only a plain template id', () => {
  assert.equal(templateFromSearch('?template=daily_brief'), 'daily_brief');
  assert.equal(templateFromSearch('?template=../x'), '');
  assert.equal(templateFromSearch(''), '');
});

// --- Issue 305: enable/disable a row from the list, without the editor. ---

test('inlineToggleState and toggleChanges describe one row toggle', () => {
  const on = {id: 'a1', revision: 3, enabled: true};
  const off = {id: 'a1', revision: 4, enabled: false};
  assert.deepEqual(inlineToggleState(on),
    {label: '已启用', checked: true, action: '停用', next: false});
  assert.deepEqual(inlineToggleState(off),
    {label: '未启用', checked: false, action: '启用', next: true});
  assert.deepEqual(toggleChanges(on), {revision: 3, changes: {enabled: false}});
  assert.deepEqual(toggleChanges(off), {revision: 4, changes: {enabled: true}});
});

async function mountToggleList(items, respond) {
  const {doc, elements} = fakeDocument();
  const calls = [];
  const fetcher = async (path, options = {}) => {
    calls.push({method: options.method || 'GET', path, body: options.body});
    if (path === '/v1/auth/session') return {status: 200, json: async () => ({user: {username: 'alice'}})};
    if (path === '/v1/workspaces?limit=100') return {status: 200, json: async () => ({items: [{id: 'ws1', name: '团队'}]})};
    if (path === '/v1/automation-templates') return {status: 200, json: async () => ({items: []})};
    if (path === '/v1/workspaces/ws1/automations?category=mine') {
      return {status: 200, json: async () => ({items})};
    }
    if (options.method === 'POST' && /\/v1\/workspaces\/ws1\/automations\/[a-z0-9]+$/.test(path)) {
      return respond(path, JSON.parse(options.body));
    }
    throw new Error('unexpected ' + path);
  };
  const saved = globalThis.document;
  globalThis.document = doc;
  try {
    await mount(doc, {fetcher});
  } finally {
    if (saved === undefined) delete globalThis.document; else globalThis.document = saved;
  }
  return {list: elements.get('automation-list'), calls, doc, elements};
}

function rowSwitch(row) {
  return row.children.find(child => child.attributes && child.attributes.role === 'switch');
}

function rowPill(row) {
  return row.children.find(child => String(child.className).includes('status-pill'));
}

const TOGGLE_ROW = {
  id: 'a1', title: '每日简报', revision: 3, enabled: true,
  schedule: {kind: 'now', time_zone: 'Asia/Shanghai'},
};

test('a list row toggles enabled through the existing update route and repaints the pill', async () => {
  const {list, calls} = await mountToggleList([{...TOGGLE_ROW}], () => ({
    status: 200,
    json: async () => ({automation: {...TOGGLE_ROW, enabled: false, revision: 4}}),
  }));
  const row = list.children[0];
  const toggle = rowSwitch(row);
  assert.ok(toggle, 'the row must carry a role=switch control');
  assert.equal(toggle.attributes['aria-checked'], 'true');
  assert.equal(toggle.textContent, '停用');
  assert.match(rowPill(row).textContent, /已启用/);

  await toggle.handlers.click[0]();
  await flush();

  const post = calls.find(entry => entry.method === 'POST');
  assert.equal(post.path, '/v1/workspaces/ws1/automations/a1');
  assert.deepEqual(JSON.parse(post.body), {revision: 3, changes: {enabled: false}});
  assert.equal(toggle.attributes['aria-checked'], 'false');
  assert.equal(toggle.textContent, '启用');
  assert.equal(rowPill(row).textContent, '未启用');
  assert.equal(rowPill(row).className.includes('is-on'), false);
});

test('a refused toggle keeps the old state and reports the server reason in an alert', async () => {
  const {list, elements} = await mountToggleList([{...TOGGLE_ROW}], () => ({
    status: 403,
    json: async () => ({error: {code: 'forbidden', message: 'Not allowed to change automations'}}),
  }));
  const row = list.children[0];
  const toggle = rowSwitch(row);
  await toggle.handlers.click[0]();
  await flush();

  assert.equal(toggle.attributes['aria-checked'], 'true', 'a refused toggle must not flip the switch');
  assert.equal(rowPill(row).textContent, '已启用');
  const alert = elements.get('automations-alert');
  assert.equal(alert.hidden, false);
  assert.match(alert.textContent, /Not allowed to change automations/);
});

test('a stale revision asks for a reload instead of pretending the toggle worked', async () => {
  const {list, calls, elements, doc} = await mountToggleList([{...TOGGLE_ROW}], () => ({
    status: 409,
    json: async () => ({
      error: {code: 'conflict', message: 'Automation changed elsewhere; reload and retry'},
      automation: {...TOGGLE_ROW, revision: 9},
    }),
  }));
  const row = list.children[0];
  // The 409 path re-reads the list, and those handlers resolve `document` at
  // call time, so the fake document stays installed for the whole click.
  const savedDoc = globalThis.document;
  globalThis.document = doc;
  try {
    await rowSwitch(row).handlers.click[0]();
    await flush();
  } finally {
    if (savedDoc === undefined) delete globalThis.document; else globalThis.document = savedDoc;
  }

  const alert = elements.get('automations-alert');
  assert.equal(alert.hidden, false);
  assert.match(alert.textContent, /别处|重新/);
  const reloads = calls.filter(entry => entry.method === 'GET'
    && entry.path === '/v1/workspaces/ws1/automations?category=mine');
  assert.equal(reloads.length, 2, 'a 409 must re-read the list so the row shows the stored state');
});

test('runFilterFromSearch and runFilterSearchText round-trip the runs query', () => {
  assert.equal(runFilterFromSearch(''), 'all');
  assert.equal(runFilterFromSearch('?runs=failed'), 'failed');
  assert.equal(runFilterFromSearch('?runs=succeeded'), 'succeeded');
  assert.equal(runFilterFromSearch('?runs=all'), 'all');
  assert.equal(runFilterFromSearch('?runs=1'), 'all');
  assert.equal(runFilterFromSearch('?runs=FAILED'), 'all');
  assert.equal(runFilterFromSearch('?template=daily_brief&runs=failed'), 'failed');
  assert.equal(runFilterSearchText('all'), '');
  assert.equal(runFilterSearchText('failed'), '?runs=failed');
  assert.equal(runFilterSearchText('succeeded'), '?runs=succeeded');
});

test('matchesRunFilter keeps only the requested stored statuses', () => {
  assert.equal(matchesRunFilter({status: 'failed'}, 'all'), true);
  assert.equal(matchesRunFilter({status: 'succeeded'}, 'all'), true);
  assert.equal(matchesRunFilter({status: 'failed'}, 'failed'), true);
  assert.equal(matchesRunFilter({status: 'queued'}, 'failed'), false);
  assert.equal(matchesRunFilter({status: 'succeeded'}, 'failed'), false);
  assert.equal(matchesRunFilter({status: 'cancelled'}, 'failed'), true,
    'run_view reports a cancelled run as cancelled; the server stores it as failed');
  assert.equal(matchesRunFilter({status: 'timeout'}, 'failed'), true);
  assert.equal(matchesRunFilter({status: 'succeeded'}, 'succeeded'), true);
  assert.equal(matchesRunFilter({status: 'failed'}, 'succeeded'), false);
  assert.equal(matchesRunFilter({}, 'succeeded'), false);
});

const RUNS = [
  {id: 'r1', status: 'succeeded', error_code: null, due_at: 1795085700, started: 1795085700, finished: 1795085760},
  {id: 'r2', status: 'failed', error_code: 'runtime_failure', due_at: 1795085800, started: 1795085800, finished: 1795085860},
  {id: 'r3', status: 'failed', error_code: 'timeout', due_at: 1795085900, started: 1795085900, finished: 1795085960},
];

test('点「失败」只请求失败运行，并把 ?runs=failed 写进地址栏', async () => {
  const pushes = [];
  const {elements, calls, restore} = await mountEditor({runs: RUNS, pushes});
  try {
    await openFirst(elements);
    calls.length = 0;
    await elements.get('run-filter-failed').handlers.click[0]();
    await flush();
    assert.ok(calls.includes('GET /v1/workspaces/ws1/automations/a1/runs?limit=20&status=failed'),
      `the failed filter must ask the server for failed runs: ${calls.join(' | ')}`);
    assert.deepEqual(pushes, ['/automations?runs=failed'], 'choosing a run filter must leave a shareable URL');
    assert.equal(elements.get('run-filter-failed').getAttribute('aria-current'), 'true');
    assert.equal(elements.get('run-filter-all').getAttribute('aria-current'), 'false');
    assert.equal(elements.get('run-filter-succeeded').getAttribute('aria-current'), 'false');
    assert.equal(elements.get('run-list').children.length, 2, 'only the two failed runs stay listed');
    assert.equal(elements.get('run-filter-empty').hidden, true);
  } finally {
    restore();
  }
});

test('带 ?runs=failed 直接打开时首屏就请求失败列表，按钮也已经选中', async () => {
  const handlers = {};
  const {elements, calls, restore} = await mountEditor({runs: RUNS, search: '?runs=failed', windowHandlers: handlers});
  try {
    await openFirst(elements);
    assert.ok(calls.includes('GET /v1/workspaces/ws1/automations/a1/runs?limit=20&status=failed'),
      `a shared URL must be honoured on the first run request: ${calls.join(' | ')}`);
    assert.equal(elements.get('run-filter-failed').getAttribute('aria-current'), 'true');
    assert.equal(elements.get('run-filter-all').getAttribute('aria-current'), 'false');
    assert.equal(elements.get('run-list').children.length, 2);
  } finally {
    restore();
  }
});

test('筛选没有匹配项时给一句空态，而不是空白列表', async () => {
  const only = [{id: 'r1', status: 'succeeded', error_code: null, due_at: 1795085700}];
  const {elements, restore} = await mountEditor({runs: only, search: '?runs=failed'});
  try {
    await openFirst(elements);
    assert.equal(elements.get('run-list').children.length, 0);
    assert.equal(elements.get('run-filter-empty').hidden, false,
      'a filter with no match must say so instead of leaving the list blank');
    assert.equal(elements.get('run-empty').hidden, true,
      'the old empty note belongs to the unfiltered list only');
  } finally {
    restore();
  }
});

test('浏览器后退回到「全部」时按地址栏重载，不再写一次历史', async () => {
  const pushes = [];
  const handlers = {};
  const {elements, calls, view, restore} = await mountEditor({runs: RUNS, pushes, windowHandlers: handlers});
  try {
    await openFirst(elements);
    await elements.get('run-filter-succeeded').handlers.click[0]();
    await flush();
    assert.deepEqual(pushes, ['/automations?runs=succeeded']);
    assert.ok(handlers.popstate && handlers.popstate.length, 'the page must listen for back/forward');
    calls.length = 0;
    view.location.search = '';
    handlers.popstate[0]({});
    await flush();
    assert.deepEqual(pushes, ['/automations?runs=succeeded'], 'back/forward must not push another history entry');
    assert.ok(calls.includes('GET /v1/workspaces/ws1/automations/a1/runs?limit=20'),
      `going back to 全部 must reload the unfiltered list: ${calls.join(' | ')}`);
    assert.equal(elements.get('run-filter-all').getAttribute('aria-current'), 'true');
    assert.equal(elements.get('run-list').children.length, 3);
  } finally {
    restore();
  }
});

// A failed or timed-out run used to be a dead end: the only control was 取消这次运行
// on a queued run, so the next attempt was whatever the schedule produced. These
// tests drive the real mount() and read the request the retry button sends.

const RETRY_RUNS = [
  {id: 'r1', status: 'succeeded', error_code: null, due_at: 1795085600, started: 1795085600, finished: 1795085660},
  {id: 'r2', status: 'failed', error_code: 'runtime_failure', due_at: 1795085700, started: 1795085700, finished: 1795085760},
  {id: 'r3', status: 'timeout', error_code: 'timeout', due_at: 1795085800, started: 1795085800, finished: 1795085860},
  {id: 'r4', status: 'queued', error_code: null, due_at: 1795085900, started: 1795085900, finished: null},
];

function runRowButtons(elements, label) {
  const list = elements.get('run-list');
  const found = [];
  for (const row of list.children) {
    const nodes = row.children.flatMap(node => [node, ...(node.children || [])]);
    for (const node of nodes) {
      if (node.tagName === 'BUTTON' && String(node.textContent).trim() === label) found.push(node);
    }
  }
  return found;
}

async function mountRuns({runs = RETRY_RUNS, retry = 'ok'} = {}) {
  const restorePolling = holdRunPolling();
  const {doc, elements} = fakeDocument();
  const calls = [];
  const posts = [];
  let listed = runs.slice();
  const fetcher = async (path, options = {}) => {
    const method = options.method || 'GET';
    calls.push(`${method} ${path}`);
    if (path === '/v1/auth/session') return {status: 200, json: async () => ({user: {username: 'alice'}})};
    if (path === '/v1/workspaces?scope=personal') return {status: 200, json: async () => ({items: []})};
    if (path === '/v1/workspaces?limit=100') return {status: 200, json: async () => ({items: [{id: 'ws1', name: '团队'}]})};
    if (path === '/v1/automation-templates') return {status: 200, json: async () => ({items: []})};
    if (path === '/v1/workspaces/ws1/automations?category=mine') {
      return {status: 200, json: async () => ({items: [AUTOMATION]})};
    }
    if (method === 'GET' && /^\/v1\/workspaces\/ws1\/automations\/a1\/runs\?limit=20$/.test(path)) {
      return {status: 200, json: async () => ({items: listed})};
    }
    if (method === 'POST' && /^\/v1\/workspaces\/ws1\/automations\/a1\/runs\/[^/]+\/retry$/.test(path)) {
      posts.push({path, headers: options.headers || {}, body: options.body});
      if (retry === 'ok') {
        const fresh = {id: 'r9', status: 'queued', error_code: 'no_agent', due_at: 1795086000, started: 1795086000, finished: null};
        listed = [fresh, ...listed];
        return {status: 201, json: async () => ({run: fresh})};
      }
      return {status: retry, json: async () => ({error: {code: 'conflict', message: 'Only a failed run can be retried'}})};
    }
    throw new Error('unexpected ' + method + ' ' + path);
  };
  const saved = globalThis.document;
  globalThis.document = doc;
  await mount(doc, {fetcher});
  await openFirst(elements);
  return {
    elements, calls, posts,
    restore() {
      if (saved === undefined) delete globalThis.document; else globalThis.document = saved;
      restorePolling();
    },
  };
}

test('only failed, timed-out and cancelled runs offer 重新运行', async () => {
  const {elements, restore} = await mountRuns({
    runs: [...RETRY_RUNS, {id: 'r5', status: 'cancelled', error_code: 'cancelled', due_at: 1, started: 1, finished: 2}],
  });
  try {
    const retry = runRowButtons(elements, '重新运行');
    assert.equal(retry.length, 3, 'the failed, timed-out and cancelled rows each offer one retry');
    const succeeded = elements.get('run-list').children[0];
    assert.ok(!succeeded.children.flatMap(node => [node, ...(node.children || [])])
      .some(node => String(node.textContent).trim() === '重新运行'), 'a finished success has nothing to re-run');
    const queued = elements.get('run-list').children[3];
    assert.ok(!queued.children.flatMap(node => [node, ...(node.children || [])])
      .some(node => String(node.textContent).trim() === '重新运行'), 'a queued run is not retryable, it is cancellable');
  } finally {
    restore();
  }
});

test('点「重新运行」带幂等键请求 /retry，成功后列表出现一条排队中的新运行', async () => {
  const {elements, posts, restore} = await mountRuns();
  try {
    const [button] = runRowButtons(elements, '重新运行');
    await button.handlers.click[0]();
    await flush();
    assert.equal(posts.length, 1, 'one click is one request');
    assert.equal(posts[0].path, '/v1/workspaces/ws1/automations/a1/runs/r2/retry');
    assert.match(posts[0].headers['Idempotency-Key'] || '', /^[A-Za-z0-9_-]{16,64}$/,
      'the request needs an idempotency key or a double click queues the automation twice');
    const rows = elements.get('run-list').children;
    assert.equal(rows.length, 5, 'the reloaded list now carries the new queued run');
    assert.match(rows[0].textContent, /等待已连接的代理|运行中/, 'the new run is queued, not a finished failure');
    assert.match(elements.get('status').textContent, /重新排队/);
  } finally {
    restore();
  }
});

test('连点两次用同一把幂等键，不会排两次队', async () => {
  const {elements, posts, restore} = await mountRuns();
  try {
    const [button] = runRowButtons(elements, '重新运行');
    const handler = button.handlers.click[0];
    await Promise.all([handler(), handler()]);
    await flush();
    assert.equal(posts.length, 2, 'both clicks reach the server');
    assert.equal(posts[0].headers['Idempotency-Key'], posts[1].headers['Idempotency-Key'],
      'two clicks on the same run must reuse one key, otherwise the server queues two runs');
  } finally {
    restore();
  }
});

test('服务端说不能重跑时贴出原因，不假装成功', async () => {
  const {elements, restore} = await mountRuns({retry: 409});
  try {
    const [button] = runRowButtons(elements, '重新运行');
    await button.handlers.click[0]();
    await flush();
    const status = elements.get('status');
    assert.equal(status.dataset.kind, 'error');
    assert.match(status.textContent, /Only a failed run can be retried/);
  } finally {
    restore();
  }
});

// A run row expands in place: the summary, the status code and the failure
// reason come from fields the server already returns (automations.py run_view).
test('a failed run names a readable reason and keeps the raw code visible', () => {
  const failed = {id: 'r1', status: 'failed', error_code: 'provider_error', result: {}};
  assert.equal(runErrorReason(failed), '模型提供方这次没有返回结果。');
  assert.deepEqual(runDetailFields(failed).map(field => field.label), ['状态码', '失败原因']);
  assert.equal(runDetailFields(failed)[0].value, 'provider_error');
});

test('an explicit result.error wins over the mapped code', () => {
  const failed = {status: 'failed', error_code: 'provider_error', result: {error: '上游 502：bad gateway'}};
  assert.equal(runErrorReason(failed), '上游 502：bad gateway');
});

test('an unknown code falls back to the raw code, never to an empty box', () => {
  const failed = {status: 'failed', error_code: 'mystery', result: {}};
  assert.equal(runErrorReason(failed), '服务端只留下错误代码：mystery');
});

test('a run that left nothing says so instead of showing an empty box', () => {
  assert.equal(RUN_DETAIL_EMPTY, '这次运行没有留下输出');
  assert.deepEqual(runDetailFields({status: 'succeeded', result: {}}), []);
});

test('a succeeded run expands to its summary and the model that wrote it', () => {
  const succeeded = {status: 'succeeded', error_code: null, result: {text: '今天的简报', model: 'deepseek-v4'}};
  assert.deepEqual(runDetailFields(succeeded), [
    {label: '摘要', value: '今天的简报'},
    {label: '模型', value: 'deepseek-v4'},
  ]);
});
