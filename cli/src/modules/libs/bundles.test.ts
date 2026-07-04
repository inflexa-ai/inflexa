import { describe, expect, test } from "bun:test";

import { archFromMachine, defaultBundle, resolvableBundles, selectBundle } from "./bundles.ts";

describe("archFromMachine", () => {
    test("maps x86_64 / amd64 to linux-amd64", () => {
        expect(archFromMachine("x86_64")).toBe("linux-amd64");
        expect(archFromMachine("amd64\n")).toBe("linux-amd64");
    });

    test("maps aarch64 / arm64 to linux-arm64", () => {
        expect(archFromMachine("aarch64")).toBe("linux-arm64");
        expect(archFromMachine("ARM64")).toBe("linux-arm64");
    });

    test("returns null for an unrecognized machine", () => {
        expect(archFromMachine("riscv64")).toBeNull();
    });
});

describe("selectBundle", () => {
    test("amd64 + full resolves the R triple", () => {
        const r = selectBundle("full", "linux-amd64");
        expect(r.bundle).toBe("full");
        expect(r.manifestBundle).toBe("python-r-conda");
        expect(r.tracks).toContain("cran");
        expect(r.tracks).toContain("bioconductor");
        expect(r.tracks).toContain("github");
        expect(r.downgradeReason).toBeUndefined();
    });

    test("arm64 + full is rejected-with-reason and falls back to core", () => {
        const r = selectBundle("full", "linux-arm64");
        expect(r.bundle).toBe("core");
        expect(r.manifestBundle).toBe("python-conda");
        expect(r.downgradeReason).toBeDefined();
        expect(r.downgradeReason).toContain("arm64");
    });

    test("core has no R tracks on any arch", () => {
        for (const arch of ["linux-amd64", "linux-arm64"] as const) {
            const r = selectBundle("core", arch);
            expect(r.tracks).toEqual(["python", "conda", "node"]);
            expect(r.tracks).not.toContain("cran");
        }
    });

    test("defaults resolve per arch: full@amd64, core@arm64", () => {
        expect(selectBundle(undefined, "linux-amd64").bundle).toBe("full");
        expect(selectBundle(undefined, "linux-arm64").bundle).toBe("core");
    });
});

describe("defaultBundle / resolvableBundles", () => {
    test("default is full on amd64, core on arm64", () => {
        expect(defaultBundle("linux-amd64")).toBe("full");
        expect(defaultBundle("linux-arm64")).toBe("core");
    });

    test("only core is resolvable on arm64", () => {
        expect(resolvableBundles("linux-amd64")).toEqual(["full", "core"]);
        expect(resolvableBundles("linux-arm64")).toEqual(["core"]);
    });
});
