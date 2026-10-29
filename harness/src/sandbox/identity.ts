/**
 * The name of a sandbox machine. It comes from a key: the id of the lease workflow and the machine generation. Thus
 * a rerun of the spawn step adopts the machine of the earlier attempt, and no step checkpoints a name before a spawn.
 */

import { createHash } from "node:crypto";

import type { SandboxIdentity } from "./types.js";

/**
 * `sbx-{run8}-{hash12}`. The run prefix aids `kubectl` triage. The same key gives the same name, and the key is
 * hashed, because a workflow id can hold characters that a container name refuses.
 */
export function keyedSandboxIdentity(runId: string, key: string): SandboxIdentity {
    const run8 = runId.replaceAll("-", "").slice(0, 8);
    const suffix = createHash("sha256").update(key, "utf8").digest("hex").slice(0, 12);
    return { sandboxId: `sbx-${run8}-${suffix}` };
}
