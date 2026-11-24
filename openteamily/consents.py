"""Versioned user consent records for terms, privacy, marketing and recording.

This module stores consent document versions and per-user grant/withdraw
evidence hashes. It is a small persistence ledger, not legal advice, a legal
review, a compliance certification, or a guarantee that a deployment's notice,
retention or jurisdiction rules are satisfied. Callers remain responsible for
presenting the actual documents, deriving the user identity from the session,
and deciding which kinds are required. Evidence is hashed; raw IP addresses,
user-agent strings and other submitted evidence are never stored here.
"""
import hashlib
import json
import re
from uuid import uuid4

KINDS = ('terms', 'privacy', 'marketing', 'recording')
STATUSES = ('granted', 'withdrawn')
VERSION = re.compile(r'[A-Za-z0-9][A-Za-z0-9._+-]{0,63}')
METHOD = re.compile(r'[a-z][a-z0-9_.-]{0,31}')
MAX_EVIDENCE_BYTES = 8192
MAX_USER_ID = 128

SCHEMA = '''
CREATE TABLE IF NOT EXISTS consent_documents (
 kind TEXT NOT NULL CHECK(kind IN ('terms','privacy','marketing','recording')),
 version TEXT NOT NULL,
 effective INTEGER NOT NULL,
 created INTEGER NOT NULL,
 PRIMARY KEY(kind, version));
CREATE INDEX IF NOT EXISTS consent_documents_current
 ON consent_documents(kind, effective, created);
CREATE TABLE IF NOT EXISTS user_consents (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('terms','privacy','marketing','recording')),
 version TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('granted','withdrawn')),
 method TEXT NOT NULL,
 evidence_hash TEXT,
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL,
 UNIQUE(user_id, kind, version));
CREATE INDEX IF NOT EXISTS user_consents_history
 ON user_consents(user_id, kind, updated, created);
CREATE INDEX IF NOT EXISTS user_consents_kind
 ON user_consents(kind, user_id, updated);
'''


def ensure_schema(db):
    db.executescript(SCHEMA)


def _kind(kind):
    if kind not in KINDS:
        raise ValueError('Unknown consent kind')
    return kind


def _version(version):
    if not isinstance(version, str) or not VERSION.fullmatch(version):
        raise ValueError('Invalid consent document version')
    return version


def _user(user_id):
    if not isinstance(user_id, str) or not 1 <= len(user_id) <= MAX_USER_ID:
        raise ValueError('Invalid consent user')
    return user_id


def _time(value, name):
    if type(value) is not int or value < 0:
        raise ValueError('Invalid consent ' + name)
    return value


def _method(method):
    if not isinstance(method, str):
        raise ValueError('Invalid consent method')
    method = method.strip().lower()
    if not METHOD.fullmatch(method):
        raise ValueError('Invalid consent method')
    return method


def _evidence_hash(evidence):
    if evidence is None:
        return None
    try:
        document = json.dumps(evidence, sort_keys=True, separators=(',', ':'),
                              ensure_ascii=False, allow_nan=False)
        raw = document.encode('utf-8')
    except (TypeError, ValueError, UnicodeError):
        raise ValueError('Invalid consent evidence') from None
    if len(raw) > MAX_EVIDENCE_BYTES:
        raise ValueError('Consent evidence is too large')
    return hashlib.sha256(raw).hexdigest()


def _document_view(row):
    if row is None:
        return None
    return {'kind': row['kind'], 'version': row['version'],
            'effective': row['effective'], 'created': row['created']}


def _record_view(row):
    if row is None:
        return None
    return {'id': row['id'], 'user_id': row['user_id'], 'kind': row['kind'],
            'version': row['version'], 'status': row['status'],
            'method': row['method'], 'evidence_hash': row['evidence_hash'],
            'created': row['created'], 'updated': row['updated']}


def _find_document(db, kind, version=None):
    if version is None:
        return db.execute(
            'SELECT * FROM consent_documents WHERE kind=? '
            'ORDER BY effective DESC, created DESC, rowid DESC LIMIT 1', (kind,)).fetchone()
    return db.execute('SELECT * FROM consent_documents WHERE kind=? AND version=?',
                      (kind, version)).fetchone()


def register_document(db, kind, version, effective, now):
    """Register an immutable document version. Re-registering the same effective time is idempotent."""
    kind = _kind(kind)
    version = _version(version)
    effective = _time(effective, 'effective time')
    now = _time(now, 'time')
    row = _find_document(db, kind, version)
    if row is not None:
        if row['effective'] != effective:
            raise ValueError('Consent document version already has a different effective time')
        return _document_view(row)
    db.execute('INSERT INTO consent_documents(kind,version,effective,created) VALUES(?,?,?,?)',
               (kind, version, effective, now))
    return _document_view(_find_document(db, kind, version))


def current_document(db, kind, now):
    """The newest registered version effective at ``now``; None when nothing is effective yet."""
    kind = _kind(kind)
    now = _time(now, 'time')
    row = db.execute(
        'SELECT * FROM consent_documents WHERE kind=? AND effective<=? '
        'ORDER BY effective DESC, created DESC, rowid DESC LIMIT 1', (kind, now)).fetchone()
    return _document_view(row)


def grant(db, user_id, kind, version, now, method='web', evidence=None):
    """Record a grant for an existing document version, replacing a prior record for the same version."""
    user_id = _user(user_id)
    kind = _kind(kind)
    version = _version(version)
    now = _time(now, 'time')
    method = _method(method)
    evidence_hash = _evidence_hash(evidence)
    if _find_document(db, kind, version) is None:
        raise ValueError('Consent document version is not registered')
    db.execute(
        'INSERT INTO user_consents(id,user_id,kind,version,status,method,evidence_hash,created,updated) '
        "VALUES(?,?,?,?,'granted',?,?,?,?) "
        'ON CONFLICT(user_id,kind,version) DO UPDATE SET '
        "status='granted', method=excluded.method, evidence_hash=excluded.evidence_hash, "
        'updated=excluded.updated',
        (uuid4().hex, user_id, kind, version, method, evidence_hash, now, now))
    row = db.execute('SELECT * FROM user_consents WHERE user_id=? AND kind=? AND version=?',
                     (user_id, kind, version)).fetchone()
    return _record_view(row)


def withdraw(db, user_id, kind, version, now):
    """Mark an existing consent record withdrawn. A missing record is an error."""
    user_id = _user(user_id)
    kind = _kind(kind)
    version = _version(version)
    now = _time(now, 'time')
    cursor = db.execute(
        "UPDATE user_consents SET status='withdrawn', updated=? "
        'WHERE user_id=? AND kind=? AND version=?', (now, user_id, kind, version))
    if cursor.rowcount == 0:
        raise ValueError('Consent record not found')
    row = db.execute('SELECT * FROM user_consents WHERE user_id=? AND kind=? AND version=?',
                     (user_id, kind, version)).fetchone()
    return _record_view(row)


def current_status(db, user_id, kind, now=None):
    """Latest record for a kind plus the required version and whether that version is granted.

    Without ``now`` the newest registered document is used. Passing ``now`` applies
    the document effective time.
    """
    user_id = _user(user_id)
    kind = _kind(kind)
    if now is None:
        document = _find_document(db, kind)
    else:
        now = _time(now, 'time')
        document = current_document(db, kind, now)
    required_version = document['version'] if document is not None else None
    row = db.execute(
        'SELECT * FROM user_consents WHERE user_id=? AND kind=? '
        'ORDER BY updated DESC, created DESC, rowid DESC LIMIT 1', (user_id, kind)).fetchone()
    record = _record_view(row)
    granted = bool(record is not None and record['status'] == 'granted'
                   and required_version == record['version'])
    return {'record': record, 'required_version': required_version, 'granted': granted}


def list_history(db, user_id, kind=None):
    """Consent records for one user, newest update first; optional kind filter."""
    user_id = _user(user_id)
    if kind is None:
        rows = db.execute(
            'SELECT * FROM user_consents WHERE user_id=? '
            'ORDER BY updated DESC, created DESC, rowid DESC', (user_id,)).fetchall()
    else:
        kind = _kind(kind)
        rows = db.execute(
            'SELECT * FROM user_consents WHERE user_id=? AND kind=? '
            'ORDER BY updated DESC, created DESC, rowid DESC', (user_id, kind)).fetchall()
    return [_record_view(row) for row in rows]


def require_all(db, user_id, kinds, now):
    """Return the kinds that are not granted at their currently effective version."""
    user_id = _user(user_id)
    now = _time(now, 'time')
    if isinstance(kinds, str):
        raise ValueError('Consent kinds must be an iterable of kind names')
    try:
        kinds = list(kinds)
    except TypeError:
        raise ValueError('Consent kinds must be an iterable of kind names') from None
    for kind in kinds:
        _kind(kind)
    missing = []
    seen = set()
    for kind in kinds:
        if kind in seen:
            continue
        seen.add(kind)
        document = current_document(db, kind, now)
        if document is None:
            missing.append(kind)
            continue
        row = db.execute(
            "SELECT 1 FROM user_consents WHERE user_id=? AND kind=? AND version=? AND status='granted'",
            (user_id, kind, document['version'])).fetchone()
        if row is None:
            missing.append(kind)
    return missing
