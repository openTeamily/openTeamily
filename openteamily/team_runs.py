"""Team task runs: a member-started multi-agent step graph (DAG).

Self-written for OpenTeamily; no upstream or Teamily source. A workspace member
describes one goal and 2-8 steps; each step names a workspace agent, an
instruction and earlier steps it depends on (only earlier steps, so the graph is
acyclic by construction). A step becomes runnable once all of its dependencies
succeeded; it then queues one ordinary runtime ``infer`` task through the same
agent/runtime selection the private agent chat uses, with the goal and the
dependencies' outputs in its prompt. A failed step blocks its dependants while
independent branches keep going. Members can cancel a run (queued/claimed
runtime tasks are cancelled), retry a failed step, and save a finished step's
output to the works library. Progress is reconciled on read; there is no hidden
scheduler, no tool or Composio grant, and the #124 group-reply protocol is not
used or changed. Runs are private to the member who started them.
"""
import json
import re
from uuid import uuid4

from . import agent_work_schema, agents, artifacts, conversations, members, runtime_connect
from .security import digest

SCHEMA = agent_work_schema.TEAM_RUNS

MIN_STEPS, MAX_STEPS = 2, 8
TITLE_MAX, GOAL_MAX, INSTRUCTION_MAX = 80, 2000, 1000
OUTPUT_IN_PROMPT = 900
MAX_RUNS_PER_USER = 50
MAX_ACTIVE_PER_USER = 5
MAX_ATTEMPTS = 3
ACTIVE = ('queued', 'running')
PATH = re.compile(r'/v1/workspaces/([0-9a-f]{32})/team-runs(?:/([0-9a-f]{32})'
                  r'(?:/(cancel|remove)|/steps/([0-7])/(retry|artifact))?)?')


def _text(value, limit):
    return isinstance(value, str) and value.strip() != '' and len(value) <= limit and '\x00' not in value


def parse_steps(db, workspace_id, value):
    if not isinstance(value, list) or not MIN_STEPS <= len(value) <= MAX_STEPS:
        return None, 'Provide 2-8 steps'
    steps = []
    for index, item in enumerate(value):
        if not isinstance(item, dict) or set(item) - {'agent_id', 'instruction', 'depends_on'}:
            return None, 'Each step needs agent_id, instruction and depends_on'
        agent_id, instruction, depends = item.get('agent_id'), item.get('instruction'), item.get('depends_on', [])
        if not isinstance(agent_id, str) or not re.fullmatch(r'[0-9a-f]{32}', agent_id):
            return None, 'Choose an agent for every step'
        agent = agents.load(db, workspace_id, agent_id)
        if agent is None or agent['archived'] == 1:
            return None, 'Choose an active workspace agent for every step'
        if not _text(instruction, INSTRUCTION_MAX):
            return None, 'Each step needs an instruction of at most 1000 characters'
        if (not isinstance(depends, list) or len(depends) > index
                or any(type(d) is not int or not 0 <= d < index for d in depends)
                or len(set(depends)) != len(depends)):
            return None, 'A step may only depend on earlier steps'
        steps.append({'agent': agent, 'instruction': instruction.strip(), 'depends': sorted(depends)})
    return steps, None


def load_run(db, workspace_id, user_id, run_id):
    return db.execute('SELECT * FROM team_runs WHERE id=? AND workspace_id=? AND user_id=?',
                      (run_id, workspace_id, user_id)).fetchone()


def load_steps(db, run_id):
    return db.execute('SELECT * FROM team_run_steps WHERE run_id=? ORDER BY position', (run_id,)).fetchall()


def step_view(row):
    return {'position': row['position'], 'agent_id': row['agent_id'], 'agent_name': row['agent_name'],
            'instruction': row['instruction'], 'depends_on': json.loads(row['depends']),
            'status': row['status'], 'error_code': row['error_code'], 'output': row['output'],
            'attempts': row['attempts'], 'started': row['started'], 'finished': row['finished']}


def stages(steps):
    """Depth of each step in the graph: 1 + the deepest dependency."""
    depth = {}
    for step in steps:
        deps = json.loads(step['depends'])
        depth[step['position']] = 1 + max((depth[d] for d in deps), default=0)
    return depth


def run_view(db, row, include_steps=True):
    steps = load_steps(db, row['id'])
    done = sum(1 for step in steps if step['status'] == 'succeeded')
    data = {'id': row['id'], 'title': row['title'], 'goal': row['goal'], 'status': row['status'],
            'created': row['created'], 'updated': row['updated'],
            'progress': {'succeeded': done, 'total': len(steps)}}
    if include_steps:
        depth = stages(steps)
        data['steps'] = [step_view(step) | {'stage': depth[step['position']]} for step in steps]
    return data


def step_prompt(db, run, step, steps):
    agent = agents.load(db, run['workspace_id'], step['agent_id'])
    if agent is None or agent['archived'] == 1:
        return None
    lines = ['团队任务目标：' + run['goal'], '你负责的步骤（第 %d 步）：%s' % (step['position'] + 1, step['instruction'])]
    deps = json.loads(step['depends'])
    if deps:
        lines.append('前序步骤的结果：')
        for position in deps:
            prior = steps[position]
            output = prior['output']
            if len(output) > OUTPUT_IN_PROMPT:
                output = output[:OUTPUT_IN_PROMPT] + '…'
            lines.append('[第 %d 步 · %s] %s' % (position + 1, prior['agent_name'], output))
    prompt = conversations.compose_prompt(agent, [], '\n'.join(lines))
    return prompt if runtime_connect.valid_prompt(prompt) else None


def set_step(db, run_id, position, **fields):
    keys = sorted(fields)
    db.execute('UPDATE team_run_steps SET ' + ', '.join(k + '=?' for k in keys) + ' WHERE run_id=? AND position=?',
               tuple(fields[k] for k in keys) + (run_id, position))


def queue_step(app, db, run, step, steps, now):
    prompt = step_prompt(db, run, step, steps)
    if prompt is None:
        set_step(db, run['id'], step['position'], status='failed', error_code='agent_unavailable', finished=now)
        return
    task_id, error_code, _dispatch = app.queue_infer_task(db, run['user_id'], now, prompt, run['workspace_id'],
                                                          step['agent_id'])
    set_step(db, run['id'], step['position'], status='queued', task_id=task_id, error_code=error_code,
             started=step['started'] or now, attempts=step['attempts'] + (1 if task_id else 0))


def reconcile(app, db, run, now):
    """Advance one run: apply finished tasks, block dependants of failures, queue runnable steps."""
    if run['status'] != 'running':
        return run
    for _ in range(MAX_STEPS + 1):
        steps = load_steps(db, run['id'])
        changed = False
        for step in steps:
            if step['status'] not in ACTIVE:
                continue
            if not step['task_id']:
                if step['error_code'] == 'no_agent':
                    queue_step(app, db, run, step, steps, now)
                    refreshed = load_steps(db, run['id'])[step['position']]
                    changed = changed or refreshed['task_id'] is not None
                continue
            task = runtime_connect.load_task(db, step['task_id'])
            if task is not None:
                task = runtime_connect.expire_task(db, task, now)
            status, error_code, text = conversations.map_task_status(task)
            if status == 'running' and step['status'] != 'running':
                set_step(db, run['id'], step['position'], status='running')
            elif status == 'succeeded':
                set_step(db, run['id'], step['position'], status='succeeded', output=text, error_code=None,
                         finished=now)
                changed = True
            elif status in ('failed', 'cancelled'):
                set_step(db, run['id'], step['position'], status='failed', error_code=error_code or 'failed',
                         finished=now)
                changed = True
        steps = load_steps(db, run['id'])
        for step in steps:
            if step['status'] != 'waiting':
                continue
            deps = [steps[d] for d in json.loads(step['depends'])]
            if any(dep['status'] in ('failed', 'blocked', 'cancelled') for dep in deps):
                set_step(db, run['id'], step['position'], status='blocked', finished=now)
                changed = True
            elif all(dep['status'] == 'succeeded' for dep in deps):
                queue_step(app, db, run, step, steps, now)
                changed = True
        if not changed:
            break
    steps = load_steps(db, run['id'])
    states = {step['status'] for step in steps}
    if not states & {'waiting', 'queued', 'running'}:
        final = 'succeeded' if states == {'succeeded'} else 'failed'
        db.execute('UPDATE team_runs SET status=?, updated=? WHERE id=?', (final, now, run['id']))
    elif any(step['finished'] == now or step['started'] == now for step in steps):
        db.execute('UPDATE team_runs SET updated=? WHERE id=?', (now, run['id']))
    return db.execute('SELECT * FROM team_runs WHERE id=?', (run['id'],)).fetchone()


def create(app, db, workspace, session, now, env, refuse):
    body = app.body(env, ['title', 'goal', 'steps'], limit=32768)
    title, goal = body.get('title'), body.get('goal')
    if not _text(title, TITLE_MAX) or not _text(goal, GOAL_MAX):
        refuse(400, 'invalid', 'Provide a title (<=80) and a goal (<=2000)')
    steps, problem = parse_steps(db, workspace['id'], body.get('steps'))
    if steps is None:
        refuse(400, 'invalid', problem)
    key = env.get('HTTP_IDEMPOTENCY_KEY', '')
    if not re.fullmatch(r'[A-Za-z0-9_-]{16,64}', key):
        refuse(400, 'invalid', 'Supply a 16–64 character Idempotency-Key')
    payload = json.dumps({'title': title.strip(), 'goal': goal.strip(),
                          'steps': [[s['agent']['id'], s['instruction'], s['depends']] for s in steps]},
                         sort_keys=True, separators=(',', ':'), ensure_ascii=False)
    key_hash, request_hash = digest('team-run:' + key), digest(payload)
    prior = db.execute('SELECT * FROM team_runs WHERE workspace_id=? AND user_id=? AND key_hash=?',
                       (workspace['id'], session['user_id'], key_hash)).fetchone()
    if prior:
        if prior['request_hash'] != request_hash:
            refuse(409, 'conflict', 'Idempotency key was used for a different request')
        return 200, {'run': run_view(db, reconcile(app, db, prior, now))}, []
    owned = db.execute('SELECT status FROM team_runs WHERE workspace_id=? AND user_id=?',
                       (workspace['id'], session['user_id'])).fetchall()
    if len(owned) >= MAX_RUNS_PER_USER:
        refuse(429, 'quota', 'Team run capacity reached; remove finished runs first')
    if sum(1 for row in owned if row['status'] == 'running') >= MAX_ACTIVE_PER_USER:
        refuse(429, 'quota', 'Too many running team runs; wait or cancel one')
    run_id = uuid4().hex
    db.execute('INSERT INTO team_runs VALUES(?,?,?,?,?,?,?,?,?,?)',
               (run_id, workspace['id'], session['user_id'], title.strip(), goal.strip(), 'running', now, now,
                key_hash, request_hash))
    for position, step in enumerate(steps):
        db.execute('INSERT INTO team_run_steps VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
                   (run_id, position, step['agent']['id'], step['agent']['name'], step['instruction'],
                    json.dumps(step['depends']), 'waiting', None, None, '', 0, None, None))
    run = reconcile(app, db, db.execute('SELECT * FROM team_runs WHERE id=?', (run_id,)).fetchone(), now)
    return 201, {'run': run_view(db, run)}, []


def cancel(db, run, now):
    if run['status'] != 'running':
        return run
    for step in load_steps(db, run['id']):
        if step['status'] in ACTIVE and step['task_id']:
            task = runtime_connect.load_task(db, step['task_id'])
            if task is not None:
                runtime_connect.cancel_task(db, task, now)
        if step['status'] in ACTIVE + ('waiting',):
            set_step(db, run['id'], step['position'], status='cancelled', error_code='cancelled', finished=now)
    db.execute('UPDATE team_runs SET status=?, updated=? WHERE id=?', ('cancelled', now, run['id']))
    return db.execute('SELECT * FROM team_runs WHERE id=?', (run['id'],)).fetchone()


def retry(app, db, run, position, now, refuse):
    steps = load_steps(db, run['id'])
    if position >= len(steps) or steps[position]['status'] != 'failed':
        refuse(409, 'conflict', 'Only a failed step can be retried')
    if run['status'] == 'cancelled':
        refuse(409, 'conflict', 'A cancelled run cannot be retried')
    if steps[position]['attempts'] >= MAX_ATTEMPTS:
        refuse(429, 'quota', 'This step reached its retry limit')
    # Reset the failed step and every step it (transitively) blocked.
    reset = {position}
    for step in steps[position + 1:]:
        if step['status'] == 'blocked' and reset & set(json.loads(step['depends'])):
            reset.add(step['position'])
    for index in sorted(reset):
        set_step(db, run['id'], index, status='waiting', task_id=None, error_code=None, finished=None)
    db.execute('UPDATE team_runs SET status=?, updated=? WHERE id=?', ('running', now, run['id']))
    return reconcile(app, db, db.execute('SELECT * FROM team_runs WHERE id=?', (run['id'],)).fetchone(), now)


def save_artifact(app, db, workspace, session, run, position, now, refuse):
    steps = load_steps(db, run['id'])
    if position >= len(steps) or steps[position]['status'] != 'succeeded' or not steps[position]['output'].strip():
        refuse(409, 'conflict', 'Only a finished step with output can be saved')
    step = steps[position]
    key_hash = digest('artifact-source:team_run:%s:%d' % (run['id'], position))
    existing = db.execute('SELECT id FROM artifacts WHERE workspace_id=? AND key_hash=?',
                          (workspace['id'], key_hash)).fetchone()
    if existing is not None:
        return 200, {'artifact': artifacts.view(artifacts.load(db, workspace['id'], existing['id']))}, []
    content = step['output'][:artifacts.BODY_MAX]
    title = artifacts.unique_title(db, workspace['id'], ('%s · 第 %d 步' % (run['title'], position + 1))[:80],
                                   run['id'] + ':%d' % position)
    if not artifacts.valid_title(title) or not artifacts.valid_body(content):
        refuse(409, 'conflict', 'This step output cannot be saved as a document')
    if (db.execute('SELECT COUNT(*) FROM artifacts WHERE workspace_id=?', (workspace['id'],)).fetchone()[0]
            >= app.config.max_artifacts_per_workspace):
        refuse(429, 'quota', 'Artifact capacity reached')
    artifact_id = uuid4().hex
    request_hash = digest(json.dumps({'source': 'team_run', 'id': run['id'], 'step': position},
                                     sort_keys=True, separators=(',', ':')))
    db.execute('INSERT INTO artifacts VALUES(?,?,?,?,?,?,1,?,?,?,?,?,?)',
               (artifact_id, workspace['id'], title, artifacts.title_hash(title), 'document', content, now, now,
                session['user_id'], session['user_id'], key_hash, request_hash))
    return app.artifact_saved(db, workspace['id'], artifact_id, 201, session, now)


def dispatch(app, db, session, method, query, now, env, refuse, path):
    match = PATH.fullmatch(path)
    workspace_id, run_id, cancelling, position, step_action = match.groups()
    workspace = members.load(db, workspace_id, session['user_id'])
    if workspace is None:
        refuse(404, 'not_found', 'Workspace not found')
    if query:
        refuse(400, 'invalid', 'Unexpected query')
    if run_id is None:
        if method == 'GET':
            rows = db.execute('SELECT * FROM team_runs WHERE workspace_id=? AND user_id=? '
                              'ORDER BY created DESC, id DESC LIMIT ?',
                              (workspace['id'], session['user_id'], MAX_RUNS_PER_USER)).fetchall()
            items = [run_view(db, reconcile(app, db, row, now), include_steps=False) for row in rows]
            return 200, {'items': items}, []
        if method == 'POST':
            return create(app, db, workspace, session, now, env, refuse)
        refuse(400, 'invalid', 'Invalid team run request')
    run = load_run(db, workspace['id'], session['user_id'], run_id)
    if run is None:
        refuse(404, 'not_found', 'Team run not found')
    if method == 'GET' and not cancelling and position is None:
        return 200, {'run': run_view(db, reconcile(app, db, run, now))}, []
    if method != 'POST':
        refuse(400, 'invalid', 'Invalid team run request')
    if env.get('CONTENT_LENGTH') not in (None, '', '0'):
        app.body(env, [])
    if cancelling == 'cancel':
        return 200, {'run': run_view(db, cancel(db, reconcile(app, db, run, now), now))}, []
    if cancelling == 'remove':
        run = reconcile(app, db, run, now)
        if run['status'] == 'running':
            refuse(409, 'conflict', 'Cancel a running team run before removing it')
        db.execute('DELETE FROM team_runs WHERE id=?', (run['id'],))
        return 200, {'removed': run['id']}, []
    if step_action == 'retry':
        return 200, {'run': run_view(db, retry(app, db, reconcile(app, db, run, now), int(position), now, refuse))}, []
    return save_artifact(app, db, workspace, session, reconcile(app, db, run, now), int(position), now, refuse)
