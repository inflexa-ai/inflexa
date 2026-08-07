import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { ok } from "neverthrow";

import { isMovingTag, sandboxPull, sandboxRemove, sandboxStatus } from "./pull.ts";
import { PROVISIONER_IMAGE, SANDBOX_IMAGE } from "./images.ts";
import * as config from "../../lib/config.ts";
import { readConfig } from "../../lib/config.ts";
import * as container from "../../lib/container.ts";
import { env } from "../../lib/env.ts";
import { assertTestSandbox } from "../../test_support/sandbox.ts";

// `sandbox status` is a read-only diagnostic: it resolves a runtime for inspection
// (selectedRuntime() ?? firstReadyRuntime(...)) but must NEVER pin one — pinning is
// ensureRuntime's job, reserved for commands that create runtime-bound state. This
// exercises the real resolution seam against the sandboxed env.configPath (test
// preload) and asserts the config's `runtime` key stays absent across the call.

// Both hooks touch env.configPath; guard first so a root run (developer's real
// config.json) throws before any write/delete rather than clobbering it.
beforeEach(() => {
    assertTestSandbox(env.configPath);
});

afterEach(() => {
    assertTestSandbox(env.configPath);
    rmSync(env.configPath, { force: true });
});

describe("sandboxStatus — read-only, never pins", () => {
    test("does not write the runtime config key when none is selected", async () => {
        // No runtime selected: status must inspect against a detected ready runtime
        // (or report unknown when none is) while leaving config untouched.
        mkdirSync(dirname(env.configPath), { recursive: true });
        writeFileSync(env.configPath, JSON.stringify({ telemetry: false }));

        // sandboxStatus prints its report to stdout; silence it for the test run.
        const originalLog = console.log;
        console.log = (): void => {};
        try {
            await sandboxStatus();
        } finally {
            console.log = originalLog;
        }

        expect(readConfig().runtime).toBeUndefined();
    });
});

describe("isMovingTag — decides when a present image must still be re-pulled", () => {
    test("`:latest` and untagged refs are moving (re-pull to refresh the digest)", () => {
        expect(isMovingTag("ghcr.io/inflexa-ai/sandbox-base:latest")).toBe(true);
        // No tag → the runtime defaults to :latest, so it is moving too.
        expect(isMovingTag("ghcr.io/inflexa-ai/sandbox-base")).toBe(true);
    });

    test("pinned version tags and digest refs are immutable (present is authoritative)", () => {
        expect(isMovingTag("ghcr.io/inflexa-ai/sandbox-base:20260706-034b897")).toBe(false);
        expect(isMovingTag("ghcr.io/inflexa-ai/sandbox-base@sha256:" + "a".repeat(64))).toBe(false);
    });

    test("a registry host:port prefix is not mistaken for the tag", () => {
        // The ':5000' is the registry port, and there is no image tag → moving.
        expect(isMovingTag("localhost:5000/sandbox-base")).toBe(true);
        expect(isMovingTag("localhost:5000/sandbox-base:v1")).toBe(false);
    });
});

describe("sandboxRemove — the two pulled images, and nothing else", () => {
    /** The engine calls the removal issued, in order, as flat argument lists. */
    let issued: string[][];

    /**
     * Stub the engine seam. `present` decides which references the machine holds, so an absent image takes
     * the reported-not-refused path. Every `image rm` of a present reference succeeds.
     *
     * A successful removal DROPS the reference from `present`, exactly as an engine does. Thus a later
     * probe against the same stub reads the image as absent, and a pull after a removal transfers again.
     */
    function stubEngine(present: Set<string>, failures: ReadonlyMap<string, string> = new Map()): void {
        issued = [];
        spies.push(
            spyOn(config, "ensureRuntime").mockImplementation(async () => ok(container.runtimes.docker)),
            spyOn(container, "capture").mockImplementation(async (_rt: unknown, args: readonly string[]) => {
                issued.push([...args]);
                const image = args[args.length - 1] ?? "";
                if (args[0] === "image" && args[1] === "inspect") return { code: present.has(image) ? 0 : 1, stdout: "", stderr: "" };
                const failure = failures.get(image);
                if (args[0] === "image" && args[1] === "rm") {
                    if (failure !== undefined) return { code: 1, stdout: "", stderr: failure };
                    present.delete(image);
                    return { code: 0, stdout: "", stderr: "" };
                }
                return { code: 0, stdout: "", stderr: "" };
            }),
        );
    }

    const spies: { mockRestore: () => void }[] = [];
    afterEach(() => {
        for (const spy of spies.splice(0)) spy.mockRestore();
    });

    test("removes the runtime image and the provisioner image, and names each one", async () => {
        stubEngine(new Set([SANDBOX_IMAGE, PROVISIONER_IMAGE]));
        const removals = (await sandboxRemove())._unsafeUnwrap();
        expect(removals).toEqual([
            { image: SANDBOX_IMAGE, outcome: "removed" },
            { image: PROVISIONER_IMAGE, outcome: "removed" },
        ]);
        expect(issued.filter((args) => args[1] === "rm").map((args) => args[2])).toEqual([SANDBOX_IMAGE, PROVISIONER_IMAGE]);
    });

    test("an absent image is reported, not refused", async () => {
        stubEngine(new Set([SANDBOX_IMAGE]));
        const removals = (await sandboxRemove())._unsafeUnwrap();
        expect(removals).toEqual([
            { image: SANDBOX_IMAGE, outcome: "removed" },
            { image: PROVISIONER_IMAGE, outcome: "absent" },
        ]);
        // Absence is a normal condition: no `image rm` was issued for the reference the machine lacks.
        expect(issued.filter((args) => args[1] === "rm").map((args) => args[2])).toEqual([SANDBOX_IMAGE]);
    });

    test("an engine that refuses one removal reports it and still tries the other", async () => {
        stubEngine(new Set([SANDBOX_IMAGE, PROVISIONER_IMAGE]), new Map([[SANDBOX_IMAGE, "image is in use by a container"]]));
        const removals = (await sandboxRemove())._unsafeUnwrap();
        expect(removals[0]).toEqual({ image: SANDBOX_IMAGE, outcome: "failed", detail: "image is in use by a container" });
        expect(removals[1]).toEqual({ image: PROVISIONER_IMAGE, outcome: "removed" });
    });

    test("a pull after the removal obtains the runtime image again", async () => {
        // The removal is complete, not partial. Thus the transfer runs a second time, and the machine holds
        // the runtime image again — which is what makes `inflexa sandbox remove` a recoverable action.
        stubEngine(new Set([SANDBOX_IMAGE, PROVISIONER_IMAGE]));
        expect((await sandboxRemove())._unsafeUnwrap()[0]).toEqual({ image: SANDBOX_IMAGE, outcome: "removed" });

        issued = [];
        // `quiet` keeps the pull off the terminal of the test and asks nothing, which is the non-interactive
        // shape the removal-then-pull sequence takes in a script.
        const outcome = (await sandboxPull({ yes: true, quiet: true }))._unsafeUnwrap();
        expect(outcome).toEqual({ type: "pulled", image: SANDBOX_IMAGE });
        expect(issued.filter((args) => args[0] === "pull").map((args) => args[1])).toEqual([SANDBOX_IMAGE]);
    });

    test("the store root and each farm are left exactly as they were", async () => {
        // The two images and the package catalog are separate artifacts. The `inflexa store` family owns
        // the catalog surface, and nothing here reaches it.
        assertTestSandbox(env.libStoreDir);
        const farm = join(env.libStoreDir, "farms", "default");
        mkdirSync(farm, { recursive: true });
        writeFileSync(join(farm, "packages.txt"), "scanpy 1.9\n");
        try {
            stubEngine(new Set([SANDBOX_IMAGE, PROVISIONER_IMAGE]));
            (await sandboxRemove())._unsafeUnwrap();
            expect(readFileSync(join(farm, "packages.txt"), "utf8")).toBe("scanpy 1.9\n");
            // Every engine call named an image; none named a path.
            expect(issued.every((args) => args[0] === "image")).toBe(true);
        } finally {
            rmSync(env.libStoreDir, { recursive: true, force: true });
        }
    });
});
