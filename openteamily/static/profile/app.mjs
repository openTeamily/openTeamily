function csrfCookie(source) {
  const match = /(?:^|;\s*)(?:__Host-ot_csrf|ot_dev_csrf)=([^;]+)/.exec(source || '');
  return match ? decodeURIComponent(match[1]) : '';
}

function messageFor(error, fallback) {
  if (error && error.message) return error.message;
  return fallback;
}

export function sanitizeHandle(username) {
  let text = String(username || '').toLowerCase().replace(/[^a-z0-9._]+/g, '.');
  text = text.replace(/\.{2,}/g, '.').replace(/^\.+|\.+$/g, '');
  if (text.length < 3) text = (text + 'user').slice(0, 30);
  text = text.slice(0, 30).replace(/\.+$/g, '');
  return text || 'user';
}

export function parseTags(text) {
  const seen = new Set();
  const tags = [];
  for (const raw of String(text || '').split(/[,，]/)) {
    const tag = raw.trim().slice(0, 20);
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length >= 8) break;
  }
  return tags;
}

export function avatarTone(name) {
  let hash = 0;
  for (const ch of String(name || '')) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return String((hash % 6) + 1);
}

export function monogram(name) {
  const letters = String(name || '').match(/\p{L}|\p{N}/gu) || [];
  if (!letters.length) return '?';
  if (letters.length === 1) return letters[0].toUpperCase();
  return (letters[0] + letters[1]).toUpperCase();
}

function $(id) {
  return typeof document !== 'undefined' && document.getElementById ? document.getElementById(id) : null;
}

function hasHome() {
  return typeof document !== 'undefined' && typeof document.querySelector === 'function'
    && document.querySelector('#profile-home');
}

function isEditPath() {
  if (typeof location === 'undefined') return false;
  return /\/profile\/edit\/?$/.test(location.pathname || '');
}

async function request(method, path, body) {
  const headers = { Accept: 'application/json' };
  const options = { method, headers, credentials: 'same-origin' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['X-CSRF-Token'] = csrfCookie(document.cookie);
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  let payload = {};
  try { payload = await response.json(); } catch { payload = {}; }
  return { status: response.status, body: payload };
}

function mount() {
  const status = document.getElementById('status');
  const loginPanel = document.getElementById('login-panel');
  const mainPanel = document.getElementById('main-panel');
  const form = document.getElementById('profile-form');
  if (!status || !loginPanel || !mainPanel || !form) return;
  const goals = ['health', 'finance', 'career', 'hobbies', 'family', 'productivity', 'other'];
  let revision = 0;
  let snapshot = '';
  let currentUsername = '';

  function show(kind, text) {
    status.dataset.kind = kind;
    status.textContent = text;
  }

  function syncView() {
    if (!hasHome()) return;
    const home = document.querySelector('#profile-home');
    const edit = document.querySelector('#profile-edit');
    const editing = isEditPath();
    if (home) home.hidden = editing;
    if (edit) edit.hidden = !editing;
  }

  function paintAvatar(node, name) {
    if (!node) return;
    node.textContent = monogram(name);
    if (node.dataset) node.dataset.tone = avatarTone(name);
  }

  function updateCounters() {
    const name = form.elements.name;
    const bio = form.elements.bio;
    const tags = form.elements.tags;
    const nameCount = document.querySelector && document.querySelector('#count-name');
    const bioCount = document.querySelector && document.querySelector('#count-bio');
    const tagCount = document.querySelector && document.querySelector('#count-tags');
    if (nameCount && name) nameCount.textContent = `${String(name.value || '').length}/40`;
    if (bioCount && bio) bioCount.textContent = `${String(bio.value || '').length}/200`;
    if (tagCount && tags) tagCount.textContent = `${parseTags(tags.value).length}/8`;
  }

  function collect() {
    const changes = {
      name: form.elements.name.value.trim(),
      handle: form.elements.handle.value.trim(),
      bio: form.elements.bio.value,
      tags: parseTags(form.elements.tags.value),
      gender: form.elements.gender.value,
      location: form.elements.location.value.trim(),
      website: form.elements.website.value.trim(),
      goals: {},
    };
    for (const key of goals) {
      const input = document.getElementById('goal-' + key);
      if (input) changes.goals[key] = input.value;
    }
    return changes;
  }

  function markClean() {
    snapshot = JSON.stringify(collect());
    const save = document.getElementById('profile-save');
    if (save && hasHome()) save.disabled = true;
  }

  function markDirty() {
    const save = document.getElementById('profile-save');
    if (!save || !hasHome()) return;
    save.disabled = JSON.stringify(collect()) === snapshot;
  }

  function fill(profile, username) {
    const value = profile || {};
    form.elements.name.value = value.name || username || '';
    form.elements.handle.value = value.handle || sanitizeHandle(username);
    form.elements.bio.value = value.bio || '';
    form.elements.tags.value = (value.tags || []).join(', ');
    form.elements.gender.value = value.gender || '';
    form.elements.location.value = value.location || '';
    form.elements.website.value = value.website || '';
    for (const key of goals) {
      const input = document.getElementById('goal-' + key);
      if (input) input.value = (value.goals && value.goals[key]) || '';
    }
    revision = Number(value.revision || 0);
    const meta = document.getElementById('profile-meta');
    meta.textContent = revision
      ? '修订 ' + revision + ' · Teamily ID 可用于公开资料地址'
      : '还没有保存过资料。保存后会生成 Teamily ID。';
    const link = document.getElementById('profile-public');
    if (link) link.href = value.handle ? '/p/' + encodeURIComponent(value.handle) : '/v1/profile';
    const hint = document.querySelector && document.querySelector('#handle-hint');
    if (hint) hint.textContent = value.handle ? '' : '首次设置后可以再改有限次数；这里不限制修改次数。';
    if (hasHome()) {
      const label = username || value.name || '';
      const nameEl = document.getElementById('profile-username');
      if (nameEl) nameEl.textContent = username || '';
      paintAvatar(document.querySelector('#profile-avatar'), label);
      paintAvatar(document.querySelector('#profile-edit-avatar'), label);
      const title = document.querySelector('#followers-dialog-title');
      if (title) title.textContent = username || '';
      updateCounters();
      markClean();
    }
  }

  function setFeed(tab) {
    const empty = document.querySelector && document.querySelector('#profile-feed-empty');
    const tabs = {
      posts: ['#tab-posts', '还没有帖子，发布你的第一篇吧。'],
      saved: ['#tab-saved', '还没有收藏。收藏功能尚未接通。'],
      liked: ['#tab-liked', '还没有点赞。点赞功能尚未接通。'],
    };
    const current = tabs[tab] || tabs.posts;
    if (typeof document.querySelectorAll === 'function') {
      for (const button of document.querySelectorAll('.profile-tabs [role="tab"]')) {
        button.setAttribute('aria-selected', button.id === current[0].slice(1) ? 'true' : 'false');
      }
    }
    if (empty) empty.textContent = current[1];
  }

  function openFollowers(tab) {
    const dialog = document.querySelector && document.querySelector('#followers-dialog');
    if (!dialog) return;
    dialog.hidden = false;
    const following = document.querySelector('#dialog-tab-following');
    const followers = document.querySelector('#dialog-tab-followers');
    const search = document.querySelector('#followers-search');
    const empty = document.querySelector('#followers-dialog-empty');
    const isFollowers = tab !== 'following';
    if (following) following.setAttribute('aria-selected', isFollowers ? 'false' : 'true');
    if (followers) followers.setAttribute('aria-selected', isFollowers ? 'true' : 'false');
    if (search) {
      search.placeholder = isFollowers ? '搜索粉丝' : '搜索关注';
      search.value = '';
    }
    if (empty) empty.textContent = isFollowers
      ? '还没有粉丝。关注和粉丝功能尚未接通。'
      : '还没有关注。关注和粉丝功能尚未接通。';
  }

  function closeFollowers() {
    const dialog = document.querySelector && document.querySelector('#followers-dialog');
    if (dialog) dialog.hidden = true;
  }

  async function loadAgents() {
    const list = document.querySelector && document.querySelector('#profile-agent-list');
    const empty = document.querySelector && document.querySelector('#profile-agents-empty');
    if (!list) return;
    list.replaceChildren();
    try {
      const workspaces = await request('GET', '/v1/workspaces?limit=100');
      if (workspaces.status !== 200) throw new Error('workspaces');
      const items = workspaces.body.items || workspaces.body.workspaces || [];
      const first = items[0];
      if (!first || !first.id) throw new Error('empty');
      const listed = await request('GET', `/v1/workspaces/${first.id}/agents?limit=100`);
      if (listed.status !== 200) throw new Error('agents');
      const agents = (listed.body.items || []).filter(item => item && item.name).slice(0, 5);
      if (!agents.length) throw new Error('empty');
      for (const agent of agents) {
        const row = document.createElement('li');
        const link = document.createElement('a');
        link.href = '/agents';
        const face = document.createElement('span');
        face.className = 'avatar';
        face.dataset.tone = avatarTone(agent.name);
        face.textContent = monogram(agent.name);
        const label = document.createElement('span');
        label.textContent = agent.name;
        link.append(face, label);
        row.appendChild(link);
        list.appendChild(row);
      }
      if (empty) empty.hidden = true;
    } catch {
      if (empty) empty.hidden = false;
    }
  }

  async function load() {
    const session = await request('GET', '/v1/auth/session');
    if (session.status === 401) {
      loginPanel.hidden = false;
      mainPanel.hidden = true;
      show('', '');
      return;
    }
    if (session.status !== 200 || !session.body.user) {
      show('error', messageFor(session.body && session.body.error, '无法读取会话。'));
      return;
    }
    const username = session.body.user.username;
    currentUsername = username;
    loginPanel.hidden = true;
    mainPanel.hidden = false;
    syncView();
    const whoami = document.getElementById('whoami');
    whoami.dataset.username = username;
    whoami.textContent = username;
    document.getElementById('profile-username').textContent = username;
    const email = document.querySelector && document.querySelector('#profile-email');
    if (email) email.textContent = '未设置';
    const result = await request('GET', '/v1/profile');
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法读取资料。'));
      return;
    }
    fill(result.body.profile, username);
    if (hasHome()) await loadAgents();
  }

  const save = document.getElementById('profile-save');
  let saving = false;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (saving) return;
    const changes = collect();
    if (!changes.name) {
      show('error', '请填写昵称。');
      return;
    }
    saving = true;
    if (save) save.disabled = true;
    try {
      const result = await request('POST', '/v1/profile', {revision, changes});
      if (result.status === 409) {
        const current = result.body && result.body.error && result.body.error.current;
        if (current) fill(current, document.getElementById('profile-username').textContent);
        show('error', current
          ? '资料已在别处更新，已重新加载。'
          : '保存失败：资料已在别处更新或 Teamily ID 不可用，请刷新后重试。');
        return;
      }
      if (result.status !== 200 && result.status !== 201) {
        show('error', messageFor(result.body.error, '保存失败。'));
        return;
      }
      fill(result.body.profile, document.getElementById('profile-username').textContent);
      show('ok', '资料已保存。');
    } finally {
      saving = false;
      if (save) {
        if (hasHome()) markDirty();
        else save.disabled = false;
      }
    }
  });

  form.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !['TEXTAREA', 'BUTTON', 'SELECT', 'A'].includes(event.target.tagName)) {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  form.addEventListener('input', () => {
    if (!hasHome()) return;
    updateCounters();
    markDirty();
  });
  form.addEventListener('change', () => {
    if (!hasHome()) return;
    markDirty();
  });

  const reload = document.getElementById('profile-reload');
  if (reload) {
    reload.addEventListener('click', async () => {
      if (reload.disabled) return;
      reload.disabled = true;
      try {
        await load();
      } finally {
        reload.disabled = false;
      }
    });
  }

  const cancel = document.querySelector && document.querySelector('#profile-cancel');
  if (cancel) {
    cancel.addEventListener('click', () => {
      if (isEditPath()) {
        location.href = '/profile';
        return;
      }
      fill({
        name: form.elements.name.value,
        handle: form.elements.handle.value,
        bio: form.elements.bio.value,
        tags: parseTags(form.elements.tags.value),
        gender: form.elements.gender.value,
        location: form.elements.location.value,
        website: form.elements.website.value,
        goals: collect().goals,
        revision,
      }, currentUsername);
    });
  }

  const login = document.getElementById('login-form');
  if (login) {
    login.addEventListener('submit', async event => {
      event.preventDefault();
      const result = await request('POST', '/v1/auth/login', {
        username: login.elements.username.value,
        password: login.elements.password.value,
      });
      if (result.status !== 200) {
        show('error', messageFor(result.body && result.body.error, '无法登录。'));
        return;
      }
      login.reset();
      await load();
    });
  }

  const logout = document.getElementById('logout-form');
  if (logout) {
    logout.addEventListener('submit', async event => {
      event.preventDefault();
      await request('POST', '/v1/auth/logout', {});
      await load();
    });
  }

  if (hasHome()) {
    setFeed('posts');
    const tabPosts = document.querySelector('#tab-posts');
    const tabSaved = document.querySelector('#tab-saved');
    const tabLiked = document.querySelector('#tab-liked');
    if (tabPosts) tabPosts.addEventListener('click', () => setFeed('posts'));
    if (tabSaved) tabSaved.addEventListener('click', () => setFeed('saved'));
    if (tabLiked) tabLiked.addEventListener('click', () => setFeed('liked'));
    const following = document.querySelector('#stat-following');
    const followers = document.querySelector('#stat-followers');
    if (following) following.addEventListener('click', () => openFollowers('following'));
    if (followers) followers.addEventListener('click', () => openFollowers('followers'));
    const close = document.querySelector('#followers-dialog-close');
    if (close) close.addEventListener('click', closeFollowers);
    const dialog = document.querySelector('#followers-dialog');
    if (dialog) {
      dialog.addEventListener('click', event => {
        if (event.target === dialog) closeFollowers();
      });
    }
    const tabF = document.querySelector('#dialog-tab-following');
    const tabR = document.querySelector('#dialog-tab-followers');
    if (tabF) tabF.addEventListener('click', () => openFollowers('following'));
    if (tabR) tabR.addEventListener('click', () => openFollowers('followers'));
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') closeFollowers();
    });
  }

  syncView();
  load();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
}
