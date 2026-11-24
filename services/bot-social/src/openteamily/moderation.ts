// Moderation on Bot Social (phase C): directional user blocks, idempotent content
// reports and a workspace moderation queue with terminal statuses, resolution notes and
// one action row per resolution. Ported from the legacy openteamily/moderation.py
// contract (#460); deliberately narrow — only message/work/user/comment targets exist,
// the legacy `agent` target is deferred to the DS-Bot side. OpenTeamily semantics.
import type { FastifyInstance } from "fastify";
import { assert } from "../errors.js";
import { newId } from "../ids.js";
import { body, one, OtContext, optText, params, query, text } from "./core.js";
import { requireMember } from "./teams.js";

export const MODERATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  created INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX IF NOT EXISTS user_block_blocked ON user_blocks(blocked_id, blocker_id);
CREATE TABLE IF NOT EXISTS content_reports (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  reporter_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('message','work','user','comment')),
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','reviewed','actioned','dismissed')),
  reviewer_id TEXT REFERENCES owners(id),
  resolution TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS content_report_open
  ON content_reports(reporter_id, workspace_id, target_type, target_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS content_report_queue ON content_reports(workspace_id, status, id);
CREATE INDEX IF NOT EXISTS content_report_target ON content_reports(workspace_id, target_type, target_id, id);
CREATE TABLE IF NOT EXISTS moderation_actions (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES content_reports(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS moderation_action_report ON moderation_actions(report_id, created, id);
`;

// The legacy vocabulary, unchanged: callers present these labels; the store never infers a reason.
const REASONS = new Set([
  "spam", "scam", "fraud", "phishing", "malware",
  "harassment", "harass", "abuse", "bullying", "threat", "threats",
  "hate", "hate_speech", "hate-speech", "offensive", "inappropriate", "rude",
  "violence", "graphic", "dangerous", "terrorism", "weapons", "drugs",
  "sexual", "sexual_content", "nudity", "adult", "porn", "obscenity",
  "self_harm", "self-harm", "child_safety", "csam",
  "misinformation", "disinformation", "misleading",
  "impersonation", "privacy", "doxxing", "defamation",
  "copyright", "illegal", "unwanted", "other",
]);
const TARGET_TYPES = new Set(["message", "work", "user", "comment"]);
const STATUSES = new Set(["pending", "reviewed", "actioned", "dismissed"]);
const TERMINAL = new Set(["reviewed", "actioned", "dismissed"]);
const DETAILS_MAX = 4000;
const RESOLUTION_MAX = 2000;
const ACTION_MAX = 120;
const TARGET_ID_MAX = 200;
const LIMIT = 50;
const MAX_LIMIT = 100;
const WORKSPACE = /^[0-9a-f]{32}$/;
const REPORT_ID = /^otr_[0-9A-Z]{26}$/;

type Report = {
  id: string; workspace_id: string; reporter_id: string; target_type: string; target_id: string;
  reason: string; details: string; status: string; reviewer_id: string | null;
  resolution: string; created: number; updated: number;
};

const blockView = (row: any) => ({ blocker_id: row.blocker_id, blocked_id: row.blocked_id, created: row.created });
const reportView = (row: any): Report => ({
  id: row.id, workspace_id: row.workspace_id, reporter_id: row.reporter_id, target_type: row.target_type,
  target_id: row.target_id, reason: row.reason, details: row.details, status: row.status,
  reviewer_id: row.reviewer_id ?? null, resolution: row.resolution, created: row.created, updated: row.updated,
});
const actionView = (row: any) => ({
  id: row.id, report_id: row.report_id, actor_id: row.actor_id, action: row.action,
  notes: row.notes, created: row.created,
});

function targetTypeOf(raw: unknown) {
  const value = text(raw, "target_type", { max: 16 });
  assert(TARGET_TYPES.has(value), 400, "invalid_request", "target_type must be one of: " + [...TARGET_TYPES].join(", "));
  return value;
}
function reasonOf(raw: unknown) {
  const value = text(raw, "reason", { max: 64 });
  assert(REASONS.has(value), 400, "invalid_request", "reason is not recognized");
  return value;
}
function statusOf(raw: unknown, terminalOnly = false) {
  const value = text(raw, "status", { max: 16 });
  const allowed = terminalOnly ? TERMINAL : STATUSES;
  assert(allowed.has(value), 400, "invalid_request", "status must be one of: " + [...allowed].join(", "));
  return value;
}
function limitOf(raw: unknown) {
  const value = one(raw, "limit");
  if (value === undefined || value.trim() === "") return LIMIT;
  const n = Number(value);
  assert(Number.isSafeInteger(n) && n >= 1 && n <= MAX_LIMIT, 400, "invalid_request", `limit must be an integer from 1 to ${MAX_LIMIT}`);
  return n;
}

/** The team behind a workspace id, only for a live member of it. */
function workspaceTeam(ot: OtContext, raw: unknown, ownerId: string) {
  const workspaceId = String(raw ?? "");
  assert(WORKSPACE.test(workspaceId), 400, "invalid_request", "workspace_id must be a 32-character hex id");
  const team = ot.get<any>(
    "SELECT t.id FROM ot_teams t JOIN ot_team_members m ON m.team_id = t.id WHERE t.workspace_id = ? AND m.owner_id = ? AND m.suspended = 0",
    workspaceId, ownerId,
  );
  assert(team, 404, "not_found", "workspace not found");
  return { workspaceId, teamId: team.id as string };
}

/** The same workspace, narrowed to its reviewers: the owner or an admin of the team. */
function reviewerTeam(ot: OtContext, raw: unknown, ownerId: string) {
  const workspaceId = String(raw ?? "");
  assert(WORKSPACE.test(workspaceId), 400, "invalid_request", "workspace_id must be a 32-character hex id");
  const team = ot.get<any>("SELECT id FROM ot_teams WHERE workspace_id = ?", workspaceId);
  assert(team, 404, "not_found", "workspace not found");
  const { role } = requireMember(ot, team.id as string, ownerId, ["owner", "admin"]);
  return { workspaceId, teamId: team.id as string, role };
}

// Who a report's target belongs to, when this deployment stores the target itself. A report
// may name a person (owner id, handle, handle.home or platform user id) or a piece of content;
// either way its author never reviews it. Targets this deployment does not hold (imported or
// opaque ids) get null and keep the pre-existing behaviour instead of being blocked here.
function reportAuthor(ot: OtContext, targetType: string, targetId: string): string | null {
  if (targetType === "user") {
    try { return ot.ownerByHandle(targetId); } catch { return null; }
  }
  if (targetType === "message") return ot.get<any>("SELECT author_id FROM ot_messages WHERE id = ?", targetId)?.author_id ?? null;
  if (targetType === "comment") return ot.get<any>("SELECT owner_id FROM ot_work_comments WHERE id = ?", targetId)?.owner_id ?? null;
  if (targetType === "work") return ot.get<any>("SELECT owner_id FROM ot_listings WHERE id = ?", targetId)?.owner_id ?? null;
  return null;
}

export function registerModeration(app: FastifyInstance, ot: OtContext) {
  // ---- blocks: directional and owner-global, so a block holds across every workspace
  app.get("/v1/ot/blocks", async (req) => {
    const me = ot.me(req);
    const rows = ot.all<any>("SELECT * FROM user_blocks WHERE blocker_id = ? ORDER BY created DESC, blocked_id ASC", me.ownerId);
    return { blocks: rows.map(blockView) };
  });
  app.post("/v1/ot/blocks", async (req, reply) => {
    const me = ot.me(req);
    const b = body(req);
    const blockedId = ot.ownerByHandle(text(b.blocked, "blocked", { min: 1, max: 80 }));
    assert(blockedId !== me.ownerId, 400, "invalid_request", "a user cannot block themselves");
    ot.run("INSERT OR IGNORE INTO user_blocks(blocker_id, blocked_id, created) VALUES (?,?,?)", me.ownerId, blockedId, ot.now());
    const row = ot.get<any>("SELECT * FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?", me.ownerId, blockedId);
    return reply.status(201).send(blockView(row));
  });
  app.delete("/v1/ot/blocks/:blocked", async (req) => {
    const me = ot.me(req);
    const blockedId = ot.ownerByHandle(params(req).blocked);
    const removed = ot.run("DELETE FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?", me.ownerId, blockedId).changes > 0;
    return { removed };
  });

  // ---- reports and the queue: one workspace's reviewers see only that workspace
  app.post("/v1/ot/workspaces/:workspace_id/reports", async (req, reply) => {
    const me = ot.me(req);
    const b = body(req);
    const { workspaceId } = workspaceTeam(ot, params(req).workspace_id, me.ownerId);
    const targetType = targetTypeOf(b.target_type);
    const targetId = text(b.target_id, "target_id", { min: 1, max: TARGET_ID_MAX });
    const reason = reasonOf(b.reason);
    const details = optText(b.details, "details", { max: DETAILS_MAX, multiline: true }) ?? "";
    const now = ot.now();
    const created = ot.tx(() => {
      const open = () => ot.get<any>(
        "SELECT * FROM content_reports WHERE workspace_id = ? AND reporter_id = ? AND target_type = ? AND target_id = ? AND status = 'pending' ORDER BY id LIMIT 1",
        workspaceId, me.ownerId, targetType, targetId,
      );
      const existing = open();
      if (existing) return { report: existing, fresh: false };
      const id = newId("otr");
      try {
        ot.run(
          "INSERT INTO content_reports(id, workspace_id, reporter_id, target_type, target_id, reason, details, status, reviewer_id, resolution, created, updated) VALUES (?,?,?,?,?,?,?,'pending',NULL,'',?,?)",
          id, workspaceId, me.ownerId, targetType, targetId, reason, details, now, now,
        );
      } catch (error: any) {
        // The partial unique index closes the concurrent-create race: return the winner.
        const winner = open();
        if (winner) return { report: winner, fresh: false };
        throw error;
      }
      return { report: ot.get<any>("SELECT * FROM content_reports WHERE id = ?", id), fresh: true };
    });
    return reply.status(created.fresh ? 201 : 200).send(reportView(created.report));
  });
  app.get("/v1/ot/workspaces/:workspace_id/reports/count", async (req) => {
    const me = ot.me(req);
    const { workspaceId } = reviewerTeam(ot, params(req).workspace_id, me.ownerId);
    const pending = ot.get<any>("SELECT COUNT(*) AS n FROM content_reports WHERE workspace_id = ? AND status = 'pending'", workspaceId).n;
    return { pending };
  });
  app.get("/v1/ot/workspaces/:workspace_id/reports", async (req) => {
    const me = ot.me(req);
    const { workspaceId } = reviewerTeam(ot, params(req).workspace_id, me.ownerId);
    const q = query(req);
    const limit = limitOf(q.limit);
    let sql = "SELECT * FROM content_reports WHERE workspace_id = ?";
    const args: unknown[] = [workspaceId];
    const status = optText(q.status, "status");
    if (status !== undefined) { sql += " AND status = ?"; args.push(statusOf(status)); }
    const cursor = one(q.cursor, "cursor");
    if (cursor !== undefined && cursor !== "") {
      assert(REPORT_ID.test(cursor), 400, "invalid_request", "cursor must be a report id");
      sql += " AND id > ?"; args.push(cursor);
    }
    sql += " ORDER BY id ASC LIMIT ?"; args.push(limit);
    const items = ot.all<any>(sql, ...args).map(reportView);
    return { items, next_cursor: items.length === limit ? items[items.length - 1].id : null };
  });
  app.get("/v1/ot/workspaces/:workspace_id/reports/:report_id", async (req) => {
    const me = ot.me(req);
    const { workspaceId } = reviewerTeam(ot, params(req).workspace_id, me.ownerId);
    const row = ot.get<any>("SELECT * FROM content_reports WHERE workspace_id = ? AND id = ?", workspaceId, text(params(req).report_id, "report_id", { max: 128 }));
    assert(row, 404, "not_found", "report not found");
    return reportView(row);
  });
  app.get("/v1/ot/workspaces/:workspace_id/reports/:report_id/actions", async (req) => {
    const me = ot.me(req);
    const { workspaceId } = reviewerTeam(ot, params(req).workspace_id, me.ownerId);
    const reportId = text(params(req).report_id, "report_id", { max: 128 });
    const row = ot.get<any>("SELECT 1 FROM content_reports WHERE workspace_id = ? AND id = ?", workspaceId, reportId);
    assert(row, 404, "not_found", "report not found");
    const actions = ot.all<any>("SELECT * FROM moderation_actions WHERE report_id = ? ORDER BY created, id", reportId);
    return { actions: actions.map(actionView) };
  });
  app.post("/v1/ot/workspaces/:workspace_id/reports/:report_id/resolve", async (req) => {
    const me = ot.me(req);
    const b = body(req);
    const { workspaceId, role } = reviewerTeam(ot, params(req).workspace_id, me.ownerId);
    const reportId = text(params(req).report_id, "report_id", { max: 128 });
    const status = statusOf(b.status, true);
    const resolution = optText(b.resolution, "resolution", { max: RESOLUTION_MAX, multiline: true }) ?? "";
    const action = optText(b.action, "action", { max: ACTION_MAX });
    const now = ot.now();
    return ot.tx(() => {
      const row = ot.get<any>("SELECT * FROM content_reports WHERE workspace_id = ? AND id = ?", workspaceId, reportId);
      assert(row, 404, "not_found", "report not found");
      // A reviewer never settles a complaint about themselves or about content they wrote —
      // no owner exemption there, because such a row's reporter is someone else and the
      // self-review would be invisible to the reporter = reviewer check below. The owner is
      // the workspace's accountable reviewer, so only an admin is barred from clearing a
      // report they filed; the owner's own filings still need the owner, or the queue would
      // never drain.
      assert(reportAuthor(ot, row.target_type, row.target_id) !== me.ownerId, 403, "forbidden", "you cannot resolve a report about yourself");
      assert(row.reporter_id !== me.ownerId || role === "owner", 403, "forbidden", "you cannot resolve a report you filed");
      if (row.status !== "pending") {
        assert(row.status === status, 409, "conflict", "report is already resolved");
        return reportView(row);
      }
      const updated = ot.run(
        "UPDATE content_reports SET status = ?, reviewer_id = ?, resolution = ?, updated = ? WHERE workspace_id = ? AND id = ? AND status = 'pending'",
        status, me.ownerId, resolution, now, workspaceId, reportId,
      );
      if (updated.changes !== 1) {
        const current = ot.get<any>("SELECT * FROM content_reports WHERE workspace_id = ? AND id = ?", workspaceId, reportId);
        assert(current && current.status === status, 409, "conflict", "report was resolved concurrently");
        return reportView(current);
      }
      ot.run(
        "INSERT INTO moderation_actions(id, report_id, actor_id, action, notes, created) VALUES (?,?,?,?,?,?)",
        newId("otma"), reportId, me.ownerId, action ?? status, resolution, now,
      );
      return reportView(ot.get<any>("SELECT * FROM content_reports WHERE id = ?", reportId));
    });
  });
}
