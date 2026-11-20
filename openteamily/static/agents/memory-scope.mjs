// Agent memory recall settings shown beside the agent edit form.
export function csrfCookie(source) {
  const match = /(?:^|;\s*)(?:__Host-ot_csrf|ot_dev_csrf)=([^;]+)/.exec(source || '');
  return match ? decodeURIComponent(match[1]) : '';
}

export function scopeChanges(form) {
  const mode = (form.querySelector('input[name="mode"]:checked') || {}).value || 'off';
  const changes = {mode};
  if (mode === 'topics') changes.topics = [...form.querySelectorAll('input[name="topic"]:checked')].map(box => box.value);
  return changes;
}

export function mountMemoryScope(document, fetcher = globalThis.fetch.bind(globalThis)) {
  const $ = id => document.getElementById(id);
  const panel = $('memory-scope-panel');
  const editForm = $('edit-form');
  if (!panel || !editForm) return null;
  let state = null;
  let agentId = '';

  async function request(method, path, body) {
    const headers = {'Accept': 'application/json', 'X-CSRF-Token': csrfCookie(document.cookie)};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetcher(path, {method, headers, credentials: 'same-origin',
      body: body !== undefined ? JSON.stringify(body) : undefined});
    let parsed = {};
    try { parsed = await response.json(); } catch { parsed = {}; }
    return {status: response.status, body: parsed};
  }
  const base = () => `/v1/workspaces/${$('workspace').value}/agents/${agentId}/memory-scope`;
  const note = text => { $('memory-scope-status').textContent = text; };

  function render() {
    const form = $('memory-scope-form');
    for (const radio of form.querySelectorAll('input[name="mode"]')) radio.checked = radio.value === state.scope.mode;
    const holder = $('memory-scope-topics');
    holder.replaceChildren();
    if (!state.topics.length) {
      holder.textContent = '记忆页还没有主题；给记忆页加上主题后才能按主题限定。';
      const topicsRadio = form.querySelector('input[value="topics"]');
      topicsRadio.disabled = true;
    } else {
      form.querySelector('input[value="topics"]').disabled = false;
      const chosen = new Set(state.scope.topics.map(name => name.toLowerCase()));
      for (const topic of state.topics) {
        const label = document.createElement('label');
        label.className = 'topic-chip';
        const box = document.createElement('input');
        box.type = 'checkbox'; box.name = 'topic'; box.value = topic.name;
        box.checked = chosen.has(topic.name.toLowerCase());
        label.append(box, document.createTextNode(` ${topic.name}（${topic.pages}）`));
        holder.append(label);
      }
    }
    $('memory-scope-fields').disabled = !state.can_manage;
    const mode = {off: '不引用记忆', all: '引用全部记忆页', topics: '只引用：' + state.scope.topics.join('、')}[state.scope.mode];
    note(state.can_manage ? `当前：${mode}` : `当前：${mode}。只有所有者或管理员可以修改。`);
  }

  async function refresh() {
    agentId = editForm.elements.id.value;
    $('memory-preview-list').replaceChildren();
    if (!agentId || !$('workspace').value) { panel.hidden = true; return; }
    const result = await request('GET', base());
    if (result.status !== 200) { panel.hidden = true; return; }
    state = result.body;
    panel.hidden = false;
    render();
  }

  $('memory-scope-form').addEventListener('submit', async event => {
    event.preventDefault();
    const changes = scopeChanges($('memory-scope-form'));
    if (changes.mode === 'topics' && !changes.topics.length) { note('至少选一个主题。'); return; }
    const result = await request('POST', base(), {revision: state.scope.revision, changes});
    if (result.status !== 200) {
      note(result.status === 409 ? '设置刚被别人改过，已重新读取。' : ((result.body.error && result.body.error.message) || '保存失败。'));
      if (result.status === 409) await refresh();
      return;
    }
    state = result.body;
    render();
    note('已保存。' + $('memory-scope-status').textContent);
  });

  $('memory-preview-form').addEventListener('submit', async event => {
    event.preventDefault();
    const text = $('memory-preview-form').elements.text.value.trim();
    if (!text) return;
    const result = await request('POST', base() + '/preview', {text});
    const list = $('memory-preview-list');
    list.replaceChildren();
    if (result.status !== 200) { note('无法预览召回结果。'); return; }
    if (result.body.scope.mode === 'off') { note('记忆引用已关闭，回复不会带上记忆。'); return; }
    if (!result.body.items.length) { note('没有相关的记忆页，回复不会带上记忆。'); return; }
    for (const item of result.body.items) {
      const li = document.createElement('li');
      const title = document.createElement('strong');
      title.textContent = `[${item.marker}] ${item.title}`;
      const excerpt = document.createElement('p');
      excerpt.className = 'note';
      excerpt.textContent = item.excerpt;
      li.append(title, excerpt);
      list.append(li);
    }
    note(`会带上 ${result.body.items.length} 条记忆。`);
  });

  const observer = new globalThis.MutationObserver(() => { if (editForm.hidden) panel.hidden = true; else refresh(); });
  observer.observe(editForm, {attributes: true, attributeFilter: ['hidden']});
  // Switching agents while the drawer stays open only retitles the chat panel.
  const title = $('chat-title');
  if (title) observer.observe(title, {childList: true, characterData: true, subtree: true});
  return {refresh};
}

if (globalThis.document && globalThis.document.getElementById('memory-scope-panel') && globalThis.MutationObserver) {
  mountMemoryScope(globalThis.document);
}
