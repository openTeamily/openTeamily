const HEX = /^[0-9a-f]{32}$/;
const running = job => job?.state === 'queued' || job?.state === 'running';

export function mountVideoCreator(document, {request, context, key, share, onOpen, notify}) {
  const trigger = document.getElementById('composer-video-create');
  const dialog = document.getElementById('video-create-dialog');
  if (!trigger || typeof dialog?.showModal !== 'function') return {sync() {}};

  const element = name => document.getElementById('video-create-' + name);
  const form = element('form');
  const {prompt, shape} = form.elements;
  const submit = element('submit');
  const status = element('status');
  const settings = element('settings');
  const result = element('result');
  const preview = element('preview');
  const sendButton = element('send');
  const attempts = new Map();
  const sent = new Set();
  let session;
  let timer;

  const current = draft => dialog.open && session === draft && context()?.scope === draft.scope;
  const call = (method, path, body, headers) => request(method, path, body, headers)
    .catch(() => ({status: 0, body: {}}));

  function setForm(draft, busy) {
    submit.disabled = busy || !draft.configured;
    prompt.disabled = shape.disabled = busy;
  }

  function clearResult() {
    result.hidden = true;
    sendButton.hidden = true;
    preview.removeAttribute('src');
    preview.load();
  }

  function renderResult(draft, artifact) {
    const base = `/v1/workspaces/${draft.workspace}/artifacts/${artifact}`;
    preview.src = base + '/file';
    element('space').href = '/space?' + new URLSearchParams({workspace: draft.workspace, artifact});
    element('download').href = base + '/export';
    sendButton.hidden = !draft.sendLabel;
    sendButton.disabled = sent.has(draft.scope + artifact);
    sendButton.textContent = sendButton.disabled ? '已发送' : (draft.sendLabel || '发送到会话');
    result.hidden = false;
  }

  function render(draft, job) {
    clearTimeout(timer);
    draft.job = job;
    setForm(draft, running(job));
    settings.hidden = draft.configured;
    if (running(job)) {
      status.textContent = job.state === 'queued' ? '正在排队…' : '正在生成，可以关闭窗口。';
      timer = setTimeout(() => void poll(draft, job.id), 1800);
    } else if (job?.state === 'failed') {
      status.textContent = job.message || '视频生成失败，请重试。';
      settings.hidden = false;
    } else if (job?.state === 'succeeded' && HEX.test(job.artifact_id || '')) {
      status.textContent = '视频已保存到资料空间。';
      renderResult(draft, job.artifact_id);
    } else {
      status.textContent = draft.configured ? '' : '请先配置视频模型。';
    }
  }

  async function poll(draft, id) {
    const response = await call('GET', draft.path + '/' + encodeURIComponent(id));
    if (!current(draft)) return;
    if (response.status === 200 && response.body.job) {
      render(draft, response.body.job);
    } else if ([401, 403, 404].includes(response.status)) {
      status.textContent = '无法查看这个视频任务，请重新打开。';
    } else {
      status.textContent = '暂时无法读取进度，任务仍在后台运行。';
      timer = setTimeout(() => void poll(draft, id), 5000);
    }
  }

  trigger.addEventListener('click', async () => {
    const target = context();
    if (!target || dialog.open) return;
    const draft = session = {...target, path: `/v1/workspaces/${target.workspace}/videos`};
    const prior = attempts.get(draft.scope);
    const text = document.getElementById('chat-body').value.trim();
    prompt.value = prior?.values.prompt ?? (text.length <= 1000 ? text : '');
    shape.value = prior?.values.shape ?? 'landscape';
    onOpen();
    clearResult();
    setForm(draft, true);
    settings.hidden = true;
    status.textContent = '正在读取视频任务…';
    dialog.showModal();
    const response = await call('GET', draft.path);
    if (!current(draft)) return;
    if (response.status !== 200) {
      status.textContent = response.body.error?.message || '无法读取视频任务，请重新打开。';
      return;
    }
    draft.configured = response.body.configured === true;
    const job = response.body.job;
    if (running(job) || !prompt.value) {
      prompt.value = job?.prompt || '';
      shape.value = job?.shape || 'landscape';
    }
    render(draft, job);
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const draft = session;
    if (!draft || !current(draft) || submit.disabled) return;
    const values = {prompt: prompt.value.trim(), shape: shape.value};
    if (!values.prompt || values.prompt.length > 1000) return;
    const prior = attempts.get(draft.scope);
    const attempt = prior?.values.prompt === values.prompt && prior.values.shape === values.shape
      ? prior : {values, key: key()};
    attempts.set(draft.scope, attempt);
    setForm(draft, true);
    status.textContent = '正在提交…';
    clearResult();
    const response = await call('POST', draft.path, values, {'Idempotency-Key': attempt.key});
    const accepted = response.status === 202 && response.body.job;
    if (accepted && attempts.get(draft.scope) === attempt) attempts.delete(draft.scope);
    if (!current(draft)) return;
    if (accepted) {
      render(draft, response.body.job);
      return;
    }
    if (response.body.error?.code === 'video_unconfigured') {
      draft.configured = false;
      settings.hidden = false;
    }
    setForm(draft, false);
    status.textContent = response.body.error?.message || '尚未确认提交，请重试。';
  });

  sendButton.addEventListener('click', async () => {
    const draft = session;
    const artifact = draft?.job?.artifact_id;
    if (!draft?.sendLabel || !current(draft) || sendButton.disabled || draft.job?.state !== 'succeeded' || !HEX.test(artifact || '')) return;
    const sendKey = draft.scope + artifact;
    sendButton.disabled = true;
    status.textContent = '正在发送视频…';
    const response = await share(artifact, draft.scope).catch(() => ({status: 0, body: {}}));
    const delivered = [200, 201].includes(response.status);
    if (delivered) sent.add(sendKey);
    if (!current(draft)) return;
    if (delivered) {
      dialog.close();
      notify('ok', '视频已发送。', {announceOnly: true});
    } else {
      sendButton.disabled = false;
      status.textContent = response.body.error?.message || '尚未确认发送，请重试。';
    }
  });

  preview.addEventListener('error', () => {
    if (!result.hidden && session && current(session)) status.textContent = '视频已保存，暂时无法预览。';
  });
  element('close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    session = null;
    clearTimeout(timer);
    clearResult();
  });

  return {sync() {
    trigger.disabled = !context();
    if (dialog.open && session && !current(session)) dialog.close();
  }};
}
