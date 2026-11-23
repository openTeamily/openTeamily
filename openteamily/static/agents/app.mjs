import { createLookAvatar } from '../look/app.mjs';
import { AGENT_CATEGORIES, AGENT_CATEGORY_SLUGS, categoryFromSearch, categoryLabel } from '../shell/agent-categories.mjs';
import { csrfCookie, canManage, idempotencyKey } from '../shell/chat-utils.mjs';
import { servedByDsBot } from '../shell/dsbot-api.mjs';

export { AGENT_CATEGORIES, categoryFromSearch, categoryLabel } from '../shell/agent-categories.mjs';
export { csrfCookie, canManage, idempotencyKey, statusLabel } from '../shell/chat-utils.mjs';

// Two-letter card monogram ("Slides Assistant" -> "SA"; CJK names keep one glyph).
export function agentMonogram(name) {
  const text = String(name || '').replace(/^\s*\[[^\]]*\]\s*/, '');
  const words = text.match(/[\p{L}\p{N}]+/gu) || [];
  if (!words.length) return '?';
  if (/^\p{Script=Han}/u.test(words[0])) return words[0].slice(0, 1);
  return words.slice(0, 2).map((word) => word[0].toUpperCase()).join('');
}

export function agentTone(name) {
  let hash = 0;
  for (const ch of String(name || '')) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return String((hash % 6) + 1);
}

export function searchWithCategory(search, slug) {
  const params = new URLSearchParams((search || '').replace(/^\?/, ''));
  if (!slug || slug === 'all') params.delete('category');
  else params.set('category', slug);
  const next = params.toString();
  return next ? '?' + next : '';
}

const directoryId = /^[0-9a-f]{32}$/;
const editLimits = {name:80, summary:500, instructions:16000, quick_starts:404, category:80};
const editFields = Object.keys(editLimits);

function directoryTarget(hash) {
  const params = new URLSearchParams((hash || '').replace(/^#/, ''));
  const workspaces = params.getAll('workspace');
  const agents = params.getAll('agent');
  const workspace = workspaces[0] || '';
  const agent = agents[0] || '';
  if ((workspaces.length && (workspaces.length !== 1 || !directoryId.test(workspace))) ||
      (agents.length && (agents.length !== 1 || !workspace || !directoryId.test(agent)))) {
    return {invalid: true};
  }
  return {workspace, agent, archived: params.get('status') === 'archived'};
}

export function teamDirectoryLink(search) {
  return search === '?tab=teams' || search === '?tab=teams&new=1';
}

export function readAgentForm(form) {
  const data = new FormData(form);
  const quickStarts = data.get('quick_starts');
  return {
    name: (data.get('name') || '').trim(),
    summary: (data.get('summary') || '').trim(),
    instructions: data.get('instructions') || '',
    category: AGENT_CATEGORY_SLUGS.has(data.get('category')) ? data.get('category') : null,
    ...(typeof quickStarts === 'string' ? {quick_starts: quickStarts.split(/\r?\n/).map(line => line.trim()).filter(Boolean)} : {}),
  };
}

export function matchesCategory(item, slug) {
  return !slug || slug === 'all' || (item && item.category === slug);
}

export function matchesCreator(item, creatorId) {
  return !creatorId || (item && item.created_by === creatorId);
}

export function creatorChoices(items, names) {
  const seen = new Map();
  for (const item of items || []) {
    const id = item && item.created_by;
    if (id && !seen.has(id)) seen.set(id, (names && names.get(id)) || '用户 ' + String(id).slice(0, 8));
  }
  return [...seen.entries()]
    .sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]))
    .map(([id, label]) => ({id, label}));
}

export function fillCreatorOptions(select, items, names, doc) {
  if (!select) return;
  const chosen = select.value;
  const producer = doc || select.ownerDocument;
  const choices = creatorChoices(items, names);
  select.replaceChildren();
  const all = producer.createElement('option');
  all.value = '';
  all.textContent = '全部';
  select.append(all);
  for (const choice of choices) {
    const option = producer.createElement('option');
    option.value = choice.id;
    option.textContent = choice.label;
    select.append(option);
  }
  select.value = choices.some((choice) => choice.id === chosen) ? chosen : '';
}

export function fillCategoryOptions(select, doc) {
  if (!select || !select.options || select.options.length > 1) return;
  for (const entry of AGENT_CATEGORIES) {
    const option = (doc || select.ownerDocument).createElement('option');
    option.value = entry.slug;
    option.textContent = entry.label;
    select.append(option);
  }
}

// The template endpoint reports a handful of known refusals; keep those in the
// page's language and leave anything else in the server's own words.
export function teamTemplateFailure(status, body) {
  const message = body && body.error && body.error.message ? String(body.error.message) : '';
  if (/Only workspace owners and admins/i.test(message)) return '只有工作区所有者或管理员可以创建 AI 团队。';
  if (/Template not found/i.test(message)) return '没有找到这个团队模板。';
  if (/Idempotency/i.test(message)) return '这次请求的幂等键无效，请重试。';
  if (/Conversation (member limit|capacity) reached/i.test(message)) return '群会话或成员配额已满，先清理旧群会话再试。';
  return message || '无法用这个模板建团队。';
}

export function templateAgentText(template) {
  const names = (template && template.agents ? template.agents : []).map((agent) => agent.name).filter(Boolean);
  return names.length ? '含 ' + names.length + ' 个智能体：' + names.join('、') : '';
}

function teamTemplateKey() {
  const bytes = new Uint8Array(18);
  globalThis.crypto.getRandomValues(bytes);
  let text = '';
  for (const value of bytes) text += String.fromCharCode(value);
  return globalThis.btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function messageFor(error, fallback) {
  if (error && error.message) return error.message;
  return fallback;
}

function validCreateReceipt(attempt) {
  const {values, key} = attempt || {};
  return typeof key === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(key) &&
    values && typeof values.name === 'string' && values.name.trim() &&
    ['name', 'summary', 'instructions'].every(field => typeof values[field] === 'string' && values[field].length <= editLimits[field]) &&
    (values.category === null || AGENT_CATEGORY_SLUGS.has(values.category)) &&
    (values.quick_starts === undefined || (Array.isArray(values.quick_starts) && values.quick_starts.length <= 5 &&
      values.quick_starts.every(line => typeof line === 'string' && line.length <= 80)));
}

export function mount(document, {fetcher = globalThis.fetch.bind(globalThis)} = {}) {
  const status = document.getElementById('status');
  const loginPanel = document.getElementById('login-panel');
  const mainPanel = document.getElementById('main-panel');
  const workspaceSelect = document.getElementById('workspace');
  const createForm = document.getElementById('create-form');
  const createStatus = document.getElementById('agent-create-status');
  const cancelCreate = document.getElementById('cancel-create');
  const editForm = document.getElementById('edit-form');
  const editConflict = document.getElementById('agent-edit-conflict');
  const reloadSettings = document.getElementById('reload-agent-settings');
  const draftNotice = document.getElementById('agent-edit-draft');
  const draftText = document.getElementById('agent-edit-draft-note');
  const restoreDraft = document.getElementById('restore-agent-draft');
  const clearDraft = document.getElementById('discard-agent-draft');
  const chatPanel = document.getElementById('chat-panel');
  const drawer = document.getElementById('manage-drawer');
  const apiKeyOutput = document.getElementById('api-key-token');
  const apiKeyValue = document.getElementById('api-key-value');
  const openCreate = document.getElementById('open-create');
  const openSharing = document.getElementById('agent-share-open');
  const openAccess = document.getElementById('agent-access-open');
  const nativeSharing = servedByDsBot(document);
  let sharing;
  const directoryStatus = document.getElementById('agent-status');
  const directoryStatusControl = document.getElementById('agent-status-control');
  let archivedOnly = false;
  let loadedArchived = false;
  const archiveWrites = new Set();
  let currentUser = null;
  let actor = null;
  let workspaces = [];
  let currentAgent = null;
  let revealedApiKey = '';
  let draftKey = '', originalEdits, waitingDraft;
  let personalIdentity = null;
  let agentSelection = 0;
  let sessionLoad = 0;
  let workspaceLoad = 0;
  let loadedWorkspace = '';
  let directoryLoaded = false;
  const createAttempts = new Map();
  fillCategoryOptions(createForm.elements.category, document);
  fillCategoryOptions(editForm.elements.category, document);
  const categoryButtons = [...document.querySelectorAll('.filter-row .pill[data-category]')];
  const creatorFilter = document.getElementById('creator-filter');
  let selectedCategory = categoryFromSearch(globalThis.location && globalThis.location.search);
  let selectedCreator = '';
  let memberNames = new Map();
  let teamTemplates = [];
  let teamTemplatesLoaded = false;
  const directorySearch = globalThis.location?.search || '';
  let teamsTabSelected = teamDirectoryLink(directorySearch);
  let focusTemplates = directorySearch === '?tab=teams&new=1';

  function clearApiKeyToken() {
    revealedApiKey = '';
    if (apiKeyOutput) apiKeyOutput.hidden = true;
    if (apiKeyValue) apiKeyValue.textContent = '';
  }

  function hideDrawer() {
    sharing?.close();
    currentAgent = null;
    draftKey = '';
    originalEdits = waitingDraft = null;
    agentSelection += 1;
    createForm.hidden = editForm.hidden = chatPanel.hidden = true;
    if (drawer) drawer.hidden = true;
    for (const id of ['homepage-panel', 'api-key-panel']) {
      const control = document.getElementById(id);
      if (control) control.hidden = true;
    }
    clearApiKeyToken();
  }

  function renderCategoryFilter() {
    for (const button of categoryButtons) {
      button.setAttribute('aria-pressed', button.dataset.category === selectedCategory ? 'true' : 'false');
    }
  }

  function selectCategory(slug, push) {
    selectedCategory = AGENT_CATEGORY_SLUGS.has(slug) ? slug : 'all';
    renderCategoryFilter();
    if (directoryLoaded) renderDirectory();
    if (!globalThis.location || !globalThis.history) return;
    const next = searchWithCategory(globalThis.location.search, selectedCategory);
    const url = globalThis.location.pathname + next + globalThis.location.hash;
    if (push && globalThis.history.pushState) globalThis.history.pushState(null, '', url);
    else if (globalThis.history.replaceState) globalThis.history.replaceState(null, '', url);
  }

  renderCategoryFilter();
  for (const button of categoryButtons) {
    button.addEventListener('click', () => selectCategory(button.dataset.category, true));
  }
  if (globalThis.addEventListener) {
    globalThis.addEventListener('popstate', () => {
      selectedCategory = categoryFromSearch(globalThis.location.search);
      renderCategoryFilter();
      if (currentUser && workspaces.length) return restoreDirectory();
    });
  }

  function show(kind, text) {
    status.dataset.kind = kind;
    status.textContent = text;
  }

  async function request(method, path, body, extra, signal) {
    const headers = {'Accept': 'application/json', 'X-CSRF-Token': csrfCookie(document.cookie), ...(extra || {})};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetcher(path, {
      method, headers, credentials: 'same-origin', signal,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let parsed = {};
    try { parsed = await response.json(); } catch { parsed = {}; }
    return {status: response.status, body: parsed};
  }

  function shareContext() {
    if (!nativeSharing || !currentAgent || !currentUser || !canManage(actor)) return null;
    return {agent:currentAgent, user:currentUser.id, workspace:workspaceId()};
  }

  async function openSharePanel(access) {
    const selected = shareContext();
    if (!selected) return;
    try {
      const {mountAgentSharing} = await import('./sharing.mjs');
      const latest = shareContext();
      if (!latest || latest.agent !== selected.agent || latest.user !== selected.user || latest.workspace !== selected.workspace) return;
      sharing ??= mountAgentSharing(document, {request, context:shareContext, idempotencyKey});
      sharing.open({access});
    } catch {
      const latest = shareContext();
      if (latest?.agent === selected.agent && latest.user === selected.user && latest.workspace === selected.workspace) {
        show('error', document.documentElement?.lang === 'en' ? 'Could not open sharing. Try again.' : '无法打开分享，请重试。');
      }
    }
  }
  openSharing?.addEventListener('click', () => void openSharePanel(false));
  openAccess?.addEventListener('click', () => void openSharePanel(true));

  function renderTeamTemplates() {
    const list = document.getElementById('team-template-list');
    const empty = document.getElementById('teams-empty');
    if (!list) return;
    list.replaceChildren();
    for (const template of teamTemplates) {
      const card = document.createElement('li');
      card.className = 'team-template-card';
      card.dataset.slug = template.slug;
      const name = document.createElement('h3');
      name.textContent = template.name || template.slug;
      const summary = document.createElement('p');
      summary.className = 'summary';
      summary.textContent = template.summary || '';
      const members = document.createElement('p');
      members.className = 'note';
      members.textContent = templateAgentText(template);
      const apply = document.createElement('button');
      apply.type = 'button';
      apply.className = 'primary';
      apply.textContent = '用这个模板建团队';
      apply.dataset.slug = template.slug;
      if (!canManage(actor)) {
        apply.disabled = true;
        apply.title = '只有工作区所有者或管理员可以创建 AI 团队';
      }
      apply.addEventListener('click', () => applyTeamTemplate(template, apply));
      card.append(name, summary, members, apply);
      list.append(card);
    }
    if (empty) empty.hidden = teamTemplates.length > 0;
  }

  async function loadTeamTemplates() {
    if (teamTemplatesLoaded) return;
    const listed = await request('GET', '/v1/team-templates');
    if (listed.status !== 200) {
      const empty = document.getElementById('teams-empty');
      if (empty) {
        empty.hidden = false;
        empty.textContent = '模板列表没有加载出来：' + messageFor(listed.body.error, '服务端没有返回模板。');
      }
      return;
    }
    teamTemplates = listed.body.items || [];
    teamTemplatesLoaded = true;
    renderTeamTemplates();
  }

  async function applyTeamTemplate(template, button) {
    if (!canManage(actor) || button.disabled) return;
    const id = workspaceId();
    if (!id) {
      show('error', '先选择一个工作区，再用模板建团队。');
      return;
    }
    button.disabled = true;
    const previous = button.textContent;
    button.textContent = '正在建团队…';
    try {
      const result = await request('POST', `/v1/workspaces/${id}/team-templates/${template.slug}`, {},
        {'Idempotency-Key': teamTemplateKey()});
      if ((result.status !== 200 && result.status !== 201) || !result.body.conversation) {
        show('error', teamTemplateFailure(result.status, result.body));
        return;
      }
      const href = '/chat#workspace=' + encodeURIComponent(id) + '&social=' + encodeURIComponent(result.body.conversation.id);
      show('ok', '团队已建好，正在打开群会话。');
      if (globalThis.location && typeof globalThis.location.assign === 'function') globalThis.location.assign(href);
      else if (globalThis.location) globalThis.location.href = href;
    } finally {
      button.disabled = false;
      button.textContent = previous;
    }
  }

  function workspaceId() {
    return workspaceSelect.value;
  }

  function createScope() {
    const user = currentUser?.id, workspace = workspaceId();
    return directoryId.test(user || '') && directoryId.test(workspace) ? `ot-agent-create:${user}:${workspace}` : '';
  }

  function readCreateReceipt(scope) {
    const active = createAttempts.get(scope);
    if (active || !scope) return active;
    try {
      const saved = JSON.parse(document.defaultView.sessionStorage.getItem(scope));
      if (!validCreateReceipt(saved)) return;
      const attempt = {key:saved.key, values:saved.values, saved:true};
      createAttempts.set(scope, attempt);
      return attempt;
    } catch { return; }
  }

  function paintCreateControls(attempt) {
    if (openCreate) openCreate.textContent = attempt ? '继续创建智能体' : '创建我的智能体';
    if (createForm.hidden) return;
    for (const field of editFields) {
      if (createForm.elements[field]) createForm.elements[field].disabled = Boolean(attempt);
    }
    const submit = createForm.querySelector('button[type="submit"]');
    submit.disabled = Boolean(attempt?.sending);
    submit.textContent = attempt?.sending ? '创建中…' : attempt ? '核对创建结果' : '创建';
    if (cancelCreate) cancelCreate.textContent = attempt ? '关闭' : '取消';
    if (createStatus) {
      createStatus.hidden = !attempt;
      createStatus.textContent = attempt?.sending ? '正在创建智能体…' : attempt?.saved
        ? '暂时无法确认创建结果。可核对原请求，智能体只会创建一次。'
        : attempt ? '暂时无法确认创建结果。浏览器无法保留记录，请在此页重试。' : '';
    }
  }

  function writeDirectoryTarget(agent, {push = false} = {}) {
    const {location, history} = globalThis;
    const workspace = workspaceId();
    if (!location || !history || !directoryId.test(workspace) || (agent && !directoryId.test(agent))) return;
    const params = new URLSearchParams({workspace});
    if (agent) params.set('agent', agent);
    if (archivedOnly) params.set('status', 'archived');
    const hash = '#' + params;
    if (hash === location.hash) return;
    const url = location.pathname + location.search + hash;
    if (push && history.pushState) history.pushState(null, '', url);
    else history.replaceState?.(null, '', url);
  }

  function syncDirectoryStatus() {
    const available = canManage(actor);
    if (directoryStatusControl) directoryStatusControl.hidden = !available;
    if (directoryStatus) {
      directoryStatus.disabled = !available;
      directoryStatus.value = available && archivedOnly ? 'archived' : 'active';
    }
  }

  async function restoreDirectory() {
    const hash = globalThis.location?.hash;
    const target = directoryTarget(hash);
    const workspace = target.workspace || workspaces[0]?.id;
    if (target.invalid || !workspaces.some(space => space.id === workspace)) {
      workspaceLoad += 1;
      workspaceSelect.value = '';
      actor = null;
      directoryLoaded = false;
      directoryAgents = [];
      loadedWorkspace = '';
      hideDrawer();
      if (openCreate) openCreate.hidden = true;
      syncDirectoryStatus();
      fillCreatorOptions(creatorFilter, [], memberNames, document);
      selectedCreator = '';
      syncTeamRunLink();
      if (teamTemplatesLoaded) renderTeamTemplates();
      document.getElementById('role-note').textContent = '';
      document.getElementById('agent-list').replaceChildren();
      document.getElementById('agents-empty').hidden = true;
      const count = document.getElementById('agents-count');
      if (count) count.textContent = '显示 0 个智能体';
      show('error', '无法访问链接中的工作区，请选择其他工作区。');
      return;
    }
    workspaceSelect.value = workspace;
    archivedOnly = target.archived;
    syncTeamRunLink();
    if (!directoryLoaded || loadedWorkspace !== workspace || loadedArchived !== archivedOnly) {
      if (!await loadWorkspace({directoryOnly: true}) || globalThis.location?.hash !== hash) return;
    } else {
      renderDirectory();
    }
    if (target.agent && target.agent !== currentAgent?.id) {
      hideDrawer();
      await openAgent(target.agent, {record: false});
    } else if (!target.agent) hideDrawer();
  }

  function syncTeamRunLink() {
    const link = document.getElementById('open-team-runs');
    if (!link) return;
    const workspace = workspaceId();
    link.href = /^[0-9a-f]{32}$/.test(workspace) ? '/team-runs#workspace=' + workspace : '/team-runs';
  }

  async function load() {
    const seq = ++sessionLoad;
    workspaceLoad += 1;
    hideDrawer();
    if (openCreate) openCreate.hidden = true;
    const unavailable = {status: 0, body: {}};
    const session = await request('GET', '/v1/auth/session').catch(() => unavailable);
    if (seq !== sessionLoad) return;
    if (session.status !== 200) {
      currentUser = null;
      loginPanel.hidden = false;
      mainPanel.hidden = true;
      show('', '');
      return;
    }
    currentUser = session.body.user;
    loginPanel.hidden = true;
    mainPanel.hidden = false;
    personalIdentity = null;
    actor = null;
    syncDirectoryStatus();
    directoryLoaded = false;
    loadedWorkspace = '';
    directoryAgents = [];
    archivedOnly = false;
    if (directoryStatus) directoryStatus.value = 'active';
    document.getElementById('agent-list').replaceChildren();
    const personalPath = nativeSharing ? '/v1/workspaces?scope=personal&include=personal-agent' : '/v1/personal-agent';
    void request('GET', personalPath).catch(() => unavailable).then(personal => {
      if (seq !== sessionLoad || personal.status !== 200) return;
      const body = personal.body ?? {};
      if (nativeSharing) {
        const space = body.items?.length === 1 ? body.items[0] : null;
        const viewer = body.viewer_username;
        if (space?.kind !== 'personal' || !directoryId.test(space.id) || !directoryId.test(body.personal_agent_id ?? '')
            || (!space.owner_id && !viewer) || (space.owner_id && space.owner_id !== currentUser.id)
            || (viewer && viewer !== currentUser.username)) return;
        personalIdentity = {agentId: body.personal_agent_id, workspaceId: space.id, look: body.personal_look ?? null};
      } else if (body.personal_agent?.agent?.id) {
        const found = body.personal_agent;
        personalIdentity = {agentId: found.agent.id, workspaceId: found.workspace?.id, look: found.look ?? null};
      }
      if (directoryLoaded && personalIdentity && (!personalIdentity.workspaceId || personalIdentity.workspaceId === workspaceId())) {
        renderDirectory();
      }
    });
    const whoami = document.getElementById('whoami');
    whoami.dataset.username = currentUser.username;
    whoami.textContent = '已登录为 ' + currentUser.username;
    const listed = await request('GET', '/v1/workspaces?limit=100').catch(() => unavailable);
    if (seq !== sessionLoad) return;
    workspaces = listed.status === 200 ? (listed.body.items || []) : [];
    workspaceSelect.replaceChildren();
    for (const space of workspaces) {
      const option = document.createElement('option');
      option.value = space.id;
      option.textContent = space.name;
      workspaceSelect.append(option);
    }
    syncTeamRunLink();
    if (!workspaces.length) {
      directoryAgents = [];
      fillCreatorOptions(creatorFilter, [], memberNames, document);
      selectedCreator = '';
      document.getElementById('role-note').textContent = '还没有可访问的工作区。';
      document.getElementById('agent-list').replaceChildren();
      const empty = document.getElementById('agents-empty');
      empty.hidden = false;
      empty.textContent = '这个工作区还没有智能体。';
      const count = document.getElementById('agents-count');
      if (count) count.textContent = '显示 0 个智能体';
      syncDirectoryStatus();
      show(listed.status === 200 ? '' : 'error', listed.status === 200 ? '' : '无法加载工作区。请刷新后重试。');
      return;
    }
    await restoreDirectory();
    if (seq !== sessionLoad || !teamsTabSelected) return;
    await loadTeamTemplates();
    if (seq === sessionLoad && teamsTabSelected && focusTemplates) {
      focusTemplates = false;
      document.getElementById('teams-panel')?.focus();
    }
  }

  let directoryAgents = [];

  function matchesDirectoryQuery(item, query) {
    if (!query) return true;
    const hay = (item.name + ' ' + (item.summary || '')).toLowerCase();
    return hay.includes(query);
  }

  function renderDirectory() {
    const id = workspaceId();
    const list = document.getElementById('agent-list');
    const empty = document.getElementById('agents-empty');
    const count = document.getElementById('agents-count');
    const query = ((document.getElementById('agent-search') || {}).value || '').trim().toLowerCase();
    list.replaceChildren();
    let shown = 0;
    for (const item of directoryAgents) {
      if (archivedOnly !== Boolean(item.archived || item.native_deleted) ||
          !matchesDirectoryQuery(item, query) || !matchesCategory(item, selectedCategory)
          || !matchesCreator(item, selectedCreator)) continue;
      shown += 1;
      const li = document.createElement('li');
      li.className = 'agent-card';
      const isPersonal = item.id === personalIdentity?.agentId && (!personalIdentity.workspaceId || personalIdentity.workspaceId === id);
      const lookAvatar = isPersonal ? createLookAvatar(personalIdentity.look, document) : null;
      const avatar = lookAvatar || document.createElement('span');
      if (!lookAvatar) {
        avatar.className = 'avatar';
        avatar.textContent = agentMonogram(item.name);
        avatar.dataset.tone = agentTone(item.name);
      }
      const copy = document.createElement('div');
      copy.className = 'copy';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'link';
      button.dataset.id = item.id;
      button.textContent = item.name;
      copy.append(button);
      const note = document.createElement('p');
      note.className = 'summary';
      note.textContent = item.summary || '暂无简介';
      copy.append(note);
      if (item.category && categoryLabel(item.category)) {
        const tag = document.createElement('span');
        tag.className = 'category-tag';
        tag.textContent = categoryLabel(item.category);
        copy.append(tag);
      }
      li.append(avatar, copy);
      if (!archivedOnly) {
        const chat = document.createElement('a');
        chat.className = 'chat-cta';
        chat.href = '/chat#workspace=' + encodeURIComponent(id) + '&agent=' + encodeURIComponent(item.id);
        chat.textContent = '聊天';
        li.append(chat);
      } else {
        const label = document.createElement('span');
        label.className = 'archive-label';
        label.textContent = item.native_deleted ? '已删除' : '已归档';
        copy.append(label);
        if (canManage(actor) && !item.native_deleted) {
          const restore = document.createElement('button');
          restore.type = 'button';
          restore.className = 'chat-cta';
          restore.textContent = '恢复';
          restore.addEventListener('click', () => changeArchive(item, false, restore));
          li.append(restore);
        }
      }
      list.append(li);
    }
    if (empty) {
      empty.hidden = shown > 0;
      empty.textContent = !directoryAgents.length
        ? archivedOnly ? '这个工作区没有已归档的智能体。' : '这个工作区还没有智能体。'
        : query
        ? '没有匹配的智能体。试试其他关键词。'
        : selectedCreator
          ? '没有符合筛选的智能体'
          : selectedCategory !== 'all' && directoryAgents.length
            ? '「' + categoryLabel(selectedCategory) + '」类目下还没有智能体。选「全部」查看其余智能体。'
            : '这个工作区还没有智能体。';
    }
    if (count) count.textContent = '显示 ' + shown + (archivedOnly ? ' 个已归档的智能体' : ' 个智能体');
  }

  document.getElementById('api-key-copy')?.addEventListener('click', async () => {
    const key = revealedApiKey;
    if (!key || apiKeyOutput.hidden) return;
    try {
      await document.defaultView.navigator.clipboard.writeText(apiKeyValue.textContent);
      if (key === revealedApiKey) show('ok', '密钥已复制。');
    } catch {
      if (key === revealedApiKey) show('error', '无法访问剪贴板，请选中密钥手动复制。');
    }
  });

  const apiKeyForm = document.getElementById('api-key-form');
  if (apiKeyForm) apiKeyForm.addEventListener('submit', async event => {
    event.preventDefault();
    const submit = apiKeyForm.querySelector('button[type="submit"]');
    if (!currentAgent || submit.disabled) return;
    const agent = currentAgent, wid = workspaceId(), owner = currentUser?.id, selection = agentSelection;
    const nameInput = document.getElementById('api-key-name');
    const sameSelection = () => workspaceId() === wid && currentUser?.id === owner &&
      currentAgent?.id === agent.id && agentSelection === selection;
    submit.disabled = true;
    try {
      const result = await request('POST', `/v1/workspaces/${wid}/agents/${agent.id}/api-keys`, {
        name: nameInput.value,
        rate_per_minute: Number(document.getElementById('api-key-rate').value) || 10,
      });
      if (!sameSelection()) return;
      const {token, key} = result.body;
      if (result.status !== 201 || !key?.id || !token) {
        show('error', messageFor(result.body.error, '无法生成密钥。'));
        return;
      }
      revealedApiKey = key.id;
      apiKeyValue.textContent = token;
      apiKeyOutput.hidden = false;
      nameInput.value = '';
      show('ok', '密钥已生成，请复制。');
      void loadApiKeys(agent, true);
    } catch {
      if (sameSelection()) {
        show('error', '未收到新密钥，请先检查密钥列表。');
        void loadApiKeys(agent, true);
      }
    } finally {
      submit.disabled = false;
    }
  });

  async function listAgents(base, archived) {
    const path = base + '/agents?limit=100' + (archived ? '&archived=1' : '');
    const first = await request('GET', path);
    const cursor = first.body.cursor;
    if (!archived || first.status !== 200 || !/^[0-9a-f]{32}$/.test(cursor)) return first;
    const next = await request('GET', path + '&cursor=' + cursor);
    if (next.status !== 200) return next;
    return {status: 200, body: {items: [...(first.body.items || []), ...(next.body.items || [])]}};
  }

  async function loadWorkspace({directoryOnly = false} = {}) {
    const id = workspaceId();
    if (!id) return false;
    const seq = ++workspaceLoad;
    const user = currentUser?.id;
    let archived = archivedOnly;
    const includeWorkspace = !directoryOnly || id !== loadedWorkspace;
    hideDrawer();
    if (includeWorkspace) {
      actor = null;
      syncDirectoryStatus();
      if (openCreate) openCreate.hidden = true;
      if (teamTemplatesLoaded) renderTeamTemplates();
    }
    if (id !== loadedWorkspace || archived !== loadedArchived) {
      directoryLoaded = false;
      directoryAgents = [];
      document.getElementById('agent-list').replaceChildren();
      document.getElementById('agents-empty').hidden = true;
      if (includeWorkspace) document.getElementById('role-note').textContent = '';
      show('loading', '正在加载智能体…');
    }
    const unavailable = {status: 0, body: {}};
    const base = `/v1/workspaces/${id}`;
    const nativeWorkspace = nativeSharing ? workspaces.find(space => space.id === id) : null;
    const readList = status => listAgents(base, status).catch(() => unavailable);
    const stillCurrent = () => seq === workspaceLoad && id === workspaceId() && user === currentUser?.id;
    const [detail, members, active] = await Promise.all([
      includeWorkspace && !nativeSharing ? request('GET', base).catch(() => unavailable) : null,
      includeWorkspace ? request('GET', base + '/members').catch(() => unavailable) : null,
      archived ? null : readList(false),
    ]);
    if (!stillCurrent()) return false;
    if (includeWorkspace) {
      const workspace = nativeSharing ? nativeWorkspace : detail?.status === 200 ? detail.body.workspace : null;
      if (!workspace) {
        actor = null;
        show('error', messageFor(detail?.body.error, '无法打开工作区。'));
        return false;
      }
      memberNames = new Map(members.status === 200
        ? (members.body.items || []).map(row => [row.user_id, row.username])
        : []);
      const self = members.status === 200
        ? (members.body.items || []).find(row => row.user_id === currentUser.id)
        : null;
      actor = self?.suspended ? 'member' : self?.role || (nativeSharing ? workspace.role || 'member'
        : workspace.owner_id === currentUser.id ? 'owner' : 'member');
      document.getElementById('role-note').textContent = canManage(actor)
        ? '你可以管理这个工作区中的智能体。'
        : '你可以查看这个工作区中的智能体。';
      if (teamTemplatesLoaded) renderTeamTemplates();
    }
    if (archived && !canManage(actor)) {
      archived = archivedOnly = false;
      writeDirectoryTarget(null);
    }
    syncDirectoryStatus();
    const listed = active ?? await readList(archived);
    if (!stillCurrent()) return false;
    if (listed.status !== 200) {
      show('error', messageFor(listed.body.error, '无法加载智能体目录。'));
      return false;
    }
    if (openCreate) openCreate.hidden = archived || !canManage(actor);
    paintCreateControls(archived || !canManage(actor) ? null : readCreateReceipt(createScope()));
    directoryAgents = listed.body.items || [];
    loadedWorkspace = id;
    loadedArchived = archived;
    directoryLoaded = true;
    fillCreatorOptions(creatorFilter, directoryAgents, memberNames, document);
    selectedCreator = creatorFilter ? creatorFilter.value : '';
    renderDirectory();
    show('', '');
    return true;
  }

  function currentEdits() {
    return Object.fromEntries(editFields.filter(field => editForm.elements[field])
      .map(field => [field, editForm.elements[field].value]));
  }

  function applyEdits(values) {
    for (const [field, value] of Object.entries(values)) {
      if (editForm.elements[field]) editForm.elements[field].value = value;
    }
  }

  function readEditDraft() {
    if (!draftKey) return null;
    try {
      const draft = JSON.parse(document.defaultView.sessionStorage.getItem(draftKey));
      if (!Number.isSafeInteger(draft?.revision) || !draft.values) return null;
      const values = Object.fromEntries(editFields.filter(field => typeof draft.values[field] === 'string' &&
        draft.values[field].length <= editLimits[field] &&
        (field !== 'category' || !draft.values[field] || AGENT_CATEGORY_SLUGS.has(draft.values[field])))
        .map(field => [field,draft.values[field]]));
      for (const field of Object.keys(values)) {
        if (values[field] === originalEdits[field]) delete values[field];
      }
      return Object.keys(values).length ? {revision:draft.revision, values} : null;
    } catch { return null; }
  }

  function storeEditDraft() {
    if (!draftKey || !originalEdits || waitingDraft) return;
    const values = Object.fromEntries(Object.entries(currentEdits()).filter(([field,value]) => originalEdits[field] !== value));
    const changed = Object.keys(values).length > 0;
    let saved = false;
    try {
      const storage = document.defaultView.sessionStorage;
      if (changed) storage.setItem(draftKey, JSON.stringify({revision:currentAgent.revision, values}));
      else storage.removeItem(draftKey);
      saved = true;
    } catch {}
    if (draftNotice) draftNotice.hidden = !changed;
    const text = saved ? '草稿已保存在此标签页。' : '有未保存的修改。';
    if (draftText && draftText.textContent !== text) draftText.textContent = text;
    if (restoreDraft) restoreDraft.hidden = true;
  }

  function setEditFieldsEnabled(enabled) {
    for (const field of editFields) {
      if (editForm.elements[field]) editForm.elements[field].disabled = !enabled;
    }
    editForm.querySelector('button[type="submit"]').disabled = !enabled;
  }

  function fillEdit(agent) {
    sharing?.close();
    clearApiKeyToken();
    if (editConflict) editConflict.hidden = true;
    if (reloadSettings) reloadSettings.hidden = true;
    createForm.hidden = true;
    currentAgent = agent;
    editForm.hidden = false;
    editForm.elements.id.value = agent.id;
    editForm.elements.revision.value = String(agent.revision);
    editForm.elements.name.value = agent.name;
    editForm.elements.summary.value = agent.summary || '';
    editForm.elements.instructions.value = agent.instructions || '';
    if (editForm.elements.category) {
      editForm.elements.category.value = AGENT_CATEGORY_SLUGS.has(agent.category) ? agent.category : '';
    }
    const starts = editForm.elements.quick_starts;
    if (starts) starts.value = (agent.quick_starts || []).join('\n');
    const active = !agent.archived && !agent.native_deleted;
    const writable = active && canManage(actor);
    const scope = [currentUser?.id, workspaceId(), agent.id];
    draftKey = writable && scope.every(id => directoryId.test(id || '')) ? 'ot-agent-edit:' + scope.join(':') : '';
    originalEdits = currentEdits();
    const draft = readEditDraft();
    waitingDraft = draft && draft.revision !== agent.revision ? draft : null;
    if (draft && !waitingDraft) applyEdits(draft.values);
    if (waitingDraft) {
      if (draftNotice) draftNotice.hidden = false;
      if (draftText) draftText.textContent = '设置已更新。恢复草稿会应用你改过的字段，请核对后再保存。';
      if (restoreDraft) restoreDraft.hidden = false;
    } else if (draftKey) storeEditDraft();
    else if (draftNotice) draftNotice.hidden = true;
    setEditFieldsEnabled(writable && !waitingDraft);
    document.getElementById('archive-button').hidden = !writable;
    if (openSharing) {
      openSharing.hidden = !nativeSharing || !canManage(actor);
      const english = document.documentElement?.lang?.startsWith('en');
      openSharing.textContent = active ? (english ? 'Share privately' : '私下分享')
        : (english ? 'Manage shares' : '管理分享');
    }
    if (openAccess) {
      openAccess.hidden = !nativeSharing || !canManage(actor);
      const english = document.documentElement?.lang?.startsWith('en');
      openAccess.textContent = active ? (english ? 'Authorize chat with original agent' : '授权与原智能体对话')
        : (english ? 'Manage chat access' : '管理对话授权');
    }
    editForm.querySelector('button[type="submit"]').hidden = !writable;
    document.getElementById('chat-title').textContent = '与 ' + agent.name + ' 的对话';
    chatPanel.hidden = !active;
    if (drawer) {
      drawer.hidden = false;
      drawer.scrollTop = 0;
      if (waitingDraft) restoreDraft?.focus?.();
      else editForm.elements.name.focus?.();
    }
    const openChat = document.getElementById('open-in-chat');
    if (openChat) {
      openChat.href = '/chat#workspace=' + encodeURIComponent(workspaceId()) + '&agent=' + encodeURIComponent(agent.id);
    }
    const homepage = document.getElementById('homepage-panel');
    const manageHome = document.getElementById('manage-public-homepage');
    if (homepage) homepage.hidden = !writable;
    if (manageHome) manageHome.href = '/discover?' + new URLSearchParams({
      tab:'agents', workspace:workspaceId(), agent:agent.id,
    }) + '#catalog-manage';
    loadApiKeys(agent, writable);
  }

  async function loadApiKeys(agent, writable) {
    const panel = document.getElementById('api-key-panel');
    if (!panel) return;
    panel.hidden = !writable || Boolean(agent.archived);
    if (panel.hidden) return;
    const wid = workspaceId();
    let listed;
    try {
      listed = await request('GET', `/v1/workspaces/${wid}/agents/${agent.id}/api-keys`);
    } catch (error) {
      return;  // optional panel; never break the editor
    }
    if (workspaceId() !== wid || !currentAgent || currentAgent.id !== agent.id) return;
    const list = document.getElementById('api-key-list');
    const keys = listed.status === 200 && Array.isArray(listed.body.items) ? listed.body.items : [];
    list.replaceChildren(...keys.map(key => {
      const li = document.createElement('li');
      const meta = document.createElement('span');
      meta.textContent = `${key.name} · ${key.rate_per_minute} 次/分钟 · ${key.revoked ? '已撤销' : '有效'}`
        + (key.last_used ? ' · 用过' : ' · 未使用');
      li.append(meta);
      if (!key.revoked) {
        const revoke = document.createElement('button');
        revoke.type = 'button';
        revoke.textContent = '撤销';
        revoke.addEventListener('click', async () => {
          const result = await request('POST', `/v1/workspaces/${wid}/agents/${agent.id}/api-keys/${key.id}/revoke`, {});
          if (result.status !== 200) { show('error', messageFor(result.body.error, '无法撤销密钥。')); return; }
          if (workspaceId() !== wid || currentAgent?.id !== agent.id) return;
          if (revealedApiKey === key.id) clearApiKeyToken();
          show('ok', '已撤销密钥。');
          void loadApiKeys(agent, writable);
        });
        li.append(revoke);
      }
      return li;
    }));
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

  workspaceSelect.addEventListener('change', () => {
    syncTeamRunLink();
    writeDirectoryTarget(null, {push: true});
    return loadWorkspace();
  });

  async function openAgent(agentId, {record = true} = {}) {
    const workspace = workspaceId();
    const user = currentUser?.id;
    const hash = globalThis.location?.hash;
    const selected = ++agentSelection;
    const result = await request('GET', `/v1/workspaces/${workspace}/agents/${agentId}`).catch(() => ({status:0, body:{}}));
    if (selected !== agentSelection || workspace !== workspaceId() || user !== currentUser?.id ||
        hash !== globalThis.location?.hash) return;
    const agent = result.body.agent;
    if (result.status !== 200 || agent?.id !== agentId || (agent.workspace_id && agent.workspace_id !== workspace)) {
      show('error', messageFor(result.body.error, '无法打开这个智能体。'));
      return;
    }
    fillEdit(agent);
    if (record) writeDirectoryTarget(agent.id, {push: true});
    show('', '');
  }

  document.getElementById('agent-list').addEventListener('click', event => {
    const button = event.target.closest('button[data-id]');
    if (button) return openAgent(button.dataset.id);
  });
  reloadSettings?.addEventListener('click', () => {
    if (currentAgent) return openAgent(currentAgent.id);
  });
  editForm.addEventListener('input', storeEditDraft);
  editForm.addEventListener('change', storeEditDraft);
  restoreDraft?.addEventListener('click', () => {
    if (!waitingDraft) return;
    applyEdits(waitingDraft.values);
    waitingDraft = null;
    setEditFieldsEnabled(true);
    storeEditDraft();
    editForm.elements.name.focus?.();
  });
  clearDraft?.addEventListener('click', () => {
    if (!draftKey || (editForm.querySelector('button[type="submit"]').disabled && !waitingDraft)) return;
    applyEdits(originalEdits);
    waitingDraft = null;
    setEditFieldsEnabled(true);
    storeEditDraft();
    editForm.elements.name.focus?.();
  });

  function invalidQuickStarts(starts) {
    if (!starts || (starts.length <= 5 && starts.every(line => line.length <= 80))) return false;
    show('error', '快捷开场最多 5 条，每条不超过 80 字。');
    return true;
  }

  createForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (createForm.hidden || !canManage(actor) || archivedOnly) return;
    const id = workspaceId();
    const scope = createScope();
    if (!scope) return;
    let attempt = readCreateReceipt(scope);
    if (attempt?.sending) return;
    if (!attempt) {
      const values = readAgentForm(createForm);
      if (invalidQuickStarts(values.quick_starts)) return;
      if (!values.name) {
        show('error', '请填写名称。');
        return;
      }
      attempt = {key:idempotencyKey('agent-create-'), values, saved:false};
      createAttempts.set(scope, attempt);
      try {
        document.defaultView.sessionStorage.setItem(scope, JSON.stringify({key:attempt.key, values}));
        attempt.saved = true;
      } catch {}
    }
    attempt.sending = true;
    paintCreateControls(attempt);
    const result = await request('POST', `/v1/workspaces/${id}/agents`, attempt.values,
      {'Idempotency-Key': attempt.key}, AbortSignal.timeout(20000)).catch(() => ({status:0, body:{}}));
    attempt.sending = false;
    const agent = result.body?.agent;
    const accepted = [200, 201].includes(result.status) && directoryId.test(agent?.id || '') && agent.workspace_id === id;
    const certainFailure = [400, 401, 403, 404, 409, 413, 422].includes(result.status) || result.body?.error?.code === 'quota';
    const sameDirectory = scope === createScope() && loadedWorkspace === id && directoryLoaded && !archivedOnly && canManage(actor);
    if (!accepted && !certainFailure) {
      if (sameDirectory) paintCreateControls(attempt);
      return;
    }
    createAttempts.delete(scope);
    try { document.defaultView.sessionStorage.removeItem(scope); } catch {}
    if (!sameDirectory) return;
    paintCreateControls(null);
    if (!accepted) {
      if (!createForm.hidden && createStatus) {
        createStatus.hidden = false;
        createStatus.textContent = messageFor(result.body?.error, '无法创建智能体。');
      }
      return;
    }
    directoryAgents = [agent, ...directoryAgents.filter(item => item.id !== agent.id)];
    fillCreatorOptions(creatorFilter, directoryAgents, memberNames, document);
    renderDirectory();
    if (!createForm.hidden) {
      createForm.reset();
      fillEdit(agent);
      writeDirectoryTarget(agent.id, {push: true});
      show('ok', '已创建智能体。');
    }
  });

  editForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (!canManage(actor)) return;
    const workspace = workspaceId();
    const selected = agentSelection;
    const edited = event.currentTarget.elements.id.value;
    const submit = event.currentTarget.querySelector('button[type="submit"]');
    if (submit.disabled) return;
    const sentEdits = currentEdits();
    const values = readAgentForm(event.currentTarget);
    if (invalidQuickStarts(values.quick_starts)) return;
    values.revision = Number(event.currentTarget.elements.revision.value);
    submit.disabled = true;
    const result = await request('POST', `/v1/workspaces/${workspace}/agents/${edited}`, values)
      .catch(() => ({status:0, body:{}}));
    if (selected !== agentSelection || workspace !== workspaceId() || edited !== currentAgent?.id) return;
    submit.disabled = false;
    if (result.body.error?.code === 'revision_conflict' && editConflict && reloadSettings) {
      editConflict.hidden = reloadSettings.hidden = false;
      return;
    }
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法保存。'));
      return;
    }
    const {agent} = result.body;
    const newerEdits = Object.fromEntries(Object.entries(currentEdits()).filter(([field,value]) => sentEdits[field] !== value));
    try { if (draftKey) document.defaultView.sessionStorage.removeItem(draftKey); } catch {}
    directoryAgents = directoryAgents.map(item => item.id === agent.id ? agent : item);
    renderDirectory();
    fillEdit(agent);
    applyEdits(newerEdits);
    storeEditDraft();
    show('ok', '已更新。之后的对话会使用新的说明。');
  });

  async function changeArchive(agent, archived, button) {
    if (!agent || agent.native_deleted || !canManage(actor)) return;
    const wid = workspaceId();
    const user = currentUser?.id;
    const view = archivedOnly;
    const key = wid + '/' + agent.id;
    if (archiveWrites.has(key)) return;
    archiveWrites.add(key);
    if (button) button.disabled = true;
    try {
      const result = await request('POST', `/v1/workspaces/${wid}/agents/${agent.id}/archive`,
        {revision: agent.revision, archived}).catch(() => ({status:0, body:{}}));
      if (wid !== workspaceId() || user !== currentUser?.id || view !== archivedOnly) return;
      if (result.status !== 200) {
        if (result.body.error?.code === 'revision_conflict' && archived && currentAgent?.id === agent.id && editConflict && reloadSettings) {
          editConflict.hidden = reloadSettings.hidden = false;
          return;
        }
        show('error', messageFor(result.body.error, archived ? '无法归档智能体。' : '无法恢复智能体。'));
        return;
      }
      if (await loadWorkspace({directoryOnly: true})) {
        writeDirectoryTarget(null);
        show('ok', archived ? '已归档，可在「已归档」中恢复。' : '已恢复，可在「可用」中打开聊天。');
        directoryStatus?.focus?.();
      }
    } finally {
      archiveWrites.delete(key);
      if (button) button.disabled = false;
    }
  }

  const archiveButton = document.getElementById('archive-button');
  archiveButton.addEventListener('click', () => changeArchive(currentAgent, true, archiveButton));

  document.getElementById('cancel-edit').addEventListener('click', () => {
    hideDrawer();
    writeDirectoryTarget(null);
  });
  cancelCreate?.addEventListener('click', () => {
    hideDrawer();
    openCreate?.focus?.();
  });

  document.getElementById('logout-form').addEventListener('submit', async event => {
    event.preventDefault();
    const result = await request('POST', '/v1/auth/logout', {});
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '退出失败。'));
      return;
    }
    await load();
  });

  openCreate?.addEventListener('click', () => {
    if (!canManage(actor) || archivedOnly || !createForm.hidden) return;
    hideDrawer();
    writeDirectoryTarget(null);
    if (drawer) {
      drawer.hidden = false;
      drawer.scrollTop = 0;
    }
    createForm.hidden = false;
    createForm.reset?.();
    const attempt = readCreateReceipt(createScope());
    if (attempt) {
      const {values} = attempt;
      for (const field of ['name', 'summary', 'instructions', 'category']) {
        if (createForm.elements[field]) createForm.elements[field].value = values[field] ?? '';
      }
      if (createForm.elements.quick_starts) createForm.elements.quick_starts.value = (values.quick_starts || []).join('\n');
    }
    paintCreateControls(attempt);
    if (attempt) createForm.querySelector('button[type="submit"]').focus?.();
    else createForm.elements.name.focus?.();
  });
  directoryStatus?.addEventListener('change', () => {
    if (!canManage(actor)) return;
    archivedOnly = directoryStatus.value === 'archived';
    writeDirectoryTarget(null, {push: true});
    return loadWorkspace({directoryOnly: true});
  });
  const search = document.getElementById('agent-search');
  if (creatorFilter) creatorFilter.addEventListener('change', () => {
    selectedCreator = creatorFilter.value || '';
    renderDirectory();
  });
  if (search) {
    search.addEventListener('input', () => renderDirectory());
    search.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      search.value = '';
      renderDirectory();
      if (typeof search.focus === 'function') search.focus();
    });
  }
  const tabAgents = document.getElementById('tab-agents');
  const tabTeams = document.getElementById('tab-teams');
  if (tabAgents && tabTeams) {
    function selectDirectoryTab(teams) {
      teamsTabSelected = teams;
      tabAgents.setAttribute('aria-selected', String(!teams));
      tabTeams.setAttribute('aria-selected', String(teams));
      document.getElementById('list-panel').hidden = teams;
      document.getElementById('teams-panel').hidden = !teams;
    }
    tabAgents.addEventListener('click', () => {
      focusTemplates = false;
      selectDirectoryTab(false);
    });
    tabTeams.addEventListener('click', async () => {
      selectDirectoryTab(true);
      await loadTeamTemplates();
    });
    if (teamsTabSelected) selectDirectoryTab(true);
  }

  return load();
}

if (globalThis.document && globalThis.document.getElementById('create-form')) {
  mount(globalThis.document);
}
