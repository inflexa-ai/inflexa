import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// The harness's own value for the profile's synthetic run id — never a literal here, for the same
// reason the query layer imports it rather than spelling it out.
import { DATA_PROFILE_RUN_LITERAL } from "@inflexa-ai/harness/contracts/data-profile.js";
import { Hono } from "hono";
import { ok } from "neverthrow";

import type { UsageView } from "../../api/usage.ts";
import type { ClientOpts } from "../../client/api.ts";
import { usageReport, usageRuns, usageSessions, usageSteps } from "../../client/commands/usage.ts";
import { upsertLlmUsage, type LlmUsageEntry } from "../../db/primary_mutation.ts";
import { freshDb } from "../../test_support/db.ts";
import type { ServerEnv } from "../http.ts";
import { usageRoutes } from "./usage.ts";

// The route alone, mounted at its path with no bearer check and no analysis guard: `app.test.ts` covers
// those. The ledger matches rows by scope id alone, thus no analysis row is necessary. Each `as` cast of a
// body below reads JSON that the route under test builds from the same `src/api/` type.
const ANALYSIS = { id: "ana-1", name: "usage" };
const app = new Hono<ServerEnv>().route("/api/v1/analyses/:analysisId/usage", usageRoutes());

/** The client options of a command that runs in this process against `app`, with no port. */
const opts: ClientOpts = {
    discover: () => ok({ baseUrl: "http://server.test", token: "t" }),
    fetch: (url, init) => Promise.resolve(app.request(url, init)),
};

async function get(query: string): Promise<Response> {
    return app.request(`/api/v1/analyses/${ANALYSIS.id}/usage${query}`);
}

async function view(query: string): Promise<UsageView> {
    const response = await get(query);
    expect(response.status).toBe(200);
    return (await response.json()) as UsageView;
}

// Only the fields a given case cares about; everything else takes a plausible constant. Every token
// quantity stays OPTIONAL here on purpose — a test that always supplies all five could not tell a
// preserved absence from a zero.
function record(key: string, over: Partial<LlmUsageEntry> & { usage: LlmUsageEntry["usage"] }): void {
    upsertLlmUsage({
        recordKey: key,
        recordedAt: 1,
        agentId: "conversation",
        callPath: "conversation",
        scopeKind: "analysis",
        scopeId: ANALYSIS.id,
        ...over,
    })._unsafeUnwrap();
}

const RUN_A = "11111111-2222-3333-4444-5555aabbccdd";
const RUN_B = "99999999-8888-7777-6666-5555ffeeddcc";

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
 * The data profile's calls: the harness's synthetic run id, its own step and agent, and no thread at
 * all. Seeded separately from {@link seedEveryGrain} so the reconciliation figures stay readable, and
 * because most cases here are about what the profile must NOT appear in.
 */
function seedDataProfile(): void {
    record("p1", { agentId: "data-profiler", runId: DATA_PROFILE_RUN_LITERAL, stepId: "profile", usage: { inputTokens: 55_534, outputTokens: 3_195 } });
    record("p2", { agentId: "data-profiler", runId: DATA_PROFILE_RUN_LITERAL, stepId: "profile", usage: { inputTokens: 5_000, outputTokens: 500 } });
}

let logs: string[] = [];
const origLog = console.log;

function output(): string {
    return logs.join("\n");
}

beforeEach(() => {
    freshDb();
    logs = [];
    console.log = (...args: unknown[]): void => void logs.push(args.join(" "));
});

afterEach(() => {
    console.log = origLog;
});

describe("GET {A}/usage", () => {
    test("the analysis scope carries the data profile and the unattributed calls beside its totals", async () => {
        seedEveryGrain();
        seedDataProfile();

        const v = await view("");

        expect(v.scope).toEqual({ kind: "analysis" });
        expect(v.totals.calls).toBe(10);
        expect(v.grains).toEqual({
            dataProfile: { calls: 2, inputTokens: 60_534, outputTokens: 3_695 },
            unattributed: { calls: 1, inputTokens: 800, outputTokens: 80 },
        });
        expect(v.groups).toBeUndefined();
    });

    test("a conversation folds in the runs it launched, and nothing of another thread, the profile, or the background", async () => {
        // The real ledger's proportions: the conversation's own turns are a rounding error beside the
        // run it started, which is why the sidebar reports the inclusive reading rather than the grain.
        record("turn", { threadId: "thr-a", servedModelId: "claude-opus-4-8", usage: { inputTokens: 11_100, outputTokens: 2_900 } });
        record("run", {
            threadId: "thr-a",
            runId: RUN_A,
            agentId: "step-executor",
            servedModelId: "claude-sonnet-4-5",
            usage: { inputTokens: 809_200, outputTokens: 40_400 },
        });
        record("theirs", { threadId: "thr-b", usage: { inputTokens: 5_000 } });
        record("profile", { runId: DATA_PROFILE_RUN_LITERAL, usage: { inputTokens: 55_500 } });
        record("loose", { usage: { inputTokens: 7 } });

        const byModel = await view("?threadId=thr-a&by=model");
        const byAgent = await view("?threadId=thr-a&by=agent");

        expect(byModel.scope).toEqual({ kind: "thread", threadId: "thr-a" });
        expect(byModel.totals).toEqual({ calls: 2, inputTokens: 820_300, outputTokens: 43_300 });
        expect(byModel.grains).toBeUndefined();
        expect(byModel.groups?.map((g) => g.key).sort()).toEqual(["claude-opus-4-8", "claude-sonnet-4-5"]);
        expect(byAgent.groups?.map((g) => g.key).sort()).toEqual(["conversation", "step-executor"]);
    });

    test("a quantity that no call reported stays absent, and a conversation with no rows is zero calls", async () => {
        record("silent", { threadId: "thr-a", usage: { inputTokens: 10 } });

        expect((await view("?threadId=thr-a")).totals).toEqual({ calls: 1, inputTokens: 10 });
        expect((await view("?threadId=never-seen")).totals).toEqual({ calls: 0 });
    });

    test("a run matches by its full id or by a trailing part, and names its full id", async () => {
        seedEveryGrain();

        for (const ref of [RUN_A, "bbccdd", "5555aabbccdd"]) {
            const v = await view(`?runId=${ref}&by=step`);
            expect(v.scope).toEqual({ kind: "run", runId: RUN_A });
            expect(v.totals).toEqual({ calls: 3, inputTokens: 30_300, outputTokens: 1_930 });
            expect(v.groups?.map((g) => g.key)).toEqual(["qc_normalize", "differential_expression", null]);
        }
    });

    test("a run part that names two runs is 409 `conflict` with each full id", async () => {
        seedEveryGrain();
        const twin = "22222222-3333-4444-5555-6666aabbccdd";
        record("t1", { runId: twin, usage: { inputTokens: 1 } });

        const response = await get("?runId=aabbccdd&by=step");

        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ error: "conflict", details: { candidates: [RUN_A, twin] } });
    });

    test("a run with no recorded usage, and the profile's run id, are 404 `not_found`", async () => {
        seedEveryGrain();
        seedDataProfile();

        for (const ref of ["000000", DATA_PROFILE_RUN_LITERAL]) {
            const response = await get(`?runId=${ref}&by=step`);
            expect(response.status).toBe(404);
            expect(await response.json()).toMatchObject({ error: "not_found" });
        }
    });

    test("a grouping that the scope has no read for, or both scopes at once, is 400 `validation_error`", async () => {
        for (const query of ["?by=step", "?by=nothing", "?threadId=t&by=run", "?runId=r&by=model", "?threadId=t&runId=r"]) {
            const response = await get(query);
            expect(response.status).toBe(400);
            expect(await response.json()).toMatchObject({ error: "validation_error" });
        }
    });
});

describe("usage command action", () => {
    test("reports the analysis's figures with a per-model and a per-agent breakdown", async () => {
        record("k1", { agentId: "conversation", servedModelId: "opus-4", usage: { inputTokens: 10_000, outputTokens: 2_000 } });
        record("k2", { agentId: "conversation", servedModelId: "opus-4", usage: { inputTokens: 2_000, outputTokens: 1_000 } });
        record("k3", { agentId: "planner", servedModelId: "haiku-4", usage: { inputTokens: 400, outputTokens: 100 } });

        await usageReport(ANALYSIS, opts);
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

    test("another analysis's spend cannot leak in: the ledger attributes by scope id alone", async () => {
        record("k1", { usage: { inputTokens: 999 } });
        upsertLlmUsage({
            recordKey: "k2",
            recordedAt: 1,
            agentId: "conversation",
            callPath: "conversation",
            scopeKind: "analysis",
            scopeId: "other",
            usage: { inputTokens: 111 },
        })._unsafeUnwrap();

        await usageReport({ id: "other", name: "other" }, opts);
        const out = output();

        expect(out).toContain('Usage for "other"');
        expect(out).toContain("111");
        expect(out).not.toContain("999");
    });

    test("an analysis with no recorded usage says so, with no zeroed figures and no table", async () => {
        await usageReport(ANALYSIS, opts);
        const out = output();

        expect(out).toContain('No usage recorded for "usage".');
        expect(out).not.toContain("input");
        expect(out).not.toContain("By served model");
        expect(out).not.toContain("0");
    });

    test("calls whose provider reported nothing are a report, distinct from no calls at all", async () => {
        record("k1", { usage: {} });
        record("k2", { usage: {} });

        await usageReport(ANALYSIS, opts);
        const out = output();

        // Two recorded calls that measured nothing: the count is the fact, the figures are unknowns.
        expect(out).toContain("2 calls");
        expect(out).not.toContain("No usage recorded");
        expect(out).toMatch(/input\s+not reported/);
        expect(out).toMatch(/output\s+not reported/);
    });

    test("an unreported quantity prints as unknown while a reported zero prints as zero", async () => {
        record("k1", { usage: { inputTokens: 500, outputTokens: 0 } });

        await usageReport(ANALYSIS, opts);
        const out = output();

        // outputTokens: 0 is a measurement the provider made; the absent cache/reasoning counts are not.
        expect(out).toMatch(/output\s+0/);
        expect(out).not.toContain("cache read");
        expect(out).not.toContain("reasoning");
    });

    test("cache and reasoning counts render as breakdowns and are never folded into the two figures", async () => {
        record("k1", {
            usage: { inputTokens: 10_000, outputTokens: 2_000, cacheCreationInputTokens: 1_000, cacheReadInputTokens: 8_000, reasoningTokens: 900 },
        });

        await usageReport(ANALYSIS, opts);
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

    test("calls whose endpoint reported no served model group under a labelled absence", async () => {
        record("k1", { usage: { inputTokens: 100 } });

        await usageReport(ANALYSIS, opts);

        expect(output()).toContain("(not reported)");
    });
});

describe("usage grain subcommand actions", () => {
    test("sessions reports each thread's own turns, and never the runs it launched", async () => {
        seedEveryGrain();

        await usageSessions(ANALYSIS, opts);
        const out = output();

        expect(out).toContain('Sessions for "usage"');
        expect(out).toMatch(/thr-a\s+2\s+12\.0k\s+1\.2k/);
        expect(out).toMatch(/thr-b\s+1\s+400\s+40/);
        // The runs' 30.3k belongs under `usage runs`; folding it into a session would double-count the
        // moment both grains are read, and 42.3k is the number that folding would produce.
        expect(out).not.toContain("30.3k");
        expect(out).not.toContain("42.3k");
    });

    test("runs reports each run, including one whose provider reported nothing", async () => {
        seedEveryGrain();

        await usageRuns(ANALYSIS, opts);
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
    test("the unattributed figures appear exactly once across the reports a user would sum", async () => {
        seedEveryGrain();

        await usageReport(ANALYSIS, opts);
        const report = output();
        logs = [];
        await usageSessions(ANALYSIS, opts);
        const sessions = output();
        logs = [];
        await usageRuns(ANALYSIS, opts);
        const runs = output();

        const printed = [report, sessions, runs].join("\n");
        expect(printed.match(/\(no session or run\)/g)).toHaveLength(1);
        expect(printed.match(/\b800\b/g)).toHaveLength(1);
        expect(report).toMatch(/\(no session or run\)\s+1\s+800\s+80/);
        // Summing what the three reports DO print reaches the headline the analysis report leads with:
        // 12.4k across sessions + 30.3k across runs + 800 unattributed = 43.5k.
        expect(report).toMatch(/input\s+43\.5k/);
    });

    test("each grain table holds only its own grain, and signposts the bucket it does not carry", async () => {
        seedEveryGrain();

        await usageSessions(ANALYSIS, opts);
        const sessions = output();
        expect(sessions).toMatch(/thr-a\s+2\s+12\.0k\s+1\.2k/);
        expect(sessions).not.toContain("(no session or run)");
        // The signpost names the bucket and where it is reported, and carries no figure of its own —
        // not even the call count — so there is nothing in a grain report left to add up twice.
        expect(sessions).toContain("Calls belonging to no session or run are reported by `inflexa usage`.");
        expect(sessions).not.toContain("800");

        logs = [];
        await usageRuns(ANALYSIS, opts);
        const runs = output();
        expect(runs).toMatch(new RegExp(`${RUN_A}\\s+3\\s+30\\.3k\\s+1\\.9k`));
        expect(runs).not.toContain("(no session or run)");
        expect(runs).toContain("Calls belonging to no session or run are reported by `inflexa usage`.");
        expect(runs).not.toContain("800");
    });

    test("an analysis whose only calls carry neither frame still says where they are reported", async () => {
        record("b1", { usage: { inputTokens: 800, outputTokens: 80 } });

        await usageSessions(ANALYSIS, opts);
        const sessions = output();

        // The emptied grain is exactly when the signpost matters most: without it the analysis holds
        // consumption the reader can see in the headline and nowhere in the report they are looking at.
        expect(sessions).toContain('No session usage recorded for "usage".');
        expect(sessions).toContain("`inflexa usage`");
        expect(sessions).not.toContain("800");

        logs = [];
        await usageReport(ANALYSIS, opts);
        expect(output()).toMatch(/\(no session or run\)\s+1\s+800\s+80/);
    });

    test("an analysis with nothing at a grain says so, with no zeroed figures and no table", async () => {
        record("c1", { threadId: "thr-a", usage: { inputTokens: 100 } });

        await usageRuns(ANALYSIS, opts);
        const out = output();

        expect(out).toContain('No run usage recorded for "usage".');
        expect(out).not.toContain("calls");
        expect(out).not.toContain("0");
        // Nothing runs outside a frame here, so the signpost would point at an empty bucket — noise.
        expect(out).not.toContain("inflexa usage");
    });

    test("steps reports one run's steps and excludes another run's", async () => {
        seedEveryGrain();
        record("x1", { runId: RUN_B, stepId: "qc_normalize", usage: { inputTokens: 90_000 } });

        await usageSteps(ANALYSIS, RUN_A, opts);
        const out = output();

        expect(out).toContain(`Steps for run ${RUN_A}`);
        expect(out).toMatch(/qc_normalize\s+1\s+24\.0k\s+1\.5k/);
        expect(out).toMatch(/differential_expression\s+1\s+6\.0k\s+400/);
        // A run's calls outside any step are labelled, not blank.
        expect(out).toMatch(/\(no step\)\s+1\s+300\s+30/);
        // The same step slug under the OTHER run must not leak in — step ids are unique per plan only.
        expect(out).not.toContain("90.0k");
    });

    test("steps accepts the id tail every other surface prints, and reports the full id", async () => {
        seedEveryGrain();

        await usageSteps(ANALYSIS, "bbccdd", opts);
        const out = output();

        expect(out).toContain(`Steps for run ${RUN_A}`);
        expect(out).toMatch(/qc_normalize\s+1\s+24\.0k/);
    });

    test("a run reference matching nothing reports that, rather than an empty table", async () => {
        seedEveryGrain();

        await usageSteps(ANALYSIS, "000000", opts);

        expect(output()).toContain('No usage recorded for run "000000" in "usage".');
    });

    test("the data profile is reported as its own grain, never as a run", async () => {
        seedEveryGrain();
        seedDataProfile();

        await usageReport(ANALYSIS, opts);
        const report = output();

        // Its own section with its own call count, and the two figures nested the way the headline is
        // — the profile runs at most once per analysis, so there is nothing to enumerate in a table.
        expect(report).toContain("Data profile — 2 calls");
        expect(report).toMatch(/input\s+60\.5k/);
        expect(report).toMatch(/output\s+3\.7k/);

        logs = [];
        await usageRuns(ANALYSIS, opts);
        const runs = output();

        // The row a reader could not cross-reference against any run listing is gone from the runs
        // table — id and figures both.
        expect(runs).not.toContain(DATA_PROFILE_RUN_LITERAL);
        expect(runs).not.toContain("60.5k");
        expect(runs).toMatch(new RegExp(`${RUN_A}\\s+3\\s+30\\.3k\\s+1\\.9k`));
    });

    test("the grains signpost the data profile they cannot hold", async () => {
        seedEveryGrain();
        seedDataProfile();

        await usageRuns(ANALYSIS, opts);
        const runs = output();
        logs = [];
        await usageSessions(ANALYSIS, opts);
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

    test("an analysis that never profiled says nothing about a data profile", async () => {
        seedEveryGrain();

        await usageReport(ANALYSIS, opts);
        expect(output()).not.toContain("Data profile");

        logs = [];
        await usageRuns(ANALYSIS, opts);
        // A signpost to a bucket holding no calls is noise, exactly as for the unattributed one.
        expect(output()).not.toContain("The data profile's calls");
    });

    test("the printed grains still reach the headline with the profile partitioned out", async () => {
        seedEveryGrain();
        seedDataProfile();

        await usageReport(ANALYSIS, opts);

        // 12.4k sessions + 30.3k runs + 60.5k data profile + 800 unattributed = 104.0k. The profile
        // leaving the run grouping is exactly when a grain can go missing from the sum while still
        // counting toward the headline, so the arithmetic is pinned on the printed report.
        expect(output()).toMatch(/input\s+104\.0k/);
    });

    test("the profile's run id names no run at the step grain", async () => {
        seedEveryGrain();
        seedDataProfile();

        await usageSteps(ANALYSIS, DATA_PROFILE_RUN_LITERAL, opts);

        // `usage steps` resolves against the analysis's RUNS, and the profile is not one — so it reads
        // as an unknown run rather than quietly rendering a profile's steps under a run heading.
        expect(output()).toContain(`No usage recorded for run "${DATA_PROFILE_RUN_LITERAL}"`);
    });
});
