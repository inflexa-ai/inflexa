/**
 * `composeStepSeed` — the dispatch-time seed composition.
 *
 * These tests drive the composer directly (it is a plain async function; the
 * parent wraps it in a `DBOS.runStep`, which is what makes its output
 * replay-stable). They assert on the composed STRING against real durable
 * state: a summary written to the run tree, artifact rows in the fake ledger,
 * a persisted data profile, and a working-memory row read through the real store.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";

import { makeLocalAuth } from "../auth/local-auth-context.js";
import { createWorkingMemory, type WorkingMemory } from "../memory/working-memory.js";
import { ANALYSIS_MEMORY_HEADING } from "../prompts/briefing.js";
import type { DataProfileResult } from "../state/data-profile.js";
import type { AnalysisStep } from "../schemas/workflow-state.js";
import { composeStepSeed } from "./execute-analysis.js";
import type { ExecuteAnalysisDeps, ExecuteAnalysisInput } from "./execute-analysis.js";

const ANALYSIS_ID = "an-1";
const RUN_ID = "run-1";

const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function makeWorkspace(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "cortex-step-seed-"));
    roots.push(root);
    return root;
}

/** Write a completed step's `output/summary.md` into the run tree. */
async function writeStepSummary(workspaceRoot: string, stepId: string, markdown: string): Promise<void> {
    const dir = join(workspaceRoot, "runs", RUN_ID, stepId, "output");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "summary.md"), markdown, "utf8");
}

interface FakeState {
    /** `cortex_analysis_state.data_profile_result` for this analysis. */
    readonly profile?: DataProfileResult;
    /** `cortex_artifacts` step-output rows, keyed by step id. */
    readonly artifactsByStep?: Record<string, Array<{ path: string; file_type: string | null }>>;
    /** `cortex_working_memory.data` for this analysis. A mutable holder, thus a test can edit it between two dispatches. */
    readonly memory?: { current: WorkingMemory | undefined };
    /** Make the working-memory read fail at the driver. */
    readonly memoryReadFails?: boolean;
}

function fakePool(state: FakeState): Pool {
    // The state queries pass a config object; the working-memory store passes the text and the values apart.
    const query = async (config: string | { text: string; values?: readonly unknown[] }, values?: readonly unknown[]) => {
        const q = typeof config === "string" ? { text: config, values } : config;
        const text = q.text.trim();
        if (text.startsWith("SELECT data_profile_status")) {
            if (!state.profile) return { rows: [], rowCount: 0 };
            return {
                rows: [
                    {
                        data_profile_status: "completed",
                        data_profile_error: null,
                        data_profile_started_at: null,
                        data_profile_completed_at: null,
                        data_profile_result: state.profile,
                        seed_input_file_ids: ["f1"],
                    },
                ],
                rowCount: 1,
            };
        }
        if (text.startsWith("SELECT data FROM cortex_working_memory")) {
            if (state.memoryReadFails) throw new Error("connection refused");
            const data = state.memory?.current;
            return data ? { rows: [{ data }], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        if (text.startsWith("SELECT path, file_type")) {
            const stepId = q.values?.[2] as string;
            const limit = q.values?.[3] as number;
            const rows = (state.artifactsByStep?.[stepId] ?? []).slice(0, limit);
            return { rows, rowCount: rows.length };
        }
        return { rows: [], rowCount: 0 };
    };
    return { query } as unknown as Pool;
}

function deps(workspaceRoot: string, state: FakeState = {}): ExecuteAnalysisDeps {
    const pool = fakePool(state);
    return {
        pool,
        workingMemory: createWorkingMemory(pool),
        resolveWorkspaceRoot: () => workspaceRoot,
    } as unknown as ExecuteAnalysisDeps;
}

function memoryRow(overrides: Partial<WorkingMemory> = {}): WorkingMemory {
    return {
        goal: "MEMORY_GOAL",
        constraints: [
            { id: "c1", text: "USER_RULE", origin: "user" },
            { id: "c2", text: "AGENT_RULE", origin: "agent" },
        ],
        hypotheses: [{ id: "h1", text: "HYPOTHESIS_TEXT" }],
        findings: { "run-0": [{ id: "f1", text: "FINDING_TEXT" }] },
        ...overrides,
    };
}

function planStep(id: string, dependsOn: readonly string[] = []): AnalysisStep {
    return {
        id,
        name: `NAME_${id}`,
        track: "T1",
        step_type: "analysis",
        question: `QUESTION_${id}`,
        acceptance_criteria: [`CRITERION_${id}`],
        depends_on: [...dependsOn],
        status: "pending",
        resources: { cpu: 2, memoryGb: 4 },
        agent: "bulk-transcriptomics-agent",
        maxSteps: 10,
    };
}

function input(steps: readonly AnalysisStep[]): ExecuteAnalysisInput {
    return {
        analysisId: ANALYSIS_ID,
        planId: "pln-abcdef01",
        planSummary: "test plan",
        threadId: null,
        steps: steps.map((s) => ({ id: s.id, depends_on: s.depends_on })),
        planStepById: Object.fromEntries(steps.map((s) => [s.id, s])),
        agentByStepId: Object.fromEntries(steps.map((s) => [s.id, s.agent ?? "unknown"])),
        resourcesByStepId: Object.fromEntries(steps.map((s) => [s.id, s.resources!])),
        runSession: {
            identity: { user: "u-1" },
            scope: { kind: "analysis", analysisId: ANALYSIS_ID },
            provenance: { agentId: "executeAnalysis", callPath: ["executeAnalysis"] },
            runFrame: { runId: RUN_ID },
            auth: makeLocalAuth(),
        },
    };
}

const PROFILE: DataProfileResult = {
    summary: "bulk RNA-seq of tumour vs normal",
    files: [{ path: "data/inputs/counts.csv", description: "raw counts", format: "CSV", rows: 20000, cols: 24 }],
    profiledAt: "2026-01-01T00:00:00.000Z",
    domain: "transcriptomics",
    subtype: "bulk-rna-seq",
    organism: { scientificName: "Homo sapiens", taxonId: "9606", source: "inferred", confidence: "high" },
};

describe("composeStepSeed", () => {
    it("carries a completed dependency's step id, summary excerpt, output dir, and artifacts into the downstream seed", async () => {
        const root = await makeWorkspace();
        await writeStepSummary(root, "T1S1", "# DE results\n\nUPSTREAM_FINDING: 412 genes differentially expressed.");

        const seed = await composeStepSeed({
            input: input([planStep("T1S1"), planStep("T1S2", ["T1S1"])]),
            stepId: "T1S2",
            runId: RUN_ID,
            deps: deps(root, {
                artifactsByStep: {
                    T1S1: [{ path: "runs/run-1/T1S1/output/de.csv", file_type: "output" }],
                },
            }),
        });

        expect(seed).toContain("T1S1");
        expect(seed).toContain("UPSTREAM_FINDING");
        expect(seed).toContain("bulk-transcriptomics-agent");
        expect(seed).toContain(`/${ANALYSIS_ID}/runs/${RUN_ID}/T1S1/output`);
        expect(seed).toContain(`/${ANALYSIS_ID}/runs/${RUN_ID}/T1S1/output/summary.md`);
        expect(seed).toContain(`/${ANALYSIS_ID}/runs/${RUN_ID}/T1S1/output/de.csv`);
        // And its own task + working directory.
        expect(seed).toContain("QUESTION_T1S2");
        expect(seed).toContain(`/${ANALYSIS_ID}/runs/${RUN_ID}/T1S2`);
    });

    it("gives an independent step no upstream block", async () => {
        const root = await makeWorkspace();
        await writeStepSummary(root, "T1S1", "irrelevant sibling summary");

        const seed = await composeStepSeed({
            input: input([planStep("T1S1"), planStep("T1S2")]),
            stepId: "T1S2",
            runId: RUN_ID,
            deps: deps(root),
        });

        expect(seed).toContain("QUESTION_T1S2");
        expect(seed).not.toContain("Upstream results");
        expect(seed).not.toContain("T1S1");
    });

    it("omits a dependency that produced no summary rather than blocking the dispatch", async () => {
        const root = await makeWorkspace();
        await writeStepSummary(root, "T1S1", "FIRST_DEP_SUMMARY");
        // T1S0 completed but wrote no summary.md — nothing to hand off.

        const seed = await composeStepSeed({
            input: input([planStep("T1S0"), planStep("T1S1"), planStep("T1S2", ["T1S0", "T1S1"])]),
            stepId: "T1S2",
            runId: RUN_ID,
            deps: deps(root),
        });

        expect(seed).toContain("FIRST_DEP_SUMMARY");
        expect(seed).not.toContain("T1S0");
    });

    it("includes the data orientation when a profile is persisted", async () => {
        const root = await makeWorkspace();
        const seed = await composeStepSeed({
            input: input([planStep("T1S1")]),
            stepId: "T1S1",
            runId: RUN_ID,
            deps: deps(root, { profile: PROFILE }),
        });

        expect(seed).toContain("Data orientation");
        expect(seed).toContain("transcriptomics");
        expect(seed).toContain("Homo sapiens");
        expect(seed).toContain("data/inputs/counts.csv");
    });

    it("omits the orientation section when the analysis has not been profiled", async () => {
        const root = await makeWorkspace();
        const seed = await composeStepSeed({
            input: input([planStep("T1S1")]),
            stepId: "T1S1",
            runId: RUN_ID,
            deps: deps(root),
        });

        expect(seed).not.toContain("Data orientation");
        expect(seed).toContain("QUESTION_T1S1");
    });

    it("carries the goal and each constraint with its origin, and leaves out the hypotheses and the findings", async () => {
        const root = await makeWorkspace();
        const seed = await composeStepSeed({
            input: input([planStep("T1S1")]),
            stepId: "T1S1",
            runId: RUN_ID,
            deps: deps(root, { memory: { current: memoryRow() } }),
        });

        expect(seed).toContain("## Analysis memory (read only)");
        expect(seed).toContain("Goal: MEMORY_GOAL");
        expect(seed).toContain("- (user) USER_RULE");
        expect(seed).toContain("- (agent) AGENT_RULE");
        expect(seed).not.toContain("HYPOTHESIS_TEXT");
        expect(seed).not.toContain("FINDING_TEXT");
    });

    it("omits the memory section when the analysis has no working-memory row", async () => {
        const root = await makeWorkspace();
        const seed = await composeStepSeed({ input: input([planStep("T1S1")]), stepId: "T1S1", runId: RUN_ID, deps: deps(root) });

        expect(seed).not.toContain("Analysis memory");
        expect(seed).toContain("QUESTION_T1S1");
    });

    it("reads the memory at each dispatch, thus a later step sees an edit made during the run", async () => {
        const root = await makeWorkspace();
        const memory = { current: memoryRow() };
        const stepDeps = deps(root, { memory });
        const runInput = input([planStep("T1S1"), planStep("T1S2")]);

        const first = await composeStepSeed({ input: runInput, stepId: "T1S1", runId: RUN_ID, deps: stepDeps });
        memory.current = memoryRow({ constraints: [{ id: "c3", text: "EDITED_RULE", origin: "user" }] });
        const second = await composeStepSeed({ input: runInput, stepId: "T1S2", runId: RUN_ID, deps: stepDeps });

        expect(first).toContain("USER_RULE");
        expect(first).not.toContain("EDITED_RULE");
        expect(second).toContain("EDITED_RULE");
        expect(second).not.toContain("USER_RULE");
    });

    it("leaves the memory section out when the working-memory read fails", async () => {
        const root = await makeWorkspace();
        const seed = await composeStepSeed({ input: input([planStep("T1S1")]), stepId: "T1S1", runId: RUN_ID, deps: deps(root, { memoryReadFails: true }) });
        expect(seed).not.toContain(ANALYSIS_MEMORY_HEADING);
        expect(seed.length).toBeGreaterThan(0);
    });

    it("recomposes byte-identically from the same durable inputs (replay stability)", async () => {
        const root = await makeWorkspace();
        await writeStepSummary(root, "T1S1", "# DE results\n\n412 genes.");
        const args = {
            input: input([planStep("T1S1"), planStep("T1S2", ["T1S1"])]),
            stepId: "T1S2",
            runId: RUN_ID,
            deps: deps(root, {
                profile: PROFILE,
                artifactsByStep: { T1S1: [{ path: "runs/run-1/T1S1/output/de.csv", file_type: "output" }] },
                memory: { current: memoryRow() },
            }),
        };

        expect(await composeStepSeed(args)).toBe(await composeStepSeed(args));
    });

    it("bounds a pathological dependency summary to the excerpt budget", async () => {
        const root = await makeWorkspace();
        await writeStepSummary(root, "T1S1", "M".repeat(200_000));

        const seed = await composeStepSeed({
            input: input([planStep("T1S1"), planStep("T1S2", ["T1S1"])]),
            stepId: "T1S2",
            runId: RUN_ID,
            deps: deps(root),
        });

        // A 200k-char summary must not become a 200k-char prompt: the seed carries
        // the gist and the PATH to the rest.
        expect(seed.length).toBeLessThan(3_000);
        expect(seed).toContain(`/${ANALYSIS_ID}/runs/${RUN_ID}/T1S1/output/summary.md`);
    });

    it("throws when the dispatched step carries no plan data", async () => {
        const root = await makeWorkspace();
        const bad: ExecuteAnalysisInput = { ...input([planStep("T1S1")]), planStepById: {} };

        await expect(composeStepSeed({ input: bad, stepId: "T1S1", runId: RUN_ID, deps: deps(root) })).rejects.toThrow(/missing from planStepById/);
    });
});
