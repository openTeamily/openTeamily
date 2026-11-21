export function sourceHref(workspace, source) {
  if (source?.kind === 'group') {
    const valid = /^[0-9a-f]{32}$/.test(workspace) &&
      [source.conversation_id,source.message_id].every(id => /^[A-Za-z0-9._-]{1,80}$/.test(id || ''));
    return valid ? '/chat#' + new URLSearchParams({workspace,social:source.conversation_id,message:source.message_id}) : '';
  }
  if (![workspace,source?.agent_id,source?.conversation_id,source?.message_id].every(id => /^[0-9a-f]{32}$/.test(id || ''))) return '';
  return '/chat#' + new URLSearchParams({workspace, agent:source.agent_id, conversation:source.conversation_id, message:source.message_id});
}

export function mountCandidates(document, {request, workspaceId}) {
  const panel = document.getElementById('memory-candidates');
  if (!panel) return {show() {}};
  const get = id => document.getElementById(id);
  const toggle = get('memory-capture-toggle');
  const list = get('memory-candidates-list');
  const status = get('memory-candidates-status');
  const review = get('memory-candidate-review');
  const error = get('memory-review-error');
  let workspace = '';
  let generation = 0;
  let selected = null;
  let enabled = false;
  let groupCapture = false;
  let loading = false;
  let writing = false;
  let timer;
  const base = () => `/v1/workspaces/${workspace}/memory/candidates`;
  const node = (tag, text) => {
    const el = document.createElement(tag);
    if (text) el.textContent = text;
    return el;
  };

  function open(item) {
    selected = item;
    get('memory-review-name').value = item.title;
    get('memory-review-body').value = item.body;
    const link = get('memory-review-source');
    link.href = sourceHref(workspace, item.source);
    link.textContent = '查看原消息 · ' + (item.source.title || (item.source.kind === 'group' ? '群聊' : '智能体私聊'));
    get('memory-review-excerpt').textContent = item.source.excerpt || '';
    error.textContent = '';
    review.showModal();
  }

  function refresh() {
    clearTimeout(timer);
    if (workspace && (enabled || groupCapture || status.dataset.pending === 'true')) timer = setTimeout(() => void load(), 7000);
  }

  async function load() {
    if (!workspace || loading || writing) return;
    const token = generation;
    loading = true;
    try {
      const result = await request('GET', base());
      if (generation !== token || writing) return;
      if (result.status !== 200) throw new Error();
      enabled = result.body.enabled === true;
      groupCapture = result.body.group_capture === true;
      toggle.disabled = false;
      toggle.setAttribute('aria-pressed', String(enabled));
      toggle.textContent = enabled ? '私聊提炼已开启' : '开启私聊提炼';
      const items = result.body.items || [];
      const queue = result.body.queued || 0;
      status.dataset.pending = String(queue > 0);
      status.textContent = queue > 0 ? `正在提炼 · ${queue} 条消息`
        : items.length ? '' : groupCapture || enabled ? '暂无待核对的建议。' : '可在此开启私聊提炼，或前往群记忆开启群聊提炼。';
      list.replaceChildren(...items.map(item => {
        const row = node('li');
        const button = node('button', '核对建议');
        button.type = 'button';
        button.setAttribute('aria-label', '核对建议 · ' + item.title);
        button.addEventListener('click', () => open(item));
        row.append(node('strong', item.title));
        if (item.source?.kind === 'group') {
          const provenance = node('small', (item.source.automatic ? '群聊自动提炼 · ' : '群聊提炼 · ') + (item.source.title || '群聊'));
          provenance.className = 'note';
          row.append(provenance);
        }
        row.append(node('p', item.body), button);
        return row;
      }));
    } catch {
      if (generation === token) status.textContent = '无法读取记忆建议。';
    } finally {
      if (generation === token) { loading = false; refresh(); }
    }
  }

  toggle.addEventListener('click', async () => {
    if (writing || !workspace) return;
    const token = ++generation;
    loading = false;
    let saved = false;
    writing = true;
    toggle.disabled = true;
    try {
      const result = await request('POST', base(), {enabled:!enabled});
      if (generation !== token) return;
      if (result.status !== 200) throw new Error();
      enabled = result.body.enabled;
      saved = true;
    } catch {
      if (generation === token) status.textContent = '开关未保存，请重试。';
    } finally {
      if (generation === token) {
        writing = false;
        toggle.disabled = false;
        if (saved) void load();
      }
    }
  });

  const close = () => { selected = null; if (review.open) review.close(); };
  get('memory-review-close').addEventListener('click', close);
  review.addEventListener('cancel', event => { event.preventDefault(); if (!writing) close(); });
  async function decide(action) {
    if (!selected || writing || !workspace) return;
    const scope = workspace;
    const token = ++generation;
    loading = false;
    const path = base() + '/' + selected.id;
    const body = action === 'save' ? {action, title:get('memory-review-name').value.trim(), body:get('memory-review-body').value} : {action};
    writing = true;
    error.textContent = action === 'save' ? '正在保存…' : '正在忽略…';
    const buttons = ['close','save','ignore'].map(id => get('memory-review-' + id));
    buttons.forEach(button => {button.disabled = true;});
    let saved = false;
    try {
      const result = await request('POST',path,body);
      if (generation !== token) return;
      if (![200,201].includes(result.status)) {
        error.textContent = result.body.error?.message || '无法处理这条建议，请重试。';
        return;
      }
      close();
      saved = result.body.page?.id || false;
    } catch {
      if (generation === token) error.textContent = '无法处理这条建议，请重试。';
    } finally {
      if (generation === token) {
        buttons.forEach(button => {button.disabled = false;});
        writing = false;
        if (saved) document.defaultView.location.assign('/memory?' + new URLSearchParams({workspace:scope,page:saved}));
        else void load();
      }
    }
  }
  get('memory-candidate-form').addEventListener('submit', event => {event.preventDefault(); void decide('save');});
  get('memory-review-ignore').addEventListener('click', () => void decide('ignore'));

  return {show(active) {
    const scope = active ? workspaceId() : '';
    panel.hidden = !active;
    if (scope === workspace) return;
    workspace = scope;
    generation += 1;
    clearTimeout(timer);
    close();
    loading = false;
    writing = false;
    enabled = false;
    groupCapture = false;
    toggle.disabled = true;
    toggle.setAttribute('aria-pressed','false');
    toggle.textContent = '开启私聊提炼';
    status.dataset.pending = 'false';
    status.textContent = scope ? '正在加载记忆建议…' : '';
    list.replaceChildren();
    ['close','save','ignore'].forEach(id => {get('memory-review-' + id).disabled = false;});
    if (scope) void load();
  }};
}
