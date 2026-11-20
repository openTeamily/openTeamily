function csrfCookie(source) {
  const match = /(?:^|;\s*)(?:__Host-ot_csrf|ot_dev_csrf)=([^;]+)/.exec(source || '');
  return match ? decodeURIComponent(match[1]) : '';
}

function messageFor(error, fallback) {
  if (error && error.message) return error.message;
  return fallback;
}

async function request(method, path, body) {
  const headers = { Accept: 'application/json' };
  const options = { method, headers, credentials: 'same-origin' };
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

const LOOK_LABELS = {color: '颜色', expression: '表情', headwear: '头饰', glasses: '眼镜', hand: '手持'};

// Composio toolkit slugs for the step-2 catalog in openteamily/onboarding.py.
// The catalog uses dashed ids; Composio does not, so the mapping is explicit
// instead of guessed from the display name.
const TOOLKITS = {
  gmail: 'gmail', outlook: 'outlook', 'google-calendar': 'googlecalendar', github: 'github',
  'google-drive': 'googledrive', notion: 'notion', 'google-sheets': 'googlesheets', 'google-docs': 'googledocs',
};

// The words for one app row come from the real read, never from a constant.
// `readable: false` means the connection list could not be read (no Composio
// key of the user's own, or another refusal): that row says 未接入, because
// claiming 未连接 would assert something about an app nobody asked.
export function appConnectionState(app, {connections = [], readable = true, sync = 'ok'} = {}) {
  if (!readable) {
    return {state: 'unknown', label: '未接入', connected: false,
            title: '还没有配置你自己的 Composio key，读不到这个应用的连接状态'};
  }
  if (sync === 'failed') {
    return {state: 'unknown', label: '状态未知', connected: false,
            title: 'Composio 同步失败，这次读到的连接状态不可信'};
  }
  const slug = TOOLKITS[app.key] || String(app.key || '');
  const rows = (connections || []).filter(row => row && String(row.toolkit || '').toLowerCase() === slug);
  if (rows.some(row => row.state === 'connected')) {
    return {state: 'connected', label: '已连接', connected: true, title: '这个应用已经有真实的连接'};
  }
  if (rows.some(row => row.state === 'connecting')) {
    return {state: 'connecting', label: '连接中', connected: false, title: '授权流程还没有完成'};
  }
  if (rows.some(row => row.state === 'inactive')) {
    return {state: 'inactive', label: '已停用', connected: false, title: '连接存在但已停用，需要重新授权'};
  }
  if (rows.some(row => row.state === 'failed')) {
    return {state: 'failed', label: '连接失败', connected: false, title: '上次授权失败，需要重新连接'};
  }
  return {state: 'unconnected', label: '未连接', connected: false, title: '还没有这个应用的连接'};
}

// What the workspace already has, said in one line instead of "everything is
// unconnected". Empty string when the reads returned nothing to report.
export function realitySummary({agents = 0, runtimes = 0, online = 0} = {}) {
  const parts = [];
  if (agents > 0) parts.push(`${agents} 个智能体`);
  if (runtimes > 0) parts.push(online > 0 ? `${online} 个运行时连接在线` : `${runtimes} 个运行时连接（都不在线）`);
  if (!parts.length) return '';
  return '你的工作区已经有 ' + parts.join('，') + '。';
}


const TILE_TONES = 6;

export function tileTone(text) {
  let hash = 0;
  for (const ch of String(text || '')) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return String((hash % TILE_TONES) + 1);
}

export function stepLabel(step) {
  return `第 ${step} 步，共 4 步`;
}

export function lookSummary(look) {
  if (!look) return '还没有选择形象。';
  return Object.keys(LOOK_LABELS).map(name => `${LOOK_LABELS[name]}：${look[name]}`).join(' · ');
}

function mount() {
  const status = document.getElementById('status');
  const loginPanel = document.getElementById('login-panel');
  const mainPanel = document.getElementById('main-panel');
  const form = document.getElementById('onboarding-form');
  const select = document.getElementById('industry');
  const roleChoices = document.getElementById('role-choices');
  const roleLocked = document.getElementById('role-locked');
  const customIndustryLabel = document.getElementById('custom-industry-label');
  const customIndustry = document.getElementById('custom-industry');
  const customRoleLabel = document.getElementById('custom-role-label');
  const customRole = document.getElementById('custom-role');
  if (!status || !loginPanel || !mainPanel || !form) return;
  let industries = [];
  let current = null;

  function show(kind, text) {
    status.dataset.kind = kind;
    status.textContent = text;
  }

  function populateIndustries() {
    select.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '选择你的行业';
    select.append(placeholder);
    for (const row of industries) {
      const option = document.createElement('option');
      option.value = row.name;
      option.textContent = row.name;
      select.append(option);
    }
    renderIndustryCards();
  }

  function renderIndustryCards() {
    const holder = document.getElementById('industry-cards');
    if (!holder) return;
    holder.replaceChildren();
    for (const row of industries) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'choice-card';
      card.setAttribute('role', 'radio');
      card.dataset.value = row.name;
      card.setAttribute('aria-checked', String(select.value === row.name));
      const tile = document.createElement('span');
      tile.className = 'choice-tile';
      tile.dataset.tone = tileTone(row.name);
      tile.setAttribute('aria-hidden', 'true');
      tile.textContent = Array.from(row.name)[0] || '?';
      const name = document.createElement('span');
      name.className = 'choice-name';
      name.textContent = row.name;
      card.append(tile, name);
      card.addEventListener('click', () => {
        select.value = row.name;
        select.dispatchEvent(new Event('change'));
      });
      holder.append(card);
    }
  }

  function syncIndustryCards() {
    for (const card of document.querySelectorAll('#industry-cards .choice-card')) {
      card.setAttribute('aria-checked', String(card.dataset.value === select.value));
    }
  }

  let step = 1;
  function goStep(next) {
    step = next;
    form.hidden = next !== 1;
    const section = document.getElementById('onboarding-steps');
    if (section) section.hidden = next === 1;
    for (const part of document.querySelectorAll('#onboarding-steps .onboarding-step')) {
      part.hidden = Number(part.dataset.step) !== next;
    }
    const label = document.getElementById('onboarding-step-label');
    if (label) label.textContent = stepLabel(next);
    for (const bar of document.querySelectorAll('.onboarding-progress li')) {
      bar.dataset.done = String(Number(bar.dataset.bar) <= next);
    }
  }
  for (const button of document.querySelectorAll('#onboarding-steps [data-go]')) {
    button.addEventListener('click', () => goStep(Number(button.dataset.go)));
  }

  function renderRoles() {
    const name = select.value;
    const row = industries.find(item => item.name === name);
    roleChoices.replaceChildren();
    syncIndustryCards();
    customIndustryLabel.hidden = name !== '其他';
    customRoleLabel.hidden = true;
    roleLocked.hidden = Boolean(name);
    if (!name) return;
    const roles = row ? row.roles : [];
    const values = new Set(roles);
    for (const role of roles) {
      const label = document.createElement('label');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'role';
      radio.value = role;
      radio.addEventListener('change', () => {
        customRoleLabel.hidden = radio.value !== '其他';
        if (radio.value === '其他') customRole.focus();
      });
      const tile = document.createElement('span');
      tile.className = 'choice-tile';
      tile.dataset.tone = tileTone(role);
      tile.setAttribute('aria-hidden', 'true');
      tile.textContent = Array.from(role)[0] || '?';
      const name = document.createElement('span');
      name.className = 'choice-name';
      name.textContent = role;
      label.className = 'choice-card';
      label.append(radio, tile, name);
      roleChoices.append(label);
    }
    if (!roles.length) {
      customRoleLabel.hidden = false;
      return;
    }
    if (current && current.industry === name && current.role) {
      if (values.has(current.role)) {
        const radio = roleChoices.querySelector('input[name="role"][value="' + CSS.escape(current.role) + '"]');
        if (radio) radio.checked = true;
        customRoleLabel.hidden = current.role !== '其他';
      } else {
        customRoleLabel.hidden = false;
        customRole.value = current.role;
      }
    }
  }

  function chosenRole() {
    const checked = roleChoices.querySelector('input[name="role"]:checked');
    if (checked) return checked.value === '其他' ? customRole.value.trim() : checked.value;
    return customRole.value.trim();
  }

  function fill(state) {
    current = state;
    select.value = state && state.industry && industries.some(item => item.name === state.industry)
      ? state.industry : (state && state.industry ? '其他' : '');
    if (select.value === '其他' && state && state.industry && state.industry !== '其他') {
      customIndustry.value = state.industry;
    }
    customRole.value = state && state.role || '';
    renderRoles();
    const meta = document.getElementById('onboarding-meta');
    if (state && state.completed) {
      meta.textContent = '已完成' + (state.industry ? ' · ' + state.industry + (state.role ? ' · ' + state.role : '') : '') + '，可随时修改。';
    } else {
      meta.textContent = '';
    }
  }

  function renderChecklist(steps) {
    const list = document.getElementById('onboarding-checklist');
    if (!list) return;
    list.replaceChildren();
    for (const [index, step] of steps.entries()) {
      const row = document.createElement('li');
      row.dataset.state = step.state;
      row.className = step.state === 'done' ? 'note' : '';
      const mark = document.createElement('span');
      mark.setAttribute('aria-hidden', 'true');
      mark.textContent = step.state === 'done' ? '✓ ' : (index + 1) + '. ';
      const label = document.createElement('strong');
      label.textContent = step.title;
      row.append(mark, label, document.createTextNode(' — ' + step.detail));
      list.append(row);
    }
    const ready = document.getElementById('onboarding-ready');
    if (!ready) return;
    const done = steps.every(step => step.state === 'done');
    ready.hidden = !done;
    if (!done) {
      ready.replaceChildren();
      return;
    }
    const link = document.createElement('a');
    link.setAttribute('href', '/chat');
    link.setAttribute('role', 'button');
    link.textContent = '去聊天';
    ready.replaceChildren(document.createTextNode('可以开始了：'), link);
  }

  async function judgeAgents(step, spaces) {
    let total = 0;
    let firstName = '';
    let failed = false;
    for (const space of spaces) {
      const agents = await request('GET', '/v1/workspaces/' + space.id + '/agents?limit=100');
      if (agents.status !== 200) {
        failed = true;
        continue;
      }
      const items = agents.body.items || [];
      total += items.length;
      if (!firstName && items.length && items[0].name) firstName = items[0].name;
    }
    if (total) {
      step.state = 'done';
      step.detail = '已有 ' + total + ' 个智能体' + (firstName ? '，其中「' + firstName + '」' : '') + '。';
    } else if (failed) {
      step.state = 'unknown';
      step.detail = '读取智能体失败，暂时无法判断。';
    } else {
      step.state = 'pending';
      step.detail = '还没有智能体：到智能体页创建一个。';
    }
  }

  async function judgeAutomations(step, spaces) {
    let automations = 0;
    let runsKnown = false;
    let ran = false;
    let listFailed = false;
    let runFailed = false;
    for (const space of spaces) {
      const listed = await request('GET', '/v1/workspaces/' + space.id + '/automations');
      if (listed.status !== 200) {
        listFailed = true;
        continue;
      }
      const items = listed.body.items || [];
      automations += items.length;
      for (const item of items) {
        const runs = await request('GET', '/v1/workspaces/' + space.id + '/automations/' + item.id + '/runs?limit=20');
        if (runs.status !== 200) {
          runFailed = true;
          continue;
        }
        runsKnown = true;
        if ((runs.body.items || []).some(run => run.status === 'succeeded' || run.status === 'failed')) {
          ran = true;
        }
      }
      if (ran) break;
    }
    if (ran) {
      step.state = 'done';
      step.detail = '已经有自动化执行记录。';
    } else if (!automations) {
      if (listFailed) {
        step.state = 'unknown';
        step.detail = '读取自动化失败，暂时无法判断。';
      } else {
        step.state = 'pending';
        step.detail = '还没有自动化：到自动化页创建一条。';
      }
    } else if (!runsKnown && runFailed) {
      step.state = 'unknown';
      step.detail = '读取运行记录失败，暂时无法判断。';
    } else {
      step.state = 'pending';
      step.detail = '自动化还没有执行过：到自动化页跑一次。';
    }
  }

  async function judgeRuntime(step) {
    const runtimes = await request('GET', '/v1/runtime/connections');
    if (runtimes.status !== 200) {
      step.detail = '读取运行时失败，暂时无法判断。';
      return;
    }
    const items = runtimes.body.items || [];
    const online = items.filter(item => item.status === 'online').length;
    if (online) {
      step.state = 'done';
      step.detail = '已有 ' + online + ' 个运行时在线。';
    } else if (items.length) {
      step.state = 'pending';
      step.detail = '运行时当前离线：重新启动它就能继续。';
    } else {
      step.state = 'pending';
      step.detail = '还没有连接运行时：到运行时页按提示连接。';
    }
  }

  async function judgeChecklist(steps) {
    const listed = await request('GET', '/v1/workspaces?limit=100');
    const spaces = listed.status === 200 ? (listed.body.items || []) : [];
    if (listed.status !== 200) {
      steps[0].detail = '读取工作区失败，需要登录一个有权限的账号才能判断。';
      steps[2].detail = '读取工作区失败，需要登录一个有权限的账号才能判断。';
    } else if (!spaces.length) {
      steps[0].detail = '需要你先创建工作区才能判断。';
      steps[2].detail = '需要你先创建工作区才能判断。';
    } else {
      // Every workspace counts: a second workspace may hold the agent and the
      // finished run, so judging only the first one would report "还没有" for a
      // user who already has them.
      await judgeAgents(steps[0], spaces);
      await judgeAutomations(steps[2], spaces);
    }
    await judgeRuntime(steps[1]);
  }

  async function loadChecklist() {
    const steps = [
      {title: '建智能体', state: 'unknown', detail: ''},
      {title: '连运行时', state: 'unknown', detail: ''},
      {title: '跑一次自动化', state: 'unknown', detail: ''},
    ];
    try {
      await judgeChecklist(steps);
    } catch {
      // A thrown request must not leave the block blank: keep the three rows,
      // say why they are unknown, and never tick them. A transport failure also
      // means later requests cannot be trusted, so nothing else is judged here.
      for (const step of steps) {
        if (step.state === 'done') continue;
        step.state = 'unknown';
        if (!step.detail) step.detail = '读取时出错，暂时无法判断。';
      }
    }
    renderChecklist(steps);
  }

  async function load() {
    const session = await request('GET', '/v1/auth/session');
    if (session.status === 401) {
      loginPanel.hidden = false;
      mainPanel.hidden = true;
      show('', '');
      return;
    }
    if (session.status !== 200 || !session.body.user) {
      show('error', messageFor(session.body && session.body.error, '无法读取会话。'));
      return;
    }
    loginPanel.hidden = true;
    mainPanel.hidden = false;
    document.getElementById('whoami').textContent = session.body.user.username;
    document.getElementById('whoami').dataset.username = session.body.user.username;
    await loadChecklist();
    const result = await request('GET', '/v1/onboarding');
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法读取工作背景。'));
      return;
    }
    industries = result.body.industries || [];
    populateIndustries();
    fill(result.body.onboarding);
    await renderSteps(result.body.steps, result.body.onboarding);
    const ready = document.getElementById('onboarding-ready-name');
    if (ready) ready.textContent = session.body.user.username + '，';
    goStep(step);
  }

  async function readReality() {
    const out = {agents: 0, runtimes: 0, online: 0, connections: [], readable: true, sync: 'ok'};
    const spaces = await request('GET', '/v1/workspaces?limit=100');
    const workspace = spaces.status === 200 ? (spaces.body.items || [])[0] : null;
    if (workspace) {
      const listed = await request('GET', `/v1/workspaces/${workspace.id}/agents?limit=100`);
      if (listed.status === 200) out.agents = (listed.body.items || []).length;
    }
    const runtimes = await request('GET', '/v1/runtime/connections');
    if (runtimes.status === 200) {
      const items = runtimes.body.items || [];
      out.runtimes = items.length;
      out.online = items.filter(item => item && item.status === 'online').length;
    }
    const listed = await request('GET', '/v1/composio/connections');
    if (listed.status === 200) {
      out.connections = listed.body.items || [];
      out.sync = listed.body.sync === 'failed' ? 'failed' : 'ok';
    } else {
      out.readable = false;
    }
    return out;
  }

  async function renderSteps(steps, state) {
    const section = document.getElementById('onboarding-steps');
    if (!section) return;
    if (!steps) return;
    const apps = document.getElementById('onboarding-apps');
    apps.textContent = '';
    const reality = await readReality();
    const summary = document.getElementById('onboarding-reality');
    if (summary) summary.textContent = realitySummary(reality);
    for (const app of steps.apps || []) {
      const li = document.createElement('li');
      const tile = document.createElement('span');
      tile.className = 'choice-tile';
      tile.dataset.tone = tileTone(app.name);
      tile.setAttribute('aria-hidden', 'true');
      tile.textContent = Array.from(app.name)[0] || '?';
      const copy = document.createElement('span');
      copy.className = 'app-copy';
      const name = document.createElement('strong');
      name.textContent = app.name;
      const state = document.createElement('span');
      state.className = 'app-state';
      const info = appConnectionState(app, reality);
      state.dataset.state = info.state;
      state.textContent = ' · ' + info.label;
      state.title = info.title;
      copy.append(name, state);
      const connect = document.createElement('button');
      connect.type = 'button';
      connect.disabled = true;
      connect.className = 'app-connect';
      connect.textContent = info.connected ? '已连接' : '+ 连接';
      connect.title = info.connected ? info.title : info.title + '；连接在 设置 → 应用连接器 里做';
      connect.setAttribute('aria-label', app.name + '：' + info.label);
      li.append(tile, copy, connect);
      apps.appendChild(li);
    }
    const picks = document.getElementById('onboarding-picks');
    picks.textContent = '';
    const groups = {task: ['一次性任务'], routine: ['例行任务']};
    const lists = {};
    for (const [kind, [title]] of Object.entries(groups)) {
      const group = document.createElement('div');
      group.className = 'pick-group';
      const head = document.createElement('h3');
      head.className = 'onboarding-group';
      head.textContent = title;
      const list = document.createElement('div');
      list.className = 'pick-list';
      group.append(head, list);
      picks.append(group);
      lists[kind] = list;
    }
    for (const item of steps.recommendations || []) {
      const label = document.createElement('label');
      label.className = 'pick-card';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.name = 'pick';
      box.value = item.key;
      box.checked = (steps.picks || []).includes(item.key);
      const copy = document.createElement('span');
      copy.className = 'pick-copy';
      const title = document.createElement('strong');
      title.textContent = ` ${item.title}（${item.kind === 'routine' ? '例行' : '一次性'}）`;
      const summary = document.createElement('span');
      summary.className = 'pick-summary';
      summary.textContent = item.summary;
      copy.append(title, summary);
      label.append(box, copy);
      label.title = item.summary;
      (lists[item.kind] || lists.task).appendChild(label);
    }
    const look = document.getElementById('onboarding-look');
    look.textContent = '';
    for (const [name, options] of Object.entries(steps.look_options || {})) {
      const label = document.createElement('label');
      const choice = document.createElement('select');
      choice.name = name;
      for (const value of options) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value;
        choice.appendChild(option);
      }
      if (steps.look && steps.look[name]) choice.value = steps.look[name];
      choice.addEventListener('change', paintLook);
      label.className = 'look-option';
      const caption = document.createElement('span');
      caption.textContent = `${LOOK_LABELS[name] || name} `;
      label.append(caption, choice);
      look.appendChild(label);
    }
    paintLook();
    document.getElementById('onboarding-look-preview').textContent = lookSummary(steps.look);
    document.getElementById('onboarding-steps-meta').textContent =
      `已选 ${(steps.picks || []).length} 项 · ` + (steps.look ? '形象已保存' : '形象未保存');
  }

  function paintLook() {
    const avatar = document.getElementById('look-avatar');
    if (!avatar) return;
    for (const choice of document.querySelectorAll('#onboarding-look select')) {
      avatar.dataset[choice.name] = choice.value;
    }
  }

  async function saveStep(path, body, okText, next) {
    const result = await request('POST', path, body);
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '保存失败。'));
      return;
    }
    renderSteps(result.body.steps, current || {completed: true});
    show('ok', okText);
    if (next) goStep(next);
  }

  const picksForm = document.getElementById('onboarding-picks-form');
  if (picksForm) picksForm.addEventListener('submit', event => {
    event.preventDefault();
    const chosen = [...document.getElementById('onboarding-picks').querySelectorAll('input[name="pick"]')]
      .filter(box => box.checked).map(box => box.value);
    saveStep('/v1/onboarding/picks', {picks: chosen}, '已保存选择（不会自动创建例行任务）。', 4);
  });

  const lookForm = document.getElementById('onboarding-look-form');
  if (lookForm) lookForm.addEventListener('submit', event => {
    event.preventDefault();
    const look = {};
    for (const choice of document.getElementById('onboarding-look').querySelectorAll('select')) look[choice.name] = choice.value;
    saveStep('/v1/onboarding/look', {look}, '已保存 Agent 形象。');
  });

  select.addEventListener('change', () => {
    current = null;
    customRole.value = '';
    renderRoles();
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    let industry = select.value;
    if (industry === '其他') industry = customIndustry.value.trim();
    const role = chosenRole();
    if (!industry) {
      show('error', '请选择或填写行业。');
      return;
    }
    if (!role) {
      show('error', '请选择或填写角色。');
      return;
    }
    const result = await request('POST', '/v1/onboarding', {industry, role, completed: true});
    if (result.status !== 200 && result.status !== 201) {
      show('error', messageFor(result.body.error, '保存失败。'));
      return;
    }
    step = 2;
    await load();
  });

  document.getElementById('onboarding-skip').addEventListener('click', async () => {
    const result = await request('POST', '/v1/onboarding', {industry: '', role: '', completed: true});
    if (result.status !== 200 && result.status !== 201) {
      show('error', messageFor(result.body.error, '暂时跳过失败。'));
      return;
    }
    globalThis.location.assign('/chat');
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

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
}
