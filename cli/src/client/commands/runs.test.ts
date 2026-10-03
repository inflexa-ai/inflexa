import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { ok } from "neverthrow";

import type { DataProfileView, ProfileRerunResult, RunDetail, RunList, RunSummary } from "../../api/runs.ts";
import type { ClientOpts } from "../api.ts";
import { profileRun, profileStatus, runStatus } from "./runs.ts";

// The moved dev commands, driven in this process against a fake server: each request answers from a table
// keyed by the method and the path. A refusal of these commands exits the process through `fail()`, thus
// only the paths that end without an exit are driven here.

const ANALYSIS = { id: "a1", name: "liver" } as const;

/** Client options whose server answers each `METHOD /path` from `routes`, in order for a list of answers. */
function serverOf(routes: Record<string, unknown | unknown[]>): { opts: ClientOpts; requests: string[] } {
    const requests: string[] = [];
    const served = new Map<string, number>();
    const opts: ClientOpts = {
        discover: () => ok({ baseUrl: "http://server.test", token: "t" }),
        fetch: (url, init) => {
            const { pathname, search } = new URL(url);
            const key = `${init.method ?? "GET"} ${pathname}`;
            requests.push(`${key}${search}`);
            const answer = routes[key];
            if (answer === undefined) return Promise.resolve(new Response(JSON.stringify({ error: "not_found", message: key }), { status: 404 }));
            const index = served.get(key) ?? 0;
            served.set(key, index + 1);
            const body = Array.isArray(answer) ? answer[Math.min(index, answer.length - 1)] : answer;
            return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
        },
    };
    return { opts, requests };
}

function run(overrides: Partial<RunSummary> & Pick<RunSummary, "runId">): RunSummary {
    return {
        threadId: null,
        workflowName: "executeAnalysis",
        workflowId: overrides.runId,
        status: "completed",
        startedAt: "2026-10-01T10:00:00.000Z",
        completedAt: "2026-10-01T10:05:00.000Z",
        error: null,
        ...overrides,
    };
}

let logged: Mock<typeof console.log>;

beforeEach(() => {
    logged = spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
    logged.mockRestore();
});

function printed(): string {
    return logged.mock.calls.map((call) => call.join(" ")).join("\n");
}

describe("inflexa profile --status", () => {
    test("an analysis that was never profiled says so", async () => {
        const never: DataProfileView = { status: null };
        const { opts } = serverOf({ "GET /api/v1/analyses/a1/data-profile": never });
        await profileStatus(ANALYSIS, opts);
        expect(printed()).toContain('"liver" has never been profiled. Run `inflexa profile` to start.');
    });

    test("a profile row prints its status, its times, and its error", async () => {
        const failed: DataProfileView = {
            status: "failed",
            error: "no readable files",
            startedAt: "2026-10-01T10:00:00.000Z",
            completedAt: "2026-10-01T10:01:00.000Z",
            result: null,
            workflowId: "wf",
            seedInputFileIds: ["f1"],
        };
        const { opts } = serverOf({ "GET /api/v1/analyses/a1/data-profile": failed });
        await profileStatus(ANALYSIS, opts);
        const text = printed();
        expect(text).toContain('Profile status for "liver" (a1):');
        expect(text).toContain("status:     failed");
        expect(text).toContain("started:    2026-10-01T10:00:00.000Z");
        expect(text).toContain("completed:  2026-10-01T10:01:00.000Z");
        expect(text).toContain("error:      no readable files");
    });
});

describe("inflexa run --status", () => {
    test("each run prints with its plan title and its steps", async () => {
        const runs: RunList = {
            runs: [
                run({ runId: "r1", status: "running", completedAt: null, planTitle: "Liver DE" }),
                run({ runId: "r2", status: "failed", error: "step_failed" }),
            ],
            total: 2,
            page: 0,
            perPage: 50,
            hasMore: false,
        };
        const detail: RunDetail = {
            ...runs.runs[0]!,
            steps: [
                {
                    stepId: "T1S1",
                    agentId: "bio",
                    status: "completed",
                    startedAt: null,
                    completedAt: null,
                    durationMs: 61_000,
                    error: null,
                    attempts: 1,
                    blockedReason: null,
                },
            ],
            unattributedUsage: null,
        };
        const { opts, requests } = serverOf({
            "GET /api/v1/analyses/a1/runs": runs,
            "GET /api/v1/analyses/a1/run/r1": detail,
            // `r2` has no detail answer: its read fails, and the run still prints, with no steps.
        });
        await runStatus(ANALYSIS, opts);

        expect(requests[0]).toBe("GET /api/v1/analyses/a1/runs?perPage=50");
        const text = printed();
        expect(text).toContain('Runs for "liver" (a1):');
        expect(text).toContain("r1  [running]");
        expect(text).toContain("plan:       Liver DE");
        expect(text).toContain("- T1S1  completed  [bio] (61s)");
        expect(text).toContain("r2  [failed]");
        expect(text).toContain("plan:       —");
        expect(text).toContain("error:      step_failed");
    });

    test("an analysis with no runs says how to launch one", async () => {
        const { opts } = serverOf({ "GET /api/v1/analyses/a1/runs": { runs: [], total: 0, page: 0, perPage: 50, hasMore: false } satisfies RunList });
        await runStatus(ANALYSIS, opts);
        expect(printed()).toContain('"liver" has no runs yet. Launch one with `inflexa run --plan <file>`.');
    });
});

describe("inflexa profile", () => {
    const profile = (status: "pending" | "running" | "completed"): DataProfileView => ({
        status,
        error: null,
        startedAt: status === "pending" ? null : "2026-10-01T10:00:00.000Z",
        completedAt: status === "completed" ? "2026-10-01T10:02:00.000Z" : null,
        result: null,
        workflowId: status === "pending" ? null : "wf",
        seedInputFileIds: ["f1", "f2"],
    });

    test("asks the server for the re-profile, then reads the profile until it completes", async () => {
        const rerun: ProfileRerunResult = { outcome: { kind: "triggered", restarted: true, materialized: true } };
        const { opts, requests } = serverOf({
            "POST /api/v1/analyses/a1/data-profile/rerun": rerun,
            "GET /api/v1/analyses/a1/data-profile": [profile("pending"), profile("running"), profile("completed")],
        });
        await profileRun(ANALYSIS, { client: opts, pollMs: 1 });

        expect(requests).toEqual([
            "POST /api/v1/analyses/a1/data-profile/rerun",
            "GET /api/v1/analyses/a1/data-profile",
            "GET /api/v1/analyses/a1/data-profile",
            "GET /api/v1/analyses/a1/data-profile",
        ]);
    });
});
