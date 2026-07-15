import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { isMovingTag, sandboxStatus } from "./pull.ts";
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
