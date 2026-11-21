import { AGENT_CATEGORIES, categoryFromSearch, categoryLabel, csrfCookie } from '../agents/app.mjs';
import { servedByDsBot } from '../shell/dsbot-api.mjs';
import { bindModel3dPreview } from '../shell/model3d-preview.mjs';
import { renderThumb, thumbModel } from '../shell/thumb.mjs';
import { commentsLabel, mountWorkComments } from './comments.mjs';

const SLUG = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;
const VIEWER_USERNAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$/;
const CREATOR_HANDLE = /^[a-z0-9][a-z0-9._-]{1,79}$/i;

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
  })).filter(({agent, discover}) => !(agent.archived || agent.native_deleted) || discover.listed);
}

export function catalogQuery(text = '', cursor = '', category = 'all', creator = '') {
  const params = new URLSearchParams({limit: '12'});
  if (text.trim()) params.set('q', text.trim());
  if (cursor) params.set('cursor', cursor);
  if (category !== 'all') params.set('category', category);
  if (creator) params.set('creator', creator);
  return '/v1/discover/agents?' + params.toString();
}

export const FEED_CATEGORIES = ['网页', '图片', '音乐', '幻灯片', '视频', '3D 作品'];

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

export const FEED_KINDS = ['', 'website', 'image', 'audio', 'slides', 'video', 'model3d'];

export function feedQuery(query, cursor = '', kind = '', sort = 'latest', creator = '') {
  const params = new URLSearchParams({limit: '12'});
  if (query) params.set('q', query);
  if (cursor) params.set('cursor', cursor);
  if (kind) params.set('kind', kind);
  if (sort === 'popular') params.set('sort', sort);
  if (creator) params.set('creator', creator);
  return params.toString();
}

// The feed tab, category, sort and search live in the URL so a filtered feed can be
// shared and survives a refresh. `?tab=agents` stays the catalog switch, and the
// default 动态 feed keeps an empty query string.
export function feedStateFromSearch(search) {
  const params = new URLSearchParams(typeof search === 'string' ? search : '');
  const feed = params.get('feed');
  const tab = feed === 'following' || feed === 'collected' ? feed : 'activity';
  const requestedKind = params.get('kind');
  const kind = FEED_KINDS.includes(requestedKind) ? requestedKind : '';
  const requestedCreator = params.get('creator');
  const creator = CREATOR_HANDLE.test(requestedCreator || '') ? requestedCreator : '';
  return {
    tab,
    kind,
    sort: tab === 'activity' && !kind && !creator && params.get('sort') === 'popular' ? 'popular' : 'latest',
    query: (params.get('q') || '').slice(0, 80),
    ...(creator ? {creator} : {}),
  };
}

export function feedSearchText(state) {
  const params = new URLSearchParams();
  const tab = state && state.tab;
  if (tab === 'following' || tab === 'collected') params.set('feed', tab);
  if (state && state.kind && FEED_KINDS.includes(state.kind)) params.set('kind', state.kind);
  if (tab === 'activity' && !state.kind && !state.creator && state.sort === 'popular') params.set('sort', 'popular');
  if (state && state.query) params.set('q', state.query);
  if (state && CREATOR_HANDLE.test(state.creator || '')) params.set('creator', state.creator);
  const text = params.toString();
  return text ? '?' + text : '';
}

export function workDetailFromSearch(search) {
  const params = new URLSearchParams(search || '');
  const slug = params.get('work');
  if (params.getAll('work').length !== 1 || !validSlug(slug)) return null;
  return {slug, comments: params.get('comments') === '1', share: params.get('share') === '1'};
}

export function workDetailSearchText(state, {slug, comments = false, share = false}) {
  const params = new URLSearchParams(feedSearchText(state));
  if (validSlug(slug)) {
    params.set('work', slug);
    if (comments) params.set('comments', '1');
    if (share) params.set('share', '1');
  }
  return params.size ? '?' + params : '';
}

function workDetailQuery(state) {
  const params = new URLSearchParams(feedSearchText(state));
  const tab = params.get('feed');
  if (tab) {
    params.delete('feed');
    params.set('tab', tab);
  }
  return params.size ? '?' + params : '';
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

const KIND_LABELS = {document:'文档',website:'网页',slides:'幻灯片',audio:'音频',video:'视频',model3d:'3D 作品',whiteboard:'白板',dashboard:'看板',media:'媒体'};

// Native public works expose plain text. Other public previews can include a
// structured thumbnail. Normalize both while keeping the listing body-free.
function normalizeFeedPreview(preview) {
  if (typeof preview !== 'string') return preview;
  const lines = preview.slice(0, 2000).split(/\r?\n/)
    .map(line => line.trim()).filter(Boolean).slice(0, 4);
  return {type: 'document', lines};
}

export function attachFeedThumb(document, cover, preview) {
  if (!cover || !preview || cover.classList.contains('has-thumb')) return false;
  const thumb = renderThumb(document, normalizeFeedPreview(preview));
  if (!thumb) return false;
  cover.classList.add('has-thumb');
  cover.append(thumb);
  return true;
}

export function feedPreviewPath(item) {
  if (!item || item.kind === 'image' || item.kind === 'model3d' || !validSlug(item.slug)) return '';
  return '/w/' + item.slug + '/preview';
}

export const FEED_DETAIL_MORE = '详情';
export const FEED_DETAIL_LOADING = '正在读取作品摘要…';
// A refused preview is not an empty work: the detail says which one it is.
export const FEED_DETAIL_UNREADABLE = '读不到作品摘要。';
export const FEED_DETAIL_NO_TEXT = '这件作品没有文字摘要，打开原作品看内容。';
export const FEED_DETAIL_EMPTY = '这件作品还没有内容。';

// The detail repeats what the listing already knows plus the bounded, text-only
// preview the public work page exposes. No body is read and stored HTML is
// never interpreted: thumbModel normalises it and every line goes through
// textContent.
export function detailExcerpt(preview) {
  const model = thumbModel(normalizeFeedPreview(preview));
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

function publicWorkPath(item) {
  if (!validSlug(item.slug)) return '';
  const path = '/w/' + item.slug;
  return item.path === '/social' + path ? item.path : path;
}

export function renderFeedCard(document, item) {
  const card = document.createElement('a');
  card.className = 'feed-card';
  card.href = publicWorkPath(item) || '/discover';
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
  const who = document.createElement('span');
  const when = formatFeedTime(item.updated);
  who.textContent = [item.author || '', when].filter(Boolean).join(' · ');
  meta.append(mark, who);
  if (item.likes != null) {
    const likes = document.createElement('span');
    likes.className = 'feed-likes';
    likes.textContent = '♡ ' + (item.likes || 0);
    meta.append(likes);
  }
  card.append(cover, kind, title, meta);
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
  const nativeCatalog = servedByDsBot(document);
  let currentUser = null;
  let sessionRequest = 0;
  let sessionPending;
  let sessionState = 'pending';
  let workspaceListState = 'loading';
  let catalog = [];
  const catalogViewers = new WeakMap();
  const catalogActions = new Map();
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
  const manageParams = new URLSearchParams(location?.search || '');
  const manageWorkspace = manageParams.get('workspace');
  const manageAgent = manageParams.get('agent');
  const teamsView = isTeamsCatalog(location);
  const catalogView = agentsView || teamsView;
  const initialFeed = feedStateFromSearch(catalogView ? '' : location?.search);

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
    if (createAgent) createAgent.hidden = !agentsView || !currentUser;
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

  const feedState = {...initialFeed, items: [], cursor: '', loading: false};
  let feedRequest = 0;
  let feedViewer;
  const feedActions = new Map();
  const commentButtons = new Map();
  const workTriggers = new Map();
  const detail = Object.fromEntries([
    'back', 'paper', 'title', 'meta', 'status', 'retry', 'preview', 'actions', 'open',
    'like', 'collect', 'follow', 'comments', 'share', 'previous', 'next',
  ].map(name => [name, document.getElementById('work-detail-' + name)]));
  const share = Object.fromEntries(['dialog', 'url', 'status', 'copy', 'native', 'close']
    .map(name => [name, document.getElementById('work-share-' + name)]));
  const detailPanel = document.getElementById('work-detail');
  const initialView = document.getElementById('main');
  const engagement = [['like', 'liked', '点赞'], ['collect', 'collected', '收录'], ['follow', 'following', '关注作者']];
  let activeWork;
  let feedReturn;

  const workComments = mountWorkComments(document, {
    request,
    onCount(slug, count) {
      const item = feedState.items.find(work => work.slug === slug);
      if (item) item.comment_count = count;
      const button = commentButtons.get(slug);
      if (button) button.textContent = commentsLabel(count);
      if (activeWork?.item?.slug === slug) {
        activeWork.item.comment_count = count;
        detail.comments.textContent = commentsLabel(count);
      }
    },
  });

  function setWorkView(open) {
    detailPanel.hidden = !open;
    document.getElementById('feed-panel').hidden = open;
    document.getElementById('discover-title').hidden = open;
    document.getElementById('discover-tabs').hidden = open;
  }

  function disposeWorkPreview() {
    activeWork?.model?.setSource('');
    detail.preview.replaceChildren();
  }

  function closeWorkDetail({restore = true} = {}) {
    if (!activeWork) return;
    disposeWorkPreview();
    workComments.close();
    if (share.dialog.open) share.dialog.close();
    activeWork = null;
    setWorkView(false);
    if (restore && feedReturn) {
      const target = feedReturn.trigger?.isConnected
        ? feedReturn.trigger : workTriggers.get(feedReturn.slug) || document.getElementById('discover-title');
      initialView.scrollTop = feedReturn.scroll;
      target?.focus?.({preventScroll: true});
    } else {
      initialView.scrollTop = 0;
      document.getElementById('discover-title')?.focus?.({preventScroll: true});
    }
    feedReturn = null;
  }

  function activeWorkEntry(entry) {
    return activeWork === entry && entry.scope === sessionRequest;
  }

  function matchesNativeViewer(name, account = currentUser) {
    return typeof name === 'string' && VIEWER_USERNAME.test(name) && name === account?.username;
  }

  function setAdjacent(entry, name, neighbor) {
    const slug = validSlug(neighbor?.slug) && neighbor.slug !== entry.slug ? neighbor.slug : '';
    entry[name] = slug;
    const button = detail[name];
    button.disabled = !slug;
    button.title = slug ? String(neighbor.title || '') : '';
  }

  function workUrl(intent) {
    return '/discover' + workDetailSearchText(feedState, intent);
  }

  async function openWorkDetail(intent, {item, trigger, navigate = false} = {}) {
    if (!intent || !validSlug(intent.slug)) return;
    const existing = activeWork;
    if (!existing) {
      feedReturn = {scroll: initialView.scrollTop || 0, trigger, slug: intent.slug};
    }
    if (navigate) {
      const url = workUrl(intent);
      if (existing) history?.replaceState?.(history.state, '', url);
      else history?.pushState?.({discoverWork: true}, '', url);
    }

    disposeWorkPreview();
    workComments.close();
    if (share.dialog.open) share.dialog.close();
    const entry = {slug: intent.slug, item: null, intent, scope: sessionRequest, outcome: 'loading'};
    activeWork = entry;
    setWorkView(true);
    initialView.scrollTop = 0;
    detail.title.textContent = item?.title || '作品详情';
    detail.meta.textContent = item ? detailMetaText(item) : '';
    detail.status.textContent = '正在加载作品…';
    detail.retry.hidden = true;
    detail.actions.hidden = true;
    detail.comments.hidden = true;
    detail.paper.setAttribute('aria-busy', 'true');
    setAdjacent(entry, 'previous');
    setAdjacent(entry, 'next');
    setWorkEngagement(entry);
    detail.title.focus?.({preventScroll: true});

    const checkingSession = sessionPending;
    const publicRead = !currentUser ? loadPublicWork(entry) : null;
    if (checkingSession) await checkingSession;
    if (!activeWorkEntry(entry)) return;
    const viewer = currentUser;
    if (!viewer) {
      const result = await publicRead;
      if (!activeWorkEntry(entry)) return;
      if (!entry.item) return failWorkDetail(entry, result.status);
      return finishWorkDetail(entry, null);
    }

    const path = '/v1/discover/works/' + intent.slug + workDetailQuery(feedState);
    const readScopedWork = () => request('GET', path).catch(() => ({status: 0}));
    const wrongViewer = result => nativeCatalog && result.status === 200 &&
      !matchesNativeViewer(result.body?.viewer_username, viewer);
    let result = await readScopedWork();
    if (!activeWorkEntry(entry) || currentUser !== viewer) return;
    // The scoped request can have used a different account while the session was changing.
    if (wrongViewer(result)) result = await readScopedWork();
    if (!activeWorkEntry(entry) || currentUser !== viewer) return;
    if (result.status === 404) return failWorkDetail(entry, 404);
    if (result.status !== 200 || result.body?.work?.slug !== entry.slug || wrongViewer(result)) {
      failWorkDetail(entry, result.status);
      return publicRead;
    }

    entry.outcome = 'confirmed';
    showWork(entry, result.body.work);
    return finishWorkDetail(entry, viewer, result.body);
  }

  async function loadPublicWork(entry) {
    const path = '/w/' + entry.slug + (nativeCatalog ? '?view=preview' : '');
    const result = await request('GET', path).catch(() => ({status: 0}));
    if (!activeWorkEntry(entry) || entry.outcome === 'confirmed' || entry.outcome === 'denied') return result;
    const work = result.body;
    if (result.status !== 200 || work?.slug !== entry.slug ||
        typeof work.title !== 'string' || typeof work.kind !== 'string') return result;

    showWork(entry, work, work.preview);
    if (entry.outcome === 'unavailable') failWorkDetail(entry, 0);
    else if (entry.outcome === 'loading') detail.status.textContent = '';
    return result;
  }

  function showWork(entry, work, inlinePreview) {
    entry.item = work;
    detail.title.textContent = work.title || work.slug;
    detail.meta.textContent = detailMetaText(work);
    detail.open.href = publicWorkPath(work);
    detail.actions.hidden = false;
    detail.paper.setAttribute('aria-busy', 'false');
    const key = JSON.stringify([work.slug, work.kind, work.title, work.updated, work.site_available === true,
      work.kind === 'model3d' ? publicWorkPath(work) : '']);
    if (key !== entry.previewKey) {
      disposeWorkPreview();
      entry.previewKey = key;
      entry.preview = renderWorkPreview(entry, work, key, inlinePreview);
    }
  }

  function finishWorkDetail(entry, viewer, {previous, next} = {}) {
    entry.ready = true;
    entry.viewer = viewer;
    detail.status.textContent = '';
    detail.retry.hidden = true;
    detail.comments.hidden = false;
    detail.comments.textContent = commentsLabel(entry.item.comment_count);
    setWorkEngagement(entry);
    setAdjacent(entry, 'previous', previous);
    setAdjacent(entry, 'next', next);
    if (entry.intent.comments) return Promise.all([entry.preview, workComments.open(entry.item, detail.comments)]);
    if (entry.intent.share) openWorkShare();
    return entry.preview;
  }

  function failWorkDetail(entry, status) {
    entry.outcome = status === 404 ? 'denied' : 'unavailable';
    detail.paper.setAttribute('aria-busy', 'false');
    if (entry.outcome === 'denied') {
      disposeWorkPreview();
      entry.item = null;
      detail.title.textContent = '作品详情';
      detail.meta.textContent = '';
      detail.actions.hidden = true;
    }
    detail.status.textContent = entry.outcome === 'denied'
      ? '这件作品已下架或不可访问。'
      : entry.item ? '公开预览可用。无法加载互动功能，请重试。' : '无法打开作品，请重试。';
    detail.retry.hidden = entry.outcome === 'denied';
  }

  function setWorkEngagement(entry) {
    const canEngage = Boolean(entry.viewer && entry.viewer === currentUser);
    for (const [action, flag, label] of engagement) {
      const button = detail[action];
      button.hidden = !canEngage || (action === 'follow' && entry.item.own_work);
      button.disabled = !canEngage || Boolean(entry.saving);
      if (canEngage) {
        button.textContent = engagementLabel(entry.item, action, flag, label);
        button.setAttribute('aria-pressed', String(Boolean(entry.item[flag])));
      }
    }
  }

  async function updateWorkEngagement(action, flag) {
    const entry = activeWork;
    if (!entry?.item || entry.saving || !entry.viewer || entry.viewer !== currentUser) return;
    const me = currentUser;
    const enabled = !entry.item[flag];
    entry.saving = action;
    detail.status.textContent = '';
    setWorkEngagement(entry);
    const result = await request('POST', '/v1/discover/works/' + entry.slug + '/engagement', {action, enabled})
      .catch(() => ({status: 0}));
    if (currentUser !== me) return;
    entry.saving = '';
    if (result.status === 200) {
      const changes = result.body?.engagement || result.body || {};
      entry.item[flag] = changes[flag] ?? enabled;
      if (action === 'like') entry.item.likes = changes.likes ?? Math.max(0, (entry.item.likes || 0) + (enabled ? 1 : -1));
      for (const item of feedState.items) {
        if (item.slug === entry.slug || (action === 'follow' && entry.item.author && item.author === entry.item.author)) {
          item[flag] = entry.item[flag];
          if (action === 'like') item.likes = entry.item.likes;
        }
      }
      if (action === 'collect' && !enabled && feedState.tab === 'collected') {
        feedState.items = feedState.items.filter(item => item.slug !== entry.slug);
      }
      if (action === 'follow' && !enabled && feedState.tab === 'following') {
        feedState.items = feedState.items.filter(item => item.slug !== entry.slug && (!entry.item.author || item.author !== entry.item.author));
      }
      renderFeed();
    }
    if (activeWork !== entry) return;
    if (result.status !== 200) detail.status.textContent = '操作未保存，请重试。';
    setWorkEngagement(entry);
  }

  function openWorkShare() {
    if (!activeWork?.item) return;
    const slug = activeWork.slug;
    const origin = location?.origin || window?.location?.origin;
    share.url.value = origin ? new URL('/w/' + slug, origin).href : '/w/' + slug;
    share.status.textContent = '';
    const navigator = window?.navigator;
    share.native.hidden = !navigator?.share || (navigator.canShare && !navigator.canShare({url: share.url.value}));
    if (!share.dialog.open) share.dialog.showModal();
  }

  async function copyWorkShare() {
    const value = share.url.value;
    try {
      const clipboard = window?.navigator?.clipboard;
      if (!clipboard?.writeText) throw new Error('Clipboard unavailable');
      await clipboard.writeText(value);
      if (share.dialog.open && share.url.value === value) share.status.textContent = '已复制链接。';
    } catch {
      if (!share.dialog.open || share.url.value !== value) return;
      share.url.focus?.();
      share.url.select?.();
      share.status.textContent = '可手动复制已选中的链接。';
    }
  }

  detail.back.addEventListener('click', () => {
    if (history?.state?.discoverWork && typeof history.back === 'function') {
      history.back();
      return;
    }
    history?.replaceState?.(null, '', feedUrl());
    closeWorkDetail();
  });
  for (const name of ['previous', 'next']) {
    detail[name].addEventListener('click', () => {
      const slug = activeWork?.[name];
      if (slug) return openWorkDetail({slug}, {navigate: true});
    });
  }
  detail.retry.addEventListener('click', () => activeWork && openWorkDetail(activeWork.intent));
  detail.comments.addEventListener('click', () => {
    if (activeWork?.ready && activeWorkEntry(activeWork)) return workComments.open(activeWork.item, detail.comments);
  });
  detail.share.addEventListener('click', openWorkShare);
  for (const [action, flag] of engagement) {
    detail[action].addEventListener('click', () => updateWorkEngagement(action, flag));
  }
  share.close.addEventListener('click', () => share.dialog.close());
  share.copy.addEventListener('click', copyWorkShare);
  share.native.addEventListener('click', async () => {
    const url = share.url.value;
    try { await window.navigator.share({title: activeWork.item.title, url}); }
    catch (error) {
      if (error?.name !== 'AbortError' && share.dialog.open && share.url.value === url) {
        share.status.textContent = '无法打开系统分享，可复制链接。';
      }
    }
  });

  function loadDiscoverRoute() {
    const intent = workDetailFromSearch(location?.search);
    if (intent) return Promise.all([loadFeed(), openWorkDetail(intent)]);
    closeWorkDetail();
    return loadFeed();
  }

  function applyFeedChrome({restoreQuery = false} = {}) {
    for (const name of ['following', 'activity', 'collected']) {
      const button = document.getElementById('feed-tab-' + name);
      if (button) button.setAttribute('aria-selected', name === feedState.tab ? 'true' : 'false');
    }
    const popular = feedState.tab === 'activity' && feedState.sort === 'popular';
    const popularButton = document.getElementById('feed-sort-popular');
    if (popularButton) {
      popularButton.hidden = feedState.tab !== 'activity' || Boolean(feedState.creator);
      popularButton.setAttribute('aria-current', String(popular));
    }
    const creatorFilter = document.getElementById('feed-creator-filter');
    if (creatorFilter) {
      creatorFilter.hidden = !feedState.creator;
      creatorFilter.textContent = feedState.creator ? '@' + feedState.creator + ' ×' : '';
      creatorFilter.setAttribute('aria-label', feedState.creator ? '清除作者筛选 @' + feedState.creator : '清除作者筛选');
    }
    for (const kind of FEED_KINDS) {
      const node = document.getElementById('feed-kind-' + (kind || 'all'));
      if (node) node.setAttribute('aria-current', String(!popular && kind === feedState.kind));
    }
    if (restoreQuery) {
      const input = document.getElementById('feed-query');
      if (input) input.value = feedState.query;
    }
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
      const next = feedStateFromSearch(location?.search);
      const feedChanged = feedSearchText(next) !== feedSearchText(feedState);
      Object.assign(feedState, {creator: '', ...next});
      applyFeedChrome({restoreQuery: true});
      const intent = workDetailFromSearch(location?.search);
      if (!intent) {
        workComments.close();
        closeWorkDetail({restore: !feedChanged});
      }
      if (feedChanged) {
        feedReturn = null;
        return loadDiscoverRoute();
      }
      if (intent) return openWorkDetail(intent);
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
    if (feedState.loading) {
      note.textContent = '';
      return;
    }
    if (feedState.tab !== 'activity' && !currentUser) note.textContent = '请先登录，再查看关注或收录作品。';
    else if (feedState.tab === 'following') note.textContent = FEED_FOLLOWING_NOTE;
    else if (feedState.tab === 'collected') note.textContent = '这里只展示你收录且仍公开的作品。';
    else note.textContent = (feedState.query || feedState.kind || feedState.creator) && !feedState.items.length
      ? FEED_SEARCH_EMPTY_NOTE : (feedState.items.length ? FEED_ACTIVITY_LISTED_NOTE : FEED_ACTIVITY_EMPTY_NOTE);
  }

  const previewCache = new Map();
  const pendingCovers = new Map();
  const coverObserver = window?.IntersectionObserver ? new window.IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting || !pendingCovers.has(entry.target)) continue;
      const item = pendingCovers.get(entry.target);
      pendingCovers.delete(entry.target);
      coverObserver.unobserve(entry.target);
      loadThumb(entry.target, item);
    }
  }, {rootMargin: '160px 0px'}) : null;

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

  function loadThumb(cover, item) {
    cachedPreview(item).then(result => {
      if (cover.isConnected !== false) attachFeedThumb(document, cover, result.preview);
    }).catch(() => {});
  }

  function hydrateThumb(cover, item) {
    if (!cover || !feedPreviewPath(item)) return;
    if (coverObserver) {
      pendingCovers.set(cover, item);
      coverObserver.observe(cover);
    } else {
      loadThumb(cover, item);
    }
  }

  function attachModel3dDetail(panel, slug, url) {
    const actions = document.createElement('div');
    actions.className = 'feed-model3d-actions';
    const preview = document.createElement('div');
    preview.id = 'feed-model3d-preview-' + slug;
    preview.className = 'feed-model3d-preview';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'feed-model3d-preview-toggle';
    toggle.setAttribute('aria-controls', preview.id);
    const download = document.createElement('a');
    download.className = 'feed-detail-open feed-model3d-download';
    download.href = url;
    download.download = '';
    download.textContent = '下载 GLB';
    const status = document.createElement('p');
    status.className = 'feed-model3d-status';
    status.setAttribute('role', 'status');
    actions.append(toggle, download);
    panel.append(actions, status, preview);
    return bindModel3dPreview(toggle, preview, status, {onReady() {
      if (!window?.matchMedia?.('(max-width: 700px)')?.matches) return;
      const viewport = document.getElementById('main')?.getBoundingClientRect();
      if (!viewport) return;
      const trigger = toggle.getBoundingClientRect();
      // Respect any scrolling the viewer did while the model loaded.
      if (trigger.bottom <= viewport.top || trigger.top >= viewport.bottom) return;
      const model = preview.getBoundingClientRect();
      if (model.top < viewport.top || model.bottom > viewport.bottom) {
        panel.scrollIntoView({block: 'nearest', inline: 'nearest', behavior: 'instant'});
      }
    }});
  }

  function engagementLabel(item, action, flag, label) {
    return (item[flag] ? '取消' : '') + label + (action === 'like' ? ' · ' + (item.likes || 0) : '');
  }

  async function renderWorkPreview(entry, item, key, inlinePreview) {
    const stillShowing = () => activeWorkEntry(entry) && entry.previewKey === key && entry.outcome !== 'denied';
    if (item.kind === 'website' && item.site_available === true) {
      const frame = document.createElement('iframe');
      frame.className = 'work-detail-site';
      frame.title = (item.title || '网站') + ' · 互动预览';
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.src = '/w/' + item.slug + '/site';
      detail.preview.append(frame);
      return;
    }
    if (item.kind === 'model3d') {
      const file = publicWorkPath(item) + '/file';
      entry.model = attachModel3dDetail(detail.preview, item.slug, file);
      entry.model.setSource(file);
      return;
    }
    if (item.kind === 'image') {
      const image = document.createElement('img');
      image.src = '/w/' + item.slug + '/file';
      image.alt = item.title || '公开作品图片';
      image.className = 'work-detail-image';
      image.addEventListener('error', () => {
        if (stillShowing()) detail.preview.textContent = '暂时无法显示图片。';
      });
      detail.preview.append(image);
      return;
    }
    detail.preview.textContent = FEED_DETAIL_LOADING;
    const result = inlinePreview === undefined ? await cachedPreview(item) : {ok: true, preview: inlinePreview};
    if (!stillShowing()) return;
    if (!result.ok) { detail.preview.textContent = FEED_DETAIL_UNREADABLE; return; }
    if (!result.preview) { detail.preview.textContent = FEED_DETAIL_NO_TEXT; return; }
    const lines = detailExcerpt(result.preview);
    if (!lines.length) { detail.preview.textContent = FEED_DETAIL_EMPTY; return; }
    const list = document.createElement('ul');
    list.className = 'feed-detail-lines';
    for (const line of lines) {
      const row = document.createElement('li');
      row.textContent = line;
      list.append(row);
    }
    detail.preview.replaceChildren(list);
  }

  function bindWorkDetail(actions, card, item) {
    if (!validSlug(item.slug)) return;
    const options = {item, navigate: true};
    const intent = {slug: item.slug};
    card.href = workUrl(intent);
    card.addEventListener('click', event => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      return openWorkDetail(intent, {...options, trigger: card});
    });
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'feed-detail-toggle';
    button.textContent = FEED_DETAIL_MORE;
    button.setAttribute('aria-controls', 'work-detail');
    button.addEventListener('click', () => openWorkDetail(intent, {...options, trigger: button}));
    actions.append(button);
    workTriggers.set(item.slug, card);
  }

  function matchesFeedViewer(viewer) {
    return nativeCatalog ? matchesNativeViewer(viewer) : Boolean(currentUser && viewer === currentUser);
  }

  function addFeedEngagement(item, actions) {
    const viewer = currentUser;
    if (!matchesFeedViewer(feedViewer) || actions.viewer === viewer) return;
    actions.viewer = viewer;
    const buttons = [];
    for (const [action, flag, label] of engagement) {
      if (action === 'follow' && item.own_work) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = action === 'like' ? '点赞 · ' + (item.likes || 0) : action === 'follow' ? '关注' : label;
      button.setAttribute('aria-label', engagementLabel(item, action, flag, label));
      button.setAttribute('aria-pressed', String(Boolean(item[flag])));
      const isCurrent = () => viewer === currentUser && feedActions.get(item) === actions;
      button.addEventListener('click', async () => {
        if (!isCurrent() || button.disabled) return;
        button.disabled = true;
        const result = await request('POST', `/v1/discover/works/${item.slug}/engagement`, {action, enabled: !item[flag]})
          .catch(() => ({status: 0}));
        if (!isCurrent()) return;
        button.disabled = false;
        if (result.status !== 200) {
          const error = document.getElementById('feed-error');
          error.hidden = false;
          error.textContent = '操作未保存，请重试。';
          return;
        }
        await loadFeed();
      });
      buttons.push(button);
    }
    actions.element.prepend(...buttons);
  }

  function renderFeed(start = 0) {
    const grid = document.getElementById('feed-grid');
    if (!grid) return;
    if (start === 0) {
      coverObserver?.disconnect();
      pendingCovers.clear();
      commentButtons.clear();
      workTriggers.clear();
      feedActions.clear();
      grid.replaceChildren();
    }
    for (const item of feedState.items.slice(start)) {
      const card = renderFeedCard(document, item);
      const cover = typeof card.querySelector === 'function' ? card.querySelector('.work-cover') : null;
      hydrateThumb(cover, item);
      const entry = document.createElement('article');
      entry.className = 'feed-entry';
      entry.append(card);
      const actions = document.createElement('div');
      actions.className = 'feed-card-actions';
      if (validSlug(item.slug)) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'feed-comments-toggle';
        button.textContent = commentsLabel(item.comment_count);
        button.setAttribute('aria-haspopup', 'dialog');
        button.setAttribute('aria-controls', 'feed-comments-dialog');
        button.addEventListener('click', () => {
          return workComments.open(item, button);
        });
        actions.append(button);
        commentButtons.set(item.slug, button);
        const controls = {element: actions, viewer: null};
        feedActions.set(item, controls);
        addFeedEngagement(item, controls);
        bindWorkDetail(actions, card, item);
        entry.append(actions);
      }
      grid.append(entry);
    }
    grid.dataset.empty = feedState.items.length ? 'false' : 'true';
    updateFeedStatus();
  }

  function updateFeedStatus() {
    document.getElementById('feed-activity-empty')?.setAttribute('aria-busy', String(feedState.loading));
    const count = document.getElementById('feed-count');
    if (count) {
      if (feedState.loading && feedState.cursor) count.textContent = '正在加载更多作品…';
      else if (feedState.loading && !feedState.items.length) count.textContent = '正在加载作品…';
      else count.textContent = feedState.items.length ? '已显示 ' + feedState.items.length + ' 件公开作品' : '';
    }
    const more = document.getElementById('feed-more');
    if (more) {
      more.hidden = !feedState.cursor;
      more.disabled = feedState.loading || Boolean(nativeCatalog && sessionPending);
    }
    applyFeedNote();
  }

  async function loadFeed({append = false, retainItems = false, retryViewer = true} = {}) {
    if (feedState.loading && append) return;
    const seq = ++feedRequest;
    if (!append) {
      if (!retainItems) feedState.items = [];
      feedState.cursor = '';
      feedViewer = undefined;
    }
    const needsViewer = feedState.tab !== 'activity';
    const waitingForViewer = needsViewer && !currentUser;
    feedState.loading = !waitingForViewer || Boolean(sessionPending);
    const error = document.getElementById('feed-error');
    if (error) {
      error.hidden = true;
      error.textContent = '';
    }
    if (append || retainItems) updateFeedStatus();
    else renderFeed();
    if (waitingForViewer) return;
    // The native all-works route includes the same viewer state as /me/works?tab=all.
    const viewer = currentUser;
    const privateFeed = needsViewer || (viewer && !nativeCatalog);
    const sort = needsViewer ? 'latest' : feedState.sort;
    const params = feedQuery(feedState.query, feedState.cursor, feedState.kind, sort, feedState.creator);
    const tab = feedState.tab === 'activity' ? 'all' : feedState.tab;
    const path = privateFeed ? `/v1/discover/me/works?${params}&tab=${tab}` : `/v1/discover/works?${params}`;
    let result;
    try { result = await request('GET', path); }
    catch { result = {status: 0, body: {}}; }
    if (seq !== feedRequest) return;
    feedState.loading = false;
    if (append && sort === 'popular' && result.status === 409 && result.body?.error?.code === 'popularity_expired') {
      return loadFeed();
    }
    if (result.status !== 200) {
      if (error) {
        error.hidden = false;
        error.textContent = (result.body && result.body.error && result.body.error.message)
          || '无法加载公开作品。';
      }
      updateFeedStatus();
      return;
    }
    const name = result.body?.viewer_username;
    const nativeViewer = typeof name === 'string' && VIEWER_USERNAME.test(name) ? name : null;
    const mismatch = nativeCatalog && currentUser && !matchesFeedViewer(nativeViewer);
    if (mismatch && (needsViewer || append)) {
      if (retryViewer) return loadFeed({retryViewer: false});
      if (error) {
        error.hidden = false;
        error.textContent = '登录状态已变化，刷新页面后重试。';
      }
      updateFeedStatus();
      return;
    }
    const start = append ? feedState.items.length : 0;
    const incoming = catalogItems(result.body);
    if (append) {
      const seen = new Set(feedState.items.map(item => item.slug));
      for (const item of incoming) {
        if (seen.has(item.slug)) continue;
        feedState.items.push(item);
        seen.add(item.slug);
      }
    } else {
      feedState.items = incoming;
    }
    feedViewer = nativeCatalog ? nativeViewer : (privateFeed ? viewer : null);
    feedState.cursor = mismatch ? '' : result.body?.cursor || '';
    renderFeed(start);
    if (mismatch && retryViewer) return loadFeed({retainItems: true, retryViewer: false});
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
    if (!canUseCatalogItem(item)) {
      if (sessionState === 'guest') show('error', '请登录后复制智能体。');
      return;
    }
    const entry = {slug: item.slug, key: reuseKey(), template: null, viewer: currentUser};
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
      if (remix !== entry || !remixDialog.open || currentUser !== entry.viewer) return;
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
    if (remixLoading || !entry?.template || entry.viewer !== currentUser || !remixWorkspace.value) return;
    remixLoading = true;
    remixSubmit.disabled = true;
    remixStatus.textContent = '正在创建副本…';
    try {
      const result = await request('POST', '/v1/discover/agents/' + entry.slug + '/remix', {
        revision: entry.template.revision, workspace_id: remixWorkspace.value, name: remixName.value.trim(),
      }, {'Idempotency-Key': entry.key});
      if (remix !== entry || currentUser !== entry.viewer) return;
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
      if (remix === entry && currentUser === entry.viewer) {
        remixLoading = false;
        syncRemixWorkspaces();
      }
    }
  }

  function canUseCatalogItem(item) {
    const viewer = catalogViewers.get(item);
    return Boolean(currentUser && catalogActions.has(item) && validSlug(item.slug) &&
      (nativeCatalog ? matchesNativeViewer(viewer) : viewer === sessionRequest));
  }

  async function confirmCatalogViewer(page) {
    if (page.session) await page.session;
    const viewer = currentUser;
    if (!viewer || page.scope !== sessionRequest || page.catalog !== catalog ||
        matchesNativeViewer(page.viewer, viewer) || !matchesNativeViewer(viewer.username, viewer)) return;
    const response = await request('GET', page.path).catch(() => ({status: 0}));
    if (viewer !== currentUser || page.scope !== sessionRequest || page.catalog !== catalog ||
        response.status !== 200 || !matchesNativeViewer(response.body?.viewer_username, viewer)) return;
    const verified = new Map(catalogItems(response.body).filter(item => validSlug(item?.slug)).map(item => [item.slug, item]));
    for (const item of page.items) {
      const match = verified.get(item.slug);
      if (!match) continue;
      catalogViewers.set(item, viewer.username);
      item.chat_enabled = match.chat_enabled;
      item.own_agent = match.own_agent;
    }
    syncCatalogActions();
  }

  function syncCatalogActions() {
    for (const [item, actions] of catalogActions) {
      const viewer = canUseCatalogItem(item) ? currentUser : null;
      const guest = sessionState === 'guest' && validSlug(item.slug);
      if (actions.viewer === viewer && actions.guest === guest) continue;
      actions.viewer = viewer;
      actions.guest = guest;
      const holder = actions.element;
      holder.replaceChildren();
      holder.hidden = !viewer && !guest;
      if (holder.hidden) continue;
      const use = document.createElement('button');
      use.type = 'button';
      use.className = 'catalog-use';
      use.textContent = '复制';
      use.setAttribute('aria-label', '复制智能体：' + (item.name || item.slug));
      use.addEventListener('click', () => openRemix(item));
      if (viewer && item.chat_enabled && !item.own_agent) {
        const chat = document.createElement('a');
        chat.href = '/chat#public-agent=' + item.slug;
        chat.className = 'catalog-chat';
        chat.textContent = '聊天';
        chat.setAttribute('aria-label', '和 ' + (item.name || item.slug) + ' 聊天');
        chat.addEventListener('click', event => {
          if (currentUser !== viewer || !canUseCatalogItem(item)) event.preventDefault();
        });
        holder.append(chat);
      }
      holder.append(use);
    }
  }

  function renderCatalog(items, start = 0) {
    const list = document.getElementById('discover-list');
    if (!start) {
      list.replaceChildren();
      catalogActions.clear();
    }
    document.getElementById('discover-empty').hidden = items.length > 0;
    for (const item of items.slice(start)) {
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
      const label = item.name || item.slug;
      if (validSlug(item.slug)) {
        const profile = document.createElement('a');
        profile.className = 'catalog-profile';
        profile.href = '/a/' + item.slug;
        profile.textContent = label;
        name.append(profile);
      } else {
        name.textContent = label;
      }
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
      const actions = document.createElement('div');
      actions.className = 'catalog-agent-actions';
      actions.hidden = true;
      catalogActions.set(item, {element: actions, viewer: null, guest: false});
      card.append(avatar, copy, actions);
      li.append(card);
      list.append(li);
    }
    syncCatalogActions();
  }

  async function loadCatalog(append = false) {
    const seq = ++catalogRequest;
    const scope = sessionRequest;
    const checkingSession = sessionPending;
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
      const path = catalogQuery(activeQuery, cursor, activeCategory, activeCreator?.handle);
      const listed = await request('GET', path);
      if (seq !== catalogRequest || scope !== sessionRequest) return;
      if (listed.status === 401 && checkingSession) {
        await checkingSession;
        if (seq !== catalogRequest || scope !== sessionRequest) return;
        if (currentUser) return loadCatalog(append);
      }
      if (listed.status !== 200) throw new Error(messageFor(listed.body.error, '无法加载公共目录。'));
      const viewer = nativeCatalog ? listed.body.viewer_username : scope;
      const known = new Set(catalog.map(item => item.slug));
      const start = catalog.length;
      for (const item of catalogItems(listed.body)) {
        if (!item || typeof item !== 'object' || known.has(item.slug)) continue;
        known.add(item.slug);
        catalogViewers.set(item, viewer);
        catalog.push(item);
      }
      cursor = listed.body.cursor || '';
      renderCatalog(catalog, start);
      more.hidden = !cursor;
      document.getElementById('discover-empty').textContent = activeQuery || activeCategory !== 'all' || activeCreator
        ? '没有匹配的智能体。' : '暂无公开智能体。';
      count.textContent = '已显示 ' + catalog.length + ' 个智能体' + (cursor ? '，还有更多' : '');
      if (nativeCatalog && catalog.length > start) {
        void confirmCatalogViewer({path, viewer, scope, session: checkingSession, catalog, items: catalog.slice(start)});
      }
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

  function renderManage(pairs, workspace = '') {
    const list = document.getElementById('manage-list');
    list.replaceChildren();
    document.getElementById('manage-empty').hidden = pairs.length > 0;
    const viewer = currentUser;
    const canManage = () => Boolean(viewer) && viewer === currentUser && workspaceSelect.value === workspace;
    for (const {agent, discover} of pairs) {
      const li = document.createElement('li');
      li.className = 'manage-row';
      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = agent.name;
      const state = document.createElement('span');
      state.className = 'state';
      const archived = Boolean(agent.archived || agent.native_deleted);
      state.textContent = archived ? '已归档 · 仍公开' : discover.listed ? '已发布' : '未发布';
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 30;
      input.placeholder = '公开地址';
      input.setAttribute('aria-label', agent.name + ' 的公开地址');
      input.value = discover.slug || '';
      input.disabled = archived;
      const options = document.createElement('div');
      options.className = 'catalog-publish-options';
      const label = document.createElement('label');
      const allow = document.createElement('input');
      allow.type = 'checkbox';
      allow.disabled = archived || !agent.instructions;
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
      publicChat.disabled = archived;
      chatLabel.append(publicChat, document.createTextNode('允许访客聊天'));
      const chatNote = document.createElement('p');
      chatNote.className = 'note';
      chatNote.textContent = '自动回复使用已发布的简介、指令和当前对话。你可以查看访客的对话。';
      chatNote.hidden = !publicChat.checked;
      publicChat.addEventListener('change', () => { chatNote.hidden = !publicChat.checked; });
      const quickLabel = document.createElement('label');
      const quickStarts = document.createElement('input');
      quickStarts.type = 'checkbox';
      quickStarts.disabled = archived || !agent.quick_starts?.length;
      quickStarts.checked = !quickStarts.disabled && discover.publish_quick_starts === true;
      quickLabel.append(quickStarts, document.createTextNode('公开快捷开场'));
      const quickNote = document.createElement('p');
      quickNote.className = 'note';
      quickNote.textContent = archived ? '取消发布后，访客将无法打开公开主页。'
        : quickStarts.disabled ? '先在智能体编辑页添加开场。'
          : '开场会显示在公开主页。访客选择后，可编辑再发送。';
      options.append(label, preview, chatLabel, chatNote, quickLabel, quickNote);
      const publish = document.createElement('button');
      publish.type = 'button';
      publish.hidden = archived;
      publish.textContent = discover.listed ? '更新发布' : '发布';
      publish.addEventListener('click', async () => {
        if (!canManage() || archived || publish.disabled) return;
        if (!validSlug(input.value.trim())) {
          show('error', 'slug 需为 3–30 个字符的小写字母、数字或连字符。');
          return;
        }
        publish.disabled = true;
        revoke.disabled = true;
        publish.textContent = '正在发布…';
        try {
          const result = await request(
            'POST', `/v1/workspaces/${workspace}/agents/${agent.id}/discover`,
            {slug: input.value.trim(), revision: agent.revision, copy_instructions: allow.checked,
              chat_enabled: publicChat.checked, publish_quick_starts: quickStarts.checked});
          if (!canManage()) return;
          if (result.status !== 201 && result.status !== 200) {
            show('error', messageFor(result.body.error, '无法发布。'));
            return;
          }
          show('ok', '已发布。');
          await Promise.all([loadCatalog(), loadManage()]);
        } catch {
          if (canManage()) show('error', '连接中断，请重试发布。');
        } finally {
          publish.disabled = false;
          revoke.disabled = !discover.listed;
          publish.textContent = discover.listed ? '更新发布' : '发布';
        }
      });
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.textContent = '取消发布';
      revoke.disabled = !discover.listed;
      revoke.addEventListener('click', async () => {
        if (!canManage() || revoke.disabled) return;
        const result = await request(
          'POST', `/v1/workspaces/${workspace}/agents/${agent.id}/discover/revoke`, {});
        if (!canManage()) return;
        if (result.status !== 200) {
          show('error', messageFor(result.body.error, '无法取消收录。'));
          return;
        }
        show('ok', '已取消发布。');
        await loadCatalog();
        await loadManage();
      });
      li.append(title, state, input, publish, revoke, options);
      if (discover.listed && validSlug(discover.slug)) {
        const homepage = document.createElement('a');
        homepage.href = '/a/' + discover.slug;
        homepage.textContent = '打开公开主页';
        options.append(homepage);
      }
      list.append(li);
    }
  }

  async function loadManage() {
    const seq = ++manageRequest;
    const id = workspaceSelect.value;
    if (!currentUser || !id) {
      renderManage([]);
      return;
    }
    const path = `/v1/workspaces/${id}/agents?limit=100&include_archived=1`;
    const listed = await request('GET', path);
    if (seq !== manageRequest) return;
    if (listed.status !== 200) {
      renderManage([]);
      return;
    }
    const agents = [...(listed.body.items || [])];
    if (/^[0-9a-f]{32}$/.test(listed.body.cursor || '')) {
      const more = await request('GET', path + '&cursor=' + listed.body.cursor);
      if (seq !== manageRequest) return;
      if (more.status === 200) agents.push(...(more.body.items || []));
    }
    const statuses = await Promise.all(agents.map(agent =>
      request('GET', `/v1/workspaces/${id}/agents/${agent.id}/discover`)
        .then(result => (result.status === 200 ? result.body.discover : {listed: false}))));
    if (seq === manageRequest) {
      const pairs = agentDiscoverPairs(agents, statuses);
      const index = id === manageWorkspace ? pairs.findIndex(({agent}) => agent.id === manageAgent) : -1;
      if (index > 0) pairs.unshift(...pairs.splice(index, 1));
      renderManage(pairs, id);
    }
  }

  async function load() {
    const attempt = ++sessionRequest;
    currentUser = null;
    sessionState = 'pending';
    workComments.setActor('');
    syncCatalogActions();
    if (remixDialog.open) remixDialog.close();
    remix = null;
    remixLoading = false;
    manageRequest++;
    document.getElementById('catalog-manage').hidden = true;
    if (agentsView) {
      workspaceListState = 'loading';
      workspaceSelect.replaceChildren();
      renderManage([]);
    }
    const whoami = document.getElementById('whoami');
    whoami.textContent = '';
    showDiscoverView();
    const sessionLoad = request('GET', '/v1/auth/session').catch(() => ({status: 0})).then(session => {
      if (attempt !== sessionRequest) return;
      sessionPending = null;
      currentUser = session.status === 200 ? session.body?.user || null : null;
      sessionState = currentUser ? 'signed-in' : session.status === 401 ? 'guest' : 'failed';
      whoami.textContent = currentUser?.username || '';
      workComments.setActor(currentUser?.id || currentUser?.username || '');
      applyCatalogChrome();
      syncCatalogActions();
    });
    sessionPending = sessionLoad;
    const detailIntent = catalogView ? null : workDetailFromSearch(location?.search);
    const detailLoad = detailIntent ? openWorkDetail(detailIntent) : closeWorkDetail();
    if (!teamsView) mainPanel.hidden = false;
    const feedLoad = catalogView ? null : loadFeed();
    const initialFeedRequest = feedRequest;
    const directoryLoad = agentsView ? loadCatalog() : null;
    await sessionLoad;
    if (attempt !== sessionRequest) return;
    loginPanel.hidden = Boolean(currentUser);
    mainPanel.hidden = false;
    show('', '');
    if (!catalogView) {
      if (feedState.tab !== 'activity') return Promise.all([loadFeed(), detailLoad]);
      if (currentUser && !nativeCatalog) return Promise.all([loadFeed({retainItems: true}), detailLoad]);
      if (nativeCatalog && currentUser && feedViewer !== undefined) {
        if (!matchesFeedViewer(feedViewer)) return Promise.all([loadFeed({retainItems: true, retryViewer: false}), detailLoad]);
        for (const [item, actions] of feedActions) addFeedEngagement(item, actions);
      }
      updateFeedStatus();
      return Promise.all([feedRequest === initialFeedRequest ? feedLoad : null, detailLoad]);
    }
    if (!currentUser) {
      if (teamsView) await loadTeams();
      await directoryLoad;
      return;
    }
    document.getElementById('catalog-manage').hidden = !agentsView;
    if (agentsView) {
      const listed = await request('GET', '/v1/workspaces?limit=100').catch(() => ({status: 0}));
      if (attempt !== sessionRequest) return;
      workspaceListState = listed.status === 200 ? 'ready' : 'failed';
      const workspaces = workspaceListState === 'ready' ? (listed.body.items || []) : [];
      workspaceSelect.replaceChildren();
      for (const space of workspaces) {
        const option = document.createElement('option');
        option.value = space.id;
        option.textContent = space.name;
        workspaceSelect.append(option);
      }
      if (workspaces.some(space => space.id === manageWorkspace)) workspaceSelect.value = manageWorkspace;
      syncRemixWorkspaces();
      const manage = document.getElementById('catalog-manage');
      if (manage.open) void loadManage();
      else if (location?.hash === '#catalog-manage') manage.open = true;
    }
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
      feedState.sort = 'latest';
      applyFeedChrome();
      pushFeedUrl();
      return loadFeed();
    });
  }
  document.getElementById('feed-sort-popular')?.addEventListener('click', () => {
    if (feedState.tab !== 'activity') return;
    if (feedState.sort === 'popular') {
      if (!feedState.loading) return loadFeed();
      return;
    }
    feedState.kind = '';
    feedState.sort = 'popular';
    applyFeedChrome();
    pushFeedUrl();
    return loadFeed();
  });
  document.getElementById('feed-creator-filter')?.addEventListener('click', () => {
    feedState.creator = '';
    applyFeedChrome();
    pushFeedUrl();
    document.getElementById('feed-tab-' + feedState.tab)?.focus?.();
    return loadFeed();
  });
  const feedSearch = document.getElementById('feed-search');
  if (feedSearch) {
    feedSearch.addEventListener('submit', event => {
      event.preventDefault();
      const input = document.getElementById('feed-query');
      feedState.query = input ? (input.value || '').trim() : '';
      pushFeedUrl();
      return loadFeed();
    });
  }
  const feedMore = document.getElementById('feed-more');
  if (feedMore) {
    feedMore.addEventListener('click', () => {
      if (!feedMore.disabled && feedState.cursor) loadFeed({append: true});
    });
  }
  for (const tab of ['following', 'activity', 'collected']) {
    const button = document.getElementById('feed-tab-' + tab);
    if (button) button.addEventListener('click', () => {
      feedState.tab = tab;
      if (tab !== 'activity') feedState.sort = 'latest';
      applyFeedChrome();
      pushFeedUrl();
      return loadFeed();
    });
  }

  document.getElementById('logout-form').addEventListener('submit', async event => {
    event.preventDefault();
    await request('POST', '/v1/auth/logout', {});
    await load();
  });

  if (!catalogView) applyFeedChrome({restoreQuery: true});
  return load();
}

if (globalThis.document && globalThis.document.getElementById('manage-list')) {
  mount(globalThis.document);
}
