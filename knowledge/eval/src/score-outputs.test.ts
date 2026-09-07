import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkExpectation } from "../../src/build/template-tests.js";
import type { FullRunRecord, FullRunStep } from "./record.js";
import { planHoldsEnrichment, recallAndFdr, scoreOutputs } from "./score-outputs.js";
import { EVAL_ROOT } from "./tasks.js";

/** Six genes, three true: G1, G2, G3. */
const TRUTH = ['"gene","de","lfc","planted_set"', '"G1",1,1.2,""', '"G2",1,-0.9,""', '"G3",1,2.0,""', '"G4",0,0,""', '"G5",0,0,""', '"G6",0,0,""'].join("\n") + "\n";

/** G1 and G4 are called at 0.05; G3 has no adjusted p-value; thus one hit of three positives and one false call of two. */
const RESULTS =
    ['"gene","base_mean","log2_fold_change","lfc_se","pvalue","adjusted_pvalue"', '"G1",100,1.1,0.2,0.0001,0.01', '"G2",50,-0.4,0.3,0.05,0.2', '"G3",10,1.9,1.5,NA,NA', '"G4",200,0.5,0.1,0.001,0.03', '"G5",30,0.1,0.2,0.4,0.5', '"G6",20,0.0,0.2,0.8,0.9'].join(
        "\n",
    ) + "\n";

/** A table without the DE signature: a QC summary, not a results table. */
const NOT_A_DE_TABLE = "sample,library_size\ns1,1000\ns2,1200\n";

const ENRICHMENT = "pathway,pval,padj,NES\nHALLMARK_A,0.001,0.01,2.1\n";

function step(overrides: Partial<FullRunStep> & { stepId: string }): FullRunStep {
    return { agent: "bulk-transcriptomics-agent", status: "completed", durationMs: 1000, finishReason: "stop", hitMaxSteps: false, error: null, blockedReason: null, ...overrides };
}

const DE_STEP = { id: "T1S2", name: "DESeq2", agent: "bulk-transcriptomics-agent", step_type: "differential_expression" };
const ENRICHMENT_STEP = { id: "T2S1", name: "fgsea", agent: "enrichment-agent", step_type: "enrichment" };
const REPORT_STEP = { id: "T1S3", name: "Report", agent: "bulk-transcriptomics-agent", step_type: "report" };

type Outputs = FullRunRecord["outputs"];

function record(options: { readonly status?: string; readonly steps?: readonly FullRunStep[]; readonly planSteps?: readonly unknown[]; readonly outputs?: Partial<Outputs>; readonly byStep?: FullRunRecord["usage"]["byStep"]; readonly elapsedMs?: number }): FullRunRecord {
    const steps = options.steps ?? [step({ stepId: "T1S2" }), step({ stepId: "T1S3" })];
    return {
        campaign: "probe",
        condition: "with",
        model: "claude-sonnet-5",
        task: "two-group-n6-enrich",
        seed: 1,
        split: "development",
        startedAt: "2026-09-07T00:00:00.000Z",
        elapsedMs: options.elapsedMs ?? 90_000,
        outcome: "plan_submitted",
        toolCalls: [],
        knowledgeCalls: [],
        connection: { provider: "cliproxy" },
        identity: { campaign: "probe", arm: "with--claude-sonnet-5", task: "two-group-n6-enrich", run: 1, seed: 1, models_by_role: {}, snapshot_digest: null, image_digest: null, farm_lock_sha256: null, refs_receipt: null, harness_commit: "abc" },
        profile: { status: "completed", durationMs: 1000, result: {} },
        plan: { planId: "p1", outcome: "plan_submitted", clarifications: [], plan: { title: "A plan", steps: options.planSteps ?? [DE_STEP, REPORT_STEP] } },
        run: { runId: "r1", status: options.status ?? "completed", error: null, synthesis_status: "produced", steps, artifacts: [], environment_missing: [] },
        usage: { byRole: {}, byStep: options.byStep ?? {}, total: {} },
        toolCallsByStep: {},
        knowledgeTemplateCalls: [],
        failures: [],
        timings: {},
        outputs: { de_table: null, enrichment_table: null, figures: [], synthesis: null, report_step_summary: null, ...options.outputs },
        transcript_source: "dbos.operation_outputs",
    };
}

/** A dataset directory with the truth, and an attempt directory with the named files. */
async function withFixture<T>(files: Record<string, string>, work: (dirs: { dataset: string; attempt: string }) => Promise<T>): Promise<T> {
    const root = await mkdtemp(join(tmpdir(), "score-outputs-"));
    try {
        const dataset = join(root, "dataset");
        const attempt = join(root, "attempt");
        await mkdir(dataset);
        await mkdir(attempt);
        await Bun.write(join(dataset, "truth.csv"), TRUTH);
        for (const [name, text] of Object.entries(files)) await Bun.write(join(attempt, name), text);
        return await work({ dataset, attempt });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

const COMPLETE_FILES = { "results.csv": RESULTS, "enrichment.csv": ENRICHMENT, "synthesis.json": "{}", "summary.md": "# Report\n" };

describe("the executed-output score", () => {
    it("scores a complete run against the truth: recall 1/3 and FDR 1/2 on the hand-built pair", async () => {
        await withFixture(COMPLETE_FILES, async ({ dataset, attempt }) => {
            const score = await scoreOutputs(record({ outputs: { de_table: join(attempt, "results.csv"), synthesis: join(attempt, "synthesis.json"), report_step_summary: join(attempt, "summary.md") } }), dataset);
            expect(score.valid_completion).toBe(true);
            expect(score.missing_outputs).toEqual([]);
            expect(score.de_recall).toBeCloseTo(1 / 3, 10);
            expect(score.de_fdr).toBeCloseTo(1 / 2, 10);
            expect(score.report_present).toBe(true);
            expect(score.failed_steps).toBe(0);
            expect(score.total_ms).toBe(90_000);
        });
    });

    it("is not a valid completion when the run failed, whatever the outputs say", async () => {
        await withFixture(COMPLETE_FILES, async ({ dataset, attempt }) => {
            const outputs = { de_table: join(attempt, "results.csv"), synthesis: join(attempt, "synthesis.json"), report_step_summary: join(attempt, "summary.md") };
            const failed = await scoreOutputs(record({ status: "failed", outputs }), dataset);
            expect(failed.valid_completion).toBe(false);
            expect(failed.missing_outputs).toEqual([]);
            // The tables are still measured: an accuracy number is evidence, the verdict is separate.
            expect(failed.de_recall).toBeCloseTo(1 / 3, 10);
            expect(failed.report_present).toBe(true);
            const partial = await scoreOutputs(record({ status: "partial", outputs }), dataset);
            expect(partial.valid_completion).toBe(false);
        });
    });

    it("lists a missing DE table and gives no accuracy for it", async () => {
        await withFixture(COMPLETE_FILES, async ({ dataset, attempt }) => {
            const absent = await scoreOutputs(record({ outputs: { de_table: null } }), dataset);
            expect(absent.valid_completion).toBe(false);
            expect(absent.missing_outputs).toEqual(["de_table"]);
            expect(absent.de_recall).toBeNull();
            expect(absent.de_fdr).toBeNull();
            // A path to a file that no longer exists is the same as no path.
            const gone = await scoreOutputs(record({ outputs: { de_table: join(attempt, "not-there.csv") } }), dataset);
            expect(gone.missing_outputs).toEqual(["de_table"]);
        });
    });

    it("does not take a table without the DE column signature as the DE table", async () => {
        await withFixture({ "qc.csv": NOT_A_DE_TABLE }, async ({ dataset, attempt }) => {
            const score = await scoreOutputs(record({ outputs: { de_table: join(attempt, "qc.csv") } }), dataset);
            expect(score.missing_outputs).toEqual(["de_table"]);
            expect(score.valid_completion).toBe(false);
            expect(score.de_recall).toBeNull();
        });
    });

    it("requires the enrichment table only when the plan holds an enrichment step", async () => {
        await withFixture(COMPLETE_FILES, async ({ dataset, attempt }) => {
            const de = join(attempt, "results.csv");
            const withEnrichment = record({ planSteps: [DE_STEP, ENRICHMENT_STEP, REPORT_STEP], outputs: { de_table: de, enrichment_table: null } });
            const missing = await scoreOutputs(withEnrichment, dataset);
            expect(missing.missing_outputs).toEqual(["enrichment_table"]);
            expect(missing.valid_completion).toBe(false);
            const present = await scoreOutputs(record({ planSteps: [DE_STEP, ENRICHMENT_STEP, REPORT_STEP], outputs: { de_table: de, enrichment_table: join(attempt, "enrichment.csv") } }), dataset);
            expect(present.missing_outputs).toEqual([]);
            expect(present.valid_completion).toBe(true);
            const none = await scoreOutputs(record({ planSteps: [DE_STEP, REPORT_STEP], outputs: { de_table: de, enrichment_table: null } }), dataset);
            expect(none.missing_outputs).toEqual([]);
            expect(none.valid_completion).toBe(true);
        });
        expect(planHoldsEnrichment({ steps: [{ agent: "enrichment-agent", step_type: "pathway_analysis" }] })).toBe(true);
        expect(planHoldsEnrichment({ steps: [{ agent: "bulk-transcriptomics-agent", step_type: "enrichment" }] })).toBe(true);
        expect(planHoldsEnrichment({ steps: [DE_STEP] })).toBe(false);
        expect(planHoldsEnrichment(undefined)).toBe(false);
    });

    it("lists both required outputs when a failed run left nothing", async () => {
        await withFixture({}, async ({ dataset }) => {
            const score = await scoreOutputs(record({ status: "failed", planSteps: [DE_STEP, ENRICHMENT_STEP, REPORT_STEP], steps: [step({ stepId: "T1S2", status: "failed", error: "Rscript exit 1" }), step({ stepId: "T2S1", status: "skipped" })] }), dataset);
            expect(score.valid_completion).toBe(false);
            expect(score.missing_outputs).toEqual(["de_table", "enrichment_table"]);
            expect(score.report_present).toBe(false);
        });
    });

    it("counts the failed, blocked, and canceled steps, and not the skipped ones", async () => {
        await withFixture({}, async ({ dataset }) => {
            const steps = [
                step({ stepId: "S1", status: "completed" }),
                step({ stepId: "S2", status: "failed", error: "exit 1" }),
                step({ stepId: "S3", status: "blocked", blockedReason: "no lengths" }),
                step({ stepId: "S4", status: "canceled" }),
                step({ stepId: "S5", status: "skipped" }),
            ];
            const score = await scoreOutputs(record({ status: "partial", steps }), dataset);
            expect(score.failed_steps).toBe(3);
        });
    });

    it("divides the step tokens by the completed steps, and gives null when no step completed", async () => {
        await withFixture({}, async ({ dataset }) => {
            const steps = [step({ stepId: "S1" }), step({ stepId: "S2" }), step({ stepId: "S3", status: "failed" })];
            // The tokens of the failed step count in the numerator: they were spent.
            const byStep = { S1: { inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 800 }, S2: { inputTokens: 500, outputTokens: 100 }, S3: { inputTokens: 300, outputTokens: 50 } };
            const score = await scoreOutputs(record({ status: "partial", steps, byStep }), dataset);
            expect(score.tokens_per_completed_step).toBe((1200 + 600 + 350) / 2);
            const none = await scoreOutputs(record({ status: "failed", steps: [step({ stepId: "S1", status: "failed" })], byStep: { S1: { inputTokens: 10, outputTokens: 5 } } }), dataset);
            expect(none.tokens_per_completed_step).toBeNull();
        });
    });

    it("reports the report present only with both the synthesis and the report step summary on disk", async () => {
        await withFixture(COMPLETE_FILES, async ({ dataset, attempt }) => {
            const de = join(attempt, "results.csv");
            const synthesisOnly = await scoreOutputs(record({ outputs: { de_table: de, synthesis: join(attempt, "synthesis.json") } }), dataset);
            expect(synthesisOnly.report_present).toBe(false);
            // A missing report does not remove the valid completion: the tables are the required outputs.
            expect(synthesisOnly.valid_completion).toBe(true);
            const summaryOnly = await scoreOutputs(record({ outputs: { de_table: de, report_step_summary: join(attempt, "summary.md") } }), dataset);
            expect(summaryOnly.report_present).toBe(false);
            const both = await scoreOutputs(record({ outputs: { de_table: de, synthesis: join(attempt, "synthesis.json"), report_step_summary: join(attempt, "summary.md") } }), dataset);
            expect(both.report_present).toBe(true);
        });
    });

    it("resolves a relative output path under the attempt directory", async () => {
        await withFixture(COMPLETE_FILES, async ({ dataset, attempt }) => {
            const relative = record({ outputs: { de_table: "results.csv", synthesis: "synthesis.json", report_step_summary: "summary.md" } });
            const resolved = await scoreOutputs(relative, dataset, attempt);
            expect(resolved.valid_completion).toBe(true);
            expect(resolved.de_recall).toBeCloseTo(1 / 3, 10);
            expect(resolved.report_present).toBe(true);
            const unresolved = await scoreOutputs(relative, dataset);
            expect(unresolved.missing_outputs).toEqual(["de_table"]);
        });
    });

    it("gives no accuracy when the dataset has no truth, and keeps the completion verdict", async () => {
        await withFixture(COMPLETE_FILES, async ({ dataset, attempt }) => {
            await rm(join(dataset, "truth.csv"));
            const score = await scoreOutputs(record({ outputs: { de_table: join(attempt, "results.csv") } }), dataset);
            expect(score.valid_completion).toBe(true);
            expect(score.de_recall).toBeNull();
            expect(score.de_fdr).toBeNull();
        });
    });

    it("uses the conventions of the template gate at the edges: no positives and no calls both give 0", () => {
        expect(recallAndFdr(new Set(["G1"]), new Set())).toEqual({ recall: 0, fdr: 1 });
        expect(recallAndFdr(new Set(), new Set(["G1"]))).toEqual({ recall: 0, fdr: 0 });
        expect(recallAndFdr(new Set(["G1", "G2"]), new Set(["G1", "G3"]))).toEqual({ recall: 0.5, fdr: 0.5 });
    });
});

describe("the executed-output score on a simulated dataset", () => {
    const dataset = join(EVAL_ROOT, "data", "two_group_n6", "seed-1");
    const present = stat(join(dataset, "de_results.csv")).then(
        () => true,
        () => false,
    );

    it("gives the same recall and FDR as truth_recall and truth_fdr of the template gate", async () => {
        if (!(await present)) {
            console.warn(`skipped: the dataset ${dataset} is not on this machine (run eval:simulate)`);
            return;
        }
        const score = await scoreOutputs(record({ outputs: { de_table: join(dataset, "de_results.csv") } }), dataset);
        expect(score.valid_completion).toBe(true);
        expect(score.de_recall).not.toBeNull();
        expect(score.de_fdr).not.toBeNull();
        const recall = await checkExpectation("truth_recall de_results.csv >= 0", dataset, dataset);
        const fdr = await checkExpectation("truth_fdr de_results.csv <= 1", dataset, dataset);
        expect(recall.ok && fdr.ok).toBe(true);
        expect(score.de_recall!.toFixed(3)).toBe(/truth_recall = ([0-9.]+)/.exec(recall.detail)?.[1] ?? "");
        expect(score.de_fdr!.toFixed(3)).toBe(/truth_fdr = ([0-9.]+)/.exec(fdr.detail)?.[1] ?? "");
    });
});
