// OpenTeamily teams, members, invites, join requests and the team directory, shared through Bot Social.
// Ported from the legacy server modules members.py, teams.py, invites.py and team_directory.py: roles
// owner/admin/member, suspension, invite links with role/expiry/uses/approval/freeze, join-request queue,
// listed teams searchable by every signed-in member. OpenTeamily semantics; not Teamily parity.
import type { FastifyInstance } from "fastify";
import { assert } from "../errors.js";
import { randomBytes } from "node:crypto";
import { newId } from "../ids.js";
import { body, hashCode, intParam, one, OtContext, optText, params, query, secretCode, text } from "./core.js";

export const TEAMS_SCHEMA = `
CREATE TABLE IF NOT EXISTS ot_teams (
  id TEXT PRIMARY KEY, slug TEXT UNIQUE, name TEXT NOT NULL, owner_id TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '', listed INTEGER NOT NULL DEFAULT 0, directory_invite_id TEXT,
  workspace_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ot_teams_workspace ON ot_teams(workspace_id) WHERE workspace_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS ot_workspace_requests (
  owner_id TEXT NOT NULL, key_hash TEXT NOT NULL, request_hash TEXT NOT NULL, team_id TEXT NOT NULL,
  created_at INTEGER NOT NULL, PRIMARY KEY (owner_id, key_hash)
);
CREATE TABLE IF NOT EXISTS ot_team_members (
  team_id TEXT NOT NULL REFERENCES ot_teams(id) ON DELETE CASCADE, owner_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','member')), suspended INTEGER NOT NULL DEFAULT 0,
  added_by TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (team_id, owner_id)
);
CREATE INDEX IF NOT EXISTS ot_team_members_owner ON ot_team_members(owner_id, team_id);
CREATE TABLE IF NOT EXISTS ot_invites (
  id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES ot_teams(id) ON DELETE CASCADE, code_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('admin','member')), expires_at INTEGER NOT NULL, max_uses INTEGER NOT NULL,
  use_count INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0, frozen INTEGER NOT NULL DEFAULT 0,
  requires_approval INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ot_join_requests (
  id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES ot_teams(id) ON DELETE CASCADE, owner_id TEXT NOT NULL,
  invite_id TEXT, role TEXT NOT NULL CHECK (role IN ('admin','member')),
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')),
  created_at INTEGER NOT NULL, decided_at INTEGER, decided_by TEXT, UNIQUE (team_id, owner_id)
);
`;

const SLUG = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;
const RESERVED = new Set(["admin", "api", "automations", "docs", "health", "invite", "invites", "login", "logout", "me", "members", "new", "settings", "static", "team", "teams", "v1", "workspaces"]);
const DAY = 86_400_000;

export function roleOf(ot: OtContext, teamId: string, ownerId: string): { role: string; suspended: boolean } | undefined {
  const row = ot.get<any>("SELECT role, suspended FROM ot_team_members WHERE team_id = ? AND owner_id = ?", teamId, ownerId);
  return row ? { role: row.role, suspended: !!row.suspended } : undefined;
}

/** An active (not suspended) member of the team, else 404 so non-members learn nothing. */
export function requireMember(ot: OtContext, teamId: string, ownerId: string, roles?: string[]) {
  const team = ot.get<any>("SELECT * FROM ot_teams WHERE id = ?", teamId);
  const r = team ? roleOf(ot, teamId, ownerId) : undefined;
  assert(team && r && !r.suspended, 404, "team_not_found", "no such team");
  if (roles) assert(roles.includes(r.role), 403, "forbidden", "your role in this team cannot do that");
  return { team, role: r.role };
}

/** True when two owners are active members of at least one common team. */
export function shareTeam(ot: OtContext, a: string, b: string) {
  return !!ot.get("SELECT 1 FROM ot_team_members x JOIN ot_team_members y ON x.team_id = y.team_id WHERE x.owner_id = ? AND y.owner_id = ? AND x.suspended = 0 AND y.suspended = 0", a, b);
}

const teamView = (ot: OtContext, t: any, viewer: string) => ({
  id: t.id, slug: t.slug, name: t.name, summary: t.summary, listed: !!t.listed,
  workspace_id: t.workspace_id ?? null,
  owner: ot.profileView(t.owner_id), role: roleOf(ot, t.id, viewer)?.role ?? null,
  member_count: ot.get<any>("SELECT COUNT(*) AS n FROM ot_team_members WHERE team_id = ?", t.id).n,
  created_at: t.created_at, updated_at: t.updated_at,
});
const memberView = (ot: OtContext, m: any) => ({ ...ot.profileView(m.owner_id), role: m.role, suspended: !!m.suspended, joined_at: m.created_at });
const inviteView = (i: any) => ({
  id: i.id, team_id: i.team_id, role: i.role, expires_at: i.expires_at, max_uses: i.max_uses, use_count: i.use_count,
  revoked: !!i.revoked, frozen: !!i.frozen, requires_approval: !!i.requires_approval, created_at: i.created_at,
});
const requestView = (ot: OtContext, r: any) => ({ id: r.id, team_id: r.team_id, member: ot.profileView(r.owner_id), role: r.role, status: r.status, created_at: r.created_at, decided_at: r.decided_at });

function addMember(ot: OtContext, teamId: string, ownerId: string, role: string, by: string) {
  ot.run("INSERT OR IGNORE INTO ot_team_members(team_id, owner_id, role, added_by, created_at) VALUES (?,?,?,?,?)", teamId, ownerId, role, by, ot.now());
}

function notifyAdmins(ot: OtContext, teamId: string, kind: string, data: Record<string, unknown>) {
  for (const a of ot.all<any>("SELECT owner_id FROM ot_team_members WHERE team_id = ? AND role IN ('owner','admin') AND suspended = 0", teamId)) ot.notify(a.owner_id, kind, data);
}

function usable(i: any, now: number) { return !i.revoked && !i.frozen && i.expires_at > now && i.use_count < i.max_uses; }

/** Accept an invite (by row) for `ownerId`: direct membership, or a pending request when approval is required. */
function acceptInvite(ot: OtContext, invite: any, ownerId: string) {
  const now = ot.now();
  const existing = roleOf(ot, invite.team_id, ownerId);
  const team = ot.get<any>("SELECT id, name, workspace_id FROM ot_teams WHERE id = ?", invite.team_id);
  if (existing) return { status: existing.suspended ? "suspended" : "member",
    team_id: invite.team_id, workspace_id: team.workspace_id, role: existing.role };
  const prior = invite.requires_approval
    ? ot.get<any>("SELECT * FROM ot_join_requests WHERE team_id = ? AND owner_id = ?", invite.team_id, ownerId)
    : null;
  if (prior?.status === "pending" && prior.invite_id === invite.id) {
    return { status: "pending", team_id: invite.team_id, request_id: prior.id };
  }
  assert(usable(invite, now), 410, "invite_unusable", "this invite has expired, been used up, paused or revoked");
  if (invite.requires_approval) {
    if (prior?.status === "pending") return { status: "pending", team_id: invite.team_id, request_id: prior.id };
    const id = prior?.id ?? newId("otjr");
    ot.run("INSERT INTO ot_join_requests(id, team_id, owner_id, invite_id, role, status, created_at) VALUES (?,?,?,?,?,'pending',?) ON CONFLICT(team_id, owner_id) DO UPDATE SET status = 'pending', invite_id = excluded.invite_id, role = excluded.role, created_at = excluded.created_at, decided_at = NULL, decided_by = NULL",
      id, invite.team_id, ownerId, invite.id, invite.role, now);
    ot.run("UPDATE ot_invites SET use_count = use_count + 1 WHERE id = ?", invite.id);
    notifyAdmins(ot, invite.team_id, "team.join_request", { team_id: team.id, team_name: team.name, request_id: id, member: ot.profileView(ownerId) });
    return { status: "pending", team_id: invite.team_id, request_id: id };
  }
  addMember(ot, invite.team_id, ownerId, invite.role, invite.created_by);
  ot.run("UPDATE ot_invites SET use_count = use_count + 1 WHERE id = ?", invite.id);
  notifyAdmins(ot, invite.team_id, "team.member_joined", { team_id: team.id, team_name: team.name, member: ot.profileView(ownerId) });
  return { status: "member", team_id: invite.team_id, workspace_id: team.workspace_id, role: invite.role };
}

function createInvite(ot: OtContext, teamId: string, by: string, b: any) {
  const role = b.role ?? "member";
  assert(role === "member" || role === "admin", 400, "invalid_request", "role must be member or admin");
  const ttlDays = b.ttl_days ?? 7;
  assert(Number.isInteger(ttlDays) && ttlDays >= 1 && ttlDays <= 30, 400, "invalid_request", "ttl_days must be 1-30");
  const maxUses = b.max_uses ?? 10;
  assert(Number.isInteger(maxUses) && maxUses >= 1 && maxUses <= 100, 400, "invalid_request", "max_uses must be 1-100");
  const code = secretCode();
  const id = newId("oti");
  ot.run("INSERT INTO ot_invites(id, team_id, code_hash, role, expires_at, max_uses, requires_approval, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    id, teamId, hashCode(code), role, ot.now() + ttlDays * DAY, maxUses, b.requires_approval ? 1 : 0, by, ot.now());
  return { invite: inviteView(ot.get("SELECT * FROM ot_invites WHERE id = ?", id)), code };
}

const WORKSPACE = /^[0-9a-f]{32}$/;
function workspaceIdOf(raw: unknown, required = true) {
  if (raw === undefined || raw === null || raw === "") {
    assert(!required, 400, "invalid_request", "workspace_id must be a 32-character hex id");
    return null;
  }
  assert(typeof raw === "string" && WORKSPACE.test(raw), 400, "invalid_request", "workspace_id must be a 32-character hex id");
  return raw;
}

function ensureTeamColumns(ot: OtContext) {
  const cols = new Set(ot.all<any>("PRAGMA table_info(ot_teams)").map((c) => c.name));
  if (!cols.has("workspace_id")) ot.run("ALTER TABLE ot_teams ADD COLUMN workspace_id TEXT");
  ot.run("CREATE UNIQUE INDEX IF NOT EXISTS ot_teams_workspace ON ot_teams(workspace_id) WHERE workspace_id IS NOT NULL");
}

function insertTeam(ot: OtContext, meOwnerId: string, { name, slug, summary, workspaceId }: { name: string; slug: string | null; summary: string; workspaceId: string | null }) {
  if (workspaceId) assert(!ot.get("SELECT 1 FROM ot_teams WHERE workspace_id = ?", workspaceId), 409, "workspace_bound", "that workspace already has a team");
  assert(ot.get<any>("SELECT COUNT(*) AS n FROM ot_teams WHERE owner_id = ?", meOwnerId).n < 50, 429, "too_many_teams", "an account can own at most 50 teams");
  const id = newId("ott");
  const now = ot.now();
  ot.tx(() => {
    ot.run("INSERT INTO ot_teams(id, slug, name, owner_id, summary, workspace_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)", id, slug, name, meOwnerId, summary, workspaceId, now, now);
    addMember(ot, id, meOwnerId, "owner", meOwnerId);
  });
  return ot.get<any>("SELECT * FROM ot_teams WHERE id = ?", id);
}

export function registerTeams(app: FastifyInstance, ot: OtContext) {
  ensureTeamColumns(ot);
  // ---- teams
  // Bind a platform workspace (32-hex id) to one Bot Social team so page /v1 shims
  // can keep using workspace ids. Browser credentials are not authority to claim
  // platform ownership: only resolve preverified mappings; never create on read.
  app.post("/v1/ot/teams/ensure", async (req, reply) => {
    const me = ot.me(req);
    const b = body(req);
    const workspaceId = workspaceIdOf(b.workspace_id);
    const existing = ot.get<any>("SELECT * FROM ot_teams WHERE workspace_id = ?", workspaceId);
    if (existing) {
      const { team } = requireMember(ot, existing.id, me.ownerId);
      return teamView(ot, team, me.ownerId);
    }
    assert(false, 409, "membership_migration_required", "workspace binding requires verified platform membership migration");
  });
  app.get("/v1/ot/teams/by-workspace/:workspace_id", async (req) => {
    const me = ot.me(req);
    const workspaceId = workspaceIdOf(params(req).workspace_id);
    const existing = ot.get<any>("SELECT * FROM ot_teams WHERE workspace_id = ?", workspaceId);
    assert(existing, 404, "team_not_found", "no such team");
    const { team } = requireMember(ot, existing.id, me.ownerId);
    return teamView(ot, team, me.ownerId);
  });
  app.post("/v1/ot/teams", async (req, reply) => {
    const me = ot.me(req);
    const b = body(req);
    const name = text(b.name, "name", { min: 1, max: 60 });
    const slug = b.slug === undefined || b.slug === null || b.slug === "" ? null : String(b.slug);
    if (slug !== null) {
      assert(SLUG.test(slug) && !RESERVED.has(slug), 400, "invalid_request", "team id must be 3-30 lowercase letters, digits or dashes");
      assert(!ot.get("SELECT 1 FROM ot_teams WHERE slug = ?", slug), 409, "slug_taken", "that team id is taken");
    }
    const summary = optText(b.summary, "summary", { max: 200 }) ?? "";
    const workspaceId = workspaceIdOf(b.workspace_id, false);
    assert(workspaceId === null, 409, "membership_migration_required", "workspace binding requires verified platform membership migration");
    const team = insertTeam(ot, me.ownerId, { name, slug, summary, workspaceId });
    return reply.status(201).send(teamView(ot, team, me.ownerId));
  });
  // ---- workspaces (replaces platform GET/POST /v1/workspaces and POST /v1/teams)
  // Every OpenTeamily workspace is a Bot Social team with a 32-hex workspace_id. New ids
  // are generated here, so creating one never claims an existing platform workspace.
  const workspaceView = (t: any, viewer: string) => ({ ...teamView(ot, t, viewer), kind: t.slug ? "team" : "workspace" });
  app.get("/v1/ot/workspaces", async (req) => {
    const me = ot.me(req);
    const rows = ot.all<any>("SELECT t.* FROM ot_teams t JOIN ot_team_members m ON m.team_id = t.id WHERE m.owner_id = ? AND m.suspended = 0 ORDER BY t.created_at, t.id", me.ownerId);
    for (const t of rows) {
      if (t.workspace_id) continue;
      // Native teams get a fresh random id so workspace-keyed pages can address them.
      t.workspace_id = randomBytes(16).toString("hex");
      ot.run("UPDATE ot_teams SET workspace_id = ? WHERE id = ? AND workspace_id IS NULL", t.workspace_id, t.id);
    }
    return { workspaces: rows.map((t) => workspaceView(t, me.ownerId)) };
  });
  app.post("/v1/ot/workspaces", async (req, reply) => {
    const me = ot.me(req);
    const b = body(req);
    const name = text(b.name, "name", { min: 1, max: 80 });
    const slug = b.slug === undefined || b.slug === null || b.slug === "" ? null : String(b.slug);
    if (slug !== null) assert(SLUG.test(slug) && !RESERVED.has(slug), 400, "invalid_request", "team id must be 3-30 lowercase letters, digits or dashes");
    const key = text(b.idempotency_key, "idempotency_key", { min: 16, max: 64 });
    const keyHash = hashCode("ws:" + key);
    const requestHash = hashCode(JSON.stringify([name, slug]));
    const prior = ot.get<any>("SELECT * FROM ot_workspace_requests WHERE owner_id = ? AND key_hash = ?", me.ownerId, keyHash);
    if (prior) {
      assert(prior.request_hash === requestHash, 409, "conflict", "idempotency key was used for a different request");
      const team = ot.get<any>("SELECT * FROM ot_teams WHERE id = ?", prior.team_id);
      assert(team, 404, "team_not_found", "no such team");
      return workspaceView(team, me.ownerId);
    }
    if (slug !== null) assert(!ot.get("SELECT 1 FROM ot_teams WHERE slug = ?", slug), 409, "slug_taken", "that team id is taken");
    const team = insertTeam(ot, me.ownerId, { name, slug, summary: "", workspaceId: randomBytes(16).toString("hex") });
    ot.run("INSERT INTO ot_workspace_requests(owner_id, key_hash, request_hash, team_id, created_at) VALUES (?,?,?,?,?)", me.ownerId, keyHash, requestHash, team.id, ot.now());
    return reply.status(201).send(workspaceView(team, me.ownerId));
  });
  // Turn an existing workspace into a named team (legacy POST /v1/teams mode=convert).
  app.post("/v1/ot/workspaces/:workspace_id/convert", async (req) => {
    const me = ot.me(req);
    const existing = ot.get<any>("SELECT * FROM ot_teams WHERE workspace_id = ?", workspaceIdOf(params(req).workspace_id));
    assert(existing, 404, "team_not_found", "no such team");
    const { team } = requireMember(ot, existing.id, me.ownerId, ["owner"]);
    const b = body(req);
    const name = text(b.name, "name", { min: 1, max: 60 });
    const slug = String(b.slug ?? "");
    assert(SLUG.test(slug) && !RESERVED.has(slug), 400, "invalid_request", "team id must be 3-30 lowercase letters, digits or dashes");
    if (team.slug === slug) return workspaceView(team, me.ownerId);
    assert(!team.slug, 409, "conflict", "this workspace is already a team");
    assert(!ot.get("SELECT 1 FROM ot_teams WHERE slug = ?", slug), 409, "slug_taken", "that team id is taken");
    ot.run("UPDATE ot_teams SET slug = ?, name = ?, updated_at = ? WHERE id = ?", slug, name, ot.now(), team.id);
    return workspaceView(ot.get("SELECT * FROM ot_teams WHERE id = ?", team.id), me.ownerId);
  });
  app.get("/v1/ot/teams", async (req) => {
    const me = ot.me(req);
    const rows = ot.all<any>("SELECT t.* FROM ot_teams t JOIN ot_team_members m ON m.team_id = t.id WHERE m.owner_id = ? AND m.suspended = 0 ORDER BY t.created_at, t.id", me.ownerId);
    return { teams: rows.map((t) => teamView(ot, t, me.ownerId)) };
  });
  app.get("/v1/ot/teams/:id", async (req) => {
    const me = ot.me(req);
    const { team } = requireMember(ot, params(req).id, me.ownerId);
    return teamView(ot, team, me.ownerId);
  });
  app.patch("/v1/ot/teams/:id", async (req) => {
    const me = ot.me(req);
    const { team } = requireMember(ot, params(req).id, me.ownerId, ["owner", "admin"]);
    const b = body(req);
    const name = optText(b.name, "name", { min: 1, max: 60 });
    const summary = optText(b.summary, "summary", { max: 200 });
    ot.run("UPDATE ot_teams SET name = COALESCE(?, name), summary = COALESCE(?, summary), updated_at = ? WHERE id = ?", name ?? null, summary ?? null, ot.now(), team.id);
    return teamView(ot, ot.get("SELECT * FROM ot_teams WHERE id = ?", team.id), me.ownerId);
  });
  app.delete("/v1/ot/teams/:id", async (req) => {
    const me = ot.me(req);
    const { team } = requireMember(ot, params(req).id, me.ownerId, ["owner"]);
    ot.tx(() => {
      for (const t of ["ot_join_requests", "ot_invites", "ot_team_members"]) ot.run(`DELETE FROM ${t} WHERE team_id = ?`, team.id);
      ot.run("DELETE FROM ot_teams WHERE id = ?", team.id);
    });
    return { deleted: true };
  });

  // ---- members
  app.get("/v1/ot/teams/:id/members", async (req) => {
    const me = ot.me(req);
    const { team, role } = requireMember(ot, params(req).id, me.ownerId);
    const rows = ot.all<any>("SELECT * FROM ot_team_members WHERE team_id = ? ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, created_at", team.id);
    // Suspended members are listed to owners/admins only (legacy behaviour).
    return { role, members: rows.filter((m) => role !== "member" || !m.suspended).map((m) => memberView(ot, m)) };
  });
  app.post("/v1/ot/teams/:id/members", async (req, reply) => {
    const me = ot.me(req);
    const { team, role } = requireMember(ot, params(req).id, me.ownerId, ["owner", "admin"]);
    const b = body(req);
    const target = ot.ownerByHandle(b.handle ?? b.username);
    const addRole = b.role ?? "member";
    assert(addRole === "admin" || addRole === "member", 400, "invalid_request", "role must be admin or member");
    assert(role === "owner" || addRole === "member", 403, "forbidden", "admins can only add members");
    const current = roleOf(ot, team.id, target);
    if (current) {
      assert(current.role === addRole, 409, "conflict", "member already exists with a different role");
      return memberView(ot, ot.get("SELECT * FROM ot_team_members WHERE team_id = ? AND owner_id = ?", team.id, target));
    }
    addMember(ot, team.id, target, addRole, me.ownerId);
    ot.notify(target, "team.membership_changed", { team_id: team.id, team_name: team.name });
    return reply.status(201).send(memberView(ot, ot.get("SELECT * FROM ot_team_members WHERE team_id = ? AND owner_id = ?", team.id, target)));
  });
  app.patch("/v1/ot/teams/:id/members/:handle", async (req) => {
    const me = ot.me(req);
    const { team, role } = requireMember(ot, params(req).id, me.ownerId, ["owner", "admin"]);
    const target = ot.ownerByHandle(params(req).handle);
    const current = roleOf(ot, team.id, target);
    assert(current, 404, "member_not_found", "not a member of this team");
    assert(current.role !== "owner", 403, "forbidden", "the team owner cannot be changed");
    assert(target !== me.ownerId, 403, "forbidden", "you cannot change your own membership here");
    const b = body(req);
    if (b.role !== undefined) {
      assert(b.role === "admin" || b.role === "member", 400, "invalid_request", "role must be admin or member");
      assert(role === "owner", 403, "forbidden", "only the team owner changes roles");
      ot.run("UPDATE ot_team_members SET role = ? WHERE team_id = ? AND owner_id = ?", b.role, team.id, target);
    }
    if (b.suspended !== undefined) {
      assert(typeof b.suspended === "boolean", 400, "invalid_request", "suspended must be true or false");
      assert(role === "owner" || current.role === "member", 403, "forbidden", "admins can suspend members only");
      ot.run("UPDATE ot_team_members SET suspended = ? WHERE team_id = ? AND owner_id = ?", b.suspended ? 1 : 0, team.id, target);
    }
    ot.notify(target, "team.membership_changed", { team_id: team.id, team_name: team.name });
    return memberView(ot, ot.get("SELECT * FROM ot_team_members WHERE team_id = ? AND owner_id = ?", team.id, target));
  });
  app.delete("/v1/ot/teams/:id/members/:handle", async (req) => {
    const me = ot.me(req);
    const teamId = params(req).id;
    const target = ot.ownerByHandle(params(req).handle);
    if (target === me.ownerId) {
      const r = roleOf(ot, teamId, me.ownerId);
      assert(r, 404, "team_not_found", "no such team");
      assert(r.role !== "owner", 409, "owner_cannot_leave", "the owner cannot leave; delete the team instead");
    } else {
      const { role } = requireMember(ot, teamId, me.ownerId, ["owner", "admin"]);
      const current = roleOf(ot, teamId, target);
      assert(current, 404, "member_not_found", "not a member of this team");
      assert(current.role !== "owner" && (role === "owner" || current.role === "member"), 403, "forbidden", "your role cannot remove this member");
      ot.notify(target, "team.removed", { team_id: teamId });
    }
    ot.run("DELETE FROM ot_team_members WHERE team_id = ? AND owner_id = ?", teamId, target);
    return { removed: true };
  });

  // ---- invites
  app.post("/v1/ot/teams/:id/invites", async (req, reply) => {
    const me = ot.me(req);
    const { team } = requireMember(ot, params(req).id, me.ownerId, ["owner", "admin"]);
    return reply.status(201).send(createInvite(ot, team.id, me.ownerId, body(req)));
  });
  app.get("/v1/ot/teams/:id/invites", async (req) => {
    const me = ot.me(req);
    const { team } = requireMember(ot, params(req).id, me.ownerId, ["owner", "admin"]);
    return { invites: ot.all<any>("SELECT * FROM ot_invites WHERE team_id = ? ORDER BY created_at DESC", team.id).map(inviteView) };
  });
  app.patch("/v1/ot/teams/:id/invites/:invite", async (req) => {
    const me = ot.me(req);
    const { team } = requireMember(ot, params(req).id, me.ownerId, ["owner", "admin"]);
    const inv = ot.get<any>("SELECT * FROM ot_invites WHERE id = ? AND team_id = ?", params(req).invite, team.id);
    assert(inv, 404, "invite_not_found", "no such invite");
    const b = body(req);
    if (b.frozen !== undefined) { assert(typeof b.frozen === "boolean", 400, "invalid_request", "frozen must be true or false"); ot.run("UPDATE ot_invites SET frozen = ? WHERE id = ?", b.frozen ? 1 : 0, inv.id); }
    if (b.revoked === true) ot.run("UPDATE ot_invites SET revoked = 1 WHERE id = ?", inv.id);
    return inviteView(ot.get("SELECT * FROM ot_invites WHERE id = ?", inv.id));
  });
  app.post("/v1/ot/invites/preview", async (req) => {
    ot.me(req);
    const code = text(body(req).code, "code", { min: 16, max: 128 });
    const inv = ot.get<any>("SELECT * FROM ot_invites WHERE code_hash = ?", hashCode(code));
    assert(inv, 404, "invite_not_found", "no such invite");
    const team = ot.get<any>("SELECT * FROM ot_teams WHERE id = ?", inv.team_id);
    return { team: { id: team.id, name: team.name, summary: team.summary, owner: ot.profileView(team.owner_id) }, role: inv.role, requires_approval: !!inv.requires_approval, usable: usable(inv, ot.now()), expires_at: inv.expires_at };
  });
  app.post("/v1/ot/invites/accept", async (req) => {
    const me = ot.me(req);
    const code = text(body(req).code, "code", { min: 16, max: 128 });
    const inv = ot.get<any>("SELECT * FROM ot_invites WHERE code_hash = ?", hashCode(code));
    assert(inv, 404, "invite_not_found", "no such invite");
    return ot.tx(() => acceptInvite(ot, inv, me.ownerId));
  });

  // ---- join requests
  app.get("/v1/ot/teams/:id/join-requests", async (req) => {
    const me = ot.me(req);
    const { team } = requireMember(ot, params(req).id, me.ownerId, ["owner", "admin"]);
    const status = one(query(req).status, "status") ?? "pending";
    return { requests: ot.all<any>("SELECT * FROM ot_join_requests WHERE team_id = ? AND status = ? ORDER BY created_at", team.id, status).map((r) => requestView(ot, r)) };
  });
  app.post("/v1/ot/teams/:id/join-requests/:request", async (req) => {
    const me = ot.me(req);
    const { team } = requireMember(ot, params(req).id, me.ownerId, ["owner", "admin"]);
    const decision = body(req).decision;
    assert(decision === "approve" || decision === "reject", 400, "invalid_request", "decision must be approve or reject");
    return ot.tx(() => {
      const r = ot.get<any>("SELECT * FROM ot_join_requests WHERE id = ? AND team_id = ?", params(req).request, team.id);
      assert(r, 404, "request_not_found", "no such join request");
      assert(r.status === "pending", 409, "already_decided", "this request was already decided");
      ot.run("UPDATE ot_join_requests SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?", decision === "approve" ? "approved" : "rejected", ot.now(), me.ownerId, r.id);
      if (decision === "approve") addMember(ot, team.id, r.owner_id, r.role, me.ownerId);
      ot.notify(r.owner_id, "team.join_decided", { team_id: team.id, team_name: team.name, decision });
      return requestView(ot, ot.get("SELECT * FROM ot_join_requests WHERE id = ?", r.id));
    });
  });
  app.get("/v1/ot/join-requests/mine", async (req) => {
    const me = ot.me(req);
    const rows = ot.all<any>("SELECT r.*, t.name AS team_name FROM ot_join_requests r JOIN ot_teams t ON t.id = r.team_id WHERE r.owner_id = ? ORDER BY r.created_at DESC LIMIT 100", me.ownerId);
    return { requests: rows.map((r) => ({ ...requestView(ot, r), team_name: r.team_name })) };
  });

  // ---- directory
  app.put("/v1/ot/teams/:id/listing", async (req) => {
    const me = ot.me(req);
    const { team } = requireMember(ot, params(req).id, me.ownerId, ["owner", "admin"]);
    const b = body(req);
    assert(typeof b.listed === "boolean", 400, "invalid_request", "listed must be true or false");
    const summary = optText(b.summary, "summary", { max: 200 });
    ot.tx(() => {
      let inviteId = team.directory_invite_id;
      if (b.listed && !inviteId) {
        // Directory joins always go through the approval queue, backed by an invite the listing owns.
        inviteId = createInvite(ot, team.id, me.ownerId, { role: "member", ttl_days: 30, max_uses: 100, requires_approval: true }).invite.id;
      }
      ot.run("UPDATE ot_teams SET listed = ?, summary = COALESCE(?, summary), directory_invite_id = ?, updated_at = ? WHERE id = ?", b.listed ? 1 : 0, summary ?? null, inviteId ?? null, ot.now(), team.id);
    });
    return teamView(ot, ot.get("SELECT * FROM ot_teams WHERE id = ?", team.id), me.ownerId);
  });
  app.get("/v1/ot/directory", async (req) => {
    const me = ot.me(req);
    const q = (one(query(req).q, "q") ?? "").trim().toLowerCase().slice(0, 60);
    const limit = intParam(query(req).limit, "limit", 30, 100);
    const like = `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
    const rows = ot.all<any>("SELECT t.* FROM ot_teams t WHERE t.listed = 1 AND (lower(t.name) LIKE ? ESCAPE '\\' OR lower(t.summary) LIKE ? ESCAPE '\\') ORDER BY (SELECT COUNT(*) FROM ot_team_members m WHERE m.team_id = t.id) DESC, t.updated_at DESC LIMIT ?", like, like, limit);
    return {
      teams: rows.map((t) => {
        const r = roleOf(ot, t.id, me.ownerId);
        const pending = ot.get<any>("SELECT status FROM ot_join_requests WHERE team_id = ? AND owner_id = ?", t.id, me.ownerId);
        const v = teamView(ot, t, me.ownerId);
        return { id: v.id, name: v.name, summary: v.summary, member_count: v.member_count, updated_at: v.updated_at, membership: r?.suspended ? "suspended" : r ? "member" : pending?.status === "pending" ? "pending" : null };
      }),
    };
  });
  app.post("/v1/ot/directory/:id/join", async (req) => {
    const me = ot.me(req);
    const team = ot.get<any>("SELECT * FROM ot_teams WHERE id = ? AND listed = 1", params(req).id);
    assert(team && team.directory_invite_id, 404, "team_not_found", "no such listed team");
    const inv = ot.get<any>("SELECT * FROM ot_invites WHERE id = ?", team.directory_invite_id);
    assert(inv, 404, "team_not_found", "no such listed team");
    // A spent directory invite is renewed rather than refusing new joiners.
    return ot.tx(() => {
      let use = inv;
      if (!usable(inv, ot.now()) && !inv.revoked && !inv.frozen) {
        use = ot.get("SELECT * FROM ot_invites WHERE id = ?", createInvite(ot, team.id, team.owner_id, { role: "member", ttl_days: 30, max_uses: 100, requires_approval: true }).invite.id);
        ot.run("UPDATE ot_teams SET directory_invite_id = ? WHERE id = ?", use.id, team.id);
      }
      return acceptInvite(ot, use, me.ownerId);
    });
  });
}
