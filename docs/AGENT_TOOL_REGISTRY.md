# Agent tool registry

Status: **catalog projection and metadata overlays only**. DSH remains the only
owner of tool registration and execution. This feature reads live tool schemas
through DSH and records the owner's risk/side-effect/capability/enabled overlays.
It does not register, execute or rewrite a tool.

Related: #1, #10, #11.

## Reuse / new / not doing

**Reuse**
- DSH `ctx.tools.schemas(agent)` for the live tool list.
- DSH tool names, descriptions, parameters and annotations.
- DSH tool registration/execution and MCP/connector implementations.
- Bot Social policy/approval remains the cross-user owner; this feature does not
  duplicate it.

**New**
- `features/agent-tool-registry`: live DSH catalog projection, source/risk/
  side-effect inference, owner overlays, revisioned overlay store and stats.
- Endpoints: `catalog`, `get`, `overlays`, `overlay`, `upsert`, `remove`, `stats`,
  `contract`.

**Not doing**
- No tool registration, execution, policy enforcement or approval UI.
- No MCP/connector/skill implementation.
- No edits to `features/agents`, `ds-bot-bridge.mjs`, `team-runs`, `static/chat`,
  `app.py`, Bot Social or the pinned upstream tree.
- No model, container, external service or credential use.

## Live catalog

`catalog` resolves one DSH agent and reads `ctx.tools.schemas(agent)`:

- `session_id` must belong to the requested workspace and carry OpenTeamily agent
  metadata.
- `agent_id` finds the owner's native Bot and its active session.
- Neither means the Main Bot's current session.

Each tool is projected with:

- `name`, `description`, `parameters` (`schema_bytes`, `schema_truncated`);
- `source`: `builtin`, `mcp` (`mcp__…`) or `computer` (`cua_…`);
- inferred `risk`: `read`, `write`, `external`, `dangerous`, `unknown`;
- inferred `side_effect`: `read_only`, `write`, `external`, `unknown`;
- annotations: `read_only_hint`, `destructive_hint`, `idempotent_hint`;
- `enabled`, `capability`, `overlay`, `revision`.

Schemas above 32 KiB are returned as `parameters: null` with
`schema_truncated: true`; the tool itself is still listed.

## Overlays

Overlays are workspace-scoped metadata keyed by tool name:

- `risk`, `side_effect`, `capability` (≤120 chars), `enabled`, `note` (≤500).
- `revision` is required for update; stale revisions return `409` with the
  current overlay.
- A new overlay starts at revision 0; the stored revision becomes 1.
- Removing an overlay returns the tool to inferred metadata.

Overlays do not grant or revoke tool access in this slice. They are the metadata
input for the later policy/tool-broker/approval features.

## Endpoints

`POST /api/openteamily` with `endpoint: "agent-tool-registry/<op>"`:

| Op | Payload | Result |
|---|---|---|
| `catalog` | `{workspace_id, agent_id?, session_id?}` | agent, live tools, stats |
| `get` | same + `name` | one merged tool |
| `overlays` | `{workspace_id}` | stored overlays |
| `overlay` | `{workspace_id, name}` | one stored overlay |
| `upsert` | `{workspace_id, name, revision, risk?, side_effect?, capability?, enabled?, note?}` | overlay |
| `remove` | `{workspace_id, name}` | removed name |
| `stats` | `{workspace_id, agent_id?, session_id?}` | risk/source counts |
| `contract` | none | reuse/new/not-doing and limits |

All workspace calls verify `agents/personal-binding` or
`teams/activeWorkspaces`.

## Tests

`runtime/openteamily-web/test/agent-tool-registry.test.js` covers:

- live schema projection, sorting, inference and annotations;
- overlay merge, revision conflict and removal;
- agent/session/Main-Bot resolution and workspace isolation;
- oversized schemas, invalid names and missing tools;
- contract boundary.

Tests use Node 22, a temporary SQLite file and a fake DSH runtime/tool service.
They do not register or execute a real tool.
