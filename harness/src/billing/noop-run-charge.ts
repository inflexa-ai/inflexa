import type { RunCharge } from "./run-charge.js";

/**
 * Local/OSS run-charge seam: open and close are both no-ops. No external
 * billing ledger in the cloud-free build.
 */
export function createNoopRunCharge(): RunCharge {
    return {
        open: async () => {},
        close: async () => {},
    };
}
