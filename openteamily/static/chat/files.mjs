import { bindModel3dPreview } from '../shell/model3d-preview.mjs';
import { artifactVersionLabel } from '../shell/thumb.mjs';

export const MAX_CHAT_FILE_BYTES = 8 * 1024 * 1024;
export const AGENT_FILE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,.pdf,.txt,.md,.csv,.tsv,.json,.docx,.xlsx,.pptx';
const AGENT_FILE_EXT = new Set(['png','jpg','jpeg','gif','webp','pdf','txt','md','csv','tsv','json','docx','xlsx','pptx']);

const MEDIA_TYPES = {
  png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp',
  mp4:'video/mp4', webm:'video/webm', mp3:'audio/mpeg', ogg:'audio/ogg', wav:'audio/wav', m4a:'audio/mp4',
};

function fileType(file) {
  const extension = file.name.toLowerCase().split('.').at(-1);
  return Object.hasOwn(MEDIA_TYPES, extension) ? MEDIA_TYPES[extension] : file.type;
}
const formatBytes = bytes => bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB'
  : bytes >= 1024 ? Math.round(bytes / 1024) + ' KB' : bytes + ' B';

function mediaElement(document, mime, url, title, pending) {
  if (!url) return null;
  if (mime?.startsWith('image/')) {
    const image = document.createElement('img');
    image.src = url;
    image.alt = title;
    if (!pending) image.loading = 'lazy';
    image.decoding = 'async';
    return image;
  }
  if (mime?.startsWith('video/') || mime?.startsWith('audio/')) {
    const media = document.createElement(mime.startsWith('video/') ? 'video' : 'audio');
    media.src = url;
    media.controls = !pending;
    media.preload = pending ? 'metadata' : 'none';
    media.playsInline = true;
    media.setAttribute('aria-label', title);
    return media;
  }
  return null;
}

export function chatFileDownload(document, attachment) {
  if (!attachment.path) return null;
  const title = attachment.title || '附件';
  const link = document.createElement('a');
  const separator = attachment.path.includes('?') ? '&' : '?';
  link.href = attachment.path + (attachment.bytes === undefined ? '' : separator + 'download=1');
  if (attachment.bytes !== undefined) link.download = title;
  link.textContent = '下载';
  link.setAttribute('aria-label', '下载' + title);
  return link;
}

export function renderChatFile(document, attachment, {pending = false} = {}) {
  const card = document.createElement('article');
  card.className = 'chat-file';
  const title = attachment.resource?.title || attachment.title || '附件';
  const media = mediaElement(document, attachment.mime, attachment.path, title, pending);
  if (media) card.append(media);
  const details = document.createElement('div');
  details.className = 'chat-file-details';
  const info = document.createElement('span');
  info.className = 'chat-file-info';
  const name = document.createElement('strong');
  name.textContent = title;
  info.append(name);
  const version = artifactVersionLabel(attachment.resource, attachment.mime);
  if (version) {
    const meta = document.createElement('small');
    meta.textContent = version;
    info.append(meta);
  }
  if (Number.isSafeInteger(attachment.bytes)) {
    const size = document.createElement('small');
    size.textContent = formatBytes(attachment.bytes);
    info.append(size);
  }
  details.append(info);
  const download = pending ? null : chatFileDownload(document, attachment);
  if (download) details.append(download);
  card.append(details);
  if (!pending && attachment.path && attachment.mime === 'model/gltf-binary') {
    card.classList.add('chat-file-model3d');
    card.dataset.model3dSource = attachment.path;
    const button = document.createElement('button');
    button.className = 'chat-file-model3d-toggle';
    button.type = 'button';
    const status = document.createElement('p');
    status.className = 'model3d-preview-status';
    status.setAttribute('role', 'status');
    const preview = document.createElement('div');
    preview.className = 'chat-file-model3d-preview model3d-preview-frame';
    details.append(button);
    card.append(status, preview);
    bindModel3dPreview(button, preview, status).setSource(attachment.path);
  }
  return card;
}

function uploadForm(view, url, headers, body, onProgress, timeout = 180_000) {
  return new Promise((resolve, reject) => {
    const xhr = new view.XMLHttpRequest();
    xhr.open('POST', url);
    xhr.responseType = 'json';
    xhr.timeout = timeout;
    for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) onProgress(Math.min(99, Math.round(event.loaded * 100 / event.total)));
    };
    xhr.upload.onload = () => onProgress(100);
    xhr.onload = () => resolve({status: xhr.status, body: xhr.response || {}});
    xhr.onerror = xhr.ontimeout = () => reject(new Error('Upload interrupted'));
    xhr.send(body);
  });
}

export function sendPrivateAttachmentMessage(view, path, message, files, headers, onProgress) {
  const form = new view.FormData();
  form.set('body', message.body || '');
  if (message.chat_language) form.set('chat_language', message.chat_language);
  if (message.reply_language) form.set('reply_language', message.reply_language);
  for (const file of files) form.append('file',file);
  return uploadForm(view,path,headers,form,onProgress,240_000);
}

function errorText(result) {
  const code = result.body?.error?.code;
  if (code === 'reply_unavailable') return '原消息已不可回复，请取消引用后重新选择文件。';
  if (code === 'attachment_storage_full') return '附件存储空间已满。';
  if (code === 'attachment_type_blocked') return '文件格式不受支持，或内容与扩展名不符。';
  if (result.status === 413) return '文件太大，最大支持 8 MB。';
  if ([401, 403, 404].includes(result.status)) return '无法访问这段会话。';
  return '发送失败，点击重试。';
}

export function mountChatFiles(document, {context, ownerId, csrfToken, createKey, sent}) {
  const input = document.getElementById('chat-attachment');
  if (!input) return {render() {}, reset() {}};
  const view = document.defaultView;
  const messageList = document.getElementById('message-list');
  const empty = document.getElementById('chat-empty');
  const scroller = document.getElementById('message-scroller');
  const status = document.getElementById('chat-upload-error');
  const jobs = new Set();
  const drafts = new Map();
  const draftRail = document.getElementById('agent-file-draft');
  const field = document.getElementById('chat-body');
  const draftFiles = scope => (drafts.get(scope) || []).map(item => item.file);
  const make = (tag, text) => {
    const el = document.createElement(tag);
    if (text) el.textContent = text;
    return el;
  };

  function render() {
    const current = context();
    for (const job of jobs) {
      if (current?.scope === job.destination.scope) messageList.append(job.node);
      else job.node.remove();
    }
    if (messageList.children.length) empty.hidden = true;
    if (draftRail) {
      const items = current?.private ? drafts.get(current.scope) || [] : [];
      draftRail.hidden = items.length === 0;
      draftRail.replaceChildren(...items.map(item => item.card));
      field.required = items.length === 0;
    }
  }

  function remove(job) {
    jobs.delete(job);
    job.node.remove();
    if (job.preview) view.URL.revokeObjectURL(job.preview);
    empty.hidden = messageList.children.length > 0;
  }

  async function drain() {
    const waiting = [...jobs].find(job => job.phase === 'waiting');
    if (!waiting || [...jobs].some(job => job.phase === 'sending')) return;
    const job = waiting;
    job.phase = 'sending';
    job.feedback.textContent = '正在上传…';
    job.progress.hidden = false;
    job.progress.value = 0;
    job.actions.hidden = true;
    try {
      if (ownerId() !== job.destination.owner) {
        remove(job);
        return;
      }
      const form = new view.FormData();
      form.append('file',job.file);
      if (job.destination.reply) form.set('reply_to', job.destination.reply.message_id);
      const result = await uploadForm(view, job.destination.path, {
        Accept: 'application/json',
        'X-CSRF-Token': csrfToken(), 'Idempotency-Key': job.key,
      }, form, percentage => { job.progress.value = percentage; });
      if (!jobs.has(job)) return;
      if (![200, 201].includes(result.status) || !result.body?.message?.attachment) {
        throw new Error(errorText(result));
      }
      remove(job);
      sent(job.destination, result.body.message);
    } catch (error) {
      if (!jobs.has(job)) return;
      job.phase = 'failed';
      job.progress.hidden = true;
      job.feedback.textContent = error?.message === 'Upload interrupted' ? '连接中断，点击重试。'
        : error instanceof Error ? error.message : '发送失败，点击重试。';
      job.actions.hidden = false;
    } finally {
      void drain();
    }
  }

  function enqueue(file, destination) {
    const mime = fileType(file);
    const preview = mime?.startsWith('image/') || mime?.startsWith('video/') ? view.URL.createObjectURL(file) : '';
    const node = make('li');
    node.className = 'mine';
    node.dataset.filePending = '1';
    const card = renderChatFile(document, {title:file.name, bytes:file.size, mime, path:preview}, {pending:true});
    const feedback = make('p', '等待上传…');
    feedback.setAttribute('role', 'status');
    const progress = make('progress');
    progress.hidden = true;
    progress.max = 100;
    progress.value = 0;
    progress.setAttribute('aria-label', '上传进度');
    const actions = make('div');
    actions.className = 'chat-file-actions';
    actions.hidden = true;
    const retry = make('button', '重试');
    const discard = make('button', '移除');
    retry.type = discard.type = 'button';
    const job = {destination, key:createKey(), file, preview, node, feedback, progress, actions, phase:'waiting'};
    retry.addEventListener('click', () => {
      job.phase = 'waiting';
      job.actions.hidden = true;
      job.feedback.textContent = '等待上传…';
      void drain();
    });
    discard.addEventListener('click', () => remove(job));
    actions.append(retry, discard);
    card.append(feedback, progress, actions);
    node.append(card);
    jobs.add(job);
  }

  function clearDraft(scope, files = draftFiles(scope)) {
    const kept = [];
    for (const item of drafts.get(scope) || []) {
      if (files.includes(item.file)) {
        if (item.preview) view.URL.revokeObjectURL(item.preview);
      } else kept.push(item);
    }
    if (kept.length) drafts.set(scope,kept);
    else drafts.delete(scope);
    render();
  }

  function stageFiles(scope, files) {
    const existing = drafts.get(scope) || [];
    const valid = files.filter(file => AGENT_FILE_EXT.has(file.name.toLowerCase().split('.').at(-1)));
    if (valid.length !== files.length) status.textContent = '智能体私聊支持图片、PDF、Office 文档和文本文件。';
    let bytes = existing.reduce((sum,item) => sum + item.file.size,0);
    const before = existing.length;
    for (const file of valid) {
      if (existing.length >= 4 || bytes + file.size > MAX_CHAT_FILE_BYTES) {
        status.textContent = '每条消息最多 4 个附件，合计 8 MB。';
        break;
      }
      bytes += file.size;
      const mime = fileType(file), preview = mime?.startsWith('image/') ? view.URL.createObjectURL(file) : '';
      const card = renderChatFile(document,{title:file.name,mime,bytes:file.size,path:preview},{pending:true});
      const remove = make('button','×');
      remove.type = 'button';
      remove.setAttribute('aria-label','移除 '+file.name);
      remove.className = 'agent-file-remove';
      remove.addEventListener('click',() => {
        const current = context();
        if (current?.private) clearDraft(current.scope,[file]);
      });
      card.append(remove);
      existing.push({file,card,preview});
    }
    if (existing.length) drafts.set(scope,existing);
    render();
    return existing.length - before;
  }

  function addFiles(picked, scope) {
    const destination = context();
    if (!destination || !picked.length || (scope !== undefined && destination.scope !== scope)) return 0;
    status.textContent = '';
    const accepted = picked.filter(file => file.size > 0 && file.size <= MAX_CHAT_FILE_BYTES);
    if (accepted.length !== picked.length) status.textContent = '空文件和超过 8 MB 的文件无法发送。';
    if (destination.private) {
      return stageFiles(destination.scope,accepted);
    }
    for (const file of accepted) enqueue(file, destination);
    render();
    if (accepted.length) scroller.scrollTop = scroller.scrollHeight;
    void drain();
    return accepted.length;
  }

  input.addEventListener('change', () => {
    const picked = [...input.files];
    input.value = '';
    addFiles(picked);
  });
  return {render,draftFiles,clearDraft,addFiles, moveDraft(from,to) {
    const saved = drafts.get(from);
    if (saved) {
      drafts.set(to,saved);
      drafts.delete(from);
    }
    render();
  }, reset() {
    for (const scope of drafts.keys()) clearDraft(scope);
    for (const job of jobs) remove(job);
    status.textContent = '';
  }};
}
