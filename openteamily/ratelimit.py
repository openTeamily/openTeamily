"""Persistent fixed-window rate limiting for OpenTeamily.

Scope and honesty
-----------------
This module implements a **fixed-window** counter persisted in the caller's
SQLite database. It does not implement a token bucket, leaky bucket, sliding
log, or a distributed/global limiter. Windows are aligned to ``now //
window_seconds``; a caller can therefore see a burst of up to ``2 * limit``
requests around a window boundary. Only the operands supplied by the caller
are used; this module never chooses policy, authenticates a caller, or wires
itself into an HTTP route.

The limiter is **single-node** state guarded by SQLite transactions. A
top-level call uses ``BEGIN IMMEDIATE``; a call made inside an existing
transaction uses a named savepoint so the surrounding transaction keeps its
semantics. Cross-process callers that need stronger guarantees should use a
compatible SQLite transaction and a bounded busy timeout.

Keys are opaque, bounded strings. Callers must authorize the action before
calling this module and must namespace keys themselves, for example
``workspace:<id>:api``, ``workspace:<id>:automation:<id>`` or
``gateway:<key-id>``. Workspace isolation is therefore a caller choice, not a
property enforced here. Do **not** put tokens, passwords, prompts, or other
secrets in a key: keys are stored verbatim. They are not hashed.

State lives in this module's own ``rate_buckets`` table. The pre-existing
``rate_limits`` table in :mod:`openteamily.store` is deliberately untouched.
Denied calls do not write anything. Old buckets are removed only when the
caller invokes :func:`cleanup` with a cutoff older than the longest window in
use.

``hit_many`` is all-or-nothing: either every entry is consumed or none are.
See its docstring for the exact result semantics.
"""
from contextlib import contextmanager

SCHEMA = '''
CREATE TABLE IF NOT EXISTS rate_buckets (
 key TEXT PRIMARY KEY,
 window_start INTEGER NOT NULL,
 used INTEGER NOT NULL CHECK(used >= 0),
 updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_bucket_cleanup ON rate_buckets(updated);
'''

MAX_KEY_LENGTH = 512
MAX_LIMIT = 1_000_000
MAX_WINDOW_SECONDS = 31_536_000
_MAX_NOW = 2 ** 63 - 1
_SAVEPOINT = 'ratelimit'
_STATEMENTS = tuple(statement.strip() for statement in SCHEMA.split(';') if statement.strip())


def ensure_schema(db):
    """Create this module's tables/indexes if absent. Safe to call repeatedly."""
    for statement in _STATEMENTS:
        db.execute(statement)


def hit(db, key, limit, window_seconds, now, cost=1):
    """Consume ``cost`` units from ``key`` and return the decision.

    Invalid operands raise :class:`ValueError` before any state is read or
    written. The read-modify-write is atomic within a top-level
    ``BEGIN IMMEDIATE`` transaction or an outer transaction's savepoint.
    Denied calls never consume units and never update the bucket.
    """
    _validate(key, limit, window_seconds, now, cost)
    start = _window_start(now, window_seconds)
    with _transaction(db):
        used = _load_used(db, key, start)
        allowed = used + cost <= limit
        if allowed:
            new_used = used + cost
            db.execute(
                'INSERT INTO rate_buckets(key, window_start, used, updated) VALUES(?,?,?,?) '
                'ON CONFLICT(key) DO UPDATE SET window_start=excluded.window_start, '
                'used=excluded.used, updated=excluded.updated',
                (key, start, new_used, now),
            )
        else:
            new_used = used
    return _result(allowed, used, new_used, limit, start, window_seconds, now)


def peek(db, key, limit, window_seconds, now):
    """Return the current decision for a hypothetical one-unit request.

    ``remaining`` is the budget available right now. Reading never consumes
    units or creates/updates a bucket.
    """
    _validate(key, limit, window_seconds, now, 1)
    start = _window_start(now, window_seconds)
    used = _load_used(db, key, start)
    allowed = used < limit
    return _result(allowed, used, used, limit, start, window_seconds, now)


def reset(db, key):
    """Delete ``key``'s bucket. Return True when a row existed."""
    _check_key(key)
    with _transaction(db):
        cursor = db.execute('DELETE FROM rate_buckets WHERE key=?', (key,))
        removed = cursor.rowcount > 0
    return removed


def cleanup(db, before, now=None):
    """Delete buckets whose last write is older than ``before`` and return the count.

    ``before`` is an exclusive upper bound on ``updated``. ``now`` is accepted
    and validated for interface symmetry/future use but does not affect this
    fixed-window deletion. Choose ``before`` no newer than ``now`` minus the
    longest window you use, otherwise an active bucket can be removed.
    """
    _check_int('before', before, 0, _MAX_NOW)
    if now is not None:
        _check_now(now)
    with _transaction(db):
        cursor = db.execute('DELETE FROM rate_buckets WHERE updated<?', (before,))
        removed = cursor.rowcount
    return removed


def hit_many(db, entries, now):
    """Atomically consume a batch of ``(key, limit, window_seconds, cost)`` entries.

    Semantics are **all-or-nothing**. Entries are evaluated in order, with
    duplicate keys accumulating against one budget. If every entry fits, all
    costs are written in one transaction and each result describes the
    post-consumption state with ``allowed=True``. If any entry does not fit,
    nothing is written and every result has ``allowed=False``, the pre-batch
    ``remaining``, and the wait until that entry's window resets. A single key
    may not use two different window sizes in the same batch.
    """
    try:
        items = list(entries)
    except TypeError as exc:
        raise ValueError('entries must be an iterable of 4-tuples') from exc
    normalized = []
    for entry in items:
        if not isinstance(entry, (tuple, list)) or len(entry) != 4:
            raise ValueError('each entry must be a (key, limit, window_seconds, cost) tuple')
        key, limit, window_seconds, cost = entry
        _validate(key, limit, window_seconds, now, cost)
        normalized.append((key, limit, window_seconds, cost))
    if not normalized:
        return []
    windows = {}
    for key, _, window_seconds, _ in normalized:
        if windows.setdefault(key, window_seconds) != window_seconds:
            raise ValueError('one key cannot use two different windows in one batch')

    starts = {key: _window_start(now, window_seconds) for key, window_seconds in windows.items()}
    with _transaction(db):
        baseline = {key: _load_used(db, key, starts[key]) for key in windows}
        current = dict(baseline)
        results = []
        denied = False
        for key, limit, window_seconds, cost in normalized:
            used = current[key]
            allowed = used + cost <= limit
            if allowed:
                current[key] = used + cost
            else:
                denied = True
            results.append(_result(
                allowed, used, current[key], limit, starts[key], window_seconds, now
            ))
        if not denied:
            for key, window_seconds in windows.items():
                db.execute(
                    'INSERT INTO rate_buckets(key, window_start, used, updated) VALUES(?,?,?,?) '
                    'ON CONFLICT(key) DO UPDATE SET window_start=excluded.window_start, '
                    'used=excluded.used, updated=excluded.updated',
                    (key, starts[key], current[key], now),
                )
    if denied:
        return [
            _result(False, baseline[key], baseline[key], limit, starts[key], window_seconds, now)
            for key, limit, window_seconds, _ in normalized
        ]
    return results


def _result(allowed, used, new_used, limit, start, window_seconds, now):
    reset_at = start + window_seconds
    if allowed:
        remaining = max(0, limit - new_used)
        retry_after = 0
    else:
        remaining = max(0, limit - used)
        retry_after = max(1, reset_at - now)
    return {
        'allowed': allowed,
        'remaining': remaining,
        'limit': limit,
        'reset_at': reset_at,
        'retry_after': retry_after,
    }


def _window_start(now, window_seconds):
    return now - now % window_seconds


def _load_used(db, key, start):
    row = db.execute(
        'SELECT window_start, used FROM rate_buckets WHERE key=?', (key,)
    ).fetchone()
    if row is None or row[0] != start:
        return 0
    return int(row[1])


def _validate(key, limit, window_seconds, now, cost):
    _check_key(key)
    _check_int('limit', limit, 1, MAX_LIMIT)
    _check_int('window_seconds', window_seconds, 1, MAX_WINDOW_SECONDS)
    _check_now(now)
    _check_int('cost', cost, 1, limit)


def _check_key(key):
    if not isinstance(key, str):
        raise ValueError('key must be a string')
    if not 1 <= len(key) <= MAX_KEY_LENGTH:
        raise ValueError(f'key must contain 1..{MAX_KEY_LENGTH} characters')
    if '\x00' in key:
        raise ValueError('key must not contain NUL')
    try:
        key.encode('utf-8')
    except UnicodeError as exc:
        raise ValueError('key must be valid UTF-8 text') from exc


def _check_now(now):
    _check_int('now', now, 0, _MAX_NOW)


def _check_int(name, value, minimum, maximum):
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ValueError(f'{name} must be an integer between {minimum} and {maximum}')


@contextmanager
def _transaction(db):
    nested = db.in_transaction
    if nested:
        db.execute(f'SAVEPOINT {_SAVEPOINT}')
    else:
        db.execute('BEGIN IMMEDIATE')
    try:
        yield
    except BaseException:
        if nested:
            db.execute(f'ROLLBACK TO {_SAVEPOINT}')
            db.execute(f'RELEASE {_SAVEPOINT}')
        else:
            db.execute('ROLLBACK')
        raise
    else:
        if nested:
            db.execute(f'RELEASE {_SAVEPOINT}')
        else:
            db.execute('COMMIT')
