import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {startNativeUI} from './ci-native-ui.mjs';

const output = process.argv[2];
if (!output || process.argv.length !== 3) throw new Error('Usage: ci-native-ui-screenshots.mjs <output-directory>');
await mkdir(output, {recursive:true});
const fixture = await startNativeUI();
const screenshots = [];
const errors = [];
let browser;

async function contextFor(viewport) {
  const context = await browser.newContext({viewport,locale:'zh-CN',reducedMotion:'reduce'});
  await context.route('**/*', route => new URL(route.request().url()).origin === fixture.origin
    ? route.continue() : route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  return {context,page};
}

async function screenshot(page, name) {
  const dimensions = await page.evaluate(() => ({width:innerWidth, content:document.documentElement.scrollWidth}));
  assert.ok(dimensions.content <= dimensions.width + 1, name + ' has horizontal overflow');
  await page.screenshot({path:join(output,name+'.png'),animations:'disabled'});
  screenshots.push(name+'.png');
  console.log('Captured', name);
}

async function signIn(page, account) {
  const login = page.locator('#login-form');
  await page.goto(fixture.origin+'/login');
  await login.locator('input[name="username"]').fill(account.user.username);
  await login.locator('input[name="password"]').fill(fixture.password);
  await login.locator('button[type="submit"]').click();
  await page.locator('#home-greeting').waitFor({state:'visible'});
  const session = await page.request.get(fixture.origin+'/v1/auth/session');
  assert.equal((await session.json()).user.id, account.user.id);
}

function chatPath({instanceId,agent,chat}) {
  return '/chat#'+new URLSearchParams({workspace:instanceId,agent:agent.id,conversation:chat.id});
}

async function openNative(page, path, instanceId, selector) {
  const response = await page.goto(fixture.origin+path);
  assert.equal(response.status(),200,path);
  assert.equal(await page.locator('meta[name="openteamily-instance"]').getAttribute('content'),instanceId,path);
  await page.locator(selector).waitFor({state:'visible'});
  const stylesheet = await page.locator('link[rel="stylesheet"][href$="/shell/app.css"]').getAttribute('href');
  assert.match(stylesheet, /^\/chat\/assets\/[a-f0-9]{32}\/shell\/app\.css$/, path);
  assert.equal(await page.evaluate(asset => Array.from(document.styleSheets).some(sheet =>
    sheet.href === new URL(asset,location.href).href),stylesheet),true,path);
}

async function chat(page, name, send) {
  const owner = fixture.owner;
  await openNative(page,chatPath(owner),owner.instanceId,'#chat-body');
  await page.locator('#chat-title').getByText(owner.chat.name,{exact:true}).waitFor();
  const messages = page.locator('#message-list');
  const composer = page.locator('#chat-body');
  if (send) {
    await composer.fill('这是一条正式的浏览器验收消息');
    const [stream] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/b/api/openteamily/reply-stream'),
      page.locator('#chat-send').click(),
    ]);
    await page.waitForFunction(() => document.querySelector('#chat-body').value === '');
    await messages.getByText('这是一条正式的浏览器验收消息',{exact:true}).waitFor();
    assert.equal(stream.headers()['content-type']?.split(';')[0],'text/event-stream');
  }
  await messages.getByText(owner.chat.reply,{exact:true}).waitFor();
  await messages.getByRole('table').getByRole('cell',{name:'通过'}).waitFor();
  await messages.locator('.chat-flowchart').getByText('收到回复',{exact:true}).waitFor();
  assert.equal(await messages.getByText('这是一条正式的浏览器验收消息',{exact:true}).count(),1);
  await screenshot(page,name);
}

async function connectors(page) {
  await openNative(page,'/settings/connectors',fixture.owner.instanceId,'#connectors-filters');
  const rows = page.locator('#connectors-catalog .connector-row:visible');
  const group = id => page.locator('[data-connector-group="'+id+'"]');
  const search = page.locator('#connector-search');
  const jump = page.locator('#connectors-key-jump');
  const focusKey = page.locator('#connectors-catalog button[data-composio-action="focus-key"]:enabled');
  await jump.waitFor();
  assert.equal(await page.locator('#connectors-catalog-count').innerText(),'39 个应用 · 8 个分类');
  assert.equal(await page.locator('#connectors-connected-count').textContent(),'0 个已连接');
  assert.equal(await page.locator('#connectors-filters button').count(),9);
  assert.equal(await rows.count(),39);
  assert.equal(await focusKey.count(),31);
  assert.equal(await page.locator('#connectors-catalog button:disabled').count(),8);
  const writes = [];
  const recordRequest = request => {
    if (new URL(request.url()).pathname !== '/b/api/openteamily' || request.method() !== 'POST') return;
    const body = request.postDataJSON();
    if (body?.endpoint === 'connectors/v1' && body.payload?.method === 'POST') writes.push(body.payload.path);
  };
  page.on('request',recordRequest);
  try {
    await jump.click();
    await page.waitForFunction(() => document.activeElement.id === 'composio-key-input');
    await focusKey.first().click();
    await page.waitForFunction(() => document.activeElement.id === 'composio-key-input');
    await group('dev').press('Enter');
    assert.equal(await group('dev').getAttribute('aria-pressed'),'true');
    assert.equal(await rows.count(),6);
    await search.fill('cloudflare');
    assert.equal(await rows.count(),1);
    assert.equal(await rows.first().getAttribute('data-connector-id'),'cloudflare');
    await group('docs').click();
    assert.equal(await rows.count(),1);
    assert.equal(await rows.first().getAttribute('data-connector-id'),'cloudflare-docs');
    await group('mail').click();
    assert.equal(await rows.count(),0);
    await page.locator('#connectors-empty').waitFor();
    await search.clear();
    await group('all').click();
    assert.equal(await rows.count(),39);
    assert.deepEqual(writes,[]);
  } finally {
    page.off('request',recordRequest);
  }
  await screenshot(page,'desktop-connectors');
}

try {
  browser = await chromium.launch({executablePath:process.env.OT_UI_CHROMIUM_EXECUTABLE});
  const desktop = await contextFor({width:1440,height:900});
  const {page} = desktop;
  await page.goto(fixture.origin+'/login');
  await page.locator('#login-form').waitFor({state:'visible'});
  assert.equal(await page.locator('link[rel="stylesheet"][href="/shell/app.css"]').count(),1);
  await screenshot(page,'desktop-login');
  await signIn(page,fixture.owner);
  await screenshot(page,'desktop-home');
  await chat(page,'desktop-chat',true);
  const scenes = [
    ['/settings','#settings-panel','desktop-settings'],
    ['/agents','#agent-search','desktop-agents'],
    ['/space','#artifact-list','desktop-space','CI 合成工作文档'],
    ['/memory','#main-panel','desktop-memory','CI 合成记忆'],
    ['/automations','#list-empty','desktop-automations'],
    ['/meetings','#meetings-empty','desktop-meetings'],
    ['/discover','#main-panel','desktop-discover'],
  ];
  for (const [path,selector,name,expected] of scenes) {
    await openNative(page,path,fixture.owner.instanceId,selector);
    if (expected) await page.getByText(expected,{exact:true}).first().waitFor();
    await screenshot(page,name);
  }
  await connectors(page);
  await openNative(page,'/members#workspace='+fixture.team.workspace_id,fixture.owner.instanceId,'#main-panel');
  await page.locator('#member-list').getByText(fixture.peer.profile.handle.split('.')[0],{exact:true}).first().waitFor();
  await screenshot(page,'desktop-members');
  await openNative(page,chatPath(fixture.owner),fixture.owner.instanceId,'#chat-body');
  await page.locator('#new-conversation').click();
  await page.locator('#compose-new-group').click();
  await page.locator('#compose-mode-team').click();
  await page.locator('#team-template-choices input').first().check();
  await page.locator('#compose-dialog-submit').click();
  await page.locator('#compose-dialog').waitFor({state:'hidden'});
  await page.locator('#chat-title').getByText('产品研发小队',{exact:true}).waitFor();
  await page.locator('#conversation-agents-label').click();
  const roster = page.locator('#group-agent-chips .group-roster-name');
  await roster.filter({hasText:'产品经理助理'}).waitFor();
  assert.equal(await roster.count(),3);
  await screenshot(page,'desktop-template-group');

  const mobile = await contextFor({width:390,height:844});
  await signIn(mobile.page,fixture.owner);
  await chat(mobile.page,'mobile-chat',false);
  await mobile.context.close();

  const peer = await contextFor({width:1440,height:900});
  await signIn(peer.page,fixture.peer);
  assert.notEqual(fixture.peer.instanceId,fixture.owner.instanceId);
  await openNative(peer.page,'/chat',fixture.peer.instanceId,'#session-pane');
  const otherPrivateChat = await peer.page.request.post(fixture.origin+'/b/api/openteamily',{
    data:{endpoint:'agents/v1',payload:{method:'GET',
      path:'/v1/workspaces/'+fixture.owner.instanceId+'/agents/'+fixture.owner.agent.id+'/conversations/'+fixture.owner.chat.id}},
  });
  const isolation = await otherPrivateChat.json();
  assert.equal(isolation.ok,true);
  assert.equal(isolation.value.status,404);
  assert.ok(!JSON.stringify(isolation).includes(fixture.owner.chat.reply));
  await peer.context.close();
  await desktop.context.close();
  assert.deepEqual(errors,[]);
  await writeFile(join(output,'coverage.json'), JSON.stringify({screenshots,privateChatIsolated:true},null,2)+'\n');
} finally {
  await browser?.close();
  await fixture.close();
}
