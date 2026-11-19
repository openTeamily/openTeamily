import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAttendees } from '../openteamily/static/meetings/app.mjs';

test('parseAttendees trims, dedupes and splits both comma forms', () => {
  assert.deepEqual(parseAttendees('alice, bob，alice'), ['alice', 'bob']);
  assert.deepEqual(parseAttendees(''), []);
  assert.deepEqual(parseAttendees('  A , a , B '), ['A', 'B']);
});
