import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../test_support/cli.ts";
import { closeDb } from "../db/primary.ts";
import { freshDb } from "../test_support/db.ts";
import { createProject, createSession, insertAnalysis, insertAnchor } from "../db/primary_mutation.ts";
import { asStr256 } from "../lib/types.ts";

const created: string[] = [];

function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), "inflexa-e2e-"));
    created.push(dir);
    return dir;
}

// Seed an anchor + analysis the read commands can list. The subprocess reads the sandbox DB the
// parent wrote, so closeDb() (checkpoint + release) must run before each runCli.
function seedAnalysis(): void {
    insertAnchor({ id: "anc1", createdAt: 1, updatedAt: 1, cachedPath: "/home/proj", markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
    insertAnalysis({
        id: "ana1",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        name: asStr256("My Analysis"),
        slug: "my-analysis",
        outputDirectory: null,
        anchorId: "anc1",
        projectId: null,
    })._unsafeUnwrap();
}

beforeEach(() => {
    freshDb();
});

afterEach(() => {
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
    created.length = 0;
});

describe("read commands (e2e)", () => {
    test("inflexa ls lists a seeded analysis", () => {
        seedAnalysis();
        closeDb();
        const result = runCli(["ls"]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("My Analysis");
    });

    test("inflexa ls reports when there are no analyses", () => {
        closeDb();
        const result = runCli(["ls"]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("No analyses found");
    });

    test("inflexa project ls lists a seeded project", () => {
        createProject({ name: asStr256("Acme"), description: null, tags: [] })._unsafeUnwrap();
        closeDb();
        const result = runCli(["project", "ls"]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Acme");
    });

    test("inflexa sessions lists a seeded session", () => {
        seedAnalysis();
        createSession({ title: "My Chat", analysisId: "ana1" })._unsafeUnwrap();
        closeDb();
        const result = runCli(["sessions"]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("My Chat");
    });

    test("inflexa status in a marker-less directory reports empty context", () => {
        const dir = tmp();
        closeDb();
        const result = runCli(["status"], { cwd: dir });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("context: empty");
    });
});

describe("no-litter policy (e2e)", () => {
    test("a read-only command writes no anchor marker in the cwd", () => {
        const dir = tmp();
        closeDb();
        const result = runCli(["status"], { cwd: dir });
        expect(result.exitCode).toBe(0);
        // The passive flow must leave the directory untouched — no .inflexa/id minted.
        expect(existsSync(join(dir, ".inflexa", "id"))).toBe(false);
    });
});
