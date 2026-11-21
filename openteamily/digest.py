"""Per-user digest preferences, due selection, local assembly and run receipts.

This module decides *what* to summarize and *when* a digest is due, then stores
the assembled plain-text summary so the same period is not recorded twice.
Callers supply the candidate items and a collector callback; this module never
reads notifications, proactive results, automations or works itself. It does not
send email, chat, webhook or any other message: ``channel`` is a stored label
only. It does not call a model, rank by relevance, or invent prose. This is a
local summary/cadence helper, not Teamily digest or notification parity.
"""
from datetime import datetime, timezone
from uuid import uuid4

CADENCES = ('daily', 'weekly', 'off')
DEFAULT_CHANNEL = 'digest'

MAX_ITEMS = 50
MAX_TITLE = 200
MAX_ITEM_BODY = 500
MAX_ITEM_HREF = 500
MAX_BODY = 10000
MAX_CHANNEL = 64
MAX_KIND = 64
MAX_PERIOD_KEY = 32
MAX_ITEM_COUNT = 10000

MAX_INPUT_ITEMS = 500
MAX_TITLE_INPUT = 1000
MAX_ITEM_BODY_INPUT = 10000
MAX_HREF_INPUT = 2000

SCHEMA = '''
CREATE TABLE IF NOT EXISTS digest_prefs (
 workspace_id TEXT NOT NULL,
 user_id TEXT NOT NULL,
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 cadence TEXT NOT NULL CHECK(cadence IN ('daily','weekly','off')),
 hour_utc INTEGER NOT NULL CHECK(hour_utc BETWEEN 0 AND 23),
 channel TEXT NOT NULL,
 updated INTEGER NOT NULL,
 PRIMARY KEY(workspace_id,user_id));
CREATE INDEX IF NOT EXISTS digest_pref_due
 ON digest_prefs(enabled, cadence, hour_utc, workspace_id, user_id);
CREATE TABLE IF NOT EXISTS digest_runs (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL,
 user_id TEXT NOT NULL,
 period_key TEXT NOT NULL,
 item_count INTEGER NOT NULL CHECK(item_count >= 0),
 body TEXT NOT NULL,
 created INTEGER NOT NULL,
 UNIQUE(workspace_id,user_id,period_key));
CREATE INDEX IF NOT EXISTS digest_run_lookup
 ON digest_runs(workspace_id, user_id, period_key);
'''


def ensure_schema(db):
    """Create the two digest tables and indexes if they are not present yet."""
    for statement in SCHEMA.split(';'):
        if statement.strip():
            db.execute(statement)


def _moment(value):
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError('now must be epoch seconds or a datetime')
    return datetime.fromtimestamp(int(value), timezone.utc)


def _timestamp(value):
    if isinstance(value, datetime):
        return int(_moment(value).timestamp())
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError('now must be epoch seconds or a datetime')
    return int(value)


def _clean(value, label, limit, required=True, single_line=False):
    if not isinstance(value, str):
        raise ValueError(f'{label} must be text')
    if len(value) > limit:
        raise ValueError(f'{label} exceeds {limit} characters')
    try:
        value.encode('utf-8')
    except UnicodeError as error:
        raise ValueError(f'{label} is not valid Unicode') from error
    if '\x00' in value:
        raise ValueError(f'{label} contains a NUL character')
    if single_line:
        value = ' '.join(value.split())
    else:
        value = value.replace('\r\n', '\n').replace('\r', '\n')
    value = ''.join(
        ch if ch in '\n\t' or (32 <= ord(ch) and not 127 <= ord(ch) <= 159) else ' '
        for ch in value
    ).strip()
    if required and not value:
        raise ValueError(f'{label} must not be empty')
    return value


def _truncate(value, limit):
    if len(value) <= limit:
        return value
    return value[:max(0, limit - 1)] + '…'


def _render(value):
    # The body is plain text, never markup. Angle brackets are replaced so a
    # caller-supplied title or body cannot be mistaken for an HTML fragment.
    return value.replace('<', '‹').replace('>', '›')


def _valid_hour(hour):
    return isinstance(hour, int) and not isinstance(hour, bool) and 0 <= hour <= 23


def _valid_enabled(enabled):
    return isinstance(enabled, (bool, int)) and not isinstance(enabled, str) and enabled in (0, 1)


def period_key(cadence, now):
    """Return the UTC period key: daily ``YYYY-MM-DD`` or weekly ``YYYY-Www``."""
    if cadence not in ('daily', 'weekly'):
        raise ValueError('cadence must be daily or weekly for a period key')
    moment = _moment(now)
    if cadence == 'weekly':
        iso = moment.isocalendar()
        return f'{iso.year:04d}-W{iso.week:02d}'
    return f'{moment.year:04d}-{moment.month:02d}-{moment.day:02d}'


def _pref_view(row):
    return {
        'workspace_id': row['workspace_id'],
        'user_id': row['user_id'],
        'enabled': row['enabled'] == 1,
        'cadence': row['cadence'],
        'hour_utc': row['hour_utc'],
        'channel': row['channel'],
        'updated': row['updated'],
    }


def _run_view(row):
    return {
        'id': row['id'],
        'workspace_id': row['workspace_id'],
        'user_id': row['user_id'],
        'period_key': row['period_key'],
        'item_count': row['item_count'],
        'body': row['body'],
        'created': row['created'],
    }


def get_pref(db, workspace_id, user_id):
    row = db.execute(
        'SELECT * FROM digest_prefs WHERE workspace_id=? AND user_id=?',
        (workspace_id, user_id),
    ).fetchone()
    return _pref_view(row) if row is not None else None


def set_pref(db, workspace_id, user_id, cadence, hour_utc, channel=DEFAULT_CHANNEL,
             enabled=True, now=None):
    """Create or replace one user's digest preference in one workspace."""
    if cadence not in CADENCES:
        raise ValueError('cadence must be daily, weekly or off')
    if not _valid_hour(hour_utc):
        raise ValueError('hour_utc must be an integer from 0 to 23')
    channel = _clean(channel, 'channel', MAX_CHANNEL, single_line=True)
    if not _valid_enabled(enabled):
        raise ValueError('enabled must be a boolean')
    if now is None:
        raise ValueError('now is required')
    updated = _timestamp(now)
    db.execute(
        'INSERT INTO digest_prefs(workspace_id,user_id,enabled,cadence,hour_utc,channel,updated) '
        'VALUES(?,?,?,?,?,?,?) '
        'ON CONFLICT(workspace_id,user_id) DO UPDATE SET '
        'enabled=excluded.enabled, cadence=excluded.cadence, hour_utc=excluded.hour_utc, '
        'channel=excluded.channel, updated=excluded.updated',
        (workspace_id, user_id, 1 if enabled else 0, cadence, hour_utc, channel, updated),
    )
    return get_pref(db, workspace_id, user_id)


def already_recorded(db, workspace_id, user_id, period_key_value):
    if not isinstance(period_key_value, str) or not period_key_value:
        return False
    row = db.execute(
        'SELECT 1 FROM digest_runs WHERE workspace_id=? AND user_id=? AND period_key=?',
        (workspace_id, user_id, period_key_value),
    ).fetchone()
    return row is not None


def due(db, now):
    """Preferences due at or after their UTC hour with no run for this period."""
    moment = _moment(now)
    rows = db.execute(
        "SELECT * FROM digest_prefs WHERE enabled=1 AND cadence IN ('daily','weekly') "
        'ORDER BY workspace_id, user_id'
    ).fetchall()
    ready = []
    for row in rows:
        if moment.hour < row['hour_utc']:
            continue
        key = period_key(row['cadence'], moment)
        if already_recorded(db, row['workspace_id'], row['user_id'], key):
            continue
        item = _pref_view(row)
        item['period_key'] = key
        ready.append(item)
    return ready


def _created_value(value):
    if isinstance(value, datetime):
        return _timestamp(value)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    return int(value)


def _normal_item(raw):
    if not isinstance(raw, dict):
        raise ValueError('each item must be a mapping')
    kind_raw, title_raw = raw.get('kind'), raw.get('title')
    if not isinstance(kind_raw, str) or not kind_raw.strip():
        return None
    if not isinstance(title_raw, str) or not title_raw.strip():
        return None
    kind = _truncate(_clean(kind_raw, 'kind', MAX_KIND, single_line=True), MAX_KIND)
    title = _truncate(
        _clean(title_raw, 'item title', MAX_TITLE_INPUT, single_line=True), MAX_TITLE)
    body_raw = raw.get('body')
    if body_raw is None:
        body = ''
    else:
        body = _truncate(
            _clean(body_raw, 'item body', MAX_ITEM_BODY_INPUT, required=False),
            MAX_ITEM_BODY)
    href_raw = raw.get('href')
    if href_raw is None:
        href = ''
    else:
        href = _truncate(
            _clean(href_raw, 'item href', MAX_HREF_INPUT, required=False, single_line=True),
            MAX_ITEM_HREF)
    return {
        'kind': kind,
        'title': title,
        'body': body,
        'created': _created_value(raw.get('created')),
        'href': href,
        'read': bool(raw.get('read', False)),
    }


def _item_lines(item):
    prefix = '' if item['read'] else '[unread] '
    headline = f'- {prefix}{_render(item["title"])}'
    if item['created']:
        moment = _moment(item['created'])
        headline += ' — ' + moment.strftime('%Y-%m-%d %H:%M UTC')
    lines = [headline]
    if item['body']:
        lines.extend('  ' + _render(line) for line in item['body'].split('\n'))
    if item['href']:
        lines.append('  ' + _render(item['href']))
    return lines


def build(db, workspace_id, user_id, items, now):
    """Group, sort and render caller-supplied items into a bounded plain-text body."""
    if not isinstance(items, (list, tuple)):
        raise ValueError('items must be a list')
    if len(items) > MAX_INPUT_ITEMS:
        raise ValueError(f'items exceeds {MAX_INPUT_ITEMS} entries')
    pref = get_pref(db, workspace_id, user_id)
    cadence = pref['cadence'] if pref and pref['cadence'] in ('daily', 'weekly') else 'daily'
    key = period_key(cadence, now)

    groups = {}
    for raw in items:
        item = _normal_item(raw)
        if item is not None:
            groups.setdefault(item['kind'], []).append(item)

    for group in groups.values():
        group.sort(key=lambda item: (
            1 if item['read'] else 0,
            -item['created'],
            item['title'].casefold(),
            item['title'],
            item['href'],
            item['body'],
        ))

    lines = [f'Digest {key}', '']
    used = len(lines[0]) + 2
    sections = []
    total = 0
    for kind in sorted(groups, key=lambda value: (value.casefold(), value)):
        if total >= MAX_ITEMS:
            break
        rendered = []
        for item in groups[kind]:
            if total >= MAX_ITEMS:
                break
            item_lines = _item_lines(item)
            addition = sum(len(line) + 1 for line in item_lines)
            if not rendered:
                addition += len(kind) + 3
            if used + addition > MAX_BODY:
                break
            if not rendered:
                lines.append(f'[{kind}]')
                used += len(kind) + 3
            lines.extend(item_lines)
            used += sum(len(line) + 1 for line in item_lines)
            rendered.append(dict(item))
            total += 1
        if rendered:
            lines.append('')
            used += 1
            sections.append({'kind': kind, 'items': rendered})

    if total == 0:
        return {'period_key': key, 'sections': [], 'body': '', 'item_count': 0}
    body = '\n'.join(lines).strip()
    if len(body) > MAX_BODY:
        body = body[:MAX_BODY]
    return {'period_key': key, 'sections': sections, 'body': body, 'item_count': total}


def record_run(db, workspace_id, user_id, period_key_value, body, item_count, now):
    """Record one digest run, returning the existing row on a duplicate period."""
    if not isinstance(period_key_value, str) or not period_key_value.strip():
        raise ValueError('period_key must not be empty')
    key = _clean(period_key_value, 'period_key', MAX_PERIOD_KEY, single_line=True)
    body = _clean(body, 'body', MAX_BODY, required=False)
    if isinstance(item_count, bool) or not isinstance(item_count, int) or item_count < 0:
        raise ValueError('item_count must be a non-negative integer')
    if item_count > MAX_ITEM_COUNT:
        raise ValueError(f'item_count exceeds {MAX_ITEM_COUNT}')
    created = _timestamp(now)
    db.execute(
        'INSERT OR IGNORE INTO digest_runs(id,workspace_id,user_id,period_key,item_count,body,created) '
        'VALUES(?,?,?,?,?,?,?)',
        (uuid4().hex, workspace_id, user_id, key, item_count, body, created),
    )
    row = db.execute(
        'SELECT * FROM digest_runs WHERE workspace_id=? AND user_id=? AND period_key=?',
        (workspace_id, user_id, key),
    ).fetchone()
    return _run_view(row)


def run_due(db, now, collect_items, limit=50):
    """Collect, build and record due digests; empty collectors are skipped."""
    if not callable(collect_items):
        raise ValueError('collect_items must be callable')
    if isinstance(limit, bool) or not isinstance(limit, int) or limit < 0:
        raise ValueError('limit must be a non-negative integer')
    if limit == 0:
        return []
    recorded = []
    for pref in due(db, now):
        if len(recorded) >= limit:
            break
        items = collect_items(pref['workspace_id'], pref['user_id'], pref['period_key'])
        if not items:
            continue
        built = build(db, pref['workspace_id'], pref['user_id'], items, now)
        if built['item_count'] == 0:
            continue
        recorded.append(record_run(
            db, pref['workspace_id'], pref['user_id'], built['period_key'],
            built['body'], built['item_count'], now,
        ))
    return recorded
