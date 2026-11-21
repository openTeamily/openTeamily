import {mountMeetingAudio} from './audio.mjs';
import {readWorkspaceChoices} from '../shell/dsbot-api.mjs';
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

function mount() {
  const status = document.getElementById('status');
  const loginPanel = document.getElementById('login-panel');
  const mainPanel = document.getElementById('main-panel');
  const form = document.getElementById('meeting-form');
  const workspaceSelect = document.getElementById('workspace');
  const newButton = document.getElementById('new-meeting');
  const back = document.getElementById('meeting-library');
  let workspaceLoad = 0;
  if (!status || !loginPanel || !mainPanel || !form) return;
  let current = null;
  let meetings = [];
  let actions = [];
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
      box.addEventListener('change', () => {
        action.done = box.checked;
        persistActionToggle(index, box.checked, box);
      });
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
  }


  async function persistActionToggle(index, done, box) {
    if (!current || !current.id) {
      show('ok', '这条行动项的完成状态会在保存会议后生效。');
      return;
    }
    const result = await request('POST', `${base()}/${current.id}`,
      actionToggleBody(actions, index, done, current.revision));
    if (result.status === 409) {
      box.checked = !done;
      actions[index].done = !done;
      show('error', '会议已在别处更新，请重新打开后再勾选。');
      return;
    }
    if (result.status !== 200) {
      box.checked = !done;
      actions[index].done = !done;
      show('error', messageFor(result.body.error, '无法保存这条行动项的完成状态。'));
      return;
    }
    const saved = result.body.meeting;
    current = {...current, revision: saved.revision, done_count: saved.done_count,
               action_count: saved.action_count};
    document.getElementById('meeting-meta').textContent =
      '修订 ' + current.revision + ' · 创建者 ' + current.created_by;
    // Refresh the list counts without reloading the form: unsaved body edits stay put.
    const listed = await request('GET', `${base()}?limit=100`);
    if (listed.status === 200) {
      meetings = listed.body.items || [];
      renderList();
    }
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

  function fill(meeting) {
    selection += 1;
    syncLibraryLink();
    audio.reset();
    hideAttendees();
    current = meeting;
    form.hidden = false;
    document.getElementById('meeting-empty').hidden = true;
    document.getElementById('meeting-title').value = meeting ? meeting.title : '';
    document.getElementById('meeting-started-at').value = inputTime(meeting ? meeting.started_at : null);
    document.getElementById('meeting-attendees').value = meeting ? (meeting.attendees || []).join(', ') : '';
    document.getElementById('meeting-summary').value = meeting ? (meeting.summary || '') : '';
    document.getElementById('meeting-transcript').value = meeting ? (meeting.transcript || '') : '';
    clearDraft();
    actions = meeting ? (meeting.action_items || []).map(item => ({...item})) : [];
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
    if (globalThis.history?.replaceState && globalThis.location) {
      const fragment = new URLSearchParams({workspace: workspaceId()});
      if (meeting?.id) fragment.set('meeting', meeting.id);
      else fragment.set('new', '1');
      globalThis.history.replaceState(null, '', '#' + fragment);
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
    if (meetings.length && !current) await openMeeting(meetings[0].id);
    else fill(null);
  }

  async function openMeeting(id) {
    const workspace = workspaceId(), pendingSelection = ++selection;
    audio.reset();
    clearDraft();
    const result = await request('GET', `${base()}/${id}`);
    if (workspaceId() !== workspace || pendingSelection !== selection) return;
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法打开会议。'));
      return;
    }
    fill(result.body.meeting);
  }

  function syncLibraryLink() {
    if (back) back.href = '/space?view=meetings' + (workspaceId() ? '#workspace=' + encodeURIComponent(workspaceId()) : '');
    newButton.disabled = !workspaceId();
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
    newButton.disabled = true;
    const session = await request('GET', '/v1/auth/session');
    if (seq !== workspaceLoad) return;
    if (session.status !== 200) {
      audio.reset();
      loginPanel.hidden = false;
      mainPanel.hidden = true;
      show('', '');
      return;
    }
    loginPanel.hidden = true;
    mainPanel.hidden = false;
    document.getElementById('whoami').textContent = session.body.user.username;
    const linked = new URLSearchParams((globalThis.location?.hash || '').slice(1));
    const linkedWorkspace = linked.get('workspace');
    let {initial: listed, supplemental} = await readWorkspaceChoices(request, '/v1/workspaces?limit=100');
    if (linkedWorkspace && !listed.body.items?.some(item => item.id === linkedWorkspace) && supplemental) {
      const shared = await supplemental;
      if (shared.status === 200) listed = shared;
      supplemental = null;
    }
    if (seq !== workspaceLoad) return;
    const workspaces = listed.status === 200 ? (listed.body.items || []) : [];
    fillWorkspaces(workspaces, linkedWorkspace || workspaceId());
    void supplemental?.then(shared => {
      if (seq === workspaceLoad && shared.status === 200) fillWorkspaces(shared.body.items, workspaceId());
    });
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
    const meetingId = linked.get('meeting') || '';
    if (workspaceId() === linkedWorkspace && /^[0-9a-f]{32}$/.test(meetingId)) {
      await Promise.all([openMeeting(meetingId), loadList({keepEditor: true})]);
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
      action_items: actions.filter(action => (action.text || '').trim()),
    };
    const save = document.getElementById('save-meeting');
    if (!workspaceId() || save.disabled) return;
    const target = current, workspace = workspaceId(), seq = selection;
    save.disabled = true;
    show('', '正在保存…');
    let result;
    try {
      if (target?.id) {
        result = await request('POST', `${base()}/${target.id}`, {revision: target.revision, changes});
      } else {
        const key = 'meeting-' + (globalThis.crypto?.randomUUID ? crypto.randomUUID().replace(/-/g, '') : String(Date.now()));
        result = await request('POST', base(), changes, {'Idempotency-Key': key});
      }
    } catch {
      result = {status: 0, body: {}};
    } finally {
      save.disabled = false;
    }
    if (workspaceId() !== workspace || seq !== selection) return;
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
    document.getElementById('meeting-title').focus?.();
  });

  document.getElementById('add-action').addEventListener('click', () => {
    if (actions.length >= 50) return;
    actions.push({text: '', owner: '', done: false});
    renderActions();
  });

  document.getElementById('cancel-meeting').addEventListener('click', () => {
    fill(current);
  });

  document.getElementById('remove-meeting').addEventListener('click', async () => {
    if (!current || !current.id) return;
    const result = await request('POST', `${base()}/${current.id}/remove`, {});
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '删除失败。'));
      return;
    }
    current = null;
    await loadList();
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
    current = null;
    actions = [];
    form.hidden = true;
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
