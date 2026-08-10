import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { sha256 } from "./sha256.js";
import { defaultProvDigest } from "./document.js";

/**
 * The vendored SHA-256 must stay byte-identical to `createHash("sha256")` from `node:crypto` —
 * every QName suffix and relation id derives from it, thus a single divergent byte forks the
 * identifier space. The tests run under bun, where both implementations are loadable, and they
 * compare the two directly over inputs that cover the padding boundaries of the 64-byte block.
 */

function hexReference(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
}

function hexVendored(bytes: Uint8Array): string {
    return Array.from(sha256(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("sha256", () => {
    const cases: Array<[name: string, input: Uint8Array]> = [
        ["the empty input", new Uint8Array(0)],
        ["a short ascii string", new TextEncoder().encode("abc")],
        ["a multi-byte UTF-8 string", new TextEncoder().encode("provenance — προέλευση — 来歴 — 🧬")],
        // The padding boundaries: 55 bytes is the last one-block message, 56 forces a second
        // block, 64 is an exact block, 65 starts a second block of content.
        ["a 55-byte input", new Uint8Array(55).fill(0x61)],
        ["a 56-byte input", new Uint8Array(56).fill(0x62)],
        ["a 63-byte input", new Uint8Array(63).fill(0x63)],
        ["a 64-byte input", new Uint8Array(64).fill(0x64)],
        ["a 65-byte input", new Uint8Array(65).fill(0x65)],
        ["a 100-byte input (more than one block)", new TextEncoder().encode("x".repeat(100))],
        ["a 4KiB input (more than 1KiB)", new Uint8Array(4096).map((_, i) => i % 251)],
    ];

    for (const [name, input] of cases) {
        test(`matches node:crypto over ${name}`, () => {
            expect(hexVendored(input)).toBe(hexReference(input));
        });
    }

    test('matches the FIPS 180-4 vector for "abc"', () => {
        expect(hexVendored(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    });
});

describe("defaultProvDigest", () => {
    // The exact derivation the kernel used before the vendored sha256: `node:crypto`, the first
    // 8 digest bytes read big-endian, rendered in base36.
    function referenceDigest(s: string): string {
        return createHash("sha256").update(s).digest().readBigUInt64BE(0).toString(36);
    }

    const identities = [
        "",
        "data/inputs/counts.csv|abc123",
        "anchor-1|data/inputs",
        "anthropic/golden-model",
        "path with spaces — και ελληνικά|deadbeef",
        "🧬".repeat(300),
        "a".repeat(2048),
    ];

    for (const s of identities) {
        test(`matches the node:crypto derivation for ${JSON.stringify(s.slice(0, 32))}`, () => {
            expect(defaultProvDigest(s)).toBe(referenceDigest(s));
        });
    }
});
