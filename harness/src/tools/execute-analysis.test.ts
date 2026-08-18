/**
 * execute_analysis tool — unit-level coverage for the validation gate and the
 * dedup recovery contract. The Postgres-testcontainer end-to-end coverage
 * (task 3.5) is exercised once the full executeAnalysis dep bundle is wired
 * at boot; here we drive the tool with a fake `Pool` and a fake registered
 * workflow function to keep the assertion surface focused.
 */

import { describe, expect, it } from "bun:test";
import { okAsync } from "neverthrow";
import type { Pool } from "pg";

import type { RequestSession, RunSession } from "../auth/types.js";
import { makeLocalAuth } from "../auth/local-auth-context.js";
import type { RunAuthorization, RunAuthorizer } from "../execution/run-authorizer.js";
import type { RunLauncher } from "../execution/run-launcher.js";
import type { ChatProvider } from "../providers/types.js";
import type { ExtendAnalysisFarm, PackageRequest, PackageRequestOutcome } from "../sandbox/types.js";
import type { ExecuteAnalysisInput } from "../workflows/execute-analysis.js";
import type { ToolContext } from "./define-tool.js";
import { PlanNotFoundError, PlanPackagesUnavailableError, PlanValidationError, createExecuteAnalysisTool } from "./execute-analysis.js";

/** Records launches; never reaches the durability engine. */
function fakeLauncher(opts: { failLaunch?: boolean } = {}): {
    launcher: RunLauncher;
    launches: Array<{ workflowId: string }>;
    inputs: ExecuteAnalysisInput[];
} {
    const launches: Array<{ workflowId: string }> = [];
    const inputs: ExecuteAnalysisInput[] = [];
    const launcher: RunLauncher = {
        launch: async (_workflow, o, input) => {
            if (opts.failLaunch) throw new Error("launch boom");
            launches.push({ workflowId: o.workflowId });
            inputs.push(input as ExecuteAnalysisInput);
        },
    };
    return { launcher, launches, inputs };
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

function fakeContext(invocationId = "tool-call-1", emitted: unknown[] = []): ToolContext {
    const session: RequestSession = {
        identity: { user: "user-1" },
        scope: { kind: "analysis", analysisId: ANALYSIS_ID, threadId: "thread-1" },
        provenance: { agentId: "conversation-agent", callPath: [] },
        auth: makeLocalAuth(),
    };
    return {
        session,
        invocationId,
        signal: new AbortController().signal,
        emit: async (part) => {
            emitted.push(part);
        },
        runStep: (_name, fn) => fn(),
        ask: async () => {
            throw new Error("ask should not be reached");
        },
    };
}

function routeProvider(agentId = "single-cell-agent"): { provider: ChatProvider; calls: { count: number } } {
    const calls = { count: 0 };
    return {
        calls,
        provider: {
            capabilities: { toolCalling: true },
            chat: () => {
                calls.count++;
                return okAsync({
                    message: {
                        role: "assistant",
                        content: [
                            {
                                type: "tool-call",
                                toolCallId: `route-${calls.count}`,
                                toolName: "submit_route",
                                input: {
                                    agentId,
                                    resources: { cpu: 2, memoryGb: 4 },
                                    rationale: `route-${calls.count}`,
                                },
                            },
                        ],
                    },
                    finishReason: "tool-calls",
                });
            },
            chatStream: async function* () {},
        } as ChatProvider,
    };
}

function statefulAdHocPool(): { pool: Pool; plans: Map<string, unknown>; runs: Map<string, Row> } {
    const plans = new Map<string, unknown>();
    const runs = new Map<string, Row>();
    const query = async (q: { text: string; values?: unknown[] }) => {
        const values = q.values ?? [];
        if (q.text.includes("SELECT plan FROM cortex_plans")) {
            const plan = plans.get(String(values[0]));
            return { rows: plan === undefined ? [] : [{ plan }], rowCount: plan === undefined ? 0 : 1 };
        }
        if (q.text.includes("INSERT INTO cortex_plans")) {
            const planId = String(values[0]);
            if (!plans.has(planId)) plans.set(planId, JSON.parse(String(values[2])));
            return { rows: [], rowCount: 1 };
        }
        if (q.text.includes("INSERT INTO cortex_runs") && q.text.includes("ON CONFLICT (run_id)")) {
            const runId = String(values[0]);
            if (runs.has(runId)) return { rows: [], rowCount: 0 };
            const row = {
                run_id: runId,
                analysis_id: String(values[1]),
                thread_id: values[2] ?? null,
                workflow_name: String(values[3]),
                status: "running",
                started_at: String(values[4]),
                completed_at: null,
                error: null,
                synthesis_status: null,
                synthesis_reason: null,
                parts: null,
                mandate_jti: null,
                mandate_expires_at: null,
                plan_id: values[5] ?? null,
            };
            runs.set(runId, row);
            return { rows: [{ run_id: runId }], rowCount: 1 };
        }
        if (q.text.includes("FROM cortex_runs") && q.text.includes("WHERE run_id = $1")) {
            const row = runs.get(String(values[0]));
            return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
        }
        if (q.text.includes("UPDATE cortex_runs")) return { rows: [], rowCount: 1 };
        // No persisted data profile.
        return { rows: [], rowCount: 0 };
    };
    return { pool: { query } as unknown as Pool, plans, runs };
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

const utilityDeps = {
    utilityProvider: {} as never,
    utilityModel: "utility-model",
};

describe("createExecuteAnalysisTool plan mode", () => {
    it("exposes one flat refined schema with only mode, planId, and request", () => {
        const tool = createExecuteAnalysisTool({
            ...utilityDeps,
            pool: {} as Pool,
            runLauncher: fakeLauncher().launcher,
            runAuthorizer: throwingAuthorizer,
            executeAnalysisWorkflow: async () => {
                throw new Error("unused");
            },
        });

        expect(Object.keys((tool.jsonSchema.properties ?? {}) as Record<string, unknown>).sort()).toEqual(["mode", "planId", "request"]);
        expect(tool.inputSchema.safeParse({ mode: "plan", planId: PLAN_ID }).success).toBe(true);
        expect(tool.inputSchema.safeParse({ mode: "adhoc", request: "Compute this" }).success).toBe(true);
        expect(tool.inputSchema.safeParse({ mode: "plan", request: "wrong" }).success).toBe(false);
        expect(tool.inputSchema.safeParse({ mode: "adhoc", planId: PLAN_ID, request: "wrong" }).success).toBe(false);
    });

    it("throws PlanNotFoundError when no row matches the (analysis, plan) tuple", async () => {
        const { pool } = fakePool({
            "SELECT plan FROM cortex_plans": [],
        });
        const tool = createExecuteAnalysisTool({
            ...utilityDeps,
            pool,
            runLauncher: fakeLauncher().launcher,
            runAuthorizer: throwingAuthorizer,
            executeAnalysisWorkflow: async () => {
                throw new Error("should not be called");
            },
        });
        await expect(tool.execute({ mode: "plan", planId: PLAN_ID }, fakeContext())).rejects.toBeInstanceOf(PlanNotFoundError);
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
        const tool = createExecuteAnalysisTool({
            ...utilityDeps,
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
        await expect(tool.execute({ mode: "plan", planId: PLAN_ID }, fakeContext())).rejects.toBeInstanceOf(PlanValidationError);
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
        const tool = createExecuteAnalysisTool({
            ...utilityDeps,
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
        const result = (await tool.execute({ mode: "plan", planId: PLAN_ID }, fakeContext()))._unsafeUnwrap();
        expect(result).toMatchObject({ runId: "r-existing", status: "in_progress" });
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
        const tool = createExecuteAnalysisTool({
            ...utilityDeps,
            pool,
            runLauncher: fakeLauncher().launcher,
            runAuthorizer: failingAuthorizer,
            executeAnalysisWorkflow: async () => {
                throw new Error("workflow must not start after a failed authorization");
            },
        });

        await expect(tool.execute({ mode: "plan", planId: PLAN_ID }, fakeContext())).rejects.toThrow(/mint exploded/);

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
        const tool = createExecuteAnalysisTool({
            ...utilityDeps,
            pool,
            runLauncher: launcher,
            runAuthorizer: authorizer,
            executeAnalysisWorkflow: async () => {
                throw new Error("the tool launches via the seam, never calls directly");
            },
        });

        const result = (await tool.execute({ mode: "plan", planId: PLAN_ID }, fakeContext()))._unsafeUnwrap() as {
            runId: string;
            status: string;
        };

        expect(launches).toHaveLength(1);
        expect(launches[0]!.workflowId).toBe(result.runId);
        expect(result.status).toBe("in_progress");
        expect(revokes).toHaveLength(0);
    });

    it("carries each step's plan DATA into the workflow input — the seed is composed later, at dispatch", async () => {
        setEnv();
        const { pool } = fakePool({
            "SELECT plan FROM cortex_plans": [{ plan: validPlan }],
        });
        const { authorizer } = recordingAuthorizer();
        const { launcher, inputs } = fakeLauncher();
        const tool = createExecuteAnalysisTool({
            ...utilityDeps,
            pool,
            runLauncher: launcher,
            runAuthorizer: authorizer,
            executeAnalysisWorkflow: async () => {
                throw new Error("the tool launches via the seam, never calls directly");
            },
        });

        await tool.execute({ mode: "plan", planId: PLAN_ID }, fakeContext());

        const workflowInput = inputs[0]!;
        expect(workflowInput.planStepById["step-a"]!.question).toBe("do step-a");
        expect(workflowInput.planStepById["step-a"]!.acceptance_criteria).toEqual(["completes"]);
        // No pre-rendered prompt string is frozen into the durable input.
        expect(workflowInput).not.toHaveProperty("promptByStepId");
    });

    it("revokes authorization and marks the run failed when the launch fails", async () => {
        setEnv();
        const { pool, queries } = fakePool({
            "SELECT plan FROM cortex_plans": [{ plan: validPlan }],
        });
        const { authorizer, revokes } = recordingAuthorizer();
        const { launcher } = fakeLauncher({ failLaunch: true });
        const tool = createExecuteAnalysisTool({
            ...utilityDeps,
            pool,
            runLauncher: launcher,
            runAuthorizer: authorizer,
            executeAnalysisWorkflow: async () => {
                throw new Error("unused");
            },
        });

        await expect(tool.execute({ mode: "plan", planId: PLAN_ID }, fakeContext())).rejects.toThrow(/launch boom/);

        expect(revokes).toContain("workflow-start-failed");
        expect(queries.some((q) => q.text.includes("SET status") && q.values.includes("failed"))).toBe(true);
    });
});

/** Records what the tool asked the pool for, and answers each request the same way. */
function fakeFarm(answer: (request: PackageRequest) => PackageRequestOutcome): {
    seam: ExtendAnalysisFarm;
    calls: PackageRequest[][];
} {
    const calls: PackageRequest[][] = [];
    const seam: ExtendAnalysisFarm = async (_analysisId, requests) => {
        calls.push([...requests]);
        return requests.map(answer);
    };
    return { seam, calls };
}

const packagedPlan = {
    ...validPlan,
    steps: [
        { ...makeStep("step-a"), packages: ["scanpy", "polars==1.2"] },
        { ...makeStep("step-b", ["step-a"]), packages: ["scanpy"] },
    ],
};

describe("createExecuteAnalysisTool plan packages", () => {
    it("asks the pool for each named package once, then launches", async () => {
        setEnv();
        const { pool } = fakePool({ "SELECT plan FROM cortex_plans": [{ plan: packagedPlan }] });
        const { authorizer } = recordingAuthorizer();
        const { launcher, launches } = fakeLauncher();
        const { seam, calls } = fakeFarm((request) => ({
            kind: "linked",
            requested: request.kind === "distribution" ? request.requirement : request.module,
            name: "scanpy",
            version: "1.10.0",
        }));
        const tool = createExecuteAnalysisTool({
            ...utilityDeps,
            pool,
            runLauncher: launcher,
            runAuthorizer: authorizer,
            extendAnalysisFarm: seam,
            executeAnalysisWorkflow: async () => {
                throw new Error("the tool launches via the seam, never calls directly");
            },
        });

        await tool.execute({ mode: "plan", planId: PLAN_ID }, fakeContext());

        expect(calls).toHaveLength(1);
        expect(calls[0]).toEqual([
            { kind: "distribution", requirement: "scanpy" },
            { kind: "distribution", requirement: "polars==1.2" },
        ]);
        expect(launches).toHaveLength(1);
    });

    it("treats a package already in the farm as a success", async () => {
        setEnv();
        const { pool } = fakePool({ "SELECT plan FROM cortex_plans": [{ plan: packagedPlan }] });
        const { authorizer } = recordingAuthorizer();
        const { launcher, launches } = fakeLauncher();
        const { seam } = fakeFarm(() => ({ kind: "present", requested: "scanpy", name: "scanpy", version: "1.10.0" }));
        const tool = createExecuteAnalysisTool({
            ...utilityDeps,
            pool,
            runLauncher: launcher,
            runAuthorizer: authorizer,
            extendAnalysisFarm: seam,
            executeAnalysisWorkflow: async () => {
                throw new Error("unused");
            },
        });

        await tool.execute({ mode: "plan", planId: PLAN_ID }, fakeContext());

        expect(launches).toHaveLength(1);
    });

    it("refuses a package the pool does not hold, and reserves nothing", async () => {
        setEnv();
        const { pool, queries } = fakePool({ "SELECT plan FROM cortex_plans": [{ plan: packagedPlan }] });
        const { launcher, launches } = fakeLauncher();
        // The remedy rides in the reason of the embedder, because only the embedder holds
        // the pool and only it knows the command that acquires one.
        const { seam } = fakeFarm((request) => ({
            kind: "absent",
            requested: request.kind === "distribution" ? request.requirement : request.module,
            reason: 'the store holds no package named "scanpy" — run `some-host-command` to acquire it',
            acquisitionPossible: true,
        }));
        const tool = createExecuteAnalysisTool({
            ...utilityDeps,
            pool,
            runLauncher: launcher,
            // Never reached: the refusal lands before the run is authorized.
            runAuthorizer: throwingAuthorizer,
            extendAnalysisFarm: seam,
            executeAnalysisWorkflow: async () => {
                throw new Error("unused");
            },
        });

        const failure = await tool.execute({ mode: "plan", planId: PLAN_ID }, fakeContext()).then(
            () => null,
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(PlanPackagesUnavailableError);
        const message = (failure as Error).message;
        expect(message).toContain('"scanpy"');
        expect(message).toContain('"polars==1.2"');
        expect(message).toContain("run `some-host-command` to acquire it");
        // The harness names no remedy of its own: a managed deployment runs this same code
        // and holds no `inflexa` binary.
        expect(message).not.toContain("inflexa");
        expect(message).not.toContain("never acquire");
        expect(launches).toHaveLength(0);
        expect(queries.some((q) => q.text.includes("INSERT INTO cortex_runs"))).toBe(false);
    });

    it("marks a request that no acquisition can ever answer, and relays the reason of the embedder", async () => {
        setEnv();
        const { pool } = fakePool({ "SELECT plan FROM cortex_plans": [{ plan: packagedPlan }] });
        const { seam } = fakeFarm((request) => ({
            kind: "absent",
            requested: request.kind === "distribution" ? request.requirement : request.module,
            reason: 'the store holds "DESeq2" at 1.38.0, and not at 1.40',
            acquisitionPossible: false,
        }));
        const tool = createExecuteAnalysisTool({
            ...utilityDeps,
            pool,
            runLauncher: fakeLauncher().launcher,
            runAuthorizer: throwingAuthorizer,
            extendAnalysisFarm: seam,
            executeAnalysisWorkflow: async () => {
                throw new Error("unused");
            },
        });

        const failure = await tool.execute({ mode: "plan", planId: PLAN_ID }, fakeContext()).then(
            () => null,
            (error: unknown) => error,
        );

        const message = (failure as Error).message;
        // The mark is the harness rule, and it names no ecosystem: `acquisitionPossible`
        // is false for each request that no acquisition answers, and an R package is only
        // one such case. The ecosystem rides in the reason of the embedder.
        expect(message).toContain("this store can never acquire");
        expect(message).toContain('the store holds "DESeq2" at 1.38.0, and not at 1.40');
    });

    it("refuses a version collision, and names both store directories", async () => {
        setEnv();
        const { pool } = fakePool({ "SELECT plan FROM cortex_plans": [{ plan: packagedPlan }] });
        const { launcher, launches } = fakeLauncher();
        const { seam } = fakeFarm((request) => ({
            kind: "collision",
            requested: request.kind === "distribution" ? request.requirement : request.module,
            name: "polars",
            linkedDirectory: "/store/pkgs/polars-1.9.0-aaaa",
            requestedDirectory: "/store/pkgs/polars-1.2.0-bbbb",
        }));
        const tool = createExecuteAnalysisTool({
            ...utilityDeps,
            pool,
            runLauncher: launcher,
            runAuthorizer: throwingAuthorizer,
            extendAnalysisFarm: seam,
            executeAnalysisWorkflow: async () => {
                throw new Error("unused");
            },
        });

        const failure = await tool.execute({ mode: "plan", planId: PLAN_ID }, fakeContext()).then(
            () => null,
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(PlanPackagesUnavailableError);
        const message = (failure as Error).message;
        expect(message).toContain("/store/pkgs/polars-1.9.0-aaaa");
        expect(message).toContain("/store/pkgs/polars-1.2.0-bbbb");
        expect(message).toContain("A farm holds one version of one name");
        expect(launches).toHaveLength(0);
    });

    it("launches unchanged when the embedder binds no seam", async () => {
        setEnv();
        const { pool } = fakePool({ "SELECT plan FROM cortex_plans": [{ plan: packagedPlan }] });
        const { authorizer } = recordingAuthorizer();
        const { launcher, launches } = fakeLauncher();
        const tool = createExecuteAnalysisTool({
            ...utilityDeps,
            pool,
            runLauncher: launcher,
            runAuthorizer: authorizer,
            executeAnalysisWorkflow: async () => {
                throw new Error("unused");
            },
        });

        await tool.execute({ mode: "plan", planId: PLAN_ID }, fakeContext());

        expect(launches).toHaveLength(1);
    });
});

describe("createExecuteAnalysisTool ad hoc mode", () => {
    it("persists one routed step, disables synthesis, and reuses the same terminal-capable reservation on redelivery", async () => {
        const { pool, plans, runs } = statefulAdHocPool();
        const routing = routeProvider();
        const { authorizer } = recordingAuthorizer();
        const { launcher, launches, inputs } = fakeLauncher();
        const emitted: unknown[] = [];
        const tool = createExecuteAnalysisTool({
            pool,
            utilityProvider: routing.provider,
            utilityModel: "utility-model",
            runAuthorizer: authorizer,
            runLauncher: launcher,
            executeAnalysisWorkflow: async () => {
                throw new Error("launch seam should be used");
            },
        });

        const first = (
            await tool.execute({ mode: "adhoc", request: "Compare marker expression between these clusters" }, fakeContext("call-adhoc-1", emitted))
        )._unsafeUnwrap() as { runId: string };
        // Simulate a terminal DBOS outcome. A duplicate tool delivery must still
        // return this exact run instead of launching it again.
        runs.get(first.runId)!.status = "completed";
        const replay = (
            await tool.execute({ mode: "adhoc", request: "Compare marker expression between these clusters" }, fakeContext("call-adhoc-1", emitted))
        )._unsafeUnwrap() as { runId: string };

        expect(replay.runId).toBe(first.runId);
        expect(routing.calls.count).toBe(1);
        expect(launches).toHaveLength(1);
        expect(inputs[0]!.steps).toEqual([{ id: "T1S1", depends_on: [] }]);
        expect(inputs[0]!.agentByStepId).toEqual({ T1S1: "single-cell-agent" });
        expect(inputs[0]!.synthesisEnabled).toBe(false);
        expect(plans.size).toBe(1);
        expect(emitted).toHaveLength(2);
    });

    it("treats a deliberate identical re-call with a new tool invocation id as a new run", async () => {
        const { pool } = statefulAdHocPool();
        const routing = routeProvider("cheminformatics-agent");
        const { authorizer } = recordingAuthorizer();
        const { launcher, launches } = fakeLauncher();
        const tool = createExecuteAnalysisTool({
            pool,
            utilityProvider: routing.provider,
            utilityModel: "utility-model",
            runAuthorizer: authorizer,
            runLauncher: launcher,
            executeAnalysisWorkflow: async () => {
                throw new Error("launch seam should be used");
            },
        });
        const request = "Calculate descriptors for the supplied compounds";

        const first = (await tool.execute({ mode: "adhoc", request }, fakeContext("call-1")))._unsafeUnwrap() as { runId: string };
        const second = (await tool.execute({ mode: "adhoc", request }, fakeContext("call-2")))._unsafeUnwrap() as { runId: string };

        expect(second.runId).not.toBe(first.runId);
        expect(launches).toHaveLength(2);
        expect(routing.calls.count).toBe(2);
    });
});
