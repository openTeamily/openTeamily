import assert from 'node:assert/strict';
import test from 'node:test';
import {
  conversationLabel, sortConversations, validMessage, memberChoices,
} from '../openteamily/static/messenger/app.mjs';
import { parseMessengerHash } from '../openteamily/static/shell/thumb.mjs';

const current = 'a'.repeat(32);

test('conversationLabel names a DM by the other members', () => {
  const dm = {kind: 'dm', title: 'bob', members: [
    {user_id: current, username: 'alice'},
    {user_id: 'b'.repeat(32), username: 'bob'},
  ]};
  assert.equal(conversationLabel(dm, current), 'bob');
  assert.equal(conversationLabel({kind: 'group', title: '产品群', members: []}, current), '产品群');
  assert.equal(conversationLabel(null, current), '');
});

test('sortConversations orders newest first and does not mutate input', () => {
  const rows = [{id: 'a', updated: 1}, {id: 'b', updated: 3}, {id: 'c', updated: 2}];
  assert.deepEqual(sortConversations(rows).map((row) => row.id), ['b', 'c', 'a']);
  assert.deepEqual(rows.map((row) => row.id), ['a', 'b', 'c']);
});

test('validMessage enforces a non-empty bounded body', () => {
  assert.equal(validMessage('hello'), true);
  assert.equal(validMessage('   '), false);
  assert.equal(validMessage('x'.repeat(4000)), true);
  assert.equal(validMessage('x'.repeat(4001)), false);
  assert.equal(validMessage(null), false);
});

test('memberChoices excludes the signed-in user', () => {
  const members = [
    {user_id: current, username: 'alice'},
    {user_id: 'b'.repeat(32), username: 'bob'},
  ];
  assert.deepEqual(memberChoices(members, current).map((member) => member.username), ['bob']);
});


test('independent-session hash parsing keeps workspace and conversation distinct', () => {
  assert.deepEqual(parseMessengerHash('#workspace=w1&conversation=c1'), {workspace: 'w1', conversation: 'c1'});
  assert.deepEqual(parseMessengerHash('workspace=w1'), {workspace: 'w1', conversation: ''});
});
