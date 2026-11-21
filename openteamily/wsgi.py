"""Production WSGI entrypoint: management app plus the opt-in DS-Bot gateway.

Run with ``gunicorn openteamily.wsgi:app`` (or ``:application``). Required environment:

``OPENTEAMILY_DATA_DIR``
    Private state directory.
``OPENTEAMILY_ORIGIN``
    Exact public HTTP(S) origin.
``OPENTEAMILY_GATEWAY_KEY_FILE``
    Operator-owned gateway key file (0600). Setting it mounts
    ``/v1/platform/route`` and the manager report endpoints.
``OPENTEAMILY_REQUIRE_GATEWAY``
    Set to ``1``/``true`` to refuse startup when the key file is absent. A configured
    gateway that does not actually mount the route also refuses startup.

Other runtime options use the same ``OPENTEAMILY_*`` names as the development CLI.
Without gateway configuration the legacy unwrapped app is returned as before.
"""
from dataclasses import dataclass, replace
import os
from typing import Optional

from . import server


@dataclass(frozen=True)
class Settings:
    data_dir: str
    origin: str
    insecure_local: bool = False
    allow_registration: bool = False
    simulation: bool = False
    compose_image: Optional[str] = None
    manager_grants: Optional[str] = None
    operator_admin: Optional[str] = None
    model_http_policy: Optional[str] = None
    oidc_providers: Optional[str] = None
    auto_provision: Optional[str] = None
    gateway_key_file: Optional[str] = None
    require_gateway: bool = False


def _flag(value):
    return (value or '').strip().lower() in ('1', 'true', 'yes', 'on')


def settings_from_env(environ=None):
    env = os.environ if environ is None else environ
    data_dir, origin = env.get('OPENTEAMILY_DATA_DIR'), env.get('OPENTEAMILY_ORIGIN')
    if not data_dir or not origin:
        raise ValueError('OPENTEAMILY_DATA_DIR and OPENTEAMILY_ORIGIN are required')
    return Settings(
        data_dir=data_dir, origin=origin,
        insecure_local=_flag(env.get('OPENTEAMILY_INSECURE_LOCAL')),
        allow_registration=_flag(env.get('OPENTEAMILY_OPEN_REGISTRATION')),
        simulation=_flag(env.get('OPENTEAMILY_SIMULATION')),
        compose_image=env.get('OPENTEAMILY_COMPOSE_IMAGE'),
        manager_grants=env.get('OPENTEAMILY_MANAGER_GRANTS'),
        operator_admin=env.get('OPENTEAMILY_OPERATOR_ADMIN'),
        model_http_policy=env.get('OPENTEAMILY_MODEL_HTTP_POLICY'),
        oidc_providers=env.get('OPENTEAMILY_OIDC_PROVIDERS'),
        auto_provision=env.get('OPENTEAMILY_AUTO_PROVISION'),
        gateway_key_file=env.get('OPENTEAMILY_GATEWAY_KEY_FILE'),
        require_gateway=_flag(env.get('OPENTEAMILY_REQUIRE_GATEWAY')),
    )


def create_runtime(settings=None, **overrides):
    """Build the app; returns :class:`openteamily.server.BuiltApp`."""
    if settings is None:
        settings = settings_from_env()
    if overrides:
        settings = replace(settings, **overrides)
    return server.build_app(
        data_dir=settings.data_dir, origin=settings.origin,
        insecure_local=settings.insecure_local, allow_registration=settings.allow_registration,
        simulation=settings.simulation, compose_image=settings.compose_image,
        manager_grants=settings.manager_grants, operator_admin=settings.operator_admin,
        model_http_policy=settings.model_http_policy, oidc_providers=settings.oidc_providers,
        auto_provision=settings.auto_provision, gateway_key_file=settings.gateway_key_file,
        require_gateway=settings.require_gateway,
    )


def create_app(settings=None, **overrides):
    """Return the WSGI callable (wrapped when the gateway is configured)."""
    return create_runtime(settings, **overrides).app


def _module_app():
    names = ('OPENTEAMILY_DATA_DIR', 'OPENTEAMILY_ORIGIN',
             'OPENTEAMILY_GATEWAY_KEY_FILE', 'OPENTEAMILY_REQUIRE_GATEWAY')
    if not any(os.environ.get(name) for name in names):
        return None
    return create_app()


app = _module_app()
application = app
