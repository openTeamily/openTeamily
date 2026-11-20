// The runtime API-key flow on /runtimes: a 201 must land in the list right
// away, and revoking must ask once before it reaches the server.
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
    this._text = '';
    this.className = '';
    this.type = '';
  }
  // Assigning textContent replaces the children, exactly like the real DOM,
  // so a re-render does not leave the previous rows behind.
  get textContent() { return this._text; }
  set textContent(value) {
    this._text = String(value);
    if (this._text === '') this.children = [];
  }
  addEventListener(type, handler) { (this.handlers[type] ||= []).push(handler); }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
  appendChild(child) { this.children.push(child); return child; }
  reset() {}
}

function fakeDocument() {
  const elements = new Map();
  const doc = {
    readyState: 'complete',
    cookie: '',
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeElement(id.endsWith('-form') ? 'form' : 'div'));
      return elements.get(id);
    },
    querySelectorAll() { return []; },
    querySelector() { return new FakeElement(); },
    createElement(tag) { return new FakeElement(tag); },
  };
  return {doc, elements};
}

function installGlobals(doc, fetcher) {
  const saved = {document: globalThis.document, fetch: globalThis.fetch, FormData: globalThis.FormData};
  globalThis.document = doc;
  globalThis.fetch = fetcher;
  globalThis.FormData = class {
    constructor(form) {
      this.form = form;
      this.values = new Map([
        ['name', doc.getElementById('key-name').value],
        ['expires', doc.getElementById('key-expires').value || 'never'],
      ]);
    }
    get(name) { return this.values.get(name) ?? null; }
  };
  return () => {
    if (saved.document === undefined) delete globalThis.document; else globalThis.document = saved.document;
    if (saved.fetch === undefined) delete globalThis.fetch; else globalThis.fetch = saved.fetch;
    globalThis.FormData = saved.FormData;
  };
}

async function settle() {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

// A DOM submit event's `currentTarget` is only set while the dispatch runs, so
// an async handler sees null once it resumes after an await.
function submitEvent(form) {
  let reads = 0;
  return {
    preventDefault() {},
    get currentTarget() {
      reads += 1;
      return reads === 1 ? form : null;
    },
  };
}

async function mountRuntimes(tag, items = []) {
  const {doc} = fakeDocument();
  const state = {items: items.map((item) => ({...item})), calls: []};
  doc.getElementById('key-expires').value = 'never';
  const keyForm = doc.getElementById('key-form');
  keyForm.reset = () => { doc.getElementById('key-name').value = ''; };
  const fetcher = async (path, options = {}) => {
    const method = options.method || 'GET';
    state.calls.push(`${method} ${path}`);
    if (path === '/v1/auth/session') return {status: 200, json: async () => ({user: {username: 'alice'}})};
    if (path === '/v1/runtime/connections') return {status: 200, json: async () => ({items: []})};
    if (path === '/v1/runtime/tasks') return {status: 200, json: async () => ({items: []})};
    if (path === '/v1/runtime-keys' && method === 'GET') {
      return {status: 200, json: async () => ({device_id: 'fbdev_test', items: state.items})};
    }
    if (path === '/v1/runtime-keys' && method === 'POST') {
      const body = JSON.parse(options.body || '{}');
      const created = {
        id: 'a'.repeat(32), name: body.name, prefix: 'abcd1234', created: 1,
        expires: body.expires_in || null, revoked: false,
      };
      state.items = [created, ...state.items];
      return {status: 201, json: async () => ({key: {...created}, token: 'otk_plaintext_secret'})};
    }
    const revoke = /^\/v1\/runtime-keys\/([0-9a-f]{32})\/revoke$/.exec(path);
    if (revoke && method === 'POST') {
      state.items = state.items.map((item) => (item.id === revoke[1] ? {...item, revoked: true} : item));
      const row = state.items.find((item) => item.id === revoke[1]);
      return {status: 200, json: async () => ({key: {...row}})};
    }
    throw new Error('unexpected ' + method + ' ' + path);
  };
  const restore = installGlobals(doc, fetcher);
  await import('../openteamily/static/runtimes/app.mjs?keys_flow=' + tag);
  await settle();
  return {doc, state, restore};
}

function rowButtons(doc, name) {
  const row = doc.getElementById('key-list').children.find(
    (child) => String(child.children[0]?.textContent || '').includes(name),
  );
  return row ? row.children.slice(1) : [];
}

test('a 201 puts the new key in the list, clears the name, and disables generate', async () => {
  const {doc, state, restore} = await mountRuntimes('created-' + Math.random());
  try {
    const name = 'dev4-key';
    doc.getElementById('key-name').value = name;
    await doc.getElementById('key-form').handlers.submit[0](submitEvent(doc.getElementById('key-form')));
    await settle();

    const listText = doc.getElementById('key-list').children
      .map((row) => row.children[0]?.textContent || '')
      .join(' | ');
    assert.match(listText, new RegExp(name), 'the key created in this submit is listed without a reload');
    assert.match(listText, /abcd1234…/, 'the list keeps the prefix form, never the full secret');
    assert.equal(listText.includes('otk_plaintext_secret'), false, 'the one-time secret never reaches the list');
    assert.equal(doc.getElementById('issued-token').textContent.includes('otk_plaintext_secret'), true,
      'the one-time secret is shown once, at generation time');
    assert.equal(doc.getElementById('key-name').value, '', 'the name field is cleared after the key exists');
    assert.equal(doc.getElementById('generate-key').disabled, true, 'generate goes back to disabled until a new name is typed');
    assert.equal(state.items.length, 1, 'exactly one key was created');
  } finally {
    restore();
  }
});

test('the first revoke click only asks; it sends nothing', async () => {
  const {doc, state, restore} = await mountRuntimes('revoke-first-' + Math.random(), [
    {id: 'b'.repeat(32), name: 'laptop', prefix: 'deadbeef', created: 1, expires: null, revoked: false},
  ]);
  try {
    const [revoke] = rowButtons(doc, 'laptop');
    assert.equal(revoke?.textContent, '撤销', 'the row offers a revoke button first');
    await revoke.handlers.click[0]();
    await settle();

    assert.deepEqual(state.calls.filter((call) => call.includes('/revoke')), [],
      'no request is sent before the user confirms');
    const after = rowButtons(doc, 'laptop').map((button) => button.textContent);
    assert.deepEqual(after, ['确认撤销', '取消'], 'the row asks for confirmation in place');
    assert.equal(state.items[0].revoked, false, 'the key is still usable while the question is open');
  } finally {
    restore();
  }
});

test('cancelling the inline confirmation restores the row and sends nothing', async () => {
  const {doc, state, restore} = await mountRuntimes('revoke-cancel-' + Math.random(), [
    {id: 'c'.repeat(32), name: 'desk', prefix: 'cafebabe', created: 1, expires: null, revoked: false},
  ]);
  try {
    await rowButtons(doc, 'desk')[0].handlers.click[0]();
    await settle();
    const cancel = rowButtons(doc, 'desk').find((button) => button.textContent === '取消');
    assert.equal(typeof cancel?.handlers.click?.[0], 'function', 'the confirmation offers a cancel');
    await cancel.handlers.click[0]();
    await settle();

    assert.deepEqual(state.calls.filter((call) => call.includes('/revoke')), [],
      'cancelling never reaches the server');
    assert.deepEqual(rowButtons(doc, 'desk').map((button) => button.textContent), ['撤销'],
      'the row goes back to its single revoke button');
    assert.equal(state.items[0].revoked, false, 'the key stays live after a cancel');
  } finally {
    restore();
  }
});

test('confirming revokes the key and the row shows 已撤销 with no buttons left', async () => {
  const {doc, state, restore} = await mountRuntimes('revoke-confirm-' + Math.random(), [
    {id: 'd'.repeat(32), name: 'server', prefix: 'feedface', created: 1, expires: null, revoked: false},
  ]);
  try {
    await rowButtons(doc, 'server')[0].handlers.click[0]();
    await settle();
    const confirm = rowButtons(doc, 'server').find((button) => button.textContent === '确认撤销');
    assert.equal(typeof confirm?.handlers.click?.[0], 'function', 'the confirmation offers a confirm');
    await confirm.handlers.click[0]();
    await settle();

    const posts = state.calls.filter((call) => call === `POST /v1/runtime-keys/${'d'.repeat(32)}/revoke`);
    assert.equal(posts.length, 1, 'confirming sends exactly one revoke request');
    assert.equal(state.items[0].revoked, true, 'the key is revoked on the server');
    const label = doc.getElementById('key-list').children[0].children[0].textContent;
    assert.match(label, /已撤销/, 'the row reports the revoked state');
    assert.deepEqual(rowButtons(doc, 'server'), [], 'a revoked key offers no further buttons');
  } finally {
    restore();
  }
});
