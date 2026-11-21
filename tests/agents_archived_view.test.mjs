import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { mount } from '../openteamily/static/agents/app.mjs';

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
    this.checked = false;
    this.value = '';
    this.textContent = '';
    this.className = '';
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
  querySelector(selector) {
    if (selector === 'button[type="submit"]') {
      if (!this._submit) {
        this._submit = new Element('button');
        this._submit.type = 'submit';
      }
      return this._submit;
    }
    return null;
  }
  focus() { this.focused = true; }
  closest(selector) {
    let node = this;
    while (node) {
      if (selector === 'button[data-id]' && node.tagName === 'BUTTON' && node.dataset.id) return node;
      if (selector === 'button[data-conversation]' && node.tagName === 'BUTTON' && node.dataset.conversation) return node;
      if (selector === 'button[data-restore]' && node.tagName === 'BUTTON' && node.dataset.restore) return node;
      node = node.parent;
    }
    return null;
  }
}

function fakeDocument() {
  const elements = new Map();
  const pills = ['all', 'content-creation', 'design', 'operations'].map((slug) => {
    const pill = new Element('button');
    pill.dataset.category = slug;
    return pill;
  });
  const doc = {
    cookie: '',
    getElementById(id) {
      if (!elements.has(id)) {
        const tag = id === 'workspace' || id === 'runtime-instance' || id === 'creator-filter' ? 'select'
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
            category: new Element('select'),
          };
          el.reset = () => { for (const field of Object.values(el.elements)) field.value = ''; };
        }
        elements.set(id, el);
      }
      return elements.get(id);
    },
    createElement(tag) { return new Element(tag); },
    querySelectorAll(selector) {
      return selector === '.filter-row .pill[data-category]' ? pills : [];
    },
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

// One active agent and one archived agent. The archived row only appears in the
// response when the page asks with include_archived=1, and a successful restore
// puts it back into the default list, exactly like the DS-Bot endpoint does.
function directoryFetcher(requests, {role = 'owner'} = {}) {
  const space = {id: 'ws-1', name: 'Desk', owner_id: 'user-1'};
  const user = {id: 'user-1', username: 'alice'};
  const members = [{user_id: 'user-1', username: 'alice', role}];
  const active = {id: 'ag-live', name: '写作助手', summary: '帮助起草文案', revision: 1,
    category: 'content-creation', created_by: 'user-1', archived: 0};
  const archived = {id: 'ag-old', name: '归档助手', summary: '以前负责周报', revision: 3,
    category: 'operations', created_by: 'user-1', archived: 1};
  const state = {archivedVisible: false, restored: false};
  const rows = () => {
    const list = [active];
    if (state.restored) list.push({...archived, archived: 0, revision: archived.revision + 1});
    else if (state.archivedVisible) list.push({...archived});
    return list;
  };
  const fetcher = async (path, options) => {
    const method = (options && options.method) || 'GET';
    const body = options && options.body ? JSON.parse(options.body) : undefined;
    requests.push({path, method, body});
    if (path === '/v1/auth/session') return json(200, {user});
    if (path === '/v1/workspaces?limit=100') return json(200, {items: [space]});
    if (path === '/v1/workspaces/ws-1') return json(200, {workspace: space});
    if (path === '/v1/workspaces/ws-1/members') return json(200, {items: members});
    if (path === '/v1/workspaces/ws-1/agents?limit=100') {
      state.archivedVisible = false;
      return json(200, {items: rows()});
    }
    if (path === '/v1/workspaces/ws-1/agents?limit=100&include_archived=1') {
      state.archivedVisible = true;
      return json(200, {items: rows()});
    }
    if (method === 'POST' && path === '/v1/workspaces/ws-1/agents/ag-old/archive') {
      if (!body || body.archived !== false) return json(400, {error: {code: 'invalid'}});
      state.restored = true;
      state.archivedVisible = false;
      return json(200, {agent: {...archived, archived: 0, revision: archived.revision + 1}});
    }
    if (path.match(/^\/v1\/workspaces\/ws-1\/agents\/[^/?]+$/)) return json(200, {agent: active});
    if (path.endsWith('/runtime')) return json(200, {runtime: null});
    if (path.includes('/instances?limit=100')) return json(200, {items: []});
    if (path.endsWith('/conversations?limit=100')) return json(200, {items: []});
    throw new Error('unexpected ' + path);
  };
  return {fetcher, state, members};
}

const names = (el) => el('agent-list').children.map((li) => li.children[1].children[0].textContent);
const restoreButton = (el) => el('agent-list').children
  .flatMap((li) => li.children)
  .find((node) => node.dataset && node.dataset.restore);

function withLocation(search, run) {
  const saved = {location: globalThis.location, history: globalThis.history, add: globalThis.addEventListener};
  globalThis.location = {pathname: '/agents', search, hash: ''};
  globalThis.history = {
    pushState(_s, _t, url) { globalThis.location.search = url.slice('/agents'.length); },
    replaceState(_s, _t, url) { globalThis.location.search = url.slice('/agents'.length); },
  };
  globalThis.addEventListener = () => {};
  return Promise.resolve(run()).finally(() => {
    globalThis.location = saved.location;
    globalThis.history = saved.history;
    globalThis.addEventListener = saved.add;
  });
}

function setArchivedToggle(el, checked) {
  const toggle = el('show-archived');
  toggle.checked = checked;
  assert.equal(typeof toggle.handlers.change, 'function',
    'the show-archived switch has no change handler');
  return toggle.handlers.change();
}

const agentRequests = (requests) => requests.filter((row) => /\/agents(?:\?|$)/.test(row.path));

test('the directory does not ask for archived agents until the switch is on', async () => {
  await withLocation('', async () => {
    const requests = [];
    const {fetcher} = directoryFetcher(requests);
    const {doc, el} = fakeDocument();
    const html = readFileSync(new URL('../openteamily/static/agents/index.html', import.meta.url), 'utf8');
    assert.match(html, /id="show-archived"/, 'the directory has no way to show archived agents');
    assert.match(html, /for="show-archived"/, 'the switch needs a label');
    await mount(doc, {fetcher});
    await tick();
    assert.deepEqual(names(el), ['写作助手']);
    assert.equal(el('show-archived-wrap').hidden, false,
      'the owner has no show-archived switch');
    const listed = agentRequests(requests).filter((row) => row.method === 'GET');
    assert.ok(listed.length > 0, 'the directory never loaded');
    assert.ok(listed.every((row) => !row.path.includes('include_archived')),
      'the default directory request carries include_archived');
    assert.equal(restoreButton(el), undefined, 'an active card rendered a restore button');
  });
});

test('turning the switch on lists archived agents with a restore button', async () => {
  await withLocation('', async () => {
    const requests = [];
    const {fetcher} = directoryFetcher(requests);
    const {doc, el} = fakeDocument();
    await mount(doc, {fetcher});
    await tick();
    await setArchivedToggle(el, true);
    await tick();
    assert.ok(requests.some((row) => row.path === '/v1/workspaces/ws-1/agents?limit=100&include_archived=1'),
      'the switch never asked the server for archived agents');
    assert.deepEqual(names(el), ['写作助手', '归档助手'], 'the archived agent is not in the archived view');
    const restore = restoreButton(el);
    assert.ok(restore, 'the archived card has no restore button');
    assert.equal(restore.textContent, '恢复');
    assert.equal(restore.dataset.revision, '3');
  });
});

test('restoring sends the unarchive call and the card loses its archived controls', async () => {
  await withLocation('', async () => {
    const requests = [];
    const {fetcher, state} = directoryFetcher(requests);
    const {doc, el} = fakeDocument();
    await mount(doc, {fetcher});
    await tick();
    await setArchivedToggle(el, true);
    await tick();
    const restore = restoreButton(el);
    await el('agent-list').handlers.click({target: restore});
    await tick();
    const call = requests.find((row) => row.method === 'POST' && row.path.endsWith('/ag-old/archive'));
    assert.ok(call, 'the restore button did not call the archive endpoint');
    assert.equal(call.path, '/v1/workspaces/ws-1/agents/ag-old/archive');
    assert.deepEqual(call.body, {revision: 3, archived: false}, 'restore did not send archived:false with the revision');
    assert.equal(state.restored, true);
    assert.equal(restoreButton(el), undefined, 'the restored card still renders the restore button');
    assert.equal(el('agent-list').children.some((li) => li.children.some((node) => node.textContent === '已归档')), false,
      'the restored card still carries the archived tag');
    await setArchivedToggle(el, false);
    await tick();
    assert.deepEqual(names(el), ['写作助手', '归档助手'], 'the restored agent did not return to the default list');
    assert.equal(restoreButton(el), undefined, 'the restored card still renders the archived controls');
  });
});

test('members never see the archived switch or the restore button', async () => {
  await withLocation('', async () => {
    const requests = [];
    const {fetcher} = directoryFetcher(requests, {role: 'member'});
    const {doc, el} = fakeDocument();
    await mount(doc, {fetcher});
    await tick();
    assert.equal(el('show-archived-wrap').hidden, true, 'a member sees the archived switch');
    assert.equal(el('show-archived').disabled, true, 'a member can toggle the archived switch');
    assert.equal(restoreButton(el), undefined);
    assert.ok(agentRequests(requests).every((row) => !row.path.includes('include_archived')),
      'a member request asked for archived agents');
  });
});
