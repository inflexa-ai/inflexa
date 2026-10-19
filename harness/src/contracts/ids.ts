import { isLowerHex } from "../lib/text.js";

/**
 * The plan id: `pln-` plus 8 lowercase hex digits — the `cortex_plans.plan_id`
 * wire shape that the chat schemas, the storage module, and the tools share.
 */
export function isPlanId(value: string): boolean {
    return value.length === 12 && value.startsWith("pln-") && isLowerHex(value.slice(4));
}
