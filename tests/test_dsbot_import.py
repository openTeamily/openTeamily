"""Manager job that writes per-user import bundles and the runtime seal key."""
import json
import os
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
        self.files = set()
        self.unreadable = set()

    def run(self, args, heartbeat=lambda: None, timeout=10):
        self.calls.append(args)
        if args[:3] == ['inspect', '-f', '{{.State.Running}}']:
            return ('true\n' if self.running else 'false\n'), ''
        if 'check-delivery' in args:
            marker, bundle = args[-2:]
            if marker in self.files and bundle not in self.unreadable:
                return '', ''
            raise ManagerError('exec_failed')
        if args[0] == 'exec' and args[-3:-1] == ['test', '-r']:
            if args[-1] in self.files and args[-1] not in self.unreadable:
                return '', ''
            raise ManagerError('exec_failed')
        if args[0] == 'exec' and args[-2:] == ['-p', '/data/openteamily/import']:
            return '', ''
        if args[0] == 'cp':
            dest = args[-1].split(':', 1)[-1]
            self.files.add(dest)
            self.unreadable.discard(dest)
            return '', ''
        if args[0] == 'exec' and 'chown' in args:
            return '', ''
        if args[0] == 'exec' and 'sh' in args:
            cmd = args[-1]
            # `touch /data/openteamily/import/.delivered-<feature>-v1`
            for part in cmd.split():
                if part.startswith('/data/openteamily/import/.delivered-'):
                    self.files.add(part)
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


class ImportJobTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    @mock.patch('openteamily.manager.dsbot_import.os.fchown')
    def test_writes_bundles_once_and_reuses_the_seal_key(self, _chown):
        engine, client = FakeEngine(self.tmp.name), FakeClient()
        iid = '1' * 32
        first = dsbot_import.deliver(engine, client, iid)
        self.assertEqual(first['status'], 'imported')
        self.assertEqual(client.seen[1], '11' * 32)
        self.assertTrue(any(c[0] == 'cp' for c in engine.runner.calls))
        self.assertIn('automations-v1.bundle', first['features'])
        self.assertIn('agents-v1.bundle', first['features'])
        self.assertIn('artifacts-v1.bundle', first['features'])
        self.assertIn('personal-v1.bundle', first['features'])
        engine.runner.calls.clear()
        again = dsbot_import.deliver(engine, client, iid)
        self.assertEqual(again['status'], 'already-imported')
        self.assertFalse(any(c[0] == 'cp' for c in engine.runner.calls))

    @mock.patch('openteamily.manager.dsbot_import.os.fchown')
    def test_redelivers_unreadable_bundles_with_legacy_markers(self, _chown):
        engine, client = FakeEngine(self.tmp.name), FakeClient()
        iid = '1' * 32
        dsbot_import.deliver(engine, client, iid)
        bundle = '/data/openteamily/import/agents-v1.bundle'
        engine.runner.unreadable.add(bundle)
        engine.runner.files.remove('/data/openteamily/import/automations-v1.bundle')
        engine.runner.calls.clear()
        retry = dsbot_import.deliver(engine, client, iid)
        self.assertEqual(retry['features'], ['agents-v1.bundle'])
        self.assertNotIn(bundle, engine.runner.unreadable)
        self.assertEqual(dsbot_import.deliver(engine, client, iid)['status'], 'already-imported')

    def test_refuses_when_the_runtime_is_down(self):
        engine, client = FakeEngine(self.tmp.name), FakeClient()
        engine.runner.running = False
        with self.assertRaises(ManagerError) as caught:
            dsbot_import.deliver(engine, client, '1' * 32)
        self.assertEqual(caught.exception.code, 'instance_not_running')
        self.assertIsNone(client.seen)
