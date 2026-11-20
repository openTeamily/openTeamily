import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {muteNote} from '../openteamily/static/chat/app.mjs';

// The chat page is a static shell plus one ES module; these checks keep the mute
// control wired instead of regressing to the disabled placeholder.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(root, 'openteamily/static/chat/index.html'), 'utf8');
const source = readFileSync(path.join(root, 'openteamily/static/chat/app.mjs'), 'utf8');

test('the mute switch is live in group info and not a placeholder', () => {
  const row = html.match(/<button[^>]*id="group-info-mute"[^>]*>/);
  assert.ok(row, 'group-info-mute switch is present');
  assert.doesNotMatch(row[0], /\bdisabled\b/);
  assert.match(html, /id="group-info-mute-note"/);
  assert.doesNotMatch(html, /消息免打扰<\/strong><small>未接通。/);
});

test('a direct message exposes its own mute entry in the header', () => {
  const row = html.match(/<button[^>]*id="mute-conversation"[^>]*>/);
  assert.ok(row, 'mute-conversation button is present');
  assert.doesNotMatch(row[0], /\bdisabled\b/);
  assert.match(source, /muteButton\.hidden = currentConversation\.kind !== 'dm'/);
});

test('both mute entry points post the muted preference and reload the chat', () => {
  assert.match(source, /\/preferences`, \{muted\}\)/);
  assert.match(source, /saveMute\(!\(currentConversation && currentConversation\.muted\)\)/);
  assert.match(source, /muted: Boolean\(row\.muted\)/);
  assert.match(source, /aria-checked', String\(Boolean\(conversation\.muted\)\)/);
});

test('mute copy names the counters it hides and that messages stay visible', () => {
  assert.match(muteNote(true), /已开启/);
  assert.match(muteNote(true), /未读角标和通知列表/);
  assert.match(muteNote(true), /消息照常可见/);
  assert.match(muteNote(false), /开启后/);
});
