import assert from 'node:assert/strict';
import test from 'node:test';
import { envelope, install, movedTarget, servedByDsBot, toResponse } from '../openteamily/static/shell/dsbot-api.mjs';

const ORIGIN = 'https://openteamily.example';
const WS = 'a'.repeat(32);
const ID = 'b'.repeat(32);

test('moved meeting routes go to the meetings feature of the user\'s own DS-Bot', () => {
  assert.deepEqual(movedTarget(`/v1/workspaces/${WS}/meetings?limit=20`, ORIGIN),
    { feature: 'meetings', path: `/v1/workspaces/${WS}/meetings?limit=20` });
  assert.equal(movedTarget(`/v1/workspaces/${WS}/meetings/${ID}/export`, ORIGIN).feature, 'meetings');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/meetings/draft`, ORIGIN).feature, 'meetings');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/meetings/speech`, ORIGIN).feature, 'meetings');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/meetings/transcribe`, ORIGIN).feature, 'meetings');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/meetings/${ID}/draft`, ORIGIN), null);
  assert.equal(movedTarget(`/v1/workspaces/${WS}/memory?q=x`, ORIGIN).feature, 'memory');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/memory/${ID}/versions/3/restore`, ORIGIN).feature, 'memory');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/memory/${ID}/dream/${ID}`, ORIGIN).feature, 'memory');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/memory/${ID}/share-group`, ORIGIN).feature, 'memory');
  for (const rest of ['actions', `actions/${ID}/remove`, 'links', 'graph', 'profile', 'profile/dream', 'candidates', `candidates/${ID}`, `preferences/${ID}/remove`]) {
    assert.equal(movedTarget(`/v1/workspaces/${WS}/memory/${rest}`, ORIGIN).feature, 'memory', rest);
  }
  assert.equal(movedTarget(`/v1/workspaces/${WS}/memory/bogus`, ORIGIN), null);
  assert.equal(movedTarget(`/v1/workspaces/${WS}/search/messages?q=x`, ORIGIN).feature, 'search');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/search/resources?kind=links`, ORIGIN).feature, 'search');
  assert.equal(movedTarget('/v1/auth/session', ORIGIN), null);
  assert.equal(movedTarget('/v1/automation-templates', ORIGIN).feature, 'automations');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/automations`, ORIGIN).feature, 'automations');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/automations/tick`, ORIGIN).feature, 'automations');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/automations/${ID}`, ORIGIN).feature, 'automations');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/automations/${ID}/run`, ORIGIN).feature, 'automations');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/automations/${ID}/runs/${ID}/retry`, ORIGIN).feature, 'automations');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/agents?limit=100`, ORIGIN).feature, 'agents');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/agents/${ID}/conversations/${ID}/memory/capture`, ORIGIN).feature, 'agents');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/agents/${ID}/archive`, ORIGIN).feature, 'agents');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/agents/${ID}/conversations/${ID}/messages`, ORIGIN).feature, 'agents');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/agents/${ID}/api-keys`, ORIGIN).feature, 'agent-api');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/agents/${ID}/api-keys/${ID}/revoke`, ORIGIN).feature, 'agent-api');
  // Cross-user / provision routes stay on the platform.
  assert.equal(movedTarget(`/v1/workspaces/${WS}/agents/${ID}/homepage`, ORIGIN), null);
  assert.equal(movedTarget(`/v1/workspaces/${WS}/agents/${ID}/runtime`, ORIGIN), null);
  assert.equal(movedTarget(`/v1/workspaces/${WS}/agents/${ID}/discover`, ORIGIN).feature, 'discover');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/agents/${ID}/discover/revoke`, ORIGIN).feature, 'discover');
  assert.equal(movedTarget('/v1/settings', ORIGIN).feature, 'settings');
  assert.equal(movedTarget('/v1/notification-prefs', ORIGIN).feature, 'settings');
  assert.equal(movedTarget('/v1/onboarding/look', ORIGIN).feature, 'settings');
  assert.equal(movedTarget('/v1/onboarding/recommendations', ORIGIN).feature, 'settings');
  assert.equal(movedTarget('/v1/model-api', ORIGIN).feature, 'model-api');
  assert.equal(movedTarget('/v1/model-api/image', ORIGIN).feature, 'model-api');
  assert.equal(movedTarget('/v1/model-api/video', ORIGIN).feature, 'model-api');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/images`, ORIGIN).feature, 'images');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/videos`, ORIGIN).feature, 'videos');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/images/${ID}`, ORIGIN).feature, 'images');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/videos/${ID}`, ORIGIN).feature, 'videos');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/images/wrong`, ORIGIN), null);
  assert.equal(movedTarget(`/v1/composio/connections/${ID}/disconnect`, ORIGIN).feature, 'connectors');
  assert.equal(movedTarget(`/v1/mcp/servers/${ID}`, ORIGIN).feature, 'connectors');
  assert.equal(movedTarget('/v1/composio/callback', ORIGIN), null);
  assert.equal(movedTarget('/v1/skill-secrets', ORIGIN).feature, 'skill-secrets');
  assert.equal(movedTarget('/v1/onboarding/automations', ORIGIN).feature, 'automations');
  assert.equal(movedTarget(`https://evil.example/v1/workspaces/${WS}/meetings`, ORIGIN), null);
});


test('members, team, messenger and discover /v1 routes go to the C features', () => {
  assert.equal(movedTarget(`/v1/workspaces/${WS}/members`, ORIGIN).feature, 'members');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/members/${ID}/remove`, ORIGIN).feature, 'members');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/members/ann.home/suspend`, ORIGIN).feature, 'members');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/invites`, ORIGIN).feature, 'invites');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/invites/oti_01/revoke`, ORIGIN).feature, 'invites');
  assert.equal(movedTarget('/v1/invites/accept', ORIGIN).feature, 'invites');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/join-requests/${ID}/approve`, ORIGIN).feature, 'invites');
  assert.equal(movedTarget('/v1/join-requests', ORIGIN).feature, 'invites');
  assert.equal(movedTarget('/v1/team-directory?q=guild', ORIGIN).feature, 'teams');
  assert.equal(movedTarget(`/v1/team-directory/${WS}/join`, ORIGIN).feature, 'teams');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/directory`, ORIGIN).feature, 'teams');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/social/conversations?limit=20`, ORIGIN).feature, 'messenger');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/social/conversations/otc_01/messages`, ORIGIN).feature, 'messenger');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/social/conversations/otc_01/memory/capture`, ORIGIN).feature, 'messenger');
  for (const action of ['create', 'preview', 'join', 'poll', 'signal', 'leave', 'end']) {
    assert.equal(movedTarget('/v1/meeting-calls/' + action, ORIGIN).feature, 'messenger');
  }
  assert.equal(movedTarget('/v1/discover/agents?q=x', ORIGIN).feature, 'discover');
  assert.equal(movedTarget('/v1/discover/me/works?tab=following', ORIGIN).feature, 'discover');
  assert.equal(movedTarget('/v1/discover/works/my-essay/engagement', ORIGIN).feature, 'discover');
  // Workspace lists and team creation use the DS-Bot teams feature.
  assert.equal(movedTarget('/v1/auth/session', ORIGIN), null);
  assert.equal(movedTarget('/v1/workspaces?limit=100', ORIGIN).feature, 'teams');
  assert.equal(movedTarget(`/v1/workspaces/${WS}`, ORIGIN), null);
  assert.equal(movedTarget('/v1/teams', ORIGIN).feature, 'teams');
});

test('the envelope carries method, path, body and idempotency key only', () => {
  const env = envelope({ feature: 'meetings', path: '/v1/x' }, 'post', { 'Idempotency-Key': 'k'.repeat(20), 'X-CSRF-Token': 't' }, '{"title":"周会"}');
  assert.deepEqual(env, { endpoint: 'meetings/v1', payload: { method: 'POST', path: '/v1/x', idempotency_key: 'k'.repeat(20), body: { title: '周会' } } });
});

test('answers become ordinary responses, downloads keep their name', async () => {
  const json = toResponse({ status: 409, body: { error: { code: 'conflict' } } });
  assert.equal(json.status, 409);
  assert.equal((await json.json()).error.code, 'conflict');
  const file = toResponse({ status: 200, download: { content_type: 'text/markdown', filename: 'm.md', data: Buffer.from('# hi').toString('base64') } });
  assert.equal(await file.text(), '# hi');
  assert.match(file.headers.get('Content-Disposition'), /m\.md/);
});

test('does nothing on pages served by the legacy platform', () => {
  const doc = { querySelector: () => null, addEventListener() { throw new Error('must not install'); } };
  assert.equal(servedByDsBot(doc), false);
  assert.equal(install({ document: doc, location: { origin: ORIGIN }, fetch() { throw new Error('no'); } }), null);
});

test('moved artifact routes go to the artifacts feature of the user\'s own DS-Bot', () => {
  assert.equal(movedTarget(`/v1/workspaces/${WS}/artifacts?limit=20`, ORIGIN).feature, 'artifacts');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/artifacts/${ID}`, ORIGIN).feature, 'artifacts');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/artifacts/${ID}/file`, ORIGIN).feature, 'artifacts');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/artifacts/${ID}/export`, ORIGIN).feature, 'artifacts');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/artifacts/spreadsheet/draft`, ORIGIN).feature, 'artifacts');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/artifacts/slides/draft`, ORIGIN).feature, 'artifacts');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/artifacts/${ID}/versions/3/export`, ORIGIN).feature, 'artifacts');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/artifacts/${ID}/shares/${ID}/revoke`, ORIGIN).feature, 'artifacts');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/artifacts/${ID}/favorite`, ORIGIN).feature, 'artifacts');
  assert.equal(movedTarget(`/v1/workspaces/${WS}/artifacts/bogus`, ORIGIN), null);
});

test('a missing moved feature never falls back to platform execution', async () => {
  const calls = [];
  const win = {
    document: {querySelector: () => ({}), addEventListener() {}},
    location: {origin: ORIGIN},
    async fetch(url) {
      calls.push(url);
      return Response.json({ok: false, error: {code: 'openteamily/not-found'}});
    },
  };
  install(win);
  const response = await win.fetch('/v1/settings');
  assert.equal(response.status, 502);
  assert.deepEqual(calls, ['/b/api/openteamily']);
});
