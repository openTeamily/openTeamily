export function csrfCookie(source) {
  const match = /(?:^|;\s*)(?:__Host-ot_csrf|ot_dev_csrf)=([^;]+)/.exec(source || '');
  return match ? decodeURIComponent(match[1]) : '';
}

export function validName(value) {
  const name = (value || '').trim();
  return name.length >= 1 && name.length <= 60;
}

export function validSlug(value) {
  return /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(value || '');
}

export function step1Ready(values) {
  return validName(values.name) && validSlug(values.slug);
}

export function readWizard(form) {
  const data = new FormData(form);
  const mode = data.get('mode') || 'new';
  return {
    name: (data.get('name') || '').trim(),
    slug: (data.get('slug') || '').trim(),
    mode,
    workspace_id: mode === 'convert' ? (data.get('workspace_id') || '') : undefined,
  };
}

// The invite endpoint (POST /v1/workspaces/<id>/invites) takes a role and an
// expiry in seconds; its defaults are member and seven days.
const INVITE_EXPIRY = [86400, 604800, 2592000];

export function inviteValues(document) {
  const roleField = document.getElementById('invite-role');
  const expiryField = document.getElementById('invite-expiry');
  const expires = Number(expiryField ? expiryField.value : 0);
  return {
    role: roleField && roleField.value === 'admin' ? 'admin' : 'member',
    expires_in: INVITE_EXPIRY.includes(expires) ? expires : 604800,
  };
}

// The invite object has no email field, and the endpoint rejects unknown ones, so
// an address typed in the wizard only ever becomes a link in the user's own mail
// client. Nothing is sent to the server and no mail is claimed to be sent.
export function inviteMailto(email, teamName, token) {
  const address = (email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) || /[\r\n]/.test(address)) return '';
  const subject = '邀请你加入团队「' + (teamName || 'OpenTeamily 团队') + '」';
  const body = '邀请令牌：' + token + '\n\n在 OpenTeamily 的成员页「接受邀请」里粘贴这个令牌即可加入。令牌只显示一次。';
  return 'mailto:' + encodeURI(address) + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
}

// Renders the server's own invite object; it carries no email, so none is shown.
export function inviteSummary(invite) {
  if (!invite) return '';
  const role = invite.role === 'admin' ? '管理员' : '成员';
  const seconds = Number(invite.expires);
  const day = Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString().slice(0, 10) : '';
  const uses = Number.isFinite(Number(invite.max_uses)) ? Number(invite.max_uses) : 1;
  return [role, day ? '有效期至 ' + day : '', '最多使用 ' + uses + ' 次'].filter(Boolean).join(' · ');
}

function messageFor(error, fallback) {
  if (error && error.message) return error.message;
  return fallback;
}

function idempotencyKey() {
  const bytes = new Uint8Array(18);
  globalThis.crypto.getRandomValues(bytes);
  let text = '';
  for (const value of bytes) text += String.fromCharCode(value);
  return globalThis.btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function mount(document, {fetcher = globalThis.fetch.bind(globalThis)} = {}) {
  const status = document.getElementById('status');
  const loginPanel = document.getElementById('login-panel');
  const mainPanel = document.getElementById('main-panel');
  const form = document.getElementById('wizard-form');
  let step = 1;
  let owned = [];
  let created = null;
  let invited = false;
  let busy = false;

  function show(kind, text) {
    status.dataset.kind = kind;
    status.textContent = text;
  }

  async function request(method, path, body, extraHeaders) {
    const headers = {'Accept': 'application/json', 'X-CSRF-Token': csrfCookie(document.cookie)};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (extraHeaders) Object.assign(headers, extraHeaders);
    const response = await fetcher(path, {
      method, headers, credentials: 'same-origin',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let parsed = {};
    try { parsed = await response.json(); } catch { parsed = {}; }
    return {status: response.status, body: parsed};
  }

  function syncContinue() {
    document.getElementById('next').disabled = !step1Ready(readWizard(form));
  }

  function syncConvertPicker() {
    const values = readWizard(form);
    const converting = values.mode === 'convert';
    const needsPicker = converting && owned.length > 1;
    const note = document.getElementById('convert-workspace-note');
    const field = document.getElementById('convert-workspace-field');
    if (note) note.hidden = !converting;
    if (field) field.hidden = !needsPicker;
  }

  function renderStep() {
    document.getElementById('step-1').hidden = step !== 1;
    document.getElementById('step-2').hidden = step !== 2;
    document.getElementById('step-3').hidden = step !== 3;
    document.getElementById('back').hidden = step === 1;
    document.getElementById('next').hidden = step !== 1;
    document.getElementById('submit').hidden = step !== 2;
    document.getElementById('invite-skip').hidden = step !== 2;
    const label = document.getElementById('wizard-step-label');
    if (label) label.textContent = '第 ' + step + ' / 3 步';
    const progress = document.getElementById('wizard-progress');
    if (progress && progress.querySelectorAll) {
      const dots = progress.querySelectorAll('.wizard-dots span');
      for (let index = 0; index < dots.length; index += 1) {
        if (dots[index].classList) dots[index].classList.toggle('is-current', index === step - 1);
      }
    }
    syncContinue();
    syncConvertPicker();
  }

  function resetWizard() {
    step = 1;
    created = null;
    invited = false;
    busy = false;
    document.getElementById('submit').disabled = false;
    document.getElementById('invite-result').hidden = true;
    document.getElementById('invite-summary').textContent = '';
    document.getElementById('invite-token').textContent = '';
    document.getElementById('invite-mailto').hidden = true;
    form.reset();
    form.elements.mode.value = 'new';
    renderStep();
  }

  async function renderProviders() {
    const box = document.getElementById('oidc-providers');
    if (!box) return;
    box.textContent = '';
    const listed = await request('GET', '/v1/auth/providers');
    if (listed.status !== 200 || !listed.body.items || !listed.body.items.length) return;
    for (const item of listed.body.items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = '使用 ' + item.label + ' 登录';
      button.addEventListener('click', async () => {
        const started = await request('POST', '/v1/auth/oidc/start', {provider: item.id});
        if (started.status !== 200 || !started.body.authorization_url) {
          show('error', messageFor(started.body.error, '无法开始第三方登录。'));
          return;
        }
        globalThis.location.assign(started.body.authorization_url);
      });
      box.appendChild(button);
    }
  }

  async function load() {
    const session = await request('GET', '/v1/auth/session');
    if (session.status === 401) {
      loginPanel.hidden = false;
      mainPanel.hidden = true;
      show('', '');
      await renderProviders();
      return;
    }
    if (session.status !== 200) {
      show('error', messageFor(session.body.error, '无法读取会话。'));
      return;
    }
    loginPanel.hidden = true;
    mainPanel.hidden = false;
    const whoami = document.getElementById('whoami');
    if (whoami) whoami.textContent = session.body.user.username;
    const listed = await request('GET', '/v1/workspaces?limit=100');
    const items = listed.status === 200 ? (listed.body.items || []) : [];
    owned = items.filter(item => item.owner_id === session.body.user.id && item.kind !== 'team');
    const select = form.elements.workspace_id;
    const previous = select.value;
    select.textContent = '';
    for (const item of owned) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.name;
      select.appendChild(option);
    }
    if (previous && owned.some(item => item.id === previous)) select.value = previous;
    renderStep();
  }

  document.getElementById('login-form').addEventListener('submit', async event => {
    event.preventDefault();
    const result = await request('POST', '/v1/auth/login', {
      username: document.getElementById('username').value,
      password: document.getElementById('password').value,
    });
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '登录失败。'));
      return;
    }
    document.getElementById('password').value = '';
    await load();
  });

  form.addEventListener('input', () => {
    syncContinue();
    syncConvertPicker();
  });
  form.addEventListener('change', () => {
    syncContinue();
    syncConvertPicker();
  });

  function advance() {
    const values = readWizard(form);
    if (!step1Ready(values)) {
      show('error', '请先填好团队名称和 Team ID。');
      return;
    }
    if (values.mode === 'convert' && owned.length > 0 && !values.workspace_id) {
      show('error', '当前没有可转换的工作区。');
      return;
    }
    show('', '');
    step = 2;
    renderStep();
  }

  async function createAndInvite(withInvite) {
    if (busy) return;
    if (invited) {
      step = 3;
      renderStep();
      return;
    }
    const values = readWizard(form);
    if (!step1Ready(values)) {
      show('error', '请先填好团队名称和 Team ID。');
      step = 1;
      renderStep();
      return;
    }
    if (values.mode === 'convert' && !values.workspace_id) {
      show('error', '当前没有可转换的工作区。');
      return;
    }
    busy = true;
    try {
      if (!created) {
        const body = {name: values.name, slug: values.slug, mode: values.mode};
        if (values.mode === 'convert') body.workspace_id = values.workspace_id;
        const result = await request('POST', '/v1/teams', body, {'Idempotency-Key': idempotencyKey()});
        if (result.status !== 200 && result.status !== 201) {
          show('error', messageFor(result.body.error, '创建团队失败。'));
          return;
        }
        const workspace = result.body.workspace || {};
        if (!workspace.id) {
          show('error', '创建团队失败：响应里没有工作区。');
          return;
        }
        created = workspace;
      }
      if (!withInvite) {
        step = 3;
        show('ok', '团队已创建。');
        renderStep();
        return;
      }
      const result = await request('POST', '/v1/workspaces/' + created.id + '/invites', inviteValues(document));
      if (result.status !== 201) {
        // The team exists by now; say so instead of implying nothing happened.
        show('error', '团队已创建，但邀请没有发出去：' + messageFor(result.body.error, '无法生成邀请。'));
        return;
      }
      invited = true;
      document.getElementById('invite-summary').textContent = inviteSummary(result.body.invite);
      document.getElementById('invite-token').textContent = result.body.token || '';
      const mail = document.getElementById('invite-mailto');
      if (mail) {
        const address = (document.getElementById('invite-email') || {}).value || '';
        const href = inviteMailto(address, created.name, result.body.token || '');
        mail.hidden = !href;
        if (href) {
          mail.setAttribute('href', href);
          mail.textContent = '写邮件给 ' + address.trim();
        }
      }
      document.getElementById('invite-result').hidden = false;
      document.getElementById('submit').disabled = true;
      show('ok', '团队已创建，邀请已生成。复制令牌发给同事即可。');
    } finally {
      busy = false;
    }
  }

  document.getElementById('next').addEventListener('click', () => {
    advance();
  });

  document.getElementById('back').addEventListener('click', () => {
    if (step > 1) step -= 1;
    renderStep();
  });

  document.getElementById('invite-skip').addEventListener('click', () => createAndInvite(false));

  document.getElementById('copy-invite').addEventListener('click', async () => {
    const token = document.getElementById('invite-token').textContent;
    try {
      await globalThis.navigator.clipboard.writeText(token);
      show('ok', '已复制邀请令牌，粘贴给同事即可。');
    } catch {
      show('error', '这个浏览器不允许自动复制，请手动选中令牌。');
    }
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (step === 1) {
      advance();
      return;
    }
    if (step === 2) await createAndInvite(true);
  });

  document.getElementById('logout-form').addEventListener('submit', async event => {
    event.preventDefault();
    const result = await request('POST', '/v1/auth/logout', {});
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '退出失败。'));
      return;
    }
    resetWizard();
    await load();
  });

  return load();
}

if (globalThis.document && globalThis.document.getElementById('wizard-form')) {
  mount(globalThis.document);
}
