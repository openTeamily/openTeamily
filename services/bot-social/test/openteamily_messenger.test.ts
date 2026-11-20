// OpenTeamily member messenger on Bot Social: DMs, groups, unread, reactions, edits, mentions and
// group agents answered by their owner's DS-Bot (agent inbox + capped auto replies). Fixtures only.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { bulkAuth, startServer } from "./helpers.js";
import { home } from "./openteamily_helpers.js";

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(bulkAuth); });
after(async () => { await S.stop(); });

async function teamOf(...people: Awaited<ReturnType<typeof home>>[]) {
  const [owner, ...rest] = people;
  const team = await owner.ok("POST", "/v1/ot/teams", { name: "Msg team" });
  for (const p of rest) {
    const { code } = await owner.ok("POST", `/v1/ot/teams/${team.id}/invites`, {});
    await p.ok("POST", "/v1/ot/invites/accept", { code });
  }
  return team;
}

test("DMs only between teammates; one DM per pair; unread and read cursors", async () => {
  const A = await home(S.base, "dma");
  const B = await home(S.base, "dmb");
  const X = await home(S.base, "stranger");
  await teamOf(A, B);
  assert.equal((await X.call("POST", "/v1/ot/conversations", { kind: "dm", peer: A.handle })).status, 403);
  const dm = await A.ok("POST", "/v1/ot/conversations", { kind: "dm", peer: B.handle });
  const again = await B.ok("POST", "/v1/ot/conversations", { kind: "dm", peer: A.handle });
  assert.equal(again.id, dm.id);
  const m1 = await A.ok("POST", `/v1/ot/conversations/${dm.id}/messages`, { body: "hello B", client_key: "k1" });
  const dup = await A.ok("POST", `/v1/ot/conversations/${dm.id}/messages`, { body: "hello B", client_key: "k1" });
  assert.equal(dup.id, m1.id, "client_key makes sends idempotent");
  assert.equal((await B.ok("GET", "/v1/ot/conversations")).unread, 1);
  assert.equal((await A.ok("GET", "/v1/ot/conversations")).unread, 0);
  const page = await B.ok("GET", `/v1/ot/conversations/${dm.id}/messages`);
  assert.deepEqual(page.messages.map((m: any) => m.body), ["hello B"]);
  await A.ok("POST", `/v1/ot/conversations/${dm.id}/messages`, { body: "arrived after the page loaded" });
  const partial = await B.ok("POST", `/v1/ot/conversations/${dm.id}/read`, { seq: page.messages[0].seq });
  assert.equal(partial.unread, 1);
  const allRead = await B.ok("POST", `/v1/ot/conversations/${dm.id}/read`, {});
  assert.equal(allRead.unread, 0);
  assert.equal((await B.ok("GET", "/v1/ot/conversations")).unread, 0);
  assert.equal((await X.call("GET", `/v1/ot/conversations/${dm.id}/messages`)).status, 404, "outsiders see nothing");

  await B.ok("POST", `/v1/ot/messages/${m1.id}/reactions`, { emoji: "👍" });
  assert.equal((await B.call("POST", `/v1/ot/messages/${m1.id}/reactions`, { emoji: "💩" })).status, 400);
  assert.equal((await B.call("PATCH", `/v1/ot/messages/${m1.id}`, { body: "hijack" })).status, 403);
  await A.ok("PATCH", `/v1/ot/messages/${m1.id}`, { body: "hello again" });
  const after1 = (await A.ok("GET", `/v1/ot/conversations/${dm.id}/messages`)).messages.find((message: any) => message.id === m1.id);
  assert.equal(after1.body, "hello again");
  assert.equal(after1.reactions[0].count, 1);
  await A.ok("DELETE", `/v1/ot/messages/${m1.id}`);
  assert.equal((await B.ok("GET", `/v1/ot/conversations/${dm.id}/messages`)).messages.find((message: any) => message.id === m1.id).retracted, true);
});

test("groups: members, mentions notify, creator removes, members leave", async () => {
  const A = await home(S.base, "ga");
  const B = await home(S.base, "gb");
  const C = await home(S.base, "gc");
  const team = await teamOf(A, B, C);
  const g = await A.ok("POST", "/v1/ot/conversations", { kind: "group", title: "Launch", team_id: team.id, members: [B.handle] });
  assert.equal(g.members.length, 2);
  await B.ok("POST", `/v1/ot/conversations/${g.id}/members`, { handle: C.handle });
  await B.ok("POST", `/v1/ot/conversations/${g.id}/messages`, { body: `@${C.handle} can you review?` });
  const notes = await C.ok("GET", "/v1/ot/notifications");
  assert.ok(notes.notifications.some((n: any) => n.kind === "messenger.mention" && n.data.conversation_id === g.id));
  assert.equal((await B.call("DELETE", `/v1/ot/conversations/${g.id}/members/${C.handle}`)).status, 403);
  await A.ok("DELETE", `/v1/ot/conversations/${g.id}/members/${C.handle}`);
  assert.equal((await C.call("GET", `/v1/ot/conversations/${g.id}`)).status, 404);
  await B.ok("DELETE", `/v1/ot/conversations/${g.id}/members/${B.handle}`);
  assert.equal((await A.ok("GET", `/v1/ot/conversations/${g.id}`)).members.length, 1);
});

test("group agents: the owner's DS-Bot gets mentions and auto-reply turns; auto replies capped at 3/hour", async () => {
  const A = await home(S.base, "agowner");
  const B = await home(S.base, "agpeer");
  await teamOf(A, B);
  const g = await B.ok("POST", "/v1/ot/conversations", { kind: "group", title: "Agents", members: [A.handle] });
  await A.ok("PUT", `/v1/ot/conversations/${g.id}/agents/helper`, { name: "Helper", auto_reply: false });
  assert.equal((await B.call("POST", `/v1/ot/conversations/${g.id}/agent-messages`, { agent_ref: "helper", body: "spoof" })).status, 404, "only the agent's owner posts as it");
  await B.ok("POST", `/v1/ot/conversations/${g.id}/messages`, { body: "no mention here" });
  await B.ok("POST", `/v1/ot/conversations/${g.id}/messages`, { body: "@helper summarize please" });
  let inbox = await A.ok("GET", "/v1/ot/agent-inbox");
  assert.equal(inbox.items.length, 1);
  assert.equal(inbox.items[0].mode, "mention");
  assert.equal(inbox.items[0].context.length, 2);
  assert.equal((await B.ok("GET", "/v1/ot/agent-inbox")).items.length, 0, "B owns no agent");
  const reply = await A.ok("POST", `/v1/ot/conversations/${g.id}/agent-messages`, { agent_ref: "helper", body: "Summary: …", reply_to: inbox.items[0].message.id, mode: "mention" });
  assert.equal(reply.author.kind, "agent");
  assert.equal(reply.author.name, "Helper");
  inbox = await A.ok("GET", `/v1/ot/agent-inbox?after=${inbox.cursor}`);
  assert.equal(inbox.items.length, 0, "agent messages never re-enter the inbox");

  const agentSettings = `/v1/ot/conversations/${g.id}/agents/helper`;
  const old = await B.ok("POST", `/v1/ot/conversations/${g.id}/messages`, { body: "before the switch" });
  assert.equal((await B.call("PATCH",agentSettings, {auto_reply: true})).status, 404);
  assert.deepEqual(await A.ok("PATCH",agentSettings, {auto_reply:true}), {auto_reply:true});
  assert.equal((await A.ok("GET", `/v1/ot/conversations/${g.id}`)).agents[0].auto_reply, true);

  const cursor = inbox.cursor;
  for (let i = 0; i < 4; i++) await B.ok("POST", `/v1/ot/conversations/${g.id}/messages`, { body: `thought ${i}` });
  inbox = await A.ok("GET", `/v1/ot/agent-inbox?after=${cursor}`);
  assert.equal(inbox.items.length, 4);
  assert.ok(inbox.items.every((x: any) => x.mode === "auto"));
  assert.ok(inbox.items.every((x: any) => x.message.id !== old.id));
  assert.equal((await A.call("POST", `/v1/ot/conversations/${g.id}/agent-messages`, {
    agent_ref: "helper", body: "stale auto", mode: "auto", reply_to: old.id
  })).status, 409);
  for (let i = 0; i < 3; i++) await A.ok("POST", `/v1/ot/conversations/${g.id}/agent-messages`, { agent_ref: "helper", body: `auto ${i}`, mode: "auto" });
  const capped = await A.call("POST", `/v1/ot/conversations/${g.id}/agent-messages`, { agent_ref: "helper", body: "auto 4", mode: "auto" });
  assert.equal(capped.status, 429);
  assert.equal(capped.data.error.code, "agent_reply_limit");
  assert.deepEqual(await A.ok("PATCH",agentSettings, {auto_reply:false}), {auto_reply:false});
  assert.equal((await A.call("POST", `/v1/ot/conversations/${g.id}/agent-messages`, {
    agent_ref: "helper", body: "disabled while a turn was running", mode: "auto", reply_to: inbox.items[3].message.id
  })).status, 409);
});

test("explicit mentions address the selected owner, even when agents share IDs and names", async () => {
  const A = await home(S.base, "mention-a");
  const B = await home(S.base, "mention-b");
  const C = await home(S.base, "mention-c");
  await teamOf(A, B, C);
  const group = await A.ok("POST", "/v1/ot/conversations", {
    kind: "group", title: "Mentions", members: [B.handle, C.handle],
  });
  const root = `/v1/ot/conversations/${group.id}`;
  await B.ok("PUT", root + "/agents/shared", {name: "Helper"});
  await C.ok("PUT", root + "/agents/shared", {name: "Helper"});
  const owner = (await B.ok("GET", "/v1/ot/me")).owner_id;
  const target = {owner_id:owner, agent_id:"shared"};
  const posted = await A.ok("POST", root + "/messages", {body:"Please check", agent_mentions:[target]});
  assert.equal(posted.body, "@Helper Please check");
  const forB = await B.ok("GET","/v1/ot/agent-inbox");
  assert.deepEqual(forB.items.map((entry: any) => [entry.message.id, entry.agent_ref, entry.mode]),
    [[posted.id, "shared", "mention"]]);
  assert.deepEqual((await C.ok("GET", "/v1/ot/agent-inbox")).items, []);
  const removed = await A.call("POST", root + "/messages", {
    body:"Still there?", agent_mentions:[{owner_id:owner, agent_id:"missing"}],
  });
  assert.equal(removed.status,400);
  assert.equal((await A.ok("GET", root + "/messages")).messages.length, 1);

  await B.ok("PUT", root + "/agents/second", {name:"第二位助手"});
  const both = await A.ok("POST", root + "/messages", {
    body:"各给一个答案", agent_mentions:[target, {owner_id:owner,agent_id:"second"}],
  });
  assert.equal(both.body,"@Helper @第二位助手 各给一个答案");
  const page = await B.ok("GET", `/v1/ot/agent-inbox?after=${forB.cursor}&limit=1`);
  assert.deepEqual(page.items.map((entry: any) => entry.agent_ref).sort(), ["second","shared"]);
  assert.deepEqual((await B.ok("GET", `/v1/ot/agent-inbox?after=${page.cursor}`)).items, []);
});
