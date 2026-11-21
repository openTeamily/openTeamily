"""Agent evaluation suites, cases, runs and comparisons. No model or network calls."""
from pathlib import Path
import tempfile
import unittest

from openteamily import agent_evaluations as evals
from openteamily.app import App, Config
from openteamily.store import Store
from tests.test_management import Client, ORIGIN

NOW = 1800000000


class AgentEvaluationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name).resolve() / 'state'
        self.app = App(
            Store(self.path),
            Config(ORIGIN, allow_registration=True),
            clock=lambda: NOW,
        )
        self.alice = Client(self.app)
        self.alice_id = self.alice.register('alice')['body']['user']['id']
        self.bob = Client(self.app, peer='127.0.0.2')
        self.bob_id = self.bob.register('bob')['body']['user']['id']
        self.wid = self.alice.workspace()['body']['workspace']['id']
        self.other_wid = self.bob.workspace()['body']['workspace']['id']
        with self.app.store.connect() as db:
            evals.ensure_schema(db)

    def suite(self, name='Suite', agent_id='agent-1', wid=None, now=NOW):
        with self.app.store.connect() as db:
            return evals.create_suite(db, wid or self.wid, agent_id, name, now)

    def case(self, suite_id, name='Case', value='input', expected='expected',
             weight=1.0, wid=None, now=NOW):
        with self.app.store.connect() as db:
            return evals.add_case(
                db, wid or self.wid, suite_id, name, value, expected, weight, now)

    def start(self, suite_id, wid=None, now=NOW):
        with self.app.store.connect() as db:
            return evals.start_run(db, wid or self.wid, suite_id, now)

    def record(self, run_id, case_id, score, output='output', wid=None,
               now=NOW, **kwargs):
        with self.app.store.connect() as db:
            return evals.record_result(
                db, wid or self.wid, run_id, case_id, output, score, now, **kwargs)

    def finish(self, run_id, wid=None, now=NOW, threshold=0.5):
        with self.app.store.connect() as db:
            return evals.finish_run(db, wid or self.wid, run_id, now, threshold)

    def run_view(self, run_id, wid=None):
        with self.app.store.connect() as db:
            return evals.get_run(db, wid or self.wid, run_id)

    def test_schema_is_idempotent(self):
        with self.app.store.connect() as db:
            evals.ensure_schema(db)
            evals.ensure_schema(db)
            names = {
                row[0]
                for row in db.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'eval_%'")
            }
            indexes = {
                row[0]
                for row in db.execute(
                    "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'eval_%'")
            }
            version = db.execute('PRAGMA user_version').fetchone()[0]
        self.assertEqual(
            names, {'eval_suites', 'eval_cases', 'eval_runs', 'eval_results'})
        self.assertTrue(indexes)
        self.assertEqual(version, 1)

    def test_suite_and_case_crud_and_listing(self):
        suite = self.suite()
        self.assertEqual(suite['workspace_id'], self.wid)
        self.assertEqual(suite['agent_id'], 'agent-1')
        self.assertEqual(suite['name'], 'Suite')
        self.assertEqual(suite['created'], NOW)
        self.assertEqual(suite['updated'], NOW)

        first = self.case(suite['id'], 'First', 'a', 'b', weight=2.0)
        second = self.case(suite['id'], 'Second', 'c', 'd', weight=0.5)
        self.assertEqual(first['suite_id'], suite['id'])
        self.assertEqual(first['workspace_id'], self.wid)
        self.assertEqual(first['weight'], 2.0)

        with self.app.store.connect() as db:
            suites = evals.list_suites(db, self.wid)
            cases = evals.list_cases(db, self.wid, suite['id'])
        self.assertEqual([row['id'] for row in suites['items']], [suite['id']])
        self.assertIsNone(suites['cursor'])
        self.assertEqual(
            {row['id'] for row in cases['items']}, {first['id'], second['id']})
        self.assertIsNone(cases['cursor'])

    def test_duplicate_names_rejected_and_names_scoped_by_agent(self):
        suite = self.suite(name='Duplicate')
        with self.app.store.connect() as db:
            with self.assertRaises(evals.DuplicateName):
                evals.create_suite(db, self.wid, 'agent-1', 'Duplicate', NOW)
            other = evals.create_suite(db, self.wid, 'agent-2', 'Duplicate', NOW)
            self.assertNotEqual(other['id'], suite['id'])
            evals.add_case(db, self.wid, suite['id'], 'Case', 'in', 'out', 1.0, NOW)
            with self.assertRaises(evals.DuplicateName):
                evals.add_case(db, self.wid, suite['id'], 'Case', 'in2', 'out2', 1.0, NOW)
        other_workspace = self.suite(name='Duplicate', wid=self.other_wid,
                                     agent_id='agent-1')
        self.assertNotEqual(other_workspace['id'], suite['id'])

    def test_invalid_weight_and_score_rejected(self):
        suite = self.suite()
        for weight in (0, -1, float('nan'), float('inf'), '1', True):
            with self.app.store.connect() as db:
                with self.assertRaises(ValueError):
                    evals.add_case(
                        db, self.wid, suite['id'], 'Bad weight', 'in', 'out',
                        weight, NOW)
        case = self.case(suite['id'], 'Scored')
        run = self.start(suite['id'])
        for score in (-0.01, 1.01, float('nan'), float('inf'), '0.5', True):
            with self.app.store.connect() as db:
                with self.assertRaises(ValueError):
                    evals.record_result(
                        db, self.wid, run['id'], case['id'], 'out', score, NOW)
        with self.app.store.connect() as db:
            with self.assertRaises(ValueError):
                evals.finish_run(db, self.wid, run['id'], NOW, threshold=1.1)

    def test_start_record_finish_weighted_score_and_threshold(self):
        suite = self.suite()
        heavy = self.case(suite['id'], 'Heavy', 'in1', 'out1', weight=3.0)
        light = self.case(suite['id'], 'Light', 'in2', 'out2', weight=1.0)
        run = self.start(suite['id'])
        self.assertEqual(run['status'], 'running')
        self.assertIsNone(run['score'])
        self.assertIsNone(run['passed'])

        first = self.record(run['id'], heavy['id'], 1.0)
        second = self.record(run['id'], light['id'], 0.0)
        self.assertTrue(first['passed'])
        self.assertFalse(second['passed'])

        done = self.finish(run['id'])
        self.assertEqual(done['status'], 'completed')
        self.assertAlmostEqual(done['score'], 0.75)
        self.assertTrue(done['passed'])
        self.assertEqual(done['finished'], NOW)
        self.assertEqual(done['case_count'], 2)
        self.assertEqual(done['result_count'], 2)

        other = self.start(suite['id'])
        self.record(other['id'], heavy['id'], 0.0)
        self.record(other['id'], light['id'], 1.0)
        failed = self.finish(other['id'], threshold=0.75)
        self.assertAlmostEqual(failed['score'], 0.25)
        self.assertFalse(failed['passed'])

        high = self.start(suite['id'])
        self.record(high['id'], heavy['id'], 0.5)
        self.record(high['id'], light['id'], 0.5)
        strict = self.finish(high['id'], threshold=0.75)
        self.assertAlmostEqual(strict['score'], 0.5)
        self.assertFalse(strict['passed'])

    def test_missing_results_count_as_zero_and_threshold_boundary(self):
        suite = self.suite()
        one = self.case(suite['id'], 'One', 'a', 'b', weight=1.0)
        self.case(suite['id'], 'Two', 'c', 'd', weight=1.0)
        run = self.start(suite['id'])
        self.record(run['id'], one['id'], 1.0)
        done = self.finish(run['id'], threshold=0.5)
        self.assertAlmostEqual(done['score'], 0.5)
        self.assertTrue(done['passed'])
        self.assertEqual(done['result_count'], 1)
        self.assertEqual(done['case_count'], 2)

        boundary = self.start(suite['id'])
        self.record(boundary['id'], one['id'], 0.5)
        exact = self.finish(boundary['id'], threshold=0.25)
        self.assertAlmostEqual(exact['score'], 0.25)
        self.assertTrue(exact['passed'])

    def test_record_upserts_per_case_and_get_run_returns_results(self):
        suite = self.suite()
        case = self.case(suite['id'], 'Only')
        run = self.start(suite['id'])
        self.record(run['id'], case['id'], 0.2, output='first', notes='n1')
        replaced = self.record(
            run['id'], case['id'], 0.9, output='second', notes='n2', passed=False)
        self.assertEqual(replaced['case_id'], case['id'])
        self.assertFalse(replaced['passed'])
        view = self.run_view(run['id'])
        self.assertEqual(len(view['results']), 1)
        result = view['results'][0]
        self.assertEqual(result['output'], 'second')
        self.assertEqual(result['notes'], 'n2')
        self.assertEqual(result['score'], 0.9)
        self.assertFalse(result['passed'])
        self.assertEqual(result['case_name'], 'Only')

    def test_missing_or_cross_suite_case_rejected(self):
        first = self.suite(name='First')
        second = self.suite(name='Second')
        case = self.case(first['id'], 'First case')
        run = self.start(first['id'])
        with self.app.store.connect() as db:
            with self.assertRaises(evals.NotFound):
                evals.record_result(
                    db, self.wid, run['id'], '0' * 32, 'out', 0.5, NOW)
            with self.assertRaises(evals.NotFound):
                evals.record_result(
                    db, self.wid, run['id'], case['id'] + '0', 'out', 0.5, NOW)
        foreign = self.case(second['id'], 'Second case')
        with self.app.store.connect() as db:
            with self.assertRaises(evals.NotFound):
                evals.record_result(
                    db, self.wid, run['id'], foreign['id'], 'out', 0.5, NOW)

    def test_finish_and_fail_state_transitions_are_not_idempotent(self):
        suite = self.suite()
        case = self.case(suite['id'], 'Case')
        run = self.start(suite['id'])
        self.record(run['id'], case['id'], 0.5)
        self.finish(run['id'])
        with self.app.store.connect() as db:
            with self.assertRaises(evals.InvalidState):
                evals.finish_run(db, self.wid, run['id'], NOW)
            with self.assertRaises(evals.InvalidState):
                evals.fail_run(db, self.wid, run['id'], NOW)
            with self.assertRaises(evals.InvalidState):
                evals.record_result(
                    db, self.wid, run['id'], case['id'], 'late', 1.0, NOW)

        failing = self.start(suite['id'])
        failed = None
        with self.app.store.connect() as db:
            failed = evals.fail_run(db, self.wid, failing['id'], NOW)
        self.assertEqual(failed['status'], 'failed')
        self.assertEqual(failed['finished'], NOW)
        self.assertIsNone(failed['score'])
        self.assertIsNone(failed['passed'])
        with self.app.store.connect() as db:
            with self.assertRaises(evals.InvalidState):
                evals.fail_run(db, self.wid, failing['id'], NOW)
            with self.assertRaises(evals.InvalidState):
                evals.finish_run(db, self.wid, failing['id'], NOW)

    def test_compare_runs_per_case_and_aggregate_deltas(self):
        suite = self.suite()
        heavy = self.case(suite['id'], 'Heavy', 'in1', 'out1', weight=3.0)
        light = self.case(suite['id'], 'Light', 'in2', 'out2', weight=1.0)
        run_a = self.start(suite['id'], now=NOW)
        self.record(run_a['id'], heavy['id'], 1.0)
        self.record(run_a['id'], light['id'], 0.0)
        self.finish(run_a['id'], now=NOW + 1)
        run_b = self.start(suite['id'], now=NOW + 2)
        self.record(run_b['id'], heavy['id'], 0.0)
        self.record(run_b['id'], light['id'], 1.0)
        self.finish(run_b['id'], now=NOW + 3)
        with self.app.store.connect() as db:
            comparison = evals.compare_runs(db, self.wid, run_a['id'], run_b['id'])
        self.assertAlmostEqual(comparison['aggregate_delta'], -0.5)
        deltas = {row['case_id']: row for row in comparison['cases']}
        self.assertAlmostEqual(deltas[heavy['id']]['delta'], -1.0)
        self.assertAlmostEqual(deltas[light['id']]['delta'], 1.0)
        self.assertEqual(deltas[heavy['id']]['score_a'], 1.0)
        self.assertEqual(deltas[heavy['id']]['score_b'], 0.0)

    def test_compare_runs_handles_missing_results_and_rejects_mixed_suites(self):
        suite = self.suite(name='One')
        other = self.suite(name='Two')
        case = self.case(suite['id'], 'Case')
        run_a = self.start(suite['id'])
        run_b = self.start(suite['id'])
        self.record(run_b['id'], case['id'], 1.0)
        self.finish(run_a['id'])
        self.finish(run_b['id'])
        with self.app.store.connect() as db:
            comparison = evals.compare_runs(db, self.wid, run_a['id'], run_b['id'])
        row = comparison['cases'][0]
        self.assertIsNone(row['score_a'])
        self.assertEqual(row['score_b'], 1.0)
        self.assertIsNone(row['delta'])
        self.assertAlmostEqual(comparison['aggregate_delta'], 1.0)

        mixed = self.start(other['id'])
        with self.app.store.connect() as db:
            with self.assertRaises(ValueError):
                evals.compare_runs(db, self.wid, run_a['id'], mixed['id'])

    def test_workspace_isolation(self):
        suite = self.suite(name='Alice suite')
        case = self.case(suite['id'], 'Alice case')
        run = self.start(suite['id'])
        self.record(run['id'], case['id'], 1.0)
        self.finish(run['id'])
        with self.app.store.connect() as db:
            self.assertEqual(evals.list_suites(db, self.other_wid)['items'], [])
            with self.assertRaises(evals.NotFound):
                evals.list_cases(db, self.other_wid, suite['id'])
            with self.assertRaises(evals.NotFound):
                evals.add_case(
                    db, self.other_wid, suite['id'], 'Stolen', 'in', 'out', 1.0, NOW)
            with self.assertRaises(evals.NotFound):
                evals.start_run(db, self.other_wid, suite['id'], NOW)
            with self.assertRaises(evals.NotFound):
                evals.get_run(db, self.other_wid, run['id'])
            with self.assertRaises(evals.NotFound):
                evals.record_result(
                    db, self.other_wid, run['id'], case['id'], 'out', 1.0, NOW)
            with self.assertRaises(evals.NotFound):
                evals.compare_runs(db, self.other_wid, run['id'], run['id'])
            with self.assertRaises(evals.NotFound):
                evals.delete_suite(db, self.other_wid, suite['id'], self.bob_id)
        bob_suite = self.suite(name='Alice suite', wid=self.other_wid,
                               agent_id='agent-1')
        with self.app.store.connect() as db:
            items = evals.list_suites(db, self.other_wid)['items']
        self.assertEqual([row['id'] for row in items], [bob_suite['id']])

    def test_oversize_fields_rejected(self):
        suite = self.suite()
        with self.app.store.connect() as db:
            with self.assertRaises(ValueError):
                evals.create_suite(
                    db, self.wid, 'a' * (evals.AGENT_ID_MAX + 1), 'Suite', NOW)
            with self.assertRaises(ValueError):
                evals.create_suite(
                    db, self.wid, 'agent-1', 'n' * (evals.NAME_MAX + 1), NOW)
            with self.assertRaises(ValueError):
                evals.add_case(
                    db, self.wid, suite['id'], 'Case',
                    'i' * (evals.INPUT_MAX + 1), 'out', 1.0, NOW)
            with self.assertRaises(ValueError):
                evals.add_case(
                    db, self.wid, suite['id'], 'Case', 'in',
                    'e' * (evals.EXPECTED_MAX + 1), 1.0, NOW)
        case = self.case(suite['id'], 'Bounded')
        run = self.start(suite['id'])
        with self.app.store.connect() as db:
            with self.assertRaises(ValueError):
                evals.record_result(
                    db, self.wid, run['id'], case['id'],
                    'o' * (evals.OUTPUT_MAX + 1), 1.0, NOW)
            with self.assertRaises(ValueError):
                evals.record_result(
                    db, self.wid, run['id'], case['id'], 'out', 1.0, NOW,
                    notes='n' * (evals.NOTES_MAX + 1))
            with self.assertRaises(ValueError):
                evals.record_result(
                    db, self.wid, run['id'], case['id'], 'out', 1.0, NOW,
                    passed='yes')

    def test_paging_and_listing_filters(self):
        suites = []
        for index in range(3):
            suites.append(self.suite(name=f'Suite {index}', agent_id='agent-1'))
            self.suite(name=f'Other {index}', agent_id='agent-2')
        with self.app.store.connect() as db:
            page = evals.list_suites(db, self.wid, agent_id='agent-1', limit=2)
            self.assertEqual(len(page['items']), 2)
            self.assertIsNotNone(page['cursor'])
            rest = evals.list_suites(
                db, self.wid, agent_id='agent-1', cursor=page['cursor'], limit=2)
            self.assertEqual(len(rest['items']), 1)
            self.assertIsNone(rest['cursor'])
            self.assertEqual(
                {row['id'] for row in page['items'] + rest['items']},
                {row['id'] for row in suites})
            with self.assertRaises(ValueError):
                evals.list_suites(db, self.wid, limit=0)
            with self.assertRaises(ValueError):
                evals.list_suites(db, self.wid, limit=101)

        suite = suites[0]
        cases = [self.case(suite['id'], f'Case {index}') for index in range(3)]
        with self.app.store.connect() as db:
            page = evals.list_cases(db, self.wid, suite['id'], limit=2)
            self.assertEqual(len(page['items']), 2)
            self.assertIsNotNone(page['cursor'])
            rest = evals.list_cases(
                db, self.wid, suite['id'], cursor=page['cursor'], limit=2)
            self.assertEqual(len(rest['items']), 1)
            self.assertIsNone(rest['cursor'])
            self.assertEqual(
                {row['id'] for row in page['items'] + rest['items']},
                {row['id'] for row in cases})

    def test_delete_suite_requires_owner_and_cascades(self):
        suite = self.suite()
        case = self.case(suite['id'], 'Case')
        run = self.start(suite['id'])
        self.record(run['id'], case['id'], 1.0)
        self.finish(run['id'])
        with self.app.store.connect() as db:
            with self.assertRaises(PermissionError):
                evals.delete_suite(db, self.wid, suite['id'], self.bob_id)
        self.assertEqual(self.run_view(run['id'])['status'], 'completed')
        with self.app.store.connect() as db:
            removed = evals.delete_suite(db, self.wid, suite['id'], self.alice_id)
            self.assertEqual(removed, {'id': suite['id'], 'deleted': True})
            self.assertEqual(evals.list_suites(db, self.wid)['items'], [])
            with self.assertRaises(evals.NotFound):
                evals.get_run(db, self.wid, run['id'])
            with self.assertRaises(evals.NotFound):
                evals.list_cases(db, self.wid, suite['id'])
            with self.assertRaises(evals.NotFound):
                evals.delete_suite(db, self.wid, suite['id'], self.alice_id)


if __name__ == '__main__':
    unittest.main()
