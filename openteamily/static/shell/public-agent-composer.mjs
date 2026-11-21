import {PUBLIC_AGENT_MESSAGE_LIMIT, stagePublicAgentOpening} from './public-agent-link.mjs';

export function mountPublicAgentComposer(document) {
  const form = document.getElementById('public-agent-composer');
  const input = form?.querySelector('textarea[name="message"]');
  const submit = form?.querySelector('button[type="submit"]');
  const status = document.getElementById('public-agent-composer-status');
  const view = document.defaultView;
  if (!input || !submit || !status || !view) return;

  function update() {
    submit.disabled = !input.value.trim() || input.value.length > PUBLIC_AGENT_MESSAGE_LIMIT;
    status.hidden = true;
    status.textContent = '';
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    if (submit.disabled) return;
    const continuation = stagePublicAgentOpening(view, {
      slug: form.dataset.slug, listingId: form.dataset.listingId, text: input.value,
    });
    if (!continuation) {
      status.textContent = '此浏览器暂时无法保留草稿。可先复制消息，再打开对话。';
      status.hidden = false;
      return;
    }
    submit.disabled = true;
    view.location.assign('/login' + continuation);
  });
  input.addEventListener('input', update);
  view.addEventListener('pageshow', event => { if (event.persisted) update(); });
  input.disabled = false;
  update();
}

if (typeof document !== 'undefined') mountPublicAgentComposer(document);
