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

    // The root `.version()` owns `--version`; the pull command's pinned-version flag is
    // `--pin` (NOT `--version`) precisely so there is no clash and no need for
    // `enablePositionalOptions()` — which regressed root flags after a subcommand. Both
    // directions are asserted: bare `--version` prints the version, and `--pin` reaches pull.
    test("bare --version prints the CLI version and exits 0", () => {
        const result = runCli(["--version"]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    });

    test("`libs pull --pin <v>` reaches the pull handler, not the root --version", () => {
        // Point the store at an unreachable host: reaching the handler means a manifest-fetch
        // failure ("Library store pull failed"), NOT the CLI version string being printed.
        const prev = Bun.env.INFLEXA_LIB_STORE_URL;
        Bun.env.INFLEXA_LIB_STORE_URL = "http://127.0.0.1:1";
        try {
            const result = runCli(["libs", "pull", "--pin", "2026.07.04-nonexistent", "--yes"]);
            expect(result.exitCode).toBe(1);
            expect(result.stderr).toContain("Library store pull failed");
            // The root `--version` handler did NOT fire (it would print just the version).
            expect(result.stdout.trim()).not.toMatch(/^\d+\.\d+\.\d+$/);
        } finally {
            if (prev === undefined) delete Bun.env.INFLEXA_LIB_STORE_URL;
            else Bun.env.INFLEXA_LIB_STORE_URL = prev;
        }
    });

    // Regression for the reverted `enablePositionalOptions()`: it made a root-style flag
    // placed AFTER a subcommand (`inflexa sessions --project x`) hard-fail "unknown option",
    // breaking existing invocations. Without it, the shape parses again and runs the command.
    test("`sessions --project x`-shape (root flag after a subcommand) parses again", () => {
        const result = runCli(["sessions", "--project", "x"]);
        expect(result.exitCode).toBe(0);
        expect(result.stderr).not.toContain("unknown option");
    });
});
