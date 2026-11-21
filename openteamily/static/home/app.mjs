import { meetingCodeFromHash, meetingHref } from '../shell/meeting-link.mjs';
import { publicAgentIntentFromHash, publicAgentContinuation } from '../shell/public-agent-link.mjs';
import { publicWorkIntentFromHash } from '../shell/public-work-link.mjs';
import { teamInviteFromHash, teamInviteHash } from '../shell/team-invite-link.mjs';
import { spaceHref } from '../shell/thumb.mjs';
import { createLookAvatar } from '../look/app.mjs';
import { csrfCookie, signupSessionError, takeSignupSession, waitForRuntime } from './runtime-readiness.mjs';

export const KIND_LABELS = {
  document: '文档', website: '网站', slides: '幻灯片', dashboard: '看板',
  whiteboard: '白板', media: '媒体', image: '图片', audio: '音频', video: '视频',
};

export function kindLabel(kind) {
  return KIND_LABELS[kind] || '作品';
}

export function conversationTitle(item, userId) {
  if (!item) return '对话';
  if (item.source === 'agent') return item.title || item.agent_name || 'AI 对话';
  if (item.kind === 'dm') {
    const other = (item.members || []).find((member) => member.user_id !== userId);
    return (other && other.username) || item.title || '单聊';
  }
  return item.title || '群聊';
}

export function formatWhen(value, now = Date.now() / 1000) {
  const timestamp = Number(value);
  if (!value || !Number.isFinite(timestamp)) return '';
  const seconds = now - timestamp;
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return Math.floor(seconds / 60) + ' 分钟前';
  const date = new Date(timestamp * 1000);
  const current = new Date(now * 1000);
  const sameDay = date.toDateString() === current.toDateString();
  if (sameDay) return new Intl.DateTimeFormat('zh-CN', {hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).format(date);
  const yesterday = new Date(now * 1000 - 86400000);
  if (date.toDateString() === yesterday.toDateString()) return '昨天';
  return new Intl.DateTimeFormat('zh-CN', {year: 'numeric', month: 'numeric', day: 'numeric'}).format(date);
}

export function meetingMeta(item) {
  const actions = Number(item && item.action_count) || 0;
  const done = Number(item && item.done_count) || 0;
  return actions ? `${actions} 个行动项 · ${done} 已完成` : '没有行动项';
}

function hashWorkspace() {
  const hash = (globalThis.location && globalThis.location.hash) || '';
  return new URLSearchParams(hash.replace(/^#/, '')).get('workspace') || '';
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function show(document, kind, text) {
  const signedIn = document.getElementById('main-panel')?.hidden === false;
  const status = document.getElementById(signedIn ? 'home-status' : 'status');
  const other = document.getElementById(signedIn ? 'status' : 'home-status');
  if (other) other.textContent = '';
  if (!status) return;
  status.dataset.kind = kind || '';
  status.textContent = text || '';
}

export function mount(document, {fetcher = globalThis.fetch.bind(globalThis), now = Date.now() / 1000} = {}) {
  const loginPanel = document.getElementById('login-panel');
  const mainPanel = document.getElementById('main-panel');
  const form = document.getElementById('login-form');
  const workspaceSelect = document.getElementById('home-workspace');
  const greeting = document.getElementById('home-greeting');
  if (!loginPanel || !mainPanel || !form || !workspaceSelect) return null;

  const view = document.defaultView ?? globalThis;
  const pendingKey = 'ot-pending-meeting';
  const meetingFromLink = meetingCodeFromHash(view.location?.hash);
  if (meetingFromLink) {
    try { view.sessionStorage.setItem(pendingKey, meetingFromLink); } catch {}
  }
  let currentUser = null;
  let workspaces = [];
  let personal = null;
  let profile = null;
  let selectedId = '';
  let loading = false;
  let overviewVersion = 0;

  async function request(method, path, body) {
    const headers = {Accept: 'application/json'};
    const options = {method, headers, credentials: 'same-origin'};
    if (method !== 'GET') headers['X-CSRF-Token'] = csrfCookie(document.cookie);
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    const response = await fetcher(path, options);
    let payload = {};
    try { payload = await response.json(); } catch { payload = {}; }
    return {status: response.status, body: payload};
  }

  function setHash(workspaceId) {
    if (!globalThis.location || !globalThis.history) return;
    globalThis.history.replaceState(null, '', '#workspace=' + encodeURIComponent(workspaceId));
  }

  function renderPersonal() {
    const agent = personal && personal.agent;
    const section = document.querySelector('.home-personal');
    if (!section) return;
    if (!agent) {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    document.getElementById('home-personal-title').textContent = agent.name;
    document.getElementById('home-personal-summary').textContent = agent.summary || '你的跨场景个人智能体。';
    const avatar = document.getElementById('home-personal-avatar');
    avatar.replaceChildren();
    const lookAvatar = createLookAvatar(personal.look, document);
    if (lookAvatar) avatar.append(lookAvatar);
    else avatar.textContent = (agent.name || 'P').trim().slice(0, 1).toUpperCase();
    renderPersonalContext();
    const workspaceId = personal.workspace && personal.workspace.id;
    const chat = document.getElementById('home-personal-chat');
    const agents = document.getElementById('home-personal-agents');
    if (chat && workspaceId) chat.href = '/chat#workspace=' + encodeURIComponent(workspaceId) + '&agent=' + encodeURIComponent(agent.id);
    if (agents) agents.href = '/agents';
  }

  function renderPersonalContext() {
    const context = document.getElementById('home-context');
    if (!context) return;
    const bits = [profile?.industry, profile?.role].filter(Boolean);
    context.hidden = !bits.length;
    context.textContent = bits.length ? '工作背景：' + bits.join(' · ') : '';
  }

  function renderWorkspaceSelect() {
    workspaceSelect.replaceChildren(...workspaces.map((space) => {
      const option = element('option');
      option.value = space.id;
      option.textContent = space.name;
      return option;
    }));
    workspaceSelect.value = selectedId;
    workspaceSelect.disabled = !workspaces.length;
  }

  function conversationLink(item) {
    if (item.source === 'agent') {
      return '/chat#workspace=' + encodeURIComponent(selectedId) + '&agent=' + encodeURIComponent(item.agent_id)
        + '&conversation=' + encodeURIComponent(item.id);
    }
    return '/chat#workspace=' + encodeURIComponent(selectedId) + '&social=' + encodeURIComponent(item.id);
  }

  function renderConversations(items) {
    const list = document.getElementById('home-conversations');
    const empty = document.getElementById('home-conversations-empty');
    list.replaceChildren(...(items || []).map((item) => {
      const li = element('li');
      const link = element('a', 'home-row');
      link.href = conversationLink(item);
      const title = element('strong', '', conversationTitle(item, currentUser && currentUser.id));
      const agentNote = item.source === 'agent' && item.agent_name ? item.agent_name + ' · ' : '';
      const preview = element('span', 'home-row-note',
        agentNote + (item.preview || (item.source === 'agent' ? 'AI 对话' : '群聊')));
      const when = element('time', 'home-row-time', formatWhen(item.updated, now));
      link.append(title, preview, when);
      if (item.unread_count > 0) {
        const badge = element('span', 'home-unread', String(item.unread_count));
        badge.setAttribute('aria-label', item.unread_count + ' 条未读');
        link.append(badge);
      }
      li.append(link);
      return li;
    }));
    if (empty) empty.hidden = (items || []).length > 0;
  }

  function renderArtifacts(items) {
    const list = document.getElementById('home-artifacts');
    const empty = document.getElementById('home-artifacts-empty');
    list.replaceChildren(...(items || []).map((item) => {
      const li = element('li');
      const link = element('a', 'home-row');
      link.href = spaceHref(selectedId, item && item.id);
      const title = element('strong', '', item.title);
      const meta = element('span', 'home-row-note', kindLabel(item.kind));
      const when = element('time', 'home-row-time', formatWhen(item.updated, now));
      link.append(title, meta, when);
      li.append(link);
      return li;
    }));
    if (empty) empty.hidden = (items || []).length > 0;
  }

  function renderMeetings(items) {
    const list = document.getElementById('home-meetings');
    const empty = document.getElementById('home-meetings-empty');
    list.replaceChildren(...(items || []).map((item) => {
      const li = element('li');
      const link = element('a', 'home-row');
      link.href = '/meetings';
      const title = element('strong', '', item.title);
      const meta = element('span', 'home-row-note', meetingMeta(item));
      const when = element('time', 'home-row-time', formatWhen(item.started_at, now));
      link.append(title, meta, when);
      li.append(link);
      return li;
    }));
    if (empty) empty.hidden = (items || []).length > 0;
  }

  function renderStats(counts) {
    const holder = document.getElementById('home-stats');
    if (!holder) return;
    const entries = [
      ['智能体', counts && counts.agents, '/agents'],
      ['作品', counts && counts.artifacts, '/space'],
      ['会议', counts && counts.meetings, '/meetings'],
      ['自动化', counts && counts.automations, '/automations'],
    ];
    holder.replaceChildren(...entries.map(([label, value, href]) => {
      const link = element('a', 'home-stat');
      link.href = href;
      link.append(element('strong', '', String(Number(value) || 0)), element('span', '', label));
      return link;
    }));
    holder.hidden = !counts;
  }

  async function loadOverview() {
    if (!selectedId) return;
    const version = ++overviewVersion;
    const result = await request('GET', `/v1/workspaces/${selectedId}/overview?limit=5`).catch(() => ({status: 0, body: {}}));
    if (version !== overviewVersion) return;
    if (result.status !== 200) {
      show(document, 'error', (result.body.error && result.body.error.message) || '无法加载首页摘要。');
      return;
    }
    renderConversations(result.body.recent_conversations || []);
    renderArtifacts(result.body.recent_artifacts || []);
    renderMeetings(result.body.recent_meetings || []);
    renderStats(result.body.counts || null);
    const quickChat = document.querySelector('.home-actions a[href="/chat"]');
    if (quickChat) quickChat.href = '/chat#workspace=' + encodeURIComponent(selectedId);
    const spaceLinks = document.querySelectorAll('a[href^="/space"]');
    for (const link of spaceLinks) {
      if (link.classList.contains('home-row')) continue;
      link.href = spaceHref(selectedId);
    }
    const notifications = document.getElementById('home-notifications');
    const unread = Number(result.body.unread_notifications) || 0;
    if (notifications) {
      notifications.hidden = unread === 0;
      notifications.textContent = `有 ${unread} 条未读通知，打开聊天查看`;
    }
    show(document, '', '');
  }

  async function continuePublicActivity({target, backPath, loadingText, errorText, retryId}) {
    const hash = view.location.hash;
    const stillCurrent = () => view.location.pathname === '/login' && view.location.hash === hash;
    loginPanel.hidden = true;
    mainPanel.hidden = true;
    show(document, 'loading', loadingText);
    try {
      const personal = await initializePersonalAgent();
      if (!stillCurrent() || !personal) return;
      const ready = await request('GET', '/v1/workspaces?scope=personal');
      if (!stillCurrent()) return;
      if (ready.status === 200 && ready.body?.items?.length) {
        view.location.replace(target);
        return;
      }
    } catch {}
    if (!stillCurrent()) return;
    show(document, 'error', errorText);
    const status = document.getElementById('status');
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.id = retryId;
    retry.className = 'public-agent-action';
    retry.textContent = '重试';
    retry.addEventListener('click', () => void load());
    const back = document.createElement('a');
    back.href = backPath;
    back.className = 'public-agent-action';
    back.textContent = '返回公开页面';
    status.append(retry, back);
  }

  async function initializePersonalAgent() {
    const result = await request('POST', '/v1/personal-agent').catch(() => null);
    const agent = result?.body?.personal_agent;
    const provisioning = agent?.runtime_provisioning;
    if (agent && (!provisioning || ['ready', 'unmanaged'].includes(provisioning.readiness))) return agent;

    loginPanel.hidden = true;
    mainPanel.hidden = true;
    let state;
    if (provisioning?.readiness === 'starting') {
      show(document, 'loading', '正在启动你的专属智能体。就绪后会自动继续。');
      state = await waitForRuntime(() => request('GET', '/v1/auth/runtime-readiness'));
      if (state === 'ready' || state === 'unmanaged') return agent;
      if (state === 'signed-out') {
        view.location.replace('/login' + view.location.hash);
        return null;
      }
    }
    const message = provisioning?.state === 'capacity'
      ? '当前运行容量已满，请稍后重试。'
      : state === 'timeout' ? '你的专属智能体仍在启动，请稍后再试。'
        : '暂时无法打开你的工作区，请重试。';
    show(document, 'error', message);
    const retry = element('button', 'public-agent-action', '重试');
    retry.type = 'button';
    retry.id = 'runtime-startup-retry';
    retry.addEventListener('click', () => void load());
    document.getElementById('status')?.append(retry);
    return null;
  }

  async function load() {
    if (loading) return;
    loading = true;
    try {
      const session = await request('GET', '/v1/auth/session').catch(() => ({status: 0, body: {}}));
      const expectedSignup = [200, 401].includes(session.status) ? takeSignupSession(view) : null;
      const unconfirmedSignup = expectedSignup && session.body.user?.id !== expectedSignup;
      if (session.status === 401 || unconfirmedSignup) {
        currentUser = null;
        loginPanel.hidden = false;
        mainPanel.hidden = true;
        const hash = view.location?.pathname === '/login' ? view.location.hash : '';
        const intent = publicAgentIntentFromHash(hash);
        const work = publicWorkIntentFromHash(hash);
        const continuation = teamInviteHash(teamInviteFromHash(hash)) ||
          (intent ? publicAgentContinuation(intent) : work?.continuation);
        const register = loginPanel.querySelector?.('.login-register-button');
        if (register && continuation) register.href = '/register' + continuation;
        show(document, unconfirmedSignup ? 'error' : '', unconfirmedSignup ? signupSessionError : '');
        return;
      }
      if (session.status !== 200 || !session.body.user) {
        show(document, 'error', (session.body.error && session.body.error.message) || '无法读取会话。');
        return;
      }
      let meeting = meetingFromLink;
      try {
        meeting ||= view.sessionStorage.getItem(pendingKey);
      } catch {}
      const target = meetingHref(meeting);
      if (target) {
        if (!await initializePersonalAgent()) return;
        try { view.sessionStorage.removeItem(pendingKey); } catch {}
        view.location.replace(target);
        return;
      }
      try { view.sessionStorage.removeItem(pendingKey); } catch {}
      if (view.location?.pathname === '/login') {
        const hash = view.location.hash;
        const invite = teamInviteFromHash(hash);
        const intent = publicAgentIntentFromHash(hash);
        const work = publicWorkIntentFromHash(hash);
        if (invite) {
          if (await initializePersonalAgent() && view.location.hash === hash) {
            view.location.replace('/members' + teamInviteHash(invite));
          }
        } else if (intent) {
          await continuePublicActivity({
            target: '/chat' + publicAgentContinuation(intent), backPath: '/a/' + intent.slug,
            loadingText: '正在打开公开智能体…', errorText: '聊天尚未准备好。', retryId: 'public-agent-login-retry',
          });
        } else if (work) {
          await continuePublicActivity({
            target: work.target, backPath: '/w/' + work.slug,
            loadingText: work.panel === 'comments' ? '正在打开作品评论…' : '正在打开作品…',
            errorText: '暂时无法打开作品。', retryId: 'public-work-login-retry',
          });
        } else {
          view.location.replace('/');
        }
        return;
      }
      currentUser = session.body.user;
      loginPanel.hidden = true;
      personal = await initializePersonalAgent();
      if (!personal) return;
      greeting.textContent = `欢迎回来，${currentUser.username}`;
      workspaceSelect.disabled = true;
      const banner = document.getElementById('home-onboarding');
      if (banner) banner.hidden = true;
      profile = null;
      // The authenticated personal binding is already usable. Optional dashboard
      // and onboarding reads no longer hold back opening the first chat.
      renderPersonal();
      mainPanel.hidden = false;
      show(document, '', '');
      const activeUser = currentUser;
      void request('GET', '/v1/onboarding').then(onboarding => {
        if (currentUser !== activeUser || onboarding.status !== 200) return;
        profile = onboarding.body.onboarding;
        if (banner) banner.hidden = Boolean(profile?.completed);
        renderPersonalContext();
      }).catch(() => {});
      const listed = await request('GET', '/v1/workspaces?limit=100').catch(() => ({status: 0, body: {}}));
      if (currentUser !== activeUser) return;
      if (listed.status !== 200) {
        show(document, 'error', '暂时无法加载工作区列表。');
        return;
      }
      workspaces = listed.body.items || [];
      if (!workspaces.length) {
        show(document, '', '还没有工作区。先创建一个团队或工作区。');
        return;
      }
      const wanted = hashWorkspace();
      selectedId = workspaces.some((space) => space.id === wanted)
        ? wanted
        : (personal && personal.workspace ? personal.workspace.id : workspaces[0].id);
      if (!workspaces.some((space) => space.id === selectedId)) selectedId = workspaces[0].id;
      renderWorkspaceSelect();
      setHash(selectedId);
      await loadOverview();
    } finally {
      loading = false;
    }
  }

  workspaceSelect.addEventListener('change', async () => {
    selectedId = workspaceSelect.value;
    setHash(selectedId);
    await loadOverview();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const result = await request('POST', '/v1/auth/login', {
      username: form.elements.username.value,
      password: form.elements.password.value,
    });
    if (result.status !== 200) {
      show(document, 'error', result.status === 401 ? '用户名或密码不正确。'
        : (result.body.error && result.body.error.message) || '无法登录。');
      return;
    }
    form.reset();
    await load();
  });

  const logout = document.getElementById('logout-form');
  if (logout) logout.addEventListener('submit', async (event) => {
    event.preventDefault();
    const result = await request('POST', '/v1/auth/logout', {});
    if (result.status !== 200) return;
    currentUser = null;
    overviewVersion++;
    // A slow dashboard read may still be in flight after the page is usable.
    view.location.replace('/');
  });

  load();
  return {load, loadOverview};
}

if (typeof document !== 'undefined') {
  const start = () => mount(document);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
}
