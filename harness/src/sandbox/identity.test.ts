import { describe, expect, test } from "bun:test";

import { mintSandboxIdentity } from "./identity.js";

describe("mintSandboxIdentity", () => {
    test("names are sbx-{run8}-{rand8} and DNS-1123 label-safe", () => {
        const id = mintSandboxIdentity("5ef194ab-168c-407c-9872-609f66797b11");
        expect(id.sandboxId).toMatch(/^sbx-5ef194ab-[0-9a-f]{8}$/);
        // K8s object names are DNS-1123 subdomains: lowercase alphanumeric + '-'.
        expect(id.sandboxId).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
        expect(id.sandboxId.length).toBeLessThanOrEqual(63);
    });

    test("secret is a 32-byte base64 value", () => {
        const { callbackSecret } = mintSandboxIdentity("run-1");
        expect(callbackSecret.startsWith("base64:")).toBe(true);
        expect(callbackSecret.length).toBeGreaterThan(40);
    });

    test("suffix is random across mints for the same run", () => {
        const ids = new Set(Array.from({ length: 50 }, () => mintSandboxIdentity("run-1").sandboxId));
        // 8 hex chars → collisions across 50 mints are astronomically unlikely.
        expect(ids.size).toBe(50);
    });
});
