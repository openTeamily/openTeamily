"""Workspace memory pages, next actions, and the relationship graph (issue 8).

Self-written for OpenTeamily; no upstream, Timeline, Project, or Teamily
source, fonts or marketing copy. Pages, next actions, topics and links are
workspace-scoped. Pages and actions persist on create and can be edited or
deleted. The graph is derived from optional page topics, [[Title]] mentions
in page bodies, and optional manual links. This is not a profile, share/export,
or Teamily memory parity, and it is not browser E2E acceptance.
"""
import re

from .search import snippet
from .security import digest

SCHEMA = """
CREATE TABLE IF NOT EXISTS memory_pages (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 title TEXT NOT NULL,
 title_hash TEXT NOT NULL,
 body TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision >= 1),
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL,
 created_by TEXT NOT NULL REFERENCES users(id),
 updated_by TEXT NOT NULL REFERENCES users(id),
 key_hash TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 UNIQUE(workspace_id, key_hash),
 UNIQUE(workspace_id, title_hash));
CREATE INDEX IF NOT EXISTS memory_page_workspace ON memory_pages(workspace_id, id);
CREATE TABLE IF NOT EXISTS memory_actions (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 title TEXT NOT NULL,
 notes TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('open', 'done')),
 due_at INTEGER CHECK(due_at IS NULL OR due_at >= 0),
 memory_page_id TEXT REFERENCES memory_pages(id) ON DELETE SET NULL,
 revision INTEGER NOT NULL CHECK(revision >= 1),
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL,
 created_by TEXT NOT NULL REFERENCES users(id),
 updated_by TEXT NOT NULL REFERENCES users(id),
 key_hash TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 UNIQUE(workspace_id, key_hash));
CREATE INDEX IF NOT EXISTS memory_action_workspace ON memory_actions(workspace_id, status, id);
CREATE TABLE IF NOT EXISTS memory_page_topics (
 page_id TEXT NOT NULL REFERENCES memory_pages(id) ON DELETE CASCADE,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 name TEXT NOT NULL,
 name_hash TEXT NOT NULL,
 PRIMARY KEY (page_id, name_hash));
CREATE INDEX IF NOT EXISTS memory_page_topic_workspace ON memory_page_topics(workspace_id, name_hash, page_id);
CREATE TABLE IF NOT EXISTS memory_links (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 left_id TEXT NOT NULL REFERENCES memory_pages(id) ON DELETE CASCADE,
 right_id TEXT NOT NULL REFERENCES memory_pages(id) ON DELETE CASCADE,
 created INTEGER NOT NULL,
 created_by TEXT NOT NULL REFERENCES users(id),
 key_hash TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 UNIQUE(workspace_id, left_id, right_id),
 UNIQUE(workspace_id, key_hash),
 CHECK(left_id < right_id));
CREATE INDEX IF NOT EXISTS memory_link_workspace ON memory_links(workspace_id, id);
CREATE TABLE IF NOT EXISTS memory_profiles (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 professional TEXT NOT NULL, work_style TEXT NOT NULL, communication TEXT NOT NULL,
 revision INTEGER NOT NULL, updated INTEGER NOT NULL,
 PRIMARY KEY(workspace_id,user_id));
"""

TITLE_MAX = 80
BODY_MAX = 8000
ROW_SELECT = (
    'SELECT p.*, cu.username AS created_by_username, uu.username AS updated_by_username '
    'FROM memory_pages p '
    'JOIN users cu ON cu.id=p.created_by '
    'JOIN users uu ON uu.id=p.updated_by '
)


def valid_title(value):
    return isinstance(value, str) and 1 <= len(value.strip()) <= TITLE_MAX and not re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', value)


def valid_body(value):
    return isinstance(value, str) and len(value) <= BODY_MAX and '\x00' not in value and not any(ord(ch) < 32 and ch not in '\t\n\r' for ch in value)


def title_hash(title):
    return digest(title.strip().casefold())


def view(row, include_body=True, topics=None):
    data = {
        'id': row['id'],
        'workspace_id': row['workspace_id'],
        'title': row['title'],
        'revision': row['revision'],
        'created': row['created'],
        'updated': row['updated'],
        'created_by': row['created_by_username'],
        'updated_by': row['updated_by_username'],
    }
    if include_body:
        data['body'] = row['body']
    else:
        data['preview'] = snippet(row['body'])
    if topics is not None:
        data['topics'] = list(topics)
    return data


def can_edit(role, user_id, row):
    return role in ('owner', 'admin') or row['created_by'] == user_id


def load(db, workspace_id, page_id):
    return db.execute(
        ROW_SELECT + 'WHERE p.id=? AND p.workspace_id=?',
        (page_id, workspace_id),
    ).fetchone()


def listing(db, workspace_id, cursor, limit, needle=''):
    rows = db.execute(
        ROW_SELECT + 'WHERE p.workspace_id=? ORDER BY p.id',
        (workspace_id,),
    ).fetchall()
    if needle:
        rows = [row for row in rows if needle in row['title'].casefold()]
    if cursor:
        rows = [row for row in rows if row['id'] > cursor]
    return rows[:limit]

NOTES_MAX = 2000
ACTION_STATUSES = ('open', 'done')
ACTION_ROW_SELECT = (
    'SELECT a.*, cu.username AS created_by_username, uu.username AS updated_by_username, '
    'mp.title AS memory_page_title '
    'FROM memory_actions a '
    'JOIN users cu ON cu.id=a.created_by '
    'JOIN users uu ON uu.id=a.updated_by '
    'LEFT JOIN memory_pages mp ON mp.id=a.memory_page_id '
)


def valid_notes(value):
    return isinstance(value, str) and len(value) <= NOTES_MAX and '\x00' not in value and not any(ord(ch) < 32 and ch not in '\t\n\r' for ch in value)


def valid_status(value):
    return value in ACTION_STATUSES


def valid_due_at(value):
    return value is None or (type(value) is int and 0 <= value <= 2 ** 31)


def valid_page_ref(value):
    return value is None or (isinstance(value, str) and bool(re.fullmatch(r'[0-9a-f]{32}', value)))


def action_view(row, include_notes=True):
    data = {
        'id': row['id'],
        'workspace_id': row['workspace_id'],
        'title': row['title'],
        'status': row['status'],
        'due_at': row['due_at'],
        'memory_page_id': row['memory_page_id'],
        'memory_page_title': row['memory_page_title'],
        'revision': row['revision'],
        'created': row['created'],
        'updated': row['updated'],
        'created_by': row['created_by_username'],
        'updated_by': row['updated_by_username'],
    }
    if include_notes:
        data['notes'] = row['notes']
    return data


def load_action(db, workspace_id, action_id):
    return db.execute(
        ACTION_ROW_SELECT + 'WHERE a.id=? AND a.workspace_id=?',
        (action_id, workspace_id),
    ).fetchone()


def action_listing(db, workspace_id, cursor, limit, needle='', status=''):
    rows = db.execute(
        ACTION_ROW_SELECT + 'WHERE a.workspace_id=? ORDER BY a.id',
        (workspace_id,),
    ).fetchall()
    if status:
        rows = [row for row in rows if row['status'] == status]
    if needle:
        rows = [row for row in rows if needle in row['title'].casefold()]
    if cursor:
        rows = [row for row in rows if row['id'] > cursor]
    return rows[:limit]

TOPIC_MAX = 40
TOPICS_PER_PAGE = 8
MENTION_RE = re.compile(r'\[\[([^\[\]]{1,80})\]\]')
LINK_ROW_SELECT = (
    'SELECT l.*, cu.username AS created_by_username '
    'FROM memory_links l '
    'JOIN users cu ON cu.id=l.created_by '
)


def valid_topic_name(value):
    return isinstance(value, str) and 1 <= len(value.strip()) <= TOPIC_MAX and not re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', value)


def normalize_topics(value):
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > TOPICS_PER_PAGE:
        return None
    names, seen = [], set()
    for item in value:
        if not valid_topic_name(item):
            return None
        name = item.strip()
        key = name.casefold()
        if key in seen:
            continue
        seen.add(key)
        names.append(name)
    return names


def topics_for(db, page_ids):
    grouped = {page_id: [] for page_id in page_ids}
    if not page_ids:
        return grouped
    rows = db.execute(
        'SELECT page_id, name FROM memory_page_topics WHERE page_id IN (%s) ORDER BY name COLLATE NOCASE, name'
        % ','.join('?' * len(page_ids)),
        tuple(page_ids),
    ).fetchall()
    for row in rows:
        grouped.setdefault(row['page_id'], []).append(row['name'])
    return grouped


def decorate(db, row, include_body=True):
    if row is None:
        return None
    return view(row, include_body=include_body, topics=topics_for(db, [row['id']]).get(row['id'], []))


def decorate_many(db, rows, include_body=False):
    grouped = topics_for(db, [row['id'] for row in rows])
    return [view(row, include_body=include_body, topics=grouped.get(row['id'], [])) for row in rows]


def replace_topics(db, workspace_id, page_id, names):
    db.execute('DELETE FROM memory_page_topics WHERE page_id=?', (page_id,))
    for name in names:
        db.execute(
            'INSERT INTO memory_page_topics(page_id, workspace_id, name, name_hash) VALUES(?,?,?,?)',
            (page_id, workspace_id, name, digest(name.casefold())),
        )


def mention_titles(body):
    titles, seen = [], set()
    for raw in MENTION_RE.findall(body or ''):
        title = raw.strip()
        if not title:
            continue
        key = title.casefold()
        if key in seen:
            continue
        seen.add(key)
        titles.append(title)
    return titles


def link_pair(first, second):
    if not first or not second or first == second:
        return None
    return (first, second) if first < second else (second, first)


def load_link(db, workspace_id, link_id):
    return db.execute(
        LINK_ROW_SELECT + 'WHERE l.id=? AND l.workspace_id=?',
        (link_id, workspace_id),
    ).fetchone()


def link_view(row):
    return {
        'id': row['id'],
        'workspace_id': row['workspace_id'],
        'source': row['left_id'],
        'target': row['right_id'],
        'kind': 'manual',
        'created': row['created'],
        'created_by': row['created_by_username'],
    }


def can_edit_link(role, user_id, row):
    return role in ('owner', 'admin') or row['created_by'] == user_id


def graph(db, workspace_id):
    pages = listing(db, workspace_id, cursor='', limit=10_000)
    nodes = decorate_many(db, pages, include_body=False)
    by_id = {row['id']: row for row in pages}
    by_title = {}
    for row in pages:
        by_title.setdefault(row['title'].casefold(), row['id'])
    pairs = {}
    for row in pages:
        for title in mention_titles(row['body']):
            target = by_title.get(title.casefold())
            pair = link_pair(row['id'], target)
            if not pair:
                continue
            pairs[pair] = {'id': None, 'source': pair[0], 'target': pair[1], 'kind': 'mention'}
    for row in db.execute(
        LINK_ROW_SELECT + 'WHERE l.workspace_id=? ORDER BY l.id',
        (workspace_id,),
    ).fetchall():
        if row['left_id'] in by_id and row['right_id'] in by_id:
            pairs[(row['left_id'], row['right_id'])] = {
                'id': row['id'], 'source': row['left_id'], 'target': row['right_id'], 'kind': 'manual',
            }
    edges = [pairs[key] for key in sorted(pairs)]
    topic_index = {}
    for node in nodes:
        for name in node['topics']:
            bucket = topic_index.setdefault(name.casefold(), {'name': name, 'pages': []})
            bucket['pages'].append({'id': node['id'], 'title': node['title']})
    topics = []
    for key in sorted(topic_index):
        item = topic_index[key]
        topics.append({'name': item['name'], 'pages': item['pages'], 'page_count': len(item['pages'])})
    return {
        'nodes': nodes,
        'edges': edges,
        'topics': topics,
        'counts': {'nodes': len(nodes), 'edges': len(edges), 'topics': len(topics)},
    }
