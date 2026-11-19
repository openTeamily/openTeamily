# Memory pages, next actions, and the relationship graph

Related: [#8](https://github.com/openTeamily/openTeamily/issues/8), [#1](https://github.com/openTeamily/openTeamily/issues/1). Those tracking issues stay open.

This slice stores workspace-scoped **memory pages**, **next actions**, optional **topics**, and a **relationship graph**. Pages and actions are written to the store as soon as they are created, and the author (or an owner/admin) can edit or delete them. The graph is built from page topics, `[[Title]]` mentions in page bodies, and optional manual links. It is self-written and is **not** Teamily `/memory` parity.

## Routes (session + CSRF)

| Method | Path | Behavior |
|---|---|---|
| GET | `/v1/workspaces/{id}/memory` | Lists pages (title, topics, a bounded `preview`, and metadata; no body). Optional `q`, `limit`, `cursor` |
| POST | `/v1/workspaces/{id}/memory` | Create `{title, body, topics?}`. `body` may be empty. `topics` is a list of names. Requires an Idempotency-Key |
| GET | `/v1/workspaces/{id}/memory/{id}` | One page, including body and topics |
| POST | `/v1/workspaces/{id}/memory/{id}` | Revisioned `{revision, changes: {title?, body?, topics?}}` |
| POST | `/v1/workspaces/{id}/memory/{id}/remove` | Delete the page |
| GET | `/v1/workspaces/{id}/memory/graph` | Nodes (pages), edges, topics and counts for this workspace |
| POST | `/v1/workspaces/{id}/memory/links` | Create an undirected manual link `{source, target}` between two pages. Requires an Idempotency-Key |
| POST | `/v1/workspaces/{id}/memory/links/{id}/remove` | Delete a manual link |
| GET | `/v1/workspaces/{id}/memory/actions` | Lists actions (title and metadata only; no notes). Optional `q`, `status` (`open` or `done`), `limit`, `cursor` |
| POST | `/v1/workspaces/{id}/memory/actions` | Create `{title, notes?, due_at?, memory_page_id?}`. `notes` may be empty. Status starts as `open`. Requires an Idempotency-Key |
| GET | `/v1/workspaces/{id}/memory/actions/{id}` | One action, including notes |
| POST | `/v1/workspaces/{id}/memory/actions/{id}` | Revisioned `{revision, changes: {title?, notes?, status?, due_at?, memory_page_id?}}`. `due_at` or `memory_page_id` may be `null` to clear |
| POST | `/v1/workspaces/{id}/memory/actions/{id}/remove` | Delete the action |

Page titles are unique per workspace (case-insensitive). Action titles are not unique. Default caps are 100 pages, 200 actions and 500 manual links. A page may have up to 8 topics; names are 1–40 characters and are unique per page case-insensitively. Tables are additive; `user_version` stays 1. A same-origin editor and overview graph are at `/memory`. The recorded footer hint on the overview graph is「单击查看 · 双击打开 · 悬停预览」. With fewer than two memory pages, and when the topic search is empty, the canvas also shows「创建两个或更多记忆页后，这里会把它们连成图谱」plus a「新建记忆页」button that reuses the existing create flow. This empty-state explanation and entry are OpenTeamily additions, not recorded or accepted Teamily empty-state typography. At widths up to 700px, the existing panels stack with the graph first so two fixed side columns cannot squeeze the hint and zoom controls into an overlapping sliver. This narrow-screen adaptation is also an uncompared OpenTeamily addition. Click still opens the existing editor (the difference between「查看」and「打开」was not recaptured, so this slice does not invent a select-only click). Double-click and Enter open the same page. Hovering a node for 300ms shows a preview card with the page title, the existing list `preview`, and topic tags; leaving the node or pressing Escape hides it. The hover delay, card typography, and the no-hover rule on `pointer: coarse` or a 390-wide viewport were not timed or restyled against a Teamily hover capture. Recorded Teamily views `/memory?page=profile` and `/memory?page=todos` are served by the same page. The profile view keeps the three recorded section headings and now provides private per-user/workspace text editing and save; 「做梦」 stays disabled. The todos view reuses the existing next-actions API. Empty copy is the recorded「当前没有可预期的事项。」

The `/memory` left directory now follows the recorded chrome: the heading is「记忆」,「+ 新建」is the existing create control (it still writes a page immediately), search uses the recorded「搜索主题……」placeholder, and the view list is vertical with icons (总览 / 我的资料 / 下一步行动 / 我的作品 / 我的会议). Directory rows use an original document icon, the page title, a one-line `preview` from the existing body (whitespace-collapsed, capped at 160 characters, same helper as message search), and a meta line of the UTC date plus `#topic` labels. 「收起侧边栏」hides the directory for the current page view only and leaves an「展开侧边栏」control; that collapsed layout was not recaptured, is not persisted, and is not a contrast claim. Unread counts,「新」badges, generated profile text and a recapture-wiki Getting Started group are still not invented. List search still matches titles only.

`[[Title]]` mentions in a page body create graph edges to an existing same-workspace page with that title. Missing titles and self-mentions are ignored. A manual link and a mention between the same pair appear as one edge (`manual` if a stored link exists). Deleting a page removes its topics and manual links, and mention edges disappear with the body.

`due_at` is an optional Unix timestamp in seconds. `memory_page_id` must refer to a page in the same workspace; deleting that page clears the link and keeps the action.

## Permissions

Workspace members may list, read and create pages and actions, read the graph, and create manual links. The author, an owner or an admin may edit or remove a page, action or manual link. A member cannot change someone else's item (`403`). Callers who cannot see the workspace receive `404`.

## Not in this slice

The profile page now uses the revisioned save API below. 「做梦」 was not opened in the recapture and is not implemented. Versions beyond the revision number and share or export links remain later slices on issue 8 and issue 9. "我的作品" already links to `/space`. "我的会议" now follows the same pattern and opens the existing `/space?view=meetings` empty chrome; there is still no meeting-artifact API, and this is not a Teamily/Impeccable comparison. Timeline and Project are not used as a memory implementation.

No Teamily comparison and no browser E2E are claimed. Issue 8 stays open.

## Private editable memory profile

`GET /v1/workspaces/{id}/memory/profile` returns the current caller’s `professional`, `work_style`,
`communication`, `revision` (initially 0) and `updated`. `POST` accepts all three strings plus the
current integer revision. Each section is at most 10,000 characters, with no NUL. Membership,
session, exact Origin and CSRF are required; stale revision returns 409 rather than overwriting
another tab. The additive `(workspace_id,user_id)` primary key separates both users and workspaces.
The page saves real content and restores it after reload; CI exercises that with labeled fixtures.
**Not automatically injected into model prompts; no dreaming, generated profile or inference claim.**
See [FUNCTIONAL_COMPLETION.md](FUNCTIONAL_COMPLETION.md) for the remaining full-scope checklist.
