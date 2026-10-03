import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCliAsync } from "../test_support/cli.ts";
import { freshDb } from "../test_support/db.ts";
import { startTestServer, type TestServer } from "../test_support/server.ts";
import { createProject, insertAnalysis, insertAnchor } from "../db/primary_mutation.ts";
import { asStr256 } from "../lib/types.ts";

const created: string[] = [];

function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), "inflexa-e2e-"));
    created.push(dir);
    return dir;
}

// Seed an anchor + analysis the read commands can list. Each command is a client of the server of this
// process, which reads the sandboxed database that the seed wrote; the child opens no database.
function seedAnalysis(): void {
    insertAnchor({ id: "anc1", createdAt: 1, updatedAt: 1, cachedPath: "/home/proj", markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
    insertAnalysis({
        id: "ana1",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        name: asStr256("My Analysis"),
        slug: "my-analysis",
        anchorId: "anc1",
        projectId: null,
    })._unsafeUnwrap();
}

let server: TestServer;

beforeEach(() => {
    freshDb();
    server = startTestServer();
});

afterEach(async () => {
    await server.stop();
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
    created.length = 0;
});

describe("read commands (e2e)", () => {
    test("inflexa ls lists a seeded analysis", async () => {
        seedAnalysis();
        const result = await runCliAsync(["ls"], { env: server.childEnv });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("My Analysis");
        expect(result.stdout).toContain("/home/proj");
    });

    test("inflexa ls reports when there are no analyses", async () => {
        const result = await runCliAsync(["ls"], { env: server.childEnv });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("No analyses found");
    });

    test("inflexa project ls lists a seeded project", async () => {
        createProject({ name: asStr256("Acme"), description: null, tags: [] })._unsafeUnwrap();
        const result = await runCliAsync(["project", "ls"], { env: server.childEnv });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Acme");
    });

    test("inflexa status in a marker-less directory reports empty context", async () => {
        const dir = tmp();
        const result = await runCliAsync(["status"], { cwd: dir, env: server.childEnv });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("context: empty");
    });
});

describe("no-litter policy (e2e)", () => {
    test("a read-only command writes no anchor marker in the cwd", async () => {
        const dir = tmp();
        const result = await runCliAsync(["status"], { cwd: dir, env: server.childEnv });
        expect(result.exitCode).toBe(0);
        // The passive flow must leave the directory untouched — no .inflexa/id minted.
        expect(existsSync(join(dir, ".inflexa", "id"))).toBe(false);
    });
});
