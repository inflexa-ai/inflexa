/**
 * `composeStepSeed` — the dispatch-time seed composition.
 *
 * These tests drive the composer directly (it is a plain async function; the
 * parent wraps it in a `DBOS.runStep`, which is what makes its output
 * replay-stable). They assert on the composed STRING against real durable
 * state: a summary written to the run tree, artifact rows in the fake ledger,
 * and a persisted data profile.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";

import { makeLocalAuth } from "../auth/local-auth-context.js";
import type { DataProfileResult } from "../state/data-profile.js";
import type { AnalysisStep } from "../schemas/workflow-state.js";
import type { KnowledgeClient } from "../tools/knowledge/client.js";
import { contractAnswer, fakeKnowledgeClient } from "../tools/knowledge/__fixtures__/fake-client.js";
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
}

function fakePool(state: FakeState): Pool {
    const query = async (q: { text: string; values?: readonly unknown[] }) => {
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

function deps(workspaceRoot: string, state: FakeState = {}, knowledge?: KnowledgeClient): ExecuteAnalysisDeps {
    return {
        pool: fakePool(state),
        resolveWorkspaceRoot: () => workspaceRoot,
        ...(knowledge ? { knowledge } : {}),
    } as unknown as ExecuteAnalysisDeps;
}

function planStep(id: string, dependsOn: readonly string[] = [], grounding?: AnalysisStep["grounding"]): AnalysisStep {
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
        ...(grounding ? { grounding } : {}),
    };
}

const TEMPLATE_REF = "tpl-deseq2-two-group@1.0.0";

/** A grounding on the two-group template with the settings of the procedure: one adaptable slot, one pinned slot, one name no slot carries. */
function grounded(settings: NonNullable<AnalysisStep["grounding"]>["settings"], template: string | null = TEMPLATE_REF): AnalysisStep["grounding"] {
    return {
        status: "grounded",
        snapshot: "sha256:71ac",
        claims: ["R-0001@e7d0"],
        ...(template ? { template } : {}),
        settings,
        reason: "DESeq2 Wald per R-0001@e7d0",
    };
}

const SETTINGS: NonNullable<AnalysisStep["grounding"]>["settings"] = [
    { step: "differential_expression", name: "lfc_shrink", value: "apeglm", source: "doi:10.1093/bioinformatics/bty895" },
    { step: "differential_expression", name: "alpha", value: 0.05, source: "doi:10.1186/s13059-014-0550-8" },
    { step: "enrichment", name: "inference", value: "none" },
];

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

        expect(seed.prompt).toContain("T1S1");
        expect(seed.prompt).toContain("UPSTREAM_FINDING");
        expect(seed.prompt).toContain("bulk-transcriptomics-agent");
        expect(seed.prompt).toContain(`/${ANALYSIS_ID}/runs/${RUN_ID}/T1S1/output`);
        expect(seed.prompt).toContain(`/${ANALYSIS_ID}/runs/${RUN_ID}/T1S1/output/summary.md`);
        expect(seed.prompt).toContain(`/${ANALYSIS_ID}/runs/${RUN_ID}/T1S1/output/de.csv`);
        // And its own task + working directory.
        expect(seed.prompt).toContain("QUESTION_T1S2");
        expect(seed.prompt).toContain(`/${ANALYSIS_ID}/runs/${RUN_ID}/T1S2`);
        // An ungrounded step binds nothing.
        expect(seed.templateBinding).toBeUndefined();
    });

    it("gives an independent step no upstream block", async () => {
        const root = await makeWorkspace();
        await writeStepSummary(root, "T1S1", "irrelevant sibling summary");

        const { prompt } = await composeStepSeed({
            input: input([planStep("T1S1"), planStep("T1S2")]),
            stepId: "T1S2",
            runId: RUN_ID,
            deps: deps(root),
        });

        expect(prompt).toContain("QUESTION_T1S2");
        expect(prompt).not.toContain("Upstream results");
        expect(prompt).not.toContain("T1S1");
    });

    it("omits a dependency that produced no summary rather than blocking the dispatch", async () => {
        const root = await makeWorkspace();
        await writeStepSummary(root, "T1S1", "FIRST_DEP_SUMMARY");
        // T1S0 completed but wrote no summary.md — nothing to hand off.

        const { prompt } = await composeStepSeed({
            input: input([planStep("T1S0"), planStep("T1S1"), planStep("T1S2", ["T1S0", "T1S1"])]),
            stepId: "T1S2",
            runId: RUN_ID,
            deps: deps(root),
        });

        expect(prompt).toContain("FIRST_DEP_SUMMARY");
        expect(prompt).not.toContain("T1S0");
    });

    it("includes the data orientation when a profile is persisted", async () => {
        const root = await makeWorkspace();
        const { prompt } = await composeStepSeed({
            input: input([planStep("T1S1")]),
            stepId: "T1S1",
            runId: RUN_ID,
            deps: deps(root, { profile: PROFILE }),
        });

        expect(prompt).toContain("Data orientation");
        expect(prompt).toContain("transcriptomics");
        expect(prompt).toContain("Homo sapiens");
        expect(prompt).toContain("data/inputs/counts.csv");
    });

    it("omits the orientation section when the analysis has not been profiled", async () => {
        const root = await makeWorkspace();
        const { prompt } = await composeStepSeed({
            input: input([planStep("T1S1")]),
            stepId: "T1S1",
            runId: RUN_ID,
            deps: deps(root),
        });

        expect(prompt).not.toContain("Data orientation");
        expect(prompt).toContain("QUESTION_T1S1");
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
            }),
        };

        expect((await composeStepSeed(args)).prompt).toBe((await composeStepSeed(args)).prompt);
    });

    it("bounds a pathological dependency summary to the excerpt budget", async () => {
        const root = await makeWorkspace();
        await writeStepSummary(root, "T1S1", "M".repeat(200_000));

        const { prompt } = await composeStepSeed({
            input: input([planStep("T1S1"), planStep("T1S2", ["T1S1"])]),
            stepId: "T1S2",
            runId: RUN_ID,
            deps: deps(root),
        });

        // A 200k-char summary must not become a 200k-char prompt: the seed carries
        // the gist and the PATH to the rest.
        expect(prompt.length).toBeLessThan(3_000);
        expect(prompt).toContain(`/${ANALYSIS_ID}/runs/${RUN_ID}/T1S1/output/summary.md`);
    });

    it("throws when the dispatched step carries no plan data", async () => {
        const root = await makeWorkspace();
        const bad: ExecuteAnalysisInput = { ...input([planStep("T1S1")]), planStepById: {} };

        await expect(composeStepSeed({ input: bad, stepId: "T1S1", runId: RUN_ID, deps: deps(root) })).rejects.toThrow(/missing from planStepById/);
    });
});

// ── The template contract and the binding ────────────────────────────

describe("composeStepSeed template contract", () => {
    const adaptableSlots = contractAnswer()
        .parameters.filter((slot) => slot.adaptable)
        .map((slot) => slot.name);

    it("renders the contract of a grounded step and binds the plan settings to its adaptable slots", async () => {
        const root = await makeWorkspace();
        const fake = fakeKnowledgeClient();

        const seed = await composeStepSeed({
            input: input([planStep("T1S2", [], grounded(SETTINGS))]),
            stepId: "T1S2",
            runId: RUN_ID,
            deps: deps(root, {}, fake.client),
        });

        // The contract was read for the reference of the plan, once.
        expect(fake.calls.contract).toEqual([{ template: TEMPLATE_REF }]);
        // Every adaptable slot with its permitted values, and not the pinned alpha.
        expect(seed.prompt).toContain("## Template contract");
        for (const name of adaptableSlots) expect(seed.prompt).toContain(`- \`${name}\` (`);
        expect(seed.prompt).toContain('"apeglm", "ashr", "none"');
        expect(seed.prompt).not.toContain("- `alpha` (");
        expect(seed.prompt).not.toContain("not retrieved");
        // The inputs of the template.
        expect(seed.prompt).toContain("`{{counts_path}}`");
        // The setting that names an adaptable slot is bound, with its source.
        expect(seed.prompt).toContain('`lfc_shrink` = "apeglm" (doi:10.1093/bioinformatics/bty895)');
        // The pinned slot at the plan value, and the name no slot carries, are unbound with the reason.
        expect(seed.prompt).toContain("`alpha` = 0.05 (differential_expression): pinned by the template at the same value");
        expect(seed.prompt).toContain('`inference` = "none" (enrichment): no slot of the template carries it');
        expect(seed.templateBinding).toEqual({
            template: TEMPLATE_REF,
            slots: { lfc_shrink: "apeglm" },
            sources: { lfc_shrink: "doi:10.1093/bioinformatics/bty895" },
        });
    });

    it("reports a plan value that differs from a pinned slot as a conflict, and binds it nowhere", async () => {
        const root = await makeWorkspace();
        const fake = fakeKnowledgeClient();

        const seed = await composeStepSeed({
            input: input([planStep("T1S2", [], grounded([{ step: "differential_expression", name: "alpha", value: 0.01 }]))]),
            stepId: "T1S2",
            runId: RUN_ID,
            deps: deps(root, {}, fake.client),
        });

        expect(seed.prompt).toContain("`alpha` = 0.01 (differential_expression): the template pins `alpha` at 0.05, and the plan value cannot be sent");
        expect(seed.prompt).not.toContain("Bound by the plan");
        expect(seed.templateBinding).toEqual({ template: TEMPLATE_REF, slots: {}, sources: {} });
    });

    it("binds the first value when two procedure steps set the same slot, and reports a later different value", async () => {
        const root = await makeWorkspace();
        const fake = fakeKnowledgeClient();

        const seed = await composeStepSeed({
            input: input([
                planStep(
                    "T1S2",
                    [],
                    grounded([
                        { step: "differential_expression", name: "min_count", value: 10 },
                        { step: "normalize", name: "min_count", value: 10 },
                        { step: "filter", name: "min_count", value: 5 },
                    ]),
                ),
            ]),
            stepId: "T1S2",
            runId: RUN_ID,
            deps: deps(root, {}, fake.client),
        });

        expect(seed.templateBinding?.slots).toEqual({ min_count: 10 });
        expect(seed.prompt).toContain("`min_count` = 5 (filter): differs from the bound value 10 of the same slot");
        expect(seed.prompt).not.toContain("`min_count` = 10 (normalize)");
    });

    it("says the contract was not retrieved when no client is bound, and renders no section", async () => {
        const root = await makeWorkspace();

        const seed = await composeStepSeed({
            input: input([planStep("T1S2", [], grounded(SETTINGS))]),
            stepId: "T1S2",
            runId: RUN_ID,
            deps: deps(root),
        });

        expect(seed.prompt).toContain("- Template contract: not retrieved (no knowledge client is bound)");
        expect(seed.prompt).not.toContain("## Template contract");
        expect(seed.templateBinding).toBeUndefined();
    });

    it("says the contract was not retrieved, with the reason, when the service does not answer", async () => {
        const root = await makeWorkspace();
        const fake = fakeKnowledgeClient({ contract: { match: "unavailable", reason: "connect ECONNREFUSED" } });

        const seed = await composeStepSeed({
            input: input([planStep("T1S2", [], grounded(SETTINGS))]),
            stepId: "T1S2",
            runId: RUN_ID,
            deps: deps(root, {}, fake.client),
        });

        expect(seed.prompt).toContain("- Template contract: not retrieved (the knowledge service did not answer: connect ECONNREFUSED)");
        expect(seed.prompt).not.toContain("## Template contract");
        expect(seed.templateBinding).toBeUndefined();
    });

    it("says the contract was not retrieved when the service does not hold the template", async () => {
        const root = await makeWorkspace();
        const fake = fakeKnowledgeClient({
            contract: { match: "rejected", message: "no such template", issues: [{ field: "template", message: "no such template" }] },
        });

        const seed = await composeStepSeed({
            input: input([planStep("T1S2", [], grounded(SETTINGS, "tpl-missing@1.0.0"))]),
            stepId: "T1S2",
            runId: RUN_ID,
            deps: deps(root, {}, fake.client),
        });

        expect(seed.prompt).toContain("- Template contract: not retrieved (the knowledge service refused the lookup: no such template)");
        expect(seed.templateBinding).toBeUndefined();
    });

    it("renders a served version that differs from the plan as a caveat, lists the settings as unbound, and binds nothing", async () => {
        const root = await makeWorkspace();
        const fake = fakeKnowledgeClient({ contract: { ...contractAnswer(), version: "1.1.0" } });

        const seed = await composeStepSeed({
            input: input([planStep("T1S2", [], grounded(SETTINGS))]),
            stepId: "T1S2",
            runId: RUN_ID,
            deps: deps(root, {}, fake.client),
        });

        expect(seed.prompt).toContain("## Template contract");
        expect(seed.prompt).toContain("the plan names version 1.0.0, and the service serves version 1.1.0");
        expect(seed.prompt).toContain('`lfc_shrink` = "apeglm" (differential_expression): not bound, because the served version differs from the plan');
        expect(seed.prompt).not.toContain("Bound by the plan");
        expect(seed.templateBinding).toBeUndefined();
    });

    it("fetches no contract for a step whose grounding names no template", async () => {
        const root = await makeWorkspace();
        const fake = fakeKnowledgeClient();

        const seed = await composeStepSeed({
            input: input([planStep("T1S2", [], grounded(SETTINGS, null))]),
            stepId: "T1S2",
            runId: RUN_ID,
            deps: deps(root, {}, fake.client),
        });

        expect(fake.calls.contract).toEqual([]);
        expect(seed.prompt).not.toContain("Template contract");
        expect(seed.templateBinding).toBeUndefined();
    });

    it("recomposes byte-identically with the contract in the seed (replay stability)", async () => {
        const root = await makeWorkspace();
        await writeStepSummary(root, "T1S1", "# QC\n\nSix samples pass.");
        const args = {
            input: input([planStep("T1S1"), planStep("T1S2", ["T1S1"], grounded(SETTINGS))]),
            stepId: "T1S2",
            runId: RUN_ID,
            deps: deps(root, { profile: PROFILE }, fakeKnowledgeClient().client),
        };

        const first = await composeStepSeed(args);
        const second = await composeStepSeed(args);
        expect(first.prompt).toBe(second.prompt);
        expect(first.templateBinding).toEqual(second.templateBinding);
    });
});
