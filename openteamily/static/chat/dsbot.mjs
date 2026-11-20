import { syncSkillsToDsBot } from '../shell/dsbot-skills.mjs';
// When this page is served by the user's own DS-Bot (@openteamily/web injects
// <meta name="openteamily-instance">), private chat with the personal agent runs in
// that DS-Bot: the legacy /v1 agent-conversation calls are translated to
// POST /b/api/openteamily {endpoint, payload}. Everything else stays on /v1.
export const PLUGIN_API = '/b/api/openteamily';

export function dsbotServed(document) {
  try { return Boolean(document.querySelector && document.querySelector('meta[name="openteamily-instance"]')); }
  catch { return false; }
}

const ID = '[A-Za-z0-9_-]{1,80}';

// → {endpoint, payload, shape, cid} or null when the call is not the personal agent's private chat.
export function dsbotRoute(method, path, body, personalAgentId) {
  if (!personalAgentId) return null;
  const match = new RegExp(`^/v1/workspaces/${ID}/agents/(${ID})/conversations(?:/(${ID})(/messages|/read)?)?(?:\\?.*)?$`).exec(String(path));
  if (!match || match[1] !== personalAgentId) return null;
  const [, , cid, tail] = match;
  const base = String(path).replace(/\/conversations.*$/, '');
  if (!cid && method === 'GET') return {endpoint: 'chat/conversations', payload: {}, shape: 'list', base};
  if (!cid && method === 'POST') return {endpoint: 'chat/create', payload: {title: (body && body.title) || ''}, shape: 'created'};
  if (cid && !tail && method === 'GET') return {endpoint: 'chat/messages', payload: {conversation_id: cid}, shape: 'open', cid};
  if (cid && tail === '/messages' && method === 'POST') {
    return {endpoint: 'chat/send', payload: {conversation_id: cid, text: (body && body.body) || ''}, shape: 'sent', cid};
  }
  if (cid && tail === '/read' && method === 'POST') return {endpoint: null, shape: 'read', cid};
  return null;
}

function conversation(row, agentId) {
  return {id: row.id, title: row.title, agent_id: agentId, created: row.created, updated: row.updated, unread_count: 0};
}

function message(row) {
  return {id: row.id, role: row.role, body: row.text, status: 'succeeded', created: row.created,
    memory_refs: (row.meta && row.meta.memory_refs) || [], engine: 'ds-bot'};
}

const STATUS = {'chat/not-found': 404, 'chat/invalid': 400, 'openteamily/invalid': 400, 'openteamily/not-found': 404};

async function legacyJSON(fetcher, path, headers) {
  const response = await fetcher(path, {method: 'GET', credentials: 'same-origin', headers: {...headers}});
  if (response.status !== 200) throw new Error('legacy history unavailable');
  return response.json();
}

// A source may confirm that its import is complete even when it has no rows
// (a genuinely empty account). Without that marker an empty read is
// inconclusive; a non-empty read that exhausted its pages is its own receipt.
export function sourceCompletion(listed) {
  if (!listed || typeof listed !== 'object') return undefined;
  for (const key of ['complete', 'import_complete', 'importComplete']) {
    if (listed[key] === true) return true;
    if (listed[key] === false) return false;
  }
  if (Object.prototype.hasOwnProperty.call(listed, 'receipt')) {
    const receipt = listed.receipt;
    if (receipt === false || receipt === null || receipt === '') return false;
    if (receipt !== undefined) return receipt;
  }
  return undefined;
}

// Copy this user's own platform history (personal agent) into their DS-Bot once.
// Reads only through the user's own session; writes only to the user's own DS-Bot.
// An empty read without a completion marker stays pending: it may mean the
// platform bundle has not arrived yet, not that the account has no history.
export async function importLegacyHistory(fetcher, base, headers, call) {
  const status = await call('chat/importStatus', {});
  if (status.error || (status.value && status.value.done)) return status.value || null;
  const conversations = [];
  let cursor = '';
  let marker;
  let truncated = false;
  for (let page = 0; page < 20; page += 1) {
    const listed = await legacyJSON(fetcher, `${base}/conversations?limit=100${cursor ? '&cursor=' + cursor : ''}`, headers);
    const found = sourceCompletion(listed);
    if (found !== undefined) marker = found;
    conversations.push(...(listed.items || []));
    if (!listed.cursor) break;
    cursor = listed.cursor;
    if (page === 19) truncated = true;
  }
  let imported = {conversations: 0, messages: 0};
  for (let i = 0; i < conversations.length; i += 20) {
    const batch = [];
    for (const row of conversations.slice(i, i + 20)) {
      const messages = [];
      let after = '';
      for (let page = 0; page < 10; page += 1) {
        const listed = await legacyJSON(fetcher, `${base}/conversations/${row.id}/messages?limit=200${after ? '&cursor=' + after : ''}`, headers);
        for (const m of listed.items || []) {
          if (m.role === 'user' || m.status === 'succeeded') messages.push({id: m.id, role: m.role, body: m.body || '', created: m.created});
        }
        if (!listed.cursor) break;
        after = listed.cursor;
        if (page === 9) truncated = true;
      }
      batch.push({id: row.id, title: row.title, created: row.created, updated: row.updated, messages});
    }
    const out = await call('chat/import', {conversations: batch});
    if (out.error) return null;
    imported = {conversations: imported.conversations + out.value.conversations, messages: imported.messages + out.value.messages};
  }
  const complete = !truncated && marker !== false && (marker !== undefined || conversations.length > 0);
  if (!complete) return {...imported, done: false};
  const payload = {conversations: [], finish: true, complete: true};
  if (marker !== undefined && marker !== true && marker !== false) payload.receipt = marker;
  const done = await call('chat/import', payload);
  return done.error ? null : {...imported, done: true};
}

let importing = null;
let skillsSyncedAt = 0;

export async function dsbotRequest(fetcher, route, agentId, headers) {
  if (route.shape === 'read') return {status: 200, body: {acknowledged: true}};
  const call = async (endpoint, payload) => {
    const response = await fetcher(PLUGIN_API, {method: 'POST', credentials: 'same-origin',
      headers: {...headers, 'Content-Type': 'application/json'}, body: JSON.stringify({endpoint, payload})});
    let parsed = {};
    try { parsed = await response.json(); } catch { parsed = {}; }
    if (response.status !== 200 || !parsed.ok) {
      const code = (parsed.error && parsed.error.code) || 'dsbot_unavailable';
      return {error: {status: STATUS[code] || (response.status === 200 ? 502 : response.status), body: {error: {code, message: (parsed.error && parsed.error.message) || ''}}}};
    }
    return {value: parsed.value};
  };
  if (route.shape === 'list' && route.base) {
    // Best effort: a failed import leaves the list usable and retries on the next load.
    importing ??= importLegacyHistory(fetcher, route.base, headers, call).catch(() => null).finally(() => { importing = null; });
    await importing;
  }
  if (route.shape === 'sent' && Date.now() - skillsSyncedAt > 60000) {
    // Private chat loads the user's bound skills natively; best effort, never blocks a send on failure.
    skillsSyncedAt = Date.now();
    await syncSkillsToDsBot(fetcher, headers, PLUGIN_API).catch(() => { skillsSyncedAt = 0; });
  }
  const out = await call(route.endpoint, route.payload);
  if (out.error) return out.error;
  const value = out.value;
  if (route.shape === 'list') return {status: 200, body: {items: (value.items || []).map(row => conversation(row, agentId))}};
  if (route.shape === 'created') return {status: 201, body: {conversation: conversation(value, agentId)}};
  if (route.shape === 'sent') return {status: 201, body: {reply: {id: value.reply.id, status: 'succeeded', engine: 'ds-bot'}}};
  // open: the conversation row comes from the list (one small extra call).
  const listed = await call('chat/conversations', {});
  const row = listed.value && (listed.value.items || []).find(item => item.id === route.cid);
  if (!row) return {status: 404, body: {error: {code: 'chat/not-found'}}};
  return {status: 200, body: {conversation: conversation(row, agentId), items: (value.items || []).map(message)}};
}
