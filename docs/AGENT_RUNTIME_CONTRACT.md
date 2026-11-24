# Agent Runtime Contract v1

Status: **contract only**. This slice defines the normalized OpenTeamily run-event
envelope. It does not execute a model, call a tool, start a subagent, persist a
trace or change any existing agent behavior.

Related: #1, #11, #89. The later runtime slices build on this envelope: trace,
usage/cost, event stream, context budget, memory retrieval, tool policy,
subagents, durability, guardrails, evals and versioning.

## Why this exists

The pinned DS-Bot/DSH runtime already owns the low-level execution primitives:

| Primitive | Owner |
|---|---|
| `session/event`, `turn/start`, `turn/end`, `assistant/message` | DSH |
| `tool/call`, `tool/result`, `tool/ptc-dispatch*` | DSH |
| `subagent/start`, `subagent/end`, `subagent/catalog` | DSH |
| token `usage`, permission presets, compaction, resume | DSH |
| cross-user audit, policy/DLP, untrusted wrapping, approvals, presence, webhooks | Bot Social |

What OpenTeamily does not have is a stable runtime event model shared by trace,
usage, streaming, evals, policy and durable execution. Each consumer currently
sees a different slice (or only the final reply text). This contract fixes that
without forking or duplicating DSH or Bot Social.

## Envelope

```json
{
  "schema": "openteamily.agent-runtime.event.v1",
  "version": 1,
  "event_id": "otare_<32 hex>",
  "run_id": "<32 hex>",
  "sequence": 0,
  "type": "tool.call",
  "at": 1760000000000,
  "session_id": "dsh-session-id",
  "turn_id": "12",
  "step": 3,
  "tool_call_id": "toolu_1",
  "subagent_id": null,
  "actor": { "kind": "tool", "id": "read_file" },
  "data": {},
  "redactions": [],
  "truncated": false
}
```

- `event_id` is deterministic from `run_id`, `sequence`, `type` and `at`.
- `type` is one of the versioned event types below.
- `data` is type-specific, bounded, and already redacted.
- `redactions` records the JSON paths that were replaced, never the secret.
- `truncated` says a value was cut by the contract bounds.

## Event types

| Type | Source | Meaning |
|---|---|---|
| `run.started` / `run.completed` / `run.failed` / `run.cancelled` | later trace layer | run lifecycle; reserved by this contract |
| `step.started` / `step.completed` / `step.failed` / `step.cancelled` / `step.retried` | `turn/start`, `turn/end`, `llm/retry-started` | one model step |
| `assistant.attempt` | `assistant/attempt`, stream `start` | one model attempt |
| `assistant.delta` / `reasoning.delta` | `agent/assistant-stream` chunks | streamed text/reasoning |
| `assistant.message` | `assistant/message` | settled assistant text |
| `message.user` | `user/message` | user input |
| `tool.call` / `tool.result` | `tool/call`, `tool/result`, `tool/ptc-dispatch*` | tool execution |
| `subagent.started` / `subagent.ended` | `subagent/*` | delegated child |
| `usage` | `assistant/message` usage or usage chunk | token usage |
| `approval.required` / `approval.resolved` | approval events | human-in-the-loop gate |
| `heartbeat` | caller | stream liveness |
| `runtime.event` | unknown DSH event | bounded fallback, never silently dropped |

## Reuse / new / not doing

**Reuse**
- DSH: `session/event`, `agent/assistant-stream`, `tool/call`, `tool/result`,
  `subagent/start`, `subagent/end`, `usage`, permission, approval, compaction,
  resume.
- Bot Social: `audit.ts` hash-chained audit, `policy.ts` capability/DLP/injection
  policy, `untrusted.ts` and approval/webhook primitives.

**New in this slice**
- a versioned OpenTeamily envelope;
- DSH-event normalization;
- deterministic event identity;
- bounded payloads and secret redaction with recorded paths;
- a stateless `agent-runtime-contract` feature endpoint.

**Not doing**
- no new tool, subagent, usage, permission, approval or compaction engine;
- no persistence, route, page or stream yet;
- no change to `agents/index.js`, `ds-bot-bridge.mjs`, `team-runs` or Bot Social;
- no inference, external call, credential use or deployment.

## Feature endpoints

`POST /api/openteamily` with `endpoint: "agent-runtime-contract/<op>"`:

| Op | Payload | Result |
|---|---|---|
| `contract` | none | schema, event types, limits, redaction rules, reuse/new/not-doing |
| `normalize` | `{run_id, events:[DSH event]}` (1–500) | normalized events and `next_sequence` |
| `normalizeStream` | `{run_id, frames:[{agent,frame}]}` (1–500) | normalized stream events and `next_sequence` |

The feature is discovered by the existing `features/<name>/index.js` mechanism.
It exposes no HTML page and does not alter any existing endpoint.

## Bounds and safety

- At most 500 input events/frames per call.
- At most 64 KiB per normalized event and 48 KiB of `data`.
- Strings 16 KiB, arrays 200 items, objects 200 keys, depth 8.
- Secret-like keys and values (Bearer, `sk-…`, `ghp_…`, `xox…`, `AKIA…`, private
  key blocks, authorization/cookie/password/token) are replaced before bounding.
- Unknown DSH events become `runtime.event` with their original type and a bounded
  payload; consumers can count them instead of losing them.
- Invalid envelope values (bad IDs, type, sequence, size, event identity) fail
  closed with `agent-runtime/contract`.

## Tests

`runtime/openteamily-web/test/agent-runtime-contract.test.js` covers:

- contract description and version;
- DSH turn/tool/subagent/stream/usage mapping;
- deterministic IDs and sequencing;
- redaction paths without mutating the input;
- bounds/truncation;
- unknown-event fallback;
- feature endpoint wiring.

These are pure Node tests. They do not call a model, a container, Bot Social,
or any external service.
