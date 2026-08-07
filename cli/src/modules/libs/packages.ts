/**
 * The package inventory `list_available_packages` reads, resolved on the host.
 *
 * There is ONE source, and it is the store the sandbox mounts. The rule is that the
 * inventory describes whatever the sandbox will actually mount, because an agent
 * told a package exists when the mount does not carry it writes code that fails at
 * import.
 *
 * The runtime image bakes no R library and no Python library, so a per-image label
 * cache would describe an empty set. There is thus nothing to fall back to, and an
 * inventory the CLI cannot read is a reported failure rather than a silent
 * degradation — refer to `modules/harness/runtime.ts`.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The active farm's package inventory inside the store, or null when it is not readable.
 *
 * The store keeps its active farm behind `current`, a symlink `inflexa store use` swaps; the inventory the
 * sandbox mounts is `current/packages.txt`. This reports only whether that one file is present — the
 * shallow shape the CLI reads to build the inventory. It is NOT the harness's own mount-usability check,
 * which also validates `meta.json` and the symlink target. The harness re-checks at each sandbox create.
 *
 * `existsSync` follows the `current` symlink, so a missing or dangling pointer and an absent inventory
 * file all resolve to null. It never throws, so a broken store surfaces as the reported store failure
 * rather than an exception out of the boot sequence.
 */
export function storePackagesFile(storePath: string): string | null {
    const candidate = join(storePath, "current", "packages.txt");
    return existsSync(candidate) ? candidate : null;
}
