import {conversationChatHref} from '../shell/thumb.mjs';

const byId = id => document.getElementById(id);
const root = '/v1/contacts';
const list = byId('contacts-list');
const state = byId('contacts-state');
const retry = byId('reload-contacts');
const search = byId('contact-search');
const tabs = [...document.querySelectorAll('[data-section]')];
const dialog = byId('add-contact-dialog');
const handleField = byId('contact-handle');
const lookupState = byId('lookup-state');
const lookupResult = byId('lookup-result');
const lookupButton = byId('lookup-contact');
const sendRequest = byId('request-contact');

let section = 'accepted';
let workspace = '';
let records = [];
let loaded = false;
let loading = false;
let failed = false;
let located = null;
let lookupSequence = 0;
let submitting = false;
let version = 0;
let confirmRemove = '';
const busy = new Set();

async function request(path, body) {
  const headers = {Accept: 'application/json'};
  const method = body === undefined ? 'GET' : 'POST';
  if (body !== undefined) {
    const token = /(?:^|;\s*)(?:__Host-ot_csrf|ot_dev_csrf)=([^;]+)/.exec(document.cookie)?.[1];
    headers['Content-Type'] = 'application/json';
    headers['X-CSRF-Token'] = decodeURIComponent(token || '');
  }
  const response = await fetch(path, {method, headers, credentials: 'same-origin', body: JSON.stringify(body)});
  if (response.status === 401) {
    location.assign('/login');
    throw new Error('请先登录。');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = response.status === 404 && path.startsWith(root + '/lookup')
      ? '没有找到这个用户名。' : data.error?.message;
    throw new Error(message || '暂时无法完成操作，请重试。');
  }
  return data;
}

function notify(message, error = false) {
  const status = byId('status');
  status.dataset.kind = error ? 'error' : 'ok';
  status.textContent = message;
}

function replaceRecord(item) {
  ++version;
  records = records.filter(row => row.id !== item.id);
  if (item.status === 'accepted' || item.status === 'pending') records.unshift(item);
}

function avatarText(peer) {
  return [...(peer.display_name || peer.handle || '?')][0].toUpperCase();
}

function updateTabs() {
  for (const tab of tabs) tab.setAttribute('aria-pressed', String(tab.dataset.section === section));
  const count = records.filter(row => row.status === 'pending' && row.incoming).length;
  const badge = byId('request-count');
  badge.textContent = count ? String(count) : '';
  badge.hidden = count === 0;
}

function render() {
  updateTabs();
  byId('contacts-results').setAttribute('aria-busy', String(loading));
  retry.hidden = !failed;
  const query = search.value.trim().replace(/^@/, '').toLocaleLowerCase();
  const visible = records.filter(row => row.status === section &&
    [row.peer.display_name, row.peer.handle].some(value => value?.toLocaleLowerCase().includes(query)));
  state.textContent = !loaded && loading ? '正在加载联系人…'
    : failed ? '联系人加载失败。'
      : visible.length ? '' : query ? '没有匹配的联系人。'
        : section === 'pending' ? '暂无联系人申请。' : '暂无联系人。';

  list.replaceChildren(...visible.map(row => {
    const item = document.createElement('li');
    item.className = 'contact-person';
    const avatar = document.createElement('span');
    avatar.className = 'contact-avatar';
    avatar.setAttribute('aria-hidden','true');
    avatar.textContent = avatarText(row.peer);
    const info = document.createElement('div');
    info.className = 'contact-info';
    const name = document.createElement('strong');
    name.textContent = row.peer.display_name || row.peer.handle;
    const handle = document.createElement('span');
    handle.textContent = '@' + row.peer.handle;
    info.append(name, handle);
    const actions = document.createElement('div');
    actions.className = 'contact-actions';
    const button = (label, callback, secondary = false) => {
      const element = document.createElement('button');
      element.type = 'button';
      element.textContent = label;
      element.disabled = busy.has(row.id);
      if (secondary) element.className = 'secondary';
      element.addEventListener('click', callback);
      actions.append(element);
    };
    if (row.status === 'accepted') {
      if (confirmRemove === row.id) {
        button('确认移除', () => void change(row, 'remove'));
        button('取消', () => { confirmRemove = ''; render(); }, true);
      } else {
        button('聊天', () => void chat(row));
        button('移除', () => { confirmRemove = row.id; render(); }, true);
      }
    } else if (row.incoming) {
      button('接受', () => void change(row, 'accept'));
      button('拒绝', () => void change(row, 'decline'), true);
    } else {
      handle.textContent += ' · 等待确认';
      button('撤回', () => void change(row, 'cancel'), true);
    }
    item.append(avatar, info, actions);
    return item;
  }));
}

async function load() {
  if (loading) return;
  loading = true;
  failed = false;
  if (!loaded) render();
  const started = version;
  try {
    const data = await request(root);
    workspace = data.workspace_id || '';
    if (started === version) records = data.items || [];
    loaded = true;
  } catch {
    failed = true;
  } finally {
    loading = false;
    render();
  }
}

async function change(row, action) {
  if (busy.has(row.id)) return;
  busy.add(row.id);
  render();
  try {
    replaceRecord(await request(root + '/' + encodeURIComponent(row.id), {action}));
    confirmRemove = '';
    if (action === 'accept') section = 'accepted';
    notify({accept:'已添加联系人。',decline:'已拒绝申请。',remove:'已移除联系人。',cancel:'已撤回申请。'}[action]);
  } catch (error) {
    notify(error.message, true);
    void load();
  } finally {
    busy.delete(row.id);
    render();
  }
}

async function chat(row) {
  if (busy.has(row.id)) return;
  if (!/^[0-9a-f]{32}$/.test(workspace)) {
    notify('个人工作区正在准备，请稍后重试。', true);
    void load();
    return;
  }
  busy.add(row.id);
  render();
  try {
    const data = await request('/v1/workspaces/' + workspace + '/social/conversations', {kind:'dm', member_ids:[row.peer.handle]});
    location.assign(conversationChatHref(workspace, {...data.conversation, source:'social'}));
  } catch (error) {
    notify(error.message, true);
    busy.delete(row.id);
    render();
  }
}

function clearLookup() {
  ++lookupSequence;
  located = null;
  lookupResult.hidden = true;
  lookupState.textContent = '';
  lookupButton.disabled = false;
}

byId('add-contact').addEventListener('click', () => {
  byId('contact-lookup-form').reset();
  clearLookup();
  dialog.showModal();
  handleField.focus();
});
byId('close-add-contact').addEventListener('click', () => dialog.close());
handleField.addEventListener('input', clearLookup);
byId('contact-lookup-form').addEventListener('submit', async event => {
  event.preventDefault();
  clearLookup();
  const sequence = lookupSequence;
  lookupButton.disabled = true;
  lookupState.textContent = '正在查找…';
  try {
    const {peer} = await request(root + '/lookup?' + new URLSearchParams({handle:handleField.value.trim()}));
    if (sequence !== lookupSequence || !dialog.open) return;
    located = peer;
    lookupState.textContent = '';
    byId('lookup-avatar').textContent = avatarText(peer);
    byId('lookup-name').textContent = peer.display_name || peer.handle;
    byId('lookup-handle').textContent = '@' + peer.handle;
    lookupResult.hidden = false;
  } catch (error) {
    if (sequence === lookupSequence) lookupState.textContent = error.message;
  } finally {
    if (sequence === lookupSequence) lookupButton.disabled = false;
  }
});
sendRequest.addEventListener('click', async () => {
  if (!located || submitting) return;
  submitting = true;
  sendRequest.disabled = true;
  try {
    const item = await request(root, {handle:located.handle});
    replaceRecord(item);
    section = item.status;
    search.value = '';
    dialog.close();
    notify(item.status === 'accepted' ? '已经是联系人。' : item.incoming ? '对方已发来申请。' : '已发送申请。');
    render();
  } catch (error) {
    lookupState.textContent = error.message;
  } finally {
    submitting = false;
    sendRequest.disabled = false;
  }
});
for (const tab of tabs) tab.addEventListener('click', () => {
  section = tab.dataset.section;
  confirmRemove = '';
  render();
  if (section === 'pending') void load();
});
search.addEventListener('input', render);
retry.addEventListener('click', () => void load());
byId('logout-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await request('/v1/auth/logout', {});
    location.assign('/login');
  } catch (error) {
    notify(error.message, true);
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void load();
});
void load();
void request('/v1/auth/session').then(data => {
  byId('whoami').textContent = data.user?.username || '';
}).catch(() => {});
