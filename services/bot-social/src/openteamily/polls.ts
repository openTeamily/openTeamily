// OpenTeamily polls on Bot Social: a poll belongs to one member conversation and
// every member of that conversation votes here, because that is where the other
// members are. The per-user DS-Bot feature (`runtime/openteamily-web/features/polls`)
// could only ever record the volume owner's own vote, so #453 moved the store to
// the shared side; the plugin side no longer keeps poll rows.
//
// Endpoints: POST /v1/ot/polls, GET /v1/ot/polls/:id,
// GET /v1/ot/polls?conversation_id=…&limit=…&cursor=…,
// POST /v1/ot/polls/:id/vote, POST /v1/ot/polls/:id/close, DELETE /v1/ot/polls/:id.
// A poll id is only visible to members of its conversation: a non-member gets the
// same 404 as a missing poll (no existence leak). Only the creator closes or deletes.
import type { FastifyInstance } from "fastify";
import { assert } from "../errors.js";
import { newId } from "../ids.js";
import { body, one, OtContext, params, query, text } from "./core.js";
import { memberOf } from "./messenger.js";

export const POLLS_SCHEMA = `
CREATE TABLE IF NOT EXISTS ot_polls (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES ot_conversations(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL, question TEXT NOT NULL,
  multi_select INTEGER NOT NULL DEFAULT 0 CHECK (multi_select IN (0,1)),
  anonymous INTEGER NOT NULL DEFAULT 0 CHECK (anonymous IN (0,1)),
  closes INTEGER, status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ot_polls_conversation ON ot_polls(conversation_id, created_at, id);
CREATE TABLE IF NOT EXISTS ot_poll_options (
  id TEXT PRIMARY KEY, poll_id TEXT NOT NULL REFERENCES ot_polls(id) ON DELETE CASCADE,
  position INTEGER NOT NULL, text TEXT NOT NULL, UNIQUE (poll_id, position)
);
CREATE INDEX IF NOT EXISTS ot_poll_options_order ON ot_poll_options(poll_id, position, id);
CREATE TABLE IF NOT EXISTS ot_poll_votes (
  poll_id TEXT NOT NULL REFERENCES ot_polls(id) ON DELETE CASCADE,
  option_id TEXT NOT NULL REFERENCES ot_poll_options(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (poll_id, option_id, owner_id)
);
CREATE INDEX IF NOT EXISTS ot_poll_votes_owner ON ot_poll_votes(poll_id, owner_id);
`;

export const QUESTION_MAX = 500;
export const OPTION_MAX = 200;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 20;
const LIMIT_MAX = 100;
const LIMIT_DEFAULT = 20;
const ID_MAX = 80;

function conversationId(raw: unknown): string {
  const value = one(raw, "conversation_id");
  assert(typeof value === "string" && value.length >= 1 && value.length <= ID_MAX,
    400, "invalid_request", "conversation_id is required");
  return value;
}

function optionTexts(raw: unknown): string[] {
  assert(Array.isArray(raw) && raw.length >= MIN_OPTIONS && raw.length <= MAX_OPTIONS,
    400, "invalid_request", `polls require ${MIN_OPTIONS} to ${MAX_OPTIONS} options`);
  const seen = new Set<string>();
  return raw.map((option) => {
    const value = text(option, "option", { min: 1, max: OPTION_MAX });
    const key = value.toLowerCase();
    assert(!seen.has(key), 400, "invalid_request", "duplicate poll option");
    seen.add(key);
    return value;
  });
}

function optionIds(raw: unknown): string[] {
  assert(Array.isArray(raw) && raw.length >= 1 && raw.length <= MAX_OPTIONS,
    400, "invalid_request", "at least one option id is required");
  const seen = new Set<string>();
  return raw.map((option) => {
    assert(typeof option === "string" && option.length >= 1 && option.length <= ID_MAX, 400, "invalid_request", "invalid option id");
    assert(!seen.has(option), 400, "invalid_request", "invalid option id");
    seen.add(option);
    return option;
  });
}

function closeTime(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  assert(typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0,
    400, "invalid_request", "closes must be an integer timestamp");
  return raw;
}

function pollRow(ot: OtContext, id: string, owner: string) {
  const row = ot.get<any>(`SELECT p.* FROM ot_polls p
    JOIN ot_conversation_members m ON m.conversation_id=p.conversation_id AND m.owner_id=?
    WHERE p.id=?`, owner, id);
  assert(row, 404, "poll_not_found", "no such poll");
  return row;
}

function view(ot: OtContext, row: any, viewer: string) {
  const options = ot.all<any>("SELECT * FROM ot_poll_options WHERE poll_id=? ORDER BY position,id", row.id);
  const counts = new Map(ot.all<any>("SELECT option_id,COUNT(*) AS n FROM ot_poll_votes WHERE poll_id=? GROUP BY option_id", row.id)
    .map((item) => [item.option_id as string, item.n as number]));
  const voters = new Map<string, string[]>();
  if (!row.anonymous) {
    for (const item of ot.all<any>("SELECT option_id,owner_id FROM ot_poll_votes WHERE poll_id=? ORDER BY created_at,owner_id", row.id)) {
      const list = voters.get(item.option_id) ?? [];
      list.push(item.owner_id);
      voters.set(item.option_id, list);
    }
  }
  const viewerVotes = ot.all<any>(`SELECT v.option_id FROM ot_poll_votes v JOIN ot_poll_options o ON o.id=v.option_id
    WHERE v.poll_id=? AND v.owner_id=? ORDER BY o.position,o.id`, row.id, viewer).map((item) => item.option_id as string);
  const voterCount = ot.get<any>("SELECT COUNT(DISTINCT owner_id) AS n FROM ot_poll_votes WHERE poll_id=?", row.id).n;
  return {
    id: row.id,
    owner_id: row.created_by,
    conversation_id: row.conversation_id,
    created_by: row.created_by,
    question: row.question,
    multi_select: row.multi_select === 1,
    anonymous: row.anonymous === 1,
    closes: row.closes,
    status: row.status,
    created: row.created_at,
    options: options.map((option) => ({
      id: option.id, poll_id: option.poll_id, position: option.position, text: option.text,
      count: counts.get(option.id) ?? 0, voters: voters.get(option.id) ?? [],
    })),
    votes: viewerVotes,
    viewer_votes: viewerVotes,
    total: [...counts.values()].reduce((sum, count) => sum + count, 0),
    voter_count: voterCount,
  };
}

export function registerPolls(app: FastifyInstance, ot: OtContext) {
  const root = "/v1/ot/polls";

  app.post(root, async (req, reply) => {
    const me = ot.me(req), b = body(req);
    const conv = memberOf(ot, conversationId(b.conversation_id), me.ownerId);
    const question = text(b.question, "question", { min: 1, max: QUESTION_MAX });
    const options = optionTexts(b.options);
    const closes = closeTime(b.closes);
    const id = newId("otp"), now = ot.now();
    ot.tx(() => {
      ot.run(`INSERT INTO ot_polls(id,conversation_id,created_by,question,multi_select,anonymous,closes,status,created_at)
        VALUES (?,?,?,?,?,?,?,'open',?)`,
        id, conv.id, me.ownerId, question, b.multi_select === true ? 1 : 0, b.anonymous === true ? 1 : 0, closes, now);
      options.forEach((option, position) => ot.run(
        "INSERT INTO ot_poll_options(id,poll_id,position,text) VALUES (?,?,?,?)", newId("oto"), id, position, option));
    });
    return reply.status(201).send({ poll: view(ot, ot.get("SELECT * FROM ot_polls WHERE id=?", id), me.ownerId) });
  });

  app.get(root + "/:id", async (req) => {
    const me = ot.me(req);
    return { poll: view(ot, pollRow(ot, params(req).id, me.ownerId), me.ownerId) };
  });

  app.get(root, async (req) => {
    const me = ot.me(req), q = query(req);
    const conv = memberOf(ot, conversationId(q.conversation_id), me.ownerId);
    const rawLimit = one(q.limit, "limit");
    let limit = LIMIT_DEFAULT;
    if (rawLimit !== undefined && rawLimit !== "") {
      const value = Number(rawLimit);
      assert(Number.isSafeInteger(value) && value >= 1 && value <= LIMIT_MAX,
        400, "invalid_request", `limit must be an integer from 1 to ${LIMIT_MAX}`);
      limit = value;
    }
    let filter = "conversation_id=?", args: unknown[] = [conv.id];
    const cursor = one(q.cursor, "cursor");
    if (cursor !== undefined && cursor !== "") {
      const anchor = ot.get<any>("SELECT rowid,created_at FROM ot_polls WHERE id=? AND conversation_id=?", cursor, conv.id);
      assert(anchor, 404, "poll_not_found", "unknown poll cursor");
      filter += " AND (created_at>? OR (created_at=? AND rowid>?))";
      args.push(anchor.created_at, anchor.created_at, anchor.rowid);
    }
    const rows = ot.all<any>(`SELECT rowid,* FROM ot_polls WHERE ${filter} ORDER BY created_at,rowid LIMIT ?`, ...args, limit + 1);
    const page = rows.slice(0, limit);
    return {
      items: page.map((row) => view(ot, row, me.ownerId)),
      next_cursor: rows.length > limit ? page[page.length - 1].id : null,
    };
  });

  app.post(root + "/:id/vote", async (req) => {
    const me = ot.me(req), b = body(req);
    const poll = pollRow(ot, params(req).id, me.ownerId);
    assert(poll.status === "open", 409, "poll_closed", "poll is closed");
    assert(poll.closes === null || ot.now() < poll.closes, 409, "poll_closed", "poll has closed");
    const ids = optionIds(b.option_ids);
    assert(poll.multi_select === 1 || ids.length === 1, 400, "invalid_request", "single-choice polls accept exactly one option");
    const found = new Set(ot.all<any>(`SELECT id FROM ot_poll_options WHERE poll_id=? AND id IN (${ids.map(() => "?").join(",")})`,
      poll.id, ...ids).map((row) => row.id as string));
    assert(found.size === ids.length, 400, "invalid_option", "option does not belong to this poll");
    const now = ot.now();
    ot.tx(() => {
      if (poll.multi_select !== 1) {
        ot.run("DELETE FROM ot_poll_votes WHERE poll_id=? AND owner_id=? AND option_id<>?", poll.id, me.ownerId, ids[0]);
      }
      for (const option of ids) {
        ot.run("INSERT OR IGNORE INTO ot_poll_votes(poll_id,option_id,owner_id,created_at) VALUES (?,?,?,?)",
          poll.id, option, me.ownerId, now);
      }
    });
    return { poll: view(ot, ot.get("SELECT * FROM ot_polls WHERE id=?", poll.id), me.ownerId) };
  });

  app.post(root + "/:id/close", async (req) => {
    const me = ot.me(req);
    const poll = pollRow(ot, params(req).id, me.ownerId);
    assert(poll.created_by === me.ownerId, 403, "forbidden", "only the poll creator closes it");
    if (poll.status !== "closed") ot.run("UPDATE ot_polls SET status='closed' WHERE id=?", poll.id);
    return { poll: view(ot, ot.get("SELECT * FROM ot_polls WHERE id=?", poll.id), me.ownerId) };
  });

  app.delete(root + "/:id", async (req) => {
    const me = ot.me(req);
    const poll = pollRow(ot, params(req).id, me.ownerId);
    assert(poll.created_by === me.ownerId, 403, "forbidden", "only the poll creator deletes it");
    ot.tx(() => {
      ot.run("DELETE FROM ot_poll_votes WHERE poll_id=?", poll.id);
      ot.run("DELETE FROM ot_poll_options WHERE poll_id=?", poll.id);
      ot.run("DELETE FROM ot_polls WHERE id=?", poll.id);
    });
    return { deleted: true };
  });
}
