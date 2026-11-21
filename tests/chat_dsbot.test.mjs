import assert from 'node:assert/strict';
import test from 'node:test';
import { dsbotServed } from '../openteamily/static/chat/dsbot.mjs';
import { envelope, movedTarget } from '../openteamily/static/shell/dsbot-api.mjs';

test('private chat identifies the account DS-Bot and shares the agents transport', () => {
  assert.equal(dsbotServed({querySelector: () => null}), false);
  assert.equal(dsbotServed({querySelector: () => ({})}), true);
  const origin = 'https://openteamily.example';
  const base = `/v1/workspaces/${'a'.repeat(32)}/agents/${'b'.repeat(32)}/conversations`;
  const privateChat = `${base}/${'c'.repeat(32)}`;
  for (const path of [base, privateChat, `${privateChat}/messages`]) {
    assert.deepEqual(movedTarget(path, origin), {feature: 'agents', path});
  }
  const path = `${privateChat}/messages`;
  const body = {body: 'hello'};
  const wrapped = envelope(movedTarget(path, origin), 'POST', {'Idempotency-Key':'retry-one-message'}, body);
  assert.deepEqual(wrapped, {
    endpoint: 'agents/v1',
    payload: {method:'POST', path, idempotency_key:'retry-one-message', body},
  });
});
