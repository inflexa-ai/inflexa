import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCliAsync } from "../../test_support/cli.ts";
import { freshDb } from "../../test_support/db.ts";
import { startTestServer, type TestServer } from "../../test_support/server.ts";
import { createAnalysis, fetchAnalyses } from "../analyses.ts";
import { createProject } from "../projects.ts";
import { resolveResumeTarget } from "./analyses.ts";

// The analysis commands are clients of the local server. Each case seeds through the routes of a test
// server in this process, then drives a command: in this process for a resolver that returns a value, and
// as a child process for a command that prints and exits.

const created: string[] = [];

/** A real folder under its physical path, so it equals the canonical anchor path of the server. */
function tmp(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "inflexa-client-")));
    created.push(dir);
    return dir;
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

/** Make an analysis anchored at `dir` through `POST /api/v1/analyses`. */
async function seed(dir: string, name: string): Promise<{ id: string; name: string }> {
    return (await createAnalysis({ name, folder: dir }, server.clientOpts))._unsafeUnwrap();
}

describe("resolveResumeTarget", () => {
    test("an existing analysis resolves to its anchor folder, by id and by name", async () => {
        const dir = tmp();
        const a = await seed(dir, "Bulk RNA");

        const byId = await resolveResumeTarget(a.id, server.clientOpts);
        expect(byId.workingDir).toBe(dir);
        expect(byId.analysis).toMatchObject({ id: a.id, name: "Bulk RNA" });
        // The ChatTarget shape is load-bearing: it is the entire contract with the renderer, and the
        // resolver binds NO conversation thread (the TUI binds one when the server is ready).
        expect(Object.keys(byId).sort()).toEqual(["analysis", "workingDir"]);

        const byName = await resolveResumeTarget("Bulk RNA", server.clientOpts);
        expect(byName.analysis.id).toBe(a.id);
    });

    test("resolving makes no analysis", async () => {
        const a = await seed(tmp(), "Only");
        await resolveResumeTarget(a.id, server.clientOpts);
        expect((await fetchAnalyses({ page: 0, perPage: 10 }, server.clientOpts))._unsafeUnwrap().total).toBe(1);
    });
});

describe("inflexa inputs (e2e)", () => {
    test("add, ls, and remove go through the server", async () => {
        const dir = tmp();
        writeFileSync(join(dir, "counts.tsv"), "x");
        await seed(dir, "rna");

        const added = await runCliAsync(["inputs", "add", "counts.tsv", "--analysis", "rna"], { cwd: dir, env: server.childEnv });
        expect(added.exitCode).toBe(0);
        expect(added.stdout).toContain('Added 1 input(s) to "rna": counts.tsv');

        const listed = await runCliAsync(["inputs", "ls", "--analysis", "rna"], { cwd: dir, env: server.childEnv });
        expect(listed.stdout).toContain("file  counts.tsv");

        const removed = await runCliAsync(["inputs", "remove", "counts.tsv", "gone.tsv", "--analysis", "rna"], { cwd: dir, env: server.childEnv });
        expect(removed.exitCode).toBe(0);
        expect(removed.stdout).toContain('Removed from "rna": counts.tsv');
        // The skipped path is reported as the user typed it, not as the absolute path the server matched.
        expect(removed.stdout).toContain("Not current inputs (skipped): gone.tsv");
    });

    test("a path that does not exist is refused, and nothing is added", async () => {
        const dir = tmp();
        await seed(dir, "rna");
        const result = await runCliAsync(["inputs", "add", "nope.tsv", "--analysis", "rna"], { cwd: dir, env: server.childEnv });
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(`no such file: ${join(dir, "nope.tsv")}`);
    });
});

describe("inflexa analysis set-project (e2e)", () => {
    test("sets and clears the project, and an unknown project changes nothing", async () => {
        await seed(tmp(), "rna");
        (await createProject({ name: "Liver" }, server.clientOpts))._unsafeUnwrap();

        const set = await runCliAsync(["analysis", "set-project", "rna", "Liver"], { env: server.childEnv });
        expect(set.stdout).toContain('Set the project of "rna" to "Liver".');

        const unknown = await runCliAsync(["analysis", "set-project", "rna", "nope"], { env: server.childEnv });
        expect(unknown.exitCode).toBe(1);
        expect(unknown.stderr).toContain('No project found matching "nope".');

        const cleared = await runCliAsync(["analysis", "set-project", "rna"], { env: server.childEnv });
        expect(cleared.stdout).toContain('Cleared the project of "rna".');
    });
});
