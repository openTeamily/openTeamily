import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SKILLS, filterSkills, mountSkills, skillCountLabel,
} from '../openteamily/static/skills/app.mjs';

class Element {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.handlers = {};
    this.className = '';
    this.textContent = '';
    this.hidden = false;
    this.value = '';
    this.classList = {
      add: (name) => { if (!this.className.split(' ').includes(name)) this.className = (this.className + ' ' + name).trim(); },
      contains: (name) => this.className.split(' ').includes(name),
    };
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, handler) { this.handlers[type] = handler; }
}

function fakeDocument() {
  const nodes = new Map();
  const doc = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, new Element(id === 'skills-search' ? 'input' : 'div'));
      return nodes.get(id);
    },
    createElement(tag) { return new Element(tag); },
  };
  return {doc, el: (id) => doc.getElementById(id)};
}

test('the catalogue has 8-12 unique self-written skills', () => {
  assert.ok(SKILLS.length >= 8 && SKILLS.length <= 12);
  assert.equal(new Set(SKILLS.map((item) => item.id)).size, SKILLS.length);
  for (const item of SKILLS) {
    assert.ok(item.id && item.name && item.description && item.mark);
  }
});

test('filterSkills matches names and descriptions without inventing data', () => {
  assert.equal(filterSkills(SKILLS, '').length, SKILLS.length);
  assert.deepEqual(filterSkills(SKILLS, '会议').map((item) => item.id), ['meeting-notes']);
  assert.deepEqual(filterSkills(SKILLS, '表格').map((item) => item.id), ['data-brief']);
  assert.deepEqual(filterSkills(SKILLS, '找不到的技能'), []);
  assert.deepEqual(filterSkills(SKILLS, '  邮件 ').map((item) => item.id), ['email-draft']);
});

test('skill counts reflect actual catalogue matches', () => {
  assert.equal(skillCountLabel(SKILLS.length, SKILLS.length), `共 ${SKILLS.length} 个技能`);
  assert.equal(skillCountLabel(1, SKILLS.length), `显示 1 / ${SKILLS.length} 个技能`);
});

test('mountSkills searches and never pretends to install a skill', () => {
  const {doc, el} = fakeDocument();
  const mounted = mountSkills(doc);
  assert.equal(el('skills-list').children.length, SKILLS.length);
  assert.equal(el('skills-count').textContent, `共 ${SKILLS.length} 个技能`);
  assert.equal(el('skills-empty').hidden, true);

  el('skills-search').value = '会议';
  el('skills-search').handlers.input();
  assert.equal(el('skills-list').children.length, 1);
  assert.equal(el('skills-count').textContent, `显示 1 / ${SKILLS.length} 个技能`);
  const card = el('skills-list').children[0];
  assert.equal(card.children[1].children[0].textContent, '会议纪要');
  const install = card.children[2];
  assert.equal(install.textContent, '未接通');
  assert.equal(install.disabled, true);
  assert.equal(install.handlers.click, undefined);
  assert.equal(card.className.includes('is-installed'), false);
  mounted.render();
  assert.equal(el('skills-list').children[0].children[2].disabled, true);

  el('skills-search').value = '找不到的技能';
  el('skills-search').handlers.input();
  assert.equal(el('skills-list').children.length, 0);
  assert.equal(el('skills-empty').hidden, false);
});
