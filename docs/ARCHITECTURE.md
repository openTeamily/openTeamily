# Architecture

OpenTeamily assigns **one isolated DS-Bot instance per user**. The management
plane provisions and routes to that instance by user identity. The runtime keeps
a stable instance ID independent of the user and workspace IDs. Joining or
switching workspaces reuses the same runtime. Workspace membership defines access
to shared data in the dedicated Bot Social service.

| Boundary | Responsibility |
|---|---|
| Central platform (`openteamily/app.py`, `server.py`) | Accounts, sessions, OIDC, registration, operator admin, runtime provisioning/lifecycle (manager), edge routing (`dsbot_gateway.py`), the Bot Social URL handed to runtimes, and the one-off membership migration CLI (`social_membership_migrate.py`). No model calls, agent loop, scheduler or task queue. |
| User's DS-Bot (`runtime/flybot-image` + `runtime/openteamily-web`) | All execution: private chat, agents, skills and skill runs, automations, memory, meetings, artifacts, search, connectors (Composio, MCP), group-agent replies. The OpenTeamily UI is a DS-Bot plugin: each page/API is a `features/<name>` module. |
| OpenTeamily Bot Social (`services/bot-social`) | Shared cross-user state only: workspaces/teams (every workspace is a Social team with a 32-hex `workspace_id`), members, invites, join requests, directory, member messenger, group-agent inbox, discover listings, public pages `/a/<slug>`, `/w/<slug>` and read-only shares `/share/<token>`. Never the old FlyBot Bot Social. |

## Routing

`openteamily/dsbot_routes.json` lists `moved_pages`; the edge nginx rendered by
`python -m openteamily.dsbot_gateway render` returns 418 for those pages and for
every moved `/v1` API (`MOVED_APIS` / `DSBOT_API_LOCATIONS`), which hands the
request to the signed-in owner's DS-Bot after `auth_request`. The browser shim
`openteamily/static/shell/dsbot-api.mjs` maps the same legacy `/v1` calls to
`POST /b/api/openteamily {endpoint: '<feature>/v1'}`.

`/a/`, `/w/` and `/share/` on the site root are proxied, cookie-free, to Bot
Social. `/social/` is Bot Social for DS-Bot connectors.

The platform answers any moved route that still reaches it, and the removed
central execution routes (`/v1/agent/*`, `/v1/gateway/*` on the platform,
`/v1/runtime*`, `/v1/agent-homepages/start`), with `410 moved_to_dsbot`.

## Credentials

Manager delivers each runtime only `{server, displayName?, source}` for Bot
Social; the connector token stays on the runtime volume. Model keys, Composio
keys and MCP secrets live on the user's DS-Bot. `/data/kms.key` and runtime
seal keys are never rotated by deploys.

## Public homepage conversations

A visitor on `/a/<slug>` follows "开始对话" to `/messenger/#start=<slug>` on
their own DS-Bot, which asks Bot Social to open a thread with the creator's
agent. The creator's DS-Bot answers from its agent inbox (one native turn).
