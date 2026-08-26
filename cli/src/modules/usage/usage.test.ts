import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The harness's own value for the profile's synthetic run id — never a literal here, for the same
// reason the query layer imports it rather than spelling it out.
import { DATA_PROFILE_RUN_LITERAL } from "@inflexa-ai/harness/contracts/data-profile.js";

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

    beforeEach(async () => {
        freshDb();
        origCwd = process.cwd();
        dir = realpathSync(mkdtempSync(join(tmpdir(), "inflexa-usage-")));
        const analysis = (await createAnalysis({ cwd: dir, name: str256("usage")._unsafeUnwrap() }))._unsafeUnwrap();
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

    test("resolves the analysis named by --analysis rather than the working context", async () => {
        const other = (await createAnalysis({ cwd: dir, name: str256("other")._unsafeUnwrap() }))._unsafeUnwrap();
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

    /**
     * The data profile's calls: the harness's synthetic run id, its own step and agent, and no thread
     * at all. Seeded separately from {@link seedEveryGrain} so the existing reconciliation figures
     * stay readable, and because most cases here are about what the profile must NOT appear in.
     */
    function seedDataProfile(): void {
        record("p1", { agentId: "data-profiler", runId: DATA_PROFILE_RUN_LITERAL, stepId: "profile", usage: { inputTokens: 55_534, outputTokens: 3_195 } });
        record("p2", { agentId: "data-profiler", runId: DATA_PROFILE_RUN_LITERAL, stepId: "profile", usage: { inputTokens: 5_000, outputTokens: 500 } });
    }

    function output(): string {
        return logs.join("\n");
    }

    beforeEach(async () => {
        freshDb();
        origCwd = process.cwd();
        dir = realpathSync(mkdtempSync(join(tmpdir(), "inflexa-usage-grain-")));
        const analysis = (await createAnalysis({ cwd: dir, name: str256("usage")._unsafeUnwrap() }))._unsafeUnwrap();
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

    // The double-count guard, pinned as a COUNT across the three reports rather than as a per-report
    // assertion: the invariant is not "the analysis report shows it", it is "exactly one report a
    // reader would add up shows it". A future surface that puts the row back into a grain fails here
    // rather than in a user's arithmetic, where nothing on screen could reveal it.
    test("the unattributed figures appear exactly once across the reports a user would sum", () => {
        seedEveryGrain();

        runUsage({});
        const report = output();
        logs = [];
        runUsageSessions({});
        const sessions = output();
        logs = [];
        runUsageRuns({});
        const runs = output();

        const printed = [report, sessions, runs].join("\n");
        expect(printed.match(/\(no session or run\)/g)).toHaveLength(1);
        expect(printed.match(/\b800\b/g)).toHaveLength(1);
        expect(report).toMatch(/\(no session or run\)\s+1\s+800\s+80/);
        // Summing what the three reports DO print reaches the headline the analysis report leads with:
        // 12.4k across sessions + 30.3k across runs + 800 unattributed = 43.5k.
        expect(report).toMatch(/input\s+43\.5k/);
    });

    test("each grain table holds only its own grain, and signposts the bucket it does not carry", () => {
        seedEveryGrain();

        runUsageSessions({});
        const sessions = output();
        expect(sessions).toMatch(/thr-a\s+2\s+12\.0k\s+1\.2k/);
        expect(sessions).not.toContain("(no session or run)");
        // The signpost names the bucket and where it is reported, and carries no figure of its own —
        // not even the call count — so there is nothing in a grain report left to add up twice.
        expect(sessions).toContain("Calls belonging to no session or run are reported by `inflexa usage`.");
        expect(sessions).not.toContain("800");

        logs = [];
        runUsageRuns({});
        const runs = output();
        expect(runs).toMatch(new RegExp(`${RUN_A}\\s+3\\s+30\\.3k\\s+1\\.9k`));
        expect(runs).not.toContain("(no session or run)");
        expect(runs).toContain("Calls belonging to no session or run are reported by `inflexa usage`.");
        expect(runs).not.toContain("800");
    });

    test("an analysis whose only calls carry neither frame still says where they are reported", () => {
        record("b1", { usage: { inputTokens: 800, outputTokens: 80 } });

        runUsageSessions({});
        const sessions = output();

        // The emptied grain is exactly when the signpost matters most: without it the analysis holds
        // consumption the reader can see in the headline and nowhere in the report they are looking at.
        expect(sessions).toContain('No session usage recorded for "usage".');
        expect(sessions).toContain("`inflexa usage`");
        expect(sessions).not.toContain("800");

        logs = [];
        runUsage({});
        expect(output()).toMatch(/\(no session or run\)\s+1\s+800\s+80/);
    });

    test("an analysis with nothing at a grain says so, with no zeroed figures and no table", () => {
        record("c1", { threadId: "thr-a", usage: { inputTokens: 100 } });

        runUsageRuns({});
        const out = output();

        expect(out).toContain('No run usage recorded for "usage".');
        expect(out).not.toContain("calls");
        expect(out).not.toContain("0");
        // Nothing runs outside a frame here, so the signpost would point at an empty bucket — noise.
        expect(out).not.toContain("inflexa usage");
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

    test("the data profile is reported as its own grain, never as a run", () => {
        seedEveryGrain();
        seedDataProfile();

        runUsage({});
        const report = output();

        // Its own section with its own call count, and the two figures nested the way the headline is
        // — the profile runs at most once per analysis, so there is nothing to enumerate in a table.
        expect(report).toContain("Data profile — 2 calls");
        expect(report).toMatch(/input\s+60\.5k/);
        expect(report).toMatch(/output\s+3\.7k/);

        logs = [];
        runUsageRuns({});
        const runs = output();

        // The row a reader could not cross-reference against any run listing is gone from the runs
        // table — id and figures both.
        expect(runs).not.toContain(DATA_PROFILE_RUN_LITERAL);
        expect(runs).not.toContain("60.5k");
        expect(runs).toMatch(new RegExp(`${RUN_A}\\s+3\\s+30\\.3k\\s+1\\.9k`));
    });

    test("the grains signpost the data profile they cannot hold", () => {
        seedEveryGrain();
        seedDataProfile();

        runUsageRuns({});
        const runs = output();
        logs = [];
        runUsageSessions({});
        const sessions = output();

        // A reader who used to see the profile among the runs needs to be told it moved rather than
        // left; a session report needs it because the profile stamps no thread and never could appear.
        for (const report of [runs, sessions]) {
            expect(report).toContain("The data profile's calls are reported by `inflexa usage`.");
            expect(report).toContain("Calls belonging to no session or run are reported by `inflexa usage`.");
            // Figure-free, like every signpost here: nothing a reader could add into the grain's column.
            expect(report).not.toContain("60.5k");
        }
    });

    test("an analysis that never profiled says nothing about a data profile", () => {
        seedEveryGrain();

        runUsage({});
        expect(output()).not.toContain("Data profile");

        logs = [];
        runUsageRuns({});
        // A signpost to a bucket holding no calls is noise, exactly as for the unattributed one.
        expect(output()).not.toContain("The data profile's calls");
    });

    test("the printed grains still reach the headline with the profile partitioned out", () => {
        seedEveryGrain();
        seedDataProfile();

        runUsage({});

        // 12.4k sessions + 30.3k runs + 60.5k data profile + 800 unattributed = 104.0k. The profile
        // leaving the run grouping is exactly when a grain can go missing from the sum while still
        // counting toward the headline, so the arithmetic is pinned on the printed report.
        expect(output()).toMatch(/input\s+104\.0k/);
    });

    test("the profile's run id names no run at the step grain", () => {
        seedEveryGrain();
        seedDataProfile();

        runUsageSteps({ run: DATA_PROFILE_RUN_LITERAL });

        // `usage steps` resolves against the analysis's RUNS, and the profile is not one — so it reads
        // as an unknown run rather than quietly rendering a profile's steps under a run heading.
        expect(output()).toContain(`No usage recorded for run "${DATA_PROFILE_RUN_LITERAL}"`);
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
