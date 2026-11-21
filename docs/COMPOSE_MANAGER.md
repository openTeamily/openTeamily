# Opt-in local Compose manager (stacked after PR17)

This is an **implemented operator execution path**, not a planner pretending to run.
`python3 -m openteamily.manager` can send authenticated local HTTP, run a configured
Docker executable, inspect real engine state, collect operator logs and recover an
interrupted instance through a new fenced STOP job. It is **disabled by default**.

**Evidence boundary:** tests use temporary real loopback HTTP, SQLite, a spawned
manager CLI and actual subprocesses executing `tests/fixtures/docker_stub.py`.
That executable is a **stub, not Docker**. On the implementation box, read-only
checks found neither a `docker` executable nor the standard Docker sockets; no
Docker command/image pull/build/container/host or network configuration was run.
Live Docker, an actual FlyBot image, real volume contents and real healthchecks
remain **unverified**. No browser/Teamily operation or product-parity verdict is
implied. Do not close the overall lifecycle or product tracking issue.

## Scope and prerequisites

- Linux/POSIX, Python 3.11+, operator-installed Docker Engine and Compose v2.
- Web process **does not import the manager or receive a Docker socket**. Use a
  separate unprivileged Web identity/container with no Docker group/socket access;
  the operator manager is privileged. Same-UID development is not a security
  boundary against a compromised Web process.
- Manager HTTP connection is numeric loopback HTTP only (`127.0.0.1` / `::1`,
  explicit port), direct/no proxies, redirects, cookies, Origin, credential URLs or
  DNS. The operator's `server_host` supplies the server's exact configured origin
  netloc as Host, **without changing the numeric-loopback connection target**. Public ingress must deny `/v1/internal/` entirely: a local reverse proxy's
  loopback peer is not proof that its original caller was local.
- A **locally preloaded, operator-supplied digest-pinned image**; the server still
  does not pull or build images itself and does not claim license-completeness.
  Image contract: UID/GID1000, `/data` writable by that UID (image directory
  ownership is copied to a new named volume), read-only rootfs except `/data`
  and tmpfs `/tmp`, TCP8080 if optionally published, and a functioning Docker
  HEALTHCHECK. Operators can build that image from `runtime/flybot-image/` and
  pass the resulting `name@sha256:…` to `--compose-image`. CI smokes the
  recipe under this contract; that is not a live management-server acceptance
  on this machine, and issue #3 still blocks a public redistributable release.
  Add a checked CMD healthcheck argv in operator config only if the image
  lacks one; absent/unhealthy checks **do not become ready**.
- One registered instance is one Compose project/container/volume in this first
  adapter. This does not decide the final user/workspace allocation policy.
- One active operator executor/state directory per instance/engine. `flock` prevents
  concurrent local invocations; this is not a distributed/HA runtime coordinator.

## Execution profile versus planning

PR17's `compose-planning` still returns501 on claim: plans must remain non-executable.
This follow-up adds a distinct **`compose`** mode, claimable with matching grants,
selected on the server with `--compose-image <image@sha256:...>`. There is no silent
conversion of simulation/planning records; create a new explicit Compose instance.
Simulation and original API tests remain unchanged. Private claims in Compose mode
also include the previous process_ref; public snapshots still omit it.

The Web runner is still a loopback **development WSGI runner**, not a hardened
Internet-facing server. Use a separately reviewed production WSGI/HTTPS deployment
before exposing it. No deployment/service installation happens in this PR.

## Operator bootstrap (manual; NOT performed by tests)

1. With an already-preloaded compatible image, start the management development API
   with `--compose-image "$IMAGE"` and normal private storage/origin options from
   [MANAGEMENT_API.md](MANAGEMENT_API.md). Create an account, workspace and instance
   through the authenticated/CSRF owner API; retain its 32-hex `INSTANCE_ID`. No
   request may choose paths, commands, image, environment or mounts.
2. In a new operator-owned private parent directory, create disabled configuration:

   ```sh
   # IMAGE is an operator-provided locally preloaded repository@sha256 digest.
   python3 -m openteamily.manager init \
     --state-dir "$HOME/ot-private/manager-fixture" \
     --instance-id "$INSTANCE_ID" --image "$IMAGE" \
     --base-url http://127.0.0.1:8080 --server-host 127.0.0.1:8080 \
     --docker /usr/bin/docker --socket /run/docker.sock
   ```

   The parent directory must already exist, be owned by the operator/root and not
   group/world-writable; state is new0700, files0600, no overwrite. stdout contains
   paths only, never the generated bearer secret. `manager.json` contains the
   manager token; **do not paste it into chat, logs, URLs, process arguments or git**.
   `grants.json` contains only its SHA256 digest and exact instance/mode grants.
3. Install **only the digest grants file** into the Web identity's private directory
   with the correct owner/mode, then restart/reload the development server with
   `--manager-grants /absolute/server-private/grants.json` and the same Compose image
   and persistent DB. The development loader requires an explicit operator restart.
   Do not copy the bearer-bearing manager file to Web. A new instance needs an
   explicit corresponding operator registry/grant update; no wildcard auto-enrollment.
4. Inspect `manager.json` privately, explicitly set `execution_enabled` to true and
   retain mode0600/dir0700. `--execute` is required on **every** operational command:

   ```sh
   # plan is file-only, never HTTP or Docker; generated Compose JSON must not be edited.
   python3 -m openteamily.manager --config "$CONFIG" plan --instance-id "$INSTANCE_ID"
   python3 -m openteamily.manager --config "$CONFIG" --execute run-once --instance-id "$INSTANCE_ID"
   python3 -m openteamily.manager --config "$CONFIG" --execute inspect --instance-id "$INSTANCE_ID"
   python3 -m openteamily.manager --config "$CONFIG" --execute logs --instance-id "$INSTANCE_ID" --tail 30
   ```

   Issue owner start/stop/restart intents through the existing owner API, then invoke
   run-once. This CLI is a one-shot worker, **not an installed daemon**. Repeated
   calls do not reexecute an already claimed/completed job. Optional `publish_port`
   maps only `127.0.0.1:<operator-port>` to8080; never all interfaces. The runtime's
   own authentication remains necessary. Default is no published port.

## Whitelist, bounds and readiness

`manager.json` exact fields: version1, execution_enabled(boolean), base_url,
server_host, manager_id, token, docker(absolute executable), socket(absolute local
Unix socket), instances. Each of at most100 instance entries has **only** image,
healthcheck(CMD argv or null), publish_port(integer1024..65535 or null). Repeated
host ports, unknown keys, mutable images and caller-selected Compose files fail.

The manager generates canonical JSON Compose in its private state directory and
checks its exact content again before use. There is no include/build, custom
service command/entrypoint/env_file, host/PID namespace, privileged mode,
Docker socket mount or arbitrary argv. The only data mount is named volume
`ot-<instance-id>` at `/data`, retained on stop. The only bind mounts are the
manager-generated, read-only model API secret file
(`secrets/model-api-<instance-id>.json` under the private state directory,
readable by container user 1000) at `/run/secrets/openteamily-model-api.json`, and the
manager-generated, read-only Bot Social URL file
(`secrets/bot-social-<instance-id>.json`, readable by container user 1000) at
`/run/secrets/openteamily-bot-social.json`. Operators and API
clients cannot choose those paths. Request-selected mounts stay rejected.
The files are written or refreshed before create, start or restart; when no
key or server is configured the corresponding file is empty. The model API
key and any Bot Social connector token are never placed in Compose
environment, the image, or user or manager claim/observe JSON. The manager upgrades
frozen `compose-*.json` files with missing allowlisted secret binds or the former 1 GiB
memory limit. On the next create, start, or restart it recreates the container with
`--force-recreate` to apply the updated manifest. The 1.5 GiB limit gives the local
meeting recognizer room to run alongside DS-Bot. The named volume
`ot-<instance-id>` and existing secret files are never deleted; `down`,
`volume rm`, and `-v` stay off the allowlist. Operators can preview or apply
this with `python3 -m openteamily.manager --config … migrate-manifest --instance-id …`
(add `--apply` to write). Any other compose drift still fails closed as
`manifest_changed` and still does not touch the volume. It enforces nonroot UID, no new
privileges, dropped capabilities, read-only rootfs, resource caps and bounded local
logging. Existing container project/service/image, mount, privilege, user, namespace,
network and published-port metadata are checked; existing volume Compose ownership
labels must match, with local driver and no custom driver options (no disguised host bind). No pull/down/rm/exec/kill/purge or `-v` command is emitted.

Trusted file/executable paths must be absolute, owned by the operator/root, not
symlinks or group/world-writable, including ancestors (root-owned sticky `/tmp`
allowed above a private fixture directory). Manager config/Compose/lock files and
state directory must be private and operator-owned. No private configuration path
is accepted through HTTP. Same-UID/root/Docker administrators remain trusted; this
is not a defense against an administrator racing the filesystem or daemon.

Subprocesses use shell=False, exact arrays, stdin closed, a private Docker home and
Unix host, a minimal env (no inherited DOCKER_*/COMPOSE_*/proxy/LD_PRELOAD), and a
new process group. Combined stdout/stderr is capped at64KiB; overflow discards output
and fails closed. Engine reads/logs max10s, lifecycle command max60s, health polling
max30s including subprocess time. HTTP response128KiB/request16KiB, total HTTP
header/body deadline2s; no application-level retry. Public exceptions are generic.

Create uses `compose create`, not up: it must leave an existing stopped container.
Start uses `up --no-build --no-recreate --pull never`; stop preserves volumes;
restart is a **single Compose restart** (also valid for a stopped existing container).
The manager requires the registered container's health=healthy, not merely exit0 or
running. Process identity is SHA256(container ID + exact StartedAt)[:32], so the
same container ID after restart still requires a changed process start. Both the
actual pre-restart identity and the server's previous identity are fenced.

A lease guard renews **while subprocesses and readiness checks run**, not afterwards.
Renewal/command/ready uncertainty kills only the manager's own subprocess group,
posts no invented observation, stops renewing and leaves the server to interrupt
and block the job on expiry. Killing a Docker CLI cannot cancel an already submitted
daemon operation: **do not automatically retry or recover it**.

## Explicit recovery: new fenced STOP, never replay an uncertain restart

After job expiry, inspect first. Wait for/terminate old executors appropriately and
independently ensure **all previously submitted daemon work is quiescent**. The CLI
cannot cryptographically prove daemon quiescence; the operator must attest it. Do
not use the flag as a blind retry button. A running but quiescent container can be
safely stopped by the **new leased** recovery job; no unleased stop is performed.

```sh
# default dry-run; no recover POST or DB modification
python3 -m openteamily.manager --config "$CONFIG" --execute recover --instance-id "$INSTANCE_ID"
# explicit scoped/revision-fenced operator attestation; use one stable key on retry
python3 -m openteamily.manager --config "$CONFIG" --execute recover \
  --instance-id "$INSTANCE_ID" --apply --confirm-no-active-executors \
  --expected-revision "$BLOCKED_REVISION" --operation-id operator-recovery-0001
python3 -m openteamily.manager --config "$CONFIG" --execute run-once --instance-id "$INSTANCE_ID"
```

The new authenticated route is POST `/v1/internal/instances/{id}/recover`, fields
`expected_revision` positive int, `operation_id`16..64 safe chars, and exact
`confirmation:"quiesced-executors"`. Same loopback bearer, no browser/Origin/Cookie,
exact instance and `compose` mode grants. Only blocked/interrupted or runtime-failed
instances with no queued/running job may recover. Atomic CAS increments revision,
clears the latch into **unknown, not successful**, sets desired=stopped and queues
operation_type=recover. A normal claim/lease/heartbeat/STOP/inspect/observe must
confirm it; start/restart cannot supersede pending recovery. An old lease stays
invalid. Same operation key replays its job without a new revision; inspect current
intent if a historical key is replayed. No direct DB edits, auto-requeue, automatic
resume, data deletion or purge. Owner may explicitly start only after STOP converges.

## Logs and concrete remaining tasks

- **Implemented:** local authenticated/grant-checked operator `logs`, tail1..100,
  bounded capture, known secret/quoted-key/bearer/private-key/long-token redaction
  before output. No raw command error/body logging. Regex redaction is not a full
  DLP guarantee; operator runtime text can still contain unknown sensitive material.
  Do not share it automatically or treat it as safe browser output.
- **Not implemented:** tenant/browser runtime log API. Existing owner `/logs`
  remains structured control-plane events with runtime_logs_supported=false.
  Next task: bounded authenticated manager-to-server log spool, scoped owner read,
  privacy/schema filtering, retention/rotation/drop indicators, then cross-owner
  and secret-leak tests plus real container verification. No invented raw log route.
- Next runtime task: verify this exact adapter on an isolated real Engine/Compose
  and a license-cleared compatible FlyBot runtime; collect version/digest, real
  health/StartedAt, process restart, actual `/data` sentinel before/after stop/restart,
  logs, crash/recovery and cleanup evidence. The stub does not satisfy that gate.
- Next service task: reviewed supervisor/polling and enrollment/grant rotation,
  deployment packaging/HTTPS and production operating procedures. Backup, restore,
  upgrade, purge remain unsupported separate tasks, not silently successful.
- UI/launch exchange, full image/dependency licensing and **itemized real Teamily
  comparison remain pending**. No Teamily internal architecture equivalence is claimed.

## Repeatable acceptance

```sh
# Safe temporary SQLite + local HTTP + actual subprocess STUB only:
scripts/accept-compose-manager-stub.sh
# Full original + new suite (Node planner requires trusted Node per runtime docs):
OPENTEAMILY_PLANNER_NODE="$(command -v node)" python3 -m unittest discover -s tests -v
node --test manager/compose-planner/compose-command-planner.test.js
```

On a **separately approved isolated real fixture**, after owner create/start/stop/
restart intents, `scripts/accept-compose-manager-stage.py --config "$CONFIG"
--instance-id "$INSTANCE_ID" --expected stopped|running|restart
--confirm-isolated-fixture` drains and verifies that stage. Restart additionally
requires `--previous-process-ref <previous inspect ref>`. It never pulls/builds or
cleans up volumes. It does not prove application-level behavior or persisted file
contents: retain separate private real `/data` sentinel evidence and perform manual
cleanup only after operator approval. The real-stage script has not been run here.

Official command references verified during implementation:
[create](https://docs.docker.com/reference/cli/docker/compose/create/),
[up](https://docs.docker.com/reference/cli/docker/compose/up/),
[ps](https://docs.docker.com/reference/cli/docker/compose/ps/),
[restart](https://docs.docker.com/reference/cli/docker/compose/restart/).

### Exact volume preflight (F-PR19-01)

The manager now runs `docker volume inspect ot-<instance_id>` directly. It does
not use `volume ls` name filters or infer absence from a successful empty list.
An existing volume must have exactly the expected name, local driver/scope, no
driver options, and the expected Compose project/data labels.

Only exit status 1, JSON stdout `[]`, and a single exact, target-bound English
missing-volume diagnostic are classified as absence. Supported diagnostic forms
are `Error response from daemon: get <name>: no such volume` and
`Error: No such volume: <name>`. Other errors, extra diagnostics, wrong names,
unexpected exit status, invalid metadata, or warnings fail closed. The child
locale remains `C.UTF-8`. An unrecognized Docker/CLI variant needs operator
investigation; it is not silently treated as an absent volume. Child output is
bounded and retained only for internal classification; public exceptions remain
codes, never raw engine diagnostics.

The disposable subprocess stub now has a literal-substring filter model and
exact inspect errors. Its regression proves preflight does not depend on that
model's filtering, plus wrong ownership/driver/options/metadata and error denial.
This is **not** a real-daemon confirmation of the old filter's behavior or a
successful Docker/volume-retention acceptance. No Docker engine is available in
the implementation environment; real Docker/FlyBot compatibility remains pending.
