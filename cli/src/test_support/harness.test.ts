import { afterAll, describe, expect, test } from "bun:test";
import { onCleanup } from "solid-js";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";

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

    // A marker whose VALUE points at real data — an exported `INFLEXA_TEST_SANDBOX=$HOME` (basename =
    // the username) or `=/` (basename = "") — used to be trusted: isInsideSandbox is pure prefix
    // containment, so $HOME collapses the sandbox root to the developer's home and / collapses it to "",
    // and every real env.* path then counts as "inside". The marker-SHAPE gate (assertTestSandbox →
    // isSandboxMarkerShaped) now refuses any marker whose basename is not `inflexa-test-*` before a single
    // deletion. Proven the same way as the absent-marker test: env.dbPath is the sentinel path inside the
    // REAL sandbox (safe to write/remove); under the `/` marker its containment check WOULD authorize
    // that path (every absolute path is under "/"), so only the shape gate keeps resetDb from rmSync'ing
    // the sentinel.
    for (const bogusMarker of [homedir(), sep]) {
        test(`refuses a value-only marker (${bogusMarker}) before deleting; sentinel survives`, () => {
            const saved = process.env.INFLEXA_TEST_SANDBOX;
            // Guard the repo-root scenario first, while the real marker is still present, so a stray run
            // where env.dbPath is the developer's real DB throws before the mkdir/write below touches it.
            assertTestSandbox(env.dbPath);
            mkdirSync(dirname(env.dbPath), { recursive: true });
            writeFileSync(env.dbPath, "sentinel");
            process.env.INFLEXA_TEST_SANDBOX = bogusMarker;
            try {
                expect(() => resetDb()).toThrow("test sandbox not active");
                // The refusal is the SHAPE gate firing, not containment: a malformed marker is rejected
                // before the path is ever tested, so the reason names the marker's danger, not the path.
                expect(() => resetDb()).toThrow("must never authorize destroying real data");
                expect(existsSync(env.dbPath)).toBe(true);
            } finally {
                if (saved !== undefined) process.env.INFLEXA_TEST_SANDBOX = saved;
                rmSync(env.dbPath, { force: true });
            }
        });
    }
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

// The shape gate defeats a marker whose VALUE names a real directory. These are pure decisions (no fs),
// so a throw is proof the exploit path never reaches a deletion. Unlike the sentinel tests above (which
// target env.dbPath INSIDE the real sandbox), these target real ~/... paths — exactly what the old
// value-only guard authorized under these markers.
describe("assertTestSandbox marker shape", () => {
    // Captured before any test mutates the env var (see the containment block's note on non-null-ness).
    const sandbox = process.env.INFLEXA_TEST_SANDBOX;
    // Restore the real sandbox marker for the sibling test files sharing this process.
    afterAll(() => {
        if (typeof sandbox === "string") process.env.INFLEXA_TEST_SANDBOX = sandbox;
    });

    test("a $HOME marker no longer authorizes a real home path", () => {
        // The exploit: the old value-only guard made every path under home "inside" the sandbox when the
        // marker was $HOME. The shape gate rejects the MARKER, so even a real ~/... path is refused.
        process.env.INFLEXA_TEST_SANDBOX = homedir();
        expect(() => assertTestSandbox(join(homedir(), ".local", "share", "inflexa", "agent.db"))).toThrow("must never authorize destroying real data");
    });

    test("a / marker no longer authorizes an arbitrary absolute path", () => {
        // With marker=/ every absolute path passed containment (root collapses to ""); the shape gate is
        // the only thing that now refuses it.
        process.env.INFLEXA_TEST_SANDBOX = sep;
        expect(() => assertTestSandbox(join(homedir(), ".config", "inflexa", "config.json"))).toThrow("must never authorize destroying real data");
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
