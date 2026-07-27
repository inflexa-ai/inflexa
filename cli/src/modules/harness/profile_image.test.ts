import { describe, expect, test } from "bun:test";
import { ok } from "neverthrow";

import { runtimes, type CaptureResult } from "../../lib/container.ts";
import type { PullOutcome } from "../libs/pull.ts";
import { ensureSandboxImage, type SandboxImagePreflightDeps } from "./profile.ts";

function preflightDeps(options: { readonly present?: boolean; readonly provisionedImage?: string }): {
    readonly deps: SandboxImagePreflightDeps;
    readonly commands: string[][];
} {
    const commands: string[][] = [];
    const result = (code: number): CaptureResult => ({ code, stdout: "", stderr: "" });
    const deps: SandboxImagePreflightDeps = {
        ensureRuntime: async () => ok(runtimes.docker),
        capture: async (_rt, args) => {
            commands.push(args);
            return result(options.present ? 0 : 1);
        },
        inherit: async (_rt, args) => {
            commands.push(args);
            return 0;
        },
        provisionPublishedVariant: async (_rt, variant) => {
            const outcome: Exclude<PullOutcome, { type: "declined" }> = {
                type: "pulled",
                variant,
                image: options.provisionedImage ?? "ghcr.io/inflexa-ai/sandbox-python-r:20260727-def5678",
                cleanup: { removed: [], retained: [] },
            };
            return ok(outcome);
        },
        confirm: async () => true,
        fail: (message) => {
            throw new Error(message);
        },
        isInteractive: () => false,
    };
    return { deps, commands };
}

describe("ensureSandboxImage — pinned launch preflight", () => {
    test("uses an already-present legacy channel without checking for updates", async () => {
        const image = "ghcr.io/inflexa-ai/sandbox-python-r:latest";
        const fake = preflightDeps({ present: true });

        expect(await ensureSandboxImage(image, fake.deps)).toBe(image);
        expect(fake.commands).toEqual([["image", "inspect", image]]);
    });

    test("restores a missing configured version by pulling that exact reference", async () => {
        const image = "ghcr.io/inflexa-ai/sandbox-python-r:20260720-abc1234";
        const fake = preflightDeps({ present: false });

        expect(await ensureSandboxImage(image, fake.deps)).toBe(image);
        expect(fake.commands).toEqual([
            ["image", "inspect", image],
            ["pull", image],
        ]);
    });

    test("returns the effective pin when a missing bootstrap channel is provisioned", async () => {
        const image = "ghcr.io/inflexa-ai/sandbox-python-r:latest";
        const pinned = "ghcr.io/inflexa-ai/sandbox-python-r:20260727-def5678";
        const fake = preflightDeps({ present: false, provisionedImage: pinned });

        expect(await ensureSandboxImage(image, fake.deps)).toBe(pinned);
        expect(fake.commands).toEqual([["image", "inspect", image]]);
    });

    test("preserves the actionable custom-image refusal", async () => {
        const image = "example.test/custom-sandbox:local";
        const fake = preflightDeps({ present: false });

        expect(ensureSandboxImage(image, fake.deps)).rejects.toThrow(`Sandbox image "${image}" not found`);
        expect(fake.commands).toEqual([["image", "inspect", image]]);
    });
});
