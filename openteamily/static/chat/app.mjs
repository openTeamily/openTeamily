import { decodeVoice, mountVoiceRecorder } from './voice.mjs';
import { mountAgentMentions } from './mentions.mjs';
import { AGENT_FILE_ACCEPT, chatFileDownload, mountChatFiles, renderChatFile, sendPrivateAttachmentMessage } from './files.mjs';
import { mountGroupTranslation } from './translation.mjs';
import { mountChatCalls } from './calls.mjs';
import { mountImageCreator } from './image-create.mjs';
import { mountModel3dCreator, mountMusicCreator, mountVideoCreator, mountWebsiteCreator } from './video-create.mjs';
import { mountChatActivity } from './activity.mjs';
import { stageMeetingFromChat } from '../shell/meeting-link.mjs';
import { workNotificationSummary, workNotificationTarget } from '../shell/work-notification.mjs';
import { mountPublicDraft } from './public-draft.mjs';
import { consumePublicAgentOpening, publicAgentIntentFromHash, publicAgentContinuation, publicAgentOpening } from '../shell/public-agent-link.mjs';
import { mountMessageUtilities, renderMessageText } from './utilities.mjs';
export const SEARCH_JUMP_HIGHLIGHT_MS = 2400;
import { csrfCookie, canManage, idempotencyKey, statusLabel } from '../agents/app.mjs';
import { conversationLabel, memberChoices, validMessage } from '../messenger/app.mjs';
import { createLookAvatar } from '../look/app.mjs';
import { dsbotServed } from './dsbot.mjs';
import { agentSavePath, artifactVersionLabel, defaultSaveTitle, saveableAgentMessage, saveableSocialMessage, socialSavePath, spaceHref } from '../shell/thumb.mjs';

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
  if (code === 'model-unconfigured') return {kind: 'error', text: '消息已保存。配置模型 API 后，智能体才能回复。'};
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

function hashParams(hash = location.hash) {
  const text = (hash || '').replace(/^#/, '');
  const params = new URLSearchParams(text);
  return {
    workspace: params.get('workspace') || '',
    agent: params.get('agent') || '',
    conversation: params.get('conversation') || '',
    message: params.get('message') || '',
    social: params.get('social') || '',
  };
}

const chatPathId = value => /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,79}$/.test(value || '');

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
  const workSummary = workNotificationSummary(item);
  if (workSummary) return workSummary;
  if (item.kind === 'discover.published') {
    const author = item.actor_username || '你关注的作者';
    const type = item.listing_kind === 'agent' ? '智能体' : '作品';
    return `${author} 发布了新${type}` + (item.title ? `「${item.title}」` : '');
  }
  if (item.kind === 'meeting.shared') {
    const organizer = item.organizer || '会议组织者';
    return `${organizer} 分享了纪要` + (item.title ? `「${item.title}」` : '');
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

const NOTIFICATION_ID = /^[0-9a-f]{32}$/;
const NOTIFICATION_SLUG = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;
const MEETING_NOTIFICATION_PATH = /^\/meetings#workspace=([0-9a-f]{32})&shared=([0-9a-f]{32})$/;
const LINKED_NOTIFICATION_KINDS = new Set(['meeting.shared', 'discover.published', 'follow_work', 'artifact.shared', 'automation_reminder']);

export function notificationTarget(item, workspace) {
  if (item?.kind === 'automation_reminder') return '/automations';
  if (item?.kind === 'meeting.shared') {
    const path = typeof item.path === 'string' ? MEETING_NOTIFICATION_PATH.exec(item.path) : null;
    const share = item.share_id ?? path?.[2];
    if (!NOTIFICATION_ID.test(workspace || '') || !NOTIFICATION_ID.test(share || '')
      || (item.workspace_id != null && item.workspace_id !== workspace)) return null;
    const target = '/meetings#' + new URLSearchParams({workspace, shared: share});
    return item.path == null || item.path === target ? target : null;
  }
  if (item?.kind !== 'discover.published' || item.listing_kind !== 'agent') {
    return workNotificationTarget(item, workspace);
  }
  const prefix = '/a/';
  const slug = item.slug ?? (typeof item.path === 'string' && item.path.startsWith(prefix) ? item.path.slice(prefix.length) : '');
  if (typeof slug !== 'string' || !NOTIFICATION_SLUG.test(slug)) return null;
  const target = prefix + slug;
  return item.path == null || item.path === target ? target : null;
}

async function waitForLinkedNotificationRead(read) {
  let timer;
  const timeout = new Promise(resolve => { timer = globalThis.setTimeout(resolve, 500); });
  try { return await Promise.race([read, timeout]); }
  finally { globalThis.clearTimeout(timer); }
}

export function mount(document, {fetcher = globalThis.fetch.bind(globalThis)} = {}) {
  const uiLabel = (zh, en) => document.documentElement?.lang === 'en' ? en : zh;
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
  let groupReplyFormScope = '';
  let searchSeq = 0;
  let resourceCursor = '';
  let resourceItems = [];
  let sendShortcut = 'enter';
  let chatLanguage = 'auto';
  let chatPreferences = {message_folding:'standard', document_cards:false, link_previews:true};
  let attachmentSender;
  const pendingSends = new Map();
  const agentReplyViews = new Map();
  let replyWatch = null;
  const sendScope = (conversation = currentConversation?.id) =>
    JSON.stringify([currentUser?.id, workspaceId(), currentSource, currentAgent?.id, conversation]);
  const publicDraft = mountPublicDraft(document);
  const starterPanel = document.getElementById('agent-quick-starts');
  const starterList = document.getElementById('agent-quick-starts-list');
  const starterStatus = document.getElementById('agent-quick-starts-status');
  const starterComposer = document.getElementById('chat-body');
  let starterView = null;
  let starterRefresh = null;
  starterComposer.addEventListener('input', () => setAgentStarterStatus(''));

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

  function setAgentStarterStatus(message) {
    if (starterStatus.hidden && !message) return;
    starterStatus.textContent = message;
    starterStatus.hidden = !message;
  }

  function nativeStarterAgent(agent) {
    return servedByDsbot && currentUser?.id && currentSource === 'agent' && agent?.id
      && agent.id === currentAgent?.id && agent.workspace_id === workspaceId() && agent.served_by === 'ds-bot';
  }

  function renderAgentQuickStarts(agent) {
    const eligible = nativeStarterAgent(agent) && !agent.archived && !agent.native_deleted
      && !currentConversation?.archived && currentConversation?.open !== false;
    const values = eligible && Array.isArray(agent.quick_starts)
      ? agent.quick_starts.slice(0, 5).flatMap(value =>
        typeof value === 'string' && value.trim() && value.trim().length <= 80 ? [value.trim()] : [])
      : [];
    const scope = sendScope();
    const key = values.length ? JSON.stringify([scope, values]) : '';
    if (key === (starterView?.key ?? '')) return;
    const view = values.length ? {key, scope} : null;
    starterView = view;
    starterPanel.hidden = !view;
    setAgentStarterStatus('');
    const buttons = values.map(text => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = text;
      button.title = text;
      button.addEventListener('click', () => {
        if (starterView !== view || view.scope !== sendScope() || mainPanel.hidden || starterComposer.disabled) return;
        const original = starterComposer.value;
        const next = original && original !== text ? original + '\n\n' + text : text;
        const limit = starterComposer.maxLength > 0 ? starterComposer.maxLength : 4000;
        if (next.length > limit) {
          setAgentStarterStatus('输入框里的草稿已保留。缩短后可添加这条开场。');
          return;
        }
        starterComposer.value = next;
        starterComposer.dispatchEvent(new Event('input', {bubbles: true}));
        starterComposer.focus({preventScroll: true});
        starterComposer.setSelectionRange?.(next.length, next.length);
      });
      return button;
    });
    starterList.replaceChildren(...buttons);
    starterList.scrollLeft = 0;
  }

  async function refreshAgentQuickStarts() {
    if (!nativeStarterAgent(currentAgent) || mainPanel.hidden || !viewingSocialMessages()) return;
    const scope = sendScope();
    const open = socialOpen;
    if (starterRefresh?.scope === scope && starterRefresh.open === open) return;
    const next = {scope, open};
    starterRefresh = next;
    const result = await request('GET', agentBase()).catch(() => ({status: 0}));
    if (starterRefresh !== next) return;
    starterRefresh = null;
    if (open !== socialOpen || scope !== sendScope() || document.visibilityState === 'hidden') return;
    const agent = result.body?.agent;
    if (result.status === 200 && nativeStarterAgent(agent)) {
      currentAgent = agent;
      renderAgentQuickStarts(currentAgent);
    } else if ([200, 403, 404, 410].includes(result.status)) {
      currentAgent = {...currentAgent, quick_starts: []};
      renderAgentQuickStarts();
    }
  }

  function renderPendingSend() {
    const list = document.getElementById('message-list');
    const scope = sendScope();
    const queue = pendingSends.get(scope);
    document.getElementById('chat-send').disabled = sendClosed() || memoryWrites.has(scope);
    syncMemoryRecall(scope);
    const replying = queue?.replying;
    if (replying && !replying.replyView) {
      replying.replyView = makeAgentMessage({role: 'assistant', status: 'queued', client_key: replying.key}).replyView;
      if (replying.replyView) replying.replyView.bubble.dataset.sendPending = 'reply';
    }
    const replyBubble = replying?.replyView?.bubble;
    const bubbles = new Set((queue?.jobs || []).map(job => job.bubble));
    if (replyBubble) bubbles.add(replyBubble);
    for (const child of Array.from(list.children)) {
      if (child.dataset.sendPending && !bubbles.has(child)) child.remove();
      bubbles.delete(child);
    }
    for (const job of queue?.jobs || []) {
      paintSendJob(job);
      if (bubbles.has(job.bubble)) list.append(job.bubble);
      if (job === replying && bubbles.has(replyBubble)) {
        const children = Array.from(list.children);
        const next = children[children.indexOf(job.bubble) + 1];
        if (next) list.insertBefore(replyBubble, next);
        else list.append(replyBubble);
      }
    }
    if (currentSource === 'agent' && currentAgent) {
      const pending = Boolean(replying) || lastAgentItems.some(waitingAgentReply);
      setChatSubtitle(pending ? uiLabel('正在回复…', 'Replying…') : uiLabel('AI 智能体 · 经运行时回复', 'AI agent · DS-Bot'), pending);
    }
    const empty = document.getElementById('chat-empty');
    empty.dataset.agent = String(currentSource === 'agent' && Boolean(currentAgent));
    empty.hidden = list.children.length > 0;
  }

  function paintSendJob(job) {
    if (job.status.textContent !== job.state) job.status.textContent = job.state;
    job.status.hidden = Boolean(job.replyView);
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
    job.replyView?.bubble.remove();
    for (const url of job.previews) document.defaultView.URL.revokeObjectURL(url);
    if (!queue.jobs.length && !queue.active && pendingSends.get(queue.scope) === queue) pendingSends.delete(queue.scope);
  }

  function clearPendingSends() {
    stopReplyProgress();
    stopGroupReplyProgress();
    stopPolling();
    for (const queue of pendingSends.values()) {
      for (const job of queue.jobs) removeSendJob(queue,job);
    }
    pendingSends.clear();
  }

  function pendingMessageKeys() {
    return new Set((pendingSends.get(sendScope())?.jobs || []).map(job => job.key));
  }

  async function request(method, path, body, extra, signal, {keepalive = false} = {}) {
    const headers = {'Accept': 'application/json', 'X-CSRF-Token': csrfCookie(document.cookie), ...(extra || {})};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetcher(path, {
      method, headers, credentials: 'same-origin', signal,
      ...(keepalive ? {keepalive} : {}),
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
    const scope = sendScope();
    const checked = new Set();
    if (groupReplyFormScope === scope) {
      for (const label of holder.children) {
        const box = label.children[0];
        if (box?.checked) checked.add(box.value);
      }
    } else {
      groupReplyFormScope = scope;
      document.getElementById('group-agent-prompt').value = '';
    }
    holder.replaceChildren();
    for (const agent of saved.filter(item => !item.archived && item.mine !== false)) {
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.name = 'group-agent';
      box.value = agent.id || agent.agent_id;
      box.disabled = active.has(box.value);
      box.checked = !box.disabled && checked.has(box.value);
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
    if (open) {
      document.body.classList.add('sessions-open');
      if (narrowScreen()) stopGroupReplyProgress();
    } else document.body.classList.remove('sessions-open');
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
    document.getElementById('conversation-heading').textContent = uiLabel('对话 · ', 'Conversations · ') + visible.length;
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
        unread.setAttribute('aria-label', session.unread_count + uiLabel(' 条未读消息', ' unread'));
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

  function waitingAgentReply(item) {
    return item.role === 'assistant' && (item.status === 'queued' || item.status === 'running');
  }

  function messageScrollerAtBottom(scroller) {
    return scroller.scrollHeight - scroller.scrollTop - (scroller.clientHeight || 0) < 48;
  }

  function makeAgentMessage(item) {
    const bubble = document.createElement('li');
    if (item.id) bubble.dataset.messageId = item.id;
    bubble.className = item.role === 'user' ? 'user' : 'assistant';
    const role = document.createElement('p');
    role.className = 'role';
    role.textContent = item.role === 'user' ? uiLabel('你', 'You') : (currentAgent?.name || uiLabel('智能体', 'Agent'));
    const body = document.createElement('div');
    const waiting = waitingAgentReply(item);
    const failed = item.role === 'assistant' && (item.status === 'failed' || item.status === 'cancelled');
    const partial = waiting && servedByDsbot && item.client_key;
    body.className = 'body' + (partial ? ' reply-preview' : waiting ? ' pending' : failed ? ' failed' : '');
    if (partial) {
      bubble.dataset.replyProgress = item.client_key;
      body.setAttribute('aria-live', 'off');
      body.hidden = true;
    } else if (failed && item.error_code === 'model-unconfigured') {
      body.textContent = uiLabel('这个智能体还没有可用模型。', 'This agent has no model configured.');
      const configure = document.createElement('a');
      configure.className = 'chat-model-settings';
      configure.href = '/settings#model-api';
      configure.textContent = uiLabel('配置模型 API', 'Configure model API');
      body.append(configure);
    } else {
      renderMessageBody(document, body, item.role === 'user' ? (item.body || '') : statusLabel(item), chatPreferences);
      if (item.attachments?.length && !item.body) body.hidden = true;
    }
    if (waiting || failed) bubble.dataset.state = waiting ? item.status : 'failed';
    bubble.append(role);
    let replyView;
    if (waiting) {
      const heading = document.createElement('p');
      heading.className = 'reply-state';
      heading.textContent = item.status === 'running' ? '正在生成回复' : '正在准备回复';
      bubble.append(heading);
      if (partial) replyView = {bubble, heading, body};
    }
    bubble.append(body);
    for (const attachment of item.attachments || []) bubble.append(renderChatFile(document, attachment));
    const sources = memorySources(item);
    if (sources) bubble.append(sources);
    if (item.role === 'assistant' && saveableAgentMessage(item)) {
      bubble.append(saveMessageButton(item, currentAgent.id));
    }
    return {bubble, replyView};
  }

  function renderAgentMessages(items, {followLatest = true, anchor} = {}) {
    const scroller = document.getElementById('message-scroller');
    const top = anchor?.top ?? scroller.scrollTop;
    const follow = anchor?.follow ?? (followLatest || messageScrollerAtBottom(scroller));
    const list = document.getElementById('message-list');
    list.replaceChildren();
    agentReplyViews.clear();
    lastAgentItems = items || [];
    syncCaptureButton();
    const pendingKeys = pendingMessageKeys();
    for (const item of lastAgentItems) {
      if (pendingKeys.has(item.client_key)) continue;
      const {bubble, replyView} = makeAgentMessage(item);
      if (replyView) agentReplyViews.set(item.client_key, replyView);
      list.append(bubble);
    }
    renderPendingSend();
    const tracking = syncReplyProgress();
    attachmentSender?.render();
    scroller.scrollTop = follow ? scroller.scrollHeight : top;
    return lastAgentItems.some(waitingAgentReply) && !tracking;
  }

  function stopReplyProgress() {
    const watch = replyWatch;
    if (!watch) return;
    replyWatch = null;
    globalThis.clearTimeout(watch.timer);
    globalThis.clearTimeout(watch.timeout);
    watch.controller?.abort();
  }

  function isCurrentReply(watch) {
    return replyWatch === watch && sendScope() === watch.scope && canWatchReply();
  }

  function canWatchReply() {
    return document.visibilityState !== 'hidden'
      && !(narrowScreen() && document.body.classList.contains('sessions-open'));
  }

  function paintReplyProgress(view, snapshot) {
    const state = snapshot.state === 'running' ? 'running' : 'queued';
    if (view.bubble.dataset.state !== state) {
      view.bubble.dataset.state = state;
      view.heading.textContent = state === 'running' ? '正在生成回复' : '正在准备回复';
    }
    if (typeof snapshot.text !== 'string' || view.body.textContent === snapshot.text) return;
    const scroller = document.getElementById('message-scroller');
    const follow = messageScrollerAtBottom(scroller);
    view.body.textContent = snapshot.text;
    view.body.hidden = !snapshot.text;
    if (follow) scroller.scrollTop = scroller.scrollHeight;
  }

  function scheduleReplyProgress(watch, delay = 400) {
    if (!isCurrentReply(watch)) return;
    watch.timer = globalThis.setTimeout(() => void pollReplyProgress(watch), delay);
  }

  async function pollReplyProgress(watch) {
    if (!isCurrentReply(watch)) return;
    const controller = watch.controller = new AbortController();
    watch.timeout = globalThis.setTimeout(() => controller.abort(), 5000);
    const result = await request('GET', watch.path, undefined, undefined, controller.signal).catch(() => null);
    globalThis.clearTimeout(watch.timeout);
    watch.controller = null;
    if (!isCurrentReply(watch)) return;
    const snapshot = result?.status === 200 ? result.body : null;
    if (snapshot?.state === 'pending' || snapshot?.state === 'running') {
      watch.failures = 0;
      watch.snapshot = snapshot;
      paintReplyProgress(watch.view, snapshot);
      scheduleReplyProgress(watch);
      return;
    }
    const terminal = snapshot?.state === 'succeeded' || snapshot?.state === 'failed';
    if (terminal && watch.posting) return;
    watch.failures += 1;
    if (terminal || (!watch.posting && watch.failures >= 4)) {
      await openAgentConversation(currentAgent.id, currentConversation.id, {refresh: true});
      scheduleReplyProgress(watch, 1500);
      return;
    }
    scheduleReplyProgress(watch, watch.failures < 3 ? 400 : 1200);
  }

  function syncReplyProgress() {
    const scope = sendScope();
    const job = pendingSends.get(scope)?.replying;
    const [key, view] = job ? [job.key, job.replyView] : (agentReplyViews.entries().next().value || []);
    if (!servedByDsbot || currentSource !== 'agent' || !currentConversation || !canWatchReply() || !view) {
      stopReplyProgress();
      return false;
    }
    if (replyWatch?.scope === scope && replyWatch.key === key) {
      replyWatch.view = view;
      replyWatch.posting = Boolean(job);
      if (replyWatch.snapshot) paintReplyProgress(view, replyWatch.snapshot);
      return true;
    }
    stopReplyProgress();
    const path = `${agentBase()}/conversations/${currentConversation.id}/reply-progress?${new URLSearchParams({key})}`;
    replyWatch = {scope, key, view, path, posting: Boolean(job), failures: 0};
    scheduleReplyProgress(replyWatch);
    return true;
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
    button.textContent = uiLabel('保存到资料空间', 'Save to Space');
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
  let groupReplyWatch = null;
  const groupReplyViews = new Map();
  const olderMessages = document.getElementById('chat-load-older');
  const latestMessages = document.getElementById('chat-back-to-latest');
  const historyNotice = document.getElementById('chat-history-status');

  function setSocialHistory(state) {
    socialHistory = state;
    if (!state || state.readingHistory) stopGroupReplyProgress();
    if (!state) groupReplyViews.clear();
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
    syncGroupReplyProgress();
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
      syncGroupReplyProgress();
    }
  });
  latestMessages?.addEventListener('click', () => {
    if (currentSource === 'social' && currentConversation) openSocialConversation(currentConversation.id);
  });

  let lastSocialItems = [];
  function waitingGroupReply(job) {
    return job.status === 'queued' || job.status === 'running';
  }

  function hasPendingReplies(items = lastSocialItems) {
    return items?.some(item => item.reply_jobs?.some(waitingGroupReply));
  }

  function canWatchGroupReplies() {
    return servedByDsbot && currentSource === 'social' && currentConversation?.kind === 'group'
      && !currentConversation.public_agent && socialHistory?.cid === currentConversation.id
      && !socialHistory.readingHistory && !socialHistory.loading
      && canWatchReply() && groupReplyViews.size > 0;
  }

  function paintGroupReplyProgress(items) {
    const changes = [];
    for (const [id, view] of groupReplyViews) {
      const snapshot = items.get(id);
      const text = snapshot && snapshot.message_id === view.messageId && snapshot.attempt === view.attempt
        && typeof snapshot.text === 'string' ? snapshot.text : '';
      if (view.preview.textContent !== text) changes.push({view, text});
    }
    if (!changes.length) return;
    const scroller = document.getElementById('message-scroller');
    const top = scroller.scrollTop;
    const follow = messageScrollerAtBottom(scroller);
    for (const {view, text} of changes) {
      view.preview.textContent = text;
      view.preview.hidden = !text;
      const state = text ? 'running' : view.job.status;
      view.row.dataset.state = state;
      view.note.textContent = view.job.agent_name + GROUP_REPLY_LABELS[state];
    }
    scroller.scrollTop = follow ? scroller.scrollHeight : top;
  }

  function stopGroupReplyProgress() {
    const watch = groupReplyWatch;
    if (!watch) return;
    groupReplyWatch = null;
    globalThis.clearTimeout(watch.timer);
    globalThis.clearTimeout(watch.timeout);
    watch.controller?.abort();
    paintGroupReplyProgress(new Map());
  }

  function currentGroupReplyWatch(watch) {
    return watch && groupReplyWatch === watch && sendScope() === watch.scope && canWatchGroupReplies();
  }

  function scheduleGroupReplyProgress(watch, delay = 500) {
    if (!currentGroupReplyWatch(watch)) return;
    watch.timer = globalThis.setTimeout(() => void pollGroupReplyProgress(watch), delay);
  }

  async function pollGroupReplyProgress(watch) {
    if (!currentGroupReplyWatch(watch)) {
      if (groupReplyWatch === watch) stopGroupReplyProgress();
      return;
    }
    const controller = watch.controller = new AbortController();
    watch.timeout = globalThis.setTimeout(() => controller.abort(), 5000);
    const result = await request('GET', watch.path, undefined, undefined, controller.signal).catch(() => null);
    globalThis.clearTimeout(watch.timeout);
    watch.controller = null;
    if (!currentGroupReplyWatch(watch)) {
      if (groupReplyWatch === watch) stopGroupReplyProgress();
      return;
    }
    if (result?.status === 200 && Array.isArray(result.body.items)) {
      const items = new Map(result.body.items.filter(item => item?.id).map(item => [item.id, item]));
      const settled = [...watch.items.values()].some(snapshot => {
        const view = groupReplyViews.get(snapshot.id);
        return view && view.messageId === snapshot.message_id && view.attempt === snapshot.attempt
          && items.get(snapshot.id)?.attempt !== snapshot.attempt;
      });
      watch.items = items;
      if (watch.degraded) stopPolling();
      watch.degraded = false;
      paintGroupReplyProgress(items);
      if (settled) {
        if (readingSocialContext()) {
          if (liveBanner) liveBanner.hidden = false;
        } else if (!pollTimer) schedulePoll(1200);
      }
      scheduleGroupReplyProgress(watch);
    } else if ([401, 403, 404].includes(result?.status)) {
      stopGroupReplyProgress();
      if (!pollTimer) scheduleSocialPoll(currentConversation);
    } else {
      watch.degraded = true;
      if (!pollTimer) scheduleSocialPoll(currentConversation);
      scheduleGroupReplyProgress(watch, 1500);
    }
  }

  function syncGroupReplyProgress() {
    if (!canWatchGroupReplies()) {
      stopGroupReplyProgress();
      return;
    }
    const scope = sendScope();
    if (groupReplyWatch?.scope === scope) {
      paintGroupReplyProgress(groupReplyWatch.items);
      return;
    }
    stopGroupReplyProgress();
    groupReplyWatch = {
      scope, path: `${socialBase()}/${currentConversation.id}/reply-progress`, items: new Map(),
    };
    scheduleGroupReplyProgress(groupReplyWatch);
  }

  const GROUP_REPLY_LABELS = {queued: ' · 等待回复', running: ' · 正在回复', failed: ' · 回复失败'};
  function renderReplyJobs(item) {
    const rows = document.createElement('div');
    rows.className = 'group-reply-jobs';
    for (const job of item.reply_jobs || []) {
      if (job.status === 'replied') continue;
      const row = document.createElement('div');
      row.className = 'group-reply-job';
      row.dataset.state = job.status;
      row.dataset.replyJobId = job.id;
      if (Number.isSafeInteger(job.attempt)) row.dataset.replyAttempt = String(job.attempt);
      const note = document.createElement('span');
      note.textContent = job.agent_name + (GROUP_REPLY_LABELS[job.status] || '');
      row.append(note);
      if (servedByDsbot && waitingGroupReply(job) && Number.isSafeInteger(job.attempt) && job.attempt > 0) {
        const preview = document.createElement('div');
        preview.className = 'group-reply-preview';
        preview.hidden = true;
        preview.setAttribute('aria-live', 'off');
        groupReplyViews.set(job.id, {messageId: item.id, attempt: job.attempt, job, row, note, preview});
        row.append(preview);
      }
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
              for (const previous of message.reply_jobs || []) groupReplyViews.delete(previous.id);
              message.reply_jobs = result.body.reply_jobs;
              const target = [...list.children].find(element => element.dataset.messageId === item.id);
              const jobs = target?.querySelector('.group-reply-jobs');
              if (jobs) jobs.replaceWith(renderReplyJobs(message));
              syncGroupReplyProgress();
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
    // Keep an open model attached to its original message when a sync rebuilds the list.
    const models = new Map();
    const focusedModelControl = document.activeElement?.closest('.chat-file-model3d') ? document.activeElement : null;
    for (const row of list.children) {
      const model = Array.from(row.children).find(child => child.dataset.model3dSource);
      if (model) models.set(row.dataset.messageId, model);
    }
    list.replaceChildren();
    groupReplyViews.clear();
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
      role.textContent = item.role === 'agent' ? (item.agent_name + uiLabel(' · AI 智能体 · 运行时回复', ' · AI agent · DS-Bot'))
        : (mine ? uiLabel('我', 'Me') : ((member && member.username) || uiLabel('成员', 'Member')));
      const body = document.createElement('div');
      body.className = 'body';
      if (item.attachment?.bytes !== undefined && item.body === item.attachment.title) body.hidden = true;
      renderMessageBody(document, body, item.retracted ? '此消息已撤回' : (item.body || ''), chatPreferences);
      if (item.forwarded_from && !item.retracted) {
        body.dataset.forwarded = '1';
        body.title = '转发自 ' + item.forwarded_from.author;
        role.textContent += ' · 转发自 ' + item.forwarded_from.author;
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
        const model = models.get(item.id);
        const reuse = item.attachment.mime === 'model/gltf-binary'
          && model?.dataset.model3dSource === item.attachment.path;
        li.insertBefore(reuse ? model : renderChatFile(document, item.attachment), time);
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
    if (focusedModelControl?.isConnected) focusedModelControl.focus({preventScroll: true});
    renderPendingSend();
    syncGroupReplyProgress();
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
      link.textContent = uiLabel('成员', 'Members');
    } else {
      link.href = '/agents';
      link.textContent = uiLabel('资料', 'Resources');
    }
  }

  let notificationSeq = 0;
  let notificationEpoch = 0;
  let notificationSnapshot = null;
  const notificationReads = new Set();
  const notificationKind = document.getElementById('notifications-kind');
  const notificationUnread = document.getElementById('notifications-unread');
  const notificationNotice = document.getElementById('notifications-status');
  const notificationScope = () => ({workspace: workspaceId(), owner: currentUser?.id, epoch: notificationEpoch});
  const currentNotificationScope = scope =>
    Boolean(scope?.owner && scope.owner === currentUser?.id && scope.workspace === workspaceId() && scope.epoch === notificationEpoch);

  function setNotificationStatus(text = '') {
    if (!notificationNotice) return;
    notificationNotice.textContent = text;
    notificationNotice.hidden = !text;
    if (text) {
      const empty = document.getElementById('notifications-empty');
      if (empty) empty.hidden = true;
    }
  }

  function resetNotifications() {
    notificationEpoch += 1;
    notificationSnapshot = null;
    setNotificationsOpen(false);
    renderNotifications({items: [], unread_count: 0}, notificationScope());
  }

  function applyNotificationRead(scope, result, id) {
    if (!currentNotificationScope(scope) || !notificationSnapshot) return;
    notificationSeq += 1;
    const body = notificationSnapshot.body;
    notificationSnapshot.body = {
      ...body,
      unread_count: result.body?.unread_count ?? body.unread_count,
      items: (body.items || []).map(item => !id || item.id === id ? {...item, read: true} : item),
    };
    renderNotifications(notificationSnapshot.body, scope);
  }

  function renderNotifications(body, scope) {
    const badge = document.getElementById('notification-count');
    const toggle = document.getElementById('notifications-toggle');
    const text = notificationBadgeText(body.unread_count);
    if (badge) { badge.textContent = text; badge.hidden = !text; }
    if (toggle) toggle.setAttribute('aria-label', text ? uiLabel(`通知，${body.unread_count} 条未读`, `Notifications, ${body.unread_count} unread`) : uiLabel('通知', 'Notifications'));
    const list = document.getElementById('notification-list');
    if (!list) return;
    const mentionsOnly = notificationKind?.value === 'mention';
    const items = (body.items || []).filter(item => (!mentionsOnly || item.kind === 'mention' || item.kind === 'messenger.mention')
      && (!notificationUnread?.checked || !item.read));
    list.replaceChildren(...items.map(item => {
      const li = document.createElement('li');
      const target = notificationTarget(item, scope.workspace);
      const button = document.createElement(target ? 'a' : 'button');
      const invalidLink = LINKED_NOTIFICATION_KINDS.has(item.kind) && !target;
      if (target) button.href = target;
      else {
        button.type = 'button';
        if (invalidLink) { button.disabled = true; button.title = '通知目标不可用'; }
      }
      button.className = 'notification-item' + (item.read ? '' : ' is-unread');
      button.dataset.notification = item.id;
      button.dataset.notificationKind = item.kind;
      const readKey = `${scope.epoch}:${item.id}`;
      if (notificationReads.has(readKey)) button.setAttribute('aria-busy', 'true');
      const summary = document.createElement('strong'); summary.textContent = notificationSummary(item);
      const excerpt = document.createElement('span'); excerpt.className = 'notification-excerpt'; excerpt.textContent = item.excerpt;
      const time = document.createElement('time'); time.textContent = formatSessionTime(item.created);
      button.append(summary, excerpt, time);
      button.addEventListener('click', async event => {
        if (target) event.preventDefault();
        if (invalidLink || !currentNotificationScope(scope) || notificationReads.has(readKey)) return;
        setNotificationStatus();
        if (!item.read) {
          notificationReads.add(readKey);
          button.setAttribute('aria-busy', 'true');
          const read = request('POST', `/v1/workspaces/${scope.workspace}/notifications/read`,
            {notification_id: item.id}, undefined, AbortSignal.timeout(5000), {keepalive: Boolean(target)})
            .catch(() => ({status: 0, body: {}}))
            .then(result => {
              notificationReads.delete(readKey);
              button.removeAttribute('aria-busy');
              if (result.status === 200) applyNotificationRead(scope, result, item.id);
              return result;
            });
          const result = target ? await waitForLinkedNotificationRead(read) : await read;
          if (!currentNotificationScope(scope)) return;
          if (result && result.status !== 200
            && ((result.status !== 0 && result.status < 500) || (!target && !item.conversation_id))) {
            setNotificationStatus('无法标记这条通知为已读，请重新打开通知后重试。');
            if (notificationSnapshot) renderNotifications(notificationSnapshot.body, scope);
            return;
          }
        }
        setNotificationsOpen(false);
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
      empty.hidden = items.length > 0 || Boolean(notificationNotice && !notificationNotice.hidden);
      empty.textContent = mentionsOnly
        ? (notificationUnread?.checked ? '暂无未读提及。' : '暂无提及。')
        : (notificationUnread?.checked ? '暂无未读通知。' : '暂无通知。');
    }
    const all = document.getElementById('notifications-read-all'); if (all) all.disabled = !(body.unread_count > 0);
  }

  async function loadNotifications({interactive = false} = {}) {
    const scope = notificationScope();
    if (!scope.workspace || !scope.owner) return;
    const token = ++notificationSeq;
    const unreadOnly = Boolean(notificationUnread?.checked);
    if (interactive) {
      setNotificationStatus('正在加载通知…');
      const old = notificationSnapshot;
      const items = old && (!old.unreadOnly || unreadOnly) ? old.body.items : [];
      renderNotifications({items, unread_count: old?.body.unread_count || 0}, scope);
    }
    const announce = interactive || notificationNotice?.textContent === '正在加载通知…';
    const suffix = unreadOnly ? '?filter=unread' : '';
    const result = await request('GET', `/v1/workspaces/${scope.workspace}/notifications${suffix}`)
      .catch(() => ({status: 0, body: {}}));
    if (token !== notificationSeq || !currentNotificationScope(scope) || unreadOnly !== Boolean(notificationUnread?.checked)) return;
    if (result.status !== 200) {
      if (announce) setNotificationStatus('无法加载通知。关闭后可重新打开。');
      return;
    }
    if (announce) setNotificationStatus();
    notificationSnapshot = {body: result.body, scope, unreadOnly};
    renderNotifications(result.body, scope);
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
    if (!open) setNotificationStatus();
  }

  const liveBanner = document.getElementById('conversation-live-update');
  const workspaceEvents = servedByDsbot ? mountChatActivity(document, {request, update: applySocialActivity}) : null;

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
  async function loadSessions(link) {
    const sequence = ++sessionsRequest;
    const user = currentUser;
    loadNotifications();
    loadDueReminders();
    const id = workspaceId();
    if (id !== sessionsWorkspace) workspaceEvents?.start(null);
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
    const receipt = link?.readReceipt;
    if (receipt) {
      const row = (receipt.source === 'social' ? socialConversations : rows).find(item => item.id === receipt.id);
      const covered = Number.isSafeInteger(receipt.seq) && Number.isSafeInteger(row?.last_seq)
        ? row.last_seq <= receipt.seq
        : Number.isFinite(row?.updated) && Number.isFinite(receipt.updated) && row.updated <= receipt.updated;
      if (covered) row.unread_count = Math.min(Number(row.unread_count) || 0, receipt.count);
    }
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
    workspaceEvents?.start(id);
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
    cancelStartupLink();
    stopReplyProgress();
    socialOpen += 1;
    currentConversation = null;
    currentAgent = agent;
    currentSource = 'agent';
    closeInChatSearch({restoreScroll: false, focus: false});
    publicDraft.enter(sendScope());
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
    renderAgentQuickStarts(agent);
    syncPlusState();
  }

  let startupLink = null;
  const openingStartupLink = () => startupLink?.open === socialOpen && startupLink.current();

  function cancelStartupLink() {
    if (!startupLink) return;
    startupLink = null;
    if (status.dataset.kind === 'loading' && status.textContent === '正在打开对话…') show('', '');
  }

  async function openAgentConversation(agentId, conversationId, {refresh = false, link} = {}) {
    if (refresh && openingStartupLink()) return false;
    if (!refresh) {
      if (!link) cancelStartupLink();
      renderAgentQuickStarts();
      stopReplyProgress();
      stopGroupReplyProgress();
      stopPolling();
    }
    const open = ++socialOpen;
    const wid = workspaceId();
    const owner = currentUser;
    const sameScope = () => open === socialOpen && workspaceId() === wid && currentUser === owner;
    const stillOpen = () => sameScope() && (!link || link.current());
    const result = await request('GET', `/v1/workspaces/${wid}/agents/${agentId}/conversations/${conversationId}`)
      .catch(() => ({status: 0, body: {}}));
    if (!stillOpen()) return false;
    if (result.status !== 200) {
      if (refresh && [403, 404, 410].includes(result.status)) renderAgentQuickStarts();
      if (!refresh) {
        show('error', messageFor(result.body.error, '无法打开对话。'));
        syncReplyProgress();
        syncGroupReplyProgress();
      }
      return false;
    }
    const detailAgent = result.body.agent?.id === agentId ? result.body.agent : null;
    // Older private detail payloads can omit the agent projection. Reuse the
    // directory request already in flight without fetching history twice.
    if (!detailAgent && !agents.some(item => item.id === agentId) && link?.directory) {
      await link.directory;
      if (!stillOpen()) return false;
    }
    const listedAgent = agents.find(item => item.id === agentId);
    const agent = servedByDsbot ? detailAgent || listedAgent : listedAgent || detailAgent;
    const conversation = result.body.conversation;
    if (!agent || conversation?.id !== conversationId || (link && (
      (agent.workspace_id && agent.workspace_id !== wid) || (conversation.workspace_id && conversation.workspace_id !== wid)
      || (conversation.agent_id && conversation.agent_id !== agentId)))) {
      if (link) show('error', '无法打开对话。');
      return false;
    }
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
    if (currentConversation?.id !== conversation.id) {
      const autoReplyNotice = document.getElementById('group-agent-auto-reply-status');
      if (autoReplyNotice) autoReplyNotice.hidden = true;
      closeInChatSearch({restoreScroll: false, focus: false});
    }
    currentConversation = conversation;
    publicDraft.enter(sendScope());
    renderAgentQuickStarts(detailAgent);
    if (!link) writeHash({workspace: wid, agent: agentId, conversation: conversationId});
    setSessionsOpen(false);
    const pending = renderAgentMessages(result.body.items, {followLatest: !refresh});
    const finished = (result.body.items || []).filter(item => item.role === 'assistant' && item.status === 'succeeded');
    if (currentConversation.unread_count > 0 && finished.length && document.visibilityState !== 'hidden') {
      const read = request('POST', `/v1/workspaces/${wid}/agents/${agentId}/conversations/${conversationId}/read`,
        {message_id: finished[finished.length - 1].id}).then(acknowledged => {
        if (!sameScope() || acknowledged.status !== 200) return;
        applyOpenedRead('agent', conversation, acknowledged.body.unread_count, link);
      }).catch(() => {});
      if (!link) await read;
    }
    if (!stillOpen()) return false;
    renderSessions();
    if (pending) schedulePoll();
    else stopPolling();
    return stillOpen();
  }

  async function openSocialConversation(conversationId, {acknowledge = true, refresh = false, publicStartCurrent, link} = {}) {
    if (refresh && openingStartupLink()) return false;
    if (!refresh && !link) cancelStartupLink();
    stopReplyProgress();
    renderAgentQuickStarts();
    const open = ++socialOpen;
    const wid = workspaceId();
    const owner = currentUser;
    if (currentSource !== 'social' || currentConversation?.id !== conversationId) {
      setSocialHistory(null);
      voiceRecorder.clear();
    }
    currentAgent = null;
    currentSource = 'social';
    stopPolling();
    const sameScope = () => open === socialOpen && workspaceId() === wid && currentUser === owner && currentSource === 'social';
    const stillOpen = () => sameScope() && (!link || link.current());
    const result = await request('GET', `${socialBase()}/${conversationId}`).catch(() => ({status: 0, body: {}}));
    if (!stillOpen() || (publicStartCurrent && !publicStartCurrent())) return false;
    if (result.status !== 200) {
      if (refresh) {
        scheduleSocialPoll(currentConversation);
        return false;
      }
      show('error', messageFor(result.body.error, '无法打开会话。'));
      return false;
    }
    const updated = result.body.conversation;
    if (updated?.id !== conversationId || (link && updated.workspace_id && updated.workspace_id !== wid)) {
      if (link) show('error', '无法打开会话。');
      return false;
    }
    if (publicStartCurrent && (!updated.public_agent || updated.public_agent.open === false)) return false;
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
      closeInChatSearch({restoreScroll: false, focus: false});
    }
    currentConversation = updated;
    publicDraft.enter(sendScope(), Boolean(updated.public_agent));
    renderReplyDraft();
    if (liveBanner) liveBanner.hidden = true;
    setSocialHistory({wid, cid: conversationId, cursor: result.body.cursor ?? null});
    chatCalls.sync();
    agentMentions.refresh();
    voiceRecorder.refresh();
    setSessionsOpen(false);
    const pin = document.getElementById('pin-conversation');
    syncMuteButton(currentConversation);
    if (pin) { pin.hidden = false; pin.textContent = socialPinned(updated) ? '取消置顶' : '置顶会话'; }
    const agentNote = document.getElementById('social-agent-members');
    agentNote.textContent = groupAgentSummary(currentConversation);
    agentNote.hidden = Boolean(currentConversation.public_agent) || !agentNote.textContent;
    applyChatIdentity(document, conversationLabel(
      currentConversation, currentUser && currentUser.id), currentConversation);
    setDirectoryLink({source: 'social', public_agent: currentConversation.public_agent});
    if (!link) writeHash({workspace: wid, social: conversationId});
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
      const last = shown[shown.length - 1];
      const cursor = Number.isSafeInteger(last.seq) ? {seq:last.seq} : {message_id:last.id};
      const read = request('POST', `${socialBase()}/${conversationId}/read`, cursor).then(acknowledged => {
        if (!sameScope() || acknowledged.status !== 200) return;
        applyOpenedRead('social', updated, acknowledged.body.unread_count, link, cursor.seq);
      }).catch(() => {});
      if (!link) await read;
    }
    if (!stillOpen()) return false;
    renderSessions();
    scheduleSocialPoll(currentConversation);
    if ((result.body.agent_replies || []).some(item => ['queued', 'running'].includes(item.status))) schedulePoll();
    return true;
  }

  function applyOpenedRead(source, conversation, unread, link, seq) {
    if (!Number.isSafeInteger(unread) || unread < 0) return;
    conversation.unread_count = unread;
    const listed = source === 'social' && socialConversations.find(item => item.id === conversation.id);
    if (!(Number.isSafeInteger(seq) && listed?.last_seq > seq)) {
      const session = sessions.find(item => item.source === source && item.id === conversation.id);
      if (session) session.unread_count = unread;
      if (listed) listed.unread_count = unread;
    }
    if (link) {
      link.readReceipt = {source, id:conversation.id, count:unread, updated:conversation.updated, seq};
      renderSessions();
    }
  }

  function socialPinned(conversation) {
    const row = sessions.find(item => item.source === 'social' && item.id === conversation.id);
    return Boolean(row?.pinned ?? conversation.pinned);
  }

  function scheduleSocialPoll(conversation) {
    if (hasPendingReplies() || conversation?.public_agent?.pending) {
      if (currentGroupReplyWatch(groupReplyWatch) && !groupReplyWatch.degraded) return;
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
    if (currentSource === 'agent' && !canWatchReply()) return;
    pollTimer = globalThis.setTimeout(() => {
      pollTimer = 0;
      if (currentConversation && currentAgent && currentSource === 'agent' && canWatchReply()) {
        openAgentConversation(currentAgent.id, currentConversation.id, {refresh: true});
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
    if (currentSource === 'agent') {
      if (document.visibilityState === 'visible') void refreshAgentQuickStarts();
      if (!canWatchReply()) stopPolling();
      if (!syncReplyProgress() && currentConversation && lastAgentItems.some(waitingAgentReply)) schedulePoll();
      return;
    }
    syncGroupReplyProgress();
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

  let launchAttempt = null;

  function publicStartError(intent, message, retry) {
    show('error', message);
    if (retry) {
      const button = document.createElement('button');
      button.type = 'button';
      button.id = 'public-agent-retry';
      button.className = 'public-agent-action';
      button.textContent = '重试';
      button.addEventListener('click', retry);
      status.append(button);
    }
    const link = document.createElement('a');
    link.href = '/a/' + intent.slug;
    link.className = 'public-agent-action';
    link.textContent = '返回公开主页';
    status.append(link);
  }

  async function startPublicConversation(intent) {
    const continuation = publicAgentContinuation(intent);
    const owner = currentUser?.id;
    if (!owner || !continuation || publicAgentContinuation(publicAgentIntentFromHash(location.hash)) !== continuation) return;
    const scope = owner + continuation;
    if (launchAttempt?.scope === scope && launchAttempt.busy) return;
    const opening = intent.draft && publicAgentOpening(document.defaultView, intent);
    if (intent.draft && !opening) {
      publicStartError(intent, '找不到首页草稿或草稿已过期，请返回公开主页。');
      return;
    }
    const quick = intent.quickStart !== undefined;
    const attempt = {scope, busy: true};
    launchAttempt = attempt;
    let completed = false;
    const retry = () => startPublicConversation(intent);
    const active = () => launchAttempt === attempt && currentUser?.id === owner
      && publicAgentContinuation(publicAgentIntentFromHash(location.hash)) === continuation;
    const previousOpen = socialOpen;
    show('loading', quick ? '正在准备快捷开场…' : '正在打开公开智能体…');
    try {
      const payload = opening ? {listing_id: opening.listingId}
        : quick ? {quick_start: intent.quickStart, quick_start_version: intent.version} : {};
      const result = await request('POST', '/v1/discover/agents/' + intent.slug + '/start', payload);
      if (!active() || socialOpen !== previousOpen) return;
      const {workspace_id, conversation_id, draft_text} = result.body || {};
      if (![200, 201].includes(result.status) || !/^[A-Za-z0-9._-]{1,80}$/.test(conversation_id || '')
          || !workspaces.some(space => space.id === workspace_id) || (quick && (typeof draft_text !== 'string' || !draft_text.trim() || draft_text.length > 80))) {
        const canRetry = result.status === 429 || result.status >= 500 || result.status === 0;
        publicStartError(intent, messageFor(result.body?.error, '无法打开公开智能体。'), canRetry ? retry : null);
        return;
      }
      workspaceSelect.value = workspace_id;
      if (await openSocialConversation(conversation_id, {acknowledge: false, publicStartCurrent: active})) {
        completed = true;
        const current = launchAttempt === attempt && currentUser?.id === owner && currentSource === 'social'
          && currentConversation?.id === conversation_id && workspaceId() === workspace_id;
        if (!current) return;
        if (opening) {
          const available = publicAgentOpening(document.defaultView, intent);
          const filled = available?.listingId === opening.listingId && publicDraft.fillOpening(available.text);
          if (filled) {
            consumePublicAgentOpening(document.defaultView, intent);
            if (filled === 'filled') show('ok', '首页草稿已填入输入框，可编辑后发送。', {announceOnly: true});
            else show('', '');
          } else {
            publicStartError(intent, '无法恢复首页草稿，请返回公开主页。');
          }
        } else if (quick && publicDraft.fill(draft_text)) {
          show('ok', '开场已填入输入框，可编辑后发送。', {announceOnly: true});
        } else {
          show('', '');
        }
        void loadSessions();
      } else if (active()) {
        publicStartError(intent, '暂时无法加载对话。', retry);
      }
    } catch {
      if (active()) publicStartError(intent, '连接中断，请重试。', retry);
    } finally {
      attempt.busy = false;
      if (completed && launchAttempt === attempt) launchAttempt = null;
    }
  }

  async function openLinkedConversation(start, loadCurrent, parallelDirectory) {
    const owner = currentUser;
    const workspace = workspaceId();
    const link = {current: () => startupLink === link && link.open === socialOpen
      && currentUser === owner && workspaceId() === workspace && loadCurrent()};
    startupLink = link;
    show('loading', '正在打开对话…');
    const opened = start.social
      ? openSocialConversation(start.social, {acknowledge: !start.message, link})
      : openAgentConversation(start.agent, start.conversation, {link});
    link.open = socialOpen;
    if (parallelDirectory) link.directory = loadSessions(link);
    try {
      if (!await opened || !link.current()) return;
      const message = start.social
        ? (chatPathId(start.message) ? start.message : '')
        : (/^[0-9a-f]{32}$/.test(start.message) ? start.message : '');
      if (message) {
        const moved = await jumpToMessage(message, null, link.current);
        if (!link.current()) return;
        if (!moved) {
          show('error', '找不到这条来源消息。');
          return;
        }
      }
      writeHash(start.social ? {workspace, social:start.social, message}
        : {workspace, agent:start.agent, conversation:start.conversation, message});
      show('', '');
    } finally {
      if (startupLink === link) startupLink = null;
    }
  }

  let loadRequest = 0;

  async function load() {
    const sequence = ++loadRequest;
    const hash = location.hash;
    const pathname = location.pathname;
    const banner = document.getElementById('onboarding-banner');
    let navigation = socialOpen;
    const loadCurrent = () => sequence === loadRequest && location.hash === hash && location.pathname === pathname;
    const bootCurrent = () => loadCurrent() && socialOpen === navigation;
    const session = await request('GET', '/v1/auth/session');
    if (!bootCurrent()) return;
    if (session.status !== 200 || !session.body?.user?.id) {
      if (banner) banner.hidden = true;
      currentUser = null;
      currentAgent = null;
      renderAgentQuickStarts();
      resetNotifications();
      workspaceEvents?.start(null);
      autoTranslation.open(null);
      attachmentSender?.reset();
      clearPendingSends();
      memoryDrafts.clear();
      memoryWrites.clear();
      replyDrafts.clear();
      publicDraft.clear();
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
      currentAgent = null;
      currentConversation = null;
      socialOpen += 1;
      navigation = socialOpen;
      renderAgentQuickStarts();
      resetNotifications();
      attachmentSender?.reset();
      clearPendingSends();
      memoryDrafts.clear();
      memoryWrites.clear();
      replyDrafts.clear();
      publicDraft.clear();
      renderReplyDraft();
    }
    const owner = session.body.user;
    if (currentUser?.id !== owner.id && banner) banner.hidden = true;
    currentUser = owner;
    if (banner) void request('GET', '/v1/onboarding').then(onboarding => {
      if (sequence !== loadRequest || currentUser !== owner || location.pathname !== pathname || onboarding.status !== 200) return;
      banner.hidden = Boolean(onboarding.body.onboarding?.completed);
    }).catch(() => {});
    const publicIntent = publicAgentIntentFromHash(hash);
    if (publicIntent) show('loading', publicIntent.quickStart === undefined ? '正在打开公开智能体…' : '正在准备快捷开场…');
    loginPanel.hidden = true;
    mainPanel.hidden = false;
    if (servedByDsbot) chatCalls.resumeMeeting();
    document.getElementById('session-pane').hidden = false;
    document.body.classList.add('chat-open');
    setSessionsOpen(true);
    document.getElementById('whoami').textContent = currentUser.username;
    if (!sessions.length) setSessionsStatus('正在加载对话…');
    const listWorkspaces = () => request('GET', '/v1/workspaces?limit=100');
    const personalAndWorkspaces = (async () => {
      if (servedByDsbot) {
        const personalRequest = request('GET', '/v1/personal-agent').catch(() => null);
        const workspaceRequest = listWorkspaces().catch(() => null);
        const personal = await personalRequest;
        const existing = personal?.body?.personal_agent;
        if (personal?.status === 200 && existing?.agent?.id && existing.workspace?.id) {
          const listed = await workspaceRequest;
          if (listed?.status === 200 && listed.body?.items?.some(space => space.id === existing.workspace.id)) {
            return {personal, listed};
          }
        }
        if (!bootCurrent()) return {};
      }
      // A first-time account can receive a new workspace during initialization.
      const personal = await request('POST', '/v1/personal-agent');
      const listed = await listWorkspaces();
      return {personal, listed};
    })();
    const [{personal, listed}, settings] = await Promise.all([
      personalAndWorkspaces,
      request('GET', '/v1/settings'),
    ]);
    if (!bootCurrent()) return;

    const personalEntity = [200, 201].includes(personal.status) ? personal.body.personal_agent : null;
    const personalWorkspace = personalEntity?.workspace?.id || '';
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
    if (listed.status !== 200 || (publicIntent && !listed.body.items?.length)) {
      setSessionsStatus('无法加载工作区，请重试。');
      if (publicIntent && publicAgentContinuation(publicAgentIntentFromHash(location.hash)) === publicAgentContinuation(publicIntent)) {
        publicStartError(publicIntent, '暂时无法加载工作区。', () => void load());
      }
      return;
    }
    workspaces = listed.body.items || [];
    const start = hashParams(hash);
    const hasLink = start.social || (start.agent && start.conversation);
    const wanted = start.workspace || personalWorkspace || workspaceSelect.value;
    workspaceSelect.replaceChildren();
    for (const space of workspaces) {
      const option = document.createElement('option');
      option.value = space.id;
      option.textContent = space.name;
      workspaceSelect.append(option);
    }
    workspaceSelect.value = (workspaces.find(space => space.id === wanted)
      || workspaces.find(space => space.id === personalWorkspace) || workspaces[0])?.id || '';
    if (!workspaces.length) {
      setSessionsStatus('');
      document.getElementById('conversations-empty').hidden = false;
      document.getElementById('chat-empty').hidden = false;
      if (hasLink && start.workspace) show('error', '无法访问此会话所在的工作区。');
      else show('', '');
      return;
    }
    if (publicIntent) {
      await startPublicConversation(publicIntent);
      return;
    }
    if (hasLink && start.workspace && workspaceId() !== start.workspace) {
      show('error', '无法访问此会话所在的工作区。');
      void loadSessions();
      return;
    }
    if (hasLink && !(start.social ? chatPathId(start.social) : chatPathId(start.agent) && chatPathId(start.conversation))) {
      show('error', '此对话链接无效。');
      void loadSessions();
      return;
    }
    if (hasLink && start.workspace) {
      await openLinkedConversation(start, loadCurrent, true);
      return;
    }
    await loadSessions();
    if (!bootCurrent()) return;
    if (hasLink) {
      await openLinkedConversation(start, loadCurrent, false);
      return;
    }
    if (start.agent) {
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
  notificationKind?.addEventListener('change', () => {
    if (notificationSnapshot) renderNotifications(notificationSnapshot.body, notificationSnapshot.scope);
  });
  notificationUnread?.addEventListener('change', () => loadNotifications({interactive: true}));
  const notificationsToggle = document.getElementById('notifications-toggle');
  if (notificationsToggle) notificationsToggle.addEventListener('click', async () => {
    const panel = document.getElementById('notifications-panel');
    const open = Boolean(panel && panel.hidden);
    setNotificationsOpen(open);
    if (open) await loadNotifications({interactive: true});
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !document.getElementById('notifications-panel')?.hidden) {
      void loadNotifications();
    }
  });
  globalThis.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    void loadNotifications();
    void refreshAgentQuickStarts();
  });
  const readAll = document.getElementById('notifications-read-all');
  if (readAll) readAll.addEventListener('click', async () => {
    const scope = notificationScope();
    if (!scope.owner || !scope.workspace || readAll.disabled) return;
    readAll.disabled = true;
    const result = await request('POST', `/v1/workspaces/${scope.workspace}/notifications/read`,
      {all: true}, undefined, AbortSignal.timeout(5000)).catch(() => ({status: 0, body: {}}));
    if (!currentNotificationScope(scope)) return;
    if (result.status !== 200) {
      setNotificationStatus('无法标记通知为已读。');
      readAll.disabled = false;
      return;
    }
    applyNotificationRead(scope, result);
    await loadNotifications();
  });
  function clearChatScope() {
    cancelStartupLink();
    stopReplyProgress();
    stopGroupReplyProgress();
    socialOpen += 1;
    setSocialHistory(null);
    if (liveBanner) liveBanner.hidden = true;
    resetNotifications();
    agentMentions.clear();
    currentAgent = null;
    currentConversation = null;
    currentSource = 'agent';
    renderAgentQuickStarts();
    publicDraft.enter(sendScope());
    syncCaptureButton();
    chatCalls.sync();
    voiceRecorder.refresh();
    clearVoicePlayers();
    stopPolling();
    closeSearchPanel();
    closeComposeDialog();
    closeInChatSearch({restoreScroll: false, focus: false});
    applyChatIdentity(document, '聊天');
    showPublicChatState(null);
    renderReplyDraft();
    document.getElementById('message-list').replaceChildren();
    document.getElementById('chat-empty').hidden = false;
    renderPendingSend();
    setDirectoryLink({source: 'agent'});
    syncPlusState();
  }

  workspaceSelect.addEventListener('change', async () => {
    clearChatScope();
    writeHash({workspace: workspaceId()});
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
  async function jumpToMessage(messageId, notice = document.getElementById('conversation-search-status'), isCurrent = () => true) {
    if (!isCurrent()) return false;
    const list = document.getElementById('message-list');
    const findTarget = () => Array.from(list.children || []).find(node => node.dataset.messageId === messageId);
    let target = findTarget();
    const jump = ++historyJump;
    const state = socialHistory;
    if (!target && currentSource === 'social' && state) {
      try {
        const query = new URLSearchParams({around: messageId, limit: '50'});
        const result = await historyPage(state, query);
        if (!result || jump !== historyJump || !isCurrent()) return false;
        if (result.status === 200 && result.body.items?.some(item => item.id === messageId)) {
          setSocialHistory({...state, cursor: result.body.cursor ?? null,
            readingHistory: true, loading: false});
          searchScrollSnapshot = null;
          renderSocialMessages(result.body.items, {keepScroll: false});
          target = findTarget();
          if (notice) notice.textContent = '';
        }
      } catch {
        if (socialHistory !== state || jump !== historyJump || !isCurrent()) return false;
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
  function searchHitRow(hit, view) {
    const li = document.createElement('li');
    li.className = 'search-hit';
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    li.setAttribute('aria-label', '跳到这条消息');
    const jump = () => jumpToMessage(hit.messageId, inChatStatus, () => currentSearchView(view));
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
    text.append(...highlightParts(hit.snippet || hit.preview || '', view.query).map(part => {
      if (!part.match) return document.createTextNode(part.text);
      const mark = document.createElement('mark'); mark.textContent = part.text; return mark;
    }));
    li.append(avatar, head, text);
    return li;
  }
  const CONVERSATION_SCOPES = {
    messages: {placeholder: '搜索当前会话', note: '搜索当前会话中的消息。'},
    resources: {placeholder: '搜索资料标题', note: '搜索在这个会话中分享的资料。', kind: 'resource', noun: '资料', unit: '份'},
    photos: {placeholder: '搜索照片文件名', note: '搜索当前会话中的照片。', kind: 'photo', noun: '照片', unit: '张'},
    files: {placeholder: '搜索文件名', note: '搜索当前会话中的文件。', kind: 'file', noun: '文件', unit: '个'},
  };
  const inChatPanel = document.getElementById('conversation-search-panel');
  const inChatQuery = document.getElementById('conversation-search-query');
  const inChatResults = document.getElementById('conversation-search-results');
  const inChatStatus = document.getElementById('conversation-search-status');
  const inChatMore = document.getElementById('conversation-search-more');
  const inChatRetry = document.getElementById('conversation-search-retry');
  let conversationScope = 'messages';
  let searchedChat = '';
  let inChatView;
  let searchDelay;
  const conversationQuery = () => inChatQuery.value.trim();
  const currentSearchView = view => Boolean(view && inChatView === view && !inChatPanel.hidden
    && view.chat === sendScope() && view.scope === conversationScope && view.query === conversationQuery());

  function clearConversationSearch() {
    clearTimeout(searchDelay);
    inChatView?.controller?.abort();
    inChatView = null;
    void inChatSearch.load('');
    inChatResults.replaceChildren();
    inChatResults.scrollTop = 0;
    inChatResults.setAttribute('aria-busy', 'false');
    inChatStatus.textContent = '';
    inChatMore.hidden = true;
    inChatMore.disabled = false;
    inChatRetry.hidden = true;
  }

  function setConversationScope(tab) {
    conversationScope = tab;
    for (const name of Object.keys(CONVERSATION_SCOPES)) {
      document.getElementById('conversation-search-tab-' + name)?.setAttribute('aria-selected', String(name === tab));
    }
    const {placeholder, note} = CONVERSATION_SCOPES[tab];
    inChatQuery.placeholder = placeholder;
    document.getElementById('conversation-search-query-label').textContent = placeholder;
    document.getElementById('conversation-search-scope-note').textContent = note;
  }

  function attachmentHitRow(item, view, kind) {
    const {attachment} = item;
    const photo = kind === 'photo';
    const isResource = kind === 'resource';
    const resource = isResource ? attachment.resource : null;
    const title = resource?.title || attachment.title || (photo ? '未命名照片' : isResource ? '未命名资料' : '未命名文件');
    const li = document.createElement('li');
    li.className = 'attachment-search-hit' + (isResource ? ' resource-search-hit' : '');
    const jump = document.createElement('button');
    jump.type = 'button';
    jump.className = 'search-hit attachment-search-jump';
    jump.setAttribute('aria-label', '跳到原消息，' + title);
    jump.addEventListener('click', async () => {
      const located = await jumpToMessage(item.message_id, inChatStatus, () => currentSearchView(view));
      if (!located || !currentSearchView(view)) return;
      searchScrollSnapshot = null;
      if (globalThis.matchMedia?.('(max-width: 700px)').matches) closeInChatSearch({restoreScroll: false, focus: false});
    });
    const avatar = document.createElement('span');
    avatar.className = 'search-hit-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = photo ? '照' : isResource ? '资' : '件';
    const head = document.createElement('span');
    head.className = 'search-hit-head';
    const name = document.createElement('strong');
    name.textContent = title;
    name.title = title;
    head.append(name);
    const when = document.createElement('time');
    when.textContent = formatSessionTime(item.created_at);
    const version = artifactVersionLabel(resource, attachment.mime);
    if (version) {
      const meta = document.createElement('span');
      meta.className = 'search-hit-text resource-search-meta';
      const description = document.createElement('span');
      description.textContent = version;
      meta.append(description, when);
      jump.append(avatar, head, meta);
    } else {
      when.className = 'search-hit-text';
      jump.append(avatar, head, when);
    }
    li.append(jump);
    const download = chatFileDownload(document, attachment);
    if (download) {
      download.className = 'attachment-search-download';
      li.append(download);
    }
    return li;
  }

  async function searchAttachmentPage(view, {kind, noun, unit}) {
    const conversation = currentConversation.id;
    const base = currentSource === 'social' ? socialBase() : agentBase() + '/conversations';
    const params = new URLSearchParams({kind, q: view.query, limit: '20'});
    if (view.cursor) params.set('cursor', view.cursor);
    view.controller = new AbortController();
    const result = await request('GET', `${base}/${conversation}/attachments?${params}`, undefined, undefined, view.controller.signal);
    if (!currentSearchView(view)) return;
    if (result.status !== 200) throw new Error('读不到当前会话的附件，请重试。');
    for (const item of result.body.items || []) {
      if (!item.message_id || !item.attachment?.id) continue;
      const id = JSON.stringify([item.message_id, item.attachment.id]);
      if (view.seen.has(id)) continue;
      view.seen.add(id);
      inChatResults.append(attachmentHitRow(item, view, kind));
    }
    const next = result.body.next_cursor;
    view.cursor = typeof next === 'string' && next !== view.cursor ? next : '';
    inChatStatus.textContent = view.seen.size ? `已显示 ${view.seen.size} ${unit}${noun}`
      : view.query ? `没有找到匹配的${noun}。` : `这个会话里还没有${noun}。`;
  }

  async function searchCurrentConversation(append = false) {
    if (!currentConversation || inChatPanel.hidden) return;
    if (append) {
      if (!currentSearchView(inChatView) || !inChatView.cursor || inChatView.loading) return;
    } else {
      clearConversationSearch();
      const query = conversationQuery();
      if (conversationScope === 'messages' && !query) return;
      inChatView = {chat: sendScope(), scope: conversationScope, query, cursor: '', seen: new Set()};
    }
    const view = inChatView;
    const scope = CONVERSATION_SCOPES[view.scope];
    const noun = scope.noun || '消息';
    view.loading = true;
    inChatResults.setAttribute('aria-busy', 'true');
    inChatStatus.textContent = append ? '正在加载更多…' : `正在搜索${noun}…`;
    inChatMore.disabled = true;
    inChatRetry.hidden = true;
    try {
      if (scope.kind) {
        await searchAttachmentPage(view, scope);
      } else {
        const state = await inChatSearch.load(view.query, currentConversation.id, {append});
        if (!currentSearchView(view)) return;
        if (state.error) throw new Error(state.error);
        inChatResults.replaceChildren(...state.hits.map(hit => searchHitRow(hit, view)));
        view.cursor = state.cursor;
        inChatStatus.textContent = state.hits.length ? `已显示 ${state.hits.length} 条消息` : '没有找到匹配的消息。试试其他关键词。';
      }
      if (currentSearchView(view)) inChatMore.hidden = !view.cursor;
    } catch {
      if (!currentSearchView(view)) return;
      inChatStatus.textContent = append ? '无法加载更多，请重试。' : `无法搜索${noun}，请重试。`;
      view.retryAppend = append;
      inChatMore.hidden = true;
      inChatRetry.hidden = false;
    } finally {
      if (currentSearchView(view)) {
        view.loading = false;
        view.controller = null;
        inChatMore.disabled = false;
        inChatResults.setAttribute('aria-busy', 'false');
      }
    }
  }

  for (const scope of Object.keys(CONVERSATION_SCOPES)) {
    document.getElementById('conversation-search-tab-' + scope)?.addEventListener('click', () => {
      if (scope === conversationScope) return;
      setConversationScope(scope);
      return searchCurrentConversation();
    });
  }
  const groupInfoToggle = document.getElementById('group-info-toggle');
  if (groupInfoToggle) {
    groupInfoToggle.addEventListener('click', () => {
      const open = groupInfoToggle.getAttribute('aria-expanded') !== 'true';
      if (open) closeInChatSearch({restoreScroll: false, focus: false});
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
  inChatOpen?.addEventListener('click', () => {
    if (!currentConversation) { show('error', '请先打开一个会话。'); return; }
    setGroupInfoOpen(false);
    if (!inChatPanel.hidden) { inChatQuery.focus(); return; }
    const chat = sendScope();
    if (searchedChat !== chat) {
      searchedChat = chat;
      inChatQuery.value = '';
      setConversationScope('messages');
    }
    searchScrollSnapshot = {chat, top: document.getElementById('message-scroller').scrollTop};
    inChatPanel.hidden = false;
    inChatQuery.focus();
    return searchCurrentConversation();
  });
  function closeInChatSearch({restoreScroll = true, focus = true} = {}) {
    inChatPanel.hidden = true;
    clearConversationSearch();
    if (restoreScroll && searchScrollSnapshot?.chat === sendScope()) {
      document.getElementById('message-scroller').scrollTop = searchScrollSnapshot.top;
    }
    searchScrollSnapshot = null;
    if (focus) {
      const opener = inChatOpen?.checkVisibility?.() === false ? document.getElementById('chat-more') : inChatOpen;
      opener?.focus();
    }
  }
  document.getElementById('conversation-search-close')?.addEventListener('click', () => closeInChatSearch());
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !inChatPanel.hidden) closeInChatSearch();
  });
  document.getElementById('conversation-search-form')?.addEventListener('submit', event => {
    event.preventDefault();
    return searchCurrentConversation();
  });
  inChatQuery.addEventListener('input', event => {
    clearConversationSearch();
    if (!event.isComposing) searchDelay = setTimeout(() => void searchCurrentConversation(), 200);
  });
  inChatMore.addEventListener('click', () => searchCurrentConversation(true));
  inChatRetry.addEventListener('click', () => searchCurrentConversation(inChatView?.retryAppend || false));
  function renderDeliveredSocialMessage(scope, message) {
    if (message && scope === sendScope() && !socialHistory?.readingHistory) {
      const without = lastSocialItems.filter(item => item.id !== message.id);
      renderSocialMessages([...without, message].sort((a,b) => a.seq - b.seq));
    }
    void loadSessions();
  }

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
      renderDeliveredSocialMessage(destination.scope, message);
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
    if (name) filterButton?.setAttribute('aria-label', uiLabel('会话筛选：', 'Conversation filter: ') + name);
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
    const pinned = socialPinned(currentConversation);
    const result = await request('POST', `${socialBase()}/${id}/preferences`, {pinned: !pinned});
    if (result.status !== 200) { show('error', '置顶未保存。'); return; }
    await loadSessions(); await openSocialConversation(id);
  });
  document.getElementById('search-close').addEventListener('click', closeSearchPanel);
  document.getElementById('chat-back').addEventListener('click', () => {
    cancelStartupLink();
    stopReplyProgress();
    stopGroupReplyProgress();
    if (currentSource === 'agent') stopPolling();
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
    if (groupReplyBusy || currentSource !== 'social' || currentConversation?.kind !== 'group'
      || currentConversation.public_agent) return;
    const cid = currentConversation.id;
    const scope = sendScope();
    const agentIds = [...document.querySelectorAll('#group-agent-choices input[name="group-agent"]:checked')]
      .map(box => box.value);
    const field = document.getElementById('group-agent-prompt');
    const prompt = field.value;
    if (!agentIds.length) {
      show('error', '请选择至少一个群内智能体。');
      return;
    }
    if (!prompt.trim()) return;
    const fingerprint = JSON.stringify([scope, agentIds.slice().sort(), prompt]);
    if (!groupReplyAttempt || groupReplyAttempt.fingerprint !== fingerprint) {
      groupReplyAttempt = {fingerprint, key: idempotencyKey('group-reply-')};
    }
    groupReplyBusy = true;
    const button = document.getElementById('group-agent-submit');
    const label = button.textContent;
    button.disabled = true;
    button.textContent = '发送中…';
    try {
      const result = await request('POST', `${socialBase()}/${cid}/agent-replies`,
        {agent_ids: agentIds, prompt}, {'Idempotency-Key': groupReplyAttempt.key})
        .catch(() => ({status: 0, body: {}}));
      if (result.status !== 202 || !result.body.message?.id) {
        if (scope === sendScope()) show('error', messageFor(result.body.error, '发送未确认，请重试。'));
        return;
      }
      groupReplyAttempt = null;
      if (scope === sendScope()) {
        if (field.value === prompt) field.value = '';
        if (socialHistory?.readingHistory) void openSocialConversation(cid);
        else {
          renderDeliveredSocialMessage(scope, result.body.message);
          scheduleSocialPoll(currentConversation);
        }
        show('ok', '已发送到群聊。', {announceOnly: true});
      }
    } finally {
      groupReplyBusy = false;
      button.textContent = label;
      button.disabled = !document.getElementById('group-agent-choices').querySelector('input:not(:disabled)');
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
    const message = social ? agentMentions.message(field.value) : messagePayload(field.value, chatLanguage);
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
    publicDraft.persist();
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
        const beginReply = () => {
          if (!servedByDsbot || queue.social || queue.replying === job) return;
          queue.replying = job;
          if (isCurrent()) {
            const scroller = document.getElementById('message-scroller');
            const follow = messageScrollerAtBottom(scroller);
            stopPolling();
            renderPendingSend();
            syncReplyProgress();
            if (follow) scroller.scrollTop = scroller.scrollHeight;
          }
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
              publicDraft.move(previous, queue.scope);
              renderAgentQuickStarts(currentAgent);
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
          let result;
          let anchor;
          try {
            if (job.files.length) {
              result = await sendPrivateAttachmentMessage(document.defaultView, path, job.message, job.files,
                {...headers, 'X-CSRF-Token':csrfCookie(document.cookie)}, percent => {
                  feedback(percent < 100 ? `正在上传附件 · ${percent}%` : '附件已上传，正在等待智能体回复…');
                  if (percent >= 100) beginReply();
                });
            } else {
              const response = request('POST', path, job.message, headers);
              beginReply();
              result = await response;
            }
          } finally {
            if (queue.replying === job) {
              if (isCurrent()) {
                const scroller = document.getElementById('message-scroller');
                anchor = {top: scroller.scrollTop, follow: messageScrollerAtBottom(scroller)};
                if (replyWatch?.key === job.key) stopReplyProgress();
              }
              queue.replying = null;
              job.replyView?.bubble.remove();
              job.replyView = null;
            }
          }
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
                if (renderAgentMessages(append(lastAgentItems, result.body.message, reply), {followLatest: false, anchor})) schedulePoll();
              } else void openAgentConversation(queue.agentId, queue.conversationId, {refresh: true});
              const notice = sendNotice(reply);
              show(notice.kind, notice.text, notice);
            }
          }
          if (queue.owner === currentUser?.id) void loadSessions();
        } catch (error) {
          job.failed = true;
          feedback(error instanceof TypeError || !error?.message ? '未能确认发送结果，请重试。' : error.message);
          if (isCurrent() && !queue.social) syncReplyProgress();
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
  const mediaContext = () => {
    const workspace = workspaceId();
    if (!servedByDsbot || !currentUser || !workspace) return null;
    if (currentSource === 'agent' && currentAgent) return {workspace, scope: sendScope()};
    if (currentSource !== 'social' || !currentConversation || currentConversation.public_agent || sendClosed()) return null;
    return {workspace, scope: sendScope(), sendLabel: currentConversation.kind === 'group' ? '发送到群聊' : '发送到会话'};
  };
  const mediaOptions = type => ({
    request, context: mediaContext, key: () => idempotencyKey('chat-' + type + '-'),
    async share(artifact, scope) {
      if (sendScope() !== scope || currentSource !== 'social' || !currentConversation
          || currentConversation.public_agent || sendClosed()) return {status: 409, body: {}};
      const owner = currentUser.id;
      const result = await request('POST', `${socialBase()}/${currentConversation.id}/messages`,
        {artifact_id: artifact, artifact_revision: 1}, {'Idempotency-Key': 'share-' + type + '-' + artifact});
      if ([200, 201].includes(result.status) && currentUser?.id === owner) {
        renderDeliveredSocialMessage(scope, result.body.message);
      }
      return result;
    },
    onOpen() { if (plus) plus.open = false; },
    notify: show,
  });
  const videoCreator = mountVideoCreator(document, mediaOptions('video'));
  const musicCreator = mountMusicCreator(document, mediaOptions('music'));
  const model3dCreator = mountModel3dCreator(document, mediaOptions('model3d'));
  const websiteCreator = mountWebsiteCreator(document, mediaOptions('website'));
  const attachInput = document.getElementById('chat-attachment');
  const defaultAccept = attachInput ? attachInput.getAttribute('accept') || '' : '';
  function syncPlusState() {
    syncMemoryRecall();
    imageCreator.sync();
    videoCreator.sync();
    musicCreator.sync();
    model3dCreator.sync();
    websiteCreator.sync();
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

  globalThis.addEventListener('hashchange', () => {
    clearChatScope();
    return load();
  });
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
