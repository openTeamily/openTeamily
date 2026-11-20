import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { validSlug, catalogInitial, catalogItems, agentDiscoverPairs, isAgentsCatalog, isTeamsCatalog, renderTeamCard, FEED_CATEGORIES, CATALOG_CATEGORIES, TEAM_CATEGORIES, FEED_ACTIVITY_EMPTY_NOTE, FEED_ACTIVITY_LISTED_NOTE, FEED_FOLLOWING_EMPTY_TITLE, FEED_FOLLOWING_EMPTY_BODY, FEED_FOLLOWING_NOTE, FEED_SEARCH_EMPTY_NOTE, feedQuery, formatFeedTime, renderFeedCard, coverPattern, TEAMS_NOTE, TEAMS_SEARCH_NOTE, TEAMS_SEARCH_PLACEHOLDER, TEAMS_SIGNED_OUT_NOTE } from '../openteamily/static/discover/app.mjs';


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

test('recorded feed categories stay in the captured order', () => {
  assert.deepEqual(FEED_CATEGORIES, [
    '热门', '网页', '小游戏', '图片', '音乐', '幻灯片', '视频', '3D 作品',
    '短剧', '文章', '教程', '看板', '行情', '小程序', '故事', '娱乐', 'AI 与科技', '美容',
  ]);
});

test('feed all-filter shows the recorded 全部 label and keeps an empty canvas', () => {
  const html = readFileSync(new URL('../openteamily/static/discover/index.html', import.meta.url), 'utf8');
  const block = html.split('class="feed-filters"')[1].split('id="feed-following-empty"')[0];
  assert.match(block, /class="feed-filter-all"[^>]*aria-current="true"[^>]*>全部</);
  assert.equal(/class="feed-filter-all"[^>]*><\/button>/.test(block), false);
  assert.equal(/aria-label="全部"/.test(block), false);
  assert.equal(/没有单独标出文字|圆形按钮/.test(block), false);
  const order = ['全部', ...FEED_CATEGORIES];
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
    'Legal', 'Life', 'Marketing',
  ]);
});

test('catalog filter chrome is present, disabled, and does not copy Teamily branding', () => {
  const html = readFileSync(new URL('../openteamily/static/discover/index.html', import.meta.url), 'utf8');
  const block = html.split('id="catalog-filters"')[1].split('id="teams-filters"')[0];
  assert.match(block, /aria-current="true"[^>]*>全部</);
  for (const label of CATALOG_CATEGORIES) {
    const encoded = label.replaceAll('&', '&amp;');
    assert.match(block, new RegExp(`disabled title="未接通：公共目录没有分类字段。">${encoded}<`));
  }
  const order = ['全部', ...CATALOG_CATEGORIES.map((label) => label.replaceAll('&', '&amp;'))];
  const positions = order.map((label) => block.indexOf(`>${label}<`));
  assert.equal(positions.every((index) => index !== -1), true);
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.match(block, /id="catalog-filter-search"[^>]*disabled[^>]*aria-label="搜索分类"/);
  assert.match(block, /id="catalog-filter-more"[^>]*disabled[^>]*aria-label="更多分类"/);
  assert.match(block, /对照里可以看到搜索分类控件，但没有打开面板，所以这里不发明搜索弹层。/);
  assert.match(block, /对照里未展开其余分类，所以这里不发明更多分类。/);
  const creator = html.match(/id="catalog-creator"[\s\S]*?<\/button>/)[0];
  assert.match(creator, /disabled/);
  assert.match(creator, /创建者/);
  assert.equal(/teamily|积分|credits/i.test(creator), false);
  assert.match(html, /id="catalog-filter-note" class="visually-hidden"/);
  assert.match(html, /分类和创建者筛选未接通：公共目录没有对应字段。/);
  const scroll = block.split('class="catalog-filter-scroll"')[1].split('</div>')[0];
  assert.match(scroll, />Marketing</);
  assert.equal(/id="catalog-filter-search"/.test(scroll), false);
  assert.equal(/id="catalog-filter-more"/.test(scroll), false);
  assert.match(block, /<\/div>\s*<button type="button" id="catalog-filter-search"/);
});


test('recorded team categories stay in the captured order', () => {
  assert.deepEqual(TEAM_CATEGORIES, [
    'Marketing', 'Engineering', 'IT & Security', 'Content Creation',
    'Operations', 'Product', 'Data Analysis', 'Design', 'Research',
    'Investment', 'Education', 'Life', 'Sales',
  ]);
});

test('teams filter chrome is present, disabled, and does not copy Teamily branding', () => {
  const html = readFileSync(new URL('../openteamily/static/discover/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="catalog-tab-teams" href="\/discover\?tab=agents&amp;section=groups">AI 团队</);
  assert.match(html, /id="catalog-create-team"[^>]*disabled[^>]*>\+ 创建我的 AI 团队</);
  assert.equal(/AI 团队（未接通）/.test(html), false);
  const block = html.split('id="teams-filters"')[1].split('id="catalog-creator"')[0];
  assert.match(block, /aria-current="true"[^>]*>All</);
  for (const label of TEAM_CATEGORIES) {
    const encoded = label.replaceAll('&', '&amp;');
    assert.match(block, new RegExp(`disabled title="公共团队目录没有分类字段。">${encoded}<`));
  }
  const order = ['All', ...TEAM_CATEGORIES.map((label) => label.replaceAll('&', '&amp;'))];
  const positions = order.map((label) => block.indexOf(`>${label}<`));
  assert.equal(positions.every((index) => index !== -1), true);
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.match(block, /id="teams-filter-more"[^>]*disabled[^>]*aria-label="更多分类"/);
  const teamScroll = block.split('class="catalog-filter-scroll"')[1].split('</div>')[0];
  assert.match(teamScroll, />Sales</);
  assert.equal(/id="teams-filter-more"/.test(teamScroll), false);
  assert.match(block, /<\/div>\s*<button type="button" id="teams-filter-more"/);
  assert.equal(/id="teams-filter-search"/.test(block), false);
  assert.equal(/Teamily AI|Full-Stack Delivery Guild|积分|credits/i.test(html), false);
  assert.match(html, /id="teams-filter-note" class="visually-hidden"/);
  assert.equal(/也不会复制对照里的团队名称或创建者品牌/.test(html), false);
  assert.equal(TEAMS_SEARCH_PLACEHOLDER, '搜索 AI 团队......');
});

test('renderTeamCard lays out recorded fields and keeps create unconnected', () => {
  const doc = fakeDocument();
  const card = renderTeamCard(doc, {
    category: 'engineering',
    name: 'Fixture Delivery Room',
    summary: 'An OpenTeamily fixture card, not a copied template.',
    tags: ['fixture', 'delivery'],
    members: ['alpha', 'beta'],
    extra: '+1',
  });
  assert.equal(card.children[0].textContent, 'engineering');
  assert.equal(card.children[1].textContent, 'Fixture Delivery Room');
  assert.equal(card.children[2].textContent, 'An OpenTeamily fixture card, not a copied template.');
  assert.equal(card.children[3].children[0].textContent, 'fixture');
  assert.equal(card.children[4].children[0].children[0].textContent, 'A');
  assert.equal(card.children[4].children[1].textContent, '+1');
  const create = card.children[4].children[2];
  assert.equal(create.disabled, true);
  assert.equal(create.textContent, '创建');
  assert.match(create.title, /未接通/);
});

test('renderTeamCard initials skip leading punctuation', () => {
  const doc = fakeDocument();
  const card = renderTeamCard(doc, {
    name: 'Fixture Delivery Room',
    members: ['[CI] alpha', 'beta'],
  });
  assert.equal(card.children[4].children[0].children[0].textContent, 'C');
  assert.equal(card.children[4].children[0].children[1].textContent, 'B');
});

test('catalog filter rows do not wrap chips onto a second line', () => {
  const css = readFileSync(new URL('../openteamily/static/discover/app.css', import.meta.url), 'utf8');
  const block = css.split('.catalog-filters {')[1].split('.catalog-creator-row')[0];
  assert.match(block, /flex-wrap:\s*nowrap/);
  assert.match(block, /\.catalog-filter-scroll[^}]*overflow-x:\s*auto/s);
  assert.match(block, /\.catalog-filter-search, \.catalog-filter-more[^}]*flex:\s*0 0 auto/s);
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
  append(...nodes) { this.children.push(...nodes); }
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
  };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

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
  assert.equal(card.children[1].children[1].textContent, '<script>not HTML</script>');
  assert.equal(card.children[2].disabled, true);
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

test('catalog cards do not promise a /d/ detail route the server does not serve', async () => {
  const {mount} = await import('../openteamily/static/discover/app.mjs');
  const doc = fakeDocument();
  const fetcher = async path => {
    if (path === '/v1/auth/session') return {status: 401, json: async () => ({})};
    return {status: 200, json: async () => ({items: [{name: 'Fixture', slug: 'fixture-one', summary: '简介'}], cursor: null})};
  };
  await mount(doc, {fetcher, location: {search: '?tab=agents'}});
  const card = doc.getElementById('discover-list').children[0].children[0];
  const title = card.title || '';
  assert.equal(title.includes('/d/'), false, 'hover text must not name /d/<slug>: no public detail route exists');
  assert.equal(title.includes('fixture-one'), false);
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

test('teams catalog shows recorded chrome and does not load the agent catalog API', async () => {
  const {mount} = await import('../openteamily/static/discover/app.mjs');
  const doc = fakeDocument();
  const requests = [];
  const fetcher = async (path, options) => {
    requests.push([path, options.method]);
    if (path === '/v1/auth/session') return {status: 401, json: async () => ({})};
    throw new Error('unexpected ' + path);
  };
  await mount(doc, {fetcher, location: {search: '?tab=agents&section=groups'}});
  const el = id => doc.getElementById(id);
  assert.equal(el('main-panel').hidden, false);
  assert.equal(el('catalog-view').hidden, false);
  assert.equal(el('feed-panel').hidden, true);
  assert.equal(el('catalog-filters').hidden, true);
  assert.equal(el('teams-filters').hidden, false);
  assert.equal(el('catalog-create-agent').hidden, true);
  assert.equal(el('catalog-create-team').hidden, false);
  assert.equal(el('catalog-query').placeholder, TEAMS_SEARCH_PLACEHOLDER);
  assert.equal(el('catalog-tab-teams').attributes['aria-current'], 'page');
  assert.equal(el('catalog-tab-agents').attributes['aria-current'], undefined);
  assert.equal(el('teams-note').hidden, false);
  assert.equal(el('teams-note').textContent, TEAMS_SIGNED_OUT_NOTE);
  assert.equal(el('catalog-manage').hidden, true);
  assert.equal(el('discover-list').children.length, 0);
  assert.equal(requests.some(([path]) => path.startsWith('/v1/discover/agents')), false);
  el('catalog-query').value = 'anything';
  el('catalog-search').handlers.submit({preventDefault() {}});
  await flush();
  assert.equal(el('teams-note').textContent, TEAMS_SIGNED_OUT_NOTE);
  assert.equal(requests.some(([path]) => path.startsWith('/v1/team-directory')), false,
    'a signed-out visitor is told to sign in instead of calling the directory route');
  el('catalog-clear').handlers.click();
  await flush();
  assert.equal(el('catalog-query').value, '');
  assert.equal(requests.every(([, method]) => method === 'GET'), true);
});

test('feedQuery encodes a keyword and a recency cursor', () => {
  assert.equal(feedQuery('', ''), 'limit=12');
  assert.equal(feedQuery('外观', '100.ci-doc'), 'limit=12&q=%E5%A4%96%E8%A7%82&cursor=100.ci-doc');
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
  assert.equal(card.href, '/w/ci-fixture-doc');
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

test('supported work categories are enabled, unsupported classifications stay disabled', () => {
  const html = readFileSync(new URL('../openteamily/static/discover/index.html', import.meta.url), 'utf8');
  for (const kind of ['website', 'image', 'audio', 'slides', 'video']) {
    const tag = html.match(new RegExp('<button[^>]*id="feed-kind-' + kind + '"[^>]*>'))[0];
    assert.equal(tag.includes('disabled'), false);
  }
  assert.match(html, /disabled[^>]*>小游戏</);
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
  assert.match(grid.children[0].children[1].children[0].textContent, /取消点赞.*1/);
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
    {tab: 'following', kind: 'video', query: 'cat'});
  assert.deepEqual(feedStateFromSearch('?feed=collected&q=%E4%B8%AD%E6%96%87'),
    {tab: 'collected', kind: '', query: '中文'});
  assert.deepEqual(feedStateFromSearch('?tab=agents'),
    {tab: 'activity', kind: '', query: ''});
  assert.deepEqual(feedStateFromSearch('?feed=following&kind=bogus'),
    {tab: 'following', kind: '', query: ''});
  assert.deepEqual(feedStateFromSearch('?feed=activity'), {tab: 'activity', kind: '', query: ''});
  assert.deepEqual(feedStateFromSearch(''), {tab: 'activity', kind: '', query: ''});
  assert.deepEqual(feedStateFromSearch(undefined), {tab: 'activity', kind: '', query: ''});
  assert.equal(feedSearchText({tab: 'following', kind: 'video', query: 'cat'}),
    '?feed=following&kind=video&q=cat');
  assert.equal(feedSearchText({tab: 'collected', kind: '', query: ''}), '?feed=collected');
  assert.equal(feedSearchText({tab: 'activity', kind: '', query: ''}), '');
  assert.equal(feedSearchText({tab: 'following', kind: 'bogus', query: ''}), '?feed=following');
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
  assert.match(doc.getElementById('feed-note').textContent, /只展示你关注的作者/);
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


test('用这个智能体 creates a real workspace agent through the existing endpoint and opens /agents', async () => {
  const {mount} = await import('../openteamily/static/discover/app.mjs');
  const doc = fakeDocument();
  const calls = [];
  const fetcher = async (path, options) => {
    calls.push([path, options.method, options]);
    if (path === '/v1/auth/session') return {status: 200, json: async () => ({user: {username: 'alice'}})};
    if (path === '/v1/workspaces?limit=100') return {status: 200, json: async () => ({items: [{id: 'space-1', name: '我的工作区'}], cursor: null})};
    if (path.startsWith('/v1/workspaces/space-1/agents?limit=')) return {status: 200, json: async () => ({items: [], cursor: null})};
    if (path === '/v1/workspaces/space-1/agents') return {status: 201, json: async () => ({agent: {id: 'agent-1', name: '竞品周报助手'}})};
    return {status: 200, json: async () => ({items: [
      {name: '竞品周报助手', slug: 'weekly-digest', summary: '每周竞品摘要'},
    ], cursor: null})};
  };
  let arrived = '';
  await mount(doc, {fetcher, location: {search: '?tab=agents', assign: (url) => { arrived = url; }}});
  const el = id => doc.getElementById(id);
  el('workspace').value = 'space-1';
  const card = el('discover-list').children[0].children[0];
  const use = card.children.find(node => node.className === 'catalog-use');
  assert.ok(use, 'every public catalog card must offer a 用这个智能体 action');
  assert.equal(use.textContent, '用这个智能体');
  const before = calls.length;
  await use.handlers.click();
  const posted = calls.slice(before);
  assert.equal(posted.length, 1, 'the action must send exactly one request');
  const [path, method, options] = posted[0];
  assert.equal(path, '/v1/workspaces/space-1/agents');
  assert.equal(method, 'POST');
  assert.deepEqual(JSON.parse(options.body), {
    name: '竞品周报助手', summary: '每周竞品摘要', instructions: '',
  });
  assert.match(options.headers['Idempotency-Key'], /^[A-Za-z0-9_-]{16,64}$/);
  assert.equal(el('status').textContent, '已创建「竞品周报助手」，正在打开智能体页。');
  assert.equal(arrived, '/agents');
});

test('用这个智能体 reports a same-name conflict instead of pretending the copy landed', async () => {
  const {mount} = await import('../openteamily/static/discover/app.mjs');
  const doc = fakeDocument();
  const fetcher = async (path, options) => {
    if (path === '/v1/auth/session') return {status: 200, json: async () => ({user: {username: 'alice'}})};
    if (path === '/v1/workspaces?limit=100') return {status: 200, json: async () => ({items: [{id: 'space-1', name: '我的工作区'}], cursor: null})};
    if (path.startsWith('/v1/workspaces/space-1/agents?limit=')) return {status: 200, json: async () => ({items: [], cursor: null})};
    if (options.method === 'POST') return {status: 409, json: async () => ({error: {message: 'An agent with that name already exists'}})};
    return {status: 200, json: async () => ({items: [{name: '竞品周报助手', slug: 'weekly-digest', summary: '每周竞品摘要'}], cursor: null})};
  };
  let arrived = '';
  await mount(doc, {fetcher, location: {search: '?tab=agents', assign: (url) => { arrived = url; }}});
  const el = id => doc.getElementById(id);
  el('workspace').value = 'space-1';
  const use = el('discover-list').children[0].children[0].children.find(node => node.className === 'catalog-use');
  await use.handlers.click();
  assert.equal(el('status').dataset.kind, 'error');
  assert.match(el('status').textContent, /已有同名智能体/);
  assert.equal(arrived, '', 'a refused create must not navigate away as if it worked');
});

test('a failed workspace list read says the read failed and does not send the user to create a workspace', async () => {
  const {mount} = await import('../openteamily/static/discover/app.mjs');
  const doc = fakeDocument();
  const calls = [];
  const fetcher = async (path, options) => {
    calls.push([path, options.method]);
    if (path === '/v1/auth/session') return {status: 200, json: async () => ({user: {username: 'alice'}})};
    if (path === '/v1/workspaces?limit=100') return {status: 500, json: async () => ({error: {message: 'boom'}})};
    return {status: 200, json: async () => ({items: [{name: '竞品周报助手', slug: 'weekly-digest', summary: '每周竞品摘要'}], cursor: null})};
  };
  await mount(doc, {fetcher, location: {search: '?tab=agents', assign: () => {}}});
  const el = id => doc.getElementById(id);
  const use = el('discover-list').children[0].children[0].children.find(node => node.className === 'catalog-use');
  const before = calls.length;
  await use.handlers.click();
  assert.equal(el('status').dataset.kind, 'error');
  assert.match(el('status').textContent, /工作区列表读取失败/);
  assert.doesNotMatch(el('status').textContent, /先创建一个工作区/,
    'a 500 on the workspace list is not the same state as having no workspace');
  assert.equal(calls.length, before, 'a failed workspace read must not POST an agent');
});

test('with no workspace at all the page still asks for one, because that state is real', async () => {
  const {mount} = await import('../openteamily/static/discover/app.mjs');
  const doc = fakeDocument();
  const fetcher = async (path) => {
    if (path === '/v1/auth/session') return {status: 200, json: async () => ({user: {username: 'alice'}})};
    if (path === '/v1/workspaces?limit=100') return {status: 200, json: async () => ({items: [], cursor: null})};
    return {status: 200, json: async () => ({items: [{name: '竞品周报助手', slug: 'weekly-digest', summary: '每周竞品摘要'}], cursor: null})};
  };
  await mount(doc, {fetcher, location: {search: '?tab=agents', assign: () => {}}});
  const el = id => doc.getElementById(id);
  const use = el('discover-list').children[0].children[0].children.find(node => node.className === 'catalog-use');
  await use.handlers.click();
  assert.equal(el('status').dataset.kind, 'error');
  assert.match(el('status').textContent, /先创建一个工作区/);
});

test('用这个智能体 asks a signed-out visitor to sign in and sends nothing', async () => {
  const {mount} = await import('../openteamily/static/discover/app.mjs');
  const doc = fakeDocument();
  const calls = [];
  const fetcher = async (path, options) => {
    calls.push([path, options.method]);
    if (path === '/v1/auth/session') return {status: 401, json: async () => ({})};
    return {status: 200, json: async () => ({items: [{name: '竞品周报助手', slug: 'weekly-digest', summary: '每周竞品摘要'}], cursor: null})};
  };
  await mount(doc, {fetcher, location: {search: '?tab=agents', assign: () => {}}});
  const el = id => doc.getElementById(id);
  const use = el('discover-list').children[0].children[0].children.find(node => node.className === 'catalog-use');
  const before = calls.length;
  await use.handlers.click();
  assert.match(el('status').textContent, /请先登录/);
  assert.equal(calls.length, before, 'a signed-out click must not POST');
  assert.equal(calls.some(([, method]) => method === 'POST'), false);
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

// A work card's detail is read in place: the feed keeps its tab, filter and
// scroll position, and the work page stays one click away.
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
    if (path === '/w/' + item.slug + '/preview') return previewResult(path);
    throw new Error('unexpected ' + path);
  };
  return {fetcher, requests};
}

test('a work card opens a read-only detail in place without leaving the feed', async () => {
  const app = await import('../openteamily/static/discover/app.mjs');
  const doc = feedDocument();
  const {fetcher, requests} = detailFetcher(detailFixture(), () => ({status: 200, json: async () => ({preview: {
    type: 'document', heading: '季报摘要', lines: ['第一行正文', '第二行正文', '第三行正文', '第四行不该出现'],
  }})}));
  const visited = [];
  const location = {search: '', pathname: '/discover', assign: url => visited.push(url)};
  await app.mount(doc, {fetcher, location});

  const cell = doc.getElementById('feed-grid').children[0];
  const toggles = classHits(cell, 'feed-detail-toggle');
  assert.equal(toggles.length, 1, 'a feed card offers exactly one detail toggle');
  const toggle = toggles[0];
  assert.equal(toggle.tagName, 'button');
  assert.equal(toggle.textContent, app.FEED_DETAIL_MORE);
  assert.equal(toggle.attributes['aria-expanded'], 'false');
  const panel = classHits(cell, 'feed-detail')[0];
  assert.ok(panel, 'the detail region exists before it is opened');
  assert.equal(panel.hidden, true);
  assert.equal(toggle.attributes['aria-controls'], panel.id);
  const listCallsBefore = requests.filter(path => path.startsWith('/v1/discover/works')).length;

  await toggle.handlers.click();
  await flush();

  assert.equal(toggle.attributes['aria-expanded'], 'true');
  assert.equal(toggle.textContent, app.FEED_DETAIL_LESS);
  assert.equal(panel.hidden, false);
  const text = JSON.stringify(panel);
  assert.match(text, /文档/);
  assert.match(text, /alice/);
  assert.match(text, /2027/);
  assert.match(text, /季报摘要/);
  assert.match(text, /第三行正文/);
  assert.equal(text.includes('第四行不该出现'), false, 'the excerpt stays bounded');
  const open = classHits(panel, 'feed-detail-open')[0];
  assert.equal(open.href, '/w/ci-fixture-doc');
  assert.equal(open.textContent, app.FEED_DETAIL_OPEN);
  assert.deepEqual(visited, [], 'reading the detail never navigates');
  assert.equal(requests.filter(path => path.startsWith('/v1/discover/works')).length, listCallsBefore,
    'reading the detail never reloads the listing');

  await toggle.handlers.click();
  assert.equal(toggle.attributes['aria-expanded'], 'false');
  assert.equal(toggle.textContent, app.FEED_DETAIL_MORE);
  assert.equal(panel.hidden, true);
});

test('a detail whose preview cannot be read says so instead of faking an empty summary', async () => {
  const app = await import('../openteamily/static/discover/app.mjs');
  const doc = feedDocument();
  const {fetcher} = detailFetcher(detailFixture(), () => ({status: 500, json: async () => ({})}));
  await app.mount(doc, {fetcher, location: {search: '', pathname: '/discover'}});
  const cell = doc.getElementById('feed-grid').children[0];
  const toggle = classHits(cell, 'feed-detail-toggle')[0];
  await toggle.handlers.click();
  await flush();
  const panel = classHits(cell, 'feed-detail')[0];
  assert.match(JSON.stringify(panel), new RegExp(app.FEED_DETAIL_UNREADABLE));
  assert.equal(JSON.stringify(panel).includes(app.FEED_DETAIL_EMPTY), false);
  assert.equal(classHits(panel, 'feed-detail-open')[0].href, '/w/ci-fixture-doc');
});

test('an image work says it has no text summary instead of reading a preview it does not have', async () => {
  const app = await import('../openteamily/static/discover/app.mjs');
  const doc = feedDocument();
  const {fetcher, requests} = detailFetcher(detailFixture({kind: 'image', kind_label: '图片'}), () => {
    throw new Error('an image work must not request a text preview');
  });
  await app.mount(doc, {fetcher, location: {search: '', pathname: '/discover'}});
  const cell = doc.getElementById('feed-grid').children[0];
  const toggle = classHits(cell, 'feed-detail-toggle')[0];
  await toggle.handlers.click();
  await flush();
  const panel = classHits(cell, 'feed-detail')[0];
  assert.match(JSON.stringify(panel), new RegExp(app.FEED_DETAIL_NO_TEXT));
  assert.equal(requests.some(path => path.endsWith('/preview')), false);
  assert.equal(classHits(panel, 'feed-detail-open')[0].href, '/w/ci-fixture-doc');
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
  await flush();
  const panel = classHits(cell, 'feed-detail')[0];
  assert.match(JSON.stringify(panel), new RegExp(app.FEED_DETAIL_EMPTY));
  assert.equal(JSON.stringify(panel).includes(app.FEED_DETAIL_UNREADABLE), false);
});
