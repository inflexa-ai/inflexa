import type { BillingHeaders, ResolveBilling } from "./resolver.js";

/**
 * Local/OSS billing resolver: resolves to an empty header map. No upstream
 * call, no credential reads. Wire calls carry no attribution headers.
 */
export function createNoopBillingResolver(): ResolveBilling {
    return async (): Promise<BillingHeaders> => ({});
}
