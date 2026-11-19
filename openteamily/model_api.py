"""Per-account and per-workspace model API configuration.

OpenTeamily does not implement Teamily account credits, billing or usage limits.
A self-host operator configures a platform default model API; accounts and
workspaces may optionally override it. Resolution is override-if-set, else the
platform default.
The key is stored only as a wrapped blob in the private data directory, never
returned by the API. Runtime hooks receive it in-process. The compose manager
writes the already-resolved key to a private 0600 file and bind-mounts it into
the container at start; the key is not placed in claim or observe JSON.

Self-written; no upstream or Teamily source. Provider names and URL rules are
OpenTeamily defaults and are not Teamily parity.
"""
import hmac
import hashlib
import ipaddress
import os
import re
import secrets
import stat
from urllib.parse import urlsplit

from .security import digest

SCHEMA = '''
CREATE TABLE IF NOT EXISTS model_api_configs (
 id TEXT PRIMARY KEY,
 scope TEXT NOT NULL CHECK(scope IN ('platform','account','workspace')),
 account_id TEXT REFERENCES users(id) ON DELETE CASCADE,
 workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
 provider TEXT NOT NULL,
 base_url TEXT NOT NULL,
 model TEXT NOT NULL,
 key_blob TEXT,
 revision INTEGER NOT NULL CHECK(revision >= 1),
 updated INTEGER NOT NULL,
 CHECK(
  (scope='platform' AND account_id IS NULL AND workspace_id IS NULL)
  OR (scope='account' AND account_id IS NOT NULL AND workspace_id IS NULL)
  OR (scope='workspace' AND workspace_id IS NOT NULL AND account_id IS NULL)
 ));
CREATE UNIQUE INDEX IF NOT EXISTS model_api_platform ON model_api_configs(scope) WHERE scope='platform';
CREATE UNIQUE INDEX IF NOT EXISTS model_api_account ON model_api_configs(account_id) WHERE scope='account';
CREATE UNIQUE INDEX IF NOT EXISTS model_api_workspace ON model_api_configs(workspace_id) WHERE scope='workspace';
'''

PROVIDERS = ('openai', 'azure', 'anthropic', 'custom')
MODEL = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}')
WRAP_NAME = 'model-api.wrap'
EMPTY = {'provider': None, 'base_url': None, 'model': None, 'api_key_set': False, 'revision': 0, 'scope': None}


def wrapping_key(store, name=WRAP_NAME):
    """Load or create a 32-byte wrapping key in the private data directory."""
    directory = store.path.parent
    path = directory / name
    flags = os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW
    fd = os.open(path, flags, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError('Model API wrapping key must be a private regular file')
        key = os.read(fd, 64)
        if len(key) == 0:
            key = secrets.token_bytes(32)
            os.write(fd, key)
        elif len(key) != 32:
            raise ValueError('Model API wrapping key is the wrong size')
        return key
    finally:
        os.close(fd)


def _keystream(key, nonce, length):
    out = bytearray()
    counter = 0
    while len(out) < length:
        out.extend(hmac.new(key, nonce + counter.to_bytes(8, 'big'), hashlib.sha256).digest())
        counter += 1
    return bytes(out[:length])


def wrap(key, plaintext):
    data = plaintext.encode('utf-8')
    nonce = secrets.token_bytes(16)
    cipher = bytes(a ^ b for a, b in zip(data, _keystream(key, nonce, len(data))))
    tag = hmac.new(key, nonce + cipher, hashlib.sha256).digest()
    return (nonce + cipher + tag).hex()


def unwrap(key, blob):
    try:
        raw = bytes.fromhex(blob)
    except (ValueError, TypeError):
        raise ValueError('corrupt model API key') from None
    if len(raw) < 48:
        raise ValueError('corrupt model API key')
    nonce, cipher, tag = raw[:16], raw[16:-32], raw[-32:]
    expected = hmac.new(key, nonce + cipher, hashlib.sha256).digest()
    if not hmac.compare_digest(expected, tag):
        raise ValueError('corrupt model API key')
    return bytes(a ^ b for a, b in zip(cipher, _keystream(key, nonce, len(cipher)))).decode('utf-8')


def valid_provider(value):
    return isinstance(value, str) and value in PROVIDERS


def valid_model(value):
    return isinstance(value, str) and MODEL.fullmatch(value) is not None


def insecure_http_allowed(hostname):
    """Loopback or private-address HTTP hosts. Public hostnames are rejected."""
    if not hostname:
        return False
    if hostname in ('127.0.0.1', 'localhost', '::1'):
        return True
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        return False
    return bool(address.is_private and not address.is_unspecified)


def valid_base_url(value):
    if not isinstance(value, str) or not 8 <= len(value) <= 512 or any(ord(c) < 32 for c in value):
        return False
    try:
        parts = urlsplit(value, allow_fragments=False)
    except ValueError:
        return False
    if parts.scheme not in ('https', 'http') or parts.username is not None or parts.password is not None:
        return False
    if not parts.hostname or parts.query or parts.fragment:
        return False
    if parts.scheme == 'http' and not insecure_http_allowed(parts.hostname):
        return False
    return True


def valid_api_key(value):
    return isinstance(value, str) and 8 <= len(value) <= 4096 and '\0' not in value and not any(ord(c) < 32 and c != '\t' for c in value)


def public_view(row, scope=None):
    if row is None:
        empty = dict(EMPTY)
        empty['scope'] = scope
        return empty
    return {
        'scope': row['scope'],
        'provider': row['provider'],
        'base_url': row['base_url'],
        'model': row['model'],
        'api_key_set': bool(row['key_blob']),
        'revision': row['revision'],
    }


def load_account(db, user_id):
    return db.execute(
        "SELECT * FROM model_api_configs WHERE scope='account' AND account_id=?", (user_id,)
    ).fetchone()


def load_workspace(db, workspace_id):
    return db.execute(
        "SELECT * FROM model_api_configs WHERE scope='workspace' AND workspace_id=?", (workspace_id,)
    ).fetchone()


def load_platform(db):
    return db.execute("SELECT * FROM model_api_configs WHERE scope='platform'").fetchone()


def secret(store, row):
    if row is None or not row['key_blob']:
        return None
    return unwrap(wrapping_key(store), row['key_blob'])


def resolve(db, store, workspace_id=None, user_id=None):
    """Override if set, otherwise the platform default. No credits or usage limits.

    Workspace-scoped work (instances, automations) uses a workspace override if it
    has a key, otherwise the platform default. A user's personal settings resolve
    an account override if set, otherwise the platform default.
    """
    if workspace_id:
        row = load_workspace(db, workspace_id)
        if row is not None and row['key_blob']:
            return public_view(row), secret(store, row), 'workspace'
    if user_id:
        row = load_account(db, user_id)
        if row is not None and row['key_blob']:
            return public_view(row), secret(store, row), 'account'
    row = load_platform(db)
    if row is not None and row['key_blob']:
        return public_view(row), secret(store, row), 'platform'
    return public_view(None, 'platform'), None, None


def effective_view(public, source):
    visible = {key: public[key] for key in ('provider', 'base_url', 'model', 'api_key_set', 'scope')}
    visible['source'] = source or 'none'
    return visible


# Container secret file (runtime/flybot-image): user override wins; map
# account/workspace scopes to source=user. The compose executor writes this
# file and bind-mounts it; the key never belongs in a compose manifest or log.
CONTAINER_SOURCE = {'platform': 'platform', 'account': 'user', 'workspace': 'user'}


def container_payload(public, key, source):
    """Return the JSON object the FlyBot image launcher expects, or None."""
    if not key or not public or not public.get('provider') or not public.get('base_url') or not public.get('model'):
        return None
    mapped = CONTAINER_SOURCE.get(source)
    if mapped is None:
        return None
    return {
        'provider': public['provider'],
        'base_url': public['base_url'],
        'model': public['model'],
        'api_key': key,
        'source': mapped,
    }


def fingerprint(value):
    return digest(value) if value else None
