// OpenTeamily member messenger on Bot Social: DMs and named groups between members, unread/read
// cursors, reactions, edit/retract, pins, @mentions, and group agents. Ported from the legacy
// social.py. A group agent lives in its owner's own DS-Bot: Bot Social only lists the agent and
// hands its owner's DS-Bot the messages it should answer (agent inbox); the reply is generated in
// that DS-Bot and posted back here. Automatic (un-@'d) group replies are capped at 3 per hour per
// conversation (#346). OpenTeamily semantics; not Teamily parity.
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { assert } from "../errors.js";
import { newId } from "../ids.js";
import { body, handleKey, intParam, OtContext, optText, params, query, text } from "./core.js";
import { shareTeam, requireMember } from "./teams.js";
import { acceptedContact } from "./contacts.js";

import { CHAT_FILE_BODY_LIMIT, CHAT_FILES_SCHEMA, attachmentView, decodeChatFile, readAttachment, saveAttachment } from "./chat-files.js";

export const MESSENGER_SCHEMA = `
CREATE TABLE IF NOT EXISTS ot_group_announcements (
  conversation_id TEXT PRIMARY KEY, body TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ot_conversations (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('dm','group')), title TEXT NOT NULL DEFAULT '',
  team_id TEXT, dm_key TEXT UNIQUE, created_by TEXT NOT NULL, last_seq INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, account_group INTEGER NOT NULL DEFAULT 0,
  activity_revision INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ot_group_requests (
  owner_id TEXT NOT NULL, request_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES ot_conversations(id) ON DELETE CASCADE,
  PRIMARY KEY (owner_id, request_key)
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
  created_at INTEGER NOT NULL, edited_at INTEGER, retracted INTEGER NOT NULL DEFAULT 0, pinned_by TEXT, forwarded_author TEXT,
  UNIQUE (conversation_id, seq), UNIQUE (conversation_id, author_id, client_key)
);
CREATE TABLE IF NOT EXISTS ot_group_memories (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES ot_conversations(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL, client_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
  title TEXT NOT NULL, body TEXT NOT NULL, source_message_id TEXT NOT NULL REFERENCES ot_messages(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL, removed INTEGER NOT NULL DEFAULT 0,
  UNIQUE(conversation_id,author_id,client_key)
);
CREATE INDEX IF NOT EXISTS ot_group_memories_room ON ot_group_memories(conversation_id,removed,created_at DESC);
CREATE TABLE IF NOT EXISTS ot_group_memory_sources (
  memory_id TEXT NOT NULL REFERENCES ot_group_memories(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL, revision INTEGER NOT NULL,
  PRIMARY KEY(memory_id,message_id)
);
CREATE TABLE IF NOT EXISTS ot_group_memory_references (
  message_id TEXT NOT NULL REFERENCES ot_messages(id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL REFERENCES ot_group_memories(id) ON DELETE CASCADE,
  PRIMARY KEY(message_id,memory_id)
);
CREATE TABLE IF NOT EXISTS ot_forward_requests (
  owner_id TEXT NOT NULL, request_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES ot_conversations(id) ON DELETE CASCADE, forwarded INTEGER NOT NULL,
  PRIMARY KEY (owner_id, request_key)
);
CREATE TABLE IF NOT EXISTS ot_hidden_messages (
  owner_id TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES ot_conversations(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES ot_messages(id) ON DELETE CASCADE, seq INTEGER NOT NULL,
  PRIMARY KEY (owner_id, message_id)
);
CREATE INDEX IF NOT EXISTS ot_hidden_messages_room ON ot_hidden_messages(owner_id, conversation_id, seq);
CREATE INDEX IF NOT EXISTS ot_messages_pinned ON ot_messages(conversation_id,seq DESC)
  WHERE pinned_by IS NOT NULL AND retracted=0;
CREATE TABLE IF NOT EXISTS ot_agent_reply_jobs (
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES ot_messages(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL, agent_ref TEXT NOT NULL, agent_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','failed','replied')),
  attempt INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL,
  UNIQUE (message_id, owner_id, agent_ref)
);
CREATE INDEX IF NOT EXISTS ot_agent_reply_jobs_queue ON ot_agent_reply_jobs(owner_id, status, updated_at);
CREATE TABLE IF NOT EXISTS ot_voice_messages (
  message_id TEXT PRIMARY KEY REFERENCES ot_messages(id) ON DELETE CASCADE,
  mime TEXT NOT NULL, data BLOB NOT NULL
);
${CHAT_FILES_SCHEMA}
CREATE TABLE IF NOT EXISTS ot_reactions (
  message_id TEXT NOT NULL REFERENCES ot_messages(id) ON DELETE CASCADE, owner_id TEXT NOT NULL, emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL, PRIMARY KEY (message_id, owner_id, emoji)
);
`;

export const REACTIONS = ["👍", "❤️", "😄", "🎉", "👀", "✅"];
const BODY_MAX = 4000;
const REPLY_JOB_TIMEOUT = 180_000;
const REPLY_JOB_ATTEMPTS = 3;

type ReplyAgent = {owner_id: string; agent_ref: string; name: string};
type ReplyJob = {
  id: string; message_id: string; owner_id: string; agent_ref: string; agent_name: string;
  status: "queued" | "running" | "failed" | "replied"; attempt: number; updated_at: number;
  available: number;
};

const REPLY_JOB_SOURCE = `SELECT j.*, src.conversation_id, src.retracted, src.seq, c.title AS conversation_title,
  (src.retracted=0 AND member.owner_id IS NOT NULL AND agent.owner_id IS NOT NULL
    AND (c.team_id IS NULL OR team.owner_id IS NOT NULL)) AS available
  FROM ot_agent_reply_jobs j JOIN ot_messages src ON src.id=j.message_id
  JOIN ot_conversations c ON c.id=src.conversation_id
  LEFT JOIN ot_conversation_members member ON member.conversation_id=c.id AND member.owner_id=j.owner_id
  LEFT JOIN ot_conversation_agents agent ON agent.conversation_id=c.id AND agent.owner_id=j.owner_id AND agent.agent_ref=j.agent_ref
  LEFT JOIN ot_team_members team ON team.team_id=c.team_id AND team.owner_id=j.owner_id AND team.suspended=0`;

function replyJobState(job: ReplyJob, now: number) {
  if ((job.status === "queued" || job.status === "running")
      && (!job.available || job.updated_at <= now - REPLY_JOB_TIMEOUT)) return "failed";
  return job.status;
}

function replyJobViews(ot: OtContext, message: any, viewer?: string) {
  if (message.retracted || message.mentions === "[]") return [];
  const now = ot.now();
  return ot.all<ReplyJob>(REPLY_JOB_SOURCE + " WHERE j.message_id=? ORDER BY j.rowid", message.id).map(job => {
    const status = replyJobState(job, now);
    return {id: job.id, agent_name: job.agent_name, status,
      can_retry: Boolean(viewer === message.author_id && job.available && status === "failed" && job.attempt < REPLY_JOB_ATTEMPTS)};
  });
}
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

function publicListing(ot: OtContext, conversation: {dm_key?: string | null}) {
  const key = conversation.dm_key;
  if (!key?.startsWith("agent:")) return null;
  return ot.get<{
    ref: string; owner_id: string; slug: string; title: string; summary: string; snapshot: string | null;
    listed: number; chat_enabled: number; chat_from: number;
  }>("SELECT ref, owner_id, slug, title, summary, snapshot, listed, chat_enabled, chat_from FROM ot_listings WHERE id=? AND kind='agent'", key.split(":")[1]) ?? null;
}

function fixedPublicThread(conv: {dm_key?: string | null}) {
  return !!conv.dm_key?.startsWith("agent:");
}

export function ordinaryDirect(conv: {kind: string; team_id?: string | null; dm_key?: string | null}) {
  return conv.kind === "dm" && !conv.team_id && !fixedPublicThread(conv);
}

function directReachable(ot: OtContext, owner: string, peer: string) {
  return acceptedContact(ot, owner, peer) || shareTeam(ot, owner, peer);
}

export function requireDirectReach(ot: OtContext, conv: {id: string; kind: string; team_id?: string | null; dm_key?: string | null}, owner: string) {
  if (!ordinaryDirect(conv)) return;
  const peer = ot.get<{owner_id: string}>("SELECT owner_id FROM ot_conversation_members WHERE conversation_id=? AND owner_id<>?", conv.id, owner);
  assert(peer && directReachable(ot, owner, peer.owner_id), 403, "not_reachable", "请先建立联系人关系。");
}

function accountConversation(ot: OtContext, id: string, owner: string) {
  const conv = memberOf(ot, id, owner);
  assert(ordinaryDirect(conv) || conv.account_group === 1, 404, "conversation_not_found", "no such personal conversation");
  return conv;
}

function publicParticipant(ot: OtContext, conv: any, owner: string) {
  return !fixedPublicThread(conv) || conv.created_by === owner || publicListing(ot, conv)?.owner_id === owner;
}

function requireOrdinaryGroup(conv: any) {
  assert(!fixedPublicThread(conv), 409, "public_chat_fixed", "公开智能体会话使用固定成员。");
}

function memberOf(ot: OtContext, convId: string, ownerId: string) {
  const conv = ot.get<any>("SELECT c.* FROM ot_conversations c JOIN ot_conversation_members m ON m.conversation_id = c.id WHERE c.id = ? AND m.owner_id = ?", convId, ownerId);
  assert(conv && publicParticipant(ot, conv, ownerId), 404, "conversation_not_found", "no such conversation");
  return conv;
}

function requireMemoryGroup(ot: OtContext, cid: string, viewer: string) {
  const conv = memberOf(ot, cid, viewer);
  assert(conv.kind === "group" && !fixedPublicThread(conv), 404, "not_found", "该会话没有群记忆。");
  if (conv.team_id) requireMember(ot, conv.team_id, viewer);
  return conv;
}

const ACTIVE_MEMORIES = `g.removed=0 AND NOT EXISTS (
  SELECT 1 FROM ot_group_memory_sources s LEFT JOIN ot_messages m ON m.id=s.message_id
  WHERE s.memory_id=g.id AND (m.id IS NULL OR m.retracted=1 OR m.revision<>s.revision))`;

function activeMemories(ot: OtContext, cid: string) {
  return ot.all<any>(`SELECT g.* FROM ot_group_memories g WHERE g.conversation_id=? AND ${ACTIVE_MEMORIES}
    ORDER BY g.created_at DESC,g.id DESC LIMIT 40`,cid);
}

function groupMemoryView(ot: OtContext, row: any, group: any, viewer: string) {
  return {id:row.id,title:row.title,body:row.body,source_message_id:row.source_message_id,
    author:ot.profileView(row.author_id).display_name,created_at:row.created_at,
    can_remove:row.author_id===viewer || group.created_by===viewer};
}

function messageMemories(ot: OtContext, m: any) {
  return ot.all<{id:string;title:string}>(`SELECT g.id,g.title FROM ot_group_memory_references r
    JOIN ot_group_memories g ON g.id=r.memory_id WHERE r.message_id=? AND g.conversation_id=? AND ${ACTIVE_MEMORIES}`,m.id,m.conversation_id);
}

function workspaceTeam(ot: OtContext, workspace: string, ownerId: string) {
  assert(/^[0-9a-f]{32}$/.test(workspace), 400, "invalid_request", "Invalid workspace");
  const match = ot.get<{id: string}>("SELECT id FROM ot_teams WHERE workspace_id=?", workspace);
  assert(match, 404, "team_not_found", "Workspace not found");
  return requireMember(ot, match.id, ownerId).team;
}

function workspaceConversation(ot: OtContext, workspace: string, id: string, ownerId: string) {
  const team = workspaceTeam(ot, workspace, ownerId);
  const conv = memberOf(ot, id, ownerId);
  let directPeer: string | undefined;
  if (conv.kind === "dm" && conv.team_id === null) {
    const peer = ot.get<{owner_id: string}>(`SELECT teammate.owner_id FROM ot_conversation_members member
      JOIN ot_team_members teammate ON teammate.owner_id=member.owner_id AND teammate.team_id=? AND teammate.suspended=0
      WHERE member.conversation_id=? AND member.owner_id<>?`, team.id, conv.id, ownerId);
    assert(peer, 404, "conversation_not_found", "no such conversation in this workspace");
    directPeer = peer.owner_id;
  } else {
    assert(conv.team_id === team.id, 404, "conversation_not_found", "no such conversation in this workspace");
  }
  return {conv, directPeer};
}

const VISIBLE_MESSAGE = "NOT EXISTS (SELECT 1 FROM ot_hidden_messages hidden WHERE hidden.message_id=m.id AND hidden.owner_id=?)";

function replyOriginal(ot: OtContext, conversationId: string, messageId: string, viewer: string) {
  return ot.get<{body: string; author_kind: string; author_id: string; agent_name: string | null}>(`
    SELECT m.body,m.author_kind,m.author_id,m.agent_name FROM ot_messages m
    WHERE m.id=? AND m.conversation_id=? AND m.retracted=0 AND ${VISIBLE_MESSAGE}`, messageId, conversationId, viewer);
}

function replyPreview(ot: OtContext, message: any, viewer: string) {
  const original = replyOriginal(ot, message.conversation_id, message.reply_to, viewer);
  if (!original) return {message_id: message.reply_to, available: false};
  const author = original.author_kind === "agent" ? original.agent_name : ot.profileView(original.author_id).display_name;
  return {message_id: message.reply_to, available: true, author: author || "成员",
    excerpt: original.body.replace(/\s+/g, " ").trim().slice(0, 120)};
}

const messageView = (ot: OtContext, m: any, viewer?: string) => ({
  id: m.id, conversation_id: m.conversation_id, seq: m.seq,
  author: m.author_kind === "agent" ? { kind: "agent", agent_ref: m.agent_ref, name: m.agent_name, owner: ot.profileView(m.author_id) } : { kind: "member", ...ot.profileView(m.author_id) },
  mine: viewer ? m.author_id === viewer && m.author_kind === "member" : undefined,
  ...(viewer === m.author_id && m.author_kind === "member" && m.client_key ? {client_key: m.client_key} : {}),
  body: m.retracted ? "" : m.body, revision: m.revision, retracted: !!m.retracted, edited_at: m.edited_at, created_at: m.created_at,
  mentions: JSON.parse(m.mentions), ...(viewer ? {reply_jobs: replyJobViews(ot, m, viewer)} : {}), reply_to: m.reply_to, pinned: !!m.pinned_by,
  ...(viewer && m.reply_to && !m.retracted ? {reply_preview: replyPreview(ot, m, viewer)} : {}),
  ...(m.forwarded_author && !m.retracted ? {forwarded_from: {author: m.forwarded_author}} : {}),
  ...(m.author_kind === "agent" && !m.retracted ? {group_memory_refs:messageMemories(ot,m)} : {}),
  attachment: m.retracted ? undefined : attachmentView(ot, m.id),
  voice: m.retracted ? undefined : ot.get<{mime: string}>("SELECT mime FROM ot_voice_messages WHERE message_id=?", m.id),
  reactions: ot.all<any>("SELECT emoji, COUNT(*) AS n, SUM(owner_id = ?) AS me FROM ot_reactions WHERE message_id = ? GROUP BY emoji", viewer ?? "", m.id).map((r) => ({ emoji: r.emoji, count: r.n, mine: !!r.me })),
});

function requireVisibleMessage(ot: OtContext, id: string, owner: string) {
  assert(!ot.get("SELECT 1 FROM ot_hidden_messages WHERE owner_id=? AND message_id=?", owner, id),
    404, "message_not_found", "本账号已删除该消息。");
}

function hiddenCount(ot: OtContext, conversation: string, viewer: string, after = 0) {
  return ot.get<{n: number}>("SELECT COUNT(*) AS n FROM ot_hidden_messages WHERE owner_id=? AND conversation_id=? AND seq>?",
    viewer, conversation, after)!.n;
}

function unreadMessages(ot: OtContext, conversation: {id: string; last_seq: number}, viewer: string, read: number) {
  return Math.max(0, conversation.last_seq - read - hiddenCount(ot, conversation.id, viewer, read));
}

function pinnedMessages(ot: OtContext, conversation: string, viewer: string) {
  return ot.all<any>(`SELECT m.id, m.body, m.pinned_by FROM ot_messages m
    WHERE m.conversation_id=? AND m.pinned_by IS NOT NULL AND m.retracted=0 AND ${VISIBLE_MESSAGE}
    ORDER BY m.seq DESC LIMIT 100`, conversation, viewer)
    .map(m => ({message_id: m.id, excerpt: m.body.replace(/\s+/g, " ").slice(0, 100),
      pinned_by_username: ot.profileView(m.pinned_by).display_name}));
}

function contentVersion(c: {last_seq: number; activity_revision: number}, open: boolean, hidden: number) {
  return `${c.last_seq}.${c.activity_revision}.${Number(open)}.${hidden}`;
}

function registerActivityTriggers(ot: OtContext) {
  const message = (row: string) => `(SELECT conversation_id FROM ot_messages WHERE id=${row}.message_id)`;
  const changes = [
    {table: "ot_conversations", events: ["UPDATE OF title"], room: (row: string) => row + ".id"},
    {table: "ot_conversation_members", events: ["INSERT", "DELETE"]},
    {table: "ot_conversation_agents", events: ["INSERT", "UPDATE", "DELETE"]},
    {table: "ot_messages", events: ["UPDATE"]},
    {table: "ot_reactions", events: ["INSERT", "DELETE"], room: message},
    {table: "ot_agent_reply_jobs", events: ["INSERT", "UPDATE"], room: message},
    {table: "ot_group_announcements", events: ["INSERT", "UPDATE"]},
  ];
  for (const {table, events, room} of changes) for (const event of events) {
    const row = event === "DELETE" ? "old" : "new";
    ot.run(`CREATE TRIGGER IF NOT EXISTS ${table}_activity_${event.split(" ")[0].toLowerCase()}
      AFTER ${event} ON ${table} BEGIN
        UPDATE ot_conversations SET activity_revision=activity_revision+1 WHERE id=${room?.(row) ?? row + ".conversation_id"};
      END`);
  }
}

function conversationView(ot: OtContext, c: any, viewer: string) {
  const published = publicListing(ot, c);
  const members = ot.all<any>("SELECT owner_id, read_seq, pinned, muted FROM ot_conversation_members WHERE conversation_id = ? ORDER BY created_at", c.id).filter(m => publicParticipant(ot, c, m.owner_id));
  const mine = members.find((m) => m.owner_id === viewer);
  const last = ot.get<any>(`SELECT m.* FROM ot_messages m WHERE m.conversation_id=? AND ${VISIBLE_MESSAGE} ORDER BY m.seq DESC LIMIT 1`, c.id, viewer);
  const peer = c.kind === "dm" ? members.find((m) => m.owner_id !== viewer) : undefined;
  const open = !!(published?.listed && published.chat_enabled);
  const directOpen = Boolean(peer && ordinaryDirect(c) && directReachable(ot, viewer, peer.owner_id));
  const pending = open && !!ot.get(`SELECT 1 FROM ot_messages m
    WHERE m.conversation_id=? AND m.rowseq>? AND m.author_id=? AND m.author_kind='member' AND m.retracted=0
      AND m.created_at>? AND NOT EXISTS (
        SELECT 1 FROM ot_messages answer WHERE answer.conversation_id=m.conversation_id AND answer.reply_to=m.id
          AND answer.author_id=? AND answer.agent_ref=? AND answer.author_kind='agent')
    LIMIT 1`, c.id, published.chat_from, c.created_by, ot.now() - 180_000, published.owner_id, published.ref);
  return {
    ...(fixedPublicThread(c) ? {public_agent: {open, pending, publisher: published ? ot.profileView(published.owner_id).display_name : ""}} : {}),
    ...(ordinaryDirect(c) ? {direct: {open: directOpen}} : {}),
    ...(c.account_group === 1 ? {account_group: true} : {}),
    id: c.id, kind: c.kind, title: c.kind === "dm" ? (peer ? ot.profileView(peer.owner_id).display_name : c.title) : c.title,
    team_id: c.team_id, members: members.map((m) => ot.profileView(m.owner_id)),
    agents: ot.all<any>("SELECT agent_ref, owner_id, name, auto_reply FROM ot_conversation_agents WHERE conversation_id = ?", c.id).map((a) => ({ agent_ref: a.agent_ref, name: a.name, auto_reply: !!a.auto_reply, owner: ot.profileView(a.owner_id), mine: a.owner_id === viewer })),
    activity_version: contentVersion(c, open || directOpen, hiddenCount(ot, c.id, viewer)),
    last_seq: c.last_seq, read_seq: mine?.read_seq ?? 0, unread: unreadMessages(ot, c, viewer, mine?.read_seq ?? 0),
    pinned: !!mine?.pinned, muted: !!mine?.muted, last_message: last ? messageView(ot, last, viewer) : null, updated_at: c.updated_at,
  };
}

/** Everyone a member may start a conversation with: someone sharing an active team. */
function assertReachable(ot: OtContext, from: string, to: string, teamId?: string | null, accountGroup = false) {
  if (teamId) {
    const r = ot.get<any>("SELECT 1 FROM ot_team_members WHERE team_id = ? AND owner_id = ? AND suspended = 0", teamId, to);
    assert(r, 403, "not_in_team", "that member is not in this team");
  } else if (accountGroup) {
    assert(acceptedContact(ot, from, to), 403, "not_reachable", "请选择已确认的联系人。");
  } else {
    assert(shareTeam(ot, from, to), 403, "not_reachable", "you can message members of your teams");
  }
}

function insertMessage(ot: OtContext, conv: any, row: { author: string; kind: "member" | "agent"; agentRef?: string; agentName?: string; body: string; mentions: string[]; replyTo?: string | null; replyMode?: string | null; clientKey?: string | null; forwardedAuthor?: string }) {
  if (row.clientKey) {
    const dup = ot.get<any>("SELECT * FROM ot_messages WHERE conversation_id = ? AND author_id = ? AND client_key = ?", conv.id, row.author, row.clientKey);
    if (dup) return dup;
  }
  const seq = conv.last_seq + 1;
  const now = ot.now();
  const id = newId("otm");
  ot.run("INSERT INTO ot_messages(id, conversation_id, seq, author_id, author_kind, agent_ref, agent_name, body, mentions, reply_to, reply_mode, client_key, created_at, forwarded_author) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    id, conv.id, seq, row.author, row.kind, row.agentRef ?? null, row.agentName ?? null, row.body, JSON.stringify(row.mentions), row.replyTo ?? null, row.replyMode ?? null, row.clientKey ?? null, now, row.forwardedAuthor ?? null);
  ot.run("UPDATE ot_conversations SET last_seq = ?, updated_at = ? WHERE id = ?", seq, now, conv.id);
  if (row.kind === "member") ot.run("UPDATE ot_conversation_members SET read_seq = ? WHERE conversation_id = ? AND owner_id = ?", seq, conv.id, row.author);
  return ot.get<any>("SELECT * FROM ot_messages WHERE id = ?", id);
}

const agentMentionKey = (ownerId: string, ref: string) => `/agent/${ownerId}/${ref}`;

function agentMentioned(mentions: string[], agent: ReplyAgent) {
  return mentions.some(mention => mention.startsWith("/agent/"))
    ? mentions.includes(agentMentionKey(agent.owner_id, agent.agent_ref))
    : mentions.includes(agent.agent_ref.toLowerCase()) || mentions.includes(agent.name.toLowerCase());
}

function parseMentions(ot: OtContext, convId: string, raw: unknown, bodyText: string, selectedAgents: unknown) {
  const handles = new Set<string>();
  if (Array.isArray(raw)) for (const h of raw.slice(0, 20)) handles.add(handleKey(h));
  for (const m of bodyText.matchAll(/@([a-z0-9._-]{2,40})/gi)) handles.add(handleKey(m[1]));
  const members = new Set(ot.all<any>("SELECT p.handle FROM ot_conversation_members m JOIN ot_profiles p ON p.owner_id = m.owner_id WHERE m.conversation_id = ?", convId).map((r) => r.handle));
  const agents = ot.all<ReplyAgent>(
    "SELECT agent_ref, owner_id, name FROM ot_conversation_agents WHERE conversation_id = ?", convId,
  );
  if (selectedAgents === undefined) {
    const legacy = new Set(agents.flatMap(agent => [agent.agent_ref.toLowerCase(), agent.name.toLowerCase()]));
    const mentions = [...handles].filter(h => members.has(h) || legacy.has(h));
    return { mentions, body: bodyText, agents: agents.filter(agent => agentMentioned(mentions, agent)) };
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
    agents: agents.filter(agent => targets.has(agentMentionKey(agent.owner_id, agent.agent_ref))),
    body: prefix ? text(prefix + " " + bodyText, "body", { min: 1, max: BODY_MAX, multiline: true }) : bodyText,
  };
}

function replyContext(ot: OtContext, conversationId: string, seq: number) {
  return ot.all<any>(`SELECT * FROM (SELECT * FROM ot_messages
    WHERE conversation_id=? AND seq<=? ORDER BY seq DESC LIMIT 12) ORDER BY seq`, conversationId, seq).map(m => messageView(ot, m));
}

export function registerMessenger(app: FastifyInstance, ot: OtContext) {
  const conversationCols = new Set(ot.all<{name: string}>("PRAGMA table_info(ot_conversations)").map(col => col.name));
  if (!conversationCols.has("account_group")) ot.run("ALTER TABLE ot_conversations ADD COLUMN account_group INTEGER NOT NULL DEFAULT 0");
  if (!conversationCols.has("activity_revision")) ot.run("ALTER TABLE ot_conversations ADD COLUMN activity_revision INTEGER NOT NULL DEFAULT 0");
  registerActivityTriggers(ot);
  const messageCols = new Set(ot.all<any>("PRAGMA table_info(ot_messages)").map(c => c.name));
  if (!messageCols.has("revision")) ot.run("ALTER TABLE ot_messages ADD COLUMN revision INTEGER NOT NULL DEFAULT 1");
  if (!messageCols.has("forwarded_author")) ot.run("ALTER TABLE ot_messages ADD COLUMN forwarded_author TEXT");
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
      assert(directReachable(ot, me.ownerId, peer), 403, "not_reachable", "请先建立联系人关系。");
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
    const title = text(b.title ?? "新群聊", "title", { min: 1, max: 80 });
    const teamId = b.team_id ? String(b.team_id) : null;
    const accountGroup = b.account_group === true;
    assert(!accountGroup || !teamId, 400, "invalid_request", "A personal group has no team");
    if (teamId) requireMember(ot, teamId, me.ownerId);
    assert(Array.isArray(b.members ?? []) && (b.members ?? []).length <= 50, 400, "invalid_request", "members must be a list of at most 50 handles");
    const others = [...new Set((b.members ?? []).map((h: unknown) => ot.ownerByHandle(h)))].filter((o) => o !== me.ownerId) as string[];
    const selected = b.agents ?? [];
    assert(Array.isArray(selected) && selected.length <= 10, 400, "invalid_request", "Select at most 10 agents");
    const agents = new Map<string,string>();
    for (const agent of selected) {
      const ref = text(agent?.agent_ref, "agent_ref", {min:1, max:80});
      assert(AGENT_REF.test(ref), 400, "invalid_request", "Invalid agent identifier");
      agents.set(ref, text(agent?.name, "name", {min:1, max:40}));
    }
    assert(!accountGroup || (others.length < 50 && others.length + agents.size > 0), 400, "invalid_request", "请选择联系人或智能体。");
    const key = optText(b.idempotency_key, "idempotency_key", {min:16,max:80});
    const fingerprint = JSON.stringify([title, teamId, accountGroup, others.slice().sort(), [...agents].sort()]);
    const result = ot.tx(() => {
      const prior = key && ot.get<{conversation_id:string; fingerprint:string}>(
        "SELECT conversation_id,fingerprint FROM ot_group_requests WHERE owner_id=? AND request_key=?", me.ownerId, key);
      if (prior) {
        assert(prior.fingerprint === fingerprint, 409, "conflict", "Idempotency key reused");
        return {conv:memberOf(ot, prior.conversation_id, me.ownerId), created:false};
      }
      for (const o of others) assertReachable(ot, me.ownerId, o, teamId, accountGroup);
      const id = newId("otc"); const now = ot.now();
      ot.run("INSERT INTO ot_conversations(id,kind,title,team_id,created_by,created_at,updated_at,account_group) VALUES (?,'group',?,?,?,?,?,?)",
        id, title, teamId, me.ownerId, now, now, Number(accountGroup));
      for (const o of [me.ownerId, ...others]) ot.run("INSERT INTO ot_conversation_members(conversation_id, owner_id, created_at) VALUES (?,?,?)", id, o, now);
      for (const [ref, name] of agents) ot.run("INSERT INTO ot_conversation_agents(conversation_id,agent_ref,owner_id,name,created_at) VALUES (?,?,?,?,?)", id, ref, me.ownerId, name, now);
      for (const o of others) ot.notify(o, "messenger.added", {conversation_id:id, title, by:ot.profileView(me.ownerId), ...(teamId ? {team_id:teamId} : {})});
      if (key) ot.run("INSERT INTO ot_group_requests VALUES (?,?,?,?)", me.ownerId, key, fingerprint, id);
      return {conv:memberOf(ot, id, me.ownerId), created:true};
    });
    return reply.status(result.created ? 201 : 200).send(conversationView(ot, result.conv, me.ownerId));
  });

  app.get("/v1/ot/conversations", async (req) => {
    const me = ot.me(req);
    const {scope, team_id, view, since} = query(req);
    assert(scope === undefined || scope === "public" || scope === "member" || scope === "personal", 400, "invalid_request", "Invalid conversation scope");
    let filter = scope === "public" ? " AND c.dm_key LIKE 'agent:%'"
      : scope === "personal" ? " AND (c.dm_key LIKE 'agent:%' OR (c.kind='dm' AND c.team_id IS NULL) OR c.account_group=1)"
      : scope === "member" ? " AND (c.dm_key IS NULL OR c.dm_key NOT LIKE 'agent:%')" : "";
    const args = [me.ownerId];
    if (team_id !== undefined) {
      assert(scope === "member" && typeof team_id === "string", 400, "invalid_request", "Invalid team scope");
      requireMember(ot, team_id, me.ownerId);
      filter += ` AND (c.team_id=? OR (c.kind='dm' AND c.team_id IS NULL AND EXISTS (
        SELECT 1 FROM ot_conversation_members peer JOIN ot_team_members teammate
          ON teammate.owner_id=peer.owner_id AND teammate.team_id=? AND teammate.suspended=0
        WHERE peer.conversation_id=c.id AND peer.owner_id<>?)))`;
      args.push(team_id, team_id, me.ownerId);
    }
    const rows = ot.all<any>(`SELECT c.*, m.read_seq, m.pinned, m.muted FROM ot_conversations c
      JOIN ot_conversation_members m ON m.conversation_id=c.id
      WHERE m.owner_id=?${filter} ORDER BY m.pinned DESC,c.updated_at DESC,c.id LIMIT 200`, ...args)
      .filter(c => publicParticipant(ot, c, me.ownerId));
    if (view === "activity") {
      const items = rows.map(c => {
        const published = publicListing(ot, c);
        const peer = ordinaryDirect(c) && ot.get<{owner_id: string}>(
          "SELECT owner_id FROM ot_conversation_members WHERE conversation_id=? AND owner_id<>?", c.id, me.ownerId);
        const open = Boolean(published?.listed && published.chat_enabled || peer && directReachable(ot, me.ownerId, peer.owner_id));
        return {id: c.id, activity_version: contentVersion(c, open, hiddenCount(ot, c.id, me.ownerId)), last_seq: c.last_seq,
          unread_count: unreadMessages(ot, c, me.ownerId, c.read_seq), pinned: c.pinned === 1, muted: c.muted === 1};
      });
      const version = createHash("sha256").update(JSON.stringify(items)).digest("hex");
      return since === version ? {version} : {version, items};
    }
    const list = rows.map(c => conversationView(ot, c, me.ownerId));
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
      requireOrdinaryGroup(conv);
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
    requireOrdinaryGroup(conv);
    assert(conv.kind === "group", 400, "invalid_request", "members are added to groups only");
    const input = body(req);
    const teamId = input.team_id ?? conv.team_id;
    if (input.team_id !== undefined) {
      assert(!conv.account_group && typeof teamId === "string" && (!conv.team_id || conv.team_id === teamId),
        404, "not_found", "conversation not found in this team");
      requireMember(ot, teamId, me.ownerId);
    }
    const handles = input.handles === undefined ? [input.handle] : input.handles;
    assert(Array.isArray(handles) && handles.length >= 1 && handles.length <= 50
      && handles.every(handle => typeof handle === "string" && handle.trim().length > 0 && handle.length <= 80),
      400, "invalid_request", "Provide 1–50 member handles");
    const owners = new Set<string>(handles.map(handle => ot.ownerByHandle(handle)));
    const invitedBy = ot.profileView(me.ownerId);
    ot.tx(() => {
      const count = ot.get<{n:number}>("SELECT COUNT(*) AS n FROM ot_conversation_members WHERE conversation_id=?", conv.id)?.n ?? 0;
      let added = 0;
      for (const owner of owners) {
        if (ot.get("SELECT 1 FROM ot_conversation_members WHERE conversation_id = ? AND owner_id = ?", conv.id, owner)) continue;
        assert(!conv.account_group || count + added < 50, 409, "quota", "群成员已达上限。");
        assertReachable(ot, me.ownerId, owner, teamId, conv.account_group === 1);
        ot.run("INSERT INTO ot_conversation_members(conversation_id, owner_id, read_seq, created_at) VALUES (?,?,?,?)", conv.id, owner, conv.last_seq, ot.now());
        added++;
        ot.notify(owner, "messenger.added", { conversation_id: conv.id, title: conv.title, by: invitedBy,
          ...(teamId ? { team_id: teamId } : {}) });
      }
    });
    return conversationView(ot, conv, me.ownerId);
  });
  app.delete("/v1/ot/conversations/:id/members/:handle", async (req) => {
    const me = ot.me(req);
    const conv = memberOf(ot, params(req).id, me.ownerId);
    requireOrdinaryGroup(conv);
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
  const canAnnounce = (conv: any, owner: string) => conv.account_group === 1 ? conv.created_by === owner
    : !!conv.team_id && !!ot.get("SELECT 1 FROM ot_team_members WHERE team_id=? AND owner_id=? AND role IN ('owner','admin') AND suspended=0", conv.team_id, owner);
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
  const searchMessages = async (req: FastifyRequest) => {
    const me = ot.me(req);
    const {workspace} = params(req);
    const team = workspace ? workspaceTeam(ot, workspace, me.ownerId) : null;

    const q = query(req);
    const term = text(q.q, "q", { min: 1, max: 80 });
    const limit = Math.max(1, intParam(q.limit, "limit", 20, 51));
    assert(q.before === undefined || (typeof q.before === "string" && /^[0-9]{1,16}:[0-9]{1,16}$/.test(q.before)),
      400, "invalid_request", "Invalid search cursor");
    const [beforeTime, beforeRow] = typeof q.before === "string" ? q.before.split(":").map(Number) : [0, 0];
    assert(Number.isSafeInteger(beforeTime) && Number.isSafeInteger(beforeRow), 400, "invalid_request", "Invalid search cursor");
    assert(q.conversation_id === undefined || (typeof q.conversation_id === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(q.conversation_id)),
      400, "invalid_request", "Invalid conversation");
    const conversation = q.conversation_id ?? null;
    const scope = team
      ? `(c.team_id=? OR (c.kind='dm' AND c.team_id IS NULL AND EXISTS (
          SELECT 1 FROM ot_conversation_members peer
          JOIN ot_team_members teammate ON teammate.owner_id=peer.owner_id AND teammate.team_id=? AND teammate.suspended=0
          WHERE peer.conversation_id=c.id AND peer.owner_id<>?)))`
      : "(c.account_group=1 OR (c.kind='dm' AND c.team_id IS NULL))";
    const scopeArgs = team ? [team.id, team.id, me.ownerId] : [];
    const rows = ot.all<any>(`SELECT m.id, m.conversation_id, m.rowseq, m.body, m.created_at,
      CASE WHEN c.kind='dm' THEN (
        SELECT p.display_name FROM ot_conversation_members peer JOIN ot_profiles p ON p.owner_id=peer.owner_id
        WHERE peer.conversation_id=c.id AND peer.owner_id<>? LIMIT 1)
      ELSE c.title END AS title
      FROM ot_messages m
      JOIN ot_conversations c ON c.id=m.conversation_id
      JOIN ot_conversation_members mine ON mine.conversation_id=c.id AND mine.owner_id=?
      WHERE m.retracted=0 AND ${VISIBLE_MESSAGE} AND (? IS NULL OR c.id=?)
        AND ${scope}
        AND (?=0 OR m.created_at<? OR (m.created_at=? AND m.rowseq<?))
        AND instr(lower(m.body),lower(?))>0
      ORDER BY m.created_at DESC, m.rowseq DESC LIMIT ?`,
    me.ownerId, me.ownerId, me.ownerId, conversation, conversation, ...scopeArgs,
    beforeRow, beforeTime, beforeTime, beforeRow, term, limit + 1);
    const items = rows.slice(0, limit).map(row => ({
      conversation_id: row.conversation_id, message_id: row.id, title: row.title || "会话",
      body: row.body, created_ms: row.created_at, cursor: `${row.created_at}:${row.rowseq}`,
    }));
    return { items, more: rows.length > limit };
  };
  app.get("/v1/ot/workspaces/:workspace/messages/search", searchMessages);
  app.get("/v1/ot/messages/personal-search", searchMessages);
  const translationSources = async (req: FastifyRequest) => {
    const me = ot.me(req);
    const {workspace, id} = params(req);
    const conv = workspace ? workspaceConversation(ot, workspace, id, me.ownerId).conv
      : accountConversation(ot, id, me.ownerId);
    const input = body(req).items;
    assert(Array.isArray(input) && input.length <= 6, 400, "invalid_request", "Provide at most six message revisions");
    const sources = [];
    const seen = new Set();
    for (const item of input) {
      assert(typeof item?.id === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(item.id)
        && Number.isSafeInteger(item.revision) && item.revision > 0, 400, "invalid_request", "Invalid message revision");
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      const source = ot.get<{id: string; revision: number; body: string}>(`SELECT m.id, m.revision, m.body
        FROM ot_messages m WHERE m.conversation_id=? AND m.id=? AND m.revision=? AND m.retracted=0
        AND ${VISIBLE_MESSAGE} AND (m.author_kind='agent' OR m.author_id<>?)
        AND NOT EXISTS (SELECT 1 FROM ot_voice_messages v WHERE v.message_id=m.id)
        AND NOT EXISTS (SELECT 1 FROM ot_message_attachments a WHERE a.message_id=m.id)`,
      conv.id, item.id, item.revision, me.ownerId, me.ownerId);
      if (source?.body.trim()) sources.push(source);
    }
    return {sources};
  };
  app.post("/v1/ot/workspaces/:workspace/conversations/:id/translation-sources", translationSources);
  app.post("/v1/ot/conversations/:id/translation-sources", translationSources);
  app.get("/v1/ot/workspaces/:workspace/conversations/:id/messages/:message", async req => {
    const me = ot.me(req);
    const {workspace, id, message} = params(req);
    const {conv, directPeer} = workspaceConversation(ot, workspace, id, me.ownerId);
    const title = directPeer ? ot.profileView(directPeer).display_name : conv.title;
    requireVisibleMessage(ot, message, me.ownerId);
    const row = ot.get<{body: string; revision: number; retracted: number}>(`SELECT body, revision, retracted
      FROM ot_messages WHERE id=? AND conversation_id=?`, message, id);
    assert(row, 404, "message_not_found", "Message not found in this conversation");
    assert(!row.retracted && row.body.trim() && !attachmentView(ot, message)
      && !ot.get("SELECT 1 FROM ot_voice_messages WHERE message_id=?", message),
      409, "conflict", "Only available text messages can be saved");
    return { body: row.body, revision: row.revision, title };
  });
  app.get("/v1/ot/conversations/:id/messages", async (req) => {
    const me = ot.me(req);
    const q = query(req);
    const id = params(req).id;
    const conv = q.workspace_id === undefined
      ? memberOf(ot, id, me.ownerId)
      : workspaceConversation(ot, text(q.workspace_id, "workspace_id", {min: 32, max: 32}), id, me.ownerId).conv;
    const limit = Math.max(1, intParam(q.limit, "limit", 50, 200));
    const before = intParam(q.before, "before", 0);
    const after = intParam(q.after, "after", 0);
    const around = q.around;
    const term = q.q === undefined ? "" : text(q.q, "q", { min: 1, max: 80 });
    assert(!term || (around === undefined && !after), 400, "invalid_request", "Search supports only an older cursor");
    assert(Number(Boolean(before)) + Number(Boolean(after)) + Number(around !== undefined) <= 1,
      400, "invalid_request", "Choose one message cursor");
    const visible = `FROM ot_messages m WHERE m.conversation_id=? AND ${VISIBLE_MESSAGE}`;
    const scoped = [conv.id, me.ownerId];
    let rows;
    if (term) {
      const matches = ot.all<any>(`SELECT m.* ${visible} AND m.retracted=0
        AND (?=0 OR m.seq<?) AND instr(lower(m.body),lower(?))>0 ORDER BY m.seq DESC LIMIT ?`,
      ...scoped, before, before, term, limit + 1);
      const cursor = matches.length > limit ? matches[limit - 1].seq : null;
      return { messages: matches.slice(0, limit).map(m => messageView(ot, m, me.ownerId)), next_before: cursor };
    }
    if (around !== undefined) {
      assert(typeof around === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(around), 400, "invalid_request", "Invalid message ID");
      const anchor = ot.get<{seq: number}>(`SELECT m.seq ${visible} AND m.id=?`, ...scoped, around);
      assert(anchor, 404, "message_not_found", "Message not found in this conversation");
      const preceding = ot.all<any>(`SELECT m.* ${visible} AND m.seq<? ORDER BY m.seq DESC LIMIT ?`,
        ...scoped, anchor.seq, Math.floor((limit - 1) / 2));
      const following = ot.all<any>(`SELECT m.* ${visible} AND m.seq>=? ORDER BY m.seq LIMIT ?`,
        ...scoped, anchor.seq, limit - preceding.length);
      rows = [...preceding.reverse(), ...following];
    } else if (before) {
      rows = ot.all<any>(`SELECT m.* ${visible} AND m.seq<? ORDER BY m.seq DESC LIMIT ?`, ...scoped, before, limit).reverse();
    } else if (after) {
      rows = ot.all<any>(`SELECT m.* ${visible} AND m.seq>? ORDER BY m.seq LIMIT ?`, ...scoped, after, limit);
    } else {
      rows = ot.all<any>(`SELECT m.* ${visible} ORDER BY m.seq DESC LIMIT ?`, ...scoped, limit).reverse();
    }
    const first = rows[0]?.seq;
    const hasOlder = first > 1 && ot.get(`SELECT 1 ${visible} AND m.seq<? LIMIT 1`, ...scoped, first);
    const newest = rows.at(-1)?.seq ?? after;
    const hasNewer = newest < conv.last_seq && Boolean(ot.get(`SELECT 1 ${visible} AND m.seq>? LIMIT 1`, ...scoped, newest));
    const mine = ot.get<{read_seq: number}>("SELECT read_seq FROM ot_conversation_members WHERE conversation_id=? AND owner_id=?", ...scoped)!;
    return {
      messages: rows.map(m => messageView(ot, m, me.ownerId)), read_seq: mine.read_seq, last_seq: conv.last_seq,
      next_before: hasOlder ? first : null, has_newer: hasNewer,
      ...(q.pins === "1" ? {pinned_messages: pinnedMessages(ot, conv.id, me.ownerId)} : {}),
    };
  });
  app.post("/v1/ot/conversations/:id/messages", {bodyLimit: CHAT_FILE_BODY_LIMIT}, async (req, reply) => {
    const me = ot.me(req);
    const b = body(req);
    const sourceConversation = b.attachment_from === undefined ? null : text(b.attachment_from?.conversation_id, "conversation_id", {min: 1, max: 80});
    const sourceMessage = sourceConversation ? text(b.attachment_from?.message_id, "message_id", {min: 1, max: 80}) : null;
    assert(Number(b.voice !== undefined) + Number(b.attachment !== undefined) + Number(Boolean(sourceMessage)) <= 1,
      400, "invalid_request", "Send a single file per message");
    const clientKey = optText(b.client_key, "client_key", { min: 1, max: 80 }) ?? null;
    const replyTo = optText(b.reply_to, "reply_to", {min: 1, max: 80}) ?? null;
    const msg = ot.tx(() => {
      const direct = b.direct === true;
      const workspace = !direct && (sourceConversation || b.attachment !== undefined)
        ? text(b.workspace, "workspace", {min: 32, max: 32}) : "";
      const conv = direct ? accountConversation(ot, params(req).id, me.ownerId)
        : workspace ? workspaceConversation(ot, workspace, params(req).id, me.ownerId).conv
          : memberOf(ot, params(req).id, me.ownerId);
      if (clientKey) {
        const previous = ot.get<any>(
          "SELECT * FROM ot_messages WHERE conversation_id=? AND author_id=? AND client_key=?", conv.id, me.ownerId, clientKey,
        );
        if (previous) return previous;
      }
      if (fixedPublicThread(conv)) {
        const listing = publicListing(ot, conv);
        assert(listing?.listed && listing.chat_enabled, 409, "public_chat_closed", "公开智能体已关闭访客聊天。");
        assert(!sourceConversation && b.attachment === undefined && b.voice === undefined,
          400, "invalid_request", "访客聊天支持文字消息。");
        if (me.ownerId === conv.created_by) {
          const sent = ot.get<{n: number}>(`SELECT COUNT(*) AS n FROM ot_messages
            WHERE conversation_id=? AND author_id=? AND author_kind='member' AND created_at>?`, conv.id, me.ownerId, ot.now() - HOUR)!.n;
          assert(sent < MENTION_PER_HOUR, 429, "agent_reply_limit", "本会话发送频率已达上限，请稍后重试。");
        }
      }
      requireDirectReach(ot, conv, me.ownerId);
      const voice = b.voice === undefined ? null : voiceData(b.voice);
      let file = b.attachment === undefined ? null : decodeChatFile(b.attachment);
      if (sourceConversation && sourceMessage) {
        if (direct) accountConversation(ot, sourceConversation, me.ownerId);
        else workspaceConversation(ot, workspace, sourceConversation, me.ownerId);
        requireVisibleMessage(ot, sourceMessage, me.ownerId);
        file = readAttachment(ot, sourceConversation, sourceMessage);
      }
      const bodyText = text(b.body || file?.title || (voice ? "语音消息" : b.body), "body", {min: 1, max: BODY_MAX, multiline: true});
      if (replyTo) assert(replyOriginal(ot, conv.id, replyTo, me.ownerId), 409, "reply_unavailable", "原消息已不可回复，请取消引用。");
      const parsed = parseMentions(ot, conv.id, b.mentions, bodyText, b.agent_mentions);
      const mentions = parsed.mentions;
      const m = insertMessage(ot, conv, { author: me.ownerId, kind: "member", body: parsed.body, mentions, replyTo, clientKey });
      if (voice) ot.run("INSERT INTO ot_voice_messages VALUES (?,?,?)", m.id, voice.mime, voice.data);
      if (file) saveAttachment(ot, m.id, me.ownerId, file);
      if (conv.kind === "group" && !fixedPublicThread(conv) && !voice && !file) {
        for (const agent of parsed.agents) {
          ot.run(`INSERT INTO ot_agent_reply_jobs(id,message_id,owner_id,agent_ref,agent_name,status,updated_at)
            VALUES (?,?,?,?,?,'queued',?)`, newId("otj"), m.id, agent.owner_id, agent.agent_ref, agent.name, ot.now());
        }
      }
      for (const h of mentions) {
        const row = ot.get<any>("SELECT owner_id FROM ot_profiles WHERE handle = ?", h);
        if (row && row.owner_id !== me.ownerId) ot.notify(row.owner_id, "messenger.mention", { conversation_id: conv.id, message_id: m.id, by: ot.profileView(me.ownerId) });
      }
      return m;
    });
    return reply.status(201).send(messageView(ot, msg, me.ownerId));
  });
  app.post("/v1/ot/conversations/:id/forward", async (req, reply) => {
    const me = ot.me(req);
    const input = body(req);
    const sourceId = params(req).id;
    const targetId = text(input.target_conversation_id, "target_conversation_id", {min: 1, max: 80});
    const workspace = optText(input.workspace, "workspace", {min: 32, max: 32});
    const key = optText(input.request_key, "request_key", {min: 1, max: 80});
    assert(sourceId !== targetId, 400, "invalid_request", "请选择另一个会话。");
    assert(Array.isArray(input.message_ids) && input.message_ids.length > 0 && input.message_ids.length <= 20,
      400, "invalid_request", "请选择 1–20 条消息。");
    const ids = Array.from(new Set<string>(input.message_ids.map((id: unknown) => text(id, "message_id", {min: 1, max: 80})))).sort();
    const fingerprint = createHash("sha256").update(JSON.stringify([sourceId, targetId, workspace, ids])).digest("hex");
    const result = ot.tx(() => {
      const scoped = (id: string) => workspace ? workspaceConversation(ot, workspace, id, me.ownerId).conv
        : accountConversation(ot, id, me.ownerId);
      const source = scoped(sourceId), target = scoped(targetId);
      requireOrdinaryGroup(source);
      requireOrdinaryGroup(target);
      const prior = key && ot.get<{fingerprint: string; forwarded: number}>(
        "SELECT fingerprint,forwarded FROM ot_forward_requests WHERE owner_id=? AND request_key=?", me.ownerId, key);
      if (prior) {
        assert(prior.fingerprint === fingerprint, 409, "conflict", "此转发请求已用于另一批消息。");
        return {forwarded: prior.forwarded, target_conversation_id: target.id};
      }
      requireDirectReach(ot, target, me.ownerId);
      const originals = ot.all<any>(`SELECT m.* FROM ot_messages m WHERE m.conversation_id=? AND m.retracted=0
        AND ${VISIBLE_MESSAGE} AND m.id IN (${ids.map(() => "?").join(",")}) ORDER BY m.seq`, source.id, me.ownerId, ...ids);
      assert(originals.length === ids.length, 409, "forward_unavailable", "所选消息中有内容已不可转发，请重新选择。");
      for (const original of originals) {
        const author = original.forwarded_author || (original.author_kind === "agent"
          ? original.agent_name : ot.profileView(original.author_id).display_name);
        const copied = insertMessage(ot, target, {author: me.ownerId, kind: "member", body: original.body,
          mentions: [], forwardedAuthor: author || "成员"});
        target.last_seq = copied.seq;
        ot.run("INSERT INTO ot_voice_messages SELECT ?,mime,data FROM ot_voice_messages WHERE message_id=?", copied.id, original.id);
        if (attachmentView(ot, original.id)) {
          saveAttachment(ot, copied.id, me.ownerId, readAttachment(ot, source.id, original.id));
        }
      }
      if (key) ot.run("INSERT INTO ot_forward_requests VALUES (?,?,?,?,?)", me.ownerId, key, fingerprint, target.id, originals.length);
      return {forwarded: originals.length, target_conversation_id: target.id};
    });
    return reply.status(201).send(result);
  });
  app.get("/v1/ot/workspaces/:workspace/conversations/:id/messages/:message/file", async req => {
    const me = ot.me(req);
    const {workspace, id, message} = params(req);
    const {conv} = workspaceConversation(ot, workspace, id, me.ownerId);
    requireVisibleMessage(ot, message, me.ownerId);
    const file = readAttachment(ot, conv.id, message);
    return {title: file.title, mime: file.mime, data: file.data.toString("base64")};
  });
  app.get("/v1/ot/conversations/:id/messages/:message/file", async req => {
    const me = ot.me(req);
    const {id, message} = params(req);
    const conv = accountConversation(ot, id, me.ownerId);
    requireVisibleMessage(ot, message, me.ownerId);
    const file = readAttachment(ot, conv.id, message);
    return {title: file.title, mime: file.mime, data: file.data.toString("base64")};
  });
  app.get("/v1/ot/conversations/:id/messages/:message/voice", async req => {
    const me = ot.me(req);
    const conv = memberOf(ot, params(req).id, me.ownerId);
    requireVisibleMessage(ot, params(req).message, me.ownerId);
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
    return { read_seq: readSeq, unread: unreadMessages(ot, conv, me.ownerId, readSeq) };
  });
  const ownMessage = (id: string, ownerId: string, includeHidden = false) => {
    const m = ot.get<any>("SELECT * FROM ot_messages WHERE id = ?", id);
    assert(m, 404, "message_not_found", "no such message");
    memberOf(ot, m.conversation_id, ownerId);
    if (!includeHidden) requireVisibleMessage(ot, id, ownerId);
    return m;
  };
  app.post("/v1/ot/messages/:id/hide", async req => {
    const me = ot.me(req);
    const m = ownMessage(params(req).id, me.ownerId, true);
    assert(body(req).conversation_id === m.conversation_id, 404, "message_not_found", "Message not in this conversation");
    ot.run("INSERT OR IGNORE INTO ot_hidden_messages(owner_id,conversation_id,message_id,seq) VALUES (?,?,?,?)",
      me.ownerId, m.conversation_id, m.id, m.seq);
    return {hidden: true};
  });
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
    ot.tx(() => {
      ot.run("UPDATE ot_messages SET retracted = 1, revision = revision + 1, body = '', edited_at = ? WHERE id = ?", ot.now(), m.id);
      ot.run("DELETE FROM ot_message_attachments WHERE message_id=?", m.id);
    });
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
    const updated = ot.get("SELECT * FROM ot_messages WHERE id = ?", m.id);
    return { ...messageView(ot, updated, me.ownerId), pinned_messages: pinnedMessages(ot, m.conversation_id, me.ownerId) };
  });

  // ---- group agents (executed in their owner's DS-Bot)
  app.put("/v1/ot/conversations/:id/agents/:agent", async (req) => {
    const me = ot.me(req);
    const conv = memberOf(ot, params(req).id, me.ownerId);
    requireOrdinaryGroup(conv);
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
    requireOrdinaryGroup(conv);
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
    requireOrdinaryGroup(conv);
    ot.run("DELETE FROM ot_conversation_agents WHERE conversation_id = ? AND agent_ref = ? AND owner_id = ?", conv.id, params(req).agent, me.ownerId);
    return conversationView(ot, conv, me.ownerId);
  });
  app.post("/v1/ot/conversations/:id/messages/:message/agent-retry", async req => {
    const me = ot.me(req);
    const {id, message} = params(req);
    const jobId = text(body(req).job_id, "job_id", {min: 1, max: 80});
    return ot.tx(() => {
      const conv = memberOf(ot, id, me.ownerId);
      if (conv.team_id) requireMember(ot, conv.team_id, me.ownerId);
      const original = ot.get<any>(`SELECT * FROM ot_messages WHERE id=? AND conversation_id=? AND author_id=?
        AND author_kind='member' AND retracted=0`, message, id, me.ownerId);
      assert(original, 404, "message_not_found", "原消息已不可回复。");
      const job = ot.get<ReplyJob>(REPLY_JOB_SOURCE + " WHERE j.id=? AND j.message_id=?", jobId, message);
      assert(job, 404, "reply_job_not_found", "找不到这次回复。");
      const now = ot.now();
      assert(job.available && replyJobState(job, now) === "failed" && job.attempt < REPLY_JOB_ATTEMPTS,
        409, "reply_job_unavailable", "当前无法重试这次回复。");
      ot.run("UPDATE ot_agent_reply_jobs SET status='queued',attempt=attempt+1,updated_at=? WHERE id=?", now, job.id);
      return {reply_jobs: replyJobViews(ot, original, me.ownerId)};
    });
  });

  app.post("/v1/ot/agent-reply-jobs/:id", async req => {
    const me = ot.me(req);
    const b = body(req);
    assert(b.action === "start" || b.action === "fail", 400, "invalid_request", "Invalid reply job action");
    return ot.tx(() => {
      const job = ot.get<ReplyJob>(REPLY_JOB_SOURCE + " WHERE j.id=? AND j.owner_id=?", params(req).id, me.ownerId);
      assert(job, 404, "reply_job_not_found", "找不到这次回复。");
      const now = ot.now();
      const expected = b.action === "start" ? "queued" : "running";
      assert(job.attempt === b.attempt && replyJobState(job, now) === expected,
        409, "reply_job_unavailable", "这次回复的状态已更新。");
      ot.run("UPDATE ot_agent_reply_jobs SET status=?,updated_at=? WHERE id=?",
        b.action === "start" ? "running" : "failed", now, job.id);
      return {ok: true};
    });
  });

  app.post("/v1/ot/conversations/:id/memory-sources", async req => {
    const viewer = ot.me(req).ownerId;
    const conv = requireMemoryGroup(ot,params(req).id,viewer);
    const input = body(req);
    if (input.workspace_id === undefined) {
      assert(conv.account_group === 1,404,"not_found","该群聊不在个人工作区。");
    } else {
      const workspace = text(input.workspace_id,"workspace_id",{min:32,max:32});
      assert(workspaceTeam(ot,workspace,viewer).id === conv.team_id,404,"not_found","该群聊不在当前工作区。");
    }
    const membership = ot.get<{since:number}>(`SELECT MAX(member.created_at,COALESCE(team_member.created_at,0)) AS since
      FROM ot_conversation_members member LEFT JOIN ot_team_members team_member ON team_member.team_id=? AND team_member.owner_id=member.owner_id
      WHERE member.conversation_id=? AND member.owner_id=?`,conv.team_id,conv.id,viewer)!.since;
    const readable = `FROM ot_messages m WHERE m.conversation_id=? AND ${VISIBLE_MESSAGE}
      AND m.author_kind='member' AND m.retracted=0 AND trim(m.body)<>''
      AND NOT EXISTS (SELECT 1 FROM ot_message_attachments a WHERE a.message_id=m.id)
      AND NOT EXISTS (SELECT 1 FROM ot_voice_messages v WHERE v.message_id=m.id)`;
    const select = `SELECT m.id,m.seq,m.body,m.revision,m.author_id ${readable}`;
    let rows: {id:string;seq:number;body:string;revision:number;author_id:string}[];
    let cursor = conv.last_seq;
    if (input.after !== undefined) {
      assert(input.message_ids === undefined && Number.isSafeInteger(input.after) && input.after >= 0,
        400,"invalid_request","无效的群记忆游标。");
      rows = ot.all(`${select} AND m.seq>? AND m.created_at>=? ORDER BY m.seq LIMIT 13`,conv.id,viewer,input.after,membership);
      if (rows.length > 12) {
        rows.pop();
        cursor = rows[rows.length - 1].seq;
      }
    } else {
      const ids = input.message_ids;
      assert(Array.isArray(ids) && ids.length<=12 && new Set(ids).size===ids.length &&
        ids.every(id=>typeof id==="string" && /^[A-Za-z0-9._-]{1,80}$/.test(id)),400,"invalid_request","请选择有效的群聊消息。");
      rows = ids.length ? ot.all(`${select} AND m.id IN (${ids.map(()=>"?").join(",")}) ORDER BY m.seq`,conv.id,viewer,...ids) : [];
    }
    return {cursor,membership,items:rows.map(row=>({
      id:row.id,revision:row.revision,title:conv.title,author:ot.profileView(row.author_id).display_name || "群成员",text:row.body,
    }))};
  });

  app.get("/v1/ot/conversations/:id/memories", async req => {
    const viewer = ot.me(req).ownerId;
    const conv = requireMemoryGroup(ot,params(req).id,viewer);
    return {items:activeMemories(ot,conv.id).map(row => groupMemoryView(ot,row,conv,viewer))};
  });
  app.post("/v1/ot/conversations/:id/memories", async (req,reply) => {
    const viewer = ot.me(req).ownerId;
    const draft = body(req);
    const title = text(draft.title,"title",{min:1,max:80});
    const content = text(draft.body,"body",{min:1,max:8000,multiline:true});
    const key = text(draft.client_key,"client_key",{min:16,max:80});
    const primary = text(draft.source_message_id,"source_message_id",{min:1,max:80});
    assert(Array.isArray(draft.sources) && draft.sources.length >= 1 && draft.sources.length <= 12,400,"invalid_request","请选择群聊来源。");
    const keys = new Map<string,number>();
    for (const source of draft.sources) {
      const id = text(source?.id,"source_id",{min:1,max:80});
      assert(Number.isSafeInteger(source?.revision) && source.revision > 0 && !keys.has(id),400,"invalid_request","无效的来源版本。");
      keys.set(id,source.revision);
    }
    assert(keys.has(primary),400,"invalid_request","请提供主来源消息。");
    const fingerprint = createHash("sha256").update(JSON.stringify([title,content,primary,[...keys].sort()])).digest("hex");
    const result = ot.tx(() => {
      const conv = requireMemoryGroup(ot,params(req).id,viewer);
      const prior = ot.get<any>("SELECT * FROM ot_group_memories WHERE conversation_id=? AND author_id=? AND client_key=?",conv.id,viewer,key);
      if (prior) {
        assert(prior.fingerprint === fingerprint && ot.get(
          `SELECT 1 FROM ot_group_memories g WHERE g.id=? AND ${ACTIVE_MEMORIES}`, prior.id),
          409,"conflict","这个版本已移除或原消息已更新。");
        return {status:200,item:groupMemoryView(ot,prior,conv,viewer)};
      }
      for (const [id,revision] of keys) {
        const row = ot.get<any>("SELECT revision,author_kind,retracted FROM ot_messages WHERE id=? AND conversation_id=?",id,conv.id);
        requireVisibleMessage(ot,id,viewer);
        assert(row && row.revision===revision && row.author_kind==="member" && !row.retracted,409,"conflict","原消息已更新，请重新提炼。");
      }
      assert(activeMemories(ot,conv.id).length < 40,429,"quota","群记忆已满，请先移除一条旧记忆。");
      const id = newId("otgm");
      ot.run("INSERT INTO ot_group_memories VALUES(?,?,?,?,?,?,?,?,?,0)",id,conv.id,viewer,key,fingerprint,title,content,primary,ot.now());
      for (const [source,revision] of keys) ot.run("INSERT INTO ot_group_memory_sources VALUES(?,?,?)",id,source,revision);
      return {status:201,item:groupMemoryView(ot,ot.get("SELECT * FROM ot_group_memories WHERE id=?",id),conv,viewer)};
    });
    return reply.status(result.status).send({item:result.item});
  });
  app.delete("/v1/ot/conversations/:id/memories/:memory", async req => {
    const viewer = ot.me(req).ownerId;
    const conv = requireMemoryGroup(ot,params(req).id,viewer);
    const row = ot.get<any>("SELECT * FROM ot_group_memories WHERE conversation_id=? AND id=?",conv.id,params(req).memory);
    assert(row && (row.author_id===viewer || conv.created_by===viewer),404,"not_found","无法移除这条群记忆。");
    ot.run("UPDATE ot_group_memories SET removed=1 WHERE id=?",row.id);
    return {removed:true};
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
        AND NOT EXISTS (SELECT 1 FROM ot_message_attachments a WHERE a.message_id=m.id)
        AND EXISTS (SELECT 1 FROM ot_conversation_members cm WHERE cm.conversation_id=m.conversation_id AND cm.owner_id=?)
        AND EXISTS (SELECT 1 FROM ot_conversation_agents ca WHERE ca.conversation_id=m.conversation_id AND ca.owner_id=?)
      ORDER BY m.rowseq LIMIT ?
    )
    SELECT m.*, a.agent_ref AS my_agent, a.name AS my_agent_name, a.auto_reply AS my_auto, a.auto_reply_after_seq AS auto_after_seq
    FROM pending m JOIN ot_conversation_agents a ON a.conversation_id=m.conversation_id AND a.owner_id=?
    ORDER BY m.rowseq, a.agent_ref`, after, me.ownerId, me.ownerId, limit * 4, me.ownerId);
    const roomNotes = new Map<string, {id:string;title:string;body:string}[]>();
    const memories = (cid:string) => {
      if (!roomNotes.has(cid)) {
        let list: {id:string;title:string;body:string}[] = [];
        try {
          requireMemoryGroup(ot,cid,me.ownerId);
          list = activeMemories(ot,cid).map(({id,title,body})=>({id,title,body:body.slice(0,1500)}));
        } catch { /* Membership may have changed since the agent inbox was assembled. */ }
        roomNotes.set(cid,list);
      }
      return roomNotes.get(cid);
    };
    const managed = query(req).managed === "1";
    const jobs = managed ? ot.all<ReplyJob & {conversation_id: string; conversation_title: string; seq: number}>(
      REPLY_JOB_SOURCE + ` WHERE j.owner_id=? AND j.status='queued' AND j.updated_at>?
        AND available ORDER BY j.updated_at,j.rowid LIMIT ?`, me.ownerId, ot.now() - REPLY_JOB_TIMEOUT, Math.min(8, limit),
    ).map(job => {
      const message = ot.get<any>("SELECT * FROM ot_messages WHERE id=?", job.message_id);
      return {job_id: job.id, attempt: job.attempt, conversation_id: job.conversation_id,
        conversation_title: job.conversation_title, agent_ref: job.agent_ref, agent_name: job.agent_name,
        mode: "mention", message: messageView(ot, message), context: replyContext(ot, job.conversation_id, job.seq), group_memories:memories(job.conversation_id)};
    }) : [];
    let cursor = after;
    const items: any[] = [];
    for (const m of rows) {
      // A cursor acknowledges the entire message, including its other recipients.
      if (items.length >= limit && m.rowseq > cursor) break;
      cursor = Math.max(cursor, m.rowseq);
      const mentions: string[] = JSON.parse(m.mentions);
      const conv = ot.get<any>("SELECT dm_key,title,created_by FROM ot_conversations WHERE id=?", m.conversation_id);
      if (fixedPublicThread(conv)) {
        const listing = publicListing(ot, conv);
        if (!listing?.listed || !listing.chat_enabled || listing.owner_id !== me.ownerId
          || listing.ref !== m.my_agent || conv.created_by !== m.author_id || m.rowseq <= listing.chat_from
          || m.created_at <= ot.now() - 180_000
          || ot.get(`SELECT 1 FROM ot_messages WHERE conversation_id=? AND reply_to=? AND author_id=? AND agent_ref=?`,
            m.conversation_id, m.id, me.ownerId, m.my_agent)) continue;
        const context = ot.all<any>(`SELECT * FROM (SELECT * FROM ot_messages WHERE conversation_id=? AND seq<=?
          AND retracted=0 AND author_id IN (?,?) ORDER BY seq DESC LIMIT 12) ORDER BY seq`,
        m.conversation_id, m.seq, conv.created_by, listing.owner_id);
        items.push({ conversation_id: m.conversation_id, conversation_title: listing.title, agent_ref: listing.ref,
          agent_name: listing.title, mode: "public", message: messageView(ot, m), context: context.map(c => messageView(ot, c)),
          published: {title: listing.title, summary: listing.summary, snapshot: listing.snapshot} });
        continue;
      }
      const tracked = ot.get("SELECT 1 FROM ot_agent_reply_jobs WHERE message_id=? AND owner_id=? AND agent_ref=?",
        m.id, me.ownerId, m.my_agent);
      if (tracked && managed) continue;
      const mentioned = agentMentioned(mentions, {owner_id: me.ownerId, agent_ref: m.my_agent, name: m.my_agent_name});
      if (!mentioned && (!m.my_auto || m.seq <= m.auto_after_seq)) continue;
      items.push({ conversation_id: m.conversation_id, conversation_title: conv.title, agent_ref: m.my_agent, agent_name: m.my_agent_name,
        mode: mentioned ? "mention" : "auto", message: messageView(ot, m), context: replyContext(ot, m.conversation_id, m.seq), group_memories:memories(m.conversation_id) });
    }
    return managed ? { cursor, items, jobs } : { cursor, items };
  });
  app.post("/v1/ot/conversations/:id/agent-messages", async (req, reply) => {
    const me = ot.me(req);
    const b = body(req);
    const ref = String(b.agent_ref ?? "");
    const bodyText = text(b.body, "body", { min: 1, max: BODY_MAX, multiline: true });
    const mode = b.mode === "auto" ? "auto" : b.mode === "public" ? "public" : "mention";
    const msg = ot.tx(() => {
      const conv = memberOf(ot, params(req).id, me.ownerId);
      const agent = ot.get<any>("SELECT * FROM ot_conversation_agents WHERE conversation_id = ? AND agent_ref = ? AND owner_id = ?", conv.id, ref, me.ownerId);
      assert(agent, 404, "agent_not_found", "that agent of yours is not in this group");
      if (fixedPublicThread(conv)) {
        const listing = publicListing(ot, conv);
        assert(mode === "public" && listing?.listed && listing.chat_enabled && listing.owner_id === me.ownerId
          && listing.ref === ref, 409, "public_chat_closed", "公开智能体已关闭访客聊天。");
        const original = ot.get<any>(`SELECT * FROM ot_messages WHERE id=? AND conversation_id=? AND author_id=?
          AND author_kind='member' AND retracted=0`, String(b.reply_to ?? ""), conv.id, conv.created_by);
        assert(original && original.rowseq > listing.chat_from, 409, "public_chat_closed", "原消息已不可回复。");
        const answered = ot.get<any>(`SELECT * FROM ot_messages WHERE conversation_id=? AND reply_to=? AND author_id=?
          AND agent_ref=? AND author_kind='agent'`, conv.id, original.id, me.ownerId, ref);
        if (answered) return answered;
      } else {
        assert(mode !== "public", 400, "invalid_request", "Public mode requires a public agent thread");
      }
      const originalId = b.reply_to ? String(b.reply_to) : null;
      const job = originalId && mode === "mention" ? ot.get<ReplyJob>(REPLY_JOB_SOURCE
        + " WHERE j.message_id=? AND j.owner_id=? AND j.agent_ref=? AND src.conversation_id=?", originalId, me.ownerId, ref, conv.id) : undefined;
      if (b.job_id !== undefined) {
        assert(job && job.id === b.job_id && job.attempt === b.attempt && job.available
          && (job.status === "running" || job.status === "replied"),
        409, "reply_job_unavailable", "这次回复的状态已更新。");
      } else if (job) {
        // Older inbox clients can finish a first attempt while containers update.
        assert(job.available && job.attempt === 1 && job.status !== "failed",
          409, "reply_job_unavailable", "这次回复的状态已更新。");
      }
      if (job?.status === "replied") {
        return ot.get<any>(`SELECT * FROM ot_messages WHERE conversation_id=? AND reply_to=? AND author_id=?
          AND agent_ref=? AND author_kind='agent' AND reply_mode='mention' ORDER BY seq LIMIT 1`, conv.id, originalId, me.ownerId, ref);
      }
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
      const clientKey = job ? `job:${job.id}` : b.client_key ? text(b.client_key, "client_key", { min: 1, max: 80 }) : null;
      const prior = clientKey && ot.get<any>("SELECT * FROM ot_messages WHERE conversation_id=? AND author_id=? AND client_key=?",conv.id,me.ownerId,clientKey);
      if (prior) return prior;
      const refs = b.group_memory_ids ?? [];
      assert(Array.isArray(refs) && refs.length<=3 && refs.every(id=>typeof id==="string") && new Set(refs).size===refs.length,
        400,"invalid_request","无效的群记忆引用。");
      if (refs.length) {
        requireMemoryGroup(ot,conv.id,me.ownerId);
        const allowed = new Set(activeMemories(ot,conv.id).map(item=>item.id));
        assert(refs.every(id=>allowed.has(id)),409,"group_memory_changed","群记忆已更新，请重新生成回复。");
      }
      const response = insertMessage(ot, conv, { author: me.ownerId, kind: "agent", agentRef: agent.agent_ref,
        agentName: agent.name, body: bodyText, mentions: [], replyTo: originalId, replyMode: mode,
        clientKey });
      for (const id of refs) ot.run("INSERT OR IGNORE INTO ot_group_memory_references VALUES(?,?)",response.id,id);
      if (job) ot.run("UPDATE ot_agent_reply_jobs SET status='replied',updated_at=? WHERE id=?", ot.now(), job.id);
      return response;
    });
    return reply.status(201).send(messageView(ot, msg, me.ownerId));
  });
}
