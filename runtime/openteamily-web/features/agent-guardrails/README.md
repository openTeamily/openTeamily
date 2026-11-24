# agent-guardrails

Provenance/taint and DSH tool-authorization decisions.

- Reuses Bot Social policy/untrusted concepts and DSH tool risk metadata.
- Adds trust levels, taint summary, allow/require_approval/deny decisions,
  approval scope matching and a deterministic decision hash.
- Exposes `evaluate`, `classify`, `policy`, `contract`.
- Does not execute tools, transport approvals, detect DLP/injection, persist or
  render anything.

See `docs/AGENT_GUARDRAILS.md`.
