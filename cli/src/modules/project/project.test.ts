import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runCliAsync } from "../../test_support/cli.ts";
import { freshDb } from "../../test_support/db.ts";
import { startTestServer, type TestServer } from "../../test_support/server.ts";
import { findProjectByRef } from "../../db/primary_query.ts";

// e2e: drive the real `inflexa` binary as a subprocess. The command is a client of the local server, thus
// each test starts a server in this process (startTestServer) over the sandboxed DB that freshDb() lays
// down. The child finds the server through `server.childEnv`, and the parent reads back through the same
// DB to assert persisted STATE, not just stdout. `runCliAsync`, because a sync spawn would block the event
// loop that answers the child.
let server: TestServer;

beforeEach(() => {
    freshDb();
    server = startTestServer();
});

afterEach(async () => {
    await server.stop();
});

describe("inflexa project new (e2e)", () => {
    test("creates a project: exits 0, prints confirmation, persists the row", async () => {
        const result = await runCliAsync(["project", "new", "Acme"], { env: server.childEnv });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Created project "Acme"');
        // Through `string | undefined`: the persisted name is the opaque Str256 brand.
        const persisted: string | undefined = findProjectByRef("Acme")._unsafeUnwrap()?.name;
        expect(persisted).toBe("Acme");
    });

    test("rejects a duplicate name: exits non-zero with an explanatory error", async () => {
        expect((await runCliAsync(["project", "new", "Acme"], { env: server.childEnv })).exitCode).toBe(0);
        const dup = await runCliAsync(["project", "new", "Acme"], { env: server.childEnv });
        expect(dup.exitCode).not.toBe(0);
        expect(dup.stderr).toContain("already exists");
    });

    test("rejects a blank name", async () => {
        const result = await runCliAsync(["project", "new", "   "], { env: server.childEnv });
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("Invalid project name");
    });
});

describe("inflexa project ls (e2e)", () => {
    test("lists each project with its tags and its analysis count", async () => {
        expect((await runCliAsync(["project", "new", "Acme", "--tags", "rna, liver"], { env: server.childEnv })).exitCode).toBe(0);
        const result = await runCliAsync(["project", "ls"], { env: server.childEnv });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Projects (1):");
        expect(result.stdout).toContain("Acme [rna, liver]  (0 analyses)");
    });

    test("says so when there are no projects", async () => {
        const result = await runCliAsync(["project", "ls"], { env: server.childEnv });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("No projects.");
    });
});

describe("the server check (e2e)", () => {
    test("with no server, the command stops with the instruction to start one", async () => {
        await server.stop();
        const result = await runCliAsync(["project", "ls"], { env: server.childEnv });
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("inflexa serve");
        server = startTestServer();
    });
});
