/**
 * Sandbox identity minting — the durable half of the two-step create (ADR
 * 0016). Backend-agnostic: the `sandboxId` and HMAC `callbackSecret` are minted
 * here, checkpointed by the `sandbox.mint` DBOS step, then handed to the
 * backend's spawn step. Because the identity is durable before any machine
 * exists, a crash between spawn and the spawn-step checkpoint is recoverable —
 * the re-run adopts the existing machine under the same name + secret.
 */

import { randomBytes, randomUUID } from "node:crypto";

import type { SandboxIdentity } from "./types.js";

/** `sbx-{run8}-{rand8}` — run prefix aids `kubectl` triage; the 8-hex random
 *  suffix makes within-run collisions across a run's concurrent steps
 *  negligible. Names are NOT the idempotency mechanism (the checkpoint is), and
 *  adoption is owner-label-guarded, but a unique name keeps a collision from
 *  ever reaching that guard. */
export function mintSandboxIdentity(runId: string): SandboxIdentity {
    const run8 = runId.replace(/-/g, "").slice(0, 8);
    const suffix = randomUUID().replace(/-/g, "").slice(0, 8);
    return {
        sandboxId: `sbx-${run8}-${suffix}`,
        callbackSecret: "base64:" + randomBytes(32).toString("base64"),
    };
}
