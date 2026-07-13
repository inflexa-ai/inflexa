import { describe, expect, test } from "bun:test";

import { runCli } from "../test_support/cli.ts";

// e2e of the commander registry surface — help text and the error/exit-code contract. No DB needed:
// --help exits before any action, and unknown option/command errors during parse.
describe("inflexa help & usage (e2e)", () => {
    test("--help exits 0 and lists the registered commands", () => {
        const result = runCli(["--help"]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Usage: inflexa");
        expect(result.stdout).toContain("project");
        expect(result.stdout).toContain("sessions");
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
