import { readWorkspaceChoices } from '../shell/dsbot-api.mjs';
import { mountWorkspaceEvents } from '../shell/workspace-events.mjs';
// Authorized saved-result links select a real workspace and fetch the actual editor record.
export function artifactTargetFromSearch(search) {
  const params=new URLSearchParams(search||'');
  if(!params.has('workspace')&&!params.has('artifact'))return null;
  const workspace=params.get('workspace'),artifact=params.get('artifact');
  if([...params.keys()].some(key=>!['workspace','artifact'].includes(key))||params.getAll('workspace').length!==1||params.getAll('artifact').length!==1||!(/^[0-9a-f]{32}$/).test(workspace||'')||!(/^[0-9a-f]{32}$/).test(artifact||''))return {invalid:true};
  return {workspace,artifact};
}

import { bindDocumentEditor } from '../shell/rich-editor.mjs';
import { mountSpreadsheet } from './spreadsheet.mjs';
import {
  renderThumb,
  websiteTitle, websiteStub, websitePrompt, saveableSocialMessage, saveableAgentMessage,
  socialSavePath, agentSavePath, defaultSaveTitle, describeWebsiteDispatch, conversationChatHref,
} from '../shell/thumb.mjs';

// `/space?new=<kind>` opens the matching 新建 editor once the page has loaded
// (used by the chat composer's 创建 grid). Unknown values are ignored.
const NEW_KIND_BUTTONS = {document: 'new-artifact', website: 'new-website', slides: 'new-slides', dashboard: 'new-dashboard', spreadsheet: 'new-spreadsheet', whiteboard: 'new-board'};
export function newKindFromSearch(search) {
  const value = new URLSearchParams(search || '').get('new') || '';
  return Object.prototype.hasOwnProperty.call(NEW_KIND_BUTTONS, value) ? value : '';
}
export function newKindButtonId(kind) {
  return NEW_KIND_BUTTONS[kind] || '';
}

export function csrfCookie(raw) {
  const parts = String(raw || '').split(';');
  for (const part of parts) {
    const [name, ...rest] = part.trim().split('=');
    if (name === '__Host-ot_csrf' || name === 'ot_dev_csrf') return rest.join('=');
  }
  return '';
}

export function listQuery(search) {
  const needle = (search || '').trim();
  return needle ? ('?q=' + encodeURIComponent(needle)) : '';
}

export const FILE_TYPE_LABELS = ['云文档', 'Markdown', 'DOCX', 'PDF', '电子表格', '幻灯片',
  'Web 应用', '网页', '图片', '视频', '音频', '白板', '消息'];

export function artifactMatchesType(item, type) {
  const mime = String((item && item.media && item.media.mime) || '');
  if (type === '云文档') return item.kind === 'document' && !(item.source && item.source.kind === 'agent_message');
  if (type === '网页') return item.kind === 'website';
  if (type === '图片') return item.kind === 'media' && mime.startsWith('image/');
  if (type === '视频') return item.kind === 'media' && mime.startsWith('video/');
  if (type === '音频') return item.kind === 'media' && mime.startsWith('audio/');
  if (type === '白板') return item.kind === 'whiteboard';
  if (type === '电子表格') return item.kind === 'spreadsheet';
  if (type === '幻灯片') return item.kind === 'slides';
  if (type === '消息') return !!(item.source && item.source.kind === 'agent_message');
  return false;
}

export function artifactMatchesModified(item, window, now = Date.now()) {
  if (!window || window === 'any' || window === 'custom') return true;
  const updated = Number(item && item.updated ? item.updated : 0) * 1000;
  if (!updated) return false;
  const day = 24 * 60 * 60 * 1000;
  if (window === 'today') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return updated >= start.getTime();
  }
  const days = {d7: 7, d30: 30, d90: 90};
  if (days[window]) return updated >= now - days[window] * day;
  return true;
}

export function visibleArtifacts(items, options = {}) {
  const kind = options.kind || 'all';
  const scope = options.scope || 'all';
  const username = options.username || '';
  const types = options.types || [];
  const modified = options.modified || 'any';
  const creators = options.creators || [];
  const sessions = options.sessions || [];
  const now = options.now == null ? Date.now() : options.now;
  if (kind === 'meetings') return [];
  let rows = [...(items || [])];
  if (scope === 'favorites') rows = rows.filter(item => item.favorited);
  if (scope === 'mine' && username) {
    rows = rows.filter((item) => item.created_by === username);
  }
  if (scope === 'memory') {
    rows = rows.filter((item) => item.source && item.source.kind === 'agent_task');
  }
  if (kind === 'messages') {
    rows = rows.filter((item) => item.source && item.source.kind === 'agent_message');
  } else if (kind && kind !== 'all') {
    rows = rows.filter((item) => item.kind === kind);
  }
  if (types.length) {
    rows = rows.filter((item) => types.some((type) => artifactMatchesType(item, type)));
  }
  rows = rows.filter((item) => artifactMatchesModified(item, modified, now));
  if (creators.length) rows = rows.filter((item) => creators.includes(item.created_by));
  if (sessions.length) {
    rows = rows.filter((item) => item.source && sessions.includes(item.source.conversation_id));
  }
  return rows;
}

export function meetingActionLabel(count, done) {
  const total = Number(count) || 0;
  const finished = Number(done) || 0;
  if (total <= 0) return '尚无行动项';
  if (finished >= total) return `${total} 项行动项，全部完成`;
  if (finished > 0) return `${total} 项行动项，${finished} 项已完成`;
  return `${total} 项行动项`;
}

export function meetingTimeLabel(epochSeconds) {
  const ms = Number(epochSeconds) * 1000;
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Meetings come from GET /v1/workspaces/<wid>/meetings; the page only lists them, newest first. */
export function meetingRows(items) {
  const rows = (items || []).filter((item) => item && typeof item.title === 'string');
  rows.sort((left, right) => (Number(right.started_at) || 0) - (Number(left.started_at) || 0));
  return rows.map((item) => ({
    id: item.id,
    title: item.title,
    started_at: Number(item.started_at) || 0,
    actionLabel: meetingActionLabel(item.action_count, item.done_count),
  }));
}

export function meetingsForScope(items, {scope = 'all', username = '', userId = ''} = {}) {
  const rows = Array.isArray(items) ? items : [];
  if (scope !== 'joined') return rows;
  const name = (username || '').trim().toLowerCase();
  return rows.filter((row) => {
    // The single-owner DS-Bot uses this marker when its platform user ID is unavailable.
    if (userId && (row.created_by === userId || row.created_by === 'owner')) return true;
    const attendees = Array.isArray(row.attendees) ? row.attendees : [];
    return Boolean(name) && attendees.some((item) => String(item).trim().toLowerCase() === name);
  });
}


export function sessionFilterChoices(items) {
  const sessions = [];
  const seen = new Set();
  for (const item of items || []) {
    const id = item.source && item.source.conversation_id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const title = String((item.source && item.source.conversation_title) || '').trim();
    sessions.push({id, label: title || '对话'});
  }
  sessions.sort((left, right) => (left.label < right.label ? -1 : left.label > right.label ? 1 : left.id.localeCompare(right.id)));
  return sessions;
}

export function viewFromSearch(search) {
  const value = new URLSearchParams(search || '').get('view');
  if (value === 'created') return {kind: 'all', scope: 'mine'};
  if (value === 'starred') return {kind: 'all', scope: 'favorites'};
  if (value === 'memory') return {kind: 'all', scope: 'memory'};
  if (value === 'meetings') return {kind: 'meetings', scope: 'all'};
  return {kind: 'all', scope: 'all'};
}

export function queryForView(kind, scope) {
  if (kind === 'meetings') return '?view=meetings';
  if (scope === 'mine') return '?view=created';
  if (scope === 'favorites') return '?view=starred';
  if (scope === 'memory') return '?view=memory';
  return '';
}

export function artifactDeletePrompt(artifact) {
  const title = artifact && typeof artifact.title === 'string' ? artifact.title.trim() : '';
  return {
    question: title ? `删除「${title}」？` : '删除这个作品？',
    detail: '删除后不能恢复。',
    cancelLabel: '取消',
    confirmLabel: '确认',
  };
}

export function savableTaskArtifacts(tasks) {
  return (Array.isArray(tasks) ? tasks : []).filter((task) => {
    const result = task && task.result;
    const text = result && (typeof result.text === 'string' ? result.text : result.echo);
    return Boolean(task) && task.status === 'succeeded' && typeof text === 'string' && text.trim() !== '';
  });
}

export function taskArtifactTitle(task) {
  const prompt = task && typeof task.prompt === 'string' ? task.prompt.trim() : '';
  return prompt || '任务结果';
}

export function taskArtifactError(status, body, fallback = '保存失败。') {
  if (status === 401) return '登录后才能把任务成果保存到作品库。';
  if (status === 403) return '没有权限把这条任务成果保存到这个工作区。';
  const message = body && body.error && body.error.message;
  return typeof message === 'string' && message ? message : fallback;
}

export function applyDirectoryCollapsed(root, collapsed) {
  const next = Boolean(collapsed);
  const dir = root.getElementById('artifact-dir');
  const workspace = root.getElementById('list-panel');
  const collapse = root.getElementById('dir-collapse');
  const expand = root.getElementById('dir-expand');
  if (workspace) workspace.classList.toggle('dir-collapsed', next);
  if (dir) dir.hidden = next;
  if (collapse) collapse.setAttribute('aria-expanded', next ? 'false' : 'true');
  if (expand) expand.hidden = !next;
  return next;
}

function messageFor(error, fallback) {
  if (error && error.message) return error.message;
  return fallback;
}

function idempotencyKey() {
  const bytes = new Uint8Array(18);
  globalThis.crypto.getRandomValues(bytes);
  let text = '';
  for (const value of bytes) text += String.fromCharCode(value);
  return globalThis.btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function suggestedDiscoverSlug(title) {
  const slug = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/g, '');
  return /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(slug) ? slug : '';
}

export function kindBadge(kind) {
  return ({document: 'DOC', website: 'WEB', slides: 'PPT', dashboard: 'DASH', spreadsheet: 'XLSX', whiteboard: 'BOARD', media: 'MEDIA', image: 'IMG', audio: 'AUDIO', video: 'VIDEO'}[kind] || 'FILE');
}

export function artifactTime(seconds, now = Date.now()) {
  if (!seconds) return '';
  const when = new Date(Number(seconds) * 1000);
  if (Number.isNaN(when.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  const today = new Date(now);
  const sameDay = when.toDateString() === today.toDateString();
  return sameDay ? `今天 ${pad(when.getHours())}:${pad(when.getMinutes())}`
    : `${when.getMonth() + 1}月${when.getDate()}日 ${pad(when.getHours())}:${pad(when.getMinutes())}`;
}

export function applyArtifactLayout(list, layout) {
  list.dataset.layout = layout === 'list' ? 'list' : 'grid';
  return list.dataset.layout;
}

export function canSendArtifactToChat(item) {
  return Boolean(item && item.id && ['media','document','website','whiteboard','slides','dashboard','spreadsheet'].includes(item.kind));
}

export function conversationLabel(item) {
  if (!item) return '未命名会话';
  const title = (item.title || '').trim();
  if (title) return title;
  const names = (item.members || []).map(row => row.username).filter(Boolean);
  if (names.length) return names.join('、');
  return item.kind === 'dm' ? '单聊' : '群聊';
}

export function mount(document, {fetcher = globalThis.fetch.bind(globalThis)} = {}) {
  const status = document.getElementById('status');
  const loginPanel = document.getElementById('login-panel');
  const mainPanel = document.getElementById('main-panel');
  const form = document.getElementById('editor-form');
  const listPanel = document.getElementById('list-panel');
  const workspaceSelect = document.getElementById('workspace');
  const search = document.getElementById('search');
  let currentUser = null;
  let workspaceLoad = 0;
  let current = null;
  let draftKind = 'document';
  let catalogKind = 'all';
  let catalogScope = 'all';
  let catalogLayout = 'grid';
  let meetingScope = 'all';
  let filterTypes = [];
  let filterModified = 'any';
  let filterCreators = [];
  let filterSessions = [];
  let allItems = [];
  let meetingItems = [];
  let meetingError = '';
  let meetingLoadedFor = '';
  let meetingLoading = false;
  let meetingRequest = 0;
  // A delete question is bound to the workspace and artifact it was asked about;
  // leaving that workspace retires it instead of letting the answer land elsewhere.
  let pendingDeleteCancel = null;

  function show(kind, text) {
    status.dataset.kind = kind;
    status.textContent = text;
  }

  async function request(method, path, body, extraHeaders, signal) {
    const headers = {'Accept': 'application/json', 'X-CSRF-Token': csrfCookie(document.cookie)};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (extraHeaders) Object.assign(headers, extraHeaders);
    const response = await fetcher(path, {
      method, headers, credentials: 'same-origin', signal,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let parsed = {};
    try { parsed = await response.json(); } catch { parsed = {}; }
    return {status: response.status, body: parsed};
  }

  function workspaceId() {
    return workspaceSelect.value;
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

  function kindLabel(kind) {
    if (kind === 'website') return '网站';
    if (kind === 'media') return '媒体';
    if (kind === 'whiteboard') return '白板';
    if (kind === 'slides') return '幻灯片';
    if (kind === 'dashboard') return '看板';
    if (kind === 'spreadsheet') return '电子表格';
    return '文档';
  }

  function strokeId() {
    const bytes = new Uint8Array(12);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('').slice(0, 16);
  }

  let boardState = {schema: 'openteamily.whiteboard.v1', width: 800, height: 600, strokes: []};
  let boardTool = 'path';
  let drawing = null;

  function drawBoard() {
    const canvas = document.getElementById('board-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (const stroke of boardState.strokes) {
      ctx.strokeStyle = stroke.color;
      ctx.fillStyle = stroke.color;
      if (stroke.type === 'path' && stroke.points && stroke.points.length) {
        ctx.lineWidth = stroke.width || 2;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(stroke.points[0][0], stroke.points[0][1]);
        for (let i = 1; i < stroke.points.length; i += 1) ctx.lineTo(stroke.points[i][0], stroke.points[i][1]);
        ctx.stroke();
      } else if (stroke.type === 'rect') {
        ctx.lineWidth = 2;
        ctx.strokeRect(stroke.x, stroke.y, stroke.width, stroke.height);
      } else if (stroke.type === 'ellipse') {
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(stroke.x + stroke.width / 2, stroke.y + stroke.height / 2, Math.abs(stroke.width / 2), Math.abs(stroke.height / 2), 0, 0, Math.PI * 2);
        ctx.stroke();
      } else if (stroke.type === 'text') {
        ctx.font = (stroke.size || 16) + 'px system-ui,sans-serif';
        ctx.fillText(stroke.text, stroke.x, stroke.y);
      }
    }
  }

  function canvasPoint(event) {
    const canvas = document.getElementById('board-canvas');
    const box = canvas.getBoundingClientRect();
    const x = (event.clientX - box.left) * (canvas.width / box.width);
    const y = (event.clientY - box.top) * (canvas.height / box.height);
    return [Math.max(0, Math.min(800, x)), Math.max(0, Math.min(600, y))];
  }

  let slidesState = {schema: 'openteamily.slides.v1', slides: []};
  let slideEditCount = 0;
  let pendingSlideDraft = null;
  const slideDraft = document.getElementById('slide-draft');
  const slidePrompt = document.getElementById('slide-prompt');
  const slideDraftStatus = document.getElementById('slide-draft-status');
  const slideDraftSubmit = document.getElementById('slide-draft-submit');
  const slideContext = document.getElementById('slide-context');
  const slideContextOption = document.getElementById('slide-context-option');
  const slideContextTitle = document.getElementById('slide-context-title');
  const sendSlides = document.getElementById('send-saved-slides');
  const downloadSlides = document.getElementById('download-slides');

  function slidesDeck() {
    return {
      schema: 'openteamily.slides.v1',
      slides: slidesState.slides.map(slide => ({
        title: String(slide.title || '').trim(),
        bullets: (slide.bullets || []).map(value => String(value).trim()).filter(Boolean),
      })),
    };
  }

  function renderSlidesEditor(focusIndex) {
    const list = document.getElementById('slide-list');
    if (!list) return;
    let focusTarget;
    list.replaceChildren();
    slidesState.slides.forEach((slide, index) => {
      const li = document.createElement('li');
      li.className = 'slide-card';
      const head = document.createElement('div');
      head.className = 'slide-head';
      const label = document.createElement('span');
      label.className = 'slide-index';
      label.textContent = '第 ' + (index + 1) + ' 页';
      const actions = document.createElement('div');
      actions.className = 'slide-card-actions';
      for (const [offset, text, name] of [[-1, '↑', '上移'], [1, '↓', '下移']]) {
        const move = document.createElement('button');
        const to = index + offset;
        move.type = 'button';
        move.textContent = text;
        move.setAttribute('aria-label', name + label.textContent);
        move.disabled = to < 0 || to >= slidesState.slides.length;
        move.addEventListener('click', () => {
          slidesState.slides[index] = slidesState.slides[to];
          slidesState.slides[to] = slide;
          slideEditCount++;
          renderSlidesEditor(to);
        });
        actions.append(move);
      }
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '删除';
      remove.setAttribute('aria-label', '删除' + label.textContent);
      remove.addEventListener('click', () => {
        slidesState.slides.splice(index, 1);
        slideEditCount++;
        renderSlidesEditor(Math.min(index, slidesState.slides.length - 1));
      });
      actions.append(remove);
      head.append(label, actions);
      const title = document.createElement('input');
      title.type = 'text';
      title.maxLength = 120;
      title.placeholder = '页标题';
      title.setAttribute('aria-label', label.textContent + '标题');
      title.value = slide.title || '';
      title.addEventListener('input', () => {
        slide.title = title.value;
        slideEditCount++;
      });
      const bullets = document.createElement('textarea');
      bullets.rows = 4;
      bullets.maxLength = 4000;
      bullets.placeholder = '每行一条要点（最多 10 条）';
      bullets.setAttribute('aria-label', label.textContent + '要点');
      bullets.value = (slide.bullets || []).join('\n');
      bullets.addEventListener('input', () => {
        slide.bullets = bullets.value.split('\n');
        slideEditCount++;
      });
      li.append(head, title, bullets);
      list.append(li);
      if (index === focusIndex) focusTarget = title;
    });
    const count = document.getElementById('slides-count');
    if (count) count.textContent = slidesState.slides.length + ' / 30 页';
    const add = document.getElementById('add-slide');
    if (add) add.disabled = slidesState.slides.length >= 30;
    if (focusIndex !== undefined) (focusTarget || add)?.focus();
  }

  if (slideDraftSubmit && slidePrompt && slideDraftStatus) {
    form.elements.title.addEventListener?.('input', () => {
      if (current?.kind === 'slides') slideEditCount++;
    });
    slideDraftSubmit.addEventListener('click', async () => {
      const prompt = slidePrompt.value.trim();
      if (pendingSlideDraft || current?.kind !== 'slides' || current.id || !workspaceId()) return;
      if (!prompt) {
        slideDraftStatus.textContent = '请填写幻灯片主题或素材。';
        slidePrompt.focus();
        return;
      }
      if (slidesDeck().slides.some(slide => slide.title || slide.bullets.length)) {
        slideDraftStatus.textContent = '已有幻灯片内容。请新建一份空白幻灯片后起草。';
        return;
      }
      const artifact = current;
      const wid = workspaceId();
      const edits = slideEditCount;
      const token = pendingSlideDraft = {};
      const active = () => pendingSlideDraft === token && !form.hidden && current === artifact && workspaceId() === wid;
      const origin = artifactSendOrigin;
      const body = {prompt};
      if (slideContext?.checked && origin?.allowed && origin.item === artifact && origin.wid === wid) {
        body.conversation_id = origin.conversation;
      }
      slideDraftSubmit.disabled = true;
      slideDraftSubmit.textContent = '正在生成…';
      slideDraftStatus.textContent = '智能体正在起草幻灯片。';
      try {
        const result = await request('POST', `/v1/workspaces/${wid}/artifacts/slides/draft`, body);
        if (!active()) return;
        if (slideEditCount !== edits || form.inert) {
          slideDraftStatus.textContent = '已保留你的编辑。需要起草时请重新生成。';
          return;
        }
        if (result.status !== 200 || !result.body.slides?.slides?.length) {
          slideDraftStatus.textContent = messageFor(result.body.error, '无法生成幻灯片草稿，请重试。');
          return;
        }
        slidesState = result.body.slides;
        if (!form.elements.title.value.trim()) form.elements.title.value = result.body.title || '';
        slideDraft.open = false;
        slideDraft.querySelector?.('summary')?.focus();
        renderSlidesEditor();
        slideDraftStatus.textContent = '草稿已生成。可编辑后保存。';
      } catch {
        if (active()) slideDraftStatus.textContent = '无法生成幻灯片草稿，请重试。';
      } finally {
        if (pendingSlideDraft === token) {
          pendingSlideDraft = null;
          slideDraftSubmit.disabled = false;
          slideDraftSubmit.textContent = '生成草稿';
        }
      }
    });
  }

  let dashboardState = {schema: 'openteamily.dashboard.v1', widgets: []};

  function widgetDefault(type) {
    if (type === 'table') return {type: 'table', title: '', columns: ['列 1', '列 2'], rows: [['', '']]};
    if (type === 'bar') return {type: 'bar', title: '', labels: ['A'], values: [0]};
    return {type: 'metric', title: '', value: '', note: ''};
  }

  function splitList(text) {
    return String(text || '').split(',').map(value => value.trim()).filter(Boolean);
  }

  function parseRows(text, width) {
    return String(text || '').split('\n').map(line => line.split('|').map(cell => cell.trim()))
      .filter(row => row.some(Boolean));
  }

  function dashboardValue() {
    return {
      schema: 'openteamily.dashboard.v1',
      widgets: dashboardState.widgets.map(widget => {
        if (widget.type === 'metric') {
          return {type: 'metric', title: widget.title || '', value: widget.value || '', note: widget.note || ''};
        }
        if (widget.type === 'table') {
          return {type: 'table', title: widget.title || '', columns: widget.columns || [], rows: widget.rows || []};
        }
        return {type: 'bar', title: widget.title || '', labels: widget.labels || [], values: widget.values || []};
      }),
    };
  }

  function renderDashboardEditor() {
    const list = document.getElementById('widget-list');
    if (!list) return;
    list.replaceChildren();
    dashboardState.widgets.forEach((widget, index) => {
      const li = document.createElement('li');
      li.className = 'slide-card';
      const head = document.createElement('div');
      head.className = 'slide-head';
      const types = document.createElement('select');
      for (const value of ['metric', 'table', 'bar']) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value === 'metric' ? '指标' : (value === 'table' ? '表格' : '条形图');
        if (widget.type === value) option.selected = true;
        types.append(option);
      }
      types.addEventListener('change', () => {
        dashboardState.widgets[index] = widgetDefault(types.value);
        renderDashboardEditor();
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '删除';
      remove.addEventListener('click', () => {
        dashboardState.widgets.splice(index, 1);
        renderDashboardEditor();
      });
      head.append(types, remove);
      const title = document.createElement('input');
      title.type = 'text';
      title.maxLength = 120;
      title.placeholder = '组件标题';
      title.value = widget.title || '';
      title.addEventListener('input', () => { widget.title = title.value; });
      li.append(head, title);
      if (widget.type === 'metric') {
        const value = document.createElement('input');
        value.type = 'text';
        value.maxLength = 120;
        value.placeholder = '指标值，例如 2400 元';
        value.value = widget.value || '';
        value.addEventListener('input', () => { widget.value = value.value; });
        const note = document.createElement('input');
        note.type = 'text';
        note.maxLength = 200;
        note.placeholder = '备注（可选）';
        note.value = widget.note || '';
        note.addEventListener('input', () => { widget.note = note.value; });
        li.append(value, note);
      } else if (widget.type === 'table') {
        const columns = document.createElement('input');
        columns.type = 'text';
        columns.placeholder = '列名，用逗号分隔';
        columns.value = (widget.columns || []).join(', ');
        columns.addEventListener('input', () => { widget.columns = splitList(columns.value); });
        const rows = document.createElement('textarea');
        rows.rows = 4;
        rows.placeholder = '每行一条，单元格用 | 分隔';
        rows.value = (widget.rows || []).map(row => row.join(' | ')).join('\n');
        rows.addEventListener('input', () => { widget.rows = parseRows(rows.value); });
        li.append(columns, rows);
      } else {
        const labels = document.createElement('input');
        labels.type = 'text';
        labels.placeholder = '标签，用逗号分隔';
        labels.value = (widget.labels || []).join(', ');
        labels.addEventListener('input', () => { widget.labels = splitList(labels.value); });
        const values = document.createElement('input');
        values.type = 'text';
        values.placeholder = '数值，用逗号分隔';
        values.value = (widget.values || []).join(', ');
        values.addEventListener('input', () => {
          widget.values = splitList(values.value).map(value => {
            const number = Number(value);
            return Number.isFinite(number) ? number : 0;
          });
        });
        li.append(labels, values);
      }
      list.append(li);
    });
    const add = document.getElementById('add-widget');
    if (add) add.disabled = dashboardState.widgets.length >= 20;
  }

  const richDocument = bindDocumentEditor(document, form);
  const spreadsheet = mountSpreadsheet(document, {
    async onDraft(prompt) {
      const result = await request('POST', `/v1/workspaces/${workspaceId()}/artifacts/spreadsheet/draft`, {prompt});
      if (result.status !== 200 || !result.body.spreadsheet) {
        throw new Error(messageFor(result.body.error, '无法生成表格草稿。'));
      }
      return result.body;
    },
    onTitle(title) {
      if (!form.elements.title.value.trim()) form.elements.title.value = title;
    },
  });
  const sendSpreadsheet = document.getElementById('send-saved-spreadsheet');
  const downloadSpreadsheet = document.getElementById('download-spreadsheet');

  function fillEditor(item) {
    form.elements.title.value = item && item.title ? item.title : '';
    form.elements.body.value = item && typeof item.body === 'string' ? item.body : '';
    const kind = (item && item.kind) || draftKind;
    richDocument.load(form.elements.body.value, kind === 'document');
    const meta = document.getElementById('editor-meta');
    const labels = {website: '新网站', media: '新媒体', whiteboard: '新白板', slides: '新幻灯片', dashboard: '新看板', spreadsheet: '新电子表格', document: '新文档'};
    if (item && item.id) {
      meta.textContent = `${kindLabel(kind)} · 修订 ${item.revision} · 作者 ${item.created_by || ''}`;
    } else {
      meta.textContent = labels[kind] || '新文档';
    }
    document.getElementById('body-label').hidden = kind !== 'website';
    document.getElementById('media-editor').hidden = kind !== 'media';
    document.getElementById('board-editor').hidden = kind !== 'whiteboard';
    document.getElementById('slides-editor').hidden = kind !== 'slides';
    document.getElementById('dashboard-editor').hidden = kind !== 'dashboard';
    const spreadsheetEditor = document.getElementById('spreadsheet-editor');
    if (spreadsheetEditor) spreadsheetEditor.hidden = kind !== 'spreadsheet';
    for (const button of [sendSpreadsheet, downloadSpreadsheet]) {
      if (button) button.hidden = kind !== 'spreadsheet' || !item?.id;
    }
    if (kind === 'spreadsheet') spreadsheet.load(item?.spreadsheet, item?.id, !item?.id);
    for (const button of [sendSlides, downloadSlides]) {
      if (button) button.hidden = kind !== 'slides' || !item?.id;
    }
    pendingSlideDraft = null;
    if (kind === 'slides') {
      if (slideDraft) {
        slideDraft.hidden = Boolean(item?.id);
        slideDraft.open = false;
      }
      if (slidePrompt) slidePrompt.value = '';
      if (slideContext) slideContext.checked = false;
      if (slideContextOption) slideContextOption.hidden = true;
      if (slideContextTitle) slideContextTitle.hidden = true;
      if (slideDraftStatus) slideDraftStatus.textContent = '';
      if (slideDraftSubmit) {
        slideDraftSubmit.disabled = false;
        slideDraftSubmit.textContent = '生成草稿';
      }
      slidesState = item && item.slides ? item.slides : {schema: 'openteamily.slides.v1', slides: []};
      if (!Array.isArray(slidesState.slides)) slidesState = {schema: 'openteamily.slides.v1', slides: []};
      if (!slidesState.slides.length) slidesState.slides.push({title: '', bullets: []});
      renderSlidesEditor();
    }
    if (kind === 'dashboard') {
      dashboardState = item && item.dashboard ? item.dashboard : {schema: 'openteamily.dashboard.v1', widgets: []};
      if (!Array.isArray(dashboardState.widgets)) dashboardState = {schema: 'openteamily.dashboard.v1', widgets: []};
      if (!dashboardState.widgets.length) dashboardState.widgets.push(widgetDefault('metric'));
      renderDashboardEditor();
    }
    const image = document.getElementById('media-image');
    const audio = document.getElementById('media-audio');
    const video = document.getElementById('media-video');
    const mediaMeta = document.getElementById('media-meta');
    image.hidden = true; audio.hidden = true; video.hidden = true;
    image.removeAttribute('src'); audio.removeAttribute('src'); video.removeAttribute('src');
    if (kind === 'media') {
      if (item && item.id && item.media) {
        mediaMeta.textContent = `${item.media.filename || ''} · ${item.media.mime || ''} · ${item.media.bytes || 0} 字节`;
        const src = `/v1/workspaces/${workspaceId()}/artifacts/${item.id}/file`;
        if ((item.media.mime || '').startsWith('image/')) { image.hidden = false; image.src = src; }
        else if ((item.media.mime || '').startsWith('audio/')) { audio.hidden = false; audio.src = src; }
        else if ((item.media.mime || '').startsWith('video/')) { video.hidden = false; video.src = src; }
      } else {
        mediaMeta.textContent = '选择一张图片或一段音视频，大小不超过 2 MB。';
      }
    }
    if (kind === 'whiteboard') {
      boardState = item && item.board ? item.board : {schema: 'openteamily.whiteboard.v1', width: 800, height: 600, strokes: []};
      drawBoard();
    }
    const source = document.getElementById('editor-source');
    if (item?.source?.kind === 'agent_message' && item.source.conversation_id) {
      const {conversation_id: id, agent_id, conversation_title} = item.source;
      const link = document.createElement('a');
      link.href = conversationChatHref(workspaceId(), {source: agent_id ? 'agent' : 'social', id, agent_id});
      link.textContent = conversation_title || '打开会话';
      source.hidden = false;
      source.textContent = '来源会话：';
      source.append(link);
    } else if (item && item.source) {
      source.hidden = false;
      const from = item.source.kind === 'agent_message' ? '对话消息'
        : item.source.kind === 'agent_task' ? '代理任务' : '自动化运行';
      const name = item.source.automation_title || item.source.task_kind || '';
      source.textContent = `出处：${from}${name ? ' · ' + name : ''} · ${item.source.id}`;
    } else {
      source.hidden = true;
      source.textContent = '';
    }
    const preview = document.getElementById('website-preview');
    if (kind === 'website' && item && item.id && workspaceId()) {
      preview.hidden = false;
      preview.setAttribute('sandbox', '');
      preview.removeAttribute('srcdoc');
      preview.src = `/v1/workspaces/${workspaceId()}/artifacts/${item.id}/preview`;
    } else {
      preview.hidden = true;
      preview.removeAttribute('src');
      preview.removeAttribute('srcdoc');
    }
  }

  function closeNewMenu() {
    const menu = document.getElementById('new-menu');
    const button = document.getElementById('new-menu-button');
    if (menu) menu.hidden = true;
    if (button) button.setAttribute('aria-expanded', 'false');
  }

  function worksPath() {
    const path = (document.defaultView && document.defaultView.location && document.defaultView.location.pathname) || '/space';
    const trimmed = path.replace(/\/+$/, '') || '/space';
    return trimmed === '/artifacts' ? '/artifacts' : '/space';
  }

  function syncViewUrl() {
    const view = document.defaultView;
    if (!view || !view.history || !view.history.replaceState) return;
    const fragment = catalogKind === 'meetings' && workspaceId() ? '#workspace=' + encodeURIComponent(workspaceId()) : '';
    const url = worksPath() + queryForView(catalogKind, catalogScope) + fragment;
    view.history.replaceState({}, '', url);
  }

  function applyView(kind, scope, {sync = true} = {}) {
    catalogKind = kind || 'all';
    catalogScope = scope || 'all';
    if (catalogKind === 'meetings') catalogScope = 'all';
    const searchLabel = catalogKind === 'meetings' ? '搜索会议' : '搜索作品';
    search.placeholder = searchLabel;
    search.setAttribute('aria-label', searchLabel);
    for (const item of document.querySelectorAll('.artifact-kinds [data-kind]')) {
      if (item.getAttribute('data-kind') === catalogKind) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    }
    for (const item of document.querySelectorAll('.artifact-scopes [data-scope]')) {
      if (item.getAttribute('data-scope') === catalogScope) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    }
    if (sync) syncViewUrl();
    renderCatalog();
  }

  function closeFilterPanel() {
    const panel = document.getElementById('filter-panel');
    const button = document.getElementById('filter-button');
    if (panel) panel.hidden = true;
    if (button) button.setAttribute('aria-expanded', 'false');
  }

  function readFilters() {
    filterTypes = [...document.querySelectorAll('input[name="file-type"]:checked')].map((input) => input.value);
    const modified = document.querySelector('input[name="modified"]:checked');
    filterModified = modified ? modified.value : 'any';
    const customNote = document.getElementById('custom-range-note');
    if (customNote) customNote.hidden = filterModified !== 'custom';
    filterCreators = [...document.querySelectorAll('input[name="creator"]:checked')].map((input) => input.value);
    filterSessions = [...document.querySelectorAll('input[name="session"]:checked')].map((input) => input.value);
  }

  function renderFilterChoices() {
    const creatorBox = document.getElementById('filter-creator-list');
    const creatorEmpty = document.getElementById('filter-creator-empty');
    const sessionBox = document.getElementById('filter-session-list');
    const sessionEmpty = document.getElementById('filter-session-empty');
    const names = [...new Set((allItems || []).map((item) => item.created_by).filter(Boolean))].sort();
    if (creatorBox) {
      creatorBox.replaceChildren();
      for (const name of names) {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.name = 'creator';
        input.value = name;
        input.checked = filterCreators.includes(name);
        input.addEventListener('change', () => { readFilters(); renderCatalog(); });
        label.appendChild(input);
        label.appendChild(document.createTextNode(' ' + name));
        creatorBox.appendChild(label);
      }
    }
    if (creatorEmpty) creatorEmpty.hidden = names.length > 0;
    const sessions = sessionFilterChoices(allItems);
    if (sessionBox) {
      sessionBox.replaceChildren();
      for (const session of sessions) {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.name = 'session';
        input.value = session.id;
        input.checked = filterSessions.includes(session.id);
        input.addEventListener('change', () => { readFilters(); renderCatalog(); });
        label.appendChild(input);
        label.appendChild(document.createTextNode(' ' + session.label));
        sessionBox.appendChild(label);
      }
    }
    if (sessionEmpty) sessionEmpty.hidden = sessions.length > 0;
  }

  async function loadMeetings() {
    const id = workspaceId();
    if (!id || meetingLoadedFor === id) return;
    const seq = ++meetingRequest;
    meetingItems = [];
    meetingError = '';
    meetingLoadedFor = id;
    meetingLoading = true;
    renderCatalog();
    const listed = await request('GET', `/v1/workspaces/${id}/meetings?limit=100`).catch(() => ({status: 0, body: {}}));
    if (seq !== meetingRequest || workspaceId() !== id) return;
    meetingLoading = false;
    if (listed.status === 200) {
      meetingItems = listed.body.items || [];
    } else {
      meetingLoadedFor = '';
      meetingError = messageFor(listed.body.error, '无法读取会议纪要。');
    }
    if (catalogKind === 'meetings') renderCatalog();
  }

  function renderMeetings() {
    const list = document.getElementById('artifact-list');
    const empty = document.getElementById('list-empty');
    const emptyMeetings = document.getElementById('empty-meetings');
    const errorBox = document.getElementById('meetings-error');
    const needle = search.value.trim().toLocaleLowerCase();
    const matches = meetingItems.filter(item => [item.title, ...(item.attendees || [])]
      .some(value => String(value).toLocaleLowerCase().includes(needle)));
    const rows = meetingRows(meetingsForScope(matches, {
      scope: meetingScope,
      username: currentUser && currentUser.username,
      userId: currentUser && currentUser.id,
    }));
    const caption = document.getElementById('meetings-caption');
    if (caption) {
      caption.textContent = meetingScope === 'joined'
        ? '你出席或创建的会议纪要，最新的在前。'
        : '这个工作区的会议纪要，最新的在前。';
    }
    list.textContent = '';
    if (errorBox) {
      errorBox.hidden = !meetingError;
      errorBox.textContent = meetingError;
    }
    const emptyKind = document.getElementById('empty-kind');
    if (emptyKind) emptyKind.hidden = true;
    const waiting = document.getElementById('meetings-loading');
    if (waiting) waiting.hidden = !meetingLoading;
    const noMatch = document.getElementById('meetings-no-match');
    const filtered = Boolean(needle) || meetingScope === 'joined';
    if (noMatch) noMatch.hidden = !filtered || Boolean(meetingError) || meetingLoading || rows.length > 0;
    if (emptyMeetings) emptyMeetings.hidden = filtered || Boolean(meetingError) || rows.length > 0 || meetingLoading || !workspaceId();
    if (empty) empty.hidden = !meetingError && rows.length > 0;
    const retry = document.getElementById('retry-meetings');
    if (retry) retry.hidden = !meetingError;
    const create = document.getElementById('new-meeting-in-space');
    if (create) {
      create.hidden = !workspaceId();
      create.href = '/meetings#' + new URLSearchParams({workspace: workspaceId(), new: '1'});
    }
    for (const row of rows) {
      const item = document.createElement('li');
      item.className = 'meeting-item';
      item.dataset.kind = 'meetings';
      const link = document.createElement('a');
      link.href = '/meetings#' + new URLSearchParams({workspace: workspaceId(), meeting: row.id});
      const title = document.createElement('span');
      title.className = 'meeting-title';
      title.textContent = row.title;
      const when = document.createElement('span');
      when.className = 'note';
      when.textContent = meetingTimeLabel(row.started_at);
      const actions = document.createElement('span');
      actions.className = 'note meeting-actions';
      actions.textContent = row.actionLabel;
      link.append(title, when, actions);
      item.appendChild(link);
      list.appendChild(item);
    }
    return rows;
  }

  function renderCatalog() {
    const username = currentUser && currentUser.username;
    const items = visibleArtifacts(allItems, {
      kind: catalogKind, scope: catalogScope, username,
      types: filterTypes, modified: filterModified, creators: filterCreators, sessions: filterSessions,
    });
    if (catalogKind === 'meetings') renderMeetings();
    else {
      renderList(items, (item) => openEditor(item));
      const meetingsErrorBox = document.getElementById('meetings-error');
      if (meetingsErrorBox) meetingsErrorBox.hidden = true;
    }
    // The meetings list owns its own empty and error rows; the artifact empty states stay out of it.
    if (catalogKind === 'meetings') {
      if (mainPanel) mainPanel.classList.toggle('is-meetings', true);
      const chrome = document.getElementById('meetings-chrome');
      if (chrome) chrome.hidden = false;
      return;
    }
    const empty = document.getElementById('list-empty');
    const emptyAll = document.getElementById('empty-all');
    const emptyStarred = document.getElementById('empty-starred');
    const emptyMemory = document.getElementById('empty-memory');
    const emptyKind = document.getElementById('empty-kind');
    const emptyMeetings = document.getElementById('empty-meetings');
    const emptyMessage = document.getElementById('list-empty-message');
    const newWebsite = document.getElementById('new-website');
    const meetingsChrome = document.getElementById('meetings-chrome');
    if (mainPanel) mainPanel.classList.toggle('is-meetings', catalogKind === 'meetings');
    if (meetingsChrome) meetingsChrome.hidden = catalogKind !== 'meetings';
    const layoutNote = document.getElementById('layout-note');
    if (layoutNote) layoutNote.hidden = !(items.length && catalogLayout === 'grid');
    if (!empty) return;
    const isEmpty = items.length === 0;
    empty.hidden = !isEmpty;
    if (!isEmpty) return;
    const noWorkspace = emptyMessage && emptyMessage.textContent === '还没有工作区。';
    const showMeetings = catalogKind === 'meetings' && !noWorkspace;
    const showStarred = catalogScope === 'favorites' && !showMeetings && !noWorkspace;
    const showMemory = catalogScope === 'memory' && !showMeetings && !noWorkspace;
    const showAllEmpty = (catalogKind === 'all' && (catalogScope === 'all' || catalogScope === 'mine')
      && !showStarred && !showMemory && !noWorkspace);
    if (emptyAll) emptyAll.hidden = !showAllEmpty;
    if (emptyStarred) emptyStarred.hidden = !showStarred;
    if (emptyMemory) emptyMemory.hidden = !showMemory;
    if (emptyMeetings) emptyMeetings.hidden = !showMeetings;
    if (emptyKind) emptyKind.hidden = showAllEmpty || showStarred || showMemory || showMeetings || noWorkspace;
    if (emptyMessage) emptyMessage.hidden = !noWorkspace;
    if (newWebsite) newWebsite.hidden = !(emptyKind && !emptyKind.hidden && catalogKind === 'website');
    if (emptyKind && !emptyKind.hidden) {
      const note = document.getElementById('empty-kind-note');
      if (note) {
        if (catalogKind === 'messages') note.textContent = '还没有从对话保存到作品库的消息。';
        else if (catalogScope === 'mine') note.textContent = '还没有你创建的作品。';
        else note.textContent = '这一类还没有作品。';
      }
    }
  }

  const sendDialog = document.getElementById('send-to-chat-dialog');
  const sendList = document.getElementById('send-to-chat-list');
  const sendEmpty = document.getElementById('send-to-chat-empty');
  const sendError = document.getElementById('send-to-chat-error');
  const sendLead = document.getElementById('send-to-chat-lead');
  const sendConfirm = document.getElementById('send-to-chat-confirm');
  const sendCancel = document.getElementById('send-to-chat-cancel');
  let sendingArtifact = null;
  let artifactSendOrigin = null;

  async function revealSlideContext(origin) {
    if (!slideContext || !slideContextOption || !slideContextTitle || !slideDraftSubmit) return;
    const {wid, conversation, item} = origin;
    const path = `/v1/workspaces/${wid}/social/conversations/${encodeURIComponent(conversation)}`;
    slideDraftSubmit.disabled = true;
    slideContextTitle.textContent = '正在确认原会话…';
    slideContextTitle.hidden = false;
    const data = await request('GET', path, undefined, undefined, AbortSignal.timeout(5000)).catch(() => null);
    if (artifactSendOrigin !== origin || current !== item || workspaceId() !== wid || form.hidden) return;
    slideDraftSubmit.disabled = false;
    const source = data?.body.conversation;
    if (data?.status !== 200 || source?.id !== conversation || source.public_agent || source.direct?.open === false) {
      slideContextTitle.textContent = '无法读取原会话。仍可根据主题或素材起草。';
      return;
    }
    origin.allowed = true;
    slideContext.checked = true;
    slideContextOption.hidden = false;
    slideContextTitle.textContent = '会话：' + conversationLabel(source);
  }

  function sendStatus(message = '') {
    if (!sendError) return;
    sendError.textContent = message;
    sendError.hidden = !message;
  }

  function closeSendDialog() {
    if (!sendDialog || sendingArtifact?.pending) return;
    sendDialog.hidden = true;
    sendingArtifact = null;
  }

  async function openSendDialog(item) {
    if (!sendDialog || !workspaceId() || !canSendArtifactToChat(item)) return;
    const wid = workspaceId();
    const state = {item, wid, destination: null, pending: false, keys: new Map()};
    sendingArtifact = state;
    sendDialog.hidden = false;
    sendConfirm.disabled = true;
    const formats = {document:'Word 文档', website:'网页源码（文本）', whiteboard:'白板数据（JSON）',
      slides:'PowerPoint 文件', dashboard:'Excel 文件', spreadsheet:'Excel 工作簿', media:'媒体文件'};
    sendLead.textContent = `「${item.title}」版本 ${item.revision} 将作为${formats[item.kind]}发送。请选择接收会话。`;
    sendStatus();
    sendList.replaceChildren();
    sendEmpty.hidden = false;
    sendEmpty.textContent = '正在读取会话…';
    sendCancel?.focus();
    const listed = await request('GET', `/v1/workspaces/${wid}/social/conversations?limit=100`)
      .catch(() => ({status:0, body:{}}));
    if (sendingArtifact !== state || workspaceId() !== wid) return;
    if (listed.status !== 200) {
      sendEmpty.textContent = messageFor(listed.body.error, '无法读取会话列表。');
      return;
    }
    const items = (listed.body.items || []).filter(item => !item.public_agent && item.direct?.open !== false);
    if (artifactSendOrigin?.wid === wid && artifactSendOrigin.item.id === item.id) {
      state.destination = items.find(conversation => conversation.id === artifactSendOrigin.conversation) || null;
      sendConfirm.disabled = !state.destination;
    }
    sendEmpty.hidden = items.length > 0;
    sendEmpty.textContent = '这个工作区还没有可发送的群或单聊。';
    for (const conversation of items) {
      const row = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = conversationLabel(conversation);
      button.setAttribute('aria-pressed', String(state.destination === conversation));
      button.addEventListener('click', () => {
        if (state.pending) return;
        state.destination = conversation;
        for (const option of sendList.querySelectorAll('button')) option.setAttribute('aria-pressed', String(option === button));
        sendConfirm.disabled = false;
        sendStatus();
      });
      row.append(button);
      sendList.append(row);
    }
  }

  sendConfirm?.addEventListener('click', async () => {
    const state = sendingArtifact;
    if (!state?.destination || state.pending || workspaceId() !== state.wid) return;
    const {wid, item, destination, keys} = state;
    const key = keys.get(destination.id) || idempotencyKey();
    keys.set(destination.id, key);
    state.pending = true;
    sendConfirm.disabled = true;
    sendConfirm.textContent = '正在发送…';
    if (sendCancel) sendCancel.disabled = true;
    sendStatus();
    try {
      const result = await request('POST', `/v1/workspaces/${wid}/social/conversations/${destination.id}/messages`,
        {artifact_id: item.id, artifact_revision: item.revision}, {'Idempotency-Key': key});
      if (sendingArtifact !== state || workspaceId() !== wid) return;
      if (result.status !== 200 && result.status !== 201) {
        sendStatus(messageFor(result.body.error, '发送失败，请重试。'));
        return;
      }
      state.pending = false;
      closeSendDialog();
      show('ok', '已发送到「' + conversationLabel(destination) + '」。');
    } catch {
      if (sendingArtifact === state && workspaceId() === wid) sendStatus('未能确认发送结果，请选择同一会话重试。');
    } finally {
      state.pending = false;
      if (sendingArtifact === state || !sendingArtifact) {
        sendConfirm.textContent = '确认发送';
        sendConfirm.disabled = !sendingArtifact?.destination;
        if (sendCancel) sendCancel.disabled = false;
      }
    }
  });

  sendCancel?.addEventListener('click', closeSendDialog);
  sendDialog?.addEventListener('click', event => {
    if (event.target === sendDialog) closeSendDialog();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !sendDialog?.hidden) closeSendDialog();
  });

  let openItemMenu = null;
  function closeItemMenu() {
    if (!openItemMenu) return;
    openItemMenu.menu.hidden = true;
    openItemMenu.menu.remove();
    openItemMenu.button.setAttribute('aria-expanded', 'false');
    openItemMenu = null;
  }
  document.addEventListener('click', event => {
    if (openItemMenu && !openItemMenu.menu.contains(event.target) && event.target !== openItemMenu.button) closeItemMenu();
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeItemMenu(); });

  function itemMenu(item, onOpen) {
    const wrap = document.createElement('span');
    wrap.className = 'artifact-more-wrap';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'artifact-more';
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-label', item.title + '：更多操作');
    button.textContent = '⋯';
    const menu = document.createElement('div');
    menu.className = 'artifact-item-menu';
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    const send = document.createElement('button');
    send.type = 'button';
    send.setAttribute('role', 'menuitem');
    send.className = 'artifact-menu-send';
    send.textContent = '发送到聊天';
    if (canSendArtifactToChat(item)) {
      send.disabled = false;
      send.title = '把此作品的保存版本发到群聊或单聊';
      send.addEventListener('click', () => {
        closeItemMenu();
        openSendDialog(item);
      });
    } else {
      send.disabled = true;
      send.title = '请先保存作品再发送';
    }
    const rename = document.createElement('button');
    rename.type = 'button';
    rename.setAttribute('role', 'menuitem');
    rename.textContent = '重命名';
    rename.title = '打开文档并编辑标题';
    rename.addEventListener('click', async () => {
      closeItemMenu();
      await onOpen(item);
      const title = form.elements.title;
      if (title) { title.focus(); title.select(); }
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.setAttribute('role', 'menuitem');
    remove.className = 'artifact-menu-danger';
    remove.textContent = '删除';
    remove.addEventListener('click', async () => {
      closeItemMenu();
      if (!workspaceId() || !item.id) return;
      if (typeof globalThis.confirm === 'function' && !globalThis.confirm('删除「' + item.title + '」？')) return;
      const result = await request('POST', `/v1/workspaces/${workspaceId()}/artifacts/${item.id}/remove`, {});
      if (result.status !== 200) {
        show('error', messageFor(result.body.error, '删除失败。'));
        return;
      }
      show('ok', '已删除。');
      await loadList();
    });
    menu.append(send, rename, remove);
    button.addEventListener('click', event => {
      event.stopPropagation();
      const wasOpen = openItemMenu && openItemMenu.menu === menu;
      closeItemMenu();
      if (wasOpen) return;
      document.body.appendChild(menu);
      menu.hidden = false;
      const anchor = button.getBoundingClientRect?.() || {right:0, top:0, bottom:0};
      const viewport = document.defaultView;
      const height = viewport?.visualViewport?.height || viewport?.innerHeight || 800;
      const width = viewport?.visualViewport?.width || viewport?.innerWidth || 400;
      const top = anchor.bottom + menu.offsetHeight + 8 > height ? anchor.top - menu.offsetHeight - 4 : anchor.bottom + 4;
      menu.style.top = Math.max(8, top) + 'px';
      menu.style.left = Math.max(8, Math.min(width - menu.offsetWidth - 8, anchor.right - menu.offsetWidth)) + 'px';
      button.setAttribute('aria-expanded', 'true');
      openItemMenu = {menu, button};
    });
    wrap.append(button);
    return wrap;
  }

  function renderList(items, onOpen) {
    const list = document.getElementById('artifact-list');
    const empty = document.getElementById('list-empty');
    list.textContent = '';
    closeItemMenu();
    applyArtifactLayout(list, catalogLayout);
    if (empty) empty.hidden = items.length > 0;
    if (items.length) {
      const head = document.createElement('li');
      head.className = 'artifact-list-head';
      head.setAttribute('aria-hidden', 'true');
      for (const label of ['名称', '来源', '创建时间', '最近动态']) {
        const cell = document.createElement('span');
        cell.textContent = label;
        head.append(cell);
      }
      list.appendChild(head);
    }
    for (const item of items) {
      const row = document.createElement('li');
      row.className = 'artifact-item';
      row.dataset.kind = item.kind || '';
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'link';
      open.textContent = item.title;
      open.addEventListener('click', () => onOpen(item));
      const meta = document.createElement('span');
      meta.className = 'note';
      const source = item.source && item.source.kind === 'agent_message' ? ' · 消息' : '';
      meta.textContent = `${kindLabel(item.kind)} · ${item.created_by || ''}${source}`;
      row.appendChild(open);
      row.appendChild(meta);
      const cover = document.createElement('span');
      cover.className = 'artifact-cover';
      cover.setAttribute('aria-hidden', 'true');
      const mime = item.media && item.media.mime ? String(item.media.mime) : '';
      const thumb = item.preview ? renderThumb(document, item.preview) : null;
      if (thumb) {
        cover.classList.add('has-thumb');
        cover.append(thumb);
      } else if (item.kind === 'media' && /^image\//.test(mime) && item.id && workspaceId()) {
        const img = document.createElement('img');
        img.className = 'artifact-cover-img';
        img.alt = '';
        img.loading = 'lazy';
        img.src = `/v1/workspaces/${workspaceId()}/artifacts/${item.id}/file`;
        cover.classList.add('has-thumb');
        cover.append(img);
      } else {
        cover.textContent = kindLabel(item.kind);
      }
      row.appendChild(cover);
      const badge = document.createElement('span');
      badge.className = 'artifact-kind';
      badge.setAttribute('aria-hidden', 'true');
      badge.textContent = kindBadge(item.kind);
      row.appendChild(badge);
      const bookmark = document.createElement('button');
      bookmark.type = 'button';
      bookmark.className = 'artifact-bookmark';
      bookmark.title = item.favorited ? '取消收藏' : '收藏';
      bookmark.setAttribute('aria-label', bookmark.title);
      bookmark.setAttribute('aria-pressed', String(!!item.favorited));
      bookmark.addEventListener('click', async event => {
        event.stopPropagation();
        const wid = workspaceId();
        bookmark.disabled = true;
        try {
          const result = await request('POST', `/v1/workspaces/${wid}/artifacts/${item.id}/favorite`, {enabled: !item.favorited});
          if (workspaceId() !== wid) return;
          if (result.status !== 200) { show('error', messageFor(result.body.error, '收藏未保存。')); return; }
          item.favorited = result.body.favorited;
          renderCatalog();
        } catch { show('error', '网络错误，收藏未保存。'); }
        finally { bookmark.disabled = false; }
      });
      bookmark.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4h10v16l-5-3-5 3V4Z"/></svg>';
      row.appendChild(bookmark);
      const created = document.createElement('span');
      created.className = 'artifact-created';
      created.textContent = artifactTime(item.created);
      const updated = document.createElement('span');
      updated.className = 'artifact-updated';
      updated.textContent = item.updated ? '编辑于 ' + artifactTime(item.updated) : '';
      row.append(created, updated, itemMenu(item, onOpen));
      list.appendChild(row);
    }
  }

  async function openEditor(item) {
    if (pendingDeleteCancel) pendingDeleteCancel();
    closeNewMenu();
    current = item;
    listPanel.hidden = true;
    form.hidden = false;
    if (item && item.id && workspaceId()) {
      const seen = await request('GET', `/v1/workspaces/${workspaceId()}/artifacts/${item.id}`);
      if (seen.status !== 200) {
        current=null;form.hidden=true;listPanel.hidden=false;
        show('error', messageFor(seen.body.error, '无法打开文档。'));
        return;
      }
      current = seen.body.artifact;
    }
    fillEditor(current);
    document.getElementById('remove-artifact').hidden = !current || !current.id;
    const sharePanel = document.getElementById('share-panel');
    sharePanel.hidden = !current || !current.id;
    document.getElementById('share-once').hidden = true;
    document.getElementById('share-once').textContent = '';
    const versionPanel = document.getElementById('version-panel');
    versionPanel.hidden = !current || !current.id;
    const discoverPanel = document.getElementById('discover-panel');
    if (discoverPanel) discoverPanel.hidden = !current || !current.id;
    if (current && current.id) {
      await loadShares();
      await loadVersions();
      await loadDiscover();
    } else {
      document.getElementById('share-list').textContent = '';
      document.getElementById('version-list').textContent = '';
    }
  }

  async function loadDiscover() {
    const panel = document.getElementById('discover-panel');
    const status = document.getElementById('discover-status');
    const slugInput = document.getElementById('discover-slug');
    const revoke = document.getElementById('revoke-discover');
    if (!panel) return;
    if (!current || !current.id || !workspaceId()) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    const listed = await request('GET', `/v1/workspaces/${workspaceId()}/artifacts/${current.id}/discover`);
    if (listed.status !== 200) {
      if (status) {
        status.hidden = false;
        status.textContent = '无法读取公开状态。';
      }
      return;
    }
    const row = listed.body.discover || {};
    if (slugInput) slugInput.value = row.slug || suggestedDiscoverSlug(current.title);
    if (revoke) revoke.hidden = !row.listed;
    if (status) {
      status.hidden = false;
      status.textContent = row.listed ? ('已公开：/w/' + row.slug) : '尚未公开到发现页。';
    }
  }

  async function loadShares() {
    const list = document.getElementById('share-list');
    const empty = document.getElementById('share-empty');
    list.textContent = '';
    if (!current || !current.id || !workspaceId()) return;
    const listed = await request('GET', `/v1/workspaces/${workspaceId()}/artifacts/${current.id}/shares`);
    if (listed.status !== 200) {
      show('error', messageFor(listed.body.error, '无法读取分享链接。'));
      return;
    }
    const items = listed.body.items || [];
    empty.hidden = items.length > 0;
    for (const item of items) {
      const row = document.createElement('li');
      const meta = document.createElement('span');
      meta.className = 'note';
      meta.textContent = item.revoked ? `已撤销 · ${item.prefix}…` : `有效 · ${item.prefix}…`;
      row.appendChild(meta);
      if (!item.revoked) {
        const revoke = document.createElement('button');
        revoke.type = 'button';
        revoke.textContent = '撤销';
        revoke.addEventListener('click', async () => {
          const result = await request('POST', `/v1/workspaces/${workspaceId()}/artifacts/${current.id}/shares/${item.id}/revoke`, {});
          if (result.status !== 200) {
            show('error', messageFor(result.body.error, '撤销失败。'));
            return;
          }
          document.getElementById('share-once').hidden = true;
          document.getElementById('share-once').textContent = '';
          show('ok', '分享链接已撤销。');
          await loadShares();
        });
        row.appendChild(revoke);
      }
      list.appendChild(row);
    }
  }

  function exportHref(revision) {
    const base = `/v1/workspaces/${workspaceId()}/artifacts/${current.id}`;
    if(revision)return `${base}/versions/${revision}/export`;
    const format=document.getElementById('export-format')?.value;
    return `${base}/export`+(format && format!=='original'?'?format='+encodeURIComponent(format):'');
  }

  async function loadVersions() {
    const list = document.getElementById('version-list');
    const empty = document.getElementById('version-empty');
    list.textContent = '';
    if (!current || !current.id || !workspaceId()) return;
    const listed = await request('GET', `/v1/workspaces/${workspaceId()}/artifacts/${current.id}/versions`);
    if (listed.status !== 200) {
      show('error', messageFor(listed.body.error, '无法读取版本历史。'));
      return;
    }
    const items = listed.body.items || [];
    empty.hidden = items.length > 0;
    for (const item of items) {
      const row = document.createElement('li');
      const meta = document.createElement('span');
      meta.className = 'note';
      meta.textContent = `修订 ${item.revision} · ${item.title || ''} · ${item.created_by || ''}`;
      row.appendChild(meta);
      const download = document.createElement('a');
      download.href = exportHref(item.revision);
      download.textContent = '导出';
      row.appendChild(download);
      if (item.revision !== current.revision) {
        const restore = document.createElement('button');
        restore.type = 'button';
        restore.textContent = '恢复为新修订';
        restore.addEventListener('click', async () => {
          const result = await request('POST', `/v1/workspaces/${workspaceId()}/artifacts/${current.id}/restore`, {
            revision: current.revision,
            to: item.revision,
          });
          if (result.status !== 200) {
            show('error', messageFor(result.body.error, '恢复失败。'));
            return;
          }
          current = result.body.artifact;
          fillEditor(current);
          show('ok', `已恢复为修订 ${current.revision}。`);
          await loadVersions();
        });
        row.appendChild(restore);
      }
      list.appendChild(row);
    }
  }

  let listGeneration = 0;
  const workspaceEvents=mountWorkspaceEvents(document,{onInvalidate:async(event)=>{
    if(event.workspace!==workspaceId()||!event.changed.includes('artifacts'))return;
    await loadList();
    if(event.workspace!==workspaceId()||!current?.id)return;
    const id=current.id,wid=workspaceId();
    const result=await request('GET',`/v1/workspaces/${wid}/artifacts/${id}`);
    if(workspaceId()!==wid||current?.id!==id)return;
    const banner=document.getElementById('artifact-live-update');
    if(banner)banner.hidden=result.status===200&&result.body.artifact.revision===current.revision;
  }});
  document.getElementById('artifact-live-load')?.addEventListener('click',async()=>{
    if(!current?.id||!globalThis.confirm?.('读取服务器版本将覆盖编辑器内未保存的草稿。请先复制草稿。继续？'))return;
    const wid=workspaceId(),id=current.id;
    const result=await request('GET',`/v1/workspaces/${wid}/artifacts/${id}`);
    if(workspaceId()!==wid||current?.id!==id)return;
    if(result.status!==200){show('error','服务器作品不可读取，可能已删除或访问已撤销；保留本地草稿。');return;}
    await openEditor(result.body.artifact);
    const banner=document.getElementById('artifact-live-update');if(banner)banner.hidden=true;
  });
  async function loadList() {
    if (catalogKind === 'meetings') {
      listGeneration += 1;
      workspaceEvents.start('');
      await loadMeetings();
      return;
    }
    workspaceEvents.start(workspaceId());
    const generation = ++listGeneration;
    const id = workspaceId();
    if (!id) return;
    const listed = await request('GET', `/v1/workspaces/${id}/artifacts${listQuery(search.value)}`);
    // An old workspace/search response must never replace the current list.
    if (generation !== listGeneration || workspaceId() !== id) return;
    if (listed.status !== 200) {
      show('error', messageFor(listed.body.error, '无法读取作品库。'));
      return;
    }
    allItems = listed.body.items || [];
    renderFilterChoices();
    renderCatalog();
  }

  function fillWorkspaces(items, selected) {
    workspaceSelect.textContent = '';
    for (const item of items) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.name;
      workspaceSelect.appendChild(option);
    }
    if (items.some(item => item.id === selected)) workspaceSelect.value = selected;
  }

  async function load() {
    const seq = ++workspaceLoad;
    const session = await request('GET', '/v1/auth/session');
    if (seq !== workspaceLoad) return;
    if (session.status === 401) {
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
    const whoami = document.getElementById('whoami');
    whoami.dataset.username = currentUser.username;
    whoami.textContent = currentUser.username;
    const requested = artifactTargetFromSearch(document.defaultView?.location?.search);
    const fragment = new URLSearchParams((document.defaultView?.location?.hash || '').slice(1));
    const newKind = newKindFromSearch(document.defaultView?.location?.search);
    const linkedWorkspace = requested?.workspace || (catalogKind === 'meetings' || newKind ? fragment.get('workspace') : '');
    let {initial: space, supplemental} = await readWorkspaceChoices(request, '/v1/workspaces?limit=100');
    if (linkedWorkspace && !space.body.items?.some(item => item.id === linkedWorkspace) && supplemental) {
      const shared = await supplemental;
      if (shared.status === 200) space = shared;
      supplemental = null;
    }
    if (seq !== workspaceLoad) return;
    if (space.status !== 200) {
      show('error', '无法读取工作区。');
      return;
    }
    const workspaces = space.body.items || [];
    fillWorkspaces(workspaces, linkedWorkspace || workspaceId());
    void supplemental?.then(shared => {
      if (seq === workspaceLoad && shared.status === 200) fillWorkspaces(shared.body.items, workspaceId());
    });
    if (!workspaces.length) {
      allItems = [];
      document.getElementById('artifact-list').textContent = '';
      const emptyMessage = document.getElementById('list-empty-message');
      if (emptyMessage) emptyMessage.textContent = '还没有工作区。';
      renderCatalog();
      return;
    }
    const emptyMessage = document.getElementById('list-empty-message');
    if (emptyMessage) emptyMessage.textContent = '这个工作区还没有作品。';
    form.hidden = true;
    listPanel.hidden = false;
    if (catalogKind === 'meetings' && linkedWorkspace && !workspaces.some(item => item.id === linkedWorkspace)) {
      workspaceSelect.value = '';
      meetingError = '无法打开此工作区的会议资料。请选择其他工作区。';
      renderCatalog();
      return;
    }
    if (newKind && linkedWorkspace && !workspaces.some(item => item.id === linkedWorkspace)) {
      workspaceSelect.value = '';
      show('error', '你没有访问此工作区的权限。请选择可以访问的工作区。');
      return;
    }
    if(requested){
      if(requested.invalid||!workspaces.some(w=>w.id===requested.workspace)){
        await loadList();show('error','文档链接无效，或你没有访问该工作区的权限。');return;
      }
      workspaceSelect.value=requested.workspace;
    }
    if (newKind && !requested) {
      const view = document.defaultView;
      const params = new URLSearchParams(view.location.search);
      params.delete('new');
      const rest = params.toString();
      document.getElementById(newKindButtonId(newKind))?.click();
      const conversation = fragment.get('conversation');
      if (current?.kind === newKind && linkedWorkspace && workspaceId() === linkedWorkspace && /^[A-Za-z0-9_-]{1,128}$/.test(conversation || '')) {
        artifactSendOrigin = {wid: linkedWorkspace, conversation, item: current, allowed: false};
        if (newKind === 'slides') void revealSlideContext(artifactSendOrigin);
      }
      view.history?.replaceState(null, '', view.location.pathname + (rest ? '?' + rest : '') + view.location.hash);
      return;
    }
    await loadList();
    if(requested)await openEditor({id:requested.artifact});
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

  workspaceSelect.addEventListener('change', () => {
    if (pendingDeleteCancel) pendingDeleteCancel();
    meetingLoadedFor = '';
    meetingItems = [];
    meetingError = '';
    meetingLoading = false;
    if (catalogKind === 'meetings') syncViewUrl();
    void loadList();
  });
  search.addEventListener('input', () => {
    if (catalogKind === 'meetings') renderMeetings();
    else void loadList();
  });
  document.getElementById('retry-meetings')?.addEventListener('click', () => loadMeetings());

  document.getElementById('new-artifact').addEventListener('click', () => {
    draftKind = 'document';
    closeNewMenu();
    openEditor({kind: 'document'});
  });

  document.getElementById('new-website').addEventListener('click', () => {
    draftKind = 'website';
    openEditor({kind: 'website'});
  });

  document.getElementById('new-slides').addEventListener('click', () => {
    draftKind = 'slides';
    closeNewMenu();
    openEditor({kind: 'slides'});
  });

  document.getElementById('new-dashboard').addEventListener('click', () => {
    draftKind = 'dashboard';
    dashboardState = {schema: 'openteamily.dashboard.v1', widgets: [widgetDefault('metric')]};
    closeNewMenu();
    openEditor({kind: 'dashboard'});
  });

  document.getElementById('new-spreadsheet')?.addEventListener('click', () => {
    draftKind = 'spreadsheet';
    closeNewMenu();
    openEditor({kind: 'spreadsheet'});
  });

  sendSpreadsheet?.addEventListener('click', () => openSendDialog(current));
  sendSlides?.addEventListener('click', () => openSendDialog(current));
  downloadSpreadsheet?.addEventListener('click', () => {
    if (current?.kind === 'spreadsheet' && current.id) {
      globalThis.location.assign(exportHref(current.revision));
    }
  });
  downloadSlides?.addEventListener('click', () => {
    if (current?.kind === 'slides' && current.id) {
      globalThis.location.assign(exportHref(current.revision) + '?format=pptx');
    }
  });
  for (const backId of ['sheet-back', 'slides-back']) {
    document.getElementById(backId)?.addEventListener('click', () => {
      document.getElementById('cancel-editor').click();
    });
  }

  document.getElementById('add-widget').addEventListener('click', () => {
    if (dashboardState.widgets.length >= 20) return;
    dashboardState.widgets.push(widgetDefault('metric'));
    renderDashboardEditor();
  });

  document.getElementById('add-slide').addEventListener('click', () => {
    if (slidesState.slides.length >= 30) return;
    slidesState.slides.push({title: '', bullets: []});
    slideEditCount++;
    renderSlidesEditor(slidesState.slides.length - 1);
  });

  document.getElementById('new-media').addEventListener('click', () => {
    draftKind = 'media';
    document.getElementById('media-file').value = '';
    closeNewMenu();
    openEditor({kind: 'media'});
  });

  document.getElementById('new-board').addEventListener('click', () => {
    draftKind = 'whiteboard';
    boardState = {schema: 'openteamily.whiteboard.v1', width: 800, height: 600, strokes: []};
    closeNewMenu();
    openEditor({kind: 'whiteboard'});
  });

  function bindCreate(id, start) {
    const button = document.getElementById(id);
    if (button) button.addEventListener('click', start);
  }

  bindCreate('empty-new-document', () => {
    draftKind = 'document';
    openEditor({kind: 'document'});
  });

  bindCreate('empty-agent-website', () => { closeNewMenu(); openWebsiteBriefDialog(); });
  bindCreate('new-agent-website', () => { closeNewMenu(); openWebsiteBriefDialog(); });
  bindCreate('empty-save-message', () => { closeNewMenu(); openSaveMessageDialog(); });
  bindCreate('empty-starred-save-message', () => { closeNewMenu(); openSaveMessageDialog(); });
  bindCreate('new-save-message', () => { closeNewMenu(); openSaveMessageDialog(); });

  const newMenuButton = document.getElementById('new-menu-button');
  if (newMenuButton) {
    newMenuButton.addEventListener('click', (event) => {
      event.stopPropagation();
      const menu = document.getElementById('new-menu');
      if (!menu) return;
      const open = menu.hidden;
      menu.hidden = !open;
      newMenuButton.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }
  document.addEventListener('click', (event) => {
    const wrap = document.querySelector('.new-menu-wrap');
    if (wrap && !wrap.contains(event.target)) closeNewMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeNewMenu();
      closeFilterPanel();
    }
  });

  for (const button of document.querySelectorAll('.artifact-kinds [data-kind]')) {
    button.addEventListener('click', async () => {
      const kind = button.getAttribute('data-kind') || 'all';
      const scope = kind === 'meetings' ? 'all' : (catalogScope === 'favorites' || catalogScope === 'memory' || catalogScope === 'mine' ? catalogScope : 'all');
      applyView(kind, scope);
      await loadList();
    });
  }
  for (const button of document.querySelectorAll('.artifact-scopes [data-scope]')) {
    button.addEventListener('click', () => {
      const leavingMeetings = catalogKind === 'meetings';
      applyView('all', button.getAttribute('data-scope') || 'all');
      if (leavingMeetings) void loadList();
    });
  }
  for (const button of document.querySelectorAll('.meeting-scopes [data-meeting-scope]')) {
    button.addEventListener('click', () => {
      meetingScope = button.getAttribute('data-meeting-scope') || 'all';
      for (const item of document.querySelectorAll('.meeting-scopes [data-meeting-scope]')) {
        if (item.getAttribute('data-meeting-scope') === meetingScope) item.setAttribute('aria-current', 'page');
        else item.removeAttribute('aria-current');
      }
      renderCatalog();
    });
  }
  for (const button of document.querySelectorAll('#layout-toggle [data-layout]')) {
    button.addEventListener('click', () => {
      catalogLayout = button.getAttribute('data-layout') || 'grid';
      for (const item of document.querySelectorAll('#layout-toggle [data-layout]')) {
        const selected = item.getAttribute('data-layout') === catalogLayout;
        item.setAttribute('aria-selected', selected ? 'true' : 'false');
        item.setAttribute('aria-pressed', selected ? 'true' : 'false');
      }
      renderCatalog();
    });
  }
  const collapseButton = document.getElementById('dir-collapse');
  const expandButton = document.getElementById('dir-expand');
  if (collapseButton) {
    collapseButton.addEventListener('click', (event) => {
      event.stopPropagation();
      applyDirectoryCollapsed(document, true);
    });
  }
  if (expandButton) {
    expandButton.addEventListener('click', (event) => {
      event.stopPropagation();
      applyDirectoryCollapsed(document, false);
    });
  }
  const filterButton = document.getElementById('filter-button');
  if (filterButton) {
    filterButton.addEventListener('click', (event) => {
      event.stopPropagation();
      const panel = document.getElementById('filter-panel');
      if (!panel) return;
      const open = panel.hidden;
      panel.hidden = !open;
      filterButton.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }
  for (const button of document.querySelectorAll('.filter-accordion')) {
    button.addEventListener('click', () => {
      const section = button.closest('.filter-section');
      const open = button.getAttribute('aria-expanded') !== 'true';
      for (const other of document.querySelectorAll('.filter-section')) {
        const accordion = other.querySelector('.filter-accordion');
        const body = other.querySelector('.filter-body');
        const expanded = open && other === section;
        if (accordion) accordion.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        if (body) body.hidden = !expanded;
      }
    });
  }
  for (const input of document.querySelectorAll('#filter-panel input[name="file-type"], #filter-panel input[name="modified"]')) {
    input.addEventListener('change', () => { readFilters(); renderCatalog(); });
  }
  document.addEventListener('click', (event) => {
    const wrap = document.querySelector('.filter-wrap');
    if (wrap && !wrap.contains(event.target)) closeFilterPanel();
  });

  document.getElementById('cancel-editor').addEventListener('click', async () => {
    if (pendingDeleteCancel) pendingDeleteCancel();
    current = null;
    form.hidden = true;
    listPanel.hidden = false;
    await loadList();
  });

  async function uploadMedia(path, extraFields) {
    const file = document.getElementById('media-file').files[0];
    const title = form.elements.title.value.trim();
    if (!title) {
      show('error', '请填写标题。');
      return null;
    }
    if (!file && !(current && current.id)) {
      show('error', '请选择一个媒体文件。');
      return null;
    }
    if (!file && current && current.id) {
      return request('POST', `/v1/workspaces/${workspaceId()}/artifacts/${current.id}`,
                     {revision: current.revision, changes: {title}});
    }
    const body = new FormData();
    body.append('title', title);
    body.append('kind', 'media');
    body.append('file', file);
    if (extraFields) Object.entries(extraFields).forEach(([key, value]) => body.append(key, value));
    const headers = {'Accept': 'application/json', 'X-CSRF-Token': csrfCookie(document.cookie)};
    if (!(current && current.id)) headers['Idempotency-Key'] = idempotencyKey();
    const response = await fetcher(path, {method: 'POST', headers, credentials: 'same-origin', body});
    let parsed = {};
    try { parsed = await response.json(); } catch { parsed = {}; }
    return {status: response.status, body: parsed};
  }

  let savingArtifact = false;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (savingArtifact) return;
    savingArtifact = true;
    const saveButtons = ['save-artifact', 'document-save', 'sheet-save', 'slides-save'].map(id => document.getElementById(id)).filter(Boolean);
    for (const button of saveButtons) button.disabled = true;
    try {
    if (!workspaceId()) {
      show('error', '先选择一个工作区。');
      return;
    }
    const title = form.elements.title.value.trim();
    richDocument.flush();
    const body = form.elements.body.value;
    const kind = (current && current.kind) || draftKind;
    if (!title) {
      show('error', '请填写标题。');
      return;
    }
    let result;
    if (kind === 'media') {
      result = await uploadMedia(
        current && current.id
          ? `/v1/workspaces/${workspaceId()}/artifacts/${current.id}/file`
          : `/v1/workspaces/${workspaceId()}/artifacts`,
        current && current.id ? {revision: String(current.revision)} : null,
      );
      if (!result) return;
    } else if (kind === 'slides') {
      const slides = slidesDeck();
      if (!slides.slides.length) {
        show('error', '至少添加一页幻灯片。');
        return;
      }
      for (const [index, slide] of slides.slides.entries()) {
        if (!slide.title && !slide.bullets.length) {
          show('error', '请填写第 ' + (index + 1) + ' 页的标题或要点。');
          return;
        }
        if (slide.bullets.length > 10 || slide.bullets.some(bullet => bullet.length > 200)) {
          show('error', '第 ' + (index + 1) + ' 页最多 10 条要点，每条最多 200 字。');
          return;
        }
      }
      form.inert = true;
      if (current && current.id) {
        result = await request('POST', `/v1/workspaces/${workspaceId()}/artifacts/${current.id}`,
                               {revision: current.revision, changes: {title, slides}});
      } else {
        result = await request('POST', `/v1/workspaces/${workspaceId()}/artifacts`,
                               {title, kind: 'slides', slides},
                               {'Idempotency-Key': idempotencyKey()});
      }
    } else if (kind === 'spreadsheet') {
      form.inert = true;
      const workbook = spreadsheet.value();
      if (current?.id) {
        result = await request('POST', `/v1/workspaces/${workspaceId()}/artifacts/${current.id}`,
                               {revision: current.revision, changes: {title, spreadsheet: workbook}});
      } else {
        result = await request('POST', `/v1/workspaces/${workspaceId()}/artifacts`,
                               {title, kind, spreadsheet: workbook}, {'Idempotency-Key': idempotencyKey()});
      }
    } else if (kind === 'dashboard') {
      const value = dashboardValue();
      if (!value.widgets.length) {
        show('error', '至少添加一个看板组件。');
        return;
      }
      for (const widget of value.widgets) {
        if (!widget.title.trim()) {
          show('error', '每个看板组件都需要标题。');
          return;
        }
        if (widget.type === 'table'
            && (!widget.columns.length || widget.rows.some(row => row.length !== widget.columns.length))) {
          show('error', '表格的列名和每行单元格数量需要一致。');
          return;
        }
        if (widget.type === 'bar'
            && (!widget.labels.length || widget.labels.length !== widget.values.length)) {
          show('error', '条形图的标签和数值数量需要一致。');
          return;
        }
      }
      if (current && current.id) {
        result = await request('POST', `/v1/workspaces/${workspaceId()}/artifacts/${current.id}`,
                               {revision: current.revision, changes: {title, dashboard: value}});
      } else {
        result = await request('POST', `/v1/workspaces/${workspaceId()}/artifacts`,
                               {title, kind: 'dashboard', dashboard: value},
                               {'Idempotency-Key': idempotencyKey()});
      }
    } else if (kind === 'whiteboard') {
      if (current && current.id) {
        result = await request('POST', `/v1/workspaces/${workspaceId()}/artifacts/${current.id}`,
                               {revision: current.revision, changes: {title, board: boardState}});
      } else {
        result = await request('POST', `/v1/workspaces/${workspaceId()}/artifacts`,
                               {title, kind: 'whiteboard', board: boardState},
                               {'Idempotency-Key': idempotencyKey()});
      }
    } else if (current && current.id) {
      result = await request('POST', `/v1/workspaces/${workspaceId()}/artifacts/${current.id}`,
                             {revision: current.revision, changes: {title, body}});
    } else {
      result = await request('POST', `/v1/workspaces/${workspaceId()}/artifacts`,
                             {title, body, kind},
                             {'Idempotency-Key': idempotencyKey()});
    }
    if (result.status === 409) {
      show('error', '文档已在别处更新，或标题已被占用，请重新打开后再保存。');
      return;
    }
    if (result.status !== 200 && result.status !== 201) {
      show('error', messageFor(result.body.error, '保存失败。'));
      return;
    }
    if (artifactSendOrigin?.item === current) artifactSendOrigin.item = result.body.artifact;
    current = result.body.artifact;
    draftKind = current.kind || draftKind;
    fillEditor(current);
    form.inert = false;
    document.getElementById('remove-artifact').hidden = false;
    document.getElementById('share-panel').hidden = false;
    const discoverPanel = document.getElementById('discover-panel');
    if (discoverPanel) discoverPanel.hidden = false;
    show('ok', '已保存。');
    await loadShares();
    await loadDiscover();
    } catch { show('error', '网络错误，未能确认保存结果。请重新打开作品检查后再重试。'); }
    finally {
      form.inert = false;
      savingArtifact = false;
      for (const button of saveButtons) button.disabled = false;
    }
  });

  function askDeleteConfirmation() {
    const trigger = document.getElementById('remove-artifact');
    const target = {workspace: workspaceId(), id: current && current.id};
    const prompt = artifactDeletePrompt(current);
    const box = document.createElement('div');
    box.className = 'inline-confirm';
    box.setAttribute('role', 'alertdialog');
    box.setAttribute('aria-labelledby', 'remove-artifact-question');
    const question = document.createElement('span');
    question.id = 'remove-artifact-question';
    question.textContent = prompt.question;
    const detail = document.createElement('span');
    detail.className = 'note';
    detail.textContent = prompt.detail;
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = prompt.cancelLabel;
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.textContent = prompt.confirmLabel;
    box.appendChild(question);
    box.appendChild(detail);
    box.appendChild(cancel);
    box.appendChild(confirm);
    trigger.hidden = true;
    const parent = trigger.parentNode;
    if (parent && typeof parent.insertBefore === 'function') parent.insertBefore(box, trigger.nextSibling || null);
    else form.appendChild(box);
    if (typeof cancel.focus === 'function') cancel.focus();

    return new Promise(resolve => {
      let settled = false;
      const finish = answer => {
        if (settled) return;
        settled = true;
        pendingDeleteCancel = null;
        document.removeEventListener('keydown', onKey);
        box.remove();
        trigger.hidden = false;
        if (!answer && typeof trigger.focus === 'function') trigger.focus();
        resolve(answer ? target : null);
      };
      const onKey = event => {
        if (event.key === 'Escape') {
          event.preventDefault();
          finish(false);
        }
      };
      pendingDeleteCancel = () => finish(false);
      cancel.addEventListener('click', () => finish(false));
      confirm.addEventListener('click', () => finish(true));
      document.addEventListener('keydown', onKey);
    });
  }


  let spaceActionDialog = null;

  function closeSpaceActionDialog() {
    if (spaceActionDialog && spaceActionDialog.parentNode) spaceActionDialog.parentNode.removeChild(spaceActionDialog);
    spaceActionDialog = null;
  }

  function spaceDialogHost() {
    return mainPanel || listPanel || form;
  }

  function openSpaceDialog(id, titleText) {
    closeSpaceActionDialog();
    closeAgentTaskDialog();
    const dialog = document.createElement('div');
    dialog.id = id;
    dialog.className = 'send-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', id + '-title');
    const card = document.createElement('div');
    card.className = 'send-dialog-card';
    const heading = document.createElement('h2');
    heading.id = id + '-title';
    heading.textContent = titleText;
    const note = document.createElement('p');
    note.className = 'note';
    note.hidden = true;
    card.appendChild(heading);
    card.appendChild(note);
    dialog.appendChild(card);
    const host = spaceDialogHost();
    if (host && typeof host.appendChild === 'function') host.appendChild(dialog);
    spaceActionDialog = dialog;
    return {dialog, card, note, heading};
  }

  async function openWebsiteBriefDialog() {
    if (!workspaceId()) { show('error', '先选择一个工作区。'); return; }
    const ui = openSpaceDialog('website-brief-dialog', '让智能体搭建网站');
    const brief = document.createElement('textarea');
    brief.id = 'website-brief';
    brief.rows = 6;
    brief.maxLength = 4000;
    brief.placeholder = '描述网站要做什么、给谁看、需要哪些栏目。';
    const agentLabel = document.createElement('label');
    agentLabel.textContent = '智能体';
    const agentSelect = document.createElement('select');
    agentSelect.id = 'website-brief-agent';
    agentLabel.appendChild(agentSelect);
    const actions = document.createElement('div');
    actions.className = 'space-action-row';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = '取消';
    cancel.addEventListener('click', () => closeSpaceActionDialog());
    const submit = document.createElement('button');
    submit.type = 'button';
    submit.textContent = '创建并发送请求';
    actions.append(cancel, submit);
    ui.card.append(brief, agentLabel, actions);
    const agents = await request('GET', `/v1/workspaces/${workspaceId()}/agents?limit=100`);
    const personal = await request('GET', '/v1/personal-agent');
    const options = [];
    const personalAgent = personal.status === 200 ? personal.body.personal_agent : null;
    if (personalAgent && personalAgent.agent && personalAgent.workspace && personalAgent.workspace.id === workspaceId()) {
      const agent = personalAgent.agent;
      options.push({id: agent.id, name: (agent.name || '个人智能体') + '（个人）'});
    }
    if (agents.status === 200) {
      for (const agent of agents.body.items || []) {
        if (options.some((row) => row.id === agent.id)) continue;
        options.push({id: agent.id, name: agent.name || '智能体'});
      }
    }
    if (!options.length) {
      ui.note.hidden = false;
      ui.note.textContent = '这个工作区还没有可选用的智能体，无法发出搭建请求。';
      submit.disabled = true;
    }
    for (const option of options) {
      const row = document.createElement('option');
      row.value = option.id;
      row.textContent = option.name;
      agentSelect.append(row);
    }
    submit.addEventListener('click', async () => {
      const text = brief.value.trim();
      if (!text) { ui.note.hidden = false; ui.note.textContent = '请先填写网站需求。'; return; }
      if (!agentSelect.value) { ui.note.hidden = false; ui.note.textContent = '请选择一个智能体。'; return; }
      submit.disabled = true;
      const title = websiteTitle(text);
      const created = await request('POST', `/v1/workspaces/${workspaceId()}/artifacts`, {
        title, kind: 'website', body: websiteStub(text),
      }, { 'Idempotency-Key': idempotencyKey('site-brief-') });
      if (created.status !== 201 && created.status !== 200) {
        submit.disabled = false;
        ui.note.hidden = false;
        ui.note.textContent = messageFor(created.body.error, '无法创建网站作品。');
        return;
      }
      const artifact = created.body.artifact;
      const conversation = await request('POST', `/v1/workspaces/${workspaceId()}/agents/${agentSelect.value}/conversations`, {
        title,
      }, { 'Idempotency-Key': idempotencyKey('site-conv-') });
      if (conversation.status !== 201 && conversation.status !== 200) {
        closeSpaceActionDialog();
        show('error', '网站作品已创建，但未能打开智能体会话：' + messageFor(conversation.body.error, '请稍后重试。'));
        await loadList();
        if (artifact && artifact.id) openEditor(artifact);
        return;
      }
      const conv = conversation.body.conversation;
      const sent = await request('POST', `/v1/workspaces/${workspaceId()}/agents/${agentSelect.value}/conversations/${conv.id}/messages`, {
        body: websitePrompt(title, text),
      }, { 'Idempotency-Key': idempotencyKey('site-msg-') });
      closeSpaceActionDialog();
      if (sent.status !== 201 && sent.status !== 200) {
        show('error', '网站作品已创建，但搭建请求发送失败：' + messageFor(sent.body.error, '请打开对话后重试。'));
      } else {
        show('ok', describeWebsiteDispatch(sent.body.reply || sent.body.message));
      }
      if (catalogScope !== 'all') { catalogScope = 'all'; syncViewUrl(); }
      await loadList();
      if (artifact && artifact.id) openEditor(artifact);
    });
    if (typeof brief.focus === 'function') brief.focus();
  }

  async function openSaveMessageDialog() {
    const workspace = workspaceId();
    if (!workspace) { show('error', '先选择一个工作区。'); return; }
    const ui = openSpaceDialog('save-message-dialog', '保存聊天中的消息');
    const current = () => spaceActionDialog === ui.dialog && workspaceId() === workspace;
    const feedback = text => {
      ui.note.hidden = !text;
      ui.note.textContent = text;
    };
    ui.note.setAttribute('role', 'status');

    const label = document.createElement('label');
    label.textContent = '会话';
    const select = document.createElement('select');
    select.id = 'save-message-conversation';
    select.disabled = true;
    const prompt = document.createElement('option');
    prompt.value = '';
    prompt.textContent = '选择要查看的会话';
    select.append(prompt);
    label.append(select);
    const list = document.createElement('ul');
    list.id = 'save-message-list';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '关闭';
    close.addEventListener('click', closeSpaceActionDialog);
    ui.card.append(label, list, close);
    feedback('正在加载会话…');

    const base = `/v1/workspaces/${workspace}`;
    const get = suffix => request('GET', base + suffix).catch(() => ({status: 0, body: {}}));
    const [social, agents] = await Promise.all([
      get('/social/conversations?limit=100'),
      get('/agents?limit=100&include=conversations'),
    ]);
    if (!current()) return;
    const agentById = new Map((agents.body.items || []).map(agent => [agent.id, agent]));
    const conversations = [
      ...(social.body.items || []).map(row => ({...row, label: conversationLabel(row), social: true})),
      ...(agents.body.conversations || []).filter(row => agentById.has(row.agent_id)).map(row => ({
        ...row, label: agentById.get(row.agent_id).name + ' · ' + row.title,
      })),
    ].sort((a, b) => (b.updated || 0) - (a.updated || 0));
    const incomplete = social.status !== 200 || agents.status !== 200 || !Array.isArray(agents.body.conversations);
    feedback(incomplete ? '部分会话无法加载。' : (conversations.length ? '' : '这个工作区还没有会话。'));
    if (!conversations.length) return;
    conversations.forEach((row, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = row.label;
      select.append(option);
    });
    select.disabled = false;
    select.focus();

    let search = 0;
    select.addEventListener('change', async () => {
      const selected = ++search;
      list.replaceChildren();
      const conversation = conversations[select.value === '' ? -1 : Number(select.value)];
      if (!conversation) { feedback(''); return; }
      feedback('正在加载消息…');
      const path = conversation.social ? `/social/conversations/${conversation.id}/messages?limit=20`
        : `/agents/${conversation.agent_id}/conversations/${conversation.id}`;
      const result = await get(path);
      if (!current() || selected !== search) return;
      if (result.status !== 200) { feedback('无法加载消息，请重试。'); return; }
      const items = (result.body.items || []).filter(conversation.social ? saveableSocialMessage : saveableAgentMessage);
      feedback(items.length ? '' : '这段会话还没有可保存的文字消息。');
      for (const item of items.slice(-20).reverse()) {
        const row = document.createElement('li');
        const preview = document.createElement('span');
        preview.textContent = defaultSaveTitle(item.body);
        const save = document.createElement('button');
        save.type = 'button';
        save.textContent = '保存';
        save.addEventListener('click', async () => {
          const endpoint = conversation.social ? socialSavePath(workspace, conversation.id, item.id)
            : agentSavePath(workspace, conversation.agent_id, conversation.id, item.id);
          const body = {title: preview.textContent};
          if (conversation.social) body.revision = item.revision || 1;
          save.disabled = true;
          feedback('');
          try {
            const saved = await request('POST', endpoint, body);
            if (!current() || selected !== search) return;
            if (saved.status !== 200 && saved.status !== 201) {
              feedback(messageFor(saved.body.error, '保存失败，请重试。'));
              return;
            }
            closeSpaceActionDialog();
            show('ok', saved.status === 201 ? '已保存为文档。' : '已打开已有副本。');
            if (catalogScope !== 'all') { catalogScope = 'all'; syncViewUrl(); }
            await loadList();
            if (workspaceId() === workspace && saved.body.artifact) openEditor(saved.body.artifact);
          } catch {
            if (current() && selected === search) feedback('无法确认保存结果，请重试。');
          } finally {
            save.disabled = false;
          }
        });
        row.append(preview, save);
        list.append(row);
      }
    });
  }


  let agentTaskDialog = null;

  function closeAgentTaskDialog() {
    if (agentTaskDialog && agentTaskDialog.parentNode) agentTaskDialog.parentNode.removeChild(agentTaskDialog);
    agentTaskDialog = null;
    const opener = document.getElementById('empty-save-agent');
    if (opener) opener.disabled = false;
    if (opener && typeof opener.focus === 'function') opener.focus();
  }

  async function openAgentTaskDialog() {
    const opener = document.getElementById('empty-save-agent');
    if (agentTaskDialog) return;
    if (opener) opener.disabled = true;
    const dialog = document.createElement('div');
    dialog.id = 'agent-task-dialog';
    dialog.className = 'send-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'agent-task-title');
    const card = document.createElement('div');
    card.className = 'send-dialog-card';
    const heading = document.createElement('h2');
    heading.id = 'agent-task-title';
    heading.textContent = '保存智能体成果';
    const note = document.createElement('p');
    note.id = 'agent-task-note';
    note.className = 'note';
    note.hidden = true;
    const taskList = document.createElement('ul');
    taskList.id = 'agent-task-list';
    const close = document.createElement('button');
    close.id = 'agent-task-close';
    close.type = 'button';
    close.textContent = '关闭';
    close.addEventListener('click', () => closeAgentTaskDialog());
    card.appendChild(heading);
    card.appendChild(note);
    card.appendChild(taskList);
    card.appendChild(close);
    dialog.appendChild(card);
    const host = mainPanel || listPanel || form.parentNode;
    if (host && typeof host.appendChild === 'function') host.appendChild(dialog);
    else if (form && typeof form.appendChild === 'function') form.appendChild(dialog);
    agentTaskDialog = dialog;
    if (typeof close.focus === 'function') close.focus();

    const listed = await request('GET', '/v1/runtime/tasks');
    if (listed.status !== 200) {
      note.hidden = false;
      note.textContent = taskArtifactError(listed.status, listed.body, '读取任务列表失败。');
      if (opener) opener.disabled = false;
      return;
    }
    const tasks = savableTaskArtifacts(listed.body && listed.body.items);
    if (!tasks.length) {
      note.hidden = false;
      note.textContent = '没有可保存的已完成任务：任务需要有成功的文本结果。';
    }
    for (const task of tasks) {
      const row = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = taskArtifactTitle(task);
      const save = document.createElement('button');
      save.type = 'button';
      save.textContent = '保存';
      save.addEventListener('click', async () => {
        save.disabled = true;
        note.hidden = true;
        const saved = await request('POST', `/v1/runtime/tasks/${task.id}/artifact`, {workspace_id: workspaceId()});
        if (saved.status === 200 || saved.status === 201) {
          closeAgentTaskDialog();
          show('ok', '已保存。');
          if (catalogScope !== 'all') { catalogScope = 'all'; syncViewUrl(); }
          await loadList();
          return;
        }
        save.disabled = false;
        note.hidden = false;
        note.textContent = taskArtifactError(saved.status, saved.body);
      });
      row.appendChild(label);
      row.appendChild(save);
      taskList.appendChild(row);
    }
  }

  document.getElementById('empty-save-agent').addEventListener('click', async () => {
    await openAgentTaskDialog();
  });

  document.getElementById('remove-artifact').addEventListener('click', async () => {
    if (!current || !current.id || !workspaceId()) return;
    const target = await askDeleteConfirmation();
    if (!target) return;
    const result = await request('POST', `/v1/workspaces/${target.workspace}/artifacts/${target.id}/remove`, {});
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '删除失败。'));
      return;
    }
    current = null;
    form.hidden = true;
    listPanel.hidden = false;
    show('ok', '已删除。');
    await loadList();
  });

  const canvas = document.getElementById('board-canvas');
  canvas.addEventListener('pointerdown', event => {
    if (document.getElementById('board-editor').hidden) return;
    event.preventDefault();
    const point = canvasPoint(event);
    const color = document.getElementById('board-color').value || '#111111';
    if (boardTool === 'text') {
      const text = globalThis.prompt('文字', '');
      if (text) {
        boardState.strokes = boardState.strokes.concat([{id: strokeId(), type: 'text', color, x: point[0], y: point[1], size: 16, text: text.slice(0, 200)}]);
        drawBoard();
      }
      return;
    }
    drawing = {id: strokeId(), type: boardTool, color, width: 2, x: point[0], y: point[1], points: [point]};
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', event => {
    if (!drawing) return;
    const point = canvasPoint(event);
    if (drawing.type === 'path') drawing.points.push(point);
    else {
      drawing.width = Math.max(1, point[0] - drawing.x);
      drawing.height = Math.max(1, point[1] - drawing.y);
    }
    const live = boardState.strokes.concat([drawing]);
    const saved = boardState.strokes;
    boardState.strokes = live;
    drawBoard();
    boardState.strokes = saved;
  });
  canvas.addEventListener('pointerup', event => {
    if (!drawing) return;
    const point = canvasPoint(event);
    let stroke = drawing;
    if (drawing.type === 'path') {
      drawing.points.push(point);
      if (drawing.points.length >= 2) stroke = {id: drawing.id, type: 'path', color: drawing.color, width: 2, points: drawing.points};
      else stroke = null;
    } else {
      stroke = {id: drawing.id, type: 'rect', color: drawing.color, x: drawing.x, y: drawing.y, width: Math.max(1, point[0] - drawing.x), height: Math.max(1, point[1] - drawing.y)};
    }
    drawing = null;
    if (stroke) boardState.strokes = boardState.strokes.concat([stroke]);
    drawBoard();
  });
  document.getElementById('board-draw').addEventListener('click', () => { boardTool = 'path'; });
  document.getElementById('board-rect').addEventListener('click', () => { boardTool = 'rect'; });
  document.getElementById('board-text').addEventListener('click', () => { boardTool = 'text'; });
  document.getElementById('board-clear').addEventListener('click', () => {
    boardState.strokes = [];
    drawBoard();
  });

  // The publish controls live inside #editor-form; a nested <form> would be
  // dropped by the HTML parser and close the editor form early, so this is a
  // plain group with a button handler (Enter in the slug field publishes too).
  const publishDiscover = document.getElementById('publish-discover');
  const discoverSlug = document.getElementById('discover-slug');
  if (publishDiscover) {
    if (discoverSlug) discoverSlug.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); publishDiscover.click(); }
    });
    publishDiscover.addEventListener('click', async event => {
      event.preventDefault();
      if (!current || !current.id || !workspaceId()) {
        show('error', '请先保存作品，再发布到发现页。');
        return;
      }
      const slug = (document.getElementById('discover-slug').value || '').trim();
      const result = await request('POST', `/v1/workspaces/${workspaceId()}/artifacts/${current.id}/discover`, {slug});
      if (result.status !== 200 && result.status !== 201) {
        const messages = {
          forbidden: '只有所有者或管理员可以把作品公开到发现页。',
          conflict: '这个短地址已经在用。',
          invalid: '请输入可用的公开短地址。',
        };
        show('error', messages[result.body.error] || messageFor(result.body.error, '无法发布到发现页。'));
        return;
      }
      show('ok', '已公开到发现页。');
      await loadDiscover();
    });
  }
  const revokeDiscover = document.getElementById('revoke-discover');
  if (revokeDiscover) {
    revokeDiscover.addEventListener('click', async () => {
      if (!current || !current.id || !workspaceId()) return;
      const result = await request('POST', `/v1/workspaces/${workspaceId()}/artifacts/${current.id}/discover/revoke`, {});
      if (result.status !== 200) {
        show('error', messageFor(result.body.error, '无法从发现页撤回。'));
        return;
      }
      show('ok', '已从发现页撤回。');
      await loadDiscover();
    });
  }

  document.getElementById('create-share').addEventListener('click', async () => {
    if (!current || !current.id || !workspaceId()) {
      show('error', '请先保存作品，再创建分享链接。');
      return;
    }
    const result = await request('POST', `/v1/workspaces/${workspaceId()}/artifacts/${current.id}/shares`, {});
    if (result.status !== 201) {
      show('error', messageFor(result.body.error, '无法创建分享链接。'));
      return;
    }
    const share = result.body.share || {};
    const once = document.getElementById('share-once');
    once.hidden = false;
    once.textContent = share.path ? ('链接只显示一次：' + share.path) : '链接已创建，请立即复制。';
    show('ok', '已创建只读分享链接，完整地址只显示这一次。');
    await loadShares();
  });

  document.getElementById('export-artifact').addEventListener('click', () => {
    if (!current || !current.id || !workspaceId()) {
      show('error', '请先保存作品，再导出。');
      return;
    }
    const format=document.getElementById('export-format')?.value||'original';
    if((format==='docx'&&current.kind!=='document')||(format==='xlsx'&&!['dashboard','spreadsheet'].includes(current.kind))||(format==='pdf'&&!['document','slides','dashboard'].includes(current.kind))){
      show('error','此格式不支持当前作品类型；请按格式说明选择，或使用原格式。');return;
    }
    globalThis.location.assign(exportHref());
  });

  document.getElementById('logout-form').addEventListener('submit', async event => {
    event.preventDefault();
    const result = await request('POST', '/v1/auth/logout', {});
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '退出失败。'));
      return;
    }
    current = null;
    await load();
  });

  const view = document.defaultView;
  const initial = viewFromSearch(view && view.location && view.location.search);
  applyView(initial.kind, initial.scope, {sync: false});
  if (view) {
    view.addEventListener('popstate', () => {
      const next = viewFromSearch(view.location.search);
      applyView(next.kind, next.scope, {sync: false});
      void loadList();
    });
  }
  return load();

}

if (globalThis.document && globalThis.document.getElementById('editor-form')) {
  mount(globalThis.document);
}
