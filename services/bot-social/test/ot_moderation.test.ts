// Moderation on Bot Social (ported from PR #460's openteamily/moderation.py contract):
// directional user blocks, idempotent content reports, a workspace queue with terminal
// statuses, resolution notes and one moderation action row per resolution. Fixtures only.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { bulkAuth, startServer } from "./helpers.js";
import { home } from "./openteamily_helpers.js";

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(bulkAuth); });
after(async () => { await S.stop(); });

type Home = Awaited<ReturnType<typeof home>>;
const me = async (h: Home) => (await h.ok("GET", "/v1/ot/me")).owner_id as string;
const wsBase = (ws: any) => `/v1/ot/workspaces/${ws.workspace_id}/reports`;
async function workspace(owner: Home, name: string) {
  return owner.ok("POST", "/v1/ot/workspaces", { name, idempotency_key: `mod-${name}-${Math.random()}`.padEnd(16, "0") });
}

test("moderation: the three tables keep their exact columns and the schema re-applies", async () => {
  const { default: Database } = await import("better-sqlite3");
  const { MODERATION_SCHEMA } = await import("../src/openteamily/moderation.js");
  const db: any = new Database(":memory:");
  db.exec(MODERATION_SCHEMA);
  db.exec(MODERATION_SCHEMA);
  const cols = (table: string) => db.prepare(`PRAGMA table_info(${table})`).all().map((c: any) => c.name);
  assert.deepEqual(cols("user_blocks"), ["blocker_id", "blocked_id", "created"]);
  assert.deepEqual(cols("content_reports"), [
    "id", "workspace_id", "reporter_id", "target_type", "target_id", "reason",
    "details", "status", "reviewer_id", "resolution", "created", "updated",
  ]);
  assert.deepEqual(cols("moderation_actions"), ["id", "report_id", "actor_id", "action", "notes", "created"]);
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r: any) => r.name);
  for (const name of ["content_report_open", "content_report_queue", "moderation_action_report"]) {
    assert.ok(indexes.includes(name), `missing index ${name}`);
  }
  db.close();
});

test("blocks are idempotent, directional, list newest first and refuse a self-block", async () => {
  const A = await home(S.base, "modblka");
  const B = await home(S.base, "modblkb");
  const C = await home(S.base, "modblkc");
  const bId = await me(B);
  const cId = await me(C);

  const first = await A.ok("POST", "/v1/ot/blocks", { blocked: B.handle });
  const replay = await A.ok("POST", "/v1/ot/blocks", { blocked: B.handle });
  assert.equal(first.blocked_id, bId);
  assert.equal(first.blocker_id, await me(A));
  assert.equal(replay.created, first.created, "a replay keeps the first row");

  const self = await A.call("POST", "/v1/ot/blocks", { blocked: A.handle });
  assert.equal(self.status, 400, "a user cannot block themselves");

  assert.deepEqual((await B.ok("GET", "/v1/ot/blocks")).blocks, [], "the block is directional");

  const third = await A.ok("POST", "/v1/ot/blocks", { blocked: C.handle });
  assert.equal(third.blocked_id, cId);
  const listed = (await A.ok("GET", "/v1/ot/blocks")).blocks;
  assert.deepEqual(listed.map((row: any) => row.blocked_id), [cId, bId], "newest first, then by id");

  assert.deepEqual(await A.ok("DELETE", `/v1/ot/blocks/${B.handle}`), { removed: true });
  assert.deepEqual(await A.ok("DELETE", `/v1/ot/blocks/${B.handle}`), { removed: false });
  assert.deepEqual((await A.ok("GET", "/v1/ot/blocks")).blocks.map((row: any) => row.blocked_id), [cId]);
});

test("a report is idempotent while pending and a new one opens only after it is resolved", async () => {
  const A = await home(S.base, "modrepa");
  const ws = await workspace(A, "modrep");
  const url = wsBase(ws);

  const first = await A.ok("POST", url, {
    target_type: "message", target_id: "message-0001", reason: "spam", details: "Repeated advertising",
  });
  const replay = await A.ok("POST", url, {
    target_type: "message", target_id: "message-0001", reason: "spam", details: "Different details under the same open report",
  });
  assert.equal(replay.id, first.id, "the open report is reused");
  assert.equal(replay.details, "Repeated advertising", "the first details are kept");
  assert.equal(first.status, "pending");
  assert.equal(first.reviewer_id, null);
  assert.deepEqual((await A.ok("GET", url)).items, [first]);

  await A.ok("POST", `${url}/${first.id}/resolve`, { status: "dismissed", resolution: "Not a violation.", action: "none" });
  const reopened = await A.ok("POST", url, {
    target_type: "message", target_id: "message-0001", reason: "spam", details: "New evidence",
  });
  assert.notEqual(reopened.id, first.id);
  assert.equal((await A.ok("GET", url)).items.length, 2);
});

test("an unknown target type, reason or target id is refused and writes nothing", async () => {
  const A = await home(S.base, "modinva");
  const ws = await workspace(A, "modinv");
  const url = wsBase(ws);
  for (const target_type of ["channel", "", "MESSAGE"]) {
    const r = await A.call("POST", url, { target_type, target_id: "message-0001", reason: "spam" });
    assert.equal(r.status, 400, `target_type ${JSON.stringify(target_type)} must be refused`);
  }
  for (const reason of ["not-a-reason", "", "SPAM"]) {
    const r = await A.call("POST", url, { target_type: "message", target_id: "message-0001", reason });
    assert.equal(r.status, 400, `reason ${JSON.stringify(reason)} must be refused`);
  }
  const empty = await A.call("POST", url, { target_type: "message", target_id: "", reason: "spam" });
  assert.equal(empty.status, 400);
  assert.deepEqual((await A.ok("GET", url)).items, []);
});

test("the queue filters by status and pages by cursor", async () => {
  const A = await home(S.base, "modlista");
  const ws = await workspace(A, "modlist");
  const url = wsBase(ws);
  const made: any[] = [];
  for (const target of ["message-0001", "message-0002", "message-0003", "message-0004"]) {
    made.push(await A.ok("POST", url, { target_type: "message", target_id: target, reason: "spam" }));
  }
  await A.ok("POST", `${url}/${made[2].id}/resolve`, { status: "actioned", resolution: "Removed.", action: "remove" });
  const ordered = made.map((row) => row.id).sort();

  assert.deepEqual((await A.ok("GET", url)).items.map((row: any) => row.id), ordered);
  assert.deepEqual(
    (await A.ok("GET", `${url}?status=pending`)).items.map((row: any) => row.id).sort(),
    [made[0].id, made[1].id, made[3].id].sort(),
  );
  assert.deepEqual((await A.ok("GET", `${url}?status=actioned`)).items.map((row: any) => row.id), [made[2].id]);

  const pageOne = await A.ok("GET", `${url}?limit=2`);
  assert.deepEqual(pageOne.items.map((row: any) => row.id), ordered.slice(0, 2));
  const pageTwo = await A.ok("GET", `${url}?limit=2&cursor=${pageOne.next_cursor}`);
  assert.deepEqual(pageTwo.items.map((row: any) => row.id), ordered.slice(2));

  assert.equal((await A.call("GET", `${url}?status=open`)).status, 400);
  assert.equal((await A.call("GET", `${url}?limit=0`)).status, 400);
  assert.equal((await A.call("GET", `${url}?cursor=123`)).status, 400);
});

test("resolving records one reviewer action and a terminal report cannot be reopened", async () => {
  const A = await home(S.base, "modresa");
  const ws = await workspace(A, "modres");
  const url = wsBase(ws);
  const owner = await me(A);
  const report = await A.ok("POST", url, { target_type: "message", target_id: "message-0001", reason: "spam" });
  const resolved = await A.ok("POST", `${url}/${report.id}/resolve`, {
    status: "actioned", resolution: "Removed the message.", action: "remove",
  });
  assert.equal(resolved.status, "actioned");
  assert.equal(resolved.reviewer_id, owner);
  assert.equal(resolved.resolution, "Removed the message.");
  assert.ok(resolved.updated >= resolved.created);

  const replay = await A.ok("POST", `${url}/${report.id}/resolve`, {
    status: "actioned", resolution: "A different retry.", action: "remove",
  });
  assert.deepEqual(replay, resolved, "replaying the recorded status is a no-op");
  const actions = (await A.ok("GET", `${url}/${report.id}/actions`)).actions;
  assert.equal(actions.length, 1, "exactly one action row");
  assert.equal(actions[0].actor_id, owner);
  assert.equal(actions[0].action, "remove");
  assert.equal(actions[0].notes, "Removed the message.");
  assert.equal(actions[0].report_id, report.id);

  assert.equal((await A.call("POST", `${url}/${report.id}/resolve`, { status: "dismissed" })).status, 409);
  assert.equal((await A.ok("POST", `${url}/${report.id}/resolve`, { status: "actioned" })).status, "actioned");
  assert.equal((await A.call("POST", `${url}/${report.id}/resolve`, { status: "pending" })).status, 400);
  assert.equal((await A.call("POST", `${url}/${report.id}/resolve`, { status: "unknown" })).status, 400);
  assert.equal((await A.call("POST", `${url}/${"f".repeat(32)}/resolve`, { status: "actioned" })).status, 404);

  const second = await A.ok("POST", url, { target_type: "message", target_id: "message-0002", reason: "spam" });
  const dismissed = await A.ok("POST", `${url}/${second.id}/resolve`, {
    status: "dismissed", resolution: "No action needed.", action: "none",
  });
  assert.equal(dismissed.status, "dismissed");
});

test("counts and reports are workspace-isolated", async () => {
  const A = await home(S.base, "modisoa");
  const B = await home(S.base, "modisob");
  const mine = await workspace(A, "modiso1");
  const theirs = await workspace(B, "modiso2");
  const mineUrl = wsBase(mine);
  const theirsUrl = wsBase(theirs);

  const a = await A.ok("POST", mineUrl, { target_type: "work", target_id: "work-0001", reason: "spam" });
  await A.ok("POST", mineUrl, { target_type: "work", target_id: "work-0002", reason: "spam" });
  const b = await B.ok("POST", theirsUrl, { target_type: "work", target_id: "work-0001", reason: "spam" });

  assert.deepEqual(await A.ok("GET", `${mineUrl}/count`), { pending: 2 });
  assert.deepEqual(await B.ok("GET", `${theirsUrl}/count`), { pending: 1 });
  assert.deepEqual(await A.ok("GET", `${mineUrl}/${a.id}`), a);
  assert.equal((await A.call("GET", `${mineUrl}/${b.id}`)).status, 404, "another workspace's report is invisible");
  assert.equal((await A.call("GET", `${mineUrl}/${"f".repeat(32)}`)).status, 404);
  assert.deepEqual((await B.ok("GET", theirsUrl)).items.map((row: any) => row.id), [b.id]);

  await A.ok("POST", `${mineUrl}/${a.id}/resolve`, { status: "dismissed", resolution: "Handled." });
  assert.deepEqual(await A.ok("GET", `${mineUrl}/count`), { pending: 1 });
  assert.deepEqual(await B.ok("GET", `${theirsUrl}/count`), { pending: 1 });
  assert.equal((await B.call("POST", `${theirsUrl}/${a.id}/resolve`, { status: "actioned" })).status, 404, "no cross-workspace writes");
  assert.notEqual(b.id, a.id, "the same target reported in two workspaces stays two reports");
});

test("oversize text and out-of-range limits are refused and write no action", async () => {
  const A = await home(S.base, "modlima");
  const ws = await workspace(A, "modlim");
  const url = wsBase(ws);
  assert.equal((await A.call("POST", url, {
    target_type: "message", target_id: "message-0001", reason: "spam", details: "x".repeat(4001),
  })).status, 400);
  const report = await A.ok("POST", url, { target_type: "message", target_id: "message-0001", reason: "spam" });
  assert.equal((await A.call("POST", `${url}/${report.id}/resolve`, {
    status: "actioned", resolution: "x".repeat(2001),
  })).status, 400);
  assert.equal((await A.call("POST", `${url}/${report.id}/resolve`, {
    status: "actioned", action: "x".repeat(121),
  })).status, 400);
  assert.equal((await A.call("GET", `${url}?limit=101`)).status, 400);
  assert.deepEqual((await A.ok("GET", `${url}/${report.id}/actions`)).actions, []);
});
