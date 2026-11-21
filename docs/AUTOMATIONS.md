# Automations

Related: [#6](https://github.com/openTeamily/openTeamily/issues/6), [#1](https://github.com/openTeamily/openTeamily/issues/1).

Workspace automations are a self-written OpenTeamily feature. Schedule kinds, the twelve work templates and the tag compiler follow the 2026-11-16 Teamily contrast, with titles rephrased. This is **not** Teamily automation parity and not a verbatim copy.

`GET /v1/automation-templates` lists templates, including life templates captured in the 2026-11-16 recapture. `GET/POST /v1/workspaces/{id}/automations` creates and lists records. `POST .../automations/{id}` updates; `POST .../remove` deletes.

## Storage and roles

Additive `automations` and `automation_runs` tables on schema `user_version` 1. Members may read; only owner and admin may create, update, delete, tick or cancel. Default cap is 20 automations per workspace and 200 runs per automation.

## Execution

When a slot is due, the scheduler creates an allowlisted `infer` task on an online FlyBot agent belonging to a workspace member. Preferred agent names, if set, are tried first; otherwise the owner, then admins, then members. The long-lived model API key is not stored on the run. The agent requests a one-time model-access grant. Workspace model API overrides win; otherwise the workspace owner's account override, otherwise the platform default.

If no agent is online, the run stays `queued` with `error_code=no_agent` and is retried on the next tick. Cancel uses `POST .../automations/{id}/runs/{run_id}/cancel`. Timeouts follow the runtime task deadline. `GET .../runs` reconciles in-flight rows so the result is visible without a second manual tick.

The default backend is `AgentAutomationBackend`. A caller may still inject a container dispatch hook such as `FakeRuntimeBackend`; that hook records instance ids and is not agent execution.

## Scheduler

`Scheduler.tick_workspace` / `tick_all` and `POST .../automations/tick` still work. `due_at()` only considers the current slot; missed earlier days are not backfilled. The Web runner starts a `BackgroundWorker` that periodically recovers, ticks and reconciles (disable with `--no-automation-worker`). `Scheduler.recover()` reapplies in-flight results after a process restart.

`GET .../automations/{id}/runs` returns durable status, error code and a redacted `result` (`text`, `model`, `source`). Credentials never appear.

The same-origin page at `/automations` lists automations and shows the run log and result text. Each list row spells the slot out in the same wording as the editor radios: `立即运行`, `每天 09:00（Asia/Shanghai）`, `每周四 09:00（…）`, `每月 16 日 09:00（…）`, `工作日 09:00（…）`, `单次 2026-11-20 09:00（…）`, followed by `· 已启用` or `· 未启用`. The internal `kind` value stays in the record and in `kindOf()`; `scheduleSummary(schedule, enabled)` is the pure helper that renders the row, and it never echoes an unknown kind. Each row also carries an inline `启用` / `停用` switch (`role="switch"`, `aria-checked`) that posts only `{revision, changes: {enabled}}` to the existing `POST /v1/workspaces/{id}/automations/{id}` route: on success the pill flips immediately and the row keeps the new revision, on a refusal the switch stays where it was and the reason is printed in the row-level `role="alert"` line, and a stale revision re-reads the list instead of pretending the change landed. The list switch is not a new endpoint and does not open the editor; the editor remains the only place that edits the other fields. A fake OpenAI-compatible provider in tests or a local demo is **not** proof against a real vendor.
Both destructive controls on the page ask in place before they act. `删除` and `取消这次运行` replace themselves with an inline `role="alertdialog"` (`删除这条自动化？` / `取消这次运行？`); focus starts on `取消`, and `Esc` or `取消` closes the question with no request. Only `确认` / `确认取消` sends the single `POST .../remove` or `POST .../runs/{run_id}/cancel`.

## Not claimed

No generic shell execution, no Teamily credits, no public unauthenticated page, no real-vendor inference proof, no browser E2E in CI. Monthly day-of-month remains an unverified default. This is still not Teamily automation parity.

## Re-running one finished run (issue #321)

A failed, timed-out or cancelled run row now offers `重新运行`. It posts
`POST /v1/workspaces/{ws}/automations/{id}/runs/{run_id}/retry` with an
`Idempotency-Key`, and the server inserts a **new** `queued` run (its own
`due_at` slot, because `(automation_id, due_at)` is unique) and dispatches it
through the same scheduler path a tick uses. The source run is untouched: it
keeps its status, conclusion and result text, so the log still shows what
actually happened. Only `failed` runs can be retried; a queued or succeeded one
answers `409`, a member `403`, another automation `404`, a missing key `400`
and a full run history `429`. `(run_id, key_hash)` is stored in
`automation_run_retries`, so the same key on the same run returns that one new
run instead of queueing the automation twice — the composer keeps one key per
run and only drops it after the retry lands, so a deliberate later retry is a
new attempt. Retrying does not regenerate a schedule slot and does not pretend
the original attempt succeeded.
