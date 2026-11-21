// #335: a public work card names its author as a real link to that author's
// filtered feed, and /discover?creator=<handle> asks the existing feed API for
// just that creator. The page moves; the API already answers `creator=`.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as app from '../openteamily/static/discover/app.mjs';

class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.attributes = {}; this.handlers = {}; this.dataset = {};
    this.hidden = true; this.disabled = false; this.value = ''; this.textContent = '';
  }
  get childElementCount() { return this.children.length; }
  append(...nodes) { this.children.push(...nodes); }
  showModal() { this.open = true; }
  close() { this.open = false; this.handlers.close?.(); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(key, handler) { this.handlers[key] = handler; }
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
    querySelectorAll() { return []; },
  };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('a work card links its author to that author\'s feed, with no nested links', () => {
  const doc = fakeDocument();
  const card = app.renderFeedCard(doc, {
    slug: 'alice-note', title: 'Alice 的笔记', kind: 'document', author: 'alice', path: '/w/alice-note',
  });
  assert.equal(String(card.tagName).toLowerCase(), 'div');
  assert.equal(card.className, 'feed-card');
  const link = card.children[0];
  assert.equal(String(link.tagName).toLowerCase(), 'a', 'the work keeps its own link');
  assert.equal(link.className, 'feed-card-link');
  assert.equal(link.href, '/w/alice-note');
  const meta = card.children[1];
  assert.equal(meta.className, 'meta');
  const author = meta.children[1];
  assert.equal(String(author.tagName).toLowerCase(), 'a', 'the author is a real link, not text');
  assert.equal(author.className, 'feed-author');
  assert.equal(author.href, '/discover?creator=alice');
  assert.equal(author.textContent, 'alice');
  assert.equal(link.children.includes(meta), false, 'the author lives beside the work link, never inside it');
  const anonymous = app.renderFeedCard(doc, {slug: 'nameless-note', title: '无作者', kind: 'document'});
  const anonymousAuthor = anonymous.children[1].children[1];
  assert.equal(String(anonymousAuthor.tagName).toLowerCase(), 'span', 'no author, no link');
  assert.equal(typeof anonymousAuthor.href, 'undefined');
});

test('a creator in the URL is validated by the same handle rule as the server', () => {
  assert.equal(app.creatorFromSearch('?creator=alice'), 'alice');
  assert.equal(app.creatorFromSearch('?creator=Alice'), 'alice');
  assert.equal(app.creatorFromSearch('?tab=agents'), '');
  assert.equal(app.creatorFromSearch('?creator='), '');
  assert.equal(app.creatorFromSearch('?creator=a'), '', 'handles are 3-64 characters');
  assert.equal(app.creatorFromSearch('?creator=al ice'), '');
  assert.equal(app.creatorFromSearch('?creator=alice%2Fbob'), '');
  assert.equal(app.creatorFromSearch(undefined), '');
  assert.equal(app.creatorSearch('Alice'), '?creator=alice');
  assert.equal(app.creatorSearch('a'), '');
  assert.equal(app.creatorLink('alice'), '/discover?creator=alice');
  assert.equal(app.creatorLink(''), '/discover');
});

test('the filtered feed is a shareable URL and the request carries the creator', () => {
  const state = app.feedStateFromSearch('?creator=Alice&kind=image&q=%E7%AC%94%E8%AE%B0');
  assert.equal(state.creator, 'alice');
  assert.equal(app.feedSearchText(state), '?kind=image&q=%E7%AC%94%E8%AE%B0&creator=alice');
  assert.equal(app.feedSearchText(app.feedStateFromSearch('?creator=alice')), '?creator=alice');
  assert.match(app.feedQuery('', '', '', 'alice'), /(^|&)creator=alice(&|$)/);
  assert.doesNotMatch(app.feedQuery('', '', '', ''), /creator=/);
  assert.match(app.feedQuery('', '', 'image', 'alice'), /kind=image/);
  assert.match(app.feedQuery('', '', 'image', 'alice'), /creator=alice/);
});

test('mounting /discover?creator=alice asks the feed for that creator and shows whose feed it is', async () => {
  const {mount} = await import('../openteamily/static/discover/app.mjs');
  const doc = fakeDocument();
  const calls = [];
  const fetcher = async (path, options) => {
    calls.push([path, options && options.method]);
    if (path === '/v1/auth/session') return {status: 401, json: async () => ({})};
    if (path.startsWith('/v1/discover/works?')) {
      return {status: 200, json: async () => ({items: [{slug: 'alice-note', title: 'Alice 的笔记', kind: 'document', author: 'alice', path: '/w/alice-note'}], cursor: null})};
    }
    throw new Error('unexpected ' + path);
  };
  await mount(doc, {fetcher, location: {search: '?creator=alice', pathname: '/discover'}});
  const el = id => doc.getElementById(id);
  const works = calls.filter(([path]) => path.startsWith('/v1/discover/works?'));
  assert.equal(works.length, 1);
  assert.match(works[0][0], /(^|[?&])creator=alice(&|$)/);
  assert.equal(works[0][1], 'GET');
  assert.equal(el('feed-creator-chip').hidden, false);
  assert.equal(el('feed-creator-label').textContent, '只看 alice 的公开作品');
  assert.equal(el('feed-creator-clear').href, '/discover');
  assert.equal(el('feed-grid').children.length, 1);
  assert.equal(el('feed-count').textContent, '已显示 1 件公开作品');
  assert.equal(calls.some(([path]) => path.startsWith('/v1/discover/creators')), false, 'no creator-list endpoint exists or is needed');
});

test('clearing the creator chip keeps the other filters and asks for every author again', async () => {
  const {mount} = await import('../openteamily/static/discover/app.mjs');
  const doc = fakeDocument();
  const calls = [], visits = [];
  const fetcher = async (path) => {
    calls.push(path);
    if (path === '/v1/auth/session') return {status: 401, json: async () => ({})};
    if (path.startsWith('/v1/discover/works?')) return {status: 200, json: async () => ({items: [], cursor: null})};
    throw new Error('unexpected ' + path);
  };
  const history = {pushState(state, title, url) { visits.push(url); }};
  await mount(doc, {fetcher, history, location: {search: '?kind=image&creator=alice', pathname: '/discover'}});
  const el = id => doc.getElementById(id);
  assert.equal(el('feed-creator-clear').href, '/discover?kind=image');
  await el('feed-creator-clear').handlers.click({preventDefault() {}});
  await flush();
  const last = calls.filter((path) => path.startsWith('/v1/discover/works?')).at(-1);
  assert.doesNotMatch(last, /creator=/);
  assert.match(last, /kind=image/);
  assert.equal(el('feed-creator-chip').hidden, true);
  assert.equal(visits.at(-1), '/discover?kind=image');
});

test('a creator with no public work says that instead of claiming the directory is empty', async () => {
  const {mount} = await import('../openteamily/static/discover/app.mjs');
  const doc = fakeDocument();
  const fetcher = async (path) => {
    if (path === '/v1/auth/session') return {status: 401, json: async () => ({})};
    if (path.startsWith('/v1/discover/works?')) return {status: 200, json: async () => ({items: [], cursor: null})};
    throw new Error('unexpected ' + path);
  };
  await mount(doc, {fetcher, location: {search: '?creator=zed', pathname: '/discover'}});
  const note = doc.getElementById('feed-note');
  assert.equal(app.FEED_CREATOR_EMPTY_NOTE, '该作者还没有公开作品。');
  assert.equal(note.textContent, app.FEED_CREATOR_EMPTY_NOTE);
});

test('the creator chip is plain markup a page can hide, not a second feed', () => {
  const html = readFileSync(new URL('../openteamily/static/discover/index.html', import.meta.url), 'utf8');
  const block = html.split('id="feed-creator-chip"')[1].split('</p>')[0];
  assert.match(block, /id="feed-creator-label"/);
  assert.match(block, /id="feed-creator-clear"/);
  assert.equal(html.includes('id="feed-creator"'), false, 'no author dropdown: it would need a creators endpoint that does not exist');
  const css = readFileSync(new URL('../openteamily/static/discover/app.css', import.meta.url), 'utf8');
  assert.match(css, /\.feed-card-link \{[^}]*display:\s*flex/s);
  assert.match(css, /\.feed-author \{[^}]*text-decoration:\s*none/s);
});
