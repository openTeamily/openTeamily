import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { acceptOutcome, copyInviteText, inviteLink, inviteTokenFromHash } from '../openteamily/static/shell/invite-link.mjs';

const token = 'A'.repeat(43);

function asset(path) {
  return readFileSync(new URL(`../openteamily/static/${path}`, import.meta.url), 'utf8');
}

test('inviteLink builds the members link that pre-fills the accept form', () => {
  assert.equal(inviteLink('https://chat.example.com', token), `https://chat.example.com/members#invite=${token}`);
  assert.equal(inviteLink('https://chat.example.com/', token), `https://chat.example.com/members#invite=${token}`);
  assert.equal(inviteLink('', token), '');
  assert.equal(inviteLink('https://chat.example.com', '   '), '');
});

test('inviteTokenFromHash only accepts a real token in the invite fragment', () => {
  assert.equal(inviteTokenFromHash(`#invite=${token}`), token);
  assert.equal(inviteTokenFromHash(`#invite=${token}&from=chat`), token);
  assert.equal(inviteTokenFromHash('#invite=short'), '');
  assert.equal(inviteTokenFromHash('#from=chat'), '');
  assert.equal(inviteTokenFromHash(''), '');
});

test('copyInviteText reports clipboard failure instead of claiming a copy', async () => {
  let written = '';
  assert.equal(await copyInviteText('abc', {writeText: async value => { written = value; }}), true);
  assert.equal(written, 'abc');
  assert.equal(await copyInviteText('abc', {writeText: async () => { throw new Error('denied'); }}), false);
  assert.equal(await copyInviteText('', {writeText: async () => { throw new Error('must not run'); }}), false);
});

test('acceptOutcome separates a new join from an existing membership', () => {
  assert.equal(acceptOutcome(201, {}), 'joined');
  assert.equal(acceptOutcome(200, {member: {}}), 'already');
  assert.equal(acceptOutcome(202, {}), 'pending');
  assert.equal(acceptOutcome(200, {join_request: {status: 'pending'}}), 'pending');
  assert.equal(acceptOutcome(404, {}), '');
});

test('chat invite entry is one real button with a link box and a copy button', () => {
  const page = asset('chat/index.html');
  assert.ok(!page.includes('未实现：邀请'), 'the disabled invite placeholder is still in the chat header');
  assert.ok(!page.includes('id="chat-invite-unavailable"'), 'the disabled invite button must be removed');
  assert.match(page, /id="chat-invite"/);
  assert.match(page, /id="chat-invite-link"[^>]*readonly/);
  assert.match(page, /id="chat-invite-copy"/);
  const app = asset('chat/app.mjs');
  assert.ok(!app.includes('chat-invite-unavailable'), 'the app still toggles the removed placeholder');
  assert.ok(app.includes('inviteLink('), 'the generated invite is never turned into a link');
  assert.ok(app.includes('copyInviteText('), 'the copy button is not wired to the clipboard');
});

test('the shared invite module is served to the browser', () => {
  const page = readFileSync(new URL('../openteamily/settings_page.py', import.meta.url), 'utf8');
  assert.ok(page.includes("'/shell/invite-link.mjs'"), 'the static allowlist does not serve the new module');
});

test('members accept form names the link hint and reads the invite fragment', () => {
  assert.match(asset('members/index.html'), /id="accept-hint"/);
  assert.ok(asset('members/app.mjs').includes('inviteTokenFromHash'));
});
