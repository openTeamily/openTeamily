import { decodeVoice, mountVoiceRecorder } from './voice.mjs';
import { mountAgentMentions } from './mentions.mjs';
import { AGENT_FILE_ACCEPT, mountChatFiles, renderChatFile, sendPrivateAttachmentMessage } from './files.mjs';
import { mountGroupTranslation } from './translation.mjs';
import { mountChatCalls } from './calls.mjs';
import { mountImageCreator } from './image-create.mjs';
import { mountWorkspaceEvents } from '../shell/workspace-events.mjs';
import { mountChatActivity } from './activity.mjs';
import { stageMeetingFromChat } from '../shell/meeting-link.mjs';
import { mountMessageUtilities, renderMessageText } from './utilities.mjs';
export const SEARCH_JUMP_HIGHLIGHT_MS = 2400;
import { csrfCookie, canManage, idempotencyKey, statusLabel } from '../agents/app.mjs';
import { conversationLabel, memberChoices, validMessage } from '../messenger/app.mjs';
import { createLookAvatar } from '../look/app.mjs';
import { dsbotServed } from './dsbot.mjs';
import { agentSavePath, defaultSaveTitle, saveableAgentMessage, saveableSocialMessage, socialSavePath, spaceHref } from '../shell/thumb.mjs';

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
      kind: row.public_agent ? 'public' : row.kind,
      members: row.members,
      title: conversationLabel(row, currentUserId),
      preview: sessionPreview(row, row.public_agent ? '公开智能体' : row.kind === 'group'
        ? '群聊 · ' + ((row.members || []).length) + ' 人'
        : '单聊 · ' + ((row.members || []).length) + ' 人'),
      updated: row.updated || 0,
    });
  }
  return sortSessions(sessions);
}


function sortSessions(sessions) {
  return sessions.sort((left, right) => Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) || (right.updated || 0) - (left.updated || 0));
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
// Send mode is a property of the message a person is writing: it travels with
// the body, is stored with the row and shown on the bubble after a reload.
export const MESSAGE_MODES = ['auto', 'instant', 'agentic'];
export function normalizeMode(value) {
  return MESSAGE_MODES.includes(value) ? value : 'auto';
}
export function modeLabel(mode) {
  const value = normalizeMode(mode);
  return value === 'instant' ? 'Instant' : (value === 'agentic' ? 'Agentic' : 'Auto');
}
export function modeStoreKey(conversationId) {
  return 'ot.chat.mode.' + String(conversationId || '');
}
export function socialSendPayload(text, mode) {
  return {body: text, mode: normalizeMode(mode)};
}

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
    agentId: item.agent_id || '',
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
  const state = {hits: [], cursor: '', loading: false, error: '', warning: ''};
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
      Object.assign(state, {hits: [], cursor: '', error: '', warning: '', loading: false});
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
      state.warning = '';
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
        state.warning = (page && page.warning) || '';
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
      id: member.user_id, kind: 'human', label: member.username + (member.contact ? ' · 联系人' : ' · 成员'),
    })),
    ...agents.filter(agent => !agent.archived).map(agent => ({
      id: agent.id, kind: 'agent', label: agent.name + ' · AI 智能体',
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
  if (reply?.status === 'failed') return {kind: 'error', text: '消息已保存，智能体回复失败。'};
  return {kind: 'ok', text: '已发送。', announceOnly: true};
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
    && selectedCount <= 49 && Number(options.selectedAgentCount || 0) <= 10
    && (options.personal ? selectedCount > 0 : Number(options.selectedHumanCount ?? selectedCount) >= 1);
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
    message: params.get('message') || '',
    social: params.get('social') || '',
    publicAgent: params.get('public-agent') || '',
  };
}

function writeHash(values) {
  const params = new URLSearchParams();
  if (values.workspace) params.set('workspace', values.workspace);
  if (values.agent) params.set('agent', values.agent);
  if (values.social) params.set('social', values.social);
  if (values.conversation) params.set('conversation', values.conversation);
  if (values.message) params.set('message', values.message);
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
  return item.pinned ? '置顶' : item.kind === 'public' ? '公开智能体' : item.kind === 'group' ? '群聊' : '直聊';
}

export function groupSessionsForDisplay(items) {
  return ['置顶', '直聊', '公开智能体', '群聊'].flatMap(group => items.filter(item => sessionDisplayGroup(item) === group));
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
  return (conversations || []).filter(item => item.id !== currentId && !item.public_agent && item.direct?.open !== false)
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
  if (item.kind === 'messenger.added') {
    const author = item.by?.display_name || item.by?.handle || '成员';
    return `${author} 将你加入「${item.title || '群聊'}」`;
  }
  if (item.kind === 'messenger.call') {
    const author = item.by?.display_name || item.by?.handle || '成员';
    const kind = item.call_kind === 'video' ? '视频通话' : '语音通话';
    return item.title ? `${author} 在「${item.title}」发起了${kind}` : `${author} 发起了${kind}`;
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
  const messageUtilities = mountMessageUtilities(document, {request, notify: show, composerContext: () => currentConversation ? {wid: workspaceId(), cid: currentConversation.id, source: currentSource} : null, context: () => currentSource === 'social' && currentConversation && !currentConversation.public_agent ? {wid: workspaceId(), cid: currentConversation.id, kind: currentConversation.kind} : null});
  let currentSource = 'agent';
  const autoTranslation = mountGroupTranslation(document,{request});
  const chatCalls = mountChatCalls(document, {request, context: () => {
    if (!servedByDsbot || currentSource !== 'social' || !currentConversation || currentConversation.public_agent || currentConversation.direct?.open === false) return null;
    return {wid: workspaceId(), cid: currentConversation.id, title: conversationLabel(currentConversation, currentUser?.id)};
  }});
  const agentMentions = mountAgentMentions(document, () => {
    if (currentSource !== 'social' || currentConversation?.kind !== 'group' || currentConversation.public_agent || currentConversation.direct?.open === false) return null;
    return {scope: `${workspaceId()}/${currentConversation.id}`, agents: currentConversation.agent_members || []};
  });
  function voiceContext() {
    if (currentSource !== 'social' || !currentConversation || currentConversation.public_agent || currentConversation.direct?.open === false) return null;
    const wid = workspaceId();
    const cid = currentConversation.id;
    return {wid, cid, scope: `${wid}/${cid}`};
  }
  const voiceRecorder = mountVoiceRecorder(document, {
    context: voiceContext,
    createKey: () => idempotencyKey('voice-'),
    async send(destination, voice, key) {
      const {wid, cid, scope} = destination;
      const draftScope = sendScope();
      const reply = replyDrafts.get(draftScope);
      const result = await request('POST', `/v1/workspaces/${wid}/social/conversations/${cid}/messages`,
        {voice, ...(reply ? {reply_to: reply.message_id} : {})}, {'Idempotency-Key': key});
      if (![200, 201].includes(result.status) || !result.body?.message?.voice) {
        throw new Error(messageFor(result.body?.error, '语音发送失败，请重试。'));
      }
      consumeReplyDraft(draftScope, reply);
      if (voiceContext()?.scope === scope) {
        await openSocialConversation(cid);
        show('ok', '语音已发送。', {announceOnly: true});
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
  let attachmentSender;
  const pendingSends = new Map();
  const sendScope = (conversation = currentConversation?.id) =>
    JSON.stringify([currentUser?.id, workspaceId(), currentSource, currentAgent?.id, conversation]);

  const memoryRecall = document.getElementById('agent-memory-recall');
  const memoryDrafts = new Map();
  const memoryWrites = new Map();
  const recallMode = scope => currentConversation?.memory_scope ?? memoryDrafts.get(scope)
    ?? ((currentConversation?.memory_recall ?? currentAgent?.memory_recall_default ?? true) ? 'workspace' : 'off');

  function syncMemoryRecall(scope = sendScope()) {
    if (!memoryRecall) return;
    const visible = servedByDsbot && currentSource === 'agent' && Boolean(currentAgent);
    memoryRecall.hidden = !visible;
    if (!visible) return;
    memoryRecall.value = memoryWrites.get(scope) ?? recallMode(scope);
    memoryRecall.disabled = memoryWrites.has(scope) || Boolean(pendingSends.get(scope)?.jobs.some(job => !job.failed));
  }

  memoryRecall?.addEventListener('change', async () => {
    if (memoryRecall.hidden || memoryRecall.disabled) return;
    const scope = sendScope();
    const mode = memoryRecall.value;
    if (!currentConversation) {
      memoryDrafts.set(scope,mode);
      syncMemoryRecall(scope);
      return;
    }
    const path = `${agentBase()}/conversations/${currentConversation.id}`;
    memoryWrites.set(scope,mode);
    renderPendingSend();
    try {
      const result = await request('POST',path,{memory_scope:mode});
      if (sendScope() !== scope) return;
      if (result.status !== 200 || result.body.memory_scope !== mode) throw new Error();
      currentConversation.memory_scope = mode;
      currentConversation.memory_recall = result.body.memory_recall;
      show('ok', mode === 'off' ? '已关闭后续消息的记忆检索。' : mode === 'workspace'
        ? '后续消息将参考本工作区的记忆。' : '后续消息将参考可访问工作区里的记忆和行动项。', {announceOnly:true});
    } catch {
      if (sendScope() === scope) show('error','记忆范围未保存，请重试。');
    } finally {
      memoryWrites.delete(scope);
      if (sendScope() === scope) renderPendingSend();
    }
  });

  const replyDrafts = new Map();
  const replyPanel = document.getElementById('chat-reply-preview');
  const replyDraftTitle = document.getElementById('chat-reply-author');
  const replyDraftBody = document.getElementById('chat-reply-excerpt');

  function renderReplyDraft() {
    if (!replyPanel) return;
    const reply = currentSource === 'social' && replyDrafts.get(sendScope());
    replyPanel.hidden = !reply;
    const title = reply ? '回复 ' + reply.author : '';
    const excerpt = reply ? reply.excerpt : '';
    if (replyDraftTitle.textContent !== title) replyDraftTitle.textContent = title;
    if (replyDraftBody.textContent !== excerpt) replyDraftBody.textContent = excerpt;
  }

  function composeReply(item, author) {
    if (currentSource !== 'social' || item.retracted) return;
    const excerpt = String(item.body || item.attachment?.title || (item.voice ? '语音消息' : '消息'))
      .replace(/\s+/g, ' ').trim().slice(0, 120);
    replyDrafts.set(sendScope(), {message_id: item.id, author, excerpt, available: true});
    renderReplyDraft();
    document.getElementById('chat-body').focus();
  }

  function consumeReplyDraft(scope, reply) {
    if (reply && replyDrafts.get(scope) === reply) {
      replyDrafts.delete(scope);
      if (sendScope() === scope) renderReplyDraft();
    }
  }

  document.getElementById('chat-reply-cancel')?.addEventListener('click', () => {
    consumeReplyDraft(sendScope(), replyDrafts.get(sendScope()));
    document.getElementById('chat-body').focus();
  });

  function quoteBlock(reply, interactive = false) {
    const canJump = interactive && reply.available;
    const element = document.createElement(canJump ? 'button' : 'div');
    element.className = 'message-quote';
    if (!reply.available) {
      element.textContent = '原消息不可查看';
      return element;
    }
    const name = document.createElement('strong');
    const excerpt = document.createElement('span');
    name.textContent = reply.author;
    excerpt.textContent = reply.excerpt;
    element.append(name, excerpt);
    if (canJump) {
      element.type = 'button';
      element.setAttribute('aria-label', '查看 ' + reply.author + ' 的原消息');
      element.addEventListener('click', async () => {
        const scope = sendScope();
        if (await jumpToMessage(reply.message_id, null) === false && sendScope() === scope) {
          show('error', '原消息已不可查看。');
        }
      });
    }
    return element;
  }

  function show(kind, text, {announceOnly = false} = {}) {
    status.dataset.kind = kind;
    status.dataset.announceOnly = String(announceOnly);
    status.textContent = text;
  }

  function sendClosed() {
    return currentSource === 'social'
      && (currentConversation?.public_agent?.open === false || currentConversation?.direct?.open === false);
  }

  function renderPendingSend() {
    const list = document.getElementById('message-list');
    const scope = sendScope();
    const queue = pendingSends.get(scope);
    document.getElementById('chat-send').disabled = sendClosed() || memoryWrites.has(scope);
    syncMemoryRecall(scope);
    const bubbles = new Set((queue?.jobs || []).map(job => job.bubble));
    for (const child of Array.from(list.children)) {
      if (child.dataset.sendPending && !bubbles.has(child)) child.remove();
      bubbles.delete(child);
    }
    for (const job of queue?.jobs || []) {
      paintSendJob(job);
      if (bubbles.has(job.bubble)) list.append(job.bubble);
    }
    document.getElementById('chat-empty').hidden = list.children.length > 0;
  }

  function paintSendJob(job) {
    if (job.status.textContent !== job.state) job.status.textContent = job.state;
    job.bubble.dataset.sendPending = job.failed ? 'failed' : 'pending';
    job.actions.hidden = !job.failed;
    job.retry.disabled = sendClosed() || memoryWrites.has(sendScope());
  }

  function makeSendJob(queue, message, files, reply) {
    const key = idempotencyKey(queue.social ? 'socialmsg-' : files.length ? 'agent-files-' : 'msg-');
    const bubble = document.createElement('li');
    bubble.className = queue.social ? 'mine' : 'user';
    const body = document.createElement('div');
    body.className = 'body';
    renderMessageBody(document, body, message.body || '', chatPreferences);
    body.hidden = !message.body;
    const status = document.createElement('p');
    status.className = 'send-feedback';
    status.setAttribute('role', 'status');
    const actions = document.createElement('div');
    actions.className = 'send-actions';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = '重试';
    const discard = document.createElement('button');
    discard.type = 'button';
    discard.textContent = '移除';
    actions.append(retry, discard);
    if (reply) bubble.append(quoteBlock(reply));
    bubble.append(body);
    const previews = [];
    const urls = document.defaultView?.URL;
    for (const file of files) {
      const path = file.type?.startsWith('image/') && urls?.createObjectURL ? urls.createObjectURL(file) : '';
      if (path) previews.push(path);
      bubble.append(renderChatFile(document, {title:file.name,mime:file.type,bytes:file.size,path}, {pending:true}));
    }
    bubble.append(status, actions);
    const job = {key, message, files, previews, bubble, status, actions, retry, failed: false,
      state: queue.active ? '等待发送…' : '正在发送…'};
    retry.addEventListener('click', () => {
      if (!job.failed || job.retry.disabled) return;
      job.failed = false;
      job.state = '等待发送…';
      paintSendJob(job);
      void drainSends(queue);
    });
    discard.addEventListener('click', () => {
      removeSendJob(queue, job);
      renderPendingSend();
    });
    return job;
  }

  function removeSendJob(queue, job) {
    queue.jobs = queue.jobs.filter(item => item !== job);
    job.bubble.remove();
    for (const url of job.previews) document.defaultView.URL.revokeObjectURL(url);
    if (!queue.jobs.length && !queue.active && pendingSends.get(queue.scope) === queue) pendingSends.delete(queue.scope);
  }

  function clearPendingSends() {
    for (const queue of pendingSends.values()) {
      for (const job of queue.jobs) removeSendJob(queue,job);
    }
    pendingSends.clear();
  }

  function pendingMessageKeys() {
    return new Set((pendingSends.get(sendScope())?.jobs || []).map(job => job.key));
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

  function inPersonalWorkspace() {
    return servedByDsbot && workspaces.some(space => space.id === workspaceId() && space.kind === 'personal');
  }

  function contactMembers(result) {
    return (result.body?.items || []).filter(row => row.status === 'accepted' && row.peer?.handle)
      .map(row => ({user_id:row.peer.handle, handle:row.peer.handle, username:row.peer.display_name || row.peer.handle, contact:true}));
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
    return result.body;
  });

  function renderGroupReplyAction(requests) {
    const panel = document.getElementById('group-agent-action');
    const isGroup = currentSource === 'social' && currentConversation
      && currentConversation.kind === 'group' && !currentConversation.public_agent;
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
      remove.dataset.removeAgent = agent.id || agent.agent_id;
      li.append(name);
      if (agent.mine !== false) li.append(remove);
      chips.append(li);
    }
    const add = document.getElementById('group-agent-add');
    add.replaceChildren();
    const joined = new Set(saved.filter(agent => agent.mine !== false).map(agent => agent.id || agent.agent_id));
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
    for (const agent of saved.filter(item => !item.archived && item.mine !== false)) {
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.name = 'group-agent';
      box.value = agent.id || agent.agent_id;
      box.disabled = active.has(box.value);
      label.append(box, document.createTextNode(agent.name + (box.disabled ? '（回复中）' : '')));
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

  function memorySources(item) {
    if (item.role !== 'assistant' || item.status !== 'succeeded') return null;
    const wid = workspaceId();
    const refs = Array.isArray(item.memory_refs) ? item.memory_refs : [];
    const links = [];
    for (const ref of refs) {
      if (!/^[0-9a-f]{32}$/.test(ref?.id || '') || !/^[0-9a-f]{32}$/.test(ref.workspace_id || '')) continue;
      const workspace = workspaces.find(entry => entry.id === ref.workspace_id);
      if (ref.workspace_id !== wid && !workspace) continue;
      const params = new URLSearchParams({workspace:ref.workspace_id,page:ref.id});
      let title = ref.title || '记忆页';
      if (ref.kind === 'action') {
        params.set('page','todos');
        params.set('action',ref.id);
        title = '行动 · ' + title;
      } else if (Number.isSafeInteger(ref.revision) && ref.revision > 0) params.set('revision',String(ref.revision));
      if (ref.workspace_id !== wid && workspace?.name) title += ' · ' + workspace.name;
      links.push([params,title]);
    }
    if (item.memory_profile_workspace === wid) {
      links.push([new URLSearchParams({workspace:wid, page:'profile'}), '我的资料与偏好']);
    }
    if (!links.length) return null;
    const sources = document.createElement('details');
    sources.className = 'reply-memory-sources';
    const summary = document.createElement('summary');
    summary.textContent = `参考记忆 · ${links.length}`;
    const list = document.createElement('ol');
    for (const [params, title] of links) {
      const row = document.createElement('li');
      const link = document.createElement('a');
      link.href = '/memory?' + params.toString();
      link.textContent = title;
      row.append(link);
      list.append(row);
    }
    sources.append(summary, list);
    return sources;
  }

  let lastAgentItems = [];
  const captureButton = document.getElementById('history-capture-open');
  const captureDialog = document.getElementById('history-capture-dialog');
  const captureList = document.getElementById('history-capture-list');
  const captureQuery = document.getElementById('history-capture-query');
  const captureMore = document.getElementById('history-capture-more');
  const captureSubmit = document.getElementById('history-capture-submit');
  const captureStatus = document.getElementById('history-capture-status');
  const captureInbox = document.getElementById('history-capture-inbox');
  let captureDraft = null;

  function syncCaptureButton() {
    if (!captureButton) return;
    captureButton.hidden = !servedByDsbot || currentSource !== 'agent' || !currentConversation
      || !lastAgentItems.some(item => item.role === 'user' && item.body?.trim() && /^[0-9a-f]{32}$/.test(item.id));
  }

  function syncCaptureSelection() {
    const count = captureDraft.selected.size;
    for (const choice of captureDraft.visible) choice.disabled = captureDraft.busy || (!choice.checked && count >= 12);
    captureSubmit.disabled = !count || captureDraft.busy;
    captureSubmit.textContent = captureDraft.busy ? '正在加入队列…' : count ? `提炼 ${count} 条消息` : '提炼所选消息';
  }

  function renderCaptureChoices() {
    if (!captureDraft) return;
    const query = captureQuery.value.trim().toLocaleLowerCase();
    const rows = captureDraft.items.filter(item => item.body.toLocaleLowerCase().includes(query));
    captureDraft.visible = [];
    captureList.replaceChildren();
    for (const item of rows.slice(0,captureDraft.limit)) {
      const label = document.createElement('label');
      const choice = document.createElement('input');
      choice.type = 'checkbox';
      choice.checked = captureDraft.selected.has(item.id);
      choice.addEventListener('change', () => {
        if (choice.checked) captureDraft.selected.add(item.id);
        else captureDraft.selected.delete(item.id);
        syncCaptureSelection();
      });
      const excerpt = document.createElement('span');
      excerpt.textContent = item.body.length > 280 ? item.body.slice(0,280) + '…' : item.body;
      label.append(choice,excerpt);
      captureList.append(label);
      captureDraft.visible.push(choice);
    }
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.className = 'note';
      empty.textContent = '没有找到匹配的消息。';
      captureList.append(empty);
    }
    captureMore.hidden = rows.length <= captureDraft.limit;
    syncCaptureSelection();
  }

  captureButton?.addEventListener('click', () => {
    if (captureButton.hidden || !captureDialog) return;
    const items = lastAgentItems.filter(item => item.role === 'user' && item.body?.trim() && /^[0-9a-f]{32}$/.test(item.id)).reverse();
    if (!items.length) return;
    captureDraft = {scope:sendScope(),items,selected:new Set(),limit:24,busy:false};
    captureQuery.value = '';
    captureStatus.textContent = '';
    captureInbox.href = '/memory?' + new URLSearchParams({workspace:workspaceId(),page:'candidates'});
    captureInbox.hidden = true;
    document.getElementById('chat-more')?.setAttribute('aria-expanded','false');
    renderCaptureChoices();
    captureDialog.showModal();
    captureQuery.focus();
  });
  captureQuery?.addEventListener('input', () => {
    if (!captureDraft) return;
    captureDraft.limit = 24;
    renderCaptureChoices();
  });
  captureMore?.addEventListener('click', () => {
    if (!captureDraft) return;
    captureDraft.limit += 24;
    renderCaptureChoices();
  });
  document.getElementById('history-capture-close')?.addEventListener('click', () => captureDialog.close());
  captureDialog?.addEventListener('close', () => {
    captureDraft = null;
    document.getElementById('chat-more')?.focus();
  });
  document.getElementById('history-capture-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const draft = captureDraft;
    if (!draft || draft.busy || !draft.selected.size || sendScope() !== draft.scope) return;
    draft.busy = true;
    syncCaptureSelection();
    captureStatus.textContent = '';
    const path = `${agentBase()}/conversations/${currentConversation.id}/memory/capture`;
    try {
      const result = await request('POST',path,{message_ids:[...draft.selected]});
      if (captureDraft !== draft || sendScope() !== draft.scope) return;
      if (result.status !== 202) {
        captureStatus.textContent = messageFor(result.body.error,'无法提炼所选消息，请重试。');
        return;
      }
      const {queued,skipped,full} = result.body;
      captureStatus.textContent = [
        queued ? `${queued} 条已加入后台提炼。` : '',
        skipped ? `${skipped} 条已有处理记录。` : '',
        full ? `队列已满，${full} 条可稍后重试。` : '',
      ].filter(Boolean).join(' ');
      captureInbox.hidden = !(queued || skipped);
      if (!full) draft.selected.clear();
      renderCaptureChoices();
    } catch {
      if (captureDraft === draft) captureStatus.textContent = '无法提炼所选消息，请重试。';
    } finally {
      if (captureDraft === draft) { draft.busy = false; syncCaptureSelection(); }
    }
  });

  function renderAgentMessages(items) {
    const list = document.getElementById('message-list');
    list.replaceChildren();
    lastAgentItems = items || [];
    syncCaptureButton();
    document.getElementById('chat-empty').hidden = (items || []).length > 0;
    let pending = false;
    const pendingKeys = pendingMessageKeys();
    for (const item of items || []) {
      if (pendingKeys.has(item.client_key)) continue;
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
      if (item.attachments?.length && !item.body) body.hidden = true;
      if (waiting || failed) li.dataset.state = waiting ? item.status : 'failed';
      if (waiting) {
        const heading = document.createElement('p');
        heading.className = 'reply-state';
        heading.textContent = item.status === 'running' ? '正在生成回复' : '正在准备回复';
        li.append(role, heading, body);
      } else {
        li.append(role, body);
      }
      for (const attachment of item.attachments || []) li.append(renderChatFile(document,attachment));
      const sources = memorySources(item);
      if (sources) li.append(sources);
      if (item.role === 'assistant' && saveableAgentMessage(item)) {
        li.append(saveMessageButton(item, currentAgent.id));
      }
      list.append(li);
      if (waiting) pending = true;
    }
    setChatSubtitle(pending ? '正在回复…' : 'AI 智能体 · 经运行时回复', pending);
    renderPendingSend();
    attachmentSender?.render();
    const scroller = document.getElementById('message-scroller');
    scroller.scrollTop = scroller.scrollHeight;
    return pending;
  }

  let selecting = false;
  let forwardBusy = false;
  let forwardAttempt = null;
  const selectedMessages = new Set();
  let pinnedIds = new Set();

  function syncForwardBar() {
    const bar = document.getElementById('forward-bar');
    if (!bar) return;
    bar.hidden = !selecting;
    document.getElementById('forward-count').textContent = forwardCountLabel(selectedMessages.size);
    const target = document.getElementById('forward-target');
    document.getElementById('forward-submit').disabled = forwardBusy || !(selectedMessages.size && target.value);
    const capture = document.getElementById('selection-group-capture');
    if (capture) {
      capture.hidden = !servedByDsbot || currentSource !== 'social' || currentConversation?.kind !== 'group' || Boolean(currentConversation.public_agent);
      capture.disabled = !selectedMessages.size;
    }
    for (const id of ['selection-memory', 'selection-meeting']) {
      const action = document.getElementById(id);
      if (action) action.disabled = !selectedMessages.size;
    }
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
      li.dataset.pinnedMessage = item.message_id;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = item.excerpt || '查看置顶消息';
      if (item.pinned_by_username) button.title = '由 ' + item.pinned_by_username + ' 置顶';
      button.addEventListener('click', () => jumpToMessage(item.message_id));
      li.append(button);
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
        if (box.checked && selectedMessages.size >= 20) {
          box.checked = false;
          show('error', '一次最多转发 20 条消息。');
        } else if (box.checked) {
          selectedMessages.add(item.id);
        } else {
          selectedMessages.delete(item.id);
        }
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
    const scroller = document.getElementById('message-scroller');
    messageMenuTarget = {item, li, mine, scrollTop: scroller?.scrollTop};
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
    menu.querySelector('[data-menu="reply"]').hidden = currentConversation?.public_agent?.open === false
      || currentConversation?.direct?.open === false;
    menu.querySelector('[data-menu="retract"]').hidden = !mine;
    const edit = menu.querySelector('[data-menu="edit"]');
    if (edit) edit.hidden = !mine;
    menu.querySelector('[data-menu="forward"]').disabled = forwardTargets(socialConversations, currentConversation && currentConversation.id).length === 0;
    const publicThread = Boolean(currentConversation?.public_agent);
    for (const action of ['translate', 'ask', 'forward', 'select']) {
      menu.querySelector(`[data-menu="${action}"]`).hidden = publicThread;
    }
    menu.querySelector('[data-menu="save"]').hidden = publicThread || !saveableSocialMessage(item);
    menu.hidden = false;
    const width = menu.offsetWidth || 200, height = menu.offsetHeight || 360;
    const left = Math.max(8, Math.min(x, globalThis.innerWidth - width - 8));
    const top = Math.max(8, Math.min(y, globalThis.innerHeight - height - 8));
    menu.style.setProperty('left', left + 'px');
    menu.style.setProperty('top', top + 'px');
    const first = menu.querySelector('button:not(:disabled)');
    if (first) first.focus({preventScroll: true});
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
        const author = li.querySelector('.role')?.textContent || '成员';
        composeReply(item, author);
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
        const wid = workspaceId(), cid = currentConversation.id;
        const result = await request('DELETE', `${socialBase()}/${cid}/messages/${item.id}`)
          .catch(() => ({status: 0, body: {}}));
        if (wid !== workspaceId() || currentSource !== 'social' || currentConversation?.id !== cid) return;
        if (result.status !== 204) {
          show('error', messageFor(result.body.error, '消息未从你的会话删除，请重试。'));
          return;
        }
        socialOpen++;
        const visible = lastSocialItems.filter(row => row.id !== item.id).map(row =>
          row.reply_preview?.message_id === item.id
            ? {...row, reply_preview: {message_id: item.id, available: false}}
            : row);
        renderSocialMessages(visible, {refresh:true});
        const pin = document.querySelector?.(`#pinned-message-list [data-pinned-message="${item.id}"]`);
        pin?.remove();
        pinnedIds.delete(item.id);
        if (!pinnedIds.size) document.getElementById('pinned-messages').hidden = true;
        show('ok', '已从你的会话删除。', {announceOnly:true});
        void loadSessions();
      }
    });
    document.addEventListener('click', event => {
      if (!messageMenu.hidden && !messageMenu.contains(event.target)) closeMessageMenu();
    });
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && !messageMenu.hidden) closeMessageMenu(); });
    globalThis.addEventListener('resize', closeMessageMenu);
    const scroller = document.getElementById('message-scroller');
    if (scroller) scroller.addEventListener('scroll', () => {
      if (messageMenuTarget && scroller.scrollTop !== messageMenuTarget.scrollTop) closeMessageMenu();
    }, {passive: true});
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

  function openSaveMessage(item, agentId) {
    if (!currentConversation) return;
    const workspace = workspaceId(), conversation = currentConversation.id;
    const path = agentId ? agentSavePath(workspace, agentId, conversation, item.id)
      : socialSavePath(workspace, conversation, item.id);
    saveMessageTarget = {workspace, path, revision: agentId ? null : item.revision || 1};
    document.getElementById('save-message-title').value = defaultSaveTitle(item.body);
    document.getElementById('save-message-error').hidden = true;
    saveMessageDialog.showModal();
    document.getElementById('save-message-title').focus();
  }

  function saveMessageButton(item, agentId) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.save = item.id;
    button.textContent = '保存到资料空间';
    button.addEventListener('click', () => openSaveMessage(item, agentId));
    return button;
  }
  saveMessageDialog?.addEventListener('close', () => { saveMessageTarget = null; });
  const saveMessageCancel = document.getElementById('save-message-cancel');
  if (saveMessageCancel) saveMessageCancel.addEventListener('click', () => { saveMessageDialog.close(); saveMessageTarget = null; });
  const saveMessageForm = document.getElementById('save-message-form');
  if (saveMessageForm) saveMessageForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (!saveMessageTarget) return;
    const target = saveMessageTarget;
    const button = document.getElementById('save-message-submit');
    const error = document.getElementById('save-message-error');
    if (button.disabled) return;
    button.disabled = true; error.hidden = true;
    try {
      const body = {title: document.getElementById('save-message-title').value.trim()};
      if (target.revision !== null) body.revision = target.revision;
      const result = await request('POST', target.path, body);
      if (saveMessageTarget !== target || workspaceId() !== target.workspace) return;
      if (result.status !== 200 && result.status !== 201) {
        error.textContent = messageFor(result.body.error, '消息未保存，请重新打开消息后重试。'); error.hidden = false; return;
      }
      saveMessageDialog.close(); saveMessageTarget = null;
      const artifact = result.body.artifact;
      show('ok', result.status === 201 ? '已保存到资料空间。' : '资料空间里已有这条消息的副本。');
      if (artifact?.id) {
        const link = document.createElement('a');
        link.href = spaceHref(target.workspace, artifact.id);
        link.textContent = '打开文档';
        status.append(document.createTextNode(' '), link);
      }
    } catch {
      if (saveMessageTarget !== target) return;
      error.textContent = '无法确认保存结果，请重试。';
      error.hidden = false;
    }
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
  function hasPendingReplies(items = lastSocialItems) {
    return items?.some(item => item.reply_jobs?.some(job => job.status === 'queued' || job.status === 'running'));
  }

  function renderReplyJobs(item) {
    const rows = document.createElement('div');
    rows.className = 'group-reply-jobs';
    for (const job of item.reply_jobs || []) {
      if (job.status === 'replied') continue;
      const row = document.createElement('div');
      row.className = 'group-reply-job';
      row.dataset.state = job.status;
      const note = document.createElement('span');
      const states = {queued: ' · 等待回复', running: ' · 正在回复', failed: ' · 回复失败'};
      note.textContent = job.agent_name + (states[job.status] || '');
      row.append(note);
      if (job.can_retry) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = '重试';
        button.setAttribute('aria-label', '重试 ' + job.agent_name);
        button.addEventListener('click', async () => {
          const cid = currentConversation.id;
          const wid = workspaceId();
          button.disabled = true;
          button.textContent = '重试中…';
          const result = await request('POST', `${socialBase()}/${cid}/messages/${item.id}/agent-retry`, {job_id: job.id})
            .catch(() => ({status: 0, body: {}}));
          if (workspaceId() !== wid || currentSource !== 'social' || currentConversation?.id !== cid) return;
          if (result.status === 200) {
            // A response from a poll started before the click may still be in flight.
            socialOpen++;
            const list = document.getElementById('message-list');
            const message = lastSocialItems.find(current => current.id === item.id);
            if (message) {
              message.reply_jobs = result.body.reply_jobs;
              const updated = renderReplyJobs(message);
              const target = [...list.children].find(element => element.dataset.messageId === item.id);
              target?.querySelector('.group-reply-jobs')?.replaceWith(updated);
            }
            if (!socialHistory?.readingHistory) scheduleSocialPoll(currentConversation);
            show('ok', '已重新请求 ' + job.agent_name + ' 回复。', {announceOnly: true});
          } else {
            button.disabled = false;
            button.textContent = '重试';
            show('error', messageFor(result.body.error, '暂时无法重试，请稍后再试。'));
          }
        });
        row.append(button);
      }
      rows.append(row);
    }
    return rows;
  }

  const groupMemoryDialog = document.getElementById('group-memory-dialog');
  const groupMemoryStatus = document.getElementById('group-memory-status');
  const groupMemoryList = document.getElementById('group-memory-list');
  const groupMemoryAuto = document.getElementById('group-memory-auto');
  const groupMemoryAutoStatus = document.getElementById('group-memory-auto-status');
  let groupMemoryView = null;

  function groupMemoryButton(label, action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', action);
    return button;
  }

  const groupMemoryActive = view => groupMemoryDialog?.open && groupMemoryView === view && sendScope() === view.scope;
  groupMemoryAuto?.addEventListener('click', async () => {
    const view = groupMemoryView;
    if (!groupMemoryActive(view) || typeof view.autoCapture !== 'boolean') return;
    const enabled = !view.autoCapture;
    groupMemoryAuto.setAttribute('aria-checked', String(enabled));
    groupMemoryAuto.disabled = true;
    groupMemoryAutoStatus.textContent = '';
    const result = await request('POST', `${view.path}/auto-capture`,{enabled})
      .catch(() => ({status:0,body:{}}));
    if (!groupMemoryActive(view)) return;
    if (result.status === 200) view.autoCapture = result.body.enabled === true;
    else groupMemoryAutoStatus.textContent = messageFor(result.body.error,'设置保存失败，请重试。');
    groupMemoryAuto.setAttribute('aria-checked', String(view.autoCapture));
    groupMemoryAuto.disabled = false;
  });

  async function openGroupMemory(highlight) {
    if (!servedByDsbot || currentSource !== 'social' ||
        currentConversation?.kind !== 'group' || currentConversation.public_agent) return;
    const view = {scope:sendScope(), path:`${socialBase()}/${currentConversation.id}/shared-memory`};
    groupMemoryView = view;
    const active = () => groupMemoryActive(view);
    groupMemoryAuto.disabled = true;
    groupMemoryAuto.setAttribute('aria-checked','false');
    groupMemoryAutoStatus.textContent = '';
    document.getElementById('group-memory-inbox').href = '/memory?'+new URLSearchParams({workspace:workspaceId(),page:'candidates'});
    groupMemoryList.replaceChildren();
    groupMemoryStatus.textContent = '正在读取群记忆…';
    if (!groupMemoryDialog.open) groupMemoryDialog.showModal();
    const result = await request('GET', view.path).catch(() => ({status:0,body:{}}));
    if (!active()) return;
    if (result.status !== 200) {
      groupMemoryStatus.textContent = messageFor(result.body.error,'群记忆加载失败，请重试。');
      return;
    }
    view.autoCapture = result.body.auto_capture === true;
    groupMemoryAuto.setAttribute('aria-checked',String(view.autoCapture));
    groupMemoryAuto.disabled = false;
    const items = result.body.items || [];
    const selected = items.find(item => item.id === highlight);
    groupMemoryStatus.textContent = highlight && !selected ? '这条群记忆已失效或被移除。'
      : items.length ? '' : '还没有共享的记忆。';
    const rows = items.map(item => {
      const row = document.createElement('li');
      const title = document.createElement('h3');
      title.textContent = item.title;
      const body = document.createElement('p');
      body.className = 'group-memory-body';
      body.textContent = item.body;
      const author = document.createElement('p');
      author.className = 'note';
      author.textContent = item.author;
      const actions = document.createElement('div');
      actions.className = 'group-memory-actions';
      const source = groupMemoryButton('查看原消息', async () => {
        groupMemoryDialog.close();
        setGroupInfoOpen(false);
        if (await jumpToMessage(item.source_message_id, null) === false && sendScope() === view.scope) {
          show('error', '这条原消息已无法查看。');
        }
      });
      actions.append(source);
      if (item.can_remove) {
        const remove = groupMemoryButton('移除', () => {
          const confirm = groupMemoryButton('确认移除', async () => {
            confirm.disabled = cancel.disabled = true;
            const result = await request('POST', `${view.path}/${encodeURIComponent(item.id)}/remove`, {})
              .catch(() => ({status:0,body:{}}));
            if (!active()) return;
            if (result.status === 200) await openGroupMemory();
            else {
              confirm.disabled = cancel.disabled = false;
              groupMemoryStatus.textContent = messageFor(result.body.error,'移除失败，请重试。');
            }
          });
          const cancel = groupMemoryButton('取消', () => {
            actions.replaceChildren(source, remove);
            remove.focus();
          });
          actions.replaceChildren(source, confirm, cancel);
          confirm.focus();
        });
        actions.append(remove);
      }
      row.append(title, author, body, actions);
      return row;
    });
    groupMemoryList.replaceChildren(...rows);
    if (selected) {
      const row = rows[items.indexOf(selected)];
      row.tabIndex = -1;
      row.focus();
    }
  }

  function renderGroupMemoryRefs(refs) {
    const block = document.createElement('div');
    block.className = 'group-memory-refs';
    const label = document.createElement('span');
    label.textContent = '参考群记忆';
    block.append(label, ...refs.map(ref => groupMemoryButton(ref.title, () => openGroupMemory(ref.id))));
    return block;
  }

  function renderSocialMessages(items, {keepScroll = Boolean(socialHistory?.readingHistory), refresh = false} = {}) {
    const translateRoom = currentConversation?.kind === 'group' || (currentConversation?.kind === 'dm' && chatPreferences.auto_translate === true);
    autoTranslation.open(servedByDsbot && currentUser && translateRoom && !currentConversation?.public_agent
      ? {user:currentUser.id,wid:workspaceId(),cid:currentConversation.id}
      : null);
    autoTranslation.clearRows();
    const scroller = document.getElementById('message-scroller');
    const oldHeight = scroller.scrollHeight;
    const oldTop = scroller.scrollTop;
    const wasAtLatest = oldHeight - oldTop - scroller.clientHeight < 48;
    clearVoicePlayers();
    lastSocialItems = items || [];
    const list = document.getElementById('message-list');
    list.replaceChildren();
    document.getElementById('chat-empty').hidden = (items || []).length > 0;
    const people = currentConversation && currentConversation.members || members;
    const pendingKeys = pendingMessageKeys();
    for (const item of items || []) {
      if (pendingKeys.has(item.client_key)) continue;
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
      if (item.attachment?.bytes !== undefined && item.body === item.attachment.title) body.hidden = true;
      renderMessageBody(document, body, item.retracted ? '此消息已撤回' : (item.body || ''), chatPreferences);
      if (item.forwarded_from && !item.retracted) {
        body.dataset.forwarded = '1';
        body.title = '转发自 ' + item.forwarded_from.author;
        role.textContent += ' · 转发自 ' + item.forwarded_from.author;
      }
      if (item.mode && normalizeMode(item.mode) !== 'auto' && !item.retracted) {
        const chip = document.createElement('span');
        chip.className = 'mode-chip';
        chip.dataset.mode = normalizeMode(item.mode);
        chip.textContent = modeLabel(item.mode);
        chip.title = '发送时选择的模式：' + modeLabel(item.mode);
        role.append(document.createTextNode(' · '), chip);
      }
      const time = document.createElement('p');
      time.className = 'time';
      time.textContent = formatTime(item.created);
      li.append(role);
      if (!item.retracted && item.reply_preview) li.append(quoteBlock(item.reply_preview, true));
      li.append(body, time);
      if (!item.retracted && item.reply_jobs?.length) li.insertBefore(renderReplyJobs(item), time);
      if (!item.retracted && item.group_memory_refs?.length) li.insertBefore(renderGroupMemoryRefs(item.group_memory_refs), time);
      if (!mine) autoTranslation.add(item,li,body);
      if (item.voice && !item.retracted) li.insertBefore(voicePlayer(item), time);
      if (item.attachment?.bytes !== undefined && !item.retracted) {
        li.insertBefore(renderChatFile(document, item.attachment), time);
      } else if (item.attachment && !item.retracted) {
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
      if (item.role === 'agent' && !item.retracted && currentConversation?.public_agent?.open !== false
        && currentConversation?.direct?.open !== false) {
        const reply = document.createElement('button');
        reply.type = 'button';
        reply.textContent = '回复';
        reply.setAttribute('aria-label', '回复 ' + item.agent_name);
        reply.addEventListener('click', () => composeReply(item, item.agent_name || '智能体'));
        li.append(reply);
      }
      if (item.role === 'agent' && !currentConversation?.public_agent && saveableSocialMessage(item)) li.append(saveMessageButton(item));
      if (!item.retracted && (item.role !== 'agent' || selecting)) li.append(messageTools(item));
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
    renderPendingSend();
    attachmentSender?.render();
    if (keepScroll) scroller.scrollTop = Math.max(0, oldTop + scroller.scrollHeight - oldHeight);
    else scroller.scrollTop = refresh && !wasAtLatest ? oldTop : scroller.scrollHeight;
    return false;
  }

  function setDirectoryLink(session) {
    if (!session || session.source !== 'social') {
      document.getElementById('social-agent-members').hidden = true;
      document.getElementById('group-agent-action').hidden = true;
    }
    const link = document.getElementById('open-agent-dir');
    link.hidden = Boolean(session?.public_agent);
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

  const liveBanner = document.getElementById('conversation-live-update');
  const workspaceEvents = servedByDsbot
    ? mountChatActivity(document, {request, update: applySocialActivity})
    : mountWorkspaceEvents(document, {onInvalidate: async event => {
        if (event.workspace !== workspaceId() || document.visibilityState === 'hidden') return;
        if (event.changed.includes('notifications')) void chatCalls.refresh();
        await loadSessions();
        if (event.workspace === workspaceId() && !event.initial && event.changed.includes('social')
          && currentSource === 'social' && currentConversation && liveBanner) liveBanner.hidden = false;
      }});

  function viewingSocialMessages() {
    return !narrowScreen() || !document.body.classList.contains('sessions-open');
  }

  function readingSocialContext() {
    const scroller = document.getElementById('message-scroller');
    return socialHistory?.readingHistory || socialHistory?.loading || selecting
      || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 48
      || document.activeElement?.closest?.('.message-edit-controls')
      || [...(scroller.querySelectorAll?.('audio') || [])].some(audio => !audio.paused);
  }

  async function applySocialActivity(wid, items) {
    if (!currentUser || wid !== workspaceId() || wid !== sessionsWorkspace) return;
    const cid = currentSource === 'social' && currentConversation?.id;
    const next = items.find(row => row.id === cid);
    if (next && viewingSocialMessages() && socialHistory?.cid === cid
      && next.activity_version !== currentConversation.activity_version && !pendingSends.get(sendScope())?.active) {
      if (readingSocialContext()) {
        if (liveBanner) liveBanner.hidden = false;
      } else {
        await openSocialConversation(cid, {refresh: true});
      }
    }
    if (!currentUser || wid !== workspaceId() || wid !== sessionsWorkspace || document.visibilityState === 'hidden') return;
    const listed = new Map(socialConversations.map(row => [row.id, row]));
    const directoryChanged = items.length !== listed.size || items.some(row => {
      const old = listed.get(row.id);
      return !old || old.activity_version !== row.activity_version || old.unread_count !== row.unread_count
        || old.pinned !== row.pinned || old.muted !== row.muted;
    });
    if (!directoryChanged) return;
    const sequence = sessionsRequest;
    const user = currentUser;
    const result = await request('GET', `${socialBase()}?limit=100`);
    if (sequence !== sessionsRequest || user !== currentUser || wid !== workspaceId() || result.status !== 200) return;
    const changed = result.body.items || [];
    const incoming = changed.some(row => !listed.has(row.id) || row.last_seq > listed.get(row.id).last_seq);
    socialConversations = changed;
    sessions = sortSessions([...sessions.filter(row => row.source === 'agent'), ...mergeSessions([], changed, user.id)]);
    renderSessions();
    if (incoming || !document.getElementById('notifications-panel')?.hidden) void loadNotifications();
    if (['all', 'groups'].includes(searchTab)) refreshDirectorySearch();
  }

  document.getElementById('conversation-live-load')?.addEventListener('click', async () => {
    if (currentSource === 'social' && currentConversation) await openSocialConversation(currentConversation.id);
  });
  let sessionsRequest = 0, sessionsWorkspace = null, sessionsUser = null;
  let membersStatus = '', artifactsStatus = '';
  async function loadSessions() {
    const sequence = ++sessionsRequest;
    const user = currentUser;
    loadNotifications();
    loadDueReminders();
    const id = workspaceId();
    if (servedByDsbot && id !== sessionsWorkspace) workspaceEvents.start(null);
    if (id !== sessionsWorkspace || user !== sessionsUser || !id) {
      setSessionsStatus('正在加载对话…');
      sessionsWorkspace = id; sessionsUser = user;
      sessions = []; agents = []; members = []; artifacts = []; socialConversations = [];
      membersStatus = artifactsStatus = 'loading';
      renderSessions();
    }
    if (!id) return;
    const isLocalPersonal = inPersonalWorkspace();
    const current = () => sequence === sessionsRequest && id === workspaceId() && user === currentUser;
    const path = `/v1/workspaces/${id}`;
    const read = suffix => request('GET', path + suffix).catch(() => ({status: 0, body: {}}));
    if (isLocalPersonal) {
      const picking = !document.getElementById('compose-dialog').hidden && composeMode === 'group';
      if (picking || (isSearchOpen() && ['all','contacts'].includes(searchTab))) void loadPersonalContacts();
    } else {
      void read('/members').then(result => {
        if (!current()) return;
        membersStatus = result.status === 200 ? '' : 'failed';
        if (!membersStatus) members = result.body.items || [];
        if (!document.getElementById('compose-dialog').hidden) renderMemberChoices(composeMode === 'contact', true);
        if (['all', 'contacts'].includes(searchTab)) refreshDirectorySearch();
      });
    }
    void read('/artifacts?limit=100').then(result => {
      if (!current()) return;
      artifactsStatus = result.status === 200 ? '' : 'failed';
      if (!artifactsStatus) artifacts = result.body.items || [];
      if (['all', 'artifacts', 'documents', 'media'].includes(searchTab)) refreshDirectorySearch();
    });
    const [listed, social] = await Promise.all([
      read('/agents?limit=100&include=conversations'),
      read('/social/conversations?limit=100'),
    ]);
    if (!current()) return;
    const nextAgents = listed.status === 200 ? listed.body.items || [] : [];
    let rows = listed.body.conversations;
    let partial = listed.status !== 200 || social.status !== 200;
    if (!Array.isArray(rows)) {
      // A tab served by a previous runtime image may still return only the agent list.
      const results = await Promise.all(nextAgents.map(async agent => ({
        agent, response: await read(`/agents/${agent.id}/conversations?limit=100`),
      })));
      if (!current()) return;
      rows = results.flatMap(({agent, response}) => response.status === 200
        ? (response.body.items || []).map(row => ({...row, agent_id: agent.id})) : []);
      partial ||= results.some(({response}) => response.status !== 200);
    }
    agents = nextAgents;
    socialConversations = social.status === 200 ? social.body.items || [] : [];
    const agentById = new Map(agents.map(agent => [agent.id, agent]));
    sessions = mergeSessions(rows.flatMap(row => {
      const agent = agentById.get(row.agent_id);
      return agent ? [{...row, agent}] : [];
    }), socialConversations, currentUser && currentUser.id);
    setSessionsStatus(partial ? '部分对话加载失败，请重试。' : '');
    renderSessions();
    if (!document.getElementById('compose-dialog').hidden && composeMode === 'group') renderMemberChoices(false, true);
    if (['all', 'agents', 'groups'].includes(searchTab)) refreshDirectorySearch();
    // Start activity checks after the initial directory commits.
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
    document.getElementById('group-info-invite').hidden = which !== 'people';
  }

  const groupInvite = document.getElementById('group-invite-dialog');
  const groupInviteQuery = document.getElementById('group-invite-query');
  const groupInviteChoices = document.getElementById('group-invite-choices');
  const groupInviteStatus = document.getElementById('group-invite-status');
  const groupInviteSubmit = document.getElementById('group-invite-submit');
  let inviteTarget = null;
  let invitingMembers = false;

  const inviteMatches = (target) => target && target.workspace === workspaceId() &&
    currentSource === 'social' && currentConversation?.id === target.conversation;
  const selectedInviteMembers = () => [...groupInviteChoices.querySelectorAll('input:checked')].map(box => box.value);

  function syncGroupInviteSubmit(count = selectedInviteMembers().length) {
    groupInviteSubmit.disabled = invitingMembers || count < 1 || count > 50;
  }

  function syncGroupInvite() {
    const needle = groupInviteQuery.value.trim().toLocaleLowerCase();
    let visible = 0;
    for (const choice of groupInviteChoices.children) {
      choice.hidden = !choice.textContent.toLocaleLowerCase().includes(needle);
      if (!choice.hidden) visible++;
    }
    const count = selectedInviteMembers().length;
    syncGroupInviteSubmit(count);
    if (groupInviteChoices.children.length) {
      groupInviteStatus.textContent = count > 50 ? '一次最多添加 50 位成员。'
        : !visible ? '没有匹配的成员。'
        : count ? `已选 ${count} 位成员` : '';
    }
  }

  async function openGroupInvite() {
    const conversation = currentConversation;
    if (currentSource !== 'social' || conversation?.kind !== 'group' || groupInvite.open) return;
    const target = {workspace: workspaceId(), conversation: conversation.id};
    inviteTarget = target;
    groupInviteQuery.value = '';
    groupInviteChoices.replaceChildren();
    groupInviteSubmit.disabled = true;
    const personal = Boolean(conversation.account_group);
    const roster = personal ? '联系人' : '工作区成员';
    groupInviteStatus.textContent = '正在加载' + roster + '…';
    document.getElementById('group-invite-context').textContent = conversationLabel(conversation, currentUser?.id);
    groupInvite.showModal();
    groupInviteQuery.focus();
    const result = await request('GET', personal ? '/v1/contacts' : `/v1/workspaces/${target.workspace}/members`).catch(() => ({status: 0}));
    if (inviteTarget !== target || !inviteMatches(target) || !groupInvite.open) return;
    if (result.status !== 200) {
      groupInviteStatus.textContent = '无法加载' + roster + '，请重新打开后再试。';
      return;
    }
    const joined = new Set((currentConversation.members || []).map(member => personal ? member.handle : member.user_id));
    const candidates = memberChoices(personal ? contactMembers(result) : result.body.items, currentUser?.id)
      .filter(member => member.user_id && !member.suspended && !joined.has(member.user_id));
    for (const member of candidates) {
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = member.handle || member.user_id;
      label.append(box, document.createTextNode(member.username || box.value));
      groupInviteChoices.append(label);
    }
    groupInviteStatus.textContent = candidates.length ? '' : '没有可添加的' + roster + '。';
    syncGroupInvite();
  }

  document.getElementById('chat-group-invite').addEventListener('click', openGroupInvite);
  document.getElementById('group-info-invite').addEventListener('click', openGroupInvite);
  document.getElementById('group-invite-cancel').addEventListener('click', () => groupInvite.close());
  groupInvite.addEventListener('close', () => { if (!groupInvite.open) inviteTarget = null; });
  groupInvite.addEventListener('cancel', event => { if (invitingMembers) event.preventDefault(); });
  groupInviteQuery.addEventListener('input', syncGroupInvite);
  groupInviteChoices.addEventListener('change', syncGroupInvite);
  document.getElementById('group-invite-form').addEventListener('submit', async event => {
    event.preventDefault();
    const target = inviteTarget;
    const memberIds = selectedInviteMembers();
    if (invitingMembers || !inviteMatches(target) || !memberIds.length || memberIds.length > 50) return;
    invitingMembers = true;
    const cancel = document.getElementById('group-invite-cancel');
    cancel.disabled = true;
    groupInviteSubmit.disabled = true;
    groupInviteSubmit.textContent = '添加中…';
    try {
      const path = `/v1/workspaces/${target.workspace}/social/conversations/${target.conversation}/members`;
      const result = await request('POST', path, {member_ids: memberIds});
      if (!inviteMatches(target) || inviteTarget !== target) return;
      if (result.status !== 200 || result.body.conversation?.id !== target.conversation) {
        groupInviteStatus.textContent = result.status === 403 ? '所选成员的权限有变化，请重新打开后再试。'
          : result.status === 404 ? '群聊或工作区成员有变化，请刷新后再试。' : '无法添加成员，请重试。';
        return;
      }
      currentConversation = result.body.conversation;
      const title = conversationLabel(currentConversation, currentUser?.id);
      applyChatIdentity(document, title, currentConversation);
      setChatSubtitle(groupInfoCounts(currentConversation).text);
      setGroupInfo(currentConversation);
      groupInvite.close();
      show('ok', '群成员已更新。');
    } catch {
      if (inviteMatches(target) && inviteTarget === target) groupInviteStatus.textContent = '暂时无法确认添加结果，可以重试。';
    } finally {
      invitingMembers = false;
      cancel.disabled = false;
      groupInviteSubmit.textContent = '添加';
      syncGroupInviteSubmit();
    }
  });

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
    if (!conversation) autoTranslation.open(null);
    const toggle = document.getElementById('group-info-toggle');
    const panel = document.getElementById('group-info-panel');
    if (!toggle || !panel) return;
    const group = Boolean(conversation && conversation.kind === 'group' && !conversation.public_agent);
    if (groupInvite.open && (!group || !inviteMatches(inviteTarget))) groupInvite.close();
    if (groupMemoryDialog?.open && (!group || groupMemoryView?.scope !== sendScope())) groupMemoryDialog.close();
    const memoryOpen = document.getElementById('group-memory-open');
    if (memoryOpen) memoryOpen.hidden = !group || !servedByDsbot;
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
      memberRow(member.username, currentUser && member.user_id === currentUser.id ? '你' : (conversation.account_group ? '群成员' : '工作区成员'), 'person')));
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

  function showPublicChatState(state) {
    const notice = document.getElementById('public-chat-status');
    const directClosed = currentSource === 'social' && currentConversation?.direct?.open === false;
    if (notice) {
      notice.textContent = state?.open === false ? '发布者已关闭访客聊天。'
        : directClosed ? '联系人关系已解除，仍可查看历史消息。'
          : state?.pending ? '正在等待智能体回复…' : '';
      notice.hidden = !notice.textContent;
    }
    document.getElementById('chat-body').disabled = state?.open === false || directClosed;
    document.getElementById('chat-send').disabled = state?.open === false || directClosed;
  }

  function setSocialHeaderTools(social) {
    if (social && captureButton) captureButton.hidden = true;
    const invite = document.getElementById('chat-invite');
    const publicChat = social ? currentConversation?.public_agent : null;
    showPublicChatState(publicChat);
    const group = social && currentConversation?.kind === 'group' && !publicChat;
    document.getElementById('chat-group-invite').hidden = !group;
    const multi = document.getElementById('multi-select-toggle');
    if (invite) invite.hidden = !social || group || Boolean(publicChat);
    if (multi) multi.hidden = !social || Boolean(publicChat);
    if (!social || group || publicChat) {
      const panel = document.getElementById('chat-invite-panel');
      if (panel) panel.hidden = true;
      invite?.setAttribute('aria-expanded', 'false');
    }
    if (!social || publicChat) {
      selecting = false; selectedMessages.clear(); syncForwardBar();
      if (!social) renderPinned([]);
    }
  }

  function openEmptyAgentChat(agentId) {
    const agent = agents.find(item => item.id === agentId);
    if (!agent) return;
    socialOpen += 1;
    currentConversation = null;
    currentAgent = agent;
    currentSource = 'agent';
    stopPolling();
    setSocialHistory(null);
    autoTranslation.open(null);
    agentMentions.clear();
    voiceRecorder.clear();
    voiceRecorder.refresh();
    clearVoicePlayers();
    chatCalls.sync();
    setSocialHeaderTools(false);
    setGroupInfo(null);
    renderReplyDraft();
    if (liveBanner) liveBanner.hidden = true;
    document.getElementById('social-agent-members').hidden = true;
    document.getElementById('pin-conversation').hidden = true;
    setDirectoryLink({source:'agent'});
    applyChatIdentity(document, agent.name, null, agent.id === personalAgentId ? personalLook : null);
    writeHash({workspace:workspaceId(), agent:agentId});
    setSessionsOpen(false);
    renderAgentMessages([]);
    syncPlusState();
  }

  async function openAgentConversation(agentId, conversationId) {
    const open = ++socialOpen;
    const wid = workspaceId();
    const result = await request('GET', `/v1/workspaces/${wid}/agents/${agentId}/conversations/${conversationId}`);
    if (open !== socialOpen || workspaceId() !== wid) return false;
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法打开对话。'));
      return false;
    }
    const agent = agents.find(item => item.id === agentId) || result.body.agent;
    if (!agent) return false;
    setSocialHistory(null);
    agentMentions.clear();
    voiceRecorder.clear();
    clearVoicePlayers();
    setSocialHeaderTools(false);
    setGroupInfo(null);
    const pin = document.getElementById('pin-conversation');
    if (pin) pin.hidden = true;
    syncMuteButton();
    currentSource = 'agent';
    currentAgent = agent;
    renderReplyDraft();
    if (liveBanner) liveBanner.hidden = true;
    chatCalls.sync();
    voiceRecorder.refresh();
    document.getElementById('social-agent-members').hidden = true;
    setDirectoryLink({source: 'agent'});
    syncPlusState();
    applyChatIdentity(document, agent.name);
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
      const acknowledged = await request('POST', `/v1/workspaces/${wid}/agents/${agentId}/conversations/${conversationId}/read`,
        {message_id: finished[finished.length - 1].id});
      if (open !== socialOpen || workspaceId() !== wid) return false;
      if (acknowledged.status === 200) {
        const session = sessions.find(item => item.source === 'agent' && item.id === conversationId);
        if (session) session.unread_count = acknowledged.body.unread_count;
      }
    }
    renderSessions();
    if (pending) schedulePoll();
    else stopPolling();
    return open === socialOpen && workspaceId() === wid;
  }

  async function openSocialConversation(conversationId, {acknowledge = true, refresh = false} = {}) {
    const open = ++socialOpen;
    const wid = workspaceId();
    if (currentConversation?.id !== conversationId) {
      setSocialHistory(null);
      voiceRecorder.clear();
    }
    currentAgent = null;
    currentSource = 'social';
    stopPolling();
    const result = await request('GET', `${socialBase()}/${conversationId}`).catch(() => ({status: 0, body: {}}));
    if (open !== socialOpen || workspaceId() !== wid || currentSource !== 'social') return false;
    if (result.status !== 200) {
      if (refresh) {
        scheduleSocialPoll(currentConversation);
        return false;
      }
      show('error', messageFor(result.body.error, '无法打开会话。'));
      return false;
    }
    const updated = result.body.conversation;
    if (refresh && servedByDsbot && (!viewingSocialMessages() || readingSocialContext() || pendingSends.get(sendScope())?.active)) {
      if (viewingSocialMessages() && liveBanner && updated.activity_version !== currentConversation?.activity_version) liveBanner.hidden = false;
      scheduleSocialPoll(currentConversation);
      return false;
    }
    if (refresh && currentConversation?.id === updated.id
      && JSON.stringify(currentConversation) === JSON.stringify(updated)
      && JSON.stringify(lastSocialItems) === JSON.stringify(result.body.items)) {
      scheduleSocialPoll(updated);
      return true;
    }
    if (!currentConversation || currentConversation.id !== updated.id) {
      const panel = document.getElementById('conversation-search-panel'); if (panel) panel.hidden = true;
      const hits = document.getElementById('conversation-search-results'); if (hits) hits.replaceChildren();
    }
    currentConversation = updated;
    restoreComposerMode(currentConversation.id);
    renderReplyDraft();
    if (liveBanner) liveBanner.hidden = true;
    setSocialHistory({wid, cid: conversationId, cursor: result.body.cursor ?? null});
    chatCalls.sync();
    agentMentions.refresh();
    voiceRecorder.refresh();
    setSessionsOpen(false);
    const pin = document.getElementById('pin-conversation');
    syncMuteButton(currentConversation);
    if (pin) { pin.hidden = false; pin.textContent = sessions.find(item => item.id === conversationId && item.pinned) ? '取消置顶' : '置顶会话'; }
    const agentNote = document.getElementById('social-agent-members');
    agentNote.textContent = groupAgentSummary(currentConversation);
    agentNote.hidden = Boolean(currentConversation.public_agent) || !agentNote.textContent;
    applyChatIdentity(document, conversationLabel(
      currentConversation, currentUser && currentUser.id), currentConversation);
    setDirectoryLink({source: 'social', public_agent: currentConversation.public_agent});
    writeHash({workspace: workspaceId(), social: conversationId});
    if (selecting && (!lastSocialItems.length || lastSocialItems[0].conversation_id !== conversationId)) {
      selecting = false; selectedMessages.clear(); syncForwardBar();
    }
    renderPinned(result.body.pinned_messages || []);
    setSocialHeaderTools(true);
    syncPlusState();
    setGroupInfo(currentConversation);
    messageUtilities.refreshAnnouncement();
    const publicChat = currentConversation.public_agent;
    setChatSubtitle(publicChat ? '公开智能体 · 发布者可查看此对话'
      : currentConversation.kind === 'group' ? groupInfoCounts(currentConversation).text
        : '单聊 · ' + ((currentConversation.members || []).length) + ' 人');
    renderSocialMessages(result.body.items, {refresh});
    renderGroupReplyAction(result.body.agent_replies || []);
    // Acknowledge only the last message actually rendered, not messages that
    // arrived after this snapshot, and never consume unread in a hidden tab.
    const shown = result.body.items || [];
    if (acknowledge && currentConversation.unread_count > 0 && shown.length && document.visibilityState !== 'hidden') {
      const acknowledged = await request('POST', `${socialBase()}/${conversationId}/read`,
        Number.isSafeInteger(shown[shown.length - 1].seq)
          ? {seq: shown[shown.length - 1].seq}
          : {message_id: shown[shown.length - 1].id});
      if (open !== socialOpen || workspaceId() !== wid || currentSource !== 'social') return false;
      if (acknowledged.status === 200) {
        const unread = acknowledged.body.unread_count;
        currentConversation.unread_count = unread;
        const session = sessions.find(item => item.source === 'social' && item.id === conversationId);
        if (session) session.unread_count = unread;
        const directory = socialConversations.find(item => item.id === conversationId);
        if (directory) directory.unread_count = unread;
      }
    }
    renderSessions();
    scheduleSocialPoll(currentConversation);
    if ((result.body.agent_replies || []).some(item => ['queued', 'running'].includes(item.status))) schedulePoll();
    return true;
  }

  function scheduleSocialPoll(conversation) {
    if (hasPendingReplies() || conversation?.public_agent?.pending) {
      schedulePoll(servedByDsbot ? 8000 : 1800);
    } else if (!servedByDsbot && pollsAccountThread(conversation)) {
      schedulePoll(8000);
    }
  }

  function pollsAccountThread(conversation) {
    return Boolean(conversation?.public_agent?.open || conversation?.direct?.open || conversation?.account_group);
  }

  function schedulePoll(delay = 2000) {
    stopPolling();
    pollTimer = globalThis.setTimeout(() => {
      pollTimer = 0;
      if (currentConversation && currentAgent && currentSource === 'agent') {
        openAgentConversation(currentAgent.id, currentConversation.id);
      } else if (currentConversation && currentSource === 'social' && !socialHistory?.readingHistory) {
        if (document.visibilityState !== 'hidden' && viewingSocialMessages() && (!servedByDsbot || !readingSocialContext())) {
          openSocialConversation(currentConversation.id, {refresh: true});
        } else if (servedByDsbot && viewingSocialMessages()) {
          scheduleSocialPoll(currentConversation);
        }
      }
    }, delay);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || currentSource !== 'social' || !currentConversation
      || pollTimer || socialHistory?.readingHistory || !viewingSocialMessages()) return;
    if (servedByDsbot) scheduleSocialPoll(currentConversation);
    else if (pollsAccountThread(currentConversation) || hasPendingReplies()) {
      void openSocialConversation(currentConversation.id, {refresh: true});
    }
  });

  function closeComposeMenu() {
    const menu = document.getElementById('compose-menu');
    const button = document.getElementById('new-conversation');
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  }

  function selectedMemberCount() {
    return document.querySelectorAll('#member-choices input:checked').length;
  }

  let composing = false;
  let composeAttempt = null;
  function syncComposeCreate() {
    const button = document.getElementById('compose-dialog-submit');
    button.disabled = composing || !composeCreateEnabled({
      composeMode,
      groupMode,
      personal: inPersonalWorkspace(),
      selectedAgentCount: document.querySelectorAll('#member-choices input[name="agent-member"]:checked').length,
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
      const roster = inPersonalWorkspace() ? '联系人' : '工作区成员';
      empty.textContent = membersStatus === 'loading' ? '正在加载' + roster + '…'
        : (membersStatus === 'failed' ? '无法加载' + roster + '。' : '没有可邀请的' + roster + '。');
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

  function renderMemberChoices(single, preserveSelection = false) {
    const holder = document.getElementById('member-choices');
    const selected = preserveSelection
      ? new Set([...document.querySelectorAll('#member-choices input:checked')].map(box => box.name + ':' + box.value))
      : new Set();
    holder.replaceChildren();
    const choices = groupPickerChoices(members, currentUser && currentUser.id, single ? [] : agents);
    for (const member of choices) {
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = single ? 'radio' : 'checkbox';
      box.name = member.kind === 'agent' ? 'agent-member' : 'member';
      box.value = member.id;
      box.checked = selected.has(box.name + ':' + box.value);
      const text = document.createElement('span');
      text.className = 'choice-label';
      text.textContent = member.label;
      label.append(box, text);
      holder.append(label);
    }
    applyMemberFilter();
    syncSelectedCount();
  }

  let contactsRead = 0;
  async function loadPersonalContacts() {
    const version = ++contactsRead;
    const wid = workspaceId();
    const user = currentUser;
    membersStatus = 'loading';
    const result = await request('GET', '/v1/contacts').catch(() => ({status:0}));
    if (version !== contactsRead || wid !== workspaceId() || user !== currentUser || !inPersonalWorkspace()) return;
    membersStatus = result.status === 200 ? '' : 'failed';
    if (!membersStatus) members = contactMembers(result);
    if (!document.getElementById('compose-dialog').hidden) renderMemberChoices(false, true);
    refreshDirectorySearch();
  }

  function openComposeDialog(mode) {
    closeComposeMenu();
    composeMode = mode;
    const dialog = document.getElementById('compose-dialog');
    dialog.hidden = false;
    const isGroup = mode === 'group';
    document.getElementById('compose-dialog-title').textContent = isGroup ? '新建群组' : '工作区私聊';
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
    if (isGroup && inPersonalWorkspace()) void loadPersonalContacts();
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
    if (inPersonalWorkspace() && ['all', 'contacts'].includes(searchTab)) void loadPersonalContacts();
    renderSearch();
  }

  function refreshDirectorySearch() {
    if (isSearchOpen() && !messageSearch.state.loading) void renderSearch({reuseMessages: true});
  }

  function closeSearchPanel() {
    searchSeq++;
    void messageSearch.load('');
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
      preview: member.contact ? '联系人' : '工作区成员',
      ...(member.contact ? {href:'/contacts'} : {}),
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
    const paged = searchTab === 'messages' || searchTab === 'all';
    results.replaceChildren();
    empty.hidden = true;
    note.hidden = Boolean(query) && !searchConversation;
    note.textContent = searchConversation
      ? '仅搜索当前对话：' + searchConversationTitle
      : '搜索当前工作区。';
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
    if (paged && query) {
      if (!reuseMessages) await messageSearch.load(query, searchConversation);
      if (seq !== searchSeq) return;
      const state = messageSearch.state;
      if (state.error && searchTab === 'messages' && !state.hits.length) {
        empty.hidden = false;
        empty.textContent = state.error;
        applySearchMore(document.getElementById('search-more'), {cursor: '', loading: false});
        return;
      }
      if (state.warning) {
        note.hidden = false;
        note.textContent = state.warning;
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
          else openEmptyAgentChat(item.id);
        } else if (item.type === 'social' || item.kind === 'social') {
          const opened = await openSocialConversation(item.conversationId || item.id, {acknowledge: !item.messageId});
          if (opened && item.messageId && currentConversation?.id === item.conversationId) {
            await jumpToMessage(item.messageId, status);
          }
        } else if (item.type === 'agent-message' || item.kind === 'agent') {
          const session = sessions.find(row => row.source === 'agent' && row.id === item.conversationId);
          const agentId = item.agentId || session?.agent_id;
          if (agentId && await openAgentConversation(agentId, item.conversationId)
            && item.messageId && currentConversation?.id === item.conversationId) {
            await jumpToMessage(item.messageId, status);
          }
        } else if (item.type === 'contact') {
          openComposeDialog('contact');
          const box = document.querySelector(`#member-choices input[value="${item.id}"]`);
          if (box) box.checked = true;
        }
      });
    }
    if (!total) {
      empty.hidden = false;
      const directoryStatus = searchTab === 'contacts' ? membersStatus
        : (['artifacts', 'documents', 'media'].includes(searchTab) ? artifactsStatus : '');
      if (directoryStatus === 'loading') empty.textContent = '正在加载…';
      else if (directoryStatus === 'failed') empty.textContent = '无法加载搜索范围。';
      else if (!query) empty.textContent = '当前工作区里还没有可列出的内容。';
      else if (paged && messageSearch.state.warning) empty.textContent = '可搜索的内容里没有匹配结果。';
      else empty.textContent = '当前工作区里没有匹配的结果。';
    }
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
      if (servedByDsbot) workspaceEvents.start(null);
      autoTranslation.open(null);
      attachmentSender?.reset();
      clearPendingSends();
      memoryDrafts.clear();
      memoryWrites.clear();
      replyDrafts.clear();
      renderReplyDraft();
      currentConversation = null;
      chatCalls.sync();
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
    if (currentUser && currentUser.id !== session.body.user.id) {
      attachmentSender?.reset();
      clearPendingSends();
      memoryDrafts.clear();
      memoryWrites.clear();
      replyDrafts.clear();
      renderReplyDraft();
    }
    currentUser = session.body.user;
    loginPanel.hidden = true;
    mainPanel.hidden = false;
    if (servedByDsbot) chatCalls.resumeMeeting();
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
    if (start.publicAgent && /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(start.publicAgent)) {
      show('ok', '正在打开公开智能体…');
      try {
        const result = await request('POST', `/v1/discover/agents/${start.publicAgent}/start`, {});
        const {workspace_id, conversation_id} = result.body;
        if (result.status !== 200 || !conversation_id || !workspaces.some(space => space.id === workspace_id)) {
          show('error', messageFor(result.body.error, '无法打开公开智能体。'));
          return;
        }
        if (workspaceSelect.value !== workspace_id) {
          workspaceSelect.value = workspace_id;
          await loadSessions();
        }
        if (await openSocialConversation(conversation_id)) {
          show('', '');
          void loadSessions();
        }
      } catch { show('error', '无法打开公开智能体，请重试。'); }
      return;
    }
    if (start.social) {
      if (await openSocialConversation(start.social, {acknowledge:!start.message}) && /^[A-Za-z0-9._-]{1,80}$/.test(start.message)) {
        if (await jumpToMessage(start.message,null) === false) {
          show('error','找不到这条来源消息。');
          return;
        }
        writeHash({workspace:workspaceId(),social:start.social,message:start.message});
      }
    } else if (start.agent && start.conversation) {
      if (await openAgentConversation(start.agent, start.conversation) && /^[0-9a-f]{32}$/.test(start.message)) {
        if (await jumpToMessage(start.message, null) === false) {
          show('error', '找不到这条来源消息。');
          return;
        }
        writeHash({workspace:workspaceId(), agent:start.agent, conversation:start.conversation, message:start.message});
      }
    } else if (start.agent) {
      const first = sessions.find(row => row.source === 'agent' && row.agent_id === start.agent);
      if (first) await openAgentConversation(start.agent, first.id);
      else openEmptyAgentChat(start.agent);
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

  function selectedTranscript() {
    const people = currentConversation?.members || [];
    return lastSocialItems.filter(item => selectedMessages.has(item.id) && !item.retracted).map(item => {
      const author = item.agent_name || people.find(person => person.user_id === item.user_id)?.username || '成员';
      const body = item.body?.trim() || item.attachment?.title || (item.voice ? '语音消息' : '');
      return body ? `${author}：${body}` : '';
    }).filter(Boolean).join('\n\n');
  }

  document.getElementById('selection-meeting')?.addEventListener('click', () => {
    const transcript = selectedTranscript(), workspace = workspaceId();
    if (!workspace || !currentUser || !transcript) return;
    if (transcript.length > 40000) {
      show('error', '所选消息超过会议正文上限，请减少选择。');
      return;
    }
    const title = (conversationLabel(currentConversation, currentUser.id) + ' · 会议纪要').slice(0, 120);
    try {
      const href = stageMeetingFromChat(document.defaultView.sessionStorage, {owner:currentUser.id, workspace, transcript, title});
      document.defaultView.location.assign(href);
    } catch {
      show('error', '无法打开会议草稿，请重试。');
    }
  });

  const groupCaptureDialog = document.getElementById('group-capture-dialog');
  const groupCaptureStatus = document.getElementById('group-capture-status');
  const groupCaptureSubmit = document.getElementById('group-capture-submit');
  const groupCaptureInbox = document.getElementById('group-capture-inbox');
  let groupCapture = null;
  document.getElementById('selection-group-capture')?.addEventListener('click', () => {
    if (currentSource !== 'social' || currentConversation?.kind !== 'group' || currentConversation.public_agent) return;
    const matching = lastSocialItems.filter(item => selectedMessages.has(item.id));
    if (!matching.length || matching.length !== selectedMessages.size || matching.length > 12
        || matching.some(item => item.role === 'agent' || item.retracted || item.voice || item.attachment || !item.body?.trim())) {
      show('error','请选择当前记录中 1 到 12 条群成员发出的文字消息。');
      return;
    }
    const workspace = workspaceId();
    groupCapture = {scope:sendScope(), ids:matching.map(item => item.id),
      path:`${socialBase()}/${currentConversation.id}/memory/capture`,busy:false};
    groupCaptureStatus.textContent = '';
    groupCaptureSubmit.disabled = false;
    groupCaptureInbox.hidden = true;
    groupCaptureInbox.href = '/memory?' + new URLSearchParams({workspace,page:'candidates'});
    document.getElementById('group-capture-review').textContent =
      `已选 ${matching.length} 条群聊文字消息，将由你的 DS-Bot 在后台生成待核对建议。`;
    groupCaptureDialog.showModal();
  });
  document.getElementById('group-capture-close')?.addEventListener('click', () => groupCaptureDialog.close());
  groupCaptureDialog?.addEventListener('close', () => {groupCapture = null;});
  document.getElementById('group-capture-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const draft = groupCapture;
    if (!draft || draft.busy || sendScope() !== draft.scope) return;
    draft.busy = groupCaptureSubmit.disabled = true;
    groupCaptureStatus.textContent = '正在核对群聊消息…';
    let done = false;
    try {
      const result = await request('POST',draft.path,{message_ids:draft.ids});
      if (groupCapture !== draft || sendScope() !== draft.scope) return;
      if (result.status !== 202) {
        groupCaptureStatus.textContent = messageFor(result.body.error,'无法提炼所选消息，请重试。');
        return;
      }
      const {queued,skipped,full} = result.body;
      groupCaptureStatus.textContent = [
        queued ? `${queued} 条已加入后台提炼。` : '',
        skipped ? `${skipped} 条已有处理记录。` : '',
        full ? `队列已满，${full} 条可稍后重试。` : '',
      ].filter(Boolean).join(' ');
      groupCaptureInbox.hidden = !(queued || skipped);
      done = !full;
      if (done) setSelecting(false);
    } catch {
      if (groupCapture === draft) groupCaptureStatus.textContent = '无法提炼所选消息，请重试。';
    } finally {
      if (groupCapture === draft) { draft.busy = false; groupCaptureSubmit.disabled = done; }
    }
  });

  const memoryDialog = document.getElementById('selection-memory-dialog');
  const memoryForm = document.getElementById('selection-memory-form');
  const memoryError = document.getElementById('selection-memory-error');
  let memoryDraft = null;
  const openMemory = document.getElementById('selection-memory');
  openMemory?.addEventListener('click', () => {
    const transcript = selectedTranscript();
    if (!transcript || !currentUser || !workspaceId()) return;
    if (transcript.length > 8000) {
      show('error', '所选消息超过记忆正文上限，请减少选择。');
      return;
    }
    memoryDraft = {owner:currentUser.id, workspace:workspaceId(), scope:sendScope(), attempt:null, pending:false};
    memoryForm.elements.title.value = (conversationLabel(currentConversation, currentUser.id) + ' · 聊天记录').slice(0, 80);
    memoryForm.elements.body.value = transcript;
    memoryError.textContent = '';
    memoryDialog.showModal();
    memoryForm.elements.title.focus();
  });
  memoryDialog?.addEventListener('close', () => {memoryDraft = null;});
  document.getElementById('selection-memory-cancel')?.addEventListener('click', () => memoryDialog.close());
  memoryForm?.addEventListener('submit', async event => {
    event.preventDefault();
    const draft = memoryDraft;
    if (!draft || draft.pending || draft.owner !== currentUser?.id || draft.workspace !== workspaceId()) return;
    const payload = {title:memoryForm.elements.title.value.trim(), body:memoryForm.elements.body.value};
    const signature = JSON.stringify(payload);
    if (draft.attempt?.signature !== signature) draft.attempt = {signature, key:idempotencyKey('chat-memory-')};
    const submit = document.getElementById('selection-memory-submit');
    draft.pending = submit.disabled = true;
    memoryError.textContent = '';
    try {
      const result = await request('POST', `/v1/workspaces/${draft.workspace}/memory`, payload, {'Idempotency-Key':draft.attempt.key});
      if (draft !== memoryDraft || draft.owner !== currentUser?.id) return;
      const page = result.body.page;
      if (![200, 201].includes(result.status) || !page?.id) {
        memoryError.textContent = messageFor(result.body.error, '保存失败，请重试。');
        return;
      }
      memoryDialog.close();
      if (sendScope() === draft.scope) setSelecting(false);
      show('ok', '已保存到记忆。');
      const link = document.createElement('a');
      link.href = '/memory?' + new URLSearchParams({workspace:draft.workspace, page:page.id});
      link.textContent = '打开记忆';
      status.append(document.createTextNode(' '), link);
    } catch {
      if (draft === memoryDraft) memoryError.textContent = '无法确认保存结果，请重试。';
    } finally {
      draft.pending = submit.disabled = false;
    }
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
    if (!cid || !target || !ids.length || forwardBusy) return;
    const scope = sendScope();
    const signature = JSON.stringify([scope, target, ids]);
    if (forwardAttempt?.signature !== signature) forwardAttempt = {signature, key:idempotencyKey('forward-')};
    forwardBusy = true;
    syncForwardBar();
    try {
      const result = await request('POST', `${socialBase()}/${cid}/forward`,
        {message_ids: ids, target_conversation_id: target}, {'Idempotency-Key':forwardAttempt.key});
      if (result.status !== 201 && result.status !== 200) {
        if (scope === sendScope()) show('error', messageFor(result.body.error, '转发失败，请重试。'));
        return;
      }
      forwardAttempt = null;
      if (scope === sendScope()) {
        setSelecting(false);
        show('ok', `已转发 ${result.body.forwarded ?? ids.length} 条消息。`);
        await loadSessions();
      }
    } catch {
      if (scope === sendScope()) show('error', '未能确认转发结果，请重试。');
    } finally {
      forwardBusy = false;
      syncForwardBar();
    }
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
  const modeSelect = document.getElementById('composer-mode');
  function modeStorage() {
    try { return globalThis.localStorage || null; } catch { return null; }
  }
  function restoreComposerMode(conversationId) {
    if (!modeSelect || !conversationId) return;
    const storage = modeStorage();
    let saved = '';
    try { saved = storage ? storage.getItem(modeStoreKey(conversationId)) || '' : ''; } catch { saved = ''; }
    modeSelect.value = normalizeMode(saved);
  }
  function rememberComposerMode(conversationId, mode) {
    const storage = modeStorage();
    if (!storage || !conversationId) return;
    try { storage.setItem(modeStoreKey(conversationId), normalizeMode(mode)); } catch {}
  }
  if (modeSelect) modeSelect.addEventListener('change', () => {
    if (currentConversation && currentSource === 'social') rememberComposerMode(currentConversation.id, modeSelect.value);
  });

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
    if (liveBanner) liveBanner.hidden = true;
    notificationSnapshot = null;
    agentMentions.clear();
    renderNotifications({items: [], unread_count: 0});
    currentAgent = null;
    currentConversation = null;
    currentSource = 'agent';
    syncCaptureButton();
    chatCalls.sync();
    voiceRecorder.refresh();
    clearVoicePlayers();
    stopPolling();
    closeSearchPanel();
    closeComposeDialog();
    const inChatPanel = document.getElementById('conversation-search-panel'); if (inChatPanel) inChatPanel.hidden = true;
    writeHash({workspace: workspaceId()});
    applyChatIdentity(document, '聊天');
    showPublicChatState(null);
    renderReplyDraft();
    document.getElementById('message-list').replaceChildren();
    document.getElementById('chat-empty').hidden = false;
    renderPendingSend();
    setDirectoryLink({source: 'agent'});
    syncPlusState();
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
      return false;
    }
    target.scrollIntoView?.({block: 'center', behavior: globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'});
    target.tabIndex = -1; target.focus?.({preventScroll: true});
    for (const node of Array.from(list.children || [])) delete node.dataset.searchJump;
    target.dataset.searchJump = 'true';
    setTimeout(() => { delete target.dataset.searchJump; }, SEARCH_JUMP_HIGHLIGHT_MS);
    return true;
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
    document.getElementById('group-memory-open')?.addEventListener('click', () => openGroupMemory());
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
  attachmentSender = mountChatFiles(document, {
    context: () => {
      if (!servedByDsbot || !currentUser) return null;
      if (currentSource === 'agent' && currentAgent) return {scope:sendScope(), private:true, owner:currentUser.id};
      if (currentSource !== 'social' || !currentConversation || currentConversation.public_agent || currentConversation.direct?.open === false) return null;
      const wid = workspaceId(), cid = currentConversation.id;
      const scope = sendScope();
      return {scope, owner:currentUser.id, reply:replyDrafts.get(scope), path:`/v1/workspaces/${wid}/social/conversations/${cid}/messages`};
    },
    ownerId: () => currentUser?.id,
    csrfToken: () => csrfCookie(document.cookie),
    createKey: () => idempotencyKey('chat-file-'),
    sent(destination, message) {
      consumeReplyDraft(destination.scope, destination.reply);
      if (destination.scope === sendScope() && !socialHistory?.readingHistory) {
        const without = lastSocialItems.filter(item => item.id !== message.id);
        renderSocialMessages([...without, message].sort((a,b) => a.seq - b.seq));
      }
      void loadSessions();
    },
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
      muteButton.hidden = !conversation || (conversation.kind === 'group' && !conversation.public_agent);
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
  document.getElementById('chat-back').addEventListener('click', () => {
    setSessionsOpen(true);
    document.getElementById('conversation-list').querySelector('[aria-current="true"]')?.focus();
  });

  const chatMore = document.getElementById('chat-more');
  const extraActions = document.getElementById('chat-extra-actions');
  chatMore?.addEventListener('click', () => {
    const open = chatMore.getAttribute('aria-expanded') !== 'true';
    chatMore.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', event => {
    if (chatMore?.getAttribute('aria-expanded') !== 'true' || chatMore.contains(event.target)) return;
    const inside = extraActions.contains(event.target);
    if (inside && !event.target.closest('button, a')) return;
    if (inside && extraActions.contains(document.activeElement)) chatMore.focus();
    chatMore.setAttribute('aria-expanded', 'false');
  });

  document.getElementById('search-more').addEventListener('click', async () => {
    if (searchTab === 'files' || searchTab === 'links') { if (resourceCursor) await renderSearch({appendResources: true}); return; }
    const query = (document.getElementById('session-search').value || '').trim();
    if (!query || messageSearch.state.loading || !messageSearch.state.cursor) return;
    const seq = searchSeq;
    await messageSearch.load(query, searchConversation, {append: true});
    if (seq === searchSeq) await renderSearch({reuseMessages: true});
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
    const opened = button.dataset.source === 'social'
      ? await openSocialConversation(button.dataset.conversation)
      : await openAgentConversation(button.dataset.agent, button.dataset.conversation);
    if (opened && narrowScreen() && !document.body.classList.contains('sessions-open')
      && document.activeElement === document.body) document.getElementById('chat-title').focus();
  });

  document.getElementById('new-conversation').addEventListener('click', event => {
    event.stopPropagation();
    const menu = document.getElementById('compose-menu');
    const button = document.getElementById('new-conversation');
    const open = menu.hidden;
    document.getElementById('compose-add-contact').hidden = servedByDsbot
      && workspaces.some(space => space.id === workspaceId() && space.kind === 'personal');
    const meetingNotes = document.getElementById('compose-meeting-notes');
    if (open && meetingNotes) meetingNotes.href = '/meetings#' + new URLSearchParams({workspace: workspaceId(), new: '1'});
    menu.hidden = !open;
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  for (const [id, action] of [['start-video-meeting', 'create'], ['join-video-meeting', 'join']]) {
    const button = document.getElementById(id);
    button.hidden = !servedByDsbot;
    button.addEventListener('click', () => {
      closeComposeMenu();
      document.getElementById('new-conversation').focus();
      chatCalls.openMeeting(action);
    });
  }
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
    const submit = document.getElementById('compose-dialog-submit');
    if (composing || submit.disabled) return;
    const wid = workspaceId();
    const template = composeMode === 'group' && groupMode === 'team';
    const memberIds = [...document.querySelectorAll('#member-choices input[name="member"]:checked')].map(box => box.value);
    const agentIds = [...document.querySelectorAll('#member-choices input[name="agent-member"]:checked')].map(box => box.value);
    const title = document.getElementById('compose-title').value.trim();
    const picked = template ? document.querySelector('#team-template-choices input:checked') : null;
    if (template && !picked) return;
    const path = template ? `/v1/workspaces/${wid}/team-templates/${picked.value}` : socialBase();
    const body = template ? {} : composeMode === 'contact'
      ? {kind:'dm', member_ids:memberIds}
      : composeGroupPayload(memberIds, title, agentIds);
    const fingerprint = JSON.stringify([path, body]);
    if (composeAttempt?.fingerprint !== fingerprint) composeAttempt = {fingerprint, key:idempotencyKey('conv-')};
    const cancel = document.getElementById('compose-dialog-cancel');
    composing = true;
    cancel.disabled = true;
    submit.textContent = '创建中…';
    syncComposeCreate();
    try {
      const result = await request('POST', path, body, {'Idempotency-Key':composeAttempt.key});
      if (wid !== workspaceId()) return;
      if (![200,201].includes(result.status) || !result.body.conversation?.id) {
        show('error', messageFor(result.body.error, '无法创建会话。'));
        return;
      }
      composeAttempt = null;
      closeComposeDialog();
      if (await openSocialConversation(result.body.conversation.id)) {
        void loadSessions();
        show('ok', template ? '智能体团队已创建。' : '会话已创建。');
      }
    } catch {
      show('error', '网络连接失败，所选成员已保留。');
    } finally {
      composing = false;
      cancel.disabled = false;
      submit.textContent = '创建';
      syncComposeCreate();
    }
  });


  function sendCurrentMessage() {
    const field = document.getElementById('chat-body');
    const social = currentSource === 'social';
    const scope = sendScope();
    const files = social ? [] : attachmentSender?.draftFiles?.(scope) || [];
    if (!field.value.trim() && !files.length) return;
    if (sendClosed() || memoryWrites.has(scope)) return;
    if (social ? !currentConversation : !currentAgent) {
      show('error', social ? '请先打开或创建一个会话。' : '请先选择一个智能体。');
      return;
    }
    const message = social
      ? {...agentMentions.message(field.value), ...socialSendPayload(field.value, modeSelect ? modeSelect.value : 'auto')}
      : messagePayload(field.value, chatLanguage);
    const reply = social ? replyDrafts.get(scope) : undefined;
    if (reply) message.reply_to = reply.message_id;
    if (social && !validMessage(message.body)) {
      show('error', '请输入 1–4000 字符的消息。');
      return;
    }
    let queue = pendingSends.get(scope);
    if (!queue) {
      queue = {
        scope, social, owner: currentUser?.id, wid: workspaceId(), agentId: currentAgent?.id,
        base: social ? socialBase() : `${agentBase()}/conversations`,
        conversationId: currentConversation?.id, jobs: [], active: false,
        createKey: currentConversation ? null : idempotencyKey('chat-'),
        memoryScope: memoryDrafts.get(scope),
      };
      pendingSends.set(scope, queue);
    }
    queue.jobs.push(makeSendJob(queue, message, files, reply));
    field.value = '';
    field.focus({preventScroll: true});
    if (social) agentMentions.clear();
    consumeReplyDraft(scope, reply);
    if (files.length) attachmentSender.clearDraft(scope, files);
    show('', '');
    renderPendingSend();
    const scroller = document.getElementById('message-scroller');
    scroller.scrollTop = scroller.scrollHeight;
    void drainSends(queue);
  }

  async function drainSends(queue) {
    if (queue.active || pendingSends.get(queue.scope) !== queue) return;
    queue.active = true;
    const isCurrent = () => sendScope() === queue.scope;
    try {
      for (const job of queue.jobs.slice()) {
        if (job.failed || !queue.jobs.includes(job)) continue;
        if (pendingSends.get(queue.scope) !== queue || queue.owner !== currentUser?.id) return;
        const feedback = state => {
          job.state = state;
          if (isCurrent()) paintSendJob(job);
        };
        try {
          if (!queue.conversationId) {
            feedback('正在创建对话…');
            const body = {title: '新对话'};
            if (queue.memoryScope !== undefined) body.memory_scope = queue.memoryScope;
            const created = await request('POST', queue.base, body, {'Idempotency-Key': queue.createKey});
            const conversation = created.body.conversation;
            if (![200, 201].includes(created.status) || !conversation?.id) {
              throw new Error(messageFor(created.body.error, '创建对话失败，请重试。'));
            }
            if (pendingSends.get(queue.scope) !== queue) return;
            const previous = queue.scope;
            const visible = isCurrent();
            queue.conversationId = conversation.id;
            queue.scope = JSON.stringify([queue.owner, queue.wid, 'agent', queue.agentId, conversation.id]);
            pendingSends.delete(previous);
            memoryDrafts.delete(previous);
            pendingSends.set(queue.scope, queue);
            if (visible) {
              currentConversation = conversation;
              lastAgentItems = [];
              writeHash({workspace: queue.wid, agent: queue.agentId, conversation: conversation.id});
              attachmentSender?.moveDraft(previous, queue.scope);
              renderPendingSend();
            }
            void loadSessions();
          }
          const path = `${queue.base}/${queue.conversationId}/messages`;
          const headers = {'Idempotency-Key':job.key};
          feedback(job.files.length ? '正在上传附件…' : queue.social ? '正在发送…' : '正在等待智能体回复…');
          const result = job.files.length
            ? await sendPrivateAttachmentMessage(document.defaultView, path, job.message, job.files,
              {...headers, 'X-CSRF-Token':csrfCookie(document.cookie)}, percent => {
                feedback(percent < 100 ? `正在上传附件 · ${percent}%` : '附件已上传，正在等待智能体回复…');
              })
            : await request('POST', path, job.message, headers);
          if (![200, 201].includes(result.status) || !result.body.message?.id) {
            const code = result.body.error?.code;
            if (isCurrent() && code === 'public_chat_closed' && currentConversation?.public_agent) {
              currentConversation.public_agent = {...currentConversation.public_agent, open: false, pending: false};
              showPublicChatState(currentConversation.public_agent);
            }
            if (isCurrent() && result.status === 403 && currentConversation?.direct) {
              void openSocialConversation(queue.conversationId, {refresh:true});
            }
            throw new Error(result.status === 413 ? '附件合计不能超过 8 MB。'
              : code === 'attachment_type_blocked' ? '请确认附件的格式与扩展名一致。'
                : messageFor(result.body.error, '未能确认发送结果，请重试。'));
          }
          removeSendJob(queue, job);
          if (isCurrent()) {
            const append = (items, ...added) => [...items.filter(item => !added.some(row => row.id === item.id)), ...added];
            if (queue.social) {
              if (socialHistory?.readingHistory) void openSocialConversation(queue.conversationId);
              else renderSocialMessages(append(lastSocialItems, result.body.message).sort((a,b) => a.seq - b.seq), {refresh:true});
              if (currentConversation.public_agent?.open) {
                showPublicChatState({open: true, pending: true});
                schedulePoll(servedByDsbot ? 8000 : 2000);
              } else scheduleSocialPoll(currentConversation);
              show('ok', '已发送。', {announceOnly: true});
            } else {
              const reply = result.body.reply;
              if (reply?.id) {
                if (renderAgentMessages(append(lastAgentItems, result.body.message, reply))) schedulePoll();
              } else void openAgentConversation(queue.agentId, queue.conversationId);
              const notice = sendNotice(reply);
              show(notice.kind, notice.text, notice);
            }
          }
          if (queue.owner === currentUser?.id) void loadSessions();
        } catch (error) {
          job.failed = true;
          feedback(error instanceof TypeError || !error?.message ? '未能确认发送结果，请重试。' : error.message);
        }
      }
    } finally {
      queue.active = false;
      if (!queue.jobs.length && pendingSends.get(queue.scope) === queue) pendingSends.delete(queue.scope);
      if (isCurrent()) renderPendingSend();
      if (queue.jobs.some(job => !job.failed)) void drainSends(queue);
    }
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
    if (!(document.getElementById('chat-body').value || '').trim() && !attachmentSender?.draftFiles?.(sendScope())?.length) return;
    sendCurrentMessage();
  }, true);

  document.getElementById('chat-form').addEventListener('submit', event => {
    event.preventDefault();
    sendCurrentMessage();
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
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (chatMore?.getAttribute('aria-expanded') === 'true') {
      chatMore.setAttribute('aria-expanded', 'false');
      chatMore.focus();
      return;
    }
    closeComposeMenu();
    if (isSearchOpen()) closeSearchPanel();
    closeComposeDialog();
  });

  const plus = document.querySelector('details.composer-plus');
  const imageCreator = mountImageCreator(document,{
    request, key:() => idempotencyKey('chat-image-'),
    context() {
      if (!servedByDsbot || !currentUser || !workspaceId()) return null;
      if (currentSource === 'agent' && currentAgent) {
        return {workspace:workspaceId(),scope:sendScope(),private:true,attachLabel:'添加到输入框'};
      }
      if (currentSource === 'social' && currentConversation && !currentConversation.public_agent && !sendClosed()) {
        return {workspace:workspaceId(),scope:sendScope(),private:false,
          attachLabel:currentConversation.kind === 'group' ? '发送到群聊' : '发送到会话'};
      }
      return null;
    },
    attach: (file,scope) => Boolean(attachmentSender?.addFiles?.([file],scope)),
    onOpen() { if (plus) plus.open = false; },
    notify: show,
  });
  const attachInput = document.getElementById('chat-attachment');
  const defaultAccept = attachInput ? attachInput.getAttribute('accept') || '' : '';
  function syncPlusState() {
    syncMemoryRecall();
    imageCreator.sync();
    const social = currentSource === 'social' && Boolean(currentConversation);
    const shareable = social && !currentConversation.public_agent && currentConversation.direct?.open !== false;
    const workspace = workspaceId();
    const scope = new URLSearchParams();
    if (workspace) {
      scope.set('workspace',workspace);
      if (shareable) scope.set('conversation',currentConversation.id);
    }
    for (const link of document.querySelectorAll('[data-create-artifact]')) {
      link.href = '/space?new=' + link.dataset.createArtifact + (workspace ? '#' + scope : '');
    }
    const agent = currentSource === 'agent' && Boolean(currentAgent);
    const available = servedByDsbot && (shareable || agent);
    for (const button of document.querySelectorAll('[data-plus-attach]')) {
      button.disabled = !available;
      if (button.dataset.plusAttach === 'video') button.hidden = agent;
    }
    const hint = document.getElementById('plus-attach-hint');
    if (hint) hint.hidden = available;
    attachmentSender?.render();
  }
  if (plus) plus.addEventListener('toggle', () => { if (plus.open) syncPlusState(); });
  for (const button of document.querySelectorAll('[data-plus-attach]')) {
    button.addEventListener('click', () => {
      if (!attachInput || button.disabled) return;
      const accept = currentSource === 'agent' ? AGENT_FILE_ACCEPT : defaultAccept;
      attachInput.setAttribute('accept',plusAttachAccept(button.dataset.plusAttach,accept));
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
