import { describe, expect, test } from "bun:test";

import { canRead, canWrite, type Roots } from "./boundary.ts";

const roots: Roots = {
    writable: ["/work/out"],
    readable: ["/work/out", "/data/src"],
};

describe("canWrite", () => {
    test("allows the writable root itself and its descendants", () => {
        expect(canWrite(roots, "/work/out")).toBe(true);
        expect(canWrite(roots, "/work/out/report.md")).toBe(true);
    });

    test("rejects a sibling that merely shares a path prefix (boundary-safe: /work/outside ∉ /work/out)", () => {
        expect(canWrite(roots, "/work/outside")).toBe(false);
    });

    test("rejects a readable-but-not-writable path and anything outside every root", () => {
        expect(canWrite(roots, "/data/src")).toBe(false);
        expect(canWrite(roots, "/etc/passwd")).toBe(false);
    });
});

describe("canRead", () => {
    test("allows any readable root and its descendants", () => {
        expect(canRead(roots, "/data/src/lib.ts")).toBe(true);
        expect(canRead(roots, "/work/out/report.md")).toBe(true);
    });

    test("rejects a prefix-sharing sibling and outside paths (boundary-safe: /data/source ∉ /data/src)", () => {
        expect(canRead(roots, "/data/source")).toBe(false);
        expect(canRead(roots, "/elsewhere")).toBe(false);
    });
});
