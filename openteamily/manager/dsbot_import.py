"""Write per-user DS-Bot import bundles and the runtime seal key.

Uses dsbot_bundle.build_with_secrets on the platform (via a loopback manager
call) and copies the resulting files into the instance volume at
/data/openteamily/import/<feature>-<version>.bundle. The same 32-byte key is
bound at /run/secrets/openteamily-seal.key. Secrets stay plugin-encrypted on
the user volume after import; they are never written to DS-Bot secrets.js.
"""
import json
import os
import re
from pathlib import Path

from .engine import publish_container_secret
from .safety import ManagerError, require

FEATURES = ('settings', 'model-api', 'connectors', 'meetings', 'memory', 'automations', 'agents', 'personal', 'artifacts', 'skills', 'skill-secrets', 'message-assists')
BUNDLE_NAME = re.compile(r'^[a-z0-9-]{1,40}-v[0-9]{1,4}\.bundle$')
VERSION = 1


def _container(engine, iid):
    name = f'ot-{iid}-flybot-1'
    return name


def deliver(engine, client, iid, heartbeat=lambda: None):
    """Install the seal key, fetch sealed bundles, copy them into the volume."""
    require(re.fullmatch(r'[0-9a-f]{32}', iid or ''), 'instance_id')
    path, key = engine.install_seal_key(iid)
    # Additive compose bind; a later no-delete recreate attaches it. The job still
    # writes bundles even if the current container was created before the bind.
    try:
        engine.registry.entry(iid)
    except ManagerError:
        pass
    container = _container(engine, iid)
    inspect, _ = engine.runner.run(['inspect', '-f', '{{.State.Running}}', container], heartbeat=heartbeat, timeout=10)
    require(inspect.strip() == 'true', 'instance_not_running')
    def delivered(name):
        bundle = f'/data/openteamily/import/{name}-v{VERSION}.bundle'
        marker = f'/data/openteamily/import/.delivered-{name}-v{VERSION}'
        try:
            # Older managers could mark a root-owned bundle as delivered.
            # An absent bundle was already consumed, but an unreadable one must be recopied.
            engine.runner.run(
                ['exec', '-u', '1000:1000', container, 'sh', '-c',
                 'test -f "$1" && { test ! -e "$2" || test -r "$2"; }',
                 'check-delivery', marker, bundle],
                heartbeat=heartbeat, timeout=10)
            return True
        except ManagerError:
            return False

    if all(delivered(name) for name in FEATURES):
        return {'status': 'already-imported', 'instance_id': iid, 'version': VERSION, 'features': list(FEATURES)}
    data = client.dsbot_import(iid, key.hex())
    require(isinstance(data, dict) and data.get('owner_imported') is True, 'import_shape')
    features = data.get('features')
    require(isinstance(features, list) and len(features) <= 16, 'import_shape')
    staging = engine.registry.root / 'import-staging' / iid
    staging.mkdir(parents=True, mode=0o700, exist_ok=True)
    written = []
    try:
        for item in features:
            require(isinstance(item, dict) and set(item) >= {'name', 'bundle'}, 'import_shape')
            name = item['name']
            require(name in FEATURES or re.fullmatch(r'[a-z][a-z0-9-]{0,39}', name or ''), 'import_feature')
            if delivered(name):
                continue
            filename = f'{name}-v{VERSION}.bundle'
            require(BUNDLE_NAME.fullmatch(filename), 'import_feature')
            target = staging / filename
            raw = (json.dumps(item['bundle'], ensure_ascii=False, separators=(',', ':')) + '\n').encode()
            fd = os.open(str(target), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            try:
                # docker cp -a preserves these runtime ownership bits. A root
                # exec inside hardened runtimes cannot chown (CAP_CHOWN absent).
                os.fchown(fd, 1000, 1000)
                os.fchmod(fd, 0o600)
                os.write(fd, raw)
            finally:
                os.close(fd)
            written.append(filename)
        # Copy into the running instance volume. If the container is down, retry
        # on the next poll; do not start or recreate it here.
        # Ensure the import directory exists, then copy each bundle.
        engine.runner.run(
            ['exec', '-u', '1000:1000', container, 'mkdir', '-p', '/data/openteamily/import'],
            heartbeat=heartbeat, timeout=10)
        for filename in written:
            engine.runner.run(
                ['cp', '-a', str(staging / filename), f'{container}:/data/openteamily/import/{filename}'],
                heartbeat=heartbeat, timeout=15)
            # Never mark delivery successful if the actual runtime cannot read it.
            engine.runner.run(
                ['exec', '-u', '1000:1000', container, 'test', '-r', f'/data/openteamily/import/{filename}'],
                heartbeat=heartbeat, timeout=10)
        for filename in written:
            feature = filename.rsplit('-v', 1)[0]
            engine.runner.run(
                ['exec', '-u', '1000:1000', container, 'sh', '-c',
                 f'touch /data/openteamily/import/.delivered-{feature}-v{VERSION}'],
                heartbeat=heartbeat, timeout=10)
    finally:
        for child in staging.glob('*.bundle'):
            try:
                child.unlink()
            except FileNotFoundError:
                pass
    return {'status': 'imported', 'instance_id': iid, 'features': written, 'seal_key': 'installed'}
