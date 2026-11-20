# Agent memory recall and team task runs

Self-written OpenTeamily features; no Teamily source, assets or reference capture exists for either, so neither is a parity claim.

## Agent memory recall (`/agents` drawer → 团队记忆)
- Per workspace agent, owners/admins choose 不引用 (default) / 全部记忆页 / 只引用这些主题 (1–8 existing memory-page topics). Revisioned (`409` on stale revision); members see the current setting read-only.
- On each private agent-conversation reply (send, first message, offline retry) the server ranks the workspace memory pages in scope with deterministic local BM25 over Latin words and CJK bigrams (title weighted ×2) and adds up to 3 excerpts as labelled reference notes `[M1]…`. **This is lexical ranking, not embeddings/vector semantics.**
- Only notes that fully reached the bounded 4000-char prompt are recorded on the reply (page id, title, revision). The chat shows `参考了团队记忆：[M1] 标题`, marked 已删除 / 之后有修改 when the page changed later.
- `POST …/memory-scope/preview` shows exactly which pages a sample question would recall.
- Not used by #124 group replies, the gateway API, or automations — those prompt paths are unchanged.

API: `GET|POST /v1/workspaces/{w}/agents/{a}/memory-scope`, `POST …/memory-scope/preview`.

## Team task runs (`/team-runs`, linked from `/agents`)
- One goal, 2–8 steps; each step = active workspace agent + instruction + dependencies on earlier steps only (acyclic by construction). Steps are grouped into stages by graph depth.
- A step queues one ordinary runtime `infer` task (same agent/runtime selection as private chat, no tool or Composio grant) once all dependencies succeeded; dependency outputs (≤900 chars each) and the goal go into its prompt.
- A failed step blocks its dependants; independent branches continue. Run ends 已完成 or 未完成. Members can cancel (queued/claimed runtime tasks are cancelled), retry a failed step (≤3 attempts, resets the steps it blocked), save a finished step's output as a works-library document (idempotent), and delete finished records.
- No runtime online → step stays queued with `no_agent` and is queued on the next read after a FlyBot connects. Progress is reconciled on read (page polls every 3s while running); there is no background scheduler.
- Runs are private to the member who started them; quotas: 50 records, 5 running.

API: `GET|POST /v1/workspaces/{w}/team-runs` (POST needs `Idempotency-Key`), `GET …/team-runs/{id}`, `POST …/{id}/cancel|remove`, `POST …/{id}/steps/{n}/retry|artifact`.

## Still missing
Embedding-based semantic retrieval, automatic memory writing by agents, team runs inside group chats, parallel tool use, durable scheduler-driven progress without a page read, and real-model quality acceptance.
