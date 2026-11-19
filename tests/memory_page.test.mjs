import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mount} from '../openteamily/static/memory/app.mjs';
import test from 'node:test';
import {actionQuery, applyDirectoryCollapsed, bindGraphNodeGestures, csrfCookie, directoryGroups, dueAtFromDate, dueDateValue, fillGraphHoverCard, formatTopics, applyMarkdown, graphHoverAllowed, graphLayout, graphPreviewModel, hideGraphHoverCard, listQuery, matchingMemoryPages, MEMORY_EMPTY_NO_MATCH, MEMORY_EMPTY_WORKSPACE, memoryPageFromSearch, memoryPageMeta, memoryPagePreview, memoryUpdatedLabel, parseTopics, queryForMemoryPage, showGraphHoverCard, topicTag} from '../openteamily/static/memory/app.mjs';

test('csrfCookie reads host-bound and development cookie names only', () => {
  assert.equal(csrfCookie('__Host-ot_csrf=token-a'), 'token-a');
  assert.equal(csrfCookie('ot_dev_session=x; ot_dev_csrf=token-b'), 'token-b');
  assert.equal(csrfCookie('csrf=nope; other=1'), '');
});

test('matchingMemoryPages filters titles in place without inventing body search', () => {
  const rows = [
    {id: 'a', title: '项目简报'},
    {id: 'b', title: '运维手册'},
    {id: 'c', title: 'Project Brief'},
  ];
  assert.deepEqual(matchingMemoryPages(rows, '').map((row) => row.id), ['a', 'b', 'c']);
  assert.deepEqual(matchingMemoryPages(rows, '运维').map((row) => row.title), ['运维手册']);
  assert.deepEqual(matchingMemoryPages(rows, '简报').map((row) => row.title), ['项目简报']);
  assert.deepEqual(matchingMemoryPages(rows, 'BRIEF').map((row) => row.title), ['Project Brief']);
  assert.equal(MEMORY_EMPTY_WORKSPACE, '这个工作区还没有记忆页。');
  assert.equal(MEMORY_EMPTY_NO_MATCH, '没有匹配的记忆页。试试其他关键词。');
});

test('listQuery and actionQuery encode filters and omit empty values', () => {
  assert.equal(listQuery(''), '');
  assert.equal(listQuery('brief'), '?q=brief');
  assert.equal(actionQuery('', 'open'), '?status=open');
  assert.equal(actionQuery('跟进', 'done'), '?q=%E8%B7%9F%E8%BF%9B&status=done');
  assert.equal(actionQuery('', ''), '');
});

test('due date helpers convert UTC calendar days', () => {
  assert.equal(dueAtFromDate(''), null);
  assert.equal(dueAtFromDate('2027-01-15'), Date.UTC(2027, 0, 15) / 1000);
  assert.equal(dueDateValue(Date.UTC(2027, 0, 15) / 1000), '2027-01-15');
  assert.equal(dueDateValue(null), '');
  assert.equal(dueDateValue('bad'), '');
});

test('parseTopics splits unique names and formatTopics joins them', () => {
  assert.deepEqual(parseTopics('Getting Started, wiki，Getting started'), ['Getting Started', 'wiki']);
  assert.equal(formatTopics(['Getting Started', 'wiki']), 'Getting Started，wiki');
  assert.equal(formatTopics([]), '');
});

test('graphLayout places a single node at the center and sorts a circle by id', () => {
  assert.deepEqual(graphLayout([]), []);
  assert.deepEqual(graphLayout([{id: 'b'}], 200, 100), [{id: 'b', x: 100, y: 50}]);
  const placed = graphLayout([{id: 'm2'}, {id: 'm1'}], 200, 200, 50);
  assert.equal(placed[0].id, 'm1');
  assert.equal(placed[1].id, 'm2');
  assert.equal(placed[0].x, 100);
  assert.equal(placed[0].y, 50);
  assert.equal(placed[1].x, 100);
  assert.equal(placed[1].y, 150);
});

test('memoryPageFromSearch and queryForMemoryPage stay on the recorded allowlist', () => {
  assert.equal(memoryPageFromSearch(''), 'overview');
  assert.equal(memoryPageFromSearch('?page=profile'), 'profile');
  assert.equal(memoryPageFromSearch('?page=todos'), 'actions');
  assert.equal(memoryPageFromSearch('?page=unknown'), 'overview');
  assert.equal(queryForMemoryPage('overview'), '');
  assert.equal(queryForMemoryPage('profile'), '?page=profile');
  assert.equal(queryForMemoryPage('actions'), '?page=todos');
  assert.equal(memoryPageFromSearch('?page=meetings'), 'overview');
  assert.equal(queryForMemoryPage('meetings'), '');
});

test('memoryUpdatedLabel uses a UTC calendar date and ignores bad values', () => {
  assert.equal(memoryUpdatedLabel(''), '');
  assert.equal(memoryUpdatedLabel(null), '');
  assert.equal(memoryUpdatedLabel('bad'), '');
  assert.equal(memoryUpdatedLabel(Date.UTC(2026, 10, 17) / 1000), '2026-11-17');
});

test('topicTag and memoryPageMeta render date plus hash tags without inventing a 新 badge', () => {
  assert.equal(topicTag(''), '');
  assert.equal(topicTag('  wiki  '), '#wiki');
  assert.equal(topicTag('#already'), '#already');
  assert.equal(memoryPageMeta({}), '');
  assert.equal(
    memoryPageMeta({updated: Date.UTC(2026, 10, 17) / 1000, topics: ['CI fixture', '#keep']}),
    '2026-11-17 · #CI fixture · #keep',
  );
  assert.equal(memoryPagePreview({}), '');
  assert.equal(memoryPagePreview({preview: '  First line of the page.  '}), 'First line of the page.');
});

test('directoryGroups clusters real topics and leaves untagged pages loose', () => {
  const pages = [
    {id: 'a', title: 'Alpha notes', topics: ['Work notes']},
    {id: 'b', title: 'Beta plan', topics: ['Work notes', 'Planning']},
    {id: 'c', title: 'Loose page', topics: []},
    {id: 'd', title: 'Planner', topics: ['Planning']},
  ];
  const grouped = directoryGroups(pages, [
    {name: 'Work notes', pages: [{id: 'a'}, {id: 'b'}], page_count: 2},
    {name: 'Planning', pages: [{id: 'b'}, {id: 'd'}], page_count: 2},
    {name: 'Empty leftover', pages: [{id: 'missing'}], page_count: 1},
  ]);
  assert.deepEqual(grouped.ungrouped.map((page) => page.id), ['c']);
  assert.deepEqual(grouped.groups.map((group) => [group.name, group.count, group.pages.map((page) => page.id)]), [
    ['Work notes', 2, ['a', 'b']],
    ['Planning', 2, ['b', 'd']],
  ]);
  assert.equal(grouped.groups.some((group) => group.name === 'Getting Started' || group.name === 'Empty leftover'), false);
});

test('directoryGroups still groups from page topics when the catalog is empty', () => {
  const grouped = directoryGroups(
    [{id: 'n1', title: 'Solo', topics: ['Planning']}, {id: 'n2', title: 'Other'}],
    [],
  );
  assert.deepEqual(grouped.ungrouped.map((page) => page.id), ['n2']);
  assert.deepEqual(grouped.groups.map((group) => [group.name, group.count, group.pages.map((page) => page.id)]), [
    ['Planning', 1, ['n1']],
  ]);
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
  el('memory-dir');
  el('dir-collapse', {attributes: {'aria-expanded': 'true'}});
  el('dir-expand', {hidden: true});
  const root = {getElementById: (id) => nodes[id] || null};

  assert.equal(applyDirectoryCollapsed(root, true), true);
  assert.equal(nodes['memory-dir'].hidden, true);
  assert.equal(nodes['dir-expand'].hidden, false);
  assert.equal(nodes['list-panel'].className.includes('dir-collapsed'), true);
  assert.equal(nodes['dir-collapse'].getAttribute('aria-expanded'), 'false');

  assert.equal(applyDirectoryCollapsed(root, false), false);
  assert.equal(nodes['memory-dir'].hidden, false);
  assert.equal(nodes['dir-expand'].hidden, true);
  assert.equal(nodes['list-panel'].className.includes('dir-collapsed'), false);
  assert.equal(nodes['dir-collapse'].getAttribute('aria-expanded'), 'true');
});

test('graphPreviewModel uses title, existing preview and topic tags', () => {
  assert.deepEqual(graphPreviewModel({}), {title: '', summary: '', tags: []});
  assert.deepEqual(
    graphPreviewModel({title: ' Welcome ', preview: '  First line.  ', topics: ['CI fixture', '#keep']}),
    {title: 'Welcome', summary: 'First line.', tags: ['#CI fixture', '#keep']},
  );
});

test('graphHoverAllowed hides the card on coarse pointers and 390-wide viewports', () => {
  assert.equal(graphHoverAllowed({pointerCoarse: false, viewportWidth: 1440}), true);
  assert.equal(graphHoverAllowed({pointerCoarse: true, viewportWidth: 1440}), false);
  assert.equal(graphHoverAllowed({pointerCoarse: false, viewportWidth: 390}), false);
  assert.equal(graphHoverAllowed({pointerCoarse: false, viewportWidth: 389}), false);
});

function hoverCard() {
  const child = (className) => {
    const node = {className, textContent: '', hidden: false};
    return node;
  };
  const title = child('graph-hover-title');
  const summary = child('graph-hover-summary');
  const tags = child('graph-hover-tags');
  const map = {
    '.graph-hover-title': title,
    '.graph-hover-summary': summary,
    '.graph-hover-tags': tags,
  };
  return {
    hidden: true,
    style: {},
    attributes: {},
    title,
    summary,
    tags,
    querySelector(sel) { return map[sel] || null; },
    setAttribute(key, value) { this.attributes[key] = value; },
    getAttribute(key) { return this.attributes[key]; },
    removeAttribute(key) { delete this.attributes[key]; },
  };
}

function gestureTarget() {
  const listeners = {};
  return {
    attributes: {},
    listeners,
    setAttribute(key, value) { this.attributes[key] = value; },
    getAttribute(key) { return this.attributes[key]; },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    dispatch(type, event = {}) {
      const payload = {key: event.key, preventDefault() {}, ...event};
      for (const fn of listeners[type] || []) fn(payload);
    },
  };
}

test('fillGraphHoverCard writes title, summary and tags and can hide empty rows', () => {
  const card = hoverCard();
  fillGraphHoverCard(card, {title: 'Alpha', summary: 'Hello', tags: ['#wiki']});
  assert.equal(card.title.textContent, 'Alpha');
  assert.equal(card.summary.textContent, 'Hello');
  assert.equal(card.summary.hidden, false);
  assert.equal(card.tags.textContent, '#wiki');
  fillGraphHoverCard(card, {title: 'Alpha', summary: '', tags: []});
  assert.equal(card.summary.hidden, true);
  assert.equal(card.tags.hidden, true);
});

test('bindGraphNodeGestures keeps click-to-open and adds dblclick and Enter', () => {
  const opened = [];
  const target = gestureTarget();
  bindGraphNodeGestures(target, {id: 'p1', title: 'Alpha'}, {openPage: (id) => opened.push(id), hoverAllowed: false});
  assert.equal(target.getAttribute('tabindex'), '0');
  assert.equal(target.getAttribute('role'), 'button');
  assert.equal(target.getAttribute('aria-label'), 'Alpha');
  target.dispatch('click');
  target.dispatch('dblclick');
  target.dispatch('keydown', {key: 'Enter'});
  assert.deepEqual(opened, ['p1', 'p1', 'p1']);
});

test('bindGraphNodeGestures shows a hover card after the delay and hides it on leave or Escape', async () => {
  const card = hoverCard();
  const target = gestureTarget();
  bindGraphNodeGestures(target, {id: 'p2', title: 'Beta', preview: 'Summary text', topics: ['wiki']}, {
    openPage() {},
    card,
    hoverAllowed: true,
    delayMs: 0,
    position: {left: 12, top: 24},
  });
  target.dispatch('pointerenter');
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(card.hidden, false);
  assert.equal(card.getAttribute('data-id'), 'p2');
  assert.equal(card.title.textContent, 'Beta');
  assert.equal(card.summary.textContent, 'Summary text');
  assert.equal(card.tags.textContent, '#wiki');
  assert.equal(card.style.left, '12px');
  assert.equal(card.style.top, '24px');
  target.dispatch('pointerleave');
  assert.equal(card.hidden, true);
  target.dispatch('pointerenter');
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(card.hidden, false);
  target.dispatch('keydown', {key: 'Escape'});
  assert.equal(card.hidden, true);
});

test('bindGraphNodeGestures does not open a hover card when hover is not allowed', async () => {
  const card = hoverCard();
  const target = gestureTarget();
  bindGraphNodeGestures(target, {id: 'p3', title: 'Gamma', preview: 'Nope'}, {
    openPage() {},
    card,
    hoverAllowed: false,
    delayMs: 0,
  });
  target.dispatch('pointerenter');
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(card.hidden, true);
  assert.equal(card.getAttribute('data-id'), undefined);
});

// The 「偏好」 block sits in the 我的资料 view and keeps its rows in local
// page state: adding and deleting must change the list without any request.

class PrefElement {
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
  appendChild(node) { this.append(node); return node; }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    if (this.tagName === 'SELECT' && !nodes.length) this.value = '';
    this.append(...nodes);
  }
  setAttribute(key, value) { this.attributes[key] = value; }
  getAttribute(key) { return this.attributes[key]; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(type, handler) { this.handlers[type] = handler; }
  querySelector(selector) {
    return this.children.find((child) => child.attributes.class === selector || child.className === selector) || null;
  }
  getBoundingClientRect() { return {left: 0, top: 0, width: 0, height: 0}; }
  focus() { this.focused = true; }
  click() { if (this.handlers.click) this.handlers.click({target: this, preventDefault() {}}); }
}

function prefDocument() {
  const elements = new Map();
  const body = new PrefElement('body');
  const doc = {
    cookie: '',
    body,
    defaultView: {location: {pathname: '/memory', search: '?page=profile'}, history: {replaceState() {}}},
    getElementById(id) {
      if (!elements.has(id)) {
        const tag = id === 'workspace' || id === 'action-filter' || id === 'new-action-page' || id === 'link-target' ? 'select'
          : id.endsWith('-form') ? 'form'
          : id === 'search' || id === 'topic-search' ? 'input'
          : id === 'graph-canvas' || id === 'graph-hover-card' ? 'svg'
          : 'div';
        const el = new PrefElement(tag);
        if (id === 'editor-form') {
          el.hidden = true;
          el.elements = {title: new PrefElement('input'), body: new PrefElement('textarea'), topics: new PrefElement('input')};
        }
        if (id === 'action-editor-form') {
          el.hidden = true;
          el.elements = {
            title: new PrefElement('input'), notes: new PrefElement('textarea'),
            status: new PrefElement('select'), due: new PrefElement('input'),
            memory_page_id: new PrefElement('select'),
          };
        }
        elements.set(id, el);
      }
      return elements.get(id);
    },
    createElement(tag) { return new PrefElement(tag); },
    createElementNS(_ns, tag) { return new PrefElement(tag); },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
  return {doc, el: (id) => doc.getElementById(id)};
}

const prefFlush = () => new Promise((resolve) => setImmediate(resolve));
const prefSettle = async (times = 8) => {
  for (let i = 0; i < times; i += 1) await prefFlush();
};
const prefJson = (status, body) => ({status, json: async () => body});

function prefFetcher(calls) {
  return async (path, options = {}) => {
    calls.push({path, method: options.method || 'GET'});
    if (path === '/v1/auth/session') return prefJson(200, {user: {id: 'user-1', username: 'alice'}});
    if (path === '/v1/settings') return prefJson(404, {});
    if (path === '/v1/workspaces') return prefJson(200, {items: [{id: 'ws-1', name: 'Desk', owner_id: 'user-1'}]});
    if (path === '/v1/workspaces/ws-1/memory') return prefJson(200, {items: []});
    if (path === '/v1/workspaces/ws-1/memory/actions') return prefJson(200, {items: []});
    if (path === '/v1/workspaces/ws-1/memory/graph') {
      return prefJson(200, {nodes: [], edges: [], topics: [], counts: {nodes: 0, edges: 0, topics: 0}});
    }
    if (path === '/v1/workspaces/ws-1/memory/profile') {
      return prefJson(200, {profile: {revision: 0, professional: '', work_style: '', communication: ''}});
    }
    throw new Error('unexpected ' + path);
  };
}

async function mountPreferences() {
  const {doc, el} = prefDocument();
  const calls = [];
  await mount(doc, {fetcher: prefFetcher(calls)});
  await prefSettle();
  return {doc, el, calls};
}

test('the 偏好 block starts empty and says how to fill it', async () => {
  const {el, calls} = await mountPreferences();
  assert.equal(el('profile-panel').hidden, false);
  assert.equal(el('preferences-empty').hidden, false);
  assert.equal(el('preferences-empty').textContent, '还没有偏好，加一条试试');
  assert.equal(el('preference-list').children.length, 0);
  assert.deepEqual(calls.filter((call) => call.method !== 'GET'), []);
});

test('adding a preference appends one row, clears the field and hides the empty state', async () => {
  const {el, calls} = await mountPreferences();
  el('preference-input').value = '回复用中文';
  el('add-preference').click();
  assert.equal(el('preference-list').children.length, 1);
  const row = el('preference-list').children[0];
  assert.equal(row.children[0].textContent, '回复用中文');
  assert.equal(row.children[1].textContent, '删除');
  assert.equal(el('preferences-empty').hidden, true);
  assert.equal(el('preference-input').value, '');
  assert.equal(el('preference-status').textContent, '已添加偏好。');
  assert.deepEqual(calls.filter((call) => call.method !== 'GET'), []);
});

test('an empty preference is not added and the status line says why', async () => {
  const {el} = await mountPreferences();
  el('preference-input').value = '   ';
  el('add-preference').click();
  assert.equal(el('preference-list').children.length, 0);
  assert.equal(el('preferences-empty').hidden, false);
  assert.equal(el('preference-status').textContent, '请先写一条偏好。');
});

test('deleting removes only that preference and brings the empty state back', async () => {
  const {el, calls} = await mountPreferences();
  for (const text of ['回复用中文', '会议纪要控制在 200 字']) {
    el('preference-input').value = text;
    el('add-preference').click();
  }
  assert.equal(el('preference-list').children.length, 2);
  el('preference-list').children[0].children[1].click();
  assert.equal(el('preference-list').children.length, 1);
  assert.equal(el('preference-list').children[0].children[0].textContent, '会议纪要控制在 200 字');
  assert.equal(el('preferences-empty').hidden, true);
  el('preference-list').children[0].children[1].click();
  assert.equal(el('preference-list').children.length, 0);
  assert.equal(el('preferences-empty').hidden, false);
  assert.equal(el('preference-status').textContent, '已删除偏好。');
  assert.deepEqual(calls.filter((call) => call.method !== 'GET'), []);
});

test('applyMarkdown wraps or prefixes the selected textarea text', () => {
  const area = {value: 'hello world', selectionStart: 0, selectionEnd: 5, setSelectionRange() {}, dispatchEvent() {}};
  assert.equal(applyMarkdown(area, 'bold'), '**hello** world');
  const empty = {value: '', selectionStart: 0, selectionEnd: 0, setSelectionRange() {}, dispatchEvent() {}};
  assert.equal(applyMarkdown(empty, 'h1'), '# 标题');
  const link = {value: 'docs', selectionStart: 0, selectionEnd: 4, setSelectionRange() {}, dispatchEvent() {}};
  assert.equal(applyMarkdown(link, 'link'), '[docs](https://)');
});

import { safeHref, markdownToBlocks, renderMarkdown, domToMarkdown } from '../openteamily/static/memory/rich.mjs';

function richDocument() {
  class Node {
    constructor(type, name, value) { this.nodeType = type; this.tagName = name ? name.toUpperCase() : undefined; this.nodeName = this.tagName || '#text'; this.nodeValue = value ?? null; this.childNodes = []; this.attrs = {}; this.parentNode = null; }
    get firstChild() { return this.childNodes[0] || null; }
    appendChild(child) { child.parentNode = this; this.childNodes.push(child); return child; }
    append(...kids) { for (const kid of kids) this.appendChild(typeof kid === 'string' ? new Node(3, null, kid) : kid); }
    removeChild(child) { this.childNodes = this.childNodes.filter(item => item !== child); return child; }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    getAttribute(key) { return key in this.attrs ? this.attrs[key] : null; }
    get textContent() { return this.nodeType === 3 ? this.nodeValue : this.childNodes.map(child => child.textContent).join(''); }
    set textContent(value) { this.childNodes = []; if (value) this.appendChild(new Node(3, null, String(value))); }
  }
  return {createElement: (name) => new Node(1, name), createTextNode: (text) => new Node(3, null, text)};
}

test('rich memory editor round-trips stored markdown through the DOM', () => {
  const doc = richDocument();
  const source = '# 标题\n\n一段 **加粗** 与 _斜体_ 和 `代码`，见 [[项目简报]]。\n\n- 第一点\n- 第二点\n\n1. 步骤一\n2. 步骤二\n\n> 引用\n\n```\ncode\n```\n\n---\n\n[链接](https://example.com)';
  const root = doc.createElement('div');
  renderMarkdown(doc, root, source);
  const once = domToMarkdown(root);
  const again = doc.createElement('div');
  renderMarkdown(doc, again, once);
  assert.equal(domToMarkdown(again), once);
  for (const part of ['# 标题', '**加粗**', '`代码`', '[[项目简报]]', '- 第一点', '1. 步骤一', '> 引用', '```', '---', '[链接](https://example.com)']) {
    assert.ok(once.includes(part), part);
  }
});

test('rich memory editor drops unsafe links and keeps a list nested in a paragraph', () => {
  assert.equal(safeHref('javascript:alert(1)'), '');
  assert.equal(safeHref('https://example.com/a'), 'https://example.com/a');
  assert.equal(safeHref('/memory'), '/memory');
  assert.ok(markdownToBlocks('# a\n\nb').length >= 2);
  const doc = richDocument();
  const root = doc.createElement('div');
  const p = root.appendChild(doc.createElement('p'));
  const ul = p.appendChild(doc.createElement('ul'));
  ul.appendChild(doc.createElement('li')).appendChild(doc.createTextNode('First point'));
  ul.appendChild(doc.createElement('li')).appendChild(doc.createTextNode('Second point'));
  assert.equal(domToMarkdown(root).trim(), '- First point\n- Second point');
});

// --- Issue #241: deleting a memory page or a next action must ask first. ---
// These tests import only symbols that exist on main today, and they build the
// fake document from the served HTML, so a control missing from the page cannot
// be invented by the harness. On main the two delete buttons post immediately,
// so the assertions fail as user-visible behaviour instead of as a missing
// export.

const memoryHtml = readFileSync(new URL('../openteamily/static/memory/index.html', import.meta.url), 'utf8');
const memoryTick = () => new Promise((resolve) => setImmediate(resolve));

class MemoryNode {
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
    this.checked = false;
    this.name = '';
    this.type = '';
    this.id = '';
    this.className = '';
    this.focused = false;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this._text = '';
    this._named = {};
  }
  get textContent() {
    if (this.children.length) return this.children.map((child) => child.textContent).join('');
    return this._text;
  }
  set textContent(value) {
    this.children = [];
    this._text = String(value);
  }
  get classList() {
    const element = this;
    const names = () => element.className.split(/\s+/).filter(Boolean);
    return {
      add(name) { if (!names().includes(name)) element.className = [...names(), name].join(' '); },
      remove(name) { element.className = names().filter((item) => item !== name).join(' '); },
      contains(name) { return names().includes(name); },
      toggle(name, force) {
        const on = force === undefined ? !names().includes(name) : Boolean(force);
        if (on) this.add(name); else this.remove(name);
        return on;
      },
    };
  }
  get options() { return this.children.filter((child) => child.tagName === 'OPTION'); }
  get elements() { return this._named; }
  get parentElement() { return this.parent; }
  append(...nodes) {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
      if (this.tagName === 'SELECT' && !this.value && node.value) this.value = node.value;
    }
  }
  appendChild(node) { this.append(node); return node; }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.append(...nodes);
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(type, handler) { (this.handlers[type] ||= []).push(handler); }
  focus() { this.focused = true; }
  reset() { this.resetCount = (this.resetCount || 0) + 1; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  dispatch(type, event = {}) {
    const handlers = this.handlers[type] || [];
    return Promise.all(handlers.map((handler) => handler({
      type, target: this, preventDefault() {}, stopPropagation() {}, ...event,
    })));
  }
}

function fakeMemoryDocument(html) {
  const byId = new Map();
  const forms = [];
  for (const match of html.matchAll(/<(\/?)([a-z0-9-]+)\b([^>]*)>/gi)) {
    const [, closing, rawTag, attrs] = match;
    const tag = rawTag.toUpperCase();
    if (closing) {
      if (tag === 'FORM' && forms.length) forms.pop();
      continue;
    }
    const id = /\bid="([^"]+)"/.exec(attrs);
    const name = /\bname="([^"]+)"/.exec(attrs);
    let node = null;
    if (id || name) {
      node = new MemoryNode(tag);
      if (id) { node.id = id[1]; byId.set(id[1], node); }
      if (name) {
        node.name = name[1];
        const type = /\btype="([^"]+)"/.exec(attrs);
        if (type) node.type = type[1];
        if (forms.length) forms[forms.length - 1]._named[name[1]] = node;
      }
      for (const attr of attrs.matchAll(/([a-z][a-z0-9-]*)="([^"]*)"/gi)) {
        node.attributes[attr[1]] = attr[2];
      }
      node.hidden = /(^|\s)hidden(\s|$|=)/.test(attrs);
      node.disabled = /(^|\s)disabled(\s|$|=)/.test(attrs);
    }
    if (tag === 'FORM') {
      const form = node || new MemoryNode('FORM');
      if (!form._named) form._named = {};
      if (id) { form.id = id[1]; byId.set(id[1], form); }
      forms.push(form);
    }
  }
  const body = new MemoryNode('BODY');
  const doc = {
    cookie: '',
    body,
    defaultView: undefined,
    handlers: {},
    getElementById(id) { return byId.get(id) || null; },
    createElement(tag) { return new MemoryNode(tag); },
    createElementNS(_namespace, tag) { return new MemoryNode(tag); },
    addEventListener(type, handler) { (doc.handlers[type] ||= []).push(handler); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  return {doc, el: (id) => byId.get(id) || null};
}

function jsonResponse(status, body) { return {status, json: async () => body}; }

function memoryPage(id, title) {
  return {
    id, title, body: '', topics: [], revision: 1,
    created_by: 'alice', updated_by: 'alice', updated: 1763000000,
  };
}

function memoryFetcher() {
  const requests = [];
  const pages = {m1: memoryPage('m1', '项目简报'), m2: memoryPage('m2', '运维手册')};
  const action = {
    id: 'a1', title: '跟进客户', notes: '', status: 'open', due_at: null,
    memory_page_id: null, revision: 1, created_by: 'alice', updated_by: 'alice',
  };
  const graph = {
    nodes: Object.values(pages).map((page) => ({id: page.id, title: page.title})),
    edges: [], topics: [], counts: {nodes: 2, edges: 0, topics: 0},
  };
  const fetcher = async (path, options = {}) => {
    const method = options.method || 'GET';
    requests.push(`${method} ${path}`);
    if (path === '/v1/auth/session') return jsonResponse(200, {user: {username: 'alice'}});
    if (path === '/v1/settings') return jsonResponse(200, {settings: {values: {}}});
    if (path === '/v1/workspaces') {
      return jsonResponse(200, {items: [{id: 'ws1', name: '团队'}, {id: 'ws2', name: '另一个'}]});
    }
    const listed = /^\/v1\/workspaces\/(ws[12])\/memory$/.exec(path);
    if (listed) return jsonResponse(200, {items: Object.values(pages)});
    const actions = /^\/v1\/workspaces\/(ws[12])\/memory\/actions$/.exec(path);
    if (actions) return jsonResponse(200, {items: [action]});
    const graphPath = /^\/v1\/workspaces\/(ws[12])\/memory\/graph$/.exec(path);
    if (graphPath) return jsonResponse(200, graph);
    const oneAction = /^\/v1\/workspaces\/(ws[12])\/memory\/actions\/([^/]+)$/.exec(path);
    if (oneAction) return jsonResponse(200, {action});
    const removePage = /^\/v1\/workspaces\/(ws[12])\/memory\/([^/]+)\/remove$/.exec(path);
    if (removePage && method === 'POST') return jsonResponse(200, {});
    const removeAction = /^\/v1\/workspaces\/(ws[12])\/memory\/actions\/([^/]+)\/remove$/.exec(path);
    if (removeAction && method === 'POST') return jsonResponse(200, {});
    const onePage = /^\/v1\/workspaces\/(ws[12])\/memory\/([^/]+)$/.exec(path);
    if (onePage && pages[onePage[2]]) return jsonResponse(200, {page: pages[onePage[2]]});
    return jsonResponse(404, {error: {message: 'unexpected ' + path}});
  };
  return {fetcher, requests};
}

async function mountMemory() {
  const {doc, el} = fakeMemoryDocument(memoryHtml);
  const {fetcher, requests} = memoryFetcher();
  const saved = globalThis.document;
  globalThis.document = doc;
  try {
    mount(doc, {fetcher});
    for (let round = 0; round < 12; round += 1) await memoryTick();
  } finally {
    if (saved === undefined) delete globalThis.document; else globalThis.document = saved;
  }
  const posted = () => requests.filter((line) => line.startsWith('POST'));
  const openPageRow = async (index) => {
    await el('memory-list').children[index].children[0].dispatch('click');
    for (let round = 0; round < 6; round += 1) await memoryTick();
  };
  const openActionRow = async (index) => {
    await el('action-list').children[index].children[0].dispatch('click');
    for (let round = 0; round < 6; round += 1) await memoryTick();
  };
  return {doc, el, requests, posted, openPageRow, openActionRow};
}

test('the memory markup ships two labelled alert dialogs for its two deletes', () => {
  for (const [dialogId, questionId] of [
    ['page-delete-confirm', 'page-delete-question'],
    ['action-delete-confirm', 'action-delete-question'],
  ]) {
    const present = (pattern, message) => assert.ok(pattern.test(memoryHtml), message);
    present(new RegExp(`id="${dialogId}"[^>]*role="alertdialog"`), `${dialogId} is an alert dialog`);
    present(new RegExp(`aria-labelledby="${questionId}"`), `${dialogId} is labelled by its question`);
    present(new RegExp(`id="${questionId}"`), `${questionId} exists`);
  }
  assert.match(memoryHtml, /<button type="button" id="delete-page">删除<\/button>/);
  assert.match(memoryHtml, /<button type="button" id="delete-action">删除<\/button>/);
});

test('deleting a memory page asks first, names the target and posts nothing yet', async () => {
  const {el, posted, openPageRow} = await mountMemory();
  await openPageRow(0);
  await el('delete-page').dispatch('click');
  for (let round = 0; round < 4; round += 1) await memoryTick();
  assert.deepEqual(posted(), [], 'the delete button must ask before it sends the remove request');
  const dialog = el('page-delete-confirm');
  assert.ok(dialog, 'the page editor renders a confirmation dialog');
  assert.equal(dialog.hidden, false);
  assert.equal(dialog.getAttribute('role'), 'alertdialog');
  assert.equal(el('delete-page').hidden, true, 'the trigger is hidden while the question is open');
  assert.match(el('page-delete-question').textContent, /项目简报/);
  assert.equal(el('page-delete-confirm-cancel').focused, true, 'focus moves into the question');
});

test('cancelling or pressing Escape closes the question with zero requests and restores focus', async () => {
  const {doc, el, posted, openPageRow} = await mountMemory();
  await openPageRow(0);
  await el('delete-page').dispatch('click');
  assert.deepEqual(posted(), [], 'opening the question must not post');
  await el('page-delete-confirm-cancel').dispatch('click');
  assert.equal(el('page-delete-confirm').hidden, true);
  assert.equal(el('delete-page').hidden, false);
  assert.equal(el('delete-page').focused, true, 'cancel returns focus to the trigger');

  await el('delete-page').dispatch('click');
  for (const handler of doc.handlers.keydown || []) {
    handler({key: 'Escape', preventDefault() {}, stopPropagation() {}});
  }
  assert.equal(el('page-delete-confirm').hidden, true);
  assert.equal(el('delete-page').focused, true, 'Escape returns focus to the trigger');
  assert.deepEqual(posted(), []);
});

test('confirming posts exactly once to the page captured when the question opened', async () => {
  const {el, posted, openPageRow} = await mountMemory();
  await openPageRow(0);
  await el('delete-page').dispatch('click');
  assert.deepEqual(posted(), [], 'no request before the user confirms');
  await el('page-delete-confirm-submit').dispatch('click');
  for (let round = 0; round < 8; round += 1) await memoryTick();
  assert.deepEqual(posted(), ['POST /v1/workspaces/ws1/memory/m1/remove']);
  assert.equal(el('status').textContent, '已删除。');
  assert.equal(el('page-delete-confirm').hidden, true);
});

test('a pending question is dropped when the workspace or the open entry changes', async () => {
  const {el, posted, openPageRow} = await mountMemory();
  await openPageRow(0);
  await el('delete-page').dispatch('click');
  assert.deepEqual(posted(), [], 'a pending question must not post before it is confirmed');
  assert.equal(el('page-delete-confirm').hidden, false);
  el('workspace').value = 'ws2';
  await el('workspace').dispatch('change');
  for (let round = 0; round < 8; round += 1) await memoryTick();
  assert.equal(el('page-delete-confirm').hidden, true, 'a workspace switch closes the stale question');
  assert.equal(el('delete-page').hidden, false);
  assert.deepEqual(posted(), []);

  await openPageRow(0);
  await el('delete-page').dispatch('click');
  assert.equal(el('page-delete-confirm').hidden, false);
  await openPageRow(1);
  assert.equal(el('page-delete-confirm').hidden, true, 'opening another page closes the stale question');
  assert.equal(el('delete-page').hidden, false);
  assert.deepEqual(posted(), []);
});

test('deleting a next action asks first and only confirms the captured action', async () => {
  const {el, posted, openActionRow} = await mountMemory();
  await openActionRow(0);
  await el('delete-action').dispatch('click');
  for (let round = 0; round < 4; round += 1) await memoryTick();
  assert.deepEqual(posted(), [], 'the action delete button must ask before it sends the remove request');
  assert.equal(el('action-delete-confirm').hidden, false);
  assert.equal(el('delete-action').hidden, true);
  assert.match(el('action-delete-question').textContent, /跟进客户/);
  await el('action-delete-confirm-submit').dispatch('click');
  for (let round = 0; round < 8; round += 1) await memoryTick();
  assert.deepEqual(posted(), ['POST /v1/workspaces/ws1/memory/actions/a1/remove']);
  assert.equal(el('status').textContent, '已删除。');
  assert.equal(el('action-delete-confirm').hidden, true);
});
