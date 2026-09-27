/**
 * The versioned migrations of the Cortex state tables.
 *
 * The migrator applies them in the order of their names and records each one,
 * thus a migration never changes after a release. A schema change is a new
 * entry, with a name that sorts after every existing one.
 */

import type { Migration } from "kysely/migration";
import type { Logger } from "../../lib/logger.js";
import { baseline } from "./20260927120000_baseline.js";
import { threadTitleSetByUser } from "./20260927180000_thread_title_set_by_user.js";

export function cortexMigrations(logger: Logger): Record<string, Migration> {
    return {
        "20260927120000_baseline": baseline(logger),
        "20260927180000_thread_title_set_by_user": threadTitleSetByUser,
    };
}
