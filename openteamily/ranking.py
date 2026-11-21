"""Deterministic, explainable ranking for Discover works and agents.

Self-written for OpenTeamily; no upstream, Teamily, FlyBot or Bot Social source
and no copied ranking service. This is a deterministic heuristic, not a
recommendation system: there is no ML model, no personalization model, no
network access, no database access and no hidden state. The caller supplies the
candidate items, the current time, optional follow/seen sets and weights.

Scope and semantics
-------------------
Scores combine a normalized recency term, a logarithmic engagement term and an
optional follow boost. Missing or malformed optional engagement metrics are
treated as zero. For works, engagement uses likes, collects and comments; for
agents it uses likes, installs and uses.

Recency is ``0.5 ** (age / DEFAULT_RECENCY_HALF_LIFE)`` where
``age = max(0, now - created)``. A future timestamp therefore has recency 1.0
and never produces a bonus above 1.0.

Weights are non-negative, bounded and restricted to the documented keys.
``seen_ids`` is a demotion, never an exclusion: the final score is multiplied
by ``seen_penalty`` (0.0 through 1.0), and the item remains eligible. Author
diversity is a hard cap on how many items from one author may appear in the
returned top list. Because the cap is hard, a request can return fewer than
``limit`` items when every remaining candidate's author is already capped.

Tie-breaking is deterministic: score descending, then ``created`` descending,
then item id ascending. Duplicate item ids are rejected.

``paginate`` uses an opaque, URL-safe base64 offset cursor. It is opaque for API
ergonomics and is not signed or tamper-proof; callers must pass the ranked list
that produced the cursor and must not mutate it between pages.
"""
import base64
import binascii
import math
from collections.abc import Mapping
from types import MappingProxyType

DEFAULT_RECENCY_HALF_LIFE = 7 * 24 * 60 * 60
MAX_LIMIT = 100
MAX_AUTHOR_CAP = 100
MAX_WEIGHT = 1000.0

DEFAULT_WORK_WEIGHTS = MappingProxyType({
    'recency': 1.0,
    'engagement': 1.0,
    'likes': 1.0,
    'collects': 2.0,
    'comments': 1.5,
    'follow': 1.0,
    'seen_penalty': 0.25,
    'author_cap': 3,
})

DEFAULT_AGENT_WEIGHTS = MappingProxyType({
    'recency': 1.0,
    'engagement': 1.0,
    'likes': 1.5,
    'installs': 2.0,
    'uses': 1.0,
    'follow': 1.0,
    'seen_penalty': 0.25,
    'author_cap': 3,
})

_WORK_METRICS = (('likes', 'likes'), ('collects', 'collects'), ('comments', 'comments'))
_AGENT_METRICS = (('likes', 'likes'), ('installs', 'installs'), ('uses', 'uses'))
_CURSOR_PREFIX = 'otr1:'
_REASON_KEYS = (
    'recency', 'engagement', 'engagement_value', 'follow', 'base',
    'seen_penalty', 'score',
)


def _require_text(value, name):
    if not isinstance(value, str) or not value.strip():
        raise ValueError('%s must be a non-empty string' % name)
    return value


def _number(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError('%s must be a finite number' % name)
    number = float(value)
    if not math.isfinite(number):
        raise ValueError('%s must be a finite number' % name)
    return number


def _validate_limit(limit):
    if isinstance(limit, bool) or not isinstance(limit, int):
        raise ValueError('limit must be an integer between 1 and %d' % MAX_LIMIT)
    if limit < 1 or limit > MAX_LIMIT:
        raise ValueError('limit must be an integer between 1 and %d' % MAX_LIMIT)
    return limit


def _validate_weights(weights, defaults):
    resolved = dict(defaults)
    if weights is None:
        return resolved
    if not isinstance(weights, Mapping):
        raise ValueError('weights must be a mapping')
    for key, value in weights.items():
        if key not in defaults:
            raise ValueError('unknown weight: %r' % (key,))
        if key == 'author_cap':
            if (isinstance(value, bool) or not isinstance(value, int)
                    or value < 1 or value > MAX_AUTHOR_CAP):
                raise ValueError('author_cap must be an integer between 1 and %d'
                                 % MAX_AUTHOR_CAP)
            resolved[key] = value
            continue
        number = _number(value, 'weight %s' % key)
        if number < 0:
            raise ValueError('weights must be non-negative')
        if number > MAX_WEIGHT:
            raise ValueError('weight %s exceeds %s' % (key, MAX_WEIGHT))
        if key == 'seen_penalty' and number > 1.0:
            raise ValueError('seen_penalty must be between 0 and 1')
        resolved[key] = number
    return resolved


def _id_set(value, name):
    if value is None:
        return frozenset()
    if isinstance(value, str):
        candidates = (value,)
    else:
        try:
            candidates = list(value)
        except TypeError:
            raise ValueError('%s must be an iterable of ids' % name) from None
    result = set()
    for candidate in candidates:
        result.add(_require_text(candidate, name + ' entry'))
    return frozenset(result)


def _get(item, key, default=None):
    if isinstance(item, Mapping):
        return item.get(key, default)
    try:
        return item[key]
    except (KeyError, IndexError, TypeError):
        return default


def _copy_item(item):
    if isinstance(item, Mapping):
        return dict(item)
    if hasattr(item, 'keys'):
        try:
            return {key: item[key] for key in item.keys()}
        except (KeyError, IndexError, TypeError):
            raise ValueError('item must be a mapping') from None
    raise ValueError('item must be a mapping')


def _author(item, fields):
    for field in fields:
        value = _get(item, field)
        if value is not None:
            return _require_text(value, field)
    raise ValueError('item is missing a required author field: %s' % '/'.join(fields))


def _metric(item, key):
    value = _get(item, key, 0)
    if value is None or isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0.0
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        return 0.0
    return number


def _rank(items, now, weights, defaults, following, seen_ids, limit,
          author_fields, metric_keys):
    now_value = _number(now, 'now')
    resolved = _validate_weights(weights, defaults)
    resolved_limit = _validate_limit(limit)
    following_set = _id_set(following, 'following ids')
    seen_set = _id_set(seen_ids, 'seen_ids')
    if items is None:
        source = []
    else:
        try:
            source = list(items)
        except TypeError:
            raise ValueError('items must be an iterable') from None

    candidates = []
    item_ids = set()
    for item in source:
        item_id = _require_text(_get(item, 'id'), 'id')
        if item_id in item_ids:
            raise ValueError('duplicate item id: %r' % item_id)
        item_ids.add(item_id)
        author = _author(item, author_fields)
        created = _number(_get(item, 'created'), 'created')
        result = _copy_item(item)

        age = max(0.0, now_value - created)
        recency = 0.5 ** (age / DEFAULT_RECENCY_HALF_LIFE)
        weighted_counts = 0.0
        for item_key, weight_key in metric_keys:
            weighted_counts += resolved[weight_key] * _metric(item, item_key)
        engagement_value = math.log1p(weighted_counts)

        recency_component = resolved['recency'] * recency
        engagement_component = resolved['engagement'] * engagement_value
        follow_component = resolved['follow'] if author in following_set else 0.0
        base = recency_component + engagement_component + follow_component
        seen_penalty = resolved['seen_penalty'] if item_id in seen_set else 1.0
        score = base * seen_penalty

        result['score'] = score
        result['reasons'] = {
            'recency': recency_component,
            'engagement': engagement_component,
            'engagement_value': engagement_value,
            'follow': follow_component,
            'base': base,
            'seen_penalty': seen_penalty,
            'score': score,
        }
        candidates.append((score, created, item_id, author, result))

    candidates.sort(key=lambda row: (-row[0], -row[1], row[2]))

    author_cap = resolved['author_cap']
    author_counts = {}
    ranked = []
    for _score, _created, _item_id, author, result in candidates:
        count = author_counts.get(author, 0)
        if count >= author_cap:
            continue
        author_counts[author] = count + 1
        ranked.append(result)
        if len(ranked) >= resolved_limit:
            break
    return ranked


def rank_works(items, now, weights=None, following_authors=None,
               seen_ids=None, limit=50):
    """Rank Discover work items with the documented deterministic heuristic.

    Input items need ``id``, ``author_id`` and ``created``. ``title``, ``kind``,
    ``likes``, ``collects`` and ``comments`` are optional; missing metrics are
    zero. Each result is a shallow copy of the item plus ``score`` and
    ``reasons``.
    """
    return _rank(items, now, weights, DEFAULT_WORK_WEIGHTS, following_authors,
                 seen_ids, limit, ('author_id', 'creator_id'), _WORK_METRICS)


def rank_agents(items, now, weights=None, following_creators=None,
                seen_ids=None, limit=50):
    """Rank agent directory items with the same deterministic heuristic.

    Input items need ``id``, ``created`` and a creator (``creator_id`` or the
    ``author_id`` fallback). ``name``, ``title``, ``likes``, ``installs`` and
    ``uses`` are optional; missing metrics are zero.
    """
    return _rank(items, now, weights, DEFAULT_AGENT_WEIGHTS, following_creators,
                 seen_ids, limit, ('creator_id', 'author_id'), _AGENT_METRICS)


def explain(ranked_item):
    """Return a copy of a ranked item's score components."""
    if not isinstance(ranked_item, Mapping):
        raise ValueError('ranked item must be a mapping')
    reasons = ranked_item.get('reasons')
    if not isinstance(reasons, Mapping):
        raise ValueError('ranked item has no reasons')
    for key in _REASON_KEYS:
        if key not in reasons:
            raise ValueError('ranked item reasons are missing %s' % key)
    return dict(reasons)


def _encode_cursor(offset):
    raw = _CURSOR_PREFIX + str(offset)
    return base64.urlsafe_b64encode(raw.encode('ascii')).decode('ascii').rstrip('=')


def _decode_cursor(cursor):
    if cursor is None or cursor == '':
        return 0
    if not isinstance(cursor, str):
        raise ValueError('invalid cursor')
    try:
        padded = cursor + '=' * (-len(cursor) % 4)
        raw = base64.urlsafe_b64decode(padded.encode('ascii')).decode('ascii')
    except (ValueError, UnicodeError, binascii.Error):
        raise ValueError('invalid cursor') from None
    if not raw.startswith(_CURSOR_PREFIX):
        raise ValueError('invalid cursor')
    digits = raw[len(_CURSOR_PREFIX):]
    if not digits.isdigit():
        raise ValueError('invalid cursor')
    return int(digits)


def paginate(ranked, cursor, limit):
    """Return an offset-cursor page over an already ranked list.

    The result is ``{'items', 'next_cursor', 'cursor'}``. ``cursor`` echoes the
    supplied cursor (``None`` at the start), while ``next_cursor`` is the opaque
    cursor for the next page and is ``None`` after the final page.
    """
    resolved_limit = _validate_limit(limit)
    if ranked is None:
        source = []
    else:
        try:
            source = list(ranked)
        except TypeError:
            raise ValueError('ranked must be an iterable') from None
    offset = _decode_cursor(cursor)
    page = source[offset:offset + resolved_limit]
    next_offset = offset + len(page)
    next_cursor = _encode_cursor(next_offset) if next_offset < len(source) else None
    echoed = None if cursor is None or cursor == '' else cursor
    return {'items': page, 'next_cursor': next_cursor, 'cursor': echoed}
