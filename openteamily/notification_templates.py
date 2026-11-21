"""Localized notification template storage and safe rendering.

This module is deliberately only a catalog and renderer: it stores versioned
subject/body text per notification kind and locale, checks required variables,
substitutes ``{name}`` placeholders, and can fall back to another locale. It
does not send notifications, schedule work, translate text, or interpret HTML.
Rendering is plain text; markup in templates or values is returned verbatim.
"""
import json
import re
from collections.abc import Mapping
from uuid import uuid4

SCHEMA = '''
CREATE TABLE IF NOT EXISTS notification_templates (
 id TEXT PRIMARY KEY,
 kind TEXT NOT NULL,
 locale TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(version >= 1),
 subject TEXT NOT NULL,
 body TEXT NOT NULL,
 variables TEXT NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
 created INTEGER NOT NULL,
 UNIQUE(kind, locale, version));
CREATE INDEX IF NOT EXISTS notification_template_lookup
 ON notification_templates(kind, locale, enabled, version);
CREATE INDEX IF NOT EXISTS notification_template_catalog
 ON notification_templates(kind, locale, version);
'''

MAX_SUBJECT = 500
MAX_BODY = 10000
MAX_VARIABLES = 32
MAX_VARIABLE_NAME = 64
MAX_VALUE = 4000
MAX_VERSION = 1000000
MAX_KIND = 64
MAX_LOCALE = 35

KIND = re.compile(r'[a-z][a-z0-9_.-]{0,%d}\Z' % (MAX_KIND - 1))
LOCALE = re.compile(r'[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*\Z')
VARIABLE = re.compile(r'[A-Za-z_][A-Za-z0-9_]{0,%d}\Z' % (MAX_VARIABLE_NAME - 1))
PLACEHOLDER = re.compile(r'\{([A-Za-z_][A-Za-z0-9_]*)\}')


def ensure_schema(db):
    """Create the template table and indexes; safe to call repeatedly."""
    for statement in SCHEMA.split(';'):
        statement = statement.strip()
        if statement:
            db.execute(statement)


def _check_kind(kind):
    if type(kind) is not str or not KIND.fullmatch(kind):
        raise ValueError('Invalid notification template kind')
    return kind


def _check_locale(locale):
    if (type(locale) is not str or len(locale) > MAX_LOCALE
            or not LOCALE.fullmatch(locale)):
        raise ValueError('Invalid notification template locale')
    return locale


def _check_version(version):
    if type(version) is not int or not 1 <= version <= MAX_VERSION:
        raise ValueError('Invalid notification template version')
    return version


def _check_text(name, value, limit):
    if type(value) is not str:
        raise ValueError('Template %s must be text' % name)
    if len(value) > limit:
        raise ValueError('Template %s is too large' % name)
    return value


def _check_enabled(enabled):
    if type(enabled) is not bool:
        raise ValueError('Template enabled must be a boolean')
    return enabled


def _placeholders(subject, body):
    """Return placeholder names in first-seen order and reject other braces."""
    found = []
    for text in (subject, body):
        remainder = PLACEHOLDER.sub('', text)
        if '{' in remainder or '}' in remainder:
            raise ValueError('Malformed template placeholder')
        for match in PLACEHOLDER.finditer(text):
            name = match.group(1)
            if name not in found:
                found.append(name)
    return found


def _normalize_variables(variables):
    """Validate and de-duplicate a required-variable list without reordering it."""
    if variables is None:
        return None
    if isinstance(variables, Mapping):
        names = list(variables)
    elif isinstance(variables, (str, bytes)) or not isinstance(variables, (list, tuple, set, frozenset)):
        raise ValueError('Template variables must be a sequence of names')
    else:
        names = list(variables)
    if len(names) > MAX_VARIABLES:
        raise ValueError('Too many template variables')
    result = []
    for name in names:
        if type(name) is not str or not VARIABLE.fullmatch(name):
            raise ValueError('Invalid template variable name')
        if name not in result:
            result.append(name)
    return result


def _encode_variables(variables):
    return json.dumps(variables, ensure_ascii=False, separators=(',', ':'))


def _decode_variables(raw):
    try:
        variables = json.loads(raw)
    except (TypeError, ValueError):
        return []
    return variables if isinstance(variables, list) else []


def _view(row):
    if row is None:
        return None
    return {
        'id': row['id'],
        'kind': row['kind'],
        'locale': row['locale'],
        'version': row['version'],
        'subject': row['subject'],
        'body': row['body'],
        'variables': _decode_variables(row['variables']),
        'enabled': row['enabled'] == 1,
        'created': row['created'],
    }


def register_template(db, kind, locale, version, subject, body, now,
                      variables=None, enabled=True):
    """Store one immutable template version.

    Re-registering exactly the same kind, locale, version and content is
    idempotent and returns the stored row. Changing any of that content raises
    ``ValueError``; use a new version instead. When ``variables`` is omitted it
    is inferred from the placeholders. Every placeholder must be declared.
    """
    kind = _check_kind(kind)
    locale = _check_locale(locale)
    version = _check_version(version)
    subject = _check_text('subject', subject, MAX_SUBJECT)
    body = _check_text('body', body, MAX_BODY)
    enabled = _check_enabled(enabled)
    placeholders = _placeholders(subject, body)
    declared = _normalize_variables(variables)
    if declared is None:
        declared = placeholders
    else:
        undeclared = [name for name in placeholders if name not in declared]
        if undeclared:
            raise ValueError('Placeholder not declared as a variable: %s' % undeclared[0])
    if len(declared) > MAX_VARIABLES:
        raise ValueError('Too many template variables')
    encoded = _encode_variables(declared)
    row = db.execute(
        'SELECT * FROM notification_templates WHERE kind=? AND locale=? AND version=?',
        (kind, locale, version)).fetchone()
    if row is not None:
        identical = (row['subject'] == subject and row['body'] == body
                     and _decode_variables(row['variables']) == declared
                     and row['enabled'] == (1 if enabled else 0))
        if identical:
            return _view(row)
        raise ValueError('Notification template version is immutable')
    template_id = uuid4().hex
    db.execute(
        'INSERT INTO notification_templates '
        '(id,kind,locale,version,subject,body,variables,enabled,created) '
        'VALUES(?,?,?,?,?,?,?,?,?)',
        (template_id, kind, locale, version, subject, body, encoded,
         1 if enabled else 0, now))
    return _view(db.execute(
        'SELECT * FROM notification_templates WHERE id=?', (template_id,)).fetchone())


def get_template(db, kind, locale, version=None):
    """Fetch one version, or the latest enabled version when version is omitted."""
    kind = _check_kind(kind)
    locale = _check_locale(locale)
    if version is None:
        row = db.execute(
            'SELECT * FROM notification_templates WHERE kind=? AND locale=? AND enabled=1 '
            'ORDER BY version DESC LIMIT 1', (kind, locale)).fetchone()
    else:
        version = _check_version(version)
        row = db.execute(
            'SELECT * FROM notification_templates WHERE kind=? AND locale=? AND version=?',
            (kind, locale, version)).fetchone()
    return _view(row)


def list_templates(db, kind=None, locale=None):
    """List catalog rows, optionally filtered; disabled rows remain visible."""
    clauses, args = [], []
    if kind is not None:
        clauses.append('kind=?')
        args.append(_check_kind(kind))
    if locale is not None:
        clauses.append('locale=?')
        args.append(_check_locale(locale))
    where = ' WHERE ' + ' AND '.join(clauses) if clauses else ''
    rows = db.execute(
        'SELECT * FROM notification_templates' + where
        + ' ORDER BY kind, locale, version DESC, id', tuple(args)).fetchall()
    return [_view(row) for row in rows]


def disable_template(db, kind, locale, version=None):
    """Disable one version, or the latest enabled version; return whether it changed."""
    kind = _check_kind(kind)
    locale = _check_locale(locale)
    if version is None:
        row = db.execute(
            'SELECT version FROM notification_templates WHERE kind=? AND locale=? AND enabled=1 '
            'ORDER BY version DESC LIMIT 1', (kind, locale)).fetchone()
        if row is None:
            return False
        version = row['version']
    else:
        version = _check_version(version)
    cursor = db.execute(
        'UPDATE notification_templates SET enabled=0 '
        'WHERE kind=? AND locale=? AND version=? AND enabled=1',
        (kind, locale, version))
    return cursor.rowcount > 0


def _coerce_value(value):
    if value is None:
        return None
    if type(value) is str:
        text = value
    elif type(value) in (int, float, bool):
        text = str(value)
    else:
        raise ValueError('Template values must be text or scalar numbers')
    if len(text) > MAX_VALUE:
        raise ValueError('Template value is too large')
    return text


def render(db, kind, locale, values, fallback_locale='en'):
    """Render the latest enabled template into plain text.

    Missing required variables are returned in ``missing`` and their
    placeholders are left untouched. If the requested locale has no enabled
    template, ``fallback_locale`` is tried; ``locale`` in the result is the one
    actually used. Raises ``LookupError`` when neither locale has a template.
    """
    kind = _check_kind(kind)
    locale = _check_locale(locale)
    fallback = None if fallback_locale is None else _check_locale(fallback_locale)
    if not isinstance(values, Mapping):
        raise ValueError('Template values must be a mapping')
    if len(values) > MAX_VARIABLES * 4:
        raise ValueError('Too many template values')
    supplied = {}
    for name, value in values.items():
        if type(name) is not str:
            raise ValueError('Template value names must be text')
        text = _coerce_value(value)
        if text is not None:
            supplied[name] = text
    row = db.execute(
        'SELECT * FROM notification_templates WHERE kind=? AND locale=? AND enabled=1 '
        'ORDER BY version DESC LIMIT 1', (kind, locale)).fetchone()
    used_locale = locale
    if row is None and fallback is not None and fallback != locale:
        used_locale = fallback
        row = db.execute(
            'SELECT * FROM notification_templates WHERE kind=? AND locale=? AND enabled=1 '
            'ORDER BY version DESC LIMIT 1', (kind, fallback)).fetchone()
    if row is None:
        raise LookupError('No enabled notification template for %s/%s' % (kind, locale))
    template = _view(row)
    missing = [name for name in template['variables'] if name not in supplied]

    def substitute(match):
        name = match.group(1)
        return supplied.get(name, match.group(0))

    return {
        'subject': PLACEHOLDER.sub(substitute, template['subject']),
        'body': PLACEHOLDER.sub(substitute, template['body']),
        'locale': used_locale,
        'missing': missing,
    }
