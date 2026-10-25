// oxlint-disable-next-line eslint-js/no-restricted-syntax -- the DNS-1123 label grammar that the K8s object name must obey, whose shape is a pattern
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

import { describe, expect, test } from "bun:test";
import { isLowerHexOfLength } from "../../lib/test/text-shapes.js";

import { mintSandboxIdentity } from "../identity.js";

describe("mintSandboxIdentity", () => {
    test("names are sbx-{run8}-{rand8} and DNS-1123 label-safe", () => {
        const id = mintSandboxIdentity("5ef194ab-168c-407c-9872-609f66797b11");
        expect(id.sandboxId.startsWith("sbx-5ef194ab-") && isLowerHexOfLength(id.sandboxId.slice(13), 8)).toBe(true);
        // K8s object names are DNS-1123 subdomains: lowercase alphanumeric + '-'.
        expect(DNS_LABEL.test(id.sandboxId)).toBe(true);
        expect(id.sandboxId.length).toBeLessThanOrEqual(63);
    });

    test("suffix is random across mints for the same run", () => {
        const ids = new Set(Array.from({ length: 50 }, () => mintSandboxIdentity("run-1").sandboxId));
        // 8 hex chars → collisions across 50 mints are astronomically unlikely.
        expect(ids.size).toBe(50);
    });
});
