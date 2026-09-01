import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { configuredSandboxImage, migrateRetiredSandboxImageOverride, sandboxStatus } from "./pull.ts";
import { readConfig } from "../../lib/config.ts";
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

/**
 * The runtime resolution below spawns `docker` and `podman`, and the cost of that is the machine's, not
 * the code's. It measures about 3.6 s on a developer machine, which sits close enough to Bun's 5-second
 * default to cross it on a loaded CI runner — the whole test then reads as a failure of a change that
 * touched nothing near it.
 *
 * The cap is raised rather than the probe stubbed. A stub would run in milliseconds, but the real seam is
 * exactly what this case exists to exercise: that `firstReadyRuntime` resolves WITHOUT pinning. A stub
 * would leave that claim untested and the test green, which is worse than slow.
 *
 * 30 s is about eight times the measured cost, and it still fails fast if a probe truly hangs.
 */
const RUNTIME_PROBE_TIMEOUT_MS = 30_000;

describe("sandboxStatus — read-only, never pins", () => {
    test(
        "does not write the runtime config key when none is selected",
        async () => {
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
        },
        RUNTIME_PROBE_TIMEOUT_MS,
    );
});

describe("migrateRetiredSandboxImageOverride", () => {
    test("clears a retired override, keeps the rest of the harness block, and the default serves", () => {
        mkdirSync(dirname(env.configPath), { recursive: true });
        writeFileSync(
            env.configPath,
            JSON.stringify({ telemetry: false, harness: { sandboxImage: "ghcr.io/inflexa-ai/sandbox-python-r:latest", adminPort: 4141 } }),
        );

        expect(migrateRetiredSandboxImageOverride()).toBe("ghcr.io/inflexa-ai/sandbox-python-r:latest");

        const harness = readConfig().harness as Record<string, unknown>;
        expect(harness.sandboxImage).toBeUndefined();
        expect(harness.adminPort).toBe(4141);
        expect(configuredSandboxImage()).toBe("ghcr.io/inflexa-ai/sandbox-base:latest");
        // A second run finds nothing: the migration is one-shot by content.
        expect(migrateRetiredSandboxImageOverride()).toBeNull();
    });

    test("keeps a custom override, because that is a deliberate choice", () => {
        mkdirSync(dirname(env.configPath), { recursive: true });
        writeFileSync(env.configPath, JSON.stringify({ telemetry: false, harness: { sandboxImage: "my-registry/my-sandbox:latest" } }));

        expect(migrateRetiredSandboxImageOverride()).toBeNull();
        expect(configuredSandboxImage()).toBe("my-registry/my-sandbox:latest");
    });

    test("a config with no harness block changes nothing", () => {
        mkdirSync(dirname(env.configPath), { recursive: true });
        writeFileSync(env.configPath, JSON.stringify({ telemetry: false }));

        expect(migrateRetiredSandboxImageOverride()).toBeNull();
    });
});
