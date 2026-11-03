import { join } from "node:path";

/**
 * The golden fixture pool of the package store: `src/modules/libs/test-fixtures/farm-parity`.
 * It is the ONE input that both farm builders compose (the host and the provisioner), thus a
 * change to it changes both sides of the parity test. It stays under `src/modules/libs/`, and
 * each reader copies it into a temp store root instead of writing into it.
 */
export const FARM_PARITY_FIXTURE: string = join(import.meta.dir, "..", "modules", "libs", "test-fixtures", "farm-parity");
