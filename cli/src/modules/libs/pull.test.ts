import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { err, ok } from "neverthrow";

import { isMovingTag, provisionPublishedVariant, sandboxStatus, type PullRuntimeOps, type PullStageError } from "./pull.ts";
import { readConfig } from "../../lib/config.ts";
import { runtimes, type CaptureResult, type ContainerRuntimeId } from "../../lib/container.ts";
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

    test("reports pinned versions and legacy channels without migrating either", async () => {
        mkdirSync(dirname(env.configPath), { recursive: true });
        const lines: string[] = [];
        const originalLog = console.log;
        console.log = (...values: unknown[]): void => {
            lines.push(values.join(" "));
        };
        try {
            writeFileSync(
                env.configPath,
                JSON.stringify({ telemetry: false, harness: { sandboxImage: "ghcr.io/inflexa-ai/sandbox-python-r:20260727-def5678" } }),
            );
            await sandboxStatus();
            expect(lines.join("\n")).toContain("Version  20260727-def5678");

            lines.length = 0;
            writeFileSync(env.configPath, JSON.stringify({ telemetry: false, harness: { sandboxImage: "ghcr.io/inflexa-ai/sandbox-python-r:latest" } }));
            await sandboxStatus();
            expect(lines.join("\n")).toContain("Version  (unpinned channel)");
        } finally {
            console.log = originalLog;
        }
        expect(readConfig().runtime).toBeUndefined();
    });
});

describe("isMovingTag — decides when a present image must still be re-pulled", () => {
    test("`:latest` and untagged refs are moving (re-pull to refresh the digest)", () => {
        expect(isMovingTag("ghcr.io/inflexa-ai/sandbox-python-r:latest")).toBe(true);
        // No tag → the runtime defaults to :latest, so it is moving too.
        expect(isMovingTag("ghcr.io/inflexa-ai/sandbox-python-r")).toBe(true);
    });

    test("pinned version tags and digest refs are immutable (present is authoritative)", () => {
        expect(isMovingTag("ghcr.io/inflexa-ai/sandbox-python-r:20260706-034b897")).toBe(false);
        expect(isMovingTag("ghcr.io/inflexa-ai/sandbox-python-r@sha256:" + "a".repeat(64))).toBe(false);
    });

    test("a registry host:port prefix is not mistaken for the tag", () => {
        // The ':5000' is the registry port, and there is no image tag → moving.
        expect(isMovingTag("localhost:5000/sandbox-python")).toBe(true);
        expect(isMovingTag("localhost:5000/sandbox-python:v1")).toBe(false);
    });
});

type FakeOptions = {
    readonly runtime: ContainerRuntimeId;
    readonly configured: string;
    readonly version?: string;
    readonly oldChannelId?: string;
    readonly newChannelId?: string;
    readonly refs?: Readonly<Record<string, string>>;
    readonly retain?: readonly string[];
    readonly failPull?: boolean;
    readonly failConfig?: boolean;
    readonly failVersionTag?: boolean;
    readonly verificationMismatch?: boolean;
    readonly failRollback?: boolean;
};

function fakePullOps(options: FakeOptions): {
    readonly rt: (typeof runtimes)[ContainerRuntimeId];
    readonly ops: PullRuntimeOps;
    readonly commands: string[][];
    readonly refs: Map<string, string>;
    readonly configuredWrites: string[];
    readonly resolvedPackages: string[];
} {
    const channel = "ghcr.io/inflexa-ai/sandbox-python-r:latest";
    const refs = new Map(Object.entries(options.refs ?? {}));
    if (options.oldChannelId) refs.set(channel, options.oldChannelId);
    const commands: string[][] = [];
    const configuredWrites: string[] = [];
    const resolvedPackages: string[] = [];
    const retained = new Set(options.retain ?? []);
    const knownIds = new Set([...refs.values(), ...(options.oldChannelId ? [options.oldChannelId] : []), options.newChannelId ?? "sha256:new"]);
    const success = (stdout = ""): CaptureResult => ({ code: 0, stdout, stderr: "" });
    const failure = (): CaptureResult => ({ code: 1, stdout: "", stderr: "fake failure" });
    const resolveSource = (source: string): string | null => refs.get(source) ?? (knownIds.has(source) ? source : null);

    const ops: PullRuntimeOps = {
        capture: async (_rt, args) => {
            commands.push(args);
            if (args[0] === "pull") {
                if (options.failPull) return failure();
                refs.set(channel, options.newChannelId ?? "sha256:new");
                return success();
            }
            if (args[0] === "tag") {
                const source = args[1];
                const target = args[2];
                if (
                    !source ||
                    !target ||
                    (options.failVersionTag && target !== channel) ||
                    (options.failRollback && target === channel && source === options.oldChannelId)
                )
                    return failure();
                const id = resolveSource(source);
                if (id === null) return failure();
                refs.set(target, options.verificationMismatch && target !== channel ? "sha256:mismatch" : id);
                return success();
            }
            if (args[0] === "image" && args[1] === "inspect") {
                const image = args.at(-1);
                if (!image) return failure();
                if (args[3]?.includes("Config.Labels")) return success(`${options.version ?? "20260727-def5678"}\n`);
                const id = refs.get(image);
                return id ? success(`${id}\n`) : failure();
            }
            if (args[0] === "image" && args[1] === "ls") {
                const repository = args.at(-1);
                return success([...refs.keys()].filter((ref) => ref.startsWith(`${repository}:`)).join("\n"));
            }
            if (args[0] === "image" && args[1] === "rm") {
                const image = args[2];
                if (!image || retained.has(image)) return failure();
                if (knownIds.has(image)) {
                    for (const [ref, id] of refs) {
                        if (id === image) refs.delete(ref);
                    }
                    knownIds.delete(image);
                } else {
                    refs.delete(image);
                }
                return success();
            }
            return failure();
        },
        inherit: async (_rt, args) => {
            commands.push(args);
            refs.set(channel, options.newChannelId ?? "sha256:new");
            return 0;
        },
        configuredImage: () => options.configured,
        configureImage: (image) => {
            if (options.failConfig) {
                const failureError: PullStageError = { type: "config_write_failed", message: "fake config failure" };
                return err(failureError);
            }
            configuredWrites.push(image);
            return ok(undefined);
        },
        resolvePackages: async (_rt, image) => {
            resolvedPackages.push(image);
            return "/tmp/packages.txt";
        },
    };
    return { rt: runtimes[options.runtime], ops, commands, refs, configuredWrites, resolvedPackages };
}

describe("provisionPublishedVariant — version commit and bounded cleanup", () => {
    for (const runtime of ["docker", "podman"] as const) {
        test(`${runtime}: pulls the channel, pins the stamped version, and never prunes`, async () => {
            const fake = fakePullOps({
                runtime,
                configured: "ghcr.io/inflexa-ai/sandbox-python-r:latest",
                oldChannelId: "sha256:old",
            });

            const outcome = await provisionPublishedVariant(fake.rt, "python-r", { quiet: true }, fake.ops);

            expect(outcome._unsafeUnwrap().image).toBe("ghcr.io/inflexa-ai/sandbox-python-r:20260727-def5678");
            expect(fake.configuredWrites).toEqual(["ghcr.io/inflexa-ai/sandbox-python-r:20260727-def5678"]);
            expect(fake.resolvedPackages).toEqual(["ghcr.io/inflexa-ai/sandbox-python-r:20260727-def5678"]);
            expect(fake.commands).toContainEqual(["tag", "ghcr.io/inflexa-ai/sandbox-python-r:latest", "ghcr.io/inflexa-ai/sandbox-python-r:20260727-def5678"]);
            expect(fake.commands.some((args) => args.includes("prune"))).toBe(false);
            expect(fake.commands).toContainEqual(["image", "rm", "sha256:old"]);
        });
    }

    test("reports up to date and retries cleanup of every older strict version tag", async () => {
        const current = "ghcr.io/inflexa-ai/sandbox-python-r:20260727-def5678";
        const older = "ghcr.io/inflexa-ai/sandbox-python-r:20260720-abc1234";
        const nonVersion = "ghcr.io/inflexa-ai/sandbox-python-r:dev";
        const otherVariant = "ghcr.io/inflexa-ai/sandbox-python:20260720-abc1234";
        const fake = fakePullOps({
            runtime: "docker",
            configured: current,
            oldChannelId: "sha256:new",
            refs: { [current]: "sha256:new", [older]: "sha256:old", [nonVersion]: "sha256:dev", [otherVariant]: "sha256:other" },
        });

        const outcome = (await provisionPublishedVariant(fake.rt, "python-r", { quiet: true }, fake.ops))._unsafeUnwrap();

        expect(outcome.type).toBe("up_to_date");
        expect(outcome.cleanup.removed).toEqual([older]);
        expect(fake.refs.has(older)).toBe(false);
        expect(fake.refs.has(nonVersion)).toBe(true);
        expect(fake.refs.has(otherVariant)).toBe(true);
        expect(fake.refs.has("ghcr.io/inflexa-ai/sandbox-python-r:latest")).toBe(true);
    });

    test("commits the new version while retaining an old version used by a container", async () => {
        const older = "ghcr.io/inflexa-ai/sandbox-python-r:20260720-abc1234";
        const fake = fakePullOps({
            runtime: "podman",
            configured: older,
            refs: { [older]: "sha256:old" },
            retain: [older],
        });

        const outcome = (await provisionPublishedVariant(fake.rt, "python-r", { quiet: true }, fake.ops))._unsafeUnwrap();

        expect(outcome.type).toBe("pulled");
        expect(outcome.cleanup.retained).toEqual([older]);
        expect(fake.refs.has(older)).toBe(true);
    });

    test("invalid metadata restores a legacy channel and leaves config unchanged", async () => {
        const channel = "ghcr.io/inflexa-ai/sandbox-python-r:latest";
        const fake = fakePullOps({
            runtime: "docker",
            configured: channel,
            version: "latest;unsafe",
            oldChannelId: "sha256:old",
            newChannelId: "sha256:new",
        });

        const outcome = await provisionPublishedVariant(fake.rt, "python-r", { quiet: true }, fake.ops);

        expect(outcome._unsafeUnwrapErr().type).toBe("version_unavailable");
        expect(fake.refs.get(channel)).toBe("sha256:old");
        expect(fake.configuredWrites).toEqual([]);
    });

    test("config failure removes the uncommitted version alias and restores legacy latest", async () => {
        const channel = "ghcr.io/inflexa-ai/sandbox-python-r:latest";
        const pinned = "ghcr.io/inflexa-ai/sandbox-python-r:20260727-def5678";
        const fake = fakePullOps({
            runtime: "docker",
            configured: channel,
            oldChannelId: "sha256:old",
            newChannelId: "sha256:new",
            failConfig: true,
        });

        const outcome = await provisionPublishedVariant(fake.rt, "python-r", { quiet: true }, fake.ops);

        expect(outcome._unsafeUnwrapErr().type).toBe("config_write_failed");
        expect(fake.refs.has(pinned)).toBe(false);
        expect(fake.refs.get(channel)).toBe("sha256:old");
    });

    test("tag failure is typed and does not write config", async () => {
        const fake = fakePullOps({
            runtime: "docker",
            configured: "ghcr.io/inflexa-ai/sandbox-python-r:20260720-abc1234",
            failVersionTag: true,
        });

        const outcome = await provisionPublishedVariant(fake.rt, "python-r", { quiet: true }, fake.ops);

        expect(outcome._unsafeUnwrapErr().type).toBe("tag_failed");
        expect(fake.configuredWrites).toEqual([]);
    });

    test("pull and verification failures are typed before config commit", async () => {
        const pullFailure = fakePullOps({
            runtime: "docker",
            configured: "ghcr.io/inflexa-ai/sandbox-python-r:20260720-abc1234",
            failPull: true,
        });
        expect((await provisionPublishedVariant(pullFailure.rt, "python-r", { quiet: true }, pullFailure.ops))._unsafeUnwrapErr().type).toBe("pull_failed");
        expect(pullFailure.configuredWrites).toEqual([]);

        const verificationFailure = fakePullOps({
            runtime: "podman",
            configured: "ghcr.io/inflexa-ai/sandbox-python-r:20260720-abc1234",
            verificationMismatch: true,
        });
        expect((await provisionPublishedVariant(verificationFailure.rt, "python-r", { quiet: true }, verificationFailure.ops))._unsafeUnwrapErr().type).toBe(
            "verification_failed",
        );
        expect(verificationFailure.configuredWrites).toEqual([]);
    });

    test("reports rollback failure when a legacy alias cannot be restored", async () => {
        const channel = "ghcr.io/inflexa-ai/sandbox-python-r:latest";
        const fake = fakePullOps({
            runtime: "podman",
            configured: channel,
            version: "missing",
            oldChannelId: "sha256:old",
            failRollback: true,
        });

        const error = (await provisionPublishedVariant(fake.rt, "python-r", { quiet: true }, fake.ops))._unsafeUnwrapErr();

        expect(error.type).toBe("rollback_failed");
        if (error.type === "rollback_failed") expect(error.original.type).toBe("version_unavailable");
    });
});
