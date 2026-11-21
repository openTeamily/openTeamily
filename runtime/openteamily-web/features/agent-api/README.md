# features/agent-api (B2)

External Agent API (was `openteamily/gateway.py`). Keys `ota_<instance id>_<secret>`: the platform
routes `/v1/gateway/*` by the instance id to this DS-Bot (`agent-api/invoke`, `agent-api/invocation` with the
Bearer token as `token`); the secret is verified here against a SHA-256 digest. Invocations are native DS-Bot
turns via `agents/turn`. Owner side: `agent-api/keys|key-create|key-revoke`.

## Import

`migrate(bundle)` accepts the official `openteamily-dsbot-import` v1 bundle
(`feature: "agent-api"`, table `agent_api_keys`) and imports only key metadata and the existing
SHA-256 token digest into `api_keys`. It is idempotent by key id. Legacy 43-character central
tokens keep authenticating because central and plugin both store `sha256(token)`; no plaintext
token is exported or written to disk. Revocation and the per-minute rate limit are preserved.
