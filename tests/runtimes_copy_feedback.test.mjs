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
    this.textContent = '';
    this.className = '';
    this.type = '';
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
  const saved = {document: globalThis.document, fetch: globalThis.fetch};
  globalThis.document = doc;
  globalThis.fetch = fetcher;
  return () => {
    if (saved.document === undefined) delete globalThis.document; else globalThis.document = saved.document;
    if (saved.fetch === undefined) delete globalThis.fetch; else globalThis.fetch = saved.fetch;
  };
}

function installClipboard(writeText) {
  const navigator = globalThis.navigator;
  const had = Object.prototype.hasOwnProperty.call(navigator, 'clipboard');
  const previous = had ? navigator.clipboard : undefined;
  if (writeText) Object.defineProperty(navigator, 'clipboard', {value: {writeText}, configurable: true});
  else Object.defineProperty(navigator, 'clipboard', {value: undefined, configurable: true});
  return () => {
    if (had) Object.defineProperty(navigator, 'clipboard', {value: previous, configurable: true});
    else delete navigator.clipboard;
  };
}

async function settle() {
  for (let i = 0; i < 6; i += 1) await new Promise(resolve => setImmediate(resolve));
}

async function mountRuntimes(tag) {
  const {doc} = fakeDocument();
  const fetcher = async (path) => {
    if (path === '/v1/auth/session') return {status: 200, json: async () => ({user: {username: 'alice'}})};
    if (path === '/v1/runtime-keys') return {status: 200, json: async () => ({device_id: 'desk', items: []})};
    if (path === '/v1/runtime/connections') return {status: 200, json: async () => ({items: []})};
    if (path === '/v1/runtime/tasks') return {status: 200, json: async () => ({items: []})};
    throw new Error('unexpected ' + path);
  };
  // Mirror the served markup: an idle 「复制」 button and an empty, hidden receipt slot.
  doc.getElementById('copy-install').textContent = '复制';
  doc.getElementById('copy-install-feedback').hidden = true;
  const restore = installGlobals(doc, fetcher);
  await import('../openteamily/static/runtimes/app.mjs?copy_feedback=' + tag);
  await settle();
  return {doc, restore};
}

test('copying the install command shows a receipt on the button itself, then reverts after two seconds', async (t) => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let written = '';
  const restoreClipboard = installClipboard(async (text) => { written = text; });
  const {doc, restore} = await mountRuntimes('success-' + Math.random());
  t.after(() => { restore(); restoreClipboard(); });
  const button = doc.getElementById('copy-install');
  const feedback = doc.getElementById('copy-install-feedback');
  const status = doc.getElementById('status');
  assert.equal(typeof button.handlers.click?.[0], 'function', 'the copy button is wired');

  await button.handlers.click[0]();

  assert.match(written, /flybot\.pyz/, 'the install command reaches the clipboard');
  assert.equal(button.textContent, '已复制', 'the button itself reports the copy');
  assert.equal(feedback.textContent, '已复制安装命令', 'a readable receipt next to the button reports the copy');
  assert.equal(feedback.hidden, false, 'the receipt next to the button is visible');
  assert.equal(status.textContent, '已复制安装命令。', 'the page-level status line keeps its existing wording');

  t.mock.timers.tick(2000);

  assert.equal(button.textContent, '复制', 'the button returns to its idle label');
  assert.equal(feedback.textContent, '', 'the in-place receipt clears after two seconds');
  assert.equal(feedback.hidden, true, 'the in-place receipt is hidden again after two seconds');
});

test('a second click restarts the two-second window instead of stacking timers', async (t) => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let writes = 0;
  const restoreClipboard = installClipboard(async () => { writes += 1; });
  const {doc, restore} = await mountRuntimes('double-click-' + Math.random());
  t.after(() => { restore(); restoreClipboard(); });
  const button = doc.getElementById('copy-install');
  const feedback = doc.getElementById('copy-install-feedback');

  await button.handlers.click[0]();
  t.mock.timers.tick(1000);
  await button.handlers.click[0]();
  t.mock.timers.tick(1000); // the first click's two seconds are up here

  assert.equal(writes, 2, 'both clicks reach the clipboard');
  assert.equal(button.textContent, '已复制', 'the first click\'s timer does not clear the second click\'s receipt');
  assert.equal(feedback.hidden, false, 'the receipt is still visible at the first click\'s two-second mark');

  t.mock.timers.tick(1000); // the second click's two seconds are up here

  assert.equal(button.textContent, '复制', 'the receipt reverts two seconds after the last click');
  assert.equal(feedback.textContent, '', 'the receipt text clears two seconds after the last click');
  assert.equal(feedback.hidden, true, 'the receipt is hidden two seconds after the last click');
});

test('a rejected clipboard write keeps the button idle and reports the existing error', async (t) => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const restoreClipboard = installClipboard(async () => { throw new Error('denied'); });
  const {doc, restore} = await mountRuntimes('reject-' + Math.random());
  t.after(() => { restore(); restoreClipboard(); });
  const button = doc.getElementById('copy-install');
  const feedback = doc.getElementById('copy-install-feedback');
  const status = doc.getElementById('status');

  await button.handlers.click[0]();

  assert.equal(button.textContent, '复制', 'a rejected write does not claim success on the button');
  assert.equal(feedback.textContent, '', 'a rejected write leaves the in-place receipt empty');
  assert.equal(feedback.hidden, true, 'a rejected write leaves the in-place receipt hidden');
  assert.equal(status.textContent, '无法复制，请手动复制命令。', 'a rejected write keeps the existing error wording');
  assert.equal(status.dataset.kind, 'error', 'a rejected write reports the error state');
});

test('the copy button keeps its label when the clipboard is unavailable', async (t) => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const restoreClipboard = installClipboard(undefined);
  const {doc, restore} = await mountRuntimes('no-clipboard-' + Math.random());
  t.after(() => { restore(); restoreClipboard(); });
  const button = doc.getElementById('copy-install');
  const feedback = doc.getElementById('copy-install-feedback');
  const status = doc.getElementById('status');

  await button.handlers.click[0]();

  assert.equal(button.textContent, '复制', 'a failed copy does not claim success on the button');
  assert.equal(feedback.textContent, '', 'a failed copy leaves the in-place receipt empty');
  assert.equal(status.textContent, '这个浏览器不能复制到剪贴板，请手动复制命令。', 'the failure still goes to the status line');
});
