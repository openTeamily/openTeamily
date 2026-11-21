# features/agent-api (B2)

External Agent API (was `openteamily/gateway.py`). Keys `ota_<instance id>_<secret>`: the platform
routes `/v1/gateway/*` by the instance id to this DS-Bot (`agent-api/invoke`, `agent-api/invocation` with the
Bearer token as `token`); the secret is verified here against a SHA-256 digest. Invocations are native DS-Bot
turns via `agents/turn`. Owner side: `agent-api/keys|key-create|key-revoke`.
