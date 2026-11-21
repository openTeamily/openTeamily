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

test("groups add multiple teammates atomically and notify each new member once", async () => {
  const owner = await home(S.base, "batch-owner");
  const first = await home(S.base, "batch-first");
  const second = await home(S.base, "batch-second");
  const outsider = await home(S.base, "batch-outside");
  const team = await teamOf(owner, first, second);
  const group = await owner.ok("POST", "/v1/ot/conversations", { kind: "group", title: "Review", team_id: team.id });
  const path = `/v1/ot/conversations/${group.id}`;
  const denied = await owner.call("POST", path + "/members", { handles: [first.handle, outsider.handle] });
  assert.equal(denied.status, 403);
  assert.equal((await first.call("GET", path)).status, 404);
  assert.equal((await first.ok("GET", "/v1/ot/notifications")).notifications
    .filter((notice: any) => notice.data.conversation_id === group.id).length, 0);
  const added = await owner.ok("POST", path + "/members", { handles: [first.handle, second.handle] });
  assert.equal(added.members.length, 3);
  await owner.ok("POST", path + "/members", { handles: [first.handle, second.handle, first.handle] });
  for (const person of [first, second]) {
    assert.equal((await person.ok("GET", path)).id, group.id);
    const notes = await person.ok("GET", "/v1/ot/notifications");
    assert.equal(notes.notifications.filter((notice: any) =>
      notice.kind === "messenger.added" && notice.data.conversation_id === group.id).length, 1);
  }
});

test("live calls notify members and relay signals only to their target peer", async () => {
  const owner = await home(S.base, "call-owner");
  const member = await home(S.base, "call-member");
  const outsider = await home(S.base, "call-outside");
  const team = await teamOf(owner, member, outsider);
  const group = await owner.ok("POST", "/v1/ot/conversations", {kind: "group", title: "Standup", team_id: team.id, members: [member.handle]});
  const root = `/v1/ot/conversations/${group.id}/call`;
  const first = "tab-owner-123456789";
  const second = "tab-member-12345678";
  assert.equal((await outsider.call("GET", root)).status, 404);
  assert.deepEqual(await member.ok("GET", root), {call: null});
  const started = await owner.ok("POST", root + "/join", {kind: "video", start: true, peer_id: first});
  const callId = started.call.id;
  assert.equal(started.call.kind, "video");
  assert.equal((await owner.ok("POST", root + "/join", {kind: "video", start: true, peer_id: first})).call.id, callId);
  assert.equal((await owner.call("POST", root + "/join", {kind: "video", start: true, peer_id: "tab-duplicate-12345678"})).status, 409);
  const notes = await member.ok("GET", "/v1/ot/notifications");
  assert.equal(notes.notifications.filter((note: any) => note.kind === "messenger.call" && note.data.conversation_id === group.id).length, 1);
  const joined = await member.ok("POST", root + "/join", {kind: "video", peer_id: second});
  assert.equal(joined.call.id, callId);
  assert.equal(joined.call.peers.length, 2);
  const signal = {call_id: callId, peer_id: first, to: second, client_key: "signal-once-123456",
    description: {type: "offer", sdp: "v=0\r\n"}};
  await owner.ok("POST", root + "/signal", signal);
  await owner.ok("POST", root + "/signal", signal);
  assert.equal((await outsider.call("POST", root + "/poll", {call_id: callId, peer_id: second})).status, 404);
  assert.equal((await member.call("POST", root + "/poll", {call_id: callId, peer_id: first})).status, 404);
  assert.deepEqual((await owner.ok("POST", root + "/poll", {call_id: callId, peer_id: first})).signals, []);
  const received = await member.ok("POST", root + "/poll", {call_id: callId, peer_id: second});
  assert.equal(received.signals.length, 1);
  assert.deepEqual(received.signals[0].description, signal.description);
  await owner.ok("POST", root + "/leave", {call_id: callId, peer_id: first});
  assert.equal((await member.ok("GET", root)).call.peers.length, 1);
  await member.ok("POST", root + "/leave", {call_id: callId, peer_id: second});
  assert.deepEqual(await member.ok("GET", root), {call: null});
});

test("group memory sources page past the activation cursor with current membership and revisions", async () => {
  const owner = await home(S.base,"sources-owner");
  const member = await home(S.base,"sources-member");
  const other = await home(S.base,"sources-outsider");
  const team = await teamOf(owner,member,other);
  const workspaceId = (await owner.ok("GET","/v1/ot/workspaces")).workspaces.find((row: any)=>row.id===team.id).workspace_id;
  const group = await owner.ok("POST","/v1/ot/conversations",{
    kind:"group",title:"Memory source group",team_id:team.id,members:[member.handle],
  });
  const room = `/v1/ot/conversations/${group.id}`;
  const sources = room + "/memory-sources";
  const old = await owner.ok("POST",room + "/messages",{body:"Before enabling"});
  const read = (args: object) => member.ok("POST",sources,{workspace_id:workspaceId,...args});
  const start = await read({message_ids:[]});
  assert.equal(start.cursor,old.seq);
  assert.deepEqual(start.items,[]);
  assert.equal((await other.call("POST",sources,{workspace_id:workspaceId,after:0})).status,404);
  assert.equal((await member.call("POST",sources,{after:0})).status,404);
  const incoming = [];
  for (let i=0;i<14;i++) incoming.push(await owner.ok("POST",room + "/messages",{body:`Plan ${i}`}));
  await owner.ok("DELETE",`/v1/ot/messages/${incoming[2].id}`);
  await owner.ok("PATCH",`/v1/ot/messages/${incoming[4].id}`,{body:"Updated plan"});
  const first = await read({after:start.cursor});
  assert.equal(first.membership,start.membership);
  assert.deepEqual(first.items.map((item: any)=>item.id),incoming.slice(0,13).filter((_,i)=>i!==2).map(message=>message.id));
  assert.deepEqual(first.items[3],{
    id:incoming[4].id,revision:2,title:"Memory source group",author:first.items[0].author,text:"Updated plan",
  });
  const last = await read({after:first.cursor});
  assert.deepEqual(last.items.map((item: any)=>item.id),[incoming.at(-1).id]);
  assert.equal(last.cursor,incoming.at(-1).seq);
  assert.deepEqual((await read({message_ids:[incoming[2].id,old.id]})).items.map((item: any)=>item.id),[old.id]);
  await owner.ok("DELETE",room + "/members/" + member.handle);
  assert.equal((await member.call("POST",sources,{workspace_id:workspaceId,after:last.cursor})).status,404);
});

test("shared group memory is scoped, cited by group agents and retired when a source changes", async () => {
  const owner = await home(S.base, "memory-owner");
  const member = await home(S.base, "memory-member");
  const other = await home(S.base, "memory-outsider");
  const team = await teamOf(owner, member, other);
  const group = await owner.ok("POST", "/v1/ot/conversations", {
    kind: "group", title: "Launch planning", team_id: team.id, members: [member.handle],
  });
  const elsewhere = await owner.ok("POST", "/v1/ot/conversations", {
    kind: "group", title: "Different group", team_id: team.id, members: [member.handle],
  });
  const room = `/v1/ot/conversations/${group.id}`;
  const memory = room + "/memories";
  const author = await owner.ok("POST", room + "/messages", {body:"Launch discussion"});
  const decision = await member.ok("POST", room + "/messages", {body:"Launch on Friday"});
  const unrelated = await owner.ok("POST", `/v1/ot/conversations/${elsewhere.id}/messages`, {body:"Unrelated"});
  const draft = {
    title:"Launch date", body:"The rollout is scheduled for Friday.",
    client_key:"launch-note-revision-one", source_message_id:decision.id,
    sources:[{id:author.id,revision:author.revision}, {id:decision.id,revision:decision.revision}],
  };
  assert.equal((await other.call("POST", memory, draft)).status,404);
  assert.equal((await other.call("GET", memory)).status,404);
  assert.equal((await owner.call("POST", memory, {
    ...draft,sources:[...draft.sources, {id:unrelated.id,revision:unrelated.revision}],
  })).status,409);
  const {item} = await owner.ok("POST", memory, draft);
  assert.equal((await owner.ok("POST", memory, draft)).item.id,item.id);
  assert.equal((await member.ok("GET",memory)).items[0].body,draft.body);
  assert.equal((await member.call("DELETE", `${memory}/${item.id}`)).status,404);
  assert.deepEqual((await owner.ok("GET", `/v1/ot/conversations/${elsewhere.id}/memories`)).items,[]);

  await member.ok("PUT", room + "/agents/launch-helper", {name:"Launch Helper",auto_reply:false});
  await owner.ok("POST",room + "/messages",{body:"@launch-helper launch date?"});
  const inbox = await member.ok("GET","/v1/ot/agent-inbox");
  assert.deepEqual(inbox.items[0].group_memories,[{id:item.id,title:draft.title,body:draft.body}]);
  const reply = {agent_ref:"launch-helper", body:"Friday", reply_to:inbox.items[0].message.id, mode:"mention"};
  const sent = await member.ok("POST",room + "/agent-messages",{...reply,group_memory_ids:[item.id]});
  assert.deepEqual(sent.group_memory_refs,[{id:item.id,title:draft.title}]);

  await owner.ok("PATCH",`/v1/ot/messages/${author.id}`,{body:"Changed secondary source"});
  assert.deepEqual((await member.ok("GET", memory)).items,[]);
  assert.equal((await owner.call("POST",memory,draft)).status,409);
  const next = await owner.ok("POST",room + "/messages",{body:"@launch-helper new launch date?"});
  assert.equal((await member.call("POST",room + "/agent-messages",{
    ...reply,reply_to:next.id,group_memory_ids:[item.id],
  })).status,409);
  const after = await owner.ok("GET",room + "/messages");
  assert.deepEqual(after.messages.find((m: any) => m.id === sent.id).group_memory_refs,[]);
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

test("voice messages are idempotent and only current conversation members can play them", async () => {
  const A = await home(S.base,"voice-a");
  const B = await home(S.base,"voice-b");
  const C = await home(S.base,"voice-c");
  await teamOf(A,B,C);
  const group = await A.ok("POST","/v1/ot/conversations",{kind:"group",title:"Voice",members:[B.handle]});
  const root = `/v1/ot/conversations/${group.id}/messages`;
  const voice = {mime:"audio/webm",data:Buffer.from([0x1a,0x45,0xdf,0xa3,...Array(8).fill(0)]).toString("base64")};
  assert.equal((await A.call("POST",root,{voice:{...voice,mime:"text/html"}})).status,400);
  const request = {voice,client_key:"voice-retry"};
  const sent = await A.ok("POST",root,request);
  assert.equal(sent.body,"语音消息");
  assert.deepEqual(sent.voice,{mime:voice.mime});
  assert.equal((await A.ok("POST",root,request)).id,sent.id);
  assert.equal((await B.ok("GET",root)).messages.length,1);
  const audioPath = root + "/" + sent.id + "/voice";
  assert.deepEqual(await B.ok("GET",audioPath),voice);
  assert.equal((await C.call("GET",audioPath)).status,404);
  await A.ok("DELETE",`/v1/ot/messages/${sent.id}`);
  assert.equal((await B.call("GET",audioPath)).status,404);
  assert.equal((await B.ok("GET",root)).messages[0].voice,undefined);
});

test("members can page, search and anchor shared history inside their conversation", async () => {
  const A = await home(S.base,"history-a");
  const B = await home(S.base,"history-b");
  const C = await home(S.base,"history-c");
  await teamOf(A,B,C);
  const group = await A.ok("POST","/v1/ot/conversations",{kind:"group",title:"History",members:[B.handle]});
  const path=`/v1/ot/conversations/${group.id}/messages`;
  const messages=[];
  for(let seq=1;seq<=6;seq++) messages.push(await A.ok("POST",path,{body:seq%2 ? "Planning " + seq : "Other " + seq}));
  const latest=await B.ok("GET",path+"?limit=2");
  assert.deepEqual(latest.messages.map((message:any)=>message.seq),[5,6]);
  assert.equal(latest.next_before,5);
  assert.equal(latest.has_newer,false);
  const older=await B.ok("GET",path+"?limit=2&before="+latest.next_before);
  assert.deepEqual(older.messages.map((message:any)=>message.seq),[3,4]);
  assert.equal(older.has_newer,true);
  const anchored=await B.ok("GET",path+"?limit=3&around="+messages[1].id);
  assert.deepEqual(anchored.messages.map((message:any)=>message.seq),[1,2,3]);
  assert.equal(anchored.next_before,null);
  await A.ok("DELETE",`/v1/ot/messages/${messages[2].id}`);
  const hits=await B.ok("GET",path+"?q=planning&limit=1");
  assert.deepEqual(hits.messages.map((message:any)=>message.seq),[5]);
  const next=await B.ok("GET",path+"?q=planning&limit=1&before="+hits.next_before);
  assert.deepEqual(next.messages.map((message:any)=>message.seq),[1]);
  assert.equal(next.next_before,null);
  assert.equal((await C.call("GET",path+"?around="+messages[1].id)).status,404);
  assert.equal((await C.call("GET",path+"?q=planning")).status,404);
});

test("workspace message search and scoped history require access to the workspace and conversation", async () => {
  const A = await home(S.base, "search-a");
  const B = await home(S.base, "search-b");
  const C = await home(S.base, "search-c");
  const primary = await A.ok("POST", "/v1/ot/workspaces", {name: "Search", idempotency_key: "workspace-search-primary"});
  const other = await A.ok("POST", "/v1/ot/workspaces", {name: "Other", idempotency_key: "workspace-search-secondary"});
  for (const [team, person] of [[primary, B], [other, C]] as const) {
    const {code} = await A.ok("POST", `/v1/ot/teams/${team.id}/invites`, {});
    await person.ok("POST", "/v1/ot/invites/accept", {code});
  }
  const group = async (owner: typeof A, team_id: string, title: string, members: string[]) =>
    owner.ok("POST", "/v1/ot/conversations", {kind: "group", title, team_id, members});
  const send = (owner: typeof A, id: string, body: string) =>
    owner.ok("POST", `/v1/ot/conversations/${id}/messages`, {body});
  const current = await group(A, primary.id, "Current", [B.handle]);
  const outside = await group(A, other.id, "Outside", [C.handle]);
  const hidden = await group(B, primary.id, "Hidden", []);
  const dm = await A.ok("POST", "/v1/ot/conversations", {kind: "dm", peer: B.handle});
  const outsideDm = await A.ok("POST", "/v1/ot/conversations", {kind: "dm", peer: C.handle});
  const oldest = await send(A, current.id, "Schedule% for the meeting");
  await send(A, outside.id, "Schedule% other workspace");
  await send(B, hidden.id, "Schedule% in another group");
  await send(A, outsideDm.id, "Schedule% for an outside teammate");
  const direct = await send(B, dm.id, "Schedule% direct reply");
  const removed = await send(A, current.id, "Schedule% retracted");
  await A.ok("DELETE", `/v1/ot/messages/${removed.id}`);
  await send(A, current.id, "schedule but without a percentage sign");
  const newest = await send(A, current.id, "SCHEDULE% approved");

  const scopedHistory = (conversation: string, workspace: string) =>
    `/v1/ot/conversations/${conversation}/messages?workspace_id=${workspace}&limit=1`;
  const currentPage = await A.ok("GET", scopedHistory(current.id, primary.workspace_id));
  assert.equal(currentPage.messages[0].id, newest.id);
  assert.equal((await A.call("GET", scopedHistory(outside.id, primary.workspace_id))).status, 404);
  assert.equal((await C.call("GET", scopedHistory(current.id, primary.workspace_id))).status, 404);
  assert.equal((await A.ok("GET", scopedHistory(dm.id, primary.workspace_id))).messages[0].id, direct.id);
  assert.equal((await A.call("GET", scopedHistory(outsideDm.id, primary.workspace_id))).status, 404);

  const search = `/v1/ot/workspaces/${primary.workspace_id}/messages/search?q=schedule%25&limit=2`;
  const first = await A.ok("GET", search);
  assert.deepEqual(first.items.map((row: any) => row.message_id), [newest.id, direct.id]);
  assert.equal(first.items[0].title, "Current");
  assert.equal(first.items[1].conversation_id, dm.id);
  assert.equal(first.more, true);
  const next = await A.ok("GET", search + "&before=" + first.items[1].cursor);
  assert.deepEqual(next.items.map((row: any) => row.message_id), [oldest.id]);
  assert.equal(next.more, false);
  assert.deepEqual((await A.ok("GET", search + "&conversation_id=" + outside.id)).items, []);
  assert.equal((await A.call("GET", search + "&before=invalid")).status, 400);
  assert.equal((await C.call("GET", search)).status, 404);
  const messagePath = (conversation: string, message: string, workspace = primary.workspace_id) =>
    `/v1/ot/workspaces/${workspace}/conversations/${conversation}/messages/${message}`;
  const history = messagePath(current.id, oldest.id);
  assert.deepEqual(await B.ok("GET", history), {body: oldest.body, revision: 1, title: "Current"});
  assert.equal((await A.call("GET", messagePath(current.id, oldest.id, other.workspace_id))).status, 404);
  assert.equal((await A.call("GET", messagePath(current.id, direct.id))).status, 404);
  assert.equal((await A.call("GET", messagePath(current.id, removed.id))).status, 409);
  assert.equal((await A.call("GET", messagePath(dm.id, direct.id, other.workspace_id))).status, 404);
  assert.equal((await A.ok("GET", messagePath(dm.id, direct.id))).body, direct.body);
  await A.ok("PATCH", `/v1/ot/messages/${oldest.id}`, {body: "A saved message has been edited"});
  assert.equal((await B.ok("GET", history)).revision, 2);
  await A.ok("DELETE", `/v1/ot/conversations/${current.id}/members/${B.handle}`);
  assert.deepEqual((await B.ok("GET", search + "&conversation_id=" + current.id)).items, []);
  assert.equal((await B.call("GET", history)).status, 404);
  await A.ok("PATCH", `/v1/ot/teams/${primary.id}/members/${B.handle}`, {suspended: true});
  assert.equal((await B.call("GET", search)).status, 404);
  assert.deepEqual((await A.ok("GET", search + "&conversation_id=" + dm.id)).items, []);
});

test("standalone video meetings grant access to the call only, and only its host can end it", async () => {
  const host = await home(S.base, "meeting-host");
  const guest = await home(S.base, "meeting-guest");
  const outsider = await home(S.base, "meeting-outsider");
  await teamOf(host);
  await teamOf(guest);
  const path = "/v1/ot/meeting-calls";
  const input = {title: "Design review", peer_id: "meeting-host-browser"};
  assert.equal((await host.call("POST", path + "/create", {title: input.title})).status, 400);
  const created = await host.ok("POST", path + "/create", input);
  assert.equal(created.meeting.host, true);
  assert.match(created.meeting.code, /^[\w-]{24}$/);
  assert.deepEqual((await host.ok("POST", path + "/create", input)).meeting, created.meeting);
  assert.equal((await guest.call("POST", path + "/preview", {code: "a".repeat(24)})).status, 404);
  assert.deepEqual(await guest.ok("POST", path + "/preview", {code: created.meeting.code}), {title: input.title});
  const joined = await guest.ok("POST", path + "/join", {code: created.meeting.code, peer_id: "meeting-guest-browser"});
  assert.deepEqual(joined.meeting, {title: input.title, host: false});
  assert.equal(joined.call.id, created.call.id);
  assert.deepEqual((await guest.ok("GET", "/v1/ot/conversations")).conversations, []);
  assert.deepEqual((await host.ok("GET", "/v1/ot/conversations")).conversations, []);
  const guestPeer = {call_id: joined.call.id, peer_id: joined.peer_id};
  assert.equal((await guest.ok("POST", path + "/poll", guestPeer)).call.peers.length, 2);
  assert.equal((await outsider.call("POST", path + "/poll", guestPeer)).status, 404);
  assert.equal((await guest.call("POST", path + "/end", guestPeer)).status, 403);
  await host.ok("POST", path + "/end", {call_id: created.call.id, peer_id: created.peer_id});
  assert.equal((await guest.call("POST", path + "/poll", guestPeer)).status, 404);
  assert.equal((await guest.call("POST", path + "/preview", {code: created.meeting.code})).status, 404);
});

test("chat files are idempotent and readable only by active members of the correct conversation", async () => {
  const author = await home(S.base, "file-author");
  const reader = await home(S.base, "file-reader");
  const teammate = await home(S.base, "file-teammate");
  const team = await teamOf(author, reader, teammate);
  const {workspaces} = await author.ok("GET", "/v1/ot/workspaces");
  const workspace = workspaces.find((row: any) => row.id === team.id).workspace_id;
  const sentTo = await author.ok("POST", "/v1/ot/conversations", {
    kind: "group", title: "Shared files", team_id: team.id, members: [reader.handle],
  });
  const forwardedTo = await author.ok("POST", "/v1/ot/conversations", {
    kind: "group", title: "Forwarded files", team_id: team.id, members: [teammate.handle],
  });
  const filePath = (conversation: string, message: string) =>
    `/v1/ot/workspaces/${workspace}/conversations/${conversation}/messages/${message}/file`;
  const post = `/v1/ot/conversations/${sentTo.id}/messages`;
  const raw = Buffer.from("plain file contents", "utf8");
  const file = {title: "评审.txt", mime: "text/plain", data: raw.toString("base64")};
  const data = {workspace, client_key: "browser-retry", attachment: file};
  const created = await author.ok("POST", post, data);
  assert.deepEqual(created.attachment, {title: file.title, mime: file.mime, bytes: raw.length});
  assert.equal((await author.ok("POST", post, data)).id, created.id);
  assert.equal((await reader.ok("GET", post)).messages.length, 1);
  assert.deepEqual(await reader.ok("GET", filePath(sentTo.id, created.id)), file);
  assert.equal((await teammate.call("GET", filePath(sentTo.id, created.id))).status, 404);
  assert.equal((await reader.call("GET", filePath(forwardedTo.id, created.id))).status, 404);
  const fakeImage = await author.call("POST", post, {workspace, attachment:{...file, title:"bad.png", mime:"image/png"}});
  assert.equal(fakeImage.status, 400);
  const forwarded = await author.ok("POST", `/v1/ot/conversations/${forwardedTo.id}/messages`, {
    workspace, attachment_from: {conversation_id: sentTo.id, message_id: created.id},
  });
  assert.deepEqual(await teammate.ok("GET", filePath(forwardedTo.id, forwarded.id)), file);
  await author.ok("DELETE", `/v1/ot/conversations/${sentTo.id}/members/${reader.handle}`);
  assert.equal((await reader.call("GET", filePath(sentTo.id, created.id))).status, 404);
  await author.ok("DELETE", "/v1/ot/messages/" + created.id);
  assert.equal((await author.call("GET", filePath(sentTo.id, created.id))).status, 404);
  assert.deepEqual(await teammate.ok("GET", filePath(forwardedTo.id, forwarded.id)), file);
});

test("group translation sources require membership, exclude own media and check the exact revision", async () => {
  const reader = await home(S.base, "translation-reader");
  const author = await home(S.base, "translation-author");
  const outsider = await home(S.base, "translation-outsider");
  const team = await teamOf(reader, author, outsider);
  const {workspaces} = await reader.ok("GET", "/v1/ot/workspaces");
  const workspace = workspaces.find((row: any) => row.id === team.id).workspace_id;
  const conv = await reader.ok("POST", "/v1/ot/conversations", {
    kind: "group", title: "Translations", team_id: team.id, members: [author.handle],
  });
  const post = `/v1/ot/conversations/${conv.id}/messages`;
  const own = await reader.ok("POST", post, {body:"My text"});
  const first = await author.ok("POST", post, {body:"Visible text"});
  const file = await author.ok("POST", post, {
    workspace, attachment:{title:"data.txt",mime:"text/plain",data:Buffer.from("File contents").toString("base64")},
  });
  const source = `/v1/ot/workspaces/${workspace}/conversations/${conv.id}/translation-sources`;
  const refs = {items:[own,first,file].map(row => ({id:row.id,revision:row.revision}))};
  assert.deepEqual((await reader.ok("POST", source, refs)).sources, [{id:first.id,revision:first.revision,body:"Visible text"}]);
  assert.equal((await outsider.call("POST", source, refs)).status,404);
  const edited = await author.ok("PATCH", "/v1/ot/messages/"+first.id, {body:"Edited text"});
  assert.deepEqual((await reader.ok("POST", source, refs)).sources, []);
  assert.equal((await reader.ok("POST", source, {items:[{id:first.id,revision:edited.revision}]})).sources[0].body,"Edited text");
  await author.ok("DELETE", "/v1/ot/messages/"+first.id);
  assert.deepEqual((await reader.ok("POST", source, {items:[{id:first.id,revision:edited.revision}]})).sources, []);
});
