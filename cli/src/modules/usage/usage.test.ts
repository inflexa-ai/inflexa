import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { str256 } from "../../lib/types.ts";
import { freshDb } from "../../test_support/db.ts";
import { getAnchor } from "../../db/primary_query.ts";
import { upsertLlmUsage, type LlmUsageEntry } from "../../db/primary_mutation.ts";
import { createAnalysis } from "../analysis/analysis.ts";
import { runUsage, runUsageRuns, runUsageSessions, runUsageSteps } from "./usage.ts";

// The action resolves its analysis from process.cwd(), so each test runs cd'd into the analysis's
// anchor folder. console.log is captured to keep the suite quiet and to assert on what was printed.
describe("usage command action", () => {
    let dir = "";
    let analysisId = "";
    let anchorId = "";
    let origCwd = "";
    let logs: string[] = [];
    const origLog = console.log;

    // Only the fields a given case cares about; everything else takes a plausible constant. Every
    // token quantity stays OPTIONAL here on purpose — a test that always supplies all five could not
    // tell a preserved absence from a zero.
    function record(key: string, over: Partial<LlmUsageEntry> & { usage: LlmUsageEntry["usage"] }): void {
        upsertLlmUsage({
            recordKey: key,
            recordedAt: 1,
            agentId: "conversation",
            callPath: "conversation",
            scopeKind: "analysis",
            scopeId: analysisId,
            ...over,
        })._unsafeUnwrap();
    }

    function output(): string {
        return logs.join("\n");
    }

    beforeEach(() => {
        freshDb();
        origCwd = process.cwd();
        dir = realpathSync(mkdtempSync(join(tmpdir(), "inflexa-usage-")));
        const analysis = createAnalysis({ cwd: dir, name: str256("usage")._unsafeUnwrap() })._unsafeUnwrap();
        analysisId = analysis.id;
        anchorId = analysis.anchorId;
        process.chdir(dir);
        logs = [];
        console.log = (...args: unknown[]): void => void logs.push(args.join(" "));
    });

    afterEach(() => {
        console.log = origLog;
        process.chdir(origCwd);
        rmSync(dir, { recursive: true, force: true });
    });

    test("reports the analysis's figures with a per-model and a per-agent breakdown", () => {
        record("k1", { agentId: "conversation", servedModelId: "opus-4", usage: { inputTokens: 10_000, outputTokens: 2_000 } });
        record("k2", { agentId: "conversation", servedModelId: "opus-4", usage: { inputTokens: 2_000, outputTokens: 1_000 } });
        record("k3", { agentId: "planner", servedModelId: "haiku-4", usage: { inputTokens: 400, outputTokens: 100 } });

        runUsage({});
        const out = output();

        expect(out).toContain('Usage for "usage" — 3 calls');
        // 12.4k in / 3.1k out — reported as TWO figures. The sum (15.5k) must appear nowhere.
        expect(out).toMatch(/input\s+12\.4k/);
        expect(out).toMatch(/output\s+3\.1k/);
        expect(out).not.toContain("15.5k");
        expect(out).toContain("By served model");
        expect(out).toMatch(/opus-4\s+2\s+12\.0k\s+3\.0k/);
        expect(out).toMatch(/haiku-4\s+1\s+400\s+100/);
        expect(out).toContain("By agent");
        expect(out).toMatch(/conversation\s+2\s+12\.0k\s+3\.0k/);
        expect(out).toMatch(/planner\s+1\s+400\s+100/);
    });

    test("resolves the analysis named by --analysis rather than the working context", () => {
        const other = createAnalysis({ cwd: dir, name: str256("other")._unsafeUnwrap() })._unsafeUnwrap();
        record("k1", { usage: { inputTokens: 999 } });
        upsertLlmUsage({
            recordKey: "k2",
            recordedAt: 1,
            agentId: "conversation",
            callPath: "conversation",
            scopeKind: "analysis",
            scopeId: other.id,
            usage: { inputTokens: 111 },
        })._unsafeUnwrap();

        runUsage({ analysis: "other" });
        const out = output();

        expect(out).toContain('Usage for "other"');
        // The sibling analysis's spend is attributed by scope id alone and cannot leak in.
        expect(out).toContain("111");
        expect(out).not.toContain("999");
    });

    test("an analysis with no recorded usage says so, with no zeroed figures and no table", () => {
        runUsage({});
        const out = output();

        expect(out).toContain('No usage recorded for "usage".');
        expect(out).not.toContain("input");
        expect(out).not.toContain("By served model");
        expect(out).not.toContain("0");
    });

    test("calls whose provider reported nothing are a report, distinct from no calls at all", () => {
        record("k1", { usage: {} });
        record("k2", { usage: {} });

        runUsage({});
        const out = output();

        // Two recorded calls that measured nothing: the count is the fact, the figures are unknowns.
        expect(out).toContain("2 calls");
        expect(out).not.toContain("No usage recorded");
        expect(out).toMatch(/input\s+not reported/);
        expect(out).toMatch(/output\s+not reported/);
    });

    test("an unreported quantity prints as unknown while a reported zero prints as zero", () => {
        record("k1", { usage: { inputTokens: 500, outputTokens: 0 } });

        runUsage({});
        const out = output();

        // outputTokens: 0 is a measurement the provider made; the absent cache/reasoning counts are not.
        expect(out).toMatch(/output\s+0/);
        expect(out).not.toContain("cache read");
        expect(out).not.toContain("reasoning");
    });

    test("cache and reasoning counts render as breakdowns and are never folded into the two figures", () => {
        record("k1", {
            usage: { inputTokens: 10_000, outputTokens: 2_000, cacheCreationInputTokens: 1_000, cacheReadInputTokens: 8_000, reasoningTokens: 900 },
        });

        runUsage({});
        const out = output();

        expect(out).toMatch(/input\s+10\.0k/);
        expect(out).toMatch(/cache write\s+1\.0k/);
        expect(out).toMatch(/cache read\s+8\.0k/);
        expect(out).toMatch(/output\s+2\.0k/);
        expect(out).toMatch(/reasoning\s+900/);
        // input + cacheRead (18.0k), input + output (12.0k), and all five (21.9k) are each a number
        // this report must never invent.
        for (const summed of ["18.0k", "12.0k", "21.9k"]) expect(out).not.toContain(summed);
    });

    test("reporting is not a sighting — the anchor's heartbeat is unchanged", () => {
        record("k1", { usage: { inputTokens: 100 } });
        const before = getAnchor(anchorId)._unsafeUnwrap();

        // Every anchor write stamps Date.now(), and the row was created moments ago in this same test
        // — plausibly the same millisecond — so a real clock read could write back the value the row
        // already holds and hide the heartbeat entirely. Pinning the clock to a value the row cannot
        // already carry is what makes a write detectable at all.
        const now = spyOn(Date, "now").mockReturnValue(2_000_000_000_000);
        try {
            runUsage({}); // resolved from the working context …
            runUsage({ analysis: "usage" }); // … and named by flag: two resolve paths, both silent
        } finally {
            now.mockRestore();
        }

        // The whole row, not just lastSeen: the read must not have healed cachedPath or bumped
        // updatedAt either — the folder never moved, so the resolver had nothing to repair.
        expect(getAnchor(anchorId)._unsafeUnwrap()).toEqual(before);
    });

    test("calls whose endpoint reported no served model group under a labelled absence", () => {
        record("k1", { usage: { inputTokens: 100 } });

        runUsage({});

        expect(output()).toContain("(not reported)");
    });
});

describe("usage grain subcommand actions", () => {
    let dir = "";
    let analysisId = "";
    let anchorId = "";
    let origCwd = "";
    let logs: string[] = [];
    const origLog = console.log;

    const RUN_A = "11111111-2222-3333-4444-5555aabbccdd";
    const RUN_B = "99999999-8888-7777-6666-5555ffeeddcc";

    function record(key: string, over: Partial<LlmUsageEntry> & { usage: LlmUsageEntry["usage"] }): void {
        upsertLlmUsage({
            recordKey: key,
            recordedAt: 1,
            agentId: "conversation",
            callPath: "conversation",
            scopeKind: "analysis",
            scopeId: analysisId,
            ...over,
        })._unsafeUnwrap();
    }

    /** Chat turns on two threads, two runs (one with steps), and one call carrying neither frame. */
    function seedEveryGrain(): void {
        record("c1", { threadId: "thr-a", usage: { inputTokens: 10_000, outputTokens: 1_000 } });
        record("c2", { threadId: "thr-a", usage: { inputTokens: 2_000, outputTokens: 200 } });
        record("c3", { threadId: "thr-b", usage: { inputTokens: 400, outputTokens: 40 } });
        record("r1", { runId: RUN_A, stepId: "qc_normalize", usage: { inputTokens: 24_000, outputTokens: 1_500 } });
        record("r2", { runId: RUN_A, stepId: "differential_expression", usage: { inputTokens: 6_000, outputTokens: 400 } });
        record("r3", { runId: RUN_A, usage: { inputTokens: 300, outputTokens: 30 } });
        record("r4", { runId: RUN_B, usage: {} });
        record("b1", { usage: { inputTokens: 800, outputTokens: 80 } });
    }

    function output(): string {
        return logs.join("\n");
    }

    beforeEach(() => {
        freshDb();
        origCwd = process.cwd();
        dir = realpathSync(mkdtempSync(join(tmpdir(), "inflexa-usage-grain-")));
        const analysis = createAnalysis({ cwd: dir, name: str256("usage")._unsafeUnwrap() })._unsafeUnwrap();
        analysisId = analysis.id;
        anchorId = analysis.anchorId;
        process.chdir(dir);
        logs = [];
        console.log = (...args: unknown[]): void => void logs.push(args.join(" "));
    });

    afterEach(() => {
        console.log = origLog;
        process.chdir(origCwd);
        rmSync(dir, { recursive: true, force: true });
    });

    test("sessions reports each thread's own turns, and never the runs it launched", () => {
        seedEveryGrain();

        runUsageSessions({});
        const out = output();

        expect(out).toContain('Sessions for "usage"');
        expect(out).toMatch(/thr-a\s+2\s+12\.0k\s+1\.2k/);
        expect(out).toMatch(/thr-b\s+1\s+400\s+40/);
        // The runs' 30.3k belongs under `usage runs`; folding it into a session would double-count the
        // moment both grains are read, and 42.3k is the number that folding would produce.
        expect(out).not.toContain("30.3k");
        expect(out).not.toContain("42.3k");
    });

    test("runs reports each run, including one whose provider reported nothing", () => {
        seedEveryGrain();

        runUsageRuns({});
        const out = output();

        expect(out).toContain('Runs for "usage"');
        expect(out).toMatch(new RegExp(`${RUN_A}\\s+3\\s+30\\.3k\\s+1\\.9k`));
        // One recorded call, no figures: the count is the fact, and the figures stay unknowns.
        expect(out).toMatch(new RegExp(`${RUN_B}\\s+1\\s+not reported\\s+not reported`));
    });

    test("both grains name the calls belonging to neither, so each table accounts for the headline", () => {
        seedEveryGrain();

        runUsageSessions({});
        expect(output()).toMatch(/\(no session or run\)\s+1\s+800\s+80/);

        logs = [];
        runUsageRuns({});
        expect(output()).toMatch(/\(no session or run\)\s+1\s+800\s+80/);
    });

    test("an analysis with nothing at a grain says so, with no zeroed figures and no table", () => {
        record("c1", { threadId: "thr-a", usage: { inputTokens: 100 } });

        runUsageRuns({});
        const out = output();

        expect(out).toContain('No run usage recorded for "usage".');
        expect(out).not.toContain("calls");
        expect(out).not.toContain("0");
    });

    test("steps reports one run's steps and excludes another run's", () => {
        seedEveryGrain();
        record("x1", { runId: RUN_B, stepId: "qc_normalize", usage: { inputTokens: 90_000 } });

        runUsageSteps({ run: RUN_A });
        const out = output();

        expect(out).toContain(`Steps for run ${RUN_A}`);
        expect(out).toMatch(/qc_normalize\s+1\s+24\.0k\s+1\.5k/);
        expect(out).toMatch(/differential_expression\s+1\s+6\.0k\s+400/);
        // A run's calls outside any step are labelled, not blank.
        expect(out).toMatch(/\(no step\)\s+1\s+300\s+30/);
        // The same step slug under the OTHER run must not leak in — step ids are unique per plan only.
        expect(out).not.toContain("90.0k");
    });

    test("steps accepts the id tail every other surface prints, and reports the full id", () => {
        seedEveryGrain();

        runUsageSteps({ run: "bbccdd" });
        const out = output();

        expect(out).toContain(`Steps for run ${RUN_A}`);
        expect(out).toMatch(/qc_normalize\s+1\s+24\.0k/);
    });

    test("a run reference matching nothing reports that, rather than an empty table", () => {
        seedEveryGrain();

        runUsageSteps({ run: "000000" });

        expect(output()).toContain('No usage recorded for run "000000" in "usage".');
    });

    test("reporting at any grain is not a sighting — the anchor's heartbeat is unchanged", () => {
        seedEveryGrain();
        const before = getAnchor(anchorId)._unsafeUnwrap();

        // Every anchor write stamps Date.now(), and the row was created moments ago in this same test,
        // so a real clock read could write back the value the row already holds and hide the heartbeat
        // entirely. Pinning the clock to a value the row cannot carry is what makes a write detectable.
        const now = spyOn(Date, "now").mockReturnValue(2_000_000_000_000);
        try {
            runUsageSessions({});
            runUsageSessions({ analysis: "usage" });
            runUsageRuns({});
            runUsageRuns({ analysis: "usage" });
            runUsageSteps({ run: RUN_A });
            runUsageSteps({ run: RUN_A, analysis: "usage" });
        } finally {
            now.mockRestore();
        }

        // The whole row, not just lastSeen: no grain may have healed cachedPath or bumped updatedAt
        // either — the folder never moved, so the resolver had nothing to repair.
        expect(getAnchor(anchorId)._unsafeUnwrap()).toEqual(before);
    });
});
