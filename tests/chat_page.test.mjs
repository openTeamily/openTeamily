import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { mergeSessions, SEARCH_TABS, initial, chatIdentity, applyChatIdentity, composeSelectedLabel, filterMemberChoices, composeCreateEnabled, composeGroupPayload, GROUP_CREATE_INTRO, GROUP_CREATE_MODES, mount, messageSearchQuery, homepageStartIndex, stripHomepageStartQuery, wrapBold, inlineBold, dueReminders, reminderDueLabel } from '../openteamily/static/chat/app.mjs';

const alice = 'a'.repeat(32);
const bob = 'b'.repeat(32);

test('initial uses the first letter or digit and skips leading punctuation', () => {
  assert.equal(initial('Helper'), 'H');
  assert.equal(initial('产品群'), '产');
  assert.equal(initial('[CI FIXTURE] Directory assistant'), 'C');
  assert.equal(initial('...'), '?');
  assert.equal(initial(''), '?');
});

test('chatIdentity shows a letter avatar only for a real conversation title', () => {
  assert.deepEqual(chatIdentity('Directory assistant'), {
    title: 'Directory assistant', initial: 'D', showAvatar: true,
  });
  assert.deepEqual(chatIdentity('  '), {title: '聊天', initial: '', showAvatar: false});
  assert.deepEqual(chatIdentity('聊天'), {title: '聊天', initial: '', showAvatar: false});
  const document = {
    nodes: {
      'chat-title': {textContent: ''},
      'chat-avatar': {textContent: '', hidden: true},
    },
    getElementById(id) { return this.nodes[id]; },
  };
  applyChatIdentity(document, '[CI FIXTURE] Directory assistant');
  assert.equal(document.nodes['chat-title'].textContent, '[CI FIXTURE] Directory assistant');
  assert.equal(document.nodes['chat-avatar'].textContent, 'C');
  assert.equal(document.nodes['chat-avatar'].hidden, false);
  applyChatIdentity(document, '聊天');
  assert.equal(document.nodes['chat-avatar'].hidden, true);
  assert.equal(document.nodes['chat-avatar'].textContent, '');
});

test('SEARCH_TABS lists the recorded search scopes', () => {
  assert.deepEqual(SEARCH_TABS.map((entry) => entry[1]), [
    '全部', 'Artifacts', '联系人', '群组', '智能体', '消息', '文件', '云文档', '媒体', '链接',
  ]);
});

test('mergeSessions combines agent and social rows without inventing pins', () => {
  const sessions = mergeSessions(
    [{id: 'c1', agent_id: 'ag', title: 'Old thread', updated: 10, agent: {id: 'ag', name: 'Helper'}}],
    [
      {id: 's1', kind: 'dm', title: 'bob', updated: 30, members: [
        {user_id: alice, username: 'alice'}, {user_id: bob, username: 'bob'},
      ]},
      {id: 's2', kind: 'group', title: '产品群', updated: 20, members: [
        {user_id: alice, username: 'alice'}, {user_id: bob, username: 'bob'},
      ]},
    ],
    alice,
  );
  assert.deepEqual(sessions.map((row) => [row.source, row.id, row.title]), [
    ['social', 's1', 'bob'],
    ['social', 's2', '产品群'],
    ['agent', 'c1', 'Helper'],
  ]);
  assert.equal(sessions.every((row) => !row.pinned), true);
  assert.deepEqual(sessions.map((row) => row.preview), [
    '单聊 · 2 人',
    '群聊 · 2 人',
    'Old thread',
  ]);
});

test('mergeSessions prefers a last-message preview from the listing', () => {
  const sessions = mergeSessions(
    [{id: 'c1', agent_id: 'ag', title: 'Old thread', preview: 'Latest assistant reply', updated: 10, agent: {id: 'ag', name: 'Helper'}}],
    [
      {id: 's1', kind: 'dm', title: 'bob', preview: '你好 Alice', updated: 30, members: [
        {user_id: alice, username: 'alice'}, {user_id: bob, username: 'bob'},
      ]},
      {id: 's2', kind: 'group', title: '产品群', preview: '', updated: 20, members: [
        {user_id: alice, username: 'alice'}, {user_id: bob, username: 'bob'},
      ]},
    ],
    alice,
  );
  assert.deepEqual(sessions.map((row) => [row.id, row.preview]), [
    ['s1', '你好 Alice'],
    ['s2', '群聊 · 2 人'],
    ['c1', 'Latest assistant reply'],
  ]);
});


test('messageSearchQuery adds only an explicit conversation scope and encodes keywords', async () => {
  const {messageSearchQuery} = await import('../openteamily/static/chat/app.mjs');
  const global = new URLSearchParams(messageSearchQuery('budget & 预算'));
  assert.equal(global.get('q'), 'budget & 预算');
  assert.equal(global.has('conversation_id'), false);
  const scoped = new URLSearchParams(messageSearchQuery('budget & 预算', 'a'.repeat(32)));
  assert.equal(scoped.get('conversation_id'), 'a'.repeat(32));
  assert.deepEqual([...scoped.keys()].sort(), ['conversation_id', 'limit', 'q']);
});


function keyEvent(overrides) {
  return {
    key: 'Enter',
    isComposing: false,
    keyCode: 13,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  };
}

test('shouldSendOnShortcut honors enter and Ctrl/Cmd+Enter bindings and ignores IME', async () => {
  const {shouldSendOnShortcut} = await import('../openteamily/static/chat/app.mjs');
  assert.equal(shouldSendOnShortcut(keyEvent(), 'enter'), true);
  assert.equal(shouldSendOnShortcut(keyEvent({shiftKey: true}), 'enter'), false);
  assert.equal(shouldSendOnShortcut(keyEvent({ctrlKey: true}), 'enter'), false);
  assert.equal(shouldSendOnShortcut(keyEvent({metaKey: true}), 'enter'), false);
  assert.equal(shouldSendOnShortcut(keyEvent({altKey: true}), 'enter'), false);
  assert.equal(shouldSendOnShortcut(keyEvent({key: 'a'}), 'enter'), false);
  assert.equal(shouldSendOnShortcut(keyEvent({isComposing: true}), 'enter'), false);
  assert.equal(shouldSendOnShortcut(keyEvent({keyCode: 229}), 'enter'), false);
  assert.equal(shouldSendOnShortcut(keyEvent({ctrlKey: true}), 'mod_enter'), true);
  assert.equal(shouldSendOnShortcut(keyEvent({metaKey: true}), 'mod_enter'), true);
  assert.equal(shouldSendOnShortcut(keyEvent(), 'mod_enter'), false);
  assert.equal(shouldSendOnShortcut(keyEvent({ctrlKey: true, shiftKey: true}), 'mod_enter'), false);
  assert.equal(shouldSendOnShortcut(keyEvent(), 'unknown'), true);
  assert.equal(shouldSendOnShortcut(null, 'enter'), false);
});

test('composeSelectedLabel reports the recorded selected count', () => {
  assert.equal(composeSelectedLabel(0), '已选 0');
  assert.equal(composeSelectedLabel(2), '已选 2');
});

test('filterMemberChoices matches usernames without inventing members', () => {
  const members = [
    {user_id: alice, username: 'alice'},
    {user_id: bob, username: 'bob'},
  ];
  assert.deepEqual(filterMemberChoices(members, alice, '').map((member) => member.username), ['bob']);
  assert.deepEqual(filterMemberChoices(members, alice, 'BO').map((member) => member.username), ['bob']);
  assert.deepEqual(filterMemberChoices(members, alice, 'zzz'), []);
});

test('composeCreateEnabled stays off until a custom-group selection exists', () => {
  assert.equal(composeCreateEnabled({composeMode: 'group', groupMode: 'custom', selectedCount: 0}), false);
  assert.equal(composeCreateEnabled({composeMode: 'group', groupMode: 'custom', selectedCount: 1}), true);
  assert.equal(composeCreateEnabled({composeMode: 'group', groupMode: 'team', selectedCount: 3}), false);
  assert.equal(composeCreateEnabled({composeMode: 'contact', groupMode: 'custom', selectedCount: 1}), true);
  assert.equal(composeCreateEnabled({composeMode: 'contact', selectedCount: 0}), false);
});

test('composeGroupPayload omits a blank title so the existing API can default it', () => {
  assert.deepEqual(composeGroupPayload([bob], '  产品群  '), {
    kind: 'group', member_ids: [bob], title: '产品群',
  });
  assert.deepEqual(composeGroupPayload([bob], '   '), {kind: 'group', member_ids: [bob]});
});

test('group create chrome keeps the recorded labels and no billing copy', () => {
  assert.equal(GROUP_CREATE_INTRO, '添加名称，然后邀请好友并添加 AI 智能体。');
  assert.deepEqual(GROUP_CREATE_MODES, [
    ['custom', '自定义群组'],
    ['team', 'AI 智能体团队'],
  ]);
});

import {groupPickerChoices, groupAgentSummary} from '../openteamily/static/chat/app.mjs';

test('group picker distinguishes stored agents and people; contact picker omits agents', () => {
  const humans = [{user_id: alice, username: 'alice'}, {user_id: bob, username: 'bob'}];
  const agents = [{id: 'helper', name: 'Helper'}, {id: 'old', name: 'Archived', archived: 1}];
  const choices = groupPickerChoices(humans, alice, agents);
  assert.deepEqual(choices.map(row => [row.id, row.kind]), [[bob, 'human'], ['helper', 'agent']]);
  assert.ok(choices[1].label.includes('AI 智能体（自动回复未接通）'));
  assert.deepEqual(groupPickerChoices(humans, alice).map(row => row.id), [bob]);
  assert.equal(composeCreateEnabled({composeMode: 'group', selectedCount: 1, selectedHumanCount: 0}), false);
  assert.equal(composeCreateEnabled({composeMode: 'group', selectedCount: 2, selectedHumanCount: 1}), true);
  assert.equal(composeCreateEnabled({composeMode: 'group', groupMode: 'team', selectedCount: 2, selectedHumanCount: 1}), false);
  assert.deepEqual(composeGroupPayload([bob], '', ['helper']), {
    kind: 'group', member_ids: [bob], agent_ids: ['helper'],
  });
  assert.equal(groupAgentSummary({agent_members: []}), '');
  assert.ok(groupAgentSummary({agent_members: [{name: 'Helper'}]}).includes('Helper。可明确请求一次回复'));
});

import {groupReplyStatus} from '../openteamily/static/chat/app.mjs';
test('explicit group reply statuses distinguish pending, success and fixed errors', () => {
  assert.equal(groupReplyStatus({status: 'queued'}), '等待执行');
  assert.equal(groupReplyStatus({status: 'running'}), '执行中');
  assert.equal(groupReplyStatus({status: 'succeeded'}), '已完成');
  assert.equal(groupReplyStatus({status: 'failed', error_code: 'no_agent'}), '失败：没有可用运行时连接');
  assert.equal(groupReplyStatus({status: 'failed', error_code: 'timeout'}), '失败：执行超时');
  assert.equal(groupReplyStatus({status: 'failed', error_code: 'private diagnostic'}), '失败：请求失败');
});

test('the chat empty state offers two native links to /agents and /guide', () => {
  const html = readFileSync(new URL('../openteamily/static/chat/index.html', import.meta.url), 'utf8');
  const start = html.indexOf('id="chat-empty"');
  assert.ok(start > -1, 'the chat page has an empty state');
  const block = html.slice(start, html.indexOf('id="message-list"', start));
  assert.match(block, /<a href="\/agents">浏览智能体<\/a>/);
  assert.match(block, /<a href="\/guide">查看功能指引<\/a>/);
  assert.doesNotMatch(block, /<button[^>]*>帮助中心/, 'the next steps are links, not disabled buttons');
});

// These tests drive the real mount() with a stubbed two-page fetch, importing
// only symbols that exist on main today. On main the first page renders its 20
// hits and offers no way to reach the cursor page the server returned, and the
// query builder drops a cursor it is handed, so the assertions below fail as
// user-visible behaviour rather than as a missing export.

class FakeElement {
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
    this.name = '';
    this.href = '';
    this.scrollTop = 0;
    this.scrollHeight = 0;
  }
  get classList() {
    const element = this;
    const names = () => element.className.split(/\s+/).filter(Boolean);
    return {
      add(name) {
        if (!names().includes(name)) element.className = [...names(), name].join(' ');
      },
      remove(name) { element.className = names().filter((item) => item !== name).join(' '); },
      contains(name) { return names().includes(name); },
    };
  }
  get options() { return this.children.filter((child) => child.tagName === 'OPTION'); }
  append(...nodes) {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
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
  removeEventListener(type, handler) {
    this.handlers[type] = (this.handlers[type] || []).filter((item) => item !== handler);
  }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
  focus() { this.focused = true; }
  reset() { this.resetCount = (this.resetCount || 0) + 1; }
  closest(selector) {
    let node = this;
    while (node) {
      if (matchesSelector(node, selector)) return node;
      node = node.parent;
    }
    return null;
  }
  querySelector(selector) {
    if (selector === 'input:not(:disabled)') {
      return descendants(this).find((node) => node.tagName === 'INPUT' && !node.disabled) || null;
    }
    return null;
  }
}

function descendants(node) {
  const rows = [];
  for (const child of node.children) rows.push(child, ...descendants(child));
  return rows;
}

function matchesSelector(node, selector) {
  if (!node || !selector) return false;
  if (selector.startsWith('.')) return node.className.split(/\s+/).includes(selector.slice(1));
  const attr = /^([a-z0-9]*)\[([a-z-]+)(?:="([^"]*)")?\]$/i.exec(selector);
  if (attr) {
    if (attr[1] && node.tagName !== attr[1].toUpperCase()) return false;
    const value = attr[3];
    const actual = attr[2].startsWith('data-')
      ? node.dataset[attr[2].slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())]
      : node.attributes[attr[2]];
    if (value === undefined) return actual !== undefined && actual !== null && actual !== '';
    return actual === value;
  }
  return node.tagName === selector.toUpperCase();
}

// Ids, initial hidden state, labels and search tabs come from the served page,
// so the harness cannot invent a control the user would not have.
function fakeChatDocument(html) {
  const byId = new Map();
  const tabs = [];
  for (const match of html.matchAll(/<([a-z0-9]+)\b([^>]*)>/gi)) {
    const [, tag, attrs] = match;
    const id = /\bid="([^"]+)"/.exec(attrs);
    if (id) {
      const element = new FakeElement(tag);
      element.id = id[1];
      element.hidden = /(^|\s)hidden(\s|$|=)/.test(attrs);
      element.disabled = /(^|\s)disabled(\s|$|=)/.test(attrs);
      byId.set(id[1], element);
    }
    const tab = /\bdata-search-tab="([^"]+)"/.exec(attrs);
    if (tab) {
      const element = new FakeElement('button');
      element.dataset.searchTab = tab[1];
      tabs.push(element);
    }
  }
  for (const match of html.matchAll(/<([a-z0-9]+)\b([^>]*)>([^<]*)<\/\1>/gi)) {
    const id = /\bid="([^"]+)"/.exec(match[2]);
    const label = match[3].trim();
    if (id && label && byId.has(id[1])) byId.get(id[1]).textContent = label;
  }
  const body = new FakeElement('body');
  const doc = {
    cookie: '',
    body,
    handlers: {},
    getElementById(id) { return byId.get(id) || null; },
    createElement(tag) { return new FakeElement(tag); },
    createTextNode(text) {
      const node = new FakeElement('#text');
      node.textContent = text;
      return node;
    },
    addEventListener(type, handler) { (doc.handlers[type] ||= []).push(handler); },
    querySelector() { return null; },
    querySelectorAll(selector) {
      if (selector === '#search-panel [data-search-tab]') return tabs;
      return [];
    },
  };
  return {doc, el: (id) => byId.get(id) || null};
}

function json(status, body) { return {status, json: async () => body}; }

function searchHit(index) {
  const padded = String(index).padStart(2, '0');
  return {
    kind: 'agent',
    conversation_id: 'cv-' + padded,
    message_id: 'm-' + padded,
    title: '对话 ' + index,
    snippet: '片段 ' + index,
  };
}

function messagePage(start, count, cursor) {
  const items = [];
  for (let index = start; index < start + count; index += 1) items.push(searchHit(index));
  return {items, cursor};
}

function chatFetcher({failNext = false} = {}) {
  const requests = [];
  // Page two repeats the last hit of page one, so appending must not show it twice.
  const pages = [messagePage(1, 20, 'cursor-1'), messagePage(20, 20, '')];
  const fetcher = async (path) => {
    requests.push(path);
    if (path === '/v1/auth/session') return json(200, {user: {id: 'user-1', username: 'alice'}});
    if (path === '/v1/onboarding') return json(200, {onboarding: {completed: true}});
    if (path === '/v1/personal-agent') return json(200, {personal_agent: {workspace: {id: 'ws-1'}}});
    if (path === '/v1/workspaces?limit=100') return json(200, {items: [{id: 'ws-1', name: 'Desk'}]});
    if (path === '/v1/settings') return json(200, {settings: {values: {}}});
    if (path === '/v1/workspaces/ws-1/agents?limit=100') return json(200, {items: []});
    if (path === '/v1/workspaces/ws-1/social/conversations?limit=100') return json(200, {items: []});
    if (path === '/v1/workspaces/ws-1/members') return json(200, {items: []});
    if (path === '/v1/workspaces/ws-1/artifacts?limit=100') return json(200, {items: []});
    if (path.startsWith('/v1/workspaces/ws-1/search/messages?')) {
      if (failNext && /[?&]cursor=/.test(path)) throw new Error('无法加载更多。');
      const page = pages.shift();
      if (!page) throw new Error('unexpected search page: ' + path);
      return json(200, page);
    }
    throw new Error('unexpected ' + path);
  };
  return {fetcher, requests};
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function settle(times = 16) {
  for (let index = 0; index < times; index += 1) await tick();
}

async function fire(node, type, event = {}) {
  for (const handler of (node.handlers && node.handlers[type]) || []) await handler(event);
}

function installChatGlobals({narrow = false} = {}) {
  const saved = {
    location: globalThis.location,
    history: globalThis.history,
    addEventListener: globalThis.addEventListener,
    matchMedia: globalThis.matchMedia,
  };
  globalThis.location = {hash: '', pathname: '/chat'};
  globalThis.history = {replaceState() {}};
  globalThis.addEventListener = () => {};
  globalThis.matchMedia = (query) => ({matches: narrow && query === '(max-width: 900px)'});
  return () => {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete globalThis[key];
      else globalThis[key] = saved[key];
    }
  };
}

function messageRowTitles(doc) {
  const results = doc.getElementById('search-results');
  const titles = [];
  for (const section of results.children) {
    const list = section.children.find((child) => child.tagName === 'UL');
    for (const row of (list ? list.children : [])) {
      const button = row.children[0];
      const title = button && button.children[0];
      if (title) titles.push(title.textContent);
    }
  }
  return titles;
}

// The user-facing entry to page two: a visible control labelled 加载更多, whether
// it lives beside the results or inside them.
function visibleLoadMoreLabels(doc) {
  const labels = [];
  const add = (node) => {
    if (node && !node.hidden) labels.push(String(node.textContent || '').trim());
  };
  add(doc.getElementById('search-more'));
  const visit = (node) => {
    if (!node) return;
    if (node.tagName === 'BUTTON' && String(node.textContent || '').trim() === '加载更多') add(node);
    for (const child of node.children || []) visit(child);
  };
  visit(doc.getElementById('search-results'));
  return labels;
}

async function openMessageSearch(doc, el, fetcher) {
  await mount(doc, {fetcher});
  await settle();
  assert.equal(el('workspace').value, 'ws-1', 'the fixture workspace is selected');
  const input = el('session-search');
  await fire(input, 'focus');
  input.value = '上周';
  await fire(input, 'input');
  await settle();
}

function chatHtml() {
  return readFileSync(new URL('../openteamily/static/chat/index.html', import.meta.url), 'utf8');
}

test('message search pages by cursor through a 加载更多 control instead of stopping at 20', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher, requests} = chatFetcher();
  const restore = installChatGlobals();
  try {
    await openMessageSearch(doc, el, fetcher);
    const searchRequests = () => requests.filter((path) => path.includes('/search/messages?'));
    assert.equal(searchRequests().length, 1, 'the first query asks the server once');
    assert.match(searchRequests()[0], /[?&]limit=20(&|$)/, 'the first page asks for limit=20');
    assert.doesNotMatch(searchRequests()[0], /cursor=/, 'the first page has no cursor yet');

    const first = messageRowTitles(doc);
    assert.equal(first.length, 20, 'page one shows exactly the 20 hits the server returned');
    assert.equal(first[0], '对话 1');
    assert.equal(first[19], '对话 20');
    assert.deepEqual(
      visibleLoadMoreLabels(doc),
      ['加载更多'],
      'the server returned a cursor, so the 20 rendered rows must offer a way to reach page two',
    );

    await fire(el('search-more'), 'click');
    await settle();
    assert.equal(searchRequests().length, 2, 'clicking the control asks for the next page');
    assert.match(searchRequests()[1], /[?&]cursor=cursor-1(&|$)/, 'the second request carries the cursor');
    assert.match(searchRequests()[1], /[?&]limit=20(&|$)/, 'the page size stays 20');
    const appended = messageRowTitles(doc);
    assert.equal(appended.length, 39, 'the next page is appended once, without repeating the last row');
    assert.equal(appended[38], '对话 39');
    assert.deepEqual(visibleLoadMoreLabels(doc), [], 'an empty cursor hides the control again');
  } finally {
    restore();
  }
});

test('a failed next page keeps the rows already shown and leaves the control for a retry', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher, requests} = chatFetcher({failNext: true});
  const restore = installChatGlobals();
  try {
    await openMessageSearch(doc, el, fetcher);
    assert.deepEqual(visibleLoadMoreLabels(doc), ['加载更多'], 'page one still offers the next page');
    await fire(el('search-more'), 'click');
    await settle();
    assert.match(requests[requests.length - 1], /[?&]cursor=cursor-1(&|$)/);
    assert.equal(messageRowTitles(doc).length, 20, 'the rows already shown stay');
    assert.equal(doc.getElementById('search-empty').textContent, '无法加载更多。');
    assert.deepEqual(visibleLoadMoreLabels(doc), ['加载更多'], 'the cursor survives so the user can retry');
    assert.equal(el('search-more').disabled, false);
  } finally {
    restore();
  }
});

test('messageSearchQuery hands the next-page cursor to the server', () => {
  const first = new URLSearchParams(messageSearchQuery('上周'));
  assert.equal(first.get('limit'), '20', 'the page size stays 20');
  assert.equal(first.get('cursor'), null, 'the first page sends no cursor');

  const next = new URLSearchParams(messageSearchQuery('上周', alice, 'cursor-1'));
  assert.equal(next.get('limit'), '20', 'the page size stays 20');
  assert.equal(next.get('conversation_id'), alice);
  assert.equal(next.get('cursor'), 'cursor-1', 'a supplied cursor must reach the server, or page two is unreachable');
});

// Narrow screens show one pane at a time: the conversation list or the open
// conversation. The stylesheet keys that switch on `sessions-open`; these tests
// drive mount() and pin the class to the user's actual path through the page.

function sessionFetcher() {
  const aliceRow = {user_id: alice, username: 'alice'};
  const first = {
    id: 'conv-1', kind: 'dm', title: 'bob', updated: 30,
    members: [aliceRow, {user_id: bob, username: 'bob'}],
  };
  const second = {
    id: 'conv-2', kind: 'dm', title: 'carol', updated: 20,
    members: [aliceRow, {user_id: 'c'.repeat(32), username: 'carol'}],
  };
  const requests = [];
  const fetcher = async (path) => {
    requests.push(path);
    if (path === '/v1/auth/session') return json(200, {user: {id: alice, username: 'alice'}});
    if (path === '/v1/onboarding') return json(200, {onboarding: {completed: true}});
    if (path === '/v1/personal-agent') return json(200, {personal_agent: {workspace: {id: 'ws-1'}}});
    if (path === '/v1/workspaces?limit=100') return json(200, {items: [{id: 'ws-1', name: 'Desk'}]});
    if (path === '/v1/settings') return json(200, {settings: {values: {}}});
    if (path === '/v1/workspaces/ws-1/agents?limit=100') return json(200, {items: []});
    if (path === '/v1/workspaces/ws-1/social/conversations?limit=100') {
      return json(200, {items: [first, second]});
    }
    if (path === '/v1/workspaces/ws-1/members') return json(200, {items: []});
    if (path === '/v1/workspaces/ws-1/artifacts?limit=100') return json(200, {items: []});
    if (path === '/v1/workspaces/ws-1/social/conversations/conv-1') {
      return json(200, {
        conversation: first,
        items: [{id: 'm-1', user_id: bob, body: '你好', created: '2026-01-01T00:00:00Z'}],
      });
    }
    if (path === '/v1/workspaces/ws-1/social/conversations/conv-2') {
      return json(200, {conversation: second, items: []});
    }
    throw new Error('unexpected ' + path);
  };
  return {fetcher, requests};
}

function sessionRows(el) {
  return el('conversation-list').children.map((li) => li.children[0]);
}

test('a narrow-screen chat starts on the conversation list and returns to it from the back control', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher} = sessionFetcher();
  const restore = installChatGlobals({narrow: true});
  try {
    await mount(doc, {fetcher});
    await settle();
    assert.equal(sessionRows(el).length, 2, 'the fixture lists two conversations');
    assert.equal(
      doc.body.classList.contains('sessions-open'),
      true,
      'no conversation is open yet, so the session list must be the pane the narrow stylesheet shows',
    );

    await fire(el('conversation-list'), 'click', {target: sessionRows(el)[0]});
    await settle();
    assert.equal(
      doc.body.classList.contains('sessions-open'),
      false,
      'opening a conversation must uncover it instead of leaving the list over it',
    );
    assert.equal(el('message-list').children.length, 1, 'the opened conversation renders its messages');

    assert.ok(el('chat-back'), 'the chat header offers a way back to the session list');
    await fire(el('chat-back'), 'click');
    assert.equal(
      doc.body.classList.contains('sessions-open'),
      true,
      'the back control returns to the list so another conversation can be opened',
    );

    await fire(el('conversation-list'), 'click', {target: sessionRows(el)[1]});
    await settle();
    assert.equal(doc.body.classList.contains('sessions-open'), false, 'the second conversation opens the same way');
  } finally {
    restore();
  }
});

test('the 900px stylesheet restores the session pane for the sessions-open state', () => {
  const css = readFileSync(new URL('../openteamily/static/chat/app.css', import.meta.url), 'utf8');
  const start = css.indexOf('@media (max-width: 900px)');
  assert.ok(start > -1, 'the chat stylesheet has a 900px block');
  const end = css.indexOf('}', css.indexOf('{', start)) > -1 ? css.indexOf('\n}', start) : -1;
  const block = css.slice(start, end);
  assert.match(
    block,
    /\.sessions-open\s*>\s*\.session-pane\s*\{\s*display:\s*flex/,
    'the rule that hides the pane at 900px needs a matching restore for the list state',
  );
});

test('the 900px stylesheet puts the chat panel back in the second column', () => {
  const css = readFileSync(new URL('../openteamily/static/chat/app.css', import.meta.url), 'utf8');
  const start = css.indexOf('@media (max-width: 900px)');
  assert.ok(start > -1, 'the chat stylesheet has a 900px block');
  const block = css.slice(start, css.indexOf('\n}', start));
  for (const selector of ['#main', '#status']) {
    const rule = block.match(
      new RegExp(`body\\.app-workspace\\.chat-open\\s*>\\s*${selector}[^{]*\\{([^}]*)\\}`),
    );
    assert.ok(rule, `the two-column override at 900px must also move ${selector} out of column 3`);
    assert.match(
      rule[1],
      /grid-column:\s*2\b/,
      `${selector} is pinned to grid-column 3 by the shell stylesheet; without this the implicit third column collapses the session pane to its minimum`,
    );
  }
  // With the list shown, #main must leave the flow: otherwise it is auto-placed
  // in an implicit row below the pane and the 1fr row shrinks (pane 624px tall
  // instead of the full viewport).
  assert.match(
    block,
    /\.sessions-open\s*>\s*#main\s*\{\s*display:\s*none/,
    'the list state must hide the chat panel so the pane fills the viewport',
  );
});

test('a wide chat still opens the first conversation instead of stopping on the list', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher} = sessionFetcher();
  const restore = installChatGlobals();
  try {
    await mount(doc, {fetcher});
    await settle();
    assert.equal(
      doc.body.classList.contains('sessions-open'),
      false,
      'above 900px the list is shown beside the conversation, so no list state is applied',
    );
    assert.equal(el('message-list').children.length, 1, 'the first conversation still opens by default');
  } finally {
    restore();
  }
});

// The search panel is a child of the session pane, and the 900px stylesheet
// paints that pane only in the `sessions-open` state. With a conversation open
// the pane is display:none, so opening search without that state leaves the
// panel in the DOM and visible to script but zero by zero on screen.

function searchRequests(requests) {
  return requests.filter((path) => path.includes('/search/'));
}

function viewedConversationRequests(requests, id) {
  return requests.filter((path) => path === `/v1/workspaces/ws-1/social/conversations/${id}`);
}

test('a narrow chat shows the search panel over an open conversation by revealing the session pane', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher, requests} = sessionFetcher();
  const restore = installChatGlobals({narrow: true});
  try {
    await mount(doc, {fetcher});
    await settle();
    await fire(el('conversation-list'), 'click', {target: sessionRows(el)[0]});
    await settle();
    assert.equal(doc.body.classList.contains('sessions-open'), false, 'the conversation is the visible pane');

    await fire(el('message-search'), 'click');
    await settle();

    assert.equal(el('search-panel').hidden, false, 'the search panel is assigned the open state');
    assert.equal(
      doc.body.classList.contains('sessions-open'),
      true,
      'the search panel lives inside the session pane, which the narrow stylesheet hides while a conversation is open; without the list state the panel is 0x0 on screen',
    );
    assert.equal(viewedConversationRequests(requests, 'conv-1').length, 1, 'opening search must not refetch the conversation');
    assert.equal(el('chat-title').textContent, 'bob', 'the open conversation is still the one named in the header');
  } finally {
    restore();
  }
});

test('closing search on a narrow screen returns to the conversation that was open', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher, requests} = sessionFetcher();
  const restore = installChatGlobals({narrow: true});
  try {
    await mount(doc, {fetcher});
    await settle();
    await fire(el('conversation-list'), 'click', {target: sessionRows(el)[0]});
    await settle();
    await fire(el('message-search'), 'click');
    await settle();

    await fire(el('search-close'), 'click');
    await settle();

    assert.equal(el('search-panel').hidden, true, 'closing search hides the panel again');
    assert.equal(
      doc.body.classList.contains('sessions-open'),
      false,
      'the conversation, not the list, must be the visible pane after search closes',
    );
    assert.equal(el('message-list').children.length, 1, 'the opened conversation and its messages are still there');
    assert.equal(viewedConversationRequests(requests, 'conv-1').length, 1, 'the user does not have to open the conversation again');
  } finally {
    restore();
  }
});

test('closing search from the narrow session list keeps the list visible', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher} = sessionFetcher();
  const restore = installChatGlobals({narrow: true});
  try {
    await mount(doc, {fetcher});
    await settle();
    assert.equal(doc.body.classList.contains('sessions-open'), true, 'the list is the visible pane before search');

    await fire(el('session-search'), 'focus');
    await settle();
    assert.equal(el('search-panel').hidden, false, 'typing in the list search opens the panel');

    await fire(doc, 'keydown', {key: 'Escape'});
    await settle();

    assert.equal(el('search-panel').hidden, true, 'Escape closes the panel');
    assert.equal(
      doc.body.classList.contains('sessions-open'),
      true,
      'no conversation is open, so dropping the list state would leave the narrow screen blank',
    );
    assert.equal(sessionRows(el).length, 2, 'the conversation list is still rendered underneath');
  } finally {
    restore();
  }
});

test('a wide chat leaves the grid classes alone when search opens and closes', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher} = sessionFetcher();
  const restore = installChatGlobals();
  try {
    await mount(doc, {fetcher});
    await settle();
    assert.equal(el('message-list').children.length, 1, 'the wide page opens the first conversation');

    await fire(el('message-search'), 'click');
    await settle();
    assert.equal(el('search-panel').hidden, false, 'search opens');
    assert.equal(
      doc.body.classList.contains('sessions-open'),
      false,
      'above 900px the pane is never hidden, so no list state may be added',
    );

    await fire(el('search-close'), 'click');
    await settle();
    assert.equal(el('search-panel').hidden, true, 'search closes');
    assert.equal(
      doc.body.classList.contains('sessions-open'),
      false,
      'closing search must not add a class the wide layout never uses',
    );
  } finally {
    restore();
  }
});

test('homepageStartIndex only accepts a 0-4 start query', () => {
  assert.equal(homepageStartIndex(''), null);
  assert.equal(homepageStartIndex('?q=1'), null);
  assert.equal(homepageStartIndex('?start=5'), null);
  assert.equal(homepageStartIndex('?start=-1'), null);
  assert.equal(homepageStartIndex('?start=abc'), null);
  assert.equal(homepageStartIndex('?start=0'), 0);
  assert.equal(homepageStartIndex('start=4'), 4);
  assert.equal(homepageStartIndex('?start=1&x=2'), 1);
});

test('stripHomepageStartQuery removes only the start parameter', () => {
  assert.deepEqual(
    stripHomepageStartQuery('/chat', '?start=0', '#workspace=ws-1'),
    {changed: true, href: '/chat#workspace=ws-1'},
  );
  assert.deepEqual(
    stripHomepageStartQuery('/chat', '?start=0&x=1', ''),
    {changed: true, href: '/chat?x=1'},
  );
  assert.deepEqual(
    stripHomepageStartQuery('/chat', '', '#workspace=ws-1'),
    {changed: false, href: '/chat#workspace=ws-1'},
  );
});

test('a homepage start query opens the created conversation after a member starts it', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const calls = [];
  const conversation = {
    id: 'c'.repeat(32),
    workspace_id: 'ws-1',
    agent_id: 'a'.repeat(32),
    title: '列出这个助手能做什么',
  };
  const fetcher = async (path, options = {}) => {
    calls.push({path, method: options.method || 'GET', body: options.body});
    if (path === '/v1/auth/session') return json(200, {user: {id: 'user-1', username: 'alice'}});
    if (path === '/v1/onboarding') return json(200, {onboarding: {completed: true}});
    if (path === '/v1/personal-agent') return json(200, {personal_agent: {workspace: {id: 'ws-1'}}});
    if (path === '/v1/workspaces?limit=100') return json(200, {items: [{id: 'ws-1', name: 'Desk'}]});
    if (path === '/v1/settings') return json(200, {settings: {values: {}}});
    if (path === '/v1/workspaces/ws-1/agents?limit=100') {
      return json(200, {items: [{id: conversation.agent_id, name: '文档助手'}]});
    }
    if (path === `/v1/workspaces/ws-1/agents/${conversation.agent_id}/conversations?limit=100`) {
      return json(200, {items: [conversation]});
    }
    if (path === `/v1/workspaces/ws-1/agents/${conversation.agent_id}/conversations/${conversation.id}`) {
      return json(200, {conversation, items: [
        {id: 'm1', role: 'user', body: '列出这个助手能做什么', status: 'succeeded'},
        {id: 'm2', role: 'assistant', body: '这是本地测试回复。', status: 'succeeded'},
      ]});
    }
    if (path === '/v1/workspaces/ws-1/social/conversations?limit=100') return json(200, {items: []});
    if (path === '/v1/workspaces/ws-1/members') return json(200, {items: []});
    if (path === '/v1/workspaces/ws-1/artifacts?limit=100') return json(200, {items: []});
    if (path === '/v1/agent-homepages/start') {
      assert.equal(options.method, 'POST');
      assert.equal(JSON.parse(options.body).quick_start, 0);
      assert.match(options.headers['Idempotency-Key'] || '', /^home-start-/);
      return json(201, {
        conversation,
        message: {id: 'm1', role: 'user', body: '列出这个助手能做什么'},
        reply: {id: 'm2', role: 'assistant', body: '这是本地测试回复。', status: 'succeeded'},
      });
    }
    throw new Error('unexpected ' + options.method + ' ' + path);
  };
  const history = [];
  const saved = {
    location: globalThis.location,
    history: globalThis.history,
    addEventListener: globalThis.addEventListener,
  };
  globalThis.location = {hash: '', pathname: '/chat', search: '?start=0'};
  globalThis.history = {
    replaceState(_state, _title, url) { history.push(String(url)); globalThis.location.hash = String(url).includes('#') ? '#' + String(url).split('#').pop() : ''; },
  };
  globalThis.addEventListener = () => {};
  try {
    await mount(doc, {fetcher});
    await settle();
    const startCalls = calls.filter((item) => item.path === '/v1/agent-homepages/start');
    assert.equal(startCalls.length, 1, 'the page should start once from the query');
    assert.equal(JSON.parse(startCalls[0].body).quick_start, 0);
    assert.match(history.join(' '), /conversation=/);
    assert.ok(history.some((url) => url.startsWith('/chat#') || url === '/chat' || !url.includes('start=')),
      'the start query should be removed after a successful start: ' + history.join(' | '));
    const list = el('message-list');
    const texts = [];
    const visit = (node) => {
      if (!node) return;
      if (node.textContent) texts.push(String(node.textContent));
      for (const child of node.children || []) visit(child);
    };
    visit(list);
    assert.ok(texts.some((text) => text.includes('列出这个助手能做什么')),
      'the started prompt should appear in the conversation: ' + texts.join(' | '));
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete globalThis[key];
      else globalThis[key] = saved[key];
    }
  }
});


test('message search tab switches await the in-flight query and newer queries win', async () => {
  const {createMessageSearch} = await import('../openteamily/static/chat/app.mjs');
  const resolvers = [];
  const search = createMessageSearch(() => new Promise(resolve => resolvers.push(resolve)));
  const first = search.load('old');
  const same = search.load('old');
  assert.equal(resolvers.length, 1, 'a tab switch reuses the pending search');
  resolvers[0]({items: [{kind: 'social', message_id: 'old', snippet: 'old'}]});
  await Promise.all([first, same]);
  assert.equal(search.state.hits.length, 1);
  const stale = search.load('stale');
  const latest = search.load('latest');
  resolvers[2]({items: [{kind: 'social', message_id: 'latest', snippet: 'latest'}]});
  await latest;
  resolvers[1]({items: [{kind: 'social', message_id: 'stale', snippet: 'stale'}]});
  await stale;
  assert.equal(search.state.hits[0].messageId, 'latest');
});

test('social sessions retain server unread counts without inventing agent unread state', () => {
  const rows = mergeSessions([], [{id: 'social-unread', kind: 'group', title: 'Group', unread_count: 3}], 'alice');
  assert.equal(rows[0].unread_count, 3);
});


for (const mode of ['visible', 'hidden', 'failed']) {
  test('social unread acknowledgement is snapshot bounded: ' + mode, async () => {
    const {doc, el} = fakeChatDocument(chatHtml());
    const {fetcher: original} = sessionFetcher();
    const posts = [];
    doc.visibilityState = mode === 'hidden' ? 'hidden' : 'visible';
    const fetcher = async (path, options = {}) => {
      if (path.endsWith('/conv-1/read')) {
        posts.push(JSON.parse(options.body));
        return json(mode === 'failed' ? 500 : 200, {unread_count: 1});
      }
      const result = await original(path, options);
      const body = await result.json();
      if (path.endsWith('/social/conversations?limit=100')) body.items[0].unread_count = 2;
      if (path.endsWith('/social/conversations/conv-1')) {
        body.conversation.unread_count = 2;
        body.items.push({id: 'm-2', user_id: bob, body: 'second', created: '2026-01-01T00:00:01Z'});
      }
      return json(result.status, body);
    };
    const restore = installChatGlobals({narrow: true});
    try {
      await mount(doc, {fetcher});
      assert.equal(sessionRows(el)[0].children[2].children[0].textContent, '2');
      await fire(el('conversation-list'), 'click', {target: sessionRows(el)[0]});
      if (mode === 'hidden') assert.equal(posts.length, 0);
      else assert.deepEqual(posts, [{message_id: 'm-2'}]);
      assert.equal(sessionRows(el)[0].children[2].children[0].textContent, mode === 'visible' ? '1' : '2');
    } finally { restore(); }
  });
}


test('social pinned state sorts before recency and unread filter uses server state', () => {
  const rows = mergeSessions([], [
    {id: 'new', kind: 'dm', updated: 20, unread_count: 1},
    {id: 'old', kind: 'group', updated: 1, pinned: true},
  ], alice);
  assert.equal(rows[0].id, 'old');
  assert.equal(rows[1].unread_count, 1);
});

test('session filter selects only real unread social rows', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher: original} = sessionFetcher();
  const restore = installChatGlobals({narrow: true});
  try {
    await mount(doc, {fetcher: async path => {
      const result = await original(path), body = await result.json();
      if (path.endsWith('/social/conversations?limit=100')) body.items[0].unread_count = 2;
      return json(result.status, body);
    }});
    el('session-filter-value').value = 'unread';
    await fire(el('session-filter-value'), 'change');
    assert.equal(sessionRows(el).length, 1);
    assert.equal(sessionRows(el)[0].dataset.conversation, 'conv-1');
    el('session-filter-value').value = 'all';
    await fire(el('session-filter-value'), 'change');
    assert.equal(sessionRows(el).length, 2);
  } finally { restore(); }
});

test('the inbox filters personal agents and persists bulk-read and mute', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher: original} = sessionFetcher();
  const restore = installChatGlobals({narrow: true});
  const unread = new Set(['conv-1', 'conv-2']);
  const writes = [];
  let muted = false;
  try {
    await mount(doc, {fetcher: async (path, init) => {
      if (path === '/v1/personal-agent') return json(200, {personal_agent: {workspace: {id: 'ws-1'}, agent: {id: 'personal'}}});
      if (path.endsWith('/agents?limit=100')) return json(200, {items: [{id: 'personal', name: 'Personal'}]});
      if (path.endsWith('/agents/personal/conversations?limit=100')) return json(200, {items: [{id: 'personal-chat'}]});
      if (path.endsWith('/read')) {
        const id = path.split('/').at(-2);
        writes.push([id, JSON.parse(init.body)]);
        unread.delete(id);
        return json(200, {unread_count: 0});
      }
      if (path.endsWith('/conv-1/preferences')) {
        muted = JSON.parse(init.body).muted;
        return json(200, {muted});
      }
      const response = await original(path);
      const data = await response.json();
      if (path.endsWith('/social/conversations?limit=100')) return json(200, {
        items: data.items.map(row => ({...row, unread_count: Number(unread.has(row.id)), muted: row.id === 'conv-1' && muted})),
      });
      if (path.endsWith('/conv-1')) return json(200, {...data, conversation: {...data.conversation, muted}});
      return json(response.status, data);
    }});
    const filter = el('session-filter-value');
    filter.value = 'personal';
    await fire(filter, 'change');
    assert.deepEqual(sessionRows(el).map(row => row.dataset.conversation), ['personal-chat']);
    assert.equal(el('conversation-heading').textContent, '对话 · 1');
    filter.value = 'all';
    await fire(filter, 'change');
    assert.equal(el('conversations-read-all').hidden, false);
    await fire(el('conversations-read-all'), 'click');
    assert.deepEqual(writes, [['conv-1', {}], ['conv-2', {}]]);
    assert.equal(el('conversations-read-all').hidden, true);
    const row = sessionRows(el).find(item => item.dataset.conversation === 'conv-1');
    await fire(el('conversation-list'), 'click', {target: row});
    await fire(el('mute-conversation'), 'click');
    assert.equal(muted, true);
    assert.equal(el('mute-conversation').getAttribute('aria-pressed'), 'true');
    assert.match(sessionRows(el).find(item => item.dataset.conversation === 'conv-1').getAttribute('aria-label'), /免打扰/);
  } finally { restore(); }
});

test('independent conversation search uses current id and pages without opening sidebar search', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher: original} = sessionFetcher();
  const calls = [];
  const restore = installChatGlobals({narrow: true});
  try {
    await mount(doc, {fetcher: async path => {
      if (path.includes('/search/messages?')) {
        calls.push(path);
        const url = new URL(path, 'https://management.test');
        assert.equal(url.searchParams.get('conversation_id'), 'conv-1');
        return json(200, {items: [{kind: 'social', conversation_id: 'conv-1', message_id: url.searchParams.get('cursor') ? 'second' : 'first', snippet: 'Scoped result'}], cursor: url.searchParams.get('cursor') ? null : 'next-id'});
      }
      return original(path);
    }});
    await fire(el('conversation-list'), 'click', {target: sessionRows(el)[0]});
    await fire(el('conversation-search-open'), 'click');
    assert.equal(el('conversation-search-panel').hidden, false);
    el('conversation-search-query').value = 'needle';
    await fire(el('conversation-search-form'), 'submit', {preventDefault() {}});
    const firstHit = el('conversation-search-results').children[0];
    assert.equal(firstHit.className, 'search-hit');
    assert.ok(descendants(firstHit).some(node => node.textContent === 'Scoped result'), 'snippet is rendered in the hit row');
    assert.equal(el('conversation-search-more').hidden, false);
    await fire(el('conversation-search-more'), 'click');
    assert.equal(calls.length, 2);
    assert.equal(el('conversation-search-results').children.length, 2);
    assert.match(calls[1], /cursor=next-id/);
  } finally { restore(); }
});

test('own message editing and confirmed retraction call versioned endpoints', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher: original} = sessionFetcher();
  let text = 'Original', revision = 1, retracted = false;
  const posts = [];
  const restore = installChatGlobals({narrow: true});
  try {
    await mount(doc, {fetcher: async (path, options = {}) => {
      if (path.includes('/messages/mine-1/')) {
        const payload = JSON.parse(options.body); posts.push([path, payload]);
        assert.equal(payload.revision, revision);
        revision += 1;
        if (path.endsWith('/edit')) text = payload.body;
        else { text = ''; retracted = true; }
        return json(200, {message: {}});
      }
      const result = await original(path), body = await result.json();
      if (path.endsWith('/social/conversations/conv-1')) body.items = [{id: 'mine-1', user_id: alice, body: text, revision, retracted}];
      return json(result.status, body);
    }});
    await fire(el('conversation-list'), 'click', {target: sessionRows(el)[0]});
    let li = el('message-list').children[0];
    await fire(li.children[3], 'click'); // edit opens inline controls
    li.children[5].children[0].value = 'Edited';
    await fire(li.children[5].children[1], 'click'); // only opens the confirm step
    assert.equal(posts.length, 0);
    await fire(li.children[5].children[1], 'click'); // 确认修改
    assert.equal(text, 'Edited');
    li = el('message-list').children[0];
    await fire(li.children[4], 'click'); // only opens confirmation
    assert.equal(posts.length, 1);
    await fire(li.children[5].children[0], 'click');
    assert.equal(posts.length, 2);
    assert.equal(el('message-list').children[0].children[1].textContent, '此消息已撤回');
  } finally { restore(); }
});

test('editing a sent message adds a confirm step before the text is replaced', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher: original} = sessionFetcher();
  let text = 'Original', revision = 1;
  const posts = [];
  const restore = installChatGlobals({narrow: true});
  try {
    await mount(doc, {fetcher: async (path, options = {}) => {
      if (path.includes('/messages/mine-1/')) {
        const payload = JSON.parse(options.body); posts.push([path, payload]);
        revision += 1; text = payload.body;
        return json(200, {message: {}});
      }
      const result = await original(path), body = await result.json();
      if (path.endsWith('/social/conversations/conv-1')) {
        body.items = [{id: 'mine-1', user_id: alice, body: text, revision, retracted: false}];
      }
      return json(result.status, body);
    }});
    await fire(el('conversation-list'), 'click', {target: sessionRows(el)[0]});
    const controls = () => el('message-list').children[0].children[5];
    const buttons = () => descendants(controls()).filter(node => node.tagName === 'BUTTON');
    await fire(el('message-list').children[0].children[3], 'click'); // 编辑
    controls().children[0].value = 'Edited';
    await fire(controls().children[1], 'click'); // 保存修改
    assert.equal(posts.length, 0, '保存修改 must not send the edit on its own');
    assert.equal(el('message-list').children[0].children[1].textContent, 'Original',
      'the sent text is unchanged until the confirm step');
    const confirm = buttons().find(node => node.textContent === '确认修改');
    assert.ok(confirm, 'a 确认修改 button is shown before the edit is sent');
    assert.equal(buttons().some(node => node.textContent === '保存修改'), false,
      '保存修改 is replaced by the confirm step');
    assert.ok(descendants(controls()).some(node => node.tagName !== 'BUTTON' && /替换/.test(node.textContent || '')),
      'the confirm step says the sent message is replaced, not appended');
    const cancel = buttons().find(node => node.textContent === '取消');
    assert.ok(cancel, '取消 is offered in the confirm step');
    await fire(cancel, 'click');
    assert.equal(posts.length, 0, '取消 sends nothing');
    assert.equal(controls().children.length, 0, '取消 closes the confirm step');
    await fire(el('message-list').children[0].children[3], 'click');
    controls().children[0].value = 'Edited again';
    await fire(controls().children[1], 'click');
    await fire(buttons().find(node => node.textContent === '确认修改'), 'click');
    assert.equal(posts.length, 1);
    assert.match(posts[0][0], /messages\/mine-1\/edit$/);
    assert.equal(text, 'Edited again');
    assert.equal(el('message-list').children[0].children[1].textContent, 'Edited again');
  } finally { restore(); }
});


test('visual session groups use real pins and preserve order within each group', async () => {
  const {groupSessionsForDisplay, sessionDisplayGroup} = await import('../openteamily/static/chat/app.mjs');
  const items = [{id: 'g', kind: 'group'}, {id: 'a', source: 'agent'}, {id: 'p', pinned: true, kind: 'group'}, {id: 'd', kind: 'dm'}];
  assert.deepEqual(groupSessionsForDisplay(items).map(row => row.id), ['p', 'a', 'd', 'g']);
  assert.deepEqual(items.map(row => row.id), ['g', 'a', 'p', 'd']);
  assert.equal(sessionDisplayGroup(items[0]), '群聊');
  assert.equal(sessionDisplayGroup(items[2]), '置顶');
});

test('session timestamps use Hong Kong calendar boundaries and never invent unread state', async () => {
  const {formatSessionTime} = await import('../openteamily/static/chat/app.mjs');
  const seconds = value => Date.parse(value) / 1000;
  const now = Date.parse('2026-11-19T00:01:00+08:00');
  assert.equal(formatSessionTime(seconds('2026-11-18T23:59:00+08:00'), now), '昨天');
  assert.equal(formatSessionTime(seconds('2026-11-19T00:00:00+08:00'), now), '00:00');
  assert.match(formatSessionTime(seconds('2026-11-10T12:00:00+08:00'), now), /2026/);
  assert.equal(formatSessionTime('invalid', now), '');
});

test('icon chat controls preserve accessible names, disabled truth and attachment privacy', () => {
  const html = chatHtml();
  assert.match(html, /id="conversation-search-open"[^>]*aria-label="搜索当前会话"[\s\S]*?<svg/);
  assert.match(html, /disabled title="未实现：语音或视频通话"/);
  assert.match(html, /class="attachment-menu"[\s\S]*?id="chat-attachment"/);
  assert.match(html, /工作区成员可在作品库查看/);
  assert.match(html, /id="voice-record"[^>]*aria-label="录制语音"/);
  assert.match(html, /id="voice-preview" controls/);
});

import {notificationBadgeText, notificationSummary} from '../openteamily/static/chat/app.mjs';

test('notification badge and summary text', () => {
  assert.equal(notificationBadgeText(0), '');
  assert.equal(notificationBadgeText(3), '3');
  assert.equal(notificationBadgeText(120), '99+');
  assert.equal(notificationSummary({actor_username: 'bob', conversation_kind: 'group', conversation_title: '项目群'}),
    'bob 在「项目群」提及了你');
  assert.equal(notificationSummary({actor_username: 'bob', conversation_kind: 'dm', conversation_title: 'bob'}),
    'bob 在「单聊」提及了你');
});

test('mention notifications show a badge, open the conversation and mark read', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher: original} = sessionFetcher();
  const restore = installChatGlobals();
  const posts = [];
  let unread = 1;
  const inbox = () => ({unread_count: unread, limit: 100, items: [{
    id: 'n'.repeat(32), kind: 'mention', conversation_id: 'conv-1', conversation_kind: 'group',
    conversation_title: '项目群', message_id: 'm-1', actor_username: 'bob', excerpt: '@alice 看一下',
    created: 30, read: unread === 0}, {
    id: 'o'.repeat(32), kind: 'automation_reminder', title: '提醒', created: 20, read: true,
  }]});
  try {
    await mount(doc, {fetcher: async (path, init = {}) => {
      if (path === '/v1/workspaces/ws-1/notifications') return json(200, inbox());
      if (path === '/v1/workspaces/ws-1/notifications/read') {
        posts.push(JSON.parse(init.body)); unread = 0; return json(200, {unread_count: 0});
      }
      if (path.endsWith('/conv-1/read')) return json(200, {unread_count: 0});
      return original(path);
    }});
    await settle();
    assert.equal(el('notification-count').hidden, false);
    assert.equal(el('notification-count').textContent, '1');
    await fire(el('notifications-toggle'), 'click');
    await settle();
    assert.equal(el('notifications-panel').hidden, false);
    assert.equal(el('notification-list').children.length, 2);
    el('notifications-kind').value = 'mention';
    await fire(el('notifications-kind'), 'change');
    el('notifications-unread').checked = true;
    await fire(el('notifications-unread'), 'change');
    assert.equal(el('notification-list').children.length, 1);
    const item = el('notification-list').children[0] && el('notification-list').children[0].children[0];
    assert.ok(item, 'the mention is listed');
    assert.equal(item.children[0].textContent, 'bob 在「项目群」提及了你');
    assert.equal(el('notifications-read-all').disabled, false);
    await fire(item, 'click');
    await settle();
    assert.deepEqual(posts, [{notification_id: 'n'.repeat(32)}]);
    assert.equal(el('notifications-panel').hidden, true);
    assert.equal(el('notification-count').hidden, true);
    assert.equal(el('notifications-empty').textContent, '暂无未读提及。');
  } finally { restore(); }
});

import {MESSAGE_REACTIONS, reactionToggle} from '../openteamily/static/chat/app.mjs';

test('reaction toggle turns my reaction off and others on', () => {
  assert.equal(MESSAGE_REACTIONS.length, 6);
  assert.deepEqual(reactionToggle([{emoji: '👍', count: 2, mine: true}], '👍'), {emoji: '👍', active: false});
  assert.deepEqual(reactionToggle([{emoji: '👍', count: 1, mine: false}], '👍'), {emoji: '👍', active: true});
  assert.deepEqual(reactionToggle([], '🎉'), {emoji: '🎉', active: true});
});

test('reaction chips post the toggle and re-render server counts', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher: original} = sessionFetcher();
  const posts = [];
  const restore = installChatGlobals({narrow: true});
  try {
    await mount(doc, {fetcher: async (path, options = {}) => {
      if (path.endsWith('/messages/m-1/reactions')) {
        const payload = JSON.parse(options.body); posts.push(payload);
        return json(200, {message_id: 'm-1', reactions: payload.active ? [{emoji: payload.emoji, count: 2, mine: true}] : []});
      }
      const result = await original(path), body = await result.json();
      if (path.endsWith('/social/conversations/conv-1')) body.items[0].reactions = [{emoji: '👍', count: 1, mine: false}];
      return json(result.status, body);
    }});
    await fire(el('conversation-list'), 'click', {target: sessionRows(el)[0]});
    const li = el('message-list').children[0];
    const bar = li.children.find(node => node.className === 'message-reactions');
    assert.equal(bar.className, 'message-reactions');
    assert.equal(bar.children[0].textContent, '👍 1');
    await fire(bar.children[0], 'click');
    await settle();
    assert.deepEqual(posts, [{emoji: '👍', active: true}]);
    const next = li.children.find(node => node.className === 'message-reactions');
    assert.equal(next.children[0].textContent, '👍 2');
    assert.equal(next.children[0].getAttribute('aria-pressed'), 'true');
  } finally { restore(); }
});

test('team mode needs a selected template', () => {
  assert.equal(composeCreateEnabled({composeMode: 'group', groupMode: 'team', selectedCount: 3}), false);
  assert.equal(composeCreateEnabled({composeMode: 'group', groupMode: 'team', templateSelected: true}), true);
});

import {forwardTargets, forwardCountLabel} from '../openteamily/static/chat/app.mjs';

test('forward target list excludes the current conversation', () => {
  assert.deepEqual(forwardTargets([{id: 'a', kind: 'dm', title: 'bob'}, {id: 'b', kind: 'group', title: '群'}], 'a'),
    [{id: 'b', label: '群聊 · 群'}]);
  assert.equal(forwardCountLabel(3), '已选 3 条');
});

test('pin a message and multi-select forward call the real endpoints', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher: original} = sessionFetcher();
  const posts = [];
  const restore = installChatGlobals({narrow: true});
  try {
    await mount(doc, {fetcher: async (path, options = {}) => {
      if (path.endsWith('/messages/m-1/pin')) {
        posts.push([path, JSON.parse(options.body)]);
        return json(200, {pinned_messages: [{message_id: 'm-1', excerpt: '你好', pinned_by_username: 'alice'}]});
      }
      if (path.endsWith('/conv-1/forward')) {
        posts.push([path, JSON.parse(options.body)]);
        return json(201, {items: [{id: 'f-1'}]});
      }
      return original(path);
    }});
    await fire(el('conversation-list'), 'click', {target: sessionRows(el)[0]});
    assert.equal(el('chat-invite').hidden, false);
    assert.equal(el('multi-select-toggle').hidden, false);
    let li = el('message-list').children[0];
    const tools = li.children.find(node => node.className === 'message-tools');
    assert.equal(tools.className, 'message-tools');
    await fire(tools.children[0], 'click');
    await settle();
    assert.deepEqual(posts[0][1], {pinned: true});
    assert.equal(el('pinned-messages').hidden, false);
    li = el('message-list').children[0];
    assert.equal(li.children.find(node => node.className === 'message-tools').children[0].textContent, '取消置顶');
    await fire(el('multi-select-toggle'), 'click');
    assert.equal(el('forward-bar').hidden, false);
    li = el('message-list').children[0];
    const box = li.children.find(node => node.className === 'message-tools').children[0].children[0];
    box.checked = true;
    await fire(box, 'change');
    assert.equal(el('forward-count').textContent, '已选 1 条');
    el('forward-target').value = 'conv-2';
    await fire(el('forward-target'), 'change');
    assert.equal(el('forward-submit').disabled, false);
    await fire(el('forward-submit'), 'click');
    await settle();
    assert.deepEqual(posts[1][1], {message_ids: ['m-1'], target_conversation_id: 'conv-2'});
    assert.equal(el('forward-bar').hidden, true);
  } finally { restore(); }
});

test('agent task completion notifications have their own summary', () => {
  assert.equal(notificationSummary({kind: 'agent_reply', status: 'succeeded', actor_username: '助理',
    conversation_kind: 'group', conversation_title: '项目群'}), '助理 在「项目群」已完成你的请求');
  assert.equal(notificationSummary({kind: 'agent_reply', status: 'failed', actor_username: '助理',
    conversation_kind: 'group', conversation_title: '项目群'}), '助理 在「项目群」未能完成你的请求');
});

test('group info panel counts members and agents honestly and picks a readable glyph', async () => {
  const { groupInfoCounts, leadGlyph } = await import('../openteamily/static/chat/app.mjs');
  assert.equal(groupInfoCounts({ members: [{}, {}], agent_members: [{}] }).text, '3 位成员 · 2 位真人 · 1 位智能体');
  assert.equal(groupInfoCounts({}).text, '0 位成员 · 0 位真人 · 0 位智能体');
  assert.equal(leadGlyph('[CI FIXTURE] Group chat'), 'G');
  assert.equal(leadGlyph('产品群'), '产');
  assert.equal(leadGlyph('---', '群'), '群');
  const html = readFileSync(new URL('../openteamily/static/chat/index.html', import.meta.url), 'utf8');
  for (const label of ['视频通话', '语音通话', '自动回复', '自动翻译', '消息免打扰']) assert.ok(html.includes(label));
  assert.match(html, /aria-label="自动翻译（未接通）"/);
});

test('group members can change automatic replies for their own agent only', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher: original} = sessionFetcher();
  const restore = installChatGlobals({narrow: true});
  const members = [
    {id: 'own', name: '助手', mine: true, auto_reply: false},
    {id: 'other', name: '同事的助手', mine: false, auto_reply: true},
  ];
  const updates = [];
  let failNext = false;
  try {
    await mount(doc, {fetcher: async (path, init) => {
      if (path.endsWith('/agents/own/auto-reply')) {
        const data = JSON.parse(init.body);
        updates.push(data);
        return json(failNext ? 503 : 200, data);
      }
      const result = await original(path);
      const body = await result.json();
      if (path.endsWith('/conv-1')) return json(200, {
        ...body, conversation: {...body.conversation, kind: 'group', agent_members: members},
      });
      return json(result.status, body);
    }});
    await fire(el('conversation-list'), 'click', {target: sessionRows(el)[0]});
    const [own, other] = el('group-info-agents').children;
    assert.equal(other.children.some(child => child.tagName === 'BUTTON'), false);
    const toggle = own.children.find(child => child.tagName === 'BUTTON');
    assert.equal(toggle.getAttribute('aria-checked'), 'false');
    await fire(toggle, 'click');
    assert.deepEqual(updates, [{auto_reply: true}]);
    assert.equal(toggle.getAttribute('aria-checked'), 'true');
    failNext = true;
    await fire(toggle, 'click');
    assert.equal(toggle.getAttribute('aria-checked'), 'true');
    assert.match(el('group-agent-auto-reply-status').textContent, /保存失败/);
  } finally { restore(); }
});

test('a selected group mention sends the chosen owner and agent together', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher: original} = sessionFetcher();
  const restore = installChatGlobals({narrow: true});
  const composer = el('chat-body');
  composer.setSelectionRange = (start, end) => {
    composer.selectionStart = start;
    composer.selectionEnd = end;
  };
  const posts = [];
  try {
    await mount(doc, {fetcher: async (path, init) => {
      if (path.endsWith('/conv-1/messages') && init.method === 'POST') {
        posts.push(JSON.parse(init.body));
        return json(201, {});
      }
      const result = await original(path);
      const body = await result.json();
      if (path.endsWith('/conv-1')) return json(200, {
        ...body, conversation: {...body.conversation, kind: 'group', agent_members: [
          {id: 'same', name: '研究助手', owner_id: 'owner-one', owner_name: '小林'},
          {id: 'same', name: '研究助手', owner_id: 'owner-two', owner_name: '小周'},
        ]},
      });
      return json(result.status, body);
    }});
    await fire(el('conversation-list'), 'click', {target: sessionRows(el)[0]});
    composer.value = '@研究';
    composer.setSelectionRange(composer.value.length, composer.value.length);
    await fire(composer, 'input');
    const list = el('chat-agent-mention-options');
    assert.deepEqual(list.children.map(row => row.textContent), ['研究助手 · 小林', '研究助手 · 小周']);
    await fire(composer, 'keydown', {key: 'ArrowDown', preventDefault() {}});
    await fire(composer, 'keydown', {key: 'Enter', preventDefault() {}});
    assert.deepEqual(posts, []);
    assert.equal(el('chat-agent-mentions').children[0].textContent, '@研究助手 · 小周 ×');
    composer.value = '请查一下';
    await fire(el('chat-form'), 'submit', {preventDefault() {}});
    await settle();
    assert.deepEqual(posts, [{body: '请查一下', agent_mentions: [{owner_id: 'owner-two', agent_id: 'same'}]}]);
    assert.equal(el('chat-agent-mentions').hidden, true);
  } finally { restore(); }
});

test('in-chat search highlights every case-insensitive match without HTML', async () => {
  const { highlightParts } = await import('../openteamily/static/chat/app.mjs');
  assert.deepEqual(highlightParts('Test a test', 'test'), [
    { text: 'Test', match: true }, { text: ' a ', match: false }, { text: 'test', match: true }]);
  assert.deepEqual(highlightParts('<b>x</b>', ''), [{ text: '<b>x</b>', match: false }]);
});

import { plusAttachAccept } from '../openteamily/static/chat/app.mjs';

test('composer + attach shortcuts narrow the file picker without widening it', () => {
  const all = 'image/png, image/jpeg,video/mp4,application/pdf';
  assert.equal(plusAttachAccept('image', all), 'image/png,image/jpeg');
  assert.equal(plusAttachAccept('video', all), 'video/mp4');
  assert.equal(plusAttachAccept('any', all), 'image/png,image/jpeg,video/mp4,application/pdf');
  assert.equal(plusAttachAccept('image', ''), '');
});

test('composer + creation grid deep-links real editors and labels the rest 未接通', () => {
  const html = readFileSync(new URL('../openteamily/static/chat/index.html', import.meta.url), 'utf8');
  for (const kind of ['website', 'document', 'slides', 'dashboard']) assert.ok(html.includes(`/space?new=${kind}`), kind);
  for (const id of ['meeting_prep', 'daily_brief', 'expert_research', 'advance_goals']) assert.ok(html.includes(`/automations?template=${id}`), id);
  assert.ok((html.match(/未接通/g) || []).length >= 5);
});

// Media shared in a chat is uploaded to the workspace library before the
// message is sent, so the message carries an attachment with a mime type. The
// message list has to show an image as an image: the document card with a DOC
// cover and a download link is what an attachment used to look like for every
// file type, and it hides the picture a user just sent.

function attachmentFetcher(item) {
  const aliceRow = {user_id: alice, username: 'alice'};
  const conversation = {
    id: 'conv-1', kind: 'dm', title: 'bob', updated: 30,
    members: [aliceRow, {user_id: bob, username: 'bob'}],
  };
  const fetcher = async (path) => {
    if (path === '/v1/auth/session') return json(200, {user: {id: alice, username: 'alice'}});
    if (path === '/v1/onboarding') return json(200, {onboarding: {completed: true}});
    if (path === '/v1/personal-agent') return json(200, {personal_agent: {workspace: {id: 'ws-1'}}});
    if (path === '/v1/workspaces?limit=100') return json(200, {items: [{id: 'ws-1', name: 'Desk'}]});
    if (path === '/v1/settings') return json(200, {settings: {values: {}}});
    if (path === '/v1/workspaces/ws-1/agents?limit=100') return json(200, {items: []});
    if (path === '/v1/workspaces/ws-1/members') return json(200, {items: []});
    if (path === '/v1/workspaces/ws-1/artifacts?limit=100') return json(200, {items: []});
    if (path === '/v1/workspaces/ws-1/social/conversations?limit=100') return json(200, {items: [conversation]});
    if (path === '/v1/workspaces/ws-1/social/conversations/conv-1') {
      return json(200, {conversation, items: [item]});
    }
    throw new Error('unexpected ' + path);
  };
  return {fetcher};
}

const imageAttachment = {
  id: 'a'.repeat(32), title: '日落.png', mime: 'image/png',
  path: '/v1/workspaces/ws-1/artifacts/' + 'a'.repeat(32) + '/file',
};

function attachmentMessage(attachment) {
  return {
    id: 'm-1', conversation_id: 'conv-1', workspace_id: 'ws-1', user_id: bob,
    body: '附件：' + attachment.title, created: '2026-01-01T00:00:00Z', attachment,
  };
}

test('a picture shared in a chat renders as an image, not a document card', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const restore = installChatGlobals();
  try {
    await mount(doc, {fetcher: attachmentFetcher(attachmentMessage(imageAttachment)).fetcher});
    await settle();
    const row = el('message-list').children[0];
    assert.ok(row, 'the fixture conversation renders its message');
    const image = descendants(row).find((node) => node.tagName === 'IMG');
    assert.ok(image, 'an image attachment must render as an <img>, otherwise the picture is invisible in chat');
    assert.equal(image.src, imageAttachment.path, 'the image reads the attachment the message points at');
    assert.equal(image.alt, '日落.png', 'the image alt text is the attachment title');
    assert.equal(image.getAttribute('loading'), 'lazy', 'a shared picture is not loaded before it is seen');
    assert.ok(
      !descendants(row).some((node) => String(node.textContent).trim() === 'DOC'),
      'the document cover must not label an image attachment',
    );
  } finally {
    restore();
  }
});

test('an audio attachment keeps the document card instead of becoming an image', async () => {
  const attachment = {id: 'b'.repeat(32), title: '备忘.m4a', mime: 'audio/mp4', path: '/v1/workspaces/ws-1/artifacts/' + 'b'.repeat(32) + '/file'};
  const {doc, el} = fakeChatDocument(chatHtml());
  const restore = installChatGlobals();
  try {
    await mount(doc, {fetcher: attachmentFetcher(attachmentMessage(attachment)).fetcher});
    await settle();
    const row = el('message-list').children[0];
    assert.ok(
      !descendants(row).some((node) => node.tagName === 'IMG'),
      'a non-image attachment must not be forced into an image element',
    );
    assert.ok(
      descendants(row).some((node) => String(node.textContent).trim() === 'DOC'),
      'a non-image attachment keeps the document card',
    );
  } finally {
    restore();
  }
});

test('in-chat search jumps to loaded messages, explains unloaded hits, and restores scroll on close', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher: original} = sessionFetcher();
  const restore = installChatGlobals({narrow:true});
  try {
    await mount(doc, {fetcher: async path => {
      if (path.includes('/search/messages?')) return json(200, {items:[{message_id:'jump-loaded',snippet:'Find me'}, {message_id:'not-loaded',snippet:'Earlier message'}],cursor:null});
      return original(path);
    }});
    await fire(el('conversation-list'), 'click', {target:sessionRows(el)[0]});
    const target = el('message-list').children[0];
    target.dataset.messageId = 'jump-loaded';
    let scrolled = false;
    target.scrollIntoView = () => {scrolled=true;};
    el('message-scroller').scrollTop = 41;
    await fire(el('conversation-search-open'), 'click');
    el('conversation-search-query').value = 'Find';
    await fire(el('conversation-search-form'), 'submit', {preventDefault(){}});
    const hits = el('conversation-search-results').children;
    assert.equal(hits[0].getAttribute('role'), 'button');
    await fire(hits[0], 'keydown', {key:'Enter',preventDefault(){}});
    assert.equal(scrolled, true);
    assert.equal(target.dataset.searchJump, 'true');
    await fire(hits[1], 'click');
    assert.match(el('conversation-search-status').textContent, /不在当前已加载/);
    el('message-scroller').scrollTop = 99;
    await fire(el('conversation-search-close'), 'click');
    assert.equal(el('message-scroller').scrollTop, 41);
    assert.equal(el('conversation-search-panel').hidden, true);
  } finally {restore();}
});

test('removing a group agent sends nothing until the explicit confirmation', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher: original} = sessionFetcher();
  const posts = [];
  const restore = installChatGlobals({narrow:true});
  try {
    await mount(doc, {fetcher: async (path, options={}) => {
      if (path.endsWith('/agents/a-1/remove')) {posts.push(path);return json(200, {});}
      return original(path, options);
    }});
    await fire(el('conversation-list'), 'click', {target:sessionRows(el)[0]});
    const remove = new FakeElement('button'); remove.dataset.removeAgent = 'a-1';
    await fire(el('group-agent-chips'), 'click', {target:remove});
    assert.equal(posts.length,0);
    let question = el('group-agent-chips').children.at(-1);
    assert.equal(question.getAttribute('role'),'alertdialog');
    await fire(question.children[1], 'click');
    assert.equal(posts.length,0);
    await fire(el('group-agent-chips'), 'click', {target:remove});
    question = el('group-agent-chips').children.at(-1);
    await fire(question.children[2], 'click');
    assert.equal(posts.length,1);
  } finally {restore();}
});

test('the composer exposes a real bold tool instead of the disabled placeholder', () => {
  const html = readFileSync(new URL('../openteamily/static/chat/index.html', import.meta.url), 'utf8');
  const start = html.indexOf('id="chat-format"');
  assert.ok(start > -1, 'the composer has a format control');
  const open = html.lastIndexOf('<button', start);
  const block = html.slice(open, html.indexOf('>', start) + 1);
  assert.doesNotMatch(block, /disabled/, 'the format control must not be disabled');
  assert.match(html, /id="chat-format-bold"/, 'the format menu offers bold');
});

test('wrapBold puts double asterisks around the selected text', () => {
  assert.deepEqual(wrapBold('你好世界', 2, 4), {text: '你好**世界**', start: 4, end: 6});
  assert.deepEqual(wrapBold('abc', 1, 1), {text: 'a****bc', start: 3, end: 3});
  assert.deepEqual(wrapBold('', 0, 0), {text: '****', start: 2, end: 2});
});

test('inlineBold splits text into plain and bold runs', () => {
  assert.deepEqual(inlineBold('发 **重要** 通知'), [
    {text: '发 ', bold: false}, {text: '重要', bold: true}, {text: ' 通知', bold: false},
  ]);
  assert.deepEqual(inlineBold('**未闭合'), [{text: '**未闭合', bold: false}]);
  assert.deepEqual(inlineBold(''), []);
});

test('the message menu offers delete that hides the message only for this account', () => {
  const html = readFileSync(new URL('../openteamily/static/chat/index.html', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../openteamily/static/chat/app.mjs', import.meta.url), 'utf8');
  assert.match(html, /data-menu="delete"/);
  assert.doesNotMatch(html, /data-menu="delete"[^>]*disabled/);
  assert.doesNotMatch(html, /还没有删除消息接口/);
  assert.match(app, /request\('DELETE', `\$\{socialBase\(\)\}\/\$\{cid\}\/messages\/\$\{item\.id\}`\)/);
});

test('folding preserves complete message and link preview preference never fetches or executes markup', async () => {
  const {renderMessageText}=await import('../openteamily/static/chat/utilities.mjs');
  const document={createElement:tag=>new FakeElement(tag)}, root=new FakeElement('div');
  const full='A'.repeat(900)+' <script>untrusted</script>';
  renderMessageText(document,root,full,'compact');
  assert.equal(root.children[0].tagName,'DETAILS');
  assert.equal(root.children[0].children[1].textContent,full);
  renderMessageText(document,root,full,'none');
  assert.equal(root.children.length,0);
  assert.equal(root.textContent,full);
  const links='https://example.invalid/path?x=1 https://user:password@example.invalid/ javascript:alert(1)';
  renderMessageText(document,root,links,'none',false);
  assert.equal(root.children.length,0);
  renderMessageText(document,root,links,'none',true);
  assert.equal(root.children.length,1);
  assert.equal(root.children[0].href,'https://example.invalid/path?x=1');
  assert.equal(root.children[0].rel,'noopener noreferrer');
  assert.match(root.children[0].title,/未抓取/);
});

function utilityDocument() {
  const nodes=new Map();
  const doc={createElement(tag){const e=new FakeElement(tag);e.style={};return e},getElementById(id){
    if(!nodes.has(id)){
      const e=doc.createElement('div');e.open=false;e.showModal=()=>{e.open=true};e.close=()=>{e.open=false;for(const h of e.handlers.close||[])h()};e.dispatchEvent=()=>{};nodes.set(id,e);
    }
    return nodes.get(id);
  }};
  return {doc,el:id=>doc.getElementById(id)};
}

test('resource picker cancels pending reads, inserts actual quoted content once, and never sends', async()=>{
  const {mountMessageUtilities}=await import('../openteamily/static/chat/utilities.mjs');
  const {doc,el}=utilityDocument();const posts=[];let finish,mode='defer';
  const c={wid:'workspace',cid:'conversation',source:'social',kind:'group'};
  mountMessageUtilities(doc,{context:()=>c,composerContext:()=>c,notify:()=>{},request:async(method,path,body)=>{
    if(method==='POST'){posts.push(body);throw Error('no send expected')}
    if(path.endsWith('/memory/note'))return mode==='defer'?await new Promise(resolve=>{finish=resolve}):{status:200,body:{page:{title:'Original note',revision:2,body:'<script>quoted, never executable</script>'}}};
    return {status:200,body:{items:[{id:'note',title:'Original note'}]}};
  }});
  el('chat-body').value='Keep this draft';
  await fire(el('composer-memory-open'),'click');await settle(2);
  const pending=fire(el('resource-picker-list').children[0].children[0],'click');await settle(1);
  el('resource-picker').close();finish({status:200,body:{page:{title:'stale',revision:1,body:'must not insert'}}});await pending;
  assert.equal(el('chat-body').value,'Keep this draft');
  mode='success';await fire(el('composer-memory-open'),'click');await settle(2);
  await fire(el('resource-picker-list').children[0].children[0],'click');
  assert.match(el('chat-body').value,/Original note（修订 2）/u);
  assert.ok(el('chat-body').value.endsWith(JSON.stringify('<script>quoted, never executable</script>')));
  assert.equal(el('resource-picker').open,false);assert.equal(posts.length,0);
});

test('model utility errors remain visible and retries retain identity without fake completion', async()=>{
  const {mountMessageUtilities}=await import('../openteamily/static/chat/utilities.mjs');
  const {doc,el}=utilityDocument();const writes=[];const c={wid:'w',cid:'c',kind:'group'};
  const utility=mountMessageUtilities(doc,{context:()=>c,composerContext:()=>c,notify:()=>{},request:async(method,_path,body,headers)=>{
    if(method==='GET')return {status:200,body:{items:[]}};
    writes.push({body,headers});return {status:409,body:{error:{message:'Own runtime is offline'}}};
  }});
  utility.open({id:'message',revision:3},'translate');await settle(2);
  el('message-assist-instruction').value='English';
  await fire(el('message-assist-form'),'submit',{preventDefault(){}});
  assert.equal(el('message-assist-status').textContent,'Own runtime is offline');
  assert.equal(el('message-assist-submit').disabled,false);
  await fire(el('message-assist-form'),'submit',{preventDefault(){}});
  assert.equal(writes[0].headers['Idempotency-Key'],writes[1].headers['Idempotency-Key']);
  assert.equal(writes[0].body.revision,3);assert.equal(el('message-assist-history').children.length,0);
  el('message-assist-dialog').close();
});


test('new dialog and document-card surfaces use actual theme tokens, not undefined white fallbacks', () => {
  const css = readFileSync(new URL('../openteamily/static/chat/app.css', import.meta.url), 'utf8');
  assert.match(css, /#message-assist-dialog, #announcement-dialog \{[^}]*color:var\(--ot-ink\);background:var\(--ot-surface\)/);
  assert.match(css, /#resource-picker \{[^}]*color:var\(--ot-ink\);background:var\(--ot-surface\)/);
  assert.match(css, /\.chat-document-card \{[^}]*color:var\(--ot-ink\);background:var\(--ot-surface\)/);
});


test('conversation search lists this conversation photos and files from real attachment fields', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher: original} = sessionFetcher();
  const restore = installChatGlobals({narrow: true});
  const attachment = (id, title, kind, mime) => ({id: id.repeat(32), title, kind, mime, revision: 1,
    path: '/v1/workspaces/ws-1/artifacts/' + id.repeat(32) + '/file'});
  const rows = [
    // Real uploads all land as kind 'media'; the mime is what separates photos.
    {id: 'm-1', user_id: bob, body: '', created: '2026-01-01T00:00:00Z', attachment: attachment('a', 'pixel.png', 'media', 'image/png')},
    {id: 'm-2', user_id: bob, body: '', created: '2026-01-01T00:01:00Z', attachment: attachment('b', 'plan.pdf', 'media', 'application/pdf')},
  ];
  try {
    await mount(doc, {fetcher: async path => {
      if (path.startsWith('/v1/workspaces/ws-1/social/conversations/conv-1/messages?')) {
        return json(200, {items: rows, cursor: null});
      }
      return original(path);
    }});
    await fire(el('conversation-list'), 'click', {target: sessionRows(el)[0]});
    await fire(el('conversation-search-open'), 'click');
    await fire(el('conversation-search-tab-photos'), 'click');
    assert.equal(el('conversation-search-tab-photos').getAttribute('aria-selected'), 'true');
    const photos = el('conversation-search-results').children;
    assert.equal(photos.length, 1, 'only the image attachment is a photo');
    assert.ok(descendants(photos[0]).some(node => node.textContent === 'pixel.png'));
    assert.match(el('conversation-search-status').textContent, /已显示 1 张照片/);
    await fire(photos[0], 'click');
    const jumped = el('message-list').children.find(node => node.dataset.messageId === 'm-1');
    assert.equal(jumped.dataset.searchJump, 'true', 'a photo hit jumps back to its message and highlights it');
    await fire(el('conversation-search-tab-files'), 'click');
    const files = el('conversation-search-results').children;
    assert.equal(files.length, 1, 'the document attachment is a file, not a photo');
    assert.ok(descendants(files[0]).some(node => node.textContent === 'plan.pdf'));
    assert.match(el('conversation-search-status').textContent, /已显示 1 个文件/);
    await fire(files[0], 'click');
    assert.match(el('conversation-search-status').textContent, /不在当前已加载/, 'a hit outside the loaded window says so instead of pretending');
  } finally { restore(); }
});

test('the photos and files tabs say what is missing instead of inventing an empty conversation', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher: original} = sessionFetcher();
  const restore = installChatGlobals({narrow: true});
  try {
    await mount(doc, {fetcher: async path => {
      if (path.startsWith('/v1/workspaces/ws-1/social/conversations/conv-1/messages?')) {
        return json(500, {error: {code: 'internal', message: 'nope'}});
      }
      return original(path);
    }});
    await fire(el('conversation-list'), 'click', {target: sessionRows(el)[0]});
    await fire(el('conversation-search-open'), 'click');
    await fire(el('conversation-search-tab-photos'), 'click');
    assert.match(el('conversation-search-status').textContent, /读不到当前会话的附件/);
    assert.equal(el('conversation-search-results').children.length, 0);
  } finally { restore(); }
});

for (const phase of ['directory', 'fanout']) for (const target of ['ws-1','ws-2']) {
  test(`deferred ${phase} from an older load cannot overwrite the latest ${target} session list`, async () => {
    const {doc, el} = fakeChatDocument(chatHtml()); const restore = installChatGlobals();
    let release, first=true; const requests=[];
    const row=id=>({id,kind:'group',title:id,updated:30,members:[]});
    const fetcher=async path=>{
      requests.push(path);
      if(path==='/v1/auth/session')return json(200,{user:{id:'user-1',username:'alice'}});
      if(path==='/v1/onboarding')return json(200,{onboarding:{completed:true}});
      if(path==='/v1/personal-agent')return json(200,{personal_agent:{workspace:{id:'ws-1'}}});
      if(path==='/v1/workspaces?limit=100')return json(200,{items:[{id:'ws-1',name:'First'},{id:'ws-2',name:'Second'}]});
      if(path==='/v1/settings')return json(200,{settings:{values:{}}});
      if(path.endsWith('/agents?limit=100')){
        if(first){first=false;
          if(phase==='directory')return await new Promise(resolve=>{release=()=>resolve(json(200,{items:[{id:'old-agent',name:'old'}]}));});
          return json(200,{items:[{id:'old-agent',name:'old'}]});
        }
        return json(200,{items:[]});
      }
      if(path.includes('/agents/old-agent/conversations?'))return await new Promise(resolve=>{release=()=>resolve(json(200,{items:[{id:'stale-agent-conversation',title:'stale',updated:40}]}));});
      if(path.endsWith('/social/conversations?limit=100'))return json(200,{items:[row(release?'new-current':'old-stale')]});
      if(path.endsWith('/members')||path.endsWith('/artifacts?limit=100'))return json(200,{items:[]});
      return json(404,{error:{message:'not in synthetic fixture'}});
    };
    try{
      mount(doc,{fetcher}); await settle(); assert.equal(typeof release,'function','first real request is pending');
      el('workspace').value=target; await fire(el('workspace'),'change'); await settle();
      const ids=()=>el('conversation-list').children.map(li=>li.children[0]?.dataset.conversation).filter(Boolean);
      assert.deepEqual(ids(),['new-current']);
      release(); await settle(); assert.deepEqual(ids(),['new-current'],'late old data must not overwrite a newer successful load');
      if(phase==='directory')assert.equal(requests.some(path=>path.includes('/agents/old-agent/')),false,'stale directory must not trigger new fanout');
    }finally{restore();}
  });
}


test('initial SSE cannot supersede an uncommitted session directory and lose a conversation deep link',async()=>{
 const {doc,el}=fakeChatDocument(chatHtml()),restore=installChatGlobals();const saved=globalThis.EventSource;
 const sources=[];let release,first=true;
 class Source{constructor(){this.handlers={};sources.push(this)}addEventListener(n,fn){this.handlers[n]=fn}close(){}}
 globalThis.EventSource=Source;globalThis.location.hash='#workspace=ws-1&agent=agent-1&conversation=conv-1';
 const fallback=chatFetcher().fetcher;
 const fetcher=async(path,options)=>{
  if(path.endsWith('/agents?limit=100')){if(first){first=false;return await new Promise(resolve=>{release=()=>resolve(json(200,{items:[{id:'agent-1',name:'Deep link agent'}]}));});}return json(200,{items:[{id:'agent-1',name:'Deep link agent'}]});}
  if(path.endsWith('/agents/agent-1/conversations?limit=100'))return json(200,{items:[{id:'conv-1',title:'Stored conversation'}]});
  if(path.endsWith('/agents/agent-1/conversations/conv-1'))return json(200,{conversation:{id:'conv-1',title:'Stored conversation'},items:[{id:'m-1',role:'assistant',body:'Stored actual response',status:'succeeded'}]});
  return fallback(path,options);
 };
 try{
  mount(doc,{fetcher});await settle();assert.equal(typeof release,'function');assert.equal(sources.length,0,'subscribe only after the initial directory commits');
  release();await settle();assert.equal(sources.length,1);
  sources[0].handlers.invalidate({data:JSON.stringify({version:'f'.repeat(64),domains:{social:'a'.repeat(64),artifacts:'b'.repeat(64),notifications:'c'.repeat(64)}})});
  await settle();assert.match(el('chat-title').textContent,/Deep link agent/);assert.ok(el('message-list').children.length>0,'initial snapshot refresh retains the deep-linked history');
 }finally{if(saved===undefined)delete globalThis.EventSource;else globalThis.EventSource=saved;restore();}
});

const reminderRow = (id, overrides = {}) => ({
  id, title: '提醒：看这条消息', template_id: 'custom', scope: 'once', enabled: true,
  participants: [{user_id: alice, username: 'alice'}],
  schedule: {kind: 'once', date: '2026-11-19', time: '14:30', time_zone: 'UTC'},
  ...overrides,
});

test('due reminders are only my enabled one-off automations that are already due, split by their own zone', () => {
  const now = Date.parse('2026-11-19T16:05:00Z');
  const rows = [
    reminderRow('a'.repeat(32)),
    reminderRow('b'.repeat(32), {schedule: {kind: 'once', date: '2026-11-19', time: '23:00', time_zone: 'UTC'}}),
    reminderRow('c'.repeat(32), {schedule: {kind: 'daily', time: '09:00', time_zone: 'UTC'}}),
    reminderRow('d'.repeat(32), {participants: [{user_id: bob, username: 'bob'}]}),
    reminderRow('e'.repeat(32), {enabled: false}),
    reminderRow('f'.repeat(32), {schedule: {kind: 'once', date: '2026-11-18', time: '09:00', time_zone: 'UTC'}}),
    reminderRow('0'.repeat(32), {schedule: {kind: 'once', date: '2026-11-19', time: '10:30', time_zone: 'Asia/Shanghai'}}),
    reminderRow('1'.repeat(32), {participants: [{username: 'alice'}], schedule: {kind: 'once', date: '2026-11-19', time: '13:00', time_zone: 'UTC'}}),
  ];
  const {today, older} = dueReminders(rows, {id: alice, username: 'alice'}, now);
  assert.deepEqual(today.map((item) => item.id), ['a'.repeat(32), '1'.repeat(32)]);
  assert.deepEqual(older.map((item) => item.id), ['0'.repeat(32), 'f'.repeat(32)]);
  assert.equal(reminderDueLabel(today[0], now), '今天 14:30 到点');
  assert.equal(reminderDueLabel(older[0], now), '11-19 10:30 到点');
  assert.equal(reminderDueLabel(older[1], now), '11-18 09:00 到点');
  assert.deepEqual(dueReminders([], alice, now), {today: [], older: []});
  assert.deepEqual(dueReminders(null, alice, now), {today: [], older: []});
});

test('the sidebar lists 今天到点的提醒 from the automations the server returns and says 读不到 instead of 0', async () => {
  const at = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const date = `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
  const due = {
    id: 'r'.repeat(32), title: '提醒：看这条消息', template_id: 'custom', scope: 'once', enabled: true,
    participants: [{user_id: alice, username: 'alice'}],
    schedule: {kind: 'once', date, time: '00:00', time_zone: 'UTC'},
  };
  const future = {
    ...due, id: 'q'.repeat(32), title: '提醒：明天',
    schedule: {kind: 'once', date: '2999-01-01', time: '09:00', time_zone: 'UTC'},
  };
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher: original} = sessionFetcher();
  const restore = installChatGlobals();
  try {
    await mount(doc, {fetcher: async (path, init = {}) => {
      if (path === '/v1/workspaces/ws-1/automations') return json(200, {items: [due, future]});
      return original(path);
    }});
    await settle();
    assert.equal(el('due-reminders').hidden, false, 'the panel appears when something is due today');
    assert.equal(el('due-reminders-heading').textContent, '今天到点的提醒 1 条');
    const rows = el('due-reminders-list').children;
    assert.equal(rows.length, 1, 'only the due one is listed');
    const link = rows[0].children[0];
    assert.equal(link.tagName, 'A');
    assert.match(String(link.getAttribute('href') || link.href), /\/automations$/);
    assert.match(link.textContent, /提醒：看这条消息/);
    assert.equal(link.children[0].textContent, '今天 00:00 到点');
  } finally { restore(); }

  const failing = fakeChatDocument(chatHtml());
  const restore2 = installChatGlobals();
  try {
    await mount(failing.doc, {fetcher: async (path, init = {}) => {
      if (path === '/v1/workspaces/ws-1/automations') return json(500, {error: {code: 'internal', message: 'boom'}});
      return original(path);
    }});
    await settle();
    assert.equal(failing.el('due-reminders').hidden, false, 'a failed read is shown, not hidden as 0');
    assert.equal(failing.el('due-reminders-note').hidden, false);
    assert.equal(failing.el('due-reminders-note').textContent, '读不到到点的提醒。');
    assert.equal(failing.el('due-reminders-list').children.length, 0);
  } finally { restore2(); }
});
