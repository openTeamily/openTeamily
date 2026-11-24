# agent-context

Stateless OpenTeamily context budget.

- Reuses DSH's token heuristic and leaves native compaction to DSH
  `parts.js`/`steward.js`.
- Adds section priorities, deterministic allocation, truncation/dropping reports
  and citation-preserving context packs.
- Exposes `contract`, `estimate` and `pack`.
- Does not call a model, retrieve memory, persist, render or modify agents.
