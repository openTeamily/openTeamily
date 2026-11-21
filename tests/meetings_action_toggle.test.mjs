// Ticking an action item on /meetings writes that meeting back at once,
// through the existing edit route, without pressing 保存.
import assert from 'node:assert/strict';
import test from 'node:test';

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.dataset = {};
    this.attributes = {};
    this.handlers = {};
    this.children = [];
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.checked = false;
    this.type = '';
    this.className = '';
    this._text = '';
  }
  get textContent() { return this._text; }
  set textContent(value) {
    this._text = String(value);
    if (this._text === '') this.children = [];
  }
  get innerText() { return this._text; }
  get classList() {
    const element = this;
    const names = () => element.className.split(/\s+/).filter(Boolean);
    return {
      add(name) {
        if (!names().includes(name)) element.className = [...names(), name].join(' ');
      },
      remove(name) { element.className = names().filter((item) => item !== name).join(' '); },
      contains(name) { return names().includes(name); },
      toggle(name, force) {
        if (force === true) { this.add(name); return true; }
        if (force === false) { this.remove(name); return false; }
        if (this.contains(name)) { this.remove(name); return false; }
        this.add(name);
        return true;
      },
    };
  }
  addEventListener(type, handler) { (this.handlers[type] ||= []).push(handler); }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
  removeAttribute(name) { delete this.attributes[name]; }
  // A real <select> selects its first option once one exists.
  pickFirstOption() {
    if (this.tagName !== 'select' || this.value) return;
    const first = this.children.find((child) => child.tagName === 'option');
    if (first) this.value = first.value;
  }
  appendChild(child) { this.children.push(child); this.pickFirstOption(); return child; }
  append(...nodes) { for (const node of nodes) this.children.push(node); this.pickFirstOption(); }
  replaceChildren(...nodes) { this.children = nodes; this.pickFirstOption(); }
  reset() {}
  get options() { return this.children.filter((child) => child.tagName === 'option'); }
}

function fakeDocument() {
  const elements = new Map();
  const doc = {
    readyState: 'complete',
    cookie: 'ot_dev_csrf=test',
    getElementById(id) {
      if (!elements.has(id)) {
        const tag = id === 'workspace' ? 'select' : id === 'meeting-form' ? 'form' : 'div';
        elements.set(id, new FakeElement(tag));
      }
      return elements.get(id);
    },
    createElement(tag) { return new FakeElement(tag); },
    createTextNode(text) { const node = new FakeElement('#text'); node.textContent = text; return node; },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
  return {doc, elements};
}

const WORKSPACE = 'a'.repeat(32);
const MEETING_ID = 'b'.repeat(32);

function meeting(id = MEETING_ID, revision = 3, actions = [
  {text: 'A', done: false, owner: ''},
  {text: 'B', done: false, owner: ''},
]) {
  return {
    id, workspace_id: WORKSPACE, title: 'Weekly', started_at: 1800000000,
    attendees: ['alice'], revision, created_by: 'alice', updated_by: 'alice',
    summary: '', transcript: '', action_items: actions.map((item) => ({...item})),
    action_count: actions.length,
    done_count: actions.filter((item) => item.done).length,
  };
}

async function mountPage(tag, { revokeWith = 200 } = {}) {
  const {doc, elements} = fakeDocument();
  const state = {calls: [], body: meeting(), posted: [], revokeWith};
  const json = (status, payload) => ({status, json: async () => payload});
  const fetcher = async (path, options = {}) => {
    const method = options.method || 'GET';
    state.calls.push(`${method} ${path}`);
    if (path === '/v1/auth/session') return json(200, {user: {username: 'alice'}});
    if (path === '/v1/workspaces?limit=100') return json(200, {items: [{id: WORKSPACE, name: 'Team'}]});
    if (path === `/v1/workspaces/${WORKSPACE}/meetings?limit=100`) {
      return json(200, {items: [{
        id: MEETING_ID, title: state.body.title, started_at: state.body.started_at,
        attendees: state.body.attendees, done_count: state.body.done_count,
        action_count: state.body.action_count,
      }], cursor: null});
    }
    if (path === `/v1/workspaces/${WORKSPACE}/meetings/${MEETING_ID}` && method === 'GET') {
      return json(200, {meeting: state.body});
    }
    if (path === `/v1/workspaces/${WORKSPACE}/meetings/${MEETING_ID}` && method === 'POST') {
      const payload = JSON.parse(options.body || '{}');
      state.posted.push(payload);
      if (revokeWith !== 200) return json(revokeWith, {error: {message: 'Meeting changed elsewhere; reload and retry'}});
      state.body = {
        ...state.body,
        revision: state.body.revision + 1,
        action_items: payload.changes.action_items.map((item) => ({...item})),
        done_count: payload.changes.action_items.filter((item) => item.done).length,
        action_count: payload.changes.action_items.length,
      };
      return json(200, {meeting: state.body});
    }
    throw new Error('unexpected ' + method + ' ' + path);
  };
  const saved = {document: globalThis.document, fetch: globalThis.fetch, FormData: globalThis.FormData};
  globalThis.document = doc;
  globalThis.fetch = fetcher;
  const restore = () => {
    if (saved.document === undefined) delete globalThis.document; else globalThis.document = saved.document;
    if (saved.fetch === undefined) delete globalThis.fetch; else globalThis.fetch = saved.fetch;
    globalThis.FormData = saved.FormData;
  };
  await import('../openteamily/static/meetings/app.mjs?toggle=' + tag);
  await settle();
  return {doc, elements, state, restore};
}

async function settle() {
  for (let i = 0; i < 14; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function checkbox(doc, index) {
  const row = doc.getElementById('action-list').children[index];
  const label = row && row.children[2];
  return label && label.children[0];
}

test('ticking an action item writes the meeting back without pressing 保存', async () => {
  const {doc, state, restore} = await mountPage('tick-' + Math.random());
  try {
    const box = checkbox(doc, 0);
    assert.equal(typeof box?.handlers.change?.[0], 'function', 'the action checkbox is wired to save on change');
    box.checked = true;
    await box.handlers.change[0]();
    await settle();

    assert.equal(state.posted.length, 1, 'one edit request goes out for one tick');
    const payload = state.posted[0];
    assert.equal(payload.revision, 3, 'the request carries the revision the page holds');
    assert.deepEqual(Object.keys(payload.changes), ['action_items'], 'only action_items is sent, so other fields are not clobbered');
    assert.deepEqual(payload.changes.action_items, [
      {text: 'A', done: true, owner: ''},
      {text: 'B', done: false, owner: ''},
    ], 'only the ticked item flips');
    assert.equal((await doc.getElementById('status').textContent).trim(), '已标记完成。');
    assert.match(doc.getElementById('meeting-list').children[0].children[0].children[1].textContent, /1\/2 行动项/,
      'the list count follows the tick');
    assert.match(doc.getElementById('meeting-meta').textContent, /修订 4/);
  } finally {
    restore();
  }
});

test('a stale revision reverts the tick and says the meeting moved on', async () => {
  const {doc, state, restore} = await mountPage('conflict-' + Math.random(), {revokeWith: 409});
  try {
    const box = checkbox(doc, 0);
    assert.equal(typeof box?.handlers.change?.[0], 'function', 'the action checkbox is wired to save on change');
    box.checked = true;
    await box.handlers.change[0]();
    await settle();

    assert.equal(state.posted.length, 1, 'the page tried once');
    assert.equal(box.checked, false, 'the tick goes back to the server state');
    assert.equal((await doc.getElementById('status').textContent).trim(), '会议已在别处更新，请重新打开后再勾选。');
    assert.equal(doc.getElementById('status').dataset.kind, 'error');
  } finally {
    restore();
  }
});

test('a new meeting that was never saved only changes locally', async () => {
  const {doc, elements, state, restore} = await mountPage('new-' + Math.random());
  try {
    // No saved meeting selected: the form is empty and no id is held.
    elements.get('new-meeting').handlers.click[0]();
    await settle();
    elements.get('add-action').handlers.click[0]();
    await settle();
    const box = checkbox(doc, 0);
    assert.equal(typeof box?.handlers.change?.[0], 'function', 'the checkbox still works before the first save');
    box.checked = true;
    await box.handlers.change[0]();
    await settle();
    assert.equal(state.posted.length, 0, 'nothing is written for a meeting that does not exist yet');
  } finally {
    restore();
  }
});
