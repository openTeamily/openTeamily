# `features/retention`

Per-workspace data-retention policies and a deterministic purge plan, run inside the
owner's DS-Bot. Policy rows and run receipts live in
`features/retention/retention.sqlite3`; nothing is shared with the platform or another
user's volume. The feature never deletes workspace rows, writes caller files or calls
the network: `plan` only classifies rows the caller passes in, and `execute` is a
dry-run receipt.

Endpoints: `retention/{setPolicy,getPolicy,listPolicies,deletePolicy,plan,execute,recordRun,stats}`.

## TTL boundary rule

A row is expired only when it is **strictly older** than the policy TTL, measured
against the caller-supplied `now` (integer Unix seconds):

- `now - row.created === ttl_seconds` -> the row is exactly at the cutoff and is **kept** (`reason: "not_due"`).
- `now - row.created === ttl_seconds + 1` -> the row is one second past the cutoff and is **planned for deletion**.
- `now - row.created < ttl_seconds` -> kept (`not_due`).

Legal hold wins over expiry: a policy with `legal_hold: true`, or a row carrying
`legal_hold: true`, is listed in `legal_hold` and never in `delete`, whatever the TTL
says. A disabled policy keeps its rows with `reason: "disabled"`. A row whose data
class has no policy is reported in `unknown_policy` and is never silently deleted.
