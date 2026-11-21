"""Ephemeral chat presence and typing leases.

Self-written for OpenTeamily. A lease says a user is currently ``online`` in a
workspace conversation, or is currently ``typing`` in it. Leases are stored as
short-lived rows with an explicit expiry; readers treat an expired lease as
absent even before a sweep deletes it.

Honest scope:

* Single-node SQLite state only. There is no WebSocket/SSE transport, no push
  notification, no cross-node replication, and no durable presence history.
* This module stores only identifiers, a kind, and timestamps. It never stores
  message content.
* Callers must authenticate the user and authorise that user for the workspace
  and conversation before calling these functions. This module does not check
  membership, roles, or conversation access.
* Workspace and conversation IDs are part of every lookup and primary key, so
  leases cannot leak across those boundaries when callers pass them correctly.

Leases are deliberately bounded: the shortest useful TTL is one second and the
longest accepted lease is one hour. Clients should repeat ``heartbeat`` well
inside the TTL and call ``clear`` when they leave or stop typing.
"""
import math
import re

SCHEMA = '''
CREATE TABLE IF NOT EXISTS presence_leases (
 workspace_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL,
 user_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('online','typing')),
 expires INTEGER NOT NULL,
 updated INTEGER NOT NULL,
 PRIMARY KEY(workspace_id, conversation_id, user_id, kind));
CREATE INDEX IF NOT EXISTS presence_lease_active
 ON presence_leases(workspace_id, conversation_id, expires);
'''

KINDS = ('online', 'typing')
DEFAULT_TTL_SECONDS = 30
MIN_TTL_SECONDS = 1
MAX_TTL_SECONDS = 3600
ID_MAX = 128

CONTROL = re.compile(r'[\x00-\x1f\x7f]')


def ensure_schema(db):
    """Create the presence table/index if absent; safe to call repeatedly."""
    db.executescript(SCHEMA)


def _identifier(value, field):
    if (not isinstance(value, str) or not value or len(value) > ID_MAX
            or CONTROL.search(value)):
        raise ValueError(f'{field} must be a bounded identifier')
    return value


def _timestamp(value, field='now'):
    if (isinstance(value, bool) or not isinstance(value, (int, float))
            or not math.isfinite(value)):
        raise ValueError(f'{field} must be a finite epoch timestamp')
    return value


def _kind(value):
    if value not in KINDS:
        raise ValueError('kind must be online or typing')
    return value


def _ttl(value):
    if (isinstance(value, bool) or not isinstance(value, int)
            or not MIN_TTL_SECONDS <= value <= MAX_TTL_SECONDS):
        raise ValueError(
            f'ttl_seconds must be an integer between {MIN_TTL_SECONDS} and {MAX_TTL_SECONDS}')
    return value


def _view(row):
    return {key: row[key] for key in (
        'workspace_id', 'conversation_id', 'user_id', 'kind', 'expires', 'updated')}


def heartbeat(db, workspace_id, conversation_id, user_id, kind, now,
              ttl_seconds=DEFAULT_TTL_SECONDS):
    """Upsert one lease and extend its expiry; returns the stored lease."""
    workspace_id = _identifier(workspace_id, 'workspace_id')
    conversation_id = _identifier(conversation_id, 'conversation_id')
    user_id = _identifier(user_id, 'user_id')
    kind = _kind(kind)
    now = _timestamp(now)
    ttl_seconds = _ttl(ttl_seconds)
    expires = now + ttl_seconds
    db.execute(
        'INSERT INTO presence_leases '
        '(workspace_id, conversation_id, user_id, kind, expires, updated) '
        'VALUES (?, ?, ?, ?, ?, ?) '
        'ON CONFLICT(workspace_id, conversation_id, user_id, kind) DO UPDATE SET '
        'expires=MAX(presence_leases.expires, excluded.expires), '
        'updated=MAX(presence_leases.updated, excluded.updated)',
        (workspace_id, conversation_id, user_id, kind, expires, now))
    row = db.execute(
        'SELECT workspace_id, conversation_id, user_id, kind, expires, updated '
        'FROM presence_leases WHERE workspace_id=? AND conversation_id=? '
        'AND user_id=? AND kind=?',
        (workspace_id, conversation_id, user_id, kind)).fetchone()
    return _view(row)


def clear(db, workspace_id, conversation_id, user_id, kind=None, now=None):
    """Delete matching leases and return the number removed.

    With ``kind=None`` all of that user's leases in the conversation are
    removed. When ``now`` is supplied, only leases updated at or before that
    timestamp are removed, so a stale clear cannot erase a newer heartbeat.
    """
    workspace_id = _identifier(workspace_id, 'workspace_id')
    conversation_id = _identifier(conversation_id, 'conversation_id')
    user_id = _identifier(user_id, 'user_id')
    if kind is not None:
        kind = _kind(kind)
    if now is not None:
        now = _timestamp(now)
    sql = ('DELETE FROM presence_leases WHERE workspace_id=? AND conversation_id=? '
           'AND user_id=?')
    args = [workspace_id, conversation_id, user_id]
    if kind is not None:
        sql += ' AND kind=?'
        args.append(kind)
    if now is not None:
        sql += ' AND updated<=?'
        args.append(now)
    return db.execute(sql, args).rowcount


def list_active(db, workspace_id, conversation_id, now, kind=None):
    """Return unexpired leases for one conversation, optionally filtered by kind."""
    workspace_id = _identifier(workspace_id, 'workspace_id')
    conversation_id = _identifier(conversation_id, 'conversation_id')
    now = _timestamp(now)
    if kind is not None:
        kind = _kind(kind)
    sql = ('SELECT workspace_id, conversation_id, user_id, kind, expires, updated '
           'FROM presence_leases WHERE workspace_id=? AND conversation_id=? AND expires>?')
    args = [workspace_id, conversation_id, now]
    if kind is not None:
        sql += ' AND kind=?'
        args.append(kind)
    sql += ' ORDER BY user_id, kind'
    return [_view(row) for row in db.execute(sql, args)]


def sweep_expired(db, now):
    """Delete all leases expired at or before ``now``; returns the number removed."""
    now = _timestamp(now)
    return db.execute(
        'DELETE FROM presence_leases WHERE expires<=?', (now,)).rowcount


def is_typing(db, workspace_id, conversation_id, user_id, now):
    """True only while the user's unexpired typing lease exists."""
    workspace_id = _identifier(workspace_id, 'workspace_id')
    conversation_id = _identifier(conversation_id, 'conversation_id')
    user_id = _identifier(user_id, 'user_id')
    now = _timestamp(now)
    return db.execute(
        "SELECT 1 FROM presence_leases WHERE workspace_id=? AND conversation_id=? "
        "AND user_id=? AND kind='typing' AND expires>?",
        (workspace_id, conversation_id, user_id, now)).fetchone() is not None
