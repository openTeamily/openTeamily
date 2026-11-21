// Keep drafts separated when switching conversations. A public draft remains in
// this tab through reload and can only be restored for its owner and thread.
export function mountPublicDraft(document) {
  const input = document.getElementById('chat-body');
  const memory = new Map();
  let active = null;
  const prefix = 'openteamily.public-agent-draft:';
  function persist() {
    if (!active) return;
    const text = input.value || '';
    if (text) memory.set(active.scope, text);
    else memory.delete(active.scope);
    if (!active.publicChat) return;
    try {
      const storage = document.defaultView?.sessionStorage;
      if (text) storage?.setItem(prefix + active.scope, text);
      else storage?.removeItem(prefix + active.scope);
    } catch {}
  }

  input.addEventListener('input', persist);
  return {
    enter(scope, publicChat = false) {
      if (active?.scope === scope) return;
      if (active) persist();
      const initialText = active ? '' : (input.value || '');
      active = {scope, publicChat};
      let previous = memory.get(scope);
      if (previous === undefined && publicChat) {
        try { previous = document.defaultView?.sessionStorage?.getItem(prefix + scope); } catch {}
      }
      input.value = typeof previous === 'string' && previous.length <= 4000 ? previous : (publicChat ? '' : initialText);
    },
    fill(text) {
      if (!active?.publicChat || input.disabled) return false;
      if (!input.value) {
        input.value = text;
        persist();
      }
      input.focus({preventScroll: true});
      return true;
    },
    persist,
    clear() {
      if (active) persist();
      active = null;
      memory.clear();
      input.value = '';
    },
  };
}
