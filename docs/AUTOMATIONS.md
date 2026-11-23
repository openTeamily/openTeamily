# Automations

Open **Automations** in a workspace to create an automation from a template or write your own instructions. You can run it immediately or choose a daily, weekly, monthly, weekdays-only, or one-time schedule. The editor and list show the schedule in its configured time zone.

## Where runs execute

The [OpenTeamily plugin](../runtime/openteamily-web/features/automations/README.md) stores the automation, schedule, and run history on your account's DS-Bot volume. The scheduler starts when the runtime attaches. It checks enabled schedules and dispatches each eligible run as a native DS-Bot turn, using the runtime's configured model. Workspace switches keep using the same account runtime.

- You can cancel a queued run before it starts. The page asks for confirmation before cancelling a run or deleting an automation.
- If DS-Bot restarts after a turn has started, its history shows that the run was interrupted. Pending work that had yet to start can resume when the runtime is ready.
- **Retry** creates a separate run. The original result stays in history. The request uses an idempotency key and the reviewed automation revision, so resubmitting after a lost response returns the same retry.

## Integration

The browser sends the automation template, workspace definition, and run endpoints through the account's DS-Bot adapter. The [automation API dispatch](../runtime/openteamily-web/features/automations/v1.js) defines these routes, including run, cancel, retry, and save result.

Accounts migrated from the old scheduler use an idempotent import of their definitions and run history. The import records the eligible slot at cutover so it cannot run twice. The management service retains the historical data needed to generate an [account import bundle](DSBOT_PLUGIN_ARCHITECTURE.md).
