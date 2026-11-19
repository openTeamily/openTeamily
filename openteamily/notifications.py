"""Workspace notification center: @mentions in messenger conversations (issues #4 #86).

Self-written for OpenTeamily; no upstream or Teamily source. A notification is
created only when a human message names another human member of the same
conversation as ``@username``. Visibility is re-checked on every read: a
recipient who left the conversation or a retracted message stops showing.
Group agent request completion is also listed for the requester. User-agent
conversation unread aggregation and server push are not implemented here; do not describe this as Teamily notification parity.
"""
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
CREATE TABLE IF NOT EXISTS social_reply_notification_reads (
 reply_id TEXT NOT NULL REFERENCES social_agent_replies(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 PRIMARY KEY(reply_id, user_id));
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
 WHERE n.workspace_id=? AND n.user_id=? AND COALESCE(st.retracted,0)=0
'''


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
 WHERE r.workspace_id=? AND r.requested_by=? AND r.status IN ('succeeded','failed','cancelled')
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


def listing(db, workspace_id, user_id, unread_only=False):
    rows = db.execute(
        'SELECT n.*, msg.body AS body, c.kind AS conversation_kind, c.title AS conversation_title, '
        'a.username AS actor_username' + VISIBLE + (' AND n.read=0' if unread_only else '')
        + ' ORDER BY n.seq DESC LIMIT ?', (workspace_id, user_id, LIMIT)).fetchall()
    replies = db.execute(
        'SELECT r.*, c.kind AS conversation_kind, c.title AS conversation_title, '
        '(rr.reply_id IS NOT NULL) AS is_read' + REPLIES + (' AND rr.reply_id IS NULL' if unread_only else '')
        + ' ORDER BY r.updated DESC, r.id DESC LIMIT ?', (workspace_id, user_id, LIMIT)).fetchall()
    items = [view(row) for row in rows] + [reply_view(row) for row in replies]
    items.sort(key=lambda item: item['created'], reverse=True)
    return items[:LIMIT]


def unread_count(db, workspace_id, user_id):
    mentions = db.execute('SELECT COUNT(*)' + VISIBLE + ' AND n.read=0', (workspace_id, user_id)).fetchone()[0]
    replies = db.execute('SELECT COUNT(*)' + REPLIES + ' AND rr.reply_id IS NULL', (workspace_id, user_id)).fetchone()[0]
    return mentions + replies


def _mark_replies(db, workspace_id, user_id, extra='', args=()):
    db.execute('INSERT OR IGNORE INTO social_reply_notification_reads(reply_id,user_id) SELECT r.id, r.requested_by'
               + REPLIES + extra, (workspace_id, user_id, *args))


def mark_read(db, workspace_id, user_id, notification_id=None):
    if notification_id is None:
        db.execute('UPDATE social_notifications SET read=1 WHERE workspace_id=? AND user_id=? AND read=0',
                   (workspace_id, user_id))
        _mark_replies(db, workspace_id, user_id)
        return True
    cursor = db.execute('UPDATE social_notifications SET read=1 WHERE id=? AND workspace_id=? AND user_id=?',
                        (notification_id, workspace_id, user_id))
    if cursor.rowcount == 1:
        return True
    if db.execute('SELECT 1' + REPLIES + ' AND r.id=?', (workspace_id, user_id, notification_id)).fetchone():
        _mark_replies(db, workspace_id, user_id, ' AND r.id=?', (notification_id,))
        return True
    return False


def mark_conversation_read(db, workspace_id, user_id, conversation_id, up_to_seq):
    """Opening a conversation past a mentioned message clears that mention."""
    db.execute('UPDATE social_notifications SET read=1 WHERE workspace_id=? AND user_id=? AND conversation_id=? '
               'AND read=0 AND message_id IN (SELECT id FROM social_messages WHERE conversation_id=? AND seq<=?)',
               (workspace_id, user_id, conversation_id, conversation_id, up_to_seq))
    _mark_replies(db, workspace_id, user_id, ' AND r.conversation_id=? AND (r.seq IS NULL OR r.seq<=?)',
                  (conversation_id, up_to_seq))
