import {PUBLIC_AGENT_MESSAGE_LIMIT} from '../shell/public-agent-link.mjs';

// Keep drafts separated when switching conversations. A public draft remains in
// this tab through reload and can only be restored for its owner and thread.
export function mountPublicDraft(document) {
  const input = document.getElementById('chat-body');
  const recovery = document.getElementById('public-draft-recovery');
  const recoveryText = document.getElementById('public-draft-recovery-text');
  const memory = new Map();
  const recovered = new Map();
  let active = null;
  const prefix = 'openteamily.public-agent-draft:';
  const recoveryPrefix = 'openteamily.public-agent-draft-recovery:';

  function read(scope, keyPrefix) {
    try { return document.defaultView?.sessionStorage?.getItem(keyPrefix + scope); } catch {}
  }

  function save(scope, keyPrefix, text) {
    try {
      const storage = document.defaultView?.sessionStorage;
      if (text) storage?.setItem(keyPrefix + scope, text);
      else storage?.removeItem(keyPrefix + scope);
    } catch {}
  }

  function showRecovery(text) {
    recovery.hidden = !text;
    recovery.open = false;
    recoveryText.value = text || '';
  }

  function persist() {
    if (!active) return;
    const text = input.value || '';
    if (text) memory.set(active.scope, text);
    else memory.delete(active.scope);
    if (active.publicChat) save(active.scope, prefix, text);
  }

  input.addEventListener('input', persist);
  document.getElementById('public-draft-recovery-clear').addEventListener('click', () => {
    if (!active?.publicChat) return;
    recovered.set(active.scope, '');
    save(active.scope, recoveryPrefix, '');
    showRecovery('');
    input.focus({preventScroll: true});
  });
  return {
    enter(scope, publicChat = false) {
      if (active?.scope === scope) return;
      if (active) persist();
      const initialText = active ? '' : (input.value || '');
      active = {scope, publicChat};
      const previous = memory.get(scope) ?? (publicChat ? read(scope, prefix) : null);
      input.value = typeof previous === 'string' && previous.length <= PUBLIC_AGENT_MESSAGE_LIMIT
        ? previous : (publicChat ? '' : initialText);
      showRecovery(publicChat ? recovered.get(scope) ?? read(scope, recoveryPrefix) : '');
    },
    move(fromScope, toScope) {
      if (active?.scope !== fromScope || active.publicChat) return;
      memory.delete(fromScope);
      active.scope = toScope;
      persist();
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
    fillOpening(text) {
      if (!active?.publicChat || input.disabled) return '';
      const existing = input.value;
      const combined = existing && existing !== text ? existing + '\n\n' + text : text;
      if (combined.length <= PUBLIC_AGENT_MESSAGE_LIMIT) {
        input.value = combined;
        persist();
        input.focus({preventScroll: true});
        return 'filled';
      }
      const previous = recovered.get(active.scope) ?? read(active.scope, recoveryPrefix);
      const backup = previous ? previous + '\n\n' + text : text;
      recovered.set(active.scope, backup);
      save(active.scope, recoveryPrefix, backup);
      showRecovery(backup);
      document.getElementById('public-draft-recovery-summary').focus({preventScroll: true});
      return 'saved';
    },
    persist,
    clear() {
      if (active) persist();
      active = null;
      memory.clear();
      recovered.clear();
      input.value = '';
      showRecovery('');
    },
  };
}
