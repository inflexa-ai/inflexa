/**
 * The golden test over the curated tree: the engine on the eight design
 * patterns of the evaluation, plus the edge situations the reviews raised.
 * It loads `kb/`, writes a snapshot to a temporary file, opens it as the
 * service does, and asserts the method of the central step, the flags, and
 * the parameters that a plan must carry. A rule edit that changes which rule
 * wins a step fails here, before it reaches a planner.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadKnowledgeBase } from "../build/load-kb.js";
import { validateKnowledgeBase } from "../build/validate.js";
import { templateHolds } from "../engine/procedure.js";
import type { KnowledgeBase, Situation } from "../model.js";
import { openSnapshot, writeSnapshot, type LoadedSnapshot } from "../store.js";
import { check, claimView, recommend, render } from "./handlers.js";
import type { CheckRequest, RecommendResponse } from "./api.js";

/** A Salmon count table with no import state: the service derives `unknown`, and the missing length input is reported. */
const BASE: Situation = {
    question: "full_plan",
    modality: "bulk_rna_seq",
    data_state: "counts",
    count_source: "salmon",
    organism: "human",
    n_groups: 2,
    n_per_group_min: 6,
    n_per_group_max: 6,
    paired: false,
    batch: "none",
};

let snapshot: LoadedSnapshot;
let kb: KnowledgeBase;
let dir: string;

beforeAll(async () => {
    const loaded = await loadKnowledgeBase(join(import.meta.dir, "..", "..", "kb"));
    if (!loaded.ok) throw new Error(loaded.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
    const issues = validateKnowledgeBase(loaded.kb);
    if (issues.length > 0) throw new Error(issues.map((issue) => `${issue.where}: ${issue.message}`).join("\n"));
    kb = loaded.kb;
    dir = mkdtempSync(join(tmpdir(), "kb-tree-"));
    const path = join(dir, "snapshot.sqlite");
    writeSnapshot(path, { kb: loaded.kb, date: "2026-09-04", schemaVersion: "test", vocabularies: [], toolDefinitionHash: "sha256:test" });
    snapshot = openSnapshot(path);
});

afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
});

function answer(situation: Situation, preferences?: { language: "R" | "python" }): RecommendResponse {
    const result = recommend(snapshot, { situation, ...(preferences ? { preferences } : {}) });
    if ("error" in result) throw new Error(result.message);
    return result;
}

function step(response: RecommendResponse, name: string) {
    const found = response.procedure.find((entry) => entry.step === name);
    if (!found) throw new Error(`no step ${name} in ${response.procedure.map((entry) => entry.step).join(",")}`);
    return found;
}

function parameter(response: RecommendResponse, name: string, key: string): unknown {
    return step(response, name).parameters?.find((entry) => entry.name === key)?.value;
}

/** True when the procedure carries the parameter on that step. A step the walk dropped or left uncovered carries nothing. */
function hasParameter(response: RecommendResponse, name: string, key: string): boolean {
    return response.procedure.find((entry) => entry.step === name)?.parameters?.some((entry) => entry.name === key) ?? false;
}

describe("the curated tree on the evaluation situations", () => {
    it("two groups, 6 vs 6, one low depth sample: DESeq2 Wald, apeglm, BH 0.05, QC warn, enrichment disputed", () => {
        const response = answer({ ...BASE, quality_flags: ["low_depth_sample"] });
        expect(response.match).toBe("applicable");
        expect(step(response, "differential_expression").method?.id).toBe("M-0001");
        expect(step(response, "differential_expression").template).toBe("tpl-deseq2-two-group@1.1.0");
        expect(step(response, "differential_expression").alternatives?.map((a) => a.method)).toContain("M-0003");
        expect(step(response, "shrink_lfc").method?.id).toBe("M-0013");
        expect(parameter(response, "multiple_testing", "alpha")).toBe(0.05);
        expect(parameter(response, "filter_low_counts", "min_count")).toBe(10);
        expect(step(response, "normalize").method?.id).toBe("M-0008");
        expect(step(response, "qc_sample_structure").method?.id).toBe("M-0006");
        expect(step(response, "qc_sample_structure").flags?.some((flag) => flag.severity === "warn")).toBe(true);
        expect(step(response, "enrichment").method?.id).toBe("M-0010");
        expect(step(response, "enrichment").disputed?.sides.length).toBeGreaterThanOrEqual(3);
        expect(step(response, "enrichment").alternatives?.map((a) => a.method)).toContain("M-0011");
        expect(parameter(response, "enrichment", "gene_set_collection")).toBe("msigdb_hallmark_human");
        // R-0046 names the over-representation method (M-0011), thus its universe stays with that method and not with GSEA.
        expect(hasParameter(response, "enrichment", "universe")).toBe(false);
        // A quantifier name alone establishes no length correction: the state is unknown, and the missing input is reported.
        expect(response.situation.import_state).toBe("unknown");
        expect(parameter(response, "model_design", "import")).toBe("gene_counts_without_length_offset");
        expect(step(response, "model_design").flags?.some((flag) => flag.severity === "warn" && flag.outcome === "report_missing_length_input")).toBe(true);
        expect(hasParameter(response, "model_design", "import_tool")).toBe(false);
        expect(response.uncovered).toEqual([]);
    });

    it("two groups, 3 vs 3: DESeq2 or edgeR with a power warning; 2 vs 2: edgeR first", () => {
        const three = answer({ ...BASE, n_per_group_min: 3, n_per_group_max: 3 });
        expect(step(three, "differential_expression").method?.id).toBe("M-0001");
        expect(step(three, "differential_expression").flags?.some((flag) => flag.message.includes("power"))).toBe(true);
        const two = answer({ ...BASE, n_per_group_min: 2, n_per_group_max: 2 });
        expect(step(two, "differential_expression").method?.id).toBe("M-0003");
        expect(step(two, "differential_expression").template).toBe("tpl-edger-ql@1.0.0");
        expect(step(two, "normalize").method?.id).toBe("M-0009");
        expect(step(two, "filter_low_counts").method?.id).toBe("M-0022");
        // The parameters of the DESeq2 rules stay with DESeq2: no Wald test on the quasi-likelihood step,
        // no size factors on TMM, no count floor on filterByExpr, and no apeglm without a DESeq2 fit.
        expect(parameter(two, "differential_expression", "test")).not.toBe("Wald");
        expect(hasParameter(two, "normalize", "size_factors")).toBe(false);
        expect(hasParameter(two, "filter_low_counts", "min_count")).toBe(false);
        expect(hasParameter(two, "filter_low_counts", "filter_policy")).toBe(false);
        expect(two.uncovered).toContain("shrink_lfc");
    });

    it("paired: DESeq2 with the subject as a block; repeated measures over time: a random subject effect", () => {
        const paired = answer({ ...BASE, paired: true, blocking_factor: "subject", n_per_group_min: 5, n_per_group_max: 5 });
        expect(step(paired, "differential_expression").method?.id).toBe("M-0001");
        expect(step(paired, "differential_expression").template).toBe("tpl-deseq2-blocked@1.1.0");
        expect(parameter(paired, "differential_expression", "design_terms")).toEqual(["subject", "condition"]);
        expect(step(paired, "differential_expression").alternatives?.map((a) => a.method)).toContain("M-0004");
        const repeated = answer({ ...BASE, paired: true, n_timepoints: 3, n_per_group_min: 4, n_per_group_max: 4 });
        expect(step(repeated, "differential_expression").method?.id).toBe("M-0017");
        expect(step(repeated, "differential_expression").alternatives?.map((a) => a.method)).toContain("M-0004");
    });

    it("balanced batch: the batch enters the design; confounded batch: a flag, no batch term, ComBat-seq forbidden", () => {
        const balanced = answer({ ...BASE, batch: "known_balanced" });
        expect(balanced.match).toBe("applicable");
        expect(parameter(balanced, "model_design", "design_terms")).toEqual(["batch", "condition"]);
        expect(step(balanced, "differential_expression").method?.id).toBe("M-0001");
        const confounded = answer({ ...BASE, batch: "known_confounded" });
        expect(confounded.match).toBe("flag");
        const flag = confounded.flags.find((entry) => entry.outcome === "confounded_label_or_stop");
        expect(flag).toBeDefined();
        expect(step(confounded, "model_design").forbids).toContain("M-0018");
    });

    it("interaction: the interaction template; time course: the LRT template", () => {
        const interaction = answer({ ...BASE, interaction: true, n_groups: 4, n_per_group_min: 4, n_per_group_max: 4 });
        expect(step(interaction, "differential_expression").method?.id).toBe("M-0001");
        expect(step(interaction, "differential_expression").template).toBe("tpl-deseq2-interaction@1.1.0");
        expect(parameter(interaction, "differential_expression", "test")).toBe("interaction");
        const course = answer({ ...BASE, n_timepoints: 4, n_groups: 2, n_per_group_min: 3, n_per_group_max: 3 });
        expect(step(course, "differential_expression").method?.id).toBe("M-0002");
        expect(step(course, "differential_expression").template).toBe("tpl-deseq2-lrt-timecourse@1.2.0");
        expect(parameter(course, "differential_expression", "reduced")).toBe("~ condition + time");
        expect(parameter(course, "differential_expression", "test")).not.toBe("Wald");
    });

    it("no replicates: a flag with the descriptive outcome and every inferential method forbidden", () => {
        const response = answer({ ...BASE, n_per_group_min: 1, n_per_group_max: 1 });
        expect(response.match).toBe("flag");
        expect(response.flags.find((entry) => entry.outcome === "descriptive_only")).toBeDefined();
        expect(step(response, "differential_expression").forbids).toContain("M-0001");
        expect(step(response, "differential_expression").method?.id).toBe("M-0015");
        expect(step(response, "differential_expression").template).toBe("tpl-descriptive-no-replicates@1.0.0");
        expect(step(response, "differential_expression").alternatives ?? []).toEqual([]);
    });

    it("TPM input: limma on log values, the count models forbidden; FASTQ input: stop", () => {
        const tpm = answer({ ...BASE, data_state: "tpm_or_fpkm", count_source: undefined });
        expect(step(tpm, "differential_expression").method?.id).toBe("M-0005");
        expect(step(tpm, "differential_expression").forbids).toEqual(expect.arrayContaining(["M-0001", "M-0003", "M-0004"]));
        const fastq = answer({ ...BASE, data_state: "fastq" });
        expect(fastq.match).toBe("flag");
        expect(fastq.flags[0]?.outcome).toBe("stop_quantify_first");
    });

    it("the middle range and the population scale are covered", () => {
        const middle = answer({ ...BASE, n_per_group_min: 12, n_per_group_max: 15 });
        expect(middle.match).toBe("applicable");
        expect(step(middle, "differential_expression").method?.id).toBe("M-0001");
        const unbalanced = answer({ ...BASE, n_per_group_min: 6, n_per_group_max: 15 });
        expect(step(unbalanced, "differential_expression").method?.id).toBe("M-0001");
        const population = answer({ ...BASE, n_per_group_min: 60, n_per_group_max: 80 });
        expect(step(population, "differential_expression").method?.id).toBe("M-0019");
        expect(step(population, "normalize").method?.id).toBe("M-0009");
        expect(step(population, "filter_low_counts").method?.id).toBe("M-0022");
        // The limma-voom path carries none of the DESeq2 requirements.
        expect(hasParameter(population, "normalize", "size_factors")).toBe(false);
        expect(hasParameter(population, "shrink_lfc", "lfc_shrink")).toBe(false);
        expect(hasParameter(population, "differential_expression", "outlier_replacement")).toBe(false);
        expect(hasParameter(population, "multiple_testing", "independent_filtering")).toBe(false);
    });

    it("a three prime library with Salmon counts takes no length offset, in the unknown state and on quantifications", () => {
        const unknown = answer({ ...BASE, library_type: "three_prime" });
        // The missing input rule is the most specific rule of the step, and the three prime rule sets the two offset facts.
        expect(parameter(unknown, "model_design", "import")).toBe("gene_counts_without_length_offset");
        expect(parameter(unknown, "model_design", "counts_from_abundance")).toBe("no");
        expect(parameter(unknown, "model_design", "length_offset")).toBe("none");
        const quantifications = answer({ ...BASE, library_type: "three_prime", import_state: "quantifications" });
        // The three prime rule is more specific than the tximport rule, thus it owns the import as its own text states.
        expect(parameter(quantifications, "model_design", "import")).toBe("tximport_raw_counts_no_offset");
        expect(parameter(quantifications, "model_design", "counts_from_abundance")).toBe("no");
        expect(parameter(quantifications, "model_design", "length_offset")).toBe("none");
        expect(step(quantifications, "model_design").conflicts).toBeUndefined();
    });

    it("quantifications: the two-group template imports them with tximport, the mapping is required, and no integer-CSV template applies", () => {
        const situation: Situation = { ...BASE, import_state: "quantifications" };
        const response = answer(situation);
        expect(response.match).toBe("applicable");
        expect(response.situation.import_state).toBe("quantifications");
        expect(step(response, "differential_expression").method?.id).toBe("M-0001");
        expect(step(response, "differential_expression").template).toBe("tpl-deseq2-two-group@1.1.0");
        expect(parameter(response, "model_design", "import")).toBe("tximport_gene_level_avg_tx_length_offset");
        expect(parameter(response, "model_design", "import_tool")).toBe("tximport");
        expect(parameter(response, "model_design", "counts_from_abundance")).toBe("no");
        const tx2gene = step(response, "model_design").parameters?.find((entry) => entry.name === "tx2gene");
        expect(tx2gene).toMatchObject({ value: "transcript_to_gene_map_of_the_annotation", required: true });
        expect(step(response, "model_design").flags?.some((flag) => flag.outcome === "report_missing_length_input")).toBeFalsy();
        expect(hasParameter(response, "model_design", "missing_input")).toBe(false);
        // A Python preference finds no template that reads the quantifications: the R template stays, with the limit.
        const python = answer(situation, { language: "python" });
        expect(step(python, "differential_expression").template).toBe("tpl-deseq2-two-group@1.1.0");
        expect(step(python, "differential_expression").limit?.requested_language).toBe("python");
        expect(step(python, "differential_expression").substitution).toBeUndefined();
        // Every count template without an import branch is excluded from the quantification states.
        const importing = new Set(["tpl-deseq2-two-group", "tpl-deseq2-blocked", "tpl-deseq2-interaction", "tpl-deseq2-multigroup", "tpl-deseq2-lrt-timecourse", "tpl-deseq2-sva"]);
        const excluded = [...snapshot.templates.values()].filter((template) => template.step_types.includes("model_design") && !importing.has(template.id) && !template.id.startsWith("tpl-limma-trend-"));
        expect(excluded.length).toBe(9);
        for (const state of ["quantifications", "estimated_counts_with_lengths"] as const) {
            for (const template of excluded) {
                expect(templateHolds(template, "differential_expression", { ...situation, import_state: state })).toBe(false);
            }
        }
        for (const groups of [{ n_per_group_min: 2, n_per_group_max: 2 }, { n_per_group_min: 60, n_per_group_max: 60 }]) {
            const other = answer({ ...situation, ...groups });
            expect(step(other, "differential_expression").template).toBeUndefined();
        }
        // The blocked DESeq2 template imports the quantifications the same way.
        expect(step(answer({ ...situation, paired: true, blocking_factor: "subject" }), "differential_expression").template).toBe("tpl-deseq2-blocked@1.1.0");
    });

    it("estimated counts with lengths and corrected counts: each state carries its import and its required fact", () => {
        const estimated = answer({ ...BASE, import_state: "estimated_counts_with_lengths" });
        expect(step(estimated, "differential_expression").template).toBe("tpl-deseq2-two-group@1.1.0");
        expect(parameter(estimated, "model_design", "import")).toBe("estimated_counts_with_avg_tx_length_offset");
        expect(step(estimated, "model_design").parameters?.find((entry) => entry.name === "length_input")).toMatchObject({ value: "per_gene_per_sample_average_transcript_length", required: true });
        expect(parameter(estimated, "model_design", "counts_from_abundance")).toBe("no");
        expect(hasParameter(estimated, "model_design", "missing_input")).toBe(false);
        const corrected = answer({ ...BASE, import_state: "corrected_counts" });
        expect(step(corrected, "differential_expression").template).toBe("tpl-deseq2-two-group@1.1.0");
        expect(parameter(corrected, "model_design", "import")).toBe("length_corrected_counts_no_offset");
        expect(step(corrected, "model_design").parameters?.find((entry) => entry.name === "counts_from_abundance")).toMatchObject({ value: "lengthScaledTPM_or_scaledTPM_as_delivered", required: true });
        expect(parameter(corrected, "model_design", "length_offset")).toBe("none");
        // The corrected counts are an integer-CSV input: the Python mirror applies under its preference.
        expect(step(answer({ ...BASE, import_state: "corrected_counts" }, { language: "python" }), "differential_expression").template).toBe("tpl-pydeseq2-two-group@1.0.0");
        // RSEM gene results are estimates with effective lengths: the type rsem rule keeps its step, with no conflict.
        const rsem = answer({ ...BASE, count_source: "rsem", import_state: "estimated_counts_with_lengths" });
        expect(parameter(rsem, "model_design", "import")).toBe("tximport_rsem_expected_counts_with_effective_lengths");
        expect(step(rsem, "model_design").conflicts).toBeUndefined();
        expect(step(answer({ ...BASE, count_source: "rsem" }), "model_design").flags?.some((flag) => flag.outcome === "report_missing_length_input")).toBe(true);
    });

    it("the check asks a model design draft for the missing input on a Salmon table of unknown state", () => {
        // A draft that promises tximport on a gene table resolves by its package; the step then owes the missing input.
        const promise: CheckRequest["steps"][number] = { step_type: "model_design", method: "tximport at the gene level, then ~ condition", package: "tximport" };
        const silent = check(snapshot, { situation: BASE, steps: [promise] });
        if ("error" in silent) throw new Error(silent.message);
        expect(silent.violations).toEqual([]);
        expect(silent.warnings.map((warning) => warning.parameter)).toEqual(["missing_input"]);
        expect(silent.warnings[0]?.rule).toMatch(/^R-0169@/);
        expect(silent.ok).toBe(false);
        const stated = check(snapshot, { situation: BASE, steps: [{ ...promise, parameters: [{ name: "missing_input", value: "quant.sf directories requested from the core" }] }] });
        if ("error" in stated) throw new Error(stated.message);
        expect(stated.warnings).toEqual([]);
        const quantifications = check(snapshot, { situation: { ...BASE, import_state: "quantifications" }, steps: [promise] });
        if ("error" in quantifications) throw new Error(quantifications.message);
        expect(quantifications.warnings.map((warning) => warning.parameter).sort()).toEqual(["counts_from_abundance", "tx2gene"]);
    });

    it("the gate refuses a count template that a quantifier can feed when it neither imports the quantifications nor excludes the length states", () => {
        const edger = kb.templates.find((template) => template.id === "tpl-edger-ql")!;
        const conditions = (edger.applicability.conditions ?? []).filter((condition) => condition.field !== "import_state");
        const bare = { ...edger, applicability: { ...edger.applicability, conditions } };
        const issues = validateKnowledgeBase({ ...kb, templates: kb.templates.map((template) => (template.id === edger.id ? bare : template)) });
        expect(issues).toEqual([{ where: "template tpl-edger-ql", message: expect.stringContaining("import_state not_in [quantifications, estimated_counts_with_lengths]") }]);
    });

    it("mouse and other organisms get their own collections; enrichment only reports enrichment fields", () => {
        const mouse = answer({ ...BASE, question: "enrichment", organism: "mouse" });
        expect(step(mouse, "enrichment").method?.id).toBe("M-0010");
        expect(parameter(mouse, "enrichment", "gene_set_collection")).toBe("msigdb_hallmark_mouse");
        const other = answer({ ...BASE, question: "enrichment", organism: "other" });
        expect(parameter(other, "enrichment", "gene_set_collection")).toBe("orthology_mapped_or_go");
        expect(step(other, "enrichment").flags?.some((flag) => flag.severity === "warn")).toBe(true);
        const de = answer({ ...BASE, question: "differential_expression" });
        expect(parameter(de, "report", "enrichment_report")).toBeUndefined();
        expect(parameter(de, "report", "report_fields")).toBeDefined();
    });

    it("the check refuses DESeq2 on TPM and accepts DESeq2 on counts", () => {
        const tpm = check(snapshot, { situation: { ...BASE, data_state: "tpm_or_fpkm" }, steps: [{ step_type: "differential_expression", method: "DESeq2 Wald test", package: "DESeq2" }] });
        if ("error" in tpm) throw new Error(tpm.message);
        expect(tpm.ok).toBe(false);
        expect(tpm.violations[0]?.permitted).toContain("limma linear model on log-scale expression values");
        const counts = check(snapshot, { situation: BASE, steps: [{ step_type: "differential_expression", method: "DESeq2 Wald test with apeglm", package: "DESeq2" }] });
        if ("error" in counts) throw new Error(counts.message);
        expect(counts.violations).toEqual([]);
    });

    it("renders the two-group template from the snapshot with the farm match", async () => {
        const result = await render(snapshot, {
            template: "tpl-deseq2-two-group@1.1.0",
            slots: { import_state: "integer_counts", counts_path: "/a/data/inputs/x/counts.csv", metadata_path: "/a/data/inputs/y/metadata.csv", condition_column: "condition", reference_level: "control", test_level: "treated" },
            farm: [{ name: "DESeq2", version: "1.52.0" }, { name: "apeglm", version: "1.34.0" }, { name: "tximport", version: "1.40.0" }, { name: "ashr", version: "2.2-63" }, { name: "ggplot2", version: "4.0.3" }, { name: "pheatmap", version: "1.0.13" }, { name: "jsonlite", version: "2.0.0" }],
        });
        if ("error" in result) throw new Error(result.message);
        expect(result.environment.match).toBe("exact");
        expect(result.script).toContain('REFERENCE_LEVEL  <- "control"');
        expect(result.script).not.toContain("{{");
        expect(result.decision_record.slots.find((slot) => slot.name === "alpha")).toMatchObject({ source: "default", adaptable: false });
        // The quantifications state: the slot report carries the mapping and the correction mode, thus the decision record does too.
        const quantifications = await render(snapshot, {
            template: "tpl-deseq2-two-group@1.1.0",
            slots: { import_state: "quantifications", quant_dir: "/a/data/inputs/local/quant", tx2gene_path: "/a/data/inputs/local/tx2gene.csv", metadata_path: "/a/data/inputs/local/metadata.csv", condition_column: "condition", reference_level: "control", test_level: "treated" },
        });
        if ("error" in quantifications) throw new Error(quantifications.message);
        expect(quantifications.slots.find((slot) => slot.name === "tx2gene_path")).toMatchObject({ source: "caller", value: "/a/data/inputs/local/tx2gene.csv", adaptable: true });
        expect(quantifications.slots.find((slot) => slot.name === "counts_from_abundance")).toMatchObject({ source: "default", value: "no" });
        expect(quantifications.slots.find((slot) => slot.name === "length_offset")).toMatchObject({ source: "default", value: true });
        expect(quantifications.decision_record.slots.map((slot) => slot.name)).toEqual(expect.arrayContaining(["import_state", "tx2gene_path", "counts_from_abundance", "length_offset"]));
        expect(quantifications.slots.find((slot) => slot.name === "counts_path")).toBeUndefined();
    });

    it("three groups: the LRT with pairwise contrasts and ashr; paired with three groups: the subject in both models", () => {
        const three = answer({ ...BASE, n_groups: 3, n_per_group_min: 4, n_per_group_max: 4 });
        expect(step(three, "differential_expression").method?.id).toBe("M-0002");
        expect(step(three, "differential_expression").template).toBe("tpl-deseq2-multigroup@1.1.0");
        expect(parameter(three, "differential_expression", "test")).toBe("LRT_then_pairwise_Wald");
        expect(step(three, "differential_expression").alternatives?.map((a) => a.method)).toContain("M-0003");
        expect(step(three, "shrink_lfc").method?.id).toBe("M-0014");
        const paired = answer({ ...BASE, paired: true, n_groups: 3, n_per_group_min: 4, n_per_group_max: 4 });
        expect(step(paired, "differential_expression").method?.id).toBe("M-0002");
        expect(parameter(paired, "differential_expression", "full")).toBe("~ subject + condition");
        expect(step(paired, "differential_expression").alternatives?.map((a) => a.method)).toContain("M-0017");
    });

    it("TPM input: QC and the filter on log abundance, limma-trend with its template; log-normalized input: no normalization", () => {
        const tpm = answer({ ...BASE, data_state: "tpm_or_fpkm" });
        expect(step(tpm, "qc_sample_structure").method?.id).toBe("M-0026");
        expect(step(tpm, "qc_sample_structure").template).toBe("tpl-qc-log-abundance@1.0.0");
        expect(step(tpm, "filter_low_counts").method?.id).toBe("M-0027");
        expect(parameter(tpm, "normalize", "normalization")).toBe("log2_plus_1_only");
        expect(step(tpm, "differential_expression").template).toBe("tpl-limma-trend-logvalues@1.1.0");
        const log = answer({ ...BASE, data_state: "log_normalized" });
        expect(parameter(log, "normalize", "normalization")).toBe("none_already_normalized");
        expect(step(log, "differential_expression").method?.id).toBe("M-0005");
    });

    it("outlier sample: DESeq2 stays primary with a warn and the weighted limma-voom as the alternative", () => {
        const response = answer({ ...BASE, n_per_group_min: 5, n_per_group_max: 5, quality_flags: ["outlier_sample"] });
        expect(step(response, "differential_expression").method?.id).toBe("M-0001");
        expect(step(response, "differential_expression").alternatives?.map((a) => a.method)).toContain("M-0023");
        expect(step(response, "differential_expression").flags?.some((flag) => flag.severity === "warn")).toBe(true);
        // R-0067 names the weighted limma-voom (M-0023), thus its down-weight policy stays with that method:
        // the DESeq2 step carries the warn, not a parameter it has no mechanism for.
        expect(hasParameter(response, "differential_expression", "outlier_sample_policy")).toBe(false);
    });

    it("suspected batch: surrogate variables on the design with the sva template, and a warn on the multiple testing", () => {
        const response = answer({ ...BASE, batch: "suspected" });
        expect(step(response, "model_design").method?.id).toBe("M-0025");
        expect(step(response, "model_design").template).toBe("tpl-deseq2-sva@1.1.0");
        expect(step(response, "multiple_testing").flags?.some((flag) => flag.severity === "warn")).toBe(true);
    });

    it("population scale: limma-voom fixed effects and camera, each with a template; STAR counts: no length correction", () => {
        const population = answer({ ...BASE, n_per_group_min: 60, n_per_group_max: 60 });
        expect(step(population, "differential_expression").method?.id).toBe("M-0019");
        expect(step(population, "differential_expression").template).toBe("tpl-limma-voom-fixed@1.0.0");
        expect(step(population, "enrichment").method?.id).toBe("M-0021");
        expect(step(population, "enrichment").template).toBe("tpl-camera-hallmark@1.0.0");
        expect(parameter(population, "enrichment", "rank_metric")).toBe("moderated_t");
        const star = answer({ ...BASE, count_source: "star_featurecounts" });
        expect(parameter(star, "model_design", "import")).toBe("raw_integer_counts_no_length_correction");
    });

    it("total RNA with high duplication: the QC carries the library checks; the enrichment offers GO ORA, goseq, and GSVA as alternatives", () => {
        const total = answer({ ...BASE, library_type: "total", quality_flags: ["high_duplication"] });
        expect(step(total, "qc_sample_structure").flags?.some((flag) => flag.severity === "warn")).toBe(true);
        expect(parameter(total, "qc_sample_structure", "total_rna_qc")).toEqual(["rrna_fraction", "mito_fraction", "intronic_share"]);
        expect(parameter(total, "qc_sample_structure", "duplicate_policy")).toBe("keep_without_umi_report_rate");
        const alternatives = step(total, "enrichment").alternatives?.map((a) => a.method) ?? [];
        expect(alternatives).toEqual(expect.arrayContaining(["M-0011", "M-0021"]));
    });

    it("the enrichment input selects the method: a gene list gets goseq or GO ORA, sample scores get GSVA, the default is the ranked list", () => {
        const list = answer({ ...BASE, enrichment_input: "gene_list" });
        expect(step(list, "enrichment").method?.id).toBe("M-0032");
        expect(step(list, "enrichment").alternatives?.map((a) => a.method)).toEqual(expect.arrayContaining(["M-0033", "M-0010"]));
        expect(hasParameter(list, "enrichment", "gsea_input")).toBe(false);
        expect(hasParameter(list, "enrichment", "rank_metric")).toBe(false);
        const star = answer({ ...BASE, count_source: "star_featurecounts", enrichment_input: "gene_list" });
        expect(step(star, "enrichment").method?.id).toBe("M-0032");
        expect(step(star, "enrichment").template).toBe("tpl-ora-go@1.0.0");
        const scores = answer({ ...BASE, enrichment_input: "sample_scores" });
        expect(step(scores, "enrichment").method?.id).toBe("M-0034");
        const ranked = answer({ ...BASE, enrichment_input: "ranked_list" });
        expect(step(ranked, "enrichment").method?.id).toBe("M-0010");
        expect(step(ranked, "enrichment").disputed?.sides.length).toBeGreaterThanOrEqual(3);
    });

    it("no replicates: the procedure drops the shrinkage and the multiple testing, and the enrichment is descriptive", () => {
        const response = answer({ ...BASE, n_per_group_min: 1, n_per_group_max: 1 });
        expect(response.dropped).toEqual(expect.arrayContaining(["shrink_lfc", "multiple_testing"]));
        expect(response.procedure.some((entry) => entry.step === "shrink_lfc")).toBe(false);
        expect(step(response, "enrichment").flags?.some((flag) => flag.outcome === "descriptive_only")).toBe(true);
        expect(parameter(response, "enrichment", "rank_metric")).toBe("descriptive_log2_fold_change");
    });

    it("no replicates: a stated descriptive outcome passes the check, an inferential draft does not, and the fourth check is the host's to refuse", () => {
        const situation = { ...BASE, n_per_group_min: 1, n_per_group_max: 1 };
        const inferential = check(snapshot, { situation, steps: [{ step_type: "differential_expression", method: "DESeq2 Wald test", package: "DESeq2" }] });
        if ("error" in inferential) throw new Error(inferential.message);
        expect(inferential.violations.length).toBeGreaterThan(0);
        const stated = check(snapshot, { situation, steps: [{ step_type: "differential_expression", method: "Descriptive log2 fold change of normalized counts, no test", package: "DESeq2", outcome: "descriptive_only" }] });
        if ("error" in stated) throw new Error(stated.message);
        expect(stated.violations).toEqual([]);
        const byId = check(snapshot, { situation, steps: [{ step_type: "differential_expression", method: "descriptive log2 fold change", method_id: "M-0015", outcome: "descriptive_only" }] });
        if ("error" in byId) throw new Error(byId.message);
        expect(byId.ok).toBe(true);
        expect(byId.not_assessed).toEqual([]);
    });

    it("no replicates: the three drafts of the review each fail with R-0003, alone and together", () => {
        const situation = { ...BASE, n_per_group_min: 1, n_per_group_max: 1 };
        const drafts: CheckRequest["steps"] = [
            { step_type: "shrink_lfc", method: "apeglm log fold change shrinkage", package: "apeglm" },
            { step_type: "multiple_testing", method: "Benjamini-Hochberg", package: "DESeq2", parameters: [{ name: "alpha", value: 0.05 }] },
            { step_type: "differential_expression", method: "DESeq2 Wald test", package: "DESeq2", outcome: "descriptive_only" },
        ];
        for (const draft of drafts) {
            const result = check(snapshot, { situation, steps: [draft] });
            if ("error" in result) throw new Error(result.message);
            expect(result.ok).toBe(false);
            expect(result.violations).toHaveLength(1);
            expect(result.violations[0]?.step_type).toBe(draft.step_type);
            expect(result.violations[0]?.rule).toMatch(/^R-0003@/);
        }
        const together = check(snapshot, { situation, steps: drafts });
        if ("error" in together) throw new Error(together.message);
        expect(together.ok).toBe(false);
        expect(together.violations).toHaveLength(3);
        // The violation on the labeled Wald draft names the exact escape.
        expect(together.violations[2]?.message).toContain('method_id: "M-0015"');
    });

    it("TPM input: a shrinkage draft is not assessed, because no rule covers the step there", () => {
        const result = check(snapshot, { situation: { ...BASE, data_state: "tpm_or_fpkm" }, steps: [{ step_type: "shrink_lfc", method: "apeglm log fold change shrinkage", package: "apeglm" }] });
        if ("error" in result) throw new Error(result.message);
        expect(result.not_assessed).toEqual([{ step_type: "shrink_lfc", reason: "no_rule", message: expect.stringContaining("shrink_lfc") }]);
        expect(result.violations).toEqual([]);
        expect(result.ok).toBe(true);
    });

    it("the check asks a UCell draft for no classifier parameter, and asks a classifier draft for its preprocessing scope", () => {
        const scoring: Situation = { ...BASE, question: "signature_scoring" };
        const ucell = check(snapshot, { situation: scoring, steps: [{ step_type: "signature_scoring", method: "UCell rank-based signature scores per sample", package: "UCell" }] });
        if ("error" in ucell) throw new Error(ucell.message);
        expect(ucell.violations).toEqual([]);
        expect(ucell.warnings).toEqual([]);
        const glmnet = check(snapshot, {
            situation: { ...scoring, classifier: true },
            steps: [{ step_type: "signature_scoring", method: "Penalized logistic classifier with glmnet, nested cross-validation, and a pROC curve", package: "glmnet" }],
        });
        if ("error" in glmnet) throw new Error(glmnet.message);
        expect(glmnet.violations).toEqual([]);
        expect(glmnet.warnings.map((warning) => warning.parameter)).toEqual(["preprocessing_scope"]);
    });

    it("a Python preference selects the Python template of the same method, and no preference keeps the R one", () => {
        const python = answer(BASE, { language: "python" });
        expect(step(python, "differential_expression").method?.id).toBe("M-0001");
        expect(step(python, "differential_expression").template).toBe("tpl-pydeseq2-two-group@1.0.0");
        expect(step(python, "qc_sample_structure").template).toBe("tpl-qc-python@1.0.0");
        expect(step(python, "enrichment").template).toBe("tpl-gseapy-preranked@1.0.0");
        const r = answer(BASE, { language: "R" });
        expect(step(r, "differential_expression").template).toBe("tpl-deseq2-two-group@1.1.0");
        expect(step(answer(BASE), "enrichment").template).toBe("tpl-fgsea-preranked@1.0.0");
        // A paired design has a Python mirror that honors the pair, thus the preference selects it with no limit.
        const paired = answer({ ...BASE, paired: true }, { language: "python" });
        expect(step(paired, "differential_expression").method?.id).toBe("M-0001");
        expect(step(paired, "differential_expression").template).toBe("tpl-pydeseq2-blocked@1.0.0");
        expect(step(paired, "differential_expression").package?.name).toBe("pydeseq2");
        expect(step(paired, "differential_expression").limit).toBeUndefined();
        expect(step(paired, "differential_expression").substitution).toBeUndefined();
        // A repeated-measures design has no Python template: the R template stays, and the step reports the limit.
        const repeated = answer({ ...BASE, paired: true, n_timepoints: 3, n_per_group_min: 3, n_per_group_max: 3 }, { language: "python" });
        expect(step(repeated, "differential_expression").template).toBe("tpl-dream-repeated@1.0.0");
        expect(step(repeated, "differential_expression").limit?.requested_language).toBe("python");
        expect(step(python, "differential_expression").limit).toBeUndefined();
        const none = answer({ ...BASE, n_per_group_min: 1, n_per_group_max: 1 }, { language: "python" });
        expect(step(none, "differential_expression").template).toBe("tpl-descriptive-python@1.0.0");
        const interaction = answer({ ...BASE, n_groups: 4, n_per_group_min: 4, n_per_group_max: 4, interaction: true }, { language: "python" });
        expect(step(interaction, "differential_expression").template).toBe("tpl-pydeseq2-interaction@1.0.0");
        // Three groups: the Python template is a declared substitute, thus the step names the substitute and keeps the method of record.
        const three = answer({ ...BASE, n_groups: 3, n_per_group_min: 4, n_per_group_max: 4 }, { language: "python" });
        expect(step(three, "differential_expression").method?.id).toBe("M-0060");
        expect(step(three, "differential_expression").template).toBe("tpl-pydeseq2-multigroup@1.0.0");
        expect(step(three, "differential_expression").package?.name).toBe("pydeseq2");
        expect(step(three, "differential_expression").substitution).toEqual({ for: "M-0002", label: "DESeq2 likelihood ratio test", template: "tpl-pydeseq2-multigroup@1.0.0" });
        expect(step(three, "differential_expression").limit).toBeUndefined();
    });

    it("per-sample scores: a paired design with a balanced batch cannot select the unpaired score test, and an unpaired design names the substitute", () => {
        const scores: Situation = { ...BASE, enrichment_input: "sample_scores" };
        const paired = answer({ ...scores, paired: true, batch: "known_balanced" }, { language: "python" });
        expect(step(paired, "enrichment").method?.id).toBe("M-0034");
        expect(step(paired, "enrichment").template).toBe("tpl-gsva-hallmark@1.0.0");
        expect(step(paired, "enrichment").package?.name).toBe("GSVA");
        expect(step(paired, "enrichment").substitution).toBeUndefined();
        expect(step(paired, "enrichment").limit).toEqual({ requested_language: "python", reason: expect.stringContaining("python"), skipped: [{ template: "tpl-decoupler-scores@1.0.0", missing: ["pairing", "batch"] }] });
        expect(paired.procedure.some((entry) => entry.template?.startsWith("tpl-decoupler-scores"))).toBe(false);
        const unpaired = answer(scores, { language: "python" });
        expect(step(unpaired, "enrichment").method?.id).toBe("M-0059");
        expect(step(unpaired, "enrichment").template).toBe("tpl-decoupler-scores@1.0.0");
        expect(step(unpaired, "enrichment").package?.name).toBe("decoupler");
        expect(step(unpaired, "enrichment").substitution).toEqual({ for: "M-0034", label: "GSVA per-sample pathway scores with limma on the scores", template: "tpl-decoupler-scores@1.0.0" });
        expect(step(unpaired, "enrichment").limit).toBeUndefined();
        const r = answer(scores);
        expect(step(r, "enrichment").method?.id).toBe("M-0034");
        expect(step(r, "enrichment").template).toBe("tpl-gsva-hallmark@1.0.0");
        expect(step(r, "enrichment").package?.name).toBe("GSVA");
        expect(step(r, "enrichment").substitution).toBeUndefined();
    });

    it("the check accepts a drafted enrichment step that names the substitute for the unpaired situation, and refuses it for the paired one", () => {
        const draft: CheckRequest["steps"][number] = { step_type: "enrichment", method: "decoupler ulm per-sample pathway scores with a two-sample t-test on the scores", package: "decoupler", method_id: "M-0059" };
        const unpaired = check(snapshot, { situation: { ...BASE, enrichment_input: "sample_scores" }, steps: [draft] });
        if ("error" in unpaired) throw new Error(unpaired.message);
        expect(unpaired.violations).toEqual([]);
        expect(unpaired.not_assessed).toEqual([]);
        const paired = check(snapshot, { situation: { ...BASE, enrichment_input: "sample_scores", paired: true, batch: "known_balanced" }, steps: [draft] });
        if ("error" in paired) throw new Error(paired.message);
        expect(paired.violations).toHaveLength(1);
        expect(paired.violations[0]?.message).toContain("not a permitted method");
        expect(paired.violations[0]?.permitted).toContain("GSVA per-sample pathway scores with limma on the scores");
    });

    it("the render names the method the template runs and the method of record it stands in for", async () => {
        const substitute = await render(snapshot, {
            template: "tpl-decoupler-scores@1.0.0",
            slots: { counts_path: "/a/data/inputs/x/counts.csv", metadata_path: "/a/data/inputs/y/metadata.csv", condition_column: "condition", reference_level: "control", test_level: "treated", gmt_path: "/a/refs/hallmark.gmt" },
        });
        if ("error" in substitute) throw new Error(substitute.message);
        expect(substitute.template).toMatchObject({ id: "tpl-decoupler-scores", language: "python", method: { id: "M-0059", label: "decoupler ulm per-sample pathway scores with a two-sample t-test on the scores" }, substitute_for: { id: "M-0034", label: "GSVA per-sample pathway scores with limma on the scores" } });
        expect(substitute.decision_record.template).toEqual({ id: "tpl-decoupler-scores", version: "1.0.0", label: expect.any(String), method: { id: "M-0059", label: expect.any(String) }, substitute_for: { id: "M-0034", label: expect.any(String) } });
        const record = await render(snapshot, {
            template: "tpl-gsva-hallmark@1.0.0",
            slots: { counts_path: "/a/data/inputs/x/counts.csv", metadata_path: "/a/data/inputs/y/metadata.csv", condition_column: "condition", reference_level: "control", test_level: "treated", gmt_path: "/a/refs/hallmark.gmt" },
        });
        if ("error" in record) throw new Error(record.message);
        expect(record.decision_record.template.method).toEqual({ id: "M-0034", label: "GSVA per-sample pathway scores with limma on the scores" });
        expect(record.decision_record.template.substitute_for).toBeUndefined();
    });

    it("the wider computations: each new question kind has a method on its central step, and an extra analysis joins a full plan", () => {
        expect(step(answer({ ...BASE, question: "tf_activity" }), "tf_activity").method?.id).toBe("M-0035");
        expect(step(answer({ ...BASE, question: "tf_activity" }), "pathway_activity").method?.id).toBe("M-0036");
        const deconvolution = answer({ ...BASE, question: "deconvolution" });
        expect(step(deconvolution, "deconvolution").method?.id).toBe("M-0041");
        expect(hasParameter(deconvolution, "deconvolution", "cell_types")).toBe(false);
        const scores = answer({ ...BASE, question: "signature_scoring" });
        expect(step(scores, "signature_scoring").method?.id).toBe("M-0045");
        for (const name of ["classifier_model", "classifier_validation", "classifier_performance", "preprocessing_scope"]) {
            expect(hasParameter(scores, "signature_scoring", name)).toBe(false);
        }
        expect(step(scores, "signature_scoring").parameters?.some((entry) => entry.required)).toBeFalsy();
        const classifier = answer({ ...BASE, question: "signature_scoring", classifier: true });
        expect(step(classifier, "signature_scoring").method?.id).toBe("M-0055");
        expect(parameter(classifier, "signature_scoring", "classifier_model")).toBe("penalized_logistic_regression");
        expect(parameter(classifier, "signature_scoring", "classifier_validation")).toBe("nested_cross_validation");
        expect(parameter(classifier, "signature_scoring", "classifier_performance")).toBe("roc_auc_with_confidence_interval");
        expect(parameter(classifier, "signature_scoring", "preprocessing_scope")).toBe("filter_and_scaling_inside_each_training_fold");
        expect(step(classifier, "signature_scoring").parameters?.find((entry) => entry.name === "preprocessing_scope")?.required).toBe(true);
        expect(hasParameter(classifier, "signature_scoring", "score_method")).toBe(false);
        expect(step(answer({ ...BASE, question: "clustering", n_per_group_min: 60, n_per_group_max: 60 }), "clustering").method?.id).toBe("M-0048");
        const survival = answer({ ...BASE, question: "survival", n_per_group_min: 60, n_per_group_max: 60 });
        expect(step(survival, "survival").method?.id).toBe("M-0053");
        expect(hasParameter(survival, "survival", "penalty")).toBe(false);
        expect(step(survival, "signature_scoring").method?.id).toBe("M-0045");
        expect(parameter(survival, "survival", "score_scale")).toBe("per_standard_deviation");
        expect(parameter(survival, "survival", "event_count_statement")).toBe("state_events_censored_and_median_follow_up");
        const large = answer({ ...BASE, question: "coexpression", n_per_group_min: 60, n_per_group_max: 60 });
        expect(step(large, "coexpression").method?.id).toBe("M-0047");
        expect(parameter(large, "coexpression", "min_module_size")).toBe(30);
        expect(parameter(large, "coexpression", "merge_cut_height")).toBe(0.25);
        const small = answer({ ...BASE, question: "coexpression" });
        expect(small.match).toBe("flag");
        expect(step(small, "coexpression").forbids).toContain("M-0047");
        const extra = answer({ ...BASE, extra_analyses: ["tf_activity", "variance_partition"] });
        expect(step(extra, "tf_activity").method?.id).toBe("M-0035");
        expect(step(extra, "variance_partition").method?.id).toBe("M-0049");
        expect(step(extra, "differential_expression").method?.id).toBe("M-0001");
        const transcripts = answer({ ...BASE, extra_analyses: ["transcript_level"] });
        expect(transcripts.flags.some((flag) => flag.outcome?.startsWith("stop"))).toBe(true);
    });

    it("one group: a differential expression question stops, and a time course takes the LRT of time with ashr on the contrasts", () => {
        const none = answer({ ...BASE, question: "differential_expression", n_groups: 1 });
        expect(none.match).toBe("flag");
        expect(none.flags.some((flag) => flag.outcome === "stop_no_comparison_group")).toBe(true);
        const course = answer({ ...BASE, question: "differential_expression", n_groups: 1, n_per_group_min: 3, n_per_group_max: 3, n_timepoints: 4 });
        expect(course.match).toBe("applicable");
        expect(step(course, "differential_expression").method?.id).toBe("M-0002");
        expect(step(course, "differential_expression").rules[0]).toMatch(/^R-0171@/);
        expect(parameter(course, "differential_expression", "full")).toBe("~ time");
        expect(parameter(course, "differential_expression", "reduced")).toBe("~ 1");
        expect(step(course, "differential_expression").template).toBe("tpl-deseq2-lrt-timecourse@1.2.0");
        expect(step(course, "shrink_lfc").method?.id).toBe("M-0014");
        expect(step(course, "shrink_lfc").rules[0]).toMatch(/^R-0172@/);
        // A two-group time course shrinks its contrasts the same way, and the multi-group LRT keeps its own ashr rule.
        const two = answer({ ...BASE, n_per_group_min: 3, n_per_group_max: 3, n_timepoints: 4 });
        expect(step(two, "differential_expression").rules[0]).toMatch(/^R-0014@/);
        expect(step(two, "shrink_lfc").rules[0]).toMatch(/^R-0172@/);
        expect(step(answer({ ...BASE, n_groups: 3, n_per_group_min: 4, n_per_group_max: 4 }), "shrink_lfc").rules[0]).toMatch(/^R-0040@/);
    });

    it("mouse deconvolution takes mMCP-counter through the immunedeconv template, and the absolute methods take the same template", () => {
        const mouse = answer({ ...BASE, question: "deconvolution", organism: "mouse" });
        expect(mouse.match).toBe("applicable");
        expect(step(mouse, "deconvolution").method?.id).toBe("M-0061");
        expect(step(mouse, "deconvolution").template).toBe("tpl-immunedeconv@1.1.0");
        expect(parameter(mouse, "deconvolution", "method")).toBe("mmcp_counter");
        expect(step(mouse, "deconvolution").forbids).toEqual(expect.arrayContaining(["M-0041", "M-0042", "M-0043", "M-0044"]));
        const tpm = answer({ ...BASE, question: "deconvolution", data_state: "tpm_or_fpkm" });
        expect(step(tpm, "deconvolution").method?.id).toBe("M-0043");
        expect(step(tpm, "deconvolution").template).toBe("tpl-immunedeconv@1.1.0");
        expect(parameter(tpm, "deconvolution", "method")).toBe("epic");
    });

    it("log-scale input reaches a limma-trend template for a paired, a multi-group, a time course, and an interaction design", () => {
        const tpm: Situation = { ...BASE, data_state: "tpm_or_fpkm" };
        expect(step(answer({ ...tpm, paired: true }), "differential_expression").template).toBe("tpl-limma-trend-logvalues@1.1.0");
        expect(step(answer({ ...tpm, n_groups: 3, n_per_group_min: 4, n_per_group_max: 4 }), "differential_expression").template).toBe("tpl-limma-trend-multigroup@1.0.0");
        expect(step(answer({ ...tpm, n_per_group_min: 3, n_per_group_max: 3, n_timepoints: 4 }), "differential_expression").template).toBe("tpl-limma-trend-timecourse@1.0.0");
        expect(step(answer({ ...tpm, n_groups: 1, n_per_group_min: 3, n_per_group_max: 3, n_timepoints: 4 }), "differential_expression").template).toBe("tpl-limma-trend-timecourse@1.0.0");
        expect(step(answer({ ...tpm, n_groups: 4, n_per_group_min: 4, n_per_group_max: 4, interaction: true }), "differential_expression").template).toBe("tpl-limma-trend-interaction@1.0.0");
        for (const template of ["tpl-limma-trend-multigroup", "tpl-limma-trend-timecourse", "tpl-limma-trend-interaction"]) {
            expect(snapshot.templates.get(template)?.method).toBe("M-0005");
        }
    });

    it("the classifier and the penalized Cox have a template, and the Python mirrors follow the preference", () => {
        const classifier = answer({ ...BASE, question: "signature_scoring", classifier: true, n_per_group_min: 60, n_per_group_max: 60 });
        expect(step(classifier, "signature_scoring").template).toBe("tpl-glmnet-classifier@1.0.0");
        expect(snapshot.templates.get("tpl-glmnet-cox")?.method).toBe("M-0054");
        expect(templateHolds(snapshot.templates.get("tpl-glmnet-cox")!, "survival", { ...BASE, question: "survival", n_per_group_min: 60, n_per_group_max: 60 })).toBe(true);
        const paired = answer({ ...BASE, paired: true, blocking_factor: "subject" }, { language: "python" });
        expect(step(paired, "differential_expression").template).toBe("tpl-pydeseq2-blocked@1.0.0");
        expect(step(paired, "differential_expression").substitution).toBeUndefined();
        const pathways = answer({ ...BASE, question: "tf_activity" }, { language: "python" });
        expect(step(pathways, "pathway_activity").template).toBe("tpl-decoupler-py-pathway-activity@1.0.0");
        // A human gene list: the Disease Ontology complement has a template, and it holds for that situation only.
        const list: Situation = { ...BASE, question: "enrichment", enrichment_input: "gene_list" };
        expect(snapshot.templates.get("tpl-dose-ora")?.method).toBe("M-0058");
        expect(templateHolds(snapshot.templates.get("tpl-dose-ora")!, "enrichment", list)).toBe(true);
        expect(templateHolds(snapshot.templates.get("tpl-dose-ora")!, "enrichment", { ...list, organism: "mouse" })).toBe(false);
        expect(step(answer(list), "enrichment").alternatives?.some((alternative) => alternative.method === "M-0058")).toBe(true);
    });

    it("the answer carries the claims the procedure references and no other, for each question kind and under a flag", () => {
        const cases: Record<string, Situation> = {
            qc: { ...BASE, question: "qc" },
            differential_expression: { ...BASE, question: "differential_expression" },
            enrichment: { ...BASE, question: "enrichment" },
            full_plan: BASE,
            no_replicates: { ...BASE, n_per_group_min: 1, n_per_group_max: 1 },
        };
        for (const [label, situation] of Object.entries(cases)) {
            const response = answer(situation);
            const returned = new Set(response.claims.map((claim) => claim.id));
            const referenced = new Set(response.procedure.flatMap((entry) => entry.rules));
            expect(returned, label).toEqual(referenced);
            // One view per claim, and every flag, alternative, and dispute of the answer resolves in the claims.
            expect(response.claims.length, label).toBe(referenced.size);
            expect(returned, label).toEqual(referencedOf(response));
        }
        // A QC answer holds one claim, on its own step: no method claim of another step reaches it.
        const qc = answer(cases.qc!);
        expect(qc.procedure.map((entry) => entry.step)).toEqual(["qc_sample_structure"]);
        expect(qc.claims.map((claim) => claim.step_type)).toEqual(["qc_sample_structure"]);
        const flagged = answer({ ...cases.qc!, quality_flags: ["low_depth_sample"] });
        expect(flagged.claims.map((claim) => claim.rule).sort()).toEqual(["R-0008", "R-0033"]);
        // No replicates: the enrichment flag that removes inference names the DE rule, and that claim is in the answer.
        const none = answer(cases.no_replicates!);
        const descriptive = step(none, "enrichment").flags?.find((flag) => flag.outcome === "descriptive_only");
        expect(descriptive).toBeDefined();
        expect(none.claims.find((claim) => claim.id === descriptive!.rule)?.rule).toBe("R-0003");
        // The view of a claim the answer omits stays on demand, by id, from the snapshot.
        const omitted = [...snapshot.rulesByClaim.values()].find((stored) => stored.rule.action.step_type === "enrichment" && stored.rule.status === "active");
        expect(omitted).toBeDefined();
        expect(qc.claims.some((claim) => claim.id === omitted!.claim)).toBe(false);
        expect(claimView(snapshot, omitted!, true).id).toBe(omitted!.claim);
    });
});

/** The claim ids a procedure references: the step rules, the step flags, the alternatives, the disputes, and the top-level flags. */
function referencedOf(response: RecommendResponse): Set<string> {
    const ids = new Set<string>();
    for (const entry of response.procedure) {
        for (const rule of entry.rules) ids.add(rule);
        for (const flag of entry.flags ?? []) ids.add(flag.rule);
        for (const alternative of entry.alternatives ?? []) for (const rule of alternative.rules) ids.add(rule);
        if (entry.disputed) ids.add(entry.disputed.rule);
    }
    for (const flag of response.flags) ids.add(flag.rule);
    return ids;
}
