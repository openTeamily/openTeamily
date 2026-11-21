import {mountMeetingAudio} from './audio.mjs';
import {readWorkspaceChoices, servedByDsBot} from '../shell/dsbot-api.mjs';
import {takeMeetingFromChat} from '../shell/meeting-link.mjs';

function csrfCookie(source) {
  const match = /(?:^|;\s*)(?:__Host-ot_csrf|ot_dev_csrf)=([^;]+)/.exec(source || '');
  return match ? decodeURIComponent(match[1]) : '';
}

function messageFor(error, fallback) {
  if (error && error.message) return error.message;
  return fallback;
}

function formatTime(seconds) {
  if (!seconds) return '';
  const date = new Date(Number(seconds) * 1000);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(date);
}

function inputTime(seconds) {
  const date = seconds ? new Date(Number(seconds) * 1000) : new Date();
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function parseAttendees(text) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text || '').split(/[,，]/)) {
    const name = raw.trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

export function actionToggleBody(actions, index, done, revision) {
  const items = (actions || []).map((item, position) => ({
    text: item.text,
    done: position === index ? Boolean(done) : Boolean(item.done),
    owner: item.owner || '',
  }));
  return {revision, changes: {action_items: items}};
}


export const MEMBER_ROLE_LABELS = {owner: '所有者', admin: '管理员', member: '成员'};
export const ATTENDEE_EMPTY = '无匹配成员';
export const ATTENDEE_UNAVAILABLE = '读不到成员列表';
export const ATTENDEE_MIN = 2;
export const ATTENDEE_LIMIT = 6;

export function attendeeQuery(text) {
  const parts = String(text || '').split(/[,，]/);
  return parts[parts.length - 1].trim();
}

export function matchMembers(members, query, used) {
  const needle = String(query || '').trim().toLowerCase();
  if (needle.length < ATTENDEE_MIN) return [];
  const taken = new Set(parseAttendees(used).map(name => name.toLowerCase()));
  return (members || [])
    .filter(item => item && item.username && !taken.has(String(item.username).toLowerCase()))
    .filter(item => String(item.username).toLowerCase().includes(needle))
    .slice(0, ATTENDEE_LIMIT);
}

export function attendeeInsert(text, username) {
  const parts = String(text || '').split(/[,，]/);
  parts[parts.length - 1] = ' ' + username;
  return parts.join(',').replace(/^\s+/, '').replace(/[\s,]+$/, '') + ', ';
}

async function request(method, path, body, extra, signal) {
  const headers = { Accept: 'application/json', ...(extra || {}) };
  const options = { method, headers, credentials: 'same-origin', signal };
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

const meetingKey = prefix => prefix + (globalThis.crypto?.randomUUID
  ? crypto.randomUUID().replace(/-/g, '') : String(Date.now()));
const meetingIdPattern = /^[a-f0-9]{32}$/;
const unavailable = {status: 0, body: {}};

export function mountMeetingShares(document, {request, context, historyWorkspace = () => '', key = () => meetingKey('meeting-share-')}) {
  const control = name => document.getElementById('meeting-share-' + name);
  const trigger = document.getElementById('share-meeting');
  const historyTrigger = document.getElementById('meeting-shares-history');
  const dialog = control('dialog');
  if (!trigger || typeof dialog?.showModal !== 'function') return {sync() {}};
  const close = control('close');
  const select = control('conversation');
  const recipients = control('recipients');
  const choices = control('recipient-items');
  const feedback = control('recipient-status');
  const submit = control('submit');
  const status = control('status');
  const sent = control('sent');
  const sentStatus = control('sent-status');
  const sentMore = control('sent-more');
  const form = control('form');
  let view;
  let attempt;

  const call = (method, path, body, headers, signal) => request(method, path, body, headers, signal)
    .catch(() => ({status: 0, body: {}}));
  function isCurrent(state) {
    if (!dialog.open || view !== state || !state) return false;
    if (state.historyOnly) return historyWorkspace() === state.workspace;
    const target = context();
    return target?.workspace === state.workspace && target.meeting.id === state.meeting.id;
  }
  function syncForm(state) {
    close.disabled = state.busy;
    select.disabled = state.busy || select.options.length < 2;
    recipients.disabled = state.busy;
    submit.disabled = state.busy || !state.selected.size;
    sentMore.hidden = !state.sentCursor;
    sentMore.disabled = state.busy || state.sentLoading;
    for (const button of sent.querySelectorAll('button')) button.disabled = state.busy || state.sentLoading;
  }

  function renderSent(state, items) {
    sent.replaceChildren();
    sentStatus.textContent = items.length ? '' : '尚未分享。';
    for (const item of items) {
      const li = document.createElement('li');
      li.dataset.shareId = item.id;
      const info = document.createElement('p');
      info.textContent = [`版本 ${item.revision}`, formatTime(item.created), (item.recipients || []).join('、')]
        .filter(Boolean).join(' · ');
      const actions = document.createElement('div');
      actions.className = 'meeting-actions';
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.className = 'secondary meeting-share-revoke';
      revoke.textContent = '撤回分享';
      revoke.addEventListener('click', () => {
        if (!isCurrent(state) || state.busy || state.sentLoading) return;
        const note = document.createElement('span');
        note.textContent = '撤回后，接收人将无法打开这个副本。';
        const confirm = document.createElement('button');
        confirm.type = 'button';
        confirm.className = 'meeting-share-revoke-confirm';
        confirm.textContent = '确认撤回';
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'secondary';
        cancel.textContent = '取消';
        cancel.addEventListener('click', () => { actions.replaceChildren(revoke); revoke.focus(); });
        confirm.addEventListener('click', async () => {
          if (!isCurrent(state) || state.busy || state.sentLoading) return;
          state.sentRequest = (state.sentRequest || 0) + 1;
          state.busy = true;
          syncForm(state);
          sentStatus.textContent = '正在撤回…';
          const result = await call('POST', `${state.base}/shared/${item.id}/revoke`, {});
          if (!isCurrent(state)) return;
          state.busy = false;
          const revoked = result.status === 200 || result.status === 204;
          if (revoked) {
            state.sentItems = state.sentItems.filter(row => row.id !== item.id);
            li.remove();
            sentStatus.textContent = '已撤回分享。';
          } else {
            sentStatus.textContent = messageFor(result.body.error, '无法撤回分享，请重试。');
          }
          syncForm(state);
          if (revoked) close.focus();
        });
        actions.replaceChildren(note, confirm, cancel);
        confirm.focus();
      });
      actions.append(revoke);
      if (state.historyOnly) {
        const title = document.createElement('strong');
        title.textContent = item.title;
        li.append(title);
      }
      li.append(info, actions);
      sent.append(li);
    }
    syncForm(state);
  }

  async function loadSent(state, append = false) {
    if (!isCurrent(state) || (append && (!state.sentCursor || state.sentLoading || state.busy))) return;
    const sequence = state.sentRequest = (state.sentRequest || 0) + 1;
    state.sentLoading = true;
    syncForm(state);
    sentStatus.textContent = '正在加载分享记录…';
    const query = new URLSearchParams(state.historyOnly ? {sent: '1', limit: '100'} : {limit: '100'});
    if (append) query.set('cursor', state.sentCursor);
    const result = await call('GET', state.path + '?' + query, undefined, undefined, state.controller.signal);
    if (!isCurrent(state) || sequence !== state.sentRequest) return;
    state.sentLoading = false;
    if (result.status === 200) {
      const items = result.body.items || [];
      state.sentItems = append ? [...new Map([...state.sentItems, ...items].map(row => [row.id, row])).values()] : items;
      const cursor = result.body.cursor;
      state.sentCursor = typeof cursor === 'string' && (!append || cursor !== state.sentCursor) ? cursor : '';
      renderSent(state, state.sentItems);
    } else {
      sentStatus.textContent = messageFor(result.body.error, '无法加载分享记录。关闭后可重新打开。');
      syncForm(state);
    }
  }

  async function open(target, historyOnly = false) {
    if (!target?.workspace || dialog.open) return;
    const base = `/v1/workspaces/${target.workspace}/meetings`;
    const state = view = {
      workspace: target.workspace, meeting: {...target.meeting}, base, historyOnly,
      path: historyOnly ? base + '/shared' : `${base}/${target.meeting.id}/shares`,
      selected: new Set(), busy: false, controller: new AbortController(), sentItems: [],
    };
    control('title').textContent = historyOnly ? '分享记录' : '分享纪要';
    control('lead').textContent = historyOnly ? ''
      : `分享「${state.meeting.title}」的版本 ${state.meeting.revision}。接收人只能查看标题、时间、摘要和行动项。`;
    form.hidden = historyOnly;
    select.replaceChildren();
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '请选择会话';
    select.append(option);
    select.value = '';
    choices.replaceChildren();
    sent.replaceChildren();
    status.textContent = '';
    feedback.textContent = '正在加载会话…';
    syncForm(state);
    dialog.showModal();
    void loadSent(state);
    if (historyOnly) return;
    const path = `/v1/workspaces/${state.workspace}/social/conversations?limit=100`;
    const result = await call('GET', path, undefined, undefined, state.controller.signal);
    if (!isCurrent(state)) return;
    if (result.status !== 200) {
      feedback.textContent = messageFor(result.body.error, '无法加载会话。关闭后可重新打开。');
      return;
    }
    for (const row of result.body.items || []) {
      if (!['group', 'dm'].includes(row.kind) || row.public_agent || row.direct?.open === false) continue;
      const entry = document.createElement('option');
      entry.value = row.id;
      entry.textContent = row.title || (row.members || []).map(member => member.username).filter(Boolean).join('、')
        || (row.kind === 'group' ? '群聊' : '单聊');
      select.append(entry);
    }
    feedback.textContent = select.options.length > 1 ? '' : '当前工作区没有可分享的会话。';
    syncForm(state);
  }
  trigger.addEventListener('click', () => open(context()));
  historyTrigger?.addEventListener('click', () => open({workspace: historyWorkspace()}, true));
  sentMore.addEventListener('click', () => { if (view) return loadSent(view, true); });

  select.addEventListener('change', async () => {
    const state = view;
    if (!state || !isCurrent(state) || state.busy) return;
    state.recipientRequest?.abort();
    state.selected.clear();
    choices.replaceChildren();
    status.textContent = '';
    syncForm(state);
    const conversation = select.value;
    feedback.textContent = conversation ? '正在加载接收人…' : '';
    if (!conversation) return;
    const controller = state.recipientRequest = new AbortController();
    const query = new URLSearchParams({conversation_id: conversation});
    const result = await call('GET', `${state.base}/share-recipients?${query}`, undefined, undefined, controller.signal);
    if (!isCurrent(state) || state.recipientRequest !== controller || select.value !== conversation) return;
    if (result.status !== 200) {
      feedback.textContent = messageFor(result.body.error, '无法加载接收人，请重新选择会话。');
      return;
    }
    for (const item of result.body.items || []) {
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.name = 'recipient';
      box.value = item.id;
      box.addEventListener('change', () => {
        if (!isCurrent(state) || state.busy) return;
        if (box.checked && state.selected.size >= 50) {
          box.checked = false;
          feedback.textContent = '最多选择 50 位接收人。';
          return;
        }
        if (box.checked) state.selected.add(item.id);
        else state.selected.delete(item.id);
        feedback.textContent = '';
        syncForm(state);
      });
      label.append(box, document.createTextNode(item.name));
      choices.append(label);
    }
    feedback.textContent = choices.children.length ? '' : '这个会话中没有可选择的其他接收人。';
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const state = view;
    if (!state || state.historyOnly || !isCurrent(state) || state.busy || !select.value || !state.selected.size) return;
    const body = {revision: state.meeting.revision, conversation_id: select.value, recipient_ids: [...state.selected].sort()};
    const fingerprint = JSON.stringify([state.path, body]);
    if (fingerprint !== attempt?.fingerprint) attempt = {fingerprint, key: key()};
    state.busy = true;
    syncForm(state);
    status.textContent = '正在分享…';
    const result = await call('POST', state.path, body, {'Idempotency-Key': attempt.key});
    if (!isCurrent(state)) return;
    state.busy = false;
    if (![200, 201].includes(result.status) || !result.body.meeting?.id) {
      status.textContent = result.status === 409 ? '纪要已更新。请关闭分享窗口，重新打开会议后再试。'
        : messageFor(result.body.error, '分享未确认，请重试。');
      syncForm(state);
      return;
    }
    attempt = null;
    state.selected.clear();
    for (const label of choices.children) label.children[0].checked = false;
    status.textContent = '已分享纪要。';
    syncForm(state);
    void loadSent(state);
  });
  close.addEventListener('click', () => { if (!view?.busy) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (view?.busy) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    view?.controller.abort();
    view?.recipientRequest?.abort();
    view = null;
  });
  return {sync() {
    trigger.hidden = !context();
    if (historyTrigger) historyTrigger.hidden = !historyWorkspace();
    if (dialog.open && !isCurrent(view)) dialog.close();
  }};
}

export function renderSharedMeeting(document, meeting) {
  const title = document.getElementById('shared-meeting-title');
  title.textContent = meeting.title;
  document.getElementById('shared-meeting-meta').textContent = [
    meeting.organizer ? '组织者 ' + meeting.organizer : '',
    formatTime(meeting.started_at), `版本 ${meeting.revision}`,
  ].filter(Boolean).join(' · ');
  document.getElementById('shared-meeting-summary').textContent = meeting.summary || '没有摘要。';
  const actions = meeting.action_items || [];
  const list = document.getElementById('shared-meeting-actions');
  list.replaceChildren();
  for (const item of actions) {
    const li = document.createElement('li');
    const text = document.createElement('p');
    text.textContent = item.text;
    const state = document.createElement('p');
    state.className = 'note';
    state.textContent = [item.owner ? '负责人 ' + item.owner : '', item.done ? '已完成' : '待完成']
      .filter(Boolean).join(' · ');
    li.append(text, state);
    list.append(li);
  }
  list.hidden = !actions.length;
  document.getElementById('shared-meeting-no-actions').hidden = Boolean(actions.length);
  document.getElementById('shared-meeting-detail').hidden = false;
  title.focus();
}

function mount() {
  const status = document.getElementById('status');
  const loginPanel = document.getElementById('login-panel');
  const mainPanel = document.getElementById('main-panel');
  const form = document.getElementById('meeting-form');
  const workspaceSelect = document.getElementById('workspace');
  const newButton = document.getElementById('new-meeting');
  const back = document.getElementById('meeting-library');
  const mobileBack = document.getElementById('meeting-back-to-list');
  const layout = document.getElementById('meeting-layout');
  const save = document.getElementById('save-meeting');
  const mobileSave = document.getElementById('save-meeting-mobile');
  const remove = document.getElementById('remove-meeting');
  const deleteDialog = document.getElementById('meeting-delete-dialog');
  const native = servedByDsBot(document);
  let workspaceLoad = 0;
  let viewer = '';
  if (!status || !loginPanel || !mainPanel || !form) return;
  let current = null;
  const sharedDetail = document.getElementById('shared-meeting-detail');
  const emptyDetail = document.getElementById('meeting-empty');
  const sharing = mountMeetingShares(document, {
    request,
    context: () => servedByDsBot(document) && current?.id && workspaceId()
      ? {workspace: workspaceId(), meeting: current} : null,
    historyWorkspace: () => servedByDsBot(document) && !document.getElementById('meeting-list-pane')?.hidden
      ? workspaceId() : '',
  });
  let meetings = [];
  let actions = [];
  let actionBoxes = [];
  let writing = null;
  let creation = null;
  let deleting = null;
  const attendeeInput = document.getElementById('meeting-attendees');
  const attendeeList = document.getElementById('attendee-matches');
  let memberCache = {workspace: '', items: [], failed: false};
  let attendeeActive = -1;
  let selection = 0;
  const titleInput = document.getElementById('meeting-title');
  const transcript = document.getElementById('meeting-transcript');
  const audio = mountMeetingAudio(document, {request, base, transcript});
  const summary = document.getElementById('meeting-summary');
  const draftPanel = document.getElementById('meeting-draft');
  const draftButton = document.getElementById('generate-meeting-draft');
  const draftStatus = document.getElementById('meeting-draft-status');
  let draft = null;
  let draftRequest = null;

  function show(kind, text) {
    status.dataset.kind = kind;
    status.textContent = text;
  }

  function workspaceId() {
    return workspaceSelect.value;
  }

  function base() {
    return `/v1/workspaces/${workspaceId()}/meetings`;
  }

  function scope() {
    return {workspace: workspaceId(), selection};
  }

  function active(target) {
    return workspaceId() === target.workspace && selection === target.selection;
  }

  function syncWriting() {
    const pending = writing && active(writing) ? writing : null;
    save.disabled = Boolean(pending);
    if (mobileSave) mobileSave.disabled = Boolean(pending);
    remove.disabled = Boolean(pending);
    const label = pending?.kind === 'save' ? '保存中…' : '保存';
    save.textContent = label;
    if (mobileSave) mobileSave.textContent = label;
    for (const box of actionBoxes) box.disabled = Boolean(pending);
  }

  function rewriteLocation(params) {
    if (globalThis.history?.replaceState && globalThis.location) {
      globalThis.history.replaceState(null, '', '#' + new URLSearchParams({workspace: workspaceId(), ...params}));
    }
  }

  function updateDraftButton() {
    draftButton.disabled = Boolean(draftRequest) || !transcript.value.trim();
  }

  function clearDraft() {
    draft = null;
    if (draftRequest) draftRequest.stale = true;
    draftPanel.hidden = true;
    draftStatus.textContent = draftRequest ? '上一条生成请求仍在处理。' : '';
    updateDraftButton();
  }

  for (const field of [titleInput, attendeeInput, transcript]) {
    field.addEventListener('input', clearDraft);
  }
  draftButton.addEventListener('click', async () => {
    if (draftButton.disabled || !workspaceId()) return;
    clearDraft();
    const target = {workspace: workspaceId(), transcript: transcript.value};
    draftRequest = target;
    updateDraftButton();
    draftStatus.textContent = 'DS-Bot 正在整理纪要…';
    try {
      const result = await request('POST', `${base()}/draft`, {
        title: titleInput.value.trim(), attendees: parseAttendees(attendeeInput.value), transcript: target.transcript,
      });
      if (target.stale || workspaceId() !== target.workspace) return;
      if (result.status !== 200 || !result.body.draft) {
        draftStatus.textContent = messageFor(result.body.error, '生成失败，请重试。');
        return;
      }
      draft = result.body.draft;
      document.getElementById('meeting-draft-summary').textContent = draft.summary;
      const items = document.getElementById('meeting-draft-items');
      items.replaceChildren(...draft.action_items.map(item => {
        const row = document.createElement('li');
        row.textContent = item.owner ? `${item.text}（${item.owner}）` : item.text;
        return row;
      }));
      items.hidden = !draft.action_items.length;
      draftPanel.hidden = false;
      draftStatus.textContent = '草稿已生成，请核对后采用。';
    } catch {
      if (!target.stale && workspaceId() === target.workspace) draftStatus.textContent = '连接失败，请重试。';
    } finally {
      if (draftRequest === target) {
        draftRequest = null;
        if (target.stale) draftStatus.textContent = '';
        updateDraftButton();
      }
    }
  });
  document.getElementById('discard-meeting-draft').addEventListener('click', clearDraft);
  document.getElementById('apply-meeting-draft').addEventListener('click', () => {
    if (!draft) return;
    const note = summary.value.trim();
    const next = note && !note.includes(draft.summary) ? note + '\n\n' + draft.summary : note || draft.summary;
    const keyOf = item => JSON.stringify([item.text.trim().toLowerCase(), (item.owner || '').trim().toLowerCase()]);
    const seen = new Set(actions.map(keyOf));
    const additions = [];
    for (const item of draft.action_items) {
      const key = keyOf(item);
      if (!seen.has(key)) additions.push({...item, done: false});
      seen.add(key);
    }
    if (next.length > summary.maxLength || actions.length + additions.length > 50) {
      draftStatus.textContent = '摘要或行动项已达上限。可先精简现有内容，再采用草稿。';
      return;
    }
    summary.value = next;
    actions.push(...additions);
    renderActions();
    clearDraft();
    draftStatus.textContent = '已填入摘要和行动项。确认后保存会议。';
  });

  function hideAttendees() {
    attendeeActive = -1;
    attendeeList.hidden = true;
    attendeeList.replaceChildren();
  }

  async function workspaceMembers() {
    const id = workspaceId();
    if (!id) return [];
    if (memberCache.workspace === id) return memberCache.items;
    const result = await request('GET', `/v1/workspaces/${id}/members`);
    memberCache = result.status === 200
      ? {workspace: id, items: result.body.items || [], failed: false}
      : {workspace: id, items: [], failed: true};
    return memberCache.items;
  }

  function attendeeOptions() {
    return [...attendeeList.querySelectorAll('button[data-username]')];
  }

  function highlightAttendee(index) {
    const options = attendeeOptions();
    if (!options.length) {
      attendeeActive = -1;
      return;
    }
    attendeeActive = (index + options.length) % options.length;
    options.forEach((option, at) => {
      option.setAttribute('aria-selected', at === attendeeActive ? 'true' : 'false');
    });
  }

  function chooseAttendee(username) {
    attendeeInput.value = attendeeInsert(attendeeInput.value, username);
    clearDraft();
    hideAttendees();
    attendeeInput.focus();
  }

  function attendeeNote(text) {
    const li = document.createElement('li');
    li.className = 'note';
    li.textContent = text;
    attendeeList.append(li);
  }

  async function refreshAttendees() {
    const query = attendeeQuery(attendeeInput.value);
    if (query.length < ATTENDEE_MIN) {
      hideAttendees();
      return;
    }
    const members = await workspaceMembers();
    if (attendeeQuery(attendeeInput.value) !== query) return;
    attendeeList.replaceChildren();
    if (memberCache.failed) {
      attendeeNote(ATTENDEE_UNAVAILABLE);
    } else {
      const matches = matchMembers(members, query, attendeeInput.value);
      if (!matches.length) attendeeNote(ATTENDEE_EMPTY);
      for (const member of matches) {
        const li = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.username = member.username;
        button.textContent = `${member.username} · ${MEMBER_ROLE_LABELS[member.role] || member.role}` +
          (member.suspended ? ' · 已停用' : '');
        button.addEventListener('click', () => chooseAttendee(member.username));
        li.append(button);
        attendeeList.append(li);
      }
    }
    attendeeActive = -1;
    attendeeList.hidden = false;
  }

  function renderActions() {
    const holder = document.getElementById('action-list');
    holder.replaceChildren();
    actionBoxes = [];
    actions.forEach((action, index) => {
      const row = document.createElement('div');
      row.className = 'action-row';
      const text = document.createElement('input');
      text.type = 'text';
      text.maxLength = 500;
      text.placeholder = '行动项';
      text.value = action.text || '';
      text.addEventListener('input', () => { action.text = text.value; });
      const owner = document.createElement('input');
      owner.type = 'text';
      owner.maxLength = 80;
      owner.placeholder = '负责人';
      owner.value = action.owner || '';
      owner.addEventListener('input', () => { action.owner = owner.value; });
      const done = document.createElement('label');
      done.className = 'action-done';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = Boolean(action.done);
      box.addEventListener('change', () => persistActionToggle(action, box));
      actionBoxes.push(box);
      done.append(box, document.createTextNode('完成'));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '删除';
      remove.addEventListener('click', () => {
        actions.splice(index, 1);
        renderActions();
      });
      row.append(text, owner, done, remove);
      holder.append(row);
    });
    syncWriting();
  }

  async function persistActionToggle(action, box) {
    const done = box.checked;
    if (writing && active(writing)) { box.checked = action.done; return; }
    action.done = done;
    if (!current?.id || action.savedIndex === undefined) {
      show('ok', '这条行动项的完成状态会在保存会议后生效。');
      return;
    }
    const target = {...scope(), kind: 'action'};
    writing = target;
    syncWriting();
    show('loading', '正在保存行动项…');
    const result = await request('POST', `${base()}/${current.id}`,
      actionToggleBody(current.action_items, action.savedIndex, done, current.revision)).catch(() => unavailable);
    if (writing === target) writing = null;
    if (!active(target)) return;
    if (result.status !== 200) {
      box.checked = !done;
      action.done = !done;
      renderActions();
      show('error', result.status === 409 ? '会议已在别处更新，请重新打开后再勾选。'
        : messageFor(result.body.error, '无法保存这条行动项的完成状态。'));
      return;
    }
    current = result.body.meeting;
    document.getElementById('meeting-meta').textContent =
      '修订 ' + current.revision + ' · 创建者 ' + current.created_by;
    meetings = meetings.map(item => item.id === current.id ? current : item);
    renderList();
    syncWriting();
    show('ok', done ? '已标记完成。' : '已取消完成。');
  }

  function renderList() {
    const list = document.getElementById('meeting-list');
    list.replaceChildren();
    document.getElementById('meetings-empty').hidden = meetings.length > 0;
    for (const meeting of meetings) {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'meeting-row';
      button.dataset.meeting = meeting.id;
      if (current && current.id === meeting.id) button.setAttribute('aria-current', 'true');
      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = meeting.title;
      const meta = document.createElement('span');
      meta.className = 'preview';
      meta.textContent = formatTime(meeting.started_at) + ' · ' + (meeting.attendees || []).length + ' 人 · ' +
        meeting.done_count + '/' + meeting.action_count + ' 行动项';
      button.append(title, meta);
      li.append(button);
      list.append(li);
    }
  }

  function setReceiptMode(receipt) {
    const pane = document.getElementById('meeting-list-pane');
    if (pane) pane.hidden = receipt;
    layout?.classList?.toggle('is-reading-receipt', receipt);
    if (layout && receipt) layout.dataset.view = 'receipt';
    if (!receipt && sharedDetail) sharedDetail.hidden = true;
    sharing.sync();
  }

  function fill(meeting) {
    selection += 1;
    creation = null;
    syncLibraryLink();
    audio.reset();
    hideAttendees();
    current = meeting;
    setReceiptMode(false);
    if (layout) layout.dataset.view = 'editor';
    form.hidden = false;
    form.inert = false;
    emptyDetail.hidden = true;
    document.getElementById('meeting-title').value = meeting ? meeting.title : '';
    document.getElementById('meeting-started-at').value = inputTime(meeting ? meeting.started_at : null);
    document.getElementById('meeting-attendees').value = meeting ? (meeting.attendees || []).join(', ') : '';
    document.getElementById('meeting-summary').value = meeting ? (meeting.summary || '') : '';
    document.getElementById('meeting-transcript').value = meeting ? (meeting.transcript || '') : '';
    clearDraft();
    actions = meeting ? (meeting.action_items || []).map((item, savedIndex) => ({...item, savedIndex})) : [];
    renderActions();
    document.getElementById('remove-meeting').hidden = !meeting || !meeting.id;
    const exportLink = document.getElementById('export-meeting');
    if (exportLink) {
      exportLink.hidden = !meeting || !meeting.id;
      exportLink.href = meeting && meeting.id ? `${base()}/${meeting.id}/export` : '#';
    }
    document.getElementById('meeting-meta').textContent = meeting && meeting.id
      ? '修订 ' + meeting.revision + ' · 创建者 ' + meeting.created_by : '新会议';
    renderList();
    rewriteLocation(meeting?.id ? {meeting: meeting.id} : {new: '1'});
  }

  function openCatalogue({focus = false} = {}) {
    selection += 1;
    creation = null;
    current = null;
    actions = [];
    setReceiptMode(false);
    audio.reset();
    clearDraft();
    hideAttendees();
    form.hidden = true;
    form.inert = false;
    emptyDetail.hidden = false;
    if (layout) layout.dataset.view = 'catalogue';
    renderList();
    rewriteLocation();
    syncWriting();
    if (focus) {
      document.getElementById('main').scrollTop = 0;
      newButton.focus?.({preventScroll: true});
    }
  }

  async function loadList({keepEditor = false} = {}) {
    const workspace = workspaceId(), pendingSelection = selection;
    const result = await request('GET', `${base()}?limit=100`).catch(() => ({status: 0, body: {}}));
    if (workspaceId() !== workspace || pendingSelection !== selection) return;
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法加载会议。'));
      return;
    }
    meetings = result.body.items || [];
    renderList();
    if (keepEditor) return;
    if (globalThis.matchMedia?.('(max-width: 700px)').matches) {
      openCatalogue();
      return;
    }
    if (meetings.length && !current) await openMeeting(meetings[0].id);
    else fill(null);
  }

  async function openMeeting(id, read) {
    const workspace = workspaceId(), pendingSelection = ++selection;
    audio.reset();
    clearDraft();
    if (!read) {
      form.inert = true;
      show('loading', '正在打开会议…');
    }
    const result = read || await request('GET', `${base()}/${id}`).catch(() => unavailable);
    if (workspaceId() !== workspace || pendingSelection !== selection) return;
    form.inert = false;
    if (result.status !== 200 || (native && result.body.viewer_username !== viewer) ||
        result.body.meeting?.id !== id || result.body.meeting.workspace_id !== workspace) {
      syncWriting();
      show('error', messageFor(result.body.error, '无法打开会议。'));
      return;
    }
    fill(result.body.meeting);
    if (globalThis.matchMedia?.('(max-width: 700px)').matches) {
      document.getElementById('main').scrollTop = 0;
      document.getElementById('meeting-editor-pane')?.focus({preventScroll: true});
    }
    show('', '');
  }

  async function openSharedMeeting(id, read) {
    const workspace = workspaceId(), pendingSelection = ++selection;
    current = null;
    sharing.sync();
    audio.reset();
    clearDraft();
    hideAttendees();
    form.hidden = true;
    setReceiptMode(true);
    sharedDetail.hidden = true;
    emptyDetail.hidden = true;
    show('', '正在加载共享纪要…');
    const result = read || await request('GET', `${base()}/shared/${id}`).catch(() => unavailable);
    if (workspaceId() !== workspace || pendingSelection !== selection) return;
    const meeting = result.body.meeting;
    if (result.status !== 200 || (native && result.body.viewer_username !== viewer) ||
        meeting?.id !== id || meeting.shared !== true) {
      show('error', result.status === 404 ? '这份共享纪要已撤回或你没有查看权限。' : '无法打开共享纪要，请重试。');
      return;
    }
    renderSharedMeeting(document, meeting);
    show('', '');
  }

  function syncLibraryLink() {
    if (back) back.href = '/space?view=meetings' + (workspaceId() ? '#workspace=' + encodeURIComponent(workspaceId()) : '');
    newButton.disabled = !workspaceId();
    sharing.sync();
  }

  function fillWorkspaces(items, selected) {
    workspaceSelect.replaceChildren();
    for (const space of items) {
      const option = document.createElement('option');
      option.value = space.id;
      option.textContent = space.name;
      workspaceSelect.append(option);
    }
    if (items.some(item => item.id === selected)) workspaceSelect.value = selected;
  }

  async function load() {
    const seq = ++workspaceLoad;
    const linked = new URLSearchParams((globalThis.location?.hash || '').slice(1));
    const linkedWorkspace = linked.get('workspace');
    const meetingId = linked.get('meeting') || '';
    const shareId = linked.get('shared') || '';
    const exact = meetingIdPattern.test(linkedWorkspace)
      && (linked.has('shared') ? !meetingId && meetingIdPattern.test(shareId) : meetingIdPattern.test(meetingId));
    const eagerDetail = native && exact
      ? request('GET', `/v1/workspaces/${linkedWorkspace}/meetings/${shareId ? 'shared/' + shareId : meetingId}`)
        .catch(() => unavailable) : null;
    newButton.disabled = true;
    const session = await request('GET', '/v1/auth/session').catch(() => unavailable);
    if (seq !== workspaceLoad) return;
    if (session.status !== 200) {
      current = null;
      viewer = '';
      sharing.sync();
      if (sharedDetail) sharedDetail.hidden = true;
      audio.reset();
      loginPanel.hidden = false;
      mainPanel.hidden = true;
      show('', '');
      return;
    }
    loginPanel.hidden = true;
    mainPanel.hidden = false;
    viewer = session.body.user.username;
    document.getElementById('whoami').textContent = viewer;
    const directory = readWorkspaceChoices(request, '/v1/workspaces?limit=100');
    const detail = eagerDetail ? await eagerDetail : null;
    if (seq !== workspaceLoad) return;
    const viewerMatches = detail?.status !== 200 || detail.body.viewer_username === viewer;
    const verified = detail?.status === 200 && viewerMatches && (shareId
      ? detail.body.meeting?.id === shareId && detail.body.meeting.shared === true
      : detail.body.meeting?.id === meetingId && detail.body.meeting.workspace_id === linkedWorkspace);
    if (verified) {
      fillWorkspaces([{id: linkedWorkspace, name: '当前工作区'}], linkedWorkspace);
      syncLibraryLink();
      if (shareId) void openSharedMeeting(shareId, detail);
      else {
        void openMeeting(meetingId, detail);
        void loadList({keepEditor: true});
      }
    }
    let {initial: listed, supplemental} = await directory;
    if (seq !== workspaceLoad) return;
    if (linkedWorkspace && !listed.body.items?.some(item => item.id === linkedWorkspace) && supplemental) {
      const shared = await supplemental;
      if (shared.status === 200) listed = shared;
      supplemental = null;
    }
    if (seq !== workspaceLoad) return;
    const workspaces = listed.status === 200 ? (listed.body.items || []) : [];
    const withVerified = items => verified && !items.some(item => item.id === linkedWorkspace)
      ? [{id: linkedWorkspace, name: '当前工作区'}, ...items] : items;
    fillWorkspaces(withVerified(workspaces), verified ? workspaceId() : linkedWorkspace || workspaceId());
    void supplemental?.then(shared => {
      if (seq === workspaceLoad && shared.status === 200) fillWorkspaces(withVerified(shared.body.items || []), workspaceId());
    });
    if (verified) return;
    if (linkedWorkspace && !workspaces.some(item => item.id === linkedWorkspace)) {
      workspaceSelect.value = '';
      syncLibraryLink();
      form.hidden = true;
      show('error', '无法打开此工作区的会议。请选择其他工作区。');
      return;
    }
    syncLibraryLink();
    if (!workspaces.length) {
      form.hidden = true;
      document.getElementById('meeting-empty').hidden = false;
      document.getElementById('meetings-empty').hidden = false;
      show('error', listed.status === 200 ? '还没有工作区。请先到聊天页创建。' : '无法读取工作区，请刷新重试。');
      return;
    }
    if (linked.has('shared')) {
      if (workspaceId() === linkedWorkspace && meetingIdPattern.test(shareId) && !meetingId) {
        await openSharedMeeting(shareId, viewerMatches && detail);
      } else {
        form.hidden = true;
        if (sharedDetail) sharedDetail.hidden = true;
        show('error', '共享纪要链接无效。');
      }
    } else if (workspaceId() === linkedWorkspace && meetingIdPattern.test(meetingId)) {
      await Promise.all([openMeeting(meetingId, viewerMatches && detail), loadList({keepEditor: true})]);
    } else if (linked.get('new') === '1') {
      fill(null);
      if (linked.get('from') === 'chat') {
        let source;
        try { source = takeMeetingFromChat(document.defaultView.sessionStorage, session.body.user.id, workspaceId()); } catch {}
        if (source) {
          titleInput.value = source.title;
          transcript.value = source.transcript;
          updateDraftButton();
          show('ok', '已填入所选聊天消息。可编辑正文，再生成纪要。');
        } else {
          show('error', '无法读取聊天草稿。你可以粘贴会议正文。');
        }
      }
      await loadList({keepEditor: true});
    } else {
      await loadList();
    }
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (form.hidden) return;
    const title = document.getElementById('meeting-title').value.trim();
    const started = document.getElementById('meeting-started-at').value;
    const startedAt = Math.floor(new Date(started).getTime() / 1000);
    if (!title) { show('error', '请填写标题。'); return; }
    if (!Number.isFinite(startedAt)) { show('error', '请选择开始时间。'); return; }
    const changes = {
      title,
      started_at: startedAt,
      attendees: parseAttendees(document.getElementById('meeting-attendees').value),
      summary: document.getElementById('meeting-summary').value,
      transcript: document.getElementById('meeting-transcript').value,
      action_items: actions.filter(action => (action.text || '').trim())
        .map(({text, owner, done}) => ({text, owner, done})),
    };
    if (!workspaceId() || save.disabled) return;
    const target = current, operation = {...scope(), kind: 'save'};
    writing = operation;
    syncWriting();
    show('loading', '正在保存…');
    let result;
    try {
      if (target?.id) {
        result = await request('POST', `${base()}/${target.id}`, {revision: target.revision, changes});
      } else {
        const contents = JSON.stringify(changes);
        if (creation?.contents !== contents) creation = {contents, key: meetingKey('meeting-')};
        result = await request('POST', base(), changes, {'Idempotency-Key': creation.key});
      }
    } catch {
      result = {status: 0, body: {}};
    } finally {
      if (writing === operation) writing = null;
    }
    if (!active(operation)) return;
    syncWriting();
    if (result.status === 409) {
      show('error', '会议已在别处更新，或标题已被占用。');
      return;
    }
    if (result.status !== 200 && result.status !== 201) {
      show('error', messageFor(result.body.error, '保存失败。'));
      return;
    }
    const meeting = result.body.meeting;
    selection += 1;
    meetings = [meeting, ...meetings.filter(item => item.id !== meeting.id)];
    fill(meeting);
    show('ok', '会议已保存。');
    void loadList({keepEditor: true});
  });

  attendeeInput.addEventListener('input', () => { refreshAttendees(); });

  attendeeInput.addEventListener('keydown', event => {
    if (attendeeList.hidden && event.key !== 'Escape') return;
    const options = attendeeOptions();
    if (event.key === 'ArrowDown' && options.length) {
      event.preventDefault();
      highlightAttendee(attendeeActive + 1);
    } else if (event.key === 'ArrowUp' && options.length) {
      event.preventDefault();
      highlightAttendee(attendeeActive - 1);
    } else if (event.key === 'Enter' && options.length) {
      event.preventDefault();
      chooseAttendee(options[attendeeActive >= 0 ? attendeeActive : 0].dataset.username);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      hideAttendees();
    }
  });

  newButton.addEventListener('click', () => {
    if (!workspaceId()) return;
    selection += 1;
    fill(null);
    show('', '');
    document.getElementById('main').scrollTop = 0;
    document.getElementById('meeting-title').focus?.();
  });

  document.getElementById('add-action').addEventListener('click', () => {
    if (actions.length >= 50) return;
    actions.push({text: '', owner: '', done: false});
    renderActions();
  });

  document.getElementById('cancel-meeting').addEventListener('click', () => {
    if (globalThis.matchMedia?.('(max-width: 700px)').matches) {
      openCatalogue({focus: true});
      show('', '');
    } else fill(current);
  });

  mobileBack?.addEventListener('click', () => {
    openCatalogue({focus: true});
    void loadList({keepEditor: true});
    show('', '');
  });

  remove.addEventListener('click', () => {
    if (!current?.id || remove.disabled) return;
    deleting = {...scope(), id: current.id};
    document.getElementById('meeting-delete-target').textContent = current.title;
    deleteDialog.showModal();
  });
  document.getElementById('cancel-remove-meeting')?.addEventListener('click', () => deleteDialog.close());
  document.getElementById('confirm-remove-meeting')?.addEventListener('click', async () => {
    const target = deleting;
    deleteDialog.close();
    if (!target || !active(target) || current?.id !== target.id || remove.disabled) return;
    const operation = {...target, kind: 'delete'};
    writing = operation;
    syncWriting();
    show('loading', '正在删除会议…');
    const result = await request('POST', `${base()}/${target.id}/remove`, {}).catch(() => unavailable);
    if (writing === operation) writing = null;
    if (!active(operation)) return;
    syncWriting();
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '删除失败。'));
      return;
    }
    meetings = meetings.filter(item => item.id !== target.id);
    openCatalogue({focus: true});
    show('ok', '会议已删除。');
  });

  document.getElementById('meeting-list').addEventListener('click', async event => {
    const button = event.target.closest('button[data-meeting]');
    if (button) await openMeeting(button.dataset.meeting);
  });

  workspaceSelect.addEventListener('change', () => {
    selection += 1;
    syncLibraryLink();
    audio.reset();
    clearDraft();
    hideAttendees();
    memberCache = {workspace: '', items: [], failed: false};
    meetings = [];
    openCatalogue();
    if (workspaceId()) void loadList();
  });

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

  load();
}

if (typeof document !== 'undefined' && document.getElementById('meeting-form')) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
}
