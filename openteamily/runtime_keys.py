"""Account connection keys for a local or remote FlyBot runtime.

Self-written for OpenTeamily. The 2026-11-16 Teamily recapture saw a
connection tab with named API keys (shown once, list prefixes only,
expiry default Never), a device ID, and CLI / daemon steps. This module
implements that shape under the FlyBot brand. It is not Teamily parity,
does not ship a CLI binary, and does not accept Teamily URLs or keys.
"""
import re

from .security import digest, opaque

SCHEMA = '''
CREATE TABLE IF NOT EXISTS runtime_keys (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name TEXT NOT NULL,
 token_hash TEXT NOT NULL UNIQUE,
 prefix TEXT NOT NULL,
 created INTEGER NOT NULL,
 expires INTEGER,
 revoked INTEGER NOT NULL CHECK(revoked IN (0,1)));
CREATE INDEX IF NOT EXISTS runtime_key_user ON runtime_keys(user_id, id);
CREATE TABLE IF NOT EXISTS runtime_devices (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 device_id TEXT NOT NULL UNIQUE,
 created INTEGER NOT NULL);
'''

NAME = re.compile(r'[^\x00-\x1f\x7f]{1,80}')
MAX_KEYS = 20
# 60 seconds through 365 days. Omitted or null means the key never expires.
MIN_EXPIRES = 60
MAX_EXPIRES = 31536000
PREFIX_LEN = 8
DEVICE = re.compile(r'fbdev_[0-9a-f]{32}')


def valid_name(value):
    return isinstance(value, str) and NAME.fullmatch(value.strip()) and _unicode(value.strip())


def _unicode(value):
    try:
        value.encode('utf-8')
    except UnicodeError:
        return False
    return True


def view(row):
    return {
        'id': row['id'],
        'name': row['name'],
        'prefix': row['prefix'],
        'created': row['created'],
        'expires': row['expires'],
        'revoked': bool(row['revoked']),
    }


def device_id(db, user_id, now):
    row = db.execute(
        'SELECT device_id FROM runtime_devices WHERE user_id=?', (user_id,)
    ).fetchone()
    if row is not None:
        return row['device_id']
    from uuid import uuid4
    value = 'fbdev_' + uuid4().hex
    db.execute('INSERT INTO runtime_devices VALUES(?,?,?)', (user_id, value, now))
    return value


def listing(db, user_id):
    rows = db.execute(
        'SELECT k.* FROM runtime_keys k '
        'WHERE k.user_id=? AND k.id NOT IN (SELECT key_id FROM instance_runtime_keys) '
        'ORDER BY k.created DESC, k.id',
        (user_id,),
    ).fetchall()
    return [view(row) for row in rows]


def create(db, user_id, now, name, expires_in=None):
    active = db.execute(
        'SELECT COUNT(*) FROM runtime_keys k WHERE k.user_id=? AND k.revoked=0 '
        'AND (k.expires IS NULL OR k.expires>?) '
        'AND k.id NOT IN (SELECT key_id FROM instance_runtime_keys)',
        (user_id, now),
    ).fetchone()[0]
    if active >= MAX_KEYS:
        raise ValueError('quota')
    token = opaque()
    from uuid import uuid4
    key_id = uuid4().hex
    expires = None if expires_in is None else now + expires_in
    db.execute(
        'INSERT INTO runtime_keys VALUES(?,?,?,?,?,?,?,0)',
        (key_id, user_id, name, digest(token), token[:PREFIX_LEN], now, expires),
    )
    row = db.execute('SELECT * FROM runtime_keys WHERE id=?', (key_id,)).fetchone()
    return view(row), token


def load(db, user_id, key_id):
    return db.execute(
        'SELECT * FROM runtime_keys WHERE id=? AND user_id=?',
        (key_id, user_id),
    ).fetchone()


def revoke(db, key_id):
    db.execute('UPDATE runtime_keys SET revoked=1 WHERE id=?', (key_id,))
