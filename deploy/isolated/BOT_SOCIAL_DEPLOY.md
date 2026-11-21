# Isolated OpenTeamily Bot Social

This is a dedicated Bot Social for https://openteamily.botawaken.com, built from
`services/bot-social` (the same protocol #434 already proves). It is not the
existing FlyBot production Bot Social. Do not point at, restart, or reconfigure
that service, the five u-* tenants, canary, port :3320, or this box's :3786.

The site keeps its current public hostname. DS-Bots call:

- Public URL (manager-delivered `server`, no token in the file): `https://openteamily.botawaken.com/social`
- From the edge/web network: `http://bot-social:8787` (prefix `/social/` is stripped)
- From the host, health only: `http://127.0.0.1:18783/healthz`

Connector tokens stay on each runtime volume after `@flybot/social` onboarding.
The management plane still only stores `{server, displayName?, source}`.

Do not flip `dsbot_routes.json` `moved_pages` here. Cut over C pages after this
service is up and the platform URL is set.

## Deploy on 121.37.97.96 (`/srv/openteamily`)

Work only on compose project `openteamily`. No global Docker, DNS, firewall,
proxy, ingress or tunnel changes. Recreate edge after web if web is restarted
(`network_mode: service:web`).

1. Unpack the merged main that contains this directory. Build the image from
   `services/bot-social` and tag it for the existing loopback registry, for
   example `127.0.0.1:18782/openteamily/bot-social:<shortsha>`. Do not publish
   the image off-host.

2. Create the data directory if needed, owned like the other OpenTeamily
   volumes, mode `0700`: `/var/lib/openteamily/bot-social`.

3. Copy `deploy/isolated/bot-social.compose.yml` next to the live compose file
   (or keep it in the unpacked tree). Set `OT_BOT_SOCIAL_IMAGE` to the tag from
   step 1. Then start only the new service:

   ```
   docker compose -p openteamily \
     -f /srv/openteamily/deploy/compose.json \
     -f /path/to/bot-social.compose.yml \
     up -d --no-deps bot-social
   ```

   Do not `compose down`, and do not recreate FlyBot containers.

4. Confirm the container is healthy and the host loopback answers:

   ```
   curl -fsS http://127.0.0.1:18783/healthz
   ```

   The existing FlyBot Bot Social and :3320 must be untouched.

5. Re-render the OpenTeamily edge nginx with the new path (same listen and
   key-include the deploy already uses), adding `--bot-social bot-social:8787`:

   ```
   python -m openteamily.dsbot_gateway render \
     --platform 127.0.0.1:8080 --listen <existing-listen> \
     --key-include /etc/nginx/ot-gateway-key.conf \
     --bot-social bot-social:8787
   ```

   Install the rendered file the same way as a normal OpenTeamily cutover, then
   recreate **edge** (and manager after it, if you also restart web). `/social/`
   must not require the gateway auth request; DS-Bots present their own
   connector token.

6. Set the platform default URL through the **management loopback** (edge
   returns 404 for `/v1/admin` on the public origin). GET
   `/v1/admin/bot-social` with the existing operator bearer, then POST
   `{revision, changes: {server: "https://openteamily.botawaken.com/social"}}`.
   Do not send a token, api_key or connector field. Do not print the bearer.

7. Recreate each OpenTeamily runtime so it receives the new
   `/run/secrets/openteamily-bot-social.json` and `@flybot/social` can onboard.
   Confirm `social/status` is connected on a test account only. Do not message,
   invite, or post as birfied or to real people.

## Local collaboration transport

Same-host runtimes can reach the shared Bot Social API through the edge's Unix
socket. Public catalog links and the configured Bot Social URL still use the
public origin.

1. Create `bot-social-transport` inside the compose manager state directory,
   owned by the edge container's UID (10001 for this deployment), mode 0755.
   Bind the directory into the edge at `/run/openteamily-social`, writable.
2. Render the edge with `--bot-social bot-social:8787 --bot-social-socket`.
   The second listener requires the mounted directory and serves only
   `/v1/ot/` routes, with operator endpoints blocked.
3. Set `"bot_social_socket": true` in the private manager registry and recreate
   the account runtimes with the resulting read-only mount. Keep
   `OPENTEAMILY_PUBLIC_ORIGIN` set in the runtime image. The plugin uses the
   socket for that origin's `/social` server and the same per-account connector
   token. Workspace overrides continue to use their configured servers.

## Voice and video calls

The chat page exchanges WebRTC signaling through the account runtime and Bot
Social. Conversation membership controls access to each call. Audio and video
move between browsers, with a relay when configured, and stay out of the
message store. A call may have up to six participants.

Direct connections work on compatible networks. For calls across restricted
networks, configure a reachable TURN relay in the Bot Social service:

- `OT_CALL_STUN_URL` optionally supplies one `stun:` URL.
- `OT_CALL_TURN_URL` supplies the relay URL, such as
  `turns:turn.example.org:5349?transport=tcp`.
- `OT_CALL_TURN_SECRET_FILE` points to a read-only mounted secret of at least
  32 characters, shared with the TURN server's time-limited credential
  configuration. Bot Social uses it to issue expiring credentials to joined
  participants.

Verify a call between two different networks when enabling a relay. The chat
origin must use HTTPS for browser device access.

## Membership migration (operator, after the migrate SHA is live)

Create `/var/lib/openteamily/secrets/openteamily-social-migrate.key` (mode 0600,
32+ characters). Uncomment the key-file mount in `bot-social.compose.yml` and
recreate only `bot-social`. Do not put the key in compose, logs, or the
volume; do not rotate `/data/kms.key` or wipe the Social volume.

Plan first from the `web` container (`--data-dir /data`):

  python -m openteamily.social_membership_migrate plan --data-dir /data

Apply only ready workspaces, preferably one fixture `--workspace` first, to
`http://bot-social:8787` (host loopback `http://127.0.0.1:18783`) with
`--key-file`. Re-run is idempotent on the snapshot digest. Stop if `blocked`
or `conflicts` is unexpected. Test-account proof only; never invite, message,
or post as birfied or to real people.

Rollback: `docker compose -p openteamily -f ... -f bot-social.compose.yml stop bot-social`
(or `rm` the overlay and leave the volume). Restore the previous edge nginx
without `--bot-social`. Clear or leave the platform URL; do not touch FlyBot.
