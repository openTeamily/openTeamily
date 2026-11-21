"""Local threaded replies inside a workspace conversation.

Self-written for OpenTeamily; no upstream or Teamily source. This is a
persistence slice only: it stores thread containers, ordered replies, per-user
read cursors and a resolved flag in the private SQLite database. It does not
send messages, deliver notifications, render a client or integrate with the
management HTTP routes. The caller is responsible for authorizing workspace and
conversation membership before calling these functions; the functions enforce
workspace isolation on every stored row but cannot infer a caller's rights from
a workspace id alone.

Soft deletion is intentional. A deleted reply remains as a row with
``deleted=1`` for audit/history, but it is omitted from thread views, reply
counts and unread counts. ``reply_count`` therefore means visible (not deleted)
replies. Unread means visible replies by other users whose ``created`` value is
greater than the viewer's last-read timestamp. Timestamps are integer seconds
chosen by the caller, so replies written with the same second as a read cursor
are treated as read.
"""
import re
import sqlite3
import uuid

BODY_MAX = 4000
TITLE_MAX = 80
PAGE_MAX = 100
DEFAULT_LIMIT = 50

# Replies created before any read cursor are unread. Use the smallest SQLite
# integer rather than 0 so callers may use a zero/epoch clock in tests.
_UNREAD_START = -9223372036854775808

_TITLE_CONTROL = re.compile(r'[\x00-\x1f\x7f]')
_BODY_CONTROL = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]')

SCHEMA = '''
CREATE TABLE IF NOT EXISTS message_threads (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 conversation_id TEXT NOT NULL,
 root_message_id TEXT NOT NULL,
 created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 title TEXT,
 resolved INTEGER NOT NULL DEFAULT 0 CHECK(resolved IN (0,1)),
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL,
 UNIQUE(workspace_id, conversation_id, root_message_id));
CREATE INDEX IF NOT EXISTS message_thread_conversation
 ON message_threads(workspace_id, conversation_id, created, id);
CREATE INDEX IF NOT EXISTS message_thread_root
 ON message_threads(workspace_id, conversation_id, root_message_id);
CREATE INDEX IF NOT EXISTS message_thread_resolved
 ON message_threads(workspace_id, conversation_id, resolved, created, id);
CREATE TABLE IF NOT EXISTS thread_replies (
 id TEXT PRIMARY KEY,
 thread_id TEXT NOT NULL REFERENCES message_threads(id) ON DELETE CASCADE,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 body TEXT NOT NULL,
 created INTEGER NOT NULL,
 deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)));
CREATE INDEX IF NOT EXISTS thread_reply_list
 ON thread_replies(thread_id, created, id);
CREATE INDEX IF NOT EXISTS thread_reply_workspace
 ON thread_replies(workspace_id, thread_id, created, id);
CREATE TABLE IF NOT EXISTS thread_reads (
 thread_id TEXT NOT NULL REFERENCES message_threads(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 last_read INTEGER NOT NULL,
 updated INTEGER NOT NULL,
 PRIMARY KEY(thread_id, user_id));
CREATE INDEX IF NOT EXISTS thread_read_updated
 ON thread_reads(user_id, updated);
'''


class ThreadExists(ValueError, sqlite3.IntegrityError):
    """The conversation already has a thread rooted at that message."""


class ThreadNotFound(LookupError, ValueError):
    """The thread is absent from the supplied workspace."""


def ensure_schema(db):
    """Create the thread tables when needed. Safe to run repeatedly."""
    db.executescript(SCHEMA)


def _identifier(value, name):
    if (not isinstance(value, str) or not value or len(value) > 200
            or _TITLE_CONTROL.search(value)):
        raise ValueError('%s must be a non-empty, bounded string' % name)
    return value


def _timestamp(value, name='now'):
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError('%s must be an integer timestamp' % name)
    return value


def _title(value):
    if value is None:
        return None
    if (not isinstance(value, str) or not value.strip()
            or len(value) > TITLE_MAX or _TITLE_CONTROL.search(value)):
        raise ValueError('title must be 1-%d characters without control characters'
                         % TITLE_MAX)
    return value


def _body(value):
    if (not isinstance(value, str) or not value or len(value) > BODY_MAX
            or _BODY_CONTROL.search(value)):
        raise ValueError('body must be 1-%d characters without control characters'
                         % BODY_MAX)
    return value


def _limit(value):
    if value is None:
        return DEFAULT_LIMIT
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError('limit must be a positive integer')
    return min(value, PAGE_MAX)


def _thread_dict(row, reply_count, unread):
    return {
        'id': row['id'],
        'workspace_id': row['workspace_id'],
        'conversation_id': row['conversation_id'],
        'root_message_id': row['root_message_id'],
        'created_by': row['created_by'],
        'title': row['title'],
        'resolved': bool(row['resolved']),
        'created': row['created'],
        'updated': row['updated'],
        'reply_count': int(reply_count),
        'unread': int(unread),
    }


def _reply_dict(row):
    return {
        'id': row['id'],
        'thread_id': row['thread_id'],
        'workspace_id': row['workspace_id'],
        'author_id': row['author_id'],
        'body': row['body'],
        'created': row['created'],
        'deleted': bool(row['deleted']),
    }


def _load_thread(db, workspace_id, thread_id):
    return db.execute(
        'SELECT * FROM message_threads WHERE id=? AND workspace_id=?',
        (thread_id, workspace_id),
    ).fetchone()


def _reply_count(db, workspace_id, thread_id):
    return db.execute(
        'SELECT COUNT(*) FROM thread_replies '
        'WHERE thread_id=? AND workspace_id=? AND deleted=0',
        (thread_id, workspace_id),
    ).fetchone()[0]


def _unread(db, workspace_id, thread_id, user_id):
    return db.execute(
        'SELECT COUNT(*) FROM thread_replies r '
        'WHERE r.thread_id=? AND r.workspace_id=? AND r.deleted=0 '
        'AND r.author_id<>? AND r.created > COALESCE('
        '(SELECT last_read FROM thread_reads WHERE thread_id=? AND user_id=?), ?)',
        (thread_id, workspace_id, user_id, thread_id, user_id, _UNREAD_START),
    ).fetchone()[0]


def create_thread(db, workspace_id, conversation_id, root_message_id, created_by,
                  now, title=None):
    """Create the unique thread for one root message in a conversation."""
    _identifier(workspace_id, 'workspace_id')
    _identifier(conversation_id, 'conversation_id')
    _identifier(root_message_id, 'root_message_id')
    _identifier(created_by, 'created_by')
    when = _timestamp(now)
    title = _title(title)
    thread_id = uuid.uuid4().hex
    try:
        db.execute(
            'INSERT INTO message_threads('
            'id, workspace_id, conversation_id, root_message_id, created_by,'
            'title, resolved, created, updated) VALUES(?,?,?,?,?,?,?,?,?)',
            (thread_id, workspace_id, conversation_id, root_message_id,
             created_by, title, 0, when, when),
        )
    except sqlite3.IntegrityError:
        existing = db.execute(
            'SELECT 1 FROM message_threads WHERE workspace_id=? AND '
            'conversation_id=? AND root_message_id=?',
            (workspace_id, conversation_id, root_message_id),
        ).fetchone()
        if existing is not None:
            raise ThreadExists(
                'a thread already exists for that root message') from None
        raise
    row = _load_thread(db, workspace_id, thread_id)
    return _thread_dict(row, 0, 0)


def add_reply(db, workspace_id, thread_id, author_id, body, now):
    """Append a reply to a thread. The thread must belong to the workspace."""
    _identifier(workspace_id, 'workspace_id')
    _identifier(thread_id, 'thread_id')
    _identifier(author_id, 'author_id')
    body = _body(body)
    when = _timestamp(now)
    if _load_thread(db, workspace_id, thread_id) is None:
        raise ThreadNotFound('thread does not exist in this workspace')
    reply_id = uuid.uuid4().hex
    db.execute(
        'INSERT INTO thread_replies('
        'id, thread_id, workspace_id, author_id, body, created, deleted) '
        'VALUES(?,?,?,?,?,?,0)',
        (reply_id, thread_id, workspace_id, author_id, body, when),
    )
    db.execute(
        'UPDATE message_threads SET updated=MAX(updated,?) '
        'WHERE id=? AND workspace_id=?',
        (when, thread_id, workspace_id),
    )
    row = db.execute(
        'SELECT * FROM thread_replies WHERE id=? AND workspace_id=?',
        (reply_id, workspace_id),
    ).fetchone()
    return _reply_dict(row)


def list_threads(db, workspace_id, conversation_id, include_resolved=True,
                 limit=DEFAULT_LIMIT, cursor=None, viewer_id=None):
    """Return newest threads first with visible reply and unread counts.

    ``viewer_id`` is optional to preserve the compact caller signature; when it
    is omitted the thread creator is used for the per-thread unread count.
    """
    _identifier(workspace_id, 'workspace_id')
    _identifier(conversation_id, 'conversation_id')
    limit = _limit(limit)
    if viewer_id is not None:
        _identifier(viewer_id, 'viewer_id')
    where = 'workspace_id=? AND conversation_id=?'
    args = [workspace_id, conversation_id]
    if not include_resolved:
        where += ' AND resolved=0'
    if cursor:
        _identifier(cursor, 'cursor')
        current = db.execute(
            'SELECT created, id FROM message_threads WHERE id=? AND '
            'workspace_id=? AND conversation_id=?',
            (cursor, workspace_id, conversation_id),
        ).fetchone()
        if current is None:
            return []
        where += ' AND (created < ? OR (created = ? AND id < ?))'
        args.extend((current['created'], current['created'], current['id']))
    rows = db.execute(
        'SELECT * FROM message_threads WHERE %s '
        'ORDER BY created DESC, id DESC LIMIT ?' % where,
        (*args, limit),
    ).fetchall()
    items = []
    for row in rows:
        viewer = viewer_id if viewer_id is not None else row['created_by']
        count = _reply_count(db, workspace_id, row['id'])
        unread = _unread(db, workspace_id, row['id'], viewer)
        items.append(_thread_dict(row, count, unread))
    return items


def thread_view(db, workspace_id, thread_id, viewer_id, limit=DEFAULT_LIMIT,
                cursor=None):
    """Return a thread, one ordered page of visible replies and unread count."""
    _identifier(workspace_id, 'workspace_id')
    _identifier(thread_id, 'thread_id')
    _identifier(viewer_id, 'viewer_id')
    limit = _limit(limit)
    row = _load_thread(db, workspace_id, thread_id)
    if row is None:
        return None
    where = 'thread_id=? AND workspace_id=? AND deleted=0'
    args = [thread_id, workspace_id]
    if cursor:
        _identifier(cursor, 'cursor')
        current = db.execute(
            'SELECT created, id FROM thread_replies WHERE id=? AND '
            'thread_id=? AND workspace_id=?',
            (cursor, thread_id, workspace_id),
        ).fetchone()
        if current is None:
            return None
        where += ' AND (created > ? OR (created = ? AND id > ?))'
        args.extend((current['created'], current['created'], current['id']))
    replies = db.execute(
        'SELECT * FROM thread_replies WHERE %s '
        'ORDER BY created ASC, id ASC LIMIT ?' % where,
        (*args, limit),
    ).fetchall()
    count = _reply_count(db, workspace_id, thread_id)
    unread = _unread(db, workspace_id, thread_id, viewer_id)
    return {
        'thread': _thread_dict(row, count, unread),
        'replies': [_reply_dict(reply) for reply in replies],
        'unread': unread,
    }


def mark_read(db, workspace_id, thread_id, user_id, now):
    """Advance one user's read cursor to ``now`` (never backwards)."""
    _identifier(workspace_id, 'workspace_id')
    _identifier(thread_id, 'thread_id')
    _identifier(user_id, 'user_id')
    when = _timestamp(now)
    if _load_thread(db, workspace_id, thread_id) is None:
        return None
    db.execute(
        'INSERT INTO thread_reads(thread_id, user_id, last_read, updated) '
        'VALUES(?,?,?,?) ON CONFLICT(thread_id, user_id) DO UPDATE SET '
        'last_read=MAX(last_read, excluded.last_read), '
        'updated=MAX(updated, excluded.updated)',
        (thread_id, user_id, when, when),
    )
    state = db.execute(
        'SELECT * FROM thread_reads WHERE thread_id=? AND user_id=?',
        (thread_id, user_id),
    ).fetchone()
    return {
        'thread_id': state['thread_id'],
        'user_id': state['user_id'],
        'last_read': state['last_read'],
        'updated': state['updated'],
        'unread': _unread(db, workspace_id, thread_id, user_id),
    }


def resolve_thread(db, workspace_id, thread_id, now, resolved=True):
    """Set or clear the resolved flag; returns the updated thread or None."""
    _identifier(workspace_id, 'workspace_id')
    _identifier(thread_id, 'thread_id')
    when = _timestamp(now)
    row = _load_thread(db, workspace_id, thread_id)
    if row is None:
        return None
    db.execute(
        'UPDATE message_threads SET resolved=?, updated=MAX(updated,?) '
        'WHERE id=? AND workspace_id=?',
        (1 if resolved else 0, when, thread_id, workspace_id),
    )
    row = _load_thread(db, workspace_id, thread_id)
    count = _reply_count(db, workspace_id, thread_id)
    unread = _unread(db, workspace_id, thread_id, row['created_by'])
    return _thread_dict(row, count, unread)


def delete_reply(db, workspace_id, reply_id, author_id, now):
    """Soft-delete a reply, but only when ``author_id`` wrote it.

    Returns True when the reply exists in the workspace and belongs to the
    author (including an already-deleted reply); False for missing, foreign or
    other users' replies.
    """
    _identifier(workspace_id, 'workspace_id')
    _identifier(reply_id, 'reply_id')
    _identifier(author_id, 'author_id')
    when = _timestamp(now)
    row = db.execute(
        'SELECT * FROM thread_replies WHERE id=? AND workspace_id=?',
        (reply_id, workspace_id),
    ).fetchone()
    if row is None or row['author_id'] != author_id:
        return False
    if not row['deleted']:
        db.execute(
            'UPDATE thread_replies SET deleted=1 '
            'WHERE id=? AND workspace_id=? AND author_id=?',
            (reply_id, workspace_id, author_id),
        )
        db.execute(
            'UPDATE message_threads SET updated=MAX(updated,?) '
            'WHERE id=? AND workspace_id=?',
            (when, row['thread_id'], workspace_id),
        )
    return True
