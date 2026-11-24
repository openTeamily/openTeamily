# agent-runtime-contract

The stateless contract feature for the OpenTeamily Agent Runtime.

- Reuses DSH `session/event`, `agent/assistant-stream`, `tool/*`, `subagent/*`,
  `usage`, permission, approval, compaction and resume primitives.
- Reuses Bot Social `audit.ts`, `policy.ts`, `untrusted.ts` and its approval
  primitives. This feature does not reimplement them.
- Adds only the versioned OpenTeamily event envelope, DSH normalization,
  deterministic event identity, bounded payloads and secret redaction.
- Does not persist, execute, route, render or call a model/tool/subagent.
- Does not modify `features/agents`, the runtime bridge, `team-runs` or Bot
  Social.

See `docs/AGENT_RUNTIME_CONTRACT.md`.
