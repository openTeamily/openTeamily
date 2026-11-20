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
  if (!cid && method === 'POST') return {endpoint: 'chat/create', payload: {title: (body && body.title) || ''}, shape: 'created', base};
  if (cid && !tail && method === 'GET') return {endpoint: 'chat/open', payload: {conversation_id: cid}, shape: 'open', base};
  if (cid && tail === '/messages' && method === 'POST') {
    return {endpoint: 'chat/send', payload: {conversation_id: cid, text: (body && body.body) || ''}, shape: 'sent', cid, base};
  }
  if (cid && tail === '/read' && method === 'POST') return {endpoint: null, shape: 'read', cid};
  return null;
}

function conversation(row, agentId) {
  return {id: row.id, title: row.title, agent_id: agentId, created: row.created, updated: row.updated, unread_count: 0};
}

function message(row) {
  return {id: row.id, role: row.role, body: row.text,
    status: !row.status || row.status === 'sent' ? 'succeeded' : row.status, created: row.created,
    memory_refs: (row.meta && row.meta.memory_refs) || [], engine: 'ds-bot'};
}

const STATUS = {'chat/not-found': 404, 'chat/invalid': 400, 'agents/not-found': 404,
  'openteamily/invalid': 400, 'openteamily/not-found': 404};

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
  if (route.shape === 'sent' && Date.now() - skillsSyncedAt > 60000) {
    // Private chat loads the user's bound skills natively; best effort, never blocks a send on failure.
    skillsSyncedAt = Date.now();
    await syncSkillsToDsBot(fetcher, headers, PLUGIN_API).catch(() => { skillsSyncedAt = 0; });
  }
  const scope = /\/workspaces\/([^/]+)\/agents\//.exec(route.base || '');
  const out = await call(route.endpoint, {...route.payload, agent_id:agentId, ...(scope ? {workspace_id:scope[1]} : {})});
  if (out.error) return out.error;
  const value = out.value;
  if (route.shape === 'list') return {status: 200, body: {items: (value.items || []).map(row => conversation(row, agentId))}};
  if (route.shape === 'created') return {status: 201, body: {conversation: conversation(value, agentId)}};
  if (route.shape === 'sent') return {status: 201, body: {reply: {id: value.reply.id, status: 'succeeded', engine: 'ds-bot'}}};
  return {status: 200, body: {agent: value.agent, conversation: conversation(value.conversation, agentId),
    items: (value.items || []).map(message)}};
}
