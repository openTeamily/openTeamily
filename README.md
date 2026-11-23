# OpenTeamily

An independent, open-source, self-hostable project targeting full Teamily feature parity. This is a new project under the openTeamily organization, not a continuation of development in the original FlyBot repository.

OpenTeamily is a project name, not a claim of affiliation with or endorsement by Teamily. Final product branding remains open; no proprietary code, logos, fonts or legal text are included.

## Architecture

- **Management server:** accounts, authentication, runtime lifecycle and routing to the authorized user’s DS-Bot.
- **DS-Bot:** each user gets one isolated container running DS-Bot, the Bot Social plugin, and the OpenTeamily web plugin. The same container serves that user across workspaces. Agents, private chat, skills, memory, and automations run there.
- **Dedicated Bot Social:** manages shared workspaces, membership, group messaging and public sharing.
- Instance IDs are independent of user and workspace IDs. See the [architecture](docs/ARCHITECTURE.md) for service boundaries.
- The [runtime pin](runtime/ds-bot-upstream.pin.json) identifies the bundled DS-Bot and DSH releases. The FlyBot Social plugin and Bot Social service are tracked as separate source imports. See [migration notes](docs/upstream/MIGRATION.md) and [licensing](docs/LICENSING.md).

## Deployment and verification

- [Compose manager setup and recovery](docs/COMPOSE_MANAGER.md)
- [Dedicated Bot Social and gateway deployment](deploy/isolated/BOT_SOCIAL_DEPLOY.md)
- [Management API](docs/MANAGEMENT_API.md) and [DS-Bot plugin contract](docs/DSBOT_PLUGIN_ARCHITECTURE.md)

The [container workflow](.github/workflows/flybot-runtime-image.yml) checks provisioning, volume retention, account routing and collaboration between two DS-Bots through Bot Social. The [browser workflow](.github/workflows/ui-screenshots.yml) exercises sign-in, streamed chat, group creation, mobile layout and account isolation in Chromium using synthetic accounts and model replies. See the [capability roadmap](docs/ROADMAP.md) for remaining work.

## License

New material authored in this repository is licensed under MIT; see [LICENSE](LICENSE). This does not relicense any FlyBot, Bot Social, runtime or third-party material.

Imported FlyBot customization source remains Apache-2.0 with its `NOTICE`. Imported Bot Social source remains MIT, Copyright (c) 2026 Birfy. `runtime/ds-bot-upstream/` is an unmodified, pinned copy of upstream [DS Bot](https://github.com/Fei2411/DS-Bot) under the **Apache License 2.0** (its `LICENSE` and `NOTICE` are kept there). No upstream git history is imported. See [docs/LICENSING.md](docs/LICENSING.md) and [runtime/ds-bot-upstream/UPSTREAM.md](runtime/ds-bot-upstream/UPSTREAM.md).
