"""Workspace outbound event subscription registry, matching and delivery bookkeeping.

Self-written for OpenTeamily. This module stores which external HTTPS endpoints
want which workspace event kinds, plus an idempotent record of delivery attempts.
It does not send HTTP, sign payloads, retry, queue an outbox, or accept inbound
webhooks. ``secret_ref`` is an opaque pointer to a secret held elsewhere; no
secret value is accepted or stored here. HTTP delivery and the outbox are later
slices and must not be described as implemented by this module.
"""
import builtins
import json
import math
import re
import sqlite3
from urllib.parse import urlsplit
from uuid import uuid4

SCHEMA = '''
CREATE TABLE IF NOT EXISTS event_subscriptions (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 name TEXT NOT NULL,
 endpoint TEXT NOT NULL,
 secret_ref TEXT,
 kinds TEXT NOT NULL,
 filters TEXT NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL,
 last_delivery INTEGER,
 UNIQUE(workspace_id, name));
CREATE INDEX IF NOT EXISTS event_subscription_workspace
 ON event_subscriptions(workspace_id, enabled, id);
CREATE TABLE IF NOT EXISTS event_delivery_records (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 subscription_id TEXT NOT NULL REFERENCES event_subscriptions(id) ON DELETE CASCADE,
 event_kind TEXT NOT NULL,
 event_key TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('delivered','failed')),
 created INTEGER NOT NULL,
 UNIQUE(workspace_id, subscription_id, event_key));
CREATE INDEX IF NOT EXISTS event_delivery_record_lookup
 ON event_delivery_records(workspace_id, subscription_id, created);
CREATE INDEX IF NOT EXISTS event_delivery_record_kind
 ON event_delivery_records(workspace_id, event_kind, created);
'''

MAX_ENDPOINT = 2048
MAX_HOST = 253
MAX_NAME = 80
MAX_KINDS = 50
MAX_KIND = 64
MAX_FILTER_KEYS = 20
MAX_FILTER_KEY = 64
MAX_FILTER_STRING = 256
MAX_FILTER_IN = 50
MAX_FILTER_JSON = 4096
MAX_SECRET_REF = 256
MAX_EVENT_KEY = 256
MAX_LIST = 1000
MAX_MATCHED = 1000

CONTROL = re.compile(r'[\x00-\x1f\x7f-\x9f]')
KIND = re.compile(r'[A-Za-z0-9_.:-]{1,64}')
FILTER_KEY = re.compile(r'[A-Za-z0-9_.-]{1,64}')
MISSING = object()


def ensure_schema(db):
    """Create the subscription and delivery tables if they are absent.

    Safe to call repeatedly. The application store does not include this module's
    schema; an integration that wants it on startup must call this explicitly.
    """
    db.executescript(SCHEMA)


def _timestamp(value):
    if type(value) is not int or value < 0:
        raise ValueError('Timestamp must be a non-negative integer')
    return value


def _validate_name(value):
    if not isinstance(value, str):
        raise ValueError('Subscription name must be text')
    name = value.strip()
    if not 1 <= len(name) <= MAX_NAME or CONTROL.search(name):
        raise ValueError('Subscription name must be 1-80 characters without control characters')
    return name


def _validate_endpoint(value):
    if not isinstance(value, str) or not 1 <= len(value) <= MAX_ENDPOINT:
        raise ValueError('Endpoint must be a bounded HTTPS URL')
    if CONTROL.search(value) or any(char.isspace() for char in value):
        raise ValueError('Endpoint must not contain whitespace or control characters')
    try:
        parts = urlsplit(value)
        parts.port
    except ValueError as exc:
        raise ValueError('Endpoint is not a valid HTTPS URL') from exc
    if parts.scheme.lower() != 'https' or not parts.hostname:
        raise ValueError('Endpoint must be an HTTPS URL with a host')
    if len(parts.hostname) > MAX_HOST:
        raise ValueError('Endpoint host is too long')
    if parts.username is not None or parts.password is not None:
        raise ValueError('Endpoint must not embed credentials; use secret_ref')
    if parts.fragment:
        raise ValueError('Endpoint must not contain a fragment')
    return value


def _validate_kind(value):
    if not isinstance(value, str):
        raise ValueError('Event kind must be text')
    kind = value.strip()
    if not KIND.fullmatch(kind):
        raise ValueError('Event kind must be 1-64 letters, digits, dot, colon, underscore or dash')
    return kind


def _normalize_kinds(kinds):
    if not isinstance(kinds, (builtins.list, tuple)):
        raise ValueError('Kinds must be a list')
    normalized = []
    for value in kinds:
        kind = _validate_kind(value)
        if kind not in normalized:
            normalized.append(kind)
    if not 1 <= len(normalized) <= MAX_KINDS:
        raise ValueError('Kinds must contain 1-50 distinct values')
    return normalized


def _validate_secret_ref(value):
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError('secret_ref must be text')
    reference = value.strip()
    if not 1 <= len(reference) <= MAX_SECRET_REF or CONTROL.search(reference):
        raise ValueError('secret_ref must be 1-256 characters without control characters')
    return reference


def _validate_event_key(value):
    if not isinstance(value, str) or not 1 <= len(value) <= MAX_EVENT_KEY:
        raise ValueError('Event key must be 1-256 characters')
    if CONTROL.search(value):
        raise ValueError('Event key must not contain control characters')
    return value


def _enabled(value):
    if type(value) is bool:
        return 1 if value else 0
    if type(value) is int and value in (0, 1):
        return value
    raise ValueError('enabled must be a boolean')


def _scalar(value):
    if value is None:
        return None
    if type(value) is bool:
        return value
    if type(value) is int:
        return value
    if type(value) is float:
        if not math.isfinite(value):
            raise ValueError('Filter numbers must be finite')
        return value
    if isinstance(value, str):
        if len(value) > MAX_FILTER_STRING or CONTROL.search(value):
            raise ValueError('Filter strings must be at most 256 characters without controls')
        return value
    raise ValueError('Filter values must be scalar JSON values')


def _normalize_filters(filters):
    if filters is None:
        filters = {}
    if not isinstance(filters, dict) or len(filters) > MAX_FILTER_KEYS:
        raise ValueError('Filters must be an object with at most 20 keys')
    normalized = {}
    for key, value in filters.items():
        if not isinstance(key, str) or not FILTER_KEY.fullmatch(key):
            raise ValueError('Filter keys must be 1-64 letters, digits, dot, underscore or dash')
        if isinstance(value, dict):
            if set(value) != {'in'} or not isinstance(value['in'], builtins.list):
                raise ValueError('Filter objects must have exactly an "in" list')
            if not 1 <= len(value['in']) <= MAX_FILTER_IN:
                raise ValueError('Filter "in" lists must contain 1-50 values')
            normalized[key] = {'in': [_scalar(item) for item in value['in']]}
        else:
            normalized[key] = _scalar(value)
    return normalized


def _filters_json(filters):
    encoded = json.dumps(filters, ensure_ascii=True, sort_keys=True, separators=(',', ':'))
    if len(encoded) > MAX_FILTER_JSON:
        raise ValueError('Filters exceed the 4096-character storage bound')
    return encoded


def _kind_json(kinds):
    return json.dumps(kinds, ensure_ascii=True, sort_keys=False, separators=(',', ':'))


def view(row):
    return {
        'id': row['id'],
        'workspace_id': row['workspace_id'],
        'name': row['name'],
        'endpoint': row['endpoint'],
        'secret_ref': row['secret_ref'],
        'kinds': json.loads(row['kinds']),
        'filters': json.loads(row['filters']),
        'enabled': bool(row['enabled']),
        'created': row['created'],
        'updated': row['updated'],
        'last_delivery': row['last_delivery'],
    }


def _row(db, workspace_id, subscription_id):
    return db.execute(
        'SELECT * FROM event_subscriptions WHERE workspace_id=? AND id=?',
        (workspace_id, subscription_id)).fetchone()


def _require_row(db, workspace_id, subscription_id):
    row = _row(db, workspace_id, subscription_id)
    if row is None:
        raise LookupError('Subscription not found in this workspace')
    return row


def create_subscription(db, workspace_id, name, endpoint, now, kinds,
                        secret_ref=None, filters=None):
    """Create an enabled subscription; duplicate names in a workspace are rejected."""
    name = _validate_name(name)
    endpoint = _validate_endpoint(endpoint)
    now = _timestamp(now)
    kinds = _normalize_kinds(kinds)
    filters = _normalize_filters(filters)
    secret_ref = _validate_secret_ref(secret_ref)
    if db.execute('SELECT 1 FROM workspaces WHERE id=?', (workspace_id,)).fetchone() is None:
        raise LookupError('Workspace not found')
    subscription_id = uuid4().hex
    try:
        db.execute(
            'INSERT INTO event_subscriptions '
            '(id,workspace_id,name,endpoint,secret_ref,kinds,filters,enabled,created,updated,last_delivery) '
            'VALUES(?,?,?,?,?,?,?,1,?,?,NULL)',
            (subscription_id, workspace_id, name, endpoint, secret_ref,
             _kind_json(kinds), _filters_json(filters), now, now))
    except sqlite3.IntegrityError as exc:
        if 'UNIQUE' in str(exc).upper():
            raise ValueError('Subscription name already exists in this workspace') from exc
        raise
    return view(_require_row(db, workspace_id, subscription_id))


def update_subscription(db, workspace_id, subscription_id, now, changes=None, **fields):
    """Update named fields, or a ``changes`` mapping, without touching delivery records.

    Supported keys are ``name``, ``endpoint``, ``kinds``, ``filters``, ``secret_ref``
    and ``enabled``. ``secret_ref=None`` clears the reference; a plaintext ``secret``
    key is rejected.
    """
    now = _timestamp(now)
    if changes is None:
        updates = {}
    elif isinstance(changes, dict):
        updates = dict(changes)
    else:
        raise ValueError('changes must be an object')
    updates.update(fields)
    allowed = {'name', 'endpoint', 'kinds', 'filters', 'secret_ref', 'enabled'}
    unknown = set(updates) - allowed
    if unknown:
        raise ValueError('Unsupported subscription fields: ' + ', '.join(sorted(unknown)))
    row = _require_row(db, workspace_id, subscription_id)
    if not updates:
        return view(row)

    columns, params = [], []
    if 'name' in updates:
        columns.append('name=?')
        params.append(_validate_name(updates['name']))
    if 'endpoint' in updates:
        columns.append('endpoint=?')
        params.append(_validate_endpoint(updates['endpoint']))
    if 'kinds' in updates:
        columns.append('kinds=?')
        params.append(_kind_json(_normalize_kinds(updates['kinds'])))
    if 'filters' in updates:
        columns.append('filters=?')
        params.append(_filters_json(_normalize_filters(updates['filters'])))
    if 'secret_ref' in updates:
        columns.append('secret_ref=?')
        params.append(_validate_secret_ref(updates['secret_ref']))
    if 'enabled' in updates:
        columns.append('enabled=?')
        params.append(_enabled(updates['enabled']))
    columns.append('updated=?')
    params.append(now)
    params.extend((workspace_id, subscription_id))
    try:
        db.execute('UPDATE event_subscriptions SET ' + ','.join(columns) +
                   ' WHERE workspace_id=? AND id=?', params)
    except sqlite3.IntegrityError as exc:
        if 'UNIQUE' in str(exc).upper():
            raise ValueError('Subscription name already exists in this workspace') from exc
        raise
    return view(_require_row(db, workspace_id, subscription_id))


def disable(db, workspace_id, subscription_id, now):
    now = _timestamp(now)
    _require_row(db, workspace_id, subscription_id)
    db.execute(
        'UPDATE event_subscriptions SET enabled=0, updated=? WHERE workspace_id=? AND id=?',
        (now, workspace_id, subscription_id))
    return view(_require_row(db, workspace_id, subscription_id))


def get(db, workspace_id, subscription_id):
    row = _row(db, workspace_id, subscription_id)
    return None if row is None else view(row)


def list(db, workspace_id, kinds=None, enabled=None):
    """List workspace subscriptions, optionally intersecting event kinds or enabled state."""
    sql = 'SELECT * FROM event_subscriptions WHERE workspace_id=?'
    params = [workspace_id]
    if enabled is not None:
        sql += ' AND enabled=?'
        params.append(_enabled(enabled))
    sql += ' ORDER BY created,id LIMIT ?'
    params.append(MAX_LIST)
    items = [view(row) for row in db.execute(sql, params).fetchall()]
    if kinds is not None:
        wanted = set(_normalize_kinds(kinds))
        items = [item for item in items if wanted.intersection(item['kinds'])]
    return items


def delete(db, workspace_id, subscription_id):
    """Delete a subscription and its delivery records; return whether a row was removed."""
    db.execute(
        'DELETE FROM event_delivery_records WHERE workspace_id=? AND subscription_id=?',
        (workspace_id, subscription_id))
    return db.execute(
        'DELETE FROM event_subscriptions WHERE workspace_id=? AND id=?',
        (workspace_id, subscription_id)).rowcount > 0


def _equal(actual, expected):
    if actual is MISSING:
        return False
    if isinstance(actual, bool) or isinstance(expected, bool):
        return isinstance(actual, bool) and isinstance(expected, bool) and actual is expected
    return actual == expected


def _filter_matches(filters, event):
    for key, expected in filters.items():
        actual = event.get(key, MISSING)
        if isinstance(expected, dict):
            if not any(_equal(actual, candidate) for candidate in expected['in']):
                return False
        elif not _equal(actual, expected):
            return False
    return True


def matches(db, workspace_id, event):
    """Return enabled subscriptions whose kinds and filters all match ``event``.

    Equality is JSON-scalar equality; an ``{"in": [...]}`` filter accepts any listed
    value. Missing event fields never match. Results are capped at 1000 rows.
    """
    if not isinstance(event, dict):
        raise ValueError('Event must be an object')
    event_kind = _validate_kind(event.get('kind'))
    rows = db.execute(
        'SELECT * FROM event_subscriptions WHERE workspace_id=? AND enabled=1 '
        'ORDER BY created,id LIMIT ?', (workspace_id, MAX_MATCHED)).fetchall()
    matched = []
    for row in rows:
        kinds = json.loads(row['kinds'])
        filters = json.loads(row['filters'])
        if event_kind in kinds and _filter_matches(filters, event):
            matched.append(view(row))
    return matched


def record_delivery(db, workspace_id, subscription_id, event_kind, event_key, now, ok=True):
    """Record one attempt idempotently by workspace+subscription+event_key.

    Returns True only for the first record; duplicate keys do not change the stored
    status or the subscription's last_delivery. ``ok=False`` stores ``failed``.
    """
    event_kind = _validate_kind(event_kind)
    event_key = _validate_event_key(event_key)
    now = _timestamp(now)
    if type(ok) is not bool:
        raise ValueError('ok must be a boolean')
    _require_row(db, workspace_id, subscription_id)
    status = 'delivered' if ok else 'failed'
    inserted = db.execute(
        'INSERT OR IGNORE INTO event_delivery_records '
        '(id,workspace_id,subscription_id,event_kind,event_key,status,created) '
        'VALUES(?,?,?,?,?,?,?)',
        (uuid4().hex, workspace_id, subscription_id, event_kind, event_key, status, now)
    ).rowcount > 0
    if inserted:
        db.execute(
            'UPDATE event_subscriptions SET last_delivery=? WHERE workspace_id=? AND id=?',
            (now, workspace_id, subscription_id))
    return inserted


def _stats(db, workspace_id, subscription_id):
    row = db.execute(
        "SELECT COUNT(*) AS total, "
        "COALESCE(SUM(CASE WHEN status='delivered' THEN 1 ELSE 0 END),0) AS delivered, "
        "COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END),0) AS failed "
        'FROM event_delivery_records WHERE workspace_id=? AND subscription_id=?',
        (workspace_id, subscription_id)).fetchone()
    return {'subscription_id': subscription_id, 'delivered': row['delivered'],
            'failed': row['failed'], 'total': row['total']}


def delivery_stats(db, workspace_id, subscription_id=None):
    """Return one subscription's counters, or a list for every subscription in a workspace."""
    if subscription_id is not None:
        _require_row(db, workspace_id, subscription_id)
        return _stats(db, workspace_id, subscription_id)
    rows = db.execute(
        'SELECT id FROM event_subscriptions WHERE workspace_id=? ORDER BY created,id LIMIT ?',
        (workspace_id, MAX_LIST)).fetchall()
    return [_stats(db, workspace_id, row['id']) for row in rows]
