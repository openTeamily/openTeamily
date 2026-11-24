"""Workspace/user feature flags with deterministic percentage rollout.

This is a small local flag store for OpenTeamily. Flags, allowlists and
percentages live in the management SQLite database; bucketing is a pure hash
of the flag key, user ID and workspace ID, so the same tuple always maps to
the same bucket. Callers remain responsible for authenticating the user and
authorizing access to the workspace before consulting a flag. This module is
not an experimentation analytics platform: it does not record exposures,
compute statistics, target attributes, cache remotely, or provide an admin UI.

Set operations raise KeyError for an unknown key. Passing no fields to
set_flag returns the existing flag without changing ``updated``. Allowlist
entry order is preserved and duplicates are removed. ``list_flags`` uses the
last returned key as the next cursor. Invalid keys passed to read/delete
operations are treated as absent.
"""
import hashlib
import json
import re

SCHEMA = '''
CREATE TABLE IF NOT EXISTS feature_flags (
 key TEXT PRIMARY KEY,
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 rollout_percent INTEGER NOT NULL DEFAULT 0 CHECK(rollout_percent BETWEEN 0 AND 100),
 allow_users TEXT NOT NULL DEFAULT '[]',
 allow_workspaces TEXT NOT NULL DEFAULT '[]',
 description TEXT,
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL);
'''

KEY = re.compile(r'[a-z0-9._-]{1,64}')
CONTROL = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f]')
MAX_ALLOW_ENTRIES = 1000
MAX_ALLOW_ENTRY = 128
MAX_DESCRIPTION = 2000
MAX_LIMIT = 100


def ensure_schema(db):
    """Create the feature flag table when absent. Safe to call repeatedly."""
    db.executescript(SCHEMA)


def valid_key(key):
    return isinstance(key, str) and KEY.fullmatch(key) is not None


def _allowlist(value, name):
    if value is None:
        return []
    if not isinstance(value, (list, tuple)):
        raise ValueError(f'{name} must be a list of IDs')
    if len(value) > MAX_ALLOW_ENTRIES:
        raise ValueError(f'{name} has too many entries')
    result = []
    seen = set()
    for item in value:
        if not isinstance(item, str) or not item or len(item) > MAX_ALLOW_ENTRY:
            raise ValueError(f'{name} entries must be non-empty strings of at most {MAX_ALLOW_ENTRY} characters')
        if CONTROL.search(item):
            raise ValueError(f'{name} entries must not contain control characters')
        if item not in seen:
            result.append(item)
            seen.add(item)
    return result


def _description(value):
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > MAX_DESCRIPTION:
        raise ValueError(f'description must be a string of at most {MAX_DESCRIPTION} characters')
    if CONTROL.search(value):
        raise ValueError('description must not contain control characters')
    return value


def _rollout(value):
    if type(value) is not int or not 0 <= value <= 100:
        raise ValueError('rollout_percent must be an integer from 0 to 100')
    return value


def _enabled(value):
    if type(value) is not bool:
        raise ValueError('enabled must be a boolean')
    return 1 if value else 0


def _encode(values):
    return json.dumps(values, ensure_ascii=True, separators=(',', ':'))


def _decode(value):
    try:
        decoded = json.loads(value)
    except (TypeError, ValueError):
        return []
    if not isinstance(decoded, list) or any(not isinstance(item, str) for item in decoded):
        return []
    return decoded


def _view(row):
    return {
        'key': row['key'],
        'enabled': bool(row['enabled']),
        'rollout_percent': int(row['rollout_percent']),
        'allow_users': _decode(row['allow_users']),
        'allow_workspaces': _decode(row['allow_workspaces']),
        'description': row['description'],
        'created': row['created'],
        'updated': row['updated'],
    }


def define_flag(db, key, now, enabled=True, rollout_percent=0, allow_users=None,
                allow_workspaces=None, description=None):
    """Insert or fully replace a flag definition; created is preserved on update."""
    if not valid_key(key):
        raise ValueError('invalid feature flag key')
    enabled_value = _enabled(enabled)
    rollout = _rollout(rollout_percent)
    users = _allowlist(allow_users, 'allow_users')
    workspaces = _allowlist(allow_workspaces, 'allow_workspaces')
    text = _description(description)
    db.execute(
        'INSERT INTO feature_flags '
        '(key,enabled,rollout_percent,allow_users,allow_workspaces,description,created,updated) '
        'VALUES(?,?,?,?,?,?,?,?) '
        'ON CONFLICT(key) DO UPDATE SET '
        'enabled=excluded.enabled, rollout_percent=excluded.rollout_percent, '
        'allow_users=excluded.allow_users, allow_workspaces=excluded.allow_workspaces, '
        'description=excluded.description, updated=excluded.updated',
        (key, enabled_value, rollout, _encode(users), _encode(workspaces), text, now, now),
    )
    return get_flag(db, key)


def set_flag(db, key, now, enabled=None, rollout_percent=None, allow_users=None,
             allow_workspaces=None, description=None):
    """Partially update an existing flag. Raises KeyError when the key is unknown."""
    if not valid_key(key):
        raise ValueError('invalid feature flag key')
    row = db.execute('SELECT * FROM feature_flags WHERE key=?', (key,)).fetchone()
    if row is None:
        raise KeyError(key)
    changes = {}
    if enabled is not None:
        changes['enabled'] = _enabled(enabled)
    if rollout_percent is not None:
        changes['rollout_percent'] = _rollout(rollout_percent)
    if allow_users is not None:
        changes['allow_users'] = _encode(_allowlist(allow_users, 'allow_users'))
    if allow_workspaces is not None:
        changes['allow_workspaces'] = _encode(_allowlist(allow_workspaces, 'allow_workspaces'))
    if description is not None:
        changes['description'] = _description(description)
    if not changes:
        return _view(row)
    changes['updated'] = now
    assignments = ', '.join(f'{column}=?' for column in changes)
    db.execute(
        f'UPDATE feature_flags SET {assignments} WHERE key=?',
        (*changes.values(), key),
    )
    return get_flag(db, key)


def get_flag(db, key):
    if not isinstance(key, str):
        return None
    row = db.execute('SELECT * FROM feature_flags WHERE key=?', (key,)).fetchone()
    return _view(row) if row is not None else None


def list_flags(db, limit=100, cursor=None):
    if type(limit) is not int or limit < 1:
        raise ValueError('limit must be a positive integer')
    if cursor is None:
        cursor = ''
    elif not isinstance(cursor, str):
        raise ValueError('cursor must be a flag key string')
    rows = db.execute(
        'SELECT * FROM feature_flags WHERE key>? ORDER BY key LIMIT ?',
        (cursor, min(limit, MAX_LIMIT)),
    ).fetchall()
    return [_view(row) for row in rows]


def delete_flag(db, key):
    if not isinstance(key, str):
        return False
    cursor = db.execute('DELETE FROM feature_flags WHERE key=?', (key,))
    return cursor.rowcount > 0


def bucket(key, user_id=None, workspace_id=None):
    material = f'{key}:{user_id or ""}:{workspace_id or ""}'.encode('utf-8')
    return int(hashlib.sha256(material).hexdigest()[:8], 16) % 100


def is_enabled(db, key, user_id=None, workspace_id=None, default=False):
    flag = get_flag(db, key)
    if flag is None:
        return bool(default)
    if not flag['enabled']:
        return False
    if user_id is not None and user_id in flag['allow_users']:
        return True
    if workspace_id is not None and workspace_id in flag['allow_workspaces']:
        return True
    return bucket(key, user_id, workspace_id) < flag['rollout_percent']
