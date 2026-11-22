# DS-Bot image patches

Small, ordered patches applied to a **copy** of `runtime/ds-bot-upstream/ds-bot` when the FlyBot runtime image is built. The vendor tree in git stays byte-identical to `runtime/ds-bot-upstream.pin.json` and is checked by `node scripts/ds-bot-upstream.mjs check`.

Use a patch only where a plugin cannot reach a seam. Each patch should remain a candidate for an upstream change so the series can shrink.

Apply with:

```sh
node runtime/ds-bot-patches/apply.mjs --root runtime/ds-bot-upstream/ds-bot
```

Do not run that against a working tree you need to keep pin-clean; the unit test copies the touched files first.

## 0001-native-remote-participants.patch

Relocates the native group-settings hook that landed in the vendor tree in #524:

- `GroupSettingsForm` shows a "Shared human participants" field when `room.openteamily.conversation_id` is set.
- Host `update-room` forwards `remoteParticipants` to the OpenTeamily overlay in `runtime/openteamily-web/lib/c/native-groups.js`.
- The generated `client.js` bundle gets the same form change (no comment-path rebuild noise).

## 0002-filter-native-capabilities.patch

Relocates the native capability-filter hook that landed in the vendor tree in `ba4ebb76` (skill consent):

- Host `reconcileAgent` lets `rt.config.filterNativeCapabilities(bot, names, library())` narrow the capabilities mounted on a Bot.
- The OpenTeamily plugin uses this to enforce native skill consent; without the hook the filter never runs.
