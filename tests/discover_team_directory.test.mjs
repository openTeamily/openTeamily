import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../openteamily/static/discover/index.html', import.meta.url), 'utf8');

class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.attributes = {}; this.handlers = {}; this.dataset = {};
    this.hidden = true; this.disabled = false; this.value = ''; this.textContent = '';
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(key, handler) { this.handlers[key] = handler; }
  get classes() { return (this.className || '').split(' ').filter(Boolean); }
}

function fakeDocument() {
  const elements = new Map();
  return {
    cookie: '',
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    },
    createElement(tag) { return new Element(tag); },
    querySelector() { return null; },
  };
}

function fakeHistory() {
  const pushed = [];
  return {pushed, pushState(state, title, url) { pushed.push(url); }};
}

const flush = () => new Promise(resolve => setImmediate(resolve));
const TEAM = {workspace_id: 'a'.repeat(32), name: '发布小队', summary: '发布检查与回归',
  member_count: 3, membership: 'member', updated: 1763000000};

function fetcherFor(directory, requests) {
  return async (path, options = {}) => {
    requests.push([path, options.method || 'GET']);
    if (path === '/v1/auth/session') return {status: 200, json: async () => ({user: {id: 'u1', username: 'alice'}})};
    if (path.startsWith('/v1/team-directory')) return {status: 200, json: async () => ({items: directory})};
    if (path.startsWith('/v1/workspaces')) return {status: 200, json: async () => ({items: []})};
    return {status: 200, json: async () => ({items: []})};
  };
}

test('the AI 团队 tab reads the real public team directory instead of a placeholder', async () => {
  const { mount } = await import('../openteamily/static/discover/app.mjs');
  const doc = fakeDocument();
  const requests = [];
  await mount(doc, {fetcher: fetcherFor([TEAM], requests), location: {search: '?tab=agents&section=groups'}, history: fakeHistory()});
  await flush();
  assert.equal(requests.some(([path]) => path.startsWith('/v1/team-directory')), true,
    'the tab must ask GET /v1/team-directory, the existing public directory route');
  assert.equal(requests.some(([path]) => path.startsWith('/v1/discover/agents')), false,
    'the team tab must not fall back to the agent catalog');
  const list = doc.getElementById('discover-list');
  assert.equal(list.children.length, 1);
  const card = list.children[0].children[0];
  const texts = card.children.map(child => child.textContent);
  assert.equal(texts.includes('发布小队'), true, 'the team name is shown');
  assert.equal(card.children.some(child => String(child.textContent).includes('3 位成员')), true,
    'the member count comes from the directory view');
  assert.equal(card.children.some(child => String(child.textContent).includes('已加入')), true,
    'membership state is shown, not invented');
  assert.match(doc.getElementById('catalog-count').textContent, /1 支团队/);
  assert.equal(doc.getElementById('discover-empty').hidden, true);
});

test('an empty public directory says what is true and names the two real steps', async () => {
  const { TEAMS_EMPTY_NOTE } = await import('../openteamily/static/discover/app.mjs');
  const { mount } = await import('../openteamily/static/discover/app.mjs');
  const doc = fakeDocument();
  await mount(doc, {fetcher: fetcherFor([], []), location: {search: '?tab=agents&section=groups'}, history: fakeHistory()});
  await flush();
  const empty = doc.getElementById('discover-empty');
  assert.equal(empty.hidden, false);
  assert.equal(empty.textContent, TEAMS_EMPTY_NOTE);
  assert.match(TEAMS_EMPTY_NOTE, /还没有公开的 AI 团队/);
  assert.match(TEAMS_EMPTY_NOTE, /创建一个团队/);
  assert.match(TEAMS_EMPTY_NOTE, /登记到公共目录/);
});

test('a team search passes q to the directory and reports no match honestly', async () => {
  const { TEAMS_NONE_MATCHED } = await import('../openteamily/static/discover/app.mjs');
  const { mount } = await import('../openteamily/static/discover/app.mjs');
  const doc = fakeDocument();
  const requests = [];
  await mount(doc, {fetcher: fetcherFor([], requests), location: {search: '?tab=agents&section=groups'}, history: fakeHistory()});
  await flush();
  doc.getElementById('catalog-query').value = '发布';
  doc.getElementById('catalog-search').handlers.submit({preventDefault() {}});
  await flush();
  assert.equal(requests.some(([path]) => path.includes('/v1/team-directory') && path.includes('q=%E5%8F%91%E5%B8%83')), true);
  const note = doc.getElementById('teams-search-note');
  assert.equal(note.hidden, false);
  assert.equal(note.textContent, TEAMS_NONE_MATCHED);
  assert.match(TEAMS_NONE_MATCHED, /没有匹配的公开 AI 团队/);
});

test('teams markup has no 未接通 placeholder left for the directory', () => {
  const start = HTML.indexOf('id="teams-filters"');
  const end = HTML.indexOf('id="catalog-panel"');
  const chipLines = HTML.slice(start, end).split('\n').filter(line =>
    line.includes('class="catalog-filter-all"') || line.trim().startsWith('<button type="button" disabled title="'));
  assert.ok(chipLines.length >= 12, 'the recorded team chips are still all present');
  for (const line of chipLines) assert.equal(/未接通/.test(line), false, 'no 未接通 team chip: ' + line.trim().slice(0, 60));
  assert.equal(/没有公共 AI 团队目录接口/.test(HTML), false);
  // The creation entry belongs to another slice (#313). It stays exactly as
  // base ships it, so this slice keeps its own claim narrow.
  assert.match(HTML, /<button type="button" class="catalog-create" id="catalog-create-team" hidden disabled/);
  assert.match(HTML, /id="teams-note"[^>]*>以下是本实例里公开登记的 AI 团队/);
});
