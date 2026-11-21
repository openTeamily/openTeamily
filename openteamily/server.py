"""Loopback-only development WSGI runner, not an internet-facing production server."""
import argparse
from dataclasses import dataclass
import socketserver
from wsgiref.simple_server import WSGIRequestHandler, WSGIServer, make_server

from . import dsbot_gateway
from .app import App, Config
from .store import Store
from .lifecycle import Lifecycle, RuntimePolicy
from .operator_config import load_auto_provision, load_manager_auth, load_operator_admin
from .oidc import load_oidc_providers
from .settings_page import SettingsPage
from .model_http_policy import load_model_http_policy


class QuietHandler(WSGIRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def log_message(self, format, *args):
        # Do not write URLs, queries, cookies or bodies to request logs.
        pass


class ThreadedWSGIServer(socketserver.ThreadingMixIn, WSGIServer):
    """Allow overlapping asset and API requests on the loopback runner.

    This is still not an internet-facing production server.
    """
    daemon_threads = True
    block_on_close = False


@dataclass(frozen=True)
class BuiltApp:
    api: App
    app: object
    gateway: bool = False


def build_app(*, data_dir, origin, insecure_local=False, allow_registration=False,
              simulation=False, compose_image=None, manager_grants=None,
              operator_admin=None, model_http_policy=None, oidc_providers=None,
              auto_provision=None, gateway_key_file=None, require_gateway=False):
    """Build the WSGI app and mount the DS-Bot gateway when it is configured."""
    if simulation and compose_image:
        raise ValueError('Choose simulation OR explicit Compose execution')
    if manager_grants and not (simulation or compose_image):
        raise ValueError('Manager grants require an explicit runtime profile')
    if auto_provision and not manager_grants:
        raise ValueError('Auto-provisioning requires manager grants with an auto_provisioned manager')
    if require_gateway and not gateway_key_file:
        raise dsbot_gateway.GatewayConfigurationError(
            'Production gateway is required but no gateway key file was supplied')
    store = Store(data_dir)
    policy = RuntimePolicy(image_ref=compose_image, profile='local-compose', backend_mode='compose') if compose_image else RuntimePolicy()
    lifecycle = Lifecycle(store, policy) if simulation or compose_image else None
    manager_auth = load_manager_auth(manager_grants) if manager_grants else None
    admin_auth = load_operator_admin(operator_admin) if operator_admin else None
    oidc_registry = load_oidc_providers(oidc_providers) if oidc_providers else None
    http_policy = load_model_http_policy(model_http_policy) if model_http_policy else None
    auto_provision_config = load_auto_provision(auto_provision) if auto_provision else None
    api = App(store, Config(origin=origin, insecure_local=insecure_local,
                            allow_registration=allow_registration), lifecycle=lifecycle,
              manager_auth=manager_auth, operator_admin=admin_auth, oidc_registry=oidc_registry,
              model_http_policy=http_policy, auto_provision=auto_provision_config)
    page = SettingsPage(api)
    if gateway_key_file:
        page = dsbot_gateway.wrap(page, store, api.config, gateway_key_file,
                                  manager_auth=manager_auth)
    return BuiltApp(api=api, app=page, gateway=bool(gateway_key_file))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', required=True)
    parser.add_argument('--origin', required=True)
    parser.add_argument('--port', type=int, default=8080)
    parser.add_argument('--insecure-local', action='store_true')
    parser.add_argument('--open-registration', action='store_true')
    parser.add_argument('--simulation', action='store_true', help='Enable explicitly labelled simulation lifecycle APIs; never runs Docker')
    parser.add_argument('--compose-image', help='Explicit Compose execution profile; operator-supplied image@sha256 digest, never pulled by Web')
    parser.add_argument('--manager-grants', help='Operator-owned private JSON file containing manager credential digests and explicit instance grants')
    parser.add_argument('--operator-admin', help='Operator-owned private JSON file with a credential_hash for admin APIs (platform model API)')
    parser.add_argument('--model-http-policy', help='Private operator file of exact public IPv4 HTTP task-model bases; HTTPS default unchanged')
    parser.add_argument('--oidc-providers', help='Operator-owned private JSON file of OIDC/OAuth client credentials; secrets are never logged')
    parser.add_argument('--auto-provision', help='Private operator JSON enabling one capped, isolated runtime per user personal workspace (default off)')
    parser.add_argument('--gateway-key', help='Operator-owned private DS-Bot gateway key file; mounts /v1/platform/route')
    parser.add_argument('--no-automation-worker', action='store_true',
                        help='Do not start the background automation worker; explicit tick still works')
    args = parser.parse_args()
    if args.simulation and args.compose_image:
        parser.error('Choose simulation OR explicit Compose execution')
    if args.manager_grants and not (args.simulation or args.compose_image):
        parser.error('Manager grants require an explicit runtime profile')
    if args.auto_provision and not args.manager_grants:
        parser.error('Auto-provisioning requires manager grants with an auto_provisioned manager')
    if not 1 <= args.port <= 65535:
        parser.error('Port must be in 1..65535')
    try:
        built = build_app(data_dir=args.data_dir, origin=args.origin,
                          insecure_local=args.insecure_local,
                          allow_registration=args.open_registration,
                          simulation=args.simulation, compose_image=args.compose_image,
                          manager_grants=args.manager_grants, operator_admin=args.operator_admin,
                          model_http_policy=args.model_http_policy, oidc_providers=args.oidc_providers,
                          auto_provision=args.auto_provision, gateway_key_file=args.gateway_key)
    except dsbot_gateway.GatewayConfigurationError as error:
        parser.error(str(error))
    except (OSError, ValueError, TypeError):
        parser.error('Cannot initialize private storage or origin configuration')
    if not args.no_automation_worker:
        built.api.start_automation_worker()
    # Never changes firewall/proxy rules or binds the development service to all interfaces.
    try:
        with make_server('127.0.0.1', args.port, built.app, handler_class=QuietHandler, server_class=ThreadedWSGIServer) as server:
            server.serve_forever()
    finally:
        built.api.stop_automation_worker()


if __name__ == '__main__':
    main()
