/**
 * UUIDv7 generator for the ask ledger id.
 *
 * The package pins no uuidv7 dependency and Node's `crypto.randomUUID` mints
 * only v4, so a small self-contained helper covers the one call site that needs
 * a time-ordered id: `cortex_asks.id`. v7's leading 48-bit millisecond timestamp
 * makes ledger ids monotonically sortable, so a `created_at`-ordered scan and the
 * id order agree without a second sort key.
 */

import { randomBytes } from "node:crypto";

/**
 * Mint a RFC 9562 UUIDv7 — 48-bit big-endian unix-millis prefix, version/variant
 * nibbles patched over otherwise-random bytes.
 */
export function uuidv7(): string {
    const bytes = randomBytes(16);
    // 48-bit timestamp occupies the first six bytes, big-endian. Date.now() fits
    // in 48 bits well past the year 10000, so writeUIntBE never overflows.
    bytes.writeUIntBE(Date.now(), 0, 6);
    // Version 7 in the high nibble of byte 6; variant 0b10 in the top bits of byte 8.
    bytes[6] = (bytes[6] & 0x0f) | 0x70;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
