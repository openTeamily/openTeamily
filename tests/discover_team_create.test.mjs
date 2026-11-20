import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {
  directoryTabFromSearch, selectDirectoryTab, wantsTeamCreate,
} from '../openteamily/static/agents/app.mjs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

class Node {
  constructor(id) {
    this.id = id;
    this.hidden = false;
    this.attributes = {};
    this.focused = false;
    this.clicked = 0;
    this.children = [];
  }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  append(...nodes) { this.children.push(...nodes); }
  querySelector(selector) {
    return selector === '[data-team-create]' && this.createControl ? this.createControl : null;
  }
  focus() { this.focused = true; }
  click() { this.clicked += 1; }
}

function fakeDocument() {
  const nodes = new Map();
  const doc = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, new Node(id));
      return nodes.get(id);
    },
  };
  return {doc, el: (id) => doc.getElementById(id)};
}

test('directoryTabFromSearch only accepts the two real tabs', () => {
  assert.equal(directoryTabFromSearch(''), 'agents');
  assert.equal(directoryTabFromSearch('?tab=agents'), 'agents');
  assert.equal(directoryTabFromSearch('tab=teams'), 'teams');
  assert.equal(directoryTabFromSearch('?tab=unknown'), 'agents');
});

test('wantsTeamCreate needs the team tab and an explicit new flag', () => {
  assert.equal(wantsTeamCreate('?tab=teams&new=1'), true);
  assert.equal(wantsTeamCreate('?tab=teams&new=true'), true);
  assert.equal(wantsTeamCreate('?tab=teams'), false);
  assert.equal(wantsTeamCreate('?tab=teams&new=0'), false);
  assert.equal(wantsTeamCreate('?new=1'), false);
});

test('selectDirectoryTab opens the AI team tab from the address', () => {
  const {doc, el} = fakeDocument();
  assert.equal(selectDirectoryTab(doc, '?tab=teams'), 'teams');
  assert.equal(el('tab-teams').attributes['aria-selected'], 'true');
  assert.equal(el('tab-agents').attributes['aria-selected'], 'false');
  assert.equal(el('teams-panel').hidden, false);
  assert.equal(el('list-panel').hidden, true);

  const plain = fakeDocument();
  assert.equal(selectDirectoryTab(plain.doc, ''), 'agents');
  assert.equal(plain.el('tab-teams').attributes['aria-selected'], undefined);
  assert.equal(plain.el('teams-panel').hidden, false);
});

test('new=1 opens a real team create control and otherwise only focuses the panel', () => {
  const withControl = fakeDocument();
  const control = new Node('team-create');
  withControl.el('teams-panel').createControl = control;
  selectDirectoryTab(withControl.doc, '?tab=teams&new=1');
  assert.equal(control.clicked, 1);
  assert.equal(withControl.el('teams-panel').focused, false);

  const withoutControl = fakeDocument();
  selectDirectoryTab(withoutControl.doc, '?tab=teams&new=1');
  assert.equal(withoutControl.el('teams-panel').focused, true);
  assert.equal(withoutControl.el('teams-panel').attributes.tabindex, '-1');
});

test('the discover directory links to the agents team tab instead of a dead button', () => {
  const html = read('../openteamily/static/discover/index.html');
  const tag = html.match(/<a[^>]*id="catalog-create-team"[^>]*>/);
  assert.ok(tag, 'catalog-create-team should be a real anchor');
  assert.match(tag[0], /href="\/agents\?tab=teams&(?:amp;)?new=1"/);
  assert.doesNotMatch(tag[0], /\bdisabled\b/);
  assert.doesNotMatch(tag[0], /\bhidden\b/);
  assert.match(html, /id="catalog-create-team"[^>]*>\+ 创建我的 AI 团队</);
  const app = read('../openteamily/static/discover/app.mjs');
  assert.doesNotMatch(app, /createTeam\.hidden\s*=\s*!teamsView/);
});
