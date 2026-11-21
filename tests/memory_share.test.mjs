import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {memorySharePath, shareRowState, shareUrl} from '../openteamily/static/memory/app.mjs';

const WID = 'a'.repeat(32);
const PID = 'b'.repeat(32);

test('memorySharePath addresses one memory page of one workspace', () => {
  assert.equal(memorySharePath(WID, PID), `/v1/workspaces/${WID}/memory/${PID}/share`);
});

test('shareUrl turns the shown link into an absolute one', () => {
  assert.equal(shareUrl('/share/token', 'https://example.test'), 'https://example.test/share/token');
  assert.equal(shareUrl('/share/token', 'https://example.test/'), 'https://example.test/share/token');
  assert.equal(shareUrl('', 'https://example.test'), '');
});

test('shareRowState stays hidden while the page was never shared', () => {
  assert.deepEqual(shareRowState(null), {visible: false, link: '', canRevoke: false, note: ''});
  assert.deepEqual(shareRowState(undefined), {visible: false, link: '', canRevoke: false, note: ''});
});

test('shareRowState shows the copy-once link right after creating it', () => {
  const state = shareRowState({active: true, revoked: false, path: '/share/abcdefghijk', prefix: 'abcdefgh'});
  assert.equal(state.visible, true);
  assert.equal(state.link, '/share/abcdefghijk');
  assert.equal(state.canRevoke, true);
  assert.match(state.note, /只读/);
});

test('shareRowState keeps the shared state after a reload but cannot repeat the link', () => {
  const state = shareRowState({active: true, revoked: false, prefix: 'abcdefgh'});
  assert.equal(state.visible, true);
  assert.equal(state.link, '');
  assert.equal(state.canRevoke, true);
  assert.match(state.note, /只显示一次/);
  assert.match(state.note, /重新分享/);
});

test('shareRowState explains a revoked or expired link and offers sharing again', () => {
  const revoked = shareRowState({active: false, revoked: true, prefix: 'abcdefgh'});
  assert.equal(revoked.visible, true);
  assert.equal(revoked.link, '');
  assert.equal(revoked.canRevoke, false);
  assert.match(revoked.note, /已撤销/);
  const expired = shareRowState({active: false, revoked: false, prefix: 'abcdefgh', expired: true});
  assert.equal(expired.canRevoke, false);
  assert.match(expired.note, /已失效|已撤销/);
});

test('share writes carry a JSON body so the server never answers 415', () => {
  const source = readFileSync(new URL('../openteamily/static/memory/app.mjs', import.meta.url), 'utf8');
  assert.match(source, /request\('POST', memorySharePath\([^)]*\), \{\}\)/);
  assert.match(source, /request\('POST', memorySharePath\([^)]*\) \+ '\/revoke', \{\}\)/);
});
