import { describe, expect, test } from "bun:test";

import { isLowerHex } from "../../lib/text.js";
import { mintSandboxIdentity } from "../identity.js";

function isDns1123Label(value: string): boolean {
    if (value.length === 0) return false;
    const headOrTail = (ch: string): boolean => (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9");
    if (!headOrTail(value[0]) || !headOrTail(value[value.length - 1])) return false;
    for (let i = 0; i < value.length; i++) {
        const ch = value[i];
        if (!headOrTail(ch) && ch !== "-") return false;
    }
    return true;
}

describe("mintSandboxIdentity", () => {
    test("names are sbx-{run8}-{rand8} and DNS-1123 label-safe", () => {
        const id = mintSandboxIdentity("5ef194ab-168c-407c-9872-609f66797b11");
        const suffix = id.sandboxId.slice("sbx-5ef194ab-".length);
        expect(id.sandboxId.startsWith("sbx-5ef194ab-")).toBe(true);
        expect(suffix.length).toBe(8);
        expect(isLowerHex(suffix)).toBe(true);
        // K8s object names are DNS-1123 subdomains: lowercase alphanumeric + '-'.
        expect(isDns1123Label(id.sandboxId)).toBe(true);
        expect(id.sandboxId.length).toBeLessThanOrEqual(63);
    });

    test("suffix is random across mints for the same run", () => {
        const ids = new Set(Array.from({ length: 50 }, () => mintSandboxIdentity("run-1").sandboxId));
        // 8 hex chars → collisions across 50 mints are astronomically unlikely.
        expect(ids.size).toBe(50);
    });
});
