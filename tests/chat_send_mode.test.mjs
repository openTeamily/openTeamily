import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { MESSAGE_MODES, modeLabel, modeStoreKey, normalizeMode, socialSendPayload } from '../openteamily/static/chat/app.mjs';

const html = readFileSync(new URL('../openteamily/static/chat/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../openteamily/static/chat/app.mjs', import.meta.url), 'utf8');

test('MESSAGE_MODES is the recorded three-way choice', () => {
  assert.deepEqual(MESSAGE_MODES, ['auto', 'instant', 'agentic']);
});

test('normalizeMode and modeLabel never invent a fourth mode', () => {
  assert.equal(normalizeMode('agentic'), 'agentic');
  assert.equal(normalizeMode('instant'), 'instant');
  assert.equal(normalizeMode('auto'), 'auto');
  assert.equal(normalizeMode('turbo'), 'auto');
  assert.equal(normalizeMode(undefined), 'auto');
  assert.equal(modeLabel('agentic'), 'Agentic');
  assert.equal(modeLabel('instant'), 'Instant');
  assert.equal(modeLabel(''), 'Auto');
});

test('socialSendPayload carries the chosen mode with the body', () => {
  assert.deepEqual(socialSendPayload('发一条', 'agentic'), {body: '发一条', mode: 'agentic'});
  assert.deepEqual(socialSendPayload('发一条', 'nope'), {body: '发一条', mode: 'auto'});
});

test('the remembered choice is per conversation', () => {
  assert.equal(modeStoreKey('c1'), 'ot.chat.mode.c1');
  assert.notEqual(modeStoreKey('c1'), modeStoreKey('c2'));
});

test('the composer offers the three modes and no disabled placeholder', () => {
  assert.ok(!html.includes('未实现：Auto / Instant / Agentic 模式'));
  assert.match(html, /id="composer-mode"/);
  for (const value of ['auto', 'instant', 'agentic']) {
    assert.match(html, new RegExp(`<option value="${value}">`));
  }
  assert.ok(app.includes("socialSendPayload(field.value, modeSelect ? modeSelect.value : 'auto')"));
  assert.ok(app.includes("restoreComposerMode(currentConversation.id)"));
});

test('a non-auto message shows its mode on the bubble', () => {
  const render = app.slice(app.indexOf('function renderSocialMessages('), app.indexOf('function renderSocialMessages(') + 4000);
  assert.ok(render.includes("chip.className = 'mode-chip'"), 'no mode chip is built on the bubble');
  assert.ok(render.includes("normalizeMode(item.mode) !== 'auto'"));
  assert.ok(render.includes('modeLabel(item.mode)'));
});
