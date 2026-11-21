export const CATEGORIES = [
  {id: 'all', label: '全部'},
  {id: 'chat', label: '聊天'},
  {id: 'agents', label: '智能体'},
  {id: 'discover', label: '发现'},
  {id: 'automations', label: '自动化'},
  {id: 'memory', label: '记忆'},
  {id: 'artifacts', label: 'Artifacts'},
  {id: 'me', label: '我'},
  {id: 'settings', label: '设置'},
  {id: 'account-menu', label: '头像菜单'},
  {id: 'calls', label: '通话窗口'},
  {id: 'other', label: '其他'},
];

// OpenTeamily's own catalog. Do not copy Teamily guide prose or its 295-item counts.
export const CATALOG = [
  {id: 'open-chat', category: 'chat', title: '打开聊天', body: '在左侧应用栏打开「聊天」，查看已经统一的会话列表。人与智能体的会话在同一页，不是单独的消息页。', path: ['应用栏', '聊天'], href: '/chat'},
  {id: 'conversation-search', category: 'chat', title: '会话内搜索', body: '在打开的会话标题栏里搜索当前会话中的已授权消息。这不是全站搜索面板。', path: ['聊天', '会话标题栏', '搜索'], href: '/chat'},
  {id: 'send-shortcut', category: 'chat', title: '发送快捷键', body: '在设置里选择用 Enter 还是 Ctrl+Enter 发送消息。换行键会随这项自动互补显示。', path: ['设置', '发送快捷键'], href: '/settings#send-shortcut'},
  {id: 'chat-previews', category: 'chat', title: '会话列表预览', body: '会话列表会显示该会话最近一条已授权消息的摘要，方便扫读。', path: ['聊天', '会话列表'], href: '/chat'},
  {id: 'open-agents', category: 'agents', title: '打开智能体', body: '在「智能体」页管理本工作区的智能体，包括创建和对话入口。', path: ['应用栏', '智能体'], href: '/agents'},
  {id: 'agent-homepage', category: 'agents', title: '公开主页', body: '可以把智能体发布为可撤销的公开主页，或随时撤回。', path: ['智能体', '公开主页'], href: '/agents'},
  {id: 'discover-feed', category: 'discover', title: '关注与动态', body: '「发现」默认是关注和动态布局。这是 OpenTeamily 自己的信息流页，不是 Teamily 的完整推荐实现。', path: ['应用栏', '发现'], href: '/discover'},
  {id: 'discover-catalog', category: 'discover', title: '发现里的智能体目录', body: '打开发现页的智能体目录，浏览可收录的公开智能体。会创建会话的「聊天」入口仍标明未接通。', path: ['发现', '智能体'], href: '/discover?tab=agents'},
  {id: 'open-automations', category: 'automations', title: '打开自动化', body: '在「自动化」页查看工作/生活模板和已有自动化。创建或运行仍须按现有表单，不在指引里代为执行。', path: ['应用栏', '自动化'], href: '/automations'},
  {id: 'memory-overview', category: 'memory', title: '记忆总览', body: '记忆页左侧是目录，中间是图谱，右侧是话题和最近更新。新建记忆页会立即落盘。', path: ['应用栏', '记忆'], href: '/memory'},
  {id: 'memory-profile', category: 'memory', title: '我的资料', body: '记忆里的「我的资料」已摆出三个小节标题。画像正文还没有接口，不能在这里保存对照账户里的内容。', path: ['记忆', '我的资料'], href: '/memory?page=profile'},
  {id: 'memory-actions', category: 'memory', title: '下一步行动', body: '查看下一步行动。空态时只显示说明；「新建行动」才会打开已有的表单。', path: ['记忆', '下一步行动'], href: '/memory?page=todos'},
  {id: 'memory-dir-collapse', category: 'memory', title: '收起记忆目录', body: '在「记忆」标题旁可以收起或展开左侧目录。收起只对当前会话有效，对照里没有收起后的版式实图。', path: ['记忆', '收起侧边栏'], href: '/memory'},
  {id: 'space-library', category: 'artifacts', title: '资料空间', body: '「作品」打开资料空间，可按类型和范围浏览。空态文案和筛选已按记录摆出；有作品时的网格还没有对照实图。', path: ['应用栏', '作品'], href: '/space'},
  {id: 'space-filters', category: 'artifacts', title: '筛选作品', body: '打开筛选面板，查看文件类型、修改时间、创建人和来源会话。来源会话会列出已有会话标题。', path: ['资料空间', '筛选'], href: '/space'},
  {id: 'space-dir-collapse', category: 'artifacts', title: '收起资料目录', body: '在「资料空间」标题旁可以收起或展开左侧目录。收起只对当前会话有效。', path: ['资料空间', '收起侧边栏'], href: '/space'},
  {id: 'open-profile', category: 'me', title: '查看我的资料', body: '「我」打开当前账户页，目前只显示用户名。更换头像、简介、标签和删除账户仍标明未实现。', path: ['应用栏', '我'], href: '/profile'},
  {id: 'settings-hub', category: 'settings', title: '所有设置', body: '打开设置总览，进入语言、外观、渠道、运行时和偏好等已有页面。用量、升级和积分按产品决定不做。', path: ['账户菜单', '所有设置'], href: '/settings'},
  {id: 'settings-appearance', category: 'settings', title: '外观', body: '选择浅色、深色、自动或跟随系统。自动切换的真实日出日落时刻仍明确未计算。', path: ['设置', '外观'], href: '/settings#appearance'},
  {id: 'settings-language', category: 'settings', title: '语言', body: '设置系统语言、聊天语言，以及是否自动翻译消息。', path: ['设置', '语言'], href: '/settings#language-section'},
  {id: 'settings-folding', category: 'settings', title: '消息折叠', body: '选择长消息预览长度，以及是否把长文档收成卡片。', path: ['设置', '消息折叠'], href: '/settings#message-display'},
  {id: 'settings-privacy', category: 'settings', title: '隐私设置', body: '控制点赞列表和收藏列表是否对他人可见。未改动时「保存更改」保持禁用。', path: ['设置', '隐私设置'], href: '/settings#privacy'},
  {id: 'settings-runtimes', category: 'settings', title: '运行时', body: '查看托管项、本机运行时和连接一台机器。托管云端 Agent 和托管电脑仍标明未接通。', path: ['设置', '运行时'], href: '/runtimes'},
  {id: 'account-menu', category: 'account-menu', title: '打开账户菜单', body: '点击应用栏底部的账户按钮，查看资料、创建团队、帮助和退出登录。积分和套餐入口不会出现。', path: ['应用栏', '账户'], href: '/chat'},
  {id: 'create-team', category: 'account-menu', title: '创建团队', body: '从账户菜单打开创建团队向导。填写和提交前请先确认，指引页不会代为创建。', path: ['账户菜单', '创建团队'], href: '/team'},
  {id: 'download-runtime', category: 'other', title: '下载', body: '下载页提供网页管理面说明和 flybot.pyz 运行时。没有 OpenTeamily 的官方 iOS、Android、macOS 或 Windows 客户端。', path: ['应用栏', '下载'], href: '/download'},
];

export function categoryLabel(id) {
  const found = CATEGORIES.find((item) => item.id === id);
  return found ? found.label : id;
}

export function countByCategory(items = CATALOG) {
  const counts = {all: items.length};
  for (const category of CATEGORIES) {
    if (category.id === 'all') continue;
    counts[category.id] = items.filter((item) => item.category === category.id).length;
  }
  return counts;
}

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

export function filterCatalog(items, {category = 'all', query = ''} = {}) {
  const needle = normalize(query);
  const source = category && category !== 'all'
    ? items.filter((item) => item.category === category)
    : items.slice();
  if (!needle) return source;
  return source.filter((item) => {
    const haystack = [
      item.title,
      item.body,
      categoryLabel(item.category),
      ...(item.path || []),
    ].join(' ');
    return normalize(haystack).includes(needle);
  });
}

// An empty category is not a failed search: name whichever one the user is
// looking at, and say nothing when there is something to list.
export function emptyGuideMessage(items, query) {
  if (items.length > 0) return '';
  return normalize(query) ? '没有匹配的条目。换个词，或按 Esc 清空搜索。' : '这一类还没有指引。';
}

// Split guide text into the runs that match the keyword so the page can mark
// them. Case-insensitive and length-preserving: joining the segments always
// gives the original text back, and an unknown keyword marks nothing.
export function highlightSegments(text, query) {
  const source = String(text || '');
  const needle = normalize(query);
  if (!source) return [];
  if (!needle) return [{text: source, match: false}];
  const haystack = source.toLowerCase();
  const segments = [];
  let start = 0;
  let hit = haystack.indexOf(needle);
  while (hit !== -1) {
    if (hit > start) segments.push({text: source.slice(start, hit), match: false});
    segments.push({text: source.slice(hit, hit + needle.length), match: true});
    start = hit + needle.length;
    hit = haystack.indexOf(needle, start);
  }
  if (start < source.length) segments.push({text: source.slice(start), match: false});
  return segments;
}


export function groupCatalog(items) {
  const groups = [];
  const index = new Map();
  for (const item of items) {
    let group = index.get(item.category);
    if (!group) {
      group = {id: item.category, label: categoryLabel(item.category), items: []};
      index.set(item.category, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

export function formatPath(path) {
  return (path || []).join(' › ');
}

// The page an entry sends the reader to. Empty when an entry has no page yet,
// which the dialog renders as text only.
export function dialogHref(item) {
  const href = item && typeof item.href === 'string' ? item.href : '';
  return /^\/[a-z-]*(?:\?[a-z=_-]+)?(?:#[a-z-]+)?$/.test(href) ? href : '';
}

// One honest line per group: what works on this instance today, and where it
// stops. Nothing here may promise future work.
export const GROUP_NOTES = Object.freeze({
  chat: '现在能做什么：应用栏打开「聊天」，会话列表、会话内搜索、Enter 或 Ctrl+Enter 发送都在这一页。已知边界：这里是人与智能体共用的会话页，不是全站搜索面板。',
  agents: '现在能做什么：智能体页列出本工作区的智能体，能创建，也能打开公开主页。已知边界：没接通的入口在页面里直接标着「未接通」。',
  discover: '现在能做什么：发现页的动态流、关注、收录、点赞，以及?tab=agents 的智能体目录。已知边界：推荐排序不是 Teamily 的完整实现。',
  automations: '现在能做什么：自动化页有模板、列表、编辑表单和运行记录。已知边界：运行结果来自已连接的运行时，没有运行时运行会停在「等待已连接的代理」。',
  memory: '现在能做什么：记忆页有目录、图谱、最近更新，?page=profile 与 ?page=todos 直达两个子页。已知边界：画像正文还没有接口。',
  artifacts: '现在能做什么：作品页按类型和范围浏览，打开筛选面板筛文件类型、时间、创建人和来源会话。已知边界：有作品时的网格版式还没有对照实图。',
  me: '现在能做什么：我的资料显示当前用户名。已知边界：头像、简介、标签和删除账户仍未实现。',
  settings: '现在能做什么：设置页的外观、语言、发送快捷键、消息折叠、隐私和模型接口都能保存。已知边界：用量、套餐、积分按产品决定不做。',
  'account-menu': '现在能做什么：应用栏底部的账户按钮里有资料、创建团队、帮助、所有设置和退出登录。已知边界：帮助中心、服务条款、隐私政策三个按钮仍是置灰的。',
  calls: '现在能做什么：暂无条目。已知边界：通话窗口没有在本实例实现。',
  other: '现在能做什么：下载页说明网页版和 flybot.pyz 运行时的安装方式。已知边界：没有官方 iOS、Android、macOS 或 Windows 客户端。',
});

export function groupNoteText(categoryId) {
  return GROUP_NOTES[categoryId] || '';
}

// Deep link only: /guide?q=<keyword>, /guide?category=<id>, or both. An empty
// keyword and the 全部 category both go back to a bare /guide, and an unknown
// category id reads as 全部 instead of inventing an empty category.
export function categorySlug(value) {
  const id = String(value || '');
  return CATEGORIES.some((category) => category.id === id) ? id : 'all';
}

export function guideHref(value, category = 'all') {
  const keyword = String(value || '').trim();
  const slug = categorySlug(category);
  const params = new URLSearchParams();
  if (slug !== 'all') params.set('category', slug);
  if (keyword) params.set('q', keyword);
  const search = params.toString();
  return search ? `/guide?${search}` : '/guide';
}

export function guideInitialQuery(search) {
  return new URLSearchParams(search || '').get('q') || '';
}

export function guideInitialCategory(search) {
  return categorySlug(new URLSearchParams(search || '').get('category'));
}

function csrfCookie(source) {
  const match = /(?:^|;\s*)(?:__Host-ot_csrf|ot_dev_csrf)=([^;]+)/.exec(source || '');
  return match ? decodeURIComponent(match[1]) : '';
}

function messageFor(error, fallback) {
  if (error && error.message) return error.message;
  return fallback;
}

async function request(method, path, body) {
  const headers = {Accept: 'application/json'};
  const options = {method, headers, credentials: 'same-origin'};
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['X-CSRF-Token'] = csrfCookie(document.cookie);
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  const payload = await response.json();
  return {status: response.status, body: payload};
}

function iconNode() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('d', 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zm0 2a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm-1 3h2v5h-2V8zm0 6h2v2h-2v-2z');
  svg.append(path);
  return svg;
}

function mount() {
  const status = document.getElementById('status');
  const loginPanel = document.getElementById('login-panel');
  const mainPanel = document.getElementById('main-panel');
  const whoami = document.getElementById('whoami');
  const form = document.getElementById('login-form');
  const categoriesEl = document.getElementById('guide-categories');
  const listEl = document.getElementById('guide-list');
  const countEl = document.getElementById('guide-count');
  const emptyEl = document.getElementById('guide-empty');
  const searchEl = document.getElementById('guide-search');
  const dialog = document.getElementById('guide-dialog');
  const dialogTitle = document.getElementById('guide-dialog-title');
  const dialogBody = document.getElementById('guide-dialog-body');
  const dialogPath = document.getElementById('guide-dialog-path');
  const dialogClose = document.getElementById('guide-dialog-close');
  if (!status || !loginPanel || !mainPanel || !form || !categoriesEl || !listEl) return;

  let currentCategory = guideInitialCategory(globalThis.location ? globalThis.location.search : '');
  let currentItemId = '';

  function show(kind, text) {
    status.dataset.kind = kind;
    status.textContent = text;
  }

  function closeDialog() {
    if (!dialog) return;
    dialog.hidden = true;
    currentItemId = '';
    for (const button of listEl.querySelectorAll('.guide-item')) {
      button.removeAttribute('aria-current');
    }
  }

  // Mark the searched runs with <mark> elements and plain text nodes; the page
  // never writes markup into the document, so a keyword can only ever be text.
  function fillHighlighted(node, text, query) {
    const parts = [];
    for (const segment of highlightSegments(text, query)) {
      if (!segment.text) continue;
      if (segment.match) {
        const mark = document.createElement('mark');
        mark.textContent = segment.text;
        parts.push(mark);
      } else {
        parts.push(document.createTextNode(segment.text));
      }
    }
    node.replaceChildren(...parts);
  }

  function openDialog(item) {
    if (!dialog || !dialogTitle || !dialogBody || !dialogPath) return;
    const query = searchEl ? searchEl.value : '';
    currentItemId = item.id;
    fillHighlighted(dialogTitle, item.title, query);
    fillHighlighted(dialogBody, item.body, query);
    dialogPath.textContent = formatPath(item.path);
    const target = document.getElementById('guide-dialog-open');
    if (target) {
      const href = dialogHref(item);
      if (href) {
        target.href = href;
        target.textContent = `去这里：${item.title}`;
        target.hidden = false;
      } else {
        target.removeAttribute('href');
        target.hidden = true;
      }
    }
    dialog.hidden = false;
    if (dialogClose) dialogClose.focus();
    renderList();
  }

  function renderCategories() {
    const counts = countByCategory(CATALOG);
    categoriesEl.replaceChildren();
    for (const category of CATEGORIES) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'guide-category';
      button.dataset.category = category.id;
      if (category.id === currentCategory) button.setAttribute('aria-current', 'true');
      const icon = document.createElement('span');
      icon.className = 'cat-icon';
      icon.append(iconNode());
      const label = document.createElement('span');
      label.className = 'cat-label';
      label.textContent = category.label;
      const count = document.createElement('span');
      count.className = 'cat-count';
      count.textContent = String(counts[category.id] || 0);
      button.append(icon, label, count);
      button.addEventListener('click', () => {
        currentCategory = category.id;
        closeDialog();
        render();
        syncQuery(searchEl ? searchEl.value : '');
      });
      categoriesEl.append(button);
    }
  }

  function renderList() {
    const query = searchEl ? searchEl.value : '';
    const items = filterCatalog(CATALOG, {
      category: currentCategory,
      query,
    });
    if (countEl) countEl.textContent = `当前显示 ${items.length} 条`;
    if (emptyEl) {
      emptyEl.hidden = items.length > 0;
      emptyEl.textContent = emptyGuideMessage(items, query);
    }
    listEl.replaceChildren();
    for (const group of groupCatalog(items)) {
      const section = document.createElement('section');
      section.className = 'guide-group';
      const heading = document.createElement('h2');
      heading.className = 'guide-group-title';
      heading.textContent = group.label;
      section.append(heading);
      const note = groupNoteText(group.id);
      if (note) {
        const copy = document.createElement('p');
        copy.className = 'guide-group-note';
        copy.dataset.category = group.id;
        copy.textContent = note;
        section.append(copy);
      }
      for (const item of group.items) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'guide-item';
        button.dataset.itemId = item.id;
        if (item.id === currentItemId) button.setAttribute('aria-current', 'true');
        const icon = document.createElement('span');
        icon.className = 'item-icon';
        icon.append(iconNode());
        const title = document.createElement('span');
        fillHighlighted(title, item.title, query);
        button.append(icon, title);
        button.addEventListener('click', () => openDialog(item));
        section.append(button);
      }
      listEl.append(section);
    }
  }

  function render() {
    renderCategories();
    renderList();
  }

  function syncQuery(value) {
    const location = globalThis.location;
    const history = globalThis.history;
    if (!location || !history || typeof history.replaceState !== 'function') return;
    const href = guideHref(value, currentCategory);
    if (location.pathname + location.search === href) return;
    history.replaceState(null, '', href);
  }

  if (searchEl) {
    searchEl.value = guideInitialQuery(globalThis.location ? globalThis.location.search : '');
    searchEl.addEventListener('input', () => {
      closeDialog();
      renderList();
      syncQuery(searchEl.value);
    });
  }
  if (dialogClose) dialogClose.addEventListener('click', closeDialog);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (dialog && !dialog.hidden) {
      event.preventDefault();
      closeDialog();
      return;
    }
    if (searchEl && searchEl.value) {
      event.preventDefault();
      searchEl.value = '';
      renderList();
      syncQuery('');
      searchEl.focus();
    }
  });

  async function load() {
    const session = await request('GET', '/v1/auth/session');
    if (session.status === 401) {
      loginPanel.hidden = false;
      mainPanel.hidden = true;
      closeDialog();
      show('', '');
      return;
    }
    if (session.status !== 200 || !session.body.user) {
      show('error', messageFor(session.body && session.body.error, '无法读取会话。'));
      return;
    }
    const username = session.body.user.username;
    loginPanel.hidden = true;
    mainPanel.hidden = false;
    if (whoami) {
      whoami.dataset.username = username;
      whoami.textContent = username;
    }
    render();
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const result = await request('POST', '/v1/auth/login', {
      username: form.elements.username.value,
      password: form.elements.password.value,
    });
    if (result.status !== 200) {
      show('error', messageFor(result.body && result.body.error, '无法登录。'));
      return;
    }
    form.reset();
    await load();
  });

  const logout = document.getElementById('logout-form');
  if (logout) {
    logout.addEventListener('submit', async (event) => {
      event.preventDefault();
      const result = await request('POST', '/v1/auth/logout', {});
      if (result.status !== 200 && result.status !== 204) {
        show('error', messageFor(result.body && result.body.error, '无法退出登录。'));
        return;
      }
      show('ok', '已退出登录。');
      await load();
    });
  }

  load();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
}
