# Agent context budget

Status: **budget engine only**. This slice estimates tokens, allocates a model
context window across named sections, truncates or drops low-priority sections,
and returns a citation-preserving context pack. It does not call a model, replace
DSH compaction, retrieve memory or change an existing agent turn.

Related: #1, #11, #89.

## Reuse / new / not doing

**Reuse**
- DSH `parts.js` / `steward.js` native session compaction.
- DSH `text.js` token heuristic: a CJK code point costs about one token, other
  text about a third.
- The citation shape already used by `agent-runtime-contract` (`id`, `revision`,
  optional `title`/`kind`).

**New**
- Section budgets: `critical`, `high`, `normal`, `low`.
- Deterministic proportional allocation inside one priority group.
- Character-safe truncation to a token allowance.
- Citation-preserving context pack with `dropped`, `warnings` and overflow
  diagnostics.
- Stateless `agent-context` feature endpoints.

**Not doing**
- No model or provider tokenizer call; the estimator is conservative and
  provider-independent.
- No replacement for DSH native session compaction.
- No retrieval, reranking, embedding or persistence.
- No UI, route, chat change or edit to `features/agents`, `ds-bot-bridge.mjs`,
  Bot Social or the pinned upstream tree.

## Pack payload

```json
{
  "context_window": 128000,
  "output_reserve": 8192,
  "sections": [
    {"name":"system","priority":"critical","content":"..."},
    {"name":"instructions","priority":"high","content":"..."},
    {"name":"history","priority":"normal","content":"..."},
    {"name":"memory","priority":"low","content":"...","citations":[
      {"id":"page-id","revision":3,"title":"Project","kind":"memory"}
    ]}
  ]
}
```

- `context_window`: 1,024–2,000,000.
- `output_reserve`: default `min(8192, context_window / 8)`.
- 1–32 sections; names `[a-z][a-z0-9_-]{0,39}` and unique.
- Each section has a string `content` of at most 1,000,000 characters.
- Optional `max_tokens` caps that section.
- Optional citations: at most 50 per section; `id` and non-negative integer
  `revision`, optional `title`/`kind`.

## Allocation

1. Estimate every section with the DSH heuristic.
2. Reserve `output_reserve` and the separators.
3. Critical sections get their allowance first; if they do not fit, return
   `context/overflow` with required/available diagnostics.
4. Remaining budget is allocated to `high`, then `normal`, then `low`.
5. Inside a priority group, sections share the remaining budget proportionally
   to their capped token counts. Integer leftovers are assigned deterministically
   by fractional remainder, then original index.
6. A section with zero allowance is reported in `dropped`, not silently removed
   from the report.
7. Kept sections preserve original order. `prompt` joins kept content with two
   newlines.
8. Citations are emitted for kept sections and record `section_truncated`.

## Result

The result includes:

- `prompt`: joined kept content;
- `sections`: name, priority, original/final tokens, `kept`, `truncated`, content;
- `citations`: kept sections' citations plus `section` and `section_truncated`;
- `budget`: context window, output reserve, available/used/remaining and
  separator tokens;
- `dropped`, `warnings`, and a top-level `truncated` flag.

The pack never invents content and never claims provider-token accuracy.

## Endpoints

`POST /api/openteamily` with `endpoint: "agent-context/<op>"`:

| Op | Payload | Result |
|---|---|---|
| `contract` | none | schema, estimator, priorities, limits, reuse/new/not-doing |
| `estimate` | `{text}` | `{tokens, chars}` |
| `pack` | pack payload above | context pack result |

## Tests

`runtime/openteamily-web/test/agent-context.test.js` covers:

- DSH heuristic and surrogate-safe truncation;
- under-budget packing and citation preservation;
- low-priority truncation before critical context, determinism;
- critical overflow diagnostics;
- `max_tokens` caps and invalid payloads;
- feature endpoint wiring.

Tests are pure Node 22 tests. They do not call a model, container, Bot Social or
external service.
