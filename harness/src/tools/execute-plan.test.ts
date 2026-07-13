/**
 * executePlan tool — unit-level coverage for the validation gate and the
 * dedup recovery contract. The Postgres-testcontainer end-to-end coverage
 * (task 3.5) is exercised once the full executeAnalysis dep bundle is wired
 * at boot; here we drive the tool with a fake `Pool` and a fake registered
 * workflow function to keep the assertion surface focused.
 */

import { describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import type { RequestSession, RunSession } from "../auth/types.js";
import { makeLocalAuth } from "../auth/local-auth-context.js";
import type { RunAuthorization, RunAuthorizer } from "../execution/run-authorizer.js";
import type { RunLauncher } from "../execution/run-launcher.js";
import type { ToolContext } from "./define-tool.js";
import { PlanNotFoundError, PlanValidationError, createExecutePlanTool } from "./execute-plan.js";

/** Records launches; never reaches the durability engine. */
function fakeLauncher(opts: { failLaunch?: boolean } = {}): {
    launcher: RunLauncher;
    launches: Array<{ workflowId: string }>;
} {
    const launches: Array<{ workflowId: string }> = [];
    const launcher: RunLauncher = {
        launch: async (_workflow, o) => {
            if (opts.failLaunch) throw new Error("launch boom");
            launches.push({ workflowId: o.workflowId });
        },
        launchAndAwait: async () => {
            throw new Error("launchAndAwait not used by execute_plan");
        },
    };
    return { launcher, launches };
}

/** Authorizer that succeeds and records revoke reasons. */
function recordingAuthorizer(): {
    authorizer: RunAuthorizer;
    revokes: string[];
} {
    const revokes: string[] = [];
    const authorizer: RunAuthorizer = {
        authorize: async (): Promise<RunAuthorization> => ({
            runSession: {} as RunSession,
            ownsMandate: true,
        }),
        revoke: async (_authorization, reason) => {
            revokes.push(reason);
        },
    };
    return { authorizer, revokes };
}

/** None of these unit tests reach authorization — the validation/dedup paths
 * all return or throw first, so a throw-on-call authorizer is the assertion. */
const throwingAuthorizer: RunAuthorizer = {
    authorize: () => {
        throw new Error("authorize should not be reached in this test");
    },
    revoke: async () => {},
};

const ANALYSIS_ID = "analysis-test-1";
const PLAN_ID = "pln-deadbeef";

type Row = Record<string, unknown>;

function fakePool(rowsByPrefix: Record<string, Row[]>): {
    pool: Pool;
    queries: Array<{ text: string; values: unknown[] }>;
} {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const query = (q: { text: string; values?: unknown[] }) => {
        queries.push({ text: q.text, values: q.values ?? [] });
        for (const prefix of Object.keys(rowsByPrefix)) {
            if (q.text.includes(prefix)) {
                return Promise.resolve({ rows: rowsByPrefix[prefix]! });
            }
        }
        return Promise.resolve({ rows: [] });
    };
    return { pool: { query } as unknown as Pool, queries };
}

function fakeContext(): ToolContext {
    const session: RequestSession = {
        identity: { user: "user-1" },
        scope: { kind: "analysis", analysisId: ANALYSIS_ID, threadId: "thread-1" },
        provenance: { agentId: "conversation-agent", callPath: [] },
        auth: makeLocalAuth(),
    };
    return {
        session,
        signal: new AbortController().signal,
        emit: async () => {},
        runStep: (_name, fn) => fn(),
    };
}

function setEnv(): void {
    process.env.DB_PG_HOST = "localhost";
    process.env.DB_PG_NAME = "cortex";
    process.env.DB_PG_USER = "cortex";
    process.env.DB_PG_PASSWORD = "dev";
    process.env.ARTIFACT_STORE_API_URL = "http://artifact-store.test";
    process.env.DEV_SERVICE_IDENTITY = "test-svc";
}

function makeStep(id: string, deps: string[] = []) {
    return {
        id,
        name: `Step ${id}`,
        track: "test",
        step_type: "analysis",
        question: `do ${id}`,
        acceptance_criteria: ["completes"],
        depends_on: deps,
        agent: "bulk-transcriptomics-agent",
        resources: { cpu: 1, memoryGb: 4 },
        maxSteps: 30,
    };
}

const validPlan = {
    analytical_narrative: "test plan",
    steps: [makeStep("step-a")],
    created_at: "2026-01-01T00:00:00Z",
};

describe("createExecutePlanTool", () => {
    it("throws PlanNotFoundError when no row matches the (analysis, plan) tuple", async () => {
        const { pool } = fakePool({
            "SELECT plan FROM cortex_plans": [],
        });
        const tool = createExecutePlanTool({
            pool,
            runLauncher: fakeLauncher().launcher,
            runAuthorizer: throwingAuthorizer,
            executeAnalysisWorkflow: async () => {
                throw new Error("should not be called");
            },
        });
        await expect(tool.execute({ planId: PLAN_ID }, fakeContext())).rejects.toBeInstanceOf(PlanNotFoundError);
    });

    it("throws PlanValidationError without dispatching the workflow when the DAG has a cycle", async () => {
        const cyclic = {
            ...validPlan,
            steps: [makeStep("a", ["b"]), makeStep("b", ["a"])],
        };
        const { pool } = fakePool({
            "SELECT plan FROM cortex_plans": [{ plan: cyclic }],
        });
        let dispatched = false;
        const tool = createExecutePlanTool({
            pool,
            runLauncher: fakeLauncher().launcher,
            runAuthorizer: throwingAuthorizer,
            executeAnalysisWorkflow: async () => {
                dispatched = true;
                return {
                    runId: "x",
                    workflowId: "x",
                    status: "completed",
                    completedSteps: [],
                    failedSteps: [],
                    canceledSteps: [],
                };
            },
        });
        await expect(tool.execute({ planId: PLAN_ID }, fakeContext())).rejects.toBeInstanceOf(PlanValidationError);
        expect(dispatched).toBe(false);
    });

    it("dedup pre-check returns the existing runId without minting", async () => {
        setEnv();
        const { pool, queries } = fakePool({
            "SELECT plan FROM cortex_plans": [{ plan: validPlan }],
            "FROM cortex_runs": [
                {
                    run_id: "r-existing",
                    analysis_id: ANALYSIS_ID,
                    plan_id: PLAN_ID,
                    workflow_name: "executeAnalysis",
                    status: "running",
                    started_at: "2026-05-01T00:00:00Z",
                    completed_at: null,
                    error: null,
                    parts: null,
                    mandate_jti: "jti-existing",
                    mandate_expires_at: "2099-01-01T00:00:00Z",
                },
            ],
        });
        let mintCalls = 0;
        globalThis.fetch = (async () => {
            mintCalls++;
            return new Response("{}", {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        }) as unknown as typeof fetch;

        let dispatched = false;
        const tool = createExecutePlanTool({
            pool,
            runLauncher: fakeLauncher().launcher,
            runAuthorizer: throwingAuthorizer,
            executeAnalysisWorkflow: async () => {
                dispatched = true;
                return {
                    runId: "x",
                    workflowId: "x",
                    status: "completed",
                    completedSteps: [],
                    failedSteps: [],
                    canceledSteps: [],
                };
            },
        });
        const result = (await tool.execute({ planId: PLAN_ID }, fakeContext()))._unsafeUnwrap();
        expect((result as { runId: string }).runId).toBe("r-existing");
        expect(mintCalls).toBe(0);
        expect(dispatched).toBe(false);
        // The dedup pre-check is the only query that touched cortex_runs.
        expect(queries.some((q) => q.text.includes("FROM cortex_runs"))).toBe(true);
    });

    it("marks the reserved run failed and rethrows when authorization fails", async () => {
        setEnv();
        // No "FROM cortex_runs" key → dedup pre-check misses; the INSERT reserves
        // the slot; then authorization throws.
        const { pool, queries } = fakePool({
            "SELECT plan FROM cortex_plans": [{ plan: validPlan }],
        });
        const failingAuthorizer: RunAuthorizer = {
            authorize: async () => {
                throw new Error("mint exploded");
            },
            revoke: async () => {},
        };
        const tool = createExecutePlanTool({
            pool,
            runLauncher: fakeLauncher().launcher,
            runAuthorizer: failingAuthorizer,
            executeAnalysisWorkflow: async () => {
                throw new Error("workflow must not start after a failed authorization");
            },
        });

        await expect(tool.execute({ planId: PLAN_ID }, fakeContext())).rejects.toThrow(/mint exploded/);

        // The reserved row is released — marked failed — so the partial-unique
        // slot frees up and a retry can re-run.
        expect(queries.some((q) => q.text.includes("SET status") && q.values.includes("failed"))).toBe(true);
    });

    it("launches the run through the RunLauncher and returns the reserved runId", async () => {
        setEnv();
        const { pool } = fakePool({
            "SELECT plan FROM cortex_plans": [{ plan: validPlan }],
        });
        const { authorizer, revokes } = recordingAuthorizer();
        const { launcher, launches } = fakeLauncher();
        const tool = createExecutePlanTool({
            pool,
            runLauncher: launcher,
            runAuthorizer: authorizer,
            executeAnalysisWorkflow: async () => {
                throw new Error("the tool launches via the seam, never calls directly");
            },
        });

        const result = (await tool.execute({ planId: PLAN_ID }, fakeContext()))._unsafeUnwrap() as { runId: string };

        expect(launches).toHaveLength(1);
        expect(launches[0]!.workflowId).toBe(result.runId);
        expect(revokes).toHaveLength(0);
    });

    it("revokes authorization and marks the run failed when the launch fails", async () => {
        setEnv();
        const { pool, queries } = fakePool({
            "SELECT plan FROM cortex_plans": [{ plan: validPlan }],
        });
        const { authorizer, revokes } = recordingAuthorizer();
        const { launcher } = fakeLauncher({ failLaunch: true });
        const tool = createExecutePlanTool({
            pool,
            runLauncher: launcher,
            runAuthorizer: authorizer,
            executeAnalysisWorkflow: async () => {
                throw new Error("unused");
            },
        });

        await expect(tool.execute({ planId: PLAN_ID }, fakeContext())).rejects.toThrow(/launch boom/);

        expect(revokes).toContain("workflow-start-failed");
        expect(queries.some((q) => q.text.includes("SET status") && q.values.includes("failed"))).toBe(true);
    });
});
