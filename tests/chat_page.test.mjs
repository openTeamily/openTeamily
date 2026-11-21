import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { mergeSessions, SEARCH_TABS, initial, chatIdentity, applyChatIdentity, composeSelectedLabel, filterMemberChoices, composeCreateEnabled, composeGroupPayload, GROUP_CREATE_INTRO, GROUP_CREATE_MODES, mount, messageSearchQuery, wrapBold, inlineBold, dueReminders, reminderDueLabel } from '../openteamily/static/chat/app.mjs';

import {consumePublicAgentOpening, publicAgentIntentFromHash, publicAgentContinuation, publicAgentOpening, stagePublicAgentOpening} from '../openteamily/static/shell/public-agent-link.mjs';
import {mountPublicAgentComposer} from '../openteamily/static/shell/public-agent-composer.mjs';
import {mountPublicDraft} from '../openteamily/static/chat/public-draft.mjs';

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
  assert.ok(choices[1].label.includes('AI 智能体'));
  assert.deepEqual(groupPickerChoices(humans, alice).map(row => row.id), [bob]);
  assert.equal(composeCreateEnabled({composeMode: 'group', selectedCount: 1, selectedHumanCount: 0}), false);
  assert.equal(composeCreateEnabled({composeMode: 'group', personal:true, selectedCount: 1, selectedHumanCount: 0, selectedAgentCount: 1}), true);
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
  assert.match(block, /<a href="\/agents"[^>]*>浏览智能体<\/a>/);
  assert.match(block, /<a href="\/guide"[^>]*>查看功能指引<\/a>/);
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
  insertBefore(node, before) {
    node.parent = this;
    this.children.splice(this.children.indexOf(before), 0, node);
    return node;
  }
  after(...nodes) {
    const parent = this.parent;
    if (!parent) return;
    const next = parent.children[parent.children.indexOf(this) + 1];
    if (next) for (const node of nodes) parent.insertBefore(node, next);
    else parent.append(...nodes);
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.append(...nodes);
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(type, handler) { (this.handlers[type] ||= []).push(handler); }
  dispatchEvent(event) {
    for (const listener of this.handlers[event.type] || []) listener(event);
    return true;
  }
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
    if (path === '/v1/workspaces/ws-1/agents?limit=100&include=conversations') return json(200, {items: []});
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
    if (path === '/v1/workspaces/ws-1/agents?limit=100&include=conversations') return json(200, {items: []});
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

test('a slow send moves the draft into the conversation and submits only once', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher, requests} = sessionFetcher();
  const restore = installChatGlobals({narrow: true});
  let resolveSend;
  let sends = 0;
  try {
    await mount(doc, {fetcher: (path, options) => {
      if (path.endsWith('/conv-1/messages') && options.method === 'POST') {
        sends += 1;
        return new Promise(resolve => { resolveSend = resolve; });
      }
      return fetcher(path);
    }});
    const row = sessionRows(el).find(item => item.dataset.conversation === 'conv-1');
    await fire(el('conversation-list'), 'click', {target: row});
    const body = el('chat-body');
    body.value = '发出这条消息';
    await fire(el('chat-form'), 'submit', {preventDefault() {}});
    const pending = el('message-list').children.at(-1);
    assert.equal(pending.dataset.sendPending, 'pending');
    assert.ok(descendants(pending).some(node => node.textContent === '正在发送…'));
    assert.equal(body.value, '');
    assert.equal(body.focused, true);
    assert.equal(el('chat-send').disabled, false);
    await fire(el('chat-form'), 'submit', {preventDefault() {}});
    assert.equal(sends, 1);
    body.value = '下一条草稿';
    resolveSend(json(201, {message: {id: 'sent', user_id: alice, body: '发出这条消息', created: 20}}));
    await settle();
    assert.equal(el('message-list').children.at(-1).dataset.messageId, 'sent');
    assert.equal(el('chat-send').disabled, false);
    assert.equal(body.value, '下一条草稿');
    assert.equal(requests.filter(path => path.endsWith('/conv-1')).length, 1);
  } finally { restore(); }
});

function nativeReplyChat(transport) {
  const {doc, el} = fakeChatDocument(chatHtml());
  doc.querySelector = selector => selector === 'meta[name="openteamily-instance"]' ? {} : null;
  const restore = installChatGlobals();
  globalThis.location.hash = '#workspace=ws-1&agent=agent-1&conversation=private-1';
  const {fetcher: fallback} = sessionFetcher();
  const agent = {id: 'agent-1', name: '助手'};
  const conversation = {id: 'private-1', agent_id: agent.id, title: '私聊', updated: 40};
  const path = '/v1/workspaces/ws-1/agents/agent-1/conversations/private-1';
  const fetcher = (url, opts) => url.endsWith('/agents?limit=100&include=conversations')
    ? json(200, {items: [agent], conversations: [conversation]})
    : url.startsWith(path) ? transport(url.slice(path.length), opts, {agent, conversation}) : fallback(url);
  return {doc, el, restore, fetcher};
}

test('private agent starters stage safe text, preserve drafts, and follow the latest native scope', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  doc.querySelector = selector => selector === 'meta[name="openteamily-instance"]' ? {} : null;
  const {fetcher: fallback} = sessionFetcher();
  const agentA = {id:'agent-a', workspace_id:'ws-1', served_by:'ds-bot', name:'甲',
    quick_starts:['核对 <原文>', '测试开场', 'x'.repeat(81), null]};
  const agentB = {...agentA, id:'agent-b', name:'乙', quick_starts:['旧目录开场']};
  const thread = {id:'thread-b', agent_id:agentB.id, title:'既有对话', updated:50};
  let latest = {...agentB, quick_starts:['既有会话的新开场']};
  let deferredAgent;
  const calls = [];
  const fetcher = (url, options = {}) => {
    calls.push({url, method:options.method || 'GET'});
    if (url.endsWith('/agents?limit=100&include=conversations')) {
      return json(200, {items:[agentA, agentB], conversations:[thread]});
    }
    if (url.endsWith('/agents/agent-b/conversations/thread-b')) {
      return json(200, {agent:latest, conversation:thread, items:[{role:'user', body:'已有历史'}]});
    }
    if (url.endsWith('/agents/agent-b')) return deferredAgent || json(200, {agent:latest});
    return fallback(url, options);
  };
  const restore = installChatGlobals({narrow:true});
  globalThis.location.hash = '#workspace=ws-1&agent=agent-a';
  try {
    await mount(doc, {fetcher});
    const input = el('chat-body');
    const list = el('agent-quick-starts-list');
    const panel = el('agent-quick-starts');
    const notice = el('agent-quick-starts-status');
    const buttons = [...list.children];
    assert.equal(panel.hidden, false);
    assert.deepEqual(buttons.map(button => [button.type,button.textContent]), [['button','核对 <原文>'],['button','测试开场']]);
    let changes = 0;
    input.addEventListener('input', () => { changes += 1; });
    await fire(buttons[0], 'click');
    assert.equal(input.value, '核对 <原文>');
    await fire(buttons[1], 'click');
    assert.equal(input.value, '核对 <原文>\n\n测试开场');
    assert.equal(input.focused, true);
    assert.equal(changes, 2);
    const oversized = '草'.repeat(3999);
    input.value = oversized;
    await fire(buttons[0], 'click');
    assert.equal(input.value, oversized);
    assert.equal(changes, 2);
    assert.equal(notice.hidden, false);
    assert.match(notice.textContent, /草稿已保留/);
    input.value = '改过的甲草稿';
    await fire(input, 'input');
    assert.equal(notice.hidden, true);
    assert.equal(calls.filter(call => call.method === 'POST' && /conversations|messages/.test(call.url)).length, 0);

    const row = sessionRows(el).find(button => button.dataset.conversation === thread.id);
    await fire(el('conversation-list'), 'click', {target:row});
    assert.equal(input.value, '');
    assert.deepEqual(list.children.map(button => button.textContent), ['既有会话的新开场']);
    await fire(buttons[0], 'click');
    assert.equal(input.value, '', 'detached controls from another native agent cannot edit this draft');
    await fire(list.children[0], 'click');
    assert.equal(input.value, '既有会话的新开场');
    assert.equal(el('message-list').children.length, 1, 'staging does not change the existing transcript');

    latest = {...agentB, quick_starts:['编辑后的开场']};
    doc.visibilityState = 'visible';
    await fire(doc, 'visibilitychange');
    await settle();
    assert.deepEqual(list.children.map(button => button.textContent), ['编辑后的开场']);
    assert.equal(input.value, '既有会话的新开场');
    assert.equal(calls.filter(call => call.url.endsWith('/agents/agent-b/conversations/thread-b')).length, 1);
    latest = {...latest, archived:1};
    const stale = list.children[0];
    await fire(doc, 'visibilitychange');
    await settle();
    assert.equal(panel.hidden, true);
    await fire(stale, 'click');
    assert.equal(input.value, '既有会话的新开场');

    let finishAgent;
    deferredAgent = new Promise(resolve => { finishAgent = resolve; });
    await fire(doc, 'visibilitychange');
    const direct = sessionRows(el).find(button => button.dataset.conversation === 'conv-1');
    await fire(el('conversation-list'), 'click', {target:direct});
    finishAgent(json(200, {agent:agentB}));
    await settle();
    assert.equal(panel.hidden, true);
    assert.equal(input.value, '');
  } finally { restore(); }
});

test('private quick starts are suppressed for an agent returned outside the current workspace', async () => {
  const {doc, el, restore, fetcher} = nativeReplyChat((path, options, scope) => {
    assert.equal(path, '');
    return json(200, {...scope, agent:{...scope.agent, workspace_id:'another-workspace', served_by:'ds-bot', quick_starts:['私密开场']}, items:[]});
  });
  try {
    await mount(doc, {fetcher});
    assert.equal(el('agent-quick-starts').hidden, true);
    assert.equal(el('agent-quick-starts-list').children.length, 0);
  } finally { restore(); }
});

test('a native reply streams as plain text without rebuilding history or changing an unsent draft', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const previous = {id: 'earlier', role: 'user', body: '更早的消息'};
  const snapshots = [null, '正在回答 <img src=x>', '正在回答 <img src=x>\n后续内容'];
  const progressKeys = [];
  let historyReads = 0;
  let finishPost;
  let requestKey;
  const {doc, el, restore, fetcher} = nativeReplyChat((path, opts, scope) => {
    if (!path) {
      historyReads += 1;
      return json(200, {...scope, items: [previous]});
    }
    if (path === '/messages' && opts.method === 'POST') {
      requestKey = opts.headers['Idempotency-Key'];
      return new Promise(resolve => { finishPost = resolve; });
    }
    const key = new URL(path, 'https://openteamily.test').searchParams.get('key');
    progressKeys.push(key);
    const next = snapshots.shift();
    return next == null ? json(404, {}) : json(200, {state: 'running', text: next});
  });
  try {
    await mount(doc, {fetcher});
    const list = el('message-list');
    const original = list.children[0];
    const field = el('chat-body');
    field.value = '回复这个问题';
    await fire(el('chat-form'), 'submit', {preventDefault() {}});
    const pending = list.children.at(-1);
    const preview = pending.children.find(node => node.className.includes('reply-preview'));
    assert.equal(pending.dataset.replyProgress, requestKey);
    assert.equal(preview.hidden, true);
    assert.equal(field.value, '');
    field.value = '下一条草稿';

    t.mock.timers.tick(400); await settle();
    assert.equal(preview.hidden, true, '404 during reservation leaves the pending reply intact');
    t.mock.timers.tick(400); await settle();
    assert.equal(preview.textContent, '正在回答 <img src=x>');
    assert.equal(preview.children.length, 0);
    assert.equal(preview.getAttribute('aria-live'), 'off');
    assert.equal(list.children[0], original);
    assert.equal(list.children.at(-1), pending);

    const scroller = el('message-scroller');
    scroller.clientHeight = 200;
    scroller.scrollHeight = 1000;
    scroller.scrollTop = 130;
    doc.visibilityState = 'hidden';
    await fire(doc, 'visibilitychange');
    t.mock.timers.tick(1200); await settle();
    assert.equal(progressKeys.length, 2);
    doc.visibilityState = 'visible';
    await fire(doc, 'visibilitychange');
    t.mock.timers.tick(400); await settle();
    assert.match(preview.textContent, /后续内容/);
    assert.equal(scroller.scrollTop, 130);
    assert.deepEqual(progressKeys, [requestKey, requestKey, requestKey]);

    finishPost(json(201, {
      message: {id: 'new-user', role: 'user', body: '回复这个问题', client_key: requestKey},
      reply: {id: 'new-reply', role: 'assistant', status: 'succeeded', body: '**最终回复**', client_key: requestKey},
    }));
    await settle();
    t.mock.timers.tick(2000); await settle();
    assert.equal(historyReads, 1, 'live progress and final POST do not re-fetch previous messages');
    assert.equal(progressKeys.length, 3);
    assert.deepEqual(list.children.map(node => node.dataset.messageId), ['earlier', 'new-user', 'new-reply']);
    assert.ok(descendants(list.children.at(-1)).some(node => node.tagName === 'STRONG' && node.textContent === '最终回复'));
    assert.equal(field.value, '下一条草稿');
    assert.equal(scroller.scrollTop, 130);
  } finally { restore(); }
});

test('an already running native reply resumes in its existing bubble and loads the final history once', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const key = 'msg-reloaded-reply';
  const user = {id: 'saved-user', role: 'user', body: '等待中的问题', client_key: key};
  const reply = {id: 'saved-reply', role: 'assistant', status: 'running', client_key: key};
  let historyReads = 0;
  let polls = 0;
  const {doc, el, restore, fetcher} = nativeReplyChat((path, _opts, scope) => {
    if (!path) {
      historyReads += 1;
      const current = polls < 2 ? reply : {...reply, status: 'succeeded', body: '已保存的答复'};
      return json(200, {...scope, items: [user, current]});
    }
    assert.equal(path, '/reply-progress?key=' + key);
    polls += 1;
    return json(200, polls === 1 ? {state: 'running', text: '正在继续回复'} : {state: 'succeeded'});
  });
  try {
    await mount(doc, {fetcher});
    const list = el('message-list');
    const pending = list.children.at(-1);
    assert.equal(pending.dataset.messageId, reply.id);
    t.mock.timers.tick(400); await settle();
    assert.equal(list.children.at(-1), pending);
    assert.equal(pending.children.at(-1).textContent, '正在继续回复');
    t.mock.timers.tick(400); await settle();
    assert.deepEqual(list.children.map(node => node.dataset.messageId), [user.id, reply.id]);
    assert.equal(list.children.at(-1).dataset.replyProgress, undefined);
    assert.ok(descendants(list.children.at(-1)).some(node => node.textContent === '已保存的答复'));
    t.mock.timers.tick(3000); await settle();
    assert.equal(historyReads, 2);
    assert.equal(polls, 2);
  } finally { restore(); }
});

function groupReplyChat(transport) {
  const {doc, el} = fakeChatDocument(chatHtml());
  doc.querySelector = selector => selector === 'meta[name="openteamily-instance"]' ? {} : null;
  const restore = installChatGlobals();
  globalThis.location.hash = '#workspace=ws-1&social=conv-1';
  const {fetcher: fallback} = sessionFetcher();
  const base = '/v1/workspaces/ws-1/social/conversations';
  const conversation = {id: 'conv-1', kind: 'group', title: '测试群', updated: 40,
    members: [{user_id: alice, username: 'alice'}],
    agent_members: [{id: 'agent-1', name: '助手一'}, {id: 'agent-2', name: '助手二'}]};
  const fetcher = (url, opts) => url.startsWith(base + '/conv-1')
    ? transport(url.slice((base + '/conv-1').length), opts, conversation)
    : fallback(url);
  return {doc, el, restore, fetcher};
}

test('group progress updates only the original job and attempt and clears stale text', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const source = {id: 'source', user_id: alice, body: '请两位协助', created: 1, seq: 1, reply_jobs: [
    {id: 'job-a', attempt: 2, status: 'queued', agent_name: '助手一'},
    {id: 'job-b', attempt: 1, status: 'running', agent_name: '助手二'},
  ]};
  const flowing = [{id: 'job-a', message_id: 'source', attempt: 2, text: '原样显示 <em>片段</em>'},
    {id: 'job-b', message_id: 'other-source', attempt: 1, text: '别的消息'}];
  const batches = [...Array(18).fill(flowing),
    [{id: 'job-a', message_id: 'source', attempt: 1, text: '过期的尝试'},
      {id: 'job-b', message_id: 'source', attempt: 1, text: '另一个智能体的新进度'}],
  ];
  let historyReads = 0;
  let progressReads = 0;
  let pending;
  let signal;
  const {doc, el, restore, fetcher} = groupReplyChat((path, opts, conversation) => {
    if (!path) {
      historyReads += 1;
      return json(200, {conversation, items: [source]});
    }
    assert.equal(path, '/reply-progress');
    progressReads += 1;
    if (batches.length) return json(200, {items: batches.shift()});
    signal = opts.signal;
    return new Promise(resolve => { pending = resolve; });
  });
  try {
    await mount(doc, {fetcher});
    const list = el('message-list');
    const original = list.children[0];
    const jobs = descendants(original).filter(node => node.className === 'group-reply-job');
    const [first, second] = jobs.map(row => row.children.find(node => node.className === 'group-reply-preview'));
    t.mock.timers.tick(500); await settle();
    assert.equal(list.children[0], original);
    assert.equal(first.textContent, '原样显示 <em>片段</em>');
    assert.equal(first.children.length, 0);
    assert.equal(first.getAttribute('aria-live'), 'off');
    assert.equal(second.hidden, true);
    assert.equal(jobs[0].dataset.state, 'running');
    for (let index = 0; index < 17; index += 1) {
      t.mock.timers.tick(500);
      await settle();
    }
    assert.equal(historyReads, 1, 'no legacy transcript poll after 8 seconds of healthy snapshots');

    const scroller = el('message-scroller');
    scroller.scrollHeight = 1000;
    scroller.clientHeight = 200;
    scroller.scrollTop = 120;
    t.mock.timers.tick(500); await settle();
    assert.equal(first.hidden, true);
    assert.equal(second.textContent, '另一个智能体的新进度');
    assert.equal(scroller.scrollTop, 120);
    assert.equal(historyReads, 1);

    t.mock.timers.tick(500); await settle();
    doc.visibilityState = 'hidden';
    await fire(doc, 'visibilitychange');
    assert.equal(signal.aborted, true);
    assert.equal(second.hidden, true);
    pending(json(200, {items: [{id: 'job-b', message_id: 'source', attempt: 1, text: '迟到的隐藏更新'}]}));
    t.mock.timers.tick(2000); await settle();
    assert.equal(progressReads, 20);
    assert.equal(second.hidden, true);
  } finally { restore(); }
});

test('manual group requests preserve a failed draft and append the eventual accepted group message', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const promptText = '请总结这次讨论';
  const message = {id: 'requested', body: promptText, user_id: alice, created: 1, seq: 1,
    reply_jobs: [{id: 'manual-job', attempt: 1, agent_name: '助手一', status: 'queued'}]};
  const sends = [];
  let historyReads = 0;
  const {doc, el, restore, fetcher} = groupReplyChat((path, opts, conversation) => {
    if (!path) {
      historyReads += 1;
      return json(200, {conversation, items: []});
    }
    if (path === '/agent-replies') {
      sends.push({body: JSON.parse(opts.body), key: opts.headers['Idempotency-Key']});
      return sends.length === 1 ? json(503, {}) : json(202, {message});
    }
    assert.equal(path, '/reply-progress');
    return json(200, {items: [{id: 'manual-job', message_id: message.id, attempt: 1, text: '讨论要点'}]});
  });
  const querySelectorAll = doc.querySelectorAll;
  doc.querySelectorAll = selector => selector === '#group-agent-choices input[name="group-agent"]:checked'
    ? el('group-agent-choices').children.map(label => label.children[0]).filter(box => box.checked)
    : querySelectorAll(selector);
  try {
    await mount(doc, {fetcher});
    const prompt = el('group-agent-prompt');
    const selected = el('group-agent-choices').children[0].children[0];
    selected.checked = true;
    prompt.value = promptText;
    const submit = () => fire(el('group-agent-form'), 'submit', {preventDefault() {}});
    await submit();
    assert.equal(prompt.value, promptText);
    assert.equal(selected.checked, true);
    assert.equal(el('message-list').children.length, 0);

    await submit();
    assert.equal(prompt.value, '');
    assert.deepEqual(sends[0].body, {agent_ids: ['agent-1'], prompt: promptText});
    assert.equal(sends[0].key, sends[1].key);
    const original = el('message-list').children[0];
    assert.equal(original.dataset.messageId, message.id);
    const preview = descendants(original).find(node => node.className === 'group-reply-preview');
    t.mock.timers.tick(500); await settle();
    assert.equal(preview.textContent, '讨论要点');
    assert.equal(historyReads, 1);
  } finally { restore(); }
});

test('the first chat opens using the batched directory while people and artifacts are pending', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher: fallback, requests} = sessionFetcher();
  const restore = installChatGlobals({narrow: false});
  let releasePeople, releaseArtifacts;
  async function fetcher(path) {
    if (path.endsWith('/agents?limit=100&include=conversations')) {
      return json(200, {items: [{id: 'brief', name: 'Brief'}],
        conversations: [{id: 'brief-chat', agent_id: 'brief', title: 'Prior briefing', updated: 1}]});
    }
    if (path.endsWith('/members')) return new Promise(resolve => {releasePeople = resolve;});
    if (path.endsWith('/artifacts?limit=100')) return new Promise(resolve => {releaseArtifacts = resolve;});
    return fallback(path);
  }
  try {
    mount(doc, {fetcher});
    await settle();
    assert.ok(releasePeople && releaseArtifacts);
    assert.ok(sessionRows(el).some(row => row.dataset.conversation === 'brief-chat'));
    assert.equal(el('message-list').children[0].dataset.messageId, 'm-1');
    assert.ok(!requests.some(path => path.includes('/agents/brief/conversations')));
    await fire(el('compose-add-contact'), 'click');
    assert.match(el('compose-members-empty').textContent, /正在加载/);
    releasePeople(json(200, {items: [{user_id: bob, username: 'bob'}]}));
    releaseArtifacts(json(200, {items: []}));
    await settle();
    assert.equal(descendants(el('member-choices')).filter(node => node.tagName === 'INPUT')[0].value, bob);
  } finally { restore(); }
});

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

const openingVersion = 'a'.repeat(64);
const publicListingId = 'otl_' + 'A'.repeat(26);
const openingToken = 'c'.repeat(32);

test('public agent continuation only allows a slug, with an optional exclusive starter or opaque token', () => {
  const intent = {slug:'writing-demo', quickStart:0, version:openingVersion};
  const hash = '#public-agent=writing-demo&quick-start=0&quick-start-version=' + openingVersion;
  assert.equal(publicAgentContinuation(intent), hash);
  assert.deepEqual(publicAgentIntentFromHash(hash), intent);
  assert.deepEqual(publicAgentIntentFromHash('#public-agent=writing-demo'), {slug:'writing-demo'});
  const staged = '#public-agent=writing-demo&draft=' + openingToken;
  assert.equal(publicAgentContinuation({slug:'writing-demo', draft:openingToken}), staged);
  assert.deepEqual(publicAgentIntentFromHash(staged), {slug:'writing-demo', draft:openingToken});
  assert.equal(publicAgentContinuation({...intent, draft:openingToken}), '');
  for (const bad of [
    '#public-agent=writing-demo&quick-start=0', '#public-agent=writing-demo&quick-start-version=' + openingVersion,
    '#public-agent=%2F%2Fevil.test', '?start=1', hash + '&next=https://evil.test',
    hash + '&quick-start=2', hash.replace('=0', '=5'), hash.replace(openingVersion,'x'),
    hash + '&draft=' + openingToken, staged + '&draft=' + openingToken,
    staged.replace(openingToken, 'private%20draft'),
  ]) assert.equal(publicAgentIntentFromHash(bad), null, bad);
});

function publicOpeningView() {
  const saved = new Map();
  return {saved, view: {crypto:webcrypto, sessionStorage: {
    get length() { return saved.size; },
    key: index => [...saved.keys()][index],
    getItem: key => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
    removeItem: key => saved.delete(key),
  }}};
}

test('public homepage drafts expire, stay in the original tab and are consumed once', () => {
  const {saved, view} = publicOpeningView();
  const params = {slug:'writing-demo', listingId:publicListingId, text:'首页草稿 & <draft>？'};
  const hash = stagePublicAgentOpening(view, params);
  const intent = publicAgentIntentFromHash(hash);
  assert.match(hash, /^#public-agent=writing-demo&draft=[a-f0-9]{32}$/);
  assert.equal(publicAgentOpening(publicOpeningView().view, intent), null);
  assert.equal(publicAgentOpening(view, {...intent, slug:'other-agent'}), null);
  assert.equal(publicAgentOpening(view, intent).text, params.text);
  assert.equal(publicAgentOpening(view, intent).listingId, publicListingId);
  consumePublicAgentOpening(view, intent);
  assert.equal(publicAgentOpening(view, intent), null);
  const expired = publicAgentIntentFromHash(stagePublicAgentOpening(view, params));
  const key = [...saved.keys()][0];
  saved.set(key, JSON.stringify({...JSON.parse(saved.get(key)), expiresAt:Date.now() - 1}));
  assert.equal(publicAgentOpening(view, expired), null);
  assert.equal(saved.size, 0);
  assert.equal(stagePublicAgentOpening(view, {...params, text:'a'.repeat(4001)}), '');
});

test('homepage composer only navigates with an opaque fragment and reports storage failure inline', async () => {
  const {view} = publicOpeningView();
  const {doc, el} = fakeChatDocument('<form id="public-agent-composer"></form><p id="public-agent-composer-status" hidden></p>');
  const form = el('public-agent-composer');
  const textarea = new FakeElement('textarea');
  const button = new FakeElement('button');
  const pageEvents = [];
  const destinations = [];
  form.dataset = {slug:'writing-demo', listingId:publicListingId};
  form.querySelector = selector => selector === 'textarea[name="message"]' ? textarea : button;
  view.addEventListener = (_name, handler) => pageEvents.push(handler);
  view.location = {assign: path => destinations.push(path)};
  doc.defaultView = view;
  mountPublicAgentComposer(doc);
  assert.equal(button.disabled, true);
  textarea.value = '你好，整理一下这份资料';
  await fire(textarea, 'input');
  assert.equal(button.disabled, false);
  let prevented = false;
  const event = {preventDefault: () => { prevented = true; }};
  const storage = view.sessionStorage;
  view.sessionStorage = null;
  await fire(form, 'submit', event);
  assert.equal(prevented, true);
  assert.equal(el('public-agent-composer-status').hidden, false);
  assert.equal(destinations.length, 0);
  view.sessionStorage = storage;
  await fire(form, 'submit', event);
  assert.match(destinations[0], /^\/login#public-agent=writing-demo&draft=[a-f0-9]{32}$/);
  assert.equal(button.disabled, true);
  pageEvents[0]({persisted:true});
  assert.equal(button.disabled, false);
  assert.equal(el('public-agent-composer-status').hidden, true);
});

test('a versioned public quick start opens a conversation and stages the composer without sending', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  doc.querySelector = selector => selector === 'meta[name="openteamily-instance"]' ? {} : null;
  const calls = [];
  const conversation = {id:'otc_test_1', kind:'group', title:'文档助手', public_agent:{open:true}, members:[]};
  const base = '/v1/workspaces/ws-1/social/conversations';
  const hash = publicAgentContinuation({slug:'writing-demo', quickStart:0, version:openingVersion});
  const starter = '列出这个助手能做什么';
  const {fetcher: fallback} = chatFetcher();
  const fetcher = async (path, options = {}) => {
    calls.push({path, method:options.method || 'GET'});
    if (path === '/v1/discover/agents/writing-demo/start') {
      assert.equal(options.method,'POST');
      assert.deepEqual(JSON.parse(options.body), {quick_start:0, quick_start_version:openingVersion});
      return json(200, {workspace_id:'ws-1', conversation_id:conversation.id, draft_text:starter});
    }
    if (path === `${base}/${conversation.id}`) return json(200, {conversation, items:[]});
    return fallback(path);
  };
  const restore = installChatGlobals({narrow:true});
  globalThis.location.hash = hash;
  const writes = [];
  globalThis.history.replaceState = (_state, _title, href) => {
    writes.push(href);
    globalThis.location.hash = href.includes('#') ? '#' + href.split('#').pop() : '';
  };
  try {
    await mount(doc, {fetcher});
    await settle();
    assert.equal(calls.filter(({path}) => path.endsWith('/start')).length, 1);
    assert.equal(calls.filter(({method,path}) => method === 'POST' && path.endsWith('/messages')).length, 0);
    assert.equal(el('chat-body').value, starter);
    assert.equal(el('chat-body').focused, true);
    assert.equal(el('message-list').children.length, 0);
    assert.equal(writes.at(-1), '/chat#workspace=ws-1&social=' + conversation.id);
  } finally { restore(); }
});

test('homepage draft survives start and conversation retry, then attaches once to the verified thread', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {view} = publicOpeningView();
  doc.defaultView = view;
  doc.querySelector = selector => selector === 'meta[name="openteamily-instance"]' ? {} : null;
  const typed = '我的首页草稿\n两行都要保留。';
  const hash = stagePublicAgentOpening(view, {slug:'writing-demo', listingId:publicListingId, text:typed});
  const intent = publicAgentIntentFromHash(hash);
  const conversation = {id:'otc_home_open', kind:'group', title:'文档助手', public_agent:{open:true}, members:[]};
  const calls = [];
  let starts = 0;
  let details = 0;
  const {fetcher: fallback} = chatFetcher();
  const fetcher = async (path, options = {}) => {
    calls.push({path, method:options.method || 'GET', body:options.body});
    if (path === '/v1/discover/agents/writing-demo/start') {
      assert.deepEqual(JSON.parse(options.body), {listing_id:publicListingId});
      return ++starts === 1 ? json(503, {}) : json(200, {workspace_id:'ws-1', conversation_id:conversation.id});
    }
    if (path === '/v1/workspaces/ws-1/social/conversations/' + conversation.id) {
      return ++details === 1 ? json(503, {}) : json(200, {conversation, items:[]});
    }
    return fallback(path);
  };
  const restore = installChatGlobals({narrow:true});
  globalThis.location.hash = hash;
  globalThis.history.replaceState = (_state, _title, href) => {
    globalThis.location.hash = href.includes('#') ? '#' + href.split('#').pop() : '';
  };
  try {
    view.sessionStorage.setItem(
      'openteamily.public-agent-draft:' + JSON.stringify(['user-1','ws-1','social',undefined,conversation.id]),
      '已有对话草稿',
    );
    await mount(doc, {fetcher});
    assert.equal(starts, 1);
    assert.equal(details, 0);
    assert.equal(publicAgentOpening(view, intent).text, typed);
    let retry = el('status').children.findLast(node => node.id === 'public-agent-retry');
    await fire(retry, 'click');
    assert.equal(details, 1);
    assert.equal(publicAgentOpening(view, intent).text, typed);
    retry = el('status').children.findLast(node => node.id === 'public-agent-retry');
    await fire(retry, 'click');
    await settle();
    assert.equal(starts, 3);
    assert.equal(details, 2);
    assert.equal(el('chat-body').value, '已有对话草稿\n\n' + typed);
    assert.equal(el('chat-body').focused, true);
    assert.equal(publicAgentOpening(view, intent), null);
    assert.equal(globalThis.location.hash, '#workspace=ws-1&social=' + conversation.id);
    assert.ok(calls.every(({method,path,body}) => !(method === 'POST' && path.endsWith('/messages')) && !String(body).includes('首页草稿')));
  } finally { restore(); }
});

test('public draft preserves the edited text for its owner and thread, clearing when sent', async () => {
  const saved = new Map();
  const defaultView = {sessionStorage:{getItem:key => saved.get(key) || null,
    setItem:(key, value) => saved.set(key,value), removeItem:key => saved.delete(key)}};
  const {doc, el} = fakeChatDocument(chatHtml());
  doc.defaultView = defaultView;
  const draft = mountPublicDraft(doc);
  draft.enter('alice/thread', true);
  assert.equal(draft.fill('公开开场'), true);
  el('chat-body').value = '改过的开场';
  await fire(el('chat-body'), 'input');
  draft.enter('bob/thread', true);
  assert.equal(el('chat-body').value,'');
  const {doc:reopened,el:field} = fakeChatDocument(chatHtml());
  reopened.defaultView = defaultView;
  const restored = mountPublicDraft(reopened);
  restored.enter('alice/thread', true);
  restored.fill('第二个快捷开场');
  assert.equal(field('chat-body').value, '改过的开场');
  field('chat-body').value = '';
  restored.persist();
  assert.equal(saved.size,0);
});

test('draft typing during native conversation creation follows the committed thread', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const draft = mountPublicDraft(doc);
  const input = el('chat-body');
  draft.enter('alice/agent/new');
  input.value = '第一条正在发送时的下一份草稿';
  await fire(input, 'input');
  draft.move('alice/agent/new', 'alice/agent/thread');
  draft.enter('alice/agent/new');
  assert.equal(input.value, '');
  draft.enter('alice/agent/thread');
  assert.equal(input.value, '第一条正在发送时的下一份草稿');
});

test('an over-limit homepage draft stays recoverable without changing the owner and thread composer', async () => {
  const {view} = publicOpeningView();
  const {doc, el} = fakeChatDocument(chatHtml());
  doc.defaultView = view;
  const draft = mountPublicDraft(doc);
  draft.enter('alice/thread', true);
  const existing = '旧'.repeat(4000);
  const typed = '新草稿';
  assert.equal(draft.fill(existing), true);
  assert.equal(draft.fillOpening(typed), 'saved');
  assert.equal(el('chat-body').value, existing);
  assert.equal(el('public-draft-recovery').hidden, false);
  assert.equal(el('public-draft-recovery-text').value, typed);
  draft.enter('bob/thread', true);
  assert.equal(el('public-draft-recovery').hidden, true);
  assert.equal(el('public-draft-recovery-text').value, '');
  const {doc: reloaded, el: field} = fakeChatDocument(chatHtml());
  reloaded.defaultView = view;
  const restored = mountPublicDraft(reloaded);
  restored.enter('alice/thread', true);
  assert.equal(field('chat-body').value, existing);
  assert.equal(field('public-draft-recovery-text').value, typed);
  await fire(field('public-draft-recovery-clear'), 'click');
  assert.equal(field('public-draft-recovery').hidden, true);
  assert.equal(field('chat-body').value, existing);
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
      if (path.endsWith('/agents?limit=100&include=conversations')) return json(200, {items: [{id: 'personal', name: 'Personal'}]});
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
      if (path.includes('/social/conversations/conv-1/messages?q=')) {
        calls.push(path);
        const url = new URL(path, 'https://management.test');
        assert.equal(url.pathname, '/v1/workspaces/ws-1/social/conversations/conv-1/messages');
        return json(200, {items: [{kind: 'social', conversation_id: 'conv-1', id: url.searchParams.get('before') ? 'second' : 'first', body: 'Scoped result'}], cursor: url.searchParams.get('before') ? null : 42});
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
    assert.match(calls[1], /before=42/);
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

test('icon chat controls have accessible names and a direct file picker', () => {
  const html = chatHtml();
  assert.match(html, /id="conversation-search-open"[^>]*aria-label="搜索当前会话"[\s\S]*?<svg/);
  assert.match(html, /id="chat-call" hidden aria-label="通话" aria-haspopup="dialog"/);
  assert.match(html, /id="chat-attachment-open"[^>]*aria-label="发送文件"/);
  assert.match(html, /id="chat-attachment"[^>]*multiple hidden/);
  assert.match(html, /id="voice-record"[^>]*aria-label="录制语音"/);
  assert.match(html, /id="voice-preview" controls/);
});

import {notificationBadgeText, notificationSummary, notificationTarget} from '../openteamily/static/chat/app.mjs';

test('notification badge and summary text', () => {
  assert.equal(notificationBadgeText(0), '');
  assert.equal(notificationBadgeText(3), '3');
  assert.equal(notificationBadgeText(120), '99+');
  assert.equal(notificationSummary({actor_username: 'bob', conversation_kind: 'group', conversation_title: '项目群'}),
    'bob 在「项目群」提及了你');
  assert.equal(notificationSummary({actor_username: 'bob', conversation_kind: 'dm', conversation_title: 'bob'}),
    'bob 在「单聊」提及了你');
  assert.equal(notificationSummary({kind: 'messenger.added', by: {display_name: '小林'}, title: '项目群'}),
    '小林 将你加入「项目群」');
  assert.equal(notificationSummary({kind: 'messenger.call', by: {display_name: '小林'}, title: '项目群', call_kind: 'video'}),
    '小林 在「项目群」发起了视频通话');
  assert.equal(notificationSummary({kind: 'meeting.shared', organizer: '小林', title: '设计评审'}),
    '小林 分享了纪要「设计评审」');
  assert.equal(notificationSummary({kind: 'discover.published', listing_kind: 'agent', actor_username: '小林', title: '日程助手'}),
    '小林 发布了新智能体「日程助手」');
  assert.equal(notificationSummary({kind: 'artifact.shared', actor_username: '小林', title: '排期表'}),
    '小林 分享了作品「排期表」');
});

test('notification targets only resolve exact receipt scope and safe public listing slugs', () => {
  const workspace = 'a'.repeat(32);
  const other = 'b'.repeat(32);
  const share = 'c'.repeat(32);
  const path = `/meetings#workspace=${workspace}&shared=${share}`;
  const meeting = {kind: 'meeting.shared', workspace_id: workspace, share_id: share};
  assert.equal(notificationTarget(meeting, workspace), path);
  assert.equal(notificationTarget({kind: 'meeting.shared', path}, workspace), path);
  assert.equal(notificationTarget({...meeting, path}, other), null);
  assert.equal(notificationTarget({...meeting, path: path + '&new=1'}, workspace), null);
  assert.equal(notificationTarget({...meeting, path: path.replace(share, other)}, workspace), null);
  assert.equal(notificationTarget({...meeting, path: '//outside.example'}, workspace), null);
  assert.equal(notificationTarget({kind: 'discover.published', listing_kind: 'work', slug: 'published-work'}), '/w/published-work');
  assert.equal(notificationTarget({kind: 'discover.published', listing_kind: 'agent', slug: 'assistant-app'}), '/a/assistant-app');
  assert.equal(notificationTarget({kind: 'discover.published', listing_kind: 'agent', slug: 'assistant-app', path: '/w/assistant-app'}), null);
  assert.equal(notificationTarget({kind: 'discover.published', listing_kind: 'work', slug: '../settings'}), null);
  assert.equal(notificationTarget({kind: 'follow_work', path: '/w/legacy-slug'}), '/w/legacy-slug');
  assert.equal(notificationTarget({kind: 'follow_work', path: 'https://outside.example/w/legacy-slug'}), null);
  assert.equal(notificationTarget({kind: 'automation_reminder', path: '/wrong'}), '/automations');
  const conversation = 'otc_' + 'A'.repeat(26);
  const message = 'otm_' + 'B'.repeat(26);
  const work = {kind: 'artifact.shared', workspace_id: workspace, conversation_id: conversation, message_id: message};
  const expected = `/chat#workspace=${workspace}&social=${conversation}&message=${message}`;
  assert.equal(notificationTarget({...work, path: expected}, workspace), expected);
  assert.equal(notificationTarget(work, other), null);
  assert.equal(notificationTarget({...work, message_id: '../settings'}, workspace), null);
  assert.equal(notificationTarget({...work, path: '//outside.example'}, workspace), null);
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
      if (path === '/v1/workspaces/ws-1/notifications' || path === '/v1/workspaces/ws-1/notifications?filter=unread') return json(200, inbox());
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

test('native notification links bound the read wait, fetch newest unread, and ignore stale workspace actions', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher: original} = sessionFetcher();
  const restore = installChatGlobals();
  const workspace = 'd'.repeat(32);
  const other = 'e'.repeat(32);
  const inboxPath = `/v1/workspaces/${workspace}/notifications`;
  const receipt = {id: 'receipt', kind: 'meeting.shared', title: '版本复盘', organizer: '小方', created: 30,
    workspace_id: workspace, share_id: 'f'.repeat(32)};
  receipt.path = `/meetings#workspace=${workspace}&shared=${receipt.share_id}`;
  const newest = {id: 'newest', kind: 'discover.published', listing_kind: 'agent', title: '计划助手',
    actor_username: '小方', slug: 'schedule-assistant', path: '/a/schedule-assistant', created: 50};
  const late = {...receipt, id: 'late', share_id: '1'.repeat(32)};
  late.path = `/meetings#workspace=${workspace}&shared=${late.share_id}`;
  const navigation = [];
  const marks = [];
  const filters = [];
  let completeRead;
  let receiptRead = false;
  globalThis.location.assign = path => navigation.push(path);
  try {
    await mount(doc, {fetcher: async (path, options = {}) => {
      if (path === '/v1/workspaces?limit=100') return json(200, {items: [
        {id: workspace, name: '本工作区'}, {id: other, name: '另一工作区'},
      ]});
      if (path === '/v1/personal-agent') return json(200, {personal_agent: {workspace: {id: workspace}}});
      if (path === inboxPath || path === inboxPath + '?filter=unread') {
        const filtered = path.includes('?');
        filters.push(filtered);
        return json(200, filtered ? {unread_count: 2, items: [newest, late]}
          : {unread_count: receiptRead ? 0 : 1, items: [{...receipt, read: receiptRead}]});
      }
      if (path === inboxPath + '/read') {
        const id = JSON.parse(options.body).notification_id;
        marks.push({path, id, keepalive: options.keepalive});
        if (id === newest.id) return json(503, {});
        return new Promise(resolve => { completeRead = resolve; });
      }
      if (path.startsWith(`/v1/workspaces/${other}/notifications`)) return json(200, {unread_count: 0, items: []});
      return original(path.replace(workspace, 'ws-1').replace(other, 'ws-1'));
    }});
    const rows = () => el('notification-list').children.map(row => row.children[0]);
    await fire(el('notifications-toggle'), 'click');
    const first = rows()[0];
    assert.equal(first.tagName, 'A');
    assert.equal(first.href, receipt.path);
    assert.equal(first.children[0].textContent, '小方 分享了纪要「版本复盘」');
    const clicked = () => ({preventDefault() {}});
    const pending = fire(first, 'click', clicked());
    assert.deepEqual(navigation, []);
    assert.equal(first.getAttribute('aria-busy'), 'true');
    receiptRead = true;
    completeRead(json(200, {unread_count: 0}));
    await pending;
    assert.deepEqual(navigation, [receipt.path]);
    assert.equal(el('notification-count').hidden, true);

    await fire(el('notifications-toggle'), 'click');
    el('notifications-unread').checked = true;
    await fire(el('notifications-unread'), 'change');
    assert.equal(filters.at(-1), true);
    assert.deepEqual(rows().map(row => row.dataset.notification), [newest.id, late.id]);
    assert.equal(el('notification-count').textContent, '2');
    await fire(rows()[0], 'click', clicked());
    assert.deepEqual(navigation, [receipt.path, newest.path]);
    assert.equal(el('notification-count').textContent, '2', 'temporary read failure leaves the badge unread');

    await fire(el('notifications-toggle'), 'click');
    const denied = fire(rows()[1], 'click', clicked());
    completeRead(json(404, {}));
    await denied;
    assert.deepEqual(navigation, [receipt.path, newest.path]);
    assert.equal(el('notifications-panel').hidden, false);

    const slow = fire(rows()[1], 'click', clicked());
    t.mock.timers.tick(499);
    await settle();
    assert.deepEqual(navigation, [receipt.path, newest.path]);
    t.mock.timers.tick(1);
    await slow;
    assert.deepEqual(navigation, [receipt.path, newest.path, late.path]);
    assert.equal(el('notification-count').textContent, '2', 'opening at the deadline does not acknowledge the notification');
    completeRead(json(200, {unread_count: 1}));
    await settle();
    assert.equal(el('notification-count').textContent, '1', 'a real late acknowledgement still updates the inbox');

    await fire(el('notifications-toggle'), 'click');
    const old = rows()[1];
    const lost = fire(old, 'click', clicked());
    el('workspace').value = other;
    await fire(el('workspace'), 'change');
    completeRead(json(200, {unread_count: 1}));
    await lost;
    await fire(old, 'click', clicked());
    assert.deepEqual(navigation, [receipt.path, newest.path, late.path]);
    assert.deepEqual(marks, [receipt.id, newest.id, late.id, late.id, late.id]
      .map(id => ({path: inboxPath + '/read', id, keepalive: true})));
    assert.equal(el('notification-count').hidden, true);
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
  assert.match(html, /id="group-translate"[^>]*aria-label="自动翻译"/);
  assert.match(html, /id="group-translate-language"/);
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

test('composer + creation grid opens real editors and generation dialogs', () => {
  const html = readFileSync(new URL('../openteamily/static/chat/index.html', import.meta.url), 'utf8');
  for (const kind of ['document', 'slides', 'spreadsheet']) {
    assert.ok(html.includes(`href="/space?new=${kind}" data-create-artifact="${kind}"`),kind);
  }
  for (const id of ['meeting_prep', 'daily_brief', 'expert_research', 'advance_goals']) assert.ok(html.includes(`/automations?template=${id}`), id);
  assert.match(html, /id="composer-website-create"[^>]+aria-haspopup="dialog"/);
  assert.match(html, /id="website-create-manual" href="\/space\?new=website"/);
  assert.match(html, /id="website-create-prompt" name="prompt" maxlength="1600"/);
  assert.match(html, /<iframe id="website-create-preview"[^>]+sandbox="allow-scripts" referrerpolicy="no-referrer" hidden/);
  assert.match(html, /id="composer-video-create"[^>]+aria-haspopup="dialog"/);
  assert.match(html, /<video id="video-create-preview"[^>]+controls/);
  assert.match(html, /id="composer-music-create"[^>]+aria-haspopup="dialog"/);
  assert.match(html, /<audio id="music-create-preview"[^>]+controls/);
  assert.match(html, /id="composer-model3d-create"[^>]+aria-haspopup="dialog"/);
  assert.match(html, /<select name="source">\s*<option value="text"[^>]*>根据描述<\/option>\s*<option value="image"[^>]*>根据参考图<\/option>/);
  assert.match(html, /id="model3d-create-open-preview"[^>]+aria-expanded="false"/);
});

test('website creation preserves the chat draft, recovers a saved job, and tears down its lazy preview', async () => {
  const {mountWebsiteCreator} = await import('../openteamily/static/chat/video-create.mjs');
  const {doc, el} = fakeChatDocument(chatHtml());
  const widget = name => el('website-create-' + name);
  const dialog = widget('dialog');
  const iframe = widget('preview');
  const prompt = widget('prompt');
  prompt.maxLength = 1600;
  widget('form').elements = {prompt};
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; return fire(dialog, 'close'); };
  Object.defineProperty(iframe, 'src', {set(url) { this.setAttribute('src', url); }});

  const workspace = alice;
  const artifact = bob;
  const jobsPath = `/v1/workspaces/${workspace}/websites`;
  const artifactPath = `/v1/workspaces/${workspace}/artifacts/${artifact}`;
  const calls = [];
  let job = null;
  let finishPreview;
  mountWebsiteCreator(doc, {
    context: () => ({workspace, scope: 'chat-1', sendLabel: '发送到会话'}),
    key: () => 'website-request',
    onOpen() {},
    async request(method, path, body, headers) {
      calls.push({method, path, body, headers});
      if (path === jobsPath && method === 'GET') return {status: 200, body: {configured: true, job}};
      if (path === jobsPath && method === 'POST') {
        job = {id: 'c'.repeat(32), prompt: body.prompt, state: 'queued', artifact_id: null};
        return {status: 202, body: {job}};
      }
      if (path === artifactPath) return new Promise(resolve => { finishPreview = resolve; });
      throw new Error('unexpected ' + path);
    },
  }).sync();

  const trigger = el('composer-website-create');
  el('chat-body').value = '未发送的聊天草稿';
  await fire(trigger, 'click');
  assert.equal(prompt.value, el('chat-body').value);
  assert.equal(widget('manual').href, '/space?new=website#workspace=' + workspace);
  prompt.value = '  产品展示网站  ';
  await fire(widget('form'), 'submit', {preventDefault() {}});
  assert.match(widget('status').textContent, /排队/);
  assert.equal(el('chat-body').value, '未发送的聊天草稿');
  assert.deepEqual(calls[1], {
    method: 'POST', path: jobsPath, body: {prompt: '产品展示网站'}, headers: {'Idempotency-Key': 'website-request'},
  });
  await dialog.close();
  job = {...job, state: 'succeeded', artifact_id: artifact};
  await fire(trigger, 'click');
  assert.match(widget('status').textContent, /私密保存/);
  assert.equal(widget('space').href, `/space?workspace=${workspace}&artifact=${artifact}`);
  assert.equal(widget('result').hidden, false);
  assert.equal(iframe.hidden, true);
  assert.equal(calls.length, 3);

  const preview = fire(widget('open-preview'), 'click');
  finishPreview({status: 200, body: {artifact: {revision: 3}}});
  await preview;
  assert.equal(iframe.getAttribute('src'), artifactPath + '/preview?revision=3');
  assert.equal(iframe.hidden, false);
  await dialog.close();
  assert.equal(iframe.getAttribute('src'), undefined);
  assert.equal(iframe.hidden, true);
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
    if (path === '/v1/workspaces/ws-1/agents?limit=100&include=conversations') return json(200, {items: []});
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

test('a received GLB offers a collapsed viewer and an independent download', async () => {
  const attachment = {title: '风车.glb', mime: 'model/gltf-binary', bytes: 512, path: '/fixture/windmill.glb'};
  const {doc, el} = fakeChatDocument(chatHtml());
  const restore = installChatGlobals();
  try {
    await mount(doc, {fetcher: attachmentFetcher(attachmentMessage(attachment)).fetcher});
    await settle();
    const nodes = descendants(el('message-list').children[0]);
    const button = nodes.find(node => node.classList.contains('chat-file-model3d-toggle'));
    const frame = nodes.find(node => node.classList.contains('chat-file-model3d-preview'));
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    assert.equal(frame.hidden, true);
    assert.equal(frame.children.length, 0);
    assert.equal(nodes.find(node => node.download === attachment.title).href, attachment.path + '?download=1');
    await fire(el('multi-select-toggle'), 'click');
    const renderedAgain = descendants(el('message-list').children[0]);
    assert.equal(renderedAgain.find(node => node.classList.contains('chat-file-model3d-preview')), frame);
  } finally {
    restore();
  }
});

test('social history prepends older messages and returns from a searched window to latest', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher: original} = sessionFetcher();
  const restore = installChatGlobals({narrow:true});
  const row = seq => ({id: 'history-' + seq, seq, user_id:bob, body:'Message ' + seq, created:seq});
  const list = el('message-list');
  const scroller = el('message-scroller');
  Object.defineProperty(scroller, 'scrollHeight', {get: () => list.children.length * 100});
  try {
    await mount(doc, {fetcher: async path => {
      if (path.endsWith('/conv-1')) {
        const old = await original(path);
        return json(200, {...await old.json(), items:[row(5), row(6)], cursor:5});
      }
      if (path.includes('before=5')) return json(200, {items:[row(3), row(4), row(5)],cursor:3});
      if (path.includes('around=history-1')) return json(200, {items:[row(1), row(2)],cursor:null,has_newer:true});
      if (path.includes('/messages?q=')) return json(200, {items:[row(1)],cursor:null});
      return original(path);
    }});
    await fire(el('conversation-list'), 'click', {target:sessionRows(el)[0]});
    const ids = () => list.children.map(item => item.dataset.messageId);
    assert.deepEqual(ids(), ['history-5','history-6']);
    scroller.scrollTop = 25;
    await fire(el('chat-load-older'), 'click');
    assert.deepEqual(ids(), ['history-3','history-4','history-5','history-6']);
    assert.equal(scroller.scrollTop,225);
    await fire(el('conversation-search-open'), 'click');
    el('conversation-search-query').value = 'Message';
    await fire(el('conversation-search-form'), 'submit', {preventDefault(){}});
    await fire(el('conversation-search-results').children[0], 'click');
    assert.deepEqual(ids(), ['history-1','history-2']);
    assert.equal(list.children[0].dataset.searchJump,'true');
    assert.equal(el('chat-back-to-latest').hidden,false);
    await fire(el('chat-back-to-latest'),'click');
    await settle();
    assert.deepEqual(ids(), ['history-5','history-6']);
    assert.equal(el('chat-back-to-latest').hidden,true);
  } finally { restore(); }
});

test('in-chat search jumps to loaded messages, explains unloaded hits, and restores scroll on close', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher: original} = sessionFetcher();
  const restore = installChatGlobals({narrow:true});
  try {
    await mount(doc, {fetcher: async path => {
      if (path.includes('/messages?q=')) return json(200, {items:[{id:'jump-loaded',body:'Find me'}, {id:'not-loaded',body:'Earlier message'}],cursor:null});
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


test('conversation search lists photos, files and saved resource versions from real attachment fields', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher: original} = sessionFetcher();
  const restore = installChatGlobals({narrow: true});
  const base = '/v1/workspaces/ws-1/social/conversations/conv-1';
  const file = (id, title, mime) => ({message_id: id, created_at: 1767225600, attachment: {
    id, title, mime, bytes: 200, path: base + '/messages/' + id + '/file',
  }});
  const photo = file('m-1', '现场照片.png', 'image/png');
  const report = file('m-2', '发布计划.pdf', 'application/pdf');
  const notes = file('m-3', '实施计划.txt', 'text/plain');
  const resource = file('m-4', '发布计划.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  resource.attachment.resource = {kind: 'document', title: '发布计划原件', revision: 2};
  resource.attachment.path += '?revision=2';
  const calls = [];
  let retry = true;
  try {
    await mount(doc, {fetcher: async path => {
      if (path.startsWith(base + '/attachments?')) {
        const params = new URL(path, 'https://openteamily.test').searchParams;
        const scope = Object.fromEntries(params);
        calls.push(scope);
        if (scope.kind === 'photo') return json(200, {items: [photo], next_cursor: null});
        if (scope.kind === 'resource') return json(200, {items: [resource], next_cursor: null});
        if (scope.cursor && retry) {
          retry = false;
          return json(500, {});
        }
        return json(200, scope.cursor ? {items: [notes], next_cursor: null} : {items: [report], next_cursor: 'page-2'});
      }
      if (path.startsWith(base + '/messages?')) {
        const message = new URL(path, 'https://openteamily.test').searchParams.get('around');
        assert.ok(message, 'attachment browsing does not scan history pages');
        const hit = [photo, report, notes, resource].find(row => row.message_id === message);
        return json(200, {items: [{id: message, user_id: bob, body: '', attachment: hit.attachment}], cursor: null});
      }
      return original(path);
    }});
    await fire(el('conversation-list'), 'click', {target: sessionRows(el)[0]});
    await fire(el('conversation-search-open'), 'click');
    await fire(el('conversation-search-tab-photos'), 'click');
    assert.equal(el('conversation-search-tab-photos').getAttribute('aria-selected'), 'true');
    const results = el('conversation-search-results');
    assert.equal(results.children.length, 1);
    assert.ok(descendants(results.children[0]).some(node => node.textContent === '现场照片.png'));
    assert.equal(descendants(results.children[0]).some(node => node.tagName === 'IMG'), false);
    assert.match(el('conversation-search-status').textContent, /已显示 1 张照片/);
    await fire(results.children[0].children[0], 'click');
    const jumped = el('message-list').children.find(node => node.dataset.messageId === 'm-1');
    assert.equal(jumped.dataset.searchJump, 'true', 'a photo hit jumps back to its message and highlights it');
    el('conversation-search-query').value = '计划';
    await fire(el('conversation-search-tab-files'), 'click');
    assert.deepEqual(calls, [{kind: 'photo', q: '', limit: '20'}, {kind: 'file', q: '计划', limit: '20'}]);
    assert.equal(results.children.length, 1);
    const [jump, download] = results.children[0].children;
    assert.ok(descendants(jump).some(node => node.textContent === '发布计划.pdf'));
    assert.equal(download.href, report.attachment.path + '?download=1');
    assert.equal(download.download, '发布计划.pdf');
    assert.match(el('conversation-search-status').textContent, /已显示 1 个文件/);
    await fire(el('conversation-search-more'), 'click');
    assert.equal(results.children.length, 1, 'a failed next page preserves results');
    assert.equal(el('conversation-search-retry').hidden, false);
    await fire(el('conversation-search-retry'), 'click');
    assert.equal(results.children.length, 2);
    assert.equal(el('conversation-search-more').hidden, true);
    assert.equal(calls[3].cursor, 'page-2');
    await fire(jump, 'click');
    const located = el('message-list').children.find(node => node.dataset.messageId === 'm-2');
    assert.equal(located.dataset.searchJump, 'true', 'a file outside the window loads and highlights its message');

    await fire(el('conversation-search-tab-resources'), 'click');
    assert.deepEqual(calls.at(-1), {kind: 'resource', q: '计划', limit: '20'});
    assert.match(el('conversation-search-status').textContent, /已显示 1 份资料/);
    const row = results.children[0];
    assert.match(row.className, /resource-search-hit/);
    const [resourceJump, resourceDownload] = row.children;
    assert.ok(descendants(resourceJump).some(node => node.textContent === '发布计划原件'));
    assert.ok(descendants(resourceJump).some(node => node.textContent === '文档 · 版本 2'));
    assert.equal(resourceDownload.href, resource.attachment.path + '&download=1');
    assert.equal(resourceDownload.download, '发布计划.docx');
    await fire(resourceJump, 'click');
    const originalShare = el('message-list').children.find(node => node.dataset.messageId === 'm-4');
    assert.equal(originalShare.dataset.searchJump, 'true');
    assert.ok(descendants(originalShare).some(node => node.textContent === '文档 · 版本 2'));
  } finally { restore(); }
});

test('attachment search ignores stale tabs and queries and gives an explicit retry and empty state', async () => {
  const {doc, el} = fakeChatDocument(chatHtml());
  const {fetcher: original} = sessionFetcher();
  const restore = installChatGlobals({narrow: true});
  const delayed = [];
  let failed = true;
  try {
    await mount(doc, {fetcher: async (path, options) => {
      if (path.includes('/attachments?')) {
        const params = new URL(path, 'https://openteamily.test').searchParams;
        if (params.get('kind') === 'photo' || params.get('q') === 'old') {
          return new Promise(resolve => delayed.push({resolve, signal: options.signal}));
        }
        if (failed) {
          failed = false;
          return json(500, {});
        }
        return json(200, {items: [], next_cursor: null});
      }
      return original(path);
    }});
    await fire(el('conversation-list'), 'click', {target: sessionRows(el)[0]});
    await fire(el('conversation-search-open'), 'click');
    const photos = fire(el('conversation-search-tab-photos'), 'click');
    await fire(el('conversation-search-tab-files'), 'click');
    assert.equal(delayed[0].signal.aborted, true);
    assert.match(el('conversation-search-status').textContent, /无法搜索文件/);
    delayed[0].resolve(json(200, {items: [], next_cursor: null}));
    await photos;
    assert.match(el('conversation-search-status').textContent, /无法搜索文件/);
    await fire(el('conversation-search-retry'), 'click');
    assert.match(el('conversation-search-status').textContent, /还没有文件/);

    const submit = () => fire(el('conversation-search-form'), 'submit', {preventDefault() {}});
    const query = el('conversation-search-query');
    query.value = 'old';
    const old = submit();
    query.value = 'new';
    await submit();
    assert.equal(delayed[1].signal.aborted, true);
    delayed[1].resolve(json(200, {items: [{message_id: 'm', attachment: {id: 'm', title: 'old'}}]}));
    await old;
    assert.match(el('conversation-search-status').textContent, /没有找到匹配的文件/);
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
      if(path.endsWith('/agents?limit=100&include=conversations')){
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


test('native Bot Social activity starts after the directory commits and preserves linked history', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const scope = linkBase(linkWork);
  const fixture = linkedChatFixture(`#workspace=${linkWork}&agent=${linkAgent}&conversation=${linkThread}`);
  const directory = Promise.withResolvers();
  const activity = scope + '/social/conversations?view=activity';
  fixture.routes.set(scope + linkSocialDirectory, () => directory.promise);
  fixture.routes.set(activity, () => json(200, {version: 'current', items: []}));
  try {
    const loading = mount(fixture.doc, {fetcher: fixture.fetcher});
    await settle();
    t.mock.timers.tick(2100);
    await settle();
    assert.equal(fixture.calls.some(call => call.path === activity), false);
    directory.resolve(json(200, {items: []}));
    await loading;
    await settle();
    t.mock.timers.tick(2000);
    await settle();
    assert.equal(fixture.calls.some(call => call.path === activity), true);
    assert.equal(fixture.calls.some(call => call.path.endsWith('/events')), false);
    assert.deepEqual(fixture.messages(), [linkAgentOlder, linkAgentLatest]);
  } finally {
    directory.resolve(json(200, {items: []}));
    fixture.restore();
  }
});


const linkWork = '1'.repeat(32);
const linkTeam = '2'.repeat(32);
const linkUnavailable = '3'.repeat(32);
const linkAgent = '4'.repeat(32);
const linkThread = '5'.repeat(32);
const linkAgentOlder = '6'.repeat(32);
const linkAgentLatest = '7'.repeat(32);
const linkSocial = 'otc_' + '8'.repeat(26);
const linkSocialOlder = 'otm_' + '9'.repeat(26);
const linkSocialLatest = 'otm_' + 'A'.repeat(26);
const linkNativeDirectory = '/agents?limit=100&include=conversations';
const linkSocialDirectory = '/social/conversations?limit=100';
const linkBase = workspace => '/v1/workspaces/' + workspace;
const linkNativePath = `/agents/${linkAgent}/conversations/${linkThread}`;
const linkSocialPath = '/social/conversations/' + linkSocial;
const linkMember = {user_id: alice, username: 'alice'};

function linkedChatFixture(hash, {visibility = 'visible'} = {}) {
  const {doc, el} = fakeChatDocument(chatHtml());
  doc.querySelector = selector => selector === 'meta[name="openteamily-instance"]' ? {} : null;
  doc.visibilityState = visibility;
  const restore = installChatGlobals();
  const browser = {handlers: {}};
  globalThis.addEventListener = (type, handler) => (browser.handlers[type] ||= []).push(handler);
  globalThis.location.hash = hash;
  globalThis.history.replaceState = (_state, _unused, url) => {
    globalThis.location.hash = new URL(url, 'https://fixture.invalid').hash;
  };
  const scrolls = [];
  const element = doc.createElement;
  doc.createElement = (tag) => {
    const node = element(tag);
    node.scrollIntoView = (options) => scrolls.push({id: node.dataset.messageId, options});
    return node;
  };
  const calls = [];
  const routes = new Map();
  const agent = {id: linkAgent, name: 'Linked native agent', workspace_id: linkWork, served_by: 'ds-bot'};
  const nativeThread = {id: linkThread, agent_id: linkAgent, workspace_id: linkWork, title: 'Native history',
    unread_count: 2, updated: 5};
  const nativeRows = [
    {id: linkAgentOlder, role: 'user', body: 'Earlier native message', status: 'succeeded', created: 5},
    {id: linkAgentLatest, role: 'assistant', body: 'Latest visible native reply', status: 'succeeded', created: 10},
  ];
  const socialThread = (workspace) => ({id: linkSocial, workspace_id: workspace, kind: 'group', title: 'Linked group',
    unread_count: 3, updated: 30, last_seq: 8, members: [linkMember]});
  const socialRows = [{id: linkSocialLatest, conversation_id: linkSocial, user_id: bob, body: 'Latest group reply', seq: 8, created: 10}];
  const socialOlder = {id: linkSocialOlder, conversation_id: linkSocial, user_id: bob, body: 'Earlier group reply', seq: 2, created: 5};
  const fetcher = async (path, options = {}) => {
    const call = {path, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined};
    calls.push(call);
    const override = routes.get(path);
    if (override) return override(call);
    if (path === '/v1/auth/session') return json(200, {user: {id: alice, username: 'alice'}});
    if (path === '/v1/personal-agent') return json(200, {personal_agent: {workspace: {id: linkWork}, agent}});
    if (path === '/v1/settings') return json(200, {settings: {values: {}}});
    if (path === '/v1/onboarding') return json(200, {onboarding: {completed: true}});
    if (path === '/v1/workspaces?limit=100') return json(200, {items: [
      {id: linkWork, name: 'Personal', kind: 'personal'}, {id: linkTeam, name: 'Team', kind: 'team'},
    ]});
    for (const workspace of [linkWork, linkTeam]) {
      const base = linkBase(workspace);
      if (path === base + linkNativeDirectory) return json(200,
        workspace === linkWork ? {items: [agent], conversations: [nativeThread]} : {items: [], conversations: []});
      if (path === base + linkSocialDirectory) return json(200, {items: [socialThread(workspace)]});
      if (path === base + linkSocialPath) return json(200, {conversation: socialThread(workspace), items: socialRows, cursor: 8});
      if (path.startsWith(base + linkSocialPath + '/messages?around=')) {
        return json(200, {items: [socialOlder], cursor: null, has_newer: true});
      }
      if (path === base + linkSocialPath + '/read') return json(200, {unread_count: 0});
      if (path.startsWith(base + '/notifications') || path === base + '/members' || path.startsWith(base + '/artifacts?')) {
        return json(200, {items: []});
      }
    }
    if (path === linkBase(linkWork) + linkNativePath) return json(200, {agent, conversation: nativeThread, items: nativeRows});
    if (path === linkBase(linkWork) + linkNativePath + '/read') return json(200, {unread_count: 0});
    return json(404, {error: {code: 'not_found'}});
  };
  const navigate = (nextHash) => {
    globalThis.location.hash = nextHash;
    return fire(browser, 'hashchange');
  };
  const messages = () => el('message-list').children.map(node => node.dataset.messageId);
  const selected = () => sessionRows(el).find(row => row?.getAttribute('aria-current') === 'true')?.dataset.conversation;
  return {doc, el, fetcher, routes, calls, scrolls, navigate, messages, selected, agent, nativeThread, nativeRows, restore};
}

test('a cold native Chat boot provisions the personal workspace and ignores the earlier directory snapshot', async () => {
  const scope = linkBase(linkWork);
  const fixture = linkedChatFixture(`#workspace=${linkWork}&agent=${linkAgent}&conversation=${linkThread}`);
  const earlier = Promise.withResolvers();
  const initialized = Promise.withResolvers();
  let workspaceReads = 0;
  fixture.routes.set('/v1/personal-agent', ({method}) => method === 'GET'
    ? json(200, {personal_agent: null})
    : initialized.promise);
  fixture.routes.set('/v1/workspaces?limit=100', () => {
    workspaceReads += 1;
    return workspaceReads === 1 ? earlier.promise
      : json(200, {items: [{id:linkWork, name:'Personal', kind:'personal'}]});
  });
  try {
    const mountPromise = mount(fixture.doc, {fetcher:fixture.fetcher});
    await settle();
    assert.equal(workspaceReads, 1);
    assert.equal(fixture.calls.some(call => call.path === '/v1/personal-agent' && call.method === 'POST'), true);
    assert.equal(fixture.calls.some(call => call.path === scope + linkNativePath), false);
    initialized.resolve(json(201, {personal_agent: {workspace: {id:linkWork}, agent:fixture.agent}}));
    await mountPromise;
    assert.equal(workspaceReads, 2);
    assert.deepEqual(fixture.messages(), [linkAgentOlder, linkAgentLatest]);
    earlier.resolve(json(200, {items: []}));
    await settle();
    assert.deepEqual(fixture.messages(), [linkAgentOlder, linkAgentLatest]);
  } finally {
    earlier.resolve(json(200, {items: []}));
    initialized.resolve(json(201, {personal_agent: {workspace: {id:linkWork}, agent:fixture.agent}}));
    fixture.restore();
  }
});

test('a linked native history and its message jump render before the unrelated Social directory returns', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const scope = linkBase(linkWork);
  const hash = `#workspace=${linkWork}&agent=${linkAgent}&conversation=${linkThread}&message=${linkAgentOlder}`;
  const fixture = linkedChatFixture(hash);
  const directory = Promise.withResolvers();
  const receipt = Promise.withResolvers();
  const onboarding = Promise.withResolvers();
  const settings = Promise.withResolvers();
  fixture.routes.set(scope + linkSocialDirectory, () => directory.promise);
  fixture.routes.set(scope + linkNativePath + '/read', () => receipt.promise);
  fixture.routes.set('/v1/onboarding', () => onboarding.promise);
  fixture.routes.set('/v1/settings', () => settings.promise);
  try {
    const loading = mount(fixture.doc, {fetcher: fixture.fetcher});
    await settle();
    assert.ok(fixture.calls.some(call => call.path === '/v1/onboarding'));
    assert.ok(fixture.calls.some(call => call.path === '/v1/settings'));
    assert.equal(fixture.calls.some(call => call.path === scope + linkNativePath), false, 'settings still load before detail');
    settings.resolve(json(200, {settings: {values: {send_shortcut: 'mod_enter'}}}));
    await settle();
    assert.ok(fixture.calls.some(call => call.path === scope + linkSocialDirectory), 'the Social directory really is pending');
    const personal = fixture.calls.findIndex(call => call.path === '/v1/personal-agent' && call.method === 'GET');
    const workspaces = fixture.calls.findIndex(call => call.path === '/v1/workspaces?limit=100');
    const detail = fixture.calls.findIndex(call => call.path === scope + linkNativePath);
    assert.ok(personal >= 0 && workspaces >= 0 && personal < detail && workspaces < detail, 'workspace authorization precedes detail');
    assert.equal(fixture.calls.some(call => call.path === '/v1/personal-agent' && call.method === 'POST'), false,
      'a running DS-Bot with an existing personal binding does not need to provision again');
    assert.equal(fixture.el('chat-body').dataset.sendShortcut, 'mod_enter');
    assert.deepEqual(fixture.messages(), [linkAgentOlder, linkAgentLatest]);
    assert.equal(fixture.el('chat-title').textContent, fixture.agent.name);
    assert.equal(fixture.el('message-list').children[0].dataset.searchJump, 'true');
    assert.deepEqual(fixture.scrolls.map(row => row.id), [linkAgentOlder]);
    assert.equal(globalThis.location.hash, hash);
    assert.deepEqual(fixture.calls.filter(call => call.path.endsWith('/read')).map(call => call.body),
      [{message_id: linkAgentLatest}], 'the native read receipt stops at the last rendered assistant reply');
    receipt.resolve(json(200, {unread_count: 0}));
    directory.resolve(json(200, {items: []}));
    await loading;
    await settle();
    assert.equal(fixture.selected(), linkThread);
    assert.equal(fixture.calls.filter(call => call.path === scope + linkNativePath).length, 1);
    assert.deepEqual(fixture.messages(), [linkAgentOlder, linkAgentLatest]);
    assert.equal(fixture.el('onboarding-banner').hidden, true);
    onboarding.resolve(json(200, {onboarding: {completed: false}}));
    await settle();
    assert.equal(fixture.el('onboarding-banner').hidden, false);
  } finally {
    settings.resolve(json(200, {settings: {values: {}}}));
    onboarding.resolve(json(200, {onboarding: {completed: true}}));
    receipt.resolve(json(200, {unread_count: 0}));
    directory.resolve(json(200, {items: []}));
    fixture.restore();
  }
});

test('a linked Social history reaches its older target without waiting for the native directory or marking unread', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const scope = linkBase(linkWork);
  const hash = `#workspace=${linkWork}&social=${linkSocial}&message=${linkSocialOlder}`;
  const fixture = linkedChatFixture(hash);
  const directory = Promise.withResolvers();
  fixture.routes.set(scope + linkNativeDirectory, () => directory.promise);
  try {
    const loading = mount(fixture.doc, {fetcher: fixture.fetcher});
    await settle();
    assert.ok(fixture.calls.some(call => call.path === scope + linkNativeDirectory), 'the native directory really is pending');
    assert.equal(fixture.el('chat-title').textContent, 'Linked group');
    assert.deepEqual(fixture.messages(), [linkSocialOlder]);
    assert.equal(fixture.el('message-list').children[0].dataset.searchJump, 'true');
    assert.deepEqual(fixture.scrolls.map(row => row.id), [linkSocialOlder]);
    assert.equal(globalThis.location.hash, hash);
    assert.equal(fixture.calls.filter(call => call.path === scope + linkSocialPath + '/messages?around=' + linkSocialOlder + '&limit=50').length, 1);
    assert.equal(fixture.calls.some(call => call.path.endsWith('/read')), false);
    directory.resolve(json(200, {items: [], conversations: []}));
    await loading;
    await settle();
    assert.equal(fixture.selected(), linkSocial);
    assert.equal(fixture.calls.filter(call => call.path === scope + linkSocialPath).length, 1);
    assert.equal(fixture.calls.some(call => call.path.endsWith('/read')), false);
    assert.deepEqual(fixture.messages(), [linkSocialOlder]);
  } finally {
    directory.resolve(json(200, {items: [], conversations: []}));
    fixture.restore();
  }
});

for (const newer of [false, true]) {
  test(`a late directory snapshot ${newer ? 'retains unread newer than' : 'does not restore unread covered by'} the linked Social read`, async () => {
    const scope = linkBase(linkWork);
    const fixture = linkedChatFixture(`#workspace=${linkWork}&social=${linkSocial}`);
    const directory = Promise.withResolvers();
    fixture.routes.set(scope + linkNativeDirectory, () => directory.promise);
    if (newer) fixture.routes.set(scope + linkSocialDirectory, () => json(200, {items: [
      {id: linkSocial, kind: 'group', title: 'Linked group', last_seq: 9, updated: 31, unread_count: 1, members: [linkMember]},
    ]}));
    try {
      const loading = mount(fixture.doc, {fetcher: fixture.fetcher});
      await settle();
      assert.deepEqual(fixture.messages(), [linkSocialLatest]);
      assert.deepEqual(fixture.calls.find(call => call.path === scope + linkSocialPath + '/read')?.body, {seq: 8});
      directory.resolve(json(200, {items: [], conversations: []}));
      await loading;
      await settle();
      const linked = sessionRows(fixture.el).find(row => row?.dataset.conversation === linkSocial);
      assert.ok(linked);
      assert.equal(linked.getAttribute('aria-current'), 'true');
      const badge = descendants(linked).find(node => node.classList.contains('unread-badge'));
      assert.equal(badge?.textContent, newer ? '1' : undefined);
    } finally {
      directory.resolve(json(200, {items: [], conversations: []}));
      fixture.restore();
    }
  });
}

test('a late exact native history cannot overwrite a different workspace and Social target selected by hashchange', async () => {
  const old = linkBase(linkWork) + linkNativePath;
  const current = linkBase(linkTeam) + linkSocialPath;
  const fixture = linkedChatFixture(`#workspace=${linkWork}&agent=${linkAgent}&conversation=${linkThread}`);
  const wait = Promise.withResolvers();
  const oldOnboarding = Promise.withResolvers();
  let onboardingRequests = 0;
  fixture.routes.set(old, () => wait.promise);
  fixture.routes.set('/v1/onboarding', () => ++onboardingRequests === 1
    ? oldOnboarding.promise : json(200, {onboarding: {completed: true}}));
  try {
    const first = mount(fixture.doc, {fetcher: fixture.fetcher});
    await settle();
    assert.equal(fixture.calls.filter(call => call.path === old).length, 1);
    const newHash = `#workspace=${linkTeam}&social=${linkSocial}`;
    await fixture.navigate(newHash);
    await settle();
    assert.equal(fixture.el('workspace').value, linkTeam);
    assert.equal(fixture.calls.filter(call => call.path === current).length, 1);
    assert.equal(fixture.el('chat-title').textContent, 'Linked group');
    assert.deepEqual(fixture.messages(), [linkSocialLatest]);
    assert.deepEqual(fixture.calls.find(call => call.path === current + '/read')?.body, {seq: 8});
    oldOnboarding.resolve(json(200, {onboarding: {completed: false}}));
    wait.resolve(json(200, {agent: fixture.agent, conversation: fixture.nativeThread, items: fixture.nativeRows}));
    await first;
    await settle();
    assert.equal(globalThis.location.hash, newHash);
    assert.equal(fixture.el('chat-title').textContent, 'Linked group');
    assert.deepEqual(fixture.messages(), [linkSocialLatest]);
    assert.equal(fixture.selected(), linkSocial);
    assert.equal(fixture.el('onboarding-banner').hidden, true);
    assert.equal(fixture.calls.some(call => call.path === old + '/read'), false);
  } finally {
    oldOnboarding.resolve(json(200, {onboarding: {completed: false}}));
    wait.resolve(json(404, {error: {code: 'not_found'}}));
    fixture.restore();
  }
});

for (const target of ['bare agent', 'default']) {
  test(`startup still waits for the directory before selecting a ${target} conversation`, async () => {
    const scope = linkBase(linkWork);
    const hash = `#workspace=${linkWork}` + (target === 'bare agent' ? `&agent=${linkAgent}` : '');
    const fixture = linkedChatFixture(hash);
    const directory = Promise.withResolvers();
    fixture.routes.set(scope + linkNativeDirectory, () => directory.promise);
    try {
      const loading = mount(fixture.doc, {fetcher: fixture.fetcher});
      await settle();
      assert.ok(fixture.calls.some(call => call.path === scope + linkNativeDirectory));
      assert.equal(fixture.calls.some(call => [scope + linkNativePath, scope + linkSocialPath].includes(call.path)), false);
      directory.resolve(json(200, {items: [fixture.agent], conversations: [fixture.nativeThread]}));
      await loading;
      await settle();
      assert.equal(fixture.selected(), target === 'bare agent' ? linkThread : linkSocial);
      assert.equal(fixture.calls.filter(call => call.path === scope + linkNativePath).length, target === 'bare agent' ? 1 : 0);
      assert.equal(fixture.calls.filter(call => call.path === scope + linkSocialPath).length, target === 'default' ? 1 : 0);
    } finally {
      directory.resolve(json(200, {items: [], conversations: []}));
      fixture.restore();
    }
  });
}

test('a failed Social directory does not hide a successful native deep link in a hidden tab', async () => {
  const scope = linkBase(linkWork);
  const fixture = linkedChatFixture(`#workspace=${linkWork}&agent=${linkAgent}&conversation=${linkThread}`, {visibility: 'hidden'});
  fixture.routes.set(scope + linkSocialDirectory, () => json(503, {error: {code: 'unavailable'}}));
  try {
    await mount(fixture.doc, {fetcher: fixture.fetcher});
    await settle();
    assert.deepEqual(fixture.messages(), [linkAgentOlder, linkAgentLatest]);
    assert.equal(fixture.selected(), linkThread);
    assert.equal(fixture.el('conversations-status').hidden, false);
    assert.match(fixture.el('conversations-status').textContent, /部分对话加载失败/);
    assert.equal(fixture.calls.some(call => call.path === scope + linkNativePath + '/read'), false);
  } finally { fixture.restore(); }
});

test('an unavailable direct target keeps its own error and the directory without opening another thread', async () => {
  const scope = linkBase(linkWork);
  const fixture = linkedChatFixture(`#workspace=${linkWork}&agent=${linkAgent}&conversation=${linkThread}`);
  fixture.routes.set(scope + linkNativePath, () => json(404, {error: {code: 'not_found', message: '原会话已移除'}}));
  try {
    await mount(fixture.doc, {fetcher: fixture.fetcher});
    await settle();
    assert.equal(fixture.calls.filter(call => call.path === scope + linkNativePath).length, 1);
    assert.equal(fixture.calls.some(call => call.path === scope + linkSocialPath), false);
    assert.deepEqual(fixture.messages(), []);
    assert.ok(sessionRows(fixture.el).some(row => row?.dataset.conversation === linkSocial));
    assert.match(fixture.el('status').textContent, /原会话已移除/);
  } finally { fixture.restore(); }
});

for (const path of [linkNativePath, linkSocialPath]) {
  test(`an inactive workspace cannot dispatch a linked ${path === linkNativePath ? 'native' : 'Social'} target`, async () => {
    const target = path === linkNativePath ? `agent=${linkAgent}&conversation=${linkThread}` : `social=${linkSocial}`;
    const fixture = linkedChatFixture(`#workspace=${linkUnavailable}&${target}`);
    try {
      await mount(fixture.doc, {fetcher: fixture.fetcher});
      await settle();
      assert.equal(fixture.calls.some(call => call.path.endsWith(path)), false,
        'the inactive link cannot be opened, including against an active workspace picked as fallback');
      assert.equal(fixture.calls.some(call => call.path.startsWith(linkBase(linkUnavailable) + '/')), false);
      assert.deepEqual(fixture.messages(), []);
      assert.match(fixture.el('status').textContent, /无法访问此会话所在的工作区/);
    } finally { fixture.restore(); }
  });
}

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
