import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { assert } from "../errors.js";
import { body, hashCode, one, params, query, text, type OtContext } from "./core.js";
import { MEETING_RECIPIENT_FROM, MEETING_RECIPIENT_VISIBLE } from "./meeting-receipt-access.js";
import { accountConversation, fixedPublicThread, requireDirectReach, workspaceConversation, workspaceTeam } from "./messenger.js";

export const MEETING_SHARES_SCHEMA = `
CREATE TABLE IF NOT EXISTS ot_meeting_shares (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, workspace_id TEXT,
  conversation_id TEXT NOT NULL REFERENCES ot_conversations(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL, source_id TEXT NOT NULL, client_key TEXT NOT NULL, request_hash TEXT NOT NULL,
  revision INTEGER NOT NULL, title TEXT NOT NULL, started_at INTEGER NOT NULL,
  organizer TEXT NOT NULL, summary TEXT NOT NULL, action_items TEXT NOT NULL,
  action_count INTEGER NOT NULL, done_count INTEGER NOT NULL, created INTEGER NOT NULL, revoked_at INTEGER,
  UNIQUE (sender_id, client_key)
);
CREATE INDEX IF NOT EXISTS ot_meeting_shares_source
  ON ot_meeting_shares(sender_id, workspace_id, source_id, seq);
CREATE INDEX IF NOT EXISTS ot_meeting_shares_sender
  ON ot_meeting_shares(sender_id, workspace_id, seq);
CREATE TABLE IF NOT EXISTS ot_meeting_share_recipients (
  share_id TEXT NOT NULL REFERENCES ot_meeting_shares(id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL, display_name TEXT NOT NULL, PRIMARY KEY (share_id, recipient_id)
);
CREATE INDEX IF NOT EXISTS ot_meeting_share_recipients_owner
  ON ot_meeting_share_recipients(recipient_id, share_id);
`;

type Scope = { workspace: string | null; owner: string };
type Recipient = { id: string; name: string };
type ShareHeader = {
  id: string; title: string; revision: number; started_at: number; organizer: string;
  action_count: number; done_count: number; created: number;
};
type Share = ShareHeader & {
  sender_id: string; summary: string; action_items: string; request_hash: string; revoked_at: number | null;
};
const HEX = /^[0-9a-f]{32}$/;
const SOCIAL_ID = /^[A-Za-z0-9._-]{1,80}$/;
const KEY = /^[A-Za-z0-9_-]{16,64}$/;
const CREATE_FIELDS = ["conversation_id", "recipient_ids", "source_id", "revision", "title",
  "started_at", "summary", "action_items", "client_key"];
const LIST_FIELDS = "s.id,s.title,s.revision,s.started_at,s.organizer,s.action_count,s.done_count,s.created";

function object(value: unknown, keys: string[]): Record<string, unknown> {
  assert(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every(key => keys.includes(key)), 400, "invalid_request", "Unexpected meeting share fields");
  return value as Record<string, unknown>;
}

function identifier(value: unknown, pattern: RegExp, name: string): string {
  assert(typeof value === "string" && pattern.test(value), 400, "invalid_request", `Invalid ${name}`);
  return value;
}

function integer(value: unknown, name: string, min: number, max = Number.MAX_SAFE_INTEGER) {
  assert(typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max,
    400, "invalid_request", `Invalid ${name}`);
  return value;
}

function trimmed(value: unknown, name: string, min: number, max: number) {
  return text(typeof value === "string" ? value.trim() : value, name, { min, max, multiline: true });
}

function snapshot(input: unknown) {
  const b = object(input, CREATE_FIELDS);
  assert(Array.isArray(b.recipient_ids) && b.recipient_ids.length > 0 && b.recipient_ids.length <= 50,
    400, "invalid_request", "Select 1 to 50 conversation members");
  const recipientIds = b.recipient_ids.map(value => identifier(value, SOCIAL_ID, "recipient")).sort();
  assert(new Set(recipientIds).size === recipientIds.length, 400, "invalid_request", "Select each recipient once");
  assert(Array.isArray(b.action_items) && b.action_items.length <= 50, 400, "invalid_request", "Invalid action_items");
  const actions = b.action_items.map(value => {
    const action = object(value, ["text", "done", "owner"]);
    assert(action.done === undefined || typeof action.done === "boolean", 400, "invalid_request", "Invalid action status");
    return { text: trimmed(action.text, "action text", 1, 500), owner: trimmed(action.owner ?? "", "action owner", 0, 80),
      done: action.done ?? false };
  });
  const summary = text(b.summary, "summary", { max: 8000, multiline: true });
  assert(summary.trim() || actions.length, 400, "invalid_request", "Save a summary or an action item before sharing");
  return {
    conversationId: identifier(b.conversation_id, SOCIAL_ID, "conversation"),
    sourceId: identifier(b.source_id, HEX, "source_id"),
    key: identifier(b.client_key, KEY, "client_key"),
    recipientIds,
    revision: integer(b.revision, "revision", 1), title: trimmed(b.title, "title", 1, 120),
    started: integer(b.started_at, "started_at", 0, 4102444800),
    summary, actions,
  };
}

function recipients(ot: OtContext, scope: Scope, conversationId: string): Recipient[] {
  const { workspace, owner } = scope;
  const { conv, directPeer } = workspace
    ? workspaceConversation(ot, workspace, conversationId, owner)
    : { conv: accountConversation(ot, conversationId, owner), directPeer: undefined };
  assert(!fixedPublicThread(conv), 404, "conversation_not_found", "No conversation for meeting sharing");
  requireDirectReach(ot, conv, owner);
  let eligibility = "";
  const bindings: string[] = [conv.id, owner];
  if (directPeer) {
    eligibility = "AND m.owner_id=?";
    bindings.push(directPeer);
  } else if (conv.team_id) {
    eligibility = `AND EXISTS (SELECT 1 FROM ot_team_members teammate
      WHERE teammate.team_id=? AND teammate.owner_id=m.owner_id AND teammate.suspended=0)`;
    bindings.push(conv.team_id);
  }
  return ot.all<Recipient>(`SELECT p.owner_id AS id,p.display_name AS name FROM ot_conversation_members m
    JOIN ot_profiles p ON p.owner_id=m.owner_id WHERE m.conversation_id=? AND m.owner_id<>? ${eligibility}
    ORDER BY p.display_name COLLATE NOCASE,p.owner_id`, ...bindings);
}

function recipientAccess(ot: OtContext, { workspace, owner }: Scope) {
  if (workspace) workspaceTeam(ot, workspace, owner);
  return {
    from: `${MEETING_RECIPIENT_FROM}
      WHERE addressed.recipient_id=? AND s.workspace_id IS ? AND ${MEETING_RECIPIENT_VISIBLE}`,
    bindings: [owner, workspace],
  };
}

function header({ id, title, revision, started_at, created, organizer, action_count, done_count }: ShareHeader) {
  return { id, title, revision, started_at, created, organizer, action_count, done_count, shared: true };
}

function detail(row: Share) {
  return { ...header(row), summary: row.summary, action_items: JSON.parse(row.action_items) };
}

function list(ot: OtContext, req: FastifyRequest, scope: Scope) {
  const q = object(query(req), ["source_id", "sent", "cursor", "limit"]);
  const rawLimit = one(q.limit, "limit") ?? "20";
  const limit = Number(rawLimit);
  assert(/^[0-9]{1,3}$/.test(rawLimit) && limit >= 1 && limit <= 100, 400, "invalid_request", "Invalid limit");
  const cursor = one(q.cursor, "cursor") || null;
  if (cursor) identifier(cursor, HEX, "cursor");
  const source = q.source_id === undefined ? null : identifier(q.source_id, HEX, "source_id");
  const history = one(q.sent, "sent");
  assert(history === undefined || (history === "1" && !source), 400, "invalid_request", "Invalid sent history filter");
  const { workspace, owner } = scope;
  const sent = source || history ? {
    from: `FROM ot_meeting_shares s WHERE s.sender_id=? AND s.workspace_id IS ?${source ? " AND s.source_id=?" : ""}`,
    bindings: [owner, workspace, ...(source ? [source] : [])],
  } : null;
  const addressed = {
    from: `FROM ot_meeting_share_recipients r JOIN ot_meeting_shares s ON s.id=r.share_id
      WHERE r.recipient_id=? AND s.workspace_id IS ?`,
    bindings: [owner, workspace],
  };
  const access = sent ? { ...sent, from: sent.from + " AND s.revoked_at IS NULL" } : recipientAccess(ot, scope);
  const anchor = sent ?? addressed;
  const before = cursor ? ot.get<{ seq: number }>(`SELECT s.seq ${anchor.from} AND s.id=?`, ...anchor.bindings, cursor) : null;
  if (cursor && !before) return { items: [], cursor: null };
  const rows = ot.all<ShareHeader>(`SELECT ${LIST_FIELDS} ${access.from} ${before ? "AND s.seq < ?" : ""}
    ORDER BY s.seq DESC LIMIT ?`, ...access.bindings, ...(before ? [before.seq] : []), limit + 1);
  const items = rows.slice(0, limit).map(row => {
    if (!sent) return header(row);
    const recipients = ot.all<{ display_name: string }>(`SELECT display_name FROM ot_meeting_share_recipients
      WHERE share_id=? ORDER BY display_name COLLATE NOCASE,recipient_id`, row.id).map(recipient => recipient.display_name);
    return { ...header(row), recipients };
  });
  return { items, cursor: rows.length > limit ? items[limit - 1].id : null };
}

function create(ot: OtContext, req: FastifyRequest, scope: Scope, organizer: string) {
  const data = snapshot(body(req));
  const { workspace, owner } = scope;
  const requestHash = hashCode(JSON.stringify([workspace, data]));
  return ot.tx(() => {
    const prior = ot.get<Share>("SELECT * FROM ot_meeting_shares WHERE sender_id=? AND client_key=?", owner, data.key);
    if (prior) {
      assert(prior.request_hash === requestHash, 409, "conflict", "Idempotency key reused");
      assert(prior.revoked_at === null, 409, "conflict", "This share was revoked");
      return { meeting: detail(prior), replayed: true as const };
    }
    const selectable = new Map(recipients(ot, scope, data.conversationId).map(member => [member.id, member.name]));
    assert(data.recipientIds.every(id => selectable.has(id)), 404, "member_not_found", "A recipient is outside the conversation");
    const id = randomBytes(16).toString("hex");
    ot.run(`INSERT INTO ot_meeting_shares(id,workspace_id,conversation_id,sender_id,source_id,client_key,request_hash,
      revision,title,started_at,organizer,summary,action_items,action_count,done_count,created)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, workspace, data.conversationId, owner, data.sourceId, data.key, requestHash, data.revision, data.title,
    data.started, organizer, data.summary, JSON.stringify(data.actions), data.actions.length,
    data.actions.filter(action => action.done).length, Math.floor(ot.now() / 1000));
    for (const recipient of data.recipientIds) {
      ot.run("INSERT INTO ot_meeting_share_recipients(share_id,recipient_id,display_name) VALUES (?,?,?)",
        id, recipient, selectable.get(recipient));
      ot.notify(recipient, "meeting.shared", { share_id: id, title: data.title, organizer,
        ...(workspace ? { workspace_id: workspace } : {}) });
    }
    return { meeting: detail(ot.get<Share>("SELECT * FROM ot_meeting_shares WHERE id=?", id)!) };
  });
}

export function registerMeetingShares(app: FastifyInstance, ot: OtContext) {
  const scopeFor = (req: FastifyRequest, reply: FastifyReply) => {
    reply.header("cache-control", "private, no-store");
    const owner = ot.me(req);
    const workspace = params(req)?.workspace;
    return {
      scope: { workspace: workspace === undefined ? null : identifier(workspace, HEX, "workspace"), owner: owner.ownerId },
      organizer: owner.displayName,
    };
  };
  for (const prefix of ["/v1/ot", "/v1/ot/workspaces/:workspace"]) {
    const root = prefix + "/meeting-shares";
    app.get(prefix + "/meeting-share-recipients", async (req, reply) => {
      const { scope } = scopeFor(req, reply);
      const q = object(query(req), ["conversation_id"]);
      return { items: recipients(ot, scope, identifier(q.conversation_id, SOCIAL_ID, "conversation")) };
    });
    app.get(root, async (req, reply) => list(ot, req, scopeFor(req, reply).scope));
    app.post(root, async (req, reply) => {
      const { scope, organizer } = scopeFor(req, reply);
      const result = create(ot, req, scope, organizer);
      return reply.code(result.replayed ? 200 : 201).send(result);
    });
    app.get(root + "/:id", async (req, reply) => {
      const { scope } = scopeFor(req, reply);
      const id = identifier(params(req).id, HEX, "share id");
      let row = ot.get<Share>(`SELECT * FROM ot_meeting_shares
        WHERE id=? AND workspace_id IS ? AND sender_id=? AND revoked_at IS NULL`, id, scope.workspace, scope.owner);
      if (!row) {
        const access = recipientAccess(ot, scope);
        row = ot.get<Share>(`SELECT s.* ${access.from} AND s.id=?`, ...access.bindings, id);
      }
      assert(row, 404, "not_found", "Meeting share not found");
      return { meeting: detail(row) };
    });
    app.post(root + "/:id/revoke", async (req, reply) => {
      const { scope } = scopeFor(req, reply);
      object(body(req), []);
      const id = identifier(params(req).id, HEX, "share id");
      const result = ot.run(`UPDATE ot_meeting_shares SET revoked_at=COALESCE(revoked_at,?)
        WHERE id=? AND workspace_id IS ? AND sender_id=?`, Math.floor(ot.now() / 1000), id, scope.workspace, scope.owner);
      assert(result.changes, 404, "not_found", "Meeting share not found");
      return { revoked: true };
    });
  }
}
