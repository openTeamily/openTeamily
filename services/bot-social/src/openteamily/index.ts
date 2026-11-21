// OpenTeamily shared-state routes on Bot Social. Each area registers its schema and routes here.
import type { FastifyInstance } from "fastify";
import type { Platform } from "../platform.js";
import { CORE_SCHEMA, OtContext, registerCore } from "./core.js";
import { registerTeams, TEAMS_SCHEMA } from "./teams.js";
import { MESSENGER_SCHEMA, registerMessenger } from "./messenger.js";
import { DISCOVER_SCHEMA, registerDiscover } from "./discover.js";
import { SHARES_SCHEMA, registerShares } from "./shares.js";
import { MIGRATE_SCHEMA, registerMigrate } from "./migrate.js";
import { CALLS_SCHEMA, registerCalls } from "./calls.js";

import { CONTACTS_SCHEMA, registerContacts } from "./contacts.js";

export const OT_SCHEMAS = [CORE_SCHEMA, TEAMS_SCHEMA, MESSENGER_SCHEMA, DISCOVER_SCHEMA, SHARES_SCHEMA, MIGRATE_SCHEMA, CALLS_SCHEMA, CONTACTS_SCHEMA];

export function registerOpenTeamily(app: FastifyInstance, platform: Platform) {
  for (const schema of OT_SCHEMAS) platform.db.exec(schema);
  const ot = new OtContext(platform);
  registerCore(app, ot);
  registerContacts(app, ot);
  registerTeams(app, ot);
  registerMessenger(app, ot);
  registerCalls(app, ot);
  registerDiscover(app, ot);
  registerShares(app, ot);
  registerMigrate(app, ot);
  return ot;
}
