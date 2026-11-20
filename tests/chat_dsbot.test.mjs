import assert from 'node:assert/strict';
import test from 'node:test';
import { dsbotRoute, dsbotRequest, dsbotServed, PLUGIN_API } from '../openteamily/static/chat/dsbot.mjs';

const agent = 'a'.repeat(32);
const base = `/v1/workspaces/${'w'.repeat(32)}/agents/${agent}`;

test('only the personal agent private chat is routed to the DS-Bot plugin', () => {
  assert.deepEqual(dsbotRoute('GET', `${base}/conversations?limit=100`, undefined, agent).endpoint, 'chat/conversations');
  assert.equal(dsbotRoute('POST', `${base}/conversations`, {title: 't'}, agent).endpoint, 'chat/create');
  assert.deepEqual(dsbotRoute('POST', `${base}/conversations/c1/messages`, {body: 'hi'}, agent).payload, {conversation_id: 'c1', text: 'hi'});
  assert.equal(dsbotRoute('GET', `${base}/conversations/c1`, undefined, agent).endpoint, 'chat/open');
  assert.equal(dsbotRoute('POST', `${base}/conversations/c1/read`, {}, agent).shape, 'read');
  assert.equal(dsbotRoute('GET', `${base}/conversations`, undefined, 'b'.repeat(32)), null);
  assert.equal(dsbotRoute('GET', `${base}/conversations`, undefined, ''), null);
  assert.equal(dsbotRoute('POST', `${base}/conversations/c1/messages/m1/artifact`, {}, agent), null);
  assert.equal(dsbotServed({querySelector: () => null}), false);
  assert.equal(dsbotServed({querySelector: () => ({})}), true);
});

test('plugin responses are shaped like the legacy API', async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push([url, JSON.parse(init.body)]);
    const {endpoint} = JSON.parse(init.body);
    const value = endpoint === 'chat/open' ? {conversation: {id: 'c1', title: 'T', created: 1, updated: 2},
      items: [{id: 'm1', role: 'assistant', text: 'hello', created: 3, meta: {memory_refs: [{id: 'p'}]}},
        {id: 'm2', role: 'assistant', text: '', status: 'failed'}]}
      : {reply: {id: 'r1'}};
    return {status: 200, json: async () => ({ok: true, value})};
  };
  const open = await dsbotRequest(fetcher, dsbotRoute('GET', `${base}/conversations/c1`, undefined, agent), agent, {});
  assert.equal(open.status, 200);
  assert.equal(open.body.conversation.id, 'c1');
  assert.deepEqual(open.body.items[0].body, 'hello');
  assert.equal(open.body.items[0].status, 'succeeded');
  assert.equal(open.body.items[1].status, 'failed');
  assert.deepEqual(calls, [[PLUGIN_API, {endpoint: 'chat/open',
    payload: {conversation_id: 'c1', agent_id: agent, workspace_id: 'w'.repeat(32)}}]]);
  const sent = await dsbotRequest(fetcher, dsbotRoute('POST', `${base}/conversations/c1/messages`, {body: 'x'}, agent), agent, {});
  assert.equal(sent.status, 201);
  assert.equal(calls[0][0], PLUGIN_API);
  const failing = async () => ({status: 200, json: async () => ({ok: false, error: {code: 'chat/runtime-unavailable', message: 'no'}})});
  const failed = await dsbotRequest(failing, dsbotRoute('GET', `${base}/conversations`, undefined, agent), agent, {});
  assert.equal(failed.status, 502);
  assert.equal(failed.body.error.code, 'chat/runtime-unavailable');
});

test('listing personal conversations reads only from the native DS-Bot API', async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push([url, JSON.parse(init.body).endpoint]);
    return {status: 200, json: async () => ({ok: true, value: {items: [
      {id: 'c1', title: 'Migrated conversation'},
    ]}})};
  };
  const route = dsbotRoute('GET', `${base}/conversations?limit=100`, undefined, agent);
  const response = await dsbotRequest(fetcher, route, agent, {});
  assert.equal(response.body.items[0].id, 'c1');
  assert.deepEqual(calls, [[PLUGIN_API, 'chat/conversations']]);
});
