// Team task runs page: create a multi-agent step graph, follow progress, retry, cancel, save.
export function csrfCookie(source) {
  const match = /(?:^|;\s*)(?:__Host-ot_csrf|ot_dev_csrf)=([^;]+)/.exec(source || '');
  return match ? decodeURIComponent(match[1]) : '';
}

export const STATUS_LABELS = {
  running: '进行中', succeeded: '已完成', failed: '未完成', cancelled: '已取消',
  waiting: '等待前置步骤', queued: '排队中', blocked: '被前置失败挡住',
};

export const ERROR_LABELS = {
  no_agent: '没有在线的运行时，连接 FlyBot 后打开本页会自动排队',
  agent_unavailable: '智能体已归档或不存在',
  cancelled: '已取消', timeout: '运行超时', failed: '运行失败',
};

export function readSteps(editor) {
  return [...editor.querySelectorAll('li.step-row')].map((row, index) => ({
    agent_id: row.querySelector('select[name="agent"]').value,
    instruction: row.querySelector('textarea[name="instruction"]').value.trim(),
    depends_on: [...row.querySelectorAll('input[name="depends"]:checked')].map(box => Number(box.value))
      .filter(value => value < index),
  }));
}

export function groupByStage(steps) {
  const stages = new Map();
  for (const step of steps || []) {
    if (!stages.has(step.stage)) stages.set(step.stage, []);
    stages.get(step.stage).push(step);
  }
  return [...stages.entries()].sort((a, b) => a[0] - b[0]);
}

export function newKey() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return 'team-run-' + [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function mount(document, fetcher = globalThis.fetch.bind(globalThis), timers = globalThis) {
  const $ = id => document.getElementById(id);
  const status = $('status');
  const workspaceSelect = $('workspace');
  let agentsList = [];
  let currentRun = null;
  let poll = null;
  let pendingKey = null;

  function show(kind, text) { status.dataset.kind = kind; status.textContent = text; }

  async function request(method, path, body, extraHeaders) {
    const headers = {'Accept': 'application/json', 'X-CSRF-Token': csrfCookie(document.cookie)};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (extraHeaders) Object.assign(headers, extraHeaders);
    const response = await fetcher(path, {method, headers, credentials: 'same-origin',
      body: body !== undefined ? JSON.stringify(body) : undefined});
    let parsed = {};
    try { parsed = await response.json(); } catch { parsed = {}; }
    return {status: response.status, body: parsed};
  }

  const base = () => `/v1/workspaces/${workspaceSelect.value}/team-runs`;
  const errorText = (body, fallback) => (body && body.error && body.error.message) || fallback;

  function stopPoll() { if (poll) { timers.clearTimeout(poll); poll = null; } }

  function stepRow(index) {
    const li = document.createElement('li');
    li.className = 'step-row';
    const head = document.createElement('div');
    head.className = 'step-row-head';
    const label = document.createElement('label');
    label.textContent = `第 ${index + 1} 步 · 智能体 `;
    const select = document.createElement('select');
    select.name = 'agent';
    select.required = true;
    for (const agent of agentsList) {
      const option = document.createElement('option');
      option.value = agent.id; option.textContent = agent.name;
      select.append(option);
    }
    if (agentsList.length) select.value = agentsList[index % agentsList.length].id;
    label.append(select);
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'remove-step'; remove.textContent = '移除';
    remove.setAttribute('aria-label', `移除第 ${index + 1} 步`);
    remove.addEventListener('click', () => { li.remove(); renumber(); });
    head.append(label, remove);
    const text = document.createElement('label');
    text.className = 'stack';
    text.textContent = '这一步要做什么 ';
    const area = document.createElement('textarea');
    area.name = 'instruction'; area.required = true; area.maxLength = 1000; area.rows = 2;
    text.append(area);
    const deps = document.createElement('div');
    deps.className = 'step-deps';
    li.append(head, text, deps);
    return li;
  }

  function renumber() {
    const rows = [...$('step-editor').querySelectorAll('li.step-row')];
    rows.forEach((row, index) => {
      const label = row.querySelector('.step-row-head label');
      label.firstChild.textContent = `第 ${index + 1} 步 · 智能体 `;
      row.querySelector('.remove-step').hidden = rows.length <= 2;
      row.querySelector('.remove-step').setAttribute('aria-label', `移除第 ${index + 1} 步`);
      const deps = row.querySelector('.step-deps');
      const checked = new Set([...deps.querySelectorAll('input:checked')].map(box => Number(box.value)));
      deps.replaceChildren();
      if (index === 0) { deps.textContent = '第一步没有前置步骤，会最先运行。'; return; }
      deps.append(document.createTextNode('依赖：'));
      for (let prior = 0; prior < index; prior += 1) {
        const lab = document.createElement('label');
        const box = document.createElement('input');
        box.type = 'checkbox'; box.name = 'depends'; box.value = String(prior);
        box.checked = checked.size ? checked.has(prior) : prior === index - 1;
        lab.append(box, document.createTextNode(` 第 ${prior + 1} 步`));
        deps.append(lab);
      }
    });
    $('add-step').disabled = rows.length >= 8;
  }

  function openForm() {
    stopPoll();
    currentRun = null;
    pendingKey = null;
    $('run-view').hidden = true;
    $('detail-empty').hidden = true;
    const form = $('run-form');
    form.reset();
    const editor = $('step-editor');
    editor.replaceChildren(stepRow(0), stepRow(1));
    renumber();
    $('form-note').textContent = agentsList.length ? '' : '这个工作区还没有可用的智能体，请先到「智能体」页创建。';
    form.querySelector('button[type="submit"]').disabled = !agentsList.length;
    form.hidden = false;
    form.querySelector('input[name="title"]').focus();
  }

  function pill(statusValue) {
    const span = document.createElement('span');
    span.className = 'status-pill';
    span.dataset.status = statusValue;
    span.textContent = STATUS_LABELS[statusValue] || statusValue;
    return span;
  }

  function renderRun(run) {
    currentRun = run;
    $('run-form').hidden = true;
    $('detail-empty').hidden = true;
    $('run-view').hidden = false;
    $('run-title').textContent = run.title;
    $('run-goal').textContent = run.goal;
    const badge = $('run-status');
    badge.dataset.status = run.status;
    badge.textContent = STATUS_LABELS[run.status] || run.status;
    $('run-progress').textContent = `${run.progress.succeeded} / ${run.progress.total} 步完成`;
    const board = $('stage-board');
    board.replaceChildren();
    for (const [stage, steps] of groupByStage(run.steps)) {
      const column = document.createElement('section');
      column.className = 'stage';
      const title = document.createElement('h3');
      title.textContent = `阶段 ${stage}`;
      column.append(title);
      for (const step of steps) {
        const card = document.createElement('article');
        card.className = 'step-card';
        card.dataset.status = step.status;
        const head = document.createElement('header');
        const avatar = document.createElement('span');
        avatar.className = 'agent-mono'; avatar.setAttribute('aria-hidden', 'true');
        avatar.textContent = (step.agent_name || '智').slice(0, 1);
        const name = document.createElement('strong');
        name.textContent = `第 ${step.position + 1} 步 · ${step.agent_name}`;
        head.append(avatar, name, pill(step.status));
        const instruction = document.createElement('p');
        instruction.className = 'step-instruction';
        instruction.textContent = step.instruction;
        card.append(head, instruction);
        if (step.depends_on.length) {
          const deps = document.createElement('p');
          deps.className = 'step-deps-line';
          deps.textContent = '依赖 ' + step.depends_on.map(d => `第 ${d + 1} 步`).join('、');
          card.append(deps);
        }
        if (step.error_code && step.status !== 'succeeded') {
          const err = document.createElement('p');
          err.className = 'step-error';
          err.textContent = ERROR_LABELS[step.error_code] || '运行失败';
          card.append(err);
        }
        if (step.status === 'succeeded' && step.output) {
          const output = document.createElement('details');
          output.open = true;
          const summary = document.createElement('summary');
          summary.textContent = '结果';
          const body = document.createElement('p');
          body.className = 'step-output';
          body.textContent = step.output;
          output.append(summary, body);
          card.append(output);
        }
        const actions = document.createElement('div');
        actions.className = 'step-actions';
        if (step.status === 'failed' && run.status !== 'cancelled') {
          const retry = document.createElement('button');
          retry.type = 'button'; retry.textContent = '重试这一步';
          retry.addEventListener('click', () => act(`/${run.id}/steps/${step.position}/retry`, '已重新排队。'));
          actions.append(retry);
        }
        if (step.status === 'succeeded' && step.output) {
          const save = document.createElement('button');
          save.type = 'button'; save.textContent = '保存到作品库';
          save.addEventListener('click', async () => {
            const result = await request('POST', base() + `/${run.id}/steps/${step.position}/artifact`, {});
            if (result.status === 200 || result.status === 201) {
              show('ok', result.status === 201 ? `已保存为「${result.body.artifact.title}」。` : '这一步的结果已经在作品库里。');
            } else show('error', errorText(result.body, '保存失败。'));
          });
          actions.append(save);
        }
        if (actions.childNodes.length) card.append(actions);
        column.append(card);
      }
      board.append(column);
    }
    $('cancel-run').hidden = run.status !== 'running';
    $('remove-run').hidden = run.status === 'running';
    for (const item of $('run-list').querySelectorAll('button[data-run]')) {
      item.setAttribute('aria-current', item.dataset.run === run.id ? 'true' : 'false');
    }
    stopPoll();
    if (run.status === 'running') poll = timers.setTimeout(() => openRun(run.id, true), 3000);
  }

  async function act(suffix, okText) {
    const result = await request('POST', base() + suffix, {});
    if (result.status !== 200) { show('error', errorText(result.body, '操作失败。')); return; }
    show('ok', okText);
    renderRun(result.body.run);
    await loadRuns(false);
  }

  async function openRun(id, quiet = false) {
    const result = await request('GET', base() + `/${id}`);
    if (result.status !== 200) { if (!quiet) show('error', errorText(result.body, '无法读取团队任务。')); return; }
    renderRun(result.body.run);
    if (quiet) await loadRuns(false);
  }

  async function loadRuns(openFirst = true) {
    const result = await request('GET', base());
    const list = $('run-list');
    if (result.status !== 200) { show('error', errorText(result.body, '无法读取团队任务。')); return; }
    const items = result.body.items || [];
    list.replaceChildren(...items.map(item => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button'; button.dataset.run = item.id;
      button.setAttribute('aria-current', currentRun && currentRun.id === item.id ? 'true' : 'false');
      const title = document.createElement('span');
      title.className = 'run-row-title'; title.textContent = item.title;
      const meta = document.createElement('span');
      meta.className = 'run-row-meta';
      meta.textContent = `${item.progress.succeeded}/${item.progress.total} 步`;
      button.append(title, pill(item.status), meta);
      button.addEventListener('click', () => openRun(item.id));
      li.append(button);
      return li;
    }));
    $('run-empty').hidden = items.length > 0;
    if (openFirst && items.length && !currentRun) await openRun(items[0].id);
  }

  async function loadWorkspace() {
    stopPoll();
    currentRun = null;
    $('run-view').hidden = true;
    $('run-form').hidden = true;
    $('detail-empty').hidden = false;
    const listed = await request('GET', `/v1/workspaces/${workspaceSelect.value}/agents?limit=100`);
    agentsList = listed.status === 200 ? (listed.body.items || []).filter(item => !item.archived) : [];
    await loadRuns(true);
  }

  $('new-run').addEventListener('click', openForm);
  $('add-step').addEventListener('click', () => {
    const editor = $('step-editor');
    const count = editor.querySelectorAll('li.step-row').length;
    if (count >= 8) return;
    editor.append(stepRow(count));
    renumber();
  });
  $('cancel-form').addEventListener('click', () => {
    $('run-form').hidden = true;
    $('detail-empty').hidden = false;
  });
  $('run-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget || $('run-form');
    const data = new FormData(form);
    const steps = readSteps($('step-editor'));
    if (steps.some(step => !step.instruction)) { show('error', '每一步都要写清楚要做什么。'); return; }
    pendingKey = pendingKey || newKey();
    const result = await request('POST', base(), {
      title: String(data.get('title') || '').trim(), goal: String(data.get('goal') || '').trim(), steps,
    }, {'Idempotency-Key': pendingKey});
    if (result.status !== 201 && result.status !== 200) { show('error', errorText(result.body, '无法开始团队任务。')); return; }
    pendingKey = null;
    show('ok', '团队任务已开始，前置步骤完成后下一步会自动排队。');
    renderRun(result.body.run);
    await loadRuns(false);
  });
  $('cancel-run').addEventListener('click', () => {
    if (currentRun) act(`/${currentRun.id}/cancel`, '已取消，排队和运行中的步骤已停止。');
  });
  $('remove-run').addEventListener('click', async () => {
    if (!currentRun) return;
    const result = await request('POST', base() + `/${currentRun.id}/remove`, {});
    if (result.status !== 200) { show('error', errorText(result.body, '删除失败。')); return; }
    show('ok', '已删除这条团队任务记录。');
    currentRun = null;
    $('run-view').hidden = true;
    $('detail-empty').hidden = false;
    await loadRuns(false);
  });
  workspaceSelect.addEventListener('change', loadWorkspace);
  const logout = $('logout-form');
  if (logout) logout.addEventListener('submit', async event => {
    event.preventDefault();
    await request('POST', '/v1/auth/logout', {});
    globalThis.location && globalThis.location.assign('/');
  });

  async function load() {
    const session = await request('GET', '/v1/auth/session');
    if (session.status === 401) { $('login-panel').hidden = false; $('main-panel').hidden = true; return; }
    if (session.status !== 200) { show('error', '无法读取会话。'); return; }
    $('login-panel').hidden = true;
    $('main-panel').hidden = false;
    $('whoami').textContent = session.body.user.username;
    const spaces = await request('GET', '/v1/workspaces?limit=100');
    if (spaces.status !== 200) { show('error', '无法读取工作区。'); return; }
    workspaceSelect.replaceChildren(...(spaces.body.items || []).map(item => {
      const option = document.createElement('option');
      option.value = item.id; option.textContent = item.name; return option;
    }));
    if (workspaceSelect.value) await loadWorkspace();
  }

  return load();
}

if (globalThis.document && globalThis.document.getElementById('run-form')) {
  mount(globalThis.document);
}
