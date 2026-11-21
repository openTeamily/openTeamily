// OpenTeamily Discover on Bot Social: publish/unpublish, search and tabs, likes, collections, follows
// and follow notifications. Fixture homes only.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { bulkAuth, startServer } from "./helpers.js";
import { home } from "./openteamily_helpers.js";

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(bulkAuth); });
after(async () => { await S.stop(); });

test("publish, discover, like, collect, follow and notify followers", async () => {
  const A = await home(S.base, "creator");
  const B = await home(S.base, "fan");
  const tag = `${Date.now() % 100000}`;
  await B.ok("POST", "/v1/ot/follows", { handle: A.handle });
  assert.ok((await A.ok("GET", "/v1/ot/notifications")).notifications.some((n: any) => n.kind === "follow.new" && n.data.follower.handle === B.handle));
  assert.equal((await A.call("POST", "/v1/ot/follows", { handle: A.handle })).status, 400);

  const agent = await A.ok("PUT", "/v1/ot/listings", { kind: "agent", ref: "bot_writer", slug: `writer-${tag}`, title: "Writer", summary: "drafts posts", category: "content-creation" });
  assert.equal(agent.path, `/a/writer-${tag}`);
  const work = await A.ok("PUT", "/v1/ot/listings", { kind: "work", ref: "art_1", slug: `deck-${tag}`, title: "Quarterly deck", work_kind: "slides", snapshot: "# Q3\n- growth" });
  assert.equal(work.snapshot, "# Q3\n- growth");
  assert.equal((await B.call("PUT", "/v1/ot/listings", { kind: "work", ref: "x", slug: `deck-${tag}`, title: "steal" })).status, 409);
  assert.equal((await A.call("PUT", "/v1/ot/listings", { kind: "agent", ref: "y", slug: "settings", title: "bad" })).status, 400);
  assert.equal((await A.call("PUT", "/v1/ot/listings", { kind: "agent", ref: "y", slug: `ok-${tag}`, title: "bad", category: "nope" })).status, 400);
  const published = (await B.ok("GET", "/v1/ot/notifications")).notifications.filter((n: any) => n.kind === "discover.published");
  assert.equal(published.length, 2);

  const all = await B.ok("GET", `/v1/ot/discover?q=quarterly`);
  assert.equal(all.items.length, 1);
  assert.equal(all.items[0].following, true);
  assert.equal(all.items[0].snapshot, undefined, "list never carries snapshots");
  const publicAgents = (await B.ok("GET", `/v1/ot/discover?kind=agent&creator=${A.handle}&category=content-creation`)).items;
  assert.equal(publicAgents.length, 1);
  assert.equal(publicAgents[0].ref, undefined, "the public directory does not expose local identifiers");
  assert.equal((await B.ok("GET", `/v1/ot/discover?tab=following&creator=${A.handle}`)).items.length, 2);
  await B.ok("POST", `/v1/ot/listings/${work.id}/like`, {});
  await B.ok("POST", `/v1/ot/listings/${work.id}/collect`, {});
  const detail = await B.ok("GET", `/v1/ot/discover/deck-${tag}`);
  assert.deepEqual([detail.likes, detail.collections, detail.liked, detail.collected, detail.own], [1, 1, true, true, false]);
  assert.equal(detail.snapshot, "# Q3\n- growth");
  assert.equal((await B.ok("GET", "/v1/ot/discover?tab=collected")).items.length, 1);
  await B.ok("POST", `/v1/ot/listings/${work.id}/like`, { on: false });
  assert.equal((await B.ok("GET", `/v1/ot/discover/deck-${tag}`)).likes, 0);

  assert.equal((await B.call("DELETE", `/v1/ot/listings/${work.id}`)).status, 404, "only the creator unlists");
  await A.ok("DELETE", `/v1/ot/listings/${work.id}`);
  assert.equal((await B.call("GET", `/v1/ot/discover/deck-${tag}`)).status, 404);
  assert.equal((await A.ok("GET", `/v1/ot/discover/deck-${tag}`)).listed, false, "the creator still sees it");
  const mine = (await A.ok("GET", "/v1/ot/listings/mine")).listings;
  assert.equal(mine.length, 2);
  assert.equal(mine.find((entry: any) => entry.id === agent.id).ref, "bot_writer");
  assert.deepEqual((await B.ok("GET", "/v1/ot/listings/mine")).listings, []);
  const f = await A.ok("GET", "/v1/ot/follows");
  assert.deepEqual(f.followers.map((p: any) => p.handle), [B.handle]);
  await B.ok("POST", "/v1/ot/follows", { handle: A.handle, on: false });
  assert.equal((await A.ok("GET", "/v1/ot/follows")).followers.length, 0);
});

test("public listing pages need no token and hide unlisted works", async () => {
  const { publicPrefix } = await import("../src/openteamily/discover.ts");
  assert.equal(publicPrefix("https://openteamily.botawaken.com/social"), "/social");
  assert.equal(publicPrefix("https://openteamily.botawaken.com/social/"), "/social");
  assert.equal(publicPrefix("https://openteamily.botawaken.com"), "");

  const A = await home(S.base, "public-creator");
  const tag = `${Date.now() % 100000}`;
  const work = await A.ok("PUT", "/v1/ot/listings", { kind: "work", ref: "pub_1", slug: `essay-${tag}`, title: "Public essay", work_kind: "document", snapshot: "hello <script> world" });
  const agent = await A.ok("PUT", "/v1/ot/listings", { kind: "agent", ref: "bot_pub", slug: `guide-${tag}`, title: "Guide bot", snapshot: JSON.stringify({ name: "Guide bot", quick_starts: ["介绍一下你"] }) });
  assert.equal(work.path, `/w/essay-${tag}`);
  assert.equal(agent.path, `/a/guide-${tag}`);

  const anon = await fetch(`${S.base}/v1/ot/public/listings/essay-${tag}`);
  assert.equal(anon.status, 200);
  const body = await anon.json() as any;
  assert.equal(body.title, "Public essay");
  assert.equal(body.liked, false);
  assert.equal(body.own, false);
  assert.equal(body.snapshot, "hello <script> world");

  const html = await fetch(`${S.base}/w/essay-${tag}`);
  assert.equal(html.status, 200);
  assert.match(html.headers.get("content-type") || "", /text\/html/);
  assert.equal(html.headers.get("cache-control"), "public, max-age=60");
  const page = await html.text();
  assert.match(page, /Public essay/);
  assert.equal(page.includes("<script>"), false, "snapshot is escaped");
  assert.match(page, /hello &lt;script&gt; world/);

  const preview = await fetch(`${S.base}/w/essay-${tag}/preview`);
  assert.equal((await preview.json() as any).preview, "hello <script> world");

  const agentPage = await fetch(`${S.base}/a/guide-${tag}`);
  assert.match(await agentPage.text(), /介绍一下你/);

  const asJson = await fetch(`${S.base}/a/guide-${tag}`, { headers: { accept: "application/json" } });
  assert.equal((await asJson.json() as any).kind, "agent");

  await A.ok("DELETE", `/v1/ot/listings/${work.id}`);
  assert.equal((await fetch(`${S.base}/w/essay-${tag}`)).status, 404);
  assert.equal((await fetch(`${S.base}/v1/ot/public/listings/essay-${tag}`)).status, 404);
});

test("published chats stay paired, use the publisher inbox, and stop receiving replies after revocation", async () => {
  const publisher = await home(S.base, "public-chat-publisher");
  const visitor = await home(S.base, "public-chat-visitor");
  const other = await home(S.base, "public-chat-other");
  const slug = "scoped-visitor-chat";
  const listing = {kind:"agent", ref:"writer_bot", slug, title:"Writer", summary:"Public summary"};
  const start = "/v1/ot/discover/" + slug + "/start";
  const row = await publisher.ok("PUT", "/v1/ot/listings", listing);
  assert.equal(row.chat_enabled, false);
  assert.equal((await visitor.call("POST", start)).status, 409);
  const snapshot = JSON.stringify({version:1,instructions:"Public prompt"});
  await publisher.ok("PUT", "/v1/ot/listings", {...listing, snapshot, chat_enabled:true});
  const first = await visitor.ok("POST", start);
  assert.ok((await publisher.ok("GET", "/v1/ot/notifications")).notifications.some(
    (item: any) => item.kind === "discover.conversation_started" && item.data.conversation_id === first.conversation_id,
  ));
  assert.equal((await visitor.ok("POST", start)).conversation_id, first.conversation_id);
  assert.notEqual((await other.ok("POST", start)).conversation_id, first.conversation_id);
  const thread = "/v1/ot/conversations/" + first.conversation_id;
  assert.equal((await other.call("GET", thread)).status, 404);
  assert.equal((await visitor.call("POST", thread + "/members", {handle:other.handle})).status, 409);
  assert.equal((await visitor.call("PUT", thread + "/agents/my_agent", {name:"Another agent"})).status, 409);
  const sent = await visitor.ok("POST", thread + "/messages", {body:"A visitor question"});
  assert.equal((await visitor.ok("GET", thread)).public_agent.pending, true);
  assert.deepEqual((await visitor.ok("GET", "/v1/ot/agent-inbox")).items, []);
  const inbox = await publisher.ok("GET", "/v1/ot/agent-inbox");
  const item = inbox.items.find((i:any)=>i.message.id===sent.id);
  assert.deepEqual(item.published, {title:"Writer",summary:"Public summary",snapshot});
  assert.equal(item.mode, "public");
  const response = {agent_ref:"writer_bot", mode:"public", reply_to:sent.id, body:"A reply"};
  const answered = await publisher.ok("POST", thread + "/agent-messages", response);
  assert.equal((await publisher.ok("POST", thread + "/agent-messages", response)).id, answered.id);
  assert.equal((await visitor.ok("GET", thread)).public_agent.pending, false);
  const waiting = await visitor.ok("POST", thread + "/messages", {body:"A second question"});
  await publisher.ok("PUT", "/v1/ot/listings", {...listing, snapshot, chat_enabled:false});
  assert.equal((await visitor.ok("GET", thread)).public_agent.open, false);
  assert.equal((await visitor.call("POST", thread + "/messages", {body:"Closed"})).status, 409);
  assert.equal((await publisher.call("POST", thread + "/agent-messages", {...response,reply_to:waiting.id})).status, 409);
  await publisher.ok("PUT", "/v1/ot/listings", {...listing, snapshot, chat_enabled:true});
  assert.equal((await publisher.call("POST", thread + "/agent-messages", {...response,reply_to:waiting.id})).status, 409);
  assert.equal((await visitor.ok("GET", thread + "/messages")).messages.length, 3);
});

test("public quick-start opens one private thread and drafts the current published choice without sending", async () => {
  const publisher = await home(S.base, "quick-start-publisher");
  const visitor = await home(S.base, "quick-start-visitor");
  const stranger = await home(S.base, "quick-start-stranger");
  const slug = "published-quick-start";
  const listing = {kind:"agent", ref:"quick_bot", slug, title:"Quick agent", chat_enabled:true};
  const path = "/v1/ot/discover/" + slug + "/start";
  const page = async () => {
    const response = await fetch(S.base + "/a/" + slug);
    assert.equal(response.headers.get("cache-control"), "no-store");
    return response.text();
  };
  const snapshot = JSON.stringify({quick_starts:["请介绍 <产品>", "列出计划"]});
  const release = await publisher.ok("PUT", "/v1/ot/listings", {...listing, snapshot});
  const rendered = await page();
  assert.match(rendered, /请介绍 &lt;产品&gt;/);
  assert.match(rendered, /href="\/(?:chat|login)#public-agent=published-quick-start"/);
  assert.doesNotMatch(rendered, /请介绍 <产品>/);
  const version = /quick-start=0&amp;quick-start-version=([a-f0-9]{64})/.exec(rendered)?.[1];
  assert.ok(version);
  const viaJson = await fetch(S.base + "/a/" + slug, {headers:{accept:"application/json"}});
  assert.equal(viaJson.headers.get("cache-control"), "no-store");
  assert.equal((await fetch(S.base + "/v1/ot/public/listings/" + slug)).headers.get("cache-control"), "no-store");
  const request = {quick_start:0, quick_start_version:version};
  assert.equal((await fetch(S.base + path, {method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(request)})).status, 401);
  assert.equal((await publisher.call("POST", path, request)).status, 400);
  assert.equal((await visitor.call("POST", path, {...request, body:"forged text"})).status, 400);
  assert.equal((await visitor.call("POST", path, {...request, quick_start:4})).status, 409);

  const first = await visitor.ok("POST", path, request);
  assert.equal(first.created, true);
  assert.equal(first.draft_text, "请介绍 <产品>");
  const again = await visitor.ok("POST", path, {...request, quick_start:1});
  assert.equal(again.created, false);
  assert.equal(again.conversation_id, first.conversation_id);
  assert.equal(again.draft_text, "列出计划");
  const thread = "/v1/ot/conversations/" + first.conversation_id;
  assert.equal((await visitor.ok("POST", path)).draft_text, undefined);
  assert.equal((await stranger.call("GET", thread + "/messages")).status, 404);
  assert.deepEqual((await visitor.ok("GET", thread + "/messages")).messages, []);
  assert.deepEqual((await publisher.ok("GET", "/v1/ot/agent-inbox")).items, []);
  assert.equal((await publisher.ok("GET", "/v1/ot/notifications")).notifications.some(
    (item: any) => item.kind === "discover.conversation_started" && item.data.conversation_id === first.conversation_id,
  ), false);
  const sent = await visitor.ok("POST", thread + "/messages", {body:first.draft_text});
  const original = (await publisher.ok("GET", "/v1/ot/agent-inbox")).items.find((item: any) => item.message.id === sent.id);
  assert.equal(original.mode, "public");
  assert.equal(original.agent_ref, listing.ref);
  assert.deepEqual((await visitor.ok("GET", "/v1/ot/agent-inbox")).items, []);

  const nextSnapshot = JSON.stringify({quick_starts:["更新后的开场"]});
  await publisher.ok("PUT", "/v1/ot/listings", {...listing, snapshot:nextSnapshot});
  const stale = await visitor.call("POST", path, request);
  assert.equal(stale.status, 409);
  assert.equal(stale.data.error.code, "quick_start_changed");
  const freshVersion = /quick-start=0&amp;quick-start-version=([a-f0-9]{64})/.exec(await page())?.[1];
  assert.ok(freshVersion && version !== freshVersion);
  assert.equal((await visitor.ok("POST", path, {...request, quick_start_version:freshVersion})).draft_text, "更新后的开场");
  assert.equal((await visitor.ok("GET", thread + "/messages")).messages.length, 1);

  await publisher.ok("PUT", "/v1/ot/listings", {...listing, snapshot:nextSnapshot, chat_enabled:false});
  assert.doesNotMatch(await page(), /quick-start-version/);
  assert.equal((await visitor.call("POST", path, {...request, quick_start_version:freshVersion})).status, 409);
  await publisher.ok("DELETE", "/v1/ot/listings/" + release.id);
  const unpublished = await fetch(S.base + "/a/" + slug);
  assert.equal(unpublished.status, 404);
  assert.equal(unpublished.headers.get("cache-control"), "no-store");
  assert.equal((await visitor.call("POST", path, request)).status, 404);
});
