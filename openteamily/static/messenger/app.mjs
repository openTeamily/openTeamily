import { csrfCookie, idempotencyKey } from '../agents/app.mjs';
import { parseMessengerHash, messengerHref, conversationChatHref } from '../shell/thumb.mjs';

export function samePerson(item, self) {
  if (!item || self == null || self === '') return false;
  const user = typeof self === 'object' ? self : {id: self};
  if (item.user_id && user.id && item.user_id === user.id) return true;
  const strip = (value) => String(value || '').toLowerCase().replace(/^@/, '').replace(/\.home$/, '');
  const mine = new Set([user.id, user.username, user.handle].filter(Boolean).map(strip).filter(Boolean));
  if (!mine.size) return false;
  return [item.user_id, item.username, item.handle].some((value) => value && mine.has(strip(value)));
}

export function conversationLabel(row, currentUserId) {
  if (!row) return '';
  if (row.kind === 'group') return row.title || '群聊';
  if (row.direct && row.title) return row.title;
  const others = (row.members || []).filter(member => !samePerson(member, currentUserId));
  if (others.length) return others.map(member => member.username).join('、');
  return row.title || '单聊';
}

export function sortConversations(rows) {
  return [...(rows || [])].sort((left, right) => (right.updated || 0) - (left.updated || 0));
}

export function validMessage(text) {
  const value = typeof text === 'string' ? text.trim() : '';
  return value.length > 0 && value.length <= 4000;
}

export function memberChoices(members, currentUserId) {
  return (members || []).filter(member => !samePerson(member, currentUserId));
}

function messageFor(error, fallback) {
  if (error && error.message) return error.message;
  return fallback;
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(Number(value) * 1000);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(date);
}

export function mount(document, { fetcher = globalThis.fetch.bind(globalThis) } = {}) {
  const status = document.getElementById('status');
  const loginPanel = document.getElementById('login-panel');
  const mainPanel = document.getElementById('main-panel');
  const workspaceSelect = document.getElementById('workspace');
  const list = document.getElementById('conversation-list');
  const messageList = document.getElementById('message-list');
  let currentUser = null;
  let currentConversation = null;
  let conversations = [];
  let members = [];

  function show(kind, text) {
    status.dataset.kind = kind;
    status.textContent = text;
  }

  async function request(method, path, body, extra) {
    const headers = { Accept: 'application/json', 'X-CSRF-Token': csrfCookie(document.cookie), ...(extra || {}) };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetcher(path, {
      method, headers, credentials: 'same-origin',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let parsed = {};
    try { parsed = await response.json(); } catch { parsed = {}; }
    return { status: response.status, body: parsed };
  }

  function base() {
    return `/v1/workspaces/${workspaceSelect.value}/social/conversations`;
  }

  function renderConversations() {
    list.replaceChildren();
    conversations = sortConversations(conversations);
    document.getElementById('conversations-empty').hidden = conversations.length > 0;
    for (const row of conversations) {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'session-row';
      button.dataset.conversation = row.id;
      if (currentConversation && currentConversation.id === row.id) button.setAttribute('aria-current', 'true');
      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = conversationLabel(row, currentUser);
      const meta = document.createElement('span');
      meta.className = 'preview';
      meta.textContent = (row.kind === 'group' ? '群聊 · ' : '单聊 · ') + ((row.members || []).length) + ' 人';
      const time = document.createElement('span');
      time.className = 'time';
      time.textContent = formatTime(row.updated);
      button.append(title, meta, time);
      li.append(button);
      list.append(li);
    }
  }

  function renderMembers() {
    const holder = document.getElementById('member-choices');
    holder.replaceChildren();
    for (const member of memberChoices(members, currentUser)) {
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = member.user_id;
      box.name = 'member';
      label.append(box, document.createTextNode(member.username));
      holder.append(label);
    }
  }

  function renderMessages(items) {
    messageList.replaceChildren();
    document.getElementById('chat-empty').hidden = (items || []).length > 0;
    for (const item of items || []) {
      const li = document.createElement('li');
      li.className = samePerson(item, currentUser) ? 'mine' : 'other';
      const who = document.createElement('p');
      who.className = 'role';
      const member = members.find(entry => entry.user_id === item.user_id || (item.username && entry.username === item.username));
      who.textContent = samePerson(item, currentUser)
        ? '我' : ((member && member.username) || '成员');
      const body = document.createElement('p');
      body.className = 'body';
      body.textContent = item.body || '';
      const time = document.createElement('p');
      time.className = 'time';
      time.textContent = formatTime(item.created);
      li.append(who, body, time);
      messageList.append(li);
    }
    const scroller = document.getElementById('message-scroller');
    scroller.scrollTop = scroller.scrollHeight;
  }

  function setPane(name) {
    const layout = document.querySelector('.messenger-layout');
    if (layout) layout.setAttribute('data-pane', name);
    for (const button of document.querySelectorAll('.messenger-pane-switch [data-pane]')) {
      button.setAttribute('aria-pressed', button.getAttribute('data-pane') === name ? 'true' : 'false');
    }
  }

  function renderDetail() {
    const empty = document.getElementById('detail-empty');
    const body = document.getElementById('detail-body');
    if (!currentConversation) {
      if (empty) empty.hidden = false;
      if (body) body.hidden = true;
      return;
    }
    if (empty) empty.hidden = true;
    if (body) body.hidden = false;
    const kind = document.getElementById('detail-kind');
    const updated = document.getElementById('detail-updated');
    const list = document.getElementById('detail-members');
    if (kind) kind.textContent = currentConversation.kind === 'group' ? '群聊' : '单聊';
    if (updated) updated.textContent = formatTime(currentConversation.updated) ? ('更新于 ' + formatTime(currentConversation.updated)) : '';
    if (list) {
      list.replaceChildren();
      for (const member of currentConversation.members || []) {
        const li = document.createElement('li');
        li.textContent = member.username || member.user_id || '成员';
        list.append(li);
      }
    }
    const link = document.getElementById('detail-open-chat');
    if (link && workspaceSelect.value) {
      link.href = conversationChatHref(workspaceSelect.value, {source: 'social', id: currentConversation.id});
    }
  }

  function writeHash() {
    if (!globalThis.history) return;
    globalThis.history.replaceState(null, '', messengerHref(workspaceSelect.value, currentConversation && currentConversation.id).replace(/^\/messenger/, '') || '#');
  }

  function resetChat() {
    currentConversation = null;
    document.getElementById('chat-title').textContent = '消息';
    messageList.replaceChildren();
    document.getElementById('chat-empty').hidden = false;
    renderDetail();
    writeHash();
  }

  async function openConversation(conversationId) {
    const result = await request('GET', `${base()}/${conversationId}`);
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法打开会话。'));
      return;
    }
    currentConversation = result.body.conversation;
    document.getElementById('chat-title').textContent = conversationLabel(currentConversation, currentUser);
    renderMessages(result.body.items);
    renderConversations();
    renderDetail();
    writeHash();
    setPane('chat');
  }

  async function loadWorkspaceData() {
    conversations = [];
    members = [];
    renderConversations();
    if (!workspaceSelect.value) return;
    const [listed, people] = await Promise.all([
      request('GET', `${base()}?limit=100`),
      request('GET', `/v1/workspaces/${workspaceSelect.value}/members`),
    ]);
    if (people.status === 200) members = people.body.items || [];
    renderMembers();
    if (listed.status !== 200) {
      show('error', messageFor(listed.body.error, '无法加载会话。'));
      return;
    }
    conversations = listed.body.items || [];
    renderConversations();
    const wanted = parseMessengerHash(globalThis.location && globalThis.location.hash).conversation;
    if (wanted && conversations.some((row) => row.id === wanted)) await openConversation(wanted);
    else resetChat();
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
    document.getElementById('whoami').textContent = currentUser.username;
    // Preserve previously shared agent links through the current chat page.
    const startSlug = new URLSearchParams(String(globalThis.location?.hash || '').slice(1)).get('start');
    if (startSlug && /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(startSlug)) {
      globalThis.location.replace('/chat#public-agent=' + startSlug);
      return;
    }
    const listed = await request('GET', '/v1/workspaces?limit=100');
    const workspaces = listed.status === 200 ? (listed.body.items || []) : [];
    const previous = workspaceSelect.value;
    workspaceSelect.replaceChildren();
    for (const space of workspaces) {
      const option = document.createElement('option');
      option.value = space.id;
      option.textContent = space.name;
      workspaceSelect.append(option);
    }
    const hashWorkspace = parseMessengerHash(globalThis.location && globalThis.location.hash).workspace;
    const preferred = hashWorkspace || previous;
    if (preferred && [...workspaceSelect.options].some(option => option.value === preferred)) {
      workspaceSelect.value = preferred;
    }
    if (!workspaces.length) {
      resetChat();
      show('error', '还没有工作区。请先到聊天页创建。');
      return;
    }
    await loadWorkspaceData();
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

  workspaceSelect.addEventListener('change', async () => {
    resetChat();
    await loadWorkspaceData();
  });

  document.getElementById('conversation-list').addEventListener('click', async event => {
    const button = event.target.closest('button[data-conversation]');
    if (button) await openConversation(button.dataset.conversation);
  });

  document.getElementById('create-conversation').addEventListener('submit', async event => {
    event.preventDefault();
    const kind = document.getElementById('conversation-kind').value;
    const title = document.getElementById('conversation-title').value.trim();
    const memberIds = [...document.querySelectorAll('#member-choices input[name="member"]:checked')]
      .map(box => box.value);
    if (!memberIds.length) {
      show('error', '至少选择一位成员。');
      return;
    }
    if (kind === 'dm' && memberIds.length !== 1) {
      show('error', '单聊只能选择一位成员。');
      return;
    }
    const body = { kind, member_ids: memberIds };
    if (title) body.title = title;
    const result = await request('POST', base(), body, { 'Idempotency-Key': idempotencyKey('social-') });
    if (result.status !== 201 && result.status !== 200) {
      show('error', messageFor(result.body.error, '无法创建会话。'));
      return;
    }
    document.getElementById('create-conversation').reset();
    await loadWorkspaceData();
    await openConversation(result.body.conversation.id);
    show('ok', '会话已创建。');
  });

  document.getElementById('message-form').addEventListener('submit', async event => {
    event.preventDefault();
    const input = document.getElementById('message-body');
    if (!validMessage(input.value)) {
      show('error', '请输入 1–4000 字符的消息。');
      return;
    }
    if (!currentConversation) {
      show('error', '请先打开或创建一个会话。');
      return;
    }
    const result = await request('POST', `${base()}/${currentConversation.id}/messages`, { body: input.value }, {
      'Idempotency-Key': idempotencyKey('socialmsg-'),
    });
    if (result.status !== 201 && result.status !== 200) {
      show('error', messageFor(result.body.error, '发送失败。'));
      return;
    }
    input.value = '';
    await openConversation(currentConversation.id);
    show('ok', '已发送。');
  });

  document.getElementById('logout-form').addEventListener('submit', async event => {
    event.preventDefault();
    await request('POST', '/v1/auth/logout', {});
    await load();
  });

  for (const button of document.querySelectorAll('.messenger-pane-switch [data-pane]')) {
    button.addEventListener('click', () => setPane(button.getAttribute('data-pane')));
  }

  return load();
}

if (globalThis.document && globalThis.document.getElementById('create-conversation')) {
  mount(globalThis.document);
}
