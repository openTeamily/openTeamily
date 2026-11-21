"""Publish a running runtime to the platform gateway (docs/DSBOT_PLUGIN_ARCHITECTURE.md §4.3).

Opt-in with ``"dsbot_gateway": {"web_container": "<exact container name>"}`` in the
manager config. For one granted, running, healthy instance this:

1. attaches the platform web container (whose network namespace the edge and this
   manager share) to that runtime's own ``ot-<id>_default`` network, so runtimes stay
   isolated from each other and no port is published;
2. reads the runtime's private address on that network;
3. takes the DSH launch URL from the start of this process's logs, caching it in the
   private secrets directory keyed by process identity (DSH prints it once per start);
4. exchanges it server-side for the DSH session cookie;
5. reports address + cookie to the platform for this exact process.

Nothing here logs, prints or returns the token or cookie. Docker argv is fixed.
"""
import json
import os
import re
from pathlib import Path

from .. import dsbot_gateway
from .safety import ManagerError, require, json_loads

NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}')
LAUNCH = re.compile(r'http://[0-9.]+:8080/\?token=[A-Za-z0-9_-]{16,256}')


def gateway_config(registry):
    cfg = registry.config.get('dsbot_gateway')
    if cfg is None:
        return None
    require(isinstance(cfg, dict) and set(cfg) == {'web_container'}, 'dsbot_gateway_fields')
    name = cfg['web_container']
    require(isinstance(name, str) and NAME.fullmatch(name) and not name.startswith('ot-'), 'dsbot_gateway_container')
    return cfg


def _inspect(runner, ref, heartbeat):
    raw, _ = runner.run(['inspect', '--type', 'container', ref], heartbeat=heartbeat)
    data = json_loads(raw)
    require(isinstance(data, list) and len(data) == 1 and isinstance(data[0], dict), 'inspect_shape')
    return data[0]


def _cache_path(registry, iid):
    return registry.root / 'secrets' / f'dsbot-launch-{iid}.json'


def _cached_launch(registry, iid, process_ref):
    path = _cache_path(registry, iid)
    try:
        data = json.loads(path.read_text('utf-8'))
    except (OSError, ValueError):
        return None
    if isinstance(data, dict) and data.get('process_ref') == process_ref and LAUNCH.fullmatch(str(data.get('url', ''))):
        return data['url']
    return None


def _store_launch(registry, iid, process_ref, url):
    path = _cache_path(registry, iid)
    tmp = path.with_suffix('.tmp')
    fd = os.open(tmp, os.O_CREAT | os.O_TRUNC | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    try:
        os.write(fd, json.dumps({'process_ref': process_ref, 'url': url}).encode())
    finally:
        os.close(fd)
    os.replace(tmp, path)


def launch_url(engine, iid, process_ref, heartbeat):
    cached = _cached_launch(engine.registry, iid, process_ref)
    if cached:
        return cached
    stdout, stderr = engine.compose(iid, 'logs', heartbeat=heartbeat, tail=100)
    found = LAUNCH.findall(stdout + '\n' + stderr)
    require(found, 'launch_url_missing')
    _store_launch(engine.registry, iid, process_ref, found[-1])
    return found[-1]


def ensure_attached(runner, web_container, network, heartbeat):
    web = _inspect(runner, web_container, heartbeat)
    require(web.get('Name', '').lstrip('/') == web_container, 'dsbot_gateway_container')
    networks = (web.get('NetworkSettings') or {}).get('Networks') or {}
    if network not in networks:
        runner.run(['network', 'connect', network, web_container], heartbeat=heartbeat)


def runtime_address(runner, iid, heartbeat, engine):
    text, _ = engine.compose(iid, 'ps', heartbeat=heartbeat)
    ids = text.split()
    require(len(ids) == 1 and re.fullmatch('[0-9a-f]{64}', ids[0]), 'container_scope')
    container = _inspect(runner, ids[0], heartbeat)
    network = 'ot-' + iid + '_default'
    ip = (((container.get('NetworkSettings') or {}).get('Networks') or {}).get(network) or {}).get('IPAddress')
    require(isinstance(ip, str) and ip, 'runtime_address')
    try:
        return dsbot_gateway.validate_address(ip + ':8080')
    except ValueError:
        raise ManagerError('runtime_address') from None


def publish(engine, client, iid, heartbeat=lambda: None, exchange=dsbot_gateway.exchange_launch_url):
    """Return a non-secret status dict; raise ManagerError on refusal."""
    cfg = gateway_config(engine.registry)
    if cfg is None:
        return {'status': 'gateway_disabled', 'instance_id': iid}
    state = engine.inspect(iid, heartbeat)
    if not (state['present'] and state['healthy'] and state['process_ref']):
        return {'status': 'not_running', 'instance_id': iid}
    network = 'ot-' + iid + '_default'
    ensure_attached(engine.runner, cfg['web_container'], network, heartbeat)
    address = runtime_address(engine.runner, iid, heartbeat, engine)
    url = launch_url(engine, iid, state['process_ref'], heartbeat)
    try:
        cookie = exchange(url, address)
    except (OSError, ValueError):
        raise ManagerError('dsh_exchange') from None
    client.dsbot_upstream(iid, address, cookie, state['process_ref'])
    return {'status': 'published', 'instance_id': iid, 'address': address}
