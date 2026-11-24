# Agent guardrails: provenance, taint and tool authorization

Status: **policy engine only**. This slice classifies where context came from,
summarizes taint, and decides whether a DSH tool call may run, needs approval, or
must be denied. It does not execute tools, transport approvals, detect DLP or
prompt injection, or change an existing agent turn.

Related: #1, #10, #11.

## Reuse / new / not doing

**Reuse**
- Bot Social `policy.ts` / `untrusted.ts` concepts for untrusted content and
  owner policy. This feature consumes provenance labels; it does not duplicate
  Bot Social's DLP/injection detector.
- DSH tool risk/permission metadata and the `agent-tool-registry` risk /
  side-effect shape.

**New**
- Provenance taxonomy: `system`, `user`, `memory`, `artifact`, `meeting`, `mcp`,
  `web`, `subagent`, `tool`, `model`.
- Trust levels: trusted / semi-trusted / untrusted.
- Taint summary and highest-taint propagation.
- Tool-authorization decision: `allow`, `require_approval`, `deny`.
- Approval scope matching (`external`, `write`, `dangerous`, `unknown`, `*`).
- Owner policy overrides and a deterministic decision hash.

**Not doing**
- No DLP or injection detector; pass those findings to the tool policy later.
- No tool execution, approval transport, persistence or UI.
- No model call, external service or credential use.
- No edits to `features/agents`, `ds-bot-bridge.mjs`, `team-runs`, `static/chat`,
  `app.py`, Bot Social or the pinned upstream tree.

## Trust model

| Provenance | Trust | Typical source |
|---|---|---|
| `system`, `user` | trusted | system prompt, the current human turn |
| `memory`, `artifact`, `meeting` | semi-trusted | saved workspace content |
| `mcp`, `web`, `subagent`, `tool`, `model` | untrusted | external or model-produced content |

`highest` is `untrusted` if any untrusted source is present, else `semi` if any
semi-trusted source is present, else `trusted`.

## Decisions

1. A tool whose capability matches `secret`, `credential`, `password`, `token`,
   `api_key` or `private_key` is always `deny`, even with approval.
2. A read-only read tool is `allow`.
3. External tools: untrusted/semi context uses `untrusted_external` policy; a
   trusted-only context uses `external_always_approval` (default `true`).
4. Dangerous tools: untrusted context uses `untrusted_dangerous`; trusted-only
   context uses `dangerous_always_approval` (default `true`).
5. Write tools: trusted context is allowed; tainted context uses
   `untrusted_write` (default `require_approval`).
6. Unknown tools: tainted context uses `untrusted_unknown`; trusted context
   allows only with explicit `user_intent`, otherwise requires approval.
7. `require_approval` becomes `allow` only with a matching granted approval
   scope. An explicit policy `deny` is never overridden by approval.

Default policy:

```json
{
  "untrusted_external": "require_approval",
  "untrusted_write": "require_approval",
  "untrusted_dangerous": "require_approval",
  "untrusted_unknown": "require_approval",
  "secret_capabilities": "deny",
  "external_always_approval": true,
  "dangerous_always_approval": true
}
```

## Endpoints

`POST /api/openteamily` with `endpoint: "agent-guardrails/<op>"`:

| Op | Payload | Result |
|---|---|---|
| `evaluate` | `{workspace_id, sources, tool, user_intent?, approval?, policy?}` | decision, reasons, taint, policy, hash |
| `classify` | `{workspace_id, sources}` | taint summary |
| `policy` | `{workspace_id}` | default policy |
| `contract` | none | taxonomy, trust, limits, reuse/new/not-doing |

Workspace calls verify `agents/personal-binding` or
`teams/activeWorkspaces`.

## Tests

`runtime/openteamily-web/test/agent-guardrails.test.js` covers:

- provenance/trust classification;
- trusted read allow;
- untrusted external approval and scope matching;
- secret capability denial with approval;
- policy deny overriding approval;
- semi/trusted write behavior;
- dangerous/unknown tools and user intent;
- deterministic hashes and invalid input;
- feature workspace isolation and contract.

Tests are pure Node 22 tests. They do not execute a tool, call a model, use Bot
Social or make an external request.
