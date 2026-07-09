import { afterAll, describe, expect, test } from "bun:test";
import { onCleanup } from "solid-js";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { env } from "../lib/env.ts";
import { runCli } from "./cli.ts";
import { freshDb, resetDb } from "./db.ts";
import { assertTestSandbox } from "./sandbox.ts";
import { withRoot } from "./solid.ts";

// Pin the three harness seams (env sandbox, temp DB, Solid root) so a refactor that breaks isolation
// fails here loudly rather than silently corrupting every integration test that relies on them.

describe("test preload (env sandbox)", () => {
    test("redirects env.dbPath into an isolated temp dir, not the real home", () => {
        expect(env.dbPath).toContain("inflexa-test-");
        expect(env.dbPath.startsWith(tmpdir())).toBe(true);
    });
});

describe("freshDb / resetDb", () => {
    // Leave no open handle or stray DB file for the sibling test files that share this process.
    afterAll(() => {
        resetDb();
    });

    test("yields a migrated connection", () => {
        const conn = freshDb();
        const tables = conn
            .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
            .all()
            .map((r) => r.name);
        expect(tables).toContain("_migrations");
        expect(tables).toContain("projects");
    });

    test("wipes on-disk state between calls", () => {
        const first = freshDb();
        first.run("CREATE TABLE harness_probe (x INTEGER)");
        first.run("INSERT INTO harness_probe (x) VALUES (1)");

        // Re-requesting resets: closes `first`, deletes the db file, reopens + re-migrates empty.
        const second = freshDb();
        const probe = second.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name='harness_probe'").get();
        expect(probe).toBeNull();
    });

    test("refuses to delete when the sandbox marker is absent", () => {
        // This test writes a sentinel to and then rmSyncs env.dbPath DIRECTLY (raw fs, not resetDb),
        // while it has deliberately removed the marker below — so those raw ops bypass every guard.
        // At the monorepo root (no sandbox) env.dbPath is the developer's REAL agent.db, so without
        // this line the test itself overwrites+deletes it (that IS incident 2's "emptied DB"). Assert
        // the sandbox is active FIRST, while the marker is still present, so a root run throws here —
        // before any mkdir/write/rm touches the real DB. Inside the sandbox this passes and the test
        // proceeds to delete the marker and prove resetDb refuses.
        assertTestSandbox(env.dbPath);

        // Simulate `bun test` run from the repo root: the preload never stamps INFLEXA_TEST_SANDBOX,
        // so resetDb must THROW before any rmSync rather than delete whatever env.dbPath points at
        // (the developer's real DB, in that scenario). Save/restore the marker so the sibling tests
        // sharing this process keep their destructive-reset authorization.
        const saved = process.env.INFLEXA_TEST_SANDBOX;
        delete process.env.INFLEXA_TEST_SANDBOX;
        // A sentinel at the EXACT path resetDb would rmSync. Asserting only the throw would stay green
        // if the guard were ever reordered BELOW the rmSync loop — the precise data-loss regression it
        // exists to prevent. The sentinel proves the guard bailed BEFORE any deletion: it must survive.
        // (env.dbPath is inside the test sandbox here, so writing/removing it is safe.)
        mkdirSync(dirname(env.dbPath), { recursive: true });
        writeFileSync(env.dbPath, "sentinel");
        try {
            expect(() => resetDb()).toThrow("test sandbox not active");
            expect(existsSync(env.dbPath)).toBe(true);
        } finally {
            if (saved !== undefined) process.env.INFLEXA_TEST_SANDBOX = saved;
            rmSync(env.dbPath, { force: true });
        }
    });
});

// The guard's containment test is lexical, so its one interesting failure mode is a path that merely
// SHARES the sandbox's prefix. `mkdtempSync` names are attacker-free but not collision-free: a stale
// `/tmp/inflexa-test-AbC123-old` from a previous run sits right beside a live `/tmp/inflexa-test-AbC123`.
describe("assertTestSandbox containment", () => {
    // Non-null is guaranteed upstream: env.ts refuses to evaluate under NODE_ENV=test without the
    // marker, and the import of `env` at the top of this file would have thrown before we got here.
    const sandbox = process.env.INFLEXA_TEST_SANDBOX as string;

    test("a path inside the sandbox is authorized", () => {
        expect(() => assertTestSandbox(join(sandbox, "data", "inflexa", "agent.db"))).not.toThrow();
    });

    test("the sandbox root itself is authorized (the preload's exit hook reaps it)", () => {
        expect(() => assertTestSandbox(sandbox)).not.toThrow();
    });

    test("a sibling sharing the sandbox's prefix is REFUSED", () => {
        expect(() => assertTestSandbox(`${sandbox}-real`)).toThrow("test sandbox not active");
        expect(() => assertTestSandbox(`${sandbox}.bak`)).toThrow("test sandbox not active");
    });

    test("an unrelated real path is refused", () => {
        expect(() => assertTestSandbox(join(homedir(), ".local", "share", "inflexa", "agent.db"))).toThrow("test sandbox not active");
    });
});

describe("withRoot", () => {
    test("returns the body value and disposes the root afterward", () => {
        let disposed = false;
        const result = withRoot(() => {
            onCleanup(() => {
                disposed = true;
            });
            return 42;
        });
        expect(result).toBe(42);
        expect(disposed).toBe(true);
    });
});

describe("runCli", () => {
    test("runs the real CLI subprocess and captures exit code + stdout", () => {
        const result = runCli(["--help"]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Usage: inflexa");
        expect(result.stdout).toContain("sessions");
    });
});
