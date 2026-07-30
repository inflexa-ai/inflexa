import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../test_support/cli.ts";
import { closeDb } from "../db/primary.ts";
import { freshDb } from "../test_support/db.ts";
import { getAnalysisUsageTotals, getAnchor } from "../db/primary_query.ts";
import { insertAnalysis, insertAnchor, upsertLlmUsage } from "../db/primary_mutation.ts";
import { writeMarker } from "../modules/anchor/marker.ts";
import { asStr256 } from "../lib/types.ts";

// `inflexa usage` end to end, as a real subprocess. The point of these tests is WHERE the answer comes
// from: the sandbox has no durable engine, no Postgres, and no model proxy running, so a zero exit and
// a printed report prove the report is served entirely by the local SQLite ledger. A command that
// needed the harness runtime could not pass here at all.

const created: string[] = [];

function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), "inflexa-usage-e2e-"));
    created.push(dir);
    return dir;
}

// Seed an anchor + analysis the command can resolve by name. The subprocess reads the sandbox DB the
// parent wrote, so closeDb() (checkpoint + release) must run before each runCli.
//
// The anchor sits at a REAL folder holding its marker because that is the only shape under which a
// heartbeat would be written at all: `resolveAnchor` bumps `last_seen` on its cheap first step, when
// the cached path still holds the marker. An anchor cached at a path that does not exist falls
// through to the bounded search instead and writes nothing — so seeding one would make the
// no-heartbeat assertion below pass no matter how the command resolves.
function seedAnalysis(): void {
    const home = tmp();
    writeMarker(home, "anc1")._unsafeUnwrap();
    insertAnchor({ id: "anc1", createdAt: 1, updatedAt: 1, cachedPath: home, markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
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

function seedUsage(): void {
    upsertLlmUsage({
        recordKey: "rk1",
        recordedAt: 1,
        agentId: "conversation",
        callPath: "conversation",
        scopeKind: "analysis",
        scopeId: "ana1",
        servedModelId: "opus-4",
        usage: { inputTokens: 12_000, outputTokens: 3_000 },
    })._unsafeUnwrap();
    upsertLlmUsage({
        recordKey: "rk2",
        recordedAt: 2,
        agentId: "planner",
        callPath: "conversation>planner",
        scopeKind: "analysis",
        scopeId: "ana1",
        servedModelId: "haiku-4",
        usage: { inputTokens: 400, outputTokens: 100 },
    })._unsafeUnwrap();
}

beforeEach(() => {
    freshDb();
});

afterEach(() => {
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
    created.length = 0;
});

describe("usage command (e2e)", () => {
    test("reports an analysis's consumption with no harness runtime booted", () => {
        seedAnalysis();
        seedUsage();
        closeDb();

        const result = runCli(["usage", "--analysis", "My Analysis"], { cwd: tmp() });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Usage for "My Analysis" — 2 calls');
        // Two figures, never their sum: 12.4k in and 3.1k out, with 15.5k appearing nowhere.
        expect(result.stdout).toMatch(/input\s+12\.4k/);
        expect(result.stdout).toMatch(/output\s+3\.1k/);
        expect(result.stdout).not.toContain("15.5k");
        expect(result.stdout).toContain("By served model");
        expect(result.stdout).toContain("opus-4");
        expect(result.stdout).toContain("By agent");
        expect(result.stdout).toContain("planner");
    });

    test("reports an analysis with no recorded usage as such", () => {
        seedAnalysis();
        closeDb();

        const result = runCli(["usage", "--analysis", "My Analysis"], { cwd: tmp() });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('No usage recorded for "My Analysis".');
        expect(result.stdout).not.toContain("By served model");
    });

    test("the report writes nothing — no marker in the cwd, no sighting heartbeat, and no change to the ledger", () => {
        seedAnalysis();
        seedUsage();
        const anchorBefore = getAnchor("anc1")._unsafeUnwrap();
        closeDb();
        const dir = tmp();

        const result = runCli(["usage", "--analysis", "My Analysis"], { cwd: dir });

        expect(result.exitCode).toBe(0);
        // The passive read must leave the directory untouched — no .inflexa/id minted (no-litter policy).
        expect(existsSync(join(dir, ".inflexa", "id"))).toBe(false);
        // Nor may it record a sighting of the analysis's folder. A report is not a sighting, and this
        // command is `auto`: an agent may run it unprompted, so a heartbeat would make `lastSeen`
        // measure agent polling rather than the user's presence. The seeded `1` is a stamp no clock
        // read can reproduce, so a heartbeat write shows up as a changed row, never as a coincidence.
        expect(getAnchor("anc1")._unsafeUnwrap()).toEqual(anchorBefore);
        // And it must not touch what it reports on: reading the ledger is not an event in the ledger.
        expect(getAnalysisUsageTotals("ana1")._unsafeUnwrap()).toEqual({ calls: 2, inputTokens: 12_400, outputTokens: 3_100 });
    });
});
