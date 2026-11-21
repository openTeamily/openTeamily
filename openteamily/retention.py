"""Workspace data-retention policy records and deterministic purge planning.

This module stores policy records and computes a plan from caller-supplied row
metadata. It does **not** delete workspace data: :func:`execute` invokes a
caller-provided callback for each planned id and records an audit-ish run row.
The plan is only as correct as the supplied rows and their timestamps. Legal
holds are policy metadata, not an independent legal-hold workflow, and this
module is not a backup, restore, compliance or legal guarantee. It also does
not enforce retention against callers that write or delete data elsewhere.

Python 3.11+ standard library only. Rows and policies are scoped by workspace.
"""
import json
import re
from uuid import uuid4

SCHEMA = '''
CREATE TABLE IF NOT EXISTS retention_policies (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 data_class TEXT NOT NULL,
 ttl_seconds INTEGER NOT NULL CHECK(ttl_seconds > 0),
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 legal_hold INTEGER NOT NULL CHECK(legal_hold IN (0,1)),
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL,
 PRIMARY KEY(workspace_id, data_class));
CREATE INDEX IF NOT EXISTS retention_policy_workspace
 ON retention_policies(workspace_id, data_class);
CREATE TABLE IF NOT EXISTS retention_runs (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 counts TEXT NOT NULL,
 deleted INTEGER NOT NULL CHECK(deleted >= 0),
 failed INTEGER NOT NULL CHECK(failed >= 0),
 created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS retention_run_workspace
 ON retention_runs(workspace_id, created, id);
'''

DATA_CLASS = re.compile(r'[a-z][a-z0-9_]{0,63}')
MIN_TTL_SECONDS = 1
MAX_TTL_SECONDS = 10 * 365 * 24 * 60 * 60
MAX_ID_LENGTH = 256
MAX_ROWS = 10000
REASON_DISABLED = 'disabled'
REASON_NOT_DUE = 'not_due'


class _Plan(dict):
    """A normal plan dict that also carries per-class counts for the run record."""

    def __init__(self, value, data_class_counts):
        super().__init__(value)
        self.data_class_counts = data_class_counts


def ensure_schema(db):
    """Create the retention tables/indexes. Safe to call repeatedly."""
    for statement in SCHEMA.split(';'):
        if statement.strip():
            db.execute(statement)


def _text_id(value, label):
    if type(value) is not str or not 1 <= len(value) <= MAX_ID_LENGTH:
        raise ValueError(f'{label} must be a non-empty bounded string')
    if value != value.strip() or any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise ValueError(f'{label} must not contain surrounding whitespace or control characters')
    return value


def _data_class(value):
    if type(value) is not str or DATA_CLASS.fullmatch(value) is None:
        raise ValueError('data_class must match [a-z][a-z0-9_]{0,63}')
    return value


def _ttl(value):
    if type(value) is not int or not MIN_TTL_SECONDS <= value <= MAX_TTL_SECONDS:
        raise ValueError(
            f'ttl_seconds must be an integer from {MIN_TTL_SECONDS} to {MAX_TTL_SECONDS}')
    return value


def _flag(value, label):
    if type(value) is bool:
        return value
    if type(value) is int and value in (0, 1):
        return bool(value)
    raise ValueError(f'{label} must be a boolean')


def _timestamp(value, label):
    if type(value) is not int:
        raise ValueError(f'{label} must be an integer Unix timestamp')
    return value


def _policy_view(row):
    return {
        'workspace_id': row['workspace_id'],
        'data_class': row['data_class'],
        'ttl_seconds': row['ttl_seconds'],
        'enabled': bool(row['enabled']),
        'legal_hold': bool(row['legal_hold']),
        'created': row['created'],
        'updated': row['updated'],
    }


def set_policy(db, workspace_id, data_class, ttl_seconds, now,
               enabled=True, legal_hold=False):
    """Create or replace one workspace data-class policy."""
    workspace_id = _text_id(workspace_id, 'workspace_id')
    data_class = _data_class(data_class)
    ttl_seconds = _ttl(ttl_seconds)
    now = _timestamp(now, 'now')
    enabled = _flag(enabled, 'enabled')
    legal_hold = _flag(legal_hold, 'legal_hold')
    db.execute(
        'INSERT INTO retention_policies '
        '(workspace_id,data_class,ttl_seconds,enabled,legal_hold,created,updated) '
        'VALUES(?,?,?,?,?,?,?) '
        'ON CONFLICT(workspace_id,data_class) DO UPDATE SET '
        'ttl_seconds=excluded.ttl_seconds,enabled=excluded.enabled,'
        'legal_hold=excluded.legal_hold,updated=excluded.updated',
        (workspace_id, data_class, ttl_seconds, int(enabled), int(legal_hold),
         now, now),
    )
    return get_policy(db, workspace_id, data_class)


def get_policy(db, workspace_id, data_class):
    """Return one policy for this workspace, or None."""
    workspace_id = _text_id(workspace_id, 'workspace_id')
    data_class = _data_class(data_class)
    row = db.execute(
        'SELECT * FROM retention_policies WHERE workspace_id=? AND data_class=?',
        (workspace_id, data_class),
    ).fetchone()
    return None if row is None else _policy_view(row)


def list_policies(db, workspace_id):
    """Return this workspace's policies ordered by data_class."""
    workspace_id = _text_id(workspace_id, 'workspace_id')
    rows = db.execute(
        'SELECT * FROM retention_policies WHERE workspace_id=? ORDER BY data_class',
        (workspace_id,),
    ).fetchall()
    return [_policy_view(row) for row in rows]


def delete_policy(db, workspace_id, data_class):
    """Delete one policy; return True when a row was removed."""
    workspace_id = _text_id(workspace_id, 'workspace_id')
    data_class = _data_class(data_class)
    return db.execute(
        'DELETE FROM retention_policies WHERE workspace_id=? AND data_class=?',
        (workspace_id, data_class),
    ).rowcount > 0


def plan(db, workspace_id, rows, now):
    """Return a deterministic purge plan for caller-supplied row metadata.

    Each row is ``{id, data_class, created, legal_hold?}``. A row is deletable
    only when a known class policy is enabled and not under legal hold, and
    ``now - created >= ttl_seconds`` (the exact cutoff is eligible). Unknown
    classes and legal holds are reported separately instead of being deleted.
    """
    workspace_id = _text_id(workspace_id, 'workspace_id')
    now = _timestamp(now, 'now')
    if not isinstance(rows, list):
        raise ValueError('rows must be a list')
    if len(rows) > MAX_ROWS:
        raise ValueError(f'rows must contain at most {MAX_ROWS} items')

    policies = {
        row['data_class']: row for row in db.execute(
            'SELECT * FROM retention_policies WHERE workspace_id=?',
            (workspace_id,),
        ).fetchall()
    }

    delete, keep, unknown_policy, legal_hold = [], [], [], []
    counts = {}
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError('each row must be an object')
        item_id = _text_id(row.get('id'), 'id')
        data_class = _data_class(row.get('data_class'))
        created = _timestamp(row.get('created'), 'created')
        row_hold = _flag(row.get('legal_hold', False), 'legal_hold')

        if row_hold:
            legal_hold.append(item_id)
            continue
        policy = policies.get(data_class)
        if policy is None:
            unknown_policy.append(item_id)
            continue
        if policy['legal_hold']:
            legal_hold.append(item_id)
            continue
        if not policy['enabled']:
            keep.append({'id': item_id, 'reason': REASON_DISABLED})
            continue
        if now - created < policy['ttl_seconds']:
            keep.append({'id': item_id, 'reason': REASON_NOT_DUE})
            continue
        delete.append(item_id)
        counts[data_class] = counts.get(data_class, 0) + 1

    delete.sort()
    unknown_policy.sort()
    legal_hold.sort()
    keep.sort(key=lambda item: item['id'])
    return _Plan({
        'delete': delete,
        'keep': keep,
        'unknown_policy': unknown_policy,
        'legal_hold': legal_hold,
    }, counts)


def execute(db, workspace_id, plan, delete_fn, now):
    """Invoke ``delete_fn(id)`` only for planned deletions and record a run.

    This function does not read, delete or otherwise touch the caller's rows.
    Callback exceptions count as failures and do not stop later ids. A
    retention_runs row records attempted class counts plus deleted/failed.
    """
    workspace_id = _text_id(workspace_id, 'workspace_id')
    now = _timestamp(now, 'now')
    if not isinstance(plan, dict):
        raise ValueError('plan must be an object')
    if not callable(delete_fn):
        raise ValueError('delete_fn must be callable')
    raw_ids = plan.get('delete')
    if not isinstance(raw_ids, list):
        raise ValueError('plan.delete must be a list')
    if len(raw_ids) > MAX_ROWS:
        raise ValueError(f'plan.delete must contain at most {MAX_ROWS} items')

    ids = [_text_id(item_id, 'id') for item_id in raw_ids]
    counts = getattr(plan, 'data_class_counts', {})
    clean_counts = {}
    if isinstance(counts, dict):
        for data_class, value in counts.items():
            if (type(data_class) is str and DATA_CLASS.fullmatch(data_class)
                    and type(value) is int and value >= 0):
                clean_counts[data_class] = value

    deleted = failed = 0
    for item_id in ids:
        try:
            delete_fn(item_id)
        except Exception:
            failed += 1
        else:
            deleted += 1

    db.execute(
        'INSERT INTO retention_runs(id,workspace_id,counts,deleted,failed,created) '
        'VALUES(?,?,?,?,?,?)',
        (uuid4().hex, workspace_id,
         json.dumps(clean_counts, sort_keys=True, separators=(',', ':')),
         deleted, failed, now),
    )
    return {'attempted': len(ids), 'deleted': deleted, 'failed': failed}


def _run_view(row):
    try:
        counts = json.loads(row['counts'])
    except (TypeError, ValueError):
        counts = {}
    if not isinstance(counts, dict):
        counts = {}
    return {
        'id': row['id'],
        'workspace_id': row['workspace_id'],
        'counts': counts,
        'deleted': row['deleted'],
        'failed': row['failed'],
        'created': row['created'],
    }


def stats(db, workspace_id):
    """Return this workspace's policies and its most recent run (or None)."""
    workspace_id = _text_id(workspace_id, 'workspace_id')
    row = db.execute(
        'SELECT * FROM retention_runs WHERE workspace_id=? '
        'ORDER BY created DESC, rowid DESC LIMIT 1',
        (workspace_id,),
    ).fetchone()
    return {
        'policies': list_policies(db, workspace_id),
        'last_run': None if row is None else _run_view(row),
    }
