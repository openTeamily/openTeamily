"""Workspace notification center: @mentions in messenger conversations (issues #4 #86).

Self-written for OpenTeamily; no upstream or Teamily source. A notification is
created only when a human message names another human member of the same
conversation as ``@username``. Visibility is re-checked on every read: a
recipient who left the conversation or a retracted message stops showing.
Group agent request completion is also listed for the requester, and saving a work
in the artifact library notifies the other workspace members who can see it. The
artifact write side only; the /artifacts notification button is a later slice.
A due message reminder is listed too, derived from the one-shot automation run it fires.
A follower who turned on 作品通知 for a creator they follow is told once per newly listed
public work; that source reuses ``discover_follows`` and hides an item again
when the work stops being listed. User-agent conversation unread aggregation
and server push are not implemented here; do not describe this as Teamily
notification parity.
"""
import json
import re
from uuid import uuid4

SCHEMA = '''
CREATE TABLE IF NOT EXISTS social_notifications (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 conversation_id TEXT NOT NULL REFERENCES social_conversations(id) ON DELETE CASCADE,
 message_id TEXT NOT NULL REFERENCES social_messages(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('mention')),
 seq INTEGER NOT NULL,
 created INTEGER NOT NULL,
 read INTEGER NOT NULL DEFAULT 0 CHECK(read IN (0,1)),
 UNIQUE(message_id, user_id, kind));
CREATE INDEX IF NOT EXISTS social_notification_inbox
 ON social_notifications(workspace_id, user_id, seq);
CREATE TABLE IF NOT EXISTS social_follow_work_subs (
 follower_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 creator_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 updated INTEGER NOT NULL,
 PRIMARY KEY(follower_id, creator_id));
CREATE TABLE IF NOT EXISTS social_follow_work_notifications (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
 slug TEXT NOT NULL,
 title TEXT NOT NULL,
 seq INTEGER NOT NULL,
 created INTEGER NOT NULL,
 read INTEGER NOT NULL DEFAULT 0 CHECK(read IN (0,1)),
 UNIQUE(artifact_id, user_id));
CREATE INDEX IF NOT EXISTS social_follow_work_inbox
 ON social_follow_work_notifications(user_id, seq);
CREATE TABLE IF NOT EXISTS social_reply_notification_reads (
 reply_id TEXT NOT NULL REFERENCES social_agent_replies(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 PRIMARY KEY(reply_id, user_id));
CREATE TABLE IF NOT EXISTS artifact_notifications (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
 action TEXT NOT NULL CHECK(action IN ('created','updated')),
 seq INTEGER NOT NULL,
 created INTEGER NOT NULL,
 read INTEGER NOT NULL DEFAULT 0 CHECK(read IN (0,1)),
 UNIQUE(artifact_id, user_id));
CREATE INDEX IF NOT EXISTS artifact_notification_inbox
 ON artifact_notifications(workspace_id, user_id, seq);
CREATE TABLE IF NOT EXISTS automation_reminder_reads (
 run_id TEXT NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 PRIMARY KEY(run_id, user_id));
'''

# Task-completion notifications are derived from the requester's own group agent
# requests that reached a terminal state; only the read marker is stored.

LIMIT = 100
EXCERPT = 140
# A mention starts at the beginning or after whitespace/punctuation and must end
# at a boundary, so e-mail addresses and "@bobby" never notify "bob".
MENTION = re.compile(r'(?<![\w@.])@([A-Za-z0-9_.-]{1,64})(?![\w-])')
HEX32 = re.compile(r'[0-9a-f]{32}')


def mentioned_names(text):
    names = []
    for match in MENTION.finditer(text or ''):
        name = match.group(1).rstrip('.')
        if name and name not in names:
            names.append(name)
    return names


def record_mentions(db, workspace_id, conversation_id, message_id, actor_id, text, now):
    """Insert one unread mention per distinct mentioned co-member (never the author)."""
    names = mentioned_names(text)
    if not names:
        return 0
    placeholders = ','.join('?' * len(names))
    rows = db.execute(
        'SELECT u.id FROM social_members m JOIN users u ON u.id=m.user_id '
        f'WHERE m.conversation_id=? AND m.workspace_id=? AND u.id<>? AND u.username IN ({placeholders}) '
        'ORDER BY u.id', (conversation_id, workspace_id, actor_id, *names)).fetchall()
    seq = db.execute('SELECT COALESCE(MAX(seq),0) FROM social_notifications').fetchone()[0]
    for row in rows:
        seq += 1
        db.execute('INSERT OR IGNORE INTO social_notifications '
                   '(id,workspace_id,user_id,actor_id,conversation_id,message_id,kind,seq,created,read) '
                   'VALUES(?,?,?,?,?,?,?,?,?,0)',
                   (uuid4().hex, workspace_id, row['id'], actor_id, conversation_id, message_id,
                    'mention', seq, now))
    return len(rows)


VISIBLE = '''
 FROM social_notifications n
 JOIN social_members sm ON sm.conversation_id=n.conversation_id AND sm.user_id=n.user_id
 JOIN social_messages msg ON msg.id=n.message_id
 JOIN social_conversations c ON c.id=n.conversation_id
 JOIN users a ON a.id=n.actor_id
 LEFT JOIN social_message_state st ON st.message_id=n.message_id
 LEFT JOIN social_mutes mu ON mu.conversation_id=n.conversation_id AND mu.user_id=n.user_id
 WHERE n.workspace_id=? AND n.user_id=? AND COALESCE(st.retracted,0)=0
   AND COALESCE(mu.muted,0)=0
'''


# Workspace members who can see the artifact library: the owner plus every member
# who is not suspended. Roles do not filter the library (artifacts.listing has no
# role predicate), so suspension is the only exclusion here.
ARTIFACT_RECIPIENTS = '''
SELECT w.owner_id AS user_id FROM workspaces w WHERE w.id=?
UNION
SELECT m.user_id FROM workspace_members m WHERE m.workspace_id=?
 AND NOT EXISTS (SELECT 1 FROM workspace_member_suspensions s
                 WHERE s.workspace_id=m.workspace_id AND s.user_id=m.user_id)
'''


def wants_artifact(db, workspace_id, user_id):
    """Per-user opt-out for workspace artifact saves.

    #284 (notification_prefs) has not landed, so there is no preference row to read
    yet: everyone with library access gets the notice. When the preference table
    lands, this is the one place that has to return False for members who switched
    artifact notices off.
    """
    return True


def record_artifact(db, workspace_id, actor_id, artifact_id, action, now):
    """Insert one unread notice per recipient; saving the same artifact again never duplicates.

    The row is keyed (artifact_id, user_id), so a later edit of the same work does not
    add a second line; the first save keeps the row a member already saw.
    """
    rows = db.execute(ARTIFACT_RECIPIENTS, (workspace_id, workspace_id)).fetchall()
    seq = db.execute('SELECT COALESCE(MAX(seq),0) FROM artifact_notifications').fetchone()[0]
    written = 0
    for row in rows:
        user_id = row['user_id']
        if user_id == actor_id or not wants_artifact(db, workspace_id, user_id):
            continue
        seq += 1
        cursor = db.execute(
            'INSERT OR IGNORE INTO artifact_notifications '
            '(id,workspace_id,user_id,actor_id,artifact_id,action,seq,created,read) '
            'VALUES(?,?,?,?,?,?,?,?,0)',
            (uuid4().hex, workspace_id, user_id, actor_id, artifact_id, action, seq, now))
        written += 1 if cursor.rowcount > 0 else 0
    return written


# Visibility is re-checked on every read, like the mention source: a recipient who was
# suspended or removed, or a work that was deleted, stops showing.
VISIBLE_ARTIFACTS = '''
 FROM artifact_notifications n
 JOIN artifacts a ON a.id=n.artifact_id AND a.workspace_id=n.workspace_id
 JOIN users ac ON ac.id=n.actor_id
 JOIN workspaces w ON w.id=n.workspace_id
 WHERE n.workspace_id=? AND n.user_id=?
  AND (w.owner_id=n.user_id OR EXISTS (
        SELECT 1 FROM workspace_members m
        WHERE m.workspace_id=n.workspace_id AND m.user_id=n.user_id
         AND NOT EXISTS (SELECT 1 FROM workspace_member_suspensions s
                         WHERE s.workspace_id=m.workspace_id AND s.user_id=m.user_id)))
'''


def artifact_view(row):
    return {'id': row['id'], 'kind': 'artifact', 'artifact_id': row['artifact_id'],
            'artifact_title': row['artifact_title'], 'action': row['action'],
            'actor_id': row['actor_id'], 'actor_username': row['actor_username'],
            'created': row['created'], 'read': bool(row['read'])}


def view(row):
    body = row['body']
    return {'id': row['id'], 'kind': row['kind'], 'conversation_id': row['conversation_id'],
            'conversation_kind': row['conversation_kind'], 'conversation_title': row['conversation_title'],
            'message_id': row['message_id'], 'actor_id': row['actor_id'],
            'actor_username': row['actor_username'],
            'excerpt': body if len(body) <= EXCERPT else body[:EXCERPT - 1] + '…',
            'created': row['created'], 'read': bool(row['read'])}


REPLIES = '''
 FROM social_agent_replies r
 JOIN social_members sm ON sm.conversation_id=r.conversation_id AND sm.user_id=r.requested_by
 JOIN social_conversations c ON c.id=r.conversation_id
 LEFT JOIN social_reply_notification_reads rr ON rr.reply_id=r.id AND rr.user_id=r.requested_by
 LEFT JOIN social_mutes mu ON mu.conversation_id=r.conversation_id AND mu.user_id=r.requested_by
 WHERE r.workspace_id=? AND r.requested_by=? AND r.status IN ('succeeded','failed','cancelled')
   AND COALESCE(mu.muted,0)=0
'''
REPLY_STATUS = {'succeeded': '已回复', 'failed': '未能完成', 'cancelled': '已取消'}


def reply_view(row):
    return {'id': row['id'], 'kind': 'agent_reply', 'conversation_id': row['conversation_id'],
            'conversation_kind': row['conversation_kind'], 'conversation_title': row['conversation_title'],
            'message_id': row['id'] if row['status'] == 'succeeded' else None, 'actor_id': row['agent_id'],
            'actor_username': row['agent_name'], 'status': row['status'],
            'excerpt': REPLY_STATUS[row['status']] + '：' + (row['prompt'] if len(row['prompt']) <= EXCERPT
                                                            else row['prompt'][:EXCERPT - 1] + '…'),
            'created': row['updated'], 'read': row['is_read'] == 1}


# A due one-shot reminder is a derived notification as well: the automation run is the
# fact and only the read marker is stored. It is addressed to the automation's own
# participants, so another member of the same workspace never sees it.
REMINDERS = '''
 FROM automation_runs r
 JOIN automations a ON a.id=r.automation_id
 LEFT JOIN automation_reminder_reads rr ON rr.run_id=r.id AND rr.user_id=?
 WHERE r.workspace_id=? AND a.template_id='reminder' AND r.due_at<=?
'''
REMINDER_KIND = 'automation_reminder'


def _participants(raw):
    try:
        names = json.loads(raw)
    except (TypeError, ValueError):
        return []
    if not isinstance(names, list):
        return []
    found = []
    for name in names:
        if isinstance(name, str):
            found.append(name)
        elif isinstance(name, dict) and isinstance(name.get('username'), str):
            found.append(name['username'])
    return found


def reminder_view(row):
    prompt = row['prompt']
    return {'id': row['id'], 'kind': REMINDER_KIND, 'conversation_id': None, 'conversation_kind': None,
            'conversation_title': None, 'message_id': None, 'automation_id': row['automation_id'],
            'actor_id': None, 'actor_username': None, 'title': row['title'],
            'excerpt': prompt if len(prompt) <= EXCERPT else prompt[:EXCERPT - 1] + '…',
            'created': row['due_at'], 'read': row['is_read'] == 1}


def _reminder_rows(db, workspace_id, user_id, now, extra=''):
    user = db.execute('SELECT username FROM users WHERE id=?', (user_id,)).fetchone()
    if user is None:
        return []
    rows = db.execute(
        'SELECT r.id, r.automation_id, r.due_at, a.title, a.prompt, a.participants, '
        '(rr.run_id IS NOT NULL) AS is_read' + REMINDERS + extra
        + ' ORDER BY r.due_at DESC, r.id DESC LIMIT ?',
        (user_id, workspace_id, int(now or 0), LIMIT)).fetchall()
    return [row for row in rows if user['username'] in _participants(row['participants'])]


def _mark_reminders(db, workspace_id, user_id, now, run_id=None):
    extra = ' AND rr.run_id IS NULL' if run_id is None else ''
    for row in _reminder_rows(db, workspace_id, user_id, now, extra):
        if run_id is not None and row['id'] != run_id:
            continue
        db.execute('INSERT OR IGNORE INTO automation_reminder_reads(run_id,user_id) VALUES(?,?)',
                   (row['id'], user_id))

FOLLOW_WORK = '''
 FROM social_follow_work_notifications n
 JOIN artifact_discover d ON d.artifact_id=n.artifact_id AND d.listed=1
 JOIN users a ON a.id=n.actor_id
 JOIN discover_follows f ON f.follower_id=n.user_id AND f.creator_id=n.actor_id
 WHERE n.user_id=?
'''


def follow_work_view(row):
    return {'id': row['id'], 'kind': 'follow_work', 'actor_id': row['actor_id'],
            'actor_username': row['actor_username'], 'artifact_id': row['artifact_id'],
            'title': row['title'], 'slug': row['slug'], 'path': '/w/' + row['slug'],
            'created': row['created'], 'read': bool(row['read'])}


def follow_work_listing(db, user_id, unread_only=False):
    rows = db.execute(
        'SELECT n.*, a.username AS actor_username' + FOLLOW_WORK
        + (' AND n.read=0' if unread_only else '')
        + ' ORDER BY n.created DESC, n.id DESC LIMIT ?', (user_id, LIMIT)).fetchall()
    return [follow_work_view(row) for row in rows]


SWITCH = '''
 FROM discover_follows f
 JOIN users u ON u.id=f.creator_id
 LEFT JOIN user_profiles p ON p.user_id=f.creator_id
 LEFT JOIN social_follow_work_subs s ON s.follower_id=f.follower_id AND s.creator_id=f.creator_id
'''


def follow_work_switches(db, user_id):
    return db.execute(
        'SELECT f.creator_id, u.username, p.handle, p.name, COALESCE(s.enabled,0) AS enabled'
        + SWITCH + ' WHERE f.follower_id=? ORDER BY u.username', (user_id,)).fetchall()


def follow_work_switch_view(row):
    return {'creator_id': row['creator_id'], 'username': row['username'],
            'handle': row['handle'] or '', 'name': row['name'] or row['username'],
            'enabled': row['enabled'] == 1}


def set_follow_work(db, follower_id, creator_id, enabled, now):
    """Turn one followed creator's 作品通知 on or off; follow the creator first."""
    if follower_id == creator_id:
        return None
    row = db.execute('SELECT 1' + SWITCH + ' WHERE f.follower_id=? AND f.creator_id=?',
                     (follower_id, creator_id)).fetchone()
    if row is None:
        return None
    db.execute('INSERT INTO social_follow_work_subs(follower_id,creator_id,enabled,updated) VALUES(?,?,?,?) '
               'ON CONFLICT(follower_id,creator_id) DO UPDATE SET enabled=excluded.enabled, updated=excluded.updated',
               (follower_id, creator_id, 1 if enabled else 0, now))
    return follow_work_switch_view(db.execute(
        'SELECT f.creator_id, u.username, p.handle, p.name, s.enabled'
        + SWITCH + ' WHERE f.follower_id=? AND f.creator_id=?', (follower_id, creator_id)).fetchone())


def deliver_follow_work(db, artifact_id, slug, title, creator_id, now):
    """One unread item per subscribed follower when a work becomes publicly listed."""
    subs = db.execute('SELECT s.follower_id FROM social_follow_work_subs s '
                      'JOIN discover_follows f ON f.follower_id=s.follower_id AND f.creator_id=s.creator_id '
                      'WHERE s.creator_id=? AND s.enabled=1 AND s.follower_id<>?',
                      (creator_id, creator_id)).fetchall()
    if not subs:
        return 0
    seq = db.execute('SELECT COALESCE(MAX(seq),0) FROM social_follow_work_notifications').fetchone()[0]
    added = 0
    for row in subs:
        seq += 1
        added += db.execute(
            'INSERT OR IGNORE INTO social_follow_work_notifications '
            '(id,user_id,actor_id,artifact_id,slug,title,seq,created,read) VALUES(?,?,?,?,?,?,?,?,0)',
            (uuid4().hex, row['follower_id'], creator_id, artifact_id, slug, title, seq, now)).rowcount
    return added


def listing(db, workspace_id, user_id, unread_only=False, now=0):
    rows = db.execute(
        'SELECT n.*, msg.body AS body, c.kind AS conversation_kind, c.title AS conversation_title, '
        'a.username AS actor_username' + VISIBLE + (' AND n.read=0' if unread_only else '')
        + ' ORDER BY n.seq DESC LIMIT ?', (workspace_id, user_id, LIMIT)).fetchall()
    replies = db.execute(
        'SELECT r.*, c.kind AS conversation_kind, c.title AS conversation_title, '
        '(rr.reply_id IS NOT NULL) AS is_read' + REPLIES + (' AND rr.reply_id IS NULL' if unread_only else '')
        + ' ORDER BY r.updated DESC, r.id DESC LIMIT ?', (workspace_id, user_id, LIMIT)).fetchall()
    artifacts_listed = db.execute(
        'SELECT n.*, a.title AS artifact_title, ac.username AS actor_username' + VISIBLE_ARTIFACTS
        + (' AND n.read=0' if unread_only else '') + ' ORDER BY n.seq DESC LIMIT ?',
        (workspace_id, user_id, LIMIT)).fetchall()
    reminders = _reminder_rows(db, workspace_id, user_id, now, ' AND rr.run_id IS NULL' if unread_only else '')
    items = ([view(row) for row in rows] + [reply_view(row) for row in replies]
             + [artifact_view(row) for row in artifacts_listed]
             + [reminder_view(row) for row in reminders]
             + follow_work_listing(db, user_id, unread_only))
    items.sort(key=lambda item: item['created'], reverse=True)
    return items[:LIMIT]


def unread_count(db, workspace_id, user_id, now=0):
    mentions = db.execute('SELECT COUNT(*)' + VISIBLE + ' AND n.read=0', (workspace_id, user_id)).fetchone()[0]
    replies = db.execute('SELECT COUNT(*)' + REPLIES + ' AND rr.reply_id IS NULL', (workspace_id, user_id)).fetchone()[0]
    saved = db.execute('SELECT COUNT(*)' + VISIBLE_ARTIFACTS + ' AND n.read=0',
                       (workspace_id, user_id)).fetchone()[0]
    reminders = _reminder_rows(db, workspace_id, user_id, now, ' AND rr.run_id IS NULL')
    follows = db.execute('SELECT COUNT(*)' + FOLLOW_WORK + ' AND n.read=0', (user_id,)).fetchone()[0]
    return mentions + replies + saved + len(reminders) + follows


def _mark_replies(db, workspace_id, user_id, extra='', args=()):
    db.execute('INSERT OR IGNORE INTO social_reply_notification_reads(reply_id,user_id) SELECT r.id, r.requested_by'
               + REPLIES + extra, (workspace_id, user_id, *args))


def mark_read(db, workspace_id, user_id, notification_id=None, now=0):
    if notification_id is None:
        db.execute('UPDATE social_notifications SET read=1 WHERE workspace_id=? AND user_id=? AND read=0',
                   (workspace_id, user_id))
        _mark_replies(db, workspace_id, user_id)
        db.execute('UPDATE artifact_notifications SET read=1 WHERE workspace_id=? AND user_id=? AND read=0',
                   (workspace_id, user_id))
        _mark_reminders(db, workspace_id, user_id, now)
        db.execute('UPDATE social_follow_work_notifications SET read=1 WHERE user_id=? AND read=0', (user_id,))
        return True
    cursor = db.execute('UPDATE social_notifications SET read=1 WHERE id=? AND workspace_id=? AND user_id=?',
                        (notification_id, workspace_id, user_id))
    if cursor.rowcount == 1:
        return True
    if db.execute('UPDATE social_follow_work_notifications SET read=1 WHERE id=? AND user_id=?',
                  (notification_id, user_id)).rowcount == 1:
        return True
    if db.execute('SELECT 1' + REPLIES + ' AND r.id=?', (workspace_id, user_id, notification_id)).fetchone():
        _mark_replies(db, workspace_id, user_id, ' AND r.id=?', (notification_id,))
        return True
    if db.execute('UPDATE artifact_notifications SET read=1 WHERE id=? AND workspace_id=? AND user_id=?',
                  (notification_id, workspace_id, user_id)).rowcount == 1:
        return True
    if any(row['id'] == notification_id for row in _reminder_rows(db, workspace_id, user_id, now)):
        _mark_reminders(db, workspace_id, user_id, now, notification_id)
        return True
    return False


def mark_conversation_read(db, workspace_id, user_id, conversation_id, up_to_seq):
    """Opening a conversation past a mentioned message clears that mention."""
    db.execute('UPDATE social_notifications SET read=1 WHERE workspace_id=? AND user_id=? AND conversation_id=? '
               'AND read=0 AND message_id IN (SELECT id FROM social_messages WHERE conversation_id=? AND seq<=?)',
               (workspace_id, user_id, conversation_id, conversation_id, up_to_seq))
    _mark_replies(db, workspace_id, user_id, ' AND r.conversation_id=? AND (r.seq IS NULL OR r.seq<=?)',
                  (conversation_id, up_to_seq))
