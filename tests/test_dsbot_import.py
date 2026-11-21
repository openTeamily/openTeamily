"""Manager job that writes per-user import bundles and the runtime seal key."""
import json
import hashlib
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from openteamily.manager import dsbot_import
from openteamily.manager.safety import ManagerError


class FakeRunner:
    def __init__(self):
        self.calls = []
        self.running = True
        self.consume = True
        self.files = set()
        self.unreadable = set()
        self.received = {}

    def run(self, args, heartbeat=lambda: None, timeout=10, stdin=None):
        self.calls.append(args)
        if args[:3] == ['inspect', '-f', '{{.State.Running}}']:
            return ('true\n' if self.running else 'false\n'), ''
        if args[0] == 'exec' and 'test' in args and ('-f' in args or '-r' in args):
            marker = args[-1]
            if marker in self.files:
                return '', ''
            raise ManagerError('exec_failed')
        if args[:4] == ['exec', '-i', '-u', '1000:1000'] and args[-4] == 'receive-bundle':
            filename, checksum, marker = args[-3:]
            raw = stdin.read()
            if hashlib.sha256(raw).hexdigest() != checksum:
                raise ManagerError('exec_failed')
            dest = f'/data/openteamily/import/{filename}'
            self.files.add(dest)
            self.unreadable.discard(dest)
            self.received[filename] = json.loads(raw)
            self.files.add(f'/data/openteamily/import/{marker}')
            if self.consume:
                self.files.discard(dest)
            return '', ''
        raise ManagerError('unexpected')


class FakeEngine:
    def __init__(self, root):
        self.registry = mock.Mock()
        self.registry.root = Path(root)
        self.registry.entry = mock.Mock()
        self.runner = FakeRunner()
        self._key = b'\x11' * 32
        self.seal = Path(root) / 'secrets' / 'seal-x.key'

    def seal_key_path(self, iid):
        return self.seal

    def install_seal_key(self, iid):
        self.seal.parent.mkdir(parents=True, exist_ok=True)
        self.seal.write_bytes(self._key)
        return self.seal, self._key


class FakeClient:
    def __init__(self):
        self.seen = None

    def dsbot_import(self, iid, seal_key_hex):
        self.seen = (iid, seal_key_hex)
        from openteamily.manager.dsbot_import import FEATURES
        return {'owner_imported': True, 'features': [
            {'name': name, 'bundle': {'format': 'openteamily-dsbot-import', 'feature': name, 'tables': {}, 'manifest': {}}}
            for name in FEATURES
        ]}


def receives(runner):
    return [c for c in runner.calls if c[:4] == ['exec', '-i', '-u', '1000:1000'] and 'receive-bundle' in c]


class ImportJobTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_writes_bundles_once_and_reuses_the_seal_key(self):
        engine, client = FakeEngine(self.tmp.name), FakeClient()
        iid = '1' * 32
        first = dsbot_import.deliver(engine, client, iid)
        self.assertEqual(first['status'], 'delivered')
        self.assertEqual(client.seen[1], '11' * 32)
        self.assertEqual(engine.runner.received['settings-v1.bundle']['feature'], 'settings')
        self.assertFalse(any(c[0] == 'cp' for c in engine.runner.calls))
        self.assertIn('automations-v1.bundle', first['features'])
        self.assertIn('agents-v1.bundle', first['features'])
        self.assertIn('artifacts-v1.bundle', first['features'])
        engine.runner.calls.clear()
        again = dsbot_import.deliver(engine, client, iid)
        self.assertEqual(again['status'], 'already-imported')
        self.assertFalse(any(c[0] == 'cp' for c in engine.runner.calls))
        self.assertFalse(any('.delivered-' in f for f in engine.runner.files))

    def test_rejected_import_is_retried_instead_of_suppressed_by_the_copy_marker(self):
        engine, client = FakeEngine(self.tmp.name), FakeClient()
        engine.runner.consume = False
        iid = '1' * 32
        first = dsbot_import.deliver(engine, client, iid)
        self.assertEqual(first['status'], 'delivered')
        self.assertTrue(receives(engine.runner))
        self.assertTrue(any('.copied-settings-v1' in f for f in engine.runner.files))

        # The runtime rejected the bundle, so the files are still present. A copy
        # marker alone must not turn the next poll into already-imported.
        engine.runner.calls.clear()
        again = dsbot_import.deliver(engine, client, iid)
        self.assertEqual(again['status'], 'delivered')
        self.assertEqual(len(receives(engine.runner)), len(dsbot_import.FEATURES), 'rejected bundles are copied again')

        # Once the runtime consumes the bundles (verified import), the retry stops.
        engine.runner.files = {f for f in engine.runner.files if not f.endswith('.bundle')}
        engine.runner.calls.clear()
        settled = dsbot_import.deliver(engine, client, iid)
        self.assertEqual(settled['status'], 'already-imported')
        self.assertFalse(receives(engine.runner))

    def test_redelivers_a_bundle_the_runtime_has_not_consumed(self):
        engine, client = FakeEngine(self.tmp.name), FakeClient()
        iid = '1' * 32
        engine.runner.consume = False  # keep the bundles so the delivery check can see them
        dsbot_import.deliver(engine, client, iid)
        bundle = '/data/openteamily/import/agents-v1.bundle'
        engine.runner.unreadable.add(bundle)
        # Every other bundle was verified and consumed; only agents is still there.
        engine.runner.files = {f for f in engine.runner.files if not f.endswith('.bundle')} | {bundle}
        engine.runner.calls.clear()
        retry = dsbot_import.deliver(engine, client, iid)
        self.assertEqual(retry['features'], ['agents-v1.bundle'])
        self.assertNotIn(bundle, engine.runner.unreadable)
        # The re-sent bundle is imported and removed by the runtime; then it settles.
        engine.runner.consume = True
        engine.runner.files.discard(bundle)
        self.assertEqual(dsbot_import.deliver(engine, client, iid)['status'], 'already-imported')

    def test_legacy_delivered_markers_are_not_copy_receipts(self):
        engine, client = FakeEngine(self.tmp.name), FakeClient()
        iid = '1' * 32
        dsbot_import.deliver(engine, client, iid)
        # An older manager wrote `.delivered-`; only `.copied-` is a copy receipt.
        engine.runner.files = {f.replace('/.copied-', '/.delivered-') for f in engine.runner.files}
        engine.runner.calls.clear()
        retry = dsbot_import.deliver(engine, client, iid)
        self.assertEqual(sorted(retry['features']), sorted(f'{name}-v1.bundle' for name in dsbot_import.FEATURES))
        self.assertEqual(dsbot_import.deliver(engine, client, iid)['status'], 'already-imported')

    def test_skips_a_historical_runtime_without_writing_a_bundle(self):
        engine, client = FakeEngine(self.tmp.name), FakeClient()
        iid = '1' * 32
        with mock.patch.object(client, 'dsbot_import', side_effect=ManagerError('import_destination')):
            result = dsbot_import.deliver(engine, client, iid)
        self.assertEqual(result['status'], 'import_skipped')
        self.assertEqual(engine.runner.received, {})

    def test_refuses_when_the_runtime_is_down(self):
        engine, client = FakeEngine(self.tmp.name), FakeClient()
        engine.runner.running = False
        with self.assertRaises(ManagerError) as caught:
            dsbot_import.deliver(engine, client, '1' * 32)
        self.assertEqual(caught.exception.code, 'instance_not_running')
        self.assertIsNone(client.seen)
