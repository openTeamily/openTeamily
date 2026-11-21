// Send mode (Auto / Instant / Agentic) is a property of each message, not a conversation setting:
// the composer choice travels with the send, one row records it, and every later read returns it.
// Ported from #463's Python contract (social_message_modes + mode in MESSAGE_ROWS) to Bot Social.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { bulkAuth, startServer } from "./helpers.js";
import { home } from "./openteamily_helpers.js";

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(bulkAuth); });
after(async () => { await S.stop(); });

async function pair() {
  const A = await home(S.base, "modea");
  const B = await home(S.base, "modeb");
  const team = await A.ok("POST", "/v1/ot/teams", { name: "Mode team" });
  const { code } = await A.ok("POST", `/v1/ot/teams/${team.id}/invites`, {});
  await B.ok("POST", "/v1/ot/invites/accept", { code });
  const dm = await A.ok("POST", "/v1/ot/conversations", { kind: "dm", peer: B.handle });
  return { A, B, dm };
}

const messages = async (who: any, cid: string) => (await who.ok("GET", `/v1/ot/conversations/${cid}/messages`)).messages;

test("ot_messages records a send mode with an auto default", () => {
  const col = S.platform.db.prepare("SELECT name, \"notnull\", dflt_value FROM pragma_table_info('ot_messages') WHERE name='mode'").get() as any;
  assert.ok(col, "ot_messages has no mode column");
  assert.equal(col.notnull, 1);
  assert.equal(String(col.dflt_value).replace(/^'|'$/g, ""), "auto");
});

test("two messages in one conversation keep their own mode on read-back", async () => {
  const { A, B, dm } = await pair();
  const agentic = await A.ok("POST", `/v1/ot/conversations/${dm.id}/messages`, { body: "整理这周的发布计划", mode: "agentic" });
  const instant = await A.ok("POST", `/v1/ot/conversations/${dm.id}/messages`, { body: "现在就要答案", mode: "instant" });
  assert.equal(agentic.mode, "agentic");
  assert.equal(instant.mode, "instant");
  const seenByPeer = await messages(B, dm.id);
  const byId = new Map(seenByPeer.map((m: any) => [m.id, m.mode]));
  assert.equal(byId.get(agentic.id), "agentic");
  assert.equal(byId.get(instant.id), "instant");
  const seenBySender = await messages(A, dm.id);
  assert.deepEqual(seenBySender.map((m: any) => m.mode), ["agentic", "instant"]);
});

test("a message sent without a mode reads back as auto", async () => {
  const { A, dm } = await pair();
  const sent = await A.ok("POST", `/v1/ot/conversations/${dm.id}/messages`, { body: "普通消息" });
  assert.equal(sent.mode, "auto");
  assert.equal((await messages(A, dm.id))[0].mode, "auto");
});

test("an unknown mode is refused and nothing is stored", async () => {
  const { A, dm } = await pair();
  const bad = await A.call("POST", `/v1/ot/conversations/${dm.id}/messages`, { body: "不要存下来", mode: "turbo" });
  assert.equal(bad.status, 400, JSON.stringify(bad.data));
  assert.equal(typeof bad.data.error?.code, "string");
  assert.deepEqual(await messages(A, dm.id), []);
});

test("a non-string mode is refused", async () => {
  const { A, dm } = await pair();
  const bad = await A.call("POST", `/v1/ot/conversations/${dm.id}/messages`, { body: "数字不是模式", mode: 5 });
  assert.equal(bad.status, 400, JSON.stringify(bad.data));
  assert.deepEqual(await messages(A, dm.id), []);
});

test("replaying a client_key with another mode conflicts instead of mixing the two", async () => {
  const { A, dm } = await pair();
  const first = await A.ok("POST", `/v1/ot/conversations/${dm.id}/messages`, { body: "只发一次", mode: "auto", client_key: "mode-replay-1" });
  const replay = await A.call("POST", `/v1/ot/conversations/${dm.id}/messages`, { body: "只发一次", mode: "agentic", client_key: "mode-replay-1" });
  assert.equal(replay.status, 409, JSON.stringify(replay.data));
  const rows = await messages(A, dm.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, first.id);
  assert.equal(rows[0].mode, "auto");
});

test("an existing database without the column gains it and old rows read as auto", async () => {
  const dir = await mkdtemp(join(tmpdir(), "otsendmode-"));
  const dbPath = join(dir, "state.db");
  const S1 = await startServer({ ...bulkAuth, dbPath });
  let messageId = "";
  try {
    const A = await home(S1.base, "migr");
    const B = await home(S1.base, "migr2");
    const team = await A.ok("POST", "/v1/ot/teams", { name: "Migrate team" });
    const { code } = await A.ok("POST", `/v1/ot/teams/${team.id}/invites`, {});
    await B.ok("POST", "/v1/ot/invites/accept", { code });
    const dm = await A.ok("POST", "/v1/ot/conversations", { kind: "dm", peer: B.handle });
    const sent = await A.ok("POST", `/v1/ot/conversations/${dm.id}/messages`, { body: "旧消息", mode: "agentic" });
    messageId = sent.id;
  } finally {
    await S1.stop();
  }
  const raw = new Database(dbPath);
  raw.exec("ALTER TABLE ot_messages DROP COLUMN mode");
  raw.close();
  const S2 = await startServer({ ...bulkAuth, dbPath });
  try {
    const row = S2.platform.db.prepare("SELECT mode FROM ot_messages WHERE id=?").get(messageId) as any;
    assert.equal(row?.mode, "auto", "old row must read as the auto default after the migration");
  } finally {
    await S2.stop();
  }
});
