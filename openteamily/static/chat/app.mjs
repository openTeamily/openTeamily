import { decodeVoice, mountVoiceRecorder } from './voice.mjs';
import { mountAgentMentions } from './mentions.mjs';
import { mountWorkspaceEvents } from '../shell/workspace-events.mjs';
import { mountMessageUtilities, renderMessageText } from './utilities.mjs';
export const SEARCH_JUMP_HIGHLIGHT_MS = 2400;
import { csrfCookie, canManage, idempotencyKey, statusLabel } from '../agents/app.mjs';
import { conversationLabel, memberChoices, validMessage } from '../messenger/app.mjs';
import { createLookAvatar } from '../look/app.mjs';
import { dsbotServed, dsbotRoute, dsbotRequest } from './dsbot.mjs';

export const SEARCH_TABS = [
  ['all', '全部'],
  ['artifacts', 'Artifacts'],
  ['contacts', '联系人'],
  ['groups', '群组'],
  ['agents', '智能体'],
  ['messages', '消息'],
  ['files', '文件'],
  ['documents', '云文档'],
  ['media', '媒体'],
  ['links', '链接'],
];

export function sessionPreview(row, fallback) {
  const text = typeof row.preview === 'string' ? row.preview.trim() : '';
  return text || fallback || '';
}

export function mergeSessions(agentRows, socialRows, currentUserId) {
  const sessions = [];
  for (const row of agentRows || []) {
    sessions.push({
      source: 'agent',
      id: row.id,
      agent_id: row.agent_id || (row.agent && row.agent.id),
      agent: row.agent,
      kind: 'agent',
      title: (row.agent && row.agent.name) || row.title || '对话',
      preview: sessionPreview(row, row.title || ''),
      unread_count: Number(row.unread_count) || 0,
      updated: row.updated || 0,
    });
  }
  for (const row of socialRows || []) {
    sessions.push({
      source: 'social',
      id: row.id,
      unread_count: Number(row.unread_count) || 0,
      pinned: Boolean(row.pinned),
      muted: Boolean(row.muted),
      kind: row.kind,
      members: row.members,
      title: conversationLabel(row, currentUserId),
      preview: sessionPreview(row, row.kind === 'group'
        ? '群聊 · ' + ((row.members || []).length) + ' 人'
        : '单聊 · ' + ((row.members || []).length) + ' 人'),
      updated: row.updated || 0,
    });
  }
  sessions.sort((left, right) => Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) || (right.updated || 0) - (left.updated || 0));
  return sessions;
}


export function shouldSendOnShortcut(event, sendShortcut = 'enter') {
  if (!event || event.key !== 'Enter') return false;
  if (event.isComposing || event.keyCode === 229) return false;
  const modifier = Boolean(event.ctrlKey || event.metaKey);
  if (sendShortcut === 'mod_enter') return modifier && !event.shiftKey && !event.altKey;
  return !modifier && !event.shiftKey && !event.altKey;
}

// The chat language is stored per account by /settings; it only reaches the
// model if the message request carries it. 'auto' means "no opinion", so the
// field has to be absent rather than a value the server has to interpret.
export function messagePayload(text, chatLanguage = 'auto') {
  const payload = {body: text};
  if (typeof chatLanguage === 'string' && chatLanguage && chatLanguage !== 'auto') {
    payload.chat_language = chatLanguage;
  }
  return payload;
}

export function messageSearchQuery(query, conversationId = '', cursor = '') {
  const params = new URLSearchParams({q: query, limit: '20'});
  if (conversationId) params.set('conversation_id', conversationId);
  if (cursor) params.set('cursor', cursor);
  return params.toString();
}

export function homepageStartIndex(search) {
  const source = search === undefined
    ? ((typeof location !== 'undefined' && location.search) || '')
    : search;
  const params = new URLSearchParams(String(source).startsWith('?') ? String(source).slice(1) : source);
  const raw = params.get('start');
  if (!/^(0|[1-4])$/.test(raw || '')) return null;
  return Number(raw);
}

export function stripHomepageStartQuery(pathname, search, hash) {
  const params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  if (!params.has('start')) {
    return {changed: false, href: (pathname || '') + (search || '') + (hash || '')};
  }
  params.delete('start');
  const next = params.toString();
  const href = (pathname || '') + (next ? '?' + next : '') + (hash || '');
  return {changed: true, href};
}

function searchHitKey(hit) {
  return [hit.kind || '', hit.conversationId || '', hit.messageId || hit.id || '', hit.preview || '']
    .join('\u0000');
}

export function searchHitFromItem(item) {
  return {
    type: item.kind === 'social' ? 'social' : 'agent-message',
    id: item.conversation_id,
    messageId: item.message_id || '',
    title: item.title || '消息',
    preview: item.snippet || '',
    conversationId: item.conversation_id,
    kind: item.kind,
  };
}

export function mergeSearchHits(existing, incoming) {
  const merged = [];
  const seen = new Set();
  for (const hit of [...(existing || []), ...(incoming || [])]) {
    const key = searchHitKey(hit);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(hit);
  }
  return merged;
}

// The server pages message hits by keyset cursor. This controller keeps the
// rows already shown and appends the next page, so a failed or repeated page
// never drops what the user is already reading.
export function createMessageSearch(loadPage) {
  const state = {hits: [], cursor: '', loading: false, error: ''};
  let generation = 0;
  let pending = null;
  let activeKey = '';
  async function load(query, conversationId = '', {append = false} = {}) {
    const text = String(query || '').trim();
    const key = JSON.stringify([text, conversationId]);
    if (!text) {
      generation += 1;
      activeKey = '';
      pending = null;
      Object.assign(state, {hits: [], cursor: '', error: '', loading: false});
      return state;
    }
    // A tab switch during the same search must await the existing request,
    // not render its temporary empty state and invalidate the completing view.
    if (state.loading && key === activeKey) return pending;
    if (append && state.loading) return state;
    const token = ++generation;
    activeKey = key;
    if (!append) {
      state.hits = [];
      state.cursor = '';
    }
    state.loading = true;
    pending = (async () => {
      try {
        const page = await loadPage(text, conversationId, append ? state.cursor : '');
        if (token !== generation) return state;
        const incoming = ((page && page.items) || []).map(searchHitFromItem);
        state.hits = mergeSearchHits(append ? state.hits : [], incoming);
        state.cursor = (page && page.cursor) || '';
        state.error = '';
      } catch (failure) {
        if (token !== generation) return state;
        state.error = (failure && failure.message) || '无法搜索消息。';
        if (!append) {
          state.hits = [];
          state.cursor = '';
        }
      } finally {
        if (token === generation) state.loading = false;
      }
      return state;
    })();
    return pending;
  }
  return {state, load};
}

export function searchMoreVisible(state) {
  return Boolean(state && state.cursor && !state.loading);
}

export function applySearchMore(node, state) {
  if (!node) return;
  node.hidden = !searchMoreVisible(state);
  node.disabled = Boolean(state && state.loading);
}

export const GROUP_CREATE_INTRO = '添加名称，然后邀请好友并添加 AI 智能体。';
export const GROUP_CREATE_MODES = [
  ['custom', '自定义群组'],
  ['team', 'AI 智能体团队'],
];

export function composeSelectedLabel(count) {
  return '已选 ' + Number(count || 0);
}

export function filterMemberChoices(members, currentUserId, query) {
  const needle = String(query || '').trim().toLocaleLowerCase();
  const list = memberChoices(members, currentUserId);
  if (!needle) return list;
  return list.filter(member => String(member.username || '').toLocaleLowerCase().includes(needle));
}

export function groupPickerChoices(members, currentUserId, agents = []) {
  return [
    ...memberChoices(members, currentUserId).map(member => ({
      id: member.user_id, kind: 'human', label: member.username + ' · 成员',
    })),
    ...agents.filter(agent => !agent.archived).map(agent => ({
      id: agent.id, kind: 'agent', label: agent.name + ' · AI 智能体（自动回复未接通）',
    })),
  ];
}

export function leadGlyph(text, fallback = '?') {
  const cleaned = String(text || '').replace(/^\s*\[[^\]]*\]\s*/, '');
  const match = cleaned.match(/[\p{L}\p{N}]/u) || String(text || '').match(/[\p{L}\p{N}]/u);
  return match ? match[0].toUpperCase() : fallback;
}

export function inlineBold(text) {
  const value = typeof text === 'string' ? text : '';
  const parts = [];
  const pattern = /\*\*([^*]+)\*\*/g;
  let last = 0;
  let match;
  while ((match = pattern.exec(value))) {
    if (match.index > last) parts.push({text: value.slice(last, match.index), bold: false});
    parts.push({text: match[1], bold: true});
    last = match.index + match[0].length;
  }
  if (last < value.length) parts.push({text: value.slice(last), bold: false});
  return parts;
}

export function wrapBold(text, start, end) {
  const value = typeof text === 'string' ? text : '';
  const from = Number.isFinite(start) ? Math.max(0, Math.min(value.length, start)) : value.length;
  const to = Number.isFinite(end) ? Math.max(from, Math.min(value.length, end)) : from;
  return {
    text: value.slice(0, from) + '**' + value.slice(from, to) + '**' + value.slice(to),
    start: from + 2,
    end: to + 2,
  };
}

function fillBold(doc, node, text) {
  const parts = inlineBold(text);
  node.textContent = '';
  if (!parts.some(part => part.bold)) {
    node.textContent = parts.map(part => part.text).join('');
    return;
  }
  for (const part of parts) {
    if (part.bold && typeof doc.createElement === 'function') {
      const strong = doc.createElement('strong');
      strong.textContent = part.text;
      node.append(strong);
    } else if (typeof doc.createTextNode === 'function') {
      node.append(doc.createTextNode(part.text));
    } else {
      node.textContent += part.text;
    }
  }
}

function renderMessageBody(doc, node, text, prefs) {
  const source = String(text || '');
  // Bold markers are ours; everything else keeps the shared folding and link preview path.
  if (inlineBold(source).some(part => part.bold)) {
    fillBold(doc, node, source);
    return;
  }
  renderMessageText(doc, node, source, prefs.message_folding, prefs.link_previews);
}

export function highlightParts(text, query) {
  const source = String(text || '');
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return [{text: source, match: false}];
  const parts = [];
  const lower = source.toLowerCase();
  let at = 0;
  for (let index = lower.indexOf(needle); index !== -1; index = lower.indexOf(needle, at)) {
    if (index > at) parts.push({text: source.slice(at, index), match: false});
    parts.push({text: source.slice(index, index + needle.length), match: true});
    at = index + needle.length;
  }
  if (at < source.length) parts.push({text: source.slice(at), match: false});
  return parts.length ? parts : [{text: source, match: false}];
}

export function groupInfoCounts(conversation) {
  const people = (conversation && conversation.members || []).length;
  const agents = (conversation && conversation.agent_members || []).length;
  return {people, agents, text: `${people + agents} 位成员 · ${people} 位真人 · ${agents} 位智能体`};
}

export function groupAgentSummary(conversation) {
  const list = conversation && conversation.agent_members || [];
  return list.length ? '群内智能体：' + list.map(agent => agent.name).join('、')
    + '。可明确请求一次回复，或在群信息中为自己的智能体开启自动回复。' : '';
}

// Personal-runtime states from server-side auto-provisioning (operator opt-in).
export const RUNTIME_WAIT_ERRORS = {
  runtime_starting: '你的专属运行时正在创建或启动，就绪后会自动回复',
  runtime_capacity: '平台专属运行时名额已满，请联系管理员扩容，或连接你自己的运行时',
  runtime_unavailable: '你的专属运行时创建或启动失败，请联系管理员处理',
};

export function sendNotice(reply) {
  const code = reply && reply.error_code;
  if (code === 'no_agent') return {kind: 'error', text: '消息已保存，正在等待已连接的运行时。'};
  if (code === 'runtime_starting') return {kind: 'ok', text: '消息已保存。' + RUNTIME_WAIT_ERRORS[code] + '。'};
  if (RUNTIME_WAIT_ERRORS[code]) return {kind: 'error', text: '消息已保存。' + RUNTIME_WAIT_ERRORS[code] + '。'};
  return {kind: 'ok', text: '已发送。'};
}

export function groupReplyStatus(reply) {
  const labels = {queued: '等待执行', running: '执行中', succeeded: '已完成', failed: '失败', cancelled: '已取消'};
  const errors = {no_agent: '没有可用运行时连接', quota: '运行时任务容量已满', timeout: '执行超时',
    runtime_failed: '运行时执行失败', empty_reply: '运行时未返回正文', task_missing: '运行时任务丢失', cancelled: '已取消',
    ...RUNTIME_WAIT_ERRORS};
  return (labels[reply.status] || '未知状态') + (reply.error_code ? '：' + (errors[reply.error_code] || '请求失败') : '');
}

export function composeCreateEnabled(options) {
  const mode = options && options.composeMode;
  const groupMode = (options && options.groupMode) || 'custom';
  const selectedCount = Number((options && options.selectedCount) || 0);
  if (mode === 'contact') return selectedCount === 1;
  if (mode === 'group' && groupMode === 'team') return options.templateSelected === true;
  if (mode === 'group') return groupMode === 'custom'
    && selectedCount <= 49 && Number(options.selectedHumanCount ?? selectedCount) >= 1;
  return false;
}

export function composeGroupPayload(memberIds, title, agentIds = []) {
  const body = {kind: 'group', member_ids: memberIds};
  const name = String(title || '').trim();
  if (name) body.title = name;
  if (agentIds.length) body.agent_ids = agentIds;
  return body;
}

function messageFor(error, fallback) {
  if (error && error.message) return error.message;
  return fallback;
}

function hashParams() {
  const text = (location.hash || '').replace(/^#/, '');
  const params = new URLSearchParams(text);
  return {
    workspace: params.get('workspace') || '',
    agent: params.get('agent') || '',
    conversation: params.get('conversation') || '',
    social: params.get('social') || '',
  };
}

function writeHash(values) {
  const params = new URLSearchParams();
  if (values.workspace) params.set('workspace', values.workspace);
  if (values.agent) params.set('agent', values.agent);
  if (values.social) params.set('social', values.social);
  if (values.conversation) params.set('conversation', values.conversation);
  const next = params.toString();
  const hash = next ? '#' + next : '';
  if (location.hash !== hash) history.replaceState(null, '', location.pathname + hash);
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

export function sessionDisplayGroup(item) {
  return item.pinned ? '置顶' : (item.kind === 'group' ? '群聊' : '直聊');
}

export function groupSessionsForDisplay(items) {
  return ['置顶', '直聊', '群聊'].flatMap(group => items.filter(item => sessionDisplayGroup(item) === group));
}

export function formatSessionTime(value, now = Date.now()) {
  const timestamp = Number(value) * 1000;
  if (!value || !Number.isFinite(timestamp)) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const day = ms => Math.floor((ms + 8 * 3600000) / 86400000);
  const days = day(now) - day(timestamp);
  if (days === 0) return new Intl.DateTimeFormat('zh-CN', {timeZone: 'Asia/Hong_Kong', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).format(date);
  if (days === 1) return '昨天';
  if (days > 1 && days < 7) return new Intl.DateTimeFormat('zh-CN', {timeZone: 'Asia/Hong_Kong', weekday: 'short'}).format(date);
  return new Intl.DateTimeFormat('zh-CN', {timeZone: 'Asia/Hong_Kong', year: 'numeric', month: 'numeric', day: 'numeric'}).format(date);
}

// Six original pastel tones so neighbouring avatars are distinguishable; stable per name.
export function avatarTone(name) {
  let hash = 0;
  for (const ch of String(name || '')) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return String((hash % 6) + 1);
}

export function initial(name) {
  const text = (name || '').trim();
  const match = text.match(/\p{L}|\p{N}/u);
  return match ? match[0].toUpperCase() : '?';
}

export function chatIdentity(name) {
  const title = (name || '').trim() || '聊天';
  const placeholder = title === '聊天';
  return {title, initial: placeholder ? '' : initial(title), showAvatar: !placeholder};
}

export function applyChatAvatarStack(document, conversation) {
  const stack = document.getElementById('chat-avatar-stack');
  const avatar = document.getElementById('chat-avatar');
  if (!stack) return false;
  stack.replaceChildren();
  const faces = [];
  for (const member of (conversation && conversation.members) || []) {
    faces.push(member.username || member.name || '');
  }
  for (const agent of (conversation && conversation.agent_members) || []) {
    faces.push(agent.name || '');
  }
  const names = faces.filter(Boolean).slice(0, 4);
  const grouped = Boolean(conversation && conversation.kind === 'group' && names.length);
  stack.hidden = !grouped;
  if (grouped) {
    if (avatar) avatar.hidden = true;
    for (const name of names) {
      const face = document.createElement('span');
      face.className = 'avatar stack-face';
      face.textContent = initial(name);
      if (face.dataset) face.dataset.tone = avatarTone(name);
      stack.appendChild(face);
    }
  }
  return grouped;
}

export function applyChatIdentity(document, name, conversation, look) {
  const identity = chatIdentity(name);
  const title = document.getElementById('chat-title');
  const avatar = document.getElementById('chat-avatar');
  if (title) title.textContent = identity.title;
  const subtitle = document.getElementById('chat-subtitle');
  if (subtitle) { subtitle.textContent = ''; subtitle.hidden = true; }
  const lookAvatar = createLookAvatar(look, document);
  const canRenderLook = Boolean(lookAvatar && avatar && avatar.replaceChildren && avatar.append);
  if (avatar) {
    if (avatar.replaceChildren) avatar.replaceChildren();
    if (canRenderLook) {
      avatar.append(lookAvatar);
      avatar.hidden = false;
    } else {
      avatar.textContent = identity.initial;
      avatar.hidden = !identity.showAvatar;
      if (avatar.dataset) avatar.dataset.tone = avatarTone(identity.title);
    }
  }
  const stacked = applyChatAvatarStack(document, conversation);
  if (stacked && avatar) avatar.hidden = true;
  if (!stacked && avatar && (identity.showAvatar || canRenderLook)) avatar.hidden = false;
  return identity;
}

function matchesQuery(item, query) {
  if (!query) return true;
  const hay = ((item.title || '') + ' ' + (item.preview || '') + ' ' + (item.snippet || '')).toLowerCase();
  return hay.includes(query.toLowerCase());
}

// Must match social.REACTIONS on the server.
export const MESSAGE_REACTIONS = ['👍', '❤️', '😄', '🎉', '👀', '✅'];

export function reactionToggle(reactions, emoji) {
  const current = (reactions || []).find(item => item.emoji === emoji);
  return {emoji, active: !(current && current.mine)};
}

export function forwardTargets(conversations, currentId) {
  return (conversations || []).filter(item => item.id !== currentId)
    .map(item => ({id: item.id, label: (item.kind === 'dm' ? '单聊 · ' : '群聊 · ') + (item.title || '会话')}));
}

export function forwardCountLabel(count) {
  return `已选 ${Number(count) || 0} 条`;
}

export function notificationBadgeText(count) {
  const value = Number(count) || 0;
  if (value <= 0) return '';
  return value > 99 ? '99+' : String(value);
}

export function notificationSummary(item) {
  if (item.kind === 'follow_work') {
    const author = item.actor_username || '你关注的作者';
    return item.title ? `${author} 发布了新作品「${item.title}」` : '你关注的作者发布了新作品';
  }
  if (item.kind === 'messenger.mention') {
    const author = item.by?.display_name || item.by?.handle || '成员';
    return `${author} 提及了你`;
  }
  const where = item.conversation_kind === 'dm' ? '单聊' : (item.conversation_title || '群聊');
  if (item.kind === 'automation_reminder') {
    return `提醒到点：${item.title || '回看一条消息'}`;
  }
  if (item.kind === 'agent_reply') {
    const outcome = {succeeded: '已完成', failed: '未能完成', cancelled: '已取消'}[item.status] || '已结束';
    return `${item.actor_username || '智能体'} 在「${where}」${outcome}你的请求`;
  }
  return `${item.actor_username || '成员'} 在「${where}」提及了你`;
}

// A reminder is not a separate store: it is a one-shot automation created from the
// message, and its due time is listed as a derived notification.

function zoneClock(ts, zone) {
  try {
    const format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const parts = {};
    for (const part of format.formatToParts(new Date(ts))) {
      if (part.type !== 'literal') parts[part.type] = Number(part.value);
    }
    if (!Number.isFinite(parts.year)) return null;
    return {...parts, hour: parts.hour % 24};
  } catch {
    return null;
  }
}

export function zonedInstant(dateText, timeText, zone) {
  const [year, month, day] = String(dateText || '').split('-').map(Number);
  const [hour, minute] = String(timeText || '').split(':').map(Number);
  if (![year, month, day, hour, minute].every(Number.isFinite)) return null;
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = zoneClock(guess, zone);
  if (!first) return null;
  const offset = Date.UTC(first.year, first.month - 1, first.day, first.hour, first.minute, first.second) - guess;
  const settled = zoneClock(guess - offset, zone);
  const finalOffset = settled
    ? Date.UTC(settled.year, settled.month - 1, settled.day, settled.hour, settled.minute, settled.second) - (guess - offset)
    : offset;
  return guess - finalOffset;
}

export function zoneDayKey(ts, zone) {
  const clock = zoneClock(ts, zone);
  if (!clock) return '';
  return `${clock.year}-${String(clock.month).padStart(2, '0')}-${String(clock.day).padStart(2, '0')}`;
}

// One-shot automations that already came due, shown in the chat sidebar.
// Participants may be {user_id, username} (legacy) or {username} (DS-Bot plugin).
export function dueReminders(items, user, now = Date.now()) {
  const userId = user && typeof user === 'object' ? user.id : user;
  const username = user && typeof user === 'object' ? user.username : undefined;
  const today = [];
  const older = [];
  for (const item of items || []) {
    if (!item || item.enabled === false || item.enabled === 0) continue;
    const schedule = item.schedule || {};
    if (schedule.kind !== 'once' || !schedule.date || !schedule.time || !schedule.time_zone) continue;
    const mine = (item.participants || []).some(person => person && (
      (userId && person.user_id === userId)
      || (username && person.username === username)
      || (!person.user_id && person.username && (person.username === userId || person.username === username))
    ));
    if (!mine) continue;
    const due = zonedInstant(schedule.date, schedule.time, schedule.time_zone);
    if (due === null || due > now) continue;
    const row = {id: item.id, title: item.title || '', due, schedule};
    if (zoneDayKey(due, schedule.time_zone) === zoneDayKey(now, schedule.time_zone)) today.push(row);
    else older.push(row);
  }
  today.sort((left, right) => right.due - left.due);
  older.sort((left, right) => right.due - left.due);
  return {today, older};
}

export function reminderDueLabel(item, now = Date.now()) {
  const zone = (item.schedule && item.schedule.time_zone) || 'UTC';
  const clock = zoneClock(item.due, zone);
  const time = clock ? `${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}` : (item.schedule && item.schedule.time) || '';
  if (zoneDayKey(item.due, zone) === zoneDayKey(now, zone)) return `今天 ${time} 到点`;
  return `${String((item.schedule && item.schedule.date) || '').slice(5)} ${time} 到点`;
}

export const REMINDER_CHOICES = [['remind-1h', 'later'], ['remind-tomorrow', 'tomorrow']];

function zonedParts(moment, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(moment);
  const pick = (type) => {
    const found = parts.find((part) => part.type === type);
    return found ? found.value : '';
  };
  return {date: `${pick('year')}-${pick('month')}-${pick('day')}`, time: `${pick('hour')}:${pick('minute')}`};
}

export function readableTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function reminderSchedule(choice, now = new Date(), timeZone = readableTimeZone()) {
  if (choice === 'tomorrow') {
    const today = zonedParts(now, timeZone).date.split('-').map(Number);
    const next = new Date(Date.UTC(today[0], today[1] - 1, today[2] + 1));
    return {kind: 'once', date: next.toISOString().slice(0, 10), time: '09:00', time_zone: timeZone};
  }
  const later = zonedParts(new Date(now.getTime() + 3600000), timeZone);
  return {kind: 'once', date: later.date, time: later.time, time_zone: timeZone};
}

export function reminderTitle(text) {
  const collapsed = String(text || '').replace(/\s+/g, ' ').trim();
  if (!collapsed) return '提醒：回看一条消息';
  return '提醒：' + (collapsed.length > 40 ? `${collapsed.slice(0, 39)}…` : collapsed);
}

export function reminderPayload(item, choice, now, timeZone, username) {
  const excerpt = String((item && item.body) || '').replace(/\s+/g, ' ').trim();
  return {
    title: reminderTitle(item && item.body),
    prompt: excerpt ? `提醒我回看这条消息：${excerpt.slice(0, 600)}` : '提醒我回看一条消息。',
    template_id: 'reminder',
    schedule: reminderSchedule(choice, now, timeZone),
    participants: [username],
    scope: 'once',
    intent: '',
    agents: [],
  };
}

export function reminderKey(messageId) {
  return 'remind-' + String(messageId || '');
}

export function reminderNotice(status, body = {}) {
  const schedule = body && body.automation && body.automation.schedule;
  const when = schedule && schedule.date && schedule.time ? `${schedule.date} ${schedule.time}` : '';
  if (status === 201) return when ? `已设提醒：${when}。` : '已设提醒。';
  if (status === 200) return when ? `这条消息已经设过提醒：${when}。` : '这条消息已经设过提醒。';
  if (status === 403) return '只有工作区所有者或管理员可以设提醒。';
  if (status === 429) return '这个工作区的自动化数量已达上限，先删掉一条再设提醒。';
  if (status === 409) return '这个工作区已经有同名提醒，请到自动化页调整。';
  return '没能设成提醒，请稍后再试。';
}

export function notificationTarget(item) {
  return item && item.kind === 'automation_reminder' ? '/automations' : null;
}

export function mount(document, {fetcher = globalThis.fetch.bind(globalThis)} = {}) {
  const status = document.getElementById('status');
  const loginPanel = document.getElementById('login-panel');
  const mainPanel = document.getElementById('main-panel');
  const workspaceSelect = document.getElementById('workspace');
  let currentUser = null;
  let workspaces = [];
  let agents = [];
  let members = [];
  let artifacts = [];
  let socialConversations = [];
  let sessions = [];
  let currentAgent = null;
  let personalAgentId = '';
  const servedByDsbot = dsbotServed(document);
  let personalLook = null;
  let currentConversation = null;
  const messageUtilities = mountMessageUtilities(document, {request, notify: show, composerContext: () => currentConversation ? {wid: workspaceId(), cid: currentConversation.id, source: currentSource} : null, context: () => currentSource === 'social' && currentConversation ? {wid: workspaceId(), cid: currentConversation.id, kind: currentConversation.kind} : null});
  let currentSource = 'agent';
  const agentMentions = mountAgentMentions(document, () => {
    if (currentSource !== 'social' || currentConversation?.kind !== 'group') return null;
    return {scope: `${workspaceId()}/${currentConversation.id}`, agents: currentConversation.agent_members || []};
  });
  function voiceContext() {
    if (currentSource !== 'social' || !currentConversation) return null;
    const wid = workspaceId();
    const cid = currentConversation.id;
    return {wid, cid, scope: `${wid}/${cid}`};
  }
  const voiceRecorder = mountVoiceRecorder(document, {
    context: voiceContext,
    createKey: () => idempotencyKey('voice-'),
    async send(destination, voice, key) {
      const {wid, cid, scope} = destination;
      const result = await request('POST', `/v1/workspaces/${wid}/social/conversations/${cid}/messages`,
        {voice}, {'Idempotency-Key': key});
      if (![200, 201].includes(result.status) || !result.body?.message?.voice) {
        throw new Error(messageFor(result.body?.error, '语音发送失败，请重试。'));
      }
      if (voiceContext()?.scope === scope) {
        await openSocialConversation(cid);
        show('ok', '语音已发送。');
      }
    },
  });
  const voiceUrls = new Set();
  function clearVoicePlayers() {
    for (const url of voiceUrls) URL.revokeObjectURL(url);
    voiceUrls.clear();
  }
  globalThis.addEventListener?.('pagehide', clearVoicePlayers);

  function voicePlayer(item) {
    const player = document.createElement('section');
    player.className = 'voice-message';
    const play = document.createElement('button');
    play.type = 'button';
    play.textContent = '播放语音';
    const destination = voiceContext();
    if (!destination) return player;
    play.addEventListener('click', async () => {
      if (play.disabled || voiceContext()?.scope !== destination.scope) return;
      play.disabled = true;
      play.textContent = '正在加载…';
      try {
        const path = `/v1/workspaces/${destination.wid}/social/conversations/${destination.cid}/messages/${item.id}/voice`;
        const result = await request('GET', path);
        if (result.status !== 200) throw new Error('Voice unavailable');
        if (voiceContext()?.scope !== destination.scope || player.isConnected === false) return;
        const url = URL.createObjectURL(decodeVoice(result.body));
        voiceUrls.add(url);
        const audio = document.createElement('audio');
        audio.src = url;
        audio.controls = true;
        audio.preload = 'metadata';
        audio.setAttribute('aria-label', '语音消息');
        player.replaceChildren(audio);
        audio.focus();
        audio.play().catch(() => {});
      } catch {
        play.textContent = '重试播放语音';
        play.disabled = false;
        show('error', '无法播放语音，请重试。');
      }
    });
    player.append(play);
    return player;
  }

  let pollTimer = 0;
  let searchTab = 'all';
  let searchConversation = '';
  let searchConversationTitle = '';
  let composeMode = 'group';
  let groupMode = 'custom';
  let groupReplyAttempt = null;
  let groupReplyBusy = false;
  let searchSeq = 0;
  let resourceCursor = '';
  let resourceItems = [];
  let sendShortcut = 'enter';
  let chatLanguage = 'auto';
  let chatPreferences = {message_folding:'standard', document_cards:false, link_previews:true};

  function show(kind, text) {
    status.dataset.kind = kind;
    status.textContent = text;
  }

  async function request(method, path, body, extra) {
    const headers = {'Accept': 'application/json', 'X-CSRF-Token': csrfCookie(document.cookie), ...(extra || {})};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const plugin = servedByDsbot ? dsbotRoute(method, path, body, personalAgentId) : null;
    if (plugin) return dsbotRequest(fetcher, plugin, personalAgentId, headers);
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

  function socialBase() {
    return `/v1/workspaces/${workspaceId()}/social/conversations`;
  }

  const messageSearch = createMessageSearch(async (query, conversationId, cursor) => {
    const result = await request(
      'GET',
      `/v1/workspaces/${workspaceId()}/search/messages?${messageSearchQuery(query, conversationId, cursor)}`,
    );
    if (result.status !== 200) throw new Error(messageFor(result.body.error, '无法搜索消息。'));
    return {items: result.body.items || [], cursor: result.body.cursor || ''};
  });

  function renderGroupReplyAction(requests) {
    const panel = document.getElementById('group-agent-action');
    const isGroup = currentSource === 'social' && currentConversation
      && currentConversation.kind === 'group';
    panel.hidden = !isGroup;
    if (!isGroup) return;
    const saved = currentConversation.agent_members || [];
    const active = new Set((requests || []).filter(item =>
      ['queued', 'running'].includes(item.status)).map(item => item.agent_id));
    const chips = document.getElementById('group-agent-chips');
    chips.replaceChildren();
    for (const agent of saved) {
      const li = document.createElement('li');
      li.className = 'agent-chip';
      const name = document.createElement('span');
      name.textContent = agent.name + (agent.archived ? '（已归档）' : '');
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '移除';
      remove.dataset.removeAgent = agent.agent_id;
      li.append(name, remove);
      chips.append(li);
    }
    const add = document.getElementById('group-agent-add');
    add.replaceChildren();
    const joined = new Set(saved.map(agent => agent.agent_id));
    const available = agents.filter(agent => !agent.archived && !joined.has(agent.id));
    for (const agent of available) {
      const option = document.createElement('option');
      option.value = agent.id;
      option.textContent = agent.name;
      add.append(option);
    }
    add.disabled = !available.length;
    document.getElementById('group-agent-add-submit').disabled = !available.length;
    const holder = document.getElementById('group-agent-choices');
    holder.replaceChildren();
    for (const agent of saved.filter(item => !item.archived)) {
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.name = 'group-agent';
      box.value = agent.agent_id;
      box.disabled = active.has(agent.agent_id);
      label.append(box, document.createTextNode(agent.name + (active.has(agent.agent_id) ? '（回复中）' : '')));
      holder.append(label);
    }
    const list = document.getElementById('group-agent-requests');
    list.replaceChildren();
    for (const request of requests || []) {
      const item = document.createElement('li');
      item.textContent = request.agent_name + ' · ' + request.prompt + ' · ' + groupReplyStatus(request);
      item.dataset.replyStatus = request.status;
      list.append(item);
    }
    document.getElementById('group-agent-submit').disabled = groupReplyBusy
      || !holder.querySelector('input:not(:disabled)');
  }

  function stopPolling() {
    if (pollTimer) {
      globalThis.clearTimeout(pollTimer);
      pollTimer = 0;
    }
  }

  function isSearchOpen() {
    return !document.getElementById('search-panel').hidden;
  }

  function setSessionsOpen(open) {
    if (open) document.body.classList.add('sessions-open');
    else document.body.classList.remove('sessions-open');
  }

  function narrowScreen() {
    return typeof globalThis.matchMedia === 'function'
      && globalThis.matchMedia('(max-width: 900px)').matches;
  }

  let sessionsStatus = '';

  function setSessionsStatus(text) {
    sessionsStatus = text;
    const notice = document.getElementById('conversations-status');
    if (notice) {
      notice.textContent = text;
      notice.hidden = !text;
    }
    if (text) document.getElementById('conversations-empty').hidden = true;
  }

  let markingConversationsRead = false;

  function renderSessions() {
    const list = document.getElementById('conversation-list');
    list.replaceChildren();
    const filterNode = document.getElementById('session-filter-value');
    const filter = (filterNode && filterNode.value) || 'all';
    const visible = sessions.filter(item => filter === 'all'
      || (filter === 'agent' && item.source === 'agent')
      || (filter === 'personal' && item.source === 'agent' && item.agent_id === personalAgentId)
      || (filter === 'pinned' && item.pinned)
      || (filter === 'unread' && item.unread_count > 0)
      || (filter === 'read' && !item.unread_count)
      || (filter === 'group' && item.kind === 'group') || (filter === 'dm' && item.kind === 'dm'));
    document.getElementById('conversation-heading').textContent = '对话 · ' + visible.length;
    const empty = document.getElementById('conversations-empty');
    empty.hidden = Boolean(sessionsStatus) || visible.length > 0;
    if (!empty.hidden) empty.textContent = filter === 'all'
      ? '还没有对话。用右上角的 + 新建群组或前往智能体目录。' : '当前筛选下没有对话。';
    const readAll = document.getElementById('conversations-read-all');
    if (readAll) {
      readAll.hidden = !sessions.some(item => item.source === 'social' && item.unread_count > 0);
      readAll.disabled = markingConversationsRead;
    }
    let lastGroup = '';
    for (const session of groupSessionsForDisplay(visible)) {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'session-row';
      button.dataset.conversation = session.id;
      button.dataset.source = session.source;
      if (session.agent_id) button.dataset.agent = session.agent_id;
      if (currentConversation && currentConversation.id === session.id && currentSource === session.source) {
        button.setAttribute('aria-current', 'true');
      }
      const lookAvatar = session.agent_id === personalAgentId ? createLookAvatar(personalLook, document) : null;
      const avatar = lookAvatar || document.createElement('span');
      if (!lookAvatar) {
        avatar.className = 'avatar';
        avatar.textContent = initial(session.title);
        avatar.dataset.tone = avatarTone(session.title);
        avatar.dataset.kind = session.kind || session.source || '';
      }
      const copy = document.createElement('span');
      copy.className = 'copy';
      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = (session.pinned ? '置顶 · ' : '') + session.title;
      const preview = document.createElement('span');
      preview.className = 'preview';
      fillBold(document, preview, session.preview || '');
      copy.append(title, preview);
      const time = document.createElement('span');
      time.className = 'time';
      time.textContent = formatSessionTime(session.updated);
      time.title = formatTime(session.updated);
      button.append(avatar, copy, time);
      if (session.muted) button.classList.add('is-muted');
      if (session.unread_count > 0) {
        const unread = document.createElement('span');
        unread.className = 'unread-badge';
        unread.textContent = String(session.unread_count);
        unread.setAttribute('aria-label', session.unread_count + ' 条未读消息');
        time.append(unread);
      }

      const group = sessionDisplayGroup(session);
      if (group !== lastGroup) {
        li.className = 'session-divider'; li.dataset.section = group; lastGroup = group;
      }
      button.setAttribute('aria-label', group + '：' + session.title + (session.muted ? '，免打扰' : ''));
      li.append(button);
      list.append(li);
    }
  }

  function setChatSubtitle(text, busy = false) {
    const line = document.getElementById('chat-subtitle');
    if (!line) return;
    line.textContent = text || '';
    line.hidden = !text;
    if (busy) line.dataset.busy = '1'; else delete line.dataset.busy;
  }

  function renderAgentMessages(items) {
    const list = document.getElementById('message-list');
    list.replaceChildren();
    document.getElementById('chat-empty').hidden = (items || []).length > 0;
    let pending = false;
    for (const item of items || []) {
      const li = document.createElement('li');
      li.dataset.messageId = item.id;
      li.className = item.role === 'user' ? 'user' : 'assistant';
      const role = document.createElement('p');
      role.className = 'role';
      role.textContent = item.role === 'user' ? '你' : ((currentAgent && currentAgent.name) || '智能体');
      const body = document.createElement('div');
      const waiting = item.role === 'assistant' && (item.status === 'queued' || item.status === 'running');
      const failed = item.role === 'assistant' && (item.status === 'failed' || item.status === 'cancelled');
      body.className = 'body ' + (waiting ? 'pending' : (failed ? 'failed' : ''));
      renderMessageBody(document, body, item.role === 'user' ? (item.body || '') : statusLabel(item), chatPreferences);
      if (waiting || failed) li.dataset.state = waiting ? item.status : 'failed';
      if (waiting) {
        const heading = document.createElement('p');
        heading.className = 'reply-state';
        heading.textContent = item.status === 'running' ? '正在生成回复' : '正在准备回复';
        li.append(role, heading, body);
      } else {
        li.append(role, body);
      }
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
    setChatSubtitle(pending ? '正在回复…' : 'AI 智能体 · 经运行时回复', pending);
    const scroller = document.getElementById('message-scroller');
    scroller.scrollTop = scroller.scrollHeight;
    return pending;
  }

  let selecting = false;
  const selectedMessages = new Set();
  let pinnedIds = new Set();

  function syncForwardBar() {
    const bar = document.getElementById('forward-bar');
    if (!bar) return;
    bar.hidden = !selecting;
    document.getElementById('forward-count').textContent = forwardCountLabel(selectedMessages.size);
    const target = document.getElementById('forward-target');
    document.getElementById('forward-submit').disabled = !(selectedMessages.size && target.value);
    const toggle = document.getElementById('multi-select-toggle');
    if (toggle) { toggle.setAttribute('aria-pressed', selecting ? 'true' : 'false'); toggle.textContent = selecting ? '退出多选' : '多选'; }
  }

  function fillForwardTargets() {
    const target = document.getElementById('forward-target');
    if (!target) return;
    const options = forwardTargets(socialConversations, currentConversation && currentConversation.id);
    target.replaceChildren(...options.map(item => {
      const option = document.createElement('option'); option.value = item.id; option.textContent = item.label; return option;
    }));
  }

  function setSelecting(on) {
    selecting = on;
    selectedMessages.clear();
    if (on) fillForwardTargets();
    syncForwardBar();
    if (currentConversation && currentSource === 'social') renderSocialMessages(lastSocialItems);
  }

  function renderPinned(list) {
    pinnedIds = new Set((list || []).map(item => item.message_id));
    const section = document.getElementById('pinned-messages');
    const holder = document.getElementById('pinned-message-list');
    if (!section || !holder) return;
    section.hidden = !(list && list.length);
    holder.replaceChildren(...(list || []).map(item => {
      const li = document.createElement('li');
      li.textContent = item.excerpt;
      li.title = '由 ' + item.pinned_by_username + ' 置顶';
      return li;
    }));
  }

  function messageTools(item) {
    const tools = document.createElement('span');
    tools.className = 'message-tools';
    if (selecting) {
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = selectedMessages.has(item.id);
      box.setAttribute('aria-label', '选择这条消息');
      box.addEventListener('change', () => {
        if (box.checked) selectedMessages.add(item.id); else selectedMessages.delete(item.id);
        syncForwardBar();
      });
      label.append(box, document.createTextNode('选择'));
      tools.append(label);
      return tools;
    }
    const pin = document.createElement('button');
    pin.type = 'button';
    const isPinned = pinnedIds.has(item.id);
    pin.textContent = isPinned ? '取消置顶' : '置顶';
    pin.setAttribute('aria-label', isPinned ? '取消置顶这条消息' : '置顶这条消息');
    pin.addEventListener('click', async () => {
      const wid = workspaceId(), cid = currentConversation && currentConversation.id;
      const result = await request('POST', `${socialBase()}/${cid}/messages/${item.id}/pin`, {pinned: !isPinned});
      if (workspaceId() !== wid || !currentConversation || currentConversation.id !== cid) return;
      if (result.status !== 200) { show('error', messageFor(result.body.error, '无法置顶消息。')); return; }
      renderPinned(result.body.pinned_messages);
      renderSocialMessages(lastSocialItems);
    });
    pin.hidden = true;
    tools.append(pin);
    return tools;
  }

  function reactionBar(item) {
    const bar = document.createElement('div');
    bar.className = 'message-reactions';
    fillReactionBar(bar, item);
    return bar;
  }

  function fillReactionBar(bar, item) {
    bar.replaceChildren();
    const react = async (emoji) => {
      const wid = workspaceId(), cid = currentConversation && currentConversation.id;
      if (!cid) return;
      const result = await request('POST', `${socialBase()}/${cid}/messages/${item.id}/reactions`,
        reactionToggle(item.reactions, emoji));
      if (workspaceId() !== wid || !currentConversation || currentConversation.id !== cid) return;
      if (result.status !== 200) { show('error', messageFor(result.body.error, '表情回应未保存。')); return; }
      item.reactions = result.body.reactions;
      fillReactionBar(bar, item);
    };
    for (const reaction of item.reactions || []) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'reaction-chip' + (reaction.mine ? ' is-mine' : '');
      chip.setAttribute('aria-pressed', reaction.mine ? 'true' : 'false');
      chip.setAttribute('aria-label', `${reaction.emoji} ${reaction.count} 人回应${reaction.mine ? '，含我' : ''}`);
      chip.textContent = `${reaction.emoji} ${reaction.count}`;
      chip.addEventListener('click', () => react(reaction.emoji));
      bar.append(chip);
    }
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'reaction-add';
    add.textContent = '+😊';
    add.setAttribute('aria-label', '添加表情回应');
    add.setAttribute('aria-expanded', 'false');
    const picker = document.createElement('span');
    picker.className = 'reaction-picker';
    picker.hidden = true;
    for (const emoji of MESSAGE_REACTIONS) {
      const choice = document.createElement('button');
      choice.type = 'button';
      choice.textContent = emoji;
      choice.setAttribute('aria-label', '回应 ' + emoji);
      choice.addEventListener('click', () => react(emoji));
      picker.append(choice);
    }
    add.addEventListener('click', () => {
      picker.hidden = !picker.hidden;
      add.setAttribute('aria-expanded', picker.hidden ? 'false' : 'true');
    });
    bar.append(add, picker);
  }

  let messageMenuTarget = null;
  function closeMessageMenu() {
    const menu = document.getElementById('message-context-menu');
    if (menu) menu.hidden = true;
    messageMenuTarget = null;
  }

  function openMessageMenu(item, li, mine, x, y) {
    const menu = document.getElementById('message-context-menu');
    if (!menu) return;
    messageMenuTarget = {item, li, mine};
    const reactions = document.getElementById('message-menu-reactions');
    reactions.replaceChildren(...MESSAGE_REACTIONS.map(emoji => {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      button.textContent = emoji;
      button.setAttribute('aria-label', '回应 ' + emoji);
      button.dataset.emoji = emoji;
      return button;
    }));
    const pin = menu.querySelector('[data-menu="pin"]');
    pin.textContent = pinnedIds.has(item.id) ? '取消置顶' : '置顶';
    menu.querySelector('[data-menu="retract"]').hidden = !mine;
    menu.querySelector('[data-menu="delete"]').hidden = !mine;
    const edit = menu.querySelector('[data-menu="edit"]');
    if (edit) edit.hidden = !mine;
    menu.querySelector('[data-menu="forward"]').disabled = forwardTargets(socialConversations, currentConversation && currentConversation.id).length === 0;
    menu.hidden = false;
    const width = menu.offsetWidth || 200, height = menu.offsetHeight || 360;
    const left = Math.max(8, Math.min(x, globalThis.innerWidth - width - 8));
    const top = Math.max(8, Math.min(y, globalThis.innerHeight - height - 8));
    menu.style.setProperty('left', left + 'px');
    menu.style.setProperty('top', top + 'px');
    const first = menu.querySelector('button:not(:disabled)');
    if (first) first.focus();
  }

  const messageMenu = document.getElementById('message-context-menu');
  if (messageMenu) {
    messageMenu.addEventListener('click', async event => {
      const button = event.target.closest('button');
      if (!button || button.disabled || !messageMenuTarget) return;
      const {item, li} = messageMenuTarget;
      const action = button.dataset.menu;
      closeMessageMenu();
      if (button.dataset.emoji) {
        const choice = li.querySelector(`.reaction-picker button[aria-label="回应 ${button.dataset.emoji}"]`);
        if (choice) choice.click();
      } else if (action === 'reply') {
        const input = document.getElementById('chat-body');
        const author = (li.querySelector('.role') || {}).textContent || '';
        const excerpt = String(item.body || '').replace(/\s+/g, ' ').slice(0, 80);
        input.value = `> ${author}：${excerpt}\n` + input.value;
        input.dispatchEvent(new Event('input', {bubbles: true}));
        input.focus();
      } else if (action === 'translate' || action === 'ask') {
        messageUtilities.open(item, action);
      } else if (action === 'save') {
        openSaveMessage(item);
      } else if (action === 'edit') {
        const edit = Array.from(li.querySelectorAll(':scope > button')).find(node => node.textContent === '编辑');
        if (edit) edit.click();
      } else if (action === 'copy') {
        try { await navigator.clipboard.writeText(item.body || ''); show('ok', '已复制。'); }
        catch { show('error', '浏览器不允许复制，请手动选择文本。'); }
      } else if (action === 'forward' || action === 'select') {
        setSelecting(true);
        if (action === 'forward') { selectedMessages.add(item.id); syncForwardBar(); renderSocialMessages(lastSocialItems); }
      } else if (action === 'pin') {
        const pinButton = li.querySelector('.message-tools button');
        if (pinButton) pinButton.click();
      } else if (action === 'remind-1h' || action === 'remind-tomorrow') {
        await setMessageReminder(item, action === 'remind-1h' ? 'later' : 'tomorrow');
      } else if (action === 'retract') {
        const retract = Array.from(li.querySelectorAll(':scope > button')).find(node => node.textContent === '撤回');
        if (retract) retract.click();
      } else if (action === 'delete') {
        const cid = currentConversation.id;
        const result = await request('DELETE', `${socialBase()}/${cid}/messages/${item.id}`);
        if (result.status !== 204) {
          show('error', messageFor(result.body.error, '消息未删除，请重试。'));
          return;
        }
        if (!currentConversation || currentConversation.id !== cid) return;
        renderSocialMessages(lastSocialItems.filter(row => row.id !== item.id));
        await loadSessions();
      }
    });
    document.addEventListener('click', event => {
      if (!messageMenu.hidden && !messageMenu.contains(event.target)) closeMessageMenu();
    });
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && !messageMenu.hidden) closeMessageMenu(); });
    globalThis.addEventListener('resize', closeMessageMenu);
    const scroller = document.getElementById('message-scroller');
    if (scroller) scroller.addEventListener('scroll', closeMessageMenu, {passive: true});
  }

  let saveMessageTarget = null;
  const saveMessageDialog = document.getElementById('save-message-dialog');

  // One click on a message becomes a real one-shot automation in this workspace; the
  // idempotency key is the message id, so setting it twice answers "already set".
  async function setMessageReminder(item, choice) {
    const wid = workspaceId();
    if (!wid || !currentUser) return;
    const payload = reminderPayload(item, choice, new Date(), readableTimeZone(), currentUser.username);
    let result;
    try {
      result = await request('POST', `/v1/workspaces/${wid}/automations`, payload,
        {'Idempotency-Key': reminderKey(item.id)});
    } catch {
      show('error', '网络失败，没能设成提醒。');
      return;
    }
    if (workspaceId() !== wid) return;
    show(result.status === 201 || result.status === 200 ? 'ok' : 'error',
      reminderNotice(result.status, result.body));
  }

  function openSaveMessage(item) {
    saveMessageTarget = {item, workspace: workspaceId(), conversation: currentConversation.id};
    document.getElementById('save-message-title').value = String(item.body || '').replace(/\s+/g, ' ').trim().slice(0, 60) || '消息记录';
    document.getElementById('save-message-error').hidden = true;
    saveMessageDialog.showModal();
    document.getElementById('save-message-title').focus();
  }
  const saveMessageCancel = document.getElementById('save-message-cancel');
  if (saveMessageCancel) saveMessageCancel.addEventListener('click', () => { saveMessageDialog.close(); saveMessageTarget = null; });
  const saveMessageForm = document.getElementById('save-message-form');
  if (saveMessageForm) saveMessageForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (!saveMessageTarget) return;
    const {item, workspace, conversation} = saveMessageTarget;
    const button = document.getElementById('save-message-submit');
    const error = document.getElementById('save-message-error');
    if (button.disabled) return;
    button.disabled = true; error.hidden = true;
    try {
      const result = await request('POST', `/v1/workspaces/${workspace}/social/conversations/${conversation}/messages/${item.id}/save`,
        {title: document.getElementById('save-message-title').value, revision: item.revision || 1});
      if (result.status !== 200 && result.status !== 201) {
        error.textContent = messageFor(result.body.error, '消息未保存，请重新打开消息后重试。'); error.hidden = false; return;
      }
      saveMessageDialog.close(); saveMessageTarget = null;
      show('ok', result.status === 201 ? `已保存到工作区资料空间：${result.body.artifact.title}` : `已存在工作区资料空间中（未同步后续编辑）：${result.body.artifact.title}`);
    } catch { error.textContent = '网络错误，无法确认保存结果。可以重试，不会产生重复副本。'; error.hidden = false; }
    finally { button.disabled = false; }
  });

  let socialHistory = null;
  let socialOpen = 0;
  let historyJump = 0;
  const olderMessages = document.getElementById('chat-load-older');
  const latestMessages = document.getElementById('chat-back-to-latest');
  const historyNotice = document.getElementById('chat-history-status');

  function setSocialHistory(state) {
    socialHistory = state;
    if (historyNotice) historyNotice.textContent = '';
    updateHistoryControls();
  }

  function updateHistoryControls() {
    if (olderMessages) {
      olderMessages.hidden = !socialHistory?.cursor;
      olderMessages.disabled = Boolean(socialHistory?.loading);
    }
    if (latestMessages) latestMessages.hidden = !socialHistory?.readingHistory;
  }

  async function historyPage(state, query) {
    const result = await request('GET', `/v1/workspaces/${state.wid}/social/conversations/${state.cid}/messages?${query}`);
    return socialHistory === state && currentSource === 'social' && workspaceId() === state.wid
      && currentConversation?.id === state.cid ? result : null;
  }

  olderMessages?.addEventListener('click', async () => {
    const state = socialHistory;
    if (!state?.cursor || state.loading) return;
    state.loading = true;
    updateHistoryControls();
    if (historyNotice) historyNotice.textContent = '';
    try {
      const query = new URLSearchParams({before: String(state.cursor), limit: '50'});
      const result = await historyPage(state, query);
      if (!result) return;
      if (result.status !== 200) throw new Error('History unavailable');
      const existing = new Set(lastSocialItems.map(item => item.id));
      const older = (result.body.items || []).filter(item => !existing.has(item.id));
      state.cursor = result.body.cursor ?? null;
      state.readingHistory = true;
      if (older.length) renderSocialMessages([...older, ...lastSocialItems], {keepScroll: true});
      if (historyNotice) historyNotice.textContent = older.length ? `已加载 ${older.length} 条旧消息。` : '没有更早的消息。';
    } catch {
      if (socialHistory === state && historyNotice) historyNotice.textContent = '旧消息加载失败，请重试。';
    } finally {
      state.loading = false;
      updateHistoryControls();
    }
  });
  latestMessages?.addEventListener('click', () => {
    if (currentSource === 'social' && currentConversation) openSocialConversation(currentConversation.id);
  });

  let lastSocialItems = [];
  function renderSocialMessages(items, {keepScroll = Boolean(socialHistory?.readingHistory)} = {}) {
    const scroller = document.getElementById('message-scroller');
    const oldHeight = scroller.scrollHeight;
    const oldTop = scroller.scrollTop;
    clearVoicePlayers();
    lastSocialItems = items || [];
    const list = document.getElementById('message-list');
    list.replaceChildren();
    document.getElementById('chat-empty').hidden = (items || []).length > 0;
    const people = currentConversation && currentConversation.members || members;
    for (const item of items || []) {
      const li = document.createElement('li');
      li.dataset.messageId = item.id;
      const mine = item.user_id === (currentUser && currentUser.id);
      li.className = mine ? 'mine' : 'other';
      const role = document.createElement('p');
      role.className = 'role';
      const member = people.find(entry => entry.user_id === item.user_id);
      role.textContent = item.role === 'agent' ? (item.agent_name + ' · AI 智能体 · 运行时回复')
        : (mine ? '我' : ((member && member.username) || '成员'));
      const body = document.createElement('div');
      body.className = 'body';
      renderMessageBody(document, body, item.retracted ? '此消息已撤回' : (item.body || ''), chatPreferences);
      if (item.forwarded_from && !item.retracted) {
        body.dataset.forwarded = '1';
        body.title = '转发自 ' + item.forwarded_from.author;
        role.textContent += ' · 转发自 ' + item.forwarded_from.author;
      }
      const time = document.createElement('p');
      time.className = 'time';
      time.textContent = formatTime(item.created);
      li.append(role, body, time);
      if (item.voice && !item.retracted) li.insertBefore(voicePlayer(item), time);
      if (item.attachment && !item.retracted) {
        const card = document.createElement('article');
        card.className = 'stream-artifact';
        const copy = document.createElement('span');
        copy.className = 'stream-artifact-copy';
        const heading = document.createElement('strong');
        heading.textContent = item.attachment.title || '附件';
        const file = document.createElement('a');
        file.href = item.attachment.path;
        // An attachment is a workspace media artifact, so a picture can be
        // shown as a picture. Before this, every attachment was a document
        // card: the sender saw a DOC cover instead of the photo they shared.
        if (String(item.attachment.mime || '').startsWith('image/')) {
          card.classList.add('stream-artifact-picture');
          const image = document.createElement('img');
          image.className = 'stream-artifact-image';
          image.src = item.attachment.path;
          image.alt = item.attachment.title || '聊天图片';
          image.setAttribute('loading', 'lazy');
          file.textContent = '查看原图：' + (item.attachment.title || '图片');
          copy.append(heading, file);
          card.append(image, copy);
        } else {
          const cover = document.createElement('span');
          cover.className = 'stream-artifact-cover';
          cover.textContent = 'DOC';
          if (chatPreferences.document_cards) { file.className = 'chat-document-card'; file.setAttribute('aria-label', '作品卡片：' + item.attachment.title); }
          file.textContent = '下载作品：' + item.attachment.title + (item.attachment.revision ? ' · 修订 ' + item.attachment.revision : '');
          copy.append(heading, file);
          card.append(cover, copy);
        }
        li.append(card);
      }
      if (mine && !item.retracted) {
        const edit = document.createElement('button');
        edit.type = 'button'; edit.textContent = '编辑'; edit.hidden = true;
        const retract = document.createElement('button');
        retract.type = 'button'; retract.textContent = '撤回'; retract.hidden = true;
        const controls = document.createElement('span');
        controls.className = 'message-edit-controls';
        const change = async (operation, text) => {
          const payload = {revision: item.revision || 1};
          if (operation === 'edit') payload.body = text;
          const wid = workspaceId(), cid = currentConversation.id;
          const result = await request('POST', `${socialBase()}/${cid}/messages/${item.id}/${operation}`, payload);
          if (workspaceId() !== wid || !currentConversation || currentConversation.id !== cid) return;
          if (result.status !== 200) { show('error', messageFor(result.body.error, '消息未更新，请重新打开后重试。')); return; }
          await loadSessions();
          await openSocialConversation(cid);
        };
        edit.addEventListener('click', () => {
          controls.replaceChildren();
          const input = document.createElement('textarea'); input.value = item.body || '';
          input.setAttribute('aria-label', '编辑消息'); input.maxLength = 4000;
          const save = document.createElement('button'); save.type = 'button'; save.textContent = '保存修改';
          save.addEventListener('click', () => {
            // Editing replaces text that is already on the other side, so this
            // button only opens the confirm step; the explicit confirm sends it.
            const draft = input.value;
            const note = document.createElement('span');
            note.className = 'message-edit-note';
            note.textContent = '保存后，这条已发出的消息会被新内容替换，其他人看到的是修改后的版本。';
            const confirm = document.createElement('button'); confirm.type = 'button'; confirm.textContent = '确认修改';
            confirm.addEventListener('click', () => change('edit', draft));
            const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '取消';
            cancel.addEventListener('click', () => controls.replaceChildren());
            controls.replaceChildren(note, confirm, cancel);
          });
          const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '取消';
          cancel.addEventListener('click', () => controls.replaceChildren());
          controls.append(input, save, cancel);
        });
        retract.addEventListener('click', () => {
          controls.replaceChildren();
          const confirm = document.createElement('button'); confirm.type = 'button'; confirm.textContent = '确认撤回';
          confirm.addEventListener('click', () => change('retract'));
          const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '取消';
          cancel.addEventListener('click', () => controls.replaceChildren());
          controls.append(confirm, cancel);
        });
        li.append(edit, retract, controls);
      }
      if (item.role !== 'agent' && !item.retracted) li.append(messageTools(item));
      if (item.role !== 'agent' && !item.retracted) li.append(reactionBar(item));
      if (item.role !== 'agent' && !item.retracted) {
        const more = document.createElement('button');
        more.type = 'button'; more.className = 'message-more'; more.textContent = '⋯';
        more.setAttribute('aria-label', '消息操作'); more.setAttribute('aria-haspopup', 'menu');
        const openAtMessage = () => {
          const rect = more.getBoundingClientRect();
          openMessageMenu(item, li, mine, rect.left, rect.bottom);
        };
        more.addEventListener('click', event => { event.stopPropagation(); openAtMessage(); });
        li.addEventListener('keydown', event => {
          if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') { event.preventDefault(); openAtMessage(); }
        });
        li.append(more);
        li.addEventListener('contextmenu', event => {
          if (selecting) return;
          event.preventDefault();
          openMessageMenu(item, li, mine, event.clientX, event.clientY);
        });
      }
      list.append(li);
    }
    scroller.scrollTop = keepScroll ? Math.max(0, oldTop + scroller.scrollHeight - oldHeight) : scroller.scrollHeight;
    return false;
  }

  function setDirectoryLink(session) {
    if (!session || session.source !== 'social') {
      document.getElementById('social-agent-members').hidden = true;
      document.getElementById('group-agent-action').hidden = true;
    }
    const link = document.getElementById('open-agent-dir');
    if (session && session.source === 'social') {
      link.href = '/members';
      link.textContent = '成员';
    } else {
      link.href = '/agents';
      link.textContent = '资料';
    }
  }

  let notificationSeq = 0;
  let notificationSnapshot = null;
  const notificationKind = document.getElementById('notifications-kind');
  const notificationUnread = document.getElementById('notifications-unread');

  function renderNotifications(body) {
    const badge = document.getElementById('notification-count');
    const toggle = document.getElementById('notifications-toggle');
    const text = notificationBadgeText(body.unread_count);
    if (badge) { badge.textContent = text; badge.hidden = !text; }
    if (toggle) toggle.setAttribute('aria-label', text ? `通知，${body.unread_count} 条未读` : '通知');
    const list = document.getElementById('notification-list');
    if (!list) return;
    const mentionsOnly = notificationKind?.value === 'mention';
    const items = (body.items || []).filter(item => (!mentionsOnly || item.kind === 'mention' || item.kind === 'messenger.mention')
      && (!notificationUnread?.checked || !item.read));
    list.replaceChildren(...items.map(item => {
      const li = document.createElement('li');
      const link = item.kind === 'follow_work' && item.path;
      const button = document.createElement(link ? 'a' : 'button');
      if (link) button.href = item.path;
      else button.type = 'button';
      button.className = 'notification-item' + (item.read ? '' : ' is-unread');
      button.dataset.notification = item.id;
      const summary = document.createElement('strong'); summary.textContent = notificationSummary(item);
      const excerpt = document.createElement('span'); excerpt.className = 'notification-excerpt'; excerpt.textContent = item.excerpt;
      const time = document.createElement('time'); time.textContent = formatSessionTime(item.created);
      button.append(summary, excerpt, time);
      button.addEventListener('click', async () => {
        const wid = workspaceId();
        if (link) {
          if (!item.read) request('POST', `/v1/workspaces/${wid}/notifications/read`, {notification_id: item.id});
          setNotificationsOpen(false);
          return;
        }
        if (!item.read) await request('POST', `/v1/workspaces/${wid}/notifications/read`, {notification_id: item.id});
        if (workspaceId() !== wid) return;
        setNotificationsOpen(false);
        const target = notificationTarget(item);
        if (target) { globalThis.location.assign(target); return; }
        if (item.conversation_id) {
          const opened = await openSocialConversation(item.conversation_id, {acknowledge: !item.message_id});
          if (opened && item.message_id && currentSource === 'social' && currentConversation?.id === item.conversation_id) {
            await jumpToMessage(item.message_id, status);
          }
        }
        await loadNotifications();
      });
      li.append(button);
      return li;
    }));
    const empty = document.getElementById('notifications-empty');
    if (empty) {
      empty.hidden = items.length > 0;
      empty.textContent = mentionsOnly
        ? (notificationUnread?.checked ? '暂无未读提及。' : '暂无提及。')
        : (notificationUnread?.checked ? '暂无未读通知。' : '暂无通知。');
    }
    const all = document.getElementById('notifications-read-all'); if (all) all.disabled = !(body.unread_count > 0);
  }

  async function loadNotifications() {
    const wid = workspaceId();
    if (!wid) return;
    const token = ++notificationSeq;
    let result;
    // Notifications are auxiliary: a failed fetch must never break the session list.
    try { result = await request('GET', `/v1/workspaces/${wid}/notifications`); } catch { return; }
    if (token !== notificationSeq || workspaceId() !== wid || result.status !== 200) return;
    notificationSnapshot = result.body;
    renderNotifications(notificationSnapshot);
  }

  // Live-ish delivery: poll the inbox while the tab is visible. No server push.
  const NOTIFICATION_POLL_MS = 30000;
  if (typeof globalThis.setInterval === 'function') {
    const handle = globalThis.setInterval(() => {
      if (document.visibilityState === 'hidden' || !currentUser) return;
      loadNotifications();
      loadDueReminders();
    }, NOTIFICATION_POLL_MS);
    if (handle && typeof handle.unref === 'function') handle.unref();
  }


  let dueSeq = 0;

  function renderDueReminders(state) {
    const panel = document.getElementById('due-reminders');
    const heading = document.getElementById('due-reminders-heading');
    const note = document.getElementById('due-reminders-note');
    const list = document.getElementById('due-reminders-list');
    if (!panel || !heading || !note || !list) return;
    const model = state || {};
    const today = model.today || [];
    const older = model.older || [];
    const failed = Boolean(model.failed);
    panel.hidden = !failed && today.length + older.length === 0;
    heading.textContent = failed ? '今天到点的提醒' : `今天到点的提醒 ${today.length} 条`;
    note.hidden = !failed && older.length === 0;
    note.textContent = failed ? '读不到到点的提醒。'
      : (older.length ? `另有 ${older.length} 条更早到点的提醒。` : '');
    if (failed) { list.replaceChildren(); return; }
    list.replaceChildren(...[...today, ...older].map(item => {
      const row = document.createElement('li');
      const link = document.createElement('a');
      link.href = '/automations';
      link.textContent = item.title || '提醒';
      const when = document.createElement('span');
      when.className = 'note';
      when.textContent = reminderDueLabel(item, Date.now());
      link.append(when);
      row.append(link);
      return row;
    }));
  }

  async function loadDueReminders() {
    const wid = workspaceId();
    if (!wid || !currentUser) return;
    const token = ++dueSeq;
    let result;
    try { result = await request('GET', `/v1/workspaces/${wid}/automations`); } catch { result = {status: 0, body: {}}; }
    if (token !== dueSeq || workspaceId() !== wid) return;
    if (result.status !== 200) { renderDueReminders({failed: true}); return; }
    renderDueReminders(dueReminders(result.body.items || [], currentUser, Date.now()));
  }

  function setNotificationsOpen(open) {
    const panel = document.getElementById('notifications-panel');
    const toggle = document.getElementById('notifications-toggle');
    if (panel) panel.hidden = !open;
    if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  const workspaceEvents=mountWorkspaceEvents(document,{onInvalidate:async(event)=>{
    if(event.workspace!==workspaceId()||document.visibilityState==='hidden')return;
    await loadSessions();
    if(event.workspace!==workspaceId())return;
    if(!event.initial&&event.changed.includes('social')&&currentSource==='social'&&currentConversation){
      const banner=document.getElementById('conversation-live-update');if(banner)banner.hidden=false;
    }
  }});
  document.getElementById('conversation-live-load')?.addEventListener('click',async()=>{
    if(currentSource==='social'&&currentConversation)await openSocialConversation(currentConversation.id);
    const banner=document.getElementById('conversation-live-update');if(banner)banner.hidden=true;
  });
  let sessionsRequest = 0, sessionsWorkspace = null, sessionsUser = null;
  async function loadSessions() {
    const sequence = ++sessionsRequest;
    const user = currentUser;
    loadNotifications();
    loadDueReminders();
    const id = workspaceId();
    if (id !== sessionsWorkspace || user !== sessionsUser || !id) {
      setSessionsStatus('正在加载对话…');
      sessionsWorkspace = id; sessionsUser = user;
      sessions = []; agents = []; members = []; artifacts = []; socialConversations = [];
      renderSessions();
    }
    if (!id) return;
    const current = () => sequence === sessionsRequest && id === workspaceId() && user === currentUser;
    const [listed, social, people, works] = await Promise.all([
      request('GET', `/v1/workspaces/${id}/agents?limit=100`),
      request('GET', `/v1/workspaces/${id}/social/conversations?limit=100`),
      request('GET', `/v1/workspaces/${id}/members`),
      request('GET', `/v1/workspaces/${id}/artifacts?limit=100`),
    ]);
    if (!current()) return;
    if (listed.status !== 200) {
      setSessionsStatus('无法加载智能体对话，请重试。');
      return;
    }
    const nextAgents = listed.body.items || [];
    const results = await Promise.all(nextAgents.map(agent =>
      request('GET', `/v1/workspaces/${id}/agents/${agent.id}/conversations?limit=100`)
        .then(result => ({agent, result}))));
    if (!current()) return;
    agents = nextAgents;
    members = people.status === 200 ? people.body.items || [] : [];
    artifacts = works.status === 200 ? works.body.items || [] : [];
    socialConversations = social.status === 200 ? social.body.items || [] : [];
    const agentRows = [];
    for (const {agent, result} of results) {
      if (result.status !== 200) continue;
      for (const row of result.body.items || []) {
        agentRows.push({...row, agent});
      }
    }
    sessions = mergeSessions(agentRows, socialConversations, currentUser && currentUser.id);
    const incomplete = social.status !== 200 || results.some(({result}) => result.status !== 200);
    setSessionsStatus(incomplete ? '部分对话加载失败，请重试。' : '');
    renderSessions();
    // The first SSE snapshot may immediately refresh; do not invalidate the
    // initial directory before deep-link resolution has a committed snapshot.
    workspaceEvents.start(id);
  }

  function memberRow(name, note, kind) {
    const row = document.createElement('li');
    row.className = 'group-info-member';
    row.dataset.kind = kind;
    const avatar = document.createElement('span');
    avatar.className = 'group-info-member-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = kind === 'empty' ? '+' : leadGlyph(name);
    const text = document.createElement('span');
    const strong = document.createElement('strong');
    strong.textContent = name;
    const small = document.createElement('small');
    small.textContent = note;
    text.append(strong, small);
    row.append(avatar, text);
    return row;
  }

  function setGroupInfoTab(which) {
    const agentsTab = document.getElementById('group-info-tab-agents');
    const peopleTab = document.getElementById('group-info-tab-people');
    agentsTab.setAttribute('aria-selected', String(which === 'agents'));
    peopleTab.setAttribute('aria-selected', String(which === 'people'));
    document.getElementById('group-info-agents').hidden = which !== 'agents';
    const autoNote = document.getElementById('group-agent-auto-reply-note');
    if (autoNote) autoNote.hidden = which !== 'agents';
    document.getElementById('group-info-people').hidden = which !== 'people';
  }

  const pendingAutoReplies = new Set();

  function renderGroupAgent(conversation, agent) {
    const mode = agent.auto_reply ? '自动回复已开启' : '自动回复已关闭';
    const row = memberRow(agent.name, agent.archived ? '已归档' : mode, 'agent');
    if (!agent.mine || agent.archived) return row;
    const wid = workspaceId();
    const key = `${wid}/${conversation.id}/${agent.id}`;
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'group-info-switch';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-label', `${agent.name}的自动回复`);
    toggle.setAttribute('aria-checked', String(Boolean(agent.auto_reply)));
    toggle.setAttribute('aria-describedby', 'group-agent-auto-reply-note');
    toggle.disabled = pendingAutoReplies.has(key);
    toggle.addEventListener('click', async () => {
      if (workspaceId() !== wid || currentConversation?.id !== conversation.id || pendingAutoReplies.has(key)) return;
      const notice = document.getElementById('group-agent-auto-reply-status');
      const activeConversation = currentConversation;
      const enabled = toggle.getAttribute('aria-checked') !== 'true';
      pendingAutoReplies.add(key);
      toggle.disabled = true;
      if (notice) notice.hidden = true;
      try {
        const path = `/v1/workspaces/${wid}/social/conversations/${conversation.id}/agents/${encodeURIComponent(agent.id)}/auto-reply`;
        const result = await request('POST', path, {auto_reply: enabled});
        if (workspaceId() !== wid || currentConversation?.id !== conversation.id) return;
        if (result.status !== 200 || result.body.auto_reply !== enabled) throw new Error('Automatic replies were not updated');
        const currentAgent = currentConversation.agent_members?.find(item => item.id === agent.id && item.mine);
        if (currentAgent) currentAgent.auto_reply = enabled;
        if (currentConversation === activeConversation && currentAgent === agent) {
          toggle.setAttribute('aria-checked', String(enabled));
          const description = row.children[1]?.children[1];
          if (description) description.textContent = enabled ? '自动回复已开启' : '自动回复已关闭';
        }
      } catch {
        if (notice && workspaceId() === wid && currentConversation?.id === conversation.id) {
          notice.textContent = '自动回复设置保存失败，请重试。';
          notice.hidden = false;
        }
      } finally {
        pendingAutoReplies.delete(key);
        toggle.disabled = false;
        if (workspaceId() === wid && currentConversation?.id === conversation.id && currentConversation !== activeConversation) {
          setGroupInfo(currentConversation);
        }
      }
    });
    row.append(toggle);
    return row;
  }

  function setGroupInfo(conversation) {
    const toggle = document.getElementById('group-info-toggle');
    const panel = document.getElementById('group-info-panel');
    if (!toggle || !panel) return;
    const group = Boolean(conversation && conversation.kind === 'group');
    toggle.hidden = !group;
    if (!group) {
      panel.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
      return;
    }
    const title = conversationLabel(conversation, currentUser && currentUser.id);
    const counts = groupInfoCounts(conversation);
    document.getElementById('group-info-title').textContent = title;
    document.getElementById('group-info-avatar').textContent = leadGlyph(title, '群');
    document.getElementById('group-info-count').textContent = counts.text;
    document.getElementById('group-info-tab-agents').textContent = `智能体 (${counts.agents})`;
    document.getElementById('group-info-tab-people').textContent = `成员 (${counts.people})`;
    const agentList = document.getElementById('group-info-agents');
    agentList.replaceChildren(...(conversation.agent_members || []).map(agent => renderGroupAgent(conversation, agent)));
    if (!agentList.children.length) agentList.append(memberRow('还没有智能体', '创建群聊时可以加入工作区智能体', 'empty'));
    const peopleList = document.getElementById('group-info-people');
    peopleList.replaceChildren(...(conversation.members || []).map(member =>
      memberRow(member.username, currentUser && member.user_id === currentUser.id ? '你' : '工作区成员', 'person')));
    const pinned = sessions.some(item => item.source === 'social' && item.id === conversation.id && item.pinned);
    document.getElementById('group-info-pin').setAttribute('aria-checked', String(pinned));
  }

  function setGroupInfoOpen(open) {
    const toggle = document.getElementById('group-info-toggle');
    const panel = document.getElementById('group-info-panel');
    if (!toggle || !panel) return;
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  }

  function setSocialHeaderTools(social) {
    const invite = document.getElementById('chat-invite');
    const unavailable = document.getElementById('chat-invite-unavailable');
    const multi = document.getElementById('multi-select-toggle');
    if (invite) invite.hidden = !social;
    if (unavailable) unavailable.hidden = social;
    if (multi) multi.hidden = !social;
    if (!social) {
      selecting = false; selectedMessages.clear(); syncForwardBar();
      renderPinned([]);
      const panel = document.getElementById('chat-invite-panel'); if (panel) panel.hidden = true;
    }
  }

  async function openAgentConversation(agentId, conversationId) {
    socialOpen += 1;
    setSocialHistory(null);
    agentMentions.clear();
    voiceRecorder.clear();
    clearVoicePlayers();
    setSocialHeaderTools(false);
    setGroupInfo(null);
    const pin = document.getElementById('pin-conversation');
    if (pin) pin.hidden = true;
    syncMuteButton();
    const agent = agents.find(item => item.id === agentId);
    if (!agent) {
      show('error', '找不到这个智能体。');
      return;
    }
    currentAgent = agent;
    currentSource = 'agent';
    voiceRecorder.refresh();
    document.getElementById('social-agent-members').hidden = true;
    applyChatIdentity(document, agent.name);
    setDirectoryLink({source: 'agent'});
    const result = await request('GET', `/v1/workspaces/${workspaceId()}/agents/${agentId}/conversations/${conversationId}`);
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法打开对话。'));
      return;
    }
    if (!currentConversation || currentConversation.id !== result.body.conversation.id) {
      const autoReplyNotice = document.getElementById('group-agent-auto-reply-status');
      if (autoReplyNotice) autoReplyNotice.hidden = true;
      const panel = document.getElementById('conversation-search-panel'); if (panel) panel.hidden = true;
      const hits = document.getElementById('conversation-search-results'); if (hits) hits.replaceChildren();
    }
    currentConversation = result.body.conversation;
    writeHash({workspace: workspaceId(), agent: agentId, conversation: conversationId});
    setSessionsOpen(false);
    const pending = renderAgentMessages(result.body.items);
    const finished = (result.body.items || []).filter(item => item.role === 'assistant' && item.status === 'succeeded');
    if (currentConversation.unread_count > 0 && finished.length && document.visibilityState !== 'hidden') {
      const wid = workspaceId(), cid = conversationId;
      const acknowledged = await request('POST', `/v1/workspaces/${wid}/agents/${agentId}/conversations/${cid}/read`,
        {message_id: finished[finished.length - 1].id});
      if (acknowledged.status === 200 && workspaceId() === wid) {
        const session = sessions.find(item => item.source === 'agent' && item.id === cid);
        if (session) session.unread_count = acknowledged.body.unread_count;
      }
    }
    renderSessions();
    if (pending) schedulePoll();
    else stopPolling();
  }

  async function openSocialConversation(conversationId, {acknowledge = true} = {}) {
    const open = ++socialOpen;
    const wid = workspaceId();
    if (currentConversation?.id !== conversationId) {
      setSocialHistory(null);
      voiceRecorder.clear();
    }
    currentAgent = null;
    currentSource = 'social';
    stopPolling();
    const result = await request('GET', `${socialBase()}/${conversationId}`);
    if (open !== socialOpen || workspaceId() !== wid || currentSource !== 'social') return false;
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法打开会话。'));
      return false;
    }
    if (!currentConversation || currentConversation.id !== result.body.conversation.id) {
      const panel = document.getElementById('conversation-search-panel'); if (panel) panel.hidden = true;
      const hits = document.getElementById('conversation-search-results'); if (hits) hits.replaceChildren();
    }
    currentConversation = result.body.conversation;
    setSocialHistory({wid, cid: conversationId, cursor: result.body.cursor ?? null});
    agentMentions.refresh();
    voiceRecorder.refresh();
    setSessionsOpen(false);
    const pin = document.getElementById('pin-conversation');
    syncMuteButton(currentConversation);
    if (pin) { pin.hidden = false; pin.textContent = sessions.find(item => item.id === conversationId && item.pinned) ? '取消置顶' : '置顶会话'; }
    const agentNote = document.getElementById('social-agent-members');
    agentNote.textContent = groupAgentSummary(currentConversation);
    agentNote.hidden = !agentNote.textContent;
    applyChatIdentity(document, conversationLabel(
      currentConversation, currentUser && currentUser.id), currentConversation);
    setDirectoryLink({source: 'social'});
    writeHash({workspace: workspaceId(), social: conversationId});
    if (selecting && (!lastSocialItems.length || lastSocialItems[0].conversation_id !== conversationId)) {
      selecting = false; selectedMessages.clear(); syncForwardBar();
    }
    renderPinned(result.body.pinned_messages || []);
    setSocialHeaderTools(true);
    setGroupInfo(currentConversation);
    messageUtilities.refreshAnnouncement();
    setChatSubtitle(currentConversation.kind === 'group' ? groupInfoCounts(currentConversation).text
      : '单聊 · ' + ((currentConversation.members || []).length) + ' 人');
    renderSocialMessages(result.body.items);
    renderGroupReplyAction(result.body.agent_replies || []);
    // Acknowledge only the last message actually rendered, not messages that
    // arrived after this snapshot, and never consume unread in a hidden tab.
    const shown = result.body.items || [];
    if (acknowledge && currentConversation.unread_count > 0 && shown.length && document.visibilityState !== 'hidden') {
      const acknowledged = await request('POST', `${socialBase()}/${conversationId}/read`,
        Number.isSafeInteger(shown[shown.length - 1].seq)
          ? {seq: shown[shown.length - 1].seq}
          : {message_id: shown[shown.length - 1].id});
      if (acknowledged.status === 200) {
        const session = sessions.find(item => item.source === 'social' && item.id === conversationId);
        if (session) session.unread_count = acknowledged.body.unread_count;
      }
    }
    renderSessions();
    if ((result.body.agent_replies || []).some(item => ['queued', 'running'].includes(item.status))) schedulePoll();
    return open === socialOpen && workspaceId() === wid && currentSource === 'social';
  }

  function schedulePoll() {
    stopPolling();
    pollTimer = globalThis.setTimeout(() => {
      if (currentConversation && currentAgent && currentSource === 'agent') {
        openAgentConversation(currentAgent.id, currentConversation.id);
      } else if (currentConversation && currentSource === 'social' && !socialHistory?.readingHistory) {
        openSocialConversation(currentConversation.id);
      }
    }, 2000);
  }

  function closeComposeMenu() {
    const menu = document.getElementById('compose-menu');
    const button = document.getElementById('new-conversation');
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  }

  function selectedMemberCount() {
    return document.querySelectorAll('#member-choices input:checked').length;
  }

  function syncComposeCreate() {
    const button = document.getElementById('compose-dialog-submit');
    button.disabled = !composeCreateEnabled({
      composeMode,
      groupMode,
      selectedCount: selectedMemberCount(),
      selectedHumanCount: document.querySelectorAll('#member-choices input[name="member"]:checked').length,
      templateSelected: document.querySelectorAll('#team-template-choices input:checked').length === 1,
    });
  }

  function applyMemberFilter() {
    const input = document.getElementById('compose-member-search');
    const needle = (input.value || '').trim().toLocaleLowerCase();
    const labels = [...document.querySelectorAll('#member-choices label')];
    let visible = 0;
    for (const label of labels) {
      const show = !needle || label.textContent.trim().toLocaleLowerCase().includes(needle);
      label.hidden = !show;
      if (show) visible += 1;
    }
    const empty = document.getElementById('compose-members-empty');
    if (!labels.length) {
      empty.hidden = false;
      empty.textContent = '没有可邀请的工作区成员。';
    } else if (!visible) {
      empty.hidden = false;
      empty.textContent = '没有匹配的成员。';
    } else {
      empty.hidden = true;
    }
  }

  function syncSelectedCount() {
    document.getElementById('compose-selected-count').textContent = composeSelectedLabel(selectedMemberCount());
    syncComposeCreate();
  }

  function setGroupMode(mode) {
    groupMode = mode === 'team' ? 'team' : 'custom';
    for (const button of document.querySelectorAll('#compose-mode-switch [data-group-mode]')) {
      button.setAttribute('aria-selected', button.dataset.groupMode === groupMode ? 'true' : 'false');
    }
    const team = composeMode === 'group' && groupMode === 'team';
    document.getElementById('compose-team-note').hidden = !team;
    const templates = document.getElementById('compose-team-templates');
    if (templates) templates.hidden = !team;
    if (team) loadTeamTemplates();
    document.getElementById('compose-member-picker').hidden = team;
    if (composeMode === 'group') {
      document.getElementById('compose-title-label').hidden = team;
    }
    syncComposeCreate();
  }

  let teamTemplates = null;
  async function loadTeamTemplates() {
    const holder = document.getElementById('team-template-choices');
    if (!holder) return;
    if (teamTemplates === null) {
      let result;
      try { result = await request('GET', '/v1/team-templates'); } catch { result = {status: 0, body: {}}; }
      if (result.status !== 200) {
        document.getElementById('team-templates-empty').hidden = false;
        return;
      }
      teamTemplates = result.body.items || [];
    }
    if (holder.children.length) return;
    for (const template of teamTemplates) {
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'radio'; box.name = 'team-template'; box.value = template.slug;
      const text = `${template.name} · ${template.agents.map(agent => agent.name).join('、')}`;
      label.append(box, document.createTextNode(text));
      holder.append(label);
    }
    document.getElementById('team-templates-empty').hidden = teamTemplates.length > 0;
    syncComposeCreate();
  }

  function closeComposeDialog() {
    document.getElementById('compose-dialog').hidden = true;
    document.getElementById('compose-social-form').reset();
    setGroupMode('custom');
    applyMemberFilter();
    syncSelectedCount();
  }

  function renderMemberChoices(single) {
    const holder = document.getElementById('member-choices');
    holder.replaceChildren();
    const choices = groupPickerChoices(members, currentUser && currentUser.id, single ? [] : agents);
    for (const member of choices) {
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = single ? 'radio' : 'checkbox';
      box.name = member.kind === 'agent' ? 'agent-member' : 'member';
      box.value = member.id;
      const text = document.createElement('span');
      text.className = 'choice-label';
      text.textContent = member.label;
      label.append(box, text);
      holder.append(label);
    }
    applyMemberFilter();
    syncSelectedCount();
  }

  function openComposeDialog(mode) {
    closeComposeMenu();
    composeMode = mode;
    const dialog = document.getElementById('compose-dialog');
    dialog.hidden = false;
    const isGroup = mode === 'group';
    document.getElementById('compose-dialog-title').textContent = isGroup ? '新建群组' : '添加联系人';
    document.getElementById('compose-members-legend').textContent = isGroup ? '成员' : '选择一位成员，开始单聊';
    document.getElementById('compose-intro').hidden = !isGroup;
    document.getElementById('compose-mode-switch').hidden = !isGroup;
    document.getElementById('compose-title-label').hidden = !isGroup;
    document.getElementById('compose-member-tools').hidden = !isGroup;
    document.getElementById('compose-team-note').hidden = true;
    document.getElementById('compose-member-picker').hidden = false;
    if (!isGroup) document.getElementById('compose-title').value = '';
    document.getElementById('compose-member-search').value = '';
    setGroupMode('custom');
    renderMemberChoices(mode === 'contact');
  }

  function setSearchTab(name) {
    searchTab = name;
    if (name !== 'messages') searchConversation = '';
    for (const tab of document.querySelectorAll('#search-panel [data-search-tab]')) {
      tab.setAttribute('aria-selected', tab.dataset.searchTab === name ? 'true' : 'false');
    }
  }

  function openSearchPanel(tab, conversationId = '') {
    searchConversation = conversationId;
    searchConversationTitle = document.getElementById('chat-title').textContent;
    document.getElementById('search-panel').hidden = false;
    document.getElementById('search-close').hidden = false;
    document.getElementById('conversation-group').hidden = true;
    document.getElementById('pinned-group').hidden = true;
    document.getElementById('compose-dialog').hidden = true;
    closeComposeMenu();
    // The panel is a child of the session pane, which the narrow stylesheet
    // paints only in the sessions-open state. Opening search has to reveal it
    // there, or the panel is laid out inside a display:none parent.
    if (narrowScreen()) setSessionsOpen(true);
    if (tab) setSearchTab(tab);
    renderSearch();
  }

  function closeSearchPanel() {
    searchSeq++;
    searchConversation = '';
    document.getElementById('search-panel').hidden = true;
    document.getElementById('search-close').hidden = true;
    document.getElementById('conversation-group').hidden = false;
    document.getElementById('session-search').value = '';
    setSearchTab('all');
    // Narrow screens show the conversation when one is open and the list
    // otherwise; dropping the state unconditionally would blank both.
    if (narrowScreen()) setSessionsOpen(!currentConversation);
  }

  function addSearchSection(root, title, items, onPick) {
    if (!items.length) return;
    const section = document.createElement('section');
    section.className = 'search-section';
    const heading = document.createElement('h3');
    heading.textContent = title;
    const list = document.createElement('ul');
    for (const item of items) {
      const li = document.createElement('li');
      const button = document.createElement(item.href ? 'a' : 'button');
      if (item.href) button.href = item.href;
      else button.type = 'button';
      const name = document.createElement('span');
      name.className = 'title';
      name.textContent = item.title;
      button.append(name);
      if (item.preview) {
        const preview = document.createElement('span');
        preview.className = 'preview';
        preview.textContent = item.preview;
        button.append(preview);
      }
      if (!item.href) button.addEventListener('click', () => onPick(item));
      li.append(button);
      list.append(li);
    }
    section.append(heading, list);
    root.append(section);
  }

  function artifactKind(item) {
    return item.kind || item.public_kind || '';
  }

  function artifactItems(kind) {
    return artifacts.filter(item => !kind || artifactKind(item) === kind).map(item => ({
      type: 'artifact',
      id: item.id,
      title: item.title || '未命名',
      preview: artifactKind(item) || '作品',
      href: '/space',
    }));
  }

  function contactItems() {
    return memberChoices(members, currentUser && currentUser.id).map(member => ({
      type: 'contact',
      id: member.user_id,
      title: member.username,
      preview: '工作区成员',
    }));
  }

  function groupItems() {
    return socialConversations.filter(row => row.kind === 'group').map(row => ({
      type: 'social',
      id: row.id,
      title: conversationLabel(row, currentUser && currentUser.id),
      preview: '群聊',
    }));
  }

  function agentItems() {
    return agents.map(agent => ({
      type: 'agent',
      id: agent.id,
      title: agent.name,
      preview: agent.summary || '智能体',
    }));
  }

  async function renderSearch({reuseMessages = false, appendResources = false} = {}) {
    const query = (document.getElementById('session-search').value || '').trim();
    const results = document.getElementById('search-results');
    const empty = document.getElementById('search-empty');
    const note = document.getElementById('search-source-note');
    results.replaceChildren();
    empty.hidden = true;
    note.hidden = Boolean(query) && !searchConversation;
    note.textContent = searchConversation
      ? '仅搜索当前对话：' + searchConversationTitle
      : '以下是当前工作区里已有的内容，不是站外推荐。';
    const seq = ++searchSeq;

    if (searchTab === 'files' || searchTab === 'links') {
      const params = new URLSearchParams({kind: searchTab, q: query, limit: '20'});
      if (appendResources && resourceCursor) params.set('cursor', resourceCursor);
      const found = await request('GET', `/v1/workspaces/${workspaceId()}/search/resources?${params}`);
      if (seq !== searchSeq) return;
      if (found.status !== 200) { empty.hidden = false; empty.textContent = '无法加载搜索结果。'; return; }
      resourceItems = appendResources ? resourceItems.concat(found.body.items || []) : (found.body.items || []);
      resourceCursor = found.body.cursor || '';
      addSearchSection(results, searchTab === 'files' ? '文件' : '链接', resourceItems, () => {});
      empty.hidden = Boolean(resourceItems.length); empty.textContent = '没有匹配的结果。';
      const more = document.getElementById('search-more');
      if (more) { more.hidden = !resourceCursor; more.disabled = false; }
      return;
    }
    if (searchTab === 'messages' && !query) {
      empty.hidden = false;
      empty.textContent = searchConversation
        ? '输入关键词，搜索当前对话中你有权查看的消息。'
        : '输入关键词，搜索你在这个工作区里有权查看的消息。';
      return;
    }

    let messageItems = [];
    if ((searchTab === 'messages' || searchTab === 'all') && query) {
      if (!reuseMessages) await messageSearch.load(query, searchConversation);
      if (seq !== searchSeq) return;
      const state = messageSearch.state;
      if (state.error && searchTab === 'messages' && !state.hits.length) {
        empty.hidden = false;
        empty.textContent = state.error;
        applySearchMore(document.getElementById('search-more'), {cursor: '', loading: false});
        return;
      }
      messageItems = state.hits;
    }

    const filtered = (items) => items.filter(item => matchesQuery(item, query));
    const sections = [];
    if (searchTab === 'all' || searchTab === 'agents') {
      sections.push(['智能体', filtered(agentItems())]);
    }
    if (searchTab === 'all' || searchTab === 'contacts') {
      sections.push(['联系人', filtered(contactItems())]);
    }
    if (searchTab === 'all' || searchTab === 'groups') {
      sections.push(['群组', filtered(groupItems())]);
    }
    if (searchTab === 'all' || searchTab === 'artifacts') {
      sections.push(['Artifacts', filtered(artifactItems())]);
    }
    if (searchTab === 'documents') {
      sections.push(['云文档', filtered(artifactItems('document'))]);
    }
    if (searchTab === 'media') {
      sections.push(['媒体', filtered(artifactItems('media'))]);
    }
    if (searchTab === 'all' || searchTab === 'messages') {
      sections.push(['消息', messageItems]);
    }

    let total = 0;
    for (const [title, items] of sections) {
      total += items.length;
      addSearchSection(results, title, items, async (item) => {
        closeSearchPanel();
        if (item.type === 'agent') {
          const first = sessions.find(row => row.source === 'agent' && row.agent_id === item.id);
          if (first) await openAgentConversation(item.id, first.id);
          else {
            currentAgent = agents.find(entry => entry.id === item.id) || null;
            currentConversation = null;
            currentSource = 'agent';
            socialOpen += 1;
            setSocialHistory(null);
            if (currentAgent) applyChatIdentity(document, currentAgent.name, null,
              currentAgent.id === personalAgentId ? personalLook : null);
            document.getElementById('chat-empty').hidden = false;
            document.getElementById('message-list').replaceChildren();
            writeHash({workspace: workspaceId(), agent: item.id});
          }
        } else if (item.type === 'social' || item.kind === 'social') {
          const opened = await openSocialConversation(item.conversationId || item.id, {acknowledge: !item.messageId});
          if (opened && item.messageId) await jumpToMessage(item.messageId, status);
        } else if (item.type === 'agent-message' || item.kind === 'agent') {
          const session = sessions.find(row => row.source === 'agent' && row.id === item.conversationId);
          if (session) await openAgentConversation(session.agent_id, session.id);
        } else if (item.type === 'contact') {
          openComposeDialog('contact');
          const box = document.querySelector(`#member-choices input[value="${item.id}"]`);
          if (box) box.checked = true;
        }
      });
    }
    if (!total) {
      empty.hidden = false;
      empty.textContent = query ? '当前工作区里没有匹配的结果。' : '当前工作区里还没有可列出的内容。';
    }
    const paged = searchTab === 'messages' || searchTab === 'all';
    if (paged && query && messageSearch.state.error) {
      empty.hidden = false;
      empty.textContent = messageSearch.state.error;
    }
    applySearchMore(
      document.getElementById('search-more'),
      paged && query ? messageSearch.state : {cursor: '', loading: false},
    );
  }

  async function startHomepageConversation(index) {
    const result = await request('POST', '/v1/agent-homepages/start', {quick_start: index}, {
      'Idempotency-Key': idempotencyKey('home-start-'),
    });
    if (result.status !== 200 && result.status !== 201) {
      show('error', messageFor(
        result.body && result.body.error,
        result.status === 401
          ? '请先登录，再从公开主页发起对话。'
          : '无法从公开主页发起对话。只有工作区成员可以，且需要先打开该公开主页。',
      ));
      return false;
    }
    const conversation = result.body && result.body.conversation;
    if (!conversation || !conversation.id || !conversation.agent_id || !conversation.workspace_id) {
      show('error', '无法从公开主页发起对话。');
      return false;
    }
    if ([...workspaceSelect.options].some(option => option.value === conversation.workspace_id)) {
      workspaceSelect.value = conversation.workspace_id;
    }
    await loadSessions();
    await openAgentConversation(conversation.agent_id, conversation.id);
    return true;
  }

  async function load() {
    const session = await request('GET', '/v1/auth/session');
    if (session.status !== 200) {
      currentUser = null;
      currentConversation = null;
      socialOpen += 1;
      setSocialHistory(null);
      voiceRecorder.refresh();
      clearVoicePlayers();
      loginPanel.hidden = false;
      mainPanel.hidden = true;
      document.getElementById('session-pane').hidden = true;
      document.body.classList.remove('chat-open');
      setSessionsOpen(false);
      show('', '');
      return;
    }
    currentUser = session.body.user;
    loginPanel.hidden = true;
    mainPanel.hidden = false;
    document.getElementById('session-pane').hidden = false;
    document.body.classList.add('chat-open');
    setSessionsOpen(true);
    document.getElementById('whoami').textContent = currentUser.username;
    if (!sessions.length) setSessionsStatus('正在加载对话…');
    // Personal-agent initialization may create the workspace returned by the list.
    const personalAndWorkspaces = request('POST', '/v1/personal-agent').then(async personal => {
      const listed = await request('GET', '/v1/workspaces?limit=100');
      return {personal, listed};
    });
    const [{personal, listed}, onboarding, settings] = await Promise.all([
      personalAndWorkspaces,
      request('GET', '/v1/onboarding'),
      request('GET', '/v1/settings'),
    ]);
    const banner = document.getElementById('onboarding-banner');
    if (banner && onboarding.status === 200) {
      banner.hidden = Boolean(onboarding.body.onboarding && onboarding.body.onboarding.completed);
    }

    const personalWorkspace = personal.status === 200 && personal.body.personal_agent
      ? personal.body.personal_agent.workspace.id : '';
    const personalEntity = personal.status === 200 ? personal.body.personal_agent : null;
    personalAgentId = personalEntity && personalEntity.agent ? personalEntity.agent.id : '';
    personalLook = personalEntity ? personalEntity.look || null : null;
    if (settings.status === 200 && settings.body?.settings?.values) chatPreferences = settings.body.settings.values;
    const stored = settings.status === 200 && settings.body && settings.body.settings
      && settings.body.settings.values && settings.body.settings.values.send_shortcut;
    sendShortcut = stored === 'mod_enter' ? 'mod_enter' : 'enter';
    const storedLanguage = settings.status === 200 && settings.body && settings.body.settings
      && settings.body.settings.values && settings.body.settings.values.chat_language;
    chatLanguage = typeof storedLanguage === 'string' ? storedLanguage : 'auto';
    document.getElementById('chat-body').dataset.sendShortcut = sendShortcut;
    if (listed.status !== 200) {
      setSessionsStatus('无法加载工作区，请重试。');
      return;
    }
    workspaces = listed.body.items || [];
    const wanted = hashParams().workspace || personalWorkspace || workspaceSelect.value;
    workspaceSelect.replaceChildren();
    for (const space of workspaces) {
      const option = document.createElement('option');
      option.value = space.id;
      option.textContent = space.name;
      workspaceSelect.append(option);
    }
    if (wanted && [...workspaceSelect.options].some(option => option.value === wanted)) {
      workspaceSelect.value = wanted;
    }
    if (!workspaces.length) {
      setSessionsStatus('');
      document.getElementById('conversations-empty').hidden = false;
      document.getElementById('chat-empty').hidden = false;
      show('', '');
      return;
    }
    await loadSessions();
    const homepageStart = homepageStartIndex();
    if (homepageStart !== null) {
      const started = await startHomepageConversation(homepageStart);
      const stripped = stripHomepageStartQuery(location.pathname, location.search, location.hash);
      if (stripped.changed) history.replaceState(null, '', stripped.href);
      if (started) {
        show('', '');
        return;
      }
    }
    const start = hashParams();
    if (start.social) {
      await openSocialConversation(start.social);
    } else if (start.agent && start.conversation) {
      await openAgentConversation(start.agent, start.conversation);
    } else if (start.agent) {
      const first = sessions.find(row => row.source === 'agent' && row.agent_id === start.agent);
      if (first) await openAgentConversation(start.agent, first.id);
      else {
        currentAgent = agents.find(item => item.id === start.agent) || null;
        currentSource = 'agent';
        socialOpen += 1;
        setSocialHistory(null);
        if (currentAgent) applyChatIdentity(document, currentAgent.name, null,
          currentAgent.id === personalAgentId ? personalLook : null);
        document.getElementById('chat-empty').hidden = false;
        writeHash({workspace: workspaceId(), agent: start.agent});
      }
    } else if (sessions.length && !narrowScreen()) {
      const first = sessions[0];
      if (first.source === 'social') await openSocialConversation(first.id);
      else await openAgentConversation(first.agent_id, first.id);
    }
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

  const multiToggle = document.getElementById('multi-select-toggle');
  if (multiToggle) multiToggle.addEventListener('click', () => setSelecting(!selecting));
  const forwardCancel = document.getElementById('forward-cancel');
  if (forwardCancel) forwardCancel.addEventListener('click', () => setSelecting(false));
  const forwardTarget = document.getElementById('forward-target');
  if (forwardTarget) forwardTarget.addEventListener('change', syncForwardBar);
  const forwardSubmit = document.getElementById('forward-submit');
  if (forwardSubmit) forwardSubmit.addEventListener('click', async () => {
    const cid = currentConversation && currentConversation.id, target = forwardTarget.value;
    const ids = lastSocialItems.filter(item => selectedMessages.has(item.id)).map(item => item.id);
    if (!cid || !target || !ids.length) return;
    forwardSubmit.disabled = true;
    const result = await request('POST', `${socialBase()}/${cid}/forward`,
      {message_ids: ids, target_conversation_id: target}, {'Idempotency-Key': idempotencyKey('forward-')});
    if (result.status !== 201 && result.status !== 200) {
      show('error', messageFor(result.body.error, '转发失败。'));
      syncForwardBar();
      return;
    }
    setSelecting(false);
    show('ok', `已转发 ${ids.length} 条消息。`);
    await loadSessions();
  });
  const chatInvite = document.getElementById('chat-invite');
  if (chatInvite) chatInvite.addEventListener('click', () => {
    const panel = document.getElementById('chat-invite-panel');
    panel.hidden = !panel.hidden;
    chatInvite.setAttribute('aria-expanded', panel.hidden ? 'false' : 'true');
    document.getElementById('chat-invite-result').textContent = '';
  });
  const inviteClose = document.getElementById('chat-invite-close');
  if (inviteClose) inviteClose.addEventListener('click', () => {
    document.getElementById('chat-invite-panel').hidden = true;
    if (chatInvite) chatInvite.setAttribute('aria-expanded', 'false');
  });
  const chatInviteForm = document.getElementById('chat-invite-form');
  if (chatInviteForm) chatInviteForm.addEventListener('submit', async event => {
    event.preventDefault();
    const out = document.getElementById('chat-invite-result');
    const result = await request('POST', `/v1/workspaces/${workspaceId()}/invites`, {
      role: 'member', expires_in: 7 * 86400, max_uses: 1,
      requires_approval: document.getElementById('chat-invite-approval').checked,
    });
    if (result.status !== 201) {
      out.textContent = result.status === 404 || result.status === 403
        ? '只有工作区所有者或管理员可以生成邀请。' : messageFor(result.body.error, '无法生成邀请。');
      return;
    }
    out.textContent = `邀请令牌只显示一次：${result.body.token}`;
  });
  for (const control of [notificationKind, notificationUnread]) {
    control?.addEventListener('change', () => {
      if (notificationSnapshot) renderNotifications(notificationSnapshot);
    });
  }
  const notificationsToggle = document.getElementById('notifications-toggle');
  if (notificationsToggle) notificationsToggle.addEventListener('click', async () => {
    const panel = document.getElementById('notifications-panel');
    const open = Boolean(panel && panel.hidden);
    setNotificationsOpen(open);
    if (open) await loadNotifications();
  });
  const readAll = document.getElementById('notifications-read-all');
  if (readAll) readAll.addEventListener('click', async () => {
    const wid = workspaceId();
    readAll.disabled = true;
    const result = await request('POST', `/v1/workspaces/${wid}/notifications/read`, {all: true});
    if (result.status !== 200) { show('error', '无法标记通知为已读。'); readAll.disabled = false; return; }
    await loadNotifications();
  });
  workspaceSelect.addEventListener('change', async () => {
    socialOpen += 1;
    setSocialHistory(null);
    notificationSnapshot = null;
    agentMentions.clear();
    renderNotifications({items: [], unread_count: 0});
    currentAgent = null;
    currentConversation = null;
    currentSource = 'agent';
    voiceRecorder.refresh();
    clearVoicePlayers();
    stopPolling();
    closeSearchPanel();
    closeComposeDialog();
    const inChatPanel = document.getElementById('conversation-search-panel'); if (inChatPanel) inChatPanel.hidden = true;
    writeHash({workspace: workspaceId()});
    applyChatIdentity(document, '聊天');
    document.getElementById('message-list').replaceChildren();
    document.getElementById('chat-empty').hidden = false;
    setDirectoryLink({source: 'agent'});
    await loadSessions();
  });

  document.getElementById('session-search').addEventListener('focus', () => {
    if (!isSearchOpen()) openSearchPanel();
  });
  document.getElementById('session-search').addEventListener('input', () => {
    if (!isSearchOpen()) openSearchPanel();
    else renderSearch();
  });
  const inChatSearch = createMessageSearch(async (query, conversationId, cursor) => {
    if (currentSource === 'social') {
      const params = new URLSearchParams({q: query, limit: '20'});
      if (cursor) params.set('before', cursor);
      const result = await request('GET', `${socialBase()}/${conversationId}/messages?${params}`);
      if (result.status !== 200) throw new Error('无法搜索当前会话。');
      return {
        items: (result.body.items || []).map(item => {
          const body = String(item.body || '');
          const index = body.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
          const start = Math.max(0, index - 48);
          return {
            kind: 'social', conversation_id: conversationId, message_id: item.id, created: item.created,
            snippet: (start > 0 ? '…' : '') + body.slice(start, start + 160) + (body.length > start + 160 ? '…' : ''),
          };
        }),
        cursor: result.body.cursor,
      };
    }
    const result = await request('GET', `/v1/workspaces/${workspaceId()}/search/messages?${messageSearchQuery(query, conversationId, cursor)}`);
    if (result.status !== 200) throw new Error('无法搜索当前会话。');
    return result.body;
  });
  async function searchCurrentConversation(append = false) {
    const conversation = currentConversation;
    const query = (document.getElementById('conversation-search-query').value || '').trim();
    if (!conversation || !query) return;
    const wid = workspaceId();
    const state = await inChatSearch.load(query, conversation.id, {append});
    if (workspaceId() !== wid || !currentConversation || currentConversation.id !== conversation.id) return;
    const list = document.getElementById('conversation-search-results'); list.replaceChildren();
    for (const hit of state.hits) {
      list.append(searchHitRow(hit, (document.getElementById('conversation-search-query').value || '').trim()));
    }
    document.getElementById('conversation-search-status').textContent = state.error || (state.hits.length ? '已显示 ' + state.hits.length + ' 条消息' : '没有找到匹配的消息。试试其他关键词。');
    document.getElementById('conversation-search-more').hidden = !state.cursor;
  }
  async function jumpToMessage(messageId, notice = document.getElementById('conversation-search-status')) {
    const list = document.getElementById('message-list');
    const findTarget = () => Array.from(list.children || []).find(node => node.dataset.messageId === messageId);
    let target = findTarget();
    const jump = ++historyJump;
    const state = socialHistory;
    if (!target && currentSource === 'social' && state) {
      try {
        const query = new URLSearchParams({around: messageId, limit: '50'});
        const result = await historyPage(state, query);
        if (!result || jump !== historyJump) return;
        if (result.status === 200 && result.body.items?.some(item => item.id === messageId)) {
          setSocialHistory({...state, cursor: result.body.cursor ?? null,
            readingHistory: true, loading: false});
          searchScrollSnapshot = null;
          renderSocialMessages(result.body.items, {keepScroll: false});
          target = findTarget();
          if (notice) notice.textContent = '';
        }
      } catch {
        if (socialHistory !== state || jump !== historyJump) return;
      }
    }
    if (!target) {
      if (notice) notice.textContent = '这条消息不在当前已加载的消息窗口里。';
      return;
    }
    target.scrollIntoView?.({block: 'center', behavior: globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'});
    target.tabIndex = -1; target.focus?.({preventScroll: true});
    for (const node of Array.from(list.children || [])) delete node.dataset.searchJump;
    target.dataset.searchJump = 'true';
    setTimeout(() => { delete target.dataset.searchJump; }, SEARCH_JUMP_HIGHLIGHT_MS);
  }
  function searchHitRow(hit, query) {
    const li = document.createElement('li');
    li.className = 'search-hit';
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    li.setAttribute('aria-label', '跳到这条消息');
    const jump = () => jumpToMessage(hit.messageId);
    li.addEventListener('click', jump);
    li.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); jump(); }
    });
    const avatar = document.createElement('span');
    avatar.className = 'search-hit-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    const who = hit.role === 'agent' ? (hit.agent_name || '智能体') : (hit.title || '消息');
    avatar.textContent = leadGlyph(who);
    const head = document.createElement('span');
    head.className = 'search-hit-head';
    const name = document.createElement('strong');
    name.textContent = who;
    const when = document.createElement('time');
    when.textContent = hit.created ? formatSessionTime(hit.created) : '';
    head.append(name, when);
    const text = document.createElement('span');
    text.className = 'search-hit-text';
    text.append(...highlightParts(hit.snippet || hit.preview || '', query).map(part => {
      if (!part.match) return document.createTextNode(part.text);
      const mark = document.createElement('mark'); mark.textContent = part.text; return mark;
    }));
    li.append(avatar, head, text);
    return li;
  }
  // The conversation search covers three scopes of the SAME conversation. The
  // photo and file scopes read the attachment fields the message rows already
  // carry (social.py MESSAGE_ROWS -> attachment{id,title,kind,revision,path}),
  // paged through the existing messages endpoint; no second list is invented.
  const CONVERSATION_SCOPE_NOTES = {
    messages: '· 搜索当前会话里你有权查看的消息。',
    photos: '· 只读取当前会话消息里已有的图片附件。',
    files: '· 只读取当前会话消息里已有的文件附件。',
  };
  const ATTACHMENT_PAGE_LIMIT = 100; // the messages endpoint caps limit at 100
  const ATTACHMENT_MAX_PAGES = 50;
  let conversationScope = 'messages';
  function setConversationScope(tab) {
    conversationScope = tab;
    for (const name of ['messages', 'photos', 'files']) {
      const button = document.getElementById('conversation-search-tab-' + name);
      if (button) button.setAttribute('aria-selected', String(name === tab));
    }
    const note = document.getElementById('conversation-search-scope-note');
    if (note) note.textContent = CONVERSATION_SCOPE_NOTES[tab] || CONVERSATION_SCOPE_NOTES.messages;
    const more = document.getElementById('conversation-search-more');
    if (more) more.hidden = true;
  }
  async function conversationAttachments(conversation) {
    const items = [];
    let cursor = '';
    let truncated = false;
    for (let page = 0; page < ATTACHMENT_MAX_PAGES; page += 1) {
      const params = new URLSearchParams({limit: String(ATTACHMENT_PAGE_LIMIT)});
      if (cursor) params.set('cursor', cursor);
      const result = await request('GET', `/v1/workspaces/${workspaceId()}/social/conversations/${conversation.id}/messages?${params}`);
      if (result.status !== 200) throw new Error('读不到当前会话的附件。');
      items.push(...(result.body.items || []));
      cursor = result.body.cursor || '';
      if (!cursor) return {items, truncated: false};
      truncated = true;
    }
    return {items, truncated};
  }
  function attachmentHitRow(item) {
    const li = document.createElement('li');
    li.className = 'search-hit';
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    li.setAttribute('aria-label', '跳到这条消息');
    const jump = () => jumpToMessage(item.id);
    li.addEventListener('click', jump);
    li.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); jump(); }
    });
    const attachment = item.attachment || {};
    const photo = attachment.kind === 'image' || String(attachment.mime || '').startsWith('image/');
    const avatar = document.createElement('span');
    avatar.className = 'search-hit-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = photo ? '照' : '件';
    const head = document.createElement('span');
    head.className = 'search-hit-head';
    const name = document.createElement('strong');
    name.textContent = attachment.title || (photo ? '未命名照片' : '未命名文件');
    const when = document.createElement('time');
    when.textContent = item.created ? formatSessionTime(item.created) : '';
    head.append(name, when);
    const text = document.createElement('span');
    text.className = 'search-hit-text';
    text.textContent = (photo ? '照片' : '文件') + ' · 点开回到这条消息';
    li.append(avatar, head, text);
    return li;
  }
  async function searchCurrentAttachments(scope) {
    const conversation = currentConversation;
    const list = document.getElementById('conversation-search-results');
    const status = document.getElementById('conversation-search-status');
    if (!list || !status) return;
    list.replaceChildren();
    if (!conversation) { status.textContent = '请先打开一个会话。'; return; }
    if (currentSource !== 'social') {
      status.textContent = '智能体会话的消息数据里没有附件字段，读不到照片和文件。';
      return;
    }
    status.textContent = '正在读取当前会话的附件…';
    const wid = workspaceId();
    let found;
    try {
      found = await conversationAttachments(conversation);
    } catch (failure) {
      if (currentConversation && currentConversation.id === conversation.id) {
        status.textContent = failure.message || '读不到当前会话的附件。';
      }
      return;
    }
    if (workspaceId() !== wid || !currentConversation || currentConversation.id !== conversation.id) return;
    if (conversationScope !== scope) return;
    const photos = scope === 'photos';
    const hits = found.items.filter(item => {
      const attachment = item.attachment;
      if (!attachment) return false;
      const image = attachment.kind === 'image' || String(attachment.mime || '').startsWith('image/');
      return photos ? image : !image;
    });
    for (const item of hits) list.append(attachmentHitRow(item));
    if (hits.length) {
      status.textContent = (photos ? '已显示 ' + hits.length + ' 张照片' : '已显示 ' + hits.length + ' 个文件')
        + (found.truncated ? ' · 只读取了最近 ' + (ATTACHMENT_PAGE_LIMIT * ATTACHMENT_MAX_PAGES) + ' 条消息' : '');
    } else {
      status.textContent = photos ? '这个会话里还没有照片。' : '这个会话里还没有文件。';
    }
  }
  for (const scope of ['messages', 'photos', 'files']) {
    const button = document.getElementById('conversation-search-tab-' + scope);
    if (!button) continue;
    button.addEventListener('click', async () => {
      setConversationScope(scope);
      const list = document.getElementById('conversation-search-results');
      if (scope === 'messages') {
        const query = (document.getElementById('conversation-search-query').value || '').trim();
        if (query) await searchCurrentConversation();
        else { if (list) list.replaceChildren(); document.getElementById('conversation-search-status').textContent = ''; }
        return;
      }
      await searchCurrentAttachments(scope);
    });
  }
  const groupInfoToggle = document.getElementById('group-info-toggle');
  if (groupInfoToggle) {
    groupInfoToggle.addEventListener('click', () => {
      const open = groupInfoToggle.getAttribute('aria-expanded') !== 'true';
      if (open) document.getElementById('conversation-search-panel').hidden = true;
      setGroupInfoOpen(open);
    });
    document.getElementById('group-info-close').addEventListener('click', () => { setGroupInfoOpen(false); groupInfoToggle.focus(); });
    document.getElementById('group-info-search').addEventListener('click', () => {
      setGroupInfoOpen(false);
      document.getElementById('conversation-search-open').click();
    });
    document.getElementById('group-info-tab-agents').addEventListener('click', () => setGroupInfoTab('agents'));
    document.getElementById('group-info-tab-people').addEventListener('click', () => setGroupInfoTab('people'));
    document.getElementById('group-info-pin').addEventListener('click', async () => {
      const pin = document.getElementById('pin-conversation');
      if (!pin || pin.hidden) return;
      pin.click();
      const switchButton = document.getElementById('group-info-pin');
      const wanted = switchButton.getAttribute('aria-checked') !== 'true';
      for (let tries = 0; tries < 20; tries += 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
        const now = pin.textContent === '取消置顶';
        if (now === wanted) { switchButton.setAttribute('aria-checked', String(now)); break; }
      }
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !document.getElementById('group-info-panel').hidden) setGroupInfoOpen(false);
    });
  }
  let searchScrollSnapshot = null;
  const inChatOpen = document.getElementById('conversation-search-open');
  if (inChatOpen) inChatOpen.addEventListener('click', () => {
    if (!currentConversation) { show('error', '请先打开一个会话。'); return; }
    setGroupInfoOpen(false);
    if (document.getElementById('conversation-search-panel').hidden) {
      searchScrollSnapshot = {conversation: currentConversation.id, top: document.getElementById('message-scroller').scrollTop};
    }
    document.getElementById('conversation-search-panel').hidden = false;
    const field = document.getElementById('conversation-search-query'); if (field) field.focus();
  });
  const inChatClose = document.getElementById('conversation-search-close');
  function closeInChatSearch() {
    document.getElementById('conversation-search-panel').hidden = true;
    if (searchScrollSnapshot && currentConversation && currentConversation.id === searchScrollSnapshot.conversation) {
      document.getElementById('message-scroller').scrollTop = searchScrollSnapshot.top;
    }
    searchScrollSnapshot = null;
    if (inChatOpen) inChatOpen.focus();
  }
  if (inChatClose) inChatClose.addEventListener('click', closeInChatSearch);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !document.getElementById('conversation-search-panel').hidden) closeInChatSearch();
  });
  const inChatForm = document.getElementById('conversation-search-form');
  if (inChatForm) inChatForm.addEventListener('submit', async event => { event.preventDefault(); await searchCurrentConversation(); });
  const inChatMore = document.getElementById('conversation-search-more');
  if (inChatMore) inChatMore.addEventListener('click', () => searchCurrentConversation(true));
  const attachmentInput = document.getElementById('chat-attachment');
  if (attachmentInput) attachmentInput.addEventListener('change', async () => {
    const file = attachmentInput.files && attachmentInput.files[0];
    if (!file || !currentConversation || currentSource !== 'social') { show('error', '请先打开单聊或群聊。'); return; }
    const wid = workspaceId(), cid = currentConversation.id;
    attachmentInput.disabled = true;
    try {
      const form = new FormData(); form.append('kind', 'media'); form.append('title', file.name); form.append('file', file);
      const response = await fetcher(`/v1/workspaces/${wid}/artifacts`, {method: 'POST', credentials: 'same-origin',
        headers: {'X-CSRF-Token': csrfCookie(document.cookie), 'Idempotency-Key': idempotencyKey()}, body: form});
      const uploaded = await response.json();
      if (response.status !== 201) throw new Error(messageFor(uploaded.error, '附件未上传。'));
      const result = await request('POST', `/v1/workspaces/${wid}/social/conversations/${cid}/messages`,
        {body: '', artifact_id: uploaded.artifact.id}, {'Idempotency-Key': idempotencyKey()});
      if (result.status !== 201 && result.status !== 200) throw new Error('作品已上传，但附件消息未发送；文件仍在工作区作品库。');
      if (workspaceId() === wid && currentConversation && currentConversation.id === cid) {
        await loadSessions(); await openSocialConversation(cid);
      }
      show('ok', '附件已上传到工作区作品库并发送。');
    } catch (failure) { show('error', failure.message || '附件未发送。'); }
    finally { attachmentInput.disabled = false; attachmentInput.value = ''; }
  });
  const filterButton = document.getElementById('session-filter');
  const filterLabel = document.getElementById('session-filter-label');
  const filterValue = document.getElementById('session-filter-value');
  function setFilterOpen(open) {
    if (!filterLabel || !filterButton) return;
    filterLabel.hidden = !open;
    filterButton.setAttribute('aria-expanded', String(open));
    if (open) filterValue?.focus();
    else filterButton.focus();
  }
  filterButton?.addEventListener('click', () => setFilterOpen(Boolean(filterLabel?.hidden)));
  filterValue?.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setFilterOpen(false);
    }
  });
  filterValue?.addEventListener('change', () => {
    const name = filterValue.selectedOptions?.[0]?.textContent;
    if (name) filterButton?.setAttribute('aria-label', '会话筛选：' + name);
    setFilterOpen(false);
    renderSessions();
  });
  document.getElementById('conversations-read-all')?.addEventListener('click', async () => {
    if (markingConversationsRead) return;
    const wid = workspaceId();
    const unread = sessions.filter(item => item.source === 'social' && item.unread_count > 0);
    if (!wid || !unread.length) return;
    markingConversationsRead = true;
    renderSessions();
    try {
      let updated = 0;
      // Use the same per-conversation acknowledgement as opening a conversation.
      // Small batches avoid flooding the user's runtime with simultaneous writes.
      for (let index = 0; index < unread.length && workspaceId() === wid; index += 6) {
        const batch = unread.slice(index, index + 6);
        const results = await Promise.allSettled(batch.map(item =>
          request('POST', `/v1/workspaces/${wid}/social/conversations/${item.id}/read`, {})));
        updated += results.filter(result => result.status === 'fulfilled' && result.value.status === 200).length;
      }
      if (workspaceId() === wid) {
        try { await loadSessions(); }
        catch { show('error', '已提交已读状态，但无法刷新列表。'); return; }
        if (workspaceId() === wid) show(updated === unread.length ? 'ok' : 'error',
          updated === unread.length ? '已标记单聊和群聊为已读。' : '部分会话未能标记为已读，请重试。');
      }
    } finally {
      markingConversationsRead = false;
      renderSessions();
    }
  });
  const muteButton = document.getElementById('mute-conversation');
  const groupMute = document.getElementById('group-info-mute');
  let savingMute = false;
  function syncMuteButton(conversation) {
    const muted = Boolean(conversation?.muted);
    if (muteButton) {
      muteButton.hidden = !conversation || conversation.kind === 'group';
      muteButton.setAttribute('aria-pressed', String(muted));
      muteButton.textContent = muted ? '取消免打扰' : '免打扰';
    }
    groupMute?.setAttribute('aria-checked', String(muted));
  }
  async function toggleMute() {
    if (currentSource !== 'social' || !currentConversation || savingMute) return;
    const conversation = currentConversation;
    const wid = workspaceId();
    savingMute = true;
    if (muteButton) muteButton.disabled = true;
    if (groupMute) groupMute.disabled = true;
    try {
      const result = await request('POST', `${socialBase()}/${conversation.id}/preferences`, {muted: !conversation.muted});
      if (result.status !== 200) throw new Error('Mute preference unavailable');
      if (workspaceId() !== wid) return;
      const muted = Boolean(result.body.muted);
      const row = sessions.find(item => item.source === 'social' && item.id === conversation.id);
      if (row) row.muted = muted;
      if (currentSource === 'social' && currentConversation?.id === conversation.id) {
        currentConversation.muted = muted;
        syncMuteButton(currentConversation);
      }
      renderSessions();
    } catch {
      if (workspaceId() === wid) show('error', '免打扰设置保存失败，请重试。');
    } finally {
      savingMute = false;
      if (muteButton) muteButton.disabled = false;
      if (groupMute) groupMute.disabled = false;
    }
  }
  muteButton?.addEventListener('click', toggleMute);
  groupMute?.addEventListener('click', toggleMute);
  const pinButton = document.getElementById('pin-conversation');
  if (pinButton) pinButton.addEventListener('click', async () => {
    if (currentSource !== 'social' || !currentConversation) return;
    const id = currentConversation.id;
    const pinned = Boolean(sessions.find(item => item.id === id && item.pinned));
    const result = await request('POST', `${socialBase()}/${id}/preferences`, {pinned: !pinned});
    if (result.status !== 200) { show('error', '置顶未保存。'); return; }
    await loadSessions(); await openSocialConversation(id);
  });
  document.getElementById('search-close').addEventListener('click', closeSearchPanel);
  document.getElementById('chat-back').addEventListener('click', () => setSessionsOpen(true));
  document.getElementById('search-more').addEventListener('click', async () => {
    if (searchTab === 'files' || searchTab === 'links') { if (resourceCursor) await renderSearch({appendResources: true}); return; }
    const query = (document.getElementById('session-search').value || '').trim();
    if (!query || messageSearch.state.loading || !messageSearch.state.cursor) return;
    await messageSearch.load(query, searchConversation, {append: true});
    await renderSearch({reuseMessages: true});
  });
  document.getElementById('message-search').addEventListener('click', () => {
    if (!currentConversation) {
      show('error', '请先打开一个对话再搜索。');
      return;
    }
    document.getElementById('session-search').value = '';
    openSearchPanel('messages', currentConversation.id);
    document.getElementById('session-search').focus();
  });
  document.getElementById('search-panel').addEventListener('click', event => {
    const tab = event.target.closest('[data-search-tab]');
    if (!tab) return;
    setSearchTab(tab.dataset.searchTab);
    renderSearch();
  });

  document.getElementById('conversation-list').addEventListener('click', async event => {
    const button = event.target.closest('button[data-conversation]');
    if (!button) return;
    if (button.dataset.source === 'social') await openSocialConversation(button.dataset.conversation);
    else await openAgentConversation(button.dataset.agent, button.dataset.conversation);
  });

  document.getElementById('new-conversation').addEventListener('click', event => {
    event.stopPropagation();
    const menu = document.getElementById('compose-menu');
    const button = document.getElementById('new-conversation');
    const open = menu.hidden;
    menu.hidden = !open;
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  document.getElementById('group-agent-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (groupReplyBusy || currentSource !== 'social' || !currentConversation) return;
    const cid = currentConversation.id;
    const agentIds = [...document.querySelectorAll('#group-agent-choices input[name="group-agent"]:checked')]
      .map(box => box.value);
    const prompt = document.getElementById('group-agent-prompt').value;
    if (!agentIds.length) {
      show('error', '请选择至少一个群内智能体。');
      return;
    }
    if (!prompt.trim()) return;
    const fingerprint = JSON.stringify([workspaceId(), cid, agentIds.slice().sort(), prompt]);
    if (!groupReplyAttempt || groupReplyAttempt.fingerprint !== fingerprint) {
      groupReplyAttempt = {fingerprint, key: idempotencyKey('group-reply-')};
    }
    groupReplyBusy = true;
    document.getElementById('group-agent-submit').disabled = true;
    try {
      const result = await request('POST', `${socialBase()}/${cid}/agent-replies`,
        {agent_ids: agentIds, prompt}, {'Idempotency-Key': groupReplyAttempt.key});
      if (![200, 201].includes(result.status)) {
        show('error', messageFor(result.body.error, '请求未确认；重试相同内容将复用请求标识。'));
        return;
      }
      groupReplyAttempt = null;
      if (currentSource === 'social' && currentConversation && currentConversation.id === cid) {
        await openSocialConversation(cid);
        const replies = result.body.replies || (result.body.reply ? [result.body.reply] : []);
        const failed = replies.filter(item => item.status === 'failed').length;
        show(failed ? 'error' : 'ok', failed
          ? (replies.length - failed) + ' 个已提交，' + failed + ' 个失败。'
          : '已请求 ' + replies.length + ' 个智能体回复。');
      }
    } finally {
      groupReplyBusy = false;
      if (currentSource === 'social' && currentConversation && currentConversation.id === cid) {
        await openSocialConversation(cid);
      }
    }
  });

  document.getElementById('group-agent-chips').addEventListener('click', event => {
    const button = event.target.closest('button[data-remove-agent]');
    if (!button || currentSource !== 'social' || !currentConversation || button.disabled) return;
    const cid = currentConversation.id, wid = workspaceId(), agentId = button.dataset.removeAgent;
    const holder = document.getElementById('group-agent-chips');
    if (holder.querySelector('.agent-remove-confirm')) return;
    const question = document.createElement('span');
    question.className = 'agent-remove-confirm'; question.setAttribute('role', 'alertdialog');
    question.setAttribute('aria-label', '移除群内智能体确认');
    const text = document.createElement('span'); text.textContent = '从当前群聊移除此智能体？已有消息会保留。';
    const confirm = document.createElement('button'); confirm.type = 'button'; confirm.textContent = '确认移除';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '取消';
    cancel.addEventListener('click', () => { question.remove(); button.focus(); });
    question.addEventListener('keydown', event => { if (event.key === 'Escape') { question.remove(); button.focus(); } });
    confirm.addEventListener('click', async () => {
      if (workspaceId() !== wid || !currentConversation || currentConversation.id !== cid) { question.remove(); return; }
      confirm.disabled = true; cancel.disabled = true;
      try {
        const result = await request('POST', `/v1/workspaces/${wid}/social/conversations/${cid}/agents/${agentId}/remove`, {});
        if (workspaceId() !== wid || !currentConversation || currentConversation.id !== cid) return;
        if (result.status !== 200) { show('error', messageFor(result.body.error, '无法移除智能体。')); return; }
        await openSocialConversation(cid); show('ok', '已移除智能体。');
      } catch { show('error', '网络错误，智能体未移除。'); }
      finally { confirm.disabled = false; cancel.disabled = false; }
    });
    question.append(text, cancel, confirm); holder.append(question); cancel.focus();
  });

  document.getElementById('group-agent-add-submit').addEventListener('click', async () => {
    if (currentSource !== 'social' || !currentConversation) return;
    const select = document.getElementById('group-agent-add');
    if (!select.value) return;
    const cid = currentConversation.id;
    const result = await request('POST', `${socialBase()}/${cid}/agents`, {agent_ids: [select.value]});
    if (result.status !== 201 && result.status !== 200) {
      show('error', messageFor(result.body.error, '无法添加智能体。'));
      return;
    }
    await openSocialConversation(cid);
    show('ok', '已添加智能体。');
  });

  document.getElementById('compose-new-group').addEventListener('click', () => openComposeDialog('group'));
  document.getElementById('compose-add-contact').addEventListener('click', () => openComposeDialog('contact'));
  document.getElementById('compose-dialog-cancel').addEventListener('click', closeComposeDialog);
  document.getElementById('compose-mode-switch').addEventListener('click', event => {
    const button = event.target.closest('[data-group-mode]');
    if (!button || composeMode !== 'group') return;
    setGroupMode(button.dataset.groupMode);
  });
  document.getElementById('compose-member-search').addEventListener('input', applyMemberFilter);
  document.getElementById('member-choices').addEventListener('change', syncSelectedCount);
  const templateChoices = document.getElementById('team-template-choices');
  if (templateChoices) templateChoices.addEventListener('change', syncComposeCreate);

  document.getElementById('compose-social-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (composeMode === 'group' && groupMode === 'team') {
      const picked = document.querySelectorAll('#team-template-choices input:checked')[0];
      if (!picked) { show('error', '请选择一个团队模板。'); return; }
      const wid = workspaceId();
      const created = await request('POST', `/v1/workspaces/${wid}/team-templates/${picked.value}`, {},
        {'Idempotency-Key': idempotencyKey('team-')});
      if (created.status !== 201 && created.status !== 200) {
        show('error', messageFor(created.body.error, '无法创建智能体团队。'));
        return;
      }
      closeComposeDialog();
      await loadSessions();
      await openSocialConversation(created.body.conversation.id);
      show('ok', '智能体团队已创建。智能体只在你明确请求时回复。');
      return;
    }
    const memberIds = [...document.querySelectorAll('#member-choices input[name="member"]:checked')]
      .map(box => box.value);
    if (!memberIds.length) {
      show('error', '至少选择一位成员。');
      return;
    }
    const title = document.getElementById('compose-title').value.trim();
    if (composeMode === 'contact' && memberIds.length !== 1) {
      show('error', '请选择一位成员。');
      return;
    }
    const body = composeMode === 'contact'
      ? {kind: 'dm', member_ids: memberIds.slice(0, 1)}
      : composeGroupPayload(memberIds, title,
        [...document.querySelectorAll('#member-choices input[name="agent-member"]:checked')].map(box => box.value));
    const result = await request('POST', socialBase(), body, {'Idempotency-Key': idempotencyKey('social-')});
    if (result.status !== 201 && result.status !== 200) {
      show('error', messageFor(result.body.error, '无法创建会话。'));
      return;
    }
    closeComposeDialog();
    await loadSessions();
    await openSocialConversation(result.body.conversation.id);
    show('ok', '会话已创建。');
  });


  async function sendCurrentMessage() {
    const text = document.getElementById('chat-body').value;
    if (!text.trim()) {
      show('error', '请填写消息。');
      return;
    }
    if (currentSource === 'social') {
      const message = agentMentions.message(text);
      if (!validMessage(message.body)) {
        show('error', '请输入 1–4000 字符的消息。');
        return;
      }
      if (!currentConversation) {
        show('error', '请先打开或创建一个会话。');
        return;
      }
      const conversationId = currentConversation.id;
      const wid = workspaceId();
      const result = await request('POST', `${socialBase()}/${conversationId}/messages`, message, {
        'Idempotency-Key': idempotencyKey('socialmsg-'),
      });
      if (result.status !== 201 && result.status !== 200) {
        show('error', messageFor(result.body.error, '发送失败。'));
        return;
      }
      if (workspaceId() === wid && currentSource === 'social' && currentConversation?.id === conversationId) {
        document.getElementById('chat-body').value = '';
        agentMentions.clear();
        await openSocialConversation(conversationId);
        show('ok', '已发送。');
      }
      return;
    }
    if (!currentAgent) {
      show('error', '请先选择一个智能体。');
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
      messagePayload(text, chatLanguage),
      {'Idempotency-Key': idempotencyKey('msg-')},
    );
    if (result.status !== 201 && result.status !== 200) {
      show('error', messageFor(result.body.error, '无法发送。'));
      return;
    }
    document.getElementById('chat-body').value = '';
    const notice = sendNotice(result.body.reply);
    show(notice.kind, notice.text);
    await loadSessions();
    await openAgentConversation(currentAgent.id, currentConversation.id);
  }

  const formatButton = document.getElementById('chat-format');
  const formatMenu = document.getElementById('chat-format-menu');
  const formatBold = document.getElementById('chat-format-bold');
  if (formatButton && formatMenu && formatBold) {
    const closeFormat = () => {
      formatMenu.hidden = true;
      formatButton.setAttribute('aria-expanded', 'false');
    };
    formatButton.addEventListener('click', () => {
      const open = formatMenu.hidden;
      formatMenu.hidden = !open;
      formatButton.setAttribute('aria-expanded', String(open));
    });
    if (typeof document.addEventListener === 'function') {
      document.addEventListener('click', event => {
        if (formatMenu.hidden) return;
        if (event.target && event.target.closest && event.target.closest('.format-wrap')) return;
        closeFormat();
      });
    }
    formatBold.addEventListener('click', () => {
      const field = document.getElementById('chat-body');
      const selection = wrapBold(field.value || '', field.selectionStart, field.selectionEnd);
      field.value = selection.text;
      field.focus();
      if (typeof field.setSelectionRange === 'function') {
        field.setSelectionRange(selection.start, selection.end);
      }
      closeFormat();
    });
  }

  document.getElementById('chat-body').addEventListener('keydown', event => {
    if (agentMentions.keydown(event) || !shouldSendOnShortcut(event, sendShortcut)) return;
    event.preventDefault();
    if (!(document.getElementById('chat-body').value || '').trim()) return;
    sendCurrentMessage();
  }, true);

  document.getElementById('chat-form').addEventListener('submit', event => {
    event.preventDefault();
    sendCurrentMessage();
  });

  document.getElementById('message-list').addEventListener('click', async event => {
    const button = event.target.closest('button[data-save]');
    if (!button || !currentConversation || !currentAgent) return;
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

  document.getElementById('logout-form').addEventListener('submit', async event => {
    event.preventDefault();
    const result = await request('POST', '/v1/auth/logout', {});
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '退出失败。'));
      return;
    }
    await load();
  });

  document.addEventListener('click', event => {
    const menu = document.getElementById('compose-menu');
    if (menu.hidden) return;
    if (event.target.closest('.compose-menu')) return;
    closeComposeMenu();
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    closeComposeMenu();
    if (isSearchOpen()) closeSearchPanel();
    closeComposeDialog();
  });

  // Composer "+": 上传 / 照片 / 视频 reuse the existing media-attachment upload
  // (single and group chats only); agent chats show them disabled with a note.
  const plus = document.querySelector('details.composer-plus');
  const attachInput = document.getElementById('chat-attachment');
  const defaultAccept = attachInput ? attachInput.getAttribute('accept') || '' : '';
  function syncPlusState() {
    const social = currentSource === 'social' && Boolean(currentConversation);
    for (const button of document.querySelectorAll('[data-plus-attach]')) {
      button.disabled = !social;
      if (!button.dataset.title) button.dataset.title = button.title;
      button.title = social ? button.dataset.title : '未接通：智能体私聊还不能发附件';
    }
    const hint = document.getElementById('plus-attach-hint');
    if (hint) hint.hidden = social;
  }
  if (plus) plus.addEventListener('toggle', () => { if (plus.open) syncPlusState(); });
  for (const button of document.querySelectorAll('[data-plus-attach]')) {
    button.addEventListener('click', () => {
      if (!attachInput || button.disabled) return;
      attachInput.setAttribute('accept', plusAttachAccept(button.dataset.plusAttach, defaultAccept));
      attachInput.click();
      if (plus) plus.open = false;
    });
  }
  if (attachInput) attachInput.addEventListener('change', () => attachInput.setAttribute('accept', defaultAccept));

  globalThis.addEventListener('hashchange', () => load());
  return load();
}

if (globalThis.document && globalThis.document.getElementById('session-pane')) {
  mount(globalThis.document);
}

export function plusAttachAccept(kind, fallback) {
  const all = String(fallback || '').split(',').map(item => item.trim()).filter(Boolean);
  if (kind === 'image') return all.filter(item => item.startsWith('image/')).join(',');
  if (kind === 'video') return all.filter(item => item.startsWith('video/')).join(',');
  return all.join(',');
}

export { canManage, conversationLabel };
