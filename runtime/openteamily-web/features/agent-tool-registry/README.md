# agent-tool-registry

Live DSH tool catalog plus owner metadata overlays.

- Reuses `ctx.tools.schemas(agent)` and DSH annotations.
- Adds source/risk/side-effect inference, revisioned overlays and stats.
- Exposes `catalog`, `get`, `overlays`, `overlay`, `upsert`, `remove`, `stats`,
  `contract`.
- Does not register, execute, allow/deny or render a tool.

See `docs/AGENT_TOOL_REGISTRY.md`.
