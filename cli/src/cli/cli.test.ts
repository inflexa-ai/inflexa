import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { env } from "../lib/env.ts";
import { runCli } from "../test_support/cli.ts";
import { assertTestSandbox } from "../test_support/sandbox.ts";

// e2e of the commander registry surface — help text and the error/exit-code contract. No DB needed:
// --help exits before any action, and unknown option/command errors during parse.
describe("inflexa help & usage (e2e)", () => {
    test("--help exits 0 and lists the registered commands", () => {
        const result = runCli(["--help"]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Usage: inflexa");
        expect(result.stdout).toContain("project");
        expect(result.stdout).toContain("sessions");
        expect(result.stdout).toContain("refs");
        expect(result.stdout).toContain("reference data mounted read-only in sandboxes at /mnt/refs");
    });

    test("refs path prints the exact public path without creating it", async () => {
        const result = runCli(["refs", "path"]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toContain("/inflexa/refs");
        expect(await Bun.file(result.stdout.trim()).exists()).toBe(false);
    });

    test("unknown reference ids fail before filesystem or network work", () => {
        const result = runCli(["refs", "download", "unknown", "--yes"]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("Unknown reference dataset");
    });

    test("refs list explains custom content, integrity, and catalog contributions", () => {
        const result = runCli(["refs", "list"]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Add arbitrary references under");
        expect(result.stdout).toContain("Open a PR");
        // Nothing is re-hosted: each dataset states the integrity guarantee its own upstream can offer.
        expect(result.stdout).toContain("Integrity: pinned — verified against the checksums in the catalog");
        expect(result.stdout).toContain("Integrity: unpinned — upstream is rebuilt in place; verified against what you downloaded");
        expect(result.stdout).toContain("nothing is mirrored or re-hosted here");
    });

    test("refs download offers --force to repair damage and refresh mutable upstreams", () => {
        const result = runCli(["refs", "download", "--help"]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("--yes");
        expect(result.stdout).toContain("--force");
        expect(result.stdout).toContain("Re-fetch even when already installed");
    });

    test("refs list identifies user-owned content without adopting it", () => {
        assertTestSandbox(env.refsDir);
        const custom = join(env.refsDir, "user", "custom.fa");
        mkdirSync(join(env.refsDir, "user"), { recursive: true });
        writeFileSync(custom, "custom");
        try {
            const result = runCli(["refs", "list"]);
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain("user/custom.fa");
            expect(result.stdout).toContain("left untouched");
        } finally {
            assertTestSandbox(env.refsDir);
            rmSync(env.refsDir, { recursive: true, force: true });
        }
    });

    test("refs verify with no active catalog receipts reports an empty verification set", () => {
        const result = runCli(["refs", "verify"]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("No installed catalog reference datasets to verify.");
    });

    test("an unknown option exits non-zero", () => {
        const result = runCli(["--bogus-flag"]);
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("unknown option");
    });

    test("an unknown subcommand exits non-zero", () => {
        const result = runCli(["project", "bogus"]);
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("unknown command");
    });

    // The root `.version()` owns `--version`; `sandbox pull` takes a positional
    // variant (not a `--version`-shaped flag), so there is no clash. Both directions
    // are asserted: bare `--version` prints the version, and `sandbox pull <variant>`
    // reaches the pull command's own handler.
    test("bare --version prints the CLI version and exits 0", () => {
        const result = runCli(["--version"]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    });

    test("`sandbox pull <variant>` reaches the pull handler, not the root --version", () => {
        // An unknown variant is rejected by the sandbox-pull handler BEFORE any docker
        // call, so this proves the subcommand routed there (not the root --version) without
        // touching the container runtime or the network.
        const result = runCli(["sandbox", "pull", "definitely-not-a-variant"]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("Unknown variant");
        // The root `--version` handler did NOT fire (it would print just the version).
        expect(result.stdout.trim()).not.toMatch(/^\d+\.\d+\.\d+$/);
    });

    // Regression for the reverted `enablePositionalOptions()`: it made a root-style flag
    // placed AFTER a subcommand (`inflexa sessions --project x`) hard-fail "unknown option",
    // breaking existing invocations. Without it, the shape parses again and runs the command.
    test("`sessions --project x`-shape (root flag after a subcommand) parses again", () => {
        const result = runCli(["sessions", "--project", "x"]);
        expect(result.exitCode).toBe(0);
        expect(result.stderr).not.toContain("unknown option");
    });

    // A fast `fail()` bail-out exits before the event loop turns, so the log file's fd must be
    // ready from construction (lib/log.ts opens it synchronously) or pino's exit-hook flushSync
    // throws "sonic boom is not ready yet" and sprays a stack trace after the command's real
    // message. Pin the quiet exit: the failure message must be the only stderr output.
    test("a fast fail() exit prints only its message — no log-stream crash on exit", () => {
        const result = runCli(["prov", "lineage", "nonexistent-analysis", "whatever"]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('No analysis found matching "nonexistent-analysis"');
        expect(result.stderr).not.toContain("sonic boom");
        expect(result.stderr).not.toContain("flushSync");
    });

    // An unknown --format must fail listing every accepted value. Option validation runs before
    // analysis resolution, so the placeholder arguments never need to exist.
    test("an unknown lineage --format fails listing the accepted values", () => {
        const result = runCli(["prov", "lineage", "anything", "anything", "--format", "svg"]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('Unknown format "svg". Use "tree", "json", "dot", or "mermaid".');
    });
});
