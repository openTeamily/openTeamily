# `features/automations` (B2)
Automations and their scheduler run inside this DS-Bot: definitions, editor state and
runs in `features/automations/automations.sqlite3`; the clock ticks here (same slot
rules as `openteamily/automations.py`) once the DS-Bot runtime is attached; each run is
one native DS-Bot turn via `chatTurn('automation:<id>', …)`. Endpoints:
`automations/{templates,list,get,create,update,remove,runs,run,cancel,retry,tick,import}`;
`migrate(bundle)` imports legacy rows and marks the current slot as already run.
## Page adapter and cutover

`/automations/` loads `/shell/dsbot-api.mjs`, which remaps the page's legacy `/v1/workspaces/:id/automations*` and `/v1/automation-templates` calls to `POST /b/api/openteamily {endpoint:"automations/v1", ...}` once the page is served by the user's DS-Bot (`<meta name="openteamily-served-by" content="ds-bot">`). Core can then add `/automations/` to `moved_pages`.

`migrate(bundle)` accepts either the simple `{automations:[...]}` payload or the official `openteamily-dsbot-import` v1 bundle (`feature: "automations"`, tables `automations`, `automation_editors`, `automation_runs`; see `openteamily/dsbot_bundle.py`). Import is idempotent by id. The current schedule slot is recorded as a skipped/migrated run so the in-plugin clock will not fire that slot again. The platform must stop the legacy server scheduler for this user at the same cutover, or both clocks could still fire.

Open a run in history to read its headings, lists, code, tables, and supported Mermaid diagrams.
Copy and download use the original result text.
