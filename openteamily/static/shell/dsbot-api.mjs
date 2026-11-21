// Browser half of the DS-Bot plugin's legacy /v1 compatibility.
// When this page was served by the user's own DS-Bot (the plugin marks such
// pages with <meta name="openteamily-served-by" content="ds-bot">), legacy /v1
// calls of features that moved into DS-Bot are sent to that DS-Bot as
//   POST /b/api/openteamily {endpoint: '<feature>/v1', payload: {method, path, body, idempotency_key}}
// and the answer is turned back into an ordinary Response, so the page code is
// unchanged. Download links of moved routes are fetched the same way and saved.
// On pages served by the legacy platform this module does nothing.
export const MOUNT = '/b';
export const API_ROUTE = `${MOUNT}/api/openteamily`;

// Page-facing route -> feature that serves it inside DS-Bot.
export const MOVED = [
  [/^\/v1\/skills\/(?:catalog|bindings|installed|packages(?:\/import-[a-z0-9][a-z0-9-]{1,39}(?:\/(?:revoke|versions(?:\/[0-9.]+)?))?)?)$/, 'skills'],
  [/^\/v1\/skill-secrets$/, 'skill-secrets'],
  [/^\/v1\/workspaces\/[0-9a-f]{32}\/overview$/, 'overview'],
  [/^\/v1\/team-templates$/, 'team-templates'],
  [/^\/v1\/workspaces\/[0-9a-f]{32}\/team-templates\/[a-z0-9-]{3,40}$/, 'team-templates'],
  [/^\/v1\/contacts(?:\/(?:lookup|otcpt_[A-Za-z0-9_-]{1,80}))?$/, 'social'],
  [/^\/v1\/workspaces\/[0-9a-f]{32}\/notifications(?:\/read)?$/, 'social'],
  [/^\/v1\/(?:automation-templates|onboarding\/automations)$/, 'automations'],
  [/^\/v1\/workspaces\/[0-9a-f]{32}\/automations(?:\/(?:tick|[0-9a-f]{32}))?$/, 'automations'],
  [/^\/v1\/workspaces\/[0-9a-f]{32}\/automations\/[0-9a-f]{32}\/(?:run|remove|runs(?:\/[0-9a-f]{32}(?:\/(?:cancel|retry|artifact))?)?)$/, 'automations'],
  [/^\/v1\/workspaces\/[0-9a-f]{32}\/agents\/[0-9a-f]{32}\/api-keys(?:\/[0-9a-f]{32}\/revoke)?$/, 'agent-api'],
  [/^\/v1\/workspaces\/[0-9a-f]{32}\/agents\/[0-9a-f]{32}\/conversations\/[0-9a-f]{32}\/memory\/capture$/, 'agents'],
  [/^\/v1\/workspaces\/[0-9a-f]{32}\/agents(?:\/[0-9a-f]{32}(?:\/(?:archive|conversations(?:\/[0-9a-f]{32}(?:\/(?:attachments|reply-progress|messages(?:\/[0-9a-f]{32}\/(?:artifact|files\/[0-3]))?))?)?))?)?$/, 'agents'],
  [/^\/v1\/workspaces\/[0-9a-f]{32}\/meetings(?:\/(?:draft|speech|transcribe|share-recipients|shared(?:\/[0-9a-f]{32}(?:\/revoke)?)?|[0-9a-f]{32}(?:\/(?:remove|export|shares))?))?$/, 'meetings'],
  [/^\/v1\/workspaces\/[0-9a-f]{32}\/memory(?:\/[0-9a-f]{32}(?:\/(?:remove|export|share-group|dream(?:\/[0-9a-f]{32})?|versions(?:\/\d{1,8}(?:\/restore)?)?))?)?$/, 'memory'],
  [/^\/v1\/workspaces\/[0-9a-f]{32}\/memory\/actions\/draft(?:\/save)?$/, 'memory'],
  [/^\/v1\/workspaces\/[0-9a-f]{32}\/memory\/(?:candidates(?:\/[0-9a-f]{32})?|profile(?:\/dream)?|graph|(?:actions|links|preferences)(?:\/[0-9a-f]{32}(?:\/remove)?)?)$/, 'memory'],
  [/^\/v1\/workspaces\/[0-9a-f]{32}\/search\/(?:messages|resources)$/, 'search'],
  [/^\/v1\/workspaces\/[0-9a-f]{32}\/artifacts\/(?:activity|(?:spreadsheet|slides)\/draft)$/, 'artifacts'],
  [/^\/v1\/workspaces\/[0-9a-f]{32}\/artifacts(?:\/[0-9a-f]{32}(?:\/(?:remove|favorite|preview|file|export|restore|versions(?:\/\d{1,8}(?:\/export)?)?|shares(?:\/[0-9a-f]{32}(?:\/revoke)?)?))?)?$/, 'artifacts'],
  // B4: account settings, onboarding and look live in the user's DS-Bot.
  // Auth and the Composio callback bounce page stay on the platform.
  [/^\/v1\/settings$/, 'settings'],
  [/^\/v1\/notification-prefs$/, 'settings'],
  [/^\/v1\/onboarding(?:\/(?:recommendations|picks|look))?$/, 'settings'],
  [/^\/v1\/model-api(?:\/(?:image|video|music|model3d))?$/, 'model-api'],
  [/^\/v1\/workspaces\/[0-9a-f]{32}\/images(?:\/[0-9a-f]{32})?$/, 'images'],
  [/^\/v1\/workspaces\/[0-9a-f]{32}\/videos(?:\/[0-9a-f]{32})?$/, 'videos'],
  [/^\/v1\/workspaces\/[0-9a-f]{32}\/music(?:\/[0-9a-f]{32})?$/, 'music'],
  [/^\/v1\/workspaces\/[0-9a-f]{32}\/websites(?:\/[0-9a-f]{32})?$/, 'websites'],
  [/^\/v1\/workspaces\/[0-9a-f]{32}\/models-3d(?:\/[0-9a-f]{32})?$/, 'model3d'],
  [/^\/v1\/composio$/, 'connectors'],
  [/^\/v1\/composio\/key$/, 'connectors'],
  [/^\/v1\/composio\/toolkits$/, 'connectors'],
  [/^\/v1\/composio\/connections(?:\/[0-9a-f]{32}(?:\/disconnect)?)?$/, 'connectors'],
  [/^\/v1\/composio\/approvals(?:\/[0-9a-f]{32})?$/, 'connectors'],
  [/^\/v1\/mcp\/servers(?:\/[0-9a-f]{32})?$/, 'connectors'],
  // Stream C: workspaces/teams, members, invites, directory, messenger and discover (Bot Social).
  [/^\/v1\/skills\/(?:scopes|readiness|runs)$/, 'skills'],
  [/^\/v1\/runtime\/(?:connections|tasks(?:\/[0-9a-f]{32}\/(?:cancel|artifact))?)$/, 'skills'],
  [/^\/v1\/workspaces$/, 'teams'],
  [/^\/v1\/teams$/, 'teams'],
  [/^\/v1\/workspaces\/[0-9a-f]{32}\/members(?:\/[A-Za-z0-9._-]{1,80}(?:\/(?:remove|suspend|unsuspend))?)?$/, 'members'],
  [/^\/v1\/workspaces\/[0-9a-f]{32}\/invites(?:\/[A-Za-z0-9._-]{1,80}\/(?:revoke|freeze|unfreeze))?$/, 'invites'],
  [/^\/v1\/invites\/(?:accept|preview)$/, 'invites'],
  [/^\/v1\/workspaces\/[0-9a-f]{32}\/join-requests(?:\/[A-Za-z0-9._-]{1,80}\/(?:approve|reject))?$/, 'invites'],
  [/^\/v1\/join-requests$/, 'invites'],
  [/^\/v1\/team-directory$/, 'teams'],
  [/^\/v1\/team-directory\/[A-Za-z0-9._-]{1,80}\/join$/, 'teams'],
  [/^\/v1\/workspaces\/[0-9a-f]{32}\/directory$/, 'teams'],
  [/^\/v1\/workspaces\/[0-9a-f]{32}\/social\/conversations(?:\/[A-Za-z0-9._-]{1,80}(?:\/[A-Za-z0-9._\/-]{1,120})?)?$/, 'messenger'],
  [/^\/v1\/meeting-calls\/(?:create|preview|join|poll|signal|leave|end)$/, 'messenger'],
  [/^\/v1\/profile\/(?:social|follow-work)$/, 'discover'],
  [/^\/v1\/discover\/(?:agents|works|me\/works)$/, 'discover'],
  [/^\/v1\/discover\/agents\/[a-z0-9][a-z0-9-]{1,28}[a-z0-9]\/(?:start|remix)$/, 'discover'],
  [/^\/v1\/workspaces\/[0-9a-f]{32}\/artifacts\/[0-9a-f]{32}\/discover(?:\/revoke)?$/, 'discover'],
  [/^\/v1\/discover\/works\/[a-z0-9][a-z0-9-]{1,28}[a-z0-9](?:\/(?:engagement|comments(?:\/otwc_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}\/(?:like|remove))?))?$/, 'discover'],
  [/^\/v1\/workspaces\/[0-9a-f]{32}\/agents\/[0-9a-f]{32}\/discover(?:\/revoke)?$/, 'discover'],
];

export function servedByDsBot(doc = globalThis.document) {
  return Boolean(doc && doc.querySelector && doc.querySelector('meta[name="openteamily-served-by"][content="ds-bot"]'));
}

// Map a same-origin URL to {feature, path} or null to leave it alone.
export function movedTarget(input, origin, table = MOVED) {
  let url;
  try { url = new URL(input, origin); } catch { return null; }
  if (url.origin !== origin || !url.pathname.startsWith('/v1/')) return null;
  const row = table.find(([pattern]) => pattern.test(url.pathname));
  return row ? { feature: row[1], path: url.pathname + url.search } : null;
}

export async function readWorkspaceChoices(request, sharedPath) {
  const unavailable = {status: 0, body: {}};
  const shared = request('GET', sharedPath).catch(() => unavailable);
  const initial = await request('GET', '/v1/workspaces?scope=personal').catch(() => unavailable);
  const local = initial.status === 200 ? (initial.body.items || []) : [];
  if (!local.length) return {initial: await shared, supplemental: null};
  const supplemental = shared.then(result => {
    if (result.status !== 200) return result;
    const items = result.body.items || [];
    const missing = local.filter(item => !items.some(other => other.id === item.id));
    return {...result, body: {...result.body, items: [...missing, ...items]}};
  });
  return {initial, supplemental};
}

async function encodeBody(body) {
  if (body == null || body === '') return undefined;
  if (typeof body === 'string') return JSON.parse(body);
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    const fields = {}, files = {};
    for (const [name, value] of body.entries()) {
      if (typeof value === 'string') { fields[name] = value; continue; }
      const bytes = new Uint8Array(await value.arrayBuffer());
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      files[name] = { filename: value.name || 'file', content_type: value.type || 'application/octet-stream', data: btoa(binary) };
    }
    return { _multipart: true, fields, files };
  }
  return body && typeof body === 'object' ? body : undefined;
}

export function envelope(target, method, headers, body) {
  const payload = { method: String(method || 'GET').toUpperCase(), path: target.path };
  const key = headers && (typeof headers.get === 'function' ? headers.get('Idempotency-Key') : (headers['Idempotency-Key'] || headers['idempotency-key']));
  if (key) payload.idempotency_key = key;
  if (typeof body === 'string' && body) payload.body = JSON.parse(body);
  else if (body && typeof body === 'object') payload.body = body;
  return { endpoint: `${target.feature}/v1`, payload };
}

function downloadDisposition(download) {
  const filename = String(download.filename || 'download').replace(/[\ud800-\udfff]/gu, '\ufffd');
  const fallback = filename.replace(/[^ -~]|["\\/]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16));
  return `${download.inline ? 'inline' : 'attachment'}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function responseFilename(response) {
  const header = response.headers.get('Content-Disposition') || '';
  const extended = /;\s*filename\*=UTF-8''([^;]+)/i.exec(header);
  if (extended) {
    try { return decodeURIComponent(extended[1]); } catch {}
  }
  return /;\s*filename="([^"]+)"/i.exec(header)?.[1] || 'download';
}

export function toResponse(value) {
  const download = value.download;
  if (download) {
    let bytes;
    if (Uint8Array.fromBase64) bytes = Uint8Array.fromBase64(download.data);
    else {
      const binary = atob(download.data);
      bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    }
    return new Response(bytes, {status: value.status, headers: {
      'Content-Type': download.content_type,
      'Content-Length': String(bytes.byteLength),
      'Content-Disposition': downloadDisposition(download),
    }});
  }
  return new Response(JSON.stringify(value.body ?? {}), { status: value.status, headers: { 'Content-Type': 'application/json' } });
}

export function install(win = globalThis.window) {
  if (!win || win.__openteamilyDsBotShim || !servedByDsBot(win.document)) return null;
  const origin = win.location.origin;
  const original = win.fetch.bind(win);
  async function viaDsBot(target, method, headers, body, signal, keepalive) {
    const encoded = await encodeBody(body);
    const response = await original(API_ROUTE, {
      method: 'POST', credentials: 'same-origin', signal,
      ...(keepalive ? {keepalive} : {}),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(envelope(target, method, headers, encoded)),
    });
    const result = await response.json().catch(() => null);
    if (result && result.ok) return toResponse(result.value);
    return new Response(JSON.stringify({ error: { code: 'unavailable', message: (result && result.error && result.error.message) || 'DS-Bot request failed' } }),
      { status: response.ok ? 502 : response.status, headers: { 'Content-Type': 'application/json' } });
  }
  win.fetch = async (input, init = {}) => {
    const isRequest = typeof input !== 'string' && !(input instanceof URL);
    const target = movedTarget(isRequest ? input.url : String(input), origin);
    if (!target) return original(input, init);
    const method = init.method || (isRequest ? input.method : 'GET');
    const headers = init.headers || (isRequest ? input.headers : undefined);
    const body = init.body !== undefined ? init.body : (isRequest && method !== 'GET' ? await input.clone().text() : undefined);
    return viaDsBot(target, method, headers, body, init.signal ?? (isRequest ? input.signal : undefined),
      init.keepalive ?? (isRequest ? input.keepalive : undefined));
  };
  win.document.addEventListener('click', async (event) => {
    const anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    const target = anchor ? movedTarget(anchor.getAttribute('href'), origin) : null;
    if (!target || (['messenger', 'agents'].includes(target.feature) && anchor.hasAttribute('download'))) return;
    event.preventDefault();
    const response = await viaDsBot(target, 'GET');
    if (!response.ok) {
      const status = win.document.getElementById('status');
      if (status) {
        status.dataset.kind = 'error';
        status.textContent = '无法下载文件，请重试。';
      }
      return;
    }
    const blob = await response.blob();
    const link = win.document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = responseFilename(response);
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  }, true);
  win.__openteamilyDsBotShim = { MOVED };
  return win.__openteamilyDsBotShim;
}

install();
