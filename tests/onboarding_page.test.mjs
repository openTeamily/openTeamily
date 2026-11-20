import assert from 'node:assert/strict';
import test from 'node:test';
import {mountAutomationCreation} from '../openteamily/static/onboarding/app.mjs';

class FakeElement {
  constructor(tag = 'div', id = '') {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.dataset = {};
    this.attributes = {};
    this.handlers = {};
    this.children = [];
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this._text = '';
    this.className = '';
    this.type = '';
    this.elements = {};
  }
  get textContent() {
    return this._text + this.children.map((child) => child.textContent || '').join('');
  }
  set textContent(value) {
    this._text = String(value == null ? '' : value);
    this.children = [];
  }
  addEventListener(type, handler) { (this.handlers[type] ||= []).push(handler); }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
  removeAttribute(name) { delete this.attributes[name]; }
  append(...nodes) { for (const node of nodes) this.children.push(node); }
  appendChild(node) { this.children.push(node); return node; }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  querySelector() { return null; }
  focus() {}
  reset() {}
}

function fakeDocument() {
  const elements = new Map();
  return {
    readyState: 'complete',
    cookie: '',
    getElementById(id) {
      if (!elements.has(id)) {
        const tag = id.endsWith('-form') ? 'form' : id === 'industry' ? 'select' : 'div';
        elements.set(id, new FakeElement(tag, id));
      }
      return elements.get(id);
    },
    createElement(tag) { return new FakeElement(tag); },
    createTextNode(text) { const node = new FakeElement('#text'); node.textContent = text; return node; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}

const flush = () => new Promise(resolve => setImmediate(resolve));
async function settle(times = 16) {
  for (let i = 0; i < times; i += 1) await flush();
}

function json(status, body) {
  return {status, json: async () => body};
}

function fetcherFor(state) {
  const calls = [];
  // A workspace may answer differently from the others: the checklist must
  // judge every workspace, so a fixture has to be able to make the first one
  // empty and a later one hold the real activity.
  const perWorkspace = (id, field) => {
    const own = state.byWorkspace && state.byWorkspace[id];
    if (own && field in own) return own[field];
    return state[field];
  };
  return {
    calls,
    fetch: async (path) => {
      calls.push(path);
      if (state.throwOn && path.indexOf(state.throwOn) === 0) throw new Error('network down');
      if (path === '/v1/auth/session') return json(200, {user: {username: 'alice'}});
      if (path === '/v1/onboarding') return json(200, {industries: [], onboarding: null});
      if (path === '/v1/workspaces?limit=100') {
        if (state.workspaces === 'error') return json(500, {error: {message: 'workspace listing failed'}});
        return json(200, {items: state.workspaces || []});
      }
      const agents = /^\/v1\/workspaces\/([^/]+)\/agents\?limit=100$/.exec(path);
      if (agents) {
        const value = perWorkspace(agents[1], 'agents');
        if (value === 'error') return json(500, {error: {message: 'agent listing failed'}});
        return json(200, {items: value || []});
      }
      if (path === '/v1/runtime/connections') {
        if (state.runtimes === 'error') return json(500, {error: {message: 'runtime listing failed'}});
        return json(200, {items: (state.runtimes || []).map((status, index) => ({id: 'rt-' + index, status}))});
      }
      const automations = /^\/v1\/workspaces\/([^/]+)\/automations$/.exec(path);
      if (automations) {
        const value = perWorkspace(automations[1], 'automations');
        if (value === 'error') return json(500, {error: {message: 'automation listing failed'}});
        return json(200, {items: (value || []).map(id => ({id}))});
      }
      const runs = /^\/v1\/workspaces\/([^/]+)\/automations\/([^/]+)\/runs\?limit=20$/.exec(path);
      if (runs) {
        const value = perWorkspace(runs[1], 'runs');
        if (value === 'error') return json(500, {error: {message: 'run listing failed'}});
        return json(200, {items: (value || []).map(status => ({status}))});
      }
      throw new Error('unexpected ' + path);
    },
  };
}

async function mountOnboarding(state) {
  const doc = fakeDocument();
  const fake = fetcherFor(state);
  const saved = {document: globalThis.document, fetch: globalThis.fetch};
  globalThis.document = doc;
  globalThis.fetch = fake.fetch;
  try {
    await import('../openteamily/static/onboarding/app.mjs?checklist=' + Math.random());
    await settle();
  } finally {
    if (saved.document === undefined) delete globalThis.document; else globalThis.document = saved.document;
    if (saved.fetch === undefined) delete globalThis.fetch; else globalThis.fetch = saved.fetch;
  }
  return {doc, calls: fake.calls};
}

function steps(doc) {
  const list = doc.getElementById('onboarding-checklist');
  return list.children.map((row) => ({
    text: row.textContent,
    done: row.dataset.state === 'done',
  }));
}

test('a fresh account sees three steps, none of them faked as done', async () => {
  const {doc} = await mountOnboarding({workspaces: [], runtimes: [], automations: []});
  const rows = steps(doc);
  assert.equal(rows.length, 3, 'expected 3 onboarding steps, got ' + rows.length);
  assert.deepEqual(rows.map((row) => row.done), [false, false, false],
    'an empty account claims a step is already done');
  assert.match(rows[0].text, /建智能体/);
  assert.match(rows[1].text, /连运行时/);
  assert.match(rows[2].text, /跑一次自动化/);
  assert.match(rows[0].text, /需要你先创建工作区/);
  assert.match(rows[2].text, /需要你先创建工作区/);
  assert.equal(doc.getElementById('onboarding-ready').hidden, true,
    'the ready banner shows before the checklist is complete');
});

test('an agent, an online runtime and a finished automation run complete every step', async () => {
  const {doc, calls} = await mountOnboarding({
    workspaces: [{id: 'ws-1', name: 'Desk'}],
    agents: [{id: 'ag-1', name: 'Helper'}],
    runtimes: ['online'],
    automations: ['au-1'],
    runs: ['succeeded'],
  });
  const rows = steps(doc);
  assert.deepEqual(rows.map((row) => row.done), [true, true, true],
    'real state (agent, online runtime, finished run) did not complete the steps');
  for (const row of rows) assert.match(row.text, /✓/, 'a completed step is not ticked: ' + row.text);
  assert.match(rows[0].text, /Helper/);
  const ready = doc.getElementById('onboarding-ready');
  assert.equal(ready.hidden, false, 'all steps are done but the ready banner is hidden');
  assert.match(ready.textContent, /可以开始了/);
  const link = ready.children.find((child) => child.tagName === 'A');
  assert.ok(link, 'the ready banner has no link to /chat');
  assert.equal(link.getAttribute('href'), '/chat');
  assert.ok(calls.includes('/v1/workspaces?limit=100'), 'the checklist did not read the workspaces API');
  assert.ok(calls.includes('/v1/runtime/connections'), 'the checklist did not read the runtime connections');
  assert.ok(calls.some((path) => /\/automations$/.test(path)), 'the checklist did not read automations');
  assert.ok(calls.some((path) => /\/runs\?limit=20$/.test(path)), 'the checklist did not read automation runs');
});

test('an offline runtime and a queued-only run stay unproven with the reason shown', async () => {
  const {doc} = await mountOnboarding({
    workspaces: [{id: 'ws-1', name: 'Desk'}],
    agents: [{id: 'ag-1', name: 'Helper'}],
    runtimes: ['offline'],
    automations: ['au-1'],
    runs: ['queued'],
  });
  const rows = steps(doc);
  assert.deepEqual(rows.map((row) => row.done), [true, false, false]);
  assert.match(rows[1].text, /当前离线/);
  assert.match(rows[2].text, /还没有执行过/);
  assert.equal(doc.getElementById('onboarding-ready').hidden, true);
});

test('a failing workspace request leaves the workspace steps unproven but still judges the runtime', async () => {
  const {doc} = await mountOnboarding({workspaces: 'error', runtimes: ['online'], automations: []});
  const rows = steps(doc);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.done), [false, true, false],
    'a failed workspace request was reported as completed, or a judgeable runtime was skipped');
  assert.match(rows[0].text, /读取工作区失败/);
  assert.match(rows[2].text, /读取工作区失败/);
});

test('a failing run listing reports the automation step as unknown, not done', async () => {
  const {doc} = await mountOnboarding({
    workspaces: [{id: 'ws-1', name: 'Desk'}],
    agents: [{id: 'ag-1', name: 'Helper'}],
    runtimes: ['online'],
    automations: ['au-1'],
    runs: 'error',
  });
  const rows = steps(doc);
  assert.deepEqual(rows.map((row) => row.done), [true, true, false]);
  assert.match(rows[2].text, /读取运行记录失败/);
  assert.equal(doc.getElementById('onboarding-ready').hidden, true);
});

test('a second workspace with the agent and the finished run completes the steps it proves', async () => {
  const {doc, calls} = await mountOnboarding({
    workspaces: [{id: 'ws-1', name: 'Desk'}, {id: 'ws-2', name: 'Team'}],
    byWorkspace: {
      'ws-1': {agents: [], automations: []},
      'ws-2': {agents: [{id: 'ag-2', name: 'Second'}], automations: ['au-2'], runs: ['succeeded']},
    },
    runtimes: ['online'],
  });
  const rows = steps(doc);
  assert.deepEqual(rows.map((row) => row.done), [true, true, true],
    'a second workspace holds the agent and the finished run, but the checklist judged the first workspace only');
  assert.match(rows[0].text, /Second/, 'the agent step does not name the agent found in the second workspace');
  assert.match(rows[2].text, /执行记录/, 'the automation step does not see the run finished in the second workspace');
  assert.ok(calls.includes('/v1/workspaces/ws-2/agents?limit=100'), 'the checklist never read the second workspace agents');
  assert.ok(calls.includes('/v1/workspaces/ws-2/automations'), 'the checklist never read the second workspace automations');
  assert.equal(doc.getElementById('onboarding-ready').hidden, false);
});

test('a thrown workspace request still renders three honest unknown rows', async () => {
  const {doc} = await mountOnboarding({workspaces: [], runtimes: ['online'], throwOn: '/v1/workspaces?limit=100'});
  const rows = steps(doc);
  assert.equal(rows.length, 3, 'expected 3 onboarding steps after a thrown request, got ' + rows.length);
  assert.deepEqual(rows.map((row) => row.done), [false, false, false],
    'a thrown request must not tick a step');
  const text = rows.map((row) => row.text).join('\n');
  assert.doesNotMatch(text, /✓/, 'a thrown request rendered a tick');
  for (const row of rows) assert.match(row.text, /无法判断|失败|出错/, 'a row gives no reason after a thrown request: ' + row.text);
  assert.equal(doc.getElementById('onboarding-ready').hidden, true);
});


test('automation creation is opt-in, click-only and guarded against duplicate clicks', async () => {
  const doc = fakeDocument();
  const calls = [];
  let finish;
  const creation = mountAutomationCreation(doc, async (...args) => {
    calls.push(args);
    return new Promise(resolve => {finish = resolve;});
  });
  creation.render([{template_id: 'daily_brief', title: '每日工作简报', prompt: '真实模板'}]);
  const button = doc.getElementById('create-onboarding-automations');
  const box = doc.getElementById('onboarding-automation-templates').children[0].children[0];
  assert.equal(box.checked, false);
  assert.deepEqual(calls, [], 'rendering onboarding must not create anything');
  const click = button.handlers.click[0];
  await click();
  assert.deepEqual(calls, [], 'an empty selection never creates anything');
  box.checked = true;
  assert.deepEqual(calls, [], 'selection alone must not create anything');
  const pending = click();
  await click();
  assert.equal(calls.length, 1);
  assert.equal(button.disabled, true);
  assert.deepEqual(calls[0], ['POST', '/v1/onboarding/automations', {template_ids: ['daily_brief']}]);
  finish({status: 201, body: {created: [{id: 'one'}], skipped: []}});
  await pending;
  assert.equal(button.disabled, false);
  assert.match(doc.getElementById('onboarding-automation-status').textContent, /全部暂停/);
});

test('automation creation reports errors without advancing onboarding', async () => {
  const doc = fakeDocument();
  const creation = mountAutomationCreation(doc, async () => {throw new Error('offline');});
  creation.render([{template_id: 'daily_brief', title: '每日工作简报', prompt: '真实模板'}]);
  doc.getElementById('onboarding-automation-templates').children[0].children[0].checked = true;
  const button = doc.getElementById('create-onboarding-automations');
  await button.handlers.click[0]();
  assert.equal(button.disabled, false);
  assert.match(doc.getElementById('onboarding-automation-status').textContent, /结果尚不确定/);
});
