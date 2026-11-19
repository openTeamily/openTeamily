import { csrfCookie } from '../agents/app.mjs';
import { renderThumb } from '../shell/thumb.mjs';

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

export function catalogQuery(text = '', cursor = '') {
  const params = new URLSearchParams({limit: '12'});
  if (text.trim()) params.set('q', text.trim());
  if (cursor) params.set('cursor', cursor);
  return '/v1/discover/agents?' + params.toString();
}

export const FEED_CATEGORIES = [
  '热门', '网页', '小游戏', '图片', '音乐', '幻灯片', '视频', '3D 作品',
  '短剧', '文章', '教程', '看板', '行情', '小程序', '故事', '娱乐', 'AI 与科技', '美容',
];

export const CATALOG_CATEGORIES = [
  'Content Creation', 'Customer Support', 'Data Analysis', 'Design',
  'Education', 'Engineering', 'Finance', 'IT & Security', 'Investment',
  'Legal', 'Life', 'Marketing',
];

export const TEAM_CATEGORIES = [
  'Marketing', 'Engineering', 'IT & Security', 'Content Creation',
  'Operations', 'Product', 'Data Analysis', 'Design', 'Research',
  'Investment', 'Education', 'Life', 'Sales',
];

export const TEAMS_NOTE = '公开 AI 团队目录还没有接口，所以这里不会列出模板卡片。也不会复制对照里的团队名称或创建者品牌。';
export const TEAMS_SEARCH_NOTE = '搜索 AI 团队尚未接通：没有对应的公开接口。';
export const TEAMS_SEARCH_PLACEHOLDER = '搜索 AI 团队......';

export const FEED_ACTIVITY_EMPTY_NOTE = '还没有公开作品，所以这里不会列出作品卡片。也不会展示奖励活动或推荐内容。支持点赞、收录和关注作者；其他分类尚未接通。';
export const FEED_ACTIVITY_LISTED_NOTE = '以下是工作区自愿公开的作品，不是推荐或奖励内容。支持点赞、收录和关注作者；其他分类尚未接通。';
export const FEED_ACTIVITY_NOTE = FEED_ACTIVITY_EMPTY_NOTE;
export const FEED_FOLLOWING_EMPTY_TITLE = '关注列表暂无动态';
export const FEED_FOLLOWING_EMPTY_BODY = '你关注的人发布动态后会显示在这里。';
export const FEED_FOLLOWING_NOTE = '这里只展示你关注的作者已公开的作品，不是推荐或奖励活动。';
export const FEED_SEARCH_EMPTY_NOTE = '没有匹配的公开作品。支持点赞、收录和关注作者；其他分类尚未接通。';

export const FEED_KINDS = ['', 'website', 'image', 'audio', 'slides', 'video'];

export function feedQuery(query, cursor = '', kind = '') {
  const params = new URLSearchParams({limit: '12'});
  if (query) params.set('q', query);
  if (cursor) params.set('cursor', cursor);
  if (kind) params.set('kind', kind);
  return params.toString();
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

export function renderFeedCard(document, item) {
  const card = document.createElement('a');
  card.className = 'feed-card';
  card.href = item.path || ('/w/' + (item.slug || ''));
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

export function renderTeamCard(document, item) {
  const card = document.createElement('article');
  const category = document.createElement('p');
  category.className = 'team-category';
  category.textContent = item.category || '';
  const name = document.createElement('h3');
  name.textContent = item.name || item.slug || '';
  const summary = document.createElement('p');
  summary.className = 'summary';
  summary.textContent = item.summary || '';
  const tags = document.createElement('ul');
  tags.className = 'team-tags';
  for (const label of item.tags || []) {
    const li = document.createElement('li');
    li.textContent = label;
    tags.append(li);
  }
  const foot = document.createElement('div');
  foot.className = 'team-foot';
  const avatars = document.createElement('div');
  avatars.className = 'team-avatars';
  avatars.setAttribute('aria-hidden', 'true');
  for (const member of item.members || []) {
    const mark = document.createElement('span');
    mark.textContent = catalogInitial(member);
    avatars.append(mark);
  }
  foot.append(avatars);
  if (item.extra) {
    const extra = document.createElement('span');
    extra.className = 'team-extra';
    extra.textContent = item.extra;
    foot.append(extra);
  }
  const create = document.createElement('button');
  create.type = 'button';
  create.className = 'team-create';
  create.disabled = true;
  create.textContent = '创建';
  create.title = '未接通：没有从目录创建 AI 团队的接口。';
  create.setAttribute('aria-label', (item.name || item.slug || '团队') + '：创建未接通');
  foot.append(create);
  card.append(category, name, summary, tags, foot);
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

export function mount(document, { fetcher = globalThis.fetch.bind(globalThis), location = globalThis.location } = {}) {
  const status = document.getElementById('status');
  const loginPanel = document.getElementById('login-panel');
  const mainPanel = document.getElementById('main-panel');
  const workspaceSelect = document.getElementById('workspace');
  let currentUser = null;
  // A refused workspace list and an empty one both leave the selector blank, but
  // they are different states: only the second one means "you have no workspace".
  let workspaceListFailed = false;
  let catalog = [];
  let cursor = '';
  let activeQuery = '';
  let catalogRequest = 0;
  const agentsView = isAgentsCatalog(location);
  const teamsView = isTeamsCatalog(location);
  const catalogView = agentsView || teamsView;

  function setCurrent(id, on) {
    const node = document.getElementById(id);
    if (!node) return;
    if (on) node.setAttribute('aria-current', 'page');
    else if (typeof node.removeAttribute === 'function') node.removeAttribute('aria-current');
    else if (node.attributes) delete node.attributes['aria-current'];
  }

  function applyCatalogChrome() {
    setCurrent('catalog-tab-agents', agentsView);
    setCurrent('catalog-tab-teams', teamsView);
    const agentFilters = document.getElementById('catalog-filters');
    const teamFilters = document.getElementById('teams-filters');
    if (agentFilters) agentFilters.hidden = !agentsView;
    if (teamFilters) teamFilters.hidden = !teamsView;
    const createAgent = document.getElementById('catalog-create-agent');
    const createTeam = document.getElementById('catalog-create-team');
    if (createAgent) createAgent.hidden = !agentsView;
    if (createTeam) createTeam.hidden = !teamsView;
    const query = document.getElementById('catalog-query');
    if (query) query.placeholder = teamsView ? TEAMS_SEARCH_PLACEHOLDER : '搜索智能体…';
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

  function showTeamsUnconnected() {
    const list = document.getElementById('discover-list');
    if (list) list.replaceChildren();
    const empty = document.getElementById('discover-empty');
    if (empty) empty.hidden = true;
    const more = document.getElementById('catalog-more');
    if (more) more.hidden = true;
    const count = document.getElementById('catalog-count');
    if (count) count.textContent = '';
    const error = document.getElementById('catalog-error');
    if (error) error.hidden = true;
    const note = document.getElementById('teams-note');
    if (note) {
      note.hidden = false;
      note.textContent = TEAMS_NOTE;
    }
    const panel = document.getElementById('catalog-panel');
    if (panel) panel.setAttribute('aria-busy', 'false');
  }

  function showDiscoverView() {
    const feed = document.getElementById('feed-panel');
    const catalog = document.getElementById('catalog-view');
    if (feed) feed.hidden = catalogView;
    if (catalog) catalog.hidden = !catalogView;
    applyCatalogChrome();
  }

  const feedState = {items: [], cursor: '', query: '', kind: '', tab: 'activity', loading: false};
  let feedRequest = 0;

  function setFeedTab(tab) {
    feedState.tab = tab;
    for (const name of ['following', 'activity', 'collected']) {
      const button = document.getElementById('feed-tab-' + name);
      if (button) button.setAttribute('aria-selected', name === tab ? 'true' : 'false');
    }
    applyFeedNote();
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
    else note.textContent = (feedState.query || feedState.kind) && !feedState.items.length && !feedState.loading
      ? FEED_SEARCH_EMPTY_NOTE : (feedState.items.length ? FEED_ACTIVITY_LISTED_NOTE : FEED_ACTIVITY_EMPTY_NOTE);
  }

  const previewCache = new Map();
  function hydrateThumb(card, item) {
    const path = feedPreviewPath(item);
    if (!path || typeof fetcher !== 'function') return;
    const key = path + '@' + (item.updated || '');
    if (!previewCache.has(key)) {
      previewCache.set(key, Promise.resolve()
        .then(() => fetcher(path, {method: 'GET', credentials: 'same-origin', headers: {Accept: 'application/json'}}))
        .then(response => response && response.status === 200 ? response.json() : null)
        .then(body => (body && body.preview) || null)
        .catch(() => null));
    }
    const cover = typeof card.querySelector === 'function' ? card.querySelector('.work-cover') : null;
    if (!cover) return;
    previewCache.get(key).then(preview => attachFeedThumb(document, cover, preview)).catch(() => {});
  }

  function renderFeed() {
    const grid = document.getElementById('feed-grid');
    if (!grid) return;
    grid.replaceChildren();
    for (const item of feedState.items) {
      const card = renderFeedCard(document, item);
      hydrateThumb(card, item);
      if (!currentUser) { grid.append(card); continue; }
      const entry = document.createElement('article'); entry.append(card);
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
      entry.append(actions); grid.append(entry);
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
    const params = feedQuery(feedState.query, append ? feedState.cursor : '', feedState.kind);
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
      const chat = document.createElement('button');
      chat.type = 'button';
      chat.disabled = true;
      chat.textContent = '聊天';
      chat.title = '未接通：公共目录没有发起聊天的接口';
      chat.setAttribute('aria-label', (item.name || item.slug) + '：聊天未接通');
      copy.append(name, summary);
      // Public catalog entries carry only a name and a summary (no prompts, no
      // instructions), so 用这个智能体 really calls the existing workspace-agent
      // create endpoint with those two fields and lands on /agents. It does not
      // copy a prompt nobody published, and it does not fake a local receipt.
      const use = document.createElement('button');
      use.type = 'button';
      use.className = 'catalog-use';
      use.textContent = '用这个智能体';
      use.title = '按公共目录里的名称和简介，在你的工作区里新建一个同名智能体；说明需要你之后自己补。';
      use.setAttribute('aria-label', '用这个智能体：「' + (item.name || item.slug) + '」');
      use.addEventListener('click', async () => {
        const label = item.name || item.slug;
        if (!currentUser) {
          show('error', '请先登录，再把这个智能体放进你的工作区。');
          return;
        }
        const space = workspaceSelect.value;
        if (!space) {
          // Never tell a user to create a workspace when the list simply failed to load.
          show('error', workspaceListFailed
            ? '工作区列表读取失败，请稍后重试。'
            : '先创建一个工作区，才能放进这个智能体。');
          return;
        }
        if (use.disabled) return;
        use.disabled = true;
        let result;
        try {
          result = await request('POST', `/v1/workspaces/${space}/agents`, {
            name: label,
            summary: item.summary || '',
            instructions: '',
          }, {'Idempotency-Key': reuseKey()});
        } catch {
          result = {status: 0, body: {}};
        }
        use.disabled = false;
        if (result.status === 201 || result.status === 200) {
          show('ok', '已创建「' + label + '」，正在打开智能体页。');
          if (typeof location.assign === 'function') location.assign('/agents');
          else location.href = '/agents';
          return;
        }
        if (result.status === 409) {
          show('error', '你的工作区里已有同名智能体；改名后再从目录创建。');
          return;
        }
        show('error', messageFor(result.body && result.body.error, '无法创建智能体。'));
      });
      card.append(avatar, copy, chat, use);
      // Slugs identify records, but no public detail route exists, so the card
      // carries no hover text: a "/d/<slug>" tooltip would promise a 404.
      li.append(card);
      list.append(li);
    }
  }

  async function loadCatalog(append = false) {
    const seq = ++catalogRequest;
    if (!append) {
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
      const listed = await request('GET', catalogQuery(activeQuery, cursor));
      if (seq !== catalogRequest) return;
      if (listed.status !== 200) throw new Error(messageFor(listed.body.error, '无法加载公共目录。'));
      const incoming = catalogItems(listed.body);
      const known = new Set(catalog.map(item => item.slug));
      catalog.push(...incoming.filter(item => !known.has(item.slug)));
      cursor = listed.body.cursor || '';
      renderCatalog(catalog);
      more.hidden = !cursor;
      document.getElementById('discover-empty').textContent = activeQuery
        ? '没有匹配的智能体。试试其他关键词。' : '暂无公开智能体。';
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
      state.textContent = discover.listed ? '已收录：' + discover.slug : '未收录';
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 30;
      input.placeholder = 'slug';
      input.value = discover.slug || '';
      const publish = document.createElement('button');
      publish.type = 'button';
      publish.textContent = '收录 / 更新';
      publish.addEventListener('click', async () => {
        if (!validSlug(input.value.trim())) {
          show('error', 'slug 需为 3–30 个字符的小写字母、数字或连字符。');
          return;
        }
        const result = await request(
          'POST', `/v1/workspaces/${workspaceSelect.value}/agents/${agent.id}/discover`,
          {slug: input.value.trim()});
        if (result.status !== 201 && result.status !== 200) {
          show('error', messageFor(result.body.error, '无法收录。'));
          return;
        }
        show('ok', '已收录。');
        await loadCatalog();
        await loadManage();
      });
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.textContent = '取消收录';
      revoke.disabled = !discover.listed;
      revoke.addEventListener('click', async () => {
        const result = await request(
          'POST', `/v1/workspaces/${workspaceSelect.value}/agents/${agent.id}/discover/revoke`, {});
        if (result.status !== 200) {
          show('error', messageFor(result.body.error, '无法取消收录。'));
          return;
        }
        show('ok', '已取消收录。');
        await loadCatalog();
        await loadManage();
      });
      li.append(title, state, input, publish, revoke);
      list.append(li);
    }
  }

  async function loadManage() {
    const id = workspaceSelect.value;
    if (!id) {
      renderManage([]);
      return;
    }
    const listed = await request('GET', `/v1/workspaces/${id}/agents?limit=100`);
    if (listed.status !== 200) {
      renderManage([]);
      return;
    }
    const agents = listed.body.items || [];
    const statuses = await Promise.all(agents.map(agent =>
      request('GET', `/v1/workspaces/${id}/agents/${agent.id}/discover`)
        .then(result => (result.status === 200 ? result.body.discover : {listed: false}))));
    renderManage(agentDiscoverPairs(agents, statuses));
  }

  async function load() {
    showDiscoverView();
    if (agentsView) await loadCatalog();
    if (teamsView) showTeamsUnconnected();
    const session = await request('GET', '/v1/auth/session');
    if (session.status !== 200) {
      currentUser = null;
      loginPanel.hidden = false;
      mainPanel.hidden = false;
      document.getElementById('catalog-manage').hidden = true;
      show('', '');
      return;
    }
    currentUser = session.body.user;
    loginPanel.hidden = true;
    mainPanel.hidden = false;
    document.getElementById('catalog-manage').hidden = !agentsView;
    document.getElementById('whoami').textContent = currentUser.username;
    if (agentsView) {
      const listed = await request('GET', '/v1/workspaces?limit=100');
      workspaceListFailed = listed.status !== 200;
      const workspaces = workspaceListFailed ? [] : (listed.body.items || []);
      workspaceSelect.replaceChildren();
      for (const space of workspaces) {
        const option = document.createElement('option');
        option.value = space.id;
        option.textContent = space.name;
        workspaceSelect.append(option);
      }
      await loadManage();
    }
    show('', '');
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
  document.getElementById('catalog-search').addEventListener('submit', event => {
    event.preventDefault();
    if (agentsView) return loadCatalog();
    if (teamsView) {
      const note = document.getElementById('teams-search-note');
      if (note) {
        note.hidden = false;
        note.textContent = TEAMS_SEARCH_NOTE;
      }
    }
  });
  document.getElementById('catalog-clear').addEventListener('click', () => {
    document.getElementById('catalog-query').value = '';
    const note = document.getElementById('teams-search-note');
    if (note) note.hidden = true;
    if (agentsView) return loadCatalog();
  });
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
      setFeedTab('activity');
      return loadFeed();
    });
  }
  const feedSearch = document.getElementById('feed-search');
  if (feedSearch) {
    feedSearch.addEventListener('submit', event => {
      event.preventDefault();
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
      return loadFeed();
    });
  }

  document.getElementById('logout-form').addEventListener('submit', async event => {
    event.preventDefault();
    await request('POST', '/v1/auth/logout', {});
    await load();
  });

  return load().then(() => { if (!catalogView) { setFeedTab('activity'); return loadFeed(); } });
}

if (globalThis.document && globalThis.document.getElementById('manage-list')) {
  mount(globalThis.document);
}
