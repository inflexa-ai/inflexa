import { describe, expect, test } from "bun:test";

import { runCli } from "../test_support/cli.ts";

// e2e of the commander registry surface — help text and the error/exit-code contract. No DB needed:
// --help exits before any action, and unknown option/command errors during parse.
describe("inf help & usage (e2e)", () => {
    test("--help exits 0 and lists the registered commands", () => {
        const result = runCli(["--help"]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Usage: inf");
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
});
