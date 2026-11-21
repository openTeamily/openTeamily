import { AGENT_CATEGORIES, categoryFromSearch, categoryLabel, csrfCookie } from '../agents/app.mjs';
import { renderThumb, thumbModel } from '../shell/thumb.mjs';

const SLUG = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

export function validSlug(value) {
  return typeof value === 'string' && SLUG.test(value);
}

export function catalogInitial(name) {
  const match = String(name || '').match(/\p{L}|\p{N}/u);
  return match ? match[0].toUpperCase() : '?';
}

// Two-letter monogram for directory cards ("Content Creator" -> "CC"),
// skipping a bracketed prefix such as "[CI FIXTURE]".
export function catalogMonogram(name) {
  const text = String(name || '').replace(/^\s*\[[^\]]*\]\s*/, '');
  const words = text.match(/[\p{L}\p{N}]+/gu) || [];
  if (!words.length) return catalogInitial(name);
  if (/^\p{Script=Han}/u.test(words[0])) return words[0].slice(0, 1);
  const letters = words.slice(0, 2).map((word) => word[0].toUpperCase()).join('');
  return letters || catalogInitial(name);
}

export function catalogTone(name) {
  let hash = 0;
  for (const ch of String(name || '')) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return String((hash % 6) + 1);
}

export function catalogItems(body) {
  return Array.isArray(body && body.items) ? body.items : [];
}

export function agentDiscoverPairs(agents, statuses) {
  return (agents || []).map((agent, index) => ({
    agent,
    discover: (statuses || [])[index] || {listed: false},
  }));
}

export function catalogQuery(text = '', cursor = '', category = 'all', creator = '') {
  const params = new URLSearchParams({limit: '12'});
  if (text.trim()) params.set('q', text.trim());
  if (cursor) params.set('cursor', cursor);
  if (category !== 'all') params.set('category', category);
  if (creator) params.set('creator', creator);
  return '/v1/discover/agents?' + params.toString();
}

export const FEED_CATEGORIES = ['网页', '图片', '音乐', '幻灯片', '视频'];

export const CATALOG_CATEGORIES = AGENT_CATEGORIES.map(({label}) => label);

const TEAM_DIRECTORY_LIMIT = 100;
const TEAM_DIRECTORY_ID = /^[A-Za-z0-9_-]{1,80}$/;
const TEAM_MEMBERSHIP = {member: '已加入', pending: '等待审批', suspended: '已暂停'};
const TEAM_SEARCH_LIMIT = 60;

export const FEED_ACTIVITY_EMPTY_NOTE = '暂时没有公开作品。';
export const FEED_ACTIVITY_LISTED_NOTE = '';
export const FEED_ACTIVITY_NOTE = FEED_ACTIVITY_EMPTY_NOTE;
export const FEED_FOLLOWING_EMPTY_TITLE = '关注列表暂无动态';
export const FEED_FOLLOWING_EMPTY_BODY = '你关注的人发布动态后会显示在这里。';
export const FEED_FOLLOWING_NOTE = '你关注的作者已公开的作品会显示在这里。';
export const FEED_SEARCH_EMPTY_NOTE = '没有匹配的公开作品。';

export const FEED_KINDS = ['', 'website', 'image', 'audio', 'slides', 'video'];

export const FEED_CREATOR_EMPTY_NOTE = '该作者还没有公开作品。';
export const FEED_CREATOR_VIEW_ALL = '查看全部作者';

// Same rule as App.credentials: usernames are lowercase, 3-64 characters.
const CREATOR_HANDLE = /^[a-z0-9][a-z0-9_.-]{2,63}$/;

export function creatorFromSearch(search) {
  const params = new URLSearchParams(typeof search === 'string' ? search : '');
  const handle = (params.get('creator') || '').trim().toLowerCase();
  return CREATOR_HANDLE.test(handle) ? handle : '';
}

export function creatorSearch(handle) {
  const value = String(handle || '').trim().toLowerCase();
  return CREATOR_HANDLE.test(value) ? '?creator=' + encodeURIComponent(value) : '';
}

export function creatorLink(handle) {
  return '/discover' + creatorSearch(handle);
}

export function feedQuery(query, cursor = '', kind = '', creator = '') {
  const params = new URLSearchParams({limit: '12'});
  if (query) params.set('q', query);
  if (cursor) params.set('cursor', cursor);
  if (kind) params.set('kind', kind);
  if (creator) params.set('creator', creator);
  return params.toString();
}

// The feed tab, category and search live in the URL so a filtered feed can be
// shared and survives a refresh. `?tab=agents` stays the catalog switch, and the
// default 动态 feed keeps an empty query string.
export function feedStateFromSearch(search) {
  const params = new URLSearchParams(typeof search === 'string' ? search : '');
  const feed = params.get('feed');
  const kind = params.get('kind') || '';
  return {
    tab: feed === 'following' || feed === 'collected' ? feed : 'activity',
    kind: FEED_KINDS.includes(kind) ? kind : '',
    query: (params.get('q') || '').slice(0, 80),
    creator: creatorFromSearch(search),
  };
}

export function feedSearchText(state) {
  const params = new URLSearchParams();
  const tab = state && state.tab;
  if (tab === 'following' || tab === 'collected') params.set('feed', tab);
  if (state && state.kind && FEED_KINDS.includes(state.kind)) params.set('kind', state.kind);
  if (state && state.query) params.set('q', state.query);
  if (state && state.creator) params.set('creator', state.creator);
  const text = params.toString();
  return text ? '?' + text : '';
}

export function formatFeedTime(value) {
  if (!value) return '';
  const date = new Date(Number(value) * 1000);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric',
  }).format(date);
}

export function coverPattern(title) {
  let hash = 0;
  for (const ch of String(title || '')) hash = (hash * 33 + ch.charCodeAt(0)) >>> 0;
  return String(hash % 8);
}

const KIND_LABELS = {document:'文档',website:'网页',slides:'幻灯片',audio:'音频',video:'视频',whiteboard:'白板',dashboard:'看板',media:'媒体'};

// Covers come from /w/<slug>/preview (same exposure as the public work page),
// so the feed listing itself stays a body-free projection.
export function attachFeedThumb(document, cover, preview) {
  if (!cover || !preview || cover.classList.contains('has-thumb')) return false;
  const thumb = renderThumb(document, preview);
  if (!thumb) return false;
  cover.classList.add('has-thumb');
  cover.append(thumb);
  return true;
}

export function feedPreviewPath(item) {
  if (!item || item.kind === 'image' || !/^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(String(item.slug || ''))) return '';
  return '/w/' + item.slug + '/preview';
}

export const FEED_DETAIL_MORE = '详情';
export const FEED_DETAIL_LESS = '收起';
export const FEED_DETAIL_LOADING = '正在读取作品摘要…';
// A refused preview is not an empty work: the detail says which one it is.
export const FEED_DETAIL_UNREADABLE = '读不到作品摘要。';
export const FEED_DETAIL_NO_TEXT = '这件作品没有文字摘要，打开原作品看内容。';
export const FEED_DETAIL_EMPTY = '这件作品还没有内容。';
export const FEED_DETAIL_OPEN = '打开原作品';

// The detail repeats what the listing already knows plus the bounded, text-only
// preview the public work page exposes. No body is read and stored HTML is
// never interpreted: thumbModel normalises it and every line goes through
// textContent.
export function detailExcerpt(preview) {
  const model = thumbModel(preview);
  if (!model || model.empty) return [];
  const lines = [];
  if (model.type === 'document' || model.type === 'website') {
    if (model.heading) lines.push(model.heading);
    for (const line of model.lines || []) lines.push(line);
    for (const block of model.blocks || []) lines.push(block.text);
  } else if (model.type === 'slides') {
    if (model.title) lines.push(model.title);
    for (const bullet of model.bullets || []) lines.push(bullet);
  } else if (model.type === 'dashboard') {
    for (const widget of model.widgets || []) if (widget.title) lines.push(widget.title);
  }
  const kept = [];
  for (const line of lines) {
    const value = String(line == null ? '' : line).replace(/\s+/g, ' ').trim();
    if (value && !kept.includes(value)) kept.push(value);
    if (kept.length >= 4) break;
  }
  return kept;
}

export function detailMetaText(item) {
  return [
    item.kind_label || KIND_LABELS[item.kind] || item.kind || '',
    item.author || '',
    formatFeedTime(item.updated),
  ].filter(Boolean).join(' · ');
}

export function renderFeedCard(document, item) {
  // The card carries two destinations, so it is a container rather than one big
  // link: the cover and title open the work, the author opens that author's
  // filtered feed. Links cannot nest, so this keeps both of them real <a>.
  // It stays a div, not an article: the signed-in grid already wraps each work
  // in <article class="feed-entry">, and scripts/ci_ui_screenshots.mjs counts
  // #feed-grid article per work (a nested article would double that census).
  const card = document.createElement('div');
  card.className = 'feed-card';
  const link = document.createElement('a');
  link.className = 'feed-card-link';
  link.href = item.path || ('/w/' + (item.slug || ''));
  const cover = document.createElement(item.kind === 'image' ? 'img' : 'div');
  cover.className = 'work-cover';
  cover.dataset.kind = item.kind || 'work';
  cover.dataset.pattern = coverPattern(item.title || item.slug || '');
  if (item.kind === 'image') {
    cover.src = '/w/' + encodeURIComponent(item.slug) + '/file';
    cover.alt = ''; cover.loading = 'lazy';
  } else {
    cover.setAttribute('aria-hidden', 'true');
    attachFeedThumb(document, cover, item.preview);
  }
  const kind = document.createElement('p');
  kind.className = 'kind';
  kind.textContent = item.kind_label || KIND_LABELS[item.kind] || item.kind || '';
  const title = document.createElement('h3');
  title.textContent = item.title || '';
  const meta = document.createElement('p');
  meta.className = 'meta';
  const mark = document.createElement('span');
  mark.className = 'feed-author-mark avatar';
  mark.dataset.tone = String(catalogTone(item.author || item.title || ''));
  mark.textContent = catalogMonogram(item.author || item.title || '');
  const author = String(item.author || '').trim().toLowerCase();
  const who = document.createElement(author ? 'a' : 'span');
  if (author) {
    who.className = 'feed-author';
    who.href = creatorLink(author);
    who.title = '只看 ' + item.author + ' 的公开作品';
  }
  who.textContent = item.author || '';
  const when = formatFeedTime(item.updated);
  meta.append(mark, who);
  if (when) {
    const stamp = document.createElement('span');
    stamp.className = 'feed-when';
    stamp.textContent = when;
    meta.append(stamp);
  }
  if (item.likes != null) {
    const likes = document.createElement('span');
    likes.className = 'feed-likes';
    likes.textContent = '♡ ' + (item.likes || 0);
    meta.append(likes);
  }
  link.append(cover, kind, title);
  card.append(link, meta);
  return card;
}

export function isAgentsCatalog(location) {
  const search = location && typeof location.search === 'string' ? location.search : '';
  const params = new URLSearchParams(search);
  return params.get('tab') === 'agents' && !params.has('section');
}

export function isTeamsCatalog(location) {
  const search = location && typeof location.search === 'string' ? location.search : '';
  const params = new URLSearchParams(search);
  return params.get('tab') === 'agents' && params.get('section') === 'groups';
}

function teamDirectoryQuery(text) {
  const params = new URLSearchParams({limit: String(TEAM_DIRECTORY_LIMIT)});
  if (text) params.set('q', text);
  return '/v1/team-directory?' + params.toString();
}

export function renderTeamCard(document, team, {joining = false, onJoin} = {}) {
  const card = document.createElement('article');
  const heading = document.createElement('div');
  heading.className = 'team-card-heading';
  const mark = document.createElement('span');
  mark.className = 'catalog-avatar';
  mark.dataset.tone = catalogTone(team.name);
  mark.setAttribute('aria-hidden', 'true');
  mark.textContent = catalogMonogram(team.name);
  const name = document.createElement('h3');
  name.textContent = team.name;
  heading.append(mark, name);
  card.append(heading);
  if (team.summary) {
    const summary = document.createElement('p');
    summary.className = 'team-summary';
    summary.textContent = team.summary;
    card.append(summary);
  }
  const foot = document.createElement('div');
  foot.className = 'team-foot';
  const count = document.createElement('span');
  count.className = 'team-size';
  const members = Number(team.member_count);
  count.textContent = Number.isInteger(members) && members >= 0 ? `${members} 位成员` : '';
  foot.append(count);
  const membership = Object.hasOwn(TEAM_MEMBERSHIP, team.membership) ? TEAM_MEMBERSHIP[team.membership] : '';
  if (membership) {
    const state = document.createElement('span');
    state.className = 'team-membership';
    state.dataset.state = team.membership;
    state.textContent = membership;
    foot.append(state);
  } else if (onJoin && TEAM_DIRECTORY_ID.test(team.workspace_id || '')) {
    const join = document.createElement('button');
    join.type = 'button';
    join.className = 'team-join';
    join.disabled = joining;
    join.textContent = joining ? '正在申请…' : '申请加入';
    join.setAttribute('aria-label', `${join.textContent} ${team.name}`);
    join.addEventListener('click', () => onJoin(team));
    foot.append(join);
  }
  card.append(foot);
  return card;
}

export function reuseKey(seed = Date.now()) {
  return 'discover-reuse-' + seed.toString(36) + '-' +
    Math.random().toString(36).slice(2, 10).padEnd(8, '0');
}

function messageFor(error, fallback) {
  if (error && error.message) return error.message;
  return fallback;
}

export function mount(document, { fetcher = globalThis.fetch.bind(globalThis), location = globalThis.location, history = globalThis.history, window = globalThis } = {}) {
  const status = document.getElementById('status');
  const loginPanel = document.getElementById('login-panel');
  const mainPanel = document.getElementById('main-panel');
  const workspaceSelect = document.getElementById('workspace');
  let currentUser = null;
  let workspaceListState = 'loading';
  let catalog = [];
  let cursor = '';
  let activeQuery = '';
  let activeCategory = categoryFromSearch(location?.search);
  let activeCreator = null;
  let remix = null;
  let remixLoading = false;
  let manageRequest = 0;
  let catalogRequest = 0;
  let directoryItems = [];
  let directoryLoading = false;
  let activeTeamQuery = '';
  const joiningTeams = new Set();
  const agentsView = isAgentsCatalog(location);
  const teamsView = isTeamsCatalog(location);
  const catalogView = agentsView || teamsView;
  const initialFeed = catalogView
    ? {tab: 'activity', kind: '', query: ''}
    : feedStateFromSearch(location && location.search);

  function setCurrent(id, on) {
    const node = document.getElementById(id);
    if (!node) return;
    if (on) node.setAttribute('aria-current', 'page');
    else if (typeof node.removeAttribute === 'function') node.removeAttribute('aria-current');
    else if (node.attributes) delete node.attributes['aria-current'];
  }

  function applyCatalogChrome() {
    setCurrent('catalog-tab-feed', !catalogView);
    setCurrent('catalog-tab-agents', agentsView);
    setCurrent('catalog-tab-teams', teamsView);
    const agentFilters = document.getElementById('catalog-filters');
    if (agentFilters) agentFilters.hidden = !agentsView;
    const createAgent = document.getElementById('catalog-create-agent');
    const createTeam = document.getElementById('catalog-create-team');
    if (createAgent) createAgent.hidden = !agentsView;
    if (createTeam) createTeam.hidden = !teamsView;
    const query = document.getElementById('catalog-query');
    if (query) {
      query.placeholder = teamsView ? '搜索 AI 团队…' : '搜索智能体…';
      if (teamsView) query.maxLength = TEAM_SEARCH_LIMIT;
    }
    if (typeof document.querySelector === 'function') {
      const queryLabel = document.querySelector('label[for="catalog-query"]');
      if (queryLabel) queryLabel.textContent = teamsView ? '搜索 AI 团队' : '搜索智能体';
    }
    const heading = document.getElementById('catalog-heading');
    if (heading) heading.textContent = teamsView ? '公共 AI 团队' : '公共智能体';
    const list = document.getElementById('discover-list');
    if (list && list.classList) {
      if (teamsView) list.classList.add('teams-catalog');
      else list.classList.remove('teams-catalog');
    }
  }

  function renderTeamDirectory() {
    const list = document.getElementById('discover-list');
    list.replaceChildren();
    for (const team of directoryItems) {
      const row = document.createElement('li');
      row.append(renderTeamCard(document, team, {
        joining: joiningTeams.has(team.workspace_id),
        onJoin: applyTeam,
      }));
      list.append(row);
    }
  }

  async function applyTeam(team) {
    const id = team.workspace_id;
    const user = currentUser;
    if (!user || joiningTeams.has(id) || !TEAM_DIRECTORY_ID.test(id)) return;
    joiningTeams.add(id);
    renderTeamDirectory();
    show('', '');
    try {
      const response = await request('POST', '/v1/team-directory/' + encodeURIComponent(id) + '/join', {});
      const next = response.status === 202 ? 'pending' : response.status === 200 ? response.body.status : '';
      if (currentUser !== user) return;
      if (!Object.hasOwn(TEAM_MEMBERSHIP, next)) {
        show('error', messageFor(response.body.error, '无法提交加入申请，请重试。'));
        return;
      }
      directoryItems = directoryItems.map(item => item.workspace_id === id ? {...item, membership: next} : item);
      show('ok', next === 'pending' ? '已提交申请，等待团队管理员审批。' : TEAM_MEMBERSHIP[next]);
      // A search started before the write can return pre-application membership.
      if (directoryLoading) void loadTeams(activeTeamQuery);
    } catch {
      if (currentUser === user) show('error', '连接失败，暂时无法确认申请结果。可刷新重试。');
    } finally {
      joiningTeams.delete(id);
      if (currentUser === user) renderTeamDirectory();
    }
  }

  async function loadTeams(query = document.getElementById('catalog-query').value.trim().slice(0, TEAM_SEARCH_LIMIT)) {
    const seq = ++catalogRequest;
    const panel = document.getElementById('catalog-panel');
    const empty = document.getElementById('discover-empty');
    const error = document.getElementById('catalog-error');
    const retry = document.getElementById('teams-retry');
    const count = document.getElementById('catalog-count');
    activeTeamQuery = query;
    directoryItems = [];
    renderTeamDirectory();
    document.getElementById('catalog-more').hidden = true;
    empty.hidden = true;
    error.hidden = true;
    retry.hidden = true;
    if (!currentUser) {
      directoryLoading = false;
      panel.setAttribute('aria-busy', 'false');
      count.textContent = '';
      empty.textContent = '登录后可查看并申请加入公开团队。';
      empty.hidden = false;
      return;
    }
    directoryLoading = true;
    panel.setAttribute('aria-busy', 'true');
    count.textContent = '正在加载团队…';
    try {
      const result = await request('GET', teamDirectoryQuery(query));
      if (seq !== catalogRequest) return;
      if (result.status !== 200) throw new Error(messageFor(result.body.error, '无法加载团队目录。'));
      directoryItems = catalogItems(result.body);
      renderTeamDirectory();
      count.textContent = directoryItems.length >= TEAM_DIRECTORY_LIMIT
        ? `已显示前 ${TEAM_DIRECTORY_LIMIT} 个团队，可用搜索缩小范围。`
        : directoryItems.length ? `${directoryItems.length} 个团队` : '';
      empty.textContent = query ? '没有匹配的团队。' : '暂无公开团队。';
      empty.hidden = directoryItems.length > 0;
    } catch (failure) {
      if (seq !== catalogRequest) return;
      count.textContent = '';
      error.textContent = failure.message || '无法加载团队目录。';
      error.hidden = false;
      retry.hidden = false;
    } finally {
      if (seq === catalogRequest) {
        directoryLoading = false;
        panel.setAttribute('aria-busy', 'false');
      }
    }
  }

  function showDiscoverView() {
    const feed = document.getElementById('feed-panel');
    const catalog = document.getElementById('catalog-view');
    if (feed) feed.hidden = catalogView;
    if (catalog) catalog.hidden = !catalogView;
    applyCatalogChrome();
  }

  const feedState = {items: [], cursor: '', query: initialFeed.query, kind: initialFeed.kind, tab: initialFeed.tab, loading: false, creator: initialFeed.creator};
  let feedRequest = 0;

  function setFeedTab(tab) {
    feedState.tab = tab;
    for (const name of ['following', 'activity', 'collected']) {
      const button = document.getElementById('feed-tab-' + name);
      if (button) button.setAttribute('aria-selected', name === tab ? 'true' : 'false');
    }
    applyFeedNote();
  }

  function applyFeedChrome() {
    for (const name of ['following', 'activity', 'collected']) {
      const button = document.getElementById('feed-tab-' + name);
      if (button) button.setAttribute('aria-selected', name === feedState.tab ? 'true' : 'false');
    }
    for (const kind of FEED_KINDS) {
      const node = document.getElementById('feed-kind-' + (kind || 'all'));
      if (node) node.setAttribute('aria-current', kind === feedState.kind ? 'true' : 'false');
    }
    const input = document.getElementById('feed-query');
    if (input) input.value = feedState.query;
    applyFeedCreator();
  }

  function feedUrl() {
    const pathname = location && typeof location.pathname === 'string' ? location.pathname : '/discover';
    return pathname + feedSearchText(feedState);
  }

  function pushFeedUrl() {
    if (catalogView || !history || typeof history.pushState !== 'function') return;
    history.pushState(null, '', feedUrl());
  }

  if (!catalogView && window && typeof window.addEventListener === 'function') {
    window.addEventListener('popstate', () => {
      const next = feedStateFromSearch(location && location.search);
      feedState.tab = next.tab;
      feedState.kind = next.kind;
      feedState.query = next.query;
      feedState.creator = next.creator;
      applyFeedChrome();
      applyFeedNote();
      loadFeed();
    });
  }

  function applyFeedNote() {
    const note = document.getElementById('feed-note');
    const followingEmpty = document.getElementById('feed-following-empty');
    const gridSection = document.getElementById('feed-activity-empty');
    const searchNote = document.getElementById('feed-search-note');
    if (followingEmpty) followingEmpty.hidden = !(currentUser && feedState.tab === 'following' && !feedState.items.length && !feedState.loading);
    if (gridSection) gridSection.hidden = false;
    if (searchNote) searchNote.hidden = true;
    if (!note) return;
    if (feedState.tab !== 'activity' && !currentUser) note.textContent = '请先登录，再查看关注或收录作品。';
    else if (feedState.tab === 'following') note.textContent = FEED_FOLLOWING_NOTE;
    else if (feedState.tab === 'collected') note.textContent = '这里只展示你收录且仍公开的作品。';
    else if (feedState.creator && !feedState.items.length && !feedState.loading) note.textContent = FEED_CREATOR_EMPTY_NOTE;
    else note.textContent = (feedState.query || feedState.kind) && !feedState.items.length && !feedState.loading
      ? FEED_SEARCH_EMPTY_NOTE : (feedState.items.length ? FEED_ACTIVITY_LISTED_NOTE : FEED_ACTIVITY_EMPTY_NOTE);
  }

  const previewCache = new Map();
  // One shape for both the cover thumb and the detail: a refused preview is
  // marked so the detail can say "unreadable" instead of "empty".
  function cachedPreview(item) {
    const path = feedPreviewPath(item);
    if (!path || typeof fetcher !== 'function') return Promise.resolve({ok: false, readable: false, preview: null});
    const key = path + '@' + (item.updated || '');
    if (!previewCache.has(key)) {
      previewCache.set(key, Promise.resolve()
        .then(() => fetcher(path, {method: 'GET', credentials: 'same-origin', headers: {Accept: 'application/json'}}))
        .then(response => {
          if (!response || response.status !== 200) return {ok: false, preview: null};
          return Promise.resolve()
            .then(() => response.json())
            .then(body => ({ok: true, preview: (body && body.preview) || null}))
            .catch(() => ({ok: false, preview: null}));
        })
        .catch(() => ({ok: false, preview: null})));
    }
    return previewCache.get(key);
  }

  function hydrateThumb(cover, item) {
    if (!cover) return;
    cachedPreview(item).then(result => attachFeedThumb(document, cover, result.preview)).catch(() => {});
  }

  // The detail is opened in place: the card keeps its own link to the work
  // page, and reading the summary never reloads the feed or the page.
  function attachFeedDetail(entry, item) {
    const panel = document.createElement('section');
    panel.className = 'feed-detail';
    panel.hidden = true;
    if (item.slug) {
      panel.id = 'feed-detail-' + item.slug;
      panel.setAttribute('aria-label', (item.title || item.slug) + ' 的作品详情');
    }
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'feed-detail-toggle';
    toggle.textContent = FEED_DETAIL_MORE;
    toggle.setAttribute('aria-expanded', 'false');
    if (panel.id) toggle.setAttribute('aria-controls', panel.id);
    let open = false;
    let filled = false;
    toggle.addEventListener('click', async () => {
      open = !open;
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.textContent = open ? FEED_DETAIL_LESS : FEED_DETAIL_MORE;
      panel.hidden = !open;
      if (!open || filled) return;
      filled = true;
      const meta = document.createElement('p');
      meta.className = 'feed-detail-meta';
      meta.textContent = detailMetaText(item);
      const summary = document.createElement('div');
      summary.className = 'feed-detail-summary';
      summary.textContent = FEED_DETAIL_LOADING;
      const link = document.createElement('a');
      link.className = 'feed-detail-open';
      link.href = item.path || ('/w/' + (item.slug || ''));
      link.textContent = FEED_DETAIL_OPEN;
      panel.append(meta, summary, link);
      if (!feedPreviewPath(item)) {
        summary.textContent = FEED_DETAIL_NO_TEXT;
        return;
      }
      const result = await cachedPreview(item);
      if (!result.ok) { summary.textContent = FEED_DETAIL_UNREADABLE; return; }
      if (!result.preview) { summary.textContent = FEED_DETAIL_NO_TEXT; return; }
      const lines = detailExcerpt(result.preview);
      if (!lines.length) { summary.textContent = FEED_DETAIL_EMPTY; return; }
      summary.textContent = '';
      const list = document.createElement('ul');
      list.className = 'feed-detail-lines';
      for (const line of lines) {
        const row = document.createElement('li');
        row.textContent = line;
        list.append(row);
      }
      summary.append(list);
    });
    entry.append(toggle, panel);
  }

  function renderFeed() {
    const grid = document.getElementById('feed-grid');
    if (!grid) return;
    grid.replaceChildren();
    for (const item of feedState.items) {
      const card = renderFeedCard(document, item);
      const cover = typeof card.querySelector === 'function' ? card.querySelector('.work-cover') : null;
      hydrateThumb(cover, item);
      const entry = document.createElement('article');
      entry.className = 'feed-entry';
      entry.append(card);
      if (!currentUser) { grid.append(entry); attachFeedDetail(entry, item); continue; }
      const actions = document.createElement('div');
      for (const [action, flag, label] of [['like','liked','点赞'], ['collect','collected','收录'], ['follow','following','关注作者']]) {
        if (action === 'follow' && item.own_work) continue;
        const button = document.createElement('button'); button.type = 'button';
        button.textContent = (item[flag] ? '取消' : '') + label + (action === 'like' ? ' · ' + (item.likes || 0) : '');
        button.setAttribute('aria-pressed', item[flag] ? 'true' : 'false');
        button.addEventListener('click', async () => {
          button.disabled = true;
          let result;
          try { result = await request('POST', `/v1/discover/works/${item.slug}/engagement`, {action, enabled: !item[flag]}); }
          catch { result = {status: 0}; }
          button.disabled = false;
          if (result.status !== 200) {
            const error = document.getElementById('feed-error'); error.hidden = false; error.textContent = '操作未保存，请重试。'; return;
          }
          await loadFeed();
        });
        actions.append(button);
      }
      entry.append(actions);
      attachFeedDetail(entry, item);
      grid.append(entry);
    }
    grid.dataset.empty = feedState.items.length ? 'false' : 'true';
    const count = document.getElementById('feed-count');
    if (count) {
      count.textContent = feedState.items.length
        ? '已显示 ' + feedState.items.length + ' 件公开作品'
        : '';
    }
    const more = document.getElementById('feed-more');
    if (more) more.hidden = !feedState.cursor || feedState.loading;
    applyFeedNote();
  }

  async function loadFeed({append = false} = {}) {
    if (feedState.loading && append) return;
    const seq = ++feedRequest;
    const input = document.getElementById('feed-query');
    const query = input ? (input.value || '').trim() : '';
    if (!append) {
      feedState.items = [];
      feedState.cursor = '';
      feedState.query = query;
    }
    feedState.loading = true;
    const error = document.getElementById('feed-error');
    if (error) {
      error.hidden = true;
      error.textContent = '';
    }
    const privateFeed = currentUser || feedState.tab !== 'activity';
    const params = feedQuery(feedState.query, append ? feedState.cursor : '', feedState.kind, feedState.creator);
    const tab = feedState.tab === 'activity' ? 'all' : feedState.tab;
    const path = privateFeed ? `/v1/discover/me/works?${params}&tab=${tab}` : `/v1/discover/works?${params}`;
    let result;
    try { result = await request('GET', path); }
    catch { result = {status: 0, body: {}}; }
    if (seq !== feedRequest) return;
    feedState.loading = false;
    if (result.status !== 200) {
      if (error) {
        error.hidden = false;
        error.textContent = (result.body && result.body.error && result.body.error.message)
          || '无法加载公开作品。';
      }
      renderFeed();
      return;
    }
    const incoming = result.body.items || [];
    feedState.items = append ? feedState.items.concat(incoming) : incoming;
    feedState.cursor = result.body.cursor || '';
    renderFeed();
  }

  function show(kind, text) {
    status.dataset.kind = kind;
    status.textContent = text;
  }

  async function request(method, path, body, extraHeaders = {}) {
    const headers = Object.assign(
      { Accept: 'application/json', 'X-CSRF-Token': csrfCookie(document.cookie) }, extraHeaders);
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetcher(path, {
      method, headers, credentials: 'same-origin',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let parsed = {};
    try { parsed = await response.json(); } catch { parsed = {}; }
    return { status: response.status, body: parsed };
  }

  function applyCatalogFilters() {
    for (const chip of document.querySelectorAll('[data-catalog-category]')) {
      chip.setAttribute('aria-pressed', String(chip.dataset.catalogCategory === activeCategory));
    }
    const filter = document.getElementById('catalog-creator-filter');
    filter.hidden = !activeCreator;
    document.getElementById('catalog-creator-label').textContent = activeCreator ? '创建者 · ' + activeCreator.name : '';
  }

  function setCategory(category) {
    activeCategory = category;
    if (history?.replaceState) {
      const params = new URLSearchParams(location.search);
      if (category === 'all') params.delete('category');
      else params.set('category', category);
      history.replaceState(null, '', '/discover?' + params.toString());
    }
    return loadCatalog();
  }

  const categoryDialog = document.getElementById('catalog-category-dialog');
  const categoryQuery = document.getElementById('catalog-category-query');
  function renderCategoryOptions() {
    const options = document.getElementById('catalog-category-options');
    const term = categoryQuery.value.trim().toLowerCase();
    options.replaceChildren();
    for (const {slug, label} of [{slug: 'all', label: '全部'}, ...AGENT_CATEGORIES]) {
      if (term && !label.toLowerCase().includes(term)) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.setAttribute('aria-pressed', String(slug === activeCategory));
      button.addEventListener('click', () => {
        categoryDialog.close();
        setCategory(slug);
      });
      options.append(button);
    }
    document.getElementById('catalog-category-empty').hidden = options.childElementCount > 0;
  }

  const remixDialog = document.getElementById('catalog-remix-dialog');
  const remixName = document.getElementById('catalog-remix-name');
  const remixWorkspace = document.getElementById('catalog-remix-workspace');
  const remixStatus = document.getElementById('catalog-remix-status');
  const remixSubmit = document.getElementById('catalog-remix-submit');

  function syncRemixWorkspaces() {
    const previous = remixWorkspace.value || workspaceSelect.value;
    remixWorkspace.replaceChildren(...Array.from(workspaceSelect.options, option => {
      const choice = document.createElement('option');
      choice.value = option.value;
      choice.textContent = option.textContent;
      return choice;
    }));
    if (Array.from(remixWorkspace.options).some(option => option.value === previous)) remixWorkspace.value = previous;
    remixSubmit.disabled = !remix?.template || !remixWorkspace.value || remixLoading;
    if (remix?.template && !remixWorkspace.value) {
      remixStatus.textContent = {
        loading: '正在读取可用工作区…', failed: '无法读取工作区。请刷新后重试。', ready: '暂无可用工作区。',
      }[workspaceListState];
    } else if (remix?.template && workspaceListState === 'ready' && remixStatus.textContent === '正在读取可用工作区…') {
      remixStatus.textContent = '';
    }
  }

  async function openRemix(item) {
    if (!currentUser) {
      show('error', '请登录后复制智能体。');
      return;
    }
    const entry = {slug: item.slug, key: reuseKey(), template: null};
    remix = entry;
    remixName.value = item.name;
    document.getElementById('catalog-remix-summary').textContent = item.summary || '';
    const instructions = document.getElementById('catalog-remix-instructions');
    instructions.hidden = true;
    instructions.open = false;
    const description = document.getElementById('catalog-remix-description');
    description.textContent = '';
    remixStatus.textContent = '正在读取发布内容…';
    syncRemixWorkspaces();
    if (!remixDialog.open) remixDialog.showModal();
    try {
      const result = await request('GET', '/v1/discover/agents/' + entry.slug + '/remix');
      if (remix !== entry || !remixDialog.open) return;
      if (result.status !== 200) throw new Error(messageFor(result.body.error, '无法读取发布内容。'));
      const template = result.body.template;
      entry.template = template;
      remixName.value = template.name;
      document.getElementById('catalog-remix-summary').textContent = template.summary;
      document.getElementById('catalog-remix-prompt').textContent = template.instructions;
      instructions.hidden = !template.instructions;
      description.textContent = template.instructions
        ? '副本包含发布的指令，可在自己的工作区修改。'
        : '此发布只包含名称、简介和分类。创建后可补充自己的指令。';
      remixStatus.textContent = '';
      syncRemixWorkspaces();
    } catch (error) {
      if (remix === entry && remixDialog.open) remixStatus.textContent = error.message;
    }
  }

  async function submitRemix(event) {
    event.preventDefault();
    const entry = remix;
    if (remixLoading || !entry?.template || !remixWorkspace.value) return;
    remixLoading = true;
    remixSubmit.disabled = true;
    remixStatus.textContent = '正在创建副本…';
    try {
      const result = await request('POST', '/v1/discover/agents/' + entry.slug + '/remix', {
        revision: entry.template.revision, workspace_id: remixWorkspace.value, name: remixName.value.trim(),
      }, {'Idempotency-Key': entry.key});
      if (![200, 201].includes(result.status)) {
        if (result.body.error?.code === 'listing_changed') {
          entry.template = null;
          throw new Error('发布内容已更新。关闭后重新预览。');
        }
        throw new Error(messageFor(result.body.error, '无法创建副本，请重试。'));
      }
      const agent = result.body.agent;
      const hash = new URLSearchParams({workspace: agent.workspace_id, agent: agent.id});
      location.assign('/chat#' + hash.toString());
    } catch (error) {
      if (remix === entry) remixStatus.textContent = error.message;
    } finally {
      remixLoading = false;
      syncRemixWorkspaces();
    }
  }

  function renderCatalog(items) {
    const list = document.getElementById('discover-list');
    list.replaceChildren();
    document.getElementById('discover-empty').hidden = items.length > 0;
    for (const item of items) {
      const li = document.createElement('li');
      const card = document.createElement('article');
      const avatar = document.createElement('span');
      avatar.className = 'catalog-avatar';
      avatar.setAttribute('aria-hidden', 'true');
      avatar.textContent = catalogMonogram(item.name || item.slug);
      avatar.dataset.tone = catalogTone(item.name || item.slug);
      const copy = document.createElement('div');
      copy.className = 'catalog-copy';
      const name = document.createElement('h3');
      name.textContent = item.name || item.slug;
      const summary = document.createElement('p');
      summary.className = 'summary';
      summary.textContent = item.summary || '没有简介。';
      copy.append(name, summary);
      const meta = document.createElement('div');
      meta.className = 'catalog-card-meta';
      if (item.category) {
        const tag = document.createElement('span');
        tag.textContent = categoryLabel(item.category);
        if (tag.textContent) meta.append(tag);
      }
      if (item.creator?.handle) {
        const creator = document.createElement('button');
        creator.type = 'button';
        creator.className = 'catalog-author';
        creator.textContent = item.creator.name || item.creator.handle;
        creator.title = '查看此创建者的智能体';
        creator.addEventListener('click', () => {
          activeCreator = item.creator;
          loadCatalog();
        });
        meta.append(creator);
      }
      if (meta.childElementCount) copy.append(meta);
      const use = document.createElement('button');
      use.type = 'button';
      use.className = 'catalog-use';
      use.textContent = '复制';
      use.setAttribute('aria-label', '复制智能体：' + (item.name || item.slug));
      use.addEventListener('click', () => openRemix(item));
      card.append(avatar, copy);
      if (item.chat_enabled && !item.own_agent && validSlug(item.slug)) {
        const actions = document.createElement('div');
        actions.className = 'catalog-agent-actions';
        const chat = document.createElement('a');
        chat.href = '/chat#public-agent=' + item.slug;
        chat.className = 'catalog-chat';
        chat.textContent = '聊天';
        chat.setAttribute('aria-label', '和 ' + (item.name || item.slug) + ' 聊天');
        actions.append(chat, use);
        card.append(actions);
      } else card.append(use);
      li.append(card);
      list.append(li);
    }
  }

  async function loadCatalog(append = false) {
    const seq = ++catalogRequest;
    if (!append) {
      applyCatalogFilters();
      activeQuery = document.getElementById('catalog-query').value.trim();
      catalog = [];
      cursor = '';
      renderCatalog([]);
      document.getElementById('discover-empty').hidden = true;
    }
    const more = document.getElementById('catalog-more');
    const count = document.getElementById('catalog-count');
    const error = document.getElementById('catalog-error');
    error.hidden = true;
    more.disabled = true;
    count.textContent = append ? '正在加载更多…' : '正在加载…';
    document.getElementById('catalog-panel').setAttribute('aria-busy', 'true');
    try {
      const listed = await request('GET', catalogQuery(activeQuery, cursor, activeCategory, activeCreator?.handle));
      if (seq !== catalogRequest) return;
      if (listed.status !== 200) throw new Error(messageFor(listed.body.error, '无法加载公共目录。'));
      const incoming = catalogItems(listed.body);
      const known = new Set(catalog.map(item => item.slug));
      catalog.push(...incoming.filter(item => !known.has(item.slug)));
      cursor = listed.body.cursor || '';
      renderCatalog(catalog);
      more.hidden = !cursor;
      document.getElementById('discover-empty').textContent = activeQuery || activeCategory !== 'all' || activeCreator
        ? '没有匹配的智能体。' : '暂无公开智能体。';
      count.textContent = '已显示 ' + catalog.length + ' 个智能体' + (cursor ? '，还有更多' : '');
    } catch (failure) {
      if (seq !== catalogRequest) return;
      error.hidden = false;
      error.textContent = failure.message || '无法加载公共目录。';
      count.textContent = '目录加载失败，请重试搜索。';
      more.hidden = !cursor;
      document.getElementById('discover-empty').hidden = true;
    } finally {
      if (seq === catalogRequest) {
        more.disabled = false;
        document.getElementById('catalog-panel').setAttribute('aria-busy', 'false');
      }
    }
  }

  function renderManage(pairs) {
    const list = document.getElementById('manage-list');
    list.replaceChildren();
    document.getElementById('manage-empty').hidden = pairs.length > 0;
    for (const {agent, discover} of pairs) {
      const li = document.createElement('li');
      li.className = 'manage-row';
      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = agent.name;
      const state = document.createElement('span');
      state.className = 'state';
      state.textContent = discover.listed ? '已发布' : '未发布';
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 30;
      input.placeholder = '公开地址';
      input.setAttribute('aria-label', agent.name + ' 的公开地址');
      input.value = discover.slug || '';
      const options = document.createElement('div');
      options.className = 'catalog-publish-options';
      const label = document.createElement('label');
      const allow = document.createElement('input');
      allow.type = 'checkbox';
      allow.disabled = !agent.instructions;
      allow.checked = Boolean(agent.instructions && discover.copy_instructions);
      const preview = document.createElement('pre');
      preview.textContent = agent.instructions || '';
      preview.hidden = !allow.checked;
      allow.addEventListener('change', () => { preview.hidden = !allow.checked; });
      label.append(allow, document.createTextNode('公开完整指令，允许复制'));
      const chatLabel = document.createElement('label');
      const publicChat = document.createElement('input');
      publicChat.type = 'checkbox';
      publicChat.checked = discover.chat_enabled === true;
      chatLabel.append(publicChat, document.createTextNode('允许访客聊天'));
      const chatNote = document.createElement('p');
      chatNote.className = 'note';
      chatNote.textContent = '自动回复使用已发布的简介、指令和当前对话。你可以查看访客的对话。';
      chatNote.hidden = !publicChat.checked;
      publicChat.addEventListener('change', () => { chatNote.hidden = !publicChat.checked; });
      options.append(label, preview, chatLabel, chatNote);
      const publish = document.createElement('button');
      publish.type = 'button';
      publish.textContent = discover.listed ? '更新发布' : '发布';
      publish.addEventListener('click', async () => {
        if (!validSlug(input.value.trim())) {
          show('error', 'slug 需为 3–30 个字符的小写字母、数字或连字符。');
          return;
        }
        const result = await request(
          'POST', `/v1/workspaces/${workspaceSelect.value}/agents/${agent.id}/discover`,
          {slug: input.value.trim(), revision: agent.revision, copy_instructions: allow.checked, chat_enabled: publicChat.checked});
        if (result.status !== 201 && result.status !== 200) {
          show('error', messageFor(result.body.error, '无法收录。'));
          return;
        }
        show('ok', '已发布。');
        await loadCatalog();
        await loadManage();
      });
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.textContent = '取消发布';
      revoke.disabled = !discover.listed;
      revoke.addEventListener('click', async () => {
        const result = await request(
          'POST', `/v1/workspaces/${workspaceSelect.value}/agents/${agent.id}/discover/revoke`, {});
        if (result.status !== 200) {
          show('error', messageFor(result.body.error, '无法取消收录。'));
          return;
        }
        show('ok', '已取消发布。');
        await loadCatalog();
        await loadManage();
      });
      li.append(title, state, input, publish, revoke, options);
      list.append(li);
    }
  }

  async function loadManage() {
    const seq = ++manageRequest;
    const id = workspaceSelect.value;
    if (!id) {
      renderManage([]);
      return;
    }
    const listed = await request('GET', `/v1/workspaces/${id}/agents?limit=100`);
    if (seq !== manageRequest) return;
    if (listed.status !== 200) {
      renderManage([]);
      return;
    }
    const agents = listed.body.items || [];
    const statuses = await Promise.all(agents.map(agent =>
      request('GET', `/v1/workspaces/${id}/agents/${agent.id}/discover`)
        .then(result => (result.status === 200 ? result.body.discover : {listed: false}))));
    if (seq === manageRequest) renderManage(agentDiscoverPairs(agents, statuses));
  }

  async function load() {
    showDiscoverView();
    const sessionLoad = request('GET', '/v1/auth/session');
    const directoryLoad = agentsView ? loadCatalog() : null;
    const session = await sessionLoad;
    if (session.status !== 200) {
      currentUser = null;
      loginPanel.hidden = false;
      mainPanel.hidden = false;
      document.getElementById('catalog-manage').hidden = true;
      show('', '');
      if (teamsView) await loadTeams();
      await directoryLoad;
      return;
    }
    currentUser = session.body.user;
    loginPanel.hidden = true;
    mainPanel.hidden = false;
    document.getElementById('catalog-manage').hidden = !agentsView;
    document.getElementById('whoami').textContent = currentUser.username;
    if (agentsView) {
      const listed = await request('GET', '/v1/workspaces?limit=100');
      workspaceListState = listed.status === 200 ? 'ready' : 'failed';
      const workspaces = workspaceListState === 'ready' ? (listed.body.items || []) : [];
      workspaceSelect.replaceChildren();
      for (const space of workspaces) {
        const option = document.createElement('option');
        option.value = space.id;
        option.textContent = space.name;
        workspaceSelect.append(option);
      }
      syncRemixWorkspaces();
      if (document.getElementById('catalog-manage').open) void loadManage();
    }
    show('', '');
    if (teamsView) await loadTeams();
    await directoryLoad;
  }

  document.getElementById('login-form').addEventListener('submit', async event => {
    event.preventDefault();
    const result = await request('POST', '/v1/auth/login', {
      username: document.getElementById('username').value.trim(),
      password: document.getElementById('password').value,
    });
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '登录失败。'));
      return;
    }
    await load();
  });

  workspaceSelect.addEventListener('change', loadManage);
  const manage = document.getElementById('catalog-manage');
  manage.addEventListener('toggle', () => { if (manage.open) void loadManage(); });
  if (agentsView) {
    for (const chip of document.querySelectorAll('[data-catalog-category]')) {
      chip.addEventListener('click', () => setCategory(chip.dataset.catalogCategory));
    }
    document.getElementById('catalog-filter-search').addEventListener('click', () => {
      categoryQuery.value = '';
      renderCategoryOptions();
      categoryDialog.showModal();
      categoryQuery.focus();
    });
    categoryQuery.addEventListener('input', renderCategoryOptions);
    document.getElementById('catalog-category-close').addEventListener('click', () => categoryDialog.close());
    document.getElementById('catalog-clear-creator').addEventListener('click', () => {
      activeCreator = null;
      loadCatalog();
    });
    document.getElementById('catalog-remix-form').addEventListener('submit', submitRemix);
    document.getElementById('catalog-remix-cancel').addEventListener('click', () => {
      if (!remixLoading) remixDialog.close();
    });
    remixDialog.addEventListener('cancel', event => { if (remixLoading) event.preventDefault(); });
    remixDialog.addEventListener('close', () => { remix = null; });
  }
  document.getElementById('catalog-search').addEventListener('submit', event => {
    event.preventDefault();
    if (agentsView) return loadCatalog();
    if (teamsView) return loadTeams();
  });
  document.getElementById('catalog-clear').addEventListener('click', () => {
    document.getElementById('catalog-query').value = '';
    if (agentsView) return loadCatalog();
    if (teamsView) return loadTeams();
  });
  document.getElementById('teams-retry').addEventListener('click', () => loadTeams(activeTeamQuery));
  document.getElementById('catalog-more').addEventListener('click', () => {
    if (agentsView) return loadCatalog(true);
  });
  for (const kind of FEED_KINDS) {
    const button = document.getElementById('feed-kind-' + (kind || 'all'));
    if (!button) continue;
    button.addEventListener('click', () => {
      feedState.kind = kind;
      for (const candidate of FEED_KINDS) {
        const node = document.getElementById('feed-kind-' + (candidate || 'all'));
        if (node) node.setAttribute('aria-current', candidate === kind ? 'true' : 'false');
      }
      pushFeedUrl();
      return loadFeed();
    });
  }
  // A creator filter is a link, not a stored preference: it lives in the URL so
  // it can be copied, refreshed and cleared back to every author.
  function applyFeedCreator() {
    const chip = document.getElementById('feed-creator-chip');
    if (!chip) return;
    chip.hidden = !feedState.creator;
    const label = document.getElementById('feed-creator-label');
    if (label) label.textContent = feedState.creator ? '只看 ' + feedState.creator + ' 的公开作品' : '';
    const clear = document.getElementById('feed-creator-clear');
    if (clear) {
      const pathname = location && typeof location.pathname === 'string' ? location.pathname : '/discover';
      clear.href = pathname + feedSearchText({...feedState, creator: ''});
      clear.setAttribute('aria-label', '清除作者筛选，回到全部作者');
    }
  }

  const feedCreatorClear = document.getElementById('feed-creator-clear');
  if (feedCreatorClear) {
    feedCreatorClear.addEventListener('click', (event) => {
      event.preventDefault();
      feedState.creator = '';
      applyFeedChrome();
      pushFeedUrl();
      loadFeed();
    });
  }
  const feedSearch = document.getElementById('feed-search');
  if (feedSearch) {
    feedSearch.addEventListener('submit', event => {
      event.preventDefault();
      const input = document.getElementById('feed-query');
      feedState.query = input ? (input.value || '').trim() : '';
      pushFeedUrl();
      loadFeed();
    });
  }
  const feedMore = document.getElementById('feed-more');
  if (feedMore) {
    feedMore.addEventListener('click', () => {
      if (feedState.cursor && !feedState.loading) loadFeed({append: true});
    });
  }
  for (const tab of ['following', 'activity', 'collected']) {
    const button = document.getElementById('feed-tab-' + tab);
    if (button) button.addEventListener('click', () => {
      setFeedTab(tab);
      pushFeedUrl();
      return loadFeed();
    });
  }

  document.getElementById('logout-form').addEventListener('submit', async event => {
    event.preventDefault();
    await request('POST', '/v1/auth/logout', {});
    await load();
  });

  return load().then(() => { if (!catalogView) { setFeedTab(feedState.tab); applyFeedChrome(); return loadFeed(); } });
}

if (globalThis.document && globalThis.document.getElementById('manage-list')) {
  mount(globalThis.document);
}
