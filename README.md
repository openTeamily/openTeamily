# OpenTeamily

An independent, open-source, self-hostable project targeting full Teamily feature parity. This is a new project under the openTeamily organization, not a continuation of development in the original FlyBot repository.

OpenTeamily is a project name, not a claim of affiliation with or endorsement by Teamily. Final product branding remains open; no proprietary code, logos, fonts or legal text are included.

## Status

**Current slice:** a runnable Python/SQLite authentication, workspace, and simulated instance/jobs API; an **opt-in operator Compose execution CLI** (default disabled) with HTTP/subprocess-stub tests; and a first, minimal source import of related FlyBot and Bot Social trees. Live Docker/FlyBot/real-volume acceptance, management integration of the imported trees, and browser workflows remain **unverified or missing**. See [operator setup, recovery, evidence limits and next tasks](docs/COMPOSE_MANAGER.md), [lifecycle scope and remaining gates](docs/RUNTIME_IMPLEMENTATION.md), and [implemented routes, startup/test commands, security configuration and gaps](docs/MANAGEMENT_API.md). Older FlyBot tests, screenshots and PRs do not establish functionality in this repository.

**Agent runtime baseline:** the runtime tracks upstream DS Bot's latest release, currently v0.3.8, pinned in `runtime/ds-bot-upstream.pin.json`. CI checks that the vendored tree is unmodified, runs upstream's own suite on the DSH version the pin names, and runs upstream's container startup test. A daily workflow opens a pull request when a newer upstream release exists. See [runtime/ds-bot-upstream/UPSTREAM.md](runtime/ds-bot-upstream/UPSTREAM.md).

## Architecture

- **Management server:** accounts, authentication, runtime lifecycle and routing to the authorized user’s DS-Bot.
- **DS-Bot:** each user has one isolated instance for agents and personal workloads. The same instance serves that user across workspaces.
- **Dedicated Bot Social:** manages shared workspaces, membership, group messaging and public sharing.
- Instance IDs are independent of user and workspace IDs. See the [architecture](docs/ARCHITECTURE.md) for service boundaries.
- FlyBot customization (the social plugin and instance docker helpers) and Bot Social protocol source are imported as isolated snapshots under [`runtime/flybot`](runtime/flybot/ORIGIN.md) and [`services/bot-social`](services/bot-social/ORIGIN.md); they keep their original licenses and are not relicensed as OpenTeamily MIT. This tree does not vendor the old FlyBot `core/` fork. The runtime baseline is the pinned upstream DS-Bot v0.3.8 tree under [`runtime/ds-bot-upstream`](runtime/ds-bot-upstream/UPSTREAM.md). See [migration notes](docs/upstream/MIGRATION.md), [gaps](docs/upstream/GAPS.md) and [licensing](docs/LICENSING.md).

## Next steps

1. Review the architecture and full capability map.
2. Create native issues/subissues in **this repository**, including dependencies and observable acceptance criteria.
3. Review the authentication/workspace foundation, then deliver durable runtime jobs and the fake backend; review the opt-in manager/Compose adapter, then perform separately approved real container and Teamily comparison acceptance.

See [architecture](docs/ARCHITECTURE.md), [capability roadmap](docs/ROADMAP.md) and [reuse policy](docs/REUSE_POLICY.md).

## License

New material authored in this repository is licensed under MIT; see [LICENSE](LICENSE). This does not relicense any FlyBot, Bot Social, runtime or third-party material.

Imported FlyBot customization source remains Apache-2.0 with its `NOTICE`. Imported Bot Social source remains MIT, Copyright (c) 2026 Birfy. `runtime/ds-bot-upstream/` is an unmodified, pinned copy of upstream [DS Bot](https://github.com/Fei2411/DS-Bot) under the **Apache License 2.0** (its `LICENSE` and `NOTICE` are kept there). No upstream git history is imported. See [docs/LICENSING.md](docs/LICENSING.md) and [runtime/ds-bot-upstream/UPSTREAM.md](runtime/ds-bot-upstream/UPSTREAM.md).
