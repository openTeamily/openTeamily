import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationTitle, formatWhen, kindLabel, meetingMeta, mount } from '../openteamily/static/home/app.mjs';
import { rememberSignupSession, takeSignupSession, waitForRuntime } from '../openteamily/static/home/runtime-readiness.mjs';
import { spaceHref } from '../openteamily/static/shell/thumb.mjs';

const alice = 'a'.repeat(32);
const bob = 'b'.repeat(32);

test('runtime readiness retries temporary failures and stops at confirmed states', async () => {
  const replies = [null, {status: 200, body: {state: 'starting'}}, {status: 200, body: {state: 'ready'}}];
  const waits = [];
  const state = await waitForRuntime(async () => {
    const reply = replies.shift();
    if (!reply) throw new Error('network interruption');
    return reply;
  }, {delay: async ms => waits.push(ms)});
  assert.equal(state, 'ready');
  assert.deepEqual(waits, [1000, 1000]);
  assert.equal(await waitForRuntime(async () => ({status: 401})), 'signed-out');
  assert.equal(await waitForRuntime(async () => ({status: 200, body: {state: 'starting'}}), {attempts: 1}), 'timeout');
});

test('runtime polling stays responsive during cold starts and keeps its original time bound', async () => {
  const waits = [];
  const result = await waitForRuntime(async () => ({status: 200, body: {state: 'starting'}}), {
    delay: async ms => waits.push(ms),
  });
  assert.equal(result, 'timeout');
  assert.deepEqual(waits.slice(0, 30), new Array(30).fill(1000));
  assert.equal(waits.slice(30).every(ms => ms === 3000), true);
  assert.equal(waits.reduce((sum, ms) => sum + ms, 0), 135_000);
});

function homeFixture(pathname = '/', hash = '') {
  const fixtureNode = () => ({hidden: true, dataset: {}, addEventListener() {}, replaceChildren() {}, append() {}});
  const nodes = new Map();
  const read = id => {
    if (!nodes.has(id)) nodes.set(id, fixtureNode());
    return nodes.get(id);
  };
  const register = fixtureNode();
  read('login-panel').querySelector = () => register;
  const values = new Map();
  const view = {
    location: {pathname, hash, replace() { assert.fail('unexpected navigation'); }},
    sessionStorage: {setItem: (key, value) => values.set(key, value), getItem: key => values.get(key), removeItem: key => values.delete(key)},
  };
  const document = {
    defaultView: view, cookie: '', getElementById: read,
    querySelector: selector => selector === '.home-personal' ? read('home-personal') : null,
  };
  return {document, view, read, register};
}

test('a ready personal chat becomes clickable while the workspace list and onboarding are still pending', async () => {
  const {document, read, view} = homeFixture();
  rememberSignupSession(view, alice);
  const pending = [];
  const reply = (body, status = 200) => ({status, json: async () => body});
  mount(document, {fetcher: async url => {
    if (url === '/v1/auth/session') return reply({user: {id: alice, username: 'alice'}});
    if (url === '/v1/personal-agent') return reply({personal_agent: {
      workspace: {id: alice}, agent: {id: bob, name: 'Personal Agent'}, runtime_provisioning: {readiness: 'ready'},
    }});
    return new Promise(resolve => pending.push({url, resolve}));
  }});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(read('main-panel').hidden, false);
  assert.equal(read('home-personal').hidden, false);
  assert.equal(read('home-personal-chat').href, `/chat#workspace=${alice}&agent=${bob}`);
  assert.equal(read('home-workspace').disabled, true);
  assert.equal(takeSignupSession(view), null);
  assert.deepEqual(pending.map(({url}) => url), ['/v1/onboarding', '/v1/workspaces?limit=100']);
  for (const {url, resolve} of pending) resolve(url.endsWith('onboarding') ? reply({onboarding: {industry: '测试'}}) : reply({items: []}));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(read('home-context').textContent, '工作背景：测试');
});

test('a blocked or different signup session cannot resume an invitation as another account', async () => {
  const hash = '#team-invite=validSyntheticInvite';
  for (const session of [{status: 401, body: {}}, {status: 200, body: {user: {id: bob, username: 'bob'}}}]) {
    const {document, read, register, view} = homeFixture('/login', hash);
    rememberSignupSession(view, alice);
    mount(document, {fetcher: async url => {
      assert.equal(url, '/v1/auth/session');
      return {status: session.status, json: async () => session.body};
    }});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(read('login-panel').hidden, false);
    assert.equal(read('main-panel').hidden, true);
    assert.equal(register.href, '/register' + hash);
    assert.match(read('status').textContent, /账户已创建.*登录会话尚未确认/);
  }
});

test('conversationTitle names agent, DM and group rows without inventing data', () => {
  assert.equal(conversationTitle({source: 'agent', agent_name: 'Helper', title: 'Old'}, alice), 'Old');
  assert.equal(conversationTitle({source: 'agent', agent_name: 'Helper'}, alice), 'Helper');
  assert.equal(conversationTitle({source: 'agent', title: 'Thread'}, alice), 'Thread');
  assert.equal(conversationTitle({source: 'social', kind: 'dm', members: [
    {user_id: alice, username: 'alice'}, {user_id: bob, username: 'bob'}]}, alice), 'bob');
  assert.equal(conversationTitle({source: 'social', kind: 'group', title: '产品群'}, alice), '产品群');
  assert.equal(conversationTitle({source: 'social', kind: 'group'}, alice), '群聊');
});

test('formatWhen uses compact real-time labels', () => {
  const now = 1800000000;
  assert.equal(formatWhen(now - 30, now), '刚刚');
  assert.equal(formatWhen(now - 120, now), '2 分钟前');
  assert.match(formatWhen(now - 7200, now), /^\d{2}:\d{2}$/);
  assert.equal(formatWhen(now - 86400, now), '昨天');
  assert.match(formatWhen(now - 86400 * 10, now), /2027|2026/);
  assert.equal(formatWhen(null, now), '');
});

test('kindLabel and meetingMeta keep summaries honest', () => {
  assert.equal(kindLabel('slides'), '幻灯片');
  assert.equal(kindLabel('unknown'), '作品');
  assert.equal(meetingMeta({action_count: 3, done_count: 1}), '3 个行动项 · 1 已完成');
  assert.equal(meetingMeta({action_count: 0}), '没有行动项');
});


test('home artifact rows deep-link to the existing space editor query', () => {
  const workspace = 'a'.repeat(32);
  const artifact = 'b'.repeat(32);
  assert.equal(spaceHref(workspace, artifact), '/space?workspace=' + workspace + '&artifact=' + artifact);
  assert.equal(spaceHref(workspace), '/space?workspace=' + workspace);
});

test('public work login resumes the requested panel for one safe work slug', async () => {
  const {publicWorkIntentFromHash} = await import('../openteamily/static/shell/public-work-link.mjs');
  assert.deepEqual(publicWorkIntentFromHash('#work-comments=writer-demo'), {
    slug: 'writer-demo', panel: 'comments', continuation: '#work-comments=writer-demo',
    target: '/discover?work=writer-demo&comments=1',
  });
  assert.deepEqual(publicWorkIntentFromHash('#work-detail=writer-demo'), {
    slug: 'writer-demo', panel: 'share', continuation: '#work-detail=writer-demo',
    target: '/discover?work=writer-demo&share=1',
  });
  for (const hash of [
    '#work-comments=one&work-comments=two', '#work-comments=writer-demo&next=/profile',
    '#work-detail=https%3A%2F%2Fexample.invalid', '#work-comments=..%2Fwork', '#public-agent=writer-demo',
  ]) assert.equal(publicWorkIntentFromHash(hash), null);
});
