import { describe, expect, test } from "bun:test";

import { isPublishedSandboxImage, isRetiredSandboxImage, provisionerImageFor, SANDBOX_IMAGE } from "./images.ts";

describe("SANDBOX_IMAGE", () => {
    test("is the one published runtime image at its moving tag", () => {
        expect(SANDBOX_IMAGE).toBe("ghcr.io/inflexa-ai/sandbox-base:latest");
    });
});

describe("provisionerImageFor", () => {
    test("swaps the basename and keeps the registry and the tag", () => {
        expect(provisionerImageFor("ghcr.io/inflexa-ai/sandbox-base:latest")).toBe("ghcr.io/inflexa-ai/sandbox-provisioner:latest");
        expect(provisionerImageFor("ghcr.io/inflexa-ai/sandbox-base:v12")).toBe("ghcr.io/inflexa-ai/sandbox-provisioner:v12");
    });

    test("keeps a digest reference whole", () => {
        expect(provisionerImageFor("ghcr.io/inflexa-ai/sandbox-base@sha256:deadbeef")).toBe("ghcr.io/inflexa-ai/sandbox-provisioner@sha256:deadbeef");
    });

    test("a bare local reference swaps too", () => {
        expect(provisionerImageFor("sandbox-base:local")).toBe("sandbox-provisioner:local");
    });

    test("a custom basename takes the pair convention", () => {
        expect(provisionerImageFor("my-registry/my-sandbox:latest")).toBe("my-registry/my-sandbox-provisioner:latest");
    });
});

describe("isPublishedSandboxImage", () => {
    test("recognizes the published repository at any tag or digest", () => {
        expect(isPublishedSandboxImage("ghcr.io/inflexa-ai/sandbox-base")).toBe(true);
        expect(isPublishedSandboxImage("ghcr.io/inflexa-ai/sandbox-base:latest")).toBe(true);
        expect(isPublishedSandboxImage("ghcr.io/inflexa-ai/sandbox-base@sha256:deadbeef")).toBe(true);
    });

    test("refuses a custom image", () => {
        expect(isPublishedSandboxImage("sandbox-base:latest")).toBe(false);
        expect(isPublishedSandboxImage("my-registry/my-sandbox:latest")).toBe(false);
    });
});

describe("isRetiredSandboxImage", () => {
    test("names the two retired variants of our registry, with any tag or digest", () => {
        expect(isRetiredSandboxImage("ghcr.io/inflexa-ai/sandbox-python-r:latest")).toBe(true);
        expect(isRetiredSandboxImage("ghcr.io/inflexa-ai/sandbox-python:v3")).toBe(true);
        expect(isRetiredSandboxImage("ghcr.io/inflexa-ai/sandbox-python-r@sha256:deadbeef")).toBe(true);
        expect(isRetiredSandboxImage("ghcr.io/inflexa-ai/sandbox-python")).toBe(true);
    });

    test("keeps the current image, a custom registry, and a near-name", () => {
        expect(isRetiredSandboxImage("ghcr.io/inflexa-ai/sandbox-base:latest")).toBe(false);
        expect(isRetiredSandboxImage("my-registry/sandbox-python-r:latest")).toBe(false);
        expect(isRetiredSandboxImage("ghcr.io/inflexa-ai/sandbox-pythonic:latest")).toBe(false);
        expect(isRetiredSandboxImage("sandbox-python-r:latest")).toBe(false);
    });
});
