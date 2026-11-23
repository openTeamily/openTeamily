export function chatStartFromHash(hash) {
  const params = new URLSearchParams((hash || '').replace(/^#/, ''));
  return Object.fromEntries(['workspace', 'agent', 'conversation', 'message', 'social']
    .map(key => [key, params.get(key) || '']));
}

export function startChatReads(read, start, allowLocal) {
  const sessionRequest = read('/v1/auth/session');
  const params = new URLSearchParams({scope: 'personal', include: 'chat'});
  if (start.workspace) params.set('workspace', start.workspace);
  const id = /^[a-f0-9]{32}$/;
  if (start.social && id.test(start.workspace)) params.set('directory', '0');
  if (!start.social && id.test(start.workspace) && id.test(start.agent) && (!start.conversation || id.test(start.conversation))) {
    params.set('entry_agent', start.agent);
    if (start.conversation) {
      params.set('entry_conversation', start.conversation);
      params.set('directory', '0');
    }
  }
  const localRequest = allowLocal ? read('/v1/workspaces?' + params, AbortSignal.timeout(2200)) : null;
  return {sessionRequest, localRequest};
}

function fitChatToKeyboard(view) {
  const {document, visualViewport: viewport} = view;
  if (!viewport || !view.matchMedia?.('(any-pointer: coarse)').matches) return;
  const root = document.documentElement;
  let frame = 0;
  let fitted = false;
  function update() {
    frame = 0;
    const editing = document.activeElement?.matches('textarea, input, [contenteditable]:not([contenteditable="false"])');
    // Some touch browsers pan the visible viewport above the keyboard while
    // the layout viewport and its viewport units keep their original height.
    const keyboard = viewport.height > 0 && root.clientHeight - viewport.height > 80 &&
      Math.abs(viewport.scale - 1) < .01 && (editing || fitted);
    if (keyboard) {
      root.style.setProperty('--chat-viewport-height', Math.floor(viewport.height) + 'px');
      root.style.setProperty('--chat-viewport-top', Math.max(0, Math.floor(viewport.offsetTop)) + 'px');
      if (!fitted) root.setAttribute('data-chat-keyboard', '');
    } else if (fitted) {
      root.removeAttribute('data-chat-keyboard');
      root.style.removeProperty('--chat-viewport-height');
      root.style.removeProperty('--chat-viewport-top');
    }
    fitted = keyboard;
  }
  const schedule = () => { if (!frame) frame = view.requestAnimationFrame(update); };
  viewport.addEventListener('resize', schedule);
  viewport.addEventListener('scroll', schedule);
  document.addEventListener('focusin', schedule);
  schedule();
}

let early;
const view = typeof window === 'undefined' ? null : window;
if (view) fitChatToKeyboard(view);
if (view?.document.querySelector('meta[name="openteamily-instance"]')) {
  const {href, hash} = view.location;
  // These two GETs are already routed by the gateway. Starting them directly
  // lets the account check and private snapshot overlap the rest of Chat's modules.
  const read = async (path, signal) => {
    try {
      const response = await view.fetch(path, {credentials: 'same-origin', headers: {Accept: 'application/json'}, signal});
      return {status: response.status, body: await response.json().catch(() => ({}))};
    } catch {
      return {status: 0, body: {}};
    }
  };
  const openingPublicAgent = new URLSearchParams(hash.replace(/^#/, '')).has('public-agent');
  const target = chatStartFromHash(hash);
  const reads = startChatReads(read, target, !openingPublicAgent);
  // The current runtime authenticates this directory independently of the UI.
  // Opening a saved workspace conversation still waits for both results.
  const sharedRequest = !openingPublicAgent && /^[0-9a-f]{32}$/.test(target.workspace)
    && (target.social || (target.agent && target.conversation))
    ? read('/v1/workspaces?limit=100', AbortSignal.timeout(4000)) : null;
  early = {document: view.document, href, ...reads, sharedRequest};
}

export function takeChatReads(document) {
  const requests = early;
  early = null;
  return requests && requests.document === document && requests.href === document.defaultView?.location.href ? requests : null;
}
