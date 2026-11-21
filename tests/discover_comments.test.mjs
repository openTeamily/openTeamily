// Comments on a public work, read in the same in-place detail the feed already opens.
// The control is a real write: it posts to the workspace's Bot Social and the row it
// shows afterwards comes back from that write, not from a local flip.
import assert from 'node:assert/strict';
import test from 'node:test';

class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.attributes = {}; this.handlers = {}; this.dataset = {};
    this.hidden = true; this.disabled = false; this.value = ''; this.textContent = '';
  }
  get childElementCount() { return this.children.length; }
  get options() { return this.children; }
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

function classHits(node, wanted, hits = []) {
  if (String(node.className || '').split(/\s+/).includes(wanted)) hits.push(node);
  for (const child of node.children || []) classHits(child, wanted, hits);
  return hits;
}

const WORK = {
  slug: 'ci-comment-work', title: '[CI FIXTURE] Commentable', kind: 'document', kind_label: '文档',
  author: 'alice', updated: 1800000000, path: '/w/ci-comment-work', comment_count: 2,
};

function comment(id, body, extra = {}) {
  return { id, body, author: { handle: 'alice', display_name: 'alice' }, created: 1800000100, own: true, deleted: false, ...extra };
}

function pageFixture({ session = { user: { username: 'alice' } }, comments = [comment('c1', '第一条评论'), comment('c2', '第二条评论', { own: false })], calls = [], reply = null } = {}) {
  const fetcher = async (path, options = {}) => {
    const method = options.method || 'GET';
    calls.push([path, method, options.body]);
    if (path === '/v1/auth/session') {
      return session ? { status: 200, json: async () => session } : { status: 401, json: async () => ({}) };
    }
    if (path.startsWith('/v1/discover/me/works') || path.startsWith('/v1/discover/works?')) {
      return { status: 200, json: async () => ({ items: [WORK], cursor: null }) };
    }
    if (path === '/w/ci-comment-work/preview') {
      return { status: 200, json: async () => ({ preview: { type: 'document', heading: '季报摘要', lines: ['第一行正文'] } }) };
    }
    if (path.startsWith('/v1/discover/works/ci-comment-work/comments')) {
      if (method === 'GET') return { status: 200, json: async () => ({ items: comments, next_after: null }) };
      if (method === 'DELETE') return { status: 200, json: async () => ({ deleted: true, comment_count: 0 }) };
      const answer = reply || { status: 201, json: async () => ({ comment: comment('c3', JSON.parse(options.body).body) }) };
      return answer;
    }
    throw new Error('unexpected ' + method + ' ' + path);
  };
  return fetcher;
}

async function openDetail(fetcher, session) {
  const app = await import('../openteamily/static/discover/app.mjs');
  const doc = fakeDocument();
  await app.mount(doc, { fetcher, location: { search: '', pathname: '/discover' } });
  const cell = doc.getElementById('feed-grid').children[0];
  const toggle = classHits(cell, 'feed-detail-toggle')[0];
  await toggle.handlers.click();
  await flush();
  return { app, doc, panel: classHits(cell, 'feed-detail')[0] };
}

test('opening a work detail loads its comments and shows the count it was listed with', async () => {
  const calls = [];
  const { app, panel } = await openDetail(pageFixture({ calls }));
  const reads = calls.filter(([path, method]) => method === 'GET' && path === '/v1/discover/works/ci-comment-work/comments?limit=20');
  assert.equal(reads.length, 1, 'the open detail reads the thread once');
  assert.match(JSON.stringify(panel), /第一条评论/);
  assert.match(JSON.stringify(panel), /第二条评论/);
  assert.match(JSON.stringify(panel), new RegExp('评论 · 2'));
  const rows = classHits(panel, 'feed-comment');
  assert.equal(rows.length, 2);
  assert.equal(app.FEED_COMMENT_EMPTY.includes('评论'), true);
});

test('writing a comment posts it and shows what came back', async () => {
  const calls = [];
  const { app, panel } = await openDetail(pageFixture({ calls }));
  const input = classHits(panel, 'feed-comment-input')[0];
  const submit = classHits(panel, 'feed-comment-submit')[0];
  assert.ok(input, 'a signed-in reader gets a composer');
  assert.ok(submit);
  input.value = '  这件作品很有用  ';
  await classHits(panel, 'feed-comment-form')[0].handlers.submit({ preventDefault() {} });
  await flush();
  const post = calls.find(([path, method]) => method === 'POST' && path === '/v1/discover/works/ci-comment-work/comments');
  assert.ok(post, 'the composer posts to the comments endpoint');
  assert.deepEqual(JSON.parse(post[2]), { body: '这件作品很有用' }, 'the draft is trimmed and sent as the body');
  assert.match(JSON.stringify(panel), /这件作品很有用/, 'the saved comment is shown');
  assert.equal(input.value, '', 'a saved draft is cleared');
  assert.equal(app.FEED_COMMENT_FAILED.includes('评论'), true);
});

test('deleting my own comment goes to the server and the row says it is gone', async () => {
  const calls = [];
  const comments = [comment('c1', '我写的')];
  const fetcher = pageFixture({ calls, comments });
  const { panel } = await openDetail(fetcher);
  const remove = classHits(panel, 'feed-comment-delete')[0];
  assert.ok(remove, 'an own comment offers delete');
  await remove.handlers.click();
  await flush();
  const call = calls.find(([path, method]) => method === 'DELETE');
  assert.equal(call[0], '/v1/discover/works/ci-comment-work/comments/c1');
  assert.match(JSON.stringify(panel), new RegExp('已删除'));
});

test('another author\'s comment offers no delete control', async () => {
  const calls = [];
  const comments = [comment('c2', '别人写的', { own: false, author: { handle: 'bob', display_name: 'bob' } })];
  const { panel } = await openDetail(pageFixture({ calls, comments }));
  assert.equal(classHits(panel, 'feed-comment-delete').length, 0);
  assert.equal(JSON.stringify(panel).includes('bob'), true);
});

test('a signed-out visitor is told to sign in and no comment request is sent', async () => {
  const calls = [];
  const { panel } = await openDetail(pageFixture({ calls, session: null }));
  assert.equal(classHits(panel, 'feed-comment-input').length, 0, 'no composer without a session');
  assert.equal(calls.some(([path, method]) => method !== 'GET' && path.includes('/comments')), false);
  assert.equal(calls.some(([path]) => path.includes('/comments')), false, 'a signed-out reader sends no comment read either');
  assert.match(JSON.stringify(panel), /登录后可以评论/);
});

test('a refused comment keeps the draft and says it did not save', async () => {
  const calls = [];
  const refused = { status: 500, json: async () => ({ error: { message: '保存失败' } }) };
  const { panel } = await openDetail(pageFixture({ calls, reply: refused }));
  const input = classHits(panel, 'feed-comment-input')[0];
  input.value = '没有保存的草稿';
  await classHits(panel, 'feed-comment-form')[0].handlers.submit({ preventDefault() {} });
  await flush();
  assert.equal(input.value, '没有保存的草稿', 'a refused draft is not thrown away');
  assert.match(classHits(panel, 'feed-comment-note')[0].textContent, /没有保存|重试/);
});
