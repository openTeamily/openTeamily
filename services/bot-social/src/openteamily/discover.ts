// OpenTeamily Discover on Bot Social: opt-in public catalog of agents and works, likes, collections,
// creator follows and follow notifications. Ported from the legacy discover.py (#87, #313, #335).
// A listing is a whitelisted projection the owner's DS-Bot chose to publish (title, summary,
// category, kind and an optional explicitly released snapshot).
import type { FastifyInstance } from "fastify";
import { assert } from "../errors.js";
import { newId } from "../ids.js";
import { body, handleKey, hashCode, intParam, one, OtContext, optText, params, query, text } from "./core.js";

export const DISCOVER_SCHEMA = `
CREATE TABLE IF NOT EXISTS ot_listings (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('agent','work')), ref TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', category TEXT, work_kind TEXT,
  snapshot TEXT, listed INTEGER NOT NULL DEFAULT 1, chat_enabled INTEGER NOT NULL DEFAULT 0,
  chat_from INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (owner_id, kind, ref)
);
CREATE INDEX IF NOT EXISTS ot_listings_feed ON ot_listings(listed, updated_at);
CREATE TABLE IF NOT EXISTS ot_likes (listing_id TEXT NOT NULL REFERENCES ot_listings(id) ON DELETE CASCADE, owner_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (listing_id, owner_id));
CREATE TABLE IF NOT EXISTS ot_collections (listing_id TEXT NOT NULL REFERENCES ot_listings(id) ON DELETE CASCADE, owner_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (listing_id, owner_id));
CREATE TABLE IF NOT EXISTS ot_follows (follower_id TEXT NOT NULL, creator_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (follower_id, creator_id), CHECK (follower_id <> creator_id));
CREATE INDEX IF NOT EXISTS ot_follows_creator ON ot_follows(creator_id);
`;

export const CATEGORIES = ["content-creation", "customer-support", "data-analysis", "design", "education", "engineering", "finance", "it-security", "investment", "legal", "life", "marketing", "operations", "product", "recruiting", "research", "sales"];
export const WORK_KINDS = ["document", "website", "whiteboard", "media", "image", "audio", "video", "slides", "dashboard"];
const SLUG = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;
const RESERVED = new Set(["settings", "team", "members", "v1", "discover", "agents", "chat", "messenger", "space", "artifacts", "memory", "automations", "runtimes", "profile", "download", "install", "shell", "share", "a", "d", "api", "login", "logout", "search", "w", "works", "feed"]);
const REF = /^[A-Za-z0-9._:-]{1,80}$/;
const SNAPSHOT_MAX = 200_000;

function engagement(ot: OtContext, l: any, viewer: string) {
  const has = (table: string) => !!ot.get(`SELECT 1 FROM ${table} WHERE listing_id = ? AND owner_id = ?`, l.id, viewer);
  return {
    likes: ot.get<any>("SELECT COUNT(*) AS n FROM ot_likes WHERE listing_id = ?", l.id).n,
    collections: ot.get<any>("SELECT COUNT(*) AS n FROM ot_collections WHERE listing_id = ?", l.id).n,
    liked: has("ot_likes"), collected: has("ot_collections"),
    following: !!ot.get("SELECT 1 FROM ot_follows WHERE follower_id = ? AND creator_id = ?", viewer, l.owner_id),
    own: l.owner_id === viewer,
  };
}

/** Path prefix of PUBLIC_BASE_URL (e.g. `/social`) so cards on the site origin hit this Bot Social. */
export function publicPrefix(base: string) {
  try {
    const path = new URL(base).pathname.replace(/\/+$/, "");
    return path && path !== "/" ? path : "";
  } catch {
    return "";
  }
}

function listingPath(ot: OtContext, l: { kind: string; slug: string }) {
  const prefix = publicPrefix(ot.platform.publicBaseUrl);
  return `${prefix}${l.kind === "agent" ? "/a/" : "/w/"}${l.slug}`;
}

const listingView = (ot: OtContext, l: any, viewer: string | null, withSnapshot = false) => ({
  id: l.id, slug: l.slug, kind: l.kind, title: l.title, summary: l.summary, category: l.category, work_kind: l.work_kind,
  creator: ot.profileView(l.owner_id), listed: !!l.listed, chat_enabled: l.kind === "agent" && !!l.chat_enabled, updated_at: l.updated_at, created_at: l.created_at,
  path: listingPath(ot, l), ...(viewer ? engagement(ot, l, viewer) : { likes: ot.get<any>("SELECT COUNT(*) AS n FROM ot_likes WHERE listing_id = ?", l.id).n, collections: ot.get<any>("SELECT COUNT(*) AS n FROM ot_collections WHERE listing_id = ?", l.id).n, liked: false, collected: false, following: false, own: false }),
  ...(withSnapshot ? { snapshot: l.snapshot ?? null } : {}),
});

function escapeHtml(value: string) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function publishedQuickStarts(listing: {id: string; kind: string; snapshot: string | null}) {
  let starts: string[] = [];
  if (listing.kind === "agent" && listing.snapshot) {
    try {
      const choices = JSON.parse(listing.snapshot)?.quick_starts;
      if (Array.isArray(choices)) starts = choices.slice(0, 5).flatMap((item) => {
        if (typeof item !== "string" || !item.trim()) return [];
        try { return [text(item.trim(), "quick_start", {min: 1, max: 80})]; } catch { return []; }
      });
    } catch { /* An older listing may have no valid snapshot. */ }
  }
  return {starts, version: hashCode(JSON.stringify([listing.id, starts]))};
}

function publicPage(l: any, view: any) {
  const creator = view.creator?.display_name || view.creator?.handle || "";
  const title = String(view.title || view.slug);
  const policy = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none';";
  if (l.kind === "work") {
    const content = l.snapshot && !String(l.snapshot).startsWith("{")
      ? `<pre>${escapeHtml(String(l.snapshot).slice(0, 20_000))}</pre>`
      : (view.summary ? `<p>${escapeHtml(view.summary)}</p>` : "");
    return `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="${policy}">
<title>${escapeHtml(title)} · OpenTeamily</title>
<style>
body{font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;line-height:1.5;color:#1a1a1a}
.meta{color:#555;font-size:.9rem}
pre{white-space:pre-wrap;background:#f6f6f6;padding:1rem;border-radius:8px}
</style>
</head><body>
<p class="meta">作品${creator ? " · " + escapeHtml(creator) : ""}</p>
<h1>${escapeHtml(title)}</h1>
${content}
</body></html>
`;
  }

  const {starts, version} = publishedQuickStarts(l);
  const chatHref = `/login#public-agent=${encodeURIComponent(l.slug)}`;
  const canChat = Boolean(l.chat_enabled);
  const choiceItems = starts.map((choice, index) => {
    const content = escapeHtml(choice);
    if (!canChat) return `<li class="starter-preview">${content}</li>`;
    const href = escapeHtml(`${chatHref}&quick-start=${index}&quick-start-version=${version}`);
    return `<li><a class="starter" href="${href}"><span>${content}</span><span aria-hidden="true">↗</span></a></li>`;
  }).join("");
  const startList = choiceItems ? `
<section class="starters" aria-labelledby="quick-starts">
<h3 id="quick-starts">快捷开场</h3>
<ul>${choiceItems}</ul>
</section>` : "";
  return `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="${policy}">
<title>${escapeHtml(title)} · OpenTeamily</title>
<style>
:root{color-scheme:light;--ink:#192b28;--muted:#475b57;--surface:#fff;--line:#d7e1dd;--green:#24594b}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;color:var(--ink);background:#f3f7f3;font:1rem/1.6 system-ui,sans-serif}
a{color:var(--green)}
a:focus-visible{outline:2px solid #176750;outline-offset:4px}
.site-header{background:var(--surface);border-bottom:1px solid var(--line)}
.topbar{max-width:68rem;margin:auto;padding:.85rem 1.25rem;display:flex;align-items:center;justify-content:space-between;gap:.75rem}
.brand{display:inline-flex;align-items:center;gap:.55rem;color:var(--ink);font-weight:750;text-decoration:none}
.brand-mark{display:grid;place-items:center;width:1.85rem;height:1.85rem;border-radius:.55rem;background:var(--green);color:#fff;font-weight:800}
.discover{font-size:.9rem;text-underline-offset:3px}
.agent-home{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.1fr);align-items:start;gap:clamp(1.5rem,6vw,5rem);max-width:68rem;margin:auto;padding:clamp(2rem,8vw,6.5rem) 1.25rem}
.profile{min-width:0}
.avatar{display:grid;place-items:center;width:4rem;height:4rem;border:1px solid #bacfc3;border-radius:1.15rem;background:#e0eee3;color:#1b503f;font-weight:760;font-size:1.7rem}
h1{margin:.85rem 0 .4rem;font-size:clamp(2rem,4.5vw,3.6rem);line-height:1.13;letter-spacing:-.035em;overflow-wrap:anywhere}
h2,h3,p{margin:0}
.creator{color:var(--muted);font-size:.9rem;overflow-wrap:anywhere}
.description{margin-top:1.2rem;white-space:pre-wrap;overflow-wrap:anywhere}
.conversation{min-width:0;padding:1.45rem;border:1px solid var(--line);border-radius:1.25rem;background:var(--surface);box-shadow:0 10px 35px rgb(25 43 40 / .06)}
.conversation h2{font-size:1.25rem;line-height:1.25}
.help{margin:.55rem 0 1rem;color:var(--muted);font-size:.91rem}
.chat-action{display:inline-flex;align-items:center;justify-content:center;min-height:2.85rem;padding:.55rem 1.25rem;border-radius:.65rem;background:var(--green);color:#fff;font-weight:700;text-decoration:none}
.chat-action:hover{background:#19483c}
.starters{margin-top:1.5rem;padding-top:1rem;border-top:1px solid var(--line)}
.starters h3{margin-bottom:.7rem;font-size:.97rem}
.starters ul{display:grid;gap:.55rem;list-style:none;margin:0;padding:0}
.starter,.starter-preview{display:flex;justify-content:space-between;align-items:center;gap:.8rem;min-height:2.9rem;padding:.6rem .8rem;border:1px solid var(--line);border-radius:.65rem;background:#f8faf8;overflow-wrap:anywhere}
.starter{text-decoration:none}
.starter:hover{border-color:#98bead;background:#edf6ed}
@media(max-width:44rem){.agent-home{grid-template-columns:minmax(0,1fr);padding:1.65rem 1rem 2rem;gap:1.45rem}.topbar{padding-inline:1rem}.avatar{width:3rem;height:3rem;border-radius:.9rem;font-size:1.35rem}.conversation{padding:1.15rem}.chat-action{width:100%}}
</style>
</head><body>
<header class="site-header"><div class="topbar">
<a class="brand" href="/"><span class="brand-mark" aria-hidden="true">O</span>OpenTeamily</a>
<a class="discover" href="/discover?tab=agents">发现智能体</a>
</div></header>
<main class="agent-home">
<section class="profile" aria-labelledby="profile-title">
<div class="avatar" aria-hidden="true">${escapeHtml(Array.from(title.trim())[0]?.toUpperCase() || "O")}</div>
<h1 id="profile-title">${escapeHtml(title)}</h1>
${creator ? `<p class="creator">发布者 · ${escapeHtml(creator)}</p>` : ""}
${view.summary ? `<p class="description">${escapeHtml(view.summary)}</p>` : ""}
</section>
<section class="conversation" aria-labelledby="conversation-title">
<h2 id="conversation-title">网页对话</h2>
<p class="help">${canChat ? "登录后可以聊天，发布者可以查看对话。快捷开场会填入输入框。" : "该智能体暂未开放访客聊天。"}</p>
${canChat ? `<a class="chat-action" href="${escapeHtml(chatHref)}">开始对话</a>` : ""}
${startList}
</section>
</main>
</body></html>
`;
}

function listedBySlug(ot: OtContext, slug: string) {
  assert(SLUG.test(slug), 404, "listing_not_found", "no such listing");
  const l = ot.get<any>("SELECT * FROM ot_listings WHERE slug = ? AND listed = 1", slug);
  assert(l, 404, "listing_not_found", "no such listing");
  return l;
}

export function registerDiscover(app: FastifyInstance, ot: OtContext) {
  const columns = new Set(ot.all<{name: string}>("PRAGMA table_info(ot_listings)").map(column => column.name));
  if (!columns.has("chat_enabled")) ot.run("ALTER TABLE ot_listings ADD COLUMN chat_enabled INTEGER NOT NULL DEFAULT 0");
  if (!columns.has("chat_from")) ot.run("ALTER TABLE ot_listings ADD COLUMN chat_from INTEGER NOT NULL DEFAULT 0");

  app.put("/v1/ot/listings", async (req) => {
    const me = ot.me(req);
    const b = body(req);
    assert(b.kind === "agent" || b.kind === "work", 400, "invalid_request", "kind must be agent or work");
    assert(typeof b.ref === "string" && REF.test(b.ref), 400, "invalid_request", "ref is invalid");
    const title = text(b.title, "title", { min: 1, max: 80 });
    const summary = optText(b.summary, "summary", { max: 500, multiline: true }) ?? "";
    const category = b.category == null || b.category === "" ? null : String(b.category);
    assert(category === null || CATEGORIES.includes(category), 400, "invalid_request", "unknown category");
    const workKind = b.kind === "work" ? String(b.work_kind ?? "document") : null;
    assert(workKind === null || WORK_KINDS.includes(workKind), 400, "invalid_request", "unknown work kind");
    const snapshot = b.snapshot == null ? null : text(b.snapshot, "snapshot", { max: SNAPSHOT_MAX, multiline: true });
    const existing = ot.get<any>("SELECT * FROM ot_listings WHERE owner_id = ? AND kind = ? AND ref = ?", me.ownerId, b.kind, b.ref);
    assert(b.chat_enabled === undefined || (b.kind === "agent" && typeof b.chat_enabled === "boolean"),
      400, "invalid_request", "chat_enabled must be a boolean on an agent listing");
    const chatEnabled = b.kind === "agent" && (b.chat_enabled ?? !!(existing?.listed && existing.chat_enabled));
    const chatFrom = chatEnabled && existing?.listed && existing.chat_enabled ? existing.chat_from
      : chatEnabled ? ot.get<{seq: number}>("SELECT COALESCE(MAX(rowseq),0) AS seq FROM ot_messages")!.seq : 0;
    const slug = String(b.slug ?? existing?.slug ?? "");
    assert(SLUG.test(slug) && !RESERVED.has(slug), 400, "invalid_request", "slug must be 3-30 lowercase letters, digits or dashes");
    const clash = ot.get<any>("SELECT id FROM ot_listings WHERE slug = ?", slug);
    assert(!clash || clash.id === existing?.id, 409, "slug_taken", "that address is taken");
    const now = ot.now();
    const id = existing?.id ?? newId("otl");
    ot.tx(() => {
      if (existing) {
        ot.run("UPDATE ot_listings SET slug = ?, title = ?, summary = ?, category = ?, work_kind = ?, snapshot = ?, listed = 1, chat_enabled = ?, chat_from = ?, updated_at = ? WHERE id = ?", slug, title, summary, category, workKind, snapshot, Number(chatEnabled), chatFrom, now, id);
      } else {
        assert(ot.get<any>("SELECT COUNT(*) AS n FROM ot_listings WHERE owner_id = ?", me.ownerId).n < 500, 429, "too_many_listings", "listing limit reached");
        ot.run("INSERT INTO ot_listings(id, owner_id, kind, ref, slug, title, summary, category, work_kind, snapshot, chat_enabled, chat_from, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", id, me.ownerId, b.kind, b.ref, slug, title, summary, category, workKind, snapshot, Number(chatEnabled), chatFrom, now, now);
      }
      if (!existing || !existing.listed) {
        for (const f of ot.all<any>("SELECT follower_id FROM ot_follows WHERE creator_id = ? LIMIT 5000", me.ownerId)) {
          ot.notify(f.follower_id, "discover.published", { listing_id: id, slug, kind: b.kind, title, creator: ot.profileView(me.ownerId) });
        }
      }
    });
    return listingView(ot, ot.get("SELECT * FROM ot_listings WHERE id = ?", id), me.ownerId, true);
  });
  app.delete("/v1/ot/listings/:id", async (req) => {
    const me = ot.me(req);
    const r = ot.run("UPDATE ot_listings SET listed = 0, chat_enabled = 0, updated_at = ? WHERE id = ? AND owner_id = ?", ot.now(), params(req).id, me.ownerId);
    assert(r.changes === 1, 404, "listing_not_found", "no such listing of yours");
    return { unlisted: true };
  });
  app.get("/v1/ot/listings/mine", async (req) => {
    const me = ot.me(req);
    const rows = ot.all<any>("SELECT * FROM ot_listings WHERE owner_id = ? ORDER BY updated_at DESC", me.ownerId);
    return { listings: rows.map((l) => ({ ...listingView(ot, l, me.ownerId), ref: l.ref })) };
  });
  app.get("/v1/ot/discover", async (req) => {
    const me = ot.me(req);
    const q = query(req);
    const kind = one(q.kind, "kind");
    const tab = one(q.tab, "tab") ?? "all";
    const category = one(q.category, "category");
    const workKind = one(q.work_kind, "work_kind");
    const creator = one(q.creator, "creator");
    const search = (one(q.q, "q") ?? "").trim().toLowerCase().slice(0, 60);
    const before = intParam(q.before, "before", 0);
    const limit = intParam(q.limit, "limit", 30, 100);
    const where = ["l.listed = 1"]; const args: unknown[] = [];
    if (kind) { assert(kind === "agent" || kind === "work", 400, "invalid_request", "kind must be agent or work"); where.push("l.kind = ?"); args.push(kind); }
    if (category) { where.push("l.category = ?"); args.push(category); }
    if (workKind) { where.push("l.work_kind = ?"); args.push(workKind); }
    if (creator) { where.push("l.owner_id = ?"); args.push(ot.ownerByHandle(creator)); }
    if (tab === "following") { where.push("EXISTS (SELECT 1 FROM ot_follows f WHERE f.creator_id = l.owner_id AND f.follower_id = ?)"); args.push(me.ownerId); }
    else if (tab === "collected") { where.push("EXISTS (SELECT 1 FROM ot_collections c WHERE c.listing_id = l.id AND c.owner_id = ?)"); args.push(me.ownerId); }
    else assert(tab === "all", 400, "invalid_request", "tab must be all, following or collected");
    if (search) { where.push("(instr(lower(l.title), ?) > 0 OR instr(lower(l.summary), ?) > 0 OR instr(p.handle, ?) > 0 OR instr(lower(p.display_name), ?) > 0)"); args.push(search, search, search, search); }
    if (before) { where.push("l.updated_at < ?"); args.push(before); }
    const rows = ot.all<any>(`SELECT l.* FROM ot_listings l LEFT JOIN ot_profiles p ON p.owner_id = l.owner_id WHERE ${where.join(" AND ")} ORDER BY l.updated_at DESC, l.id DESC LIMIT ?`, ...args, limit);
    return { items: rows.map((l) => listingView(ot, l, me.ownerId)), next_before: rows.length === limit ? rows[rows.length - 1].updated_at : null };
  });
  app.get("/v1/ot/discover/:slug", async (req) => {
    const me = ot.me(req);
    const l = ot.get<any>("SELECT * FROM ot_listings WHERE slug = ?", params(req).slug);
    assert(l && (l.listed || l.owner_id === me.ownerId), 404, "listing_not_found", "no such listing");
    return listingView(ot, l, me.ownerId, true);
  });
  for (const [path, table] of [["like", "ot_likes"], ["collect", "ot_collections"]] as const) {
    app.post(`/v1/ot/listings/:id/${path}`, async (req) => {
      const me = ot.me(req);
      const l = ot.get<any>("SELECT * FROM ot_listings WHERE id = ? AND listed = 1", params(req).id);
      assert(l, 404, "listing_not_found", "no such listing");
      if (body(req).on === false) ot.run(`DELETE FROM ${table} WHERE listing_id = ? AND owner_id = ?`, l.id, me.ownerId);
      else ot.run(`INSERT OR IGNORE INTO ${table}(listing_id, owner_id, created_at) VALUES (?,?,?)`, l.id, me.ownerId, ot.now());
      return listingView(ot, l, me.ownerId);
    });
  }
  app.post("/v1/ot/follows", async (req) => {
    const me = ot.me(req);
    const b = body(req);
    const creator = ot.ownerByHandle(b.handle);
    assert(creator !== me.ownerId, 400, "invalid_request", "you cannot follow yourself");
    if (b.on === false) {
      ot.run("DELETE FROM ot_follows WHERE follower_id = ? AND creator_id = ?", me.ownerId, creator);
      return { following: false };
    }
    const r = ot.run("INSERT OR IGNORE INTO ot_follows(follower_id, creator_id, created_at) VALUES (?,?,?)", me.ownerId, creator, ot.now());
    if (r.changes) ot.notify(creator, "follow.new", { follower: ot.profileView(me.ownerId) });
    return { following: true };
  });
  app.get("/v1/ot/follows", async (req) => {
    const me = ot.me(req);
    const handle = one(query(req).handle, "handle");
    const who = handle ? ot.ownerByHandle(handleKey(handle)) : me.ownerId;
    return {
      following: ot.all<any>("SELECT creator_id FROM ot_follows WHERE follower_id = ? ORDER BY created_at DESC LIMIT 500", who).map((r) => ot.profileView(r.creator_id)),
      followers: ot.all<any>("SELECT follower_id FROM ot_follows WHERE creator_id = ? ORDER BY created_at DESC LIMIT 500", who).map((r) => ot.profileView(r.follower_id)),
    };
  });

  // Public catalog pages: no connector token. The isolated site exposes them at
  // https://<origin>/social/a/<slug> and /social/w/<slug> through the existing edge prefix.
  app.get("/v1/ot/public/listings/:slug", async (req, reply) => {
    const l = listedBySlug(ot, params(req).slug);
    if (l.kind === "agent") reply.header("Cache-Control", "no-store");
    return listingView(ot, l, null, true);
  });
  const sendPublic = async (req: any, reply: any, kind: "agent" | "work") => {
    if (kind === "agent") reply.header("Cache-Control", "no-store");
    const l = listedBySlug(ot, params(req).slug);
    assert(l.kind === kind, 404, "listing_not_found", "no such listing");
    const view = listingView(ot, l, null, true);
    const accept = String(req.headers.accept || "");
    if (accept.includes("application/json") && !accept.includes("text/html")) return view;
    reply.header("Content-Type", "text/html; charset=utf-8");
    if (kind === "work") reply.header("Cache-Control", "public, max-age=60");
    return reply.send(publicPage(l, view));
  };
  app.get("/a/:slug", async (req, reply) => sendPublic(req, reply, "agent"));
  app.get("/w/:slug", async (req, reply) => sendPublic(req, reply, "work"));
  app.get("/w/:slug/preview", async (req) => {
    const l = listedBySlug(ot, params(req).slug);
    assert(l.kind === "work", 404, "listing_not_found", "no such listing");
    const snapshot = l.snapshot ? String(l.snapshot).slice(0, 2000) : "";
    return { preview: snapshot.startsWith("{") ? (listingView(ot, l, null).summary || "") : snapshot };
  });

  // Public homepage "start a conversation": a signed-in visitor talks to the creator's
  // agent. Bot Social creates one private thread (visitor + creator) with that agent
  // attached; the creator's own DS-Bot answers through its agent inbox.
  app.post("/v1/ot/discover/:slug/start", async (req, reply) => {
    const me = ot.me(req);
    const input = body(req);
    assert(input && typeof input === "object" && !Array.isArray(input), 400, "invalid_request", "Invalid public chat request");
    const quick = Object.keys(input).length !== 0;
    if (quick) {
      assert(Object.keys(input).length === 2 && Number.isInteger(input.quick_start)
        && input.quick_start >= 0 && input.quick_start <= 4
        && typeof input.quick_start_version === "string" && /^[a-f0-9]{64}$/.test(input.quick_start_version),
      400, "invalid_request", "请选择有效的快捷开场。");
    }
    const result = ot.tx(() => {
      const l = listedBySlug(ot, params(req).slug);
      assert(l.kind === "agent", 404, "listing_not_found", "no such listing");
      assert(l.chat_enabled, 409, "public_chat_closed", "该智能体未开放访客聊天。");
      assert(l.owner_id !== me.ownerId, 400, "invalid_request", "this is your own agent");
      let draftText: string | undefined;
      if (quick) {
        const {starts, version} = publishedQuickStarts(l);
        draftText = starts[input.quick_start];
        assert(draftText && input.quick_start_version === version, 409, "quick_start_changed", "快捷开场已更新，请返回公开主页重新选择。");
      }
      const key = `agent:${l.id}:${me.ownerId}`;
      const existing = ot.get<{id: string; created_by: string}>("SELECT id, created_by FROM ot_conversations WHERE dm_key = ?", key);
      const id = existing?.id ?? newId("otc");
      if (!existing) {
        const now = ot.now();
        const title = String(l.title).slice(0, 80);
        ot.run("INSERT INTO ot_conversations(id, kind, title, dm_key, created_by, created_at, updated_at) VALUES (?, 'group', ?, ?, ?, ?, ?)",
          id, title, key, me.ownerId, now, now);
        for (const owner of [me.ownerId, l.owner_id]) {
          ot.run("INSERT INTO ot_conversation_members(conversation_id, owner_id, created_at) VALUES (?,?,?)", id, owner, now);
        }
        ot.run("INSERT INTO ot_conversation_agents(conversation_id, agent_ref, owner_id, name, auto_reply, created_at) VALUES (?,?,?,?,1,?)",
          id, l.ref, l.owner_id, title, now);
        if (!quick) ot.notify(l.owner_id, "discover.conversation_started", {
          listing_id: l.id, slug: l.slug, conversation_id: id, visitor: ot.profileView(me.ownerId),
        });
      } else {
        assert(existing.created_by === me.ownerId && ot.get(
          "SELECT 1 FROM ot_conversation_members WHERE conversation_id=? AND owner_id=?", id, me.ownerId,
        ), 404, "conversation_not_found", "no such conversation");
      }
      return {conversation_id: id, agent_ref: l.ref, created: !existing, ...(draftText ? {draft_text: draftText} : {})};
    });
    return reply.status(result.created ? 201 : 200).send(result);
  });
}
