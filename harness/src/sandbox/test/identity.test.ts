// oxlint-disable-next-line eslint-js/no-restricted-syntax -- the DNS-1123 label grammar that the K8s object name must obey, whose shape is a pattern
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

import { describe, expect, test } from "bun:test";
import { isLowerHexOfLength } from "../../lib/test/text-shapes.js";

import { keyedSandboxIdentity } from "../identity.js";

describe("keyedSandboxIdentity", () => {
    test("names are sbx-{run8}-{hash12} and DNS-1123 label-safe", () => {
        const id = keyedSandboxIdentity("5ef194ab-168c-407c-9872-609f66797b11", "sandboxlease:an-1:run-1-2:1#1");
        expect(id.sandboxId.startsWith("sbx-5ef194ab-") && isLowerHexOfLength(id.sandboxId.slice(13), 12)).toBe(true);
        // K8s object names are DNS-1123 subdomains: lowercase alphanumeric + '-'.
        expect(DNS_LABEL.test(id.sandboxId)).toBe(true);
        expect(id.sandboxId.length).toBeLessThanOrEqual(63);
    });

    test("the same key gives the same name, and the next machine generation a new one", () => {
        const first = keyedSandboxIdentity("run-1", "sandboxlease:an-1:k:1#1").sandboxId;
        expect(keyedSandboxIdentity("run-1", "sandboxlease:an-1:k:1#1").sandboxId).toBe(first);
        expect(keyedSandboxIdentity("run-1", "sandboxlease:an-1:k:1#2").sandboxId).not.toBe(first);
    });
});
