import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  SEARCH_JUMP_HIGHLIGHT_MS,
  SEARCH_JUMP_MISSING,
  jumpToSearchHit,
  messageNodeById,
} from '../openteamily/static/chat/app.mjs';

function node(messageId) {
  return {
    dataset: messageId === undefined ? {} : {messageId},
    tabIndex: 0,
    scrolled: null,
    focused: null,
    scrollIntoView(options) { this.scrolled = options; },
    focus(options) { this.focused = options; },
  };
}

test('messageNodeById finds the rendered message row and ignores empty ids', () => {
  const wanted = node('m-2');
  const list = {children: [node('m-1'), wanted, node('m-3')]};
  assert.equal(messageNodeById(list, 'm-2'), wanted);
  assert.equal(messageNodeById(list, 'm-9'), null);
  assert.equal(messageNodeById(list, ''), null);
  assert.equal(messageNodeById(null, 'm-2'), null);
});

test('jumpToSearchHit centres the hit, focuses it and marks one row at a time', () => {
  const older = node('m-1');
  older.dataset.searchJump = 'true';
  const target = node('m-2');
  const list = {children: [older, target]};
  const timers = [];
  assert.equal(jumpToSearchHit(list, 'm-2', {schedule: (fn, ms) => timers.push([fn, ms])}), true);
  assert.deepEqual(target.scrolled, {block: 'center', behavior: 'smooth'});
  assert.deepEqual(target.focused, {preventScroll: true});
  assert.equal(target.tabIndex, -1);
  assert.equal(target.dataset.searchJump, 'true');
  // The previous highlight belongs to an earlier hit and must not linger.
  assert.equal(older.dataset.searchJump, undefined);
  assert.equal(timers.length, 1);
  assert.equal(timers[0][1], SEARCH_JUMP_HIGHLIGHT_MS);
});

test('the highlight clears itself after the shared jump window', () => {
  const target = node('m-2');
  const list = {children: [target]};
  const timers = [];
  jumpToSearchHit(list, 'm-2', {schedule: (fn, ms) => timers.push([fn, ms])});
  assert.equal(target.dataset.searchJump, 'true');
  timers[0][0]();
  assert.equal(target.dataset.searchJump, undefined);
});

test('a hit that is not in the loaded window is reported instead of highlighted', () => {
  const target = node('m-2');
  target.dataset.searchJump = 'true';
  const list = {children: [target]};
  assert.equal(jumpToSearchHit(list, 'm-99', {schedule: () => {}}), false);
  // Nothing loaded changes: the search panel message explains where the hit is.
  assert.equal(target.dataset.searchJump, 'true');
  assert.equal(target.scrolled, null);
  assert.equal(SEARCH_JUMP_MISSING, '这条消息在更早的历史里，当前会话还没有加载到它。请用会话内搜索再查一次，或先加载更多消息。');
});

test('the sidebar message result opens its conversation and then jumps to the hit', () => {
  const source = readFileSync(new URL('../openteamily/static/chat/app.mjs', import.meta.url), 'utf8');
  // Every message hit carries the id of the row it came from, so the sidebar
  // result can land on that row instead of the newest screen of the thread.
  assert.match(source, /pendingHitJump = \{conversationId: item\.conversationId \|\| item\.id, messageId: item\.messageId\}/);
  // Opening a conversation rewrites the hash, which repaints the thread, so the
  // jump is retried by the render that finishes for that conversation.
  assert.match(source, /currentConversation\.id !== pending\.conversationId\) return;/);
  assert.match(source, /renderSessions\(\);\n    flushPendingHitJump\(\);/);
});
