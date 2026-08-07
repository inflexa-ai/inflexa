import { describe, expect, test } from "bun:test";

import { PROVISIONER_IMAGE, SANDBOX_IMAGE, isPublishedSandboxImage } from "./images.ts";

describe("the published image constants", () => {
    test("the sandbox image is the one runtime image, at its moving tag", () => {
        expect(SANDBOX_IMAGE).toBe("ghcr.io/inflexa-ai/sandbox-base:latest");
    });

    test("the provisioner image is a constant beside it, and no variant name is left", () => {
        expect(PROVISIONER_IMAGE).toBe("ghcr.io/inflexa-ai/sandbox-provisioner:latest");
        expect(SANDBOX_IMAGE).not.toContain("sandbox-python");
    });
});

describe("isPublishedSandboxImage", () => {
    test("accepts the published repository at any tag or digest", () => {
        expect(isPublishedSandboxImage(SANDBOX_IMAGE)).toBe(true);
        expect(isPublishedSandboxImage("ghcr.io/inflexa-ai/sandbox-base")).toBe(true);
        expect(isPublishedSandboxImage("ghcr.io/inflexa-ai/sandbox-base:20260706-abc")).toBe(true);
        expect(isPublishedSandboxImage(`ghcr.io/inflexa-ai/sandbox-base@sha256:${"a".repeat(64)}`)).toBe(true);
    });

    test("refuses a retired variant repository, so no pull is offered for an image that is gone", () => {
        expect(isPublishedSandboxImage("ghcr.io/inflexa-ai/sandbox-python:latest")).toBe(false);
        expect(isPublishedSandboxImage("ghcr.io/inflexa-ai/sandbox-python-r:latest")).toBe(false);
    });

    test("refuses a custom image, which no registry can supply", () => {
        expect(isPublishedSandboxImage("sandbox-base:latest")).toBe(false);
        expect(isPublishedSandboxImage("my-registry/my-sandbox:latest")).toBe(false);
        // A repository whose name merely STARTS with the published one is a different repository.
        expect(isPublishedSandboxImage("ghcr.io/inflexa-ai/sandbox-base-custom:latest")).toBe(false);
    });
});
