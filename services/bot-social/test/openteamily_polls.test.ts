// Chat polls live with the conversation they belong to (Bot Social), because a poll's
// value is other members voting: a per-user DS-Bot volume can only ever hold the
// owner's own vote. These tests drive the /v1/ot/polls contract from two members of
// one group plus a stranger, so the member gate and per-viewer vote isolation are
// exercised alongside the poll rules ported from the removed feature.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { bulkAuth, startServer } from "./helpers.js";
import { home } from "./openteamily_helpers.js";

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(bulkAuth); });
after(async () => { await S.stop(); });

async function group(names: string[]) {
  const [owner, ...peers] = await Promise.all(names.map((name) => home(S.base, name)));
  for (const peer of peers) {
    const request = await owner.ok("POST", "/v1/ot/contacts", { handle: peer.handle });
    await peer.ok("POST", "/v1/ot/contacts/" + request.id, { action: "accept" });
  }
  const conv = await owner.ok("POST", "/v1/ot/conversations", {
    kind: "group", account_group: true, title: "Polls room", members: peers.map((peer) => peer.handle),
  });
  return { owner, peers, conv, stranger: undefined as any };
}

const created = async (owner: any, conv: any, payload: Record<string, unknown> = {}) =>
  (await owner.ok("POST", "/v1/ot/polls", {
    conversation_id: conv.id, question: "Lunch?", options: ["Yes", "No"], ...payload,
  })).poll;

test("a poll is created, read back by every member and paged oldest first", async () => {
  const { owner, peers, conv } = await group(["poll-page-owner", "poll-page-peer"]);
  const peer = peers[0];
  const first = await created(owner, conv, { question: "First" });
  const second = await created(owner, conv, { question: "Second" });
  const third = await created(peer, conv, { question: "Third" });
  assert.equal(first.status, "open");
  assert.equal(first.total, 0);
  assert.equal(first.voter_count, 0);
  assert.deepEqual(first.votes, []);
  assert.deepEqual(first.viewer_votes, []);
  assert.equal(first.created_by, first.owner_id);
  assert.deepEqual(first.options.map((row: any) => row.text), ["Yes", "No"]);
  assert.equal((await peer.ok("GET", "/v1/ot/polls/" + first.id)).poll.question, "First");

  const page = await owner.ok("GET", `/v1/ot/polls?conversation_id=${conv.id}&limit=2`);
  assert.deepEqual(page.items.map((row: any) => row.id), [first.id, second.id]);
  assert.equal(page.next_cursor, second.id);
  const rest = await owner.ok("GET", `/v1/ot/polls?conversation_id=${conv.id}&limit=2&cursor=${page.next_cursor}`);
  assert.deepEqual(rest.items.map((row: any) => row.id), [third.id]);
  assert.equal(rest.next_cursor, null);
  const all = await owner.ok("GET", `/v1/ot/polls?conversation_id=${conv.id}&limit=10`);
  assert.deepEqual(all.items.map((row: any) => row.id), [first.id, second.id, third.id]);

  assert.equal((await owner.call("GET", `/v1/ot/polls?conversation_id=${conv.id}&cursor=otp_missing`)).status, 404);
  assert.equal((await owner.call("GET", "/v1/ot/polls")).status, 400);
  assert.equal((await owner.call("GET", `/v1/ot/polls?conversation_id=${conv.id}&limit=0`)).status, 400);
  assert.equal((await owner.call("GET", `/v1/ot/polls?conversation_id=${conv.id}&limit=101`)).status, 400);
});

test("a single-choice vote replaces and repeating it is idempotent", async () => {
  const { owner, conv } = await group(["poll-single-owner", "poll-single-peer"]);
  const poll = await created(owner, conv);
  const [yes, no] = poll.options.map((row: any) => row.id);
  const voted = (await owner.ok("POST", `/v1/ot/polls/${poll.id}/vote`, { option_ids: [yes] })).poll;
  assert.deepEqual(voted.votes, [yes]);
  assert.deepEqual(voted.viewer_votes, [yes]);
  assert.equal(voted.total, 1);
  assert.equal(voted.voter_count, 1);

  const repeated = (await owner.ok("POST", `/v1/ot/polls/${poll.id}/vote`, { option_ids: [yes] })).poll;
  assert.equal(repeated.total, 1);
  const changed = (await owner.ok("POST", `/v1/ot/polls/${poll.id}/vote`, { option_ids: [no] })).poll;
  assert.deepEqual(changed.votes, [no]);
  assert.equal(changed.total, 1);
  assert.deepEqual(changed.options.map((row: any) => row.count), [0, 1]);

  assert.equal((await owner.call("POST", `/v1/ot/polls/${poll.id}/vote`, { option_ids: [yes, no] })).status, 400);
});

test("a multi-choice vote accumulates, dedupes and keeps each viewer's own votes", async () => {
  const { owner, peers, conv } = await group(["poll-multi-owner", "poll-multi-peer"]);
  const peer = peers[0];
  const poll = await created(owner, conv, { multi_select: true });
  const [yes, no] = poll.options.map((row: any) => row.id);
  const one = (await owner.ok("POST", `/v1/ot/polls/${poll.id}/vote`, { option_ids: [yes] })).poll;
  assert.equal(one.total, 1);
  const both = (await owner.ok("POST", `/v1/ot/polls/${poll.id}/vote`, { option_ids: [no] })).poll;
  assert.deepEqual(both.votes, [yes, no]);
  assert.equal(both.total, 2);
  assert.deepEqual(both.options.map((row: any) => row.count), [1, 1]);

  const peerView = (await peer.ok("POST", `/v1/ot/polls/${poll.id}/vote`, { option_ids: [yes, no] })).poll;
  assert.equal(peerView.total, 4);
  assert.equal(peerView.voter_count, 2);
  assert.deepEqual(peerView.votes, [yes, no], "the peer sees its own two votes");
  const ownerView = (await owner.ok("GET", "/v1/ot/polls/" + poll.id)).poll;
  assert.deepEqual(ownerView.votes, [yes, no]);
  assert.deepEqual(ownerView.viewer_votes, [yes, no]);
  assert.equal(ownerView.total, 4);
  assert.deepEqual(
    ownerView.options.map((row: any) => row.voters.length),
    [2, 2],
    "a non-anonymous poll names the voters",
  );

  const repeated = (await owner.ok("POST", `/v1/ot/polls/${poll.id}/vote`, { option_ids: [yes, no] })).poll;
  assert.equal(repeated.total, 4, "a repeated selection is not counted twice");
});

test("an anonymous poll hides voter identities but keeps counts and the viewer's vote", async () => {
  const { owner, peers, conv } = await group(["poll-anon-owner", "poll-anon-peer"]);
  const poll = await created(owner, conv, { anonymous: true });
  const option = poll.options[0].id;
  await owner.ok("POST", `/v1/ot/polls/${poll.id}/vote`, { option_ids: [option] });
  const viewed = (await peers[0].ok("POST", `/v1/ot/polls/${poll.id}/vote`, { option_ids: [option] })).poll;
  assert.deepEqual(viewed.options[0].voters, []);
  assert.equal(viewed.options[0].count, 2);
  assert.equal(viewed.total, 2);
  assert.equal(viewed.voter_count, 2);
  assert.deepEqual(viewed.votes, [option], "the viewer still sees its own vote");
  assert.doesNotMatch(JSON.stringify(viewed), /"voters":\["/, "no voter id leaks in an anonymous view");

  const publicPoll = await created(owner, conv, { question: "Public" });
  await peers[0].ok("POST", `/v1/ot/polls/${publicPoll.id}/vote`, { option_ids: [publicPoll.options[0].id] });
  const named = (await owner.ok("GET", "/v1/ot/polls/" + publicPoll.id)).poll;
  const peerId = (await peers[0].ok("GET", "/v1/ot/me")).owner_id;
  assert.deepEqual(named.options[0].voters, [peerId], "a non-anonymous poll names the voting member");
});

test("a non-member is refused everywhere and learns nothing about the poll", async () => {
  const { owner, peers, conv } = await group(["poll-gate-owner", "poll-gate-peer"]);
  const poll = await created(owner, conv);
  const stranger = await home(S.base, "poll-gate-stranger");
  assert.equal((await stranger.call("GET", "/v1/ot/polls/" + poll.id)).status, 404);
  assert.equal((await stranger.call("GET", `/v1/ot/polls?conversation_id=${conv.id}`)).status, 404);
  assert.equal((await stranger.call("POST", `/v1/ot/polls/${poll.id}/vote`, { option_ids: [poll.options[0].id] })).status, 404);
  assert.equal((await stranger.call("POST", `/v1/ot/polls/${poll.id}/close`)).status, 404);
  assert.equal((await stranger.call("DELETE", `/v1/ot/polls/${poll.id}`)).status, 404);
  assert.equal((await stranger.call("POST", "/v1/ot/polls", { conversation_id: conv.id, question: "Q", options: ["A", "B"] })).status, 404);
  const listed = await stranger.call("GET", `/v1/ot/polls?conversation_id=${conv.id}`);
  assert.equal(listed.status, 404, "a stranger cannot list the conversation's polls");
  const unchanged = (await peers[0].ok("GET", "/v1/ot/polls/" + poll.id)).poll;
  assert.equal(unchanged.total, 0);
});



test("a closed or expired poll refuses votes and only the creator closes it", async () => {
  const { owner, peers, conv } = await group(["poll-close-owner", "poll-close-peer"]);
  const peer = peers[0];
  const closing = await created(owner, conv, { closes: Date.now() - 1 });
  assert.equal((await owner.call("POST", `/v1/ot/polls/${closing.id}/vote`, { option_ids: [closing.options[0].id] })).status, 409);

  const poll = await created(owner, conv);
  assert.equal((await peer.call("POST", `/v1/ot/polls/${poll.id}/close`)).status, 403);
  const closed = (await owner.ok("POST", `/v1/ot/polls/${poll.id}/close`)).poll;
  assert.equal(closed.status, "closed");
  assert.equal((await peer.call("POST", `/v1/ot/polls/${poll.id}/vote`, { option_ids: [poll.options[0].id] })).status, 409);
  assert.equal((await owner.ok("POST", `/v1/ot/polls/${poll.id}/close`)).poll.status, "closed", "closing twice is idempotent");
});

test("only the creator deletes, and deleting cascades to options and votes", async () => {
  const { owner, peers, conv } = await group(["poll-delete-owner", "poll-delete-peer"]);
  const peer = peers[0];
  const poll = await created(owner, conv);
  await peer.ok("POST", `/v1/ot/polls/${poll.id}/vote`, { option_ids: [poll.options[0].id] });
  assert.equal((await peer.call("DELETE", `/v1/ot/polls/${poll.id}`)).status, 403);
  assert.deepEqual(await owner.ok("DELETE", `/v1/ot/polls/${poll.id}`), { deleted: true });
  assert.equal((await owner.call("GET", "/v1/ot/polls/" + poll.id)).status, 404);
  assert.equal((await owner.call("DELETE", "/v1/ot/polls/" + poll.id)).status, 404);
  const db = S.platform.db;
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM ot_poll_options WHERE poll_id=?").get(poll.id) as any).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM ot_poll_votes WHERE poll_id=?").get(poll.id) as any).n, 0);
});

test("bad option sets, foreign option ids and bad questions are refused without storing a poll", async () => {
  const { owner, conv } = await group(["poll-invalid-owner", "poll-invalid-peer"]);
  const bad = async (payload: Record<string, unknown>) => {
    const row = await owner.call("POST", "/v1/ot/polls", { conversation_id: conv.id, question: "Q", options: ["Yes", "No"], ...payload });
    assert.equal(row.status, 400, JSON.stringify(row.data));
  };
  await bad({ question: "x".repeat(501) });
  await bad({ options: ["x".repeat(201), "No"] });
  await bad({ options: ["Only one"] });
  await bad({ options: ["Yes", "no", "YES"] });
  await bad({ options: ["Yes", "   "] });
  await bad({ options: Array.from({ length: 21 }, (_, i) => `Option ${i}`) });
  await bad({ conversation_id: 5 });
  const unknown = await owner.call("POST", "/v1/ot/polls", { conversation_id: "nope", question: "Q", options: ["Yes", "No"] });
  assert.equal(unknown.status, 404, "an unknown conversation is not found, not invalid");
  assert.deepEqual((await owner.ok("GET", `/v1/ot/polls?conversation_id=${conv.id}`)).items, []);
});

async function teamRoom(name: string) {
  const owner = await home(S.base, name + "-owner");
  const peer = await home(S.base, name + "-peer");
  const t = await owner.ok("POST", "/v1/ot/teams", { name });
  const { code } = await owner.ok("POST", `/v1/ot/teams/${t.id}/invites`, {});
  await peer.ok("POST", "/v1/ot/invites/accept", { code });
  const room = await owner.ok("POST", "/v1/ot/conversations", {
    kind: "group", title: name, team_id: t.id, members: [peer.handle],
  });
  return { owner, peer, team: t, room };
}

test("a suspended teammate loses the team room's polls on every verb", async () => {
  const { owner, peer, team, room } = await teamRoom("poll-team-suspended");
  const visible = await created(owner, room, { question: "Owner's poll" });
  await peer.ok("POST", `/v1/ot/polls/${visible.id}/vote`, { option_ids: [visible.options[0].id] });
  const own = await created(peer, room, { question: "Peer's poll" });
  await owner.ok("PATCH", `/v1/ot/teams/${team.id}/members/${peer.handle}`, { suspended: true });

  assert.deepEqual({
    list: (await peer.call("GET", `/v1/ot/polls?conversation_id=${room.id}`)).status,
    read: (await peer.call("GET", "/v1/ot/polls/" + visible.id)).status,
    vote: (await peer.call("POST", `/v1/ot/polls/${visible.id}/vote`, { option_ids: [visible.options[1].id] })).status,
    close: (await peer.call("POST", `/v1/ot/polls/${own.id}/close`)).status,
    delete: (await peer.call("DELETE", `/v1/ot/polls/${own.id}`)).status,
  }, { list: 404, read: 404, vote: 404, close: 404, delete: 404 },
  "a suspended teammate loses every poll verb, including the read that names voters");
  assert.equal((await owner.ok("GET", "/v1/ot/polls/" + visible.id)).poll.total, 1, "the owner's view is untouched");

  await owner.ok("PATCH", `/v1/ot/teams/${team.id}/members/${peer.handle}`, { suspended: false });
  assert.equal((await peer.ok("GET", "/v1/ot/polls/" + own.id)).poll.id, own.id, "readmission restores the gate");
});

test("a teammate removed from the team loses the room's polls", async () => {
  const { owner, peer, team, room } = await teamRoom("poll-team-removed");
  const own = await created(peer, room, { question: "Peer's poll" });
  await owner.ok("DELETE", `/v1/ot/teams/${team.id}/members/${peer.handle}`);

  assert.deepEqual({
    list: (await peer.call("GET", `/v1/ot/polls?conversation_id=${room.id}`)).status,
    read: (await peer.call("GET", "/v1/ot/polls/" + own.id)).status,
    vote: (await peer.call("POST", `/v1/ot/polls/${own.id}/vote`, { option_ids: [own.options[0].id] })).status,
    delete: (await peer.call("DELETE", `/v1/ot/polls/${own.id}`)).status,
  }, { list: 404, read: 404, vote: 404, delete: 404 },
  "a teammate removed from the team loses the room's polls");
});

test("an archived group hides its polls from every member", async () => {
  const { owner, peers, conv } = await group(["poll-archived-owner", "poll-archived-peer"]);
  const peer = peers[0];
  const poll = await created(peer, conv);
  const management = `/v1/ot/conversations/${conv.id}/management`;
  const live = await owner.ok("GET", "/v1/ot/conversations/" + conv.id);
  const peerId = (await peer.ok("GET", "/v1/ot/me")).owner_id;
  await owner.ok("POST", management, { direct: true, action: "transfer", revision: live.group_management.revision, member_id: peerId });
  const handed = await owner.ok("GET", "/v1/ot/conversations/" + conv.id);
  await owner.ok("POST", management, { direct: true, action: "leave", revision: handed.group_management.revision });
  const solo = await peer.ok("GET", "/v1/ot/conversations/" + conv.id);
  await peer.ok("POST", management, { direct: true, action: "leave", revision: solo.group_management.revision });

  assert.deepEqual({
    former_owner_read: (await owner.call("GET", "/v1/ot/polls/" + poll.id)).status,
    last_owner_read: (await peer.call("GET", "/v1/ot/polls/" + poll.id)).status,
    former_owner_list: (await owner.call("GET", `/v1/ot/polls?conversation_id=${conv.id}`)).status,
  }, { former_owner_read: 404, last_owner_read: 404, former_owner_list: 404 },
  "an archived group hides its polls from every member");
});
