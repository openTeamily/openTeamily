# External Agent API gateway

Related: [#11](https://github.com/openTeamily/openTeamily/issues/11), [#2](https://github.com/openTeamily/openTeamily/issues/2).

Lets an outside program call one workspace agent with a scoped API key. OpenTeamily never calls a model
vendor itself: invocations are queued on the existing infer path and answered by the owner's connected
runtime, exactly like an in-app agent conversation. Tests use the labeled fake runtime only.

## Keys (session + Origin + CSRF, owner/admin)

| Method | Path | Behavior |
|---|---|---|
| GET | `/v1/workspaces/{wid}/agents/{aid}/api-keys` | List keys (never the token). |
| POST | `/v1/workspaces/{wid}/agents/{aid}/api-keys` | `{name, rate_per_minute?}` (1–60, default 10). `201` returns the token **once**; only its digest is stored. At most 10 keys per agent. |
| POST | `/v1/workspaces/{wid}/agents/{aid}/api-keys/{kid}/revoke` | Revoke immediately. |

Scope is fixed to `invoke` for one agent. A key stops working when revoked, when the agent is archived, or
when its creator is no longer an owner/admin (including suspension).

## Calls (Bearer only)

Requests carrying a Cookie or Origin header are refused with `401`; the gateway is not a browser surface.

| Method | Path | Behavior |
|---|---|---|
| POST | `/v1/gateway/agents/{aid}/invocations` | `{prompt}` + `Idempotency-Key`. `202` with `{invocation}`; same key + same body replays, a different body is `409`. A key for another agent is `403`. Over the per-minute limit is `429`. |
| GET | `/v1/gateway/invocations/{id}` | Status `queued/running/succeeded/failed`; `reply` only when succeeded; failures use fixed codes (`no_agent`, `quota`, `timeout`, `cancelled`, `empty_reply`, `runtime_failed`, `task_missing`). |

The agents page has an 「外部 API 访问」 panel for owners/admins to create, list and revoke keys.

## Not in this slice

Streaming, per-call audit views, broader scopes and any production deployment. CI with the fake runtime is
not vendor or Teamily acceptance.
