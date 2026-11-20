// OpenTeamily member messenger on Bot Social: DMs and named groups between members, unread/read
// cursors, reactions, edit/retract, pins, @mentions, and group agents. Ported from the legacy
// social.py. A group agent lives in its owner's own DS-Bot: Bot Social only lists the agent and
// hands its owner's DS-Bot the messages it should answer (agent inbox); the reply is generated in
// that DS-Bot and posted back here. Automatic (un-@'d) group replies are capped at 3 per hour per
// conversation (#346). OpenTeamily semantics; not Teamily parity.
import type { FastifyInstance } from "fastify";
import { assert } from "../errors.js";
import { newId } from "../ids.js";
import { body, handleKey, intParam, OtContext, optText, params, query, text } from "./core.js";
import { shareTeam, requireMember } from "./teams.js";

export const MESSENGER_SCHEMA = `
CREATE TABLE IF NOT EXISTS ot_group_announcements (
  conversation_id TEXT PRIMARY KEY, body TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ot_conversations (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('dm','group')), title TEXT NOT NULL DEFAULT '',
  team_id TEXT, dm_key TEXT UNIQUE, created_by TEXT NOT NULL, last_seq INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ot_conversation_members (
  conversation_id TEXT NOT NULL REFERENCES ot_conversations(id) ON DELETE CASCADE, owner_id TEXT NOT NULL,
  read_seq INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0, muted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, PRIMARY KEY (conversation_id, owner_id)
);
CREATE INDEX IF NOT EXISTS ot_conversation_members_owner ON ot_conversation_members(owner_id);
CREATE TABLE IF NOT EXISTS ot_conversation_agents (
  conversation_id TEXT NOT NULL REFERENCES ot_conversations(id) ON DELETE CASCADE, agent_ref TEXT NOT NULL,
  owner_id TEXT NOT NULL, name TEXT NOT NULL, auto_reply INTEGER NOT NULL DEFAULT 0,
  auto_reply_after_seq INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, agent_ref, owner_id)
);
CREATE TABLE IF NOT EXISTS ot_messages (
  rowseq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL REFERENCES ot_conversations(id) ON DELETE CASCADE, seq INTEGER NOT NULL,
  author_id TEXT NOT NULL, author_kind TEXT NOT NULL CHECK (author_kind IN ('member','agent')), agent_ref TEXT, agent_name TEXT,
  body TEXT NOT NULL, mentions TEXT NOT NULL DEFAULT '[]', reply_to TEXT, reply_mode TEXT, client_key TEXT,
  created_at INTEGER NOT NULL, edited_at INTEGER, retracted INTEGER NOT NULL DEFAULT 0, pinned_by TEXT,
  UNIQUE (conversation_id, seq), UNIQUE (conversation_id, author_id, client_key)
);
CREATE TABLE IF NOT EXISTS ot_voice_messages (
  message_id TEXT PRIMARY KEY REFERENCES ot_messages(id) ON DELETE CASCADE,
  mime TEXT NOT NULL, data BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS ot_reactions (
  message_id TEXT NOT NULL REFERENCES ot_messages(id) ON DELETE CASCADE, owner_id TEXT NOT NULL, emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL, PRIMARY KEY (message_id, owner_id, emoji)
);
`;

export const REACTIONS = ["👍", "❤️", "😄", "🎉", "👀", "✅"];
const BODY_MAX = 4000;
const VOICE_MAX_BYTES = 128 * 1024;

function voiceData(value: any) {
  const mime = value?.mime;
  const encoded = value?.data;
  assert(typeof encoded === "string" && encoded.length <= Math.ceil(VOICE_MAX_BYTES / 3) * 4,
    400, "invalid_voice", "Voice messages can contain up to 128 KiB");
  const data = Buffer.from(encoded, "base64");
  assert(data.length >= 12 && data.length <= VOICE_MAX_BYTES && data.toString("base64") === encoded,
    400, "invalid_voice", "Invalid voice message data");
  const webm = mime === "audio/webm" && data.readUInt32BE(0) === 0x1a45dfa3;
  const ogg = mime === "audio/ogg" && data.toString("ascii", 0, 4) === "OggS";
  const mp4 = mime === "audio/mp4" && data.toString("ascii", 4, 8) === "ftyp";
  assert(webm || ogg || mp4, 400, "invalid_voice", "Use a WebM, Ogg, or MP4 audio recording");
  return {mime, data};
}

const AUTO_PER_HOUR = 3;
const MENTION_PER_HOUR = 30;
const HOUR = 3_600_000;
const AGENT_REF = /^[A-Za-z0-9._:-]{1,80}$/;

function memberOf(ot: OtContext, convId: string, ownerId: string) {
  const conv = ot.get<any>("SELECT c.* FROM ot_conversations c JOIN ot_conversation_members m ON m.conversation_id = c.id WHERE c.id = ? AND m.owner_id = ?", convId, ownerId);
  assert(conv, 404, "conversation_not_found", "no such conversation");
  return conv;
}

const messageView = (ot: OtContext, m: any, viewer?: string) => ({
  id: m.id, conversation_id: m.conversation_id, seq: m.seq,
  author: m.author_kind === "agent" ? { kind: "agent", agent_ref: m.agent_ref, name: m.agent_name, owner: ot.profileView(m.author_id) } : { kind: "member", ...ot.profileView(m.author_id) },
  mine: viewer ? m.author_id === viewer && m.author_kind === "member" : undefined,
  body: m.retracted ? "" : m.body, revision: m.revision, retracted: !!m.retracted, edited_at: m.edited_at, created_at: m.created_at,
  mentions: JSON.parse(m.mentions), reply_to: m.reply_to, pinned: !!m.pinned_by,
  voice: m.retracted ? undefined : ot.get<{mime: string}>("SELECT mime FROM ot_voice_messages WHERE message_id=?", m.id),
  reactions: ot.all<any>("SELECT emoji, COUNT(*) AS n, SUM(owner_id = ?) AS me FROM ot_reactions WHERE message_id = ? GROUP BY emoji", viewer ?? "", m.id).map((r) => ({ emoji: r.emoji, count: r.n, mine: !!r.me })),
});

function conversationView(ot: OtContext, c: any, viewer: string) {
  const members = ot.all<any>("SELECT owner_id, read_seq, pinned, muted FROM ot_conversation_members WHERE conversation_id = ? ORDER BY created_at", c.id);
  const mine = members.find((m) => m.owner_id === viewer);
  const last = ot.get<any>("SELECT * FROM ot_messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT 1", c.id);
  const peer = c.kind === "dm" ? members.find((m) => m.owner_id !== viewer) : undefined;
  return {
    id: c.id, kind: c.kind, title: c.kind === "dm" ? (peer ? ot.profileView(peer.owner_id).display_name : c.title) : c.title,
    team_id: c.team_id, members: members.map((m) => ot.profileView(m.owner_id)),
    agents: ot.all<any>("SELECT agent_ref, owner_id, name, auto_reply FROM ot_conversation_agents WHERE conversation_id = ?", c.id).map((a) => ({ agent_ref: a.agent_ref, name: a.name, auto_reply: !!a.auto_reply, owner: ot.profileView(a.owner_id), mine: a.owner_id === viewer })),
    last_seq: c.last_seq, read_seq: mine?.read_seq ?? 0, unread: Math.max(0, c.last_seq - (mine?.read_seq ?? 0)),
    pinned: !!mine?.pinned, muted: !!mine?.muted, last_message: last ? messageView(ot, last, viewer) : null, updated_at: c.updated_at,
  };
}

/** Everyone a member may start a conversation with: someone sharing an active team. */
function assertReachable(ot: OtContext, from: string, to: string, teamId?: string | null) {
  if (teamId) {
    const r = ot.get<any>("SELECT 1 FROM ot_team_members WHERE team_id = ? AND owner_id = ? AND suspended = 0", teamId, to);
    assert(r, 403, "not_in_team", "that member is not in this team");
  } else {
    assert(shareTeam(ot, from, to), 403, "not_reachable", "you can message members of your teams");
  }
}

function insertMessage(ot: OtContext, conv: any, row: { author: string; kind: "member" | "agent"; agentRef?: string; agentName?: string; body: string; mentions: string[]; replyTo?: string | null; replyMode?: string | null; clientKey?: string | null }) {
  if (row.clientKey) {
    const dup = ot.get<any>("SELECT * FROM ot_messages WHERE conversation_id = ? AND author_id = ? AND client_key = ?", conv.id, row.author, row.clientKey);
    if (dup) return dup;
  }
  const seq = conv.last_seq + 1;
  const now = ot.now();
  const id = newId("otm");
  ot.run("INSERT INTO ot_messages(id, conversation_id, seq, author_id, author_kind, agent_ref, agent_name, body, mentions, reply_to, reply_mode, client_key, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    id, conv.id, seq, row.author, row.kind, row.agentRef ?? null, row.agentName ?? null, row.body, JSON.stringify(row.mentions), row.replyTo ?? null, row.replyMode ?? null, row.clientKey ?? null, now);
  ot.run("UPDATE ot_conversations SET last_seq = ?, updated_at = ? WHERE id = ?", seq, now, conv.id);
  if (row.kind === "member") ot.run("UPDATE ot_conversation_members SET read_seq = ? WHERE conversation_id = ? AND owner_id = ?", seq, conv.id, row.author);
  return ot.get<any>("SELECT * FROM ot_messages WHERE id = ?", id);
}

const agentMentionKey = (ownerId: string, ref: string) => `/agent/${ownerId}/${ref}`;

function parseMentions(ot: OtContext, convId: string, raw: unknown, bodyText: string, selectedAgents: unknown) {
  const handles = new Set<string>();
  if (Array.isArray(raw)) for (const h of raw.slice(0, 20)) handles.add(handleKey(h));
  for (const m of bodyText.matchAll(/@([a-z0-9._-]{2,40})/gi)) handles.add(handleKey(m[1]));
  const members = new Set(ot.all<any>("SELECT p.handle FROM ot_conversation_members m JOIN ot_profiles p ON p.owner_id = m.owner_id WHERE m.conversation_id = ?", convId).map((r) => r.handle));
  const agents = ot.all<{agent_ref: string; owner_id: string; name: string}>(
    "SELECT agent_ref, owner_id, name FROM ot_conversation_agents WHERE conversation_id = ?", convId,
  );
  if (selectedAgents === undefined) {
    const legacy = new Set(agents.flatMap(agent => [agent.agent_ref.toLowerCase(), agent.name.toLowerCase()]));
    return { mentions: [...handles].filter(h => members.has(h) || legacy.has(h)), body: bodyText };
  }

  assert(Array.isArray(selectedAgents) && selectedAgents.length <= 20, 400, "invalid_request", "Choose at most 20 group agents");
  const available = new Map(agents.map(agent => [agentMentionKey(agent.owner_id, agent.agent_ref), agent]));
  const targets = new Map<string, string>();
  for (const target of selectedAgents) {
    assert(target && typeof target.owner_id === "string" && !target.owner_id.includes("/")
      && typeof target.agent_id === "string" && AGENT_REF.test(target.agent_id),
    400, "invalid_request", "An agent mention requires an owner and agent ID");
    const key = agentMentionKey(target.owner_id, target.agent_id);
    const agent = available.get(key);
    assert(agent, 400, "invalid_request", "A mentioned agent is no longer in this conversation");
    targets.set(key, agent.name);
  }
  const prefix = [...targets.values()].map(name => "@" + name).join(" ");
  return {
    mentions: [...handles].filter(handle => members.has(handle)).concat([...targets.keys()]),
    body: prefix ? text(prefix + " " + bodyText, "body", { min: 1, max: BODY_MAX, multiline: true }) : bodyText,
  };
}

export function registerMessenger(app: FastifyInstance, ot: OtContext) {
  const messageCols = new Set(ot.all<any>("PRAGMA table_info(ot_messages)").map(c => c.name));
  if (!messageCols.has("revision")) ot.run("ALTER TABLE ot_messages ADD COLUMN revision INTEGER NOT NULL DEFAULT 1");
  const agentCols = new Set(ot.all<any>("PRAGMA table_info(ot_conversation_agents)").map(c => c.name));
  if (!agentCols.has("auto_reply_after_seq")) {
    ot.run("ALTER TABLE ot_conversation_agents ADD COLUMN auto_reply_after_seq INTEGER NOT NULL DEFAULT 0");
  }
  app.post("/v1/ot/conversations", async (req, reply) => {
    const me = ot.me(req);
    const b = body(req);
    if (b.kind === "dm") {
      const peer = ot.ownerByHandle(b.peer);
      assert(peer !== me.ownerId, 400, "invalid_request", "pick another member");
      assertReachable(ot, me.ownerId, peer);
      const key = [me.ownerId, peer].sort().join(":");
      const existing = ot.get<any>("SELECT * FROM ot_conversations WHERE dm_key = ?", key);
      if (existing) return reply.status(200).send(conversationView(ot, existing, me.ownerId));
      const id = newId("otc"); const now = ot.now();
      ot.tx(() => {
        ot.run("INSERT INTO ot_conversations(id, kind, dm_key, created_by, created_at, updated_at) VALUES (?, 'dm', ?, ?, ?, ?)", id, key, me.ownerId, now, now);
        for (const o of [me.ownerId, peer]) ot.run("INSERT INTO ot_conversation_members(conversation_id, owner_id, created_at) VALUES (?,?,?)", id, o, now);
      });
      return reply.status(201).send(conversationView(ot, ot.get("SELECT * FROM ot_conversations WHERE id = ?", id), me.ownerId));
    }
    assert(b.kind === "group", 400, "invalid_request", "kind must be dm or group");
    const title = text(b.title, "title", { min: 1, max: 80 });
    const teamId = b.team_id ? String(b.team_id) : null;
    if (teamId) requireMember(ot, teamId, me.ownerId);
    assert(Array.isArray(b.members ?? []) && (b.members ?? []).length <= 50, 400, "invalid_request", "members must be a list of at most 50 handles");
    const others = [...new Set((b.members ?? []).map((h: unknown) => ot.ownerByHandle(h)))].filter((o) => o !== me.ownerId) as string[];
    for (const o of others) assertReachable(ot, me.ownerId, o, teamId);
    const id = newId("otc"); const now = ot.now();
    ot.tx(() => {
      ot.run("INSERT INTO ot_conversations(id, kind, title, team_id, created_by, created_at, updated_at) VALUES (?, 'group', ?, ?, ?, ?, ?)", id, title, teamId, me.ownerId, now, now);
      for (const o of [me.ownerId, ...others]) ot.run("INSERT INTO ot_conversation_members(conversation_id, owner_id, created_at) VALUES (?,?,?)", id, o, now);
    });
    for (const o of others) ot.notify(o, "messenger.added", { conversation_id: id, title, by: ot.profileView(me.ownerId) });
    return reply.status(201).send(conversationView(ot, ot.get("SELECT * FROM ot_conversations WHERE id = ?", id), me.ownerId));
  });

  app.get("/v1/ot/conversations", async (req) => {
    const me = ot.me(req);
    const rows = ot.all<any>("SELECT c.* FROM ot_conversations c JOIN ot_conversation_members m ON m.conversation_id = c.id WHERE m.owner_id = ? ORDER BY m.pinned DESC, c.updated_at DESC LIMIT 200", me.ownerId);
    const list = rows.map((c) => conversationView(ot, c, me.ownerId));
    return { conversations: list, unread: list.reduce((n, c) => n + (c.muted ? 0 : c.unread), 0) };
  });
  app.get("/v1/ot/conversations/:id", async (req) => {
    const me = ot.me(req);
    return conversationView(ot, memberOf(ot, params(req).id, me.ownerId), me.ownerId);
  });
  app.patch("/v1/ot/conversations/:id", async (req) => {
    const me = ot.me(req);
    const conv = memberOf(ot, params(req).id, me.ownerId);
    const b = body(req);
    if (b.title !== undefined) {
      assert(conv.kind === "group", 400, "invalid_request", "only groups have a title");
      ot.run("UPDATE ot_conversations SET title = ?, updated_at = ? WHERE id = ?", text(b.title, "title", { min: 1, max: 80 }), ot.now(), conv.id);
    }
    for (const k of ["pinned", "muted"]) if (b[k] !== undefined) {
      assert(typeof b[k] === "boolean", 400, "invalid_request", `${k} must be true or false`);
      ot.run(`UPDATE ot_conversation_members SET ${k} = ? WHERE conversation_id = ? AND owner_id = ?`, b[k] ? 1 : 0, conv.id, me.ownerId);
    }
    return conversationView(ot, ot.get("SELECT * FROM ot_conversations WHERE id = ?", conv.id), me.ownerId);
  });
  app.post("/v1/ot/conversations/:id/members", async (req) => {
    const me = ot.me(req);
    const conv = memberOf(ot, params(req).id, me.ownerId);
    assert(conv.kind === "group", 400, "invalid_request", "members are added to groups only");
    const o = ot.ownerByHandle(body(req).handle);
    assertReachable(ot, me.ownerId, o, conv.team_id);
    ot.run("INSERT OR IGNORE INTO ot_conversation_members(conversation_id, owner_id, read_seq, created_at) VALUES (?,?,?,?)", conv.id, o, conv.last_seq, ot.now());
    ot.notify(o, "messenger.added", { conversation_id: conv.id, title: conv.title, by: ot.profileView(me.ownerId) });
    return conversationView(ot, conv, me.ownerId);
  });
  app.delete("/v1/ot/conversations/:id/members/:handle", async (req) => {
    const me = ot.me(req);
    const conv = memberOf(ot, params(req).id, me.ownerId);
    assert(conv.kind === "group", 400, "invalid_request", "a direct message has no members to remove");
    const o = ot.ownerByHandle(params(req).handle);
    assert(o === me.ownerId || conv.created_by === me.ownerId, 403, "forbidden", "only the group creator removes others");
    ot.tx(() => {
      ot.run("DELETE FROM ot_conversation_members WHERE conversation_id = ? AND owner_id = ?", conv.id, o);
      ot.run("DELETE FROM ot_conversation_agents WHERE conversation_id = ? AND owner_id = ?", conv.id, o);
    });
    return { removed: true };
  });

  const announcement = (cid: string) => ot.get<any>("SELECT * FROM ot_group_announcements WHERE conversation_id=?", cid) ?? { body: "", revision: 0 };
  const canAnnounce = (conv: any, owner: string) => !!conv.team_id && !!ot.get("SELECT 1 FROM ot_team_members WHERE team_id=? AND owner_id=? AND role IN ('owner','admin') AND suspended=0", conv.team_id, owner);
  app.get("/v1/ot/conversations/:id/announcement", async req => {
    const me = ot.me(req), conv = memberOf(ot, params(req).id, me.ownerId);
    assert(conv.kind === "group", 400, "invalid_request", "announcements require a group");
    return { announcement: announcement(conv.id), can_edit: canAnnounce(conv, me.ownerId) };
  });
  app.post("/v1/ot/conversations/:id/announcement", async req => {
    const me = ot.me(req), conv = memberOf(ot, params(req).id, me.ownerId), b = body(req);
    assert(conv.kind === "group", 400, "invalid_request", "announcements require a group");
    assert(canAnnounce(conv, me.ownerId), 403, "forbidden", "only team owners and admins may publish");
    const content = text(b.body, "body", { max: 2000, multiline: true });
    ot.tx(() => {
      const current = announcement(conv.id);
      assert(Number.isInteger(b.revision) && b.revision === current.revision, 409, "conflict", "announcement changed; reload");
      ot.run("INSERT INTO ot_group_announcements VALUES(?,?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET body=excluded.body,revision=excluded.revision,updated_at=excluded.updated_at,updated_by=excluded.updated_by", conv.id, content, current.revision + 1, ot.now(), me.ownerId);
    });
    return { announcement: announcement(conv.id), can_edit: true };
  });

  // ---- messages
  app.get("/v1/ot/conversations/:id/messages", async (req) => {
    const me = ot.me(req);
    const conv = memberOf(ot, params(req).id, me.ownerId);
    const q = query(req);
    const limit = Math.max(1, intParam(q.limit, "limit", 50, 200));
    const before = intParam(q.before, "before", 0);
    const after = intParam(q.after, "after", 0);
    const around = q.around;
    const term = q.q === undefined ? "" : text(q.q, "q", { min: 1, max: 80 });
    assert(!term || (around === undefined && !after), 400, "invalid_request", "Search supports only an older cursor");
    assert(Number(Boolean(before)) + Number(Boolean(after)) + Number(around !== undefined) <= 1,
      400, "invalid_request", "Choose one message cursor");
    let rows;
    if (term) {
      const matches = ot.all<any>(`SELECT * FROM ot_messages WHERE conversation_id=? AND retracted=0
        AND (?=0 OR seq<?) AND instr(lower(body),lower(?))>0 ORDER BY seq DESC LIMIT ?`,
      conv.id, before, before, term, limit + 1);
      const cursor = matches.length > limit ? matches[limit - 1].seq : null;
      return { messages: matches.slice(0, limit).map(m => messageView(ot, m, me.ownerId)), next_before: cursor };
    }
    if (around !== undefined) {
      assert(typeof around === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(around), 400, "invalid_request", "Invalid message ID");
      const anchor = ot.get<{seq: number}>("SELECT seq FROM ot_messages WHERE id=? AND conversation_id=?", around, conv.id);
      assert(anchor, 404, "message_not_found", "Message not found in this conversation");
      const preceding = ot.all<any>("SELECT * FROM ot_messages WHERE conversation_id=? AND seq<? ORDER BY seq DESC LIMIT ?",
        conv.id, anchor.seq, Math.floor((limit - 1) / 2));
      const following = ot.all<any>("SELECT * FROM ot_messages WHERE conversation_id=? AND seq>=? ORDER BY seq LIMIT ?",
        conv.id, anchor.seq, limit - preceding.length);
      rows = [...preceding.reverse(), ...following];
    } else if (before) {
      rows = ot.all<any>("SELECT * FROM ot_messages WHERE conversation_id=? AND seq<? ORDER BY seq DESC LIMIT ?", conv.id, before, limit).reverse();
    } else if (after) {
      rows = ot.all<any>("SELECT * FROM ot_messages WHERE conversation_id=? AND seq>? ORDER BY seq LIMIT ?", conv.id, after, limit);
    } else {
      rows = ot.all<any>("SELECT * FROM ot_messages WHERE conversation_id=? ORDER BY seq DESC LIMIT ?", conv.id, limit).reverse();
    }
    const mine = ot.get<any>("SELECT read_seq FROM ot_conversation_members WHERE conversation_id = ? AND owner_id = ?", conv.id, me.ownerId);
    const first = rows[0]?.seq;
    const hasOlder = first > 1 && ot.get("SELECT 1 FROM ot_messages WHERE conversation_id=? AND seq<? LIMIT 1", conv.id, first);
    return {
      messages: rows.map(m => messageView(ot, m, me.ownerId)), read_seq: mine.read_seq, last_seq: conv.last_seq,
      next_before: hasOlder ? first : null,
      has_newer: (rows.at(-1)?.seq ?? conv.last_seq) < conv.last_seq,
    };
  });
  app.post("/v1/ot/conversations/:id/messages", async (req, reply) => {
    const me = ot.me(req);
    const b = body(req);
    const voice = b.voice === undefined ? null : voiceData(b.voice);
    const bodyText = text(voice && !b.body ? "语音消息" : b.body, "body", { min: 1, max: BODY_MAX, multiline: true });
    const clientKey = optText(b.client_key, "client_key", { min: 1, max: 80 }) ?? null;
    const msg = ot.tx(() => {
      const conv = memberOf(ot, params(req).id, me.ownerId);
      if (clientKey) {
        const previous = ot.get<any>(
          "SELECT * FROM ot_messages WHERE conversation_id=? AND author_id=? AND client_key=?", conv.id, me.ownerId, clientKey,
        );
        if (previous) return previous;
      }
      if (b.reply_to) assert(ot.get("SELECT 1 FROM ot_messages WHERE id = ? AND conversation_id = ?", String(b.reply_to), conv.id), 400, "invalid_request", "reply_to is not in this conversation");
      const parsed = parseMentions(ot, conv.id, b.mentions, bodyText, b.agent_mentions);
      const mentions = parsed.mentions;
      const m = insertMessage(ot, conv, { author: me.ownerId, kind: "member", body: parsed.body, mentions, replyTo: b.reply_to ? String(b.reply_to) : null, clientKey });
      if (voice) ot.run("INSERT INTO ot_voice_messages VALUES (?,?,?)", m.id, voice.mime, voice.data);
      for (const h of mentions) {
        const row = ot.get<any>("SELECT owner_id FROM ot_profiles WHERE handle = ?", h);
        if (row && row.owner_id !== me.ownerId) ot.notify(row.owner_id, "messenger.mention", { conversation_id: conv.id, message_id: m.id, by: ot.profileView(me.ownerId) });
      }
      return m;
    });
    return reply.status(201).send(messageView(ot, msg, me.ownerId));
  });
  app.get("/v1/ot/conversations/:id/messages/:message/voice", async req => {
    const me = ot.me(req);
    const conv = memberOf(ot, params(req).id, me.ownerId);
    const voice = ot.get<{mime: string; data: Buffer}>(`SELECT v.mime,v.data FROM ot_voice_messages v
      JOIN ot_messages m ON m.id=v.message_id WHERE m.id=? AND m.conversation_id=? AND m.retracted=0`,
    params(req).message, conv.id);
    assert(voice, 404, "message_not_found", "Voice message not found");
    return {mime: voice.mime, data: voice.data.toString("base64")};
  });
  app.post("/v1/ot/conversations/:id/read", async (req) => {
    const me = ot.me(req);
    const conv = memberOf(ot, params(req).id, me.ownerId);
    const seq = body(req).seq === undefined ? conv.last_seq : Number(body(req).seq);
    assert(Number.isSafeInteger(seq) && seq >= 0, 400, "invalid_request", "seq must be a sequence number");
    ot.run("UPDATE ot_conversation_members SET read_seq = MAX(read_seq, ?) WHERE conversation_id = ? AND owner_id = ?", Math.min(seq, conv.last_seq), conv.id, me.ownerId);
    const readSeq = ot.get<any>("SELECT read_seq FROM ot_conversation_members WHERE conversation_id = ? AND owner_id = ?", conv.id, me.ownerId).read_seq;
    return { read_seq: readSeq, unread: Math.max(0, conv.last_seq - readSeq) };
  });
  const ownMessage = (id: string, ownerId: string) => {
    const m = ot.get<any>("SELECT * FROM ot_messages WHERE id = ?", id);
    assert(m, 404, "message_not_found", "no such message");
    memberOf(ot, m.conversation_id, ownerId);
    return m;
  };
  app.get("/v1/ot/messages/:id", async req => {
    const me=ot.me(req), m=ownMessage(params(req).id,me.ownerId), cid=query(req).conversation_id;
    assert(cid === undefined || cid === m.conversation_id,404,"message_not_found","message not in conversation");
    return messageView(ot,m,me.ownerId);
  });
  app.patch("/v1/ot/messages/:id", async (req) => {
    const me = ot.me(req);
    const m = ownMessage(params(req).id, me.ownerId);
    assert(m.author_id === me.ownerId && m.author_kind === "member" && !m.retracted, 403, "forbidden", "you can edit your own messages only");
    ot.run("UPDATE ot_messages SET body = ?, revision = revision + 1, edited_at = ? WHERE id = ?", text(body(req).body, "body", { min: 1, max: BODY_MAX, multiline: true }), ot.now(), m.id);
    return messageView(ot, ot.get("SELECT * FROM ot_messages WHERE id = ?", m.id), me.ownerId);
  });
  app.delete("/v1/ot/messages/:id", async (req) => {
    const me = ot.me(req);
    const m = ownMessage(params(req).id, me.ownerId);
    assert(m.author_id === me.ownerId, 403, "forbidden", "you can retract your own messages (or your agents') only");
    ot.run("UPDATE ot_messages SET retracted = 1, revision = revision + 1, body = '', edited_at = ? WHERE id = ?", ot.now(), m.id);
    return { retracted: true };
  });
  app.post("/v1/ot/messages/:id/reactions", async (req) => {
    const me = ot.me(req);
    const m = ownMessage(params(req).id, me.ownerId);
    const b = body(req);
    assert(REACTIONS.includes(b.emoji), 400, "invalid_request", `emoji must be one of ${REACTIONS.join(" ")}`);
    if (b.on === false) ot.run("DELETE FROM ot_reactions WHERE message_id = ? AND owner_id = ? AND emoji = ?", m.id, me.ownerId, b.emoji);
    else ot.run("INSERT OR IGNORE INTO ot_reactions(message_id, owner_id, emoji, created_at) VALUES (?,?,?,?)", m.id, me.ownerId, b.emoji, ot.now());
    return messageView(ot, m, me.ownerId);
  });
  app.post("/v1/ot/messages/:id/pin", async (req) => {
    const me = ot.me(req);
    const m = ownMessage(params(req).id, me.ownerId);
    ot.run("UPDATE ot_messages SET pinned_by = ? WHERE id = ?", body(req).on === false ? null : me.ownerId, m.id);
    return messageView(ot, ot.get("SELECT * FROM ot_messages WHERE id = ?", m.id), me.ownerId);
  });

  // ---- group agents (executed in their owner's DS-Bot)
  app.put("/v1/ot/conversations/:id/agents/:agent", async (req) => {
    const me = ot.me(req);
    const conv = memberOf(ot, params(req).id, me.ownerId);
    assert(conv.kind === "group", 400, "invalid_request", "agents join groups only");
    const ref = params(req).agent;
    assert(AGENT_REF.test(ref), 400, "invalid_request", "agent id is invalid");
    const b = body(req);
    const name = text(b.name, "name", { min: 1, max: 40 });
    ot.run(`INSERT INTO ot_conversation_agents(conversation_id, agent_ref, owner_id, name, auto_reply, auto_reply_after_seq, created_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(conversation_id, agent_ref, owner_id) DO UPDATE SET
        name=excluded.name, auto_reply=excluded.auto_reply,
        auto_reply_after_seq=CASE WHEN ot_conversation_agents.auto_reply=0 AND excluded.auto_reply=1
          THEN excluded.auto_reply_after_seq ELSE ot_conversation_agents.auto_reply_after_seq END`,
    conv.id, ref, me.ownerId, name, b.auto_reply === true ? 1 : 0, conv.last_seq, ot.now());
    return conversationView(ot, conv, me.ownerId);
  });
  app.patch("/v1/ot/conversations/:id/agents/:agent", async (req) => {
    const me = ot.me(req);
    const conv = memberOf(ot, params(req).id, me.ownerId);
    assert(conv.kind === "group", 400, "invalid_request", "agents join groups only");
    const enabled = body(req).auto_reply;
    assert(typeof enabled === "boolean", 400, "invalid_request", "auto_reply must be a boolean");
    const result = ot.run(`UPDATE ot_conversation_agents SET
      auto_reply_after_seq=CASE WHEN auto_reply=0 AND ?=1 THEN ? ELSE auto_reply_after_seq END,
      auto_reply=? WHERE conversation_id=? AND agent_ref=? AND owner_id=?`,
    Number(enabled), conv.last_seq, Number(enabled), conv.id, params(req).agent, me.ownerId);
    assert(result.changes === 1, 404, "agent_not_found", "that agent of yours is not in this group");
    return { auto_reply: enabled };
  });
  app.delete("/v1/ot/conversations/:id/agents/:agent", async (req) => {
    const me = ot.me(req);
    const conv = memberOf(ot, params(req).id, me.ownerId);
    ot.run("DELETE FROM ot_conversation_agents WHERE conversation_id = ? AND agent_ref = ? AND owner_id = ?", conv.id, params(req).agent, me.ownerId);
    return conversationView(ot, conv, me.ownerId);
  });
  /** Messages the caller's agents should answer: @mentions of the agent, or any member message in a group
   *  where the agent has auto-reply on. `after` is a global cursor (`cursor` in the answer). */
  app.get("/v1/ot/agent-inbox", async (req) => {
    const me = ot.me(req);
    const after = intParam(query(req).after, "after", 0);
    const limit = Math.max(1, intParam(query(req).limit, "limit", 20, 50));
    const rows = ot.all<any>(`WITH pending AS (
      SELECT m.* FROM ot_messages m
      WHERE m.rowseq > ? AND m.author_kind = 'member' AND m.retracted = 0
        AND NOT EXISTS (SELECT 1 FROM ot_voice_messages v WHERE v.message_id=m.id)
        AND EXISTS (SELECT 1 FROM ot_conversation_members cm WHERE cm.conversation_id=m.conversation_id AND cm.owner_id=?)
        AND EXISTS (SELECT 1 FROM ot_conversation_agents ca WHERE ca.conversation_id=m.conversation_id AND ca.owner_id=?)
      ORDER BY m.rowseq LIMIT ?
    )
    SELECT m.*, a.agent_ref AS my_agent, a.name AS my_agent_name, a.auto_reply AS my_auto, a.auto_reply_after_seq AS auto_after_seq
    FROM pending m JOIN ot_conversation_agents a ON a.conversation_id=m.conversation_id AND a.owner_id=?
    ORDER BY m.rowseq, a.agent_ref`, after, me.ownerId, me.ownerId, limit * 4, me.ownerId);
    let cursor = after;
    const items: any[] = [];
    for (const m of rows) {
      // A cursor acknowledges the entire message, including its other recipients.
      if (items.length >= limit && m.rowseq > cursor) break;
      cursor = Math.max(cursor, m.rowseq);
      const mentions: string[] = JSON.parse(m.mentions);
      const conv = ot.get<any>("SELECT title, dm_key FROM ot_conversations WHERE id = ?", m.conversation_id);
      // A public-homepage thread (visitor + creator's agent) addresses the agent directly.
      const homepage = String(conv.dm_key ?? "").startsWith("agent:");
      const agentRef = String(m.my_agent).toLowerCase();
      const explicit = mentions.some(mention => typeof mention === "string" && mention.startsWith("/agent/"));
      const mentioned = homepage || (explicit
        ? mentions.includes(agentMentionKey(me.ownerId, String(m.my_agent)))
        : mentions.includes(agentRef) || mentions.includes(String(m.my_agent_name).toLowerCase()));
      if (!mentioned && (!m.my_auto || m.seq <= m.auto_after_seq)) continue;
      const context = ot.all<any>("SELECT * FROM (SELECT * FROM ot_messages WHERE conversation_id = ? AND seq <= ? ORDER BY seq DESC LIMIT 12) ORDER BY seq", m.conversation_id, m.seq);
      items.push({ conversation_id: m.conversation_id, conversation_title: conv.title, agent_ref: m.my_agent, agent_name: m.my_agent_name, mode: mentioned ? "mention" : "auto", message: messageView(ot, m), context: context.map((c) => messageView(ot, c)) });
    }
    return { cursor, items };
  });
  app.post("/v1/ot/conversations/:id/agent-messages", async (req, reply) => {
    const me = ot.me(req);
    const b = body(req);
    const ref = String(b.agent_ref ?? "");
    const bodyText = text(b.body, "body", { min: 1, max: BODY_MAX, multiline: true });
    const mode = b.mode === "auto" ? "auto" : "mention";
    const msg = ot.tx(() => {
      const conv = memberOf(ot, params(req).id, me.ownerId);
      const agent = ot.get<any>("SELECT * FROM ot_conversation_agents WHERE conversation_id = ? AND agent_ref = ? AND owner_id = ?", conv.id, ref, me.ownerId);
      assert(agent, 404, "agent_not_found", "that agent of yours is not in this group");
      if (mode === "auto") {
        assert(agent.auto_reply, 409, "auto_reply_disabled", "automatic replies are disabled for this agent");
        if (b.reply_to) {
          const trigger = ot.get<any>("SELECT seq FROM ot_messages WHERE id=? AND conversation_id=?", String(b.reply_to), conv.id);
          assert(trigger && trigger.seq > agent.auto_reply_after_seq, 409, "auto_reply_disabled", "message predates automatic replies");
        }
      }
      const since = ot.now() - HOUR;
      const used = ot.get<any>("SELECT COUNT(*) AS n FROM ot_messages WHERE conversation_id = ? AND author_kind = 'agent' AND reply_mode = ? AND created_at > ?", conv.id, mode, since).n;
      assert(used < (mode === "auto" ? AUTO_PER_HOUR : MENTION_PER_HOUR), 429, "agent_reply_limit", mode === "auto" ? "automatic agent replies are limited to 3 per hour in a group" : "agent reply limit reached");
      if (b.reply_to) assert(ot.get("SELECT 1 FROM ot_messages WHERE id = ? AND conversation_id = ?", String(b.reply_to), conv.id), 400, "invalid_request", "reply_to is not in this conversation");
      return insertMessage(ot, conv, { author: me.ownerId, kind: "agent", agentRef: agent.agent_ref, agentName: agent.name, body: bodyText, mentions: [], replyTo: b.reply_to ? String(b.reply_to) : null, replyMode: mode, clientKey: b.client_key ? text(b.client_key, "client_key", { min: 1, max: 80 }) : null });
    });
    return reply.status(201).send(messageView(ot, msg, me.ownerId));
  });
}
