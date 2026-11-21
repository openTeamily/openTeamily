import { conversationChatHref } from '../shell/thumb.mjs';
import { teamInviteCode, teamInviteFromHash, teamInviteHash, teamInviteUrl } from '../shell/team-invite-link.mjs';

export function csrfCookie(source) {
  const match = /(?:^|;\s*)(?:__Host-ot_csrf|ot_dev_csrf)=([^;]+)/.exec(source || '');
  return match ? decodeURIComponent(match[1]) : '';
}

export const ROLE_LABELS = {owner: '所有者', admin: '管理员', member: '成员'};

export function readAddMember(form) {
  const data = new FormData(form);
  const role = data.get('role') === 'admin' ? 'admin' : 'member';
  return {username: (data.get('username') || '').trim(), role};
}

export function readInvite(form) {
  const data = new FormData(form);
  const days = Number(data.get('expires_days') || 7);
  const uses = Number(data.get('max_uses') || 1);
  return {
    role: data.get('role') === 'admin' ? 'admin' : 'member',
    expires_in: Math.round(days * 86400),
    max_uses: uses,
    ...(data.get('requires_approval') ? {requires_approval: true} : {}),
  };
}

export function directoryMembershipLabel(team) {
  if (team.membership === 'member') return '已加入';
  if (team.membership === 'pending') return '等待审批';
  if (team.membership === 'suspended') return '已暂停';
  return '';
}

// self may be a platform user object or just an id. After the page is served by
// this user's DS-Bot, member.user_id may be a Bot Social owner id or handle.
export function samePerson(item, self) {
  if (!item || self == null || self === '') return false;
  const user = typeof self === 'object' ? self : {id: self};
  if (item.user_id && user.id && item.user_id === user.id) return true;
  const strip = (value) => String(value || '').toLowerCase().replace(/^@/, '').replace(/\.home$/, '');
  const mine = new Set([user.id, user.username, user.handle].filter(Boolean).map(strip).filter(Boolean));
  if (!mine.size) return false;
  return [item.user_id, item.username, item.handle].some((value) => value && mine.has(strip(value)));
}

export function canSuspend(actorRole, item, selfId) {
  if (!item || item.role === 'owner' || samePerson(item, selfId)) return false;
  if (actorRole === 'owner') return true;
  return actorRole === 'admin' && item.role === 'member';
}

export function inviteState(item) {
  if (item.revoked) return '已撤销';
  if (item.frozen) return '已冻结';
  return item.requires_approval ? '有效 · 需审批' : '有效';
}

export function readAccept(form) {
  const data = new FormData(form);
  return {token: (data.get('token') || '').trim()};
}

export function canAdd(actor) {
  return actor === 'owner' || actor === 'admin';
}

export function addableRoles(actor) {
  if (actor === 'owner') return ['admin', 'member'];
  if (actor === 'admin') return ['member'];
  return [];
}

export function canChange(actor) {
  return actor === 'owner';
}

export function canInvite(actor) {
  return actor === 'owner' || actor === 'admin';
}

export function canRemove(actor, target, selfId) {
  if (!target || target.role === 'owner') return false;
  if (samePerson(target, selfId)) return actor === 'admin' || actor === 'member';
  if (actor === 'owner') return target.role === 'admin' || target.role === 'member';
  if (actor === 'admin') return target.role === 'member';
  return false;
}

export function removalPrompt(item, selfId) {
  if (!item) return {question: '', confirmLabel: '确认'};
  if (samePerson(item, selfId)) return {question: '退出工作区？', confirmLabel: '确认退出'};
  const name = item.username || '';
  return {question: name ? `移除 ${name}？` : '移除此成员？', confirmLabel: '确认'};
}

export function revokePrompt() {
  return {question: '撤销这条邀请？', confirmLabel: '确认撤销'};
}

// Freezing pauses an invite without revoking it, so it gets the same inline
// confirmation as revoking instead of firing on one click.
export function freezePrompt(item) {
  return item && item.frozen
    ? {question: '解冻这条邀请？', confirmLabel: '确认解冻'}
    : {question: '冻结这条邀请？', confirmLabel: '确认冻结'};
}

// The server answers these codes with English sentences; the page says the
// same thing in the language the rest of the row uses.
export function inviteFailure(error, action) {
  const code = error && error.code;
  if (code === 'forbidden') {
    return action === 'revoke'
      ? '只有工作区所有者或管理员可以撤销邀请。'
      : '只有工作区所有者或管理员可以冻结邀请。';
  }
  if (code === 'conflict') return '已撤销的邀请不能冻结或解冻。';
  if (code === 'not_found') return '找不到这条邀请，可能已被撤销或删除。';
  return (error && error.message) || '无法更新邀请。';
}

function messageFor(error, fallback) {
  if (error && error.message) return error.message;
  return fallback;
}

export function mount(document, {fetcher = globalThis.fetch.bind(globalThis), assign} = {}) {
  const goTo = assign || ((href) => globalThis.location.assign(href));
  const status = document.getElementById('status');
  const loginPanel = document.getElementById('login-panel');
  const mainPanel = document.getElementById('main-panel');
  const workspaceSelect = document.getElementById('workspace');
  const view = document.defaultView;
  const receiveForm = document.getElementById('accept-form');
  const receiveToken = document.getElementById('receive-invite-token');
  const receiveField = document.getElementById('receive-invite-field');
  const receivePreview = document.getElementById('invitation-preview');
  const receiveButton = document.getElementById('confirm-invite');
  let linkedInvite = teamInviteFromHash(view?.location?.hash);
  let previewed = '';
  let inviteRequest = 0;
  let accepting = false;
  let currentUser = null;
  let actor = null;
  let workspaces = [];

  function show(kind, text) {
    status.dataset.kind = kind;
    status.textContent = text;
  }

  async function request(method, path, body, extraHeaders) {
    const headers = {'Accept': 'application/json', 'X-CSRF-Token': csrfCookie(document.cookie)};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (extraHeaders) Object.assign(headers, extraHeaders);
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

  let pendingConfirm = null;
  let confirmSerial = 0;
  let memberItems = [];
  let inviteItems = [];

  function currentId() {
    return currentUser && currentUser.id;
  }

  function closeConfirm({restoreFocus = true} = {}) {
    if (!pendingConfirm) return;
    const {box, trigger} = pendingConfirm;
    pendingConfirm = null;
    if (box && box.parentElement) box.remove();
    if (trigger) {
      trigger.hidden = false;
      if (restoreFocus && typeof trigger.focus === 'function') trigger.focus();
    }
  }

  function openConfirm({row, trigger, prompt, action}) {
    closeConfirm();
    const questionId = `member-confirm-question-${++confirmSerial}`;
    const box = document.createElement('span');
    box.className = 'row-confirm';
    box.setAttribute('role', 'alertdialog');
    box.setAttribute('aria-labelledby', questionId);
    const question = document.createElement('span');
    question.id = questionId;
    question.textContent = prompt.question;
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = '取消';
    cancel.dataset.confirmAction = 'cancel';
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.textContent = prompt.confirmLabel;
    confirm.dataset.confirmAction = 'ok';
    box.appendChild(question);
    box.appendChild(cancel);
    box.appendChild(confirm);
    trigger.hidden = true;
    row.appendChild(box);
    pendingConfirm = {row, box, trigger, action};
    if (typeof cancel.focus === 'function') cancel.focus();
  }

  // One delegated listener for both lists: row buttons only carry data attributes.
  document.addEventListener('click', event => {
    const target = event.target;
    if (!target || !target.dataset) return;
    if (target.dataset.confirmAction === 'cancel') {
      closeConfirm();
      return;
    }
    if (target.dataset.confirmAction === 'ok') {
      if (!pendingConfirm) return;
      const run = pendingConfirm.action;
      closeConfirm();
      run();
      return;
    }
    if (target.dataset.rowAction === 'remove') {
      const item = memberItems.find(entry => entry.user_id === target.dataset.userId);
      if (!item) return;
      openConfirm({
        row: target.parentElement,
        trigger: target,
        prompt: removalPrompt(item, currentId()),
        action: () => removeMember(item),
      });
      return;
    }
    if (target.dataset.rowAction === 'revoke') {
      const item = inviteItems.find(entry => entry.id === target.dataset.inviteId);
      if (!item) return;
      openConfirm({
        row: target.parentElement,
        trigger: target,
        prompt: revokePrompt(item),
        action: () => revokeInvite(item),
      });
      return;
    }
    if (target.dataset.rowAction === 'freeze' || target.dataset.rowAction === 'unfreeze') {
      const item = inviteItems.find(entry => entry.id === target.dataset.inviteId);
      if (!item) return;
      const action = target.dataset.rowAction;
      openConfirm({
        row: target.parentElement,
        trigger: target,
        prompt: freezePrompt(item),
        action: () => inviteAction(item, action),
      });
    }
  });

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !pendingConfirm) return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    closeConfirm();
  });

  function setRoleOptions(form, actorRole) {
    const select = form.elements.role;
    const allowed = addableRoles(actorRole);
    for (const option of select.options) {
      option.hidden = !allowed.includes(option.value);
    }
    if (!allowed.includes(select.value)) select.value = allowed[0] || 'member';
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


  function monogram(name) {
    const text = String(name || '').trim();
    const chars = Array.from(text);
    const label = (chars.slice(0, chars[0] && /[A-Za-z]/.test(chars[0]) ? 2 : 1).join('') || '?');
    let tone = 0;
    for (const ch of chars) tone += ch.codePointAt(0) || 0;
    return {label, tone: (tone % 6) + 1};
  }

  function identity(name, detail) {
    const wrap = document.createElement('span');
    wrap.className = 'member-id';
    const mark = monogram(name);
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.dataset.tone = String(mark.tone);
    avatar.textContent = mark.label;
    const label = document.createElement('span');
    label.className = 'member-name';
    label.textContent = detail ? `${name} · ${detail}` : (name || '');
    wrap.appendChild(avatar);
    wrap.appendChild(label);
    // Fake-DOM tests read textContent on the wrap itself; keep a copy of the
    // visible name there when the getter does not walk children.
    if (Object.prototype.hasOwnProperty.call(wrap, '_text')) wrap._text = label.textContent;
    return wrap;
  }

  function messageKey() {
    const raw = (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : (String(Date.now()) + 'dmxxxxxxxx');
    return ('member-dm-' + raw.replace(/-/g, '')).slice(0, 64);
  }

  async function startDirectMessage(item) {
    const id = workspaceId();
    if (!id || !item || !item.user_id) return;
    if (currentUser && samePerson(item, currentUser)) {
      show('error', '不能给自己发消息。');
      return;
    }
    const result = await request('POST', `/v1/workspaces/${id}/social/conversations`, {
      kind: 'dm', member_ids: [item.user_id],
    }, {'Idempotency-Key': messageKey()});
    if (result.status !== 200 && result.status !== 201) {
      show('error', messageFor(result.body.error, '无法打开与对方的单聊。'));
      return;
    }
    const conversation = result.body.conversation;
    if (!conversation || !conversation.id) {
      show('error', '已发起会话，但没有返回可打开的对话。');
      return;
    }
    goTo(conversationChatHref(id, {source: 'social', id: conversation.id}));
  }

  function renderMembers(items) {
    const list = document.getElementById('member-list');
    const empty = document.getElementById('members-empty');
    memberItems = items;
    pendingConfirm = null;
    list.textContent = '';
    empty.hidden = items.length > 0;
    const selfId = currentUser;
    for (const item of items) {
      const row = document.createElement('li');
      const roleText = (ROLE_LABELS[item.role] || item.role) + (item.suspended ? ' · 已停用' : '');
      row.appendChild(identity(item.username, roleText));
      const role = document.createElement('span');
      role.className = 'role-pill' + (item.role === 'owner' ? ' is-owner' : '');
      role.textContent = ROLE_LABELS[item.role] || item.role;
      row.appendChild(role);
      if (!samePerson(item, selfId)) {
        const message = document.createElement('button');
        message.type = 'button';
        message.textContent = '发消息';
        message.title = '打开与对方的人与人单聊';
        message.addEventListener('click', () => startDirectMessage(item));
        row.appendChild(message);
      }
      if (canSuspend(actor, item, selfId)) {
        const suspend = document.createElement('button');
        suspend.type = 'button';
        suspend.textContent = item.suspended ? '恢复访问' : '停用';
        suspend.title = item.suspended ? '恢复后对方可再次访问本工作区' : '停用后对方保留成员身份，但无法访问本工作区，可随时恢复';
        suspend.addEventListener('click', () => suspendMember(item, !item.suspended));
        row.appendChild(suspend);
      }
      if (canChange(actor) && item.role !== 'owner') {
        const change = document.createElement('button');
        change.type = 'button';
        change.textContent = item.role === 'admin' ? '改为成员' : '改为管理员';
        change.addEventListener('click', () => changeRole(item, item.role === 'admin' ? 'member' : 'admin'));
        row.appendChild(change);
      }
      if (canRemove(actor, item, selfId)) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = samePerson(item, selfId) ? '退出' : '移除';
        remove.dataset.rowAction = 'remove';
        remove.dataset.userId = item.user_id;
        row.appendChild(remove);
      }
      list.appendChild(row);
    }
  }

  function renderInvites(items) {
    const list = document.getElementById('invite-list');
    const empty = document.getElementById('invites-empty');
    inviteItems = items;
    pendingConfirm = null;
    list.textContent = '';
    empty.hidden = items.length > 0;
    for (const item of items) {
      const row = document.createElement('li');
      const state = inviteState(item);
      const detail = `${ROLE_LABELS[item.role] || item.role} · ${state} · 已用 ${item.use_count}/${item.max_uses}`;
      row.appendChild(identity('邀请', detail));
      const role = document.createElement('span');
      role.className = 'role-pill';
      role.textContent = ROLE_LABELS[item.role] || item.role;
      row.appendChild(role);
      if (!item.revoked) {
        const revoke = document.createElement('button');
        revoke.type = 'button';
        revoke.textContent = '撤销';
        revoke.dataset.rowAction = 'revoke';
        revoke.dataset.inviteId = item.id;
        const freeze = document.createElement('button');
        freeze.type = 'button';
        freeze.textContent = item.frozen ? '解冻' : '冻结';
        freeze.title = item.frozen ? '解冻后邀请可再次使用，不会撤销' : '暂停这条邀请，不撤销，可随时解冻';
        freeze.dataset.rowAction = item.frozen ? 'unfreeze' : 'freeze';
        freeze.dataset.inviteId = item.id;
        row.appendChild(freeze);
        row.appendChild(revoke);
      }
      list.appendChild(row);
    }
  }

  async function changeRole(item, role) {
    const id = workspaceId();
    if (!id) return;
    const result = await request('POST', `/v1/workspaces/${id}/members/${item.user_id}`, {role});
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法更改角色。'));
      return;
    }
    show('ok', '已更改角色。');
    await loadWorkspace();
  }

  async function suspendMember(item, suspend) {
    const id = workspaceId();
    if (!id) return;
    const result = await request('POST', `/v1/workspaces/${id}/members/${item.user_id}/${suspend ? 'suspend' : 'unsuspend'}`, {});
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法更新成员状态。'));
      return;
    }
    show('ok', suspend ? '已停用该成员的访问。' : '已恢复该成员的访问。');
    await loadWorkspace();
  }

  async function removeMember(item) {
    const id = workspaceId();
    if (!id) return;
    const result = await request('POST', `/v1/workspaces/${id}/members/${item.user_id}/remove`, {});
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法移除成员。'));
      return;
    }
    show('ok', samePerson(item, currentUser) ? '已退出工作区。' : '已移除。');
    await load();
  }

  async function inviteAction(item, action) {
    const id = workspaceId();
    if (!id) return;
    const result = await request('POST', `/v1/workspaces/${id}/invites/${item.id}/${action}`, {});
    if (result.status !== 200) {
      show('error', inviteFailure(result.body.error, action));
      return;
    }
    show('ok', action === 'freeze' ? '已冻结。' : '已解冻。');
    await loadWorkspace();
  }

  function renderJoinRequests(items) {
    const list = document.getElementById('join-request-list');
    const empty = document.getElementById('join-requests-empty');
    if (!list) return;
    list.textContent = '';
    if (empty) empty.hidden = items.length > 0;
    for (const item of items) {
      const row = document.createElement('li');
      row.appendChild(identity(item.username, '申请成为' + (ROLE_LABELS[item.role] || item.role)));
      for (const [decision, label] of [['approve', '批准'], ['reject', '拒绝']]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.addEventListener('click', () => decideJoin(item, decision));
        row.appendChild(button);
      }
      list.appendChild(row);
    }
  }

  async function decideJoin(item, decision) {
    const id = workspaceId();
    if (!id) return;
    const result = await request('POST', `/v1/workspaces/${id}/join-requests/${item.id}/${decision}`, {});
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法处理申请。'));
      return;
    }
    show('ok', decision === 'approve' ? '已批准，对方已加入。' : '已拒绝申请。');
    await loadWorkspace();
  }

  async function revokeInvite(item) {
    const id = workspaceId();
    if (!id) return;
    const result = await request('POST', `/v1/workspaces/${id}/invites/${item.id}/revoke`, {});
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法撤销邀请。'));
      return;
    }
    show('ok', '已撤销邀请。');
    await loadWorkspace();
  }

  async function loadWorkspace() {
    const id = workspaceId();
    const addForm = document.getElementById('add-form');
    const inviteForm = document.getElementById('invite-form');
    const invitesPanel = document.getElementById('invites-panel');
    const membersPanel = document.getElementById('members-panel');
    const workspaceField = document.getElementById('member-workspace-field');
    if (membersPanel) membersPanel.hidden = !id;
    if (workspaceField) workspaceField.hidden = !id;
    if (!id) {
      actor = null;
      renderMembers([]);
      document.getElementById('role-note').textContent = '加入或创建团队后，可以在这里管理成员。';
      addForm.hidden = true;
      inviteForm.hidden = true;
      invitesPanel.hidden = true;
      for (const panelId of ['join-requests-panel', 'directory-listing-form']) {
        const panel = document.getElementById(panelId);
        if (panel) panel.hidden = true;
      }
      return;
    }
    const listed = await request('GET', `/v1/workspaces/${id}/members`);
    if (listed.status !== 200) {
      show('error', messageFor(listed.body.error, '无法读取成员列表。'));
      return;
    }
    const items = listed.body.items || [];
    const self = items.find(item => samePerson(item, currentUser));
    actor = self ? self.role : null;
    document.getElementById('role-note').textContent = actor
      ? `当前角色：${ROLE_LABELS[actor] || actor}`
      : '';
    renderMembers(items);
    addForm.hidden = !canAdd(actor);
    inviteForm.hidden = !canInvite(actor);
    invitesPanel.hidden = !canInvite(actor);
    if (canAdd(actor)) setRoleOptions(addForm, actor);
    if (canInvite(actor)) {
      setRoleOptions(inviteForm, actor);
      const invites = await request('GET', `/v1/workspaces/${id}/invites`);
      if (invites.status === 200) renderInvites(invites.body.items || []);
      else renderInvites([]);
      const joins = await request('GET', `/v1/workspaces/${id}/join-requests`);
      const joinPanel = document.getElementById('join-requests-panel');
      if (joinPanel) joinPanel.hidden = false;
      renderJoinRequests(joins.status === 200 ? (joins.body.items || []) : []);
    } else {
      const joinPanel = document.getElementById('join-requests-panel');
      if (joinPanel) joinPanel.hidden = true;
    }
    await loadDirectoryListing(id);
  }

  async function loadDirectoryListing(id) {
    const form = document.getElementById('directory-listing-form');
    if (!form) return;
    form.hidden = actor !== 'owner';
    if (form.hidden) return;
    let listing;
    try {
      listing = await request('GET', `/v1/workspaces/${id}/directory`);
    } catch (error) {
      form.hidden = true;  // optional panel; never break the member list
      return;
    }
    if (listing.status !== 200 || workspaceId() !== id) return;
    document.getElementById('directory-listed').checked = Boolean(listing.body.listing.listed);
    document.getElementById('directory-summary').value = listing.body.listing.summary || '';
  }

  function renderDirectory(items) {
    const list = document.getElementById('directory-results');
    list.textContent = '';
    document.getElementById('directory-empty').hidden = items.length > 0;
    for (const team of items) {
      const li = document.createElement('li');
      const name = document.createElement('strong');
      name.textContent = team.name;
      const meta = document.createElement('span');
      meta.className = 'note';
      meta.textContent = `${team.member_count} 人` + (team.summary ? ' · ' + team.summary : '');
      li.append(name, ' ', meta);
      const label = directoryMembershipLabel(team);
      if (label) {
        li.append(' ' + label);
      } else {
        const join = document.createElement('button');
        join.type = 'button';
        join.textContent = '申请加入';
        join.addEventListener('click', async () => {
          const result = await request('POST', `/v1/team-directory/${team.workspace_id}/join`, {});
          if (result.status !== 200 && result.status !== 202) {
            show('error', messageFor(result.body.error, '无法提交加入申请。'));
            return;
          }
          show('ok', '已提交加入申请，等待所有者或管理员审批。');
          join.disabled = true;
          join.textContent = '等待审批';
        });
        li.append(join);
      }
      list.appendChild(li);
    }
  }

  const directoryForm = document.getElementById('directory-search-form');
  if (directoryForm) directoryForm.addEventListener('submit', async event => {
    event.preventDefault();
    const q = document.getElementById('directory-query').value.trim();
    const result = await request('GET', '/v1/team-directory' + (q ? '?q=' + encodeURIComponent(q) : ''));
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法搜索团队目录。'));
      return;
    }
    renderDirectory(result.body.items || []);
  });

  const listingForm = document.getElementById('directory-listing-form');
  if (listingForm) listingForm.addEventListener('submit', async event => {
    event.preventDefault();
    const result = await request('POST', `/v1/workspaces/${workspaceId()}/directory`, {
      listed: document.getElementById('directory-listed').checked,
      summary: document.getElementById('directory-summary').value,
    });
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法保存目录设置。'));
      return;
    }
    show('ok', result.body.listing.listed ? '已在团队目录中公开。' : '已从团队目录移除。');
  });

  function resetInvitePreview() {
    inviteRequest++;
    previewed = '';
    receivePreview.textContent = '';
    receivePreview.hidden = true;
    if (receiveField) receiveField.hidden = false;
    receiveButton.textContent = '查看邀请';
  }

  async function previewInvite(token) {
    const sequence = ++inviteRequest;
    previewed = '';
    receivePreview.hidden = false;
    receivePreview.textContent = '正在查看邀请…';
    receiveButton.disabled = true;
    try {
      const result = await request('POST', '/v1/invites/preview', {token}).catch(() => null);
      if (sequence !== inviteRequest) return;
      const invitation = result?.body?.invitation;
      if (result?.status !== 200 || !invitation?.team_name) {
        receivePreview.textContent = result?.status === 404 || result?.status === 410
          ? '这条邀请已失效。' : '暂时无法读取邀请，请重试。';
        return;
      }
      previewed = token;
      receivePreview.textContent = `团队：${invitation.team_name} · ${ROLE_LABELS[invitation.role] || '成员'}`;
      if (receiveField && receiveToken.type === 'password') receiveField.hidden = true;
      receiveButton.textContent = invitation.requires_approval ? '提交加入申请' : '确认加入';
    } finally {
      if (sequence === inviteRequest) receiveButton.disabled = false;
    }
  }

  async function load(preferred = '') {
    const session = await request('GET', '/v1/auth/session');
    if (session.status === 401) {
      currentUser = null;
      receiveForm.reset();
      receiveToken.type = 'text';
      resetInvitePreview();
      receiveButton.disabled = false;
      loginPanel.hidden = false;
      mainPanel.hidden = true;
      show('', '');
      await renderProviders();
      return;
    }
    if (session.status !== 200) {
      show('error', messageFor(session.body.error, '无法读取会话。'));
      return;
    }
    currentUser = session.body.user;
    loginPanel.hidden = true;
    mainPanel.hidden = false;
    document.getElementById('whoami').textContent = currentUser.username;
    if (linkedInvite) {
      const token = linkedInvite;
      linkedInvite = '';
      receiveForm.dataset.linked = 'true';
      mainPanel.querySelector('.page-toolbar')?.before(receiveForm);
      receiveToken.type = 'password';
      receiveToken.value = token;
      view.history.replaceState(null, '', view.location.pathname + view.location.search);
      void previewInvite(token);
    }
    const space = await request('GET', '/v1/workspaces?limit=100');
    if (space.status !== 200) {
      show('error', messageFor(space.body.error, '无法读取工作区。'));
      return;
    }
    workspaces = (space.body.items || []).filter(workspace => workspace.kind !== 'personal');
    const previous = preferred || workspaceSelect.value;
    workspaceSelect.textContent = '';
    for (const item of workspaces) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.name || item.slug || item.id;
      workspaceSelect.appendChild(option);
    }
    if (previous && [...workspaceSelect.options].some(option => option.value === previous)) {
      workspaceSelect.value = previous;
    }
    await loadWorkspace();
  }

  document.getElementById('login-form').addEventListener('submit', async event => {
    event.preventDefault();
    const result = await request('POST', '/v1/auth/login', {
      username: document.getElementById('username').value,
      password: document.getElementById('password').value,
    });
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '登录失败。'));
      return;
    }
    document.getElementById('password').value = '';
    await load();
  });

  workspaceSelect.addEventListener('change', async () => {
    document.getElementById('issued-token').hidden = true;
    document.getElementById('issued-invite-link').value = '';
    await loadWorkspace();
  });

  document.getElementById('add-form').addEventListener('submit', async event => {
    event.preventDefault();
    const id = workspaceId();
    if (!id) {
      show('error', '先选择一个工作区。');
      return;
    }
    const values = readAddMember(event.currentTarget);
    if (!values.username) {
      show('error', '请填写用户名。');
      return;
    }
    const result = await request('POST', `/v1/workspaces/${id}/members`, values);
    if (result.status !== 200 && result.status !== 201) {
      show('error', messageFor(result.body.error, '无法添加成员。'));
      return;
    }
    event.currentTarget.reset();
    setRoleOptions(event.currentTarget, actor);
    show('ok', '已添加。');
    await loadWorkspace();
  });

  document.getElementById('invite-form').addEventListener('submit', async event => {
    event.preventDefault();
    const id = workspaceId();
    if (!id) {
      show('error', '先选择一个工作区。');
      return;
    }
    const values = readInvite(event.currentTarget);
    const result = await request('POST', `/v1/workspaces/${id}/invites`, values);
    if (result.status !== 201) {
      show('error', messageFor(result.body.error, '无法生成邀请。'));
      return;
    }
    const box = document.getElementById('issued-token');
    const url = teamInviteUrl(result.body.token, view?.location?.origin);
    box.hidden = !url;
    document.getElementById('issued-invite-link').value = url;
    show(url ? 'ok' : 'error', url ? '已生成邀请链接，请现在复制。' : '无法显示这次生成的邀请链接。');
    await loadWorkspace();
  });

  document.getElementById('copy-issued-invite')?.addEventListener('click', async () => {
    const field = document.getElementById('issued-invite-link');
    if (!field.value) return;
    try {
      await view.navigator.clipboard.writeText(field.value);
      show('ok', '已复制邀请链接。');
    } catch {
      field.select();
      show('error', '请复制选中的链接。');
    }
  });

  receiveToken?.addEventListener('input', () => {
    if (accepting) return;
    resetInvitePreview();
    receiveButton.disabled = false;
  });
  receiveForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (accepting || receiveButton.disabled) return;
    const token = teamInviteCode(readAccept(event.currentTarget).token, view?.location?.origin);
    if (!token) {
      receivePreview.hidden = false;
      receivePreview.textContent = '请输入当前站点的有效邀请链接或邀请码。';
      return;
    }
    if (token !== previewed) return previewInvite(token);
    const viewer = currentUser;
    accepting = true;
    receiveToken.readOnly = true;
    receiveButton.disabled = true;
    try {
      const result = await request('POST', '/v1/invites/accept', {token}).catch(() => null);
      if (viewer !== currentUser) return;
      if (![200, 201, 202].includes(result?.status)) {
        if (result?.status === 404 || result?.status === 410) {
          resetInvitePreview();
          receivePreview.hidden = false;
          receivePreview.textContent = '这条邀请已失效。';
        } else receivePreview.textContent = '暂时无法接受邀请，请重试。';
        return;
      }
      receiveForm.reset();
      receiveToken.type = 'text';
      resetInvitePreview();
      receivePreview.hidden = false;
      const pending = result.status === 202 || result.body.join_request?.status === 'pending';
      receivePreview.textContent = pending ? '已提交加入申请，等待审批。' : '已加入工作区。';
      if (!pending) await load(result.body.workspace?.id);
    } finally {
      accepting = false;
      receiveToken.readOnly = false;
      receiveButton.disabled = false;
    }
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

  return load();
}

if (globalThis.document && globalThis.document.getElementById('add-form')) {
  mount(globalThis.document);
}
