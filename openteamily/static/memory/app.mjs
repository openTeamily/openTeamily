import { domToMarkdown, renderMarkdown, safeHref } from './rich.mjs';
export function recentlyUpdatedCount(pages, now = Date.now(), days = 7) {
  const since = now / 1000 - days * 86400;
  return (pages || []).filter((page) => Number(page.updated || 0) >= since).length;
}

export function csrfCookie(source) {
  const match = /(?:^|;\s*)(?:__Host-ot_csrf|ot_dev_csrf)=([^;]+)/.exec(source || '');
  return match ? decodeURIComponent(match[1]) : '';
}

export function listQuery(needle, cursor, limit) {
  const params = new URLSearchParams();
  if (needle) params.set('q', needle);
  if (cursor) params.set('cursor', cursor);
  if (limit) params.set('limit', String(limit));
  const query = params.toString();
  return query ? `?${query}` : '';
}

export function actionQuery(needle, status, cursor, limit) {
  const params = new URLSearchParams();
  if (needle) params.set('q', needle);
  if (status) params.set('status', status);
  if (cursor) params.set('cursor', cursor);
  if (limit) params.set('limit', String(limit));
  const query = params.toString();
  return query ? `?${query}` : '';
}

export function dueDateValue(dueAt) {
  if (dueAt == null || dueAt === '') return '';
  const date = new Date(Number(dueAt) * 1000);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

export function dueAtFromDate(value) {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 1000;
}

export function parseTopics(value) {
  const names = [];
  const seen = new Set();
  for (const part of String(value || '').split(/[,，\n]/)) {
    const name = part.trim();
    if (!name) continue;
    const key = name.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}


export function applyMarkdown(textarea, kind) {
  if (!textarea) return '';
  const value = textarea.value;
  const start = textarea.selectionStart ?? value.length;
  const end = textarea.selectionEnd ?? value.length;
  const selected = value.slice(start, end);
  const wraps = {
    bold: ['**', '**', '粗体'],
    italic: ['_', '_', '斜体'],
    strike: ['~~', '~~', '删除线'],
    code: ['`', '`', '代码'],
    h1: ['# ', '', '标题'],
    h2: ['## ', '', '小标题'],
    h3: ['### ', '', '小标题'],
    ul: ['- ', '', '列表项'],
    ol: ['1. ', '', '列表项'],
    hr: ['\n---\n', '', ''],
    quote: ['> ', '', '引用'],
    link: ['[', '](https://)', '链接文字'],
  };
  const [pre, post, fallback] = wraps[kind] || ['', '', '文本'];
  const body = selected || fallback;
  const next = value.slice(0, start) + pre + body + post + value.slice(end);
  textarea.value = next;
  if (typeof textarea.setSelectionRange === 'function') {
    textarea.setSelectionRange(start + pre.length, start + pre.length + body.length);
  }
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  return next;
}

export function formatTopics(topics) {
  return (topics || []).join('，');
}

export function memoryUpdatedLabel(updated) {
  if (updated == null || updated === '') return '';
  const date = new Date(Number(updated) * 1000);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

export function topicTag(name) {
  const label = String(name || '').trim();
  if (!label) return '';
  return label.startsWith('#') ? label : `#${label}`;
}

export function memoryPageMeta(item) {
  const topics = (item && item.topics) || [];
  const parts = [memoryUpdatedLabel(item && item.updated), ...topics.map(topicTag)].filter(Boolean);
  return parts.join(' · ');
}

export function memoryPagePreview(item) {
  return String((item && item.preview) || '').trim();
}

export const GRAPH_HOVER_DELAY_MS = 300;
export const GRAPH_HOVER_NARROW_MAX = 390;

export function graphPreviewModel(node) {
  const title = String((node && node.title) || '').trim();
  const summary = memoryPagePreview(node);
  const tags = ((node && node.topics) || []).map(topicTag).filter(Boolean);
  return {title, summary, tags};
}

export function graphHoverAllowed({pointerCoarse = false, viewportWidth = 1440} = {}) {
  if (pointerCoarse) return false;
  if (Number(viewportWidth) <= GRAPH_HOVER_NARROW_MAX) return false;
  return true;
}

export function fillGraphHoverCard(card, model) {
  if (!card) return card;
  const titleEl = card.querySelector('.graph-hover-title');
  const summaryEl = card.querySelector('.graph-hover-summary');
  const tagsEl = card.querySelector('.graph-hover-tags');
  if (titleEl) titleEl.textContent = (model && model.title) || '';
  if (summaryEl) {
    summaryEl.textContent = (model && model.summary) || '';
    summaryEl.hidden = !(model && model.summary);
  }
  if (tagsEl) {
    tagsEl.textContent = ((model && model.tags) || []).join(' ');
    tagsEl.hidden = !((model && model.tags && model.tags.length));
  }
  return card;
}

export function hideGraphHoverCard(card) {
  if (!card) return card;
  card.hidden = true;
  if (card.removeAttribute) card.removeAttribute('data-id');
  return card;
}

export function showGraphHoverCard(card, model, position, id) {
  fillGraphHoverCard(card, model);
  if (id && card.setAttribute) card.setAttribute('data-id', id);
  if (position && Number.isFinite(position.left) && Number.isFinite(position.top) && card.style) {
    card.style.left = `${position.left}px`;
    card.style.top = `${position.top}px`;
  }
  card.hidden = false;
  return card;
}

export function bindGraphNodeGestures(target, node, options = {}) {
  if (!target || !target.addEventListener) return () => {};
  const openPage = options.openPage || (() => {});
  const card = options.card;
  const delay = options.delayMs == null ? GRAPH_HOVER_DELAY_MS : options.delayMs;
  const allowed = options.hoverAllowed != null
    ? Boolean(options.hoverAllowed)
    : graphHoverAllowed({
      pointerCoarse: options.pointerCoarse,
      viewportWidth: options.viewportWidth,
    });
  const model = graphPreviewModel(node);
  let timer = 0;
  if (target.setAttribute) {
    target.setAttribute('tabindex', '0');
    target.setAttribute('role', 'button');
    if (model.title) target.setAttribute('aria-label', model.title);
  }
  const open = () => openPage(node && node.id);
  const hide = () => {
    if (timer) {
      clearTimeout(timer);
      timer = 0;
    }
    hideGraphHoverCard(card);
  };
  const startHover = () => {
    if (!allowed || !card) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = 0;
      const position = options.positionFor ? options.positionFor(target, node) : options.position;
      showGraphHoverCard(card, model, position, node && node.id);
    }, delay);
  };
  target.addEventListener('click', open);
  target.addEventListener('dblclick', open);
  target.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      if (event.preventDefault) event.preventDefault();
      open();
      return;
    }
    if (event.key === 'Escape') hide();
  });
  target.addEventListener('pointerenter', startHover);
  target.addEventListener('pointerleave', hide);
  return hide;
}

function currentPointerIsCoarse() {
  return Boolean(typeof window !== 'undefined' && window.matchMedia
    && window.matchMedia('(pointer: coarse)').matches);
}

function currentViewportWidth() {
  return (typeof window !== 'undefined' && window.innerWidth) || 1440;
}

function graphHoverCardPosition(stage, target) {
  if (!stage || !stage.getBoundingClientRect || !target || !target.getBoundingClientRect) {
    return {left: 16, top: 16};
  }
  const stageBox = stage.getBoundingClientRect();
  const box = (target.querySelector && target.querySelector('.graph-node') || target).getBoundingClientRect();
  return {
    left: Math.max(8, box.left - stageBox.left + (box.width / 2) - 16),
    top: Math.max(8, box.top - stageBox.top + box.height + 10),
  };
}


function topicKey(name) {
  return String(name || '').trim().toLocaleLowerCase();
}

export function directoryGroups(pages, topicCatalog) {
  const rows = [...(pages || [])];
  const byId = new Map(rows.map((page) => [page.id, page]));
  const catalog = [];
  const seen = new Set();
  const addTopic = (name) => {
    const label = String(name || '').trim();
    const key = topicKey(label);
    if (!label || seen.has(key)) return;
    seen.add(key);
    catalog.push(label);
  };
  for (const topic of topicCatalog || []) {
    addTopic(topic && topic.name);
  }
  for (const page of rows) {
    for (const name of page.topics || []) addTopic(name);
  }
  const used = new Set();
  const groups = [];
  for (const name of catalog) {
    const key = topicKey(name);
    const items = [];
    const seenIds = new Set();
    const catalogTopic = (topicCatalog || []).find((topic) => topicKey(topic && topic.name) === key);
    const hinted = (catalogTopic && catalogTopic.pages ? catalogTopic.pages : []).map((page) => page && page.id);
    for (const page of rows) {
      const tagged = (page.topics || []).some((item) => topicKey(item) === key);
      const listed = hinted.includes(page.id);
      if (!tagged && !listed) continue;
      if (seenIds.has(page.id) || !byId.has(page.id)) continue;
      seenIds.add(page.id);
      items.push(page);
      used.add(page.id);
    }
    if (!items.length) continue;
    groups.push({name, count: items.length, pages: items});
  }
  return {groups, ungrouped: rows.filter((page) => !used.has(page.id))};
}

export function applyDirectoryCollapsed(root, collapsed) {
  const next = Boolean(collapsed);
  const dir = root.getElementById('memory-dir');
  const workspace = root.getElementById('list-panel');
  const collapse = root.getElementById('dir-collapse');
  const expand = root.getElementById('dir-expand');
  if (workspace) workspace.classList.toggle('dir-collapsed', next);
  if (dir) dir.hidden = next;
  if (collapse) collapse.setAttribute('aria-expanded', next ? 'false' : 'true');
  if (expand) expand.hidden = !next;
  return next;
}


export const MEMORY_EMPTY_WORKSPACE = '这个工作区还没有记忆页。';
export const PREFERENCES_EMPTY = '还没有偏好，加一条试试';
export const MEMORY_EMPTY_NO_MATCH = '没有匹配的记忆页。试试其他关键词。';
export const GRAPH_EMPTY_MESSAGE = '创建两个或更多记忆页后，这里会把它们连成图谱';

export function graphEmptyStateVisible({nodeCount = 0, query = ''} = {}) {
  if (String(query || '').trim()) return false;
  return Number(nodeCount) < 2;
}

export function matchingMemoryPages(items, needle) {
  const query = String(needle || '').trim().toLocaleLowerCase();
  const rows = [...(items || [])];
  if (!query) return rows;
  return rows.filter((item) => String(item.title || '').toLocaleLowerCase().includes(query));
}

export function memoryPageFromSearch(search) {
  const value = new URLSearchParams(search || '').get('page');
  if (value === 'profile') return 'profile';
  if (value === 'todos') return 'actions';
  return 'overview';
}

export function queryForMemoryPage(view) {
  if (view === 'profile') return '?page=profile';
  if (view === 'actions') return '?page=todos';
  return '';
}

export function exportDownloadName(title) {
  const flat = String(title == null ? '' : title).replace(/[\s\u0000-\u001f]+/g, ' ').trim();
  const safe = flat.replace(/[\\/:*?"<>|]+/g, '-').replace(/^[.\s-]+|[.\s-]+$/g, '');
  const limited = safe.slice(0, 60).replace(/[.\s-]+$/, '');
  return (limited || '记忆页') + '.md';
}

export function graphLayout(nodes, width = 640, height = 400, padding = 56) {
  const list = [...(nodes || [])].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const cx = width / 2;
  const cy = height / 2;
  if (list.length === 0) return [];
  if (list.length === 1) return [{id: list[0].id, x: cx, y: cy}];
  const radius = Math.max(0, Math.min(cx, cy) - padding);
  return list.map((node, index) => {
    const angle = ((Math.PI * 2 * index) / list.length) - (Math.PI / 2);
    return {
      id: node.id,
      x: Number((cx + radius * Math.cos(angle)).toFixed(2)),
      y: Number((cy + radius * Math.sin(angle)).toFixed(2)),
    };
  });
}

function messageFor(error, fallback) {
  if (error && error.message) return error.message;
  return fallback;
}

function applyTheme(settings) {
  const appearance = settings && settings.appearance;
  document.body.dataset.theme = appearance === 'dark' || appearance === 'light' ? appearance : '';
}

export function mount(document, {fetcher = globalThis.fetch.bind(globalThis)} = {}) {
  const status = document.getElementById('status');
  const loginPanel = document.getElementById('login-panel');
  const mainPanel = document.getElementById('main-panel');
  const workspaceSelect = document.getElementById('workspace');
  const listEl = document.getElementById('memory-list');
  const emptyEl = document.getElementById('list-empty');
  const editor = document.getElementById('editor-form');
  const actionEditor = document.getElementById('action-editor-form');
  const listPanel = document.getElementById('list-panel');
  let currentUser = null;
  let workspaces = [];
  let currentPage = null;
  let currentAction = null;
  let pageChoices = [];
  let currentView = 'overview';
  let listFilter = 'all';
  let topicFilter = '';
  let sideTab = 'topics';
  let graphZoom = 1;
  let topicQuery = '';
  let pendingDelete = null;

  function show(kind, text) {
    status.dataset.kind = kind;
    status.textContent = text;
  }

  async function request(method, path, body, extra = {}) {
    const headers = {'Accept': 'application/json', 'X-CSRF-Token': csrfCookie(document.cookie), ...extra};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetcher(path, {
      method, headers, credentials: 'same-origin',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let parsed = {};
    try { parsed = await response.json(); } catch { parsed = {}; }
    return {status: response.status, body: parsed};
  }

  function workspaceId() {
    return workspaceSelect.value;
  }

  function randomKey() {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function visiblePages(items) {
    const rows = [...(items || [])];
    if (listFilter === 'updated') {
      rows.sort((a, b) => Number(b.updated || 0) - Number(a.updated || 0) || String(a.id).localeCompare(String(b.id)));
      return rows;
    }
    if (listFilter === 'topics' && topicFilter) {
      const topic = (currentGraph.topics || []).find((item) => item.name === topicFilter);
      const allowed = new Set((topic && topic.pages ? topic.pages : []).map((page) => page.id));
      return rows.filter((item) => allowed.has(item.id));
    }
    return rows;
  }

  function pageButton(item) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'memory-page-link';
    button.dataset.id = item.id;
    const icon = document.createElement('span');
    icon.className = 'memory-page-icon';
    icon.setAttribute('aria-hidden', 'true');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('d', 'M7 3h7l5 5v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm6 1.5V9h4.5L13 4.5z');
    svg.appendChild(path);
    icon.appendChild(svg);
    button.appendChild(icon);
    const text = document.createElement('span');
    text.className = 'memory-page-text';
    const title = document.createElement('span');
    title.className = 'memory-page-title';
    title.textContent = item.title;
    text.appendChild(title);
    const preview = memoryPagePreview(item);
    if (preview) {
      const snippet = document.createElement('span');
      snippet.className = 'memory-page-preview';
      snippet.textContent = preview;
      text.appendChild(snippet);
    }
    const meta = document.createElement('span');
    meta.className = 'memory-page-meta';
    meta.textContent = memoryPageMeta(item);
    if (meta.textContent) text.appendChild(meta);
    button.appendChild(text);
    button.addEventListener('click', () => openPage(item.id));
    return button;
  }

  function appendPage(parent, item) {
    const li = document.createElement('li');
    li.appendChild(pageButton(item));
    parent.appendChild(li);
  }

  function renderList(items) {
    const rows = visiblePages(items);
    listEl.replaceChildren();
    if (listFilter === 'all') {
      const directory = directoryGroups(rows, currentGraph.topics);
      for (const item of directory.ungrouped) appendPage(listEl, item);
      for (const group of directory.groups) {
        const li = document.createElement('li');
        li.className = 'memory-topic-group';
        const details = document.createElement('details');
        details.open = true;
        const summary = document.createElement('summary');
        summary.textContent = `${group.name} ${group.count}`;
        details.appendChild(summary);
        const nested = document.createElement('ul');
        for (const item of group.pages) appendPage(nested, item);
        details.appendChild(nested);
        li.appendChild(details);
        listEl.appendChild(li);
      }
    } else {
      for (const item of rows) appendPage(listEl, item);
    }
    const needle = document.getElementById('search') ? document.getElementById('search').value : '';
    emptyEl.hidden = rows.length > 0;
    emptyEl.textContent = rows.length > 0
      ? emptyEl.textContent
      : (String(needle || '').trim() ? MEMORY_EMPTY_NO_MATCH : MEMORY_EMPTY_WORKSPACE);
    const count = document.getElementById('filter-all-count');
    if (count) count.textContent = String((pageChoices || []).length);
    const recent = document.getElementById('filter-updated-count');
    if (recent) recent.textContent = String(recentlyUpdatedCount(pageChoices));
  }

  function renderDirectory() {
    renderList(matchingMemoryPages(pageChoices, document.getElementById('search') ? document.getElementById('search').value : ''));
  }

  function renderRecent(items) {
    const list = document.getElementById('recent-list');
    const empty = document.getElementById('recent-empty');
    if (!list || !empty) return;
    const rows = [...(items || [])].sort((a, b) => Number(b.updated || 0) - Number(a.updated || 0) || String(a.id).localeCompare(String(b.id)));
    list.replaceChildren();
    for (const item of rows) {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      const updated = item.updated ? new Date(Number(item.updated) * 1000) : null;
      const when = updated && !Number.isNaN(updated.getTime()) ? updated.toISOString().slice(0, 10) : '';
      button.textContent = when ? `${item.title} · ${when}` : item.title;
      button.addEventListener('click', () => openPage(item.id));
      li.appendChild(button);
      list.appendChild(li);
    }
    empty.hidden = rows.length > 0;
  }

  function renderTopicFilters() {
    const box = document.getElementById('topic-filter-chips');
    if (!box) return;
    box.replaceChildren();
    for (const topic of currentGraph.topics || []) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `${topic.name} · ${topic.page_count}`;
      button.setAttribute('aria-pressed', topic.name === topicFilter ? 'true' : 'false');
      button.addEventListener('click', () => {
        topicFilter = topicFilter === topic.name ? '' : topic.name;
        renderTopicFilters();
        renderDirectory();
      });
      box.appendChild(button);
    }
  }

  function syncPageUrl() {
    const view = document.defaultView;
    if (!view || !view.history || !view.history.replaceState) return;
    const path = (view.location && view.location.pathname) || '/memory';
    view.history.replaceState({}, '', path + queryForMemoryPage(currentView));
  }

  let profileRevision = null;
  let profileRequest = 0;
  async function loadMemoryProfile() {
    profileRevision = null;
    const token = ++profileRequest, wid = workspaceId();
    const save = document.getElementById('save-memory-profile'); if (save) save.disabled = true;
    if (!wid) return;
    const result = await request('GET', `/v1/workspaces/${wid}/memory/profile`);
    if (token !== profileRequest || workspaceId() !== wid) return;
    const status = document.getElementById('memory-profile-status');
    if (result.status !== 200) { if (status) status.textContent = '无法读取画像。'; return; }
    const profile = result.body.profile;
    profileRevision = profile.revision;
    if (save) save.disabled = false;
    for (const field of ['professional', 'work_style', 'communication']) {
      const input = document.getElementById('profile-' + field); if (input) input.value = profile[field];
    }
    if (status) status.textContent = '';
  }
  function showView(name, {sync = true} = {}) {
    currentView = name || 'overview';
    if (editor) editor.hidden = true;
    if (actionEditor) actionEditor.hidden = true;
    const workspace = document.getElementById('list-panel');
    if (workspace) workspace.dataset.view = currentView;
    const title = document.getElementById('view-title');
    const labels = {overview: '总览', profile: '我的资料', actions: '下一步行动'};
    if (title) title.textContent = labels[currentView] || '总览';
    const overview = document.getElementById('overview-panel');
    const side = document.getElementById('memory-side');
    const actions = document.getElementById('actions-panel');
    const profile = document.getElementById('profile-panel');
    if (overview) overview.hidden = currentView !== 'overview';
    if (side) side.hidden = currentView !== 'overview';
    if (actions) actions.hidden = currentView !== 'actions';
    if (profile) profile.hidden = currentView !== 'profile';
    if (currentView === 'profile') loadMemoryProfile();
    if (currentView === 'profile') loadPreferences();
    for (const button of document.querySelectorAll('.memory-views [data-view]')) {
      if (button.getAttribute('data-view') === currentView) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    if (sync) syncPageUrl();
  }

  function unusedTitle(base) {
    const taken = new Set((pageChoices || []).map((item) => String(item.title || '').toLocaleLowerCase()));
    if (!taken.has(base.toLocaleLowerCase())) return base;
    for (let index = 2; index < 100; index += 1) {
      const title = `${base} ${index}`;
      if (!taken.has(title.toLocaleLowerCase())) return title;
    }
    return `${base} ${Date.now()}`;
  }

  function fillPageSelect(select, selected) {
    select.replaceChildren();
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = '不关联';
    select.appendChild(empty);
    for (const page of pageChoices) {
      const option = document.createElement('option');
      option.value = page.id;
      option.textContent = page.title;
      select.appendChild(option);
    }
    select.value = selected || '';
  }

  function renderActions(items) {
    const list = document.getElementById('action-list');
    const empty = document.getElementById('action-empty');
    list.replaceChildren();
    for (const item of items) {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      const due = dueDateValue(item.due_at);
      const linked = item.memory_page_title ? ` · ${item.memory_page_title}` : '';
      button.textContent = `${item.status === 'done' ? '已完成' : '未完成'} · ${item.title}${due ? ` · ${due}` : ''}${linked}`;
      button.dataset.id = item.id;
      button.addEventListener('click', () => openAction(item.id));
      li.appendChild(button);
      list.appendChild(li);
    }
    empty.hidden = items.length > 0;
    syncActionComposer(items.length > 0);
  }

  function syncActionComposer(hasItems) {
    const form = document.getElementById('new-action-form');
    const opener = document.getElementById('new-action-open');
    const filter = document.getElementById('action-filter-label');
    if (!form) return;
    const keep = form.dataset.open === 'true';
    form.hidden = !(hasItems || keep);
    if (opener) opener.hidden = hasItems || keep;
    if (filter) filter.hidden = !(hasItems || keep);
  }

  async function loadActions() {
    const id = workspaceId();
    const list = document.getElementById('action-list');
    const empty = document.getElementById('action-empty');
    if (!id) {
      renderActions([]);
      return;
    }
    const status = document.getElementById('action-filter').value;
    const listed = await request('GET', `/v1/workspaces/${id}/memory/actions${actionQuery('', status)}`);
    if (listed.status !== 200) {
      if (list) list.replaceChildren();
      if (empty) empty.hidden = true;
      show('error', messageFor(listed.body.error, '无法加载下一步行动。'));
      return;
    }
    renderActions(listed.body.items || []);
  }


  function svgNode(name, attrs) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, value);
    return node;
  }

  function truncateLabel(title) {
    const text = String(title || '');
    return text.length > 18 ? `${text.slice(0, 17)}…` : text;
  }

  function renderGraph(graph) {
    hideGraphHoverCard(document.getElementById('graph-hover-card'));
    const canvas = document.getElementById('graph-canvas');
    const counts = document.getElementById('graph-counts');
    const topicList = document.getElementById('topic-list');
    const topicEmpty = document.getElementById('topic-empty');
    const payload = graph || {nodes: [], edges: [], topics: [], counts: {nodes: 0, edges: 0, topics: 0}};
    const stats = payload.counts || {nodes: 0, edges: 0, topics: 0};
    if (counts) {
      const linked = new Set();
      for (const edge of payload.edges || []) {
        if (edge.source) linked.add(edge.source);
        if (edge.target) linked.add(edge.target);
      }
      const unconnected = (payload.nodes || []).filter((node) => !linked.has(node.id)).length;
      counts.replaceChildren();
      for (const [value, label] of [[stats.nodes, '节点'], [stats.edges, '连接'], [unconnected, '未连接'], [stats.topics, '话题']]) {
        const item = document.createElement('span');
        item.className = 'memory-count';
        const strong = document.createElement('strong');
        strong.textContent = String(value ?? 0);
        const caption = document.createElement('span');
        caption.textContent = label;
        item.append(strong, caption);
        counts.appendChild(item);
      }
    }
    const empty = document.getElementById('graph-empty');
    if (empty) {
      empty.hidden = !graphEmptyStateVisible({
        nodeCount: (payload.nodes || []).length,
        query: topicQuery,
      });
    }
    if (canvas) {
      canvas.replaceChildren();
      const world = svgNode('g', {id: 'graph-world', transform: `translate(320 200) scale(${graphZoom}) translate(-320 -200)`});
      const placed = graphLayout(payload.nodes);
      const byId = new Map(placed.map((node) => [node.id, node]));
      const needle = topicQuery.trim().toLocaleLowerCase();
      const matches = (node) => {
        if (!needle) return true;
        if (String(node.title || '').toLocaleLowerCase().includes(needle)) return true;
        return (payload.topics || []).some((topic) => String(topic.name || '').toLocaleLowerCase().includes(needle)
          && (topic.pages || []).some((page) => page.id === node.id));
      };
      for (const edge of payload.edges || []) {
        const from = byId.get(edge.source);
        const to = byId.get(edge.target);
        if (!from || !to) continue;
        world.appendChild(svgNode('line', {
          class: 'graph-edge', x1: from.x, y1: from.y, x2: to.x, y2: to.y,
        }));
      }
      for (const node of payload.nodes || []) {
        const point = byId.get(node.id);
        if (!point) continue;
        const group = svgNode('g', {'data-id': node.id, class: matches(node) ? 'graph-item' : 'graph-item is-muted'});
        const button = svgNode('circle', {class: 'graph-node', cx: point.x, cy: point.y, r: 8});
        const label = svgNode('text', {
          class: 'graph-label', x: point.x, y: point.y + 22, 'text-anchor': 'middle',
        });
        label.textContent = truncateLabel(node.title);
        group.appendChild(button);
        group.appendChild(label);
        const stage = canvas.parentElement;
        const card = document.getElementById('graph-hover-card');
        bindGraphNodeGestures(group, node, {
          openPage,
          card,
          pointerCoarse: currentPointerIsCoarse(),
          viewportWidth: currentViewportWidth(),
          positionFor: () => graphHoverCardPosition(stage, group),
        });
        world.appendChild(group);
      }
      canvas.appendChild(world);
    }
    if (topicList) {
      topicList.replaceChildren();
      for (const topic of payload.topics || []) {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        const pages = (topic.pages || []).map((page) => page.title).filter(Boolean);
        button.textContent = pages.length
          ? `${topic.name} · ${topic.page_count} · ${pages.slice(0, 3).join('，')}`
          : `${topic.name} · ${topic.page_count}`;
        button.addEventListener('click', () => {
          const first = topic.pages && topic.pages[0];
          if (first) openPage(first.id);
        });
        item.appendChild(button);
        topicList.appendChild(item);
      }
    }
    if (topicEmpty) topicEmpty.hidden = sideTab !== 'topics' || !!(payload.topics && payload.topics.length);
    renderTopicFilters();
  }

  let currentGraph = {nodes: [], edges: [], topics: [], counts: {nodes: 0, edges: 0, topics: 0}};

  async function loadGraph() {
    const id = workspaceId();
    if (!id) {
      currentGraph = {nodes: [], edges: [], topics: [], counts: {nodes: 0, edges: 0, topics: 0}};
      renderGraph(currentGraph);
      return;
    }
    const seen = await request('GET', `/v1/workspaces/${id}/memory/graph`);
    if (seen.status !== 200) {
      currentGraph = {nodes: [], edges: [], topics: [], counts: {nodes: 0, edges: 0, topics: 0}};
      renderGraph(currentGraph);
      show('error', messageFor(seen.body.error, '无法加载记忆图谱。'));
      return;
    }
    currentGraph = seen.body;
    renderGraph(currentGraph);
  }

  function renderPageLinks() {
    const box = document.getElementById('page-links');
    const select = document.getElementById('link-target');
    if (!box || !currentPage) return;
    box.replaceChildren();
    const edges = (currentGraph.edges || []).filter((edge) => edge.source === currentPage.id || edge.target === currentPage.id);
    for (const edge of edges) {
      const otherId = edge.source === currentPage.id ? edge.target : edge.source;
      const other = (currentGraph.nodes || []).find((node) => node.id === otherId);
      const row = document.createElement('p');
      row.className = 'note';
      const label = document.createElement('span');
      label.textContent = `${edge.kind === 'manual' ? '手动连接' : '正文提及'} · ${other ? other.title : otherId}`;
      row.appendChild(label);
      if (edge.kind === 'manual' && edge.id) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = '删除连接';
        button.addEventListener('click', () => removeLink(edge.id));
        row.appendChild(button);
      }
      box.appendChild(row);
    }
    if (select) {
      const used = new Set(edges.map((edge) => (edge.source === currentPage.id ? edge.target : edge.source)));
      used.add(currentPage.id);
      select.replaceChildren();
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = '选择记忆页';
      select.appendChild(empty);
      for (const page of currentGraph.nodes || pageChoices) {
        if (used.has(page.id)) continue;
        const option = document.createElement('option');
        option.value = page.id;
        option.textContent = page.title;
        select.appendChild(option);
      }
    }
  }

  async function removeLink(linkId) {
    const id = workspaceId();
    if (!id || !linkId) return;
    const removed = await request('POST', `/v1/workspaces/${id}/memory/links/${linkId}/remove`, {});
    if (removed.status !== 200) {
      show('error', messageFor(removed.body.error, '无法删除连接。'));
      return;
    }
    show('ok', '已删除连接。');
    await loadGraph();
    renderPageLinks();
  }

  async function loadSession() {
    const session = await request('GET', '/v1/auth/session');
    if (session.status !== 200 || !session.body.user) {
      currentUser = null;
      loginPanel.hidden = false;
      mainPanel.hidden = true;
      editor.hidden = true;
      if (actionEditor) actionEditor.hidden = true;
      await renderProviders();
      return;
    }
    currentUser = session.body.user;
    loginPanel.hidden = true;
    mainPanel.hidden = false;
    const whoami = document.getElementById('whoami');
    whoami.dataset.username = currentUser.username;
    whoami.textContent = '已登录：' + currentUser.username;
    const prefs = await request('GET', '/v1/settings');
    if (prefs.status === 200) applyTheme(prefs.body.settings);
    const listed = await request('GET', '/v1/workspaces');
    workspaces = listed.status === 200 && listed.body.items ? listed.body.items : [];
    workspaceSelect.replaceChildren();
    for (const space of workspaces) {
      const option = document.createElement('option');
      option.value = space.id;
      option.textContent = space.name;
      workspaceSelect.appendChild(option);
    }
    if (!workspaceSelect.value && workspaces[0]) workspaceSelect.value = workspaces[0].id;
    await loadWorkspace();
  }

  async function renderProviders() {
    const box = document.getElementById('oidc-providers');
    if (!box) return;
    box.textContent = '';
    const listed = await request('GET', '/v1/auth/providers');
    if (listed.status !== 200 || !listed.body.items || !listed.body.items.length) return;
    for (const item of listed.body.items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = '使用 ' + item.label + ' 登录';
      button.addEventListener('click', async () => {
        const started = await request('POST', '/v1/auth/oidc/start', {provider: item.id});
        if (started.status !== 200 || !started.body.authorization_url) {
          show('error', messageFor(started.body.error, '无法开始第三方登录。'));
          return;
        }
        globalThis.location.assign(started.body.authorization_url);
      });
      box.appendChild(button);
    }
  }

  async function loadWorkspace() {
    closeDeleteConfirm({restoreFocus: false});
    const id = workspaceId();
    currentPage = null;
    currentAction = null;
    syncExportButton();
    editor.hidden = true;
    if (actionEditor) actionEditor.hidden = true;
    listPanel.hidden = false;
    if (!id) {
      pageChoices = [];
      renderDirectory();
      renderRecent([]);
      fillPageSelect(document.getElementById('new-action-page'), '');
      renderActions([]);
      renderGraph({nodes: [], edges: [], topics: [], counts: {nodes: 0, edges: 0, topics: 0}});
      showView(currentView);
      return;
    }
    const listed = await request('GET', `/v1/workspaces/${id}/memory`);
    if (listed.status !== 200) {
      pageChoices = [];
      renderDirectory();
      renderActions([]);
      renderGraph({nodes: [], edges: [], topics: [], counts: {nodes: 0, edges: 0, topics: 0}});
      show('error', messageFor(listed.body.error, '无法加载记忆页。'));
      return;
    }
    pageChoices = listed.body.items || [];
    renderDirectory();
    renderRecent(pageChoices);
    fillPageSelect(document.getElementById('new-action-page'), '');
    await loadActions();
    await loadGraph();
    renderDirectory();
    renderRecent(pageChoices);
    showView(currentView);
  }

  // While a page or action is open the directory column stays visible (as in
  // the recorded editor); only the overview/side/actions/profile panels hide.
  function showPageMode() {
    listPanel.hidden = false;
    listPanel.dataset.view = 'page';
    for (const id of ['overview-panel', 'memory-side', 'actions-panel', 'profile-panel']) {
      const panel = document.getElementById(id);
      if (panel) panel.hidden = true;
    }
  }

  const rich = document.getElementById('editor-rich');
  const sourceToggle = document.getElementById('editor-source-toggle');
  let sourceMode = false;
  // Only an edited rich body is re-serialised, so opening and saving a page
  // without touching the text keeps its stored markdown byte-for-byte.
  let richDirty = false;
  function syncBodyFromRich() {
    if (!rich || sourceMode || !richDirty) return;
    const markdown = domToMarkdown(rich);
    editor.elements.body.value = markdown;
    const length = document.getElementById('editor-length');
    if (length) {
      const over = markdown.length > 8000;
      length.hidden = !over;
      length.textContent = over ? `正文 ${markdown.length} / 8000 字符，超出上限，保存会被拒绝。` : '';
    }
  }
  function loadRichBody(markdown) {
    if (!rich) return;
    renderMarkdown(document, rich, markdown);
    richDirty = false;
  }
  function setSourceMode(next) {
    if (!rich) return;
    if (next === sourceMode) return;
    if (next) syncBodyFromRich();
    sourceMode = next;
    const field = editor.querySelector('.editor-body-field');
    if (field) field.hidden = !next;
    rich.hidden = next;
    if (!next) loadRichBody(editor.elements.body.value);
    if (sourceToggle) sourceToggle.setAttribute('aria-pressed', next ? 'true' : 'false');
  }
  if (rich) {
    try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch { /* older engines */ }
    rich.addEventListener('input', () => { richDirty = true; syncBodyFromRich(); });
    rich.addEventListener('paste', (event) => {
      // Paste as plain text so foreign HTML never enters the page.
      const text = event.clipboardData && event.clipboardData.getData('text/plain');
      if (text == null) return;
      event.preventDefault();
      document.execCommand('insertText', false, text);
    });
  }
  if (sourceToggle) sourceToggle.addEventListener('click', () => setSourceMode(!sourceMode));

  function richCommand(kind) {
    if (!rich) return;
    rich.focus();
    const block = (tag) => {
      const current = String(document.queryCommandValue('formatBlock') || '').toLowerCase();
      document.execCommand('formatBlock', false, current === tag ? 'p' : tag);
    };
    const simple = {undo: 'undo', redo: 'redo', bold: 'bold', italic: 'italic', strike: 'strikeThrough',
      ul: 'insertUnorderedList', ol: 'insertOrderedList', hr: 'insertHorizontalRule'};
    if (simple[kind]) document.execCommand(simple[kind], false, null);
    else if (kind === 'h1' || kind === 'h2' || kind === 'h3') block(kind);
    else if (kind === 'quote') block('blockquote');
    else if (kind === 'code') {
      const selection = document.getSelection();
      if (selection && selection.rangeCount && rich.contains(selection.anchorNode)) {
        const range = selection.getRangeAt(0);
        const code = document.createElement('code');
        code.textContent = range.toString() || '代码';
        range.deleteContents();
        range.insertNode(code);
        selection.removeAllRanges();
        const after = document.createRange();
        after.selectNodeContents(code);
        selection.addRange(after);
      }
    } else if (kind === 'link') {
      const answer = globalThis.prompt ? globalThis.prompt('链接地址（https://、mailto: 或站内 /路径）', 'https://') : '';
      const href = safeHref(answer);
      if (href) document.execCommand('createLink', false, href);
      else if (answer) show('error', '只支持 https://、http://、mailto: 或站内路径的链接。');
    }
    richDirty = true;
    syncBodyFromRich();
  }

  const exportButton = document.getElementById('page-export');
  const exportStatus = document.getElementById('page-export-status');

  // Export reads the saved page from the server, so it never ships an unsaved
  // draft and it stays identical to what a later reader would find.
  function syncExportButton() {
    if (!exportButton) return;
    const ready = Boolean(currentPage && workspaceId());
    exportButton.disabled = !ready;
    exportButton.title = ready
      ? '把这页已保存的标题、话题和正文导出为 Markdown 文件。'
      : '打开一页记忆后才能导出为 Markdown。';
    if (!ready && exportStatus) {
      exportStatus.hidden = true;
      exportStatus.textContent = '';
    }
  }

  async function exportCurrentPage() {
    if (!currentPage) return;
    const id = workspaceId();
    if (!id) return;
    const url = `/v1/workspaces/${id}/memory/${currentPage.id}/export`;
    const name = exportDownloadName(currentPage.title);
    exportButton.disabled = true;
    try {
      const response = await fetcher(url, {
        method: 'GET', headers: {'Accept': 'text/markdown'}, credentials: 'same-origin',
      });
      if (response.status !== 200) {
        let parsed = {};
        try { parsed = await response.json(); } catch { parsed = {}; }
        show('error', messageFor(parsed.error, '无法导出这页记忆。'));
        return;
      }
      const markdown = await response.text();
      if (exportStatus) {
        exportStatus.hidden = false;
        exportStatus.textContent = '已导出 ' + name + ' · 修订 ' + currentPage.revision;
      }
      const objectUrl = globalThis.URL && globalThis.URL.createObjectURL
        ? globalThis.URL.createObjectURL(new Blob([markdown], {type: 'text/markdown;charset=utf-8'}))
        : '';
      if (!objectUrl) {
        globalThis.location.assign(url);
        show('ok', '已开始下载 ' + name + '。');
        return;
      }
      const download = document.createElement('a');
      download.href = objectUrl;
      download.download = name;
      download.rel = 'noopener';
      document.body.appendChild(download);
      download.click();
      download.remove();
      globalThis.URL.revokeObjectURL(objectUrl);
      show('ok', '已导出 ' + name + '。');
    } finally {
      syncExportButton();
    }
  }

  if (exportButton) exportButton.addEventListener('click', exportCurrentPage);
  // 做梦 asks the server for one consolidation of this page. Accept is the only
  // path that writes the page; ignore and an empty answer leave the text alone.
  const dreamPanel = document.getElementById('dream-panel');
  const dreamButton = document.getElementById('dream-page');
  const dreamSummary = document.getElementById('dream-summary');
  const dreamStatus = document.getElementById('dream-status');
  let dreamSuggestion = null;

  // Only the wording lives here: the suggestion itself must survive the update so
  // 接受 / 忽略 still knows which row they are talking about.
  function resetDream(summary = '', status = '') {
    if (dreamSummary) dreamSummary.textContent = summary;
    if (dreamStatus) dreamStatus.textContent = status;
  }

  async function dreamDecide(action) {
    const pageId = currentPage && currentPage.id;
    const wid = workspaceId();
    if (!pageId || !wid || !dreamSuggestion) return;
    const result = await request('POST', `/v1/workspaces/${wid}/memory/${pageId}/dream/${dreamSuggestion.id}`, {action});
    if (result.status !== 200) {
      if (dreamStatus) dreamStatus.textContent = messageFor(result.body.error, '整理建议没有保存成功。');
      return;
    }
    if (action === 'accept' && result.body.page) {
      currentPage = result.body.page;
      editor.elements.body.value = currentPage.body || '';
      loadRichBody(currentPage.body || '');
      document.getElementById('editor-meta').textContent =
        `修订 ${currentPage.revision} · 作者 ${currentPage.created_by} · 最近更新 ${currentPage.updated_by}`;
      const applied = result.body.applied || {};
      resetDream(applied.removed ? '已合并：删掉了一段重复正文。' : '接受时这一页已经没有重复段落，正文未改动。',
                 '这次整理留在这一页的历史里。');
      return;
    }
    resetDream('', '已忽略，原文没有改动。');
  }

  if (dreamButton) dreamButton.addEventListener('click', async () => {
    const pageId = currentPage && currentPage.id;
    const wid = workspaceId();
    if (!pageId || !wid) return;
    if (dreamPanel) dreamPanel.hidden = false;
    const result = await request('POST', `/v1/workspaces/${wid}/memory/${pageId}/dream`, {});
    if (result.status !== 200) {
      if (dreamStatus) dreamStatus.textContent = messageFor(result.body.error, '这一页暂时不能整理。');
      return;
    }
    if (!result.body.suggestion) {
      dreamSuggestion = null;
      resetDream(result.body.message || '这一页现在没有可以合并的重复段落。', '原文没有改动。');
      return;
    }
    dreamSuggestion = result.body.suggestion;
    resetDream(dreamSuggestion.summary, '接受会真的合并；忽略不会改动原文。');
    dreamSuggestion = result.body.suggestion;
  });
  for (const [id, action] of [['dream-accept', 'accept'], ['dream-ignore', 'ignore']]) {
    const button = document.getElementById(id);
    if (button) button.addEventListener('click', () => dreamDecide(action));
  }

  async function openPage(pageId) {
    closeDeleteConfirm({restoreFocus: false});
    closePageHistory({restoreFocus: false});
    hideGraphHoverCard(document.getElementById('graph-hover-card'));
    const id = workspaceId();
    if (!id) return;
    const seen = await request('GET', `/v1/workspaces/${id}/memory/${pageId}`);
    if (seen.status !== 200 || !seen.body.page) {
      show('error', messageFor(seen.body.error, '无法打开记忆页。'));
      return;
    }
    currentPage = seen.body.page;
    currentAction = null;
    if (dreamPanel) dreamPanel.hidden = true;
    dreamSuggestion = null;
    resetDream();
    showPageMode();
    if (actionEditor) actionEditor.hidden = true;
    editor.hidden = false;
    editor.elements.title.value = currentPage.title;
    editor.elements.body.value = currentPage.body || '';
    loadRichBody(currentPage.body || '');
    editor.elements.topics.value = formatTopics(currentPage.topics);
    document.getElementById('editor-meta').textContent =
      `修订 ${currentPage.revision} · 作者 ${currentPage.created_by} · 最近更新 ${currentPage.updated_by}`;
    const savedHint = document.getElementById('editor-saved');
    if (savedHint) {
      const when = memoryUpdatedLabel(currentPage.updated);
      savedHint.hidden = false;
      savedHint.textContent = when ? ('已保存 · ' + when) : ('已保存 · 修订 ' + currentPage.revision);
    }

    renderPageLinks();
    syncExportButton();
  }

  const historyPanel = document.getElementById('page-history');
  const historyOpen = document.getElementById('page-history-open');
  let historySelection = 0;
  let historyTokens = 0;

  function closePageHistory({restoreFocus = true} = {}) {
    if (!historyPanel || historyPanel.hidden) return;
    historyPanel.hidden = true;
    historySelection = 0;
    if (restoreFocus && historyOpen) historyOpen.focus();
  }

  function applyPageToEditor(page) {
    currentPage = page;
    editor.elements.title.value = page.title;
    editor.elements.body.value = page.body || '';
    loadRichBody(page.body || '');
    editor.elements.topics.value = formatTopics(page.topics);
    document.getElementById('editor-meta').textContent =
      `修订 ${page.revision} · 作者 ${page.created_by} · 最近更新 ${page.updated_by}`;
    const savedHint = document.getElementById('editor-saved');
    if (savedHint) {
      const when = memoryUpdatedLabel(page.updated);
      savedHint.hidden = false;
      savedHint.textContent = when ? ('已保存 · ' + when) : ('已保存 · 修订 ' + page.revision);
    }
    renderPageLinks();
  }

  async function loadPageHistory() {
    const wid = workspaceId();
    if (!wid || !currentPage) return;
    const token = ++historyTokens;
    const result = await request('GET', `/v1/workspaces/${wid}/memory/${currentPage.id}/versions`);
    if (token !== historyTokens || workspaceId() !== wid) return;
    const list = document.getElementById('page-history-list');
    const empty = document.getElementById('page-history-empty');
    const status = document.getElementById('page-history-status');
    if (!list) return;
    list.replaceChildren();
    if (result.status !== 200) {
      if (status) status.textContent = '历史没有读取成功。';
      return;
    }
    const items = result.body.items || [];
    if (empty) empty.hidden = items.length > 0;
    if (status) status.textContent = '';
    for (const item of items) {
      const row = document.createElement('li');
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'page-history-item';
      open.dataset.revision = String(item.revision);
      const when = memoryUpdatedLabel(item.created);
      open.textContent = `修订 ${item.revision} · ${when || '时间未知'} · ${item.summary}`;
      open.addEventListener('click', () => previewPageVersion(item.revision));
      row.appendChild(open);
      list.appendChild(row);
    }
  }

  async function openPageHistory() {
    if (!currentPage || !historyPanel) return;
    historyPanel.hidden = false;
    historySelection = 0;
    const preview = document.getElementById('page-history-preview');
    if (preview) preview.hidden = true;
    if (historyOpen) historyOpen.focus();
    await loadPageHistory();
  }

  async function previewPageVersion(revision) {
    const wid = workspaceId();
    if (!wid || !currentPage) return;
    const result = await request('GET', `/v1/workspaces/${wid}/memory/${currentPage.id}/versions/${revision}`);
    if (workspaceId() !== wid) return;
    const status = document.getElementById('page-history-status');
    if (result.status !== 200 || !result.body.version) {
      if (status) status.textContent = '这一版没有读取成功。';
      return;
    }
    const version = result.body.version;
    historySelection = version.revision;
    document.getElementById('page-history-preview-title').textContent =
      `修订 ${version.revision} · ${version.created_by}`;
    document.getElementById('page-history-preview-body').textContent = version.body || '（空白正文）';
    const preview = document.getElementById('page-history-preview');
    if (preview) preview.hidden = false;
    if (status) status.textContent = '';
  }

  async function restorePageVersion() {
    const wid = workspaceId();
    if (!wid || !currentPage || !historySelection) return;
    const revision = historySelection;
    const status = document.getElementById('page-history-status');
    const result = await request(
      'POST', `/v1/workspaces/${wid}/memory/${currentPage.id}/versions/${revision}/restore`,
      {revision: currentPage.revision});
    if (workspaceId() !== wid) return;
    if (result.status !== 200 || !result.body.page) {
      if (status) status.textContent = result.status === 409
        ? '这一页已在别处更新，重新打开后再回滚。'
        : '没有回滚成功。';
      return;
    }
    applyPageToEditor(result.body.page);
    historySelection = 0;
    const preview = document.getElementById('page-history-preview');
    if (preview) preview.hidden = true;
    await loadPageHistory();
    await loadGraph();
    show('ok', `已回滚到修订 ${revision}，保存为新的修订 ${currentPage.revision}。`);
  }

  if (historyOpen) historyOpen.addEventListener('click', openPageHistory);
  const historyClose = document.getElementById('page-history-close');
  if (historyClose) historyClose.addEventListener('click', () => closePageHistory());
  const historyRestore = document.getElementById('page-history-restore');
  if (historyRestore) historyRestore.addEventListener('click', restorePageVersion);

  async function openAction(actionId) {
    closeDeleteConfirm({restoreFocus: false});
    const id = workspaceId();
    if (!id) return;
    const seen = await request('GET', `/v1/workspaces/${id}/memory/actions/${actionId}`);
    if (seen.status !== 200 || !seen.body.action) {
      show('error', messageFor(seen.body.error, '无法打开下一步行动。'));
      return;
    }
    currentAction = seen.body.action;
    currentPage = null;
    syncExportButton();
    showPageMode();
    editor.hidden = true;
    actionEditor.hidden = false;
    actionEditor.elements.title.value = currentAction.title;
    actionEditor.elements.notes.value = currentAction.notes || '';
    actionEditor.elements.status.value = currentAction.status;
    actionEditor.elements.due.value = dueDateValue(currentAction.due_at);
    fillPageSelect(actionEditor.elements.memory_page_id, currentAction.memory_page_id || '');
    document.getElementById('action-editor-meta').textContent =
      `修订 ${currentAction.revision} · 作者 ${currentAction.created_by} · 最近更新 ${currentAction.updated_by}`;
  }

  document.getElementById('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const result = await request('POST', '/v1/auth/login', {
      username: document.getElementById('username').value,
      password: document.getElementById('password').value,
    });
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '登录失败。'));
      return;
    }
    show('ok', '已登录。');
    await loadSession();
  });

  document.getElementById('logout-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const result = await request('POST', '/v1/auth/logout', {});
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法退出登录。'));
      return;
    }
    currentUser = null;
    currentPage = null;
    currentAction = null;
    syncExportButton();
    show('ok', '已退出登录。');
    await loadSession();
  });

  const profileForm = document.getElementById('memory-profile-form');
  if (profileForm) profileForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (profileRevision === null) return;
    const wid = workspaceId();
    const payload = {revision: profileRevision};
    for (const field of ['professional', 'work_style', 'communication']) payload[field] = document.getElementById('profile-' + field).value;
    const status = document.getElementById('memory-profile-status');
    const result = await request('POST', `/v1/workspaces/${wid}/memory/profile`, payload);
    if (workspaceId() !== wid) return;
    if (result.status !== 200) { status.textContent = result.status === 409 ? '画像已在别处更新，请重新打开后重试。' : '画像未保存。'; return; }
    profileRevision = result.body.profile.revision; status.textContent = '画像已保存。';
  });
  // 「偏好」 lives in the 我的资料 view. Rows come from and go back to the
  // workspace store per user, so a reload or a new conversation reads the same
  // list instead of starting from page state.
  const preferences = [];
  let preferenceRequest = 0;

  function preferenceStatus() {
    return document.getElementById('preference-status');
  }

  function renderPreferences() {
    const list = document.getElementById('preference-list');
    const empty = document.getElementById('preferences-empty');
    if (!list) return;
    list.replaceChildren();
    for (const item of preferences) {
      const row = document.createElement('li');
      row.className = 'preference-row';
      const text = document.createElement('span');
      text.className = 'preference-text';
      text.textContent = item.text;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'preference-remove';
      remove.textContent = '删除';
      remove.dataset.id = item.id;
      remove.addEventListener('click', async () => {
        const wid = workspaceId();
        if (!wid) return;
        const status = preferenceStatus();
        const result = await request(
          'POST', `/v1/workspaces/${wid}/memory/preferences/${encodeURIComponent(item.id)}/remove`, {});
        if (workspaceId() !== wid) return;
        if (result.status === 404) {
          await loadPreferences();
          if (status) status.textContent = '这条偏好已经不在列表里。';
          return;
        }
        if (result.status !== 200) {
          if (status) status.textContent = '偏好没有删除成功。';
          return;
        }
        const index = preferences.findIndex(entry => entry.id === item.id);
        if (index >= 0) preferences.splice(index, 1);
        renderPreferences();
        if (status) status.textContent = '已删除偏好。';
      });
      row.appendChild(text);
      row.appendChild(remove);
      list.appendChild(row);
    }
    if (empty) {
      empty.textContent = PREFERENCES_EMPTY;
      empty.hidden = preferences.length > 0;
    }
  }

  async function loadPreferences() {
    const wid = workspaceId();
    const token = ++preferenceRequest;
    const list = document.getElementById('preference-list');
    if (!wid || !list) return;
    // A workspace switch must not leave the other workspace's rows visible
    // while this one is still loading.
    preferences.length = 0;
    renderPreferences();
    const result = await request('GET', `/v1/workspaces/${wid}/memory/preferences`);
    if (token !== preferenceRequest || workspaceId() !== wid) return;
    if (result.status !== 200) {
      const status = preferenceStatus();
      if (status) status.textContent = '偏好没有读取成功。';
      return;
    }
    preferences.length = 0;
    preferences.push(...(result.body.items || []));
    renderPreferences();
  }

  const addPreference = document.getElementById('add-preference');
  if (addPreference) {
    addPreference.addEventListener('click', async () => {
      const wid = workspaceId();
      const input = document.getElementById('preference-input');
      const status = preferenceStatus();
      const text = String((input && input.value) || '').trim();
      if (!wid) return;
      if (!text) {
        status.textContent = '请先写一条偏好。';
        return;
      }
      const result = await request(
        'POST', `/v1/workspaces/${wid}/memory/preferences`, {text}, {'Idempotency-Key': randomKey()});
      if (workspaceId() !== wid) return;
      if (result.status !== 200 && result.status !== 201) {
        status.textContent = result.status === 429
          ? '这个工作区的偏好数量已到上限，先删掉几条再加。'
          : '偏好没有保存成功。';
        return;
      }
      const saved = result.body.preference;
      const known = preferences.some(entry => entry.id === saved.id);
      if (!known) preferences.push(saved);
      input.value = '';
      renderPreferences();
      status.textContent = (result.status === 200 && known) ? '这条偏好已经在列表里。' : '已添加偏好。';
    });
  }
  renderPreferences();

  function invalidateMemoryProfile() {
    // A workspace switch must not leave the previous workspace's revision or
    // an enabled Save button while the new workspace profile is still loading.
    profileRevision = null;
    profileRequest += 1;
    const save = document.getElementById('save-memory-profile'); if (save) save.disabled = true;
  }
  workspaceSelect.addEventListener('change', async () => {
    invalidateMemoryProfile();
    const historyFocus = {restoreFocus: false};
    closePageHistory(historyFocus);
    await loadWorkspace();
    if (currentView === 'profile') await loadMemoryProfile();
    if (currentView === 'profile') await loadPreferences();
  });
  document.getElementById('search').addEventListener('input', () => renderDirectory());
  document.getElementById('search').addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    const box = document.getElementById('search');
    box.value = '';
    renderDirectory();
    if (box.focus) box.focus();
  });
  document.getElementById('action-filter').addEventListener('change', () => loadActions());

  for (const button of document.querySelectorAll('.memory-views [data-view]')) {
    button.addEventListener('click', (event) => {
      if (button.tagName === 'A') event.preventDefault();
      showView(button.getAttribute('data-view'));
    });
  }
  const memoryWindow = document.defaultView;
  if (memoryWindow && memoryWindow.addEventListener) {
    memoryWindow.addEventListener('popstate', () => {
      showView(memoryPageFromSearch(memoryWindow.location.search), {sync: false});
    });
  }
  for (const button of document.querySelectorAll('.memory-filters [data-filter]')) {
    button.addEventListener('click', () => {
      listFilter = button.getAttribute('data-filter') || 'all';
      const box = document.getElementById('topic-filter-box');
      if (box) box.hidden = listFilter !== 'topics';
      for (const item of document.querySelectorAll('.memory-filters [data-filter]')) {
        item.setAttribute('aria-pressed', item.getAttribute('data-filter') === listFilter ? 'true' : 'false');
      }
      renderDirectory();
    });
  }
  for (const button of document.querySelectorAll('.side-tabs [data-side]')) {
    button.addEventListener('click', () => {
      sideTab = button.getAttribute('data-side') || 'topics';
      for (const item of document.querySelectorAll('.side-tabs [data-side]')) {
        item.setAttribute('aria-selected', item.getAttribute('data-side') === sideTab ? 'true' : 'false');
      }
      const topics = document.getElementById('topic-list');
      const topicEmpty = document.getElementById('topic-empty');
      const recent = document.getElementById('recent-list');
      const recentEmpty = document.getElementById('recent-empty');
      if (topics) topics.hidden = sideTab !== 'topics';
      if (topicEmpty) topicEmpty.hidden = sideTab !== 'topics' || !!(currentGraph.topics && currentGraph.topics.length);
      if (recent) recent.hidden = sideTab !== 'recent';
      if (recentEmpty) recentEmpty.hidden = sideTab !== 'recent' || pageChoices.length > 0;
    });
  }
  const collapseButton = document.getElementById('dir-collapse');
  const expandButton = document.getElementById('dir-expand');
  if (collapseButton) {
    collapseButton.addEventListener('click', (event) => {
      event.stopPropagation();
      applyDirectoryCollapsed(document, true);
    });
  }
  if (expandButton) {
    expandButton.addEventListener('click', (event) => {
      event.stopPropagation();
      applyDirectoryCollapsed(document, false);
    });
  }
  const topicSearch = document.getElementById('topic-search');
  if (topicSearch) {
    topicSearch.addEventListener('input', () => {
      topicQuery = topicSearch.value;
      renderGraph(currentGraph);
    });
  }
  const zoomIn = document.getElementById('graph-zoom-in');
  const zoomOut = document.getElementById('graph-zoom-out');
  const zoomReset = document.getElementById('graph-zoom-reset');
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && pendingDelete) {
      closeDeleteConfirm();
      return;
    }
    if (event.key === 'Escape') hideGraphHoverCard(document.getElementById('graph-hover-card'));
  });
  if (zoomIn) zoomIn.addEventListener('click', () => { graphZoom = Math.min(2.4, graphZoom + 0.2); renderGraph(currentGraph); });
  if (zoomOut) zoomOut.addEventListener('click', () => { graphZoom = Math.max(0.6, graphZoom - 0.2); renderGraph(currentGraph); });
  if (zoomReset) zoomReset.addEventListener('click', () => { graphZoom = 1; renderGraph(currentGraph); });

  const initialSearch = document.defaultView && document.defaultView.location
    ? document.defaultView.location.search
    : '';
  showView(memoryPageFromSearch(initialSearch), {sync: false});

  const graphEmptyNew = document.getElementById('graph-empty-new');
  if (graphEmptyNew) {
    graphEmptyNew.addEventListener('click', () => {
      const create = document.getElementById('new-page');
      if (create) create.click();
    });
  }

  document.getElementById('new-page').addEventListener('click', async () => {
    const id = workspaceId();
    if (!id) return;
    const title = unusedTitle('未命名页面');
    const created = await fetcher(`/v1/workspaces/${id}/memory`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfCookie(document.cookie),
        'Idempotency-Key': randomKey(),
      },
      credentials: 'same-origin',
      body: JSON.stringify({title, body: ''}),
    });
    let parsed = {};
    try { parsed = await created.json(); } catch { parsed = {}; }
    if (created.status !== 201 && created.status !== 200) {
      show('error', messageFor(parsed.error, '无法创建记忆页。'));
      return;
    }
    show('ok', '已创建记忆页。');
    await openPage(parsed.page.id);
  });

  const toolbar = editor.querySelector('.editor-toolbar');
  if (toolbar) {
    toolbar.addEventListener('mousedown', (event) => {
      // Keep the text selection inside the editor when a tool is pressed.
      if (event.target.closest('[data-rich]')) event.preventDefault();
    });
    toolbar.addEventListener('click', (event) => {
      const button = event.target.closest('[data-rich]');
      if (!button) return;
      const kind = button.getAttribute('data-rich');
      if (sourceMode || !rich) {
        if (kind !== 'undo' && kind !== 'redo') applyMarkdown(editor.elements.body, kind);
        editor.elements.body.focus();
        return;
      }
      richCommand(kind);
    });
  }

  editor.addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = workspaceId();
    if (!id || !currentPage) return;
    syncBodyFromRich();
    const saved = await request('POST', `/v1/workspaces/${id}/memory/${currentPage.id}`, {
      revision: currentPage.revision,
      changes: {
        title: editor.elements.title.value,
        body: editor.elements.body.value,
        topics: parseTopics(editor.elements.topics.value),
      },
    });
    if (saved.status !== 200 || !saved.body.page) {
      show('error', messageFor(saved.body.error, '无法保存记忆页。'));
      return;
    }
    closeDeleteConfirm({restoreFocus: false});
    currentPage = saved.body.page;
    syncExportButton();
    editor.elements.topics.value = formatTopics(currentPage.topics);
    document.getElementById('editor-meta').textContent =
      `修订 ${currentPage.revision} · 作者 ${currentPage.created_by} · 最近更新 ${currentPage.updated_by}`;
    const savedHint = document.getElementById('editor-saved');
    if (savedHint) {
      const when = memoryUpdatedLabel(currentPage.updated);
      savedHint.hidden = false;
      savedHint.textContent = when ? ('已保存 · ' + when) : ('已保存 · 修订 ' + currentPage.revision);
    }

    await loadGraph();
    renderPageLinks();
    if (historyPanel && !historyPanel.hidden) await loadPageHistory();
    show('ok', '已保存。');
  });

  const deleteParts = {
    page: {
      trigger: document.getElementById('delete-page'),
      dialog: document.getElementById('page-delete-confirm'),
      question: document.getElementById('page-delete-question'),
      confirm: document.getElementById('page-delete-confirm-submit'),
      cancel: document.getElementById('page-delete-confirm-cancel'),
    },
    action: {
      trigger: document.getElementById('delete-action'),
      dialog: document.getElementById('action-delete-confirm'),
      question: document.getElementById('action-delete-question'),
      confirm: document.getElementById('action-delete-confirm-submit'),
      cancel: document.getElementById('action-delete-confirm-cancel'),
    },
  };

  function deleteRemovePath(kind, workspace, id) {
    return kind === 'page'
      ? `/v1/workspaces/${workspace}/memory/${id}/remove`
      : `/v1/workspaces/${workspace}/memory/actions/${id}/remove`;
  }

  function closeDeleteConfirm({restoreFocus = true} = {}) {
    const pending = pendingDelete;
    if (!pending) return;
    pendingDelete = null;
    const parts = deleteParts[pending.kind];
    if (parts.question) parts.question.textContent = '';
    if (parts.dialog) parts.dialog.hidden = true;
    if (parts.trigger) {
      parts.trigger.hidden = false;
      if (restoreFocus && parts.trigger.focus) parts.trigger.focus();
    }
  }

  function openDeleteConfirm(kind, target) {
    const workspace = workspaceId();
    if (!workspace || !target || !target.id) return;
    const parts = deleteParts[kind];
    if (!parts.dialog || !parts.question) return;
    closeDeleteConfirm({restoreFocus: false});
    // The question owns the target it names: confirming must not re-read the
    // editor's current row or the current workspace.
    pendingDelete = {kind, workspace, id: target.id};
    parts.question.textContent =
      `${kind === 'page' ? '删除这条记忆页' : '删除这条下一步行动'}「${String(target.title || '')}」？`;
    if (parts.trigger) parts.trigger.hidden = true;
    parts.dialog.hidden = false;
    if (parts.cancel && parts.cancel.focus) parts.cancel.focus();
  }

  async function removePending(kind) {
    const pending = pendingDelete;
    if (!pending || pending.kind !== kind) return;
    closeDeleteConfirm({restoreFocus: false});
    const removed = await request('POST', deleteRemovePath(kind, pending.workspace, pending.id), {});
    if (removed.status !== 200) {
      show('error', messageFor(removed.body.error,
        kind === 'page' ? '无法删除记忆页。' : '无法删除下一步行动。'));
      return;
    }
    show('ok', '已删除。');
    await loadWorkspace();
  }

  document.getElementById('delete-page').addEventListener('click', () => {
    openDeleteConfirm('page', currentPage);
  });
  for (const [kind, parts] of Object.entries(deleteParts)) {
    if (parts.confirm) parts.confirm.addEventListener('click', () => removePending(kind));
    if (parts.cancel) parts.cancel.addEventListener('click', () => closeDeleteConfirm());
  }

  const addLink = document.getElementById('add-link');
  if (addLink) {
    addLink.addEventListener('click', async () => {
      const id = workspaceId();
      const target = document.getElementById('link-target');
      if (!id || !currentPage || !target || !target.value) return;
      const created = await fetcher(`/v1/workspaces/${id}/memory/links`, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfCookie(document.cookie),
          'Idempotency-Key': randomKey(),
        },
        credentials: 'same-origin',
        body: JSON.stringify({source: currentPage.id, target: target.value}),
      });
      let parsed = {};
      try { parsed = await created.json(); } catch { parsed = {}; }
      if (created.status !== 201 && created.status !== 200) {
        show('error', messageFor(parsed.error, '无法添加连接。'));
        return;
      }
      show('ok', '已添加连接。');
      await loadGraph();
      renderPageLinks();
    });
  }

  document.getElementById('close-editor').addEventListener('click', () => loadWorkspace());

  const newActionOpen = document.getElementById('new-action-open');
  if (newActionOpen) {
    newActionOpen.addEventListener('click', () => {
      const form = document.getElementById('new-action-form');
      if (form) form.dataset.open = 'true';
      syncActionComposer(false);
    });
  }
  document.getElementById('new-action-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = workspaceId();
    if (!id) return;
    const title = document.getElementById('new-action-title').value.trim();
    const notes = document.getElementById('new-action-notes').value;
    const dueAt = dueAtFromDate(document.getElementById('new-action-due').value);
    const pageId = document.getElementById('new-action-page').value || null;
    const payload = {title, notes};
    if (dueAt != null) payload.due_at = dueAt;
    if (pageId) payload.memory_page_id = pageId;
    const created = await fetcher(`/v1/workspaces/${id}/memory/actions`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfCookie(document.cookie),
        'Idempotency-Key': randomKey(),
      },
      credentials: 'same-origin',
      body: JSON.stringify(payload),
    });
    let parsed = {};
    try { parsed = await created.json(); } catch { parsed = {}; }
    if (created.status !== 201 && created.status !== 200) {
      show('error', messageFor(parsed.error, '无法创建下一步行动。'));
      return;
    }
    document.getElementById('new-action-title').value = '';
    document.getElementById('new-action-notes').value = '';
    document.getElementById('new-action-due').value = '';
    document.getElementById('new-action-page').value = '';
    show('ok', '已创建下一步行动。');
    await openAction(parsed.action.id);
  });

  actionEditor.addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = workspaceId();
    if (!id || !currentAction) return;
    const saved = await request('POST', `/v1/workspaces/${id}/memory/actions/${currentAction.id}`, {
      revision: currentAction.revision,
      changes: {
        title: actionEditor.elements.title.value,
        notes: actionEditor.elements.notes.value,
        status: actionEditor.elements.status.value,
        due_at: dueAtFromDate(actionEditor.elements.due.value),
        memory_page_id: actionEditor.elements.memory_page_id.value || null,
      },
    });
    if (saved.status !== 200 || !saved.body.action) {
      show('error', messageFor(saved.body.error, '无法保存下一步行动。'));
      return;
    }
    closeDeleteConfirm({restoreFocus: false});
    currentAction = saved.body.action;
    document.getElementById('action-editor-meta').textContent =
      `修订 ${currentAction.revision} · 作者 ${currentAction.created_by} · 最近更新 ${currentAction.updated_by}`;
    show('ok', '已保存。');
  });

  document.getElementById('delete-action').addEventListener('click', () => {
    openDeleteConfirm('action', currentAction);
  });

  document.getElementById('close-action-editor').addEventListener('click', () => loadWorkspace());

  loadSession();
  return {renderGraph};
}

if (typeof document !== 'undefined' && document.getElementById('login-form')) {
  mount(document);
}
