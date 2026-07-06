import { describe, expect, test } from "bun:test";

import { DEFAULT_SANDBOX_IMAGE, SANDBOX_VARIANTS, parseVariant, variantImage, variantOfImage } from "./images.ts";

describe("variantImage", () => {
    test("builds the GHCR reference for each variant", () => {
        expect(variantImage("python")).toBe("ghcr.io/inflexa-ai/inf-cli/sandbox-python:latest");
        expect(variantImage("python-r")).toBe("ghcr.io/inflexa-ai/inf-cli/sandbox-python-r:latest");
    });

    test("DEFAULT_SANDBOX_IMAGE is the full python-r stack", () => {
        expect(DEFAULT_SANDBOX_IMAGE).toBe(variantImage("python-r"));
    });
});

describe("parseVariant", () => {
    test("accepts the known variants", () => {
        expect(parseVariant("python")).toBe("python");
        expect(parseVariant("python-r")).toBe("python-r");
    });

    test("rejects unknown or absent values", () => {
        expect(parseVariant("r")).toBeNull();
        expect(parseVariant("PYTHON")).toBeNull();
        expect(parseVariant(undefined)).toBeNull();
    });

    test("every SANDBOX_VARIANTS entry round-trips", () => {
        for (const v of SANDBOX_VARIANTS) expect(parseVariant(v)).toBe(v);
    });
});

describe("variantOfImage", () => {
    test("recognizes the published variant tags", () => {
        expect(variantOfImage("ghcr.io/inflexa-ai/inf-cli/sandbox-python:latest")).toBe("python");
        expect(variantOfImage("ghcr.io/inflexa-ai/inf-cli/sandbox-python-r:latest")).toBe("python-r");
    });

    test("does not misread sandbox-python-r as sandbox-python (longest match first)", () => {
        expect(variantOfImage("ghcr.io/inflexa-ai/inf-cli/sandbox-python-r:20260706-abc")).toBe("python-r");
    });

    test("matches a digest-pinned reference", () => {
        expect(variantOfImage("ghcr.io/inflexa-ai/inf-cli/sandbox-python@sha256:deadbeef")).toBe("python");
    });

    test("returns null for a custom / non-published image", () => {
        expect(variantOfImage("sandbox-base:latest")).toBeNull();
        expect(variantOfImage("my-registry/my-sandbox:latest")).toBeNull();
    });
});
