# OpenTeamily as a DS-Bot plugin — target architecture and migration plan

Status: **design, accepted by the owner on 2026-11-20** ("所有的执行都要基于 DS-Bot，你的前端只是基于 DS-Bot 的一个插件";
"像 FlyBot 平台那样：每个用户自己的 DS-Bot 直接提供 OpenTeamily 页面，网站只负责注册登录和转发").
This document is the contract for the implementation PRs listed in [Phase plan](#6-phase-plan). Until the
cutover PR (phase D) lands, the legacy Flask management server keeps working unchanged, so open feature
PRs keep merging.

## 1. Target in one paragraph

Every account owns exactly one isolated **DS-Bot** (upstream DS-Bot v0.3.8 on DSH 0.2.2-rc.1, pinned in
`runtime/ds-bot-upstream.pin.json`, one container + one volume per user, provisioned by the compose
manager). The OpenTeamily product — pages, APIs and **all execution** (chat, skills, Composio/MCP tools,
automations and schedules, exports, memory, artifacts, meetings, group replies) — is an **OpenTeamily DSH
plugin** that runs inside that user's DS-Bot and uses DS-Bot/DSH host APIs. The public site
`openteamily.botawaken.com` becomes a thin **platform**: registration, login/session, provisioning one
DS-Bot per user, and an authenticated reverse proxy that routes the signed-in browser to *their own*
DS-Bot and nothing else. Anything that involves more than one user (member DMs, teams/groups, discover,
follows, invites) goes through **Bot Social** (`services/bot-social` + `runtime/flybot/plugins/social`),
never through a central executor.

```
browser ──https──> platform (register / login / session / provision / gateway)
                        │ auth_request: session → own instance only
                        ▼
              user's DS-Bot container (dsh web :8080)
                ├─ ds-bot (unmodified upstream createRuntime)
                ├─ @flybot/social via flybot-social-host  ──> Bot Social (cross-user)
                └─ @openteamily/web  (this plugin: pages + /api/openteamily + all execution)
```

This is the same shape as the old FlyBot platform on botawaken (`panel` does account/launch, each
`u-*` tenant is its own `dsh web`, an account-state gate in front of every tenant, cross-user through
Bot Social). We reuse the *shape*, not its code: the old FlyBot core fork is not vendored, and
`@flybot/project` is never installed or enabled.

## 2. DS-Bot / DSH extension seams we build on (no upstream patches)

All of these already exist in the pinned tree and are used by today's runtime image:

| Seam | Where | Used for |
|---|---|---|
| DSH plugin entry `apply(ctx, config)` with `inject` | `runtime/ds-bot-upstream/ds-bot/plugin.js`, `src/host/entry.js` | Our wrapper `runtime/flybot-image/plugin/index.js` already boots `createRuntime` once and attaches social; `@openteamily/web` attaches the same way. |
| Profile insertion via `cordis.patch.yml` (`dsh.bundle.patch`) | `runtime/flybot-image/plugin/cordis.patch.yml`, `docker.patch.yml` | Load the plugin in the `web` profile, never a second ds-bot. |
| Exact authenticated Fetch routes `ctx.connection.fetch.register({path, methods, requestBody, fetch})` under `/api` | ds-bot `channel.js` (`POST /api/bot`), `feed.js` (SSE), `flybot-web-slots/src/route.js` (`POST /api/flybot`) | `POST /api/openteamily` (JSON `{endpoint, payload}` dispatch, same shape as `/api/bot`) and `GET /api/openteamily/page?path=…` (pages/assets). DSH applies its own browser-session/token auth before these run. |
| `ctx.connection.rpc.intercept('/api', …)` | DSH connection | Optional later: own endpoints on the shared channel. |
| Browser half: `dsh.client.platform: web` + client export | `flybot-web-slots/client.js`, `@openteamily/flybot-social-web` | Phase B/C: render OpenTeamily surfaces inside dsh-web regions instead of standalone pages. |
| Runtime services: `sessions`, `sessionController`, `llm`, `tools`, `systemPrompt`, `workspaceRegistry`, `schedule`, `skills.registerProvider`, `jobs`, `shellEnv`, DS-Bot memory/goals/schedules/office | ds-bot `src/host/*` | Execution of every moved feature (chat via native sessions as in #379, skills via `skills.registerProvider`, automations via DSH `schedule`, exports via ds-bot `office`, memory via ds-bot memory scopes). |
| MCP tool mounts | #379 (`ds-bot-bridge.mjs`, Composio→MCP bridge, custom MCP) | Composio and user-configured MCP as native DS-Bot tools, per user. |

Plugin storage lives on the user's volume under `/data/openteamily/` (SQLite via `node:sqlite` on Node 24,
plus files), owned by uid 1000 like the rest of `/data`. Nothing about one user is stored in another user's
volume.

## 3. Feature map — every current server feature and page

Legend: **P** = platform (stays on the site), **D** = user's DS-Bot plugin `@openteamily/web`, **S** = Bot
Social (cross-user). "Batch" is the implementation PR that moves it (see §6).

### 3.1 Pages (`openteamily/static/*`)

| Page | Target | Batch | Notes |
|---|---|---|---|
| `/register/`, login (OIDC + password, `oidc.py`, `/v1/auth/*`) | P | — | Platform owns identity, sessions, email/OIDC. #293 (email-code registration) stays platform. |
| `/about/`, `/privacy/`, `/terms/`, `/help/`, `/download/`, `/install/`, `/docs/` | P | — | Static, public, no user data. |
| `/home/` | D | A (shell) | Served from user's DS-Bot; data endpoints follow their features. |
| `/chat/`, `/messenger/` | D (+S for member DMs/groups) | A shell, B1 data | Personal-agent chat already executes on DS-Bot after #379. |
| `/agents/` (workspace agents, homepages, quick starts, archived) | D | B2 | Agent = DS-Bot bot in that user's team (`ds-bot` roster). |
| `/skills/` | D | B1 | Native DS-Bot skills (#379) become the only path. |
| `/automations/` | D | B2 | DSH `schedule` + ds-bot schedules. |
| `/artifacts/` (studio, slides, boards, dashboards, versions) | D (+S for shares) | B3 | Exports via ds-bot office (#379 keeps `office_exports.py` only until B3). |
| `/memory/` | D (+S for share links #299) | B3 | ds-bot memory scopes + plugin tables. |
| `/meetings/` | D | B3 | |
| `/settings/` (preferences, model API, skill secrets, Composio, custom MCP, notifications) | D (P keeps account security: password, linked identities, delete account #362) | B4 | Secrets move into DS-Bot `secrets.js` encrypted store. |
| `/profile/`, `/look/` | P for public handle/avatar; D for private look/preferences | B4 | Public handle is cross-user → published to Bot Social. |
| `/onboarding/` | D (first-run inside DS-Bot); P only for the post-register redirect | B4 | |
| `/runtimes/` | P | A | Becomes "your DS-Bot" status/start/stop page; own-machine FlyBot (`runtime_keys`, `runtime_connect`) stays P during transition, retired in D. |
| `/members/`, `/team/` (wizard, templates, invites, join requests, roles) | S (+D for local team view) | C | |
| `/discover/` (agents, works, creators, likes, collections, follows) | S | C | Public catalog is cross-user by definition. |
| `/guide/` | D | A | Static content served by the plugin. |
| `/shell/` (shared nav/chrome JS/CSS) | D (copy in plugin) + P (minimal chrome for public pages) | A | |

### 3.2 Server modules (`openteamily/*.py`) and their tables

| Module (tables) | Today | Target | Batch |
|---|---|---|---|
| `store.py` (users, sessions, workspaces, rate_limits), `security.py`, `oidc.py` (user_identities, user_emails, oidc_*), `profiles.py` (public part) | identity | **P** | — |
| `lifecycle.py` (instances, runtime_jobs), `manager/*`, `compose_planning.py`, `runtime_autoprovision.py` (#379), `operator_config.py`, `model_http_policy.py` | control plane | **P** (provision/route only; never executes user work) | A |
| `app.py` routing of `/v1/*` | everything | **P** for auth/platform; **D** via gateway for the rest | A→D |
| `personal.py` (personal_agents, builtin_agents), `conversations.py` (agent_conversations, agent_messages, agent_conversation_reads), `message_utilities.py` (message_assists) | central + runtime infer task | **D** | B1 |
| `runtime_connect.py` (runtime_connections, runtime_tasks, runtime_task_meta), `agent_runtime.py` (bindings, instance_runtime_keys, agent_message_dispatch), `fake_runtime.py`, `flybot.py`, `flybot_bundle.py` | central task queue to runtimes | **removed** (D calls are local to the DS-Bot) | D |
| `skill_packages.py`, `skill_installs.py`, `skill_execution.py`, `skill_secrets.py`, `imported_skills.py` | central selection/material/execution | **D** (catalog of public packages can be read from **P** as static content) | B1 |
| `model_api.py` (model_api_configs) | central config, loopback proxy in #379 | **D** (per-user config in DS-Bot providers/secrets); operator exact-HTTP policy (#375) stays **P→D** as a read-only operator file mounted into the runtime | B4 |
| `composio.py`, `composio_principals.py`, `connected_tools.py`, `custom_mcp.py` (#379) | central broker | **D** per-user (MCP mount in DS-Bot, user's own Composio key/connection, approval inside DS-Bot); no admin fallback | B4 |
| `automations.py` (automations, editors, runs, retries), `scheduler.py` | central scheduler dispatching runtime tasks | **D** (DSH `schedule`); team-shared automations announce via **S** | B2 |
| `agents.py` (workspace_agents, categories, homepages, quick_starts), `team_templates.py` | central | **D** (agents are DS-Bot bots); public homepages publish to **S** | B2 |
| `artifacts.py` (11 artifact_* tables), `office_exports.py` | central storage + exports | **D**; shares/discover publish to **S** | B3 |
| `memory.py` (8 memory_* tables) | central | **D** (ds-bot memory + plugin tables) | B3 |
| `meetings.py` | central | **D** | B3 |
| `settings.py` (user_settings), `settings_page.py`, `onboarding.py`, `notifications.py` (per-user reads/prefs) | central | **D** | B4 |
| `search.py` | central over all messages | **D** (own data) + **S** (shared conversations) | B3/C |
| `social.py` (14 social_* tables), `notifications.py` (cross-user mentions), `bot_social.py` | central human messenger | **S** | C |
| `members.py`, `invites.py`, `teams.py`, `team_directory.py` | central | **S** (membership/invites as Bot Social groups and invites) | C |
| `discover.py` (agent_discover, artifact_discover, likes, collections, follows) | central | **S** | C |
| `gateway.py` (agent_api_keys/rate/invocations, external Agent API) | central queue | **P** authenticates the API key and routes to the owning user's DS-Bot `POST /api/openteamily` endpoint `gateway/invoke` (execution in **D**) | B2 |
| `events.py` (SSE invalidations) | central | **D** (DS-Bot feed); **P** none | B1 |
| `local_demo.py`, `ci_ui_fixtures.py`, `server.py` | dev/CI | stay for the legacy path until D; plugin gets its own fixtures | — |

## 4. Routing and authentication design

### 4.1 One host, path mount
DNS, ingress and Cloudflare are unchanged (one Traefik route `Host(openteamily.botawaken.com)` → the
deployment's edge; no wildcard DNS, no per-user subdomain). The edge (nginx, already in the deployment)
splits:

| Path | Goes to |
|---|---|
| `/register/`, `/login`, `/v1/auth/*`, `/v1/platform/*`, public static pages, `/v1/gateway/*` (external API key check) | platform (gunicorn) |
| `/b/` and `/b/*` (DSH web of the signed-in user, incl. `/b/api/*` and its WebSocket/SSE) | **that user's** DS-Bot, prefix `/b` stripped (DSH supports a mount proxy that strips its prefix) |
| legacy page paths (`/chat/`, `/skills/`, …) once a page is "moved" | rewritten to `/b/api/openteamily/page?path=<page>` on that user's DS-Bot |
| legacy `/v1/<feature>` for a moved feature | rewritten to that user's DS-Bot `POST /b/api/openteamily` endpoint `<feature>/…` via the plugin's `/v1` compatibility shim |
| legacy `/v1/<feature>` not moved yet | platform (unchanged) — the strangler switch |

The moved-feature list is one data file (`openteamily/dsbot_routes.json`) read by both the platform
authorizer and the nginx template generator, so each batch PR flips rows instead of editing proxy config.

### 4.2 Authorization (`auth_request`)
For every `/b/*` and moved request the edge calls the platform `GET /v1/platform/route` (internal, not
public). The platform:
1. validates the platform session cookie (same `sessions` table, HttpOnly, SameSite=Lax, Secure);
2. for unsafe methods and every WebSocket upgrade, requires `Origin`/`Sec-Fetch-Site` same-origin with
   the configured public origin (CSRF); rejects cross-site;
3. resolves the caller's **own** instance only (`instances.owner_user_id == session.user_id`, desired
   running, healthy, current revision, manager heartbeat fresh — the FlyBot account-state gate rules);
   no request parameter can name an instance;
4. answers `204` with internal headers `X-OT-Upstream` (the instance's private address recorded by the
   manager) and `X-OT-Upstream-Auth` (see 4.3), or `401` (no session → redirect to login) / `403` /
   `503` (not provisioned or not healthy → `/runtimes/` status page).

The edge strips every client-supplied `X-OT-*` header, all `dsh-auth-*` cookies and `Authorization` before
proxying, sets `Host` to the instance's internal authority (`rt-<instance>.openteamily.internal`) and
rewrites `Origin` to it after the platform has checked the real one, passes `Upgrade/Connection` for
WebSockets and disables buffering for SSE.

### 4.3 DSH authentication behind the gateway
DSH keeps its own authentication (process launch token → signed `dsh-auth-<authority>` cookie bound to
the request authority). The browser never sees a DSH token or cookie:
* the manager captures each runtime's tokenized launch URL at start (as the FlyBot worker does) into the
  platform's private DB, never in logs, lists, URLs or Docker args;
* the platform exchanges it server-side for the DSH session cookie for authority
  `rt-<instance>.openteamily.internal`, keeps it encrypted at rest, and returns it to the edge only in
  `X-OT-Upstream-Auth` for that owner's requests;
* because the cookie is signed by that runtime's own secret and bound to its own authority, it is useless
  against any other runtime even if leaked.

### 4.4 Network
Runtimes keep no published ports by default. The edge reaches runtimes on a deployment-scoped internal
Docker network per runtime (created and labelled by the manager, the edge container attached, no egress
change, no global Docker/firewall/DNS change). Edge and manager get their own network namespace instead of
`network_mode: service:web` so a web restart no longer 502s or strands them (deployment overlay change,
sequenced by the deploy owner).

### 4.5 Isolation proofs required in CI
* Two users, two runtimes: each user's `/b/api/openteamily/page?path=/home/` returns a page carrying *its
  own* instance marker (served by its own DS-Bot), and every attempt by user A to reach B's runtime
  (forged headers, forged cookies, path tricks, instance ids in query/body, WebSocket upgrade) is denied.
* No session → 401, cross-site Origin → 403, unprovisioned → 503.

## 5. Data migration (management.sqlite3 → per-user DS-Bot storage)

* **Unit of migration:** one account. The platform builds an export bundle containing only rows owned by or
  scoped to that user's personal workspace (tables in §3.2 marked D), plus files (artifact media, avatars),
  with a manifest of table → row count → SHA-256.
* **Secrets:** skill secrets, model API keys and Composio keys are re-encrypted for the target runtime only
  (sealed to that runtime's key via the manager's existing secret delivery); never plain JSON on disk, in a
  bundle, log or chat. Composio stays per-user, no admin fallback.
* **Delivery:** a manager job (`import-openteamily-state`) writes the bundle into the user's volume as
  `/data/openteamily/import/<version>.bundle`; the plugin imports idempotently at start (version marker
  table, upsert by original id), verifies the manifest, then deletes the bundle.
* **Cut per feature:** each batch PR migrates only its own tables; on success the platform flips that
  feature for that user in `dsbot_routes` state and marks its legacy rows `migrated_at` (read-only, kept).
* **Shared (S) data:** teams, members, invites, social conversations, discover entries are published into
  Bot Social by the owner's DS-Bot social plugin in phase C; legacy rows stay read-only until D.
* **Existing runtimes:** the two live instances (eb0e5e47…, 102cd697…) migrate in place with their volumes
  backed up first.

## 6. Phase plan

| Phase | PR | Content | Size (honest) |
|---|---|---|---|
| 0 | this PR | Architecture, feature map, migration, routing, rollback | done |
| prerequisite | #379 | chat on DS-Bot, native skills, Composio→MCP, custom MCP, loopback model proxy, auto-provision, reconnect | in progress (other workstream) |
| A | gateway + shell | `@openteamily/web` plugin package (page route, `/api/openteamily` dispatch, instance identity), platform route authorizer + nginx template + `dsbot_routes.json`, two-runtime isolation e2e in CI | ~1–2 days |
| B1 | chat/personal agent, skills, events | move conversations, personal agent, message assists, skills catalog/installs/secrets into plugin; per-user migration | ~2–3 days |
| B2 | automations, agents, external API | automations on DSH `schedule`, agents as ds-bot bots, gateway invoke routed to DS-Bot | ~2–3 days |
| B3 | artifacts/exports, memory, meetings, search | biggest data model (artifacts 11 tables, memory 8) | ~3–5 days |
| B4 | settings/connectors, model API, onboarding, notifications prefs | secrets re-sealing | ~2 days |
| C | cross-user via Bot Social | members/teams/invites/join requests, social messenger, mentions, discover/follows/likes, share links | ~4–6 days; needs Bot Social API additions in `services/bot-social` |
| D | cutover | remove central executors (`runtime_connect`, `scheduler`, `skill_execution`, `connected_tools`, `office_exports`, `fake_runtime`, `flybot.py`), legacy `/v1` feature routes, legacy tables after retention | ~1–2 days |

Total remaining after A: roughly 2.5–4 weeks of focused work, done as small PRs with CI proof per
moved capability. Every batch PR adds CI tests: plugin unit tests (node), migration tests (python),
and a container test proving the capability executes inside the user's DS-Bot.

## 7. Compatibility with in-flight work

* Open feature PRs (HugoXK `dev*/…`, Birfy `feat/…`) keep landing on the legacy server until each batch
  moves their feature; the batch PR then ports the merged behaviour into the plugin. Phase A touches no
  legacy feature module.
* High-overlap areas to sequence: chat (#346, #352, #358, #368, #271), settings (#284, #384, #197),
  automations (#310), memory (#299, #378), discover (#313, #335), team/members (#281), profile (#362).

## 8. Rollback

* Every phase is additive behind `dsbot_routes.json`: rolling back a batch = flipping its rows back to
  `platform` (legacy rows are kept read-only, never deleted before phase D + retention), redeploying the
  previous web image. No data is destroyed by any phase before D.
* Runtime image changes follow the existing manager rule: snapshot the volume first, exact image digests,
  previous image kept; restore = previous digest + volume snapshot.
* Phase D keeps the last legacy release, its DB backup and the per-user import bundles' manifests for the
  retention window.

## 9. Non-goals and constraints

* No changes to upstream DS-Bot/DSH trees (`runtime/ds-bot-upstream` is byte-pinned); OpenTeamily code
  lives in its own plugins/adapters.
* No `@flybot/project`; no old FlyBot core fork; `@flybot/workflow`-equivalent capabilities are provided
  by DS-Bot goals/tasks/schedules in the plugin if needed.
* No global Docker/DNS/firewall/proxy/ingress changes; HTTP model access only via the operator exact-HTTP
  policy (#375); tests only with test accounts.
