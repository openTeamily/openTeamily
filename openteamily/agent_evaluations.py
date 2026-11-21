"""Local agent evaluation storage and weighted scoring.

This module persists evaluation suites, cases, runs, and per-case results in
the management SQLite database and computes weighted aggregate scores. It is
deliberately local and offline: callers supply input, expected output, and the
agent output. The module does not call an agent, invoke a model, judge output,
compare text, execute code, or train anything. Scores are caller-supplied
numbers in the closed interval 0..1; this module only stores, weights, and
aggregates them.

Each function receives an open database connection, a workspace id, and an
explicit timestamp unless noted. Every query is parameterized and scoped by
workspace. The only caller-identity check implemented here is the owner check
in :func:`delete_suite`; other authorization remains the API layer's job.
"""
import math
import sqlite3
import time
from uuid import uuid4


SCHEMA = '''
CREATE TABLE IF NOT EXISTS eval_suites (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 agent_id TEXT NOT NULL,
 name TEXT NOT NULL,
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL,
 UNIQUE(workspace_id, agent_id, name));
CREATE INDEX IF NOT EXISTS eval_suite_workspace_agent
 ON eval_suites(workspace_id, agent_id, id);
CREATE TABLE IF NOT EXISTS eval_cases (
 id TEXT PRIMARY KEY,
 suite_id TEXT NOT NULL REFERENCES eval_suites(id) ON DELETE CASCADE,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 name TEXT NOT NULL,
 input TEXT NOT NULL,
 expected TEXT NOT NULL,
 weight REAL NOT NULL CHECK(weight > 0),
 created INTEGER NOT NULL,
 UNIQUE(suite_id, name));
CREATE INDEX IF NOT EXISTS eval_case_suite ON eval_cases(suite_id, id);
CREATE INDEX IF NOT EXISTS eval_case_workspace
 ON eval_cases(workspace_id, suite_id, id);
CREATE TABLE IF NOT EXISTS eval_runs (
 id TEXT PRIMARY KEY,
 suite_id TEXT NOT NULL REFERENCES eval_suites(id) ON DELETE CASCADE,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
 score REAL,
 passed INTEGER CHECK(passed IN (0,1) OR passed IS NULL),
 started INTEGER NOT NULL,
 finished INTEGER,
 created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS eval_run_workspace_suite
 ON eval_runs(workspace_id, suite_id, started, id);
CREATE TABLE IF NOT EXISTS eval_results (
 id TEXT PRIMARY KEY,
 run_id TEXT NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
 case_id TEXT NOT NULL REFERENCES eval_cases(id) ON DELETE CASCADE,
 output TEXT NOT NULL,
 score REAL NOT NULL CHECK(score >= 0 AND score <= 1),
 passed INTEGER NOT NULL CHECK(passed IN (0,1)),
 notes TEXT,
 created INTEGER NOT NULL,
 UNIQUE(run_id, case_id));
CREATE INDEX IF NOT EXISTS eval_result_case ON eval_results(case_id);
'''

NAME_MAX = 80
AGENT_ID_MAX = 128
INPUT_MAX = 8000
EXPECTED_MAX = 8000
OUTPUT_MAX = 16000
NOTES_MAX = 2000
DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 100
CASE_PASS_THRESHOLD = 0.5
DEFAULT_PASS_THRESHOLD = 0.5


class NotFound(LookupError):
    """The requested workspace-scoped record does not exist."""


class DuplicateName(ValueError):
    """A suite or case name is already used in its uniqueness scope."""


class InvalidState(ValueError):
    """The run is not in a state that permits this operation."""


def ensure_schema(db):
    """Create the evaluation tables and indexes; safe to call repeatedly."""
    db.executescript(SCHEMA)


def _time(value):
    if value is None:
        return int(time.time())
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError('Timestamp must be a number')
    if not math.isfinite(value) or value < 0:
        raise ValueError('Timestamp must be a finite non-negative number')
    return int(value)


def _text(value, field, limit, allow_empty=True, multiline=True):
    if not isinstance(value, str):
        raise ValueError(field + ' must be text')
    if len(value) > limit:
        raise ValueError(field + ' is too long')
    if not allow_empty and not value.strip():
        raise ValueError(field + ' must not be empty')
    if '\x00' in value:
        raise ValueError(field + ' must not contain NUL')
    allowed_controls = '\t\n\r' if multiline else ''
    if any(ord(char) < 32 and char not in allowed_controls for char in value):
        raise ValueError(field + ' contains a control character')
    if '\x7f' in value:
        raise ValueError(field + ' contains a control character')
    try:
        value.encode('utf-8')
    except UnicodeEncodeError:
        raise ValueError(field + ' is not valid Unicode') from None
    return value


def _name(value, field, limit):
    if not isinstance(value, str):
        raise ValueError(field + ' must be text')
    normalized = value.strip()
    if not normalized or len(normalized) > limit:
        raise ValueError(field + ' must be 1-' + str(limit) + ' characters')
    return _text(normalized, field, limit, allow_empty=False, multiline=False)


def _agent_id(value):
    return _name(value, 'agent_id', AGENT_ID_MAX)


def _workspace(db, workspace_id):
    if not isinstance(workspace_id, str) or not workspace_id:
        raise NotFound('Workspace not found')
    row = db.execute(
        'SELECT * FROM workspaces WHERE id=?', (workspace_id,)).fetchone()
    if row is None:
        raise NotFound('Workspace not found')
    return row


def _suite(db, workspace_id, suite_id):
    row = db.execute(
        'SELECT * FROM eval_suites WHERE id=? AND workspace_id=?',
        (suite_id, workspace_id)).fetchone()
    if row is None:
        raise NotFound('Evaluation suite not found')
    return row


def _case(db, workspace_id, case_id):
    row = db.execute(
        'SELECT * FROM eval_cases WHERE id=? AND workspace_id=?',
        (case_id, workspace_id)).fetchone()
    if row is None:
        raise NotFound('Evaluation case not found')
    return row


def _run(db, workspace_id, run_id):
    row = db.execute(
        'SELECT * FROM eval_runs WHERE id=? AND workspace_id=?',
        (run_id, workspace_id)).fetchone()
    if row is None:
        raise NotFound('Evaluation run not found')
    return row


def _unit(value, field):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(field + ' must be a number between 0 and 1')
    if not math.isfinite(value) or not 0 <= value <= 1:
        raise ValueError(field + ' must be a number between 0 and 1')
    return float(value)


def _weight(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError('weight must be a number greater than 0')
    if not math.isfinite(value) or value <= 0:
        raise ValueError('weight must be a finite number greater than 0')
    return float(value)


def _passed(value, score):
    if value is None:
        return 1 if score >= CASE_PASS_THRESHOLD else 0
    if isinstance(value, bool):
        return 1 if value else 0
    if isinstance(value, int) and value in (0, 1):
        return value
    raise ValueError('passed must be a boolean when supplied')


def _page(cursor, limit):
    if cursor is None:
        cursor = ''
    if not isinstance(cursor, str) or len(cursor) > 64:
        raise ValueError('cursor must be text')
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_PAGE_SIZE:
        raise ValueError('limit must be between 1 and ' + str(MAX_PAGE_SIZE))
    return cursor, limit


def _suite_view(row):
    return {key: row[key] for key in (
        'id', 'workspace_id', 'agent_id', 'name', 'created', 'updated')}


def _case_view(row):
    return {key: row[key] for key in (
        'id', 'suite_id', 'workspace_id', 'name', 'input', 'expected',
        'weight', 'created')}


def _run_view(row):
    return {
        'id': row['id'],
        'suite_id': row['suite_id'],
        'workspace_id': row['workspace_id'],
        'status': row['status'],
        'score': row['score'],
        'passed': None if row['passed'] is None else bool(row['passed']),
        'started': row['started'],
        'finished': row['finished'],
        'created': row['created'],
    }


def _result_view(row):
    data = {
        'id': row['id'],
        'run_id': row['run_id'],
        'case_id': row['case_id'],
        'output': row['output'],
        'score': row['score'],
        'passed': bool(row['passed']),
        'notes': row['notes'],
        'created': row['created'],
    }
    keys = row.keys()
    if 'case_name' in keys:
        data['case_name'] = row['case_name']
    if 'weight' in keys:
        data['weight'] = row['weight']
    return data


def create_suite(db, workspace_id, agent_id, name, now=None):
    """Create a named suite for one agent in one workspace."""
    _workspace(db, workspace_id)
    agent_id = _agent_id(agent_id)
    name = _name(name, 'name', NAME_MAX)
    now = _time(now)
    suite_id = uuid4().hex
    try:
        db.execute(
            'INSERT INTO eval_suites VALUES(?,?,?,?,?,?)',
            (suite_id, workspace_id, agent_id, name, now, now))
    except sqlite3.IntegrityError:
        raise DuplicateName(
            'A suite with this name already exists for the agent') from None
    return _suite_view(_suite(db, workspace_id, suite_id))


def add_case(db, workspace_id, suite_id, name, input, expected, weight=1.0,
             now=None):
    """Add a weighted case to an existing suite."""
    _suite(db, workspace_id, suite_id)
    name = _name(name, 'name', NAME_MAX)
    input = _text(input, 'input', INPUT_MAX)
    expected = _text(expected, 'expected', EXPECTED_MAX)
    weight = _weight(weight)
    now = _time(now)
    case_id = uuid4().hex
    try:
        db.execute(
            'INSERT INTO eval_cases VALUES(?,?,?,?,?,?,?,?)',
            (case_id, suite_id, workspace_id, name, input, expected, weight, now))
    except sqlite3.IntegrityError:
        raise DuplicateName(
            'A case with this name already exists in the suite') from None
    db.execute(
        'UPDATE eval_suites SET updated=? WHERE id=? AND workspace_id=?',
        (now, suite_id, workspace_id))
    return _case_view(_case(db, workspace_id, case_id))


def list_suites(db, workspace_id, agent_id=None, cursor=None, limit=DEFAULT_PAGE_SIZE):
    """List suites in workspace order by id, optionally filtered by agent."""
    _workspace(db, workspace_id)
    cursor, limit = _page(cursor, limit)
    query = 'SELECT * FROM eval_suites WHERE workspace_id=?'
    parameters = [workspace_id]
    if agent_id is not None:
        agent_id = _agent_id(agent_id)
        query += ' AND agent_id=?'
        parameters.append(agent_id)
    query += ' AND id>? ORDER BY id LIMIT ?'
    parameters.extend((cursor, limit))
    rows = db.execute(query, parameters).fetchall()
    items = [_suite_view(row) for row in rows]
    return {'items': items,
            'cursor': items[-1]['id'] if len(items) == limit else None}


def list_cases(db, workspace_id, suite_id, cursor=None, limit=DEFAULT_PAGE_SIZE):
    """List cases in a suite in stable id order with keyset paging."""
    _suite(db, workspace_id, suite_id)
    cursor, limit = _page(cursor, limit)
    rows = db.execute(
        'SELECT * FROM eval_cases WHERE workspace_id=? AND suite_id=? AND id>? '
        'ORDER BY id LIMIT ?',
        (workspace_id, suite_id, cursor, limit)).fetchall()
    items = [_case_view(row) for row in rows]
    return {'items': items,
            'cursor': items[-1]['id'] if len(items) == limit else None}


def start_run(db, workspace_id, suite_id, now=None):
    """Start a running evaluation run for a suite."""
    _suite(db, workspace_id, suite_id)
    now = _time(now)
    run_id = uuid4().hex
    db.execute(
        'INSERT INTO eval_runs VALUES(?,?,?,?,?,?,?,?,?)',
        (run_id, suite_id, workspace_id, 'running', None, None, now, None, now))
    return _run_view(_run(db, workspace_id, run_id))


def record_result(db, workspace_id, run_id, case_id, output, score, now=None,
                  passed=None, notes=None):
    """Insert or replace one case result for a running run.

    ``passed`` defaults to ``score >= CASE_PASS_THRESHOLD``. Re-recording the
    same case replaces output, score, passed, and notes without changing the
    result id or original creation time.
    """
    run = _run(db, workspace_id, run_id)
    if run['status'] != 'running':
        raise InvalidState('Results can only be recorded for a running run')
    case = _case(db, workspace_id, case_id)
    if case['suite_id'] != run['suite_id']:
        raise NotFound('Evaluation case does not belong to this run suite')
    output = _text(output, 'output', OUTPUT_MAX)
    score = _unit(score, 'score')
    passed = _passed(passed, score)
    if notes is not None:
        notes = _text(notes, 'notes', NOTES_MAX)
    now = _time(now)
    result_id = uuid4().hex
    db.execute(
        'INSERT INTO eval_results '
        '(id,run_id,case_id,output,score,passed,notes,created) '
        'VALUES(?,?,?,?,?,?,?,?) '
        'ON CONFLICT(run_id,case_id) DO UPDATE SET '
        'output=excluded.output, score=excluded.score, '
        'passed=excluded.passed, notes=excluded.notes',
        (result_id, run_id, case_id, output, score, passed, notes, now))
    row = db.execute(
        'SELECT r.*, c.name AS case_name, c.weight AS weight '
        'FROM eval_results r JOIN eval_cases c ON c.id=r.case_id '
        'WHERE r.run_id=? AND r.case_id=?',
        (run_id, case_id)).fetchone()
    return _result_view(row)


def finish_run(db, workspace_id, run_id, now=None, threshold=DEFAULT_PASS_THRESHOLD):
    """Finish a running run, storing its weighted score and threshold result.

    The aggregate is ``sum(case.weight * result.score) / sum(case.weight)``
    over every case in the suite. Cases without a result contribute a zero
    score. The stored score is rounded to six decimal places. Finishing an
    already finished or failed run is rejected, not treated as idempotent.
    """
    run = _run(db, workspace_id, run_id)
    if run['status'] != 'running':
        raise InvalidState('Only a running run can be finished')
    threshold = _unit(threshold, 'threshold')
    now = _time(now)
    rows = db.execute(
        'SELECT c.weight AS weight, r.score AS score '
        'FROM eval_cases c '
        'LEFT JOIN eval_results r ON r.case_id=c.id AND r.run_id=? '
        'WHERE c.suite_id=? AND c.workspace_id=? ORDER BY c.id',
        (run_id, run['suite_id'], workspace_id)).fetchall()
    total = 0.0
    weight_sum = 0.0
    result_count = 0
    for row in rows:
        weight = float(row['weight'])
        weight_sum += weight
        if row['score'] is not None:
            total += weight * float(row['score'])
            result_count += 1
    score = round(total / weight_sum, 6) if weight_sum else 0.0
    passed = score >= threshold
    cursor = db.execute(
        'UPDATE eval_runs SET status=?, score=?, passed=?, finished=? '
        'WHERE id=? AND workspace_id=? AND status=?',
        ('completed', score, 1 if passed else 0, now, run_id, workspace_id,
         'running'))
    if cursor.rowcount != 1:
        raise InvalidState('Only a running run can be finished')
    data = _run_view(_run(db, workspace_id, run_id))
    data.update({
        'case_count': len(rows),
        'result_count': result_count,
        'threshold': threshold,
    })
    return data


def fail_run(db, workspace_id, run_id, now=None):
    """Mark a running run as failed; failed runs never gain a score."""
    run = _run(db, workspace_id, run_id)
    if run['status'] != 'running':
        raise InvalidState('Only a running run can be failed')
    now = _time(now)
    cursor = db.execute(
        'UPDATE eval_runs SET status=?, finished=? '
        'WHERE id=? AND workspace_id=? AND status=?',
        ('failed', now, run_id, workspace_id, 'running'))
    if cursor.rowcount != 1:
        raise InvalidState('Only a running run can be failed')
    return _run_view(_run(db, workspace_id, run_id))


def get_run(db, workspace_id, run_id):
    """Return one run plus its stored results in stable case order."""
    run = _run(db, workspace_id, run_id)
    rows = db.execute(
        'SELECT r.*, c.name AS case_name, c.weight AS weight '
        'FROM eval_results r JOIN eval_cases c ON c.id=r.case_id '
        'WHERE r.run_id=? ORDER BY c.id',
        (run_id,)).fetchall()
    case_count = db.execute(
        'SELECT COUNT(*) FROM eval_cases WHERE suite_id=? AND workspace_id=?',
        (run['suite_id'], workspace_id)).fetchone()[0]
    data = _run_view(run)
    data['results'] = [_result_view(row) for row in rows]
    data['case_count'] = case_count
    data['result_count'] = len(rows)
    return data


def compare_runs(db, workspace_id, run_a, run_b):
    """Compare two runs of the same suite.

    Per-case deltas are ``run_b - run_a`` and are ``None`` when either run
    lacks a result for that case. The aggregate delta uses the stored run
    scores and is ``None`` until both runs have a score.
    """
    first = _run(db, workspace_id, run_a)
    second = _run(db, workspace_id, run_b)
    if first['suite_id'] != second['suite_id']:
        raise ValueError('Runs must belong to the same evaluation suite')
    cases = db.execute(
        'SELECT id, name, weight FROM eval_cases '
        'WHERE suite_id=? AND workspace_id=? ORDER BY id',
        (first['suite_id'], workspace_id)).fetchall()
    results_a = {
        row['case_id']: row for row in db.execute(
            'SELECT * FROM eval_results WHERE run_id=?', (run_a,)).fetchall()}
    results_b = {
        row['case_id']: row for row in db.execute(
            'SELECT * FROM eval_results WHERE run_id=?', (run_b,)).fetchall()}
    items = []
    for case in cases:
        a = results_a.get(case['id'])
        b = results_b.get(case['id'])
        delta = None
        if a is not None and b is not None:
            delta = round(float(b['score']) - float(a['score']), 6)
        items.append({
            'case_id': case['id'],
            'case_name': case['name'],
            'weight': case['weight'],
            'score_a': None if a is None else a['score'],
            'score_b': None if b is None else b['score'],
            'passed_a': None if a is None else bool(a['passed']),
            'passed_b': None if b is None else bool(b['passed']),
            'delta': delta,
        })
    aggregate = None
    if first['score'] is not None and second['score'] is not None:
        aggregate = round(float(second['score']) - float(first['score']), 6)
    return {
        'workspace_id': workspace_id,
        'suite_id': first['suite_id'],
        'run_a': _run_view(first),
        'run_b': _run_view(second),
        'cases': items,
        'aggregate_delta': aggregate,
    }


def delete_suite(db, workspace_id, suite_id, actor_id):
    """Delete a suite and its cases, runs, and results.

    Only the workspace owner may delete; ``actor_id`` is the caller's user id.
    """
    workspace = _workspace(db, workspace_id)
    if not isinstance(actor_id, str) or workspace['owner_id'] != actor_id:
        raise PermissionError('Only the workspace owner may delete a suite')
    _suite(db, workspace_id, suite_id)
    db.execute(
        'DELETE FROM eval_results WHERE run_id IN '
        '(SELECT id FROM eval_runs WHERE suite_id=? AND workspace_id=?)',
        (suite_id, workspace_id))
    db.execute(
        'DELETE FROM eval_runs WHERE suite_id=? AND workspace_id=?',
        (suite_id, workspace_id))
    db.execute(
        'DELETE FROM eval_cases WHERE suite_id=? AND workspace_id=?',
        (suite_id, workspace_id))
    db.execute(
        'DELETE FROM eval_suites WHERE id=? AND workspace_id=?',
        (suite_id, workspace_id))
    return {'id': suite_id, 'deleted': True}
