"""Manager publishes a running runtime to the platform gateway (fake Docker, fake client)."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from openteamily.manager import dsbot_route
from openteamily.manager.safety import ManagerError

IID = '3' * 32
REF = 'a' * 32
URL = 'http://172.30.5.9:8080/?token=' + 'T' * 43


class FakeRunner:
    def __init__(self, web_networks=()):
        self.calls = []
        self.web_networks = dict.fromkeys(web_networks, {})

    def run(self, args, heartbeat=lambda: None, timeout=10):
        self.calls.append(list(args))
        if args[:3] == ['inspect', '--type', 'container'] and args[3] == 'openteamily-web-1':
            return json.dumps([{'Name': '/openteamily-web-1', 'NetworkSettings': {'Networks': self.web_networks}}]), ''
        if args[:3] == ['inspect', '--type', 'container']:
            return json.dumps([{'NetworkSettings': {'Networks': {f'ot-{IID}_default': {'IPAddress': '172.30.5.9'}}}}]), ''
        if args[:2] == ['network', 'connect']:
            self.web_networks[args[2]] = {}
            return '', ''
        raise AssertionError(args)


class FakeEngine:
    def __init__(self, root, runner, logs=URL, healthy=True):
        self.registry = SimpleNamespace(root=root, config={'dsbot_gateway': {'web_container': 'openteamily-web-1'}})
        self.runner, self.logs, self.healthy = runner, logs, healthy
        self.log_reads = 0

    def inspect(self, iid, heartbeat=lambda: None):
        return {'present': True, 'healthy': self.healthy, 'process_ref': REF if self.healthy else None}

    def compose(self, iid, operation, heartbeat=lambda: None, tail=100):
        if operation == 'ps':
            return 'f' * 64 + '\n', ''
        assert operation == 'logs'
        self.log_reads += 1
        return f'dsh web ready\n{self.logs}\n', ''


class FakeClient:
    def __init__(self):
        self.reports = []

    def dsbot_upstream(self, iid, address, cookie, process_ref):
        self.reports.append((iid, address, cookie, process_ref))
        return True


class PublishTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / 'secrets').mkdir(mode=0o700)

    def tearDown(self):
        self.tmp.cleanup()

    def test_attaches_web_once_exchanges_and_reports_without_exposing_secrets(self):
        runner, client = FakeRunner(), FakeClient()
        engine = FakeEngine(self.root, runner)
        seen = []

        def exchange(url, address):
            seen.append((url, address))
            return f'dsh-auth-{address}=' + 'C' * 30
        result = dsbot_route.publish(engine, client, IID, exchange=exchange)
        self.assertEqual(result, {'status': 'published', 'instance_id': IID, 'address': '172.30.5.9:8080'})
        self.assertNotIn('C' * 30, json.dumps(result))
        self.assertEqual(seen, [(URL, '172.30.5.9:8080')])
        self.assertEqual(client.reports[0][:2], (IID, '172.30.5.9:8080'))
        self.assertEqual(client.reports[0][3], REF)
        self.assertIn(['network', 'connect', f'ot-{IID}_default', 'openteamily-web-1'], runner.calls)
        cache = self.root / 'secrets' / f'dsbot-launch-{IID}.json'
        self.assertEqual(oct(os.stat(cache).st_mode & 0o777), '0o600')
        # Second pass: already attached, launch URL from the private cache (logs may have rotated).
        engine.logs = 'rotated'
        dsbot_route.publish(engine, client, IID, exchange=exchange)
        self.assertEqual(engine.log_reads, 1)
        self.assertEqual(sum(1 for c in runner.calls if c[:2] == ['network', 'connect']), 1)

    def test_new_process_needs_its_own_launch_url(self):
        runner, client = FakeRunner(), FakeClient()
        engine = FakeEngine(self.root, runner, logs='no url here')
        with self.assertRaises(ManagerError) as caught:
            dsbot_route.publish(engine, client, IID, exchange=lambda u, a: 'x')
        self.assertEqual(caught.exception.code, 'launch_url_missing')
        self.assertEqual(client.reports, [])

    def test_disabled_or_not_running(self):
        engine = FakeEngine(self.root, FakeRunner())
        engine.registry.config = {}
        self.assertEqual(dsbot_route.publish(engine, FakeClient(), IID)['status'], 'gateway_disabled')
        engine = FakeEngine(self.root, FakeRunner(), healthy=False)
        self.assertEqual(dsbot_route.publish(engine, FakeClient(), IID)['status'], 'not_running')

    def test_config_validation(self):
        for bad in ({'web_container': 'ot-evil'}, {'web_container': 'a b'}, {'web_container': 'w', 'x': 1}):
            engine = FakeEngine(self.root, FakeRunner())
            engine.registry.config = {'dsbot_gateway': bad}
            with self.assertRaises(ManagerError):
                dsbot_route.publish(engine, FakeClient(), IID)

    def test_exchange_failure_is_a_refusal(self):
        def boom(url, address):
            raise ValueError('no cookie')
        with self.assertRaises(ManagerError) as caught:
            dsbot_route.publish(FakeEngine(self.root, FakeRunner()), FakeClient(), IID, exchange=boom)
        self.assertEqual(caught.exception.code, 'dsh_exchange')


if __name__ == '__main__':
    unittest.main()
