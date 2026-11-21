"""poll-once discovers server auto-provisioned instances over real loopback HTTP; Docker is a stub."""
from contextlib import redirect_stdout
import io
import json
import unittest

import test_compose_manager as base
from openteamily.lifecycle import ManagerAuth, ManagerIdentity
from openteamily.manager.__main__ import main
from openteamily.manager.engine import Registry
from openteamily.manager.safety import ManagerError
from openteamily.runtime_autoprovision import AutoProvisionPolicy
from openteamily.security import digest
from tests.test_management import Client


class AutoProvisionPollTests(unittest.TestCase):
    setUp = base.ComposeManagerTests.setUp
    start_http = base.ComposeManagerTests.start_http
    create = base.ComposeManagerTests.create
    manager = base.ComposeManagerTests.manager

    def auto_instance(self, name='carol', peer='127.0.0.9', static=False):
        # The Docker stub models one project, so the auto-only manager has no static grant here.
        grants = frozenset([self.iid]) if static else frozenset()
        self.app.manager_auth = ManagerAuth([ManagerIdentity('manager-a', digest(self.token), grants, 'compose', True)])
        self.app.auto_provision = AutoProvisionPolicy(enabled=True, manager_id='manager-a', max_instances=3)
        user = Client(self.app, peer=peer)
        self.assertEqual(user.register(name)['status'], 201)
        state = user.call('POST', '/v1/personal-agent')['body']['personal_agent']['runtime_provisioning']
        self.assertEqual(state['state'], 'provisioned')
        return state['instance_id']

    def poll(self):
        out = io.StringIO()
        with redirect_stdout(out):
            code = main(['--config', str(self.cfgpath), '--execute', 'poll-once'])
        return code, json.loads(out.getvalue())

    def test_poll_once_adopts_auto_instance_without_restart(self):
        self.start_http()
        auto = self.auto_instance()
        self.cfg['auto_instances'] = {'image': base.IMAGE, 'healthcheck': None}
        self.cfg['instances'] = {}
        self.cfgpath.write_text(json.dumps(self.cfg))
        code, first = self.poll()
        self.assertEqual(code, 0, first)
        self.assertEqual([r['instance_id'] for r in first['results']], [auto])
        by_id = {r['instance_id']: r for r in first['results']}
        self.assertEqual(by_id[auto]['status'], 'observed', first)
        self.assertEqual(by_id[auto]['observed'], 'stopped')
        # The server queued the fenced start; the next pass runs it.
        code, second = self.poll()
        self.assertEqual(code, 0, second)
        by_id = {r['instance_id']: r for r in second['results']}
        self.assertEqual(by_id[auto]['observed'], 'running', second)
        self.assertTrue((self.root / 'secrets').exists())
        manager_cfg = json.loads(self.cfgpath.read_text())
        self.assertNotIn(auto, manager_cfg['instances'])  # never written back

    def test_without_template_auto_instance_is_skipped(self):
        self.start_http()
        auto = self.auto_instance(static=True)
        code, result = self.poll()
        self.assertEqual(code, 0, result)
        by_id = {r['instance_id']: r for r in result['results']}
        self.assertEqual(by_id[auto]['status'], 'skipped')

    def test_adopt_requires_matching_auto_snapshot(self):
        self.cfg['auto_instances'] = {'image': base.IMAGE, 'healthcheck': None}
        self.cfgpath.write_text(json.dumps(self.cfg))
        registry = Registry(str(self.cfgpath))
        iid = 'b' * 32
        good = {'id': iid, 'provisioning': 'auto', 'backend_mode': 'compose', 'image_ref': base.IMAGE, 'volume_ref': 'ot-' + iid}
        for bad in ({**good, 'provisioning': 'operator'}, {**good, 'image_ref': 'other/image@sha256:' + 'b' * 64},
                    {**good, 'volume_ref': 'ot-' + 'c' * 32}, {**good, 'id': 'c' * 32}):
            with self.assertRaises(ManagerError):
                registry.adopt(iid, bad)
        with self.assertRaises(ManagerError):
            registry.adopt(self.iid, {**good, 'id': self.iid, 'volume_ref': 'ot-' + self.iid})
        self.assertEqual(registry.adopt(iid, good)['publish_port'], None)
        entry, _ = registry.entry(iid, good)
        self.assertEqual(entry['image'], base.IMAGE)


if __name__ == '__main__':
    unittest.main()
