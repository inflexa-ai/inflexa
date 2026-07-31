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

// The grain subcommands, same sandbox and same claim: each answers from the local ledger alone, with
// no durable engine, no Postgres, and no model proxy running.
describe("usage grain subcommands (e2e)", () => {
    const RUN_ID = "11111111-2222-3333-4444-5555aabbccdd";

    /** Chat turns on one thread, a run with two steps, and one call carrying neither frame. */
    function seedGrains(): void {
        const base = { recordedAt: 1, agentId: "conversation", callPath: "conversation", scopeKind: "analysis", scopeId: "ana1" } as const;
        upsertLlmUsage({ ...base, recordKey: "c1", threadId: "thr-a", usage: { inputTokens: 12_000, outputTokens: 3_000 } })._unsafeUnwrap();
        upsertLlmUsage({
            ...base,
            recordKey: "r1",
            runId: RUN_ID,
            stepId: "qc_normalize",
            usage: { inputTokens: 24_000, outputTokens: 1_500 },
        })._unsafeUnwrap();
        upsertLlmUsage({ ...base, recordKey: "r2", runId: RUN_ID, usage: { inputTokens: 300, outputTokens: 30 } })._unsafeUnwrap();
        upsertLlmUsage({ ...base, recordKey: "b1", usage: { inputTokens: 800, outputTokens: 80 } })._unsafeUnwrap();
    }

    test("each grain reports from the local ledger with no harness runtime booted", () => {
        seedAnalysis();
        seedGrains();
        closeDb();
        const cwd = tmp();

        const sessions = runCli(["usage", "sessions", "--analysis", "My Analysis"], { cwd });
        expect(sessions.exitCode).toBe(0);
        expect(sessions.stdout).toContain('Sessions for "My Analysis"');
        expect(sessions.stdout).toMatch(/thr-a\s+1\s+12\.0k\s+3\.0k/);
        // 15.0k is the two figures added; no grain may produce it.
        expect(sessions.stdout).not.toContain("15.0k");

        const runs = runCli(["usage", "runs", "--analysis", "My Analysis"], { cwd });
        expect(runs.exitCode).toBe(0);
        expect(runs.stdout).toContain('Runs for "My Analysis"');
        expect(runs.stdout).toMatch(new RegExp(`${RUN_ID}\\s+2\\s+24\\.3k\\s+1\\.5k`));

        // Work under neither frame is carried by the analysis report — the one report that also prints
        // the headline it is part of — and by neither grain table, so summing the two printed grain
        // reports cannot count it twice. Each grain instead signposts it, figure-free.
        const report = runCli(["usage", "--analysis", "My Analysis"], { cwd });
        expect(report.exitCode).toBe(0);
        expect(report.stdout).toMatch(/\(no session or run\)\s+1\s+800\s+80/);
        for (const grain of [sessions.stdout, runs.stdout]) {
            expect(grain).not.toContain("(no session or run)");
            expect(grain).not.toContain("800");
            expect(grain).toContain("Calls belonging to no session or run are reported by `inflexa usage`.");
        }

        const steps = runCli(["usage", "steps", "--run", RUN_ID, "--analysis", "My Analysis"], { cwd });
        expect(steps.exitCode).toBe(0);
        expect(steps.stdout).toContain(`Steps for run ${RUN_ID}`);
        expect(steps.stdout).toMatch(/qc_normalize\s+1\s+24\.0k\s+1\.5k/);
        expect(steps.stdout).toMatch(/\(no step\)\s+1\s+300\s+30/);
    });

    test("a grain with nothing recorded says so rather than printing an empty table", () => {
        seedAnalysis();
        closeDb();
        const cwd = tmp();

        const sessions = runCli(["usage", "sessions", "--analysis", "My Analysis"], { cwd });
        expect(sessions.exitCode).toBe(0);
        expect(sessions.stdout).toContain('No session usage recorded for "My Analysis".');
        expect(sessions.stdout).not.toContain("calls");

        const runs = runCli(["usage", "runs", "--analysis", "My Analysis"], { cwd });
        expect(runs.exitCode).toBe(0);
        expect(runs.stdout).toContain('No run usage recorded for "My Analysis".');
    });

    test("every grain writes nothing — no marker in the cwd, no sighting heartbeat, and no change to the ledger", () => {
        seedAnalysis();
        seedGrains();
        const anchorBefore = getAnchor("anc1")._unsafeUnwrap();
        const ledgerBefore = getAnalysisUsageTotals("ana1")._unsafeUnwrap();
        closeDb();
        const dir = tmp();

        for (const argv of [
            ["usage", "sessions", "--analysis", "My Analysis"],
            ["usage", "runs", "--analysis", "My Analysis"],
            ["usage", "steps", "--run", RUN_ID, "--analysis", "My Analysis"],
        ]) {
            expect(runCli(argv, { cwd: dir }).exitCode).toBe(0);
        }

        // The passive read leaves the directory untouched — no .inflexa/id minted (no-litter policy).
        expect(existsSync(join(dir, ".inflexa", "id"))).toBe(false);
        // Nor may it record a sighting: these are `auto`, so an agent may run them unprompted, and a
        // heartbeat would make `lastSeen` measure agent polling rather than the user's presence. The
        // seeded `1` is a stamp no clock read can reproduce, so a write shows as a changed row.
        expect(getAnchor("anc1")._unsafeUnwrap()).toEqual(anchorBefore);
        // And none of them may touch what they report on: reading the ledger is not an event in it.
        expect(getAnalysisUsageTotals("ana1")._unsafeUnwrap()).toEqual(ledgerBefore);
    });
});
