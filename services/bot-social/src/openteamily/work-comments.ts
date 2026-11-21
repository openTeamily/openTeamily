// Comments on Discover public works: the one thing a signed-in member can add to another
// owner's published work. A work is public content, so the thread lives here beside the
// listing it belongs to (not in anyone's workspace), and a comment is flat — one level,
// oldest first — because replies are a separate slice. Deleting is a soft delete: the row
// stays for audit and the body is never returned again.
import type { FastifyInstance } from "fastify";
import { assert } from "../errors.js";
import { newId } from "../ids.js";
import { body, intParam, OtContext, params, query, text } from "./core.js";

export const BODY_MAX = 2_000;
export const PAGE_MAX = 50;
const SLUG = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

export const WORK_COMMENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS ot_work_comments (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES ot_listings(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS ot_work_comments_listing ON ot_work_comments(listing_id, created_at);
`;

/** Live (not soft-deleted) comments on one listing; the detail and feed cards report this. */
export function commentCount(ot: OtContext, listingId: string) {
  return ot.get<any>("SELECT COUNT(*) AS n FROM ot_work_comments WHERE listing_id = ? AND deleted_at IS NULL", listingId)?.n ?? 0;
}

/** Only a listed work has a public thread; an unlisted, missing or agent slug is a 404. */
function listedWork(ot: OtContext, slug: string) {
  const value = String(slug ?? "");
  assert(SLUG.test(value), 404, "listing_not_found", "no such listing");
  const listing = ot.get<any>("SELECT * FROM ot_listings WHERE slug = ? AND listed = 1", value);
  assert(listing && listing.kind === "work", 404, "listing_not_found", "no such listing");
  return listing;
}

const commentView = (ot: OtContext, row: any, viewer: string) => ({
  id: row.id, body: row.deleted_at ? "" : row.body, author: ot.profileView(row.owner_id),
  created_at: row.created_at, deleted: !!row.deleted_at, own: row.owner_id === viewer,
});

export function registerWorkComments(app: FastifyInstance, ot: OtContext) {
  // Oldest first, paged by insertion order: a later page never repeats or skips a row,
  // even when two comments share a millisecond.
  app.get("/v1/ot/works/:slug/comments", async (req) => {
    const me = ot.me(req);
    const q = query(req);
    const listing = listedWork(ot, params(req).slug);
    const after = intParam(q.after, "after", 0);
    const limit = intParam(q.limit, "limit", 20, PAGE_MAX);
    const rows = ot.all<any>(
      "SELECT rowid AS cursor, * FROM ot_work_comments WHERE listing_id = ? AND rowid > ? ORDER BY rowid ASC LIMIT ?",
      listing.id, after, limit);
    return {
      items: rows.map((row) => commentView(ot, row, me.ownerId)),
      next_after: rows.length === limit ? rows[rows.length - 1].cursor : null,
      comment_count: commentCount(ot, listing.id),
    };
  });

  app.post("/v1/ot/works/:slug/comments", async (req, reply) => {
    const me = ot.me(req);
    const listing = listedWork(ot, params(req).slug);
    const value = text(body(req).body, "body", { min: 1, max: BODY_MAX, multiline: true });
    assert(value.trim().length > 0, 400, "invalid_request", "body must not be blank");
    const id = newId("otwc");
    ot.run("INSERT INTO ot_work_comments(id, listing_id, owner_id, body, created_at, deleted_at) VALUES (?,?,?,?,?,NULL)",
      id, listing.id, me.ownerId, value, ot.now());
    return reply.status(201).send({
      comment: commentView(ot, ot.get("SELECT rowid AS cursor, * FROM ot_work_comments WHERE id = ?", id), me.ownerId),
      comment_count: commentCount(ot, listing.id),
    });
  });

  // Only the author deletes, and the row survives as a tombstone so paging and counts
  // stay stable for every other reader.
  app.delete("/v1/ot/works/:slug/comments/:id", async (req) => {
    const me = ot.me(req);
    const listing = listedWork(ot, params(req).slug);
    const row = ot.get<any>("SELECT rowid AS cursor, * FROM ot_work_comments WHERE id = ? AND listing_id = ?",
      params(req).id, listing.id);
    assert(row, 404, "comment_not_found", "no such comment");
    assert(row.owner_id === me.ownerId, 403, "forbidden", "only the author can delete a comment");
    if (!row.deleted_at) ot.run("UPDATE ot_work_comments SET deleted_at = ? WHERE id = ?", ot.now(), row.id);
    return { deleted: true, comment_count: commentCount(ot, listing.id) };
  });
}
