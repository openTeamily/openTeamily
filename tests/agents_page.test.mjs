import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { mount } from '../openteamily/static/agents/app.mjs';

// The badge is a server-side reading: `GET /v1/workspaces/<ws>/agents/<id>/runtime`
// answers with `{runtime: null}` for an unbound agent, otherwise a binding whose
// `status` is computed by `binding_status()` in openteamily/app.py: online (the
// bound container is heartbeating), offline (bound, no recent heartbeat) or
// unavailable (the instance is gone). It is NOT inferred from the last reply
// time, so the wording says 在线/离线 and never claims an inferred activity.

class Element {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parent = null;
    this.attributes = {};
    this.handlers = {};
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.textContent = '';
    this.className = '';
    this.title = '';
    this.type = '';
    this.href = '';
    this.options = [];
    this.elements = {};
  }
  append(...nodes) {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
    if (this.tagName === 'SELECT') {
      this.options = this.children;
      if (!this.value && this.children[0]) this.value = this.children[0].value;
    }
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.options = [];
    if (this.tagName === 'SELECT' && !nodes.length) this.value = '';
    this.append(...nodes);
  }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(key, handler) { this.handlers[key] = handler; }
  querySelector() { return null; }
  focus() { this.focused = true; }
  closest() { return null; }
}

function fakeDocument() {
  const elements = new Map();
  const doc = {
    cookie: '',
    getElementById(id) {
      if (!elements.has(id)) {
        const tag = id === 'workspace' || id === 'runtime-instance' ? 'select'
          : id.endsWith('-form') ? 'form'
          : id === 'agent-search' ? 'input'
          : 'div';
        const el = new Element(tag);
        if (id === 'create-form' || id === 'edit-form') {
          el.elements = {
            id: new Element('input'),
            revision: new Element('input'),
            name: new Element('input'),
            summary: new Element('textarea'),
            instructions: new Element('textarea'),
          };
        }
        elements.set(id, el);
      }
      return elements.get(id);
    },
    createElement(tag) { return new Element(tag); },
    querySelectorAll() { return []; },
  };
  return {doc, el: (id) => doc.getElementById(id)};
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const tick = async (times = 10) => {
  for (let i = 0; i < times; i += 1) await flush();
};

function json(status, body) {
  return {status, json: async () => body};
}

function runtimeFetcher(requests, {runtimes = {}, failing = new Set()} = {}) {
  const space = {id: 'ws-1', name: 'Desk', owner_id: 'user-1'};
  const user = {id: 'user-1', username: 'alice'};
  const items = [
    {id: 'ag-writer', name: '写作助手', summary: '帮助起草文案', revision: 1},
    {id: 'ag-ops', name: '运维助手', summary: '查看发布状态', revision: 1},
    {id: 'ag-search', name: '检索助手', summary: '查找资料', revision: 1},
  ];
  return async (path, options) => {
    requests.push({path, method: (options && options.method) || 'GET'});
    if (path === '/v1/auth/session') return json(200, {user});
    if (path === '/v1/workspaces?limit=100') return json(200, {items: [space]});
    if (path === '/v1/workspaces/ws-1') return json(200, {workspace: space});
    if (path === '/v1/workspaces/ws-1/members') return json(200, {items: [{user_id: 'user-1', role: 'owner'}]});
    if (path === '/v1/workspaces/ws-1/agents?limit=100') return json(200, {items});
    const runtime = /^\/v1\/workspaces\/ws-1\/agents\/([^/?]+)\/runtime$/.exec(path);
    if (runtime) {
      const id = runtime[1];
      if (failing.has(id)) return json(500, {error: {code: 'internal', message: 'boom'}});
      return json(200, {runtime: runtimes[id] === undefined ? null : runtimes[id]});
    }
    throw new Error('unexpected ' + path);
  };
}

function statusSpans(el) {
  const found = [];
  const walk = (node) => {
    for (const child of node.children || []) {
      if (child.dataset && child.dataset.status) found.push(child);
      walk(child);
    }
  };
  walk(el('agent-list'));
  return found;
}

test('agentStatusBadge reads the server runtime status and says so in the tooltip', async () => {
  const {agentStatusBadge} = await import('../openteamily/static/agents/app.mjs');
  assert.equal(typeof agentStatusBadge, 'function', 'the agent status helper must be exported');
  const online = agentStatusBadge({status: 'online', instance_id: 'inst-1'});
  assert.equal(online.label, '在线');
  assert.equal(online.key, 'online');
  assert.match(online.title, /服务端状态/);
  assert.match(online.title, /容器/);
  const offline = agentStatusBadge({status: 'offline', instance_id: 'inst-1'});
  assert.equal(offline.label, '离线');
  assert.match(offline.title, /服务端状态/);
  const unavailable = agentStatusBadge({status: 'unavailable', instance_id: 'inst-1'});
  assert.equal(unavailable.label, '容器不可用');
  const unbound = agentStatusBadge(null);
  assert.equal(unbound.label, '未连运行时');
  assert.match(unbound.title, /没有绑定容器/);
  assert.match(unbound.title, /回退/);
  const unknown = agentStatusBadge(undefined);
  assert.equal(unknown.label, '状态未知');
  assert.match(unknown.title, /不代表离线/);
});

test('every directory card shows the runtime badge read from its own /runtime response', async () => {
  const requests = [];
  const {doc, el} = fakeDocument();
  const runtimes = {
    'ag-writer': {status: 'online', instance_id: 'inst-1', revision: 1},
    'ag-ops': {status: 'offline', instance_id: 'inst-1', revision: 1},
    'ag-search': null,
  };
  await mount(doc, {fetcher: runtimeFetcher(requests, {runtimes})});
  await tick();
  const spans = statusSpans(el);
  assert.deepEqual(spans.map(span => span.dataset.status), ['online', 'offline', 'unbound']);
  assert.deepEqual(spans.map(span => span.textContent), ['在线', '离线', '未连运行时']);
  assert.match(spans[0].title, /服务端状态/);
  assert.match(spans[2].title, /没有绑定容器/);
  const asked = requests.filter(row => row.path.endsWith('/runtime')).map(row => row.path);
  assert.deepEqual(asked, [
    '/v1/workspaces/ws-1/agents/ag-writer/runtime',
    '/v1/workspaces/ws-1/agents/ag-ops/runtime',
    '/v1/workspaces/ws-1/agents/ag-search/runtime',
  ]);
});

test('a failed runtime read shows 状态未知 instead of a green online dot', async () => {
  const requests = [];
  const {doc, el} = fakeDocument();
  await mount(doc, {
    fetcher: runtimeFetcher(requests, {failing: new Set(['ag-ops'])}),
  });
  await tick();
  const spans = statusSpans(el);
  assert.equal(spans.length, 3);
  const ops = spans.find(span => span.dataset.status === 'unknown');
  assert.ok(ops, 'the failed agent must carry the unknown state');
  assert.equal(ops.textContent, '状态未知');
  assert.match(ops.title, /不代表离线/);
  assert.equal(spans.some(span => span.textContent === '在线'), false);
});

test('the badge keeps the same server status through the search filter and a re-render', async () => {
  const requests = [];
  const {doc, el} = fakeDocument();
  const runtimes = {
    'ag-writer': {status: 'online', instance_id: 'inst-1', revision: 1},
    'ag-ops': {status: 'offline', instance_id: 'inst-1', revision: 1},
    'ag-search': null,
  };
  await mount(doc, {fetcher: runtimeFetcher(requests, {runtimes})});
  await tick();
  const before = statusSpans(el).map(span => [span.dataset.status, span.textContent]);
  assert.deepEqual(before, [['online', '在线'], ['offline', '离线'], ['unbound', '未连运行时']]);
  const search = el('agent-search');
  search.value = '运维';
  search.handlers.input();
  const filtered = statusSpans(el);
  assert.deepEqual(filtered.map(span => [span.dataset.status, span.textContent]), [['offline', '离线']]);
  search.value = '';
  search.handlers.input();
  assert.deepEqual(statusSpans(el).map(span => [span.dataset.status, span.textContent]), before,
    'a filtered re-render must not change or drop a status');
  const asked = requests.filter(row => row.path.endsWith('/runtime')).length;
  assert.equal(asked, 3, 're-rendering must not re-read the runtime');
});

test('the page states where the status comes from and that it is not inferred', () => {
  const html = readFileSync(new URL('../openteamily/static/agents/index.html', import.meta.url), 'utf8');
  const note = html.split('id="agent-status-note"')[1].split('</p>')[0];
  assert.match(note, /服务端/);
  assert.match(note, /心跳/);
  assert.match(note, /未连运行时/);
  assert.match(note, /不是从最近回复时间推断/);
});
