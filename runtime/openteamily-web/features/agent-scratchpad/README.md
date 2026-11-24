# agent-scratchpad

Revisioned shared state for multi-agent runs.

- CAS revisions, `client_key` replay, scope/prefix listing, expiry and quotas.
- JSON or text values with visibility/owner metadata.
- Exposes `put`, `get`, `list`, `remove`, `stats`, `contract`.
- Does not execute agents/tools/subagents, define leases or render UI.

See `docs/AGENT_SCRATCHPAD.md`.
