"""Append-only security/audit events in the private management SQLite database.

This module records metadata about sensitive actions such as authentication,
administration, runtime keys, skill secrets, connectors and orchestration. It is
a local audit trail, not a compliance certification, independent attestation or
tamper-proof WORM store: an operator or anyone with database access can still
change rows, and :func:`purge_before` intentionally deletes old events for
retention. "Append-only" here means the module exposes no update API.

Callers remain responsible for authorization and for deciding which events to
record. Workspace isolation is enforced on reads. Metadata keys that look
sensitive are redacted defensively, but value-level secret detection is not
possible; never put credentials in metadata. Self-written for OpenTeamily; no
upstream or Teamily source.
"""
import json
import re

SCHEMA = '''
CREATE TABLE IF NOT EXISTS audit_events (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 workspace_id TEXT NOT NULL,
 actor_id TEXT NOT NULL,
 action TEXT NOT NULL,
 target_type TEXT,
 target_id TEXT,
 outcome TEXT NOT NULL CHECK(outcome IN ('success','denied','error')),
 request_id TEXT,
 metadata TEXT NOT NULL DEFAULT '{}',
 created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS audit_event_workspace_created ON audit_events(workspace_id, created);
CREATE INDEX IF NOT EXISTS audit_event_actor_created ON audit_events(actor_id, created);
CREATE INDEX IF NOT EXISTS audit_event_action_created ON audit_events(action, created);
'''

OUTCOMES = ('success', 'denied', 'error')
MAX_WORKSPACE_ID = 128
MAX_ACTOR_ID = 128
MAX_ACTION = 120
MAX_TARGET_TYPE = 64
MAX_TARGET_ID = 200
MAX_REQUEST_ID = 200
MAX_METADATA_BYTES = 8192
MAX_METADATA_DEPTH = 16
MAX_LIMIT = 200
DEFAULT_LIMIT = 50
REDACTED = '[REDACTED]'

_ACTION = re.compile(r'[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*')
_TYPE = re.compile(r'[a-z][a-z0-9_-]*')
_SENSITIVE = re.compile(r'password|passwd|secret|token|key|authorization|cookie|session|csrf', re.IGNORECASE)


def ensure_schema(db):
    """Create the audit table and indexes if they do not already exist."""
    db.executescript(SCHEMA)


def _text(value, name, limit, pattern=None):
    if type(value) is not str or not 1 <= len(value) <= limit:
        raise ValueError(f'{name} must be a string of 1..{limit} characters')
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise ValueError(f'{name} must not contain control characters')
    if pattern is not None and pattern.fullmatch(value) is None:
        raise ValueError(f'{name} has an invalid format')
    return value


def _integer(value, name):
    if type(value) is not int or value < 0:
        raise ValueError(f'{name} must be a non-negative integer')
    return value


def _seq(value, name='cursor'):
    if type(value) is int:
        result = value
    elif type(value) is str and re.fullmatch(r'[0-9]{1,18}', value):
        result = int(value)
    else:
        raise ValueError(f'{name} must be a non-negative integer')
    if result < 0:
        raise ValueError(f'{name} must be a non-negative integer')
    return result


def _redact(value, depth=0):
    if depth > MAX_METADATA_DEPTH:
        raise ValueError('metadata is nested too deeply')
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            if type(key) is not str:
                raise ValueError('metadata keys must be strings')
            result[key] = REDACTED if _SENSITIVE.search(key) else _redact(item, depth + 1)
        return result
    if isinstance(value, (list, tuple)):
        return [_redact(item, depth + 1) for item in value]
    if value is None or type(value) in (str, int, float, bool):
        return value
    raise ValueError('metadata must be JSON-compatible')


def _metadata_text(metadata):
    if metadata is None:
        metadata = {}
    if type(metadata) is not dict:
        raise ValueError('metadata must be an object')
    redacted = _redact(metadata)
    try:
        text = json.dumps(redacted, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)
    except (TypeError, ValueError):
        raise ValueError('metadata must be JSON-compatible') from None
    if len(text.encode('utf-8')) > MAX_METADATA_BYTES:
        raise ValueError(f'metadata exceeds {MAX_METADATA_BYTES} bytes')
    return text


def _view(row):
    try:
        metadata = json.loads(row['metadata'])
    except (TypeError, ValueError):
        metadata = {}
    return {
        'seq': row['seq'],
        'workspace_id': row['workspace_id'],
        'actor_id': row['actor_id'],
        'action': row['action'],
        'target_type': row['target_type'],
        'target_id': row['target_id'],
        'outcome': row['outcome'],
        'request_id': row['request_id'],
        'metadata': metadata,
        'created': row['created'],
    }


def record(db, workspace_id, actor_id, action, outcome, now,
           target_type=None, target_id=None, request_id=None, metadata=None):
    """Append one event and return its stored view. No update API is provided."""
    _text(workspace_id, 'workspace_id', MAX_WORKSPACE_ID)
    _text(actor_id, 'actor_id', MAX_ACTOR_ID)
    _text(action, 'action', MAX_ACTION, _ACTION)
    if outcome not in OUTCOMES:
        raise ValueError('outcome must be success, denied or error')
    if target_type is not None:
        _text(target_type, 'target_type', MAX_TARGET_TYPE, _TYPE)
    if target_id is not None:
        _text(target_id, 'target_id', MAX_TARGET_ID)
    if request_id is not None:
        _text(request_id, 'request_id', MAX_REQUEST_ID)
    _integer(now, 'now')
    stored_metadata = _metadata_text(metadata)
    cursor = db.execute(
        'INSERT INTO audit_events(workspace_id, actor_id, action, target_type, target_id, '
        'outcome, request_id, metadata, created) VALUES(?,?,?,?,?,?,?,?,?)',
        (workspace_id, actor_id, action, target_type, target_id, outcome, request_id,
         stored_metadata, now),
    )
    return get_event(db, workspace_id, cursor.lastrowid)


def list_events(db, workspace_id, limit=DEFAULT_LIMIT, cursor=None, action=None, actor_id=None, since=None):
    """Return one workspace's events newest-first, optionally paged by seq cursor."""
    _text(workspace_id, 'workspace_id', MAX_WORKSPACE_ID)
    if type(limit) is not int or not 1 <= limit <= MAX_LIMIT:
        raise ValueError(f'limit must be an integer from 1 to {MAX_LIMIT}')
    clauses = ['workspace_id=?']
    parameters = [workspace_id]
    if cursor is not None:
        clauses.append('seq<?')
        parameters.append(_seq(cursor))
    if action is not None:
        _text(action, 'action', MAX_ACTION, _ACTION)
        clauses.append('action=?')
        parameters.append(action)
    if actor_id is not None:
        _text(actor_id, 'actor_id', MAX_ACTOR_ID)
        clauses.append('actor_id=?')
        parameters.append(actor_id)
    if since is not None:
        _integer(since, 'since')
        clauses.append('created>=?')
        parameters.append(since)
    parameters.append(limit)
    rows = db.execute(
        'SELECT * FROM audit_events WHERE ' + ' AND '.join(clauses) +
        ' ORDER BY seq DESC LIMIT ?', parameters,
    ).fetchall()
    return [_view(row) for row in rows]


def get_event(db, workspace_id, seq):
    """Return one event in the workspace, or None when absent or cross-workspace."""
    _text(workspace_id, 'workspace_id', MAX_WORKSPACE_ID)
    row = db.execute(
        'SELECT * FROM audit_events WHERE workspace_id=? AND seq=?',
        (workspace_id, _seq(seq, 'seq')),
    ).fetchone()
    return None if row is None else _view(row)


def stats(db, workspace_id, since=None):
    """Return total and grouped counts for one workspace, optionally since a time."""
    _text(workspace_id, 'workspace_id', MAX_WORKSPACE_ID)
    clauses = ['workspace_id=?']
    parameters = [workspace_id]
    if since is not None:
        _integer(since, 'since')
        clauses.append('created>=?')
        parameters.append(since)
    where = ' WHERE ' + ' AND '.join(clauses)
    total = db.execute('SELECT COUNT(*) FROM audit_events' + where, parameters).fetchone()[0]
    outcomes = db.execute(
        'SELECT outcome, COUNT(*) AS count FROM audit_events' + where +
        ' GROUP BY outcome ORDER BY outcome', parameters,
    ).fetchall()
    actions = db.execute(
        'SELECT action, COUNT(*) AS count FROM audit_events' + where +
        ' GROUP BY action ORDER BY action', parameters,
    ).fetchall()
    return {
        'workspace_id': workspace_id,
        'total': total,
        'by_outcome': {row['outcome']: row['count'] for row in outcomes},
        'by_action': {row['action']: row['count'] for row in actions},
    }


def purge_before(db, cutoff, workspace_id=None):
    """Delete events created before cutoff; global when workspace_id is omitted."""
    _integer(cutoff, 'cutoff')
    if workspace_id is None:
        return db.execute('DELETE FROM audit_events WHERE created<?', (cutoff,)).rowcount
    _text(workspace_id, 'workspace_id', MAX_WORKSPACE_ID)
    return db.execute(
        'DELETE FROM audit_events WHERE created<? AND workspace_id=?',
        (cutoff, workspace_id),
    ).rowcount
