// OpenTeamily Discover on Bot Social: publish/unpublish, search and tabs, likes, collections, follows
// and follow notifications. Fixture homes only.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { bulkAuth, startServer } from "./helpers.js";
import { home } from "./openteamily_helpers.js";

const TRIANGLE_GLB = [
  "Z2xURgIAAACUAQAAVAEAAEpTT057ImFzc2V0Ijp7InZlcnNpb24iOiIyLjAifSwic2NlbmUiOjAsInNjZW5lcyI6",
  "W3sibm9kZXMiOlswXX1dLCJub2RlcyI6W3sibWVzaCI6MH1dLCJtZXNoZXMiOlt7InByaW1pdGl2ZXMiOlt7ImF0",
  "dHJpYnV0ZXMiOnsiUE9TSVRJT04iOjB9fV19XSwiYnVmZmVycyI6W3siYnl0ZUxlbmd0aCI6MzZ9XSwiYnVmZmVy",
  "Vmlld3MiOlt7ImJ1ZmZlciI6MCwiYnl0ZUxlbmd0aCI6MzYsInRhcmdldCI6MzQ5NjJ9XSwiYWNjZXNzb3JzIjpb",
  "eyJidWZmZXJWaWV3IjowLCJjb21wb25lbnRUeXBlIjo1MTI2LCJjb3VudCI6MywidHlwZSI6IlZFQzMiLCJtaW4i",
  "OlstMSwtMSwwXSwibWF4IjpbMSwxLDBdfV19ICAgJAAAAEJJTgAAAIC/AACAvwAAAAAAAIA/AACAvwAAAAAAAAAA",
  "AACAPwAAAAA=",
].join("");

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
  assert.equal(html.headers.get("cache-control"), "no-store");
  const page = await html.text();
  assert.match(page, /Public essay/);
  assert.equal(page.includes("<script>"), false, "snapshot is escaped");
  assert.match(page, /hello &lt;script&gt; world/);
  assert.doesNotMatch(page, /public-agent-(composer|share)|script-src 'self'/);

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

test("the public work preview is bounded, listed-only, and independent of the viewer", async () => {
  const publisher = await home(S.base, "preview-publisher");
  const reader = await home(S.base, "preview-reader");
  const {owner_id, display_name, handle} = await publisher.ok("GET", "/v1/ot/me");
  const platformId = "a2".repeat(16);
  S.platform.db.prepare("UPDATE ot_profiles SET platform_user_id=? WHERE owner_id=?").run(platformId, owner_id);

  const slug = "public-preview-essay";
  const path = `/w/${slug}`;
  const snapshot = "Published excerpt <script>\n" + "x".repeat(198_000) + " full snapshot tail";
  const work = await publisher.ok("PUT", "/v1/ot/listings", {
    kind: "work", ref: "owner-local-artifact", slug, title: "Public preview", work_kind: "document", snapshot,
  });
  await publisher.ok("PUT", "/v1/ot/listings", {
    kind: "agent", ref: "owner-local-agent", slug: "work-preview-agent", title: "An agent",
  });
  await reader.ok("POST", "/v1/ot/listings/" + work.id + "/like", {});
  await reader.ok("POST", "/v1/ot/listings/" + work.id + "/collect", {});
  await reader.ok("POST", "/v1/ot/follows", {handle});

  const headers = {accept: "application/json"};
  const response = await fetch(S.base + path + "?view=preview", {headers});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("vary"), "Accept");
  const payload = await response.text();
  assert.ok(payload.length < 2_500, "the public response omits the rest of the snapshot");
  const preview = JSON.parse(payload);
  assert.deepEqual(preview, {
    slug, title: "Public preview", kind: "document", author: handle.replace(/^@/, "").replace(/\.home$/, ""),
    updated: Math.floor(work.updated_at / 1000),
    path, likes: 1, collections: 1, comment_count: 0, site_available: false,
    preview: snapshot.slice(0, 2000),
  });
  assert.deepEqual(await (await fetch(S.base + path + "/preview")).json(), {preview: preview.preview});
  assert.equal((await fetch(S.base + path + "?view=preview")).headers.get("content-type")?.startsWith("text/html"), true);
  assert.equal((await fetch(S.base + "/w/work-preview-agent?view=preview", {headers})).status, 404);
  assert.equal((await fetch(S.base + "/w/unknown-preview?view=preview", {headers})).status, 404);

  for (const rawPath of [path, `/v1/ot/public/listings/${slug}`, "/a/work-preview-agent"]) {
    const raw = await (await fetch(S.base + rawPath, {headers})).json() as any;
    assert.deepEqual(raw.creator, {handle, display_name, bio: ""});
    assert.ok(!JSON.stringify(raw).includes(platformId));
    assert.ok(!JSON.stringify(raw).includes(owner_id));
    assert.equal(raw.liked, false);
    assert.equal(raw.own, false);
    if (raw.kind === "work") assert.equal(raw.snapshot, snapshot, "legacy public JSON keeps the published snapshot");
  }
  await publisher.ok("DELETE", "/v1/ot/listings/" + work.id);
  assert.equal((await fetch(S.base + path + "?view=preview", {headers})).status, 404);
});

test("publication notifications resolve the current listing by ID and disappear when it is unlisted", async () => {
  const [publisher, follower, other] = await Promise.all([
    home(S.base, "renamed-publisher"), home(S.base, "renamed-follower"), home(S.base, "reused-address"),
  ]);
  const inbox = "/v1/ot/notifications";
  await follower.ok("POST", "/v1/ot/follows", { handle: publisher.handle });
  const original = { kind: "agent", ref: "original_agent", slug: "original-published-slug", title: "Initial title" };
  const listing = await publisher.ok("PUT", "/v1/ot/listings", original);
  const [notice] = (await follower.ok("GET", inbox)).notifications;
  assert.equal(notice.data.listing_id, listing.id);
  assert.equal(notice.data.slug, original.slug);

  const renamed = { ...original, slug: "updated-published-slug", title: "Current title" };
  const updated = await publisher.ok("PUT", "/v1/ot/listings", renamed);
  assert.equal(updated.id, listing.id);
  const reused = await other.ok("PUT", "/v1/ot/listings", { kind: "work", ref: "replacement_work",
    work_kind: "document", slug: original.slug, title: "Different listing" });
  assert.notEqual(reused.id, listing.id);
  const inboxPage = await follower.ok("GET", inbox + "?personal=1&latest=1&unread=1");
  assert.equal(inboxPage.unread, 1);
  assert.equal(inboxPage.notifications.length, 1);
  const [actual] = inboxPage.notifications;
  assert.deepEqual([actual.id, actual.seq], [notice.id, notice.seq]);
  assert.deepEqual([actual.data.listing_id, actual.data.slug, actual.data.title, actual.data.kind, actual.data.listing_kind],
    [listing.id, renamed.slug, renamed.title, "agent", "agent"]);

  await publisher.ok("DELETE", "/v1/ot/listings/" + listing.id);
  assert.deepEqual(await follower.ok("GET", inbox + "?latest=1"), { notifications: [], unread: 0 });
  assert.equal((await follower.call("POST", inbox + "/read", { notification_id: actual.id })).status, 404);
  assert.deepEqual(await follower.ok("POST", inbox + "/read", { all: true }), { marked: 0, unread: 0 });
  assert.equal((await follower.ok("GET", "/v1/ot/discover/" + original.slug)).id, reused.id);
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
  for (const participant of [publisher, visitor]) {
    assert.deepEqual(await participant.ok("GET", thread + "/attachments?kind=file"), {items: [], next_cursor: null});
  }
  assert.equal((await other.call("GET", thread + "/attachments?kind=file")).status, 404);
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

test("the public composer is gated by chat availability and a drafted start is bound to its listing ID", async () => {
  const [publisher, replacement, visitor] = await Promise.all([
    home(S.base, "composer-publisher"), home(S.base, "composer-replacement"), home(S.base, "composer-visitor"),
  ]);
  const listing = { kind: "agent", slug: "public-draft-agent", ref: "draft_agent", title: 'Draft <writer>',
    snapshot: JSON.stringify({ quick_starts: ["A safe quick-start"] }) };
  const start = "/v1/ot/discover/" + listing.slug + "/start";
  const original = await publisher.ok("PUT", "/v1/ot/listings", listing);
  const page = async () => {
    const response = await fetch(S.base + "/a/" + listing.slug);
    assert.equal(response.headers.get("cache-control"), "no-store");
    return response.text();
  };
  assert.doesNotMatch(await page(), /<form id="public-agent-composer"|src="\/shell\/public-agent-composer/);
  assert.equal((await visitor.call("POST", start, { listing_id: original.id })).data.error.code, "public_chat_closed");

  await publisher.ok("PUT", "/v1/ot/listings", { ...listing, chat_enabled: true });
  const html = await page();
  assert.match(html, /Draft &lt;writer&gt;/);
  assert.match(html, /form-action 'none';[^"]*script-src 'self';/);
  assert.match(html, /<script type="module" src="\/shell\/public-agent-composer\.mjs"><\/script>/);
  assert.ok(html.includes(`<form id="public-agent-composer" method="post" data-slug="${listing.slug}" data-listing-id="${original.id}">`));
  assert.match(html, /<textarea[^>]+name="message"[^>]+maxlength="4000"[^>]+disabled/);
  assert.match(html, /<button[^>]+type="submit" disabled>/);
  assert.match(html, /href="\/login#public-agent=public-draft-agent"/);
  assert.match(html, /quick-start-version=[a-f0-9]{64}/);

  const selection = { listing_id: original.id };
  assert.equal((await fetch(S.base + start, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(selection) })).status, 401);
  assert.equal((await visitor.call("POST", start, { listing_id: "otl_fake" })).status, 400);
  assert.equal((await visitor.call("POST", start, { ...selection, message: "Private draft" })).status, 400);
  assert.equal((await visitor.call("POST", start, {
    ...selection, quick_start: 0, quick_start_version: "a".repeat(64),
  })).status, 400);
  assert.deepEqual((await visitor.ok("GET", "/v1/ot/conversations?scope=public")).conversations, []);

  const opened = await visitor.ok("POST", start, selection);
  assert.equal(opened.created, true);
  assert.equal(opened.draft_text, undefined);
  assert.equal((await visitor.ok("POST", start, selection)).conversation_id, opened.conversation_id);
  const messages = "/v1/ot/conversations/" + opened.conversation_id + "/messages";
  assert.deepEqual((await visitor.ok("GET", messages)).messages, []);
  assert.deepEqual((await publisher.ok("GET", "/v1/ot/agent-inbox")).items, []);
  assert.equal((await publisher.ok("GET", "/v1/ot/notifications")).notifications
    .some((item: { kind: string }) => item.kind === "discover.conversation_started"), false);

  await publisher.ok("PUT", "/v1/ot/listings", { ...listing, slug: "draft-agent-moved", chat_enabled: true });
  const alternative = await replacement.ok("PUT", "/v1/ot/listings", { ...listing, chat_enabled: true });
  assert.notEqual(alternative.id, original.id);
  const conflict = await visitor.call("POST", start, selection);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.error.code, "public_agent_changed");
  assert.deepEqual((await visitor.ok("GET", "/v1/ot/conversations?scope=public")).conversations
    .map((row: { id: string }) => row.id), [opened.conversation_id]);
  assert.deepEqual((await replacement.ok("GET", "/v1/ot/conversations?scope=public")).conversations, []);
  const sent = await visitor.ok("POST", messages, { body: "The confirmed message" });
  assert.ok((await publisher.ok("GET", "/v1/ot/agent-inbox")).items.some((item: { message: { id: string } }) =>
    item.message.id === sent.id));
  assert.deepEqual((await replacement.ok("GET", "/v1/ot/agent-inbox")).items, []);
});

test("listed agent profiles expose a canonical share path even when visitor chat is disabled", async () => {
  const publisher = await home(S.base, "profile-share-publisher");
  await publisher.ok("PUT", "/v1/ot/profile", { display_name: 'Name <img src=x onerror="alert(1)">' });
  const slug = "profile-share-agent";
  const malicious = '<script src="https://fixture.invalid/injected.js"></script>';
  const listing = { kind: "agent", ref: "shareable_agent", slug, title: malicious, summary: malicious,
    snapshot: JSON.stringify({ quick_starts: ["Open this example"] }) };
  const path = "/a/" + slug;
  for (const chat_enabled of [false, true]) {
    await publisher.ok("PUT", "/v1/ot/listings", { ...listing, chat_enabled });
    const response = await fetch(S.base + path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const html = await response.text();
    assert.match(html, /form-action 'none';[^"]*script-src 'self';/);
    assert.equal(html.includes(malicious), false);
    assert.match(html, /Name &lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
    assert.match(html, /&lt;script src=&quot;https:\/\/fixture\.invalid\/injected\.js&quot;&gt;/);
    assert.match(html, /<script type="module" src="\/shell\/public-agent-share\.mjs"><\/script>/);
    assert.ok(html.includes(`id="public-agent-share" class="profile-share" data-profile-path="${path}"`));
    assert.ok(html.includes(`value="${path}" data-copy-profile-url readonly`));
    assert.ok(html.includes(`href="${path}">打开公开主页`));
    assert.match(html, /<button type="button" data-copy-profile disabled hidden>/);
    assert.match(html, /<details data-copy-profile-fallback>\s*<summary>主页链接<\/summary>/);
    assert.match(html, /data-copy-profile-status role="status" aria-live="polite"/);
    assert.equal(html.includes('<form id="public-agent-composer"'), chat_enabled);
    assert.doesNotMatch(html, /(?:data-profile-path|href)="\/social\/a\//);
  }
  const publicData = await (await fetch(S.base + path, { headers: { accept: "application/json" } })).json() as Record<string, unknown>;
  assert.equal(publicData.kind, "agent");
  assert.equal(Object.hasOwn(publicData, "profile_share_token"), false);
});

test("popular works use recent public engagement, with stable account-scoped cursors", async (t) => {
  let now = Date.now();
  const server = await startServer({...bulkAuth, now: () => now});
  t.after(() => server.stop());
  const author = await home(server.base, "popularity-author");
  const reader = await home(server.base, "popularity-reader");
  const other = await home(server.base, "popularity-other");
  const publish = async (slug: string, work_kind = "document", kind = "work") => {
    now += 1_000;
    return author.ok("PUT", "/v1/ot/listings", {
      kind, ref: slug, slug, title: `Workshop ${slug}`, work_kind, snapshot: `Public ${slug}`,
      ...(work_kind === "model3d" ? {model_data: TRIANGLE_GLB} : {}),
    });
  };
  const oldest = await publish("old-work");
  const model = await publish("model-work", "model3d");
  await publish("new-work");
  await publish("not-a-work", "document", "agent");
  const base = "/v1/ot/discover?kind=work&sort=popular&q=workshop";
  const slugs = (page: {items: {slug: string}[]}) => page.items.map(item => item.slug);

  assert.equal((await fetch(server.base + base)).status, 401);
  const sparse = await reader.ok("GET", base);
  assert.deepEqual(slugs(sparse), ["new-work", "model-work", "old-work"]);
  assert.equal(sparse.next_cursor, null);
  await author.ok("POST", `/v1/ot/listings/${oldest.id}/like`, {});
  assert.deepEqual(slugs(await reader.ok("GET", base)), slugs(sparse), "self-engagement does not boost a work");
  await reader.ok("POST", "/v1/ot/follows", {handle: author.handle});
  await reader.ok("POST", `/v1/ot/listings/${oldest.id}/like`, {});
  await reader.ok("POST", `/v1/ot/listings/${model.id}/collect`, {});
  const ranked = await reader.ok("GET", base);
  assert.deepEqual(slugs(ranked), ["model-work", "old-work", "new-work"]);
  assert.equal(ranked.items[0].collected, true);
  assert.equal(ranked.items[0].following, true);
  assert.ok(ranked.items.every((item: any) => item.snapshot === undefined && item.ref === undefined && item.position === undefined));
  const independent = await other.ok("GET", base);
  assert.deepEqual(slugs(independent), slugs(ranked), "shared order is independent of the viewer's flags");
  assert.equal(independent.items[0].collected, false);
  assert.equal(independent.items[0].following, false);
  assert.deepEqual(slugs(await other.ok("GET", base + "&work_kind=model3d")), ["model-work"]);
  assert.deepEqual(slugs(await other.ok("GET", "/v1/ot/discover?kind=work&q=workshop")), slugs(sparse));
  assert.deepEqual(slugs(await reader.ok("GET", "/v1/ot/discover?kind=work&tab=following&q=workshop")), slugs(sparse));

  const pageOne = await reader.ok("GET", base + "&limit=1");
  assert.deepEqual(slugs(pageOne), ["model-work"]);
  assert.match(pageOne.next_cursor, /^[A-Za-z0-9_-]{32}\.[1-9][0-9]{0,2}$/);
  const suffix = "&limit=1&cursor=" + encodeURIComponent(pageOne.next_cursor);
  assert.equal((await other.call("GET", base + suffix)).status, 400);
  assert.equal((await reader.call("GET", base + suffix + "&work_kind=model3d")).status, 400);
  assert.equal((await reader.call("GET", base + "&before=42")).status, 400);
  assert.equal((await reader.call("GET", base + "&tab=collected")).status, 400);
  assert.equal((await reader.call("GET", base + "&cursor=42")).status, 400);

  await reader.ok("POST", `/v1/ot/listings/${model.id}/collect`, {on:false});
  await author.ok("DELETE", `/v1/ot/listings/${oldest.id}`);
  const pageTwo = await reader.ok("GET", base + suffix);
  assert.deepEqual(slugs(pageTwo), ["new-work"], "revoked works are skipped without re-ranking page one");
  assert.equal(pageTwo.next_cursor, null);
  assert.deepEqual(slugs(await reader.ok("GET", base)), ["new-work", "model-work"]);
  assert.equal((await fetch(server.base + "/w/old-work")).status, 404);
  now += 11 * 60_000;
  const expired = await reader.call("GET", base + suffix);
  assert.equal(expired.status, 409);
  assert.equal(expired.data.error.code, "popularity_expired");
});


test("public GLB downloads appear only after an explicit publish and disappear on revoke", async () => {
  const owner = await home(S.base, "model-author");
  const visitor = await home(S.base, "model-visitor");
  const payload = {kind: "work", ref: "glb-fixture", slug: "clay-figure", title: "陶土模型 🏺", work_kind: "model3d"};
  const publicPage = S.base + "/w/clay-figure";
  const publicFile = publicPage + "/file";
  assert.equal((await fetch(publicFile)).status, 404);
  assert.equal((await owner.call("PUT", "/v1/ot/listings", {...payload, model_data: "aGVsbG8="})).status, 400);
  assert.equal((await fetch(publicPage)).status, 404, "invalid files never create a public page");
  const model = await owner.ok("PUT", "/v1/ot/listings", {...payload, model_data: TRIANGLE_GLB});
  assert.equal(model.model_data, undefined);
  const document = await fetch(publicPage);
  assert.equal(document.status, 200);
  assert.match(await document.text(), /href="\/w\/clay-figure\/file"/);
  const file = await fetch(publicFile);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get("content-type"), "model/gltf-binary");
  assert.equal(file.headers.get("cache-control"), "no-store");
  assert.match(file.headers.get("content-disposition") ?? "", /filename="clay-figure\.glb"/);
  assert.equal(Buffer.from(await file.arrayBuffer()).toString("base64"), TRIANGLE_GLB);

  assert.equal((await visitor.call("DELETE", "/v1/ot/listings/" + model.id)).status, 404);
  await owner.ok("DELETE", "/v1/ot/listings/" + model.id);
  assert.equal((await fetch(publicPage)).status, 404);
  assert.equal((await fetch(publicFile)).status, 404);
});

test("work detail follows the filtered feed across page boundaries and timestamp ties", async (t) => {
  let now = Date.now();
  const server = await startServer({...bulkAuth, now: () => now});
  t.after(() => server.stop());
  const author = await home(server.base, "work-nav-author");
  const outsider = await home(server.base, "work-nav-outsider");
  const viewer = await home(server.base, "work-nav-viewer");
  const publish = (owner: typeof author, slug: string, title: string, workKind = "document") =>
    owner.ok("PUT", "/v1/ot/listings", {
      kind: "work", ref: slug, slug, title, work_kind: workKind, snapshot: "Public snapshot",
    });

  const oldest = await publish(author, "nav-oldest", "Trail sketch oldest");
  now += 1_000;
  const draft = await publish(author, "nav-hidden", "Trail sketch hidden");
  await publish(author, "nav-middle", "Trail sketch middle");
  await publish(author, "nav-same-time", "Trail sketch tied");
  await publish(outsider, "nav-unfollowed", "Trail sketch outside");
  await publish(author, "nav-other-kind", "Trail sketch website", "website");
  await publish(author, "nav-other-search", "Unrelated plans");
  await author.ok("PUT", "/v1/ot/listings", {
    kind: "agent", ref: "nav-agent", slug: "nav-agent", title: "Trail sketch helper",
  });
  await author.ok("DELETE", "/v1/ot/listings/" + draft.id);
  await viewer.ok("POST", "/v1/ot/follows", {handle: author.handle});

  const base = "/v1/ot/discover";
  const detailPath = (slug: string, q = "") => `${base}/${slug}/detail${q}`;
  const filters = "tab=following&work_kind=document&q=trail%20sketch";
  const page = await viewer.ok("GET", `${base}?kind=work&${filters}`);
  const slim = ({slug, title}: {slug: string; title: string}) => ({slug, title});
  const visible = page.items.map(slim);
  assert.deepEqual(new Set(visible.map((item: {slug: string}) => item.slug)),
    new Set(["nav-oldest", "nav-middle", "nav-same-time"]));
  assert.equal((await viewer.ok("GET", `${base}?kind=work&${filters}&limit=1`)).items.length, 1);
  for (const [index, item] of visible.entries()) {
    const data = await viewer.ok("GET", detailPath(item.slug, "?" + filters));
    assert.deepEqual(slim(data.work), item);
    assert.equal(data.work.following, true);
    assert.ok(!("snapshot" in data.work) && !("ref" in data.work));
    assert.deepEqual(data.previous, visible[index - 1] ?? null);
    assert.deepEqual(data.next, visible[index + 1] ?? null);
  }
  const unmatched = await viewer.ok("GET", detailPath("nav-unfollowed", "?" + filters));
  assert.equal(unmatched.work.slug, "nav-unfollowed");
  assert.equal(unmatched.previous, null);
  assert.equal(unmatched.next, null);
  const authorFilter = "creator=" + encodeURIComponent(author.handle) + "&work_kind=document&q=trail%20sketch";
  const scoped = await viewer.ok("GET", `${base}?kind=work&${authorFilter}`);
  assert.deepEqual(scoped.items.map(slim), visible);
  const fromAuthorProfile = await viewer.ok("GET", detailPath(visible[1].slug, "?" + authorFilter));
  assert.deepEqual(fromAuthorProfile.previous, visible[0]);
  assert.deepEqual(fromAuthorProfile.next, visible[2]);
  await viewer.ok("POST", `/v1/ot/listings/${oldest.id}/collect`, {});
  const collected = await viewer.ok("GET", detailPath(oldest.slug, "?tab=collected"));
  assert.equal(collected.work.collected, true);
  assert.equal(collected.previous, null);
  assert.equal(collected.next, null);

  // The previously older work takes the first rank after a visitor collects it.
  const hotFilter = "sort=popular&work_kind=document&q=trail%20sketch";
  const ranked = (await viewer.ok("GET", `${base}?kind=work&${hotFilter}`)).items.map(slim);
  assert.equal(ranked[0].slug, oldest.slug);
  const popular = await viewer.ok("GET", detailPath(oldest.slug, "?" + hotFilter));
  assert.equal(popular.previous, null);
  assert.deepEqual(popular.next, ranked[1]);
  assert.equal((await viewer.call("GET", detailPath("nav-hidden"))).status, 404);
  assert.equal((await author.call("GET", detailPath("nav-hidden"))).status, 404, "the public viewer hides revoked works from their author");
  assert.equal((await viewer.call("GET", detailPath("nav-agent"))).status, 404);
  assert.equal((await viewer.call("GET", detailPath(oldest.slug, "?sort=popular&tab=following"))).status, 400);
  assert.equal((await viewer.call("GET", detailPath(oldest.slug, "?work_kind=unknown"))).status, 400);
  assert.equal((await viewer.call("GET", detailPath(oldest.slug, "?q=trail&q=sketch"))).status, 400);
  assert.equal((await fetch(server.base + detailPath(oldest.slug))).status, 401);
});

test("guest work pages navigate directly between public works and keep the share entry", async (t) => {
  let now = Date.now();
  const server = await startServer({...bulkAuth, now: () => now});
  t.after(() => server.stop());
  const author = await home(server.base, "guest-work-nav");
  const publish = (slug: string, title: string, kind = "work") => {
    now += 1_000;
    return author.ok("PUT", "/v1/ot/listings", {kind, ref: slug, slug, title, snapshot: "Public preview"});
  };
  const older = await publish("guest-nav-older", "Older <work>");
  await publish("guest-nav-agent", "An agent", "agent");
  const withdrawn = await publish("guest-nav-withdrawn", "Withdrawn");
  const newer = await publish("guest-nav-newer", "Newer work");
  await author.ok("DELETE", "/v1/ot/listings/" + withdrawn.id);
  const opened = await fetch(server.base + newer.path);
  assert.equal(opened.status, 200);
  assert.equal(opened.headers.get("cache-control"), "no-store");
  const html = await opened.text();
  assert.match(html, /<span aria-disabled="true">上一件<\/span>/);
  assert.match(html, /<a rel="next" href="\/w\/guest-nav-older" title="Older &lt;work&gt;">下一件<\/a>/);
  assert.match(html, /href="\/login#work-detail=guest-nav-newer">分享作品/);
  assert.match(html, /href="\/login#work-comments=guest-nav-newer">查看评论/);
  assert.doesNotMatch(html, /guest-nav-withdrawn|guest-nav-agent/);
  const previous = await (await fetch(server.base + older.path)).text();
  assert.match(previous, /<a rel="prev" href="\/w\/guest-nav-newer"[^>]*>上一件<\/a>/);
  assert.match(previous, /<span aria-disabled="true">下一件<\/span>/);
});

test("public website HTML lives only in an isolated frame and is deleted on revocation", async () => {
  const publisher = await home(S.base, "website-publisher");
  const reader = await home(S.base, "website-reader");
  const slug = "interactive-counter";
  const page = S.base + "/w/" + slug;
  const put = "/v1/ot/listings";
  const summary = "一个可点击的计数器。";
  const site_html = '<!doctype html><button id="site-counter">0</button><script>site-counter-data</script>';
  const input = {kind: "work", work_kind: "website", ref: "website_artifact", slug, title: "计数器 <demo>", summary};

  assert.equal((await fetch(page + "/site")).status, 404);
  const anon = await fetch(S.base + put, {
    method: "PUT", headers: {"content-type":"application/json"}, body: JSON.stringify({...input, site_html}),
  });
  assert.equal(anon.status, 401);
  assert.equal((await publisher.call("PUT", put, {...input, work_kind: "document", site_html})).status, 400);
  assert.equal((await publisher.call("PUT", put, {...input, site_html: " "})).status, 400);
  assert.equal((await publisher.call("PUT", put, {...input, site_html: "网".repeat(12_000)})).status, 413);
  assert.equal((await fetch(page)).status, 404);

  const work = await publisher.ok("PUT", put, {...input, site_html, snapshot: site_html});
  assert.equal(work.site_available, true);
  assert.equal("site_html" in work, false);
  assert.equal(work.snapshot, null);
  assert.equal((await reader.call("PUT", put, {...input, site_html: "different"})).status, 409);

  const signed = await reader.ok("GET", "/v1/ot/discover/" + slug + "/detail");
  const anonymous = await (await fetch(page, {headers: {accept: "application/json"}})).json() as any;
  for (const projection of [signed.work, anonymous]) {
    assert.equal(projection.site_available, true);
    assert.equal(JSON.stringify(projection).includes("site-counter-data"), false);
    assert.equal("site_html" in projection, false);
  }
  const preview = await (await fetch(page + "?view=preview", {headers: {accept: "application/json"}})).json() as any;
  assert.equal(preview.kind, "website");
  assert.equal(preview.site_available, true);
  assert.equal(preview.preview, summary);
  assert.doesNotMatch(JSON.stringify(preview), /site-counter-data|site_html|snapshot/);
  const feed = await reader.ok("GET", "/v1/ot/discover?kind=work&work_kind=website&q=计数器");
  assert.equal(feed.items[0].site_available, true);
  assert.equal(JSON.stringify(feed).includes("site-counter-data"), false);

  const host = await (await fetch(page)).text();
  assert.match(host, /<iframe class="work-site-frame" src="\/w\/interactive-counter\/site"/);
  assert.match(host, /sandbox="allow-scripts" referrerpolicy="no-referrer"/);
  assert.match(host, /title="计数器 &lt;demo&gt; 的互动预览"/);
  assert.match(host, /frame-src 'self'/);
  assert.match(host, /评论/);
  assert.doesNotMatch(host, /site-counter-data|public-agent-share|script-src 'self'/);
  assert.deepEqual(await (await fetch(page + "/preview")).json(), {preview: summary});

  const frame = await fetch(page + "/site");
  assert.equal(frame.status, 200);
  assert.match(frame.headers.get("content-type") ?? "", /^text\/html; charset=utf-8$/);
  assert.equal(frame.headers.get("cache-control"), "no-store");
  assert.equal(frame.headers.get("x-content-type-options"), "nosniff");
  assert.equal(frame.headers.get("referrer-policy"), "no-referrer");
  assert.deepEqual(new Set(frame.headers.get("content-security-policy")?.split("; ")), new Set([
    "sandbox allow-scripts", "frame-ancestors 'self'", "default-src 'none'",
    "script-src 'unsafe-inline'", "style-src 'unsafe-inline'", "img-src data:", "font-src data:", "media-src data:",
    "connect-src 'none'", "object-src 'none'", "frame-src 'none'", "worker-src 'none'", "base-uri 'none'", "form-action 'none'",
  ]));
  assert.equal(await frame.text(), site_html);

  assert.equal((await reader.call("DELETE", put + "/" + work.id)).status, 404);
  await publisher.ok("DELETE", put + "/" + work.id);
  assert.equal((await fetch(page + "/site")).status, 404);
  assert.equal((await fetch(page)).status, 404);

  const legacy = await publisher.ok("PUT", put, {...input, snapshot: "既有静态网页"});
  assert.equal(legacy.site_available, false);
  assert.match(await (await fetch(page)).text(), /既有静态网页/);
  assert.equal((await fetch(page + "/site")).status, 404);
  await publisher.ok("PUT", put, {...input, site_html});
  await publisher.ok("PUT", put, {...input, work_kind: "document", snapshot: "普通文档"});
  assert.equal((await fetch(page + "/site")).status, 404);
  assert.doesNotMatch(await (await fetch(page)).text(), /work-site-frame" src=/);
});
