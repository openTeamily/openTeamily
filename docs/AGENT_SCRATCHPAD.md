# Agent shared scratchpad

Status: **CAS store only**. This slice provides revisioned shared state for
multi-agent runs and subagents. It does not start agents, tools or subagents, and
it does not modify `team-runs`.

Related: #1, #11, #89.

## Reuse / new / not doing

**Reuse**
- DSH run/subagent identity.
- `agent-runs` run/session metadata concepts.
- `agent-runtime-contract` event identity concepts.

**New**
- Workspace-scoped scratchpad entries with CAS revisions.
- JSON / text values, visibility metadata, owner agent/run, expiry and quotas.
- `client_key` replay for idempotent writes.
- Scope/prefix listing with stable cursors and stats.

**Not doing**
- No agent execution, subagent control or tool execution.
- No lease/claim protocol in v1; CAS revisions are the concurrency control.
- No UI, model call, external service or credential use.
- No edits to `features/agents`, `ds-bot-bridge.mjs`, `team-runs`, `static/chat`,
  `app.py`, Bot Social or the pinned upstream tree.

## Entries

An entry is identified by `(workspace_id, scope, key)`:

- `scope`: `[A-Za-z0-9][A-Za-z0-9._:-]{0,79}`.
- `key`: `[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}`.
- `value`: JSON value for `application/json`, string for `text/plain`.
- `value_bytes`: at most 256 KiB.
- `visibility`: `private`, `run` or `workspace` metadata.
- optional `owner_agent_id`, `owner_run_id`.
- optional `expires_at` (future Unix seconds).
- `revision` starts at 1 and increments on every update.

Visibility is a consumer contract in v1, not a security boundary. The plugin
runtime is per owner; workspace membership is checked on every endpoint.

## CAS and idempotency

- Create: `expected_revision: 0`.
- Update: send the current `revision`.
- Stale revision → `409` with `error.current`.
- Create with `expected_revision > 0` without a row → `409`.
- `client_key` replays the same entry when the payload matches; a different
  payload under the same key → `409`.
- An expired entry is swept and treated as absent.

## Endpoints

`POST /api/openteamily` with `endpoint: "agent-scratchpad/<op>"`:

| Op | Payload | Result |
|---|---|---|
| `put` | `{workspace_id, scope, key, value, content_type?, visibility?, owner_agent_id?, owner_run_id?, expected_revision?, expires_at?, client_key?}` | entry + status/replayed |
| `get` | `{workspace_id, scope, key}` | entry |
| `list` | `{workspace_id, scope?, prefix?, limit?, cursor?}` | entries + cursor |
| `remove` | `{workspace_id, scope, key, expected_revision?}` | removed identity |
| `stats` | `{workspace_id, scope?}` | entries/bytes per scope |
| `contract` | none | limits, reuse/new/not-doing |

## Limits

- 1,000 entries per workspace; 200 per scope.
- 256 KiB per value.
- list limit 1–100.

## Tests

`runtime/openteamily-web/test/agent-scratchpad.test.js` covers:

- JSON/text round-trip and metadata;
- CAS stale writes and client_key replay;
- scope/prefix/cursor listing and expiry;
- revisioned removal;
- invalid payloads, size bounds and workspace isolation;
- contract boundary.

Tests use Node 22, a temporary SQLite file and a fake host. They do not start an
agent, subagent, tool or external service.
