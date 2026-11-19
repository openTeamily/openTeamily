import assert from 'node:assert/strict';
import test from 'node:test';
import { MEMORY_EMPTY_NO_MATCH, MEMORY_EMPTY_WORKSPACE, matchingMemoryPages, mount } from '../openteamily/static/memory/app.mjs';

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
  querySelector() { return null; }
  focus() { this.focused = true; }
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
        if (id === 'list-empty') el.textContent = MEMORY_EMPTY_WORKSPACE;
        elements.set(id, el);
      }
      return elements.get(id);
    },
    createElement(tag) { return new Element(tag); },
    createElementNS(_ns, tag) { return new Element(tag); },
    // The WYSIWYG memory editor renders the opened page body with text nodes.
    createTextNode(text) { const node = new Element('#text'); node.textContent = String(text); node.nodeType = 3; return node; },
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

const pages = [
  {id: 'pg-brief', title: '项目简报', body: '本周进度', topics: [], updated: 1800000000, revision: 1, created_by: 'alice', updated_by: 'alice'},
  {id: 'pg-ops', title: '运维手册', body: '发布步骤', topics: [], updated: 1800000100, revision: 1, created_by: 'alice', updated_by: 'alice'},
  {id: 'pg-notes', title: '会议记录', body: '讨论纪要', topics: [], updated: 1800000200, revision: 1, created_by: 'alice', updated_by: 'alice'},
];

function directoryFetcher(requests) {
  const space = {id: 'ws-1', name: 'Desk', owner_id: 'user-1'};
  const user = {id: 'user-1', username: 'alice'};
  return async (path, options) => {
    requests.push({path, method: (options && options.method) || 'GET'});
    if (path === '/v1/auth/session') return json(200, {user});
    if (path === '/v1/settings') return json(404, {error: {message: 'missing'}});
    if (path === '/v1/workspaces') return json(200, {items: [space]});
    if (path === '/v1/workspaces/ws-1/memory') return json(200, {items: pages});
    if (path === '/v1/workspaces/ws-1/memory/actions') return json(200, {items: []});
    if (path === '/v1/workspaces/ws-1/memory/graph') {
      return json(200, {nodes: [], edges: [], topics: [], counts: {nodes: 0, edges: 0, topics: 0}});
    }
    const pageMatch = /^\/v1\/workspaces\/ws-1\/memory\/([^/?]+)$/.exec(path);
    if (pageMatch) {
      const page = pages.find((row) => row.id === pageMatch[1]);
      if (page) return json(200, {page});
    }
    throw new Error('unexpected ' + path);
  };
}

function openFirstPage(el) {
  return el('memory-list').children[0].children[0].handlers.click();
}

function pageTitles(el) {
  return el('memory-list').children.map((li) => li.children[0].children[1].children[0].textContent);
}

test('matchingMemoryPages filters titles case-insensitively and leaves empty queries intact', () => {
  assert.deepEqual(matchingMemoryPages(pages, '').map((row) => row.id), ['pg-brief', 'pg-ops', 'pg-notes']);
  assert.deepEqual(matchingMemoryPages(pages, '  运维  ').map((row) => row.title), ['运维手册']);
  assert.deepEqual(matchingMemoryPages(pages, '简报').map((row) => row.title), ['项目简报']);
  assert.deepEqual(matchingMemoryPages([{id: 'pg-en', title: 'Project Brief'}], 'BRIEF').map((row) => row.title), ['Project Brief']);
  assert.deepEqual(matchingMemoryPages(pages, 'zzz').map((row) => row.title), []);
});

test('typing in the memory directory search filters in place and keeps an open editor', async () => {
  const requests = [];
  const {doc, el} = fakeDocument();
  await mount(doc, {fetcher: directoryFetcher(requests)});
  await tick();
  assert.deepEqual(pageTitles(el), ['项目简报', '运维手册', '会议记录']);
  assert.equal(el('filter-all-count').textContent, '3');
  assert.equal(el('list-empty').hidden, true);
  assert.ok(!requests.some((row) => row.path.includes('q=')));

  await openFirstPage(el);
  await tick();
  assert.equal(el('editor-form').hidden, false);
  assert.equal(el('editor-form').elements.title.value, '项目简报');
  const afterOpen = requests.length;
  assert.ok(afterOpen > 0);

  el('search').value = 'zzz-no-match';
  el('search').handlers.input();
  await tick();
  assert.equal(requests.length, afterOpen, JSON.stringify(requests.slice(afterOpen)));
  assert.equal(el('editor-form').hidden, false);
  assert.equal(el('editor-form').elements.title.value, '项目简报');
  assert.equal(el('memory-list').children.length, 0);
  assert.equal(el('list-empty').hidden, false);
  assert.equal(el('list-empty').textContent, MEMORY_EMPTY_NO_MATCH);
  assert.equal(el('filter-all-count').textContent, '3');

  el('search').value = '运维';
  el('search').handlers.input();
  await tick();
  assert.equal(requests.length, afterOpen);
  assert.equal(el('editor-form').hidden, false);
  assert.deepEqual(pageTitles(el), ['运维手册']);
  assert.equal(el('filter-all-count').textContent, '3');
  assert.equal(el('list-empty').hidden, true);

  el('search').focused = false;
  el('search').handlers.keydown({key: 'Escape', preventDefault() {}});
  await tick();
  assert.equal(requests.length, afterOpen);
  assert.equal(el('search').value, '');
  assert.equal(el('search').focused, true);
  assert.deepEqual(pageTitles(el), ['项目简报', '运维手册', '会议记录']);
  assert.equal(el('filter-all-count').textContent, '3');
  assert.equal(el('list-empty').hidden, true);
  assert.equal(el('editor-form').hidden, false);
  assert.equal(el('editor-form').elements.title.value, '项目简报');
});

test('updated filter count only counts pages edited in the last seven days', async () => {
  const { recentlyUpdatedCount } = await import('../openteamily/static/memory/app.mjs');
  const now = Date.UTC(2026, 10, 19) ;
  const day = 86400;
  assert.equal(recentlyUpdatedCount([{ updated: now / 1000 - day }, { updated: now / 1000 - 8 * day }, {}], now), 1);
  assert.equal(recentlyUpdatedCount(null, now), 0);
});
