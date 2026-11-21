// Comments on Discover public works: oldest-first paging, author soft delete, refusal on
// missing or unlisted works, body limits that store nothing, and the count on the detail.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { bulkAuth, startServer } from "./helpers.js";
import { home } from "./openteamily_helpers.js";

let S: Awaited<ReturnType<typeof startServer>>;
before(async () => { S = await startServer(bulkAuth); });
after(async () => { await S.stop(); });

let n = 0;
const slugFor = (prefix: string) => `${prefix}-${(Date.now() % 100000).toString(36)}${(++n).toString(36)}`;

async function publish(owner: any, slug: string, extra: Record<string, unknown> = {}) {
  return owner.ok("PUT", "/v1/ot/listings", {
    kind: "work", ref: `ref-${slug}`, slug, title: "Reusable report", work_kind: "document",
    snapshot: "# Body\n- one line", ...extra,
  });
}

test("a work's comments list oldest first and page by cursor", async () => {
  const A = await home(S.base, "comment-author");
  const B = await home(S.base, "comment-reader");
  const slug = slugFor("comments");
  await publish(A, slug);

  const first = await A.ok("POST", `/v1/ot/works/${slug}/comments`, { body: "第一条" });
  await B.ok("POST", `/v1/ot/works/${slug}/comments`, { body: "second one" });
  const third = await A.ok("POST", `/v1/ot/works/${slug}/comments`, { body: "第三条" });
  assert.equal(first.comment.body, "第一条");
  assert.equal(first.comment.own, true);
  assert.equal(typeof first.comment.created_at, "number");

  const page1 = await B.ok("GET", `/v1/ot/works/${slug}/comments?limit=2`);
  assert.deepEqual(page1.items.map((row: any) => row.body), ["第一条", "second one"], "oldest first");
  assert.equal(page1.items[0].author.handle, A.handle);
  assert.equal(page1.items[0].own, false, "a reader is not the author");
  assert.equal(page1.items[1].own, true);
  assert.ok(Number.isInteger(page1.next_after), "a full page carries a cursor");

  const page2 = await B.ok("GET", `/v1/ot/works/${slug}/comments?limit=2&after=${page1.next_after}`);
  assert.deepEqual(page2.items.map((row: any) => row.body), ["第三条"]);
  assert.equal(page2.next_after, null, "the last page has no cursor");
  assert.equal(third.comment.body, "第三条");
});

test("an author soft-deletes their own comment and cannot delete another's", async () => {
  const A = await home(S.base, "comment-owner");
  const B = await home(S.base, "comment-other");
  const slug = slugFor("delete");
  await publish(A, slug);
  const mine = await A.ok("POST", `/v1/ot/works/${slug}/comments`, { body: "我写的" });
  await B.ok("POST", `/v1/ot/works/${slug}/comments`, { body: "别人写的" });

  assert.equal((await B.call("DELETE", `/v1/ot/works/${slug}/comments/${mine.comment.id}`)).status, 403);
  const kept = await A.ok("GET", `/v1/ot/works/${slug}/comments`);
  assert.deepEqual(kept.items.map((row: any) => row.body), ["我写的", "别人写的"], "a refused delete keeps the row");

  await A.ok("DELETE", `/v1/ot/works/${slug}/comments/${mine.comment.id}`);
  const after = await A.ok("GET", `/v1/ot/works/${slug}/comments`);
  const tombstone = after.items.find((row: any) => row.id === mine.comment.id);
  assert.equal(tombstone.deleted, true);
  assert.equal(tombstone.body, "", "a soft-deleted body is never returned");
  assert.equal((await A.call("DELETE", `/v1/ot/works/${slug}/comments/otwc_missing`)).status, 404);
});

test("a comment on a missing, unlisted or agent listing is 404", async () => {
  const A = await home(S.base, "comment-scope");
  const slug = slugFor("scope");
  assert.equal((await A.call("POST", `/v1/ot/works/no-such-work-${slug}/comments`, { body: "hi" })).status, 404);
  assert.equal((await A.call("GET", `/v1/ot/works/no-such-work-${slug}/comments`)).status, 404);

  const listing = await publish(A, slug);
  assert.equal((await A.call("GET", `/v1/ot/works/${slug}/comments`)).status, 200);
  await A.ok("DELETE", `/v1/ot/listings/${listing.id}`);
  assert.equal((await A.call("POST", `/v1/ot/works/${slug}/comments`, { body: "hi" })).status, 404,
    "an unlisted work takes no new comments");
  assert.equal((await A.call("GET", `/v1/ot/works/${slug}/comments`)).status, 404);

  const agent = await A.ok("PUT", "/v1/ot/listings", { kind: "agent", ref: "comment_agent", slug: slugFor("agent"), title: "Agent" });
  assert.equal((await A.call("POST", `/v1/ot/works/${agent.slug}/comments`, { body: "hi" })).status, 404);
});

test("an empty or overlong comment is refused and nothing is stored", async () => {
  const A = await home(S.base, "comment-limits");
  const slug = slugFor("limits");
  await publish(A, slug);
  for (const body of ["", "   \n  ", "x".repeat(2001)]) {
    assert.equal((await A.call("POST", `/v1/ot/works/${slug}/comments`, { body })).status, 400,
      `refused: ${JSON.stringify(body.slice(0, 8))}`);
  }
  assert.equal((await A.call("POST", `/v1/ot/works/${slug}/comments`, {})).status, 400);
  const empty = await A.ok("GET", `/v1/ot/works/${slug}/comments`);
  assert.deepEqual(empty.items, [], "a refused comment writes nothing");
  assert.equal((await A.ok("GET", `/v1/ot/discover/${slug}`)).comment_count, 0);

  const long = "x".repeat(2000);
  const saved = await A.ok("POST", `/v1/ot/works/${slug}/comments`, { body: long });
  assert.equal(saved.comment.body.length, 2000, "the limit itself is accepted");
});

test("the work detail and the feed report how many live comments a work has", async () => {
  const A = await home(S.base, "comment-count");
  const B = await home(S.base, "comment-count-reader");
  const slug = slugFor("count");
  await publish(A, slug);
  const one = await A.ok("POST", `/v1/ot/works/${slug}/comments`, { body: "one" });
  await B.ok("POST", `/v1/ot/works/${slug}/comments`, { body: "two" });
  assert.equal((await B.ok("GET", `/v1/ot/discover/${slug}`)).comment_count, 2);
  await A.ok("DELETE", `/v1/ot/works/${slug}/comments/${one.comment.id}`);
  assert.equal((await B.ok("GET", `/v1/ot/discover/${slug}`)).comment_count, 1, "a deleted comment is not counted");
  const card = (await B.ok("GET", `/v1/ot/discover?q=reusable`, )).items.find((row: any) => row.slug === slug);
  assert.equal(card.comment_count, 1, "the feed card carries the same count");
});
