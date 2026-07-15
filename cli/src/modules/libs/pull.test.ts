import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { sandboxStatus } from "./pull.ts";
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
