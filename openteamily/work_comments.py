"""Threaded comments and likes for Discover public works.

Self-written for OpenTeamily; no upstream or Teamily source. This module stores
one reply level beneath each root comment and per-user likes for a work id that
the caller supplies (normally an artifact id behind a listed Discover work).

Scope and trust boundary:

* This is local persistence and validation only. It does not decide whether a
  caller may read or write a workspace, whether a user is a member, or whether
  the work is still publicly listed. The caller must authorize the workspace and
  re-check public visibility before showing or accepting comments.
* There is no moderation classifier, spam scoring, mention delivery, edit
  history, federation, or reward/ranking logic. Bodies are stored as plain text;
  any renderer must escape them.
* Every query is scoped by both workspace_id and work_id, and by both sides of
  every parent/like lookup, so ids from one tenant or work cannot be reused in
  another.
* Deleting a comment is a soft delete. A deleted root disappears with its
  replies; a deleted reply disappears from previews and counts, but the row and
  its likes remain for audit/cleanup rather than being destroyed.
"""
import re
import uuid

BODY_MAX = 2000
LIST_MAX = 50
REPLY_PREVIEW = 3
HEX32 = re.compile(r'[0-9a-f]{32}')

SCHEMA = '''
CREATE TABLE IF NOT EXISTS work_comments (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 work_id TEXT NOT NULL,
 author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 parent_id TEXT REFERENCES work_comments(id) ON DELETE CASCADE,
 body TEXT NOT NULL CHECK(length(body) > 0),
 deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)),
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL,
 CHECK(parent_id IS NULL OR parent_id<>id));
CREATE INDEX IF NOT EXISTS work_comment_work
 ON work_comments(workspace_id, work_id, parent_id, deleted, created, id);
CREATE INDEX IF NOT EXISTS work_comment_parent
 ON work_comments(parent_id, deleted, created, id);
CREATE INDEX IF NOT EXISTS work_comment_author
 ON work_comments(workspace_id, author_id, created, id);
CREATE TABLE IF NOT EXISTS work_comment_likes (
 comment_id TEXT NOT NULL REFERENCES work_comments(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created INTEGER NOT NULL,
 PRIMARY KEY(comment_id, user_id));
CREATE INDEX IF NOT EXISTS work_comment_like_user
 ON work_comment_likes(user_id, created, comment_id);
'''


def ensure_schema(db):
    """Create the additive tables and indexes; safe to call repeatedly.

    This deliberately does not bump Store's schema version and does not commit a
    caller's open transaction. Production startup must either include this
    SCHEMA with the other module schemas or call this during initialization.
    """
    for statement in SCHEMA.split(';'):
        if statement.strip():
            db.execute(statement)


def _text_id(value, name):
    if (not isinstance(value, str) or not value or len(value) > 128
            or '\x00' in value):
        raise ValueError('%s is invalid' % name)
    return value


def _time(value):
    if type(value) is not int or value < 0:
        raise ValueError('now must be a non-negative integer')
    return value


def _body(value):
    if not isinstance(value, str):
        raise ValueError('comment body must be text')
    text = value.strip()
    if not text:
        raise ValueError('comment body is required')
    if len(text) > BODY_MAX:
        raise ValueError('comment body is too long')
    if '\x00' in text or any(ord(ch) < 32 and ch not in '\t\n\r' for ch in text):
        raise ValueError('comment body contains control characters')
    return text


def _viewer(value):
    if value is None or value == '':
        return None
    return _text_id(value, 'viewer_id')


def _load(db, workspace_id, work_id, comment_id):
    return db.execute(
        'SELECT * FROM work_comments WHERE id=? AND workspace_id=? AND work_id=?',
        (comment_id, workspace_id, work_id),
    ).fetchone()


def _like_stats(db, comment_ids, viewer_id=None):
    ids = list(dict.fromkeys(comment_id for comment_id in comment_ids if comment_id))
    stats = {comment_id: {'likes': 0, 'liked': False} for comment_id in ids}
    if not ids:
        return stats
    viewer = _viewer(viewer_id)
    for start in range(0, len(ids), 400):
        chunk = ids[start:start + 400]
        marks = ','.join('?' for _ in chunk)
        if viewer:
            rows = db.execute(
                'SELECT comment_id, COUNT(*) AS likes, MAX(user_id=?) AS liked '
                'FROM work_comment_likes WHERE comment_id IN (' + marks + ') '
                'GROUP BY comment_id',
                (viewer, *chunk)).fetchall()
        else:
            rows = db.execute(
                'SELECT comment_id, COUNT(*) AS likes FROM work_comment_likes '
                'WHERE comment_id IN (' + marks + ') GROUP BY comment_id',
                tuple(chunk)).fetchall()
        for row in rows:
            stats[row['comment_id']] = {
                'likes': int(row['likes']),
                'liked': bool(row['liked']) if viewer else False,
            }
    return stats


def _view(row, stats=None):
    stats = stats or {'likes': 0, 'liked': False}
    return {
        'id': row['id'],
        'workspace_id': row['workspace_id'],
        'work_id': row['work_id'],
        'author_id': row['author_id'],
        'parent_id': row['parent_id'],
        'body': row['body'],
        'deleted': bool(row['deleted']),
        'created': row['created'],
        'updated': row['updated'],
        'likes': stats['likes'],
        'liked': stats['liked'],
    }


def _root_view(row, stats, replies, reply_count):
    data = _view(row, stats)
    data['reply_count'] = reply_count
    data['replies'] = replies
    return data


def _like_view(comment_id, stats):
    return {'comment_id': comment_id, 'likes': stats['likes'], 'liked': stats['liked']}


def _cursor(row):
    return '%d.%s' % (row['created'], row['id'])


def _parse_cursor(cursor):
    if cursor is None or cursor == '':
        return None
    if not isinstance(cursor, str):
        raise ValueError('invalid comment cursor')
    created, sep, comment_id = cursor.partition('.')
    if not sep or not created.isdigit() or not HEX32.fullmatch(comment_id):
        raise ValueError('invalid comment cursor')
    return int(created), comment_id


def add_comment(db, workspace_id, work_id, author_id, body, now, parent_id=None):
    """Add a root comment or one reply to an existing root comment."""
    workspace_id = _text_id(workspace_id, 'workspace_id')
    work_id = _text_id(work_id, 'work_id')
    author_id = _text_id(author_id, 'author_id')
    text = _body(body)
    now = _time(now)
    if parent_id is not None:
        parent_id = _text_id(parent_id, 'parent_id')
        parent = _load(db, workspace_id, work_id, parent_id)
        if parent is None:
            raise ValueError('parent comment not found in this work')
        if parent['deleted']:
            raise ValueError('parent comment is deleted')
        if parent['parent_id'] is not None:
            raise ValueError('replies are limited to one level')
    comment_id = uuid.uuid4().hex
    db.execute(
        'INSERT INTO work_comments(id, workspace_id, work_id, author_id, parent_id, '
        'body, deleted, created, updated) VALUES(?,?,?,?,?,?,0,?,?)',
        (comment_id, workspace_id, work_id, author_id, parent_id, text, now, now),
    )
    return _view(_load(db, workspace_id, work_id, comment_id))


def list_comments(db, workspace_id, work_id, limit, cursor, viewer_id=None):
    """List visible root comments oldest-first with bounded reply previews.

    ``cursor`` is the opaque value returned by the previous page. Each root
    includes ``reply_count`` (all visible replies) and up to ``REPLY_PREVIEW``
    visible replies ordered oldest-first. ``likes`` counts everyone and
    ``liked`` reflects only ``viewer_id``.
    """
    workspace_id = _text_id(workspace_id, 'workspace_id')
    work_id = _text_id(work_id, 'work_id')
    viewer = _viewer(viewer_id)
    if type(limit) is not int or not 1 <= limit <= LIST_MAX:
        raise ValueError('limit must be between 1 and %d' % LIST_MAX)
    parsed = _parse_cursor(cursor)
    sql = ('SELECT * FROM work_comments WHERE workspace_id=? AND work_id=? '
           'AND parent_id IS NULL AND deleted=0')
    args = [workspace_id, work_id]
    if parsed is not None:
        sql += ' AND (created>? OR (created=? AND id>?))'
        args.extend([parsed[0], parsed[0], parsed[1]])
    sql += ' ORDER BY created, id LIMIT ?'
    args.append(limit + 1)
    rows = db.execute(sql, tuple(args)).fetchall()
    more = len(rows) > limit
    roots = rows[:limit]

    counts = {}
    previews = {}
    all_ids = [row['id'] for row in roots]
    for root in roots:
        counts[root['id']] = db.execute(
            'SELECT COUNT(*) FROM work_comments WHERE workspace_id=? AND work_id=? '
            'AND parent_id=? AND deleted=0',
            (workspace_id, work_id, root['id'])).fetchone()[0]
        preview = db.execute(
            'SELECT * FROM work_comments WHERE workspace_id=? AND work_id=? '
            'AND parent_id=? AND deleted=0 ORDER BY created, id LIMIT ?',
            (workspace_id, work_id, root['id'], REPLY_PREVIEW)).fetchall()
        previews[root['id']] = preview
        all_ids.extend(row['id'] for row in preview)

    stats = _like_stats(db, all_ids, viewer)
    items = []
    for root in roots:
        replies = [_view(row, stats.get(row['id'])) for row in previews[root['id']]]
        items.append(_root_view(root, stats.get(root['id']), replies, counts[root['id']]))
    return {'items': items, 'cursor': _cursor(roots[-1]) if more else None}


def edit_comment(db, workspace_id, work_id, comment_id, author_id, body, now):
    """Edit a visible comment. Only its author may edit it."""
    workspace_id = _text_id(workspace_id, 'workspace_id')
    work_id = _text_id(work_id, 'work_id')
    comment_id = _text_id(comment_id, 'comment_id')
    author_id = _text_id(author_id, 'author_id')
    text = _body(body)
    now = _time(now)
    row = _load(db, workspace_id, work_id, comment_id)
    if row is None or row['deleted']:
        raise ValueError('comment not found')
    if row['author_id'] != author_id:
        raise PermissionError('only the author can edit this comment')
    db.execute(
        'UPDATE work_comments SET body=?, updated=? WHERE id=? AND workspace_id=? '
        'AND work_id=? AND author_id=?',
        (text, now, comment_id, workspace_id, work_id, author_id),
    )
    updated = _load(db, workspace_id, work_id, comment_id)
    stats = _like_stats(db, [comment_id], author_id).get(
        comment_id, {'likes': 0, 'liked': False})
    return _view(updated, stats)


def delete_comment(db, workspace_id, work_id, comment_id, author_id, now):
    """Soft-delete a comment. Repeated deletes by the author are idempotent."""
    workspace_id = _text_id(workspace_id, 'workspace_id')
    work_id = _text_id(work_id, 'work_id')
    comment_id = _text_id(comment_id, 'comment_id')
    author_id = _text_id(author_id, 'author_id')
    now = _time(now)
    row = _load(db, workspace_id, work_id, comment_id)
    if row is None:
        raise ValueError('comment not found')
    if row['author_id'] != author_id:
        raise PermissionError('only the author can delete this comment')
    if not row['deleted']:
        db.execute(
            'UPDATE work_comments SET deleted=1, updated=? WHERE id=? AND workspace_id=? '
            'AND work_id=? AND author_id=?',
            (now, comment_id, workspace_id, work_id, author_id),
        )
        row = _load(db, workspace_id, work_id, comment_id)
    stats = _like_stats(db, [comment_id], author_id).get(
        comment_id, {'likes': 0, 'liked': False})
    return _view(row, stats)


def _visible(db, row):
    if row['deleted']:
        return False
    if row['parent_id'] is not None:
        parent = _load(db, row['workspace_id'], row['work_id'], row['parent_id'])
        return parent is not None and not parent['deleted']
    return True


def like_comment(db, workspace_id, work_id, comment_id, user_id, now):
    """Like a visible comment. Repeating the same like changes nothing."""
    workspace_id = _text_id(workspace_id, 'workspace_id')
    work_id = _text_id(work_id, 'work_id')
    comment_id = _text_id(comment_id, 'comment_id')
    user_id = _text_id(user_id, 'user_id')
    now = _time(now)
    row = _load(db, workspace_id, work_id, comment_id)
    if row is None or not _visible(db, row):
        raise ValueError('comment not found')
    db.execute(
        'INSERT OR IGNORE INTO work_comment_likes(comment_id, user_id, created) '
        'VALUES(?,?,?)', (comment_id, user_id, now))
    stats = _like_stats(db, [comment_id], user_id)[comment_id]
    return _like_view(comment_id, stats)


def unlike_comment(db, workspace_id, work_id, comment_id, user_id, now):
    """Remove a like. Repeating the same unlike changes nothing."""
    workspace_id = _text_id(workspace_id, 'workspace_id')
    work_id = _text_id(work_id, 'work_id')
    comment_id = _text_id(comment_id, 'comment_id')
    user_id = _text_id(user_id, 'user_id')
    _time(now)
    row = _load(db, workspace_id, work_id, comment_id)
    if row is None or not _visible(db, row):
        raise ValueError('comment not found')
    db.execute(
        'DELETE FROM work_comment_likes WHERE comment_id=? AND user_id=?',
        (comment_id, user_id))
    stats = _like_stats(db, [comment_id], user_id)[comment_id]
    return _like_view(comment_id, stats)


def comment_count(db, workspace_id, work_id):
    """Count visible comments (roots plus replies under visible roots)."""
    workspace_id = _text_id(workspace_id, 'workspace_id')
    work_id = _text_id(work_id, 'work_id')
    return db.execute(
        'SELECT COUNT(*) FROM work_comments c WHERE c.workspace_id=? AND c.work_id=? '
        'AND c.deleted=0 AND (c.parent_id IS NULL OR EXISTS('
        'SELECT 1 FROM work_comments p WHERE p.id=c.parent_id '
        'AND p.workspace_id=c.workspace_id AND p.work_id=c.work_id '
        'AND p.parent_id IS NULL AND p.deleted=0))',
        (workspace_id, work_id)).fetchone()[0]
