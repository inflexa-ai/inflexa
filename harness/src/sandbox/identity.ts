/**
 * The name of a sandbox machine. It comes from a key: the id of the lease workflow and the machine generation. Thus
 * a rerun of the spawn step adopts the machine of the earlier attempt, and no step checkpoints a name before a spawn.
 */

import { createHash, randomBytes } from "node:crypto";

import type { SandboxIdentity } from "./types.js";
import { WORKLOAD_USER_ENV_KEYS } from "./workload-identity.js";

/** The env key that gives a machine its exec token. sandbox-server refuses each exec without the token. */
export const EXEC_TOKEN_ENV = "SANDBOX_EXEC_TOKEN";

/** A new exec token: 32 random bytes as hex. Each machine gets its own, thus a token opens one machine only. */
export function mintExecToken(): string {
    return randomBytes(32).toString("hex");
}

/** The env keys that only the harness sets on a machine. */
const HARNESS_ENV_KEYS: readonly string[] = [...WORKLOAD_USER_ENV_KEYS, EXEC_TOKEN_ENV];

/** The extra env of a spec, with no key that only the harness sets. */
export function withoutHarnessEnv(extraEnv: Readonly<Record<string, string>> | undefined): Record<string, string> {
    return Object.fromEntries(Object.entries(extraEnv ?? {}).filter(([key]) => !HARNESS_ENV_KEYS.includes(key)));
}

/**
 * `sbx-{run8}-{hash12}`. The run prefix aids `kubectl` triage. The same key gives the same name, and the key is
 * hashed, because a workflow id can hold characters that a container name refuses.
 */
export function keyedSandboxIdentity(runId: string, key: string): SandboxIdentity {
    const run8 = runId.replaceAll("-", "").slice(0, 8);
    const suffix = createHash("sha256").update(key, "utf8").digest("hex").slice(0, 12);
    return { sandboxId: `sbx-${run8}-${suffix}` };
}
