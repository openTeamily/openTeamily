import assert from 'node:assert/strict';
import test from 'node:test';
import { mountMeetingShares, parseAttendees, renderSharedMeeting } from '../openteamily/static/meetings/app.mjs';

test('parseAttendees trims, dedupes and splits both comma forms', () => {
  assert.deepEqual(parseAttendees('alice, bob，alice'), ['alice', 'bob']);
  assert.deepEqual(parseAttendees(''), []);
  assert.deepEqual(parseAttendees('  A , a , B '), ['A', 'B']);
});

function meetingDocument() {
  const nodes = new Map();
  function createElement(tag) {
    const handlers = new Map();
    return {
      tag, children: [], dataset: {}, value: '', textContent: '',
      get options() { return this.children; },
      append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } },
      replaceChildren(...nodes) { this.children = []; this.append(...nodes); },
      querySelectorAll(selector) {
        return this.children.flatMap(child => [ ...(child.tag === selector ? [child] : []), ...child.querySelectorAll(selector)]);
      },
      remove() { this.parent.children = this.parent.children.filter(child => child !== this); },
      focus() { this.focused = true; },
      addEventListener(name, fn) { handlers.set(name, fn); },
      fire(name) { return handlers.get(name)?.({preventDefault() {}}); },
    };
  }
  const document = {
    createElement,
    createTextNode(text) { return Object.assign(createElement('#text'), {textContent: text}); },
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, createElement('div'));
      return nodes.get(id);
    },
  };
  return document;
}

test('meeting sharing sends only the saved revision and selected account, then confirms revocation', async () => {
  const document = meetingDocument();
  const element = id => document.getElementById(id);
  const control = name => element('meeting-share-' + name);
  const dialog = control('dialog');
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; dialog.fire('close'); };
  const source = {id: 'source', title: '部署复盘', revision: 3, transcript: 'private transcript'};
  const sent = {id: 'sent', title: '部署复盘', revision: 3, recipients: ['成员甲']};
  const attempts = [];
  let saved = false;
  let revoked = false;
  let current = source;
  let historyReads = 0;
  const sharing = mountMeetingShares(document, {
    context: () => current ? {workspace: 'ws-1', meeting: current} : null,
    historyWorkspace: () => 'ws-1',
    key: () => 'idempotent-share-key',
    async request(method, path, body, headers) {
      if (path.endsWith('/social/conversations?limit=100')) return {status: 200, body: {items: [
        {id: 'group-1', kind: 'group', title: '工程群'},
        {id: 'public', kind: 'dm', public_agent: true},
      ]}};
      if (path.endsWith('/share-recipients?conversation_id=group-1')) return {status: 200, body: {items: [
        {id: 'account-a', name: '成员甲'}, {id: 'account-b', name: '成员乙'},
      ]}};
      if (path.endsWith('/shared/sent/revoke')) {
        revoked = true;
        return {status: 200};
      }
      if (path.endsWith('/shared?sent=1&limit=100')) historyReads += 1;
      if (method === 'GET') return {status: 200, body: {items: saved ? [sent] : []}};
      attempts.push({path, body, headers});
      if (attempts.length === 1) return {status: 503, body: {}};
      saved = true;
      return {status: 201, body: {meeting: sent}};
    },
  });
  sharing.sync();
  await element('share-meeting').fire('click');
  const select = control('conversation');
  assert.deepEqual(select.options.map(option => option.value), ['', 'group-1']);
  source.revision = 4;
  select.value = 'group-1';
  await select.fire('change');
  const first = control('recipient-items').children[0].children[0];
  first.checked = true;
  first.fire('change');
  const form = control('form');
  await form.fire('submit');
  assert.equal(first.checked, true);
  await form.fire('submit');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(first.checked, false);
  assert.deepEqual(attempts, Array(2).fill({
    path: '/v1/workspaces/ws-1/meetings/source/shares',
    body: {revision: 3, conversation_id: 'group-1', recipient_ids: ['account-a']},
    headers: {'Idempotency-Key': 'idempotent-share-key'},
  }));
  await control('close').fire('click');
  current = null;
  sharing.sync();
  assert.equal(element('share-meeting').hidden, true);
  assert.equal(element('meeting-shares-history').hidden, false);
  await element('meeting-shares-history').fire('click');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(historyReads, 1);
  assert.equal(form.hidden, true, 'share history opens independently after source deletion');
  const row = control('sent').children[0];
  assert.equal(row.children[0].textContent, '部署复盘');
  const actions = row.children.at(-1);
  actions.children[0].fire('click');
  assert.equal(revoked, false);
  await actions.children.find(button => button.className === 'meeting-share-revoke-confirm').fire('click');
  assert.equal(revoked, true);
  assert.equal(control('sent').children.length, 0);
  assert.equal(control('close').focused, true);
});

test('a receipt renders the shared summary and action status as read-only text', () => {
  const document = meetingDocument();
  const element = id => document.getElementById(id);
  renderSharedMeeting(document, {
    title: '只读复盘', organizer: '分享者', revision: 2,
    started_at: 1700000000, summary: '<em>保留原文</em>',
    transcript: 'private transcript', action_items: [{text: '核对版本', owner: '成员甲', done: true}],
  });
  assert.equal(element('shared-meeting-detail').hidden, false);
  assert.equal(element('shared-meeting-title').textContent, '只读复盘');
  assert.match(element('shared-meeting-meta').textContent, /组织者 分享者.*版本 2/);
  assert.equal(element('shared-meeting-summary').textContent, '<em>保留原文</em>');
  assert.deepEqual(element('shared-meeting-actions').children[0].children.map(node => [node.tag, node.textContent]),
    [['p', '核对版本'], ['p', '负责人 成员甲 · 已完成']]);
});
