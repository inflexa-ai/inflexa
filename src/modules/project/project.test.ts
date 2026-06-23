import { beforeEach, describe, expect, test } from "bun:test";

import { runCli } from "../../test_support/cli.ts";
import { closeDb } from "../../db/primary.ts";
import { freshDb } from "../../test_support/db.ts";
import { findProjectByRef } from "../../db/primary_query.ts";

// e2e: drive the real `inf` binary as a subprocess against the sandboxed DB. freshDb() lays down an
// empty migrated DB; closeDb() releases it so the subprocess opens it cleanly. The parent reads back
// through the same file (db() reopens) to assert persisted STATE, not just stdout.
beforeEach(() => {
    freshDb();
    closeDb();
});

describe("inf project new (e2e)", () => {
    test("creates a project: exits 0, prints confirmation, persists the row", () => {
        const result = runCli(["project", "new", "Acme"]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Created project "Acme"');
        // Through `string | undefined`: the persisted name is the opaque Str256 brand.
        const persisted: string | undefined = findProjectByRef("Acme")._unsafeUnwrap()?.name;
        expect(persisted).toBe("Acme");
    });

    test("rejects a duplicate name: exits non-zero with an explanatory error", () => {
        expect(runCli(["project", "new", "Acme"]).exitCode).toBe(0);
        const dup = runCli(["project", "new", "Acme"]);
        expect(dup.exitCode).not.toBe(0);
        expect(dup.stderr).toContain("already exists");
    });

    test("rejects a blank name", () => {
        const result = runCli(["project", "new", "   "]);
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("Invalid project name");
    });
});
