# Meeting notes and action items

Related: [#212](https://github.com/openTeamily/openTeamily/issues/212), [#1](https://github.com/openTeamily/openTeamily/issues/1).

This is the first meetings slice: **manual meeting notes** stored per workspace. It reuses the
recorded `/space` meeting chrome (Birfy #115) instead of duplicating it. It does **not** record
audio/video, transcribe, diarize, join calls, or dispatch action items to agents.

## Routes

All under `/v1/workspaces/{id}/meetings`; session required, writes also require exact Origin and CSRF.
Outsiders get `404`.

| Method | Path | Behavior |
|---|---|---|
| GET | `/` | Keyset page of meetings (`limit=1..100`, optional UUID-hex `cursor`). Items omit transcript/actions but include `action_count`/`done_count`. |
| POST | `/` | Create `{title, started_at?, attendees?, transcript?, summary?, action_items?}` + `Idempotency-Key`. |
| GET | `/{meeting_id}` | Full meeting incl. transcript and action items. |
| POST | `/{meeting_id}` | `{revision, changes:{...}}`; stale revision `409` with `error.current`. |
| POST | `/{meeting_id}/remove` | Delete (author, owner or admin). |

`started_at` is Unix seconds (default: now). `attendees` is a list of 0–50 unique names (≤80
chars). `transcript` ≤40,000; `summary` ≤8,000; `action_items` ≤50 items of
`{text (1–500), owner (≤80, optional), done (bool, default false)}`. Titles are unique per
workspace (casefold) and ≤120 chars. Control characters are rejected. Body limit for meetings is
70 KiB so a full transcript fits.

Any workspace member may list, read and create; the author, an owner or an admin may edit/delete.
Default capacity is 100 meetings per workspace (`Config.max_meetings_per_workspace`).

## Storage

Additive `meetings` table (`CREATE TABLE IF NOT EXISTS`) with JSON for attendees/action items;
schema `user_version` stays 1. No existing tables or chrome change.

## Page

`/meetings` lists workspace meetings and provides an editor for title, start time, attendees,
summary, transcript and action-item rows (text, owner, done). It is linked from the app rail.
`docs/screenshots/meetings/` holds synthetic review captures.

## Explicitly not in this slice

- Audio/video recording, live transcription, speaker separation, or call integration.
- Automatically creating tasks/automations from action items.
- Birfy/Bot Social or control-plane behavior.
- Browser E2E or Teamily page-by-page comparison.
