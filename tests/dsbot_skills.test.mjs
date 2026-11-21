import assert from 'node:assert/strict';
import test from 'node:test';
import { effectiveSkills, syncSkillsToDsBot } from '../openteamily/static/shell/dsbot-skills.mjs';

const item = (id, extra = {}) => ({id, name: id, version: '1.0.0', digest: id.padEnd(64, '0'), content: '# ' + id, source: 'bundled-original', ...extra});

test('effective set mirrors account bindings plus bundled library skills', () => {
  const catalogue = [item('a'), item('b'), item('c', {source: 'user-imported'}), item('d')];
  const bindings = [{scope: 'account', skill_id: 'a', version: '1.0.0', digest: 'a'.padEnd(64, '0')},
    {scope: 'account', skill_id: 'd', version: '0.9.0', digest: 'd'.padEnd(64, '0')},
    {scope: 'workspace:x', skill_id: 'b', version: '1.0.0', digest: 'b'.padEnd(64, '0')}];
  assert.deepEqual(effectiveSkills(catalogue, bindings, ['b', 'c']).map(s => s.id), ['a', 'b']);
});

test('sync posts the set to the plugin skills feature', async () => {
  let posted;
  const fetcher = async (url, init) => {
    if (url === '/v1/skills/catalog') return {status: 200, json: async () => ({items: [item('a')]})};
    if (url === '/v1/skills/bindings') return {status: 200, json: async () => ({items: []})};
    if (url === '/v1/skills/installed') return {status: 200, json: async () => ({installed: ['a']})};
    posted = JSON.parse(init.body);
    return {status: 200, json: async () => ({ok: true, value: {attached: ['ot-bound-a']}})};
  };
  assert.deepEqual(await syncSkillsToDsBot(fetcher), {attached: ['ot-bound-a']});
  assert.equal(posted.endpoint, 'skills/sync');
  assert.deepEqual(posted.payload.items.map(s => s.id), ['a']);
});
