import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  websiteTitle, websiteStub, websitePrompt, saveableSocialMessage, saveableAgentMessage,
  socialSavePath, agentSavePath, defaultSaveTitle, conversationChatHref, messengerHref,
  parseMessengerHash, describeWebsiteDispatch, spaceHref, escapeHtml,
} from '../openteamily/static/shell/thumb.mjs';
import {
  csrfCookie, listQuery, visibleArtifacts, artifactMatchesType,
  artifactMatchesModified, viewFromSearch, queryForView, FILE_TYPE_LABELS,
  sessionFilterChoices, applyDirectoryCollapsed, artifactDeletePrompt, mount,
  meetingRows, meetingActionLabel, meetingTimeLabel, meetingsForScope,
} from '../openteamily/static/artifacts/app.mjs';

test('csrfCookie reads host-bound and development cookie names only', () => {
  assert.equal(csrfCookie('__Host-ot_csrf=token-a'), 'token-a');
  assert.equal(csrfCookie('ot_dev_session=x; ot_dev_csrf=token-b'), 'token-b');
  assert.equal(csrfCookie('csrf=nope; other=1'), '');
});

test('listQuery encodes search and omits empty q', () => {
  assert.equal(listQuery(''), '');
  assert.equal(listQuery('  brief '), '?q=brief');
});

test('visibleArtifacts filters by kind, saved messages and creator', () => {
  const items = [
    {title: 'Doc', kind: 'document', created_by: 'alice'},
    {title: 'Site', kind: 'website', created_by: 'bob'},
    {title: 'Clip', kind: 'document', created_by: 'alice', source: {kind: 'agent_message', id: 'm1'}},
  ];
  assert.deepEqual(visibleArtifacts(items, {kind: 'website'}).map((item) => item.title), ['Site']);
  assert.deepEqual(visibleArtifacts(items, {kind: 'messages'}).map((item) => item.title), ['Clip']);
  assert.deepEqual(visibleArtifacts(items, {kind: 'meetings'}).map((item) => item.title), []);
  assert.deepEqual(visibleArtifacts(items, {scope: 'mine', username: 'alice'}).map((item) => item.title), ['Doc', 'Clip']);
  assert.deepEqual(visibleArtifacts(items, {scope: 'favorites'}).map((item) => item.title), []);
  assert.deepEqual(visibleArtifacts(items, {scope: 'memory'}).map((item) => item.title), []);
});

test('visibleArtifacts maps recorded filters onto existing fields', () => {
  const now = Date.parse('2026-11-17T02:30:00Z');
  const items = [
    {title: 'Doc', kind: 'document', created_by: 'alice', updated: now / 1000 - 60},
    {title: 'Site', kind: 'website', created_by: 'bob', updated: now / 1000 - 60},
    {title: 'Photo', kind: 'media', created_by: 'alice', updated: now / 1000 - 60, media: {mime: 'image/png'}},
    {title: 'Old', kind: 'document', created_by: 'alice', updated: now / 1000 - 40 * 24 * 60 * 60},
    {title: 'Task', kind: 'document', created_by: 'alice', updated: now / 1000 - 60,
      source: {kind: 'agent_task', conversation_id: 'c1'}},
    {title: 'Clip', kind: 'document', created_by: 'alice', updated: now / 1000 - 60,
      source: {kind: 'agent_message', conversation_id: 'c2'}},
  ];
  assert.equal(FILE_TYPE_LABELS.length, 13);
  assert.equal(artifactMatchesType(items[0], '云文档'), true);
  assert.equal(artifactMatchesType(items[5], '云文档'), false);
  assert.equal(artifactMatchesType(items[2], '图片'), true);
  assert.equal(artifactMatchesType(items[0], 'Markdown'), false);
  assert.equal(artifactMatchesType({kind: 'slides'}, '幻灯片'), true);
  assert.equal(artifactMatchesType({kind: 'document'}, '幻灯片'), false);
  assert.deepEqual(visibleArtifacts(items, {types: ['网页']}).map((item) => item.title), ['Site']);
  assert.deepEqual(visibleArtifacts(items, {types: ['消息']}).map((item) => item.title), ['Clip']);
  assert.deepEqual(visibleArtifacts(items, {types: ['Markdown']}).map((item) => item.title), []);
  assert.deepEqual(visibleArtifacts(items, {modified: 'today', now}).map((item) => item.title),
                   ['Doc', 'Site', 'Photo', 'Task', 'Clip']);
  assert.deepEqual(visibleArtifacts(items, {modified: 'custom', now}).map((item) => item.title),
                   items.map((item) => item.title));
  assert.deepEqual(visibleArtifacts(items, {creators: ['bob']}).map((item) => item.title), ['Site']);
  assert.deepEqual(visibleArtifacts(items, {sessions: ['c2']}).map((item) => item.title), ['Clip']);
  assert.deepEqual(visibleArtifacts(items, {scope: 'memory'}).map((item) => item.title), ['Task']);
  assert.equal(artifactMatchesModified(items[3], 'd30', now), false);
  assert.equal(artifactMatchesModified(items[3], 'd90', now), true);
});

test('sessionFilterChoices uses conversation titles instead of raw ids', () => {
  const choices = sessionFilterChoices([
    {title: 'Clip', source: {kind: 'agent_message', conversation_id: 'c2', conversation_title: '晨会'}},
    {title: 'Again', source: {kind: 'agent_message', conversation_id: 'c2', conversation_title: '晨会'}},
    {title: 'Other', source: {kind: 'agent_message', conversation_id: 'c1'}},
    {title: 'Plain', kind: 'document'},
  ]);
  assert.deepEqual(choices, [
    {id: 'c1', label: '对话'},
    {id: 'c2', label: '晨会'},
  ]);
  assert.equal(choices.some((row) => row.label === 'c1' || row.label === 'c2'), false);
});

test('viewFromSearch and queryForView stay on the recorded allowlist', () => {
  assert.deepEqual(viewFromSearch(''), {kind: 'all', scope: 'all'});
  assert.deepEqual(viewFromSearch('?view=created'), {kind: 'all', scope: 'mine'});
  assert.deepEqual(viewFromSearch('?view=starred'), {kind: 'all', scope: 'favorites'});
  assert.deepEqual(viewFromSearch('?view=memory'), {kind: 'all', scope: 'memory'});
  assert.deepEqual(viewFromSearch('?view=meetings'), {kind: 'meetings', scope: 'all'});
  assert.deepEqual(viewFromSearch('?view=unknown'), {kind: 'all', scope: 'all'});
  assert.equal(queryForView('all', 'all'), '');
  assert.equal(queryForView('all', 'mine'), '?view=created');
  assert.equal(queryForView('all', 'favorites'), '?view=starred');
  assert.equal(queryForView('all', 'memory'), '?view=memory');
  assert.equal(queryForView('meetings', 'all'), '?view=meetings');
});

test('applyDirectoryCollapsed hides the directory in session only', () => {
  const nodes = {};
  const el = (id, extra = {}) => {
    const node = {
      id,
      hidden: false,
      className: '',
      attributes: {},
      classList: {
        toggle(name, on) {
          const parts = new Set((node.className || '').split(/\s+/).filter(Boolean));
          if (on) parts.add(name);
          else parts.delete(name);
          node.className = [...parts].join(' ');
        },
      },
      setAttribute(key, value) {
        node.attributes[key] = value;
      },
      getAttribute(key) {
        return node.attributes[key];
      },
    };
    Object.assign(node, extra);
    nodes[id] = node;
    return node;
  };
  el('list-panel');
  el('artifact-dir');
  el('dir-collapse', {attributes: {'aria-expanded': 'true'}});
  el('dir-expand', {hidden: true});
  const root = {getElementById: (id) => nodes[id] || null};

  assert.equal(applyDirectoryCollapsed(root, true), true);
  assert.equal(nodes['artifact-dir'].hidden, true);
  assert.equal(nodes['dir-expand'].hidden, false);
  assert.equal(nodes['list-panel'].className.includes('dir-collapsed'), true);
  assert.equal(nodes['dir-collapse'].getAttribute('aria-expanded'), 'false');

  assert.equal(applyDirectoryCollapsed(root, false), false);
  assert.equal(nodes['artifact-dir'].hidden, false);
  assert.equal(nodes['dir-expand'].hidden, true);
  assert.equal(nodes['list-panel'].className.includes('dir-collapsed'), false);
  assert.equal(nodes['dir-collapse'].getAttribute('aria-expanded'), 'true');
});

class FakeNode {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.handlers = {};
    this.dataset = {};
    this.attributes = {};
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.className = '';
    this.parentNode = null;
    this._text = '';
    this.classList = {
      add() {}, remove() {},
      toggle(name, on) { this._last = [name, on]; },
      contains() { return false; },
    };
  }
  get textContent() {
    if (this.children.length) return this.children.map(child => child.textContent).join('');
    return this._text;
  }
  set textContent(value) { this.children = []; this._text = String(value); }
  get options() { return this.children.filter(child => child.tagName === 'OPTION'); }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(type, handler) { (this.handlers[type] ||= []).push(handler); }
  removeEventListener(type, handler) {
    this.handlers[type] = (this.handlers[type] || []).filter(item => item !== handler);
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    if (this.tagName === 'SELECT' && !this.value) this.value = child.value || '';
    return child;
  }
  append(...nodes) {
    for (const node of nodes) this.appendChild(typeof node === 'string' ? {textContent: node, parentNode: null} : node);
  }
  insertBefore(child, before) {
    child.parentNode = this;
    const index = before ? this.children.indexOf(before) : -1;
    if (index < 0) this.children.push(child);
    else this.children.splice(index, 0, child);
    return child;
  }
  replaceChildren(...nodes) {
    this.children = [];
    this._text = '';
    for (const node of nodes) this.appendChild(node);
  }
  removeChild(child) { this.children = this.children.filter(item => item !== child); child.parentNode = null; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  contains(child) { return child === this || this.children.includes(child); }
  focus() { if (this.ownerDocument) this.ownerDocument._activeElement = this; }
  getContext() { return {fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {}, fillText() {}}; }
  async dispatch(type, event = {}) {
    if (!event.preventDefault) event.preventDefault = () => {};
    for (const handler of this.handlers[type] || []) await handler(event);
  }
}

function fakeDocument() {
  const elements = new Map();
  const created = [];
  const doc = {
    cookie: '',
    _activeElement: null,
    get activeElement() { return this._activeElement; },
    getElementById(id) {
      if (!elements.has(id)) {
        const tags = {workspace: 'select', search: 'input', 'editor-form': 'form', 'artifact-list': 'ul'};
        const node = new FakeNode(tags[id] || 'div');
        node.ownerDocument = doc;
        elements.set(id, node);
      }
      return elements.get(id);
    },
    createElement(tag) {
      const node = new FakeNode(tag);
      node.ownerDocument = doc;
      created.push(node);
      return node;
    },
    createTextNode(text) {
      const node = new FakeNode('#text');
      node.textContent = text;
      node.ownerDocument = doc;
      created.push(node);
      return node;
    },
    querySelectorAll(selector) {
      if (doc.kindButtons && String(selector).includes('data-kind')) return doc.kindButtons;
      return [];
    },
    querySelector() { return null; },
    addEventListener(type, handler) { (doc.handlers[type] ||= []).push(handler); },
    removeEventListener(type, handler) {
      doc.handlers[type] = (doc.handlers[type] || []).filter(item => item !== handler);
    },
    async dispatch(type, event = {}) {
      if (!event.preventDefault) event.preventDefault = () => {};
      for (const handler of doc.handlers[type] || []) await handler(event);
    },
    handlers: {},
  };
  const form = doc.getElementById('editor-form');
  form.elements = {title: new FakeNode('input'), body: new FakeNode('textarea')};
  return {doc, elements, created, form};
}

function reply({status = 200, body = {}} = {}) {
  return {status, json: async () => body};
}

async function openArtifactsPage({items = [], artifact, meetings = [], meetingsStatus = 200, meetingsError = null,
                                  withKinds = false, workspaces = [{id: 'w1', name: 'Desk'}], tasks = [], saveReply = null} = {}) {
  const {doc, elements, created, form} = fakeDocument();
  if (withKinds) {
    doc.kindButtons = ['all', 'website', 'document', 'media', 'messages', 'meetings'].map((kind) => {
      const node = new FakeNode('button');
      node.setAttribute('data-kind', kind);
      node.ownerDocument = doc;
      return node;
    });
  }
  const calls = [];
  const saveCalls = [];
  let listed = items.slice();
  const target = artifact || {id: 'a1', title: 'Doc', kind: 'document', revision: 1, body: 'hello', created_by: 'alice'};
  const fetcher = async (path, options = {}) => {
    const method = options.method || 'GET';
    calls.push({method, path, headers: options.headers || {}, body: options.body});
    if (path === '/v1/auth/session') return reply({body: {user: {id: 'u1', username: 'alice'}}});
    if (path === '/v1/auth/providers') return reply({body: {items: []}});
    if (path === '/v1/workspaces?limit=100') return reply({body: {items: workspaces}});
    if (path === '/v1/workspaces/w2/artifacts') return reply({body: {items: []}});
    if (path === '/v1/workspaces/w1/artifacts') return reply({body: {items: listed}});
    if (path === '/v1/workspaces/w1/meetings?limit=50') {
      if (meetingsStatus !== 200) return reply({status: meetingsStatus, body: meetingsError || {}});
      return reply({body: {items: meetings, cursor: null}});
    }
    if (path === '/v1/runtime/tasks' && method === 'GET') return reply({body: {items: tasks}});
    const taskSave = /^\/v1\/runtime\/tasks\/([0-9a-f]+)\/artifact$/.exec(path);
    if (taskSave && method === 'POST') {
      saveCalls.push({id: taskSave[1], body: options.body ? JSON.parse(options.body) : null});
      if (saveReply) return reply(saveReply);
      const task = tasks.find((row) => row.id === taskSave[1]);
      const saved = {id: 'a9', title: `${task.prompt} · 任务结果`, kind: 'document', created_by: 'alice'};
      listed = [saved, ...listed];
      return reply({status: 201, body: {artifact: saved}});
    }
    const detail = /^\/v1\/workspaces\/w1\/artifacts\/([^/]+)(\/(shares|versions|discover))?$/.exec(path);
    if (detail && method === 'GET') {
      if (detail[3] === 'shares') return reply({body: {items: []}});
      if (detail[3] === 'versions') return reply({body: {items: []}});
      if (detail[3] === 'discover') return reply({body: {discover: {}}});
      if (detail[1] === target.id) return reply({body: {artifact: target}});
      const row = listed.find(item => item.id === detail[1]);
      if (row) return reply({body: {artifact: {...row, revision: 1, body: 'hello'}}});
    }
    if (path === '/v1/workspaces/w1/artifacts/a1/remove') {
      listed = [];
      return reply({status: 200});
    }
    throw new Error(`unexpected request: ${method} ${path}`);
  };
  const saved = globalThis.document;
  globalThis.document = doc;
  let mounted = false;
  try {
    await mount(doc, {fetcher});
    mounted = true;
  } finally {
    if (!mounted) {
      if (saved === undefined) delete globalThis.document; else globalThis.document = saved;
    }
  }
  return {
    doc, elements, created, form, calls, saveCalls,
    async openKind(kind) {
      const button = (doc.kindButtons || []).find((node) => node.getAttribute('data-kind') === kind);
      assert.ok(button, `kind button ${kind} must exist`);
      await button.dispatch('click');
    },
    meetingCalls() { return calls.filter(call => call.path === '/v1/workspaces/w1/meetings?limit=50'); },
    removeCalls() { return calls.filter(call => call.path === '/v1/workspaces/w1/artifacts/a1/remove'); },
    alertdialog() { return created.filter(node => node.getAttribute('role') === 'alertdialog' && node.parentNode); },
    close() {
      if (saved === undefined) delete globalThis.document; else globalThis.document = saved;
    },
  };
}

function cardOf(dialog) {
  return dialog.children.find(child => String(child.className || '').includes('send-dialog-card')) || dialog;
}

function artifactRows(list) {
  return list.children.filter(child => String(child.className || '').split(/\s+/).includes('artifact-item'));
}

async function openEditorOn(page, index = 0) {
  const list = page.elements.get('artifact-list');
  const row = artifactRows(list)[index];
  assert.ok(row, `the list must render artifact row ${index} first`);
  await row.children[0].dispatch('click');
}

test('artifactDeletePrompt names the artifact and never echoes an empty title', () => {
  assert.deepEqual(artifactDeletePrompt({title: 'Doc'}), {
    question: '删除「Doc」？', detail: '删除后不能恢复。', cancelLabel: '取消', confirmLabel: '确认',
  });
  assert.equal(artifactDeletePrompt({title: '  '}).question, '删除这个作品？');
  assert.equal(artifactDeletePrompt(null).question, '删除这个作品？');
});

test('clicking remove asks first and sends no request until the answer is yes', async () => {
  const page = await openArtifactsPage({items: [{id: 'a1', title: 'Doc', kind: 'document', created_by: 'alice'}]});
  try {
    await openEditorOn(page);
    const trigger = page.elements.get('remove-artifact');
    assert.equal(trigger.hidden, false);
    void trigger.dispatch('click');
    assert.equal(page.removeCalls().length, 0, 'opening the question must not send the delete request');
    const dialogs = page.alertdialog();
    assert.equal(dialogs.length, 1, 'one inline alertdialog must exist');
    const box = dialogs[0];
    assert.equal(box.getAttribute('aria-labelledby'), 'remove-artifact-question');
    const question = box.children.find(child => child.id === 'remove-artifact-question');
    assert.equal(question.textContent, '删除「Doc」？');
    assert.deepEqual(box.children.filter(child => child.tagName === 'BUTTON').map(child => child.textContent), ['取消', '确认']);
    assert.equal(trigger.hidden, true);
    const buttons = box.children.filter(child => child.tagName === 'BUTTON');
    assert.equal(page.doc.activeElement, buttons[0], 'focus starts on the cancel button');
  } finally {
    page.close();
  }
});

test('cancel and Escape keep the artifact and send nothing', async () => {
  for (const how of ['cancel', 'escape']) {
    const page = await openArtifactsPage({items: [{id: 'a1', title: 'Doc', kind: 'document', created_by: 'alice'}]});
    try {
      await openEditorOn(page);
      const trigger = page.elements.get('remove-artifact');
      const list = page.elements.get('artifact-list');
      const statusText = page.elements.get('status').textContent;
      const rowsBefore = list.children.length;
      const pending = trigger.dispatch('click');
      const box = page.alertdialog()[0];
      const choice = box.children.filter(child => child.tagName === 'BUTTON');
      if (how === 'cancel') await choice[0].dispatch('click');
      else await page.doc.dispatch('keydown', {key: 'Escape'});
      await pending;
      assert.equal(page.removeCalls().length, 0, `no delete request after ${how}`);
      assert.equal(page.alertdialog().length, 0, `the question closes after ${how}`);
      assert.equal(trigger.hidden, false, `the remove button returns after ${how}`);
      assert.equal(page.doc.activeElement, trigger, `focus returns to remove after ${how}`);
      assert.equal(list.children.length, rowsBefore, `the list is unchanged after ${how}`);
      assert.equal(page.elements.get('status').textContent, statusText, `the status line is unchanged after ${how}`);
    } finally {
      page.close();
    }
  }
});

test('confirming deletes the artifact exactly once and clears it from the list', async () => {
  const page = await openArtifactsPage({items: [{id: 'a1', title: 'Doc', kind: 'document', created_by: 'alice'}]});
  try {
    await openEditorOn(page);
    const trigger = page.elements.get('remove-artifact');
    const pending = trigger.dispatch('click');
    const box = page.alertdialog()[0];
    await box.children.filter(child => child.tagName === 'BUTTON')[1].dispatch('click');
    await pending;
    assert.equal(page.removeCalls().length, 1);
    assert.equal(page.elements.get('status').textContent, '已删除。');
    assert.equal(page.elements.get('status').dataset.kind, 'ok');
    assert.equal(page.elements.get('artifact-list').children.length, 0);
    assert.equal(page.elements.get('editor-form').hidden, true);
    assert.equal(page.elements.get('list-panel').hidden, false);
  } finally {
    page.close();
  }
});

test('library layout applies actual grid/list presentation state without changing data', async () => {
  const {applyArtifactLayout} = await import('../openteamily/static/artifacts/app.mjs');
  const row = {id: 'persisted-work'};
  const list = {dataset: {}, children: [row]};
  assert.equal(applyArtifactLayout(list, 'grid'), 'grid');
  assert.equal(list.dataset.layout, 'grid');
  assert.equal(applyArtifactLayout(list, 'list'), 'list');
  assert.equal(list.dataset.layout, 'list');
  assert.equal(applyArtifactLayout(list, 'unknown'), 'grid');
  assert.equal(list.children[0], row);
});

test('switching workspace retires a delete question aimed at the workspace it left', async () => {
  const page = await openArtifactsPage({
    items: [{id: 'a1', title: 'W1 作品', kind: 'document', created_by: 'alice'}],
    artifact: {id: 'a1', title: 'W1 作品', kind: 'document', revision: 1, body: 'hello', created_by: 'alice'},
    workspaces: [{id: 'w1', name: 'Desk'}, {id: 'w2', name: 'Studio'}],
  });
  try {
    await openEditorOn(page);
    page.elements.get('remove-artifact').dispatch('click');
    const box = page.alertdialog()[0];
    assert.ok(box, 'clicking remove asks the user first');
    const question = box.children.find((node) => node.id === 'remove-artifact-question');
    assert.equal(question.textContent, '删除「W1 作品」？');

    page.elements.get('workspace').value = 'w2';
    await page.elements.get('workspace').dispatch('change');
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(
      page.alertdialog().length,
      0,
      'the question must not keep asking about a workspace the page has left',
    );
    assert.deepEqual(
      page.calls.filter((call) => call.method === 'POST').map((call) => call.path),
      [],
      'switching workspace while the question is open must delete nothing',
    );
  } finally {
    page.close();
  }
});

test('returning to the list retires the delete question', async () => {
  const page = await openArtifactsPage({
    items: [{id: 'a1', title: '每日简报', kind: 'document', created_by: 'alice'}],
    artifact: {id: 'a1', title: '每日简报', kind: 'document', revision: 1, body: 'hello', created_by: 'alice'},
  });
  try {
    await openEditorOn(page);
    void page.elements.get('remove-artifact').dispatch('click');
    assert.equal(page.alertdialog().length, 1, 'clicking remove asks the user first');

    await page.elements.get('cancel-editor').dispatch('click');
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(
      page.alertdialog().length,
      0,
      'going back to the list must not leave the delete question hanging over it',
    );
    assert.deepEqual(
      page.calls.filter((call) => call.method === 'POST').map((call) => call.path),
      [],
      'nothing is deleted by leaving the editor',
    );
  } finally {
    page.close();
  }
});

test('opening another artifact never inherits the previous delete question', async () => {
  const page = await openArtifactsPage({
    items: [
      {id: 'a1', title: '每日简报', kind: 'document', created_by: 'alice'},
      {id: 'a2', title: '周报', kind: 'document', created_by: 'alice'},
    ],
    artifact: {id: 'a1', title: '每日简报', kind: 'document', revision: 1, body: 'hello', created_by: 'alice'},
  });
  try {
    const list = page.elements.get('artifact-list');
    await artifactRows(list)[0].children[0].dispatch('click');
    void page.elements.get('remove-artifact').dispatch('click');
    assert.equal(page.alertdialog().length, 1, 'clicking remove asks the user first');

    await page.elements.get('cancel-editor').dispatch('click');
    await new Promise((resolve) => setImmediate(resolve));
    await artifactRows(list)[1].children[0].dispatch('click');
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(
      page.alertdialog().length,
      0,
      'the question about the first artifact must not follow the editor into the second one',
    );
    const posts = page.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/remove'));
    assert.equal(posts.length, 0, 'opening a second artifact deletes nothing');
    const form = page.elements.get('editor-form');
    assert.equal(form.hidden, false, 'the second artifact is open in the editor');
  } finally {
    page.close();
  }
});

test('the confirmation keeps the target it captured even if the picker moves without an event', async () => {
  const page = await openArtifactsPage({
    items: [{id: 'a1', title: '每日简报', kind: 'document', created_by: 'alice'}],
    artifact: {id: 'a1', title: '每日简报', kind: 'document', revision: 1, body: 'hello', created_by: 'alice'},
    workspaces: [{id: 'w1', name: 'Desk'}, {id: 'w2', name: 'Studio'}],
  });
  try {
    await openEditorOn(page);
    void page.elements.get('remove-artifact').dispatch('click');
    const box = page.alertdialog()[0];
    assert.ok(box, 'clicking remove asks the user first');

    page.elements.get('workspace').value = 'w2';
    box.children.filter(child => child.tagName === 'BUTTON')[1].dispatch('click');
    await new Promise((resolve) => setImmediate(resolve));

    const posts = page.calls.filter((call) => call.method === 'POST');
    assert.deepEqual(
      posts.map((call) => call.path),
      ['/v1/workspaces/w1/artifacts/a1/remove'],
      'the answer must delete the artifact the question named, in the workspace it named',
    );
  } finally {
    page.close();
  }
});

test('opening an artifact straight from a stale list clears the question', async () => {
  const page = await openArtifactsPage({
    items: [
      {id: 'a1', title: '每日简报', kind: 'document', created_by: 'alice'},
      {id: 'a2', title: '周报', kind: 'document', created_by: 'alice'},
    ],
    artifact: {id: 'a1', title: '每日简报', kind: 'document', revision: 1, body: 'hello', created_by: 'alice'},
  });
  try {
    const list = page.elements.get('artifact-list');
    await artifactRows(list)[0].children[0].dispatch('click');
    void page.elements.get('remove-artifact').dispatch('click');
    assert.equal(page.alertdialog().length, 1, 'clicking remove asks the user first');

    await artifactRows(list)[1].children[0].dispatch('click');
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(
      page.alertdialog().length,
      0,
      'opening another artifact must clear a question the editor still holds',
    );
    assert.equal(
      page.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/remove')).length,
      0,
      'opening another artifact deletes nothing',
    );
  } finally {
    page.close();
  }
});

test('library item badges and times are derived from real artifact fields', async () => {
  const { kindBadge, artifactTime } = await import('../openteamily/static/artifacts/app.mjs');
  assert.equal(kindBadge('document'), 'DOC');
  assert.equal(kindBadge('website'), 'WEB');
  assert.equal(kindBadge('unknown'), 'FILE');
  assert.equal(artifactTime(0), '');
  const now = new Date(2026, 10, 19, 15, 0).getTime();
  assert.equal(artifactTime(new Date(2026, 10, 19, 9, 5).getTime() / 1000, now), '今天 09:05');
  assert.equal(artifactTime(new Date(2026, 10, 2, 18, 30).getTime() / 1000, now), '11月2日 18:30');
});


test('canSendArtifactToChat enables every persisted work type, not missing IDs', async () => {
  const {canSendArtifactToChat, conversationLabel} = await import('../openteamily/static/artifacts/app.mjs');
  assert.equal(canSendArtifactToChat({id: 'a', kind: 'media'}), true);
  assert.equal(canSendArtifactToChat({id: 'a', kind: 'document'}), true);
  assert.equal(canSendArtifactToChat({id: 'a', kind: 'website'}), true);
  assert.equal(canSendArtifactToChat({kind: 'media'}), false);
  assert.equal(conversationLabel({title: 'Project room'}), 'Project room');
  assert.equal(conversationLabel({kind: 'dm', members: [{username: 'alice'}, {username: 'bob'}]}), 'alice、bob');
  assert.equal(conversationLabel({kind: 'group'}), '群聊');
  assert.equal(conversationLabel({kind: 'dm'}), '单聊');
});

import { newKindFromSearch, newKindButtonId } from '../openteamily/static/artifacts/app.mjs';

test('?new= only opens known 新建 editors', () => {
  assert.equal(newKindFromSearch('?new=document'), 'document');
  assert.equal(newKindButtonId('document'), 'new-artifact');
  assert.equal(newKindButtonId(newKindFromSearch('?new=whiteboard')), 'new-board');
  assert.equal(newKindFromSearch('?new=constructor'), '');
  assert.equal(newKindFromSearch(''), '');
  assert.equal(newKindButtonId('image'), '');
});

test('meetingRows sorts newest first and labels action items honestly', () => {
  const rows = meetingRows([
    {id: 'm1', title: '周会', started_at: 1700000000, action_count: 2, done_count: 1},
    {id: 'm2', title: '评审', started_at: 1700003600, action_count: 0, done_count: 0},
    {id: 'm3', title: '复盘', started_at: 1699996400, action_count: 3, done_count: 3},
  ]);
  assert.deepEqual(rows.map((row) => row.title), ['评审', '周会', '复盘']);
  assert.equal(rows[0].actionLabel, '尚无行动项');
  assert.equal(rows[1].actionLabel, '2 项行动项，1 项已完成');
  assert.equal(rows[2].actionLabel, '3 项行动项，全部完成');
  assert.equal(meetingActionLabel(1, 0), '1 项行动项');
  assert.equal(meetingActionLabel(undefined, undefined), '尚无行动项');
  assert.match(meetingTimeLabel(1700000000), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(meetingTimeLabel(0), '');
  assert.equal(meetingTimeLabel('nope'), '');
});

test('meetingsForScope keeps the workspace list unless the joined scope is selected', () => {
  const items = [
    {id: 'm1', title: '周会', attendees: ['alice'], created_by: 'u2'},
    {id: 'm2', title: '评审', attendees: ['bob'], created_by: 'u2'},
    {id: 'm3', title: '复盘', attendees: [], created_by: 'u1'},
  ];
  assert.deepEqual(meetingsForScope(items).map((row) => row.id), ['m1', 'm2', 'm3']);
  assert.deepEqual(meetingsForScope(items, {scope: 'all'}).map((row) => row.id), ['m1', 'm2', 'm3']);
  assert.deepEqual(
    meetingsForScope(items, {scope: 'joined', username: 'alice', userId: 'u1'}).map((row) => row.id),
    ['m1', 'm3'],
  );
  assert.deepEqual(meetingsForScope(items, {scope: 'joined', username: 'ALICE'}).map((row) => row.id), ['m1']);
  assert.deepEqual(meetingsForScope(items, {scope: 'joined'}).map((row) => row.id), []);
});

test('the meetings kind renders the workspace meetings from the existing endpoint', async () => {
  const page = await openArtifactsPage({withKinds: true, meetings: [
    {id: 'm1', title: '设计周会', started_at: 1700000000, action_count: 2, done_count: 0},
    {id: 'm2', title: '发布复盘', started_at: 1700007200, action_count: 1, done_count: 1},
  ]});
  try {
    await page.openKind('meetings');
    assert.equal(page.meetingCalls().length, 1, 'the meetings tab reads the endpoint once');
    assert.equal(page.meetingCalls()[0].method, 'GET');
    const list = page.elements.get('artifact-list');
    const rows = list.children.filter((child) => String(child.className || '').includes('artifact-item'));
    assert.equal(rows.length, 2, 'two meetings must be listed');
    assert.match(rows[0].textContent, /发布复盘/);
    assert.match(rows[1].textContent, /设计周会/);
    assert.match(rows[0].textContent, /1 项行动项，全部完成/);
    assert.match(rows[1].textContent, /2 项行动项/);
    assert.equal(page.elements.get('empty-meetings').hidden, true);
    assert.equal(page.elements.get('meetings-error').hidden, true);
  } finally {
    page.close();
  }
});

test('an empty meetings workspace shows the honest empty state, not an error', async () => {
  const page = await openArtifactsPage({withKinds: true, meetings: []});
  try {
    await page.openKind('meetings');
    assert.equal(page.elements.get('empty-meetings').hidden, false);
    assert.equal(page.elements.get('meetings-error').hidden, true);
    assert.equal(page.elements.get('meetings-error').textContent, '');
  } finally {
    page.close();
  }
});

test('a failing meetings request shows the server reason instead of an empty list', async () => {
  const page = await openArtifactsPage({
    withKinds: true, meetingsStatus: 500,
    meetingsError: {error: {code: 'internal', message: 'listing failed in the store'}},
  });
  try {
    await page.openKind('meetings');
    const errorBox = page.elements.get('meetings-error');
    assert.equal(errorBox.hidden, false);
    assert.match(errorBox.textContent, /listing failed in the store/);
    assert.equal(page.elements.get('empty-meetings').hidden, true, 'a failure must not read as "no meetings"');
    const list = page.elements.get('artifact-list');
    assert.equal(list.children.filter((child) => String(child.className || '').includes('artifact-item')).length, 0);
  } finally {
    page.close();
  }
});

// The artworks empty state is the place a user learns how content gets into the
// library. Its image entry claimed there was no way to save a chat picture even
// though the chat composer uploads every attachment into this same library
// before it sends the message, so the disabled promise was simply false.

test('the artworks empty state points at the real chat picture flow', () => {
  const html = readFileSync(new URL('../openteamily/static/artifacts/index.html', import.meta.url), 'utf8');
  const start = html.indexOf('id="empty-save-image"');
  assert.ok(start > -1, 'the starred empty state still offers a picture entry');
  const open = html.lastIndexOf('<', start);
  const tag = html.slice(open, html.indexOf('>', start) + 1);
  assert.match(tag, /^<a\b/, 'the picture entry must be a real link, not a disabled button');
  assert.match(tag, /href="\/chat"/, 'it has to reach the page that can actually attach a picture');
  assert.doesNotMatch(tag, /\bdisabled\b/, 'a working entry cannot be disabled');
  const copy = html.slice(open, html.indexOf('</a>', start)).replace(/\s+/g, ' ');
  assert.doesNotMatch(copy, /未实现/, 'the copy must not claim the feature is missing');
  assert.match(copy, /作品库/, 'the copy names where the picture lands');
});

test('saving a completed task artifact posts the task id and lists the document', async () => {
  const page = await openArtifactsPage({
    items: [],
    tasks: [
      {id: 'abc123', status: 'succeeded', prompt: '整理周报', workspace_id: 'w1', result: {text: '周报正文'}},
      {id: 'def456', status: 'running', prompt: '还在跑', workspace_id: 'w1', result: {}},
      {id: 'aaa999', status: 'succeeded', prompt: '空结果', workspace_id: 'w1', result: {text: '   '}},
    ],
  });
  try {
    await page.doc.getElementById('empty-save-agent').dispatch('click');
    assert.equal(page.calls.some(call => call.path === '/v1/runtime/tasks' && call.method === 'GET'), true,
                 'the agent save panel must read the real task list');
    const dialog = page.created.find(node => node.id === 'agent-task-dialog');
    assert.ok(dialog, 'the panel is rendered');
    assert.equal(dialog.getAttribute('role'), 'dialog');
    const rows = cardOf(dialog).children.find(child => child.id === 'agent-task-list').children;
    assert.equal(rows.length, 1, 'only succeeded tasks with text results are offered');
    assert.match(rows[0].textContent, /整理周报/);
    const save = rows[0].children.filter(child => child.tagName === 'BUTTON')[0];
    assert.equal(save.textContent, '保存');
    await save.dispatch('click');
    assert.equal(page.saveCalls.length, 1);
    assert.equal(page.saveCalls[0].id, 'abc123');
    assert.deepEqual(page.saveCalls[0].body, {workspace_id: 'w1'});
    assert.equal(page.elements.get('status').textContent, '已保存。');
    const list = page.elements.get('artifact-list');
    const titles = artifactRows(list).map(row => row.textContent);
    assert.equal(titles.some(text => text.includes('整理周报 · 任务结果')), true, 'the saved document joins the list');
  } finally {
    page.close();
  }
});

test('a refused save shows the server reason and keeps the task on screen', async () => {
  const page = await openArtifactsPage({
    items: [],
    tasks: [{id: 'abc123', status: 'succeeded', prompt: '整理周报', workspace_id: 'w1', result: {text: '正文'}}],
    saveReply: {status: 409, body: {error: {code: 'conflict', message: 'Only a succeeded task with a text result can be saved'}}},
  });
  try {
    await page.doc.getElementById('empty-save-agent').dispatch('click');
    const dialog = page.created.find(node => node.id === 'agent-task-dialog');
    const row = cardOf(dialog).children.find(child => child.id === 'agent-task-list').children[0];
    const save = row.children.filter(child => child.tagName === 'BUTTON')[0];
    await save.dispatch('click');
    const note = cardOf(dialog).children.find(child => child.id === 'agent-task-note');
    assert.equal(note.hidden, false, 'the failure is shown');
    assert.equal(note.textContent, 'Only a succeeded task with a text result can be saved');
    assert.equal(dialog.hidden, false, 'the panel stays open after a failure');
    assert.equal(save.disabled, false, 'the button is not flipped to a success state');
    assert.equal(artifactRows(page.elements.get('artifact-list')).length, 0, 'nothing was added to the list');
  } finally {
    page.close();
  }
});

test('an unauthorised save asks the user to sign in instead of failing silently', async () => {
  const page = await openArtifactsPage({
    items: [],
    tasks: [{id: 'abc123', status: 'succeeded', prompt: '整理周报', workspace_id: 'w1', result: {text: '正文'}}],
    saveReply: {status: 401, body: {error: {code: 'unauthorized', message: 'Sign in first'}}},
  });
  try {
    await page.doc.getElementById('empty-save-agent').dispatch('click');
    const dialog = page.created.find(node => node.id === 'agent-task-dialog');
    const row = cardOf(dialog).children.find(child => child.id === 'agent-task-list').children[0];
    await row.children.filter(child => child.tagName === 'BUTTON')[0].dispatch('click');
    const note = cardOf(dialog).children.find(child => child.id === 'agent-task-note');
    assert.equal(note.hidden, false);
    assert.match(note.textContent, /登录/);
    assert.equal(artifactRows(page.elements.get('artifact-list')).length, 0);
  } finally {
    page.close();
  }
});

test('favorites scope uses the persisted flag instead of inventing an empty collection', () => {
  const items = [{id:'a', kind:'document', favorited:true}, {id:'b', kind:'document', favorited:false}];
  assert.deepEqual(visibleArtifacts(items, {scope:'favorites'}).map(item=>item.id), ['a']);
});

test('an older workspace list cannot overwrite the current selected workspace', async () => {
  const {doc, elements} = fakeDocument();
  const saved = globalThis.document;
  globalThis.document = doc;
  let finishOld, announce;
  const firstStarted = new Promise(resolve => {announce=resolve;});
  const old = new Promise(resolve => {finishOld=resolve;});
  const fetcher = async path => {
    if (path === '/v1/auth/session') return reply({body:{user:{id:'u1',username:'alice'}}});
    if (path === '/v1/workspaces?limit=100') return reply({body:{items:[{id:'w1',name:'Old'}, {id:'w2',name:'New'}]}});
    if (path === '/v1/workspaces/w1/artifacts') { announce(); return old; }
    if (path === '/v1/workspaces/w2/artifacts') return reply({body:{items:[{id:'new',kind:'document',title:'New workspace document'}]}});
    throw new Error(path);
  };
  try {
    const mounted = mount(doc, {fetcher});
    await firstStarted;
    const picker = elements.get('workspace'); picker.value = 'w2';
    await picker.dispatch('change');
    await new Promise(resolve=>setImmediate(resolve));
    finishOld(reply({body:{items:[]}}));
    await mounted;
    assert.equal(elements.get('artifact-list').hidden, false);
    assert.equal(artifactRows(elements.get('artifact-list')).length, 1);
    assert.equal(artifactRows(elements.get('artifact-list'))[0].children[0].textContent, 'New workspace document');
  } finally { if (saved === undefined) delete globalThis.document; else globalThis.document=saved; }
});


test('saved result deep links require an exact authorized workspace and artifact id pair', async () => {
  const {artifactTargetFromSearch}=await import('../openteamily/static/artifacts/app.mjs');
  const wid='a'.repeat(32),aid='b'.repeat(32);
  assert.deepEqual(artifactTargetFromSearch('?workspace='+wid+'&artifact='+aid),{workspace:wid,artifact:aid});
  assert.equal(artifactTargetFromSearch('?new=document'),null);
  for(const query of ['?artifact='+aid,'?workspace='+wid,'?workspace=../private&artifact='+aid,'?workspace='+wid+'&artifact='+aid+'&artifact='+aid,'?workspace='+wid+'&artifact='+aid+'&new=document','?workspace='+wid+'&artifact='+aid+'&x=1'])assert.deepEqual(artifactTargetFromSearch(query),{invalid:true});
});

test('website helpers keep titles and escaped stubs bounded and honest', () => {
  assert.equal(websiteTitle('  给产品做介绍站  '), '网站：给产品做介绍站');
  assert.equal(websiteTitle('x'.repeat(80)).startsWith('网站：'), true);
  assert.ok(websiteTitle('x'.repeat(80)).length <= 50);
  assert.equal(websiteTitle('   '), '新网站');
  assert.match(websiteStub('<script>'), /&lt;script&gt;/);
  assert.doesNotMatch(websiteStub('<script>alert(1)</script>'), /<script>/);
  assert.equal(escapeHtml('a&b<"'), 'a&amp;b&lt;&quot;');
  assert.match(websitePrompt('站点', '需要首页和关于'), /作品标题：站点/);
  assert.match(websitePrompt('站点', '需要首页和关于'), /需要首页和关于/);
});

test('saveable messages require real text and reject retracted or unfinished rows', () => {
  assert.equal(saveableSocialMessage({body: '你好', revision: 1}), true);
  assert.equal(saveableSocialMessage({body: '  ', revision: 1}), false);
  assert.equal(saveableSocialMessage({body: '你好', retracted: 1}), false);
  assert.equal(saveableSocialMessage({body: '语音消息', revision: 1, voice: {mime: 'audio/webm'}}), false);
  assert.equal(saveableAgentMessage({body: '完成稿', status: 'succeeded'}), true);
  assert.equal(saveableAgentMessage({body: '完成稿', status: 'queued'}), false);
  assert.equal(defaultSaveTitle('  第一段内容  '), '第一段内容');
  const wid = 'a'.repeat(32), cid = 'b'.repeat(32), mid = 'c'.repeat(32), aid = 'd'.repeat(32);
  assert.equal(
    socialSavePath(wid, cid, mid),
    `/v1/workspaces/${wid}/social/conversations/${cid}/messages/${mid}/save`,
  );
  assert.equal(
    agentSavePath(wid, aid, cid, mid),
    `/v1/workspaces/${wid}/agents/${aid}/conversations/${cid}/messages/${mid}/artifact`,
  );
});

test('deep links point at existing space and chat routes, not invented pages', () => {
  const wid = 'a'.repeat(32), id = 'b'.repeat(32), aid = 'c'.repeat(32);
  assert.equal(spaceHref(), '/space');
  assert.equal(spaceHref(wid), '/space?workspace=' + wid);
  assert.equal(spaceHref(wid, id), '/space?workspace=' + wid + '&artifact=' + id);
  assert.equal(conversationChatHref(wid, {source: 'social', id}), '/chat#workspace=' + wid + '&social=' + id);
  assert.equal(
    conversationChatHref(wid, {source: 'agent', id, agent_id: aid}),
    '/chat#workspace=' + wid + '&agent=' + aid + '&conversation=' + id,
  );
  assert.equal(messengerHref(wid, id), '/messenger#workspace=' + wid + '&conversation=' + id);
  assert.deepEqual(parseMessengerHash('#workspace=' + wid + '&conversation=' + id), {
    workspace: wid, conversation: id,
  });
  assert.deepEqual(parseMessengerHash(''), {workspace: '', conversation: ''});
});

test('website dispatch copy distinguishes queued work from a missing runtime', () => {
  assert.match(describeWebsiteDispatch({status: 'queued', task_id: 't1'}), /发出搭建请求/);
  assert.match(describeWebsiteDispatch({status: 'queued', error_code: 'no_agent'}), /没有在线运行时/);
  assert.match(describeWebsiteDispatch({error_code: 'quota'}), /quota/);
  assert.match(describeWebsiteDispatch(null), /未能发出搭建请求/);
});
