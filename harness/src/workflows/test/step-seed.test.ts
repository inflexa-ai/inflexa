/**
 * `composeStepSeed` — the dispatch-time seed composition.
 *
 * These tests drive the composer directly (it is a plain async function; the
 * parent wraps it in a `DBOS.runStep`, which is what makes its output
 * replay-stable). They assert on the composed STRING against real durable
 * state: a summary written to the run tree, artifact rows in the fake ledger,
 * a persisted data profile, and a working-memory row read through the real store.
 */

import { makeFakeWorkspaceFs } from "../../agents/sandbox/__fixtures__/deps.js";
import { createSynthesisLookupTools } from "../../tools/research/synthesis-lookups.js";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { okAsync } from "neverthrow";

import { makeLocalAuth } from "../../auth/local-auth-context.js";
import { createNoopRunCharge } from "../../billing/noop-run-charge.js";
import { unusedCitationResolver } from "../../citations/__fixtures__/resolver.js";
import { createWorkingMemory, type WorkingMemory } from "../../memory/working-memory.js";
import { unusedChatProvider } from "../../providers/__fixtures__/chat-provider.js";
import { ANALYSIS_MEMORY_HEADING } from "../../prompts/briefing.js";
import type { DataProfileResult } from "../../state/data-profile.js";
import type { AnalysisStep } from "../../schemas/workflow-state.js";
import type { KnowledgeClient } from "../../tools/knowledge/client.js";
import { contractAnswer, fakeKnowledgeClient } from "../../tools/knowledge/__fixtures__/fake-client.js";
import { composeStepSeed } from "../execute-analysis.js";
import type { ExecuteAnalysisDeps, ExecuteAnalysisInput } from "../execute-analysis.js";
import { scriptSha256 } from "../../tools/workspace/decision-record.js";
import { stepDecisionRecordDir } from "../../workspace/paths.js";

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

type FakeState = {
    /** `cortex_analysis_state.data_profile_result` for this analysis. */
    readonly profile?: DataProfileResult;
    /** `cortex_artifacts` step-output rows, keyed by step id. */
    readonly artifactsByStep?: Record<string, Array<{ path: string; file_type: string | null }>>;
    /** `cortex_working_memory.data` for this analysis. A mutable holder, thus a test can edit it between two dispatches. */
    readonly memory?: { current: WorkingMemory | undefined };
    /** Make the working-memory read fail at the driver. */
    readonly memoryReadFails?: boolean;
};

function fakePool(state: FakeState): Pool {
    // The state queries pass a config object; the working-memory store passes the text and the values apart.
    const query = (config: string | { text: string; values?: readonly unknown[] }, values?: readonly unknown[]) => {
        const q = typeof config === "string" ? { text: config, values } : config;
        const text = q.text.trim();
        if (text.startsWith("SELECT data_profile_status")) {
            if (!state.profile) return Promise.resolve({ rows: [], rowCount: 0 });
            return Promise.resolve({
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
            });
        }
        if (text.startsWith("SELECT data FROM cortex_working_memory")) {
            if (state.memoryReadFails) return Promise.reject(new Error("connection refused"));
            const data = state.memory?.current;
            return Promise.resolve(data ? { rows: [{ data }], rowCount: 1 } : { rows: [], rowCount: 0 });
        }
        if (text.startsWith("SELECT path, file_type")) {
            const stepId = q.values?.[2];
            const limit = q.values?.[3];
            if (typeof stepId !== "string" || typeof limit !== "number")
                return Promise.reject(new Error(`unexpected artifact-list query values: ${JSON.stringify(q.values)}`));
            const rows = (state.artifactsByStep?.[stepId] ?? []).slice(0, limit);
            return Promise.resolve({ rows, rowCount: rows.length });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
    };
    return Object.assign(new Pool(), { query });
}

function deps(workspaceRoot: string, state: FakeState = {}, knowledge?: KnowledgeClient): ExecuteAnalysisDeps {
    const pool = fakePool(state);
    return {
        pool,
        provider: unusedChatProvider(),
        embedding: { dimensions: 3, embed: (texts) => okAsync(texts.map(() => [0, 0, 0])) },
        sandboxStepCallable: () => {
            return Promise.reject(new Error("sandboxStepCallable should not be invoked in the seed tests"));
        },
        resolveWorkspaceRoot: () => Promise.resolve(workspaceRoot),
        workspaceFs: makeFakeWorkspaceFs(),
        synthesisModel: "test-synthesis-model",
        synthesisLookups: createSynthesisLookupTools({ bioKeys: { drugbank: "", disgenet: "", epaCcte: "" }, citationResolver: unusedCitationResolver }),
        runCharge: createNoopRunCharge(),
        runAuthorizer: {
            authorize() {
                throw new Error("runAuthorizer.authorize not exercised in the seed tests");
            },
            revoke() {
                throw new Error("runAuthorizer.revoke not exercised in the seed tests");
            },
            revokeByMandateId() {
                throw new Error("runAuthorizer.revokeByMandateId not exercised in the seed tests");
            },
            suspend: () => okAsync(undefined),
            renew: () => okAsync(undefined),
        },
        workingMemory: createWorkingMemory(pool),
        knowledge,
    };
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
        agent: "analyst",
        maxSteps: 10,
        grounding,
    };
}

const TEMPLATE_REF = "tpl-deseq2-two-group@1.0.0";

/** The part of every binding that comes from the grounding and the contract, not from the settings. */
const BINDING_BASE = {
    template: TEMPLATE_REF,
    step: "T1S2",
    claims: ["R-0001@e7d0"],
    snapshot: "sha256:71ac",
    local: contractAnswer().parameters.filter((slot) => slot.local === true),
    adaptable: contractAnswer()
        .parameters.filter((slot) => slot.adaptable)
        .map((slot) => slot.name),
};

/** A grounding on the two-group template with the settings of the procedure: one adaptable slot, one pinned slot, one name no slot carries. */
function grounded(settings: NonNullable<AnalysisStep["grounding"]>["settings"], template: string | null = TEMPLATE_REF): AnalysisStep["grounding"] {
    return {
        status: "grounded",
        snapshot: "sha256:71ac",
        claims: ["R-0001@e7d0"],
        template: template ?? undefined,
        settings,
        reason: "DESeq2 Wald per R-0001@e7d0",
    };
}

/** A grounding of {@link grounded} with the departures of the plan. */
function departed(grounding: AnalysisStep["grounding"], departures: NonNullable<AnalysisStep["grounding"]>["departures"]): AnalysisStep["grounding"] {
    if (grounding === undefined) throw new Error("the step has no grounding");
    return { ...grounding, departures };
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
        expect(seed.prompt).toContain("analyst");
        expect(seed.prompt).toContain(`/${ANALYSIS_ID}/runs/${RUN_ID}/T1S1/output`);
        expect(seed.prompt).toContain(`/${ANALYSIS_ID}/runs/${RUN_ID}/T1S1/output/summary.md`);
        expect(seed.prompt).toContain(`/${ANALYSIS_ID}/runs/${RUN_ID}/T1S1/output/de.csv`);
        // And its own task + working directory.
        expect(seed.prompt).toContain("QUESTION_T1S2");
        expect(seed.prompt).toContain(`/${ANALYSIS_ID}/runs/${RUN_ID}/T1S2`);
        // An ungrounded step binds nothing.
        expect(seed.templateBinding).toBeUndefined();
    });

    it("carries the request of the plan into the seed of each step", async () => {
        const root = await makeWorkspace();
        const request = "Write `answer.json` with `verdict` one of `answer`, `insufficient`.";

        const { prompt } = await composeStepSeed({
            input: { ...input([planStep("T1S1")]), request },
            stepId: "T1S1",
            runId: RUN_ID,
            deps: deps(root),
        });

        expect(prompt).toContain("## The request of the analysis");
        expect(prompt).toContain(request);
    });

    it("carries the title of each claim of the step, and no view of another snapshot or of another step", async () => {
        const root = await makeWorkspace();
        const view = (id: string, snapshot: string, title: string) => ({
            id,
            snapshot,
            title,
            statement: `The statement of ${id}`,
            strength: "consensus",
            evidence: [],
        });

        const { prompt } = await composeStepSeed({
            input: {
                ...input([planStep("T1S2", [], grounded(SETTINGS, null))]),
                claims: [
                    view("R-0001@e7d0", "sha256:9999", "A view of another release"),
                    view("R-0001@e7d0", "sha256:71ac", "The title of R-0001"),
                    view("R-0002@e7d0", "sha256:71ac", "A claim of another step"),
                ],
            },
            stepId: "T1S2",
            runId: RUN_ID,
            deps: deps(root),
        });

        expect(prompt).toContain("  - R-0001@e7d0 (consensus): The title of R-0001");
        expect(prompt).not.toContain("A view of another release");
        expect(prompt).not.toContain("A claim of another step");
    });

    it("carries the methods of a grounded dependency and the paths of its decision records into the downstream seed", async () => {
        const root = await makeWorkspace();
        await writeStepSummary(root, "T1S1", "# DE results");
        const recordDir = stepDecisionRecordDir({ workspaceRoot: root, runId: RUN_ID, stepId: "T1S1" });
        await mkdir(recordDir, { recursive: true });
        await writeFile(
            join(recordDir, "decision_record_tpl-deseq2-two-group_A.json"),
            JSON.stringify({
                template: { id: "tpl-deseq2-two-group", version: "1.0.0", label: "DESeq2", method: { id: "M-0008", label: "DESeq2 Wald test" } },
                citations: [{ doi: "10.1186/s13059-014-0550-8", title: "DESeq2", year: 2014 }],
            }),
            "utf8",
        );

        const { prompt } = await composeStepSeed({
            input: {
                ...input([planStep("T1S1", [], grounded(SETTINGS)), planStep("T1S3", ["T1S1"])]),
                claims: [{ id: "R-0001@e7d0", snapshot: "sha256:71ac", title: "Shrink the effect sizes", statement: "s", strength: "consensus", evidence: [] }],
            },
            stepId: "T1S3",
            runId: RUN_ID,
            deps: deps(root),
        });

        expect(prompt).toContain("- Grounding: grounded, knowledge release `sha256:71ac`");
        expect(prompt).toContain("- Template `tpl-deseq2-two-group@1.0.0`: method M-0008, DESeq2 Wald test");
        expect(prompt).toContain("- Rules: `R-0001@e7d0` Shrink the effect sizes");
        expect(prompt).toContain("- Sources: DESeq2 (2014), doi:10.1186/s13059-014-0550-8");
        expect(prompt).toContain(`- Decision records: \`/${ANALYSIS_ID}/runs/${RUN_ID}/T1S1/output/decision_record_tpl-deseq2-two-group_A.json\``);
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

    it("carries the goal and each constraint with its origin, and leaves out the hypotheses and the findings", async () => {
        const root = await makeWorkspace();
        const { prompt: seed } = await composeStepSeed({
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
        const { prompt: seed } = await composeStepSeed({ input: input([planStep("T1S1")]), stepId: "T1S1", runId: RUN_ID, deps: deps(root) });

        expect(seed).not.toContain("Analysis memory");
        expect(seed).toContain("QUESTION_T1S1");
    });

    it("reads the memory at each dispatch, thus a later step sees an edit made during the run", async () => {
        const root = await makeWorkspace();
        const memory = { current: memoryRow() };
        const stepDeps = deps(root, { memory });
        const runInput = input([planStep("T1S1"), planStep("T1S2")]);

        const { prompt: first } = await composeStepSeed({ input: runInput, stepId: "T1S1", runId: RUN_ID, deps: stepDeps });
        memory.current = memoryRow({ constraints: [{ id: "c3", text: "EDITED_RULE", origin: "user" }] });
        const { prompt: second } = await composeStepSeed({ input: runInput, stepId: "T1S2", runId: RUN_ID, deps: stepDeps });

        expect(first).toContain("USER_RULE");
        expect(first).not.toContain("EDITED_RULE");
        expect(second).toContain("EDITED_RULE");
        expect(second).not.toContain("USER_RULE");
    });

    it("leaves the memory section out when the working-memory read fails", async () => {
        const root = await makeWorkspace();
        const { prompt: seed } = await composeStepSeed({
            input: input([planStep("T1S1")]),
            stepId: "T1S1",
            runId: RUN_ID,
            deps: deps(root, { memoryReadFails: true }),
        });
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

        await expect(composeStepSeed({ input: bad, stepId: "T1S1", runId: RUN_ID, deps: deps(root) })).rejects.toThrow("missing from planStepById");
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
        // The script reads the pinned slot at the plan value, thus the setting needs no act of the agent.
        expect(seed.prompt).toContain(
            "Done by the script (the plan states them, and the script does them with no slot or with a pinned slot; send no value for them):\n" +
                "- `alpha` = 0.05 (differential_expression; doi:10.1186/s13059-014-0550-8): pinned by the template at the same value",
        );
        // The name that no slot carries is unbound with the reason, and the pinned setting is not in that list.
        expect(seed.prompt).toContain(
            'Unbound settings (the plan states them, and no bound slot carries them):\n- `inference` = "none" (enrichment): no slot of the template carries it',
        );
        expect(seed.templateBinding).toEqual({
            ...BINDING_BASE,
            slots: { lfc_shrink: "apeglm" },
            sources: { lfc_shrink: "doi:10.1093/bioinformatics/bty895" },
        });
        // The local slots are marked in the section, thus the agent knows which values never leave the machine.
        expect(seed.prompt).toContain("- `counts_path` (string; local; required)");
    });

    it("carries the notes of the served contract into the Template contract section", async () => {
        const root = await makeWorkspace();
        const fake = fakeKnowledgeClient({
            contract: { ...contractAnswer(), notes: "  The condition column is renamed to `condition` inside the script.  " },
        });

        const seed = await composeStepSeed({
            input: input([planStep("T1S2", [], grounded(SETTINGS))]),
            stepId: "T1S2",
            runId: RUN_ID,
            deps: deps(root, {}, fake.client),
        });

        expect(seed.prompt).toContain(
            "Notes of the template (the input requirements of the script):\nThe condition column is renamed to `condition` inside the script.\n",
        );
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
        expect(seed.templateBinding).toEqual({ ...BINDING_BASE, slots: {}, sources: {} });
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

    it("binds a number to a number slot, and leaves a policy word of the plan unbound with the reason", async () => {
        const root = await makeWorkspace();
        const fake = fakeKnowledgeClient();

        const seed = await composeStepSeed({
            input: input([
                planStep(
                    "T1S2",
                    [],
                    grounded([
                        { step: "filter_low_counts", name: "min_samples", value: "smallest_group_size" },
                        { step: "filter_low_counts", name: "min_count", value: 10, source: "doi:10.12688/f1000research.7035.1" },
                    ]),
                ),
            ]),
            stepId: "T1S2",
            runId: RUN_ID,
            deps: deps(root, {}, fake.client),
        });

        // The integer binds; the policy word stays with the agent, which states the integer it gives.
        expect(seed.prompt).toContain("`min_count` = 10 (doi:10.12688/f1000research.7035.1)");
        expect(seed.prompt).toContain(
            '`min_samples` = "smallest_group_size" (filter_low_counts): a policy of the plan, not a value of the `min_samples` slot (integer)',
        );
        expect(seed.templateBinding).toEqual({
            ...BINDING_BASE,
            slots: { min_count: 10 },
            sources: { min_count: "doi:10.12688/f1000research.7035.1" },
        });
    });

    it("binds the value of a departure in place of the value of the rule, and names the departure as its source", async () => {
        const root = await makeWorkspace();
        const fake = fakeKnowledgeClient();
        const departure = { rule: "R-0001@e7d0", setting: "min_count", value: 5, reason: "the panel holds 364 targets" };

        const seed = await composeStepSeed({
            input: input([
                planStep(
                    "T1S2",
                    [],
                    departed(grounded([{ step: "filter_low_counts", name: "min_count", value: 10, source: "doi:10.12688/f1000research.7035.1" }]), [departure]),
                ),
            ]),
            stepId: "T1S2",
            runId: RUN_ID,
            deps: deps(root, {}, fake.client),
        });

        expect(seed.templateBinding).toEqual({
            ...BINDING_BASE,
            slots: { min_count: 5 },
            sources: { min_count: "departure from R-0001@e7d0" },
            departures: [departure],
        });
        expect(seed.prompt).toContain("`min_count` = 5 (departure from R-0001@e7d0)");
        expect(seed.prompt).toContain("  - R-0001@e7d0: `min_count` = 5. the panel holds 364 targets");
        expect(seed.prompt).not.toContain("`min_count` = 10");
    });

    describe("a slot that takes the value of the reported fit", () => {
        const FIT = { id: "tpl-fit", version: "2.0.0", label: "The fit", method: { id: "M-0008", label: "A count model" } };
        const FIT_SLOTS = [
            { name: "min_count", value: 5, source: "caller", adaptable: true, lines: [3] },
            { name: "lfc_shrink", value: "ashr", source: "caller", adaptable: true, lines: [4] },
            { name: "condition_column", value: "arm", source: "caller", adaptable: true, lines: [5] },
            { name: "counts_path", value: "data/counts.csv", source: "caller", adaptable: true, lines: [1] },
            // A slot that the fit did not read has no value in its record.
            { name: "min_samples", source: "default", adaptable: true, lines: [6] },
        ];
        const SOURCE = "the reported fit of T1S1 (tpl-fit@2.0.0)";
        const carriedContract = (bind = ["min_count", "lfc_shrink", "condition_column", "min_samples"]) => ({
            ...contractAnswer(),
            carried_slots: { from_templates: ["tpl-fit"], bind, show: ["counts_path"] },
        });
        const SCRIPT = "min_count <- 5\n";
        // The record names its script and the digest of the bytes that the render wrote.
        const RENDERED_NO_RUN = { script_path: "/an-1/runs/run-1/T1S1/scripts/tpl-fit.R", written_sha256: scriptSha256(SCRIPT) };
        // The record also holds the run of those bytes, as `execute_command` writes it.
        const RENDERED = { ...RENDERED_NO_RUN, runs: [{ exit_code: 0, sha256: scriptSha256(SCRIPT) }] };
        const writeScript = async (root: string, content: string) => {
            const dir = join(root, "runs", RUN_ID, "T1S1", "scripts");
            await mkdir(dir, { recursive: true });
            await writeFile(join(dir, "tpl-fit.R"), content, "utf8");
        };
        const writeRecord = async (root: string, stepId: string, file: string, record: unknown) => {
            const recordDir = stepDecisionRecordDir({ workspaceRoot: root, runId: RUN_ID, stepId });
            await mkdir(recordDir, { recursive: true });
            await writeFile(join(recordDir, file), JSON.stringify(record), "utf8");
        };
        const compose = async (
            records: readonly { readonly file: string; readonly record: unknown }[],
            grounding: AnalysisStep["grounding"] = grounded([]),
            contract: ReturnType<typeof contractAnswer> = carriedContract(),
            script: string | null = SCRIPT,
        ) => {
            const root = await makeWorkspace();
            for (const entry of records) await writeRecord(root, "T1S1", entry.file, entry.record);
            if (script !== null) await writeScript(root, script);
            const fake = fakeKnowledgeClient({ contract });
            return composeStepSeed({
                input: input([planStep("T1S1"), planStep("T1S2", ["T1S1"], grounding)]),
                stepId: "T1S2",
                runId: RUN_ID,
                deps: deps(root, {}, fake.client),
            });
        };
        const ONE = [{ file: "decision_record_tpl-fit.R.json", record: { template: FIT, slots: FIT_SLOTS, ...RENDERED } }];
        const CARRIED = { min_count: 5, lfc_shrink: "ashr", condition_column: "arm" };
        const CARRIED_SOURCES = { min_count: SOURCE, lfc_shrink: SOURCE, condition_column: SOURCE };

        it("binds each carried slot to the value in the record of the fit, a local slot also, and shows a path", async () => {
            const seed = await compose(ONE);
            // min_samples has no value in the record, thus the default of this template holds and nothing binds.
            expect(seed.templateBinding).toEqual({ ...BINDING_BASE, slots: CARRIED, sources: CARRIED_SOURCES });
            expect(seed.prompt).toContain(`\`min_count\` = 5 (${SOURCE})`);
            expect(seed.prompt).toContain(`\`condition_column\` = "arm" (${SOURCE})`);
            // A path is a fact of the step that wrote it: the seed shows it, and the binding does not hold it.
            expect(seed.prompt).toContain(`Values of ${SOURCE} that are not bound`);
            expect(seed.prompt).toContain('- `counts_path` = "data/counts.csv"');
            expect(seed.templateBinding?.slots).not.toHaveProperty("counts_path");
        });

        it("binds nothing from the record of the fit when the service does not answer or no client is bound", async () => {
            // A grounded plan of an earlier session, and the service is not there at the run. The record of the
            // fit is on disk, and the step must start with no binding and no value of the fit.
            for (const client of [fakeKnowledgeClient({ contract: { match: "unavailable", reason: "connect ECONNREFUSED" } }).client, undefined]) {
                const root = await makeWorkspace();
                await writeRecord(root, "T1S1", "decision_record_tpl-fit.R.json", { template: FIT, slots: FIT_SLOTS, ...RENDERED });
                await writeScript(root, SCRIPT);
                const seed = await composeStepSeed({
                    input: input([planStep("T1S1"), planStep("T1S2", ["T1S1"], grounded(SETTINGS))]),
                    stepId: "T1S2",
                    runId: RUN_ID,
                    deps: deps(root, {}, client),
                });
                expect(seed.templateBinding).toBeUndefined();
                expect(seed.prompt).toContain("- Template contract: not retrieved (");
                expect(seed.prompt).not.toContain("## Template contract");
                expect(seed.prompt).not.toContain("reported fit");
            }
        });

        it("binds nothing from a record with no run of the rendered script that ended with exit code 0", async () => {
            const NOTE = "holds no run of its rendered script that ended with exit code 0";
            const cases: readonly Record<string, unknown>[] = [
                // A render that never ran, and a record of an older version.
                RENDERED_NO_RUN,
                // A run that failed, and a run that the sandbox ended.
                { ...RENDERED_NO_RUN, runs: [{ exit_code: 1, sha256: scriptSha256(SCRIPT) }] },
                { ...RENDERED_NO_RUN, runs: [{ exit_code: null, sha256: scriptSha256(SCRIPT) }] },
                // A run of different bytes.
                { ...RENDERED_NO_RUN, runs: [{ exit_code: 0, sha256: scriptSha256("min_count <- 9\n") }] },
                // A list of a different shape reads as no run, and the record stays a record.
                { ...RENDERED_NO_RUN, runs: "yes" },
            ];
            for (const rendered of cases) {
                const seed = await compose([{ file: "decision_record_tpl-fit.R.json", record: { template: FIT, slots: FIT_SLOTS, ...rendered } }]);
                expect(seed.templateBinding, JSON.stringify(rendered)).toEqual({ ...BINDING_BASE, slots: {}, sources: {} });
                expect(seed.prompt).toContain(NOTE);
            }
        });

        it("binds from a record with one good run among failed runs", async () => {
            const runs = [
                { exit_code: 1, sha256: scriptSha256(SCRIPT) },
                { exit_code: 0, sha256: scriptSha256(SCRIPT) },
                { exit_code: 137, sha256: scriptSha256(SCRIPT) },
            ];
            const seed = await compose([{ file: "decision_record_tpl-fit.R.json", record: { template: FIT, slots: FIT_SLOTS, ...RENDERED_NO_RUN, runs } }]);
            expect(seed.templateBinding).toEqual({ ...BINDING_BASE, slots: CARRIED, sources: CARRIED_SOURCES });
        });

        it("keeps the value of the fit when a plan setting of the step gives a different value", async () => {
            const own = { step: "sensitivity_fits", name: "min_count", value: 10, source: "doi:10.12688/f1000research.7035.1" };
            const same = { step: "sensitivity_fits", name: "lfc_shrink", value: "ashr" };
            const seed = await compose(ONE, grounded([own, same]));
            expect(seed.templateBinding).toEqual({ ...BINDING_BASE, slots: CARRIED, sources: CARRIED_SOURCES });
            expect(seed.prompt).toContain(
                "`min_count` = 10 (sensitivity_fits; doi:10.12688/f1000research.7035.1): differs from the bound value 5 of the same slot",
            );
            expect(seed.prompt).not.toContain('`lfc_shrink` = "ashr" (sensitivity_fits)');
        });

        it("does not bind a plan setting of a carried slot that the fit read no value for: the default of the template holds", async () => {
            const own = { step: "sensitivity_fits", name: "min_samples", value: 3 };
            const seed = await compose(ONE, grounded([own]));
            expect(seed.templateBinding).toEqual({ ...BINDING_BASE, slots: CARRIED, sources: CARRIED_SOURCES });
            expect(seed.prompt).toContain(
                "`min_samples` = 3 (sensitivity_fits): the reported fit read no value for the slot `min_samples`, thus the default of the template holds",
            );
        });

        it("does not bind a plan setting of a slot whose value of the fit the seed shows", async () => {
            // The agent sends the shown value. A bound plan value would refuse it at the render with no override.
            const contract = { ...contractAnswer(), carried_slots: { from_templates: ["tpl-fit"], bind: ["lfc_shrink"], show: ["min_count"] } };
            const own = { step: "sensitivity_fits", name: "min_count", value: 10 };
            const seed = await compose(ONE, grounded([own]), contract);
            expect(seed.templateBinding).toEqual({ ...BINDING_BASE, slots: { lfc_shrink: "ashr" }, sources: { lfc_shrink: SOURCE } });
            expect(seed.prompt).toContain("- `min_count` = 5");
            expect(seed.prompt).toContain(
                "`min_count` = 10 (sensitivity_fits): the slot `min_count` takes the value that the reported fit used, which the seed shows",
            );
        });

        it("keeps the exclusion of a slot that a mapped setting binds: only a value of the fit stays under a departure", async () => {
            const policy = { step: "filter_low_counts", name: "depth_policy", value: "low_depth_panel" };
            const own = { step: "filter_low_counts", name: "min_count", value: 10 };
            const removed = { rule: "R-0001@e7d0", setting: "min_count", reason: "the plan keeps each gene" };
            const contract = {
                ...contractAnswer(),
                setting_bindings: [{ setting: "depth_policy", value: "low_depth_panel", slot: "min_count", slot_value: 5 }],
            };
            const seed = await compose([], departed(grounded([policy, own]), [removed]), contract);
            expect(seed.templateBinding?.excluded).toEqual(["min_count"]);
        });

        it("does not exclude a carried slot that a departure of the step removes", async () => {
            const own = { step: "sensitivity_fits", name: "min_count", value: 10 };
            const removed = { rule: "R-0001@e7d0", setting: "min_count", reason: "the plan keeps each gene" };
            const seed = await compose(ONE, departed(grounded([own]), [removed]));
            expect(seed.templateBinding).toEqual({ ...BINDING_BASE, slots: CARRIED, sources: CARRIED_SOURCES, departures: [removed] });
            expect(seed.prompt).toContain("but the slot takes the value 5 of the reported fit");
        });

        it("binds nothing with no record of a named template, and the seed gives the reason", async () => {
            const other = [{ file: "decision_record_tpl-other.R.json", record: { template: { ...FIT, id: "tpl-other" }, slots: FIT_SLOTS } }];
            for (const records of [[], other]) {
                const seed = await compose(records);
                expect(seed.templateBinding).toEqual({ ...BINDING_BASE, slots: {}, sources: {} });
                expect(seed.prompt).toContain("Values of the reported fit: no step that this step depends on holds a decision record of `tpl-fit`");
            }
        });

        it("does not bind a plan setting of a carried slot when the host found no record of the fit", async () => {
            // A plan value is not the value that the fit used. A bound plan value would refuse the value of the fit at the render.
            const own = { step: "sensitivity_fits", name: "min_count", value: 10 };
            const seed = await compose([], grounded([own]));
            expect(seed.templateBinding).toEqual({ ...BINDING_BASE, slots: {}, sources: {} });
            expect(seed.prompt).toContain(
                "`min_count` = 10 (sensitivity_fits): the slot `min_count` takes the value that the reported fit used, and the host holds no valid value of it",
            );
        });

        it("binds nothing with two records of the fit: the host cannot tell which fit the step reports", async () => {
            const two = [...ONE, { file: "decision_record_tpl-fit_B.R.json", record: { template: FIT, slots: [{ name: "min_count", value: 1 }] } }];
            const seed = await compose(two);
            expect(seed.templateBinding).toEqual({ ...BINDING_BASE, slots: {}, sources: {} });
            expect(seed.prompt).toContain("2 decision records of `tpl-fit` are in the steps that this step depends on");
            expect(seed.prompt).toContain("T1S1: output/decision_record_tpl-fit.R.json, T1S1: output/decision_record_tpl-fit_B.R.json");
        });

        it("binds nothing when the script of the fit changed after its render: the record does not prove the values that ran", async () => {
            const edited = [
                {
                    file: "decision_record_tpl-fit.R.json",
                    record: { template: FIT, slots: FIT_SLOTS, ...RENDERED, unvetted_edits: [{ sha256: "ab12", tool: "edit_file" }] },
                },
            ];
            const seed = await compose(edited);
            expect(seed.templateBinding).toEqual({ ...BINDING_BASE, slots: {}, sources: {} });
            const NOTE =
                "Values of the reported fit: the script of the reported fit is not the script that its render wrote (the record is T1S1: output/decision_record_tpl-fit.R.json)";
            expect(seed.prompt).toContain(NOTE);
            // A shell command can write the script, and the record then lists no change. The digest of the bytes
            // on disk tells: a different script, an absent script, and a record with no digest bind nothing.
            for (const script of ["min_count <- 10\n", null]) {
                const changed = await compose(ONE, grounded([]), carriedContract(), script);
                expect(changed.templateBinding).toEqual({ ...BINDING_BASE, slots: {}, sources: {} });
                expect(changed.prompt).toContain(NOTE);
            }
            const noDigest = await compose([{ file: "decision_record_tpl-fit.R.json", record: { template: FIT, slots: FIT_SLOTS } }]);
            expect(noDigest.templateBinding).toEqual({ ...BINDING_BASE, slots: {}, sources: {} });
            expect(seed.prompt).not.toContain("that are not bound");
        });

        it("binds nothing when the host did not read each record of a dependency: a record that it left out can be a second fit", async () => {
            // A file that does not parse is left out of the read, and so is each file past the bound of the read.
            const broken = [...ONE, { file: "decision_record_tpl-fit_B.R.json", record: { template: "not a template" } }];
            const seed = await compose(broken);
            expect(seed.templateBinding).toEqual({ ...BINDING_BASE, slots: {}, sources: {} });
            expect(seed.prompt).toContain("Values of the reported fit: the host did not read each decision record of T1S1");
            const many = Array.from({ length: 17 }, (_, index) => ({
                file: `decision_record_a${String(index).padStart(2, "0")}.R.json`,
                record: { template: { ...FIT, id: index === 0 ? "tpl-fit" : "tpl-other" }, slots: FIT_SLOTS },
            }));
            const truncated = await compose(many);
            expect(truncated.templateBinding).toEqual({ ...BINDING_BASE, slots: {}, sources: {} });
            expect(truncated.prompt).toContain("the host did not read each decision record of T1S1");
        });

        it("does not bind a value that the slot of this template does not take, and lists it with the reason", async () => {
            const bad = [
                {
                    file: "decision_record_tpl-fit.R.json",
                    record: {
                        template: FIT,
                        ...RENDERED,
                        slots: [
                            { name: "min_count", value: -1 },
                            { name: "lfc_shrink", value: "other" },
                        ],
                    },
                },
            ];
            const seed = await compose(bad);
            expect(seed.templateBinding).toEqual({ ...BINDING_BASE, slots: {}, sources: {} });
            expect(seed.prompt).toContain(`\`min_count\` = -1 (${SOURCE}): the slot of this template does not take it (the value must be at least 0)`);
            expect(seed.prompt).toContain(`\`lfc_shrink\` = "other" (${SOURCE}): the slot of this template does not take it`);
            // A plan value does not take the place of a value of the fit that the slot refuses.
            const own = { step: "sensitivity_fits", name: "min_count", value: 10 };
            const withPlan = await compose(bad, grounded([own]));
            expect(withPlan.templateBinding).toEqual({ ...BINDING_BASE, slots: {}, sources: {} });
            expect(withPlan.prompt).toContain(
                "`min_count` = 10 (sensitivity_fits): the slot `min_count` takes the value that the reported fit used, and the host holds no valid value of it",
            );
        });

        it("reads no record for a contract with no carried slot, and binds nothing when the served version differs", async () => {
            const plain = await compose(ONE, grounded([]), contractAnswer());
            expect(plain.templateBinding).toEqual({ ...BINDING_BASE, slots: {}, sources: {} });
            expect(plain.prompt).not.toContain("reported fit");
            const moved = await compose(ONE, grounded([]), { ...carriedContract(), version: "9.9.9" });
            expect(moved.templateBinding).toBeUndefined();
            expect(moved.prompt).not.toContain("reported fit");
        });
    });

    describe("a setting that the script of the template does with no slot", () => {
        const ADJUSTMENT = { step: "multiple_testing", name: "adjustment", value: "BH", source: "rule:R-0003" } as const;
        const doneContract = (entries: { setting: string; value: string | number | boolean }[] = [{ setting: "adjustment", value: "BH" }]) => ({
            ...contractAnswer(),
            settings_by_construction: entries,
        });
        const compose = async (grounding: AnalysisStep["grounding"], contract: ReturnType<typeof contractAnswer> = doneContract()) => {
            const root = await makeWorkspace();
            const fake = fakeKnowledgeClient({ contract });
            return composeStepSeed({ input: input([planStep("T1S2", [], grounding)]), stepId: "T1S2", runId: RUN_ID, deps: deps(root, {}, fake.client) });
        };
        const DONE = "Done by the script (the plan states them, and the script does them with no slot or with a pinned slot; send no value for them):";
        const LINE = '`adjustment` = "BH" (multiple_testing; rule:R-0003)';

        it("lists the setting as done by the script, binds no slot, and does not list it as unbound", async () => {
            const seed = await compose(grounded([ADJUSTMENT]));
            // The decision record holds only what the script reads, thus the binding holds no slot and no source.
            expect(seed.templateBinding).toEqual({ ...BINDING_BASE, slots: {}, sources: {} });
            expect(seed.prompt).toContain(`${DONE}\n- ${LINE}`);
            expect(seed.prompt).not.toContain("no slot of the template carries it");
            expect(seed.prompt).not.toContain("Unbound settings");
        });

        it("lists the setting as unbound with no entry of the contract", async () => {
            const seed = await compose(grounded([ADJUSTMENT]), contractAnswer());
            expect(seed.prompt).toContain(`${LINE}: no slot of the template carries it`);
            expect(seed.prompt).not.toContain("Done by the script");
        });

        it("reports a different plan value as a conflict: no slot can send it", async () => {
            const changed = { rule: "R-0003@bb22", setting: "adjustment", value: "bonferroni", reason: "the plan controls the family-wise error rate" };
            const seed = await compose(departed(grounded([ADJUSTMENT]), [changed]));
            expect(seed.templateBinding).toEqual({ ...BINDING_BASE, slots: {}, sources: {}, departures: [changed] });
            expect(seed.prompt).toContain('the script of the template does `adjustment` = "BH" with no slot, and the plan value cannot be sent');
            expect(seed.prompt).not.toContain("Done by the script");
        });

        it("reports a setting that the plan removes: the script does it with no slot, and the binding excludes no slot", async () => {
            const removed = { rule: "R-0003@bb22", setting: "adjustment", reason: "the plan reports the raw p-values" };
            const seed = await compose(departed(grounded([ADJUSTMENT]), [removed]));
            expect(seed.templateBinding).toEqual({ ...BINDING_BASE, slots: {}, sources: {}, departures: [removed] });
            expect(seed.prompt).toContain(
                'the plan departs from R-0003@bb22 and does not apply it (the plan reports the raw p-values), but the script of the template does `adjustment` = "BH" with no slot',
            );
            expect(seed.prompt).not.toContain("Done by the script");
        });

        it("matches a boolean of the contract against the value of the plan", async () => {
            const filtering = { step: "multiple_testing", name: "independent_filtering", value: true };
            const seed = await compose(grounded([filtering]), doneContract([{ setting: "independent_filtering", value: true }]));
            expect(seed.prompt).toContain(`${DONE}\n- \`independent_filtering\` = true (multiple_testing)`);
        });

        it("lets a slot of the same name carry the setting: the entry of the contract then says nothing", async () => {
            const direct = { step: "filter_low_counts", name: "min_count", value: 10, source: "doi:10.12688/f1000research.7035.1" };
            const seed = await compose(grounded([direct]), doneContract([{ setting: "min_count", value: 10 }]));
            expect(seed.templateBinding).toEqual({ ...BINDING_BASE, slots: { min_count: 10 }, sources: { min_count: "doi:10.12688/f1000research.7035.1" } });
            expect(seed.prompt).not.toContain("Done by the script");
        });

        it("says nothing as done when the served version differs from the plan", async () => {
            const seed = await compose(grounded([ADJUSTMENT]), { ...doneContract(), version: "9.9.9" });
            expect(seed.templateBinding).toBeUndefined();
            expect(seed.prompt).toContain("not bound, because the served version differs from the plan");
            expect(seed.prompt).not.toContain("Done by the script");
        });
    });

    describe("a policy setting that the template maps to a slot", () => {
        const POLICY = { step: "filter_low_counts", name: "depth_policy", value: "low_depth_panel", source: "rule:R-0571" } as const;
        const mappedContract = (slot = "min_count", slotValue: string | number = 5) => ({
            ...contractAnswer(),
            setting_bindings: [{ setting: "depth_policy", value: "low_depth_panel", slot, slot_value: slotValue }],
        });
        const compose = async (grounding: AnalysisStep["grounding"], contract: ReturnType<typeof contractAnswer> = mappedContract()) => {
            const root = await makeWorkspace();
            const fake = fakeKnowledgeClient({ contract });
            return composeStepSeed({ input: input([planStep("T1S2", [], grounding)]), stepId: "T1S2", runId: RUN_ID, deps: deps(root, {}, fake.client) });
        };

        it("binds the slot value of the map, and names the setting and its source", async () => {
            const seed = await compose(grounded([POLICY]));
            expect(seed.templateBinding).toEqual({
                ...BINDING_BASE,
                slots: { min_count: 5 },
                sources: { min_count: "the plan setting `depth_policy`; rule:R-0571" },
            });
            expect(seed.prompt).toContain("`min_count` = 5 (the plan setting `depth_policy`; rule:R-0571)");
            expect(seed.prompt).not.toContain("no slot of the template carries it");
        });

        it("matches a list setting, whose members the skeleton keeps as text, against the typed list of the map", async () => {
            const listed = { step: "filter_low_counts", name: "depth_bounds", value: ["1", "2"] };
            const contract = { ...contractAnswer(), setting_bindings: [{ setting: "depth_bounds", value: [1, 2], slot: "min_count", slot_value: 5 }] };
            const seed = await compose(grounded([listed]), contract);
            expect(seed.templateBinding).toEqual({ ...BINDING_BASE, slots: { min_count: 5 }, sources: { min_count: "the plan setting `depth_bounds`" } });
        });

        it("binds nothing with no map: the policy stays a plan setting", async () => {
            const seed = await compose(grounded([POLICY]), contractAnswer());
            expect(seed.templateBinding).toEqual({ ...BINDING_BASE, slots: {}, sources: {} });
            expect(seed.prompt).toContain('`depth_policy` = "low_depth_panel" (filter_low_counts; rule:R-0571): no slot of the template carries it');
        });

        it("reads the setting after its departure: a different word binds nothing, and a removed word binds nothing and excludes no slot", async () => {
            const changed = { rule: "R-0571@aa11", setting: "depth_policy", value: "full_depth", reason: "the panel has the depth of a full library" };
            const withValue = await compose(departed(grounded([POLICY]), [changed]));
            expect(withValue.templateBinding).toEqual({ ...BINDING_BASE, slots: {}, sources: {}, departures: [changed] });
            expect(withValue.prompt).toContain("no slot of the template carries it");

            const removed = { rule: "R-0571@aa11", setting: "depth_policy", reason: "the plan keeps the default filter" };
            const withoutValue = await compose(departed(grounded([POLICY]), [removed]));
            expect(withoutValue.templateBinding).toEqual({ ...BINDING_BASE, slots: {}, sources: {}, departures: [removed] });
            expect(withoutValue.prompt).toContain("the plan departs from R-0571@aa11 and does not apply it");
        });

        it("keeps the first value of a slot that a setting by name and a mapped setting both give", async () => {
            const direct = { step: "filter_low_counts", name: "min_count", value: 10, source: "doi:10.12688/f1000research.7035.1" };
            const seed = await compose(grounded([direct, POLICY]));
            expect(seed.templateBinding).toEqual({ ...BINDING_BASE, slots: { min_count: 10 }, sources: { min_count: "doi:10.12688/f1000research.7035.1" } });
            expect(seed.prompt).toContain(
                '`depth_policy` = "low_depth_panel" (filter_low_counts; rule:R-0571): differs from the bound value 10 of the same slot',
            );
        });

        it("binds nothing when the served contract does not take the mapped value", async () => {
            for (const contract of [mappedContract("absent_slot"), mappedContract("counts_path", "x.csv"), mappedContract("min_count", "many")]) {
                const seed = await compose(grounded([POLICY]), contract);
                expect(seed.templateBinding).toEqual({ ...BINDING_BASE, slots: {}, sources: {} });
                expect(seed.prompt).toContain("which the served contract does not take");
            }
        });

        it("binds nothing when the served version differs from the plan", async () => {
            const seed = await compose(grounded([POLICY]), { ...mappedContract(), version: "9.9.9" });
            expect(seed.templateBinding).toBeUndefined();
            expect(seed.prompt).toContain("not bound, because the served version differs from the plan");
        });
    });

    it("binds no value for a slot that a departure does not apply, names it as excluded, and asks for the value of the plan", async () => {
        const root = await makeWorkspace();
        const fake = fakeKnowledgeClient();
        const departure = { rule: "R-0001@e7d0", setting: "lfc_shrink", reason: "the plan reports the unshrunk fold changes" };

        const seed = await composeStepSeed({
            input: input([planStep("T1S2", [], departed(grounded(SETTINGS), [departure]))]),
            stepId: "T1S2",
            runId: RUN_ID,
            deps: deps(root, {}, fake.client),
        });

        expect(seed.templateBinding).toEqual({ ...BINDING_BASE, slots: {}, sources: {}, departures: [departure], excluded: ["lfc_shrink"] });
        expect(seed.prompt).toContain(
            '`lfc_shrink` = "apeglm" (differential_expression; doi:10.1093/bioinformatics/bty895): the plan departs from R-0001@e7d0 and does not apply it (the plan reports the unshrunk fold changes), but the template gives each slot a value; send the value that matches the plan, with an `overrides` entry and the reason',
        );
        expect(seed.prompt).toContain("  - R-0001@e7d0: `lfc_shrink` not applied. the plan reports the unshrunk fold changes");
    });

    it("excludes no slot for a departure from a setting that no slot carries", async () => {
        const root = await makeWorkspace();
        const fake = fakeKnowledgeClient();
        const departure = { rule: "R-0001@e7d0", setting: "gc_bias", reason: "the inputs hold no amplicon sequence" };

        const seed = await composeStepSeed({
            input: input([planStep("T1S2", [], departed(grounded([{ step: "qc_bias", name: "gc_bias", value: true }]), [departure]))]),
            stepId: "T1S2",
            runId: RUN_ID,
            deps: deps(root, {}, fake.client),
        });

        expect(seed.templateBinding).toEqual({ ...BINDING_BASE, slots: {}, sources: {}, departures: [departure] });
        expect(seed.prompt).toContain(
            "`gc_bias` = true (qc_bias): the plan departs from R-0001@e7d0 and does not apply it (the inputs hold no amplicon sequence)\n",
        );
    });

    it("leaves a departure value that does not fit its slot unbound, with the departure in the line", async () => {
        const root = await makeWorkspace();
        const fake = fakeKnowledgeClient();
        const departure = { rule: "R-0001@e7d0", setting: "min_count", value: "all_retained", reason: "the PCA uses each retained target" };

        const seed = await composeStepSeed({
            input: input([planStep("T1S2", [], departed(grounded([{ step: "filter_low_counts", name: "min_count", value: 10 }]), [departure]))]),
            stepId: "T1S2",
            runId: RUN_ID,
            deps: deps(root, {}, fake.client),
        });

        expect(seed.templateBinding?.slots).toEqual({});
        expect(seed.prompt).toContain(
            '`min_count` = "all_retained" (filter_low_counts; departure from R-0001@e7d0: the PCA uses each retained target): a policy of the plan, not a value of the `min_count` slot (integer)',
        );
    });

    it("gives a seed with no text of the knowledge service for a plan with no grounding and no client", async () => {
        const root = await makeWorkspace();

        const seed = await composeStepSeed({
            input: input([planStep("T1S1"), planStep("T1S2", ["T1S1"])]),
            stepId: "T1S2",
            runId: RUN_ID,
            deps: deps(root),
        });

        // The harness with no knowledge service: the seed names no tool that is not attached and no contract.
        expect(seed.templateBinding).toBeUndefined();
        expect(seed.prompt).not.toContain("knowledge_");
        expect(seed.prompt).not.toContain("Template contract");
        expect(seed.prompt).not.toContain("reported fit");
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
        expect(seed.prompt).toContain(
            '`lfc_shrink` = "apeglm" (differential_expression; doi:10.1093/bioinformatics/bty895): not bound, because the served version differs from the plan',
        );
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
