/**
 * Body digest for sandbox callbacks.
 *
 * The callback signature is taken over the hex SHA-256 of the POSTed body
 * rather than over the body itself, so the digest is a value the ingress can
 * compute and forward while the bytes themselves are dropped — verification
 * downstream needs nothing more.
 *
 * This lives apart from `hmac.ts` on purpose. Hashing carries no secret and
 * decides nothing, so the route that only forwards can depend on it without
 * taking on the verification machinery it is required to stay clear of.
 */

import { createHash } from "node:crypto";

/** Hex SHA-256 of the POSTed bytes — the value the callback signature covers. */
export function digestBody(input: Buffer | string): string {
    return createHash("sha256").update(input).digest("hex");
}
