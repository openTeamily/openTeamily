"""CI fixture: create legacy OpenTeamily data for test accounts in a temp store,
then print the DS-Bot import bundles
that openteamily.dsbot_bundle builds for one of those accounts.

usage: python3 legacy_bundle.py <feature> [<feature> ...]  -> JSON {feature: bundle_text, "expect": {...}}
Test accounts only (alice, bob); nothing leaves the temp directory.
"""
import json
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT))

from openteamily import dsbot_bundle  # noqa: E402
from openteamily.app import App, Config  # noqa: E402
from openteamily.store import Store  # noqa: E402
from tests.test_management import Client, ORIGIN  # noqa: E402


def meeting_fixture(store):
    now = 1800000000
    title, foreign_title = '周会', 'bob 的会'
    with store.transaction() as db:
        for i, (name, heading) in enumerate((('alice', title), ('bob', foreign_title)), 1):
            user_id, workspace_id, meeting_id = (str(i + offset) * 32 for offset in (0, 2, 4))
            db.execute('INSERT INTO users VALUES(?,?,?,?)', (user_id, name, 'fixture-only', now))
            db.execute('INSERT INTO workspaces VALUES(?,?,?,?,?,?)',
                       (workspace_id, user_id, name, now, '7' * 64, '8' * 64))
            db.execute('INSERT INTO meetings VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                       (meeting_id, workspace_id, heading, '9' * 64, now, json.dumps([name]), '讨论排期。',
                        '同步进度。', json.dumps([{'text': '订会议室', 'owner': name, 'done': False}]),
                        1, now, now, user_id, user_id, 'a' * 64, 'b' * 64))
    return {'workspace_id': '3' * 32,
            'meetings': {'meeting_id': '5' * 32, 'title': title, 'foreign_title': foreign_title}}


def seed_memory(alice, bob, wid, bob_wid):
    created = alice.call('POST', f'/v1/workspaces/{wid}/memory',
                         {'title': '客户偏好', 'body': '喜欢简洁的周报。', 'topics': ['客户']},
                         {'HTTP_IDEMPOTENCY_KEY': 'fixture-memory-0001'})
    assert created['status'] == 201, created
    page = created['body']['page']
    edited = alice.call('POST', f'/v1/workspaces/{wid}/memory/{page["id"]}',
                        {'revision': page['revision'], 'changes': {'body': '喜欢简洁的周报，周五发。'}})
    assert edited['status'] == 200, edited
    other = bob.call('POST', f'/v1/workspaces/{bob_wid}/memory', {'title': 'bob 的记忆', 'body': 'x'},
                     {'HTTP_IDEMPOTENCY_KEY': 'fixture-memory-0002'})
    assert other['status'] == 201, other
    return {'page_id': page['id'], 'title': '客户偏好', 'body': '喜欢简洁的周报，周五发。', 'revision': 2,
            'foreign_title': 'bob 的记忆'}



def seed_artifacts(alice, bob, wid, bob_wid):
    created = alice.call('POST', f'/v1/workspaces/{wid}/artifacts',
                         {'title': '周报', 'body': '本周完成迁移。', 'kind': 'document'},
                         {'HTTP_IDEMPOTENCY_KEY': 'fixture-artifact-0001'})
    assert created['status'] == 201, created
    other = bob.call('POST', f'/v1/workspaces/{bob_wid}/artifacts',
                     {'title': 'bob 的文档', 'body': 'x', 'kind': 'document'},
                     {'HTTP_IDEMPOTENCY_KEY': 'fixture-artifact-0002'})
    assert other['status'] == 201, other
    return {'artifact_id': created['body']['artifact']['id'], 'title': '周报', 'body': '本周完成迁移。',
            'foreign_title': 'bob 的文档'}


SEEDS = {'memory': seed_memory, 'artifacts': seed_artifacts}


def main(features):
    with tempfile.TemporaryDirectory() as temp:
        store = Store(Path(temp) / 'state')
        if features == ['meetings']:
            # The platform write routes were retired. Reproduce their retained database rows.
            expect = meeting_fixture(store)
        else:
            app = App(store, Config(ORIGIN, allow_registration=True), clock=lambda: 1800000000)
            alice, bob = Client(app), Client(app, peer='127.0.0.2')
            alice.register('alice')
            bob.register('bob')
            wid = alice.workspace()['body']['workspace']['id']
            bob_wid = bob.workspace(key='request_example_0002')['body']['workspace']['id']
            expect = {'workspace_id': wid}
            for feature in features:
                expect[feature] = SEEDS[feature](alice, bob, wid, bob_wid)
        with store.connect() as db:
            user_id = db.execute("SELECT id FROM users WHERE username='alice'").fetchone()[0]
            bundles = {feature: dsbot_bundle.dumps(dsbot_bundle.build(db, user_id, feature, now=1800000000, data_dir=store.data_dir))
                       for feature in features}
        print(json.dumps({'bundles': bundles, 'expect': expect}, ensure_ascii=False))


if __name__ == '__main__':
    main(sys.argv[1:])
