import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { validSlug, catalogInitial, catalogItems, agentDiscoverPairs, isAgentsCatalog, isTeamsCatalog, renderTeamCard, FEED_CATEGORIES, CATALOG_CATEGORIES, FEED_ACTIVITY_EMPTY_NOTE, FEED_ACTIVITY_LISTED_NOTE, FEED_FOLLOWING_EMPTY_TITLE, FEED_FOLLOWING_EMPTY_BODY, FEED_FOLLOWING_NOTE, FEED_SEARCH_EMPTY_NOTE, feedQuery, formatFeedTime, renderFeedCard, coverPattern } from '../openteamily/static/discover/app.mjs';


test('catalogInitial skips leading punctuation like the public homepage initial', () => {
  assert.equal(catalogInitial('[CI FIXTURE] Directory assistant'), 'C');
  assert.equal(catalogInitial('Directory assistant'), 'D');
  assert.equal(catalogInitial('  智能体'), '智');
  assert.equal(catalogInitial('42-helper'), '4');
  assert.equal(catalogInitial('---'), '?');
  assert.equal(catalogInitial(''), '?');
  assert.equal(catalogInitial(undefined), '?');
});

test('validSlug mirrors the server slug rule', () => {
  assert.equal(validSlug('on-call'), true);
  assert.equal(validSlug('abc'), true);
  assert.equal(validSlug('a'), false);
  assert.equal(validSlug('On-call'), false);
  assert.equal(validSlug('-abc'), false);
  assert.equal(validSlug('abc-'), false);
  assert.equal(validSlug('a'.repeat(31)), false);
  assert.equal(validSlug(null), false);
});

test('isAgentsCatalog only matches the recorded tab=agents query', () => {
  assert.equal(isAgentsCatalog({search: ''}), false);
  assert.equal(isAgentsCatalog({search: '?tab=agents'}), true);
  assert.equal(isAgentsCatalog({search: '?tab=teams'}), false);
  assert.equal(isAgentsCatalog({search: '?tab=agents&section=groups'}), false);
  assert.equal(isAgentsCatalog(undefined), false);
});

test('isTeamsCatalog only matches the recorded tab=agents&section=groups query', () => {
  assert.equal(isTeamsCatalog({search: ''}), false);
  assert.equal(isTeamsCatalog({search: '?tab=agents'}), false);
  assert.equal(isTeamsCatalog({search: '?tab=agents&section=groups'}), true);
  assert.equal(isTeamsCatalog({search: '?section=groups'}), false);
  assert.equal(isTeamsCatalog(undefined), false);
});

test('available feed categories have a consistent order', () => {
  assert.deepEqual(FEED_CATEGORIES, ['网页', '图片', '音乐', '幻灯片', '视频', '3D 作品']);
});

test('feed all-filter shows the recorded 全部 label and keeps an empty canvas', () => {
  const html = readFileSync(new URL('../openteamily/static/discover/index.html', import.meta.url), 'utf8');
  const block = html.split('class="feed-filters"')[1].split('id="feed-following-empty"')[0];
  assert.match(block, /class="feed-filter-all"[^>]*aria-current="true"[^>]*>全部</);
  assert.equal(/class="feed-filter-all"[^>]*><\/button>/.test(block), false);
  assert.equal(/aria-label="全部"/.test(block), false);
  assert.equal(/没有单独标出文字|圆形按钮/.test(block), false);
  const order = ['全部', '热门', ...FEED_CATEGORIES];
  const positions = order.map((label) => block.indexOf(`>${label}<`));
  assert.equal(positions.every((index) => index !== -1), true);
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.match(html, /id="feed-activity-empty"/);
  assert.match(html, /id="feed-grid"[^>]*data-empty="true"/);
  const activity = html.split('id="feed-activity-empty"')[1].split('id="feed-note"')[0];
  assert.equal(/\bhidden\b/.test(activity.split('>')[0]), false);
  assert.equal(activity.includes('id="feed-note"'), false);
  assert.equal(/最多领取|CREDITS|积分中心/.test(html.split('id="feed-panel"')[1].split('id="catalog-view"')[0]), false);
});

test('recorded catalog categories stay in the captured order', () => {
  assert.deepEqual(CATALOG_CATEGORIES, [
    'Content Creation', 'Customer Support', 'Data Analysis', 'Design',
    'Education', 'Engineering', 'Finance', 'IT & Security', 'Investment',
    'Legal', 'Life', 'Marketing', 'Operations', 'Product', 'Recruiting', 'Research', 'Sales',
  ]);
});

test('catalog categories are selectable and the search opens a real dialog', () => {
  const html = readFileSync(new URL('../openteamily/static/discover/index.html', import.meta.url), 'utf8');
  const block = html.split('id="catalog-filters"')[1].split('id="catalog-creator-filter"')[0];
  assert.match(block, /data-catalog-category="all" aria-pressed="true">全部</);
  for (const label of CATALOG_CATEGORIES) assert.ok(block.includes('>' + label.replaceAll('&', '&amp;') + '<'));
  assert.doesNotMatch(block, /disabled/);
  assert.match(block, /id="catalog-filter-search"[^>]*aria-haspopup="dialog"/);
  assert.match(html, /<dialog id="catalog-category-dialog"/);
});


test('the teams catalog links to the existing team wizard', () => {
  const html = readFileSync(new URL('../openteamily/static/discover/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="catalog-tab-teams" href="\/discover\?tab=agents&amp;section=groups">AI 团队</);
  assert.match(html, /id="catalog-create-team" href="\/team" hidden>\+ 创建团队</);
  assert.doesNotMatch(html, /没有公共 AI 团队目录接口/);
});

test('team cards render real membership and keep a join action for nonmembers', () => {
  const doc = fakeDocument();
  const team = {workspace_id: 'ott_1', name: '策划团队', summary: '<b>Brief</b>', member_count: 2};
  const card = renderTeamCard(doc, team, {onJoin() {}});
  assert.equal(card.children[0].children[1].textContent, team.name);
  assert.equal(card.children[1].textContent, team.summary);
  assert.equal(card.children[2].children[0].textContent, '2 位成员');
  assert.equal(card.children[2].children[1].textContent, '申请加入');
  for (const [membership, label] of [['member','已加入'],['pending','等待审批'],['suspended','已暂停']]) {
    const state = renderTeamCard(doc, {...team, membership}, {onJoin() {}}).children[2].children[1];
    assert.equal(state.tagName, 'span');
    assert.equal(state.textContent, label);
  }
});

test('catalog filter rows do not wrap chips onto a second line', () => {
  const css = readFileSync(new URL('../openteamily/static/discover/app.css', import.meta.url), 'utf8');
  const block = css.split('.catalog-filters {')[1].split('.catalog-creator-row')[0];
  assert.match(block, /flex-wrap:\s*nowrap/);
  assert.match(block, /\.catalog-filter-scroll[^}]*overflow-x:\s*auto/s);
  assert.match(block, /\.catalog-filter-search[^}]*flex:\s*0 0 auto/s);
  assert.equal(/\.catalog-filters \{[^}]*flex-wrap:\s*wrap/.test(css.split('/* Design refresh */')[0]), false);
});


test('catalogItems tolerates missing bodies', () => {
  assert.deepEqual(catalogItems({items: [{slug: 'a'}]}), [{slug: 'a'}]);
  assert.deepEqual(catalogItems(null), []);
  assert.deepEqual(catalogItems({}), []);
});

test('agentDiscoverPairs aligns statuses by index and defaults to unlisted', () => {
  const agents = [{id: 'a'}, {id: 'b'}];
  const pairs = agentDiscoverPairs(agents, [{listed: true, slug: 'a'}]);
  assert.deepEqual(pairs[0].discover, {listed: true, slug: 'a'});
  assert.deepEqual(pairs[1].discover, {listed: false});
});

test('publish management keeps archived listings available for withdrawal', () => {
  const agents = [{id:'active'}, {id:'archived-public', archived:1}, {id:'archived-private', archived:1}];
  const statuses = [{listed:false}, {listed:true}, {listed:false}];
  assert.deepEqual(agentDiscoverPairs(agents,statuses).map(({agent}) => agent.id), ['active','archived-public']);
});


test('catalogQuery encodes search and cursor on the existing public allowlist', async () => {
  const {catalogQuery} = await import('../openteamily/static/discover/app.mjs');
  assert.equal(catalogQuery(), '/v1/discover/agents?limit=12');
  assert.equal(catalogQuery('  a & 中文  ', 'ci-helper-01'),
    '/v1/discover/agents?limit=12&q=a+%26+%E4%B8%AD%E6%96%87&cursor=ci-helper-01');
});

class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.attributes = {}; this.handlers = {}; this.dataset = {};
    this.hidden = true; this.disabled = false; this.value = ''; this.textContent = '';
  }
  get childElementCount() { return this.children.length; }
  get options() { return this.children; }
  append(...nodes) { this.children.push(...nodes); }
  prepend(...nodes) { this.children.unshift(...nodes); }
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

test('DS-Bot paints the public catalog before session, then enables the already loaded viewer flags', async () => {
  const {mount} = await import('../openteamily/static/discover/app.mjs');
  const doc = fakeDocument();
  doc.querySelector = selector => selector.includes('openteamily-served-by') ? {} : null;
  const session = Promise.withResolvers();
  const requests = [];
  const work = detailFixture({liked: true, collected: true, own_work: true});
  const loaded = mount(doc, {location: {search: '?sort=popular'}, fetcher(path) {
    requests.push(path);
    if (path === '/v1/auth/session') return session.promise;
    if (path === '/v1/discover/works?limit=12&sort=popular') {
      return Promise.resolve(commentResponse({items: [work], viewer_username: 'alice'}));
    }
    throw new Error(path);
  }});
  const el = id => doc.getElementById(id);
  await flush();
  assert.equal(el('main-panel').hidden, false);
  assert.equal(el('catalog-manage').hidden, true);
  assert.equal(el('whoami').textContent, '');
  const [card] = el('feed-grid').children;
  const [comments, details] = card.children[1].children;
  assert.equal(card.children[1].className, 'feed-card-actions');
  assert.equal(card.children[1].children.length, 2);
  assert.equal(comments.className, 'feed-comments-toggle');
  assert.equal(details.className, 'feed-detail-toggle');
  session.resolve(commentResponse({user: {id: 'owner', username: 'alice'}}));
  await loaded;
  assert.equal(el('feed-grid').children[0], card, 'session did not remove or rebuild the visible card');
  assert.equal(el('whoami').textContent, 'alice');
  const [like, collect, stillComments, stillDetails] = card.children[1].children;
  assert.equal(like.attributes['aria-pressed'], 'true');
  assert.equal(collect.attributes['aria-pressed'], 'true');
  assert.equal(stillComments, comments, 'the owner has no follow control');
  assert.equal(stillDetails, details, 'the detail control remains last');
  assert.deepEqual(requests, ['/v1/auth/session', '/v1/discover/works?limit=12&sort=popular']);
});

test('a guest sees the public works before sign-in resolves and never requests a private tab', async () => {
  const {mount} = await import('../openteamily/static/discover/app.mjs');
  const doc = fakeDocument();
  const session = Promise.withResolvers();
  const requests = [];
  const loaded = mount(doc, {location: {search: ''}, fetcher(path) {
    requests.push(path);
    if (path === '/v1/auth/session') return session.promise;
    if (path === '/v1/discover/works?limit=12') return Promise.resolve(commentResponse({items: [detailFixture()]}));
    throw new Error(path);
  }});
  const el = id => doc.getElementById(id);
  await flush();
  assert.equal(el('feed-grid').children.length, 1);
  await el('feed-tab-collected').handlers.click();
  assert.equal(el('feed-grid').children.length, 0);
  assert.equal(el('feed-note').textContent, '');
  session.resolve(commentResponse({}, 401));
  await loaded;
  assert.equal(el('login-panel').hidden, false);
  assert.match(el('feed-note').textContent, /请先登录/);
  assert.deepEqual(requests, ['/v1/auth/session', '/v1/discover/works?limit=12']);
});

test('a signed-in private tab supersedes a delayed public response and clears after logout', async () => {
  const {mount} = await import('../openteamily/static/discover/app.mjs');
  const doc = fakeDocument();
  doc.querySelector = selector => selector.includes('openteamily-served-by') ? {} : null;
  const publicFeed = Promise.withResolvers();
  const session = Promise.withResolvers();
  const requests = [];
  let authCount = 0;
  const loaded = mount(doc, {location: {search: ''}, fetcher(path) {
    requests.push(path);
    if (path === '/v1/auth/session') return ++authCount === 1 ? session.promise : Promise.resolve(commentResponse({}, 401));
    if (path === '/v1/discover/works?limit=12') return publicFeed.promise;
    if (path === '/v1/discover/me/works?limit=12&tab=following') {
      return Promise.resolve(commentResponse({items: [detailFixture({slug: 'followed-work', title: 'Followed'})], viewer_username: 'alice'}));
    }
    if (path === '/v1/auth/logout') return Promise.resolve(commentResponse({}));
    throw new Error(path);
  }});
  const el = id => doc.getElementById(id);
  await el('feed-tab-following').handlers.click();
  assert.deepEqual(requests, ['/v1/auth/session', '/v1/discover/works?limit=12']);
  session.resolve(commentResponse({user: {id: 'owner', username: 'alice'}}));
  await loaded;
  const [row] = el('feed-grid').children;
  const [oldLike] = row.children[1].children;
  publicFeed.resolve(commentResponse({items: [detailFixture()]}));
  await flush();
  assert.equal(el('feed-grid').children[0], row);
  await el('logout-form').handlers.submit({preventDefault() {}});
  await oldLike.handlers.click();
  assert.equal(el('feed-grid').children.length, 0);
  assert.match(el('feed-note').textContent, /请先登录/);
  assert.deepEqual(requests, [
    '/v1/auth/session', '/v1/discover/works?limit=12', '/v1/discover/me/works?limit=12&tab=following',
    '/v1/auth/logout', '/v1/auth/session',
  ]);
});

test('the platform page keeps public cards visible while signed-in viewer flags are read', async () => {
  const {mount} = await import('../openteamily/static/discover/app.mjs');
  const doc = fakeDocument();
  const session = Promise.withResolvers();
  const viewerFeed = Promise.withResolvers();
  const work = detailFixture();
  const loaded = mount(doc, {location: {search: ''}, fetcher(path) {
    if (path === '/v1/auth/session') return session.promise;
    if (path === '/v1/discover/works?limit=12') return Promise.resolve(commentResponse({items: [work]}));
    if (path === '/v1/discover/me/works?limit=12&tab=all') return viewerFeed.promise;
    throw new Error(path);
  }});
  const grid = doc.getElementById('feed-grid');
  await flush();
  const [publicCard] = grid.children;
  assert.equal(publicCard.children[1].children.length, 2);
  session.resolve(commentResponse({user: {id: 'owner', username: 'alice'}}));
  await flush();
  assert.equal(grid.children[0], publicCard);
  assert.equal(publicCard.children[1].children.length, 2);
  viewerFeed.resolve(commentResponse({items: [{...work, liked: true}]}));
  await loaded;
  const [like] = grid.children[0].children[1].children;
  assert.equal(like.attributes['aria-pressed'], 'true');
});

test('the signed-in native feed refreshes once when a different account provided the public cards', async () => {
  const {mount} = await import('../openteamily/static/discover/app.mjs');
  const doc = fakeDocument();
  doc.querySelector = selector => selector.includes('openteamily-served-by') ? {} : null;
  const session = Promise.withResolvers();
  const refresh = Promise.withResolvers();
  const requests = [];
  const work = detailFixture({liked: true, own_work: true});
  const loaded = mount(doc, {location: {search: ''}, fetcher(path) {
    requests.push(path);
    if (path === '/v1/auth/session') return session.promise;
    if (path !== '/v1/discover/works?limit=12') throw new Error(path);
    return requests.length === 2 ? Promise.resolve(commentResponse({items: [work], viewer_username: 'alice', cursor: 'old-cursor'})) : refresh.promise;
  }});
  const grid = doc.getElementById('feed-grid');
  const more = doc.getElementById('feed-more');
  await flush();
  const [publicCard] = grid.children;
  assert.equal(publicCard.children[1].children.length, 2);
  assert.equal(more.disabled, true);
  session.resolve(commentResponse({user: {username: 'bobby'}}));
  await flush();
  assert.equal(grid.children[0], publicCard);
  assert.equal(publicCard.children[1].children.length, 2);
  assert.equal(more.hidden, true);
  refresh.resolve(commentResponse({items: [{...work, liked: false, own_work: false}], viewer_username: 'bobby', cursor: 'new-cursor'}));
  await loaded;
  const [like, , follow] = grid.children[0].children[1].children;
  assert.equal(like.attributes['aria-pressed'], 'false');
  assert.equal(follow.textContent, '关注');
  assert.equal(follow.attributes['aria-label'], '关注作者');
  assert.equal(more.disabled, false);
  assert.equal(more.hidden, false);
  assert.deepEqual(requests, ['/v1/auth/session', '/v1/discover/works?limit=12', '/v1/discover/works?limit=12']);
});

test('the native feed discards private rows with an unproven viewer after a single retry', async () => {
  const {mount} = await import('../openteamily/static/discover/app.mjs');
  const doc = fakeDocument();
  doc.querySelector = selector => selector.includes('openteamily-served-by') ? {} : null;
  const requests = [];
  await mount(doc, {location: {search: '?feed=collected'}, fetcher: async path => {
    requests.push(path);
    if (path === '/v1/auth/session') return commentResponse({user: {username: 'bobby'}});
    assert.equal(path, '/v1/discover/me/works?limit=12&tab=collected');
    const viewer_username = requests.length === 2 ? 'alice' : ['bobby'];
    return commentResponse({items: [detailFixture({title: 'Other account collection'})], viewer_username});
  }});
  assert.equal(doc.getElementById('feed-grid').children.length, 0);
  assert.match(doc.getElementById('feed-error').textContent, /登录状态已变化/);
  assert.equal(requests.length, 3);
});

test('public agent cards and profile links render while account actions are waiting for the session', async () => {
  const {mount} = await import('../openteamily/static/discover/app.mjs');
  const doc = fakeDocument();
  doc.querySelector = selector => selector.includes('openteamily-served-by') ? {} : null;
  const session = Promise.withResolvers();
  const requests = [];
  const loaded = mount(doc, {location: {search: '?tab=agents'}, fetcher: async path => {
    requests.push(path);
    if (path === '/v1/auth/session') return session.promise;
    if (path === '/v1/discover/agents?limit=12') return commentResponse({
      viewer_username: 'alice', items: [{slug: 'writing-demo', name: 'Writing', chat_enabled: true}],
    });
    if (path === '/v1/workspaces?limit=100') return commentResponse({items: []});
    throw new Error(path);
  }});
  const el = id => doc.getElementById(id);
  await flush();
  assert.equal(el('main-panel').hidden, false);
  const [row] = el('discover-list').children;
  assert.equal(classHits(row, 'catalog-profile')[0].href, '/a/writing-demo');
  assert.equal(classHits(row, 'catalog-use').length, 0);
  assert.equal(classHits(row, 'catalog-chat').length, 0);
  assert.equal(el('catalog-manage').hidden, true);
  assert.equal(el('catalog-create-agent').hidden, true);

  session.resolve(commentResponse({user: {id: 'owner', username: 'alice'}}));
  await loaded;
  assert.equal(el('discover-list').children[0], row);
  assert.equal(classHits(row, 'catalog-use').length, 1);
  assert.equal(classHits(row, 'catalog-chat')[0].href, '/chat#public-agent=writing-demo');
  assert.equal(el('catalog-manage').hidden, false);
  assert.deepEqual(requests, ['/v1/auth/session', '/v1/discover/agents?limit=12', '/v1/workspaces?limit=100']);
});

test('a late wrong-viewer catalog recheck leaves the selected search and actions intact', async () => {
  const {mount} = await import('../openteamily/static/discover/app.mjs');
  const doc = fakeDocument();
  doc.querySelector = selector => selector.includes('openteamily-served-by') ? {} : null;
  const session = Promise.withResolvers();
  const verification = Promise.withResolvers();
  const requests = [];
  const initial = '/v1/discover/agents?limit=12';
  const loaded = mount(doc, {location: {search: '?tab=agents'}, fetcher: async path => {
    requests.push(path);
    if (path === '/v1/auth/session') return session.promise;
    if (path === '/v1/workspaces?limit=100') return commentResponse({items: []});
    if (path === initial) {
      if (requests.filter(url => url === initial).length === 2) return verification.promise;
      return commentResponse({viewer_username: 'other', items: [{slug: 'writing-demo', name: 'Writing', chat_enabled: true}]});
    }
    if (path === initial + '&q=math') {
      return commentResponse({viewer_username: 'alice', items: [{slug: 'math-demo', name: 'Math', chat_enabled: true, own_agent: true}]});
    }
    throw new Error(path);
  }});
  await flush();
  session.resolve(commentResponse({user: {id: 'owner', username: 'alice'}}));
  await loaded;
  assert.equal(classHits(doc.getElementById('discover-list'), 'catalog-chat').length, 0);
  const query = doc.getElementById('catalog-query');
  query.value = 'math';
  await doc.getElementById('catalog-search').handlers.submit({preventDefault() {}});
  verification.resolve(commentResponse({viewer_username: 'alice', items: [{slug: 'writing-demo', name: 'Writing', chat_enabled: true}]}));
  await flush();

  const list = doc.getElementById('discover-list');
  assert.equal(classHits(list, 'catalog-profile')[0].href, '/a/math-demo');
  assert.equal(classHits(list, 'catalog-chat').length, 0);
  assert.equal(classHits(list, 'catalog-use').length, 1);
  assert.equal(query.value, 'math');
  assert.equal(requests.filter(url => url === initial).length, 2);
});

test('anonymous catalog search/clear/paging use public GETs and never publish on browse', async () => {
  const {mount} = await import('../openteamily/static/discover/app.mjs');
  const doc = fakeDocument();
  const requests = [];
  const fetcher = async (path, options) => {
    requests.push([path, options.method]);
    if (path === '/v1/auth/session') return {status: 401, json: async () => ({})};
    const url = new URL(path, 'https://management.test');
    const query = url.searchParams.get('q');
    const cursor = url.searchParams.get('cursor');
    return {status: 200, json: async () => query
      ? {items: []}
      : {items: [{name: 'Fixture', slug: cursor ? 'fixture-two' : 'fixture-one', summary: '<script>not HTML</script>'}],
        cursor: cursor ? null : 'fixture-one'}};
  };
  await mount(doc, {fetcher, location: {search: '?tab=agents'}});
  const el = id => doc.getElementById(id);
  assert.equal(el('main-panel').hidden, false);
  assert.equal(el('catalog-manage').hidden, true);
  assert.equal(el('catalog-more').hidden, false);
  const card = el('discover-list').children[0].children[0];
  const profile = card.children[1].children[0].children[0];
  assert.equal(profile.tagName, 'a');
  assert.equal(profile.href, '/a/fixture-one');
  assert.equal(profile.textContent, 'Fixture');
  assert.equal(card.children[1].children[1].textContent, '<script>not HTML</script>');
  assert.equal(classHits(card, 'catalog-use')[0].textContent, '复制');
  await el('catalog-more').handlers.click();
  assert.equal(el('discover-list').children.length, 2);
  assert.equal(el('catalog-more').hidden, true);
  el('catalog-query').value = 'nothing & 中文';
  el('catalog-search').handlers.submit({preventDefault() {}});
  await flush();
  assert.equal(el('discover-list').children.length, 0);
  assert.match(el('discover-empty').textContent, /没有匹配/);
  el('catalog-clear').handlers.click();
  await flush();
  assert.equal(el('catalog-query').value, '');
  assert.equal(el('discover-list').children.length, 1);
  assert.equal(requests.every(([, method]) => method === 'GET'), true);
  assert.equal(requests.some(([path]) => path.includes('cursor=fixture-one')), true);
  assert.equal(requests.some(([path]) => path.includes('q=nothing+%26+%E4%B8%AD%E6%96%87')), true);
});

test('catalog failure displays an error and leaves loading state', async () => {
  const {mount} = await import('../openteamily/static/discover/app.mjs');
  const doc = fakeDocument();
  await mount(doc, {location: {search: '?tab=agents'}, fetcher: async path => {
    if (path === '/v1/auth/session') return {status: 401, json: async () => ({})};
    throw new Error('fixture unavailable');
  }});
  assert.equal(doc.getElementById('catalog-error').hidden, false);
  assert.match(doc.getElementById('catalog-error').textContent, /fixture unavailable/);
  assert.equal(doc.getElementById('catalog-panel').attributes['aria-busy'], 'false');
  assert.equal(doc.getElementById('discover-empty').hidden, true);
});

test('catalog cards only link to profiles with a valid public slug', async () => {
  const {mount} = await import('../openteamily/static/discover/app.mjs');
  const doc = fakeDocument();
  const fetcher = async path => {
    if (path === '/v1/auth/session') return {status: 401, json: async () => ({})};
    return {status: 200, json: async () => ({items: [{name: 'Fixture', slug: '../fixture-one'}], cursor: null})};
  };
  await mount(doc, {fetcher, location: {search: '?tab=agents'}});
  const card = doc.getElementById('discover-list').children[0].children[0];
  const title = card.children[1].children[0];
  assert.equal(title.textContent, 'Fixture');
  assert.equal(title.childElementCount, 0);
});

test('default discover view loads works; private tabs require sign-in and does not load the catalog API', async () => {
  const {mount} = await import('../openteamily/static/discover/app.mjs');
  const doc = fakeDocument();
  const requests = [];
  const fetcher = async (path, options) => {
    requests.push([path, options.method]);
    if (path === '/v1/auth/session') return {status: 401, json: async () => ({})};
    if (path.startsWith('/v1/discover/me/works?')) return {status: 401, json: async () => ({})};
    if (path.startsWith('/v1/discover/works?')) return {status: 200, json: async () => ({items: [], cursor: null})};
    throw new Error('unexpected ' + path);
  };
  await mount(doc, {fetcher, location: {search: ''}});
  const el = id => doc.getElementById(id);
  assert.equal(el('main-panel').hidden, false);
  assert.equal(el('feed-panel').hidden, false);
  assert.equal(el('catalog-view').hidden, true);
  assert.equal(el('feed-note').textContent, FEED_ACTIVITY_EMPTY_NOTE);
  assert.equal(el('feed-following-empty').hidden, true);
  assert.equal(el('feed-activity-empty').hidden, false);
  assert.equal(el('feed-tab-activity').attributes['aria-selected'], 'true');
  assert.equal(requests.some(([path]) => path.startsWith('/v1/discover/agents')), false);
  assert.equal(requests.some(([path]) => path.startsWith('/v1/discover/works?')), true);
  await el('feed-tab-following').handlers.click();
  assert.match(el('feed-note').textContent, /请先登录/);
  assert.equal(el('feed-following-empty').hidden, true);
  assert.equal(el('feed-activity-empty').hidden, false);
  assert.equal(el('feed-tab-following').attributes['aria-selected'], 'true');
  assert.equal(FEED_FOLLOWING_EMPTY_TITLE, '关注列表暂无动态');
  assert.equal(FEED_FOLLOWING_EMPTY_BODY, '你关注的人发布动态后会显示在这里。');
  assert.equal(FEED_FOLLOWING_NOTE.includes('没有对照截图'), false);
  assert.match(FEED_FOLLOWING_NOTE, /你关注的作者已公开/);
  await el('feed-tab-activity').handlers.click();
  assert.equal(el('feed-following-empty').hidden, true);
  assert.equal(el('feed-activity-empty').hidden, false);
  assert.equal(el('feed-note').textContent, FEED_ACTIVITY_EMPTY_NOTE);
});

test('anonymous viewers see login guidance and never query the teams directory', async () => {
  const {mount} = await import('../openteamily/static/discover/app.mjs');
  const doc = fakeDocument();
  const requests = [];
  const fetcher = async path => {
    requests.push(path);
    return {status: 401, json: async () => ({})};
  };
  await mount(doc, {fetcher, location: {search: '?tab=agents&section=groups'}});
  assert.equal(doc.getElementById('catalog-tab-teams').attributes['aria-current'], 'page');
  assert.equal(doc.getElementById('catalog-create-team').hidden, false);
  assert.match(doc.getElementById('discover-empty').textContent, /登录后/);
  await doc.getElementById('catalog-search').handlers.submit({preventDefault() {}});
  assert.deepEqual(requests, ['/v1/auth/session']);
});

test('search and join use the team directory and show the approval status', async () => {
  const {mount} = await import('../openteamily/static/discover/app.mjs');
  const doc = fakeDocument();
  const requests = [];
  const team = {workspace_id: 'ott_1', name: '产品团队', member_count: 2};
  const pending = Promise.withResolvers();
  const respond = (status, body) => ({status, json: async () => body});
  const fetcher = async (path, options) => {
    requests.push([path, options.method]);
    if (path === '/v1/auth/session') return respond(200, {user: {id: 'one', username: 'alice'}});
    if (path === '/v1/team-directory/ott_1/join') return pending.promise;
    assert.match(path, /^\/v1\/team-directory\?limit=100/);
    return respond(200, {items: path.includes('&q=') ? [] : [team]});
  };
  await mount(doc, {fetcher, location: {search: '?tab=agents&section=groups'}});
  const el = id => doc.getElementById(id);
  const teamAction = () => el('discover-list').children[0].children[0].children[1].children[1];
  const original = teamAction();
  const clicked = original.handlers.click();
  await original.handlers.click();
  assert.equal(teamAction().disabled, true);
  pending.resolve(respond(202, {join_request: {status: 'pending'}}));
  await clicked;
  assert.equal(teamAction().textContent, '等待审批');
  el('catalog-query').value = '  研发 & 内容 ';
  await el('catalog-search').handlers.submit({preventDefault() {}});
  assert.equal(el('discover-empty').textContent, '没有匹配的团队。');
  await el('catalog-clear').handlers.click();
  assert.equal(el('discover-list').children.length, 1);
  assert.deepEqual(requests, [
    ['/v1/auth/session', 'GET'],
    ['/v1/team-directory?limit=100', 'GET'],
    ['/v1/team-directory/ott_1/join', 'POST'],
    ['/v1/team-directory?limit=100&q=%E7%A0%94%E5%8F%91+%26+%E5%86%85%E5%AE%B9', 'GET'],
    ['/v1/team-directory?limit=100', 'GET'],
  ]);
});

test('feedQuery encodes a keyword and a recency cursor', () => {
  assert.equal(feedQuery('', ''), 'limit=12');
  assert.equal(feedQuery('外观', '100.ci-doc'), 'limit=12&q=%E5%A4%96%E8%A7%82&cursor=100.ci-doc');
  assert.equal(feedQuery('设计', 'hot-key', '', 'popular'), 'limit=12&q=%E8%AE%BE%E8%AE%A1&cursor=hot-key&sort=popular');
  assert.equal(feedQuery('', '', '', 'latest', 'vera.home'), 'limit=12&creator=vera.home');
});

test('the activity feed renders opted-in work cards from the public API', async () => {
  const {mount} = await import('../openteamily/static/discover/app.mjs');
  const doc = fakeDocument();
  const fetcher = async (path) => {
    if (path === '/v1/auth/session') return {status: 401, json: async () => ({})};
    if (path === '/v1/discover/works?limit=12') {
      return {status: 200, json: async () => ({items: [{
        slug: 'ci-fixture-doc',
        title: '[CI FIXTURE] Document',
        kind: 'document',
        kind_label: '文档',
        author: 'alice',
        updated: 1800000000,
        path: '/w/ci-fixture-doc',
      }], cursor: null})};
    }
    throw new Error('unexpected ' + path);
  };
  await mount(doc, {fetcher, location: {search: ''}});
  const el = id => doc.getElementById(id);
  assert.equal(el('feed-grid').dataset.empty, 'false');
  assert.equal(el('feed-grid').children.length, 1);
  const cell = el('feed-grid').children[0];
  // The grid cell wraps the work link so the detail can sit beside it.
  assert.equal(String(cell.tagName).toLowerCase(), 'article');
  assert.equal(cell.className, 'feed-entry');
  const card = cell.children[0];
  assert.equal(String(card.tagName).toLowerCase(), 'a');
  assert.equal(card.href, '/discover?work=ci-fixture-doc');
  assert.equal(card.children[0].className, 'work-cover');
  assert.equal(card.children[0].dataset.kind, 'document');
  assert.equal(card.children[1].textContent, '文档');
  assert.equal(card.children[2].textContent, '[CI FIXTURE] Document');
  assert.equal(card.children[3].children[1].textContent.includes('alice'), true);
  assert.equal(el('feed-note').textContent, FEED_ACTIVITY_LISTED_NOTE);
  assert.equal(el('feed-count').textContent, '已显示 1 件公开作品');
  assert.equal(el('feed-more').hidden, true);
});

test('formatFeedTime renders the listing timestamp in Asia/Shanghai', () => {
  assert.equal(formatFeedTime(1800000000), '2027/1/15');
});


test('work type selection uses the real API and resets pagination, all restores full feed', async () => {
  const {mount} = await import('../openteamily/static/discover/app.mjs');
  const doc = fakeDocument();
  const calls = [];
  const fetcher = async (path, options) => {
    calls.push([path, options.method]);
    if (path === '/v1/auth/session') return {status: 401, json: async () => ({})};
    return {status: 200, json: async () => ({items: [], cursor: path.includes('kind=website') ? '1.site-one' : null})};
  };
  await mount(doc, {fetcher, location: {search: ''}});
  const el = id => doc.getElementById(id);
  await el('feed-kind-website').handlers.click();
  assert.equal(calls.at(-1)[0], '/v1/discover/works?limit=12&kind=website');
  assert.equal(el('feed-kind-website').attributes['aria-current'], 'true');
  assert.equal(el('feed-kind-all').attributes['aria-current'], 'false');
  el('feed-more').handlers.click();
  await flush();
  assert.equal(calls.at(-1)[0], '/v1/discover/works?limit=12&cursor=1.site-one&kind=website');
  await el('feed-kind-image').handlers.click();
  assert.equal(calls.at(-1)[0], '/v1/discover/works?limit=12&kind=image');
  await el('feed-kind-all').handlers.click();
  assert.equal(calls.at(-1)[0], '/v1/discover/works?limit=12');
  assert.equal(calls.every(([, method]) => method === 'GET'), true);
});

test('the feed only presents available filters', () => {
  const html = readFileSync(new URL('../openteamily/static/discover/index.html', import.meta.url), 'utf8');
  for (const kind of ['website', 'image', 'audio', 'slides', 'video', 'model3d']) {
    const tag = html.match(new RegExp('<button[^>]*id="feed-kind-' + kind + '"[^>]*>'))[0];
    assert.equal(tag.includes('disabled'), false);
  }
  assert.doesNotMatch(html, />小游戏</);
  assert.equal(feedQuery('中文', '1.site-one', 'website'), 'limit=12&q=%E4%B8%AD%E6%96%87&cursor=1.site-one&kind=website');
});


test('every supported selected type uses the selected category styling', () => {
  const css = readFileSync(new URL('../openteamily/static/discover/app.css', import.meta.url), 'utf8');
  assert.match(css, /\.feed-filters button\[aria-current="true"\]/);
});


test('signed-in feed persists like/collect/follow and loads real private tabs', async () => {
  const {mount} = await import('../openteamily/static/discover/app.mjs');
  const doc = fakeDocument(), calls = [];
  const state = {liked: false, collected: false, following: false, likes: 0};
  const item = {slug: 'shared-doc', title: 'Public work', author: 'bob', path: '/w/shared-doc', kind: 'document'};
  const fetcher = async (path, options) => {
    calls.push([path, options]);
    if (path === '/v1/auth/session') return {status: 200, json: async () => ({user: {username: 'alice'}})};
    if (path.endsWith('/engagement')) {
      const body = JSON.parse(options.body);
      state[{like: 'liked', collect: 'collected', follow: 'following'}[body.action]] = body.enabled;
      state.likes = state.liked ? 1 : 0;
      return {status: 200, json: async () => state};
    }
    if (path.startsWith('/v1/discover/me/works?')) return {status: 200, json: async () => ({items: [{...item, ...state}], cursor: null})};
    throw new Error('unexpected ' + path);
  };
  await mount(doc, {fetcher, location: {search: ''}});
  const grid = doc.getElementById('feed-grid');
  await grid.children[0].children[1].children[0].handlers.click();
  assert.equal(state.liked, true);
  const [liked] = grid.children[0].children[1].children;
  assert.equal(liked.textContent, '点赞 · 1');
  assert.equal(liked.attributes['aria-label'], '取消点赞 · 1');
  await grid.children[0].children[1].children[1].handlers.click();
  assert.equal(state.collected, true);
  await grid.children[0].children[1].children[2].handlers.click();
  assert.equal(state.following, true);
  await doc.getElementById('feed-tab-following').handlers.click();
  assert.match(calls.at(-1)[0], /tab=following/);
  await doc.getElementById('feed-tab-collected').handlers.click();
  assert.match(calls.at(-1)[0], /tab=collected/);
});


test('switching private feed tabs cannot be overwritten by an older in-flight response', async () => {
  const {mount} = await import('../openteamily/static/discover/app.mjs');
  const doc = fakeDocument();
  let release;
  const fetcher = async path => {
    if (path === '/v1/auth/session') return {status: 200, json: async () => ({user: {id: 'owner'}})};
    if (path.startsWith('/v1/workspaces')) return {status: 200, json: async () => ({items: []})};
    if (path.includes('tab=following')) return new Promise(resolve => {release = resolve;});
    return {status: 200, json: async () => ({items: path.includes('tab=collected') ? [{slug: 'saved-work', title: 'Saved fixture', kind: 'document'}] : []})};
  };
  await mount(doc, {fetcher, location: {search: ''}});
  const pending = doc.getElementById('feed-tab-following').handlers.click();
  await flush();
  await doc.getElementById('feed-tab-collected').handlers.click();
  release({status: 200, json: async () => ({items: [{slug: 'old-work', title: 'Stale fixture', kind: 'document'}]})});
  await pending;
  const grid = doc.getElementById('feed-grid');
  assert.equal(grid.children.length, 1);
  assert.match(JSON.stringify(grid.children[0]), /Saved fixture/);
  assert.doesNotMatch(JSON.stringify(grid.children[0]), /Stale fixture/);
});


test('feed selection round-trips through the URL search', async () => {
  const {feedStateFromSearch, feedSearchText} = await import('../openteamily/static/discover/app.mjs');
  assert.deepEqual(feedStateFromSearch('?feed=following&kind=video&q=cat'),
    {tab: 'following', kind: 'video', sort: 'latest', query: 'cat'});
  assert.deepEqual(feedStateFromSearch('?feed=collected&q=%E4%B8%AD%E6%96%87'),
    {tab: 'collected', kind: '', sort: 'latest', query: '中文'});
  assert.deepEqual(feedStateFromSearch('?tab=agents'),
    {tab: 'activity', kind: '', sort: 'latest', query: ''});
  assert.deepEqual(feedStateFromSearch('?feed=following&kind=bogus'),
    {tab: 'following', kind: '', sort: 'latest', query: ''});
  assert.deepEqual(feedStateFromSearch('?feed=activity'), {tab: 'activity', kind: '', sort: 'latest', query: ''});
  assert.deepEqual(feedStateFromSearch(''), {tab: 'activity', kind: '', sort: 'latest', query: ''});
  assert.deepEqual(feedStateFromSearch(undefined), {tab: 'activity', kind: '', sort: 'latest', query: ''});
  assert.deepEqual(feedStateFromSearch('?sort=popular&q=cat'), {tab: 'activity', kind: '', sort: 'popular', query: 'cat'});
  assert.deepEqual(feedStateFromSearch('?kind=model3d'), {tab: 'activity', kind: 'model3d', sort: 'latest', query: ''});
  assert.equal(feedSearchText(feedStateFromSearch('?sort=popular&q=cat')), '?sort=popular&q=cat');
  assert.equal(feedSearchText({tab: 'following', kind: 'video', query: 'cat'}),
    '?feed=following&kind=video&q=cat');
  assert.equal(feedSearchText({tab: 'collected', kind: '', query: ''}), '?feed=collected');
  assert.equal(feedSearchText({tab: 'activity', kind: '', query: ''}), '');
  assert.equal(feedSearchText({tab: 'following', kind: 'bogus', query: ''}), '?feed=following');
});

test('热门 and work kinds replace each other and restore their activity URLs', async () => {
  const {mount} = await import('../openteamily/static/discover/app.mjs');
  const doc = fakeDocument(), requests = [], visits = [], handlers = {};
  const location = {search: '?kind=model3d&q=chair', pathname: '/discover'};
  const fetcher = async path => {
    if (path === '/v1/auth/session') return {status: 200, json: async () => ({user: {username: 'alice'}})};
    requests.push(new URL(path, 'https://example.com').searchParams);
    return {status: 200, json: async () => ({items: [], cursor: null})};
  };
  await mount(doc, {fetcher, location, history: {pushState(_state, _title, url) {visits.push(url);}},
    window: {addEventListener(type, handler) {handlers[type] = handler;}}});
  const el = id => doc.getElementById(id);
  assert.equal(el('feed-kind-model3d').attributes['aria-current'], 'true');
  await el('feed-sort-popular').handlers.click();
  assert.equal(visits.at(-1), '/discover?sort=popular&q=chair');
  assert.equal(requests.at(-1).get('sort'), 'popular');
  assert.equal(requests.at(-1).get('tab'), 'all');
  assert.equal(requests.at(-1).has('kind'), false);
  assert.equal(el('feed-kind-all').attributes['aria-current'], 'false');
  assert.equal(el('feed-sort-popular').attributes['aria-current'], 'true');
  await el('feed-kind-all').handlers.click();
  assert.equal(visits.at(-1), '/discover?q=chair');
  assert.equal(requests.at(-1).has('sort'), false);
  assert.equal(el('feed-kind-all').attributes['aria-current'], 'true');
  location.search = '?sort=popular&q=chair';
  await handlers.popstate();
  assert.equal(el('feed-sort-popular').attributes['aria-current'], 'true');
  await el('feed-tab-following').handlers.click();
  assert.equal(el('feed-sort-popular').hidden, true);
  assert.equal(requests.at(-1).has('sort'), false);
  assert.equal(requests.at(-1).get('tab'), 'following');
});

test('a popularity cursor refreshes from the first page after expiring', async () => {
  const {mount} = await import('../openteamily/static/discover/app.mjs');
  const doc = fakeDocument(), paths = [];
  const fetcher = async path => {
    if (path === '/v1/auth/session') return {status: 401, json: async () => ({})};
    paths.push(path);
    if (path.includes('cursor=')) {
      return {status: 409, json: async () => ({error: {code: 'popularity_expired'}})};
    }
    const item = {slug: 'paper-chair', title: paths.length === 1 ? 'Original' : 'Refreshed', kind: 'model3d'};
    return {status: 200, json: async () => ({items: [item], cursor: paths.length === 1 ? 'hot-key' : null})};
  };
  await mount(doc, {fetcher, location: {search: '?sort=popular'}});
  doc.getElementById('feed-more').handlers.click();
  await flush();
  assert.deepEqual(paths, [
    '/v1/discover/works?limit=12&sort=popular',
    '/v1/discover/works?limit=12&cursor=hot-key&sort=popular',
    '/v1/discover/works?limit=12&sort=popular',
  ]);
  assert.match(JSON.stringify(doc.getElementById('feed-grid').children), /Refreshed/);
  assert.equal(doc.getElementById('feed-sort-popular').attributes['aria-current'], 'true');
  assert.equal(doc.getElementById('feed-error').hidden, true);
});


test('a shared feed URL opens the tab, kind and search it names', async () => {
  const {mount} = await import('../openteamily/static/discover/app.mjs');
  const doc = fakeDocument();
  const calls = [], visit = [];
  const fetcher = async (path) => {
    calls.push(path);
    if (path === '/v1/auth/session') return {status: 200, json: async () => ({user: {username: 'alice'}})};
    if (path.startsWith('/v1/discover/me/works?')) {
      return {status: 200, json: async () => ({items: [{slug: 'followed-work', title: 'Followed', author: 'bob'}], cursor: null})};
    }
    throw new Error('unexpected ' + path);
  };
  await mount(doc, {
    fetcher, location: {search: '?feed=following&kind=video&q=cat', pathname: '/discover'},
    history: {pushState(_state, _title, url) { visit.push(url); }},
    window: {addEventListener() {}},
  });
  assert.equal(doc.getElementById('feed-query').value, 'cat');
  assert.equal(doc.getElementById('feed-tab-following').attributes['aria-selected'], 'true');
  assert.equal(doc.getElementById('feed-tab-activity').attributes['aria-selected'], 'false');
  assert.equal(doc.getElementById('feed-kind-video').attributes['aria-current'], 'true');
  assert.equal(doc.getElementById('feed-kind-all').attributes['aria-current'], 'false');
  const loaded = calls.findLast(path => path.startsWith('/v1/discover/me/works?'));
  assert.match(loaded, /tab=following/);
  assert.match(loaded, /kind=video/);
  assert.match(loaded, /q=cat/);
  assert.equal(visit.length, 0, 'opening a link must not add a history entry');
});


test('choosing a category keeps the feed tab instead of resetting to 动态', async () => {
  const {mount} = await import('../openteamily/static/discover/app.mjs');
  const doc = fakeDocument();
  const calls = [];
  const fetcher = async (path) => {
    calls.push(path);
    if (path === '/v1/auth/session') return {status: 200, json: async () => ({user: {username: 'alice'}})};
    if (path.startsWith('/v1/discover/me/works?')) {
      return {status: 200, json: async () => ({items: [{slug: 'followed-work', title: 'Followed', author: 'bob'}], cursor: null})};
    }
    throw new Error('unexpected ' + path);
  };
  await mount(doc, {fetcher, location: {search: '', pathname: '/discover'},
    history: {pushState() {}}, window: {addEventListener() {}}});
  const el = id => doc.getElementById(id);
  await el('feed-tab-following').handlers.click();
  assert.match(calls.at(-1), /tab=following/);
  await el('feed-kind-image').handlers.click();
  assert.match(calls.at(-1), /tab=following/);
  assert.match(calls.at(-1), /kind=image/);
  assert.equal(el('feed-tab-following').attributes['aria-selected'], 'true');
  assert.equal(el('feed-tab-activity').attributes['aria-selected'], 'false');
  assert.equal(el('feed-kind-image').attributes['aria-current'], 'true');
  el('feed-query').value = 'cat';
  await el('feed-search').handlers.submit({preventDefault() {}});
  assert.match(calls.at(-1), /tab=following/);
  assert.match(calls.at(-1), /kind=image/);
  assert.match(calls.at(-1), /q=cat/);
});


test('feed tab and category changes push a shareable URL and back/forward restores them', async () => {
  const {mount} = await import('../openteamily/static/discover/app.mjs');
  const doc = fakeDocument();
  const visit = [];
  const handlers = {};
  const location = {search: '', pathname: '/discover'};
  const calls = [];
  const fetcher = async (path) => {
    calls.push(path);
    if (path === '/v1/auth/session') return {status: 200, json: async () => ({user: {username: 'alice'}})};
    if (path.startsWith('/v1/discover/me/works?')) return {status: 200, json: async () => ({items: [], cursor: null})};
    throw new Error('unexpected ' + path);
  };
  await mount(doc, {fetcher, location,
    history: {pushState(_state, _title, url) { visit.push(url); location.search = url.split('?')[1] ? '?' + url.split('?')[1] : ''; }},
    window: {addEventListener(type, handler) { handlers[type] = handler; }}});
  const el = id => doc.getElementById(id);
  assert.equal(visit.length, 0);
  await el('feed-tab-following').handlers.click();
  assert.equal(visit.at(-1), '/discover?feed=following');
  await el('feed-kind-image').handlers.click();
  assert.equal(visit.at(-1), '/discover?feed=following&kind=image');
  el('feed-query').value = 'cat';
  await el('feed-search').handlers.submit({preventDefault() {}});
  assert.equal(visit.at(-1), '/discover?feed=following&kind=image&q=cat');
  assert.equal(typeof handlers.popstate, 'function');

  location.search = '';
  await handlers.popstate();
  assert.equal(el('feed-tab-activity').attributes['aria-selected'], 'true');
  assert.equal(el('feed-kind-all').attributes['aria-current'], 'true');
  assert.equal(el('feed-query').value, '');
  assert.doesNotMatch(calls.at(-1), /tab=following/);
  assert.equal(visit.at(-1), '/discover?feed=following&kind=image&q=cat', 'back must not push a new entry');

  location.search = '?feed=following&kind=image&q=cat';
  await handlers.popstate();
  assert.equal(el('feed-tab-following').attributes['aria-selected'], 'true');
  assert.equal(el('feed-kind-image').attributes['aria-current'], 'true');
  assert.equal(el('feed-query').value, 'cat');
  assert.match(calls.at(-1), /tab=following/);
  assert.match(calls.at(-1), /kind=image/);
});


test('following nobody from a shared URL shows the following empty note, not a blank feed', async () => {
  const {mount} = await import('../openteamily/static/discover/app.mjs');
  const doc = fakeDocument();
  const calls = [];
  const fetcher = async (path) => {
    calls.push(path);
    if (path === '/v1/auth/session') return {status: 200, json: async () => ({user: {username: 'alice'}})};
    return {status: 200, json: async () => ({items: [], cursor: null})};
  };
  await mount(doc, {fetcher, location: {search: '?feed=following', pathname: '/discover'},
    history: {pushState() {}}, window: {addEventListener() {}}});
  const empty = doc.getElementById('feed-following-empty');
  assert.equal(empty.hidden, false);
  assert.equal(doc.getElementById('feed-tab-following').attributes['aria-selected'], 'true');
  assert.match(doc.getElementById('feed-note').textContent, /你关注的作者已公开/);
  assert.match(calls.at(-1), /tab=following/);
});


test('work covers use real same-origin published media, not invented screenshots', () => {
  const doc = fakeDocument();
  const image = renderFeedCard(doc, {slug: 'real-photo', title: '<safe>', kind: 'image'});
  const cover = image.children.find(node => node.className === 'work-cover');
  assert.equal(cover.tagName, 'img');
  assert.equal(cover.src, '/w/real-photo/file');
  assert.equal(cover.loading, 'lazy');
  assert.equal(cover.alt, '');
  const website = renderFeedCard(doc, {slug: 'real-site', title: 'Site', kind: 'website'});
  const fallback = website.children.find(node => node.className === 'work-cover');
  assert.equal(fallback.tagName, 'div');
  assert.equal(fallback.dataset.kind, 'website');
  assert.equal(fallback.dataset.pattern, coverPattern('Site'));
  assert.equal(fallback.textContent, '');
  assert.equal(fallback.src, undefined);
  const badge = website.children.find(node => node.className === 'kind');
  assert.equal(badge.textContent, '网页');
});

test('feed cover patterns are stable for a title and stay in 0-7', () => {
  assert.equal(coverPattern('Site'), coverPattern('Site'));
  assert.match(coverPattern('Site'), /^[0-7]$/);
  assert.notEqual(coverPattern('Site'), coverPattern('Other title completely different'));
});

import { thumbModel } from '../openteamily/static/shell/thumb.mjs';
import { feedPreviewPath, attachFeedThumb } from '../openteamily/static/discover/app.mjs';

test('thumbModel keeps only bounded text and validated shapes from the preview', () => {
  assert.equal(thumbModel(null), null);
  assert.equal(thumbModel({type: 'unknown'}), null);
  const doc = thumbModel({type: 'document', heading: '  标题  ', lines: ['a', '', 'b', 'c', 'd', 'e']});
  assert.deepEqual(doc, {type: 'document', heading: '标题', lines: ['a', 'b', 'c', 'd']});
  assert.equal(thumbModel({type: 'website', heading: '', lines: []}).empty, true);
  const slides = thumbModel({type: 'slides', title: '首页', bullets: ['1', '2', '3', '4'], count: 5});
  assert.equal(slides.bullets.length, 3);
  assert.equal(slides.count, 5);
});

test('feed covers load from the public work preview path, never for images or odd slugs', () => {
  assert.equal(feedPreviewPath({slug: 'public-note', kind: 'document'}), '/w/public-note/preview');
  assert.equal(feedPreviewPath({slug: 'photo-1', kind: 'image'}), '');
  assert.equal(feedPreviewPath({slug: '../x', kind: 'document'}), '');
  assert.equal(feedPreviewPath(null), '');
  assert.equal(attachFeedThumb({}, null, {type: 'document'}), false);
});


async function setupRemix({status = 201, workspaceStatus = 200, workspaces = [{id:'space-1',name:'我的工作区'}], signedIn = true} = {}) {
  const {mount} = await import('../openteamily/static/discover/app.mjs');
  const doc = fakeDocument();
  const calls = [];
  const response = (status, body) => ({status, json:async()=>body});
  const fetcher = async (path, options) => {
    calls.push([path, options.method, options]);
    if (path === '/v1/auth/session') return response(signedIn ? 200 : 401, {user:{username:'alice'}});
    if (path === '/v1/workspaces?limit=100') return response(workspaceStatus, {items:workspaces});
    if (path === '/v1/discover/agents/weekly-digest/remix' && options.method === 'GET') {
      return response(200, {template:{revision:'public-revision',name:'竞品周报助手',summary:'每周竞品摘要',instructions:'公开指令'}});
    }
    if (options.method === 'POST') return response(status, status === 201
      ? {agent:{id:'agent-1',workspace_id:'space-1',name:'竞品周报助手'}}
      : {error:{code:'name_conflict',message:'工作区已有同名智能体，请换个名称。'}});
    return response(200, {items:[{name:'竞品周报助手',slug:'weekly-digest',summary:'每周竞品摘要'}]});
  };
  const navigation = [];
  await mount(doc, {fetcher, location:{search:'?tab=agents',assign:url=>navigation.push(url)}});
  const el = id => doc.getElementById(id);
  const use = classHits(el('discover-list'), 'catalog-use')[0];
  return {calls, el, use, navigation};
}

test('copy previews the released instructions before creating a real agent', async () => {
  const {calls, el, use, navigation} = await setupRemix();
  await use.handlers.click();
  assert.equal(el('catalog-remix-prompt').textContent,'公开指令');
  assert.equal(calls.filter(([,method])=>method==='POST').length,0);
  el('catalog-remix-workspace').value='space-1';
  await el('catalog-remix-form').handlers.submit({preventDefault() {}});
  const [path,method,options]=calls.at(-1);
  assert.equal(path,'/v1/discover/agents/weekly-digest/remix');
  assert.equal(method,'POST');
  assert.deepEqual(JSON.parse(options.body),{revision:'public-revision',workspace_id:'space-1',name:'竞品周报助手'});
  assert.match(options.headers['Idempotency-Key'],/^[A-Za-z0-9_-]{16,64}$/);
  assert.deepEqual(navigation,['/chat#workspace=space-1&agent=agent-1']);
});

test('copy presents a duplicate name error in the preview dialog', async () => {
  const {el, use, navigation}=await setupRemix({status:409});
  await use.handlers.click();
  el('catalog-remix-workspace').value='space-1';
  await el('catalog-remix-form').handlers.submit({preventDefault() {}});
  assert.match(el('catalog-remix-status').textContent,/已有同名智能体/);
  assert.deepEqual(navigation,[]);
});

test('copy distinguishes a failed workspace read from an empty workspace list', async () => {
  for (const [status,text] of [[500,'无法读取工作区'],[200,'暂无可用工作区']]) {
    const {calls, el, use}=await setupRemix({workspaceStatus:status,workspaces:[]});
    await use.handlers.click();
    assert.ok(el('catalog-remix-status').textContent.includes(text));
    assert.equal(el('catalog-remix-submit').disabled,true);
    assert.equal(calls.some(([,method])=>method==='POST'),false);
  }
});

test('copy asks a signed-out visitor to sign in and sends no writes', async () => {
  const {el, calls, use}=await setupRemix({signedIn:false});
  const before = calls.length;
  await use.handlers.click();
  assert.match(el('status').textContent,/请登录/);
  assert.equal(calls.length,before);
});

test('the status line is a polite live region for the create receipt', () => {
  const html = readFileSync(new URL('../openteamily/static/discover/index.html', import.meta.url), 'utf8');
  assert.match(html, /<p id="status" role="status" aria-live="polite">/);
  assert.equal(html.includes('catalog-reuse-note'), false);
});

test('document thumbnails preserve only bounded semantic text blocks', () => {
  const model = thumbModel({type:'document',heading:'Title',lines:['one'],blocks:[
    {type:'heading',text:'Title'}, {type:'list',text:'item'}, {type:'code',text:'x = 1'},
    {type:'script',text:'not a supported shape'}, {type:'quote',text:'quote'},
  ]});
  assert.deepEqual(model.blocks.map(block=>block.type), ['heading','list','code','quote']);
  assert.equal(model.blocks[1].text,'item');
});

// A work detail retains the originating feed and links out to the public work.
function classHits(node, wanted, hits = []) {
  if (String(node.className || '').split(/\s+/).includes(wanted)) hits.push(node);
  for (const child of node.children || []) classHits(child, wanted, hits);
  return hits;
}

function feedDocument() {
  return fakeDocument();
}

function detailFixture(extra = {}) {
  return Object.assign({
    slug: 'ci-fixture-doc',
    title: '[CI FIXTURE] Document',
    kind: 'document',
    kind_label: '文档',
    author: 'alice',
    updated: 1800000000,
    path: '/w/ci-fixture-doc',
  }, extra);
}

function detailFetcher(item, previewResult) {
  const requests = [];
  const fetcher = async path => {
    requests.push(path);
    if (path === '/v1/auth/session') return {status: 401, json: async () => ({})};
    if (path.startsWith('/v1/discover/works')) {
      return {status: 200, json: async () => ({items: [item], cursor: null})};
    }
    if (path === '/w/' + item.slug) return {status: 200, json: async () => item};
    if (path === '/w/' + item.slug + '/preview') return previewResult(path);
    throw new Error('unexpected ' + path);
  };
  return {fetcher, requests};
}

test('the 3D detail exposes an explicit preview and direct download without prefetching the file', async () => {
  const {mount} = await import('../openteamily/static/discover/app.mjs');
  const doc = feedDocument();
  const {fetcher, requests} = detailFetcher(detailFixture({
    kind: 'model3d', kind_label: '', path: '/social/w/ci-fixture-doc',
  }), () => {
    assert.fail('a 3D cover does not need a text preview');
  });
  await mount(doc, {fetcher, location: {search: '?kind=model3d'}});
  const grid = doc.getElementById('feed-grid');
  assert.equal(grid.children[0].children[0].children[1].textContent, '3D 作品');
  const [detail] = classHits(grid, 'feed-detail-toggle');
  await detail.handlers.click();
  const surface = doc.getElementById('work-detail-preview');
  const [preview] = classHits(surface, 'feed-model3d-preview-toggle');
  const [download] = classHits(surface, 'feed-model3d-download');
  assert.equal(preview.textContent, '预览 3D 模型');
  assert.equal(preview.disabled, false);
  assert.equal(download.href, '/social/w/ci-fixture-doc/file');
  assert.equal(download.download, '');
  assert.equal(requests.some(path => path.endsWith('/preview') || path.endsWith('/file')), false);
  await doc.getElementById('work-detail-back').handlers.click();
  assert.equal(preview.disabled, true);
});

test('3D card URLs fall back to the matching same-origin work route', () => {
  const doc = feedDocument();
  const item = detailFixture({kind: 'model3d'});
  for (const path of ['//other.example/w/ci-fixture-doc', '/social/w/other-asset', '/w/ci-fixture-doc?next=outside']) {
    assert.equal(renderFeedCard(doc, {...item, path}).href, '/w/ci-fixture-doc');
  }
});

test('a work card opens a shareable detail and returns to the originating feed and focus', async () => {
  const app = await import('../openteamily/static/discover/app.mjs');
  const doc = feedDocument();
  const {fetcher, requests} = detailFetcher(detailFixture(), () => ({status: 200, json: async () => ({preview: {
    type: 'document', heading: '季报摘要', lines: ['第一行正文', '第二行正文', '第三行正文', '第四行不该出现'],
  }})}));
  const visits = [];
  const location = {search: '?q=季报', pathname: '/discover'};
  const history = {
    pushState(_state, _title, url) { visits.push(url); },
    replaceState(_state, _title, url) { visits.push(url); },
  };
  await app.mount(doc, {fetcher, location, history});

  const grid = doc.getElementById('feed-grid');
  const cell = grid.children[0];
  const toggles = classHits(cell, 'feed-detail-toggle');
  assert.equal(toggles.length, 1);
  const toggle = toggles[0];
  let focused = false;
  toggle.isConnected = true;
  toggle.focus = () => { focused = true; };
  assert.equal(toggle.textContent, app.FEED_DETAIL_MORE);
  assert.equal(toggle.attributes['aria-controls'], 'work-detail');
  assert.equal(doc.getElementById('work-detail').hidden, true);
  doc.getElementById('main').scrollTop = 184;

  await toggle.handlers.click();

  assert.deepEqual(visits, ['/discover?q=%E5%AD%A3%E6%8A%A5&work=ci-fixture-doc']);
  assert.equal(doc.getElementById('work-detail').hidden, false);
  assert.equal(doc.getElementById('feed-panel').hidden, true);
  assert.match(doc.getElementById('work-detail-meta').textContent, /文档 · alice · 2027/);
  assert.deepEqual(classHits(doc.getElementById('work-detail-preview'), 'feed-detail-lines')[0]
    .children.map(row => row.textContent), ['季报摘要', '第一行正文', '第二行正文', '第三行正文']);
  assert.equal(doc.getElementById('work-detail-open').href, '/w/ci-fixture-doc');
  assert.equal(doc.getElementById('work-detail-previous').disabled, true);

  await doc.getElementById('work-detail-back').handlers.click();
  assert.equal(visits[1], '/discover?q=%E5%AD%A3%E6%8A%A5');
  assert.equal(doc.getElementById('work-detail').hidden, true);
  assert.equal(doc.getElementById('feed-panel').hidden, false);
  assert.equal(doc.getElementById('main').scrollTop, 184);
  assert.equal(focused, true);
  assert.equal(grid.children[0], cell);
  assert.equal(requests.filter(path => path.startsWith('/v1/discover/works?')).length, 1);
});

test('work navigation keeps the signed-in feed context and sharing copies the canonical public URL', async () => {
  const {mount, workDetailFromSearch} = await import('../openteamily/static/discover/app.mjs');
  const doc = feedDocument();
  const first = detailFixture({slug: 'first-work'});
  const second = detailFixture({slug: 'second-work', title: '首篇之后', path: '/social/w/second-work'});
  const requests = [];
  const visits = [];
  const copies = [];
  const location = {
    search: '?feed=following&kind=slides&q=设计&work=first-work',
    origin: 'https://management.test',
  };
  const history = {replaceState(_state, _title, url) { visits.push(url); }};
  const window = {navigator: {clipboard: {writeText(value) { copies.push(value); }}}};
  const fetcher = async path => {
    requests.push(path);
    if (path === '/v1/auth/session') return commentResponse({user: {id: 'viewer', username: 'viewer'}});
    if (path.startsWith('/v1/discover/me/works?')) return commentResponse({items: [first]});
    if (path.startsWith('/v1/discover/works/first-work?')) return commentResponse({work: first, next: second});
    if (path.startsWith('/v1/discover/works/second-work?')) return commentResponse({work: second, previous: first});
    if (path.endsWith('/preview')) return commentResponse({preview: null});
    throw new Error('Unexpected ' + path);
  };
  await mount(doc, {fetcher, location, history, window});
  assert.equal(doc.getElementById('work-detail-next').disabled, false);
  assert.equal(doc.getElementById('work-detail-previous').disabled, true);
  await doc.getElementById('work-detail-next').handlers.click();
  const context = new URL(requests.find(path => path.startsWith('/v1/discover/works/second-work?')),
    'https://management.test').searchParams;
  assert.deepEqual(Object.fromEntries(context), {kind: 'slides', q: '设计', tab: 'following'});
  assert.equal(visits[0], '/discover?feed=following&kind=slides&q=%E8%AE%BE%E8%AE%A1&work=second-work');
  assert.equal(doc.getElementById('work-detail-title').textContent, '首篇之后');
  assert.equal(doc.getElementById('work-detail-open').href, '/social/w/second-work');
  assert.equal(doc.getElementById('work-detail-next').disabled, true);
  assert.equal(doc.getElementById('work-detail-previous').disabled, false);
  assert.equal(workDetailFromSearch('?work=../../secret&share=1'), null);
  assert.equal(workDetailFromSearch('?work=first-work&work=second-work'), null);
  doc.getElementById('work-detail-share').handlers.click();
  assert.equal(doc.getElementById('work-share-dialog').open, true);
  await doc.getElementById('work-share-copy').handlers.click();
  assert.deepEqual(copies, ['https://management.test/w/second-work']);
  assert.equal(doc.getElementById('work-share-status').textContent, '已复制链接。');
});

test('the native direct excerpt paints before auth and is retained through a mismatched viewer reply', async () => {
  const {mount} = await import('../openteamily/static/discover/app.mjs');
  const doc = feedDocument();
  doc.querySelector = selector => selector.includes('openteamily-served-by') ? {} : null;
  const session = Promise.withResolvers();
  const scoped = Promise.withResolvers();
  const work = detailFixture();
  const next = detailFixture({slug: 'next-work'});
  const publicPath = '/w/' + work.slug + '?view=preview';
  const privatePath = '/v1/discover/works/' + work.slug;
  const requests = [];
  const loaded = mount(doc, {location: {search: '?work=' + work.slug}, fetcher: async (path, options) => {
    requests.push(path);
    if (path === '/v1/auth/session') return session.promise;
    if (path === '/v1/discover/works?limit=12') return commentResponse({viewer_username: 'alice', items: []});
    if (path === publicPath) {
      assert.equal(options.headers.Accept, 'application/json');
      return commentResponse({...work, preview: '正文预览'});
    }
    if (path === privatePath) return requests.filter(url => url === privatePath).length < 2
      ? commentResponse({viewer_username: 'bobby', work: {...work, liked: true}, next}) : scoped.promise;
    throw new Error(path);
  }});
  const el = id => doc.getElementById('work-detail-' + id);
  await flush();
  assert.deepEqual(requests, ['/v1/auth/session', publicPath, '/v1/discover/works?limit=12']);
  const [preview] = classHits(el('preview'), 'feed-detail-lines');
  assert.equal(preview.children[0].textContent, '正文预览');
  assert.equal(el('title').textContent, work.title);
  assert.equal(el('open').href, '/w/' + work.slug);
  assert.equal(el('actions').hidden, false);
  for (const action of ['comments', 'like', 'collect', 'follow']) assert.equal(el(action).hidden, true);
  assert.equal(el('next').disabled, true);
  await el('comments').handlers.click();

  session.resolve(commentResponse({user: {id: 'owner', username: 'alice'}}));
  await flush();
  assert.equal(requests.filter(url => url === privatePath).length, 2);
  assert.equal(el('like').hidden, true);
  assert.equal(el('next').disabled, true);
  scoped.resolve(commentResponse({viewer_username: 'alice', work: {...work, liked: false}, next}));
  await loaded;
  assert.equal(classHits(el('preview'), 'feed-detail-lines')[0], preview);
  assert.equal(el('comments').hidden, false);
  assert.equal(el('like').hidden, false);
  assert.equal(el('like').attributes['aria-pressed'], 'false');
  assert.equal(el('next').disabled, false);
});

test('a failed public detail cannot block the native scoped work or its preview', async () => {
  const {mount} = await import('../openteamily/static/discover/app.mjs');
  const doc = feedDocument();
  doc.querySelector = selector => selector.includes('openteamily-served-by') ? {} : null;
  const work = detailFixture();
  const publicPath = '/w/' + work.slug;
  const requests = [];
  await mount(doc, {location: {search: '?work=' + work.slug}, fetcher: async path => {
    requests.push(path);
    if (path === '/v1/auth/session') return commentResponse({user: {id: 'owner', username: 'alice'}});
    if (path === publicPath + '?view=preview') return commentResponse({}, 503);
    if (path === publicPath + '/preview') return commentResponse({preview: 'Normal scoped preview'});
    if (path === '/v1/discover/works/' + work.slug) return commentResponse({viewer_username: 'alice', work});
    if (path === '/v1/discover/works?limit=12') return commentResponse({viewer_username: 'alice', items: []});
    throw new Error(path);
  }});
  const preview = doc.getElementById('work-detail-preview');
  assert.equal(classHits(preview, 'feed-detail-lines')[0].children[0].textContent, 'Normal scoped preview');
  assert.equal(doc.getElementById('work-detail-like').hidden, false);
  assert.equal(requests.filter(path => path === publicPath + '/preview').length, 1);
});

test('an authoritative withdrawal clears the optimistic public preview and actions', async () => {
  const {mount} = await import('../openteamily/static/discover/app.mjs');
  const doc = feedDocument();
  doc.querySelector = selector => selector.includes('openteamily-served-by') ? {} : null;
  const session = Promise.withResolvers();
  const work = detailFixture();
  const loaded = mount(doc, {location: {search: '?work=' + work.slug}, fetcher: async path => {
    if (path === '/v1/auth/session') return session.promise;
    if (path === '/w/' + work.slug + '?view=preview') return commentResponse({...work, preview: 'Was public'});
    if (path === '/v1/discover/works/' + work.slug) return commentResponse({}, 404);
    if (path === '/v1/discover/works?limit=12') return commentResponse({viewer_username: 'alice', items: []});
    throw new Error(path);
  }});
  const el = id => doc.getElementById('work-detail-' + id);
  await flush();
  assert.equal(el('actions').hidden, false);
  assert.equal(classHits(el('preview'), 'feed-detail-lines').length, 1);
  session.resolve(commentResponse({user: {id: 'owner', username: 'alice'}}));
  await loaded;

  assert.equal(classHits(el('preview'), 'feed-detail-lines').length, 0);
  assert.equal(el('actions').hidden, true);
  assert.equal(el('retry').hidden, true);
  assert.match(el('status').textContent, /下架或不可访问/);
});

test('an older detail response cannot overwrite a newer work', async () => {
  const {mount} = await import('../openteamily/static/discover/app.mjs');
  const doc = feedDocument();
  const first = detailFixture({slug: 'slow-work'});
  const second = detailFixture({slug: 'new-work', title: '当前作品'});
  let finish;
  const fetcher = async path => {
    if (path === '/v1/auth/session') return commentResponse({}, 401);
    if (path.startsWith('/v1/discover/works?')) return commentResponse({items: [first, second]});
    if (path === '/w/slow-work') return new Promise(resolve => { finish = resolve; });
    if (path === '/w/new-work') return commentResponse(second);
    if (path.endsWith('/preview')) return commentResponse({preview: null});
    throw new Error('Unexpected ' + path);
  };
  await mount(doc, {fetcher, location: {search: '', pathname: '/discover'}});
  const [slow, fast] = classHits(doc.getElementById('feed-grid'), 'feed-detail-toggle');
  const opening = slow.handlers.click();
  doc.getElementById('work-detail-back').handlers.click();
  await fast.handlers.click();
  finish(commentResponse(first));
  await opening;
  assert.equal(doc.getElementById('work-detail-title').textContent, '当前作品');
});

test('a detail whose preview cannot be read says so instead of faking an empty summary', async () => {
  const app = await import('../openteamily/static/discover/app.mjs');
  const doc = feedDocument();
  const {fetcher} = detailFetcher(detailFixture(), () => ({status: 500, json: async () => ({})}));
  await app.mount(doc, {fetcher, location: {search: '', pathname: '/discover'}});
  const cell = doc.getElementById('feed-grid').children[0];
  await classHits(cell, 'feed-detail-toggle')[0].handlers.click();
  assert.equal(doc.getElementById('work-detail-preview').textContent, app.FEED_DETAIL_UNREADABLE);
  assert.equal(doc.getElementById('work-detail-open').href, '/w/ci-fixture-doc');
});

test('an image work uses the public media file without reading a text preview', async () => {
  const app = await import('../openteamily/static/discover/app.mjs');
  const doc = feedDocument();
  const {fetcher, requests} = detailFetcher(detailFixture({kind: 'image', kind_label: '图片'}), () => {
    assert.fail('an image work must not request a text preview');
  });
  await app.mount(doc, {fetcher, location: {search: '', pathname: '/discover'}});
  const cell = doc.getElementById('feed-grid').children[0];
  await classHits(cell, 'feed-detail-toggle')[0].handlers.click();
  const [image] = classHits(doc.getElementById('work-detail-preview'), 'work-detail-image');
  assert.equal(image.src, '/w/ci-fixture-doc/file');
  assert.equal(requests.some(path => path.endsWith('/preview')), false);
});

test('a native plain-text snapshot appears verbatim and is bounded in the work detail', async () => {
  const {mount} = await import('../openteamily/static/discover/app.mjs');
  const doc = feedDocument();
  const preview = '<img src="not-public">\n可公开阅读的示例内容。\n' + '长'.repeat(500) + '\n第四行\n第五行';
  const {fetcher} = detailFetcher(detailFixture(), () => commentResponse({preview}));
  await mount(doc, {fetcher, location: {search: '', pathname: '/discover'}});
  await classHits(doc.getElementById('feed-grid'), 'feed-detail-toggle')[0].handlers.click();
  const [list] = classHits(doc.getElementById('work-detail-preview'), 'feed-detail-lines');
  assert.deepEqual(list.children.map(row => row.textContent),
    ['<img src="not-public">', '可公开阅读的示例内容。', '长'.repeat(90), '第四行']);
  assert.ok(list.children.every(row => row.childElementCount === 0));
});

test('a work with an empty preview says it has no content yet', async () => {
  const app = await import('../openteamily/static/discover/app.mjs');
  const doc = feedDocument();
  const {fetcher} = detailFetcher(detailFixture(), () => ({status: 200, json: async () => ({preview: {
    type: 'document', heading: '', lines: [],
  }})}));
  await app.mount(doc, {fetcher, location: {search: '', pathname: '/discover'}});
  const cell = doc.getElementById('feed-grid').children[0];
  await classHits(cell, 'feed-detail-toggle')[0].handlers.click();
  assert.equal(doc.getElementById('work-detail-preview').textContent, app.FEED_DETAIL_EMPTY);
});

const commentResponse = (body, status = 200) => ({status, json: async () => body});

test('guest comments are loaded on demand and render literal text with a safe sign-in link', async () => {
  const {mount} = await import('../openteamily/static/discover/app.mjs');
  const doc = feedDocument();
  const work = detailFixture({comment_count: 1});
  const requests = [];
  const fetcher = async (path, options) => {
    requests.push([path, options.method]);
    if (path === '/v1/auth/session') return commentResponse({}, 401);
    if (path === '/v1/discover/works?limit=12') return commentResponse({items: [work]});
    if (path === '/w/ci-fixture-doc/comments?limit=12') return commentResponse({items: [{
      id: 'fixture-comment', body: '<script>公开文本</script>', author: {name: 'Alice'},
      created_at: 1_800_000_000_000,
    }], comment_count: 1});
    throw new Error('Unexpected ' + path);
  };
  await mount(doc, {fetcher, location: {search: ''}});
  assert.equal(requests.some(([path]) => path.includes('/comments')), false);
  const [toggle] = classHits(doc.getElementById('feed-grid'), 'feed-comments-toggle');
  assert.equal(toggle.textContent, '评论 · 1');
  await toggle.handlers.click();
  const [row] = classHits(doc.getElementById('feed-comments-list'), 'feed-comment-body');
  assert.equal(row.textContent, '<script>公开文本</script>');
  assert.equal(doc.getElementById('feed-comments-form').hidden, true);
  assert.equal(doc.getElementById('feed-comments-login').href, '/login#work-comments=ci-fixture-doc');
  assert.equal(requests.every(([, method]) => method === 'GET'), true);
});

test('posting a comment clears the editor and exposes pending text before the reply, then retries with the same key', async () => {
  const {mount} = await import('../openteamily/static/discover/app.mjs');
  const doc = feedDocument();
  const work = detailFixture({comment_count: 0});
  const writes = [];
  let finishFirst;
  const fetcher = (path, options) => {
    if (path === '/v1/auth/session') return Promise.resolve(commentResponse({user: {id: 'a', username: 'alice'}}));
    if (path.startsWith('/v1/discover/me/works?')) return Promise.resolve(commentResponse({items: [work]}));
    if (path.endsWith('/comments?limit=12')) return Promise.resolve(commentResponse({items: [], comment_count: 0}));
    if (path === '/v1/discover/works/ci-fixture-doc/comments' && options.method === 'POST') {
      writes.push({key: options.headers['Idempotency-Key'], body: JSON.parse(options.body)});
      if (writes.length === 1) return new Promise(resolve => { finishFirst = resolve; });
      return Promise.resolve(commentResponse({comment: {
        id: 'posted', body: '第一行\n第二行', author: {name: 'Alice'}, parent_id: null,
      }, comment_count: 1}));
    }
    throw new Error('Unexpected ' + path);
  };
  await mount(doc, {fetcher, location: {search: ''}});
  const [toggle] = classHits(doc.getElementById('feed-grid'), 'feed-comments-toggle');
  await toggle.handlers.click();
  const form = doc.getElementById('feed-comments-form');
  const input = doc.getElementById('feed-comments-input');
  const list = doc.getElementById('feed-comments-list');
  input.value = '第一行\n第二行';
  input.handlers.input();
  const posting = form.handlers.submit({preventDefault() {}});
  assert.equal(input.value, '');
  assert.equal(doc.getElementById('feed-comments-submit').disabled, true);
  assert.equal(classHits(list, 'is-pending').length, 1);
  assert.equal(classHits(list, 'feed-comment-body')[0].textContent, '第一行\n第二行');
  finishFirst(commentResponse({}, 503));
  await posting;
  assert.equal(input.value, '第一行\n第二行');
  assert.match(doc.getElementById('feed-comments-status').textContent, /草稿已保留/);
  assert.equal(classHits(list, 'is-pending').length, 0);

  await form.handlers.submit({preventDefault() {}});
  assert.equal(writes.length, 2);
  assert.match(writes[0].key, /^comment-/);
  assert.deepEqual(writes[1], writes[0]);
  assert.equal(input.value, '');
  assert.equal(classHits(list, 'feed-comment-body').length, 1);
  assert.equal(toggle.textContent, '评论 · 1');
});

test('comment permalinks open a published work missing from the feed without waiting for the feed', async () => {
  const {mount, workDetailFromSearch} = await import('../openteamily/static/discover/app.mjs');
  assert.equal(workDetailFromSearch('?work=../private&comments=1'), null);
  const doc = feedDocument();
  const requests = [];
  let finishFeed;
  const fetcher = (path) => {
    requests.push(path);
    if (path === '/v1/auth/session') return Promise.resolve(commentResponse({user: {id: 'a', username: 'alice'}}));
    if (path.startsWith('/v1/discover/me/works?')) return new Promise(resolve => { finishFeed = resolve; });
    if (path === '/v1/discover/works/older-work') return Promise.resolve(commentResponse({
      work: detailFixture({slug: 'older-work', title: '早期作品', comment_count: 0}),
    }));
    if (path === '/v1/discover/works/older-work/comments?limit=12') {
      return Promise.resolve(commentResponse({items: [], comment_count: 0}));
    }
    throw new Error('Unexpected ' + path);
  };
  const mounted = mount(doc, {fetcher, location: {search: '?work=older-work&comments=1'}});
  await flush();
  assert.equal(doc.getElementById('feed-comments-dialog').open, true);
  assert.equal(doc.getElementById('feed-comments-work').textContent, '早期作品');
  assert.equal(doc.getElementById('feed-comments-empty').hidden, false);
  assert.ok(requests.includes('/v1/discover/works/older-work/comments?limit=12'));
  finishFeed(commentResponse({items: []}));
  await mounted;
  assert.equal(doc.getElementById('feed-comments-dialog').open, true);
});

test('published interactive websites load a same-origin isolated frame only inside the work detail', async () => {
  const {mount} = await import('../openteamily/static/discover/app.mjs');
  const doc = feedDocument();
  const item = detailFixture({
    kind: 'website', title: '互动作品', site_available: true, path: '/social/w/ci-fixture-doc',
  });
  const {fetcher} = detailFetcher(item, () => commentResponse({preview: '公开简介'}));
  await mount(doc, {fetcher, location: {search: '', pathname: '/discover'}});
  const grid = doc.getElementById('feed-grid');
  const reader = doc.getElementById('work-detail-preview');
  assert.equal(classHits(grid, 'work-detail-site').length, 0);
  assert.equal(reader.children.length, 0);
  await classHits(grid, 'feed-detail-toggle')[0].handlers.click();
  const [frame] = classHits(reader, 'work-detail-site');
  assert.equal(frame.src, '/w/ci-fixture-doc/site');
  assert.equal(frame.attributes.sandbox, 'allow-scripts');
  assert.equal(frame.attributes.referrerpolicy, 'no-referrer');
  assert.match(frame.title, /互动作品/);
  doc.getElementById('work-detail-back').handlers.click();
  assert.equal(classHits(reader, 'work-detail-site').length, 0);
});
