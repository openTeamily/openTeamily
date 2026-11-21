import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {
  GRAPH_EMPTY_MESSAGE,
  graphEmptyStateVisible,
  mount,
} from '../openteamily/static/memory/app.mjs';

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
    this.type = '';
    this.href = '';
    this.options = [];
    this.elements = {};
    this.focused = false;
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
  appendChild(node) {
    this.append(node);
    return node;
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.options = [];
    if (this.tagName === 'SELECT' && !nodes.length) this.value = '';
    this.append(...nodes);
  }
  setAttribute(key, value) { this.attributes[key] = value; }
  getAttribute(key) { return this.attributes[key]; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(key, handler) { this.handlers[key] = handler; }
  querySelector(selector) {
    if (selector === '.graph-node') {
      return this.children.find((child) => child.className === 'graph-node') || null;
    }
    return this.children.find((child) => child.attributes.class === selector || child.className === selector) || null;
  }
  focus() { this.focused = true; }
  click() { return this.handlers.click && this.handlers.click({target: this}); }
}

function fakeDocument() {
  const elements = new Map();
  const body = new Element('body');
  const doc = {
    cookie: '',
    body,
    getElementById(id) {
      if (!elements.has(id)) {
        const tag = id === 'workspace' || id === 'action-filter' || id === 'new-action-page' || id === 'link-target' ? 'select'
          : id.endsWith('-form') ? 'form'
          : id === 'search' || id === 'topic-search' || id === 'username' || id === 'password' ? 'input'
          : id === 'graph-canvas' ? 'svg'
          : 'div';
        const el = new Element(tag);
        if (id === 'editor-form') {
          el.hidden = true;
          el.elements = {
            title: new Element('input'),
            body: new Element('textarea'),
            topics: new Element('input'),
          };
        }
        if (id === 'action-editor-form') {
          el.hidden = true;
          el.elements = {
            title: new Element('input'),
            notes: new Element('textarea'),
            status: new Element('select'),
            due: new Element('input'),
            memory_page_id: new Element('select'),
          };
        }
        if (id === 'graph-empty') {
          el.hidden = true;
          el.className = 'graph-empty';
          const copy = new Element('p');
          copy.textContent = GRAPH_EMPTY_MESSAGE;
          const button = new Element('button');
          button.id = 'graph-empty-new';
          button.textContent = '新建记忆页';
          el.append(copy, button);
        }
        elements.set(id, el);
      }
      return elements.get(id);
    },
    createElement(tag) { return new Element(tag); },
    createElementNS(_ns, tag) { return new Element(tag); },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
  return {doc, el: (id) => doc.getElementById(id)};
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const tick = async (times = 8) => {
  for (let i = 0; i < times; i += 1) await flush();
};

function json(status, body) {
  return {status, json: async () => body};
}

function graphFetcher(graph) {
  const space = {id: 'ws-1', name: 'Desk', owner_id: 'user-1'};
  const user = {id: 'user-1', username: 'alice'};
  return async (path) => {
    if (path === '/v1/auth/session') return json(200, {user});
    if (path === '/v1/settings') return json(404, {error: {message: 'missing'}});
    if (path === '/v1/workspaces') return json(200, {items: [space]});
    if (path === '/v1/workspaces/ws-1/memory') return json(200, {items: []});
    if (path === '/v1/workspaces/ws-1/memory/actions') return json(200, {items: []});
    if (path === '/v1/workspaces/ws-1/memory/graph') return json(200, graph);
    if (/^\/v1\/workspaces\/ws-1\/memory\/[a-z0-9-]+\/share$/.test(path)) return json(200, {share: null});
    throw new Error('unexpected ' + path);
  };
}

const emptyGraph = {nodes: [], edges: [], topics: [], counts: {nodes: 0, edges: 0, topics: 0}};
const oneNode = {
  nodes: [{id: 'pg-1', title: '单独一页'}],
  edges: [],
  topics: [],
  counts: {nodes: 1, edges: 0, topics: 0},
};
const twoNodes = {
  nodes: [{id: 'pg-1', title: '项目简报'}, {id: 'pg-2', title: '运维手册'}],
  edges: [{source: 'pg-1', target: 'pg-2', kind: 'mention'}],
  topics: [],
  counts: {nodes: 2, edges: 1, topics: 0},
};

test('graphEmptyStateVisible hides the hint when a query is present or two pages exist', () => {
  assert.equal(GRAPH_EMPTY_MESSAGE, '创建两个或更多记忆页后，这里会把它们连成图谱');
  assert.equal(graphEmptyStateVisible({nodeCount: 0, query: ''}), true);
  assert.equal(graphEmptyStateVisible({nodeCount: 1, query: '  '}), true);
  assert.equal(graphEmptyStateVisible({nodeCount: 2, query: ''}), false);
  assert.equal(graphEmptyStateVisible({nodeCount: 0, query: 'zzz'}), false);
  assert.equal(graphEmptyStateVisible({nodeCount: 1, query: '简报'}), false);
});

test('renderGraph shows the empty hint for zero or one page and hides it for two', async () => {
  const {doc, el} = fakeDocument();
  const api = await mount(doc, {fetcher: graphFetcher(emptyGraph)});
  await tick();
  assert.equal(el('graph-empty').hidden, false);
  assert.ok(el('graph-empty').children[0].textContent.includes('两个或更多'));

  api.renderGraph(oneNode);
  assert.equal(el('graph-empty').hidden, false);

  api.renderGraph(twoNodes);
  assert.equal(el('graph-empty').hidden, true);
});

test('a topic search miss keeps muted nodes and does not show the empty hint', async () => {
  const {doc, el} = fakeDocument();
  const api = await mount(doc, {fetcher: graphFetcher(twoNodes)});
  await tick();
  assert.equal(el('graph-empty').hidden, true);
  el('topic-search').value = 'zzz-no-match';
  el('topic-search').handlers.input();
  await tick();
  assert.equal(el('graph-empty').hidden, true);
  const classOf = (item) => String(item.attributes.class || item.className || '');
  const items = el('graph-canvas').children[0].children.filter((child) => classOf(child).includes('graph-item'));
  assert.equal(items.length, 2);
  assert.ok(items.every((item) => classOf(item).includes('is-muted')));
  api.renderGraph(twoNodes);
  assert.equal(el('graph-empty').hidden, true);
});


test('the graph create entry posts through the existing flow and opens the created page', async () => {
  const {doc, el} = fakeDocument();
  doc.cookie = 'ot_dev_csrf=fixture-csrf';
  const calls = [];
  const baseFetcher = graphFetcher(emptyGraph);
  const fetcher = async (path, options = {}) => {
    calls.push({path, options});
    if (path === '/v1/workspaces/ws-1/memory' && options.method === 'POST') {
      return json(201, {page: {id: 'pg-created', title: '未命名页面', body: '', topics: [], revision: 1,
        created_by: 'user-1', updated_by: 'user-1'}});
    }
    return baseFetcher(path, options);
  };
  mount(doc, {fetcher});
  await tick();
  assert.equal(el('graph-empty').hidden, false);
  el('graph-empty-new').click();
  await tick();
  const writes = calls.filter(call => call.options.method === 'POST');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, '/v1/workspaces/ws-1/memory');
  assert.deepEqual(JSON.parse(writes[0].options.body), {title: '未命名页面', body: ''});
  assert.equal(writes[0].options.headers['X-CSRF-Token'], 'fixture-csrf');
  assert.ok(writes[0].options.headers['Idempotency-Key']);
  assert.equal(calls.some(call => call.path.endsWith('/pg-created')), false);
  assert.equal(el('editor-form').hidden, false);
  assert.equal(el('editor-form').elements.title.value, '未命名页面');
});


test('the graph finishing in the background leaves a newly created page open', async () => {
  const {doc, el} = fakeDocument();
  const fallback = graphFetcher(emptyGraph);
  let finishGraph;
  const fetcher = async (path, options = {}) => {
    if (path.endsWith('/memory/graph')) return new Promise(resolve => { finishGraph = resolve; });
    if (path === '/v1/workspaces/ws-1/memory' && options.method === 'POST') {
      return json(201, {page: {id: 'new', title: '未命名页面', body: '', topics: [], revision: 1}});
    }
    return fallback(path, options);
  };
  const loaded = mount(doc, {fetcher});
  await tick();
  assert.equal(typeof finishGraph, 'function');
  el('new-page').click();
  await tick();
  assert.equal(el('editor-form').hidden, false);
  finishGraph(json(200, {graph: emptyGraph}));
  await loaded;
  assert.equal(el('editor-form').hidden, false);
  assert.equal(el('list-panel').dataset.view, 'page');
});

test('narrow stacking overrides the shell panel grid only while the list is visible', () => {
  const css = readFileSync(new URL('../openteamily/static/memory/app.css', import.meta.url), 'utf8');
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*#list-panel\.memory-workspace:not\(\[hidden\]\)\s*\{\s*display: flex;/);
  assert.doesNotMatch(css, /#list-panel\.memory-workspace\s*\{\s*display: flex;/);
});
