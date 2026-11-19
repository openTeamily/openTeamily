"""FlyBot connection daemon for a self-hosted OpenTeamily server.

Authenticate with a runtime key, register, heartbeat, and run allowlisted
tasks: `echo` or `infer`. Infer uses a one-time model-access grant from the
management server and an OpenAI-compatible provider URL. Payloads are never
passed to a shell, and credentials are never logged.

Start from a checkout, or from the downloaded zipapp:

  python3 -m openteamily.flybot daemon start --origin <origin> --key-file <path>
  python3 flybot.pyz daemon start --origin <origin> --key-file <path>

Do not pipe install scripts into a shell. HTTP origins other than loopback
are rejected; HTTPS is required for non-loopback hosts.
"""
import argparse
import ipaddress
import json
import os
import ssl
import stat
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

USER_AGENT = 'FlyBot-OpenTeamily-agent/1'


class AgentError(Exception):
    def __init__(self, status, body):
        self.status, self.body = status, body
        message = 'request failed'
        if isinstance(body, dict) and isinstance(body.get('error'), dict):
            message = body['error'].get('message') or message
        super().__init__(message)


def valid_origin(value):
    parsed = urlsplit(value)
    if (parsed.scheme not in ('http', 'https') or not parsed.hostname
            or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment):
        return False
    if parsed.scheme == 'https':
        return True
    try:
        return ipaddress.ip_address(parsed.hostname).is_loopback
    except ValueError:
        return parsed.hostname in ('localhost',)


def valid_provider_url(value):
    parsed = urlsplit(value)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
        return False
    if parsed.scheme == 'https':
        return True
    try:
        return ipaddress.ip_address(parsed.hostname).is_loopback
    except ValueError:
        return parsed.hostname in ('localhost',)


def read_key_file(path):
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    fd = os.open(path, flags)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError('Key file must be a private regular file owned by this user')
        raw = os.read(fd, 256)
    finally:
        os.close(fd)
    token = raw.decode('utf-8').strip()
    if not token or len(token) > 128 or any(c.isspace() for c in token):
        raise ValueError('Key file must contain a single runtime key')
    return token


def request(origin, method, path, token, body=None, timeout=10):
    payload = None if body is None and method == 'GET' else json.dumps(body if body is not None else {}).encode()
    headers = {'Accept': 'application/json', 'Authorization': 'Bearer ' + token, 'User-Agent': USER_AGENT}
    if payload is not None:
        headers['Content-Type'] = 'application/json'
    req = Request(origin + path, data=payload, headers=headers, method=method)
    context = ssl.create_default_context() if urlsplit(origin).scheme == 'https' else None
    try:
        with urlopen(req, timeout=timeout, context=context) as response:
            raw = response.read()
            status = response.status
    except HTTPError as error:
        raw = error.read()
        status = error.code
    except URLError as error:
        raise AgentError(0, {'error': {'code': 'network', 'message': 'Cannot reach the management server'}}) from error
    try:
        parsed = json.loads(raw.decode('utf-8')) if raw else {}
    except (UnicodeError, ValueError):
        parsed = {}
    if status >= 400:
        raise AgentError(status, parsed if isinstance(parsed, dict) else {})
    return status, parsed if isinstance(parsed, dict) else {}


def completions_url(base):
    base = (base or '').rstrip('/')
    if base.endswith('/chat/completions'):
        return base
    return base + '/chat/completions'


def infer_chat(model_api, prompt, timeout=30, opener=urlopen, tools=None, execute_tool=None):
    if not isinstance(model_api, dict):
        raise AgentError(0, {'error': {'message': 'Model access was empty'}})
    provider = model_api.get('provider')
    base = model_api.get('base_url')
    model = model_api.get('model')
    key = model_api.get('api_key')
    if provider not in ('openai', 'custom') or not valid_provider_url(base) or not model or not key:
        raise AgentError(0, {'error': {'message': 'Model access is incomplete or not allowed'}})
    messages = [{'role': 'user', 'content': prompt}]
    for _round in range(5):
        request_body = {'model': model, 'messages': messages, 'max_tokens': 512}
        if tools:
            request_body.update(tools=tools, parallel_tool_calls=False)
        payload = json.dumps(request_body).encode()
        headers = {'Accept': 'application/json', 'Content-Type': 'application/json',
                   'Authorization': 'Bearer ' + key, 'User-Agent': USER_AGENT}
        req = Request(completions_url(base), data=payload, headers=headers, method='POST')
        context = ssl.create_default_context() if urlsplit(base).scheme == 'https' else None
        try:
            try:
                response = opener(req, timeout=timeout, context=context)
            except TypeError:
                response = opener(req, timeout=timeout)
            with response:
                raw = response.read(65537)
            if len(raw) > 65536:
                raise ValueError()
            parsed = json.loads(raw.decode('utf-8'))
            message = parsed['choices'][0]['message']
            calls = message.get('tool_calls')
            if not calls:
                text = message.get('content')
                if not isinstance(text, str):
                    raise ValueError()
                return text
            if not execute_tool or not isinstance(calls, list) or len(calls) > 4:
                raise ValueError()
            messages.append({'role': 'assistant', 'content': message.get('content'), 'tool_calls': calls})
            for call in calls:
                name = call['function']['name']
                if name not in [t['function']['name'] for t in tools or []]:
                    raise ValueError()
                args = json.loads(call['function']['arguments'])
                result = execute_tool(call['id'], name, args)
                messages.append({'role': 'tool', 'tool_call_id': call['id'], 'content': json.dumps(result)})
        except HTTPError as error:
            raise AgentError(error.code, {'error': {'message': 'Model provider rejected the request'}}) from None
        except URLError:
            raise AgentError(0, {'error': {'message': 'Cannot reach the model provider'}}) from None
        except (KeyError, IndexError, TypeError, ValueError, UnicodeError):
            raise AgentError(0, {'error': {'message': 'Model provider returned an unexpected body'}}) from None
    raise AgentError(0, {'error': {'message': 'Tool round limit exceeded'}})


def connected_tool_bridge(task, origin, token, requester=request, sleeper=time.sleep, clock=time.time):
    path = '/v1/agent/tasks/' + task['id'] + '/tools'
    tools = requester(origin, 'POST', path, token, {})[1].get('tools', [])

    def execute(call_id, name, arguments):
        row = requester(origin, 'POST', path + '/calls', token,
                        {'call_id': call_id, 'name': name, 'arguments': arguments})[1]['call']
        deadline = min(clock() + 40, task.get('deadline', clock() + 40) - 1)
        while row['status'] in ('pending', 'approved') and clock() < deadline:
            sleeper(1)
            requester(origin, 'POST', '/v1/agent/heartbeat', token, {})
            row = requester(origin, 'POST', path + '/calls/' + row['id'], token, {})[1]['call']
        return row.get('result') or {'error': 'tool_' + row['status'],
                                    'note': 'Owner approval required in Settings > App connectors. No implicit retry.'}
    return tools, execute


def echo_result(prompt):
    return {'echo': prompt}


def handle_task(task, origin=None, token=None, requester=request, inferer=infer_chat, infer_timeout=30):
    if not isinstance(task, dict):
        return 'failed', {'error': 'unsupported task kind'}
    kind = task.get('kind')
    prompt = task.get('prompt')
    if not isinstance(prompt, str):
        return 'failed', {'error': 'invalid prompt'}
    if kind == 'echo':
        return 'succeeded', echo_result(prompt)
    if kind == 'infer':
        if not origin or not token:
            return 'failed', {'error': 'missing agent credentials'}
        model_api = None
        try:
            access = requester(origin, 'POST', '/v1/agent/tasks/' + task['id'] + '/model-access', token, {})[1]
            model_api = access.get('model_api') if isinstance(access, dict) else None
            if access.get('connected_tools') and inferer is infer_chat:
                tools, execute = connected_tool_bridge(task, origin, token, requester)
                text = inferer(model_api, prompt, timeout=infer_timeout, tools=tools, execute_tool=execute)
            else:
                text = inferer(model_api, prompt, timeout=infer_timeout)
            return 'succeeded', {
                'text': text,
                'model': model_api.get('model') if isinstance(model_api, dict) else None,
                'source': model_api.get('source') if isinstance(model_api, dict) else None,
            }
        except (AgentError, OSError, TimeoutError):
            return 'failed', {'error': 'Inference or connected tool request failed; no automatic retry'}
        finally:
            if isinstance(model_api, dict):
                model_api.pop('api_key', None)
    return 'failed', {'error': 'unsupported task kind'}


def run_cycle(origin, token, hostname, once=False, poll=1.0, sleeper=time.sleep, requester=request, inferer=infer_chat, infer_timeout=30):
    status, connected = requester(origin, 'POST', '/v1/agent/connect', token, {'hostname': hostname})
    if status not in (200, 201):
        raise AgentError(status, connected)
    processed = []
    while True:
        requester(origin, 'POST', '/v1/agent/heartbeat', token, {})
        listed = requester(origin, 'GET', '/v1/agent/tasks', token)[1]
        items = listed.get('items') or []
        for task in items:
            claimed = requester(origin, 'POST', '/v1/agent/tasks/' + task['id'] + '/claim', token, {})[1]
            payload = claimed.get('task') or task
            outcome, result = handle_task(
                payload, origin=origin, token=token, requester=requester,
                inferer=inferer, infer_timeout=infer_timeout)
            requester(origin, 'POST', '/v1/agent/tasks/' + payload['id'] + '/result', token,
                      {'status': outcome, 'result': result})
            processed.append(payload['id'])
        if once:
            return connected.get('connection'), processed
        sleeper(poll)


def main(argv=None, stdout=None, stderr=None):
    stdout = stdout or sys.stdout
    stderr = stderr or sys.stderr
    parser = argparse.ArgumentParser(prog='openteamily.flybot', description=__doc__)
    sub = parser.add_subparsers(dest='group', required=True)
    daemon = sub.add_parser('daemon')
    action = daemon.add_subparsers(dest='action', required=True)
    start = action.add_parser('start', help='Register with the management server and poll for tasks')
    start.add_argument('--origin', required=True, help='Exact management origin, such as https://management.example')
    key = start.add_mutually_exclusive_group(required=True)
    key.add_argument('--key-file', help='Private file containing the runtime key (preferred)')
    key.add_argument('--key', help='Runtime key (for tests only; prefer --key-file)')
    start.add_argument('--hostname', default='flybot')
    start.add_argument('--once', action='store_true', help='Connect, drain queued tasks, and exit')
    start.add_argument('--poll', type=float, default=1.0)
    start.add_argument('--infer-timeout', type=float, default=30)
    args = parser.parse_args(argv)
    if args.group == 'daemon' and args.action == 'start':
        if not valid_origin(args.origin):
            parser.error('Origin must be https, or http on a loopback address, without a path')
        if not 0.1 <= args.poll <= 60:
            parser.error('--poll must be between 0.1 and 60 seconds')
        if not 1 <= args.infer_timeout <= 120:
            parser.error('--infer-timeout must be between 1 and 120 seconds')
        try:
            token = read_key_file(args.key_file) if args.key_file else args.key
        except (OSError, ValueError):
            print('Cannot read the runtime key', file=stderr)
            return 2
        try:
            connection, processed = run_cycle(
                args.origin.rstrip('/'), token, args.hostname, once=bool(args.once),
                poll=args.poll, infer_timeout=args.infer_timeout)
        except AgentError as error:
            print('FlyBot daemon: ' + str(error), file=stderr)
            return 1
        if args.once:
            print('connected ' + connection['id'] + ' tasks ' + str(len(processed)), file=stdout)
            return 0
        return 0
    parser.error('Unsupported command')
    return 2


if __name__ == '__main__':
    sys.exit(main())
