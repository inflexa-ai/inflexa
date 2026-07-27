import { describe, expect, test } from "bun:test";

import {
    DEFAULT_SANDBOX_IMAGE,
    SANDBOX_VARIANTS,
    parseSandboxVersion,
    parseVariant,
    publishedVersionOfImage,
    variantImage,
    variantOfImage,
    variantRepository,
    versionedVariantImage,
} from "./images.ts";

describe("variantImage", () => {
    test("builds the GHCR reference for each variant", () => {
        expect(variantImage("python")).toBe("ghcr.io/inflexa-ai/sandbox-python:latest");
        expect(variantImage("python-r")).toBe("ghcr.io/inflexa-ai/sandbox-python-r:latest");
    });

    test("DEFAULT_SANDBOX_IMAGE is the full python-r stack", () => {
        expect(DEFAULT_SANDBOX_IMAGE).toBe(variantImage("python-r"));
    });
});

describe("published versions", () => {
    test("builds channel and version references from the known repository", () => {
        const version = parseSandboxVersion("20260727-def5678");
        expect(version).not.toBeNull();
        if (version === null) return;
        expect(variantRepository("python")).toBe("ghcr.io/inflexa-ai/sandbox-python");
        expect(versionedVariantImage("python", version)).toBe("ghcr.io/inflexa-ai/sandbox-python:20260727-def5678");
    });

    test("accepts only the publication grammar", () => {
        expect(parseSandboxVersion("20260727-def5678")).not.toBeNull();
        for (const value of ["latest", "2026-07-27-def5678", "20260727-DEF5678", "20260727-def567", "20260727-def56789", "20260727-abcdef0;rm"]) {
            expect(parseSandboxVersion(value)).toBeNull();
        }
    });

    test("parses exact first-party version refs but not channels, digests, or custom refs", () => {
        const parsed = publishedVersionOfImage("ghcr.io/inflexa-ai/sandbox-python-r:20260727-def5678");
        expect(parsed?.variant).toBe("python-r");
        expect(parsed?.version === "20260727-def5678").toBe(true);
        expect(publishedVersionOfImage("ghcr.io/inflexa-ai/sandbox-python-r:latest")).toBeNull();
        expect(publishedVersionOfImage("ghcr.io/inflexa-ai/sandbox-python@sha256:deadbeef")).toBeNull();
        expect(publishedVersionOfImage("localhost:5000/sandbox-python:20260727-def5678")).toBeNull();
        expect(publishedVersionOfImage("my-registry/sandbox-python:20260727-def5678")).toBeNull();
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
        expect(variantOfImage("ghcr.io/inflexa-ai/sandbox-python:latest")).toBe("python");
        expect(variantOfImage("ghcr.io/inflexa-ai/sandbox-python-r:latest")).toBe("python-r");
    });

    test("does not misread sandbox-python-r as sandbox-python (longest match first)", () => {
        expect(variantOfImage("ghcr.io/inflexa-ai/sandbox-python-r:20260706-abc")).toBe("python-r");
    });

    test("matches a digest-pinned reference", () => {
        expect(variantOfImage("ghcr.io/inflexa-ai/sandbox-python@sha256:deadbeef")).toBe("python");
    });

    test("returns null for a custom / non-published image", () => {
        expect(variantOfImage("sandbox-base:latest")).toBeNull();
        expect(variantOfImage("my-registry/my-sandbox:latest")).toBeNull();
    });
});
