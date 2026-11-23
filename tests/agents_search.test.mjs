import assert from 'node:assert/strict';
import test from 'node:test';
import { mount } from '../openteamily/static/agents/app.mjs';

class Element {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parent = null;
    this.attributes = {};
    this.handlers = {};
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.textContent = '';
    this.className = '';
    this.type = '';
    this.href = '';
    this.options = [];
    this.elements = {};
  }
  append(...nodes) {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
    if (this.tagName === 'SELECT') {
      this.options = this.children;
      if (!this.value && this.children[0]) this.value = this.children[0].value;
    }
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.options = [];
    if (this.tagName === 'SELECT' && !nodes.length) this.value = '';
    this.append(...nodes);
  }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(key, handler) { this.handlers[key] = handler; }
  querySelector(selector) {
    if (selector === 'button[type="submit"]') {
      if (!this._submit) {
        this._submit = new Element('button');
        this._submit.type = 'submit';
      }
      return this._submit;
    }
    return null;
  }
  focus() { this.focused = true; }
  closest(selector) {
    let node = this;
    while (node) {
      if (selector === 'button[data-id]' && node.tagName === 'BUTTON' && node.dataset.id) return node;
      if (selector === 'button[data-conversation]' && node.tagName === 'BUTTON' && node.dataset.conversation) return node;
      node = node.parent;
    }
    return null;
  }
}

function fakeDocument() {
  const elements = new Map();
  const doc = {
    cookie: '',
    getElementById(id) {
      if (!elements.has(id)) {
        const tag = id === 'workspace' || id === 'runtime-instance' ? 'select'
          : id.endsWith('-form') ? 'form'
          : id === 'agent-search' ? 'input'
          : 'div';
        const el = new Element(tag);
        if (id === 'create-form' || id === 'edit-form') {
          el.elements = {
            id: new Element('input'),
            revision: new Element('input'),
            name: new Element('input'),
            summary: new Element('textarea'),
            instructions: new Element('textarea'),
          };
        }
        elements.set(id, el);
      }
      return elements.get(id);
    },
    createElement(tag) { return new Element(tag); },
    querySelectorAll() { return []; },
  };
  return {doc, el: (id) => doc.getElementById(id)};
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const tick = async (times = 8) => {
  for (let i = 0; i < times; i += 1) await flush();
};

function json(status, body) {
  return {status, json: async () => body};
}

function directoryFetcher(requests, {agents, conversations, personal = null} = {}) {
  const space = {id: 'ws-1', name: 'Desk', owner_id: 'user-1'};
  const user = {id: 'user-1', username: 'alice'};
  const items = agents || [
    {id: 'ag-writer', name: '写作助手', summary: '帮助起草文案', revision: 1},
    {id: 'ag-ops', name: '运维助手', summary: '查看发布状态', revision: 1},
    {id: 'ag-search', name: '检索助手', summary: '查找资料', revision: 1},
  ];
  const threads = conversations || [
    {id: 'cv-1', title: '当前对话'},
  ];
  return async (path, options) => {
    requests.push({path, method: (options && options.method) || 'GET'});
    if (path === '/v1/auth/session') return json(200, {user});
    if (path === '/v1/personal-agent') return json(200, {personal_agent: personal});
    if (path === '/v1/workspaces?limit=100') return json(200, {items: [space]});
    if (path === '/v1/workspaces/ws-1') return json(200, {workspace: space});
    if (path === '/v1/workspaces/ws-1/members') return json(200, {items: [{user_id: 'user-1', role: 'owner'}]});
    if (path === '/v1/workspaces/ws-1/agents?limit=100') return json(200, {items});
    const agentMatch = /^\/v1\/workspaces\/ws-1\/agents\/([^/?]+)$/.exec(path);
    if (agentMatch) {
      const agent = items.find((row) => row.id === agentMatch[1]);
      return json(200, {agent});
    }
    if (path.endsWith('/runtime')) return json(200, {runtime: null});
    if (path.includes('/instances?limit=100')) return json(200, {items: []});
    if (path.endsWith('/conversations?limit=100')) return json(200, {items: threads});
    const convo = /^\/v1\/workspaces\/ws-1\/agents\/[^/]+\/conversations\/([^/?]+)$/.exec(path);
    if (convo) {
      return json(200, {
        conversation: {id: convo[1], title: '当前对话'},
        items: [
          {id: 'm-1', role: 'user', body: '你好'},
          {id: 'm-2', role: 'assistant', status: 'succeeded', body: '已收到。'},
        ],
      });
    }
    throw new Error('unexpected ' + path);
  };
}

function openFirstAgent(el) {
  const button = el('agent-list').children[0].children[1].children[0];
  return el('agent-list').handlers.click({target: button});
}

test('workspace reads start together and the personal avatar cannot delay the directory', async () => {
  const requests = [];
  const {doc, el} = fakeDocument();
  const personal = Promise.withResolvers();
  const members = Promise.withResolvers();
  const fetch = directoryFetcher(requests);
  const ready = mount(doc, {fetcher: (path, options) => {
    const response = fetch(path, options);
    if (path === '/v1/personal-agent') return personal.promise.then(() => response);
    if (path === '/v1/workspaces/ws-1/members') return members.promise.then(() => response);
    return response;
  }});
  try {
    await tick();
    for (const path of ['/v1/workspaces/ws-1', '/v1/workspaces/ws-1/members', '/v1/workspaces/ws-1/agents?limit=100']) {
      assert.equal(requests.some(request => request.path === path), true, path);
    }
    members.resolve();
    await ready;
    assert.equal(el('agent-list').children.length, 3);
  } finally {
    members.resolve();
    personal.resolve();
    await ready;
  }
});

test('typing in the directory search filters in place and keeps an open conversation', async () => {
  const requests = [];
  const {doc, el} = fakeDocument();
  const cleared = new Set();
  const realClear = globalThis.clearTimeout;
  globalThis.clearTimeout = (id) => {
    cleared.add(id);
    return realClear(id);
  };
  try {
    await mount(doc, {fetcher: directoryFetcher(requests)});
    await tick();
    assert.equal(el('agent-list').children.length, 3);
    assert.equal(el('agents-count').textContent, '显示 3 个智能体');
    assert.equal(el('agents-empty').hidden, true);

    await openFirstAgent(el);
    await tick();
    assert.equal(el('chat-panel').hidden, false);
    assert.match(el('chat-title').textContent, /写作助手/);
    assert.equal(el('open-in-chat').href, '/chat#workspace=ws-1&agent=ag-writer');
    assert.equal(requests.some(({path}) => path.includes('/conversations')), false);
    const afterOpen = requests.length;
    const clearedBefore = cleared.size;
    assert.ok(afterOpen > 0);

    el('agent-search').value = 'zzz-no-match';
    el('agent-search').handlers.input();
    await tick();
    assert.equal(requests.length, afterOpen, JSON.stringify(requests.slice(afterOpen)));
    assert.equal(cleared.size, clearedBefore);
    assert.equal(el('chat-panel').hidden, false);
    assert.match(el('chat-title').textContent, /写作助手/);
    assert.equal(el('agent-list').children.length, 0);
    assert.equal(el('agents-empty').hidden, false);
    assert.equal(el('agents-empty').textContent, '没有匹配的智能体。试试其他关键词。');
    assert.equal(el('agents-count').textContent, '显示 0 个智能体');

    el('agent-search').value = '运维';
    el('agent-search').handlers.input();
    await tick();
    assert.equal(requests.length, afterOpen);
    assert.equal(el('chat-panel').hidden, false);
    assert.equal(el('agent-list').children.length, 1);
    assert.equal(el('agent-list').children[0].children[1].children[0].textContent, '运维助手');
    assert.equal(el('agents-count').textContent, '显示 1 个智能体');
    assert.equal(el('agents-empty').hidden, true);

    el('agent-search').focused = false;
    el('agent-search').handlers.keydown({key: 'Escape', preventDefault() {}});
    await tick();
    assert.equal(requests.length, afterOpen);
    assert.equal(el('agent-search').value, '');
    assert.equal(el('agent-search').focused, true);
    assert.equal(el('agent-list').children.length, 3);
    assert.equal(el('agents-count').textContent, '显示 3 个智能体');
    assert.equal(el('chat-panel').hidden, false);
  } finally {
    globalThis.clearTimeout = realClear;
  }
});

test('an empty workspace keeps the genuine empty copy, not the no-match copy', async () => {
  const requests = [];
  const {doc, el} = fakeDocument();
  await mount(doc, {fetcher: directoryFetcher(requests, {agents: []})});
  await tick();
  assert.equal(el('agent-list').children.length, 0);
  assert.equal(el('agents-empty').hidden, false);
  assert.equal(el('agents-empty').textContent, '这个工作区还没有智能体。');
  assert.equal(el('agents-count').textContent, '显示 0 个智能体');
});


test('the saved Personal Agent look replaces the monogram in the directory', async () => {
  const requests = [];
  const {doc, el} = fakeDocument();
  const look = {color: '葡萄紫', expression: '好奇', headwear: '贝雷帽', glasses: '圆框眼镜', hand: '魔法棒'};
  const personalAgent = {id: 'ag-look', name: "alice's Personal Agent", summary: 'Personal'};
  await mount(doc, {fetcher: directoryFetcher(requests, {
    agents: [personalAgent, {id: 'ag-other', name: 'Other', summary: ''}],
    personal: {agent: personalAgent, look},
  })});
  await tick();
  assert.equal(el('agent-list').children.length, 2);
  const avatar = el('agent-list').children[0].children[0];
  assert.equal(avatar.className, 'look-avatar');
  assert.equal(avatar.dataset.color, '葡萄紫');
  assert.equal(avatar.dataset.headwear, '贝雷帽');
  const other = el('agent-list').children[1].children[0];
  assert.equal(other.className, 'avatar');
  assert.equal(other.textContent, 'O');
});


test('native directory renders the updated look only for the signed account and its personal workspace', async () => {
  const requests = [];
  const {doc, el} = fakeDocument();
  doc.querySelector = (selector) => selector === 'meta[name="openteamily-served-by"][content="ds-bot"]' ? {} : null;
  const owner = {id: 'e'.repeat(32), username: 'alice'};
  const workspace = {id: 'a'.repeat(32), name: 'Desk', kind: 'personal', owner_id: owner.id};
  const agent = {id: 'b'.repeat(32), name: "alice's Personal Agent", summary: ''};
  const look = {color: '葡萄紫', expression: '好奇', headwear: '贝雷帽', glasses: '圆框眼镜', hand: '魔法棒'};
  let returnLook;
  let snapshot = {items: [workspace], personal_agent_id: agent.id, personal_look: look, viewer_username: 'alice'};
  const load = () => mount(doc, {fetcher: async (path) => {
    requests.push(path);
    if (path === '/v1/auth/session') return json(200, {user: owner});
    if (path === '/v1/workspaces?scope=personal&include=personal-agent') return returnLook.then(() => json(200, snapshot));
    if (path === '/v1/workspaces?limit=100') return json(200, {items: [workspace]});
    if (path === '/v1/workspaces/' + workspace.id) return json(200, {workspace});
    if (path.endsWith('/members')) return json(200, {items: [{user_id: owner.id, role: 'owner'}]});
    if (path.endsWith('/agents?limit=100')) return json(200, {items: [agent]});
    return json(404, {});
  }});
  const avatar = () => el('agent-list').children[0].children[0];
  const pending = Promise.withResolvers();
  returnLook = pending.promise;
  await load();
  assert.equal(avatar().className, 'avatar', 'the directory must render before the look read finishes');
  pending.resolve();
  await tick();
  assert.equal(avatar().className, 'look-avatar');
  assert.equal(avatar().dataset.color, look.color);
  assert.equal(requests.includes('/v1/personal-agent'), false);

  snapshot = {...snapshot, viewer_username: 'another-user'};
  await load();
  await tick();
  assert.equal(avatar().className, 'avatar', 'a different signed-in viewer must never apply the look');

  snapshot = {...snapshot, viewer_username: 'alice', items: [{...workspace, id: 'c'.repeat(32)}]};
  await load();
  await tick();
  assert.equal(avatar().className, 'avatar', 'the personal look must only decorate the bound workspace');
});


test('create form retains its element after DOM dispatch clears currentTarget during await', async () => {
  const {doc,el}=fakeDocument();const requests=[],agents=[];let release,reset=0;
  const ordinary=directoryFetcher(requests,{agents,conversations:[]});
  const fetcher=async(path,options={})=>{
    if(path==='/v1/workspaces/ws-1/agents'&&options.method==='POST'){
      const agent={id:'new-agent',...JSON.parse(options.body),revision:1};
      agents.push(agent);return await new Promise(resolve=>{release=()=>resolve(json(201,{agent}));});
    }
    return ordinary(path,options);
  };
  mount(doc,{fetcher});await tick();
  const form=el('create-form');form.elements.name.value='Actually persisted';form.reset=()=>{reset++;};
  const saved=globalThis.FormData;
  globalThis.FormData=class{constructor(form){this.form=form}get(name){return this.form.elements[name]?.value||''}};
  try{
    const event={currentTarget:form,preventDefault(){}};
    const pending=form.handlers.submit(event);assert.equal(typeof release,'function');
    event.currentTarget=null;release();await pending;await tick();
    assert.equal(reset,1);assert.equal(el('agent-list').children.length,1);
    assert.equal(el('agents-count').textContent,'显示 1 个智能体');
  }finally{globalThis.FormData=saved;}
});
