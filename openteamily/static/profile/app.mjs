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

export function deleteConfirmation(typed, username) {
  const candidate = String(typed == null ? '' : typed).trim();
  if (!candidate) return {ok: false, message: '请输入你的用户名以确认删除。'};
  if (candidate.toLowerCase() !== String(username || '').toLowerCase()) {
    return {ok: false, message: '输入的账户名与你登录的账户不一致，没有删除任何内容。'};
  }
  return {ok: true, message: ''};
}

export function avatarTone(name) {
  let hash = 0;
  for (const ch of String(name || '')) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return String((hash % 6) + 1);
}

export const FOLLOW_WORK_EMPTY = '还没有关注任何人。先在发现页关注作者，再回来打开作品通知。';

export function followWorkNotice(enabled) {
  return enabled ? '已打开作品通知。' : '已关闭作品通知。';
}

export function followWorkSwitchLabel(name) {
  return name ? name + ' 的作品通知' : '这个账号的作品通知';
}

export function monogram(name) {
  const letters = String(name || '').match(/\p{L}|\p{N}/gu) || [];
  if (!letters.length) return '?';
  if (letters.length === 1) return letters[0].toUpperCase();
  return (letters[0] + letters[1]).toUpperCase();
}

export const AVATAR_LIMIT = 2 * 1024 * 1024;

// The server owns the rules (2 MB cap, PNG/JPG only, session required); the page
// only turns its status codes into Chinese, and never reports success on failure.
export function avatarNotice(status, error) {
  if (status === 413) return '头像不能超过 2 MB。';
  if (status === 415) return '头像只支持 PNG 或 JPG。';
  if (status === 400) return '这张图片无法识别，请换一张 PNG 或 JPG。';
  if (status === 401) return '登录状态已失效，请重新登录。';
  if (status === 403) return '页面已过期，请刷新后重试。';
  return messageFor(error, '头像上传失败，请稍后重试。');
}

export function paintAvatarImage(node, avatar) {
  if (!node) return false;
  if (avatar && avatar.url) {
    node.setAttribute('src', avatar.url);
    node.hidden = false;
    return true;
  }
  node.setAttribute('src', '');
  node.hidden = true;
  return false;
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
  let currentHandle = '';

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

  function publicProfileUrl(handle) {
    const origin = (typeof location !== 'undefined' && location.origin) || '';
    return origin + '/p/' + encodeURIComponent(handle);
  }

  function openEditView() {
    if (typeof history === 'undefined' || typeof history.pushState !== 'function') return;
    if (!isEditPath()) history.pushState({}, '', '/profile/edit');
    syncView();
  }

  function showShareFallback(url) {
    const box = document.querySelector && document.querySelector('#profile-share-fallback');
    const code = document.querySelector && document.querySelector('#profile-share-link');
    if (code) code.textContent = url;
    if (box) box.hidden = false;
  }

  async function shareProfile() {
    if (!currentHandle) {
      show('', '先设置 Teamily ID 才能分享。');
      openEditView();
      const input = document.getElementById('profile-handle');
      if (input && typeof input.focus === 'function') input.focus();
      return;
    }
    const url = publicProfileUrl(currentHandle);
    const clipboard = typeof navigator !== 'undefined' && navigator.clipboard;
    if (clipboard && typeof clipboard.writeText === 'function') {
      try {
        await clipboard.writeText(url);
        show('ok', '公开主页链接已复制。');
        return;
      } catch {
        // The browser refused the clipboard; fall through to the manual-copy line.
      }
    }
    show('error', '浏览器没有给出剪贴板权限，请手动复制下面的链接。');
    showShareFallback(url);
  }

  function paintAvatar(node, name) {
    if (!node) return;
    node.textContent = monogram(name);
    if (node.dataset) node.dataset.tone = avatarTone(name);
  }

  function applyAvatar(avatar) {
    const home = document.querySelector && document.querySelector('#profile-avatar-image');
    const edit = document.querySelector && document.querySelector('#profile-edit-avatar-image');
    const homeTone = document.querySelector && document.querySelector('#profile-avatar');
    const editTone = document.querySelector && document.querySelector('#profile-edit-avatar');
    const shown = paintAvatarImage(home, avatar);
    paintAvatarImage(edit, avatar);
    if (homeTone) homeTone.hidden = shown;
    if (editTone) editTone.hidden = shown;
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
    currentHandle = value.handle || '';
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

  function closeFollowWork() {
    const dialog = document.querySelector('#follow-work-dialog');
    if (dialog) dialog.hidden = true;
  }

  function followWorkRow(item) {
    const li = document.createElement('li');
    li.className = 'follow-work-row';
    const label = document.createElement('label');
    label.className = 'follow-work-label';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = item.enabled;
    input.setAttribute('aria-label', followWorkSwitchLabel(item.name));
    input.dataset.creator = item.creator_id;
    const copy = document.createElement('span');
    copy.className = 'follow-work-copy';
    const name = document.createElement('strong');
    name.textContent = item.name || item.username;
    const handle = document.createElement('span');
    handle.className = 'follow-work-handle';
    handle.textContent = '@' + (item.handle || item.username);
    copy.append(name, handle);
    label.append(input, copy);
    input.addEventListener('change', async () => {
      input.disabled = true;
      try {
        const result = await request('POST', '/v1/profile/follow-work',
          {creator_id: item.creator_id, enabled: input.checked});
        const status = document.querySelector('#follow-work-status');
        if (result.status !== 200) {
          input.checked = !input.checked;
          if (status) {
            status.hidden = false;
            status.textContent = messageFor(result.body.error, '无法保存作品通知设置。');
          }
          return;
        }
        if (status) {
          status.hidden = false;
          status.textContent = followWorkNotice(input.checked);
        }
      } finally {
        input.disabled = false;
      }
    });
    li.append(label);
    return li;
  }

  async function loadFollowWork() {
    const list = document.querySelector('#follow-work-list');
    const empty = document.querySelector('#follow-work-empty');
    const status = document.querySelector('#follow-work-status');
    if (!list) return;
    if (status) {
      status.hidden = true;
      status.textContent = '';
    }
    const result = await request('GET', '/v1/profile/follow-work');
    if (result.status !== 200) {
      list.hidden = true;
      if (empty) {
        empty.hidden = false;
        empty.textContent = messageFor(result.body.error, '无法读取作品通知设置。');
      }
      return;
    }
    const items = result.body.items || [];
    list.replaceChildren(...items.map(followWorkRow));
    list.hidden = items.length === 0;
    if (empty) {
      empty.hidden = items.length > 0;
      empty.textContent = FOLLOW_WORK_EMPTY;
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
    applyAvatar(result.body.avatar);
    if (hasHome()) await loadAgents();
  }

    const deleteButton = document.getElementById('profile-delete-account');
  const deleteDialog = document.getElementById('delete-account-dialog');
  const deleteNote = document.getElementById('delete-account-note');
  const deleteInput = document.getElementById('delete-account-confirm');
  const deleteSubmit = document.getElementById('delete-account-submit');
  let deleting = false;

  function closeDeleteDialog() {
    if (deleteDialog) deleteDialog.hidden = true;
    if (deleteNote) deleteNote.textContent = '';
    if (deleteInput) deleteInput.value = '';
  }

  if (deleteButton && deleteDialog) {
    deleteButton.addEventListener('click', () => {
      deleteDialog.hidden = false;
      if (deleteNote) deleteNote.textContent = '';
      const expected = document.getElementById('delete-account-expected');
      if (expected) expected.textContent = currentUsername;
      if (deleteInput) {
        deleteInput.value = '';
        if (typeof deleteInput.focus === 'function') deleteInput.focus();
      }
    });
    for (const id of ['delete-account-cancel', 'delete-account-back']) {
      const button = document.getElementById(id);
      if (button) button.addEventListener('click', closeDeleteDialog);
    }
    if (typeof document.addEventListener === 'function') {
      document.addEventListener('keydown', event => {
        if (event.key === 'Escape') closeDeleteDialog();
      });
    }
  }

  if (deleteSubmit) {
    deleteSubmit.addEventListener('click', async () => {
      if (deleting) return;
      const typed = deleteInput ? deleteInput.value : '';
      const verdict = deleteConfirmation(typed, currentUsername);
      if (!verdict.ok) {
        if (deleteNote) deleteNote.textContent = verdict.message;
        return;
      }
      deleting = true;
      deleteSubmit.disabled = true;
      try {
        const result = await request('POST', '/v1/account/delete', {username: String(typed).trim()});
        if (result.status === 204) {
          closeDeleteDialog();
          mainPanel.hidden = true;
          loginPanel.hidden = false;
          show('ok', '账户已删除，用户名已释放，现在可以重新注册。');
          return;
        }
        if (result.status === 400) {
          if (deleteNote) deleteNote.textContent = '输入的账户名与你登录的账户不一致，没有删除任何内容。';
          return;
        }
        if (result.status === 409) {
          show('error', '这个账户还有共享内容（工作区或其中别人也在用的记录），当前版本不能自助删除。');
          if (deleteNote) deleteNote.textContent = '先删除你创建的工作区，或联系实例运行者处理这些内容。';
          return;
        }
        show('error', messageFor(result.body && result.body.error, '删除失败，账户没有变化。'));
      } finally {
        deleting = false;
        deleteSubmit.disabled = false;
      }
    });
  }

  const changeAvatar = document.getElementById('profile-change-avatar');
  const avatarInput = document.getElementById('profile-avatar-input');
  if (changeAvatar && avatarInput) {
    changeAvatar.addEventListener('click', () => {
      if (changeAvatar.disabled) return;
      avatarInput.click();
    });
    avatarInput.addEventListener('change', async () => {
      const file = avatarInput.files && avatarInput.files[0];
      avatarInput.value = '';
      if (!file || changeAvatar.disabled) return;
      changeAvatar.disabled = true;
      show('', '正在上传头像…');
      try {
        const form = new FormData();
        form.append('file', file, file.name || 'avatar.png');
        const response = await fetch('/v1/profile/avatar', {
          method: 'POST',
          headers: {Accept: 'application/json', 'X-CSRF-Token': csrfCookie(document.cookie)},
          credentials: 'same-origin',
          body: form,
        });
        let payload = {};
        try { payload = await response.json(); } catch { payload = {}; }
        if (response.status !== 200 || !payload.avatar) {
          show('error', avatarNotice(response.status, payload && payload.error));
          return;
        }
        applyAvatar(payload.avatar);
        show('ok', '头像已更新。');
      } catch {
        show('error', '头像上传失败，请检查网络后重试。');
      } finally {
        changeAvatar.disabled = false;
      }
    });
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
    const share = document.querySelector('#profile-share');
    if (share) share.addEventListener('click', shareProfile);
    const notifyOpen = document.querySelector('#profile-notify-open');
    if (notifyOpen) notifyOpen.addEventListener('click', () => {
      const dialog = document.querySelector('#follow-work-dialog');
      if (!dialog) return;
      dialog.hidden = false;
      loadFollowWork();
    });
    const notifyClose = document.querySelector('#follow-work-dialog-close');
    if (notifyClose) notifyClose.addEventListener('click', closeFollowWork);
    const notifyDialog = document.querySelector('#follow-work-dialog');
    if (notifyDialog) {
      notifyDialog.addEventListener('click', event => {
        if (event.target === notifyDialog) closeFollowWork();
      });
    }
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        closeFollowers();
        closeFollowWork();
      }
    });
  }

  syncView();
  load();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
}
