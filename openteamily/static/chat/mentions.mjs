const MAX_MENTIONS = 20;
const agentKey = agent => JSON.stringify([agent.owner_id, agent.id]);

export function activeMentionQuery(text, caret) {
  const match = /(?:^|[\s(（、，。])@([^\s@]{0,40})$/u.exec(text.slice(0, caret));
  return match ? {start: caret - match[1].length - 1, query: match[1]} : null;
}

export function mountAgentMentions(doc, context) {
  const input = doc.getElementById('chat-body');
  const list = doc.getElementById('chat-agent-mention-options');
  const chips = doc.getElementById('chat-agent-mentions');
  if (!input || !list || !chips) return {refresh() {}, clear() {}, keydown: () => false, message: body => ({body})};

  let scope = null;
  let options = [];
  let active = 0;
  const selected = new Map();

  function close() {
    list.hidden = true;
    list.replaceChildren();
    input.removeAttribute('aria-activedescendant');
    options = [];
  }

  function renderSelected() {
    chips.replaceChildren(...Array.from(selected, ([key, agent]) => {
      const button = doc.createElement('button');
      button.type = 'button';
      button.textContent = agent.owner_name ? `@${agent.name} · ${agent.owner_name} ×` : `@${agent.name} ×`;
      button.setAttribute('aria-label', `移除对 ${agent.name}${agent.owner_name ? `（${agent.owner_name}）` : ''} 的提及`);
      button.addEventListener('click', () => {
        selected.delete(key);
        renderSelected();
        input.focus();
      });
      return button;
    }));
    chips.hidden = selected.size === 0;
  }

  function refresh() {
    const group = context();
    if (scope !== group?.scope) {
      scope = group?.scope;
      selected.clear();
      renderSelected();
      close();
    }
    return group;
  }

  function choose(agent) {
    const group = refresh();
    const query = activeMentionQuery(input.value, input.selectionStart);
    if (!query || !group?.agents.some(candidate => agentKey(candidate) === agentKey(agent) && !candidate.archived) || selected.size >= MAX_MENTIONS) {
      close();
      return;
    }
    const end = input.selectionStart;
    input.value = input.value.slice(0, query.start) + input.value.slice(end);
    input.setSelectionRange(query.start, query.start);
    selected.set(agentKey(agent), agent);
    renderSelected();
    close();
    input.focus();
  }

  function highlight() {
    Array.from(list.children).forEach((option, index) => option.setAttribute('aria-selected', String(index === active)));
    input.setAttribute('aria-activedescendant', list.children[active].id);
  }

  function suggest(event) {
    if (event?.isComposing) return;
    const group = refresh();
    const query = activeMentionQuery(input.value, input.selectionStart);
    if (!group || !query || selected.size >= MAX_MENTIONS) { close(); return; }
    const needle = query.query.toLowerCase();
    options = group.agents.filter(agent => agent.name && agent.owner_id && agent.id && !agent.archived && !selected.has(agentKey(agent))
      && agent.name.toLowerCase().includes(needle)).slice(0, 8);
    if (!options.length) { close(); return; }
    active = 0;
    list.replaceChildren(...options.map((agent, index) => {
      const option = doc.createElement('button');
      option.type = 'button';
      option.id = `chat-agent-mention-option-${index}`;
      option.setAttribute('role', 'option');
      option.textContent = agent.owner_name ? `${agent.name} · ${agent.owner_name}` : agent.name;
      option.addEventListener('pointerdown', event => event.preventDefault());
      option.addEventListener('click', () => choose(agent));
      return option;
    }));
    list.hidden = false;
    highlight();
  }

  input.addEventListener('input', suggest);
  input.addEventListener('compositionend', suggest);
  input.addEventListener('blur', close);
  return {
    refresh,
    clear() { selected.clear(); renderSelected(); close(); },
    keydown(event) {
      if (event.isComposing || list.hidden || !options.length) return false;
      const keys = ['Escape', 'ArrowDown', 'ArrowUp', 'Enter', 'Tab'];
      if (!keys.includes(event.key) || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false;
      event.preventDefault();
      if (event.key === 'Escape') close();
      else if (event.key === 'Enter' || event.key === 'Tab') choose(options[active]);
      else {
        active = (active + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
        highlight();
      }
      return true;
    },
    message(body) {
      const group = refresh();
      if (!group || !selected.size) return {body};
      return {body, agent_mentions: Array.from(selected.values(), agent => ({owner_id: agent.owner_id, agent_id: agent.id}))};
    },
  };
}
