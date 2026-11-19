import { createLookAvatar } from '../look/app.mjs';

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

export function csrfCookie(source) {
  const match = /(?:^|;\s*)(?:__Host-ot_csrf|ot_dev_csrf)=([^;]+)/.exec(source || '');
  return match ? decodeURIComponent(match[1]) : '';
}

export function canManage(actor) {
  return actor === 'owner' || actor === 'admin';
}

export const AGENT_CATEGORIES = [
  {slug: 'content-creation', label: 'Content Creation'},
  {slug: 'customer-support', label: 'Customer Support'},
  {slug: 'data-analysis', label: 'Data Analysis'},
  {slug: 'design', label: 'Design'},
  {slug: 'education', label: 'Education'},
  {slug: 'engineering', label: 'Engineering'},
  {slug: 'finance', label: 'Finance'},
  {slug: 'it-security', label: 'IT & Security'},
  {slug: 'investment', label: 'Investment'},
  {slug: 'legal', label: 'Legal'},
  {slug: 'life', label: 'Life'},
  {slug: 'marketing', label: 'Marketing'},
  {slug: 'operations', label: 'Operations'},
  {slug: 'product', label: 'Product'},
  {slug: 'recruiting', label: 'Recruiting'},
  {slug: 'research', label: 'Research'},
  {slug: 'sales', label: 'Sales'},
];

const AGENT_CATEGORY_SLUGS = new Set(AGENT_CATEGORIES.map((entry) => entry.slug));

export function categoryFromSearch(search) {
  const slug = new URLSearchParams((search || '').replace(/^\?/, '')).get('category') || '';
  return AGENT_CATEGORY_SLUGS.has(slug) ? slug : 'all';
}

export function searchWithCategory(search, slug) {
  const params = new URLSearchParams((search || '').replace(/^\?/, ''));
  if (!slug || slug === 'all') params.delete('category');
  else params.set('category', slug);
  const next = params.toString();
  return next ? '?' + next : '';
}

export function readAgentForm(form) {
  const data = new FormData(form);
  return {
    name: (data.get('name') || '').trim(),
    summary: (data.get('summary') || '').trim(),
    instructions: data.get('instructions') || '',
    category: AGENT_CATEGORY_SLUGS.has(data.get('category')) ? data.get('category') : null,
  };
}

export function categoryLabel(slug) {
  const found = AGENT_CATEGORIES.find((entry) => entry.slug === slug);
  return found ? found.label : '';
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

export function idempotencyKey(prefix) {
  const raw = (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now());
  return ((prefix || 'agent-') + raw.replace(/-/g, '')).slice(0, 64);
}

export function statusLabel(message) {
  if (!message) return '';
  if (message.status === 'queued' && message.error_code === 'no_agent') return '等待已连接的运行时。';
  if (message.status === 'queued') return '排队中。';
  if (message.status === 'running') return '生成中。';
  if (message.status === 'failed') return '回复失败' + (message.error_code ? '（' + message.error_code + '）' : '') + '。';
  if (message.status === 'cancelled') return '已取消。';
  return message.body || '';
}

function messageFor(error, fallback) {
  if (error && error.message) return error.message;
  return fallback;
}

export function mount(document, {fetcher = globalThis.fetch.bind(globalThis)} = {}) {
  const status = document.getElementById('status');
  const loginPanel = document.getElementById('login-panel');
  const mainPanel = document.getElementById('main-panel');
  const workspaceSelect = document.getElementById('workspace');
  const createForm = document.getElementById('create-form');
  const editForm = document.getElementById('edit-form');
  const chatPanel = document.getElementById('chat-panel');
  const runtimePanel = document.getElementById('runtime-panel');
  let currentUser = null;
  let actor = null;
  let workspaces = [];
  let currentAgent = null;
  let personalAgentId = '';
  let personalLook = null;
  let currentConversation = null;
  let pollTimer = 0;
  let directoryLoaded = false;
  fillCategoryOptions(createForm.elements.category, document);
  fillCategoryOptions(editForm.elements.category, document);
  const categoryButtons = [...document.querySelectorAll('.filter-row .pill[data-category]')];
  const creatorFilter = document.getElementById('creator-filter');
  let selectedCategory = categoryFromSearch(globalThis.location && globalThis.location.search);
  let selectedCreator = '';
  let memberNames = new Map();

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
      if (directoryLoaded) renderDirectory();
    });
  }

  function show(kind, text) {
    status.dataset.kind = kind;
    status.textContent = text;
  }

  async function request(method, path, body, extra) {
    const headers = {'Accept': 'application/json', 'X-CSRF-Token': csrfCookie(document.cookie), ...(extra || {})};
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

  function agentBase() {
    return `/v1/workspaces/${workspaceId()}/agents/${currentAgent && currentAgent.id}`;
  }

  function stopPolling() {
    if (pollTimer) {
      globalThis.clearTimeout(pollTimer);
      pollTimer = 0;
    }
  }

  async function load() {
    const session = await request('GET', '/v1/auth/session');
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
    // The saved Personal Agent look is an optional identity detail. Never let
    // this auxiliary read break the directory if an older server lacks it.
    try {
      const personal = await request('GET', '/v1/personal-agent');
      const found = personal.status === 200 && personal.body.personal_agent;
      personalAgentId = found && found.agent ? found.agent.id : '';
      personalLook = found ? found.look || null : null;
    } catch (error) {
      personalAgentId = '';
      personalLook = null;
    }
    const whoami = document.getElementById('whoami');
    whoami.dataset.username = currentUser.username;
    whoami.textContent = '已登录为 ' + currentUser.username;
    const listed = await request('GET', '/v1/workspaces?limit=100');
    workspaces = listed.status === 200 ? (listed.body.items || []) : [];
    const previous = workspaceSelect.value;
    workspaceSelect.replaceChildren();
    for (const space of workspaces) {
      const option = document.createElement('option');
      option.value = space.id;
      option.textContent = space.name;
      workspaceSelect.append(option);
    }
    if (previous && [...workspaceSelect.options].some(option => option.value === previous)) {
      workspaceSelect.value = previous;
    }
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
      createForm.hidden = true;
      editForm.hidden = true;
      chatPanel.hidden = true;
    if (runtimePanel) runtimePanel.hidden = true;
      show('', '');
      return;
    }
    await loadWorkspace();
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
      if (!matchesDirectoryQuery(item, query) || !matchesCategory(item, selectedCategory)
          || !matchesCreator(item, selectedCreator)) continue;
      shown += 1;
      const li = document.createElement('li');
      li.className = 'agent-card';
      const lookAvatar = item.id === personalAgentId ? createLookAvatar(personalLook, document) : null;
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
      const chat = document.createElement('a');
      chat.className = 'chat-cta';
      chat.href = '/chat#workspace=' + encodeURIComponent(id) + '&agent=' + encodeURIComponent(item.id);
      chat.textContent = '聊天';
      li.append(avatar, copy, chat);
      list.append(li);
    }
    if (empty) {
      empty.hidden = shown > 0;
      empty.textContent = !directoryAgents.length
        ? '这个工作区还没有智能体。'
        : query
        ? '没有匹配的智能体。试试其他关键词。'
        : selectedCreator
          ? '没有符合筛选的智能体'
          : selectedCategory !== 'all' && directoryAgents.length
            ? '「' + categoryLabel(selectedCategory) + '」类目下还没有智能体。选「全部」查看其余智能体。'
            : '这个工作区还没有智能体。';
    }
    if (count) count.textContent = '显示 ' + shown + ' 个智能体';
  }

  const apiKeyForm = document.getElementById('api-key-form');
  if (apiKeyForm) apiKeyForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (!currentAgent) return;
    const agent = currentAgent, wid = workspaceId();
    const result = await request('POST', `/v1/workspaces/${wid}/agents/${agent.id}/api-keys`, {
      name: document.getElementById('api-key-name').value,
      rate_per_minute: Number(document.getElementById('api-key-rate').value) || 10,
    });
    if (result.status !== 201) { show('error', messageFor(result.body.error, '无法生成密钥。')); return; }
    const out = document.getElementById('api-key-token');
    out.hidden = false;
    out.textContent = `密钥只显示一次：${result.body.token}`;
    document.getElementById('api-key-name').value = '';
    loadApiKeys(agent, true);
  });

  async function loadWorkspace() {
    const id = workspaceId();
    if (!id) return;
    currentAgent = null;
    currentConversation = null;
    stopPolling();
    chatPanel.hidden = true;
    if (runtimePanel) runtimePanel.hidden = true;
    const detail = await request('GET', `/v1/workspaces/${id}`);
    if (detail.status !== 200) {
      show('error', messageFor(detail.body.error, '无法打开工作区。'));
      return;
    }
    const members = await request('GET', `/v1/workspaces/${id}/members`);
    memberNames = new Map(members.status === 200
      ? (members.body.items || []).map(row => [row.user_id, row.username])
      : []);
    const self = members.status === 200
      ? (members.body.items || []).find(row => row.user_id === currentUser.id)
      : null;
    actor = self ? self.role : (detail.body.workspace && detail.body.workspace.owner_id === currentUser.id ? 'owner' : 'member');
    document.getElementById('role-note').textContent = actor === 'owner'
      ? '你是这个工作区的所有者，可以创建和归档智能体，并与自己的智能体对话。'
      : actor === 'admin'
        ? '你是管理员，可以创建和归档智能体，并与自己的智能体对话。'
        : '你是成员，可以查看目录并与自己的智能体对话，但不能改目录。';
    createForm.hidden = !canManage(actor);
    editForm.hidden = true;
    const listed = await request('GET', `/v1/workspaces/${id}/agents?limit=100`);
    if (listed.status !== 200) {
      show('error', messageFor(listed.body.error, '无法加载智能体目录。'));
      return;
    }
    directoryAgents = listed.body.items || [];
    directoryLoaded = true;
    fillCreatorOptions(creatorFilter, directoryAgents, memberNames, document);
    selectedCreator = creatorFilter ? creatorFilter.value : '';
    renderDirectory();
    show('', '');
  }

  function fillEdit(agent) {
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
    const writable = canManage(actor);
    for (const field of ['name', 'summary', 'instructions', 'category']) {
      if (editForm.elements[field]) editForm.elements[field].disabled = !writable;
    }
    document.getElementById('archive-button').hidden = !writable;
    editForm.querySelector('button[type="submit"]').hidden = !writable;
    document.getElementById('chat-title').textContent = '与 ' + agent.name + ' 的对话';
    chatPanel.hidden = false;
    const drawer = document.getElementById('manage-drawer');
    if (drawer) drawer.hidden = false;
    const openChat = document.getElementById('open-in-chat');
    if (openChat) {
      openChat.href = '/chat#workspace=' + encodeURIComponent(workspaceId()) + '&agent=' + encodeURIComponent(agent.id);
    }
    renderHomepage(agent, writable);
    if (runtimePanel) loadRuntime();
    loadApiKeys(agent, writable);
  }

  async function loadApiKeys(agent, writable) {
    const panel = document.getElementById('api-key-panel');
    if (!panel) return;
    panel.hidden = !writable || Boolean(agent.archived);
    document.getElementById('api-key-token').hidden = true;
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
    list.replaceChildren(...(listed.status === 200 ? listed.body.items : []).map(key => {
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
          show('ok', '已撤销密钥。');
          loadApiKeys(agent, writable);
        });
        li.append(revoke);
      }
      return li;
    }));
  }

  function renderHomepage(agent, writable, tokenPath) {
    const panel = document.getElementById('homepage-panel');
    const status = document.getElementById('homepage-status');
    const wrap = document.getElementById('homepage-link-wrap');
    const link = document.getElementById('homepage-link');
    if (!panel) return;
    panel.hidden = false;
    const home = agent.homepage || {visibility: 'restricted'};
    const publicHome = home.visibility === 'public';
    document.getElementById('publish-homepage').hidden = !writable;
    document.getElementById('revoke-homepage').hidden = !writable || !publicHome;
    document.getElementById('publish-homepage').textContent = publicHome ? '更换链接' : '发布链接';
    if (tokenPath) {
      status.textContent = '链接只显示这一次，请立即复制。撤回后旧链接会失效。';
      wrap.hidden = false;
      link.textContent = tokenPath;
    } else if (publicHome) {
      status.textContent = '已发布公开主页。完整链接只在发布时显示一次，这里只保留前缀 ' + (home.prefix || '') + '。';
      wrap.hidden = true;
      link.textContent = '';
    } else {
      status.textContent = '当前仅工作区成员可见。';
      wrap.hidden = true;
      link.textContent = '';
    }
  }

  async function loadRuntime() {
    if (!currentAgent || !runtimePanel) return;
    const result = await request('GET', `${agentBase()}/runtime`);
    if (result.status === 501) {
      runtimePanel.hidden = true;
      return;
    }
    runtimePanel.hidden = false;
    const bindable = canManage(actor);
    document.getElementById('bind-runtime').hidden = !bindable;
    document.getElementById('unbind-runtime').hidden = !bindable;
    document.getElementById('runtime-instance').disabled = !bindable;
    const listed = bindable ? await request('GET', `/v1/workspaces/${workspaceId()}/instances?limit=100`) : {status: 200, body: {items: []}};
    const items = listed.status === 200 ? (listed.body.items || []) : [];
    const select = document.getElementById('runtime-instance');
    const current = result.body.runtime;
    select.replaceChildren();
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = '选择一个容器实例';
    select.append(empty);
    for (const item of items) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = (item.id || '').slice(0, 8) + (item.desired ? ' · ' + item.desired : '');
      select.append(option);
    }
    if (current && current.instance_id) select.value = current.instance_id;
    document.getElementById('runtime-status').textContent = current
      ? ('已绑定实例 ' + current.instance_id.slice(0, 8) + '（' + (current.status || '未知') + '）')
      : '尚未绑定容器。成员对话仍可回退到自己的已连接机器。';
  }


  function renderMessages(items) {
    const list = document.getElementById('message-list');
    list.replaceChildren();
    let pending = false;
    for (const item of items || []) {
      const li = document.createElement('li');
      const role = document.createElement('p');
      role.className = 'role';
      role.textContent = item.role === 'user' ? '你' : '智能体';
      const body = document.createElement('p');
      const waiting = item.role === 'assistant' && (item.status === 'queued' || item.status === 'running');
      const failed = item.role === 'assistant' && (item.status === 'failed' || item.status === 'cancelled');
      body.className = waiting ? 'pending' : (failed ? 'failed' : '');
      body.textContent = item.role === 'user' ? (item.body || '') : statusLabel(item);
      li.append(role, body);
      if (item.role === 'assistant' && item.status === 'succeeded' && item.body) {
        const save = document.createElement('button');
        save.type = 'button';
        save.dataset.save = item.id;
        save.textContent = '保存到作品库';
        li.append(save);
      }
      list.append(li);
      if (waiting) pending = true;
    }
    return pending;
  }

  async function loadConversations() {
    if (!currentAgent) return;
    const listed = await request('GET', `${agentBase()}/conversations?limit=100`);
    if (listed.status !== 200) {
      show('error', messageFor(listed.body.error, '无法加载对话。'));
      return;
    }
    const items = listed.body.items || [];
    const list = document.getElementById('conversation-list');
    list.replaceChildren();
    for (const item of items) {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'link';
      button.dataset.conversation = item.id;
      button.textContent = item.title || '对话';
      li.append(button);
      list.append(li);
    }
    document.getElementById('conversations-empty').hidden = items.length > 0;
    if (!currentConversation && items.length) {
      await openConversation(items[0].id);
    } else if (currentConversation) {
      await openConversation(currentConversation.id);
    } else {
      document.getElementById('message-list').replaceChildren();
    }
  }

  function schedulePoll() {
    stopPolling();
    pollTimer = globalThis.setTimeout(() => {
      if (currentConversation) openConversation(currentConversation.id);
    }, 2000);
  }

  async function openConversation(id) {
    if (!currentAgent) return;
    const result = await request('GET', `${agentBase()}/conversations/${id}`);
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法打开对话。'));
      return;
    }
    currentConversation = result.body.conversation;
    const pending = renderMessages(result.body.items);
    if (pending) schedulePoll();
    else stopPolling();
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

  workspaceSelect.addEventListener('change', () => loadWorkspace());

  document.getElementById('agent-list').addEventListener('click', async event => {
    const button = event.target.closest('button[data-id]');
    if (!button) return;
    const id = workspaceId();
    const result = await request('GET', `/v1/workspaces/${id}/agents/${button.dataset.id}`);
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法打开这个智能体。'));
      return;
    }
    currentConversation = null;
    stopPolling();
    fillEdit(result.body.agent);
    await loadConversations();
  });

  document.getElementById('conversation-list').addEventListener('click', async event => {
    const button = event.target.closest('button[data-conversation]');
    if (!button) return;
    await openConversation(button.dataset.conversation);
  });

  const bindButton = document.getElementById('bind-runtime');
  if (bindButton) bindButton.addEventListener('click', async () => {
    const instanceId = document.getElementById('runtime-instance').value;
    if (!instanceId || !currentAgent) {
      show('error', '请选择一个实例。');
      return;
    }
    const current = await request('GET', `${agentBase()}/runtime`);
    const body = {instance_id: instanceId};
    if (current.status === 200 && current.body.runtime) body.revision = current.body.runtime.revision;
    const result = await request('POST', `${agentBase()}/runtime`, body);
    if (result.status !== 200 && result.status !== 201) {
      show('error', messageFor(result.body.error, '无法绑定。'));
      return;
    }
    show('ok', '已绑定到工作区容器。');
    await loadRuntime();
  });
  const unbindButton = document.getElementById('unbind-runtime');
  if (unbindButton) unbindButton.addEventListener('click', async () => {
    const current = await request('GET', `${agentBase()}/runtime`);
    if (current.status !== 200 || !current.body.runtime) return;
    const result = await request('POST', `${agentBase()}/runtime/unbind`, {revision: current.body.runtime.revision});
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法解除绑定。'));
      return;
    }
    show('ok', '已解除绑定。');
    await loadRuntime();
  });

  document.getElementById('new-conversation').addEventListener('click', async () => {
    if (!currentAgent) return;
    const result = await request('POST', `${agentBase()}/conversations`, {title: '新对话'}, {
      'Idempotency-Key': idempotencyKey('chat-'),
    });
    if (result.status !== 201 && result.status !== 200) {
      show('error', messageFor(result.body.error, '无法创建对话。'));
      return;
    }
    currentConversation = result.body.conversation;
    document.getElementById('message-list').replaceChildren();
    show('ok', '已开始新对话。');
    await loadConversations();
  });

  document.getElementById('chat-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!currentAgent) return;
    const text = document.getElementById('chat-body').value;
    if (!text.trim()) {
      show('error', '请填写消息。');
      return;
    }
    if (!currentConversation) {
      const created = await request('POST', `${agentBase()}/conversations`, {title: '新对话'}, {
        'Idempotency-Key': idempotencyKey('chat-'),
      });
      if (created.status !== 201 && created.status !== 200) {
        show('error', messageFor(created.body.error, '无法创建对话。'));
        return;
      }
      currentConversation = created.body.conversation;
    }
    const result = await request(
      'POST',
      `${agentBase()}/conversations/${currentConversation.id}/messages`,
      {body: text},
      {'Idempotency-Key': idempotencyKey('msg-')},
    );
    if (result.status !== 201 && result.status !== 200) {
      show('error', messageFor(result.body.error, '无法发送。'));
      return;
    }
    document.getElementById('chat-body').value = '';
    show(result.body.reply && result.body.reply.error_code === 'no_agent' ? 'error' : 'ok',
         result.body.reply && result.body.reply.error_code === 'no_agent'
           ? '消息已保存，正在等待已连接的运行时。'
           : '已发送。');
    await loadConversations();
  });

  document.getElementById('message-list').addEventListener('click', async event => {
    const button = event.target.closest('button[data-save]');
    if (!button || !currentConversation) return;
    const result = await request(
      'POST',
      `${agentBase()}/conversations/${currentConversation.id}/messages/${button.dataset.save}/artifact`,
      {},
    );
    if (result.status !== 201 && result.status !== 200) {
      show('error', messageFor(result.body.error, '无法保存到作品库。'));
      return;
    }
    show('ok', '已保存到作品库。');
  });

  createForm.addEventListener('submit', async event => {
    event.preventDefault();
    const id = workspaceId();
    const values = readAgentForm(event.currentTarget);
    if (!values.name) {
      show('error', '请填写名称。');
      return;
    }
    const result = await request('POST', `/v1/workspaces/${id}/agents`, values, {
      'Idempotency-Key': idempotencyKey(),
    });
    if (result.status !== 201 && result.status !== 200) {
      show('error', messageFor(result.body.error, '无法创建智能体。'));
      return;
    }
    event.currentTarget.reset();
    show('ok', '已保存到目录。对话仍由已连接的运行时执行。');
    await loadWorkspace();
    if (result.body.agent) {
      fillEdit(result.body.agent);
      await loadConversations();
    }
  });

  editForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (!canManage(actor)) return;
    const id = workspaceId();
    const values = readAgentForm(event.currentTarget);
    values.revision = Number(event.currentTarget.elements.revision.value);
    const result = await request(
      'POST',
      `/v1/workspaces/${id}/agents/${event.currentTarget.elements.id.value}`,
      values,
    );
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法保存。'));
      return;
    }
    show('ok', '已更新。之后的对话会使用新的说明。');
    const keep = currentConversation && currentConversation.id;
    await loadWorkspace();
    fillEdit(result.body.agent);
    if (keep) currentConversation = {id: keep, ...currentConversation};
    await loadConversations();
  });

  document.getElementById('archive-button').addEventListener('click', async () => {
    if (!canManage(actor)) return;
    const id = workspaceId();
    const result = await request(
      'POST',
      `/v1/workspaces/${id}/agents/${editForm.elements.id.value}/archive`,
      {revision: Number(editForm.elements.revision.value)},
    );
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法归档。'));
      return;
    }
    show('ok', '已归档，默认目录里不再显示，公开主页链接也已失效。');
    const homepagePanel = document.getElementById('homepage-panel');
    if (homepagePanel) homepagePanel.hidden = true;
    await loadWorkspace();
  });

  document.getElementById('cancel-edit').addEventListener('click', () => {
    editForm.hidden = true;
    chatPanel.hidden = true;
    const drawer = document.getElementById('manage-drawer');
    if (drawer && createForm.hidden) drawer.hidden = true;
    const homepagePanel = document.getElementById('homepage-panel');
    if (homepagePanel) homepagePanel.hidden = true;
    if (runtimePanel) runtimePanel.hidden = true;
    currentAgent = null;
    currentConversation = null;
    stopPolling();
  });

  document.getElementById('publish-homepage').addEventListener('click', async () => {
    if (!canManage(actor) || !currentAgent) return;
    const result = await request('POST', `${agentBase()}/homepage`, {});
    if (result.status !== 201) {
      show('error', messageFor(result.body.error, '无法发布公开主页。'));
      return;
    }
    currentAgent = result.body.agent;
    fillEdit(currentAgent);
    renderHomepage(currentAgent, true, result.body.agent.homepage.path);
    show('ok', '已发布公开主页链接。');
  });

  document.getElementById('revoke-homepage').addEventListener('click', async () => {
    if (!canManage(actor) || !currentAgent) return;
    const result = await request('POST', `${agentBase()}/homepage/revoke`, {});
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法撤回公开主页。'));
      return;
    }
    currentAgent = result.body.agent;
    fillEdit(currentAgent);
    show('ok', '已撤回公开主页，旧链接失效。');
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

  const openCreate = document.getElementById('open-create');
  if (openCreate) openCreate.addEventListener('click', () => {
    const drawer = document.getElementById('manage-drawer');
    if (drawer) drawer.hidden = false;
    if (canManage(actor)) createForm.hidden = false;
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
    tabAgents.addEventListener('click', () => {
      tabAgents.setAttribute('aria-selected', 'true');
      tabTeams.setAttribute('aria-selected', 'false');
      document.getElementById('list-panel').hidden = false;
      document.getElementById('teams-panel').hidden = true;
    });
    tabTeams.addEventListener('click', () => {
      tabAgents.setAttribute('aria-selected', 'false');
      tabTeams.setAttribute('aria-selected', 'true');
      document.getElementById('list-panel').hidden = true;
      document.getElementById('teams-panel').hidden = false;
    });
  }

  return load();
}

if (globalThis.document && globalThis.document.getElementById('create-form')) {
  mount(globalThis.document);
}
