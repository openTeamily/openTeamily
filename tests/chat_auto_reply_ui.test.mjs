import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {autoReplyNote, mergeConversationSettings} from '../openteamily/static/chat/app.mjs';

// The Agent 主动性 switch is static markup plus one stored server setting; these
// checks keep the row wired and its copy honest about the hourly cap.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(root, 'openteamily/static/chat/index.html'), 'utf8');
const source = readFileSync(path.join(root, 'openteamily/static/chat/app.mjs'), 'utf8');

test('the Agent 主动性 switch is live and leaves the placeholder behind', () => {
  const row = html.match(/<button[^>]*id="group-info-auto"[^>]*>/);
  assert.ok(row, 'group-info-auto switch is present');
  assert.doesNotMatch(row[0], /\bdisabled\b/);
  assert.match(row[0], /role="switch"/);
  assert.match(html, /id="group-info-auto-note"/);
  assert.doesNotMatch(html, /群内自动回复尚未实现/);
});

test('the switch posts the stored setting and renders it', () => {
  assert.match(source, /\/auto-reply`, \{enabled: !info\.enabled\}\)/);
  assert.match(source, /group-info-auto-note/);
  assert.match(source, /conversation\.auto_reply\.can_manage/);
});

test('copy states the agent, the limit and the reached-limit state', () => {
  const base = {enabled: false, can_manage: true, available: true, agent_name: 'Group helper',
    used: 0, limit: 3, window_seconds: 3600};
  assert.match(autoReplyNote(base), /Group helper/);
  assert.match(autoReplyNote(base), /每小时最多 3 条/);
  assert.match(autoReplyNote({...base, enabled: true, used: 1}), /已用 1\/3 条/);
  assert.match(autoReplyNote({...base, enabled: true, used: 3}), /达到上限/);
  assert.match(autoReplyNote({...base, available: false, agent_name: null}), /加入一个可用的群内智能体/);
  assert.match(autoReplyNote({...base, can_manage: false, enabled: false}), /只有工作区所有者或管理员/);
});

test('the detail response hands the switch state to the conversation it belongs to', () => {
  const conversation = {id: 'c-1', kind: 'group', title: '发布小组'};
  const auto = {enabled: true, can_manage: true, available: true, agent_name: 'Group helper',
    used: 1, limit: 3, window_seconds: 3600};
  const merged = mergeConversationSettings(conversation, {conversation, auto_reply: auto});
  assert.deepEqual(merged.auto_reply, auto);
  assert.equal(merged.id, 'c-1');
  assert.equal(mergeConversationSettings(conversation, {conversation}).auto_reply, undefined);
});
