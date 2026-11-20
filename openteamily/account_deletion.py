"""Self-service account deletion over the existing schema; no new tables.

Deleting an account must not silently destroy work other people still use, so the
purge is data-driven instead of a hand-written table list:

* the session rows are removed first, so the browser is signed out even if the
  rest is refused;
* every nullable foreign key that points at ``users`` is cleared, which keeps
  shared rows (invite decisions, suspensions) readable without naming a person;
* every remaining non-null, non-cascading reference is reported as a blocker and
  the whole operation is refused, because dropping those rows would delete
  content that belongs to a workspace rather than to one person;
* only when nothing blocks is the user row deleted, which cascades into the
  per-user tables (settings, profile, onboarding, notifications, keys...).
"""
import sqlite3

BLOCKED_TABLES = ('users', 'sessions')


def _tables(db):
    return [row[0] for row in db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]


def _user_columns(db, table):
    """(column -> notnull) for every foreign key of ``table`` that points at users."""
    columns = {row['name']: row['notnull'] for row in db.execute(f'PRAGMA table_info("{table}")')}
    found = {}
    for row in db.execute(f'PRAGMA foreign_key_list("{table}")').fetchall():
        if row['table'] == 'users':
            found[row['from']] = {'notnull': bool(columns[row['from']]), 'on_delete': (row['on_delete'] or '').upper()}
    return found


def blockers(db, user_id):
    """Shared rows that a hard delete would orphan; reported, never deleted."""
    found = []
    for table in _tables(db):
        if table in BLOCKED_TABLES:
            continue
        for column, spec in _user_columns(db, table).items():
            if spec['on_delete'] == 'CASCADE' or not spec['notnull']:
                continue
            if db.execute(f'SELECT 1 FROM "{table}" WHERE "{column}"=? LIMIT 1', (user_id,)).fetchone():
                found.append({'table': table, 'column': column})
    return found


def delete(db, user_id):
    """Sign the account out, anonymize what can stay, drop it; refuse when blocked."""
    db.execute('DELETE FROM sessions WHERE user_id=?', (user_id,))
    for table in _tables(db):
        if table in BLOCKED_TABLES:
            continue
        for column, spec in _user_columns(db, table).items():
            if spec['on_delete'] == 'CASCADE' or spec['notnull']:
                continue
            db.execute(f'UPDATE "{table}" SET "{column}"=NULL WHERE "{column}"=?', (user_id,))
    found = blockers(db, user_id)
    if found:
        return found
    db.execute('DELETE FROM users WHERE id=?', (user_id,))
    return []
