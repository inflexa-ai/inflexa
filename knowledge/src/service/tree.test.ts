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
import type { Situation } from "../model.js";
import { openSnapshot, writeSnapshot, type LoadedSnapshot } from "../store.js";
import { check, recommend, render } from "./handlers.js";
import type { RecommendResponse } from "./api.js";

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
let dir: string;

beforeAll(async () => {
    const loaded = await loadKnowledgeBase(join(import.meta.dir, "..", "..", "kb"));
    if (!loaded.ok) throw new Error(loaded.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
    const issues = validateKnowledgeBase(loaded.kb);
    if (issues.length > 0) throw new Error(issues.map((issue) => `${issue.where}: ${issue.message}`).join("\n"));
    dir = mkdtempSync(join(tmpdir(), "kb-tree-"));
    const path = join(dir, "snapshot.sqlite");
    writeSnapshot(path, { kb: loaded.kb, date: "2026-09-04", schemaVersion: "test", vocabularies: [], toolDefinitionHash: "sha256:test" });
    snapshot = openSnapshot(path);
});

afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
});

function answer(situation: Situation): RecommendResponse {
    const result = recommend(snapshot, { situation });
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

describe("the curated tree on the evaluation situations", () => {
    it("two groups, 6 vs 6, one low depth sample: DESeq2 Wald, apeglm, BH 0.05, QC warn, enrichment disputed", () => {
        const response = answer({ ...BASE, quality_flags: ["low_depth_sample"] });
        expect(response.match).toBe("applicable");
        expect(step(response, "differential_expression").method?.id).toBe("M-0001");
        expect(step(response, "differential_expression").template).toBe("tpl-deseq2-two-group@1.0.0");
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
        expect(parameter(response, "enrichment", "universe")).toBe("tested_genes");
        expect(parameter(response, "model_design", "import")).toBe("tximport_lengthScaledTPM_or_offsets");
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
    });

    it("paired: DESeq2 with the subject as a block; repeated measures over time: a random subject effect", () => {
        const paired = answer({ ...BASE, paired: true, blocking_factor: "subject", n_per_group_min: 5, n_per_group_max: 5 });
        expect(step(paired, "differential_expression").method?.id).toBe("M-0001");
        expect(step(paired, "differential_expression").template).toBe("tpl-deseq2-blocked@1.0.0");
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
        expect(step(interaction, "differential_expression").template).toBe("tpl-deseq2-interaction@1.0.0");
        expect(parameter(interaction, "differential_expression", "test")).toBe("interaction");
        const course = answer({ ...BASE, n_timepoints: 4, n_groups: 2, n_per_group_min: 3, n_per_group_max: 3 });
        expect(step(course, "differential_expression").method?.id).toBe("M-0002");
        expect(step(course, "differential_expression").template).toBe("tpl-deseq2-lrt-timecourse@1.0.0");
        expect(parameter(course, "differential_expression", "reduced")).toBe("~ condition + time");
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
    });

    it("a three prime library with Salmon counts imports raw counts with no offset", () => {
        const response = answer({ ...BASE, library_type: "three_prime" });
        expect(parameter(response, "model_design", "import")).toBe("tximport_raw_counts_no_offset");
        expect(parameter(response, "model_design", "counts_from_abundance")).toBe("no");
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
            template: "tpl-deseq2-two-group@1.0.0",
            slots: { counts_path: "/a/data/inputs/x/counts.csv", metadata_path: "/a/data/inputs/y/metadata.csv", condition_column: "condition", reference_level: "control", test_level: "treated" },
            farm: [{ name: "DESeq2", version: "1.52.0" }, { name: "apeglm", version: "1.34.0" }, { name: "ashr", version: "2.2-63" }, { name: "ggplot2", version: "4.0.3" }, { name: "pheatmap", version: "1.0.13" }, { name: "jsonlite", version: "2.0.0" }],
        });
        if ("error" in result) throw new Error(result.message);
        expect(result.environment.match).toBe("exact");
        expect(result.script).toContain('REFERENCE_LEVEL  <- "control"');
        expect(result.script).not.toContain("{{");
        expect(result.decision_record.slots.find((slot) => slot.name === "alpha")).toMatchObject({ source: "default", adaptable: false });
    });

    it("three groups: the LRT with pairwise contrasts and ashr; paired with three groups: the subject in both models", () => {
        const three = answer({ ...BASE, n_groups: 3, n_per_group_min: 4, n_per_group_max: 4 });
        expect(step(three, "differential_expression").method?.id).toBe("M-0002");
        expect(step(three, "differential_expression").template).toBe("tpl-deseq2-multigroup@1.0.0");
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
        expect(step(tpm, "differential_expression").template).toBe("tpl-limma-trend-logvalues@1.0.0");
        const log = answer({ ...BASE, data_state: "log_normalized" });
        expect(parameter(log, "normalize", "normalization")).toBe("none_already_normalized");
        expect(step(log, "differential_expression").method?.id).toBe("M-0005");
    });

    it("outlier sample: DESeq2 stays primary with a warn and the weighted limma-voom as the alternative", () => {
        const response = answer({ ...BASE, n_per_group_min: 5, n_per_group_max: 5, quality_flags: ["outlier_sample"] });
        expect(step(response, "differential_expression").method?.id).toBe("M-0001");
        expect(step(response, "differential_expression").alternatives?.map((a) => a.method)).toContain("M-0023");
        expect(step(response, "differential_expression").flags?.some((flag) => flag.severity === "warn")).toBe(true);
        expect(parameter(response, "differential_expression", "outlier_sample_policy")).toBe("down_weight_not_remove");
    });

    it("suspected batch: surrogate variables on the design with the sva template, and a warn on the multiple testing", () => {
        const response = answer({ ...BASE, batch: "suspected" });
        expect(step(response, "model_design").method?.id).toBe("M-0025");
        expect(step(response, "model_design").template).toBe("tpl-deseq2-sva@1.0.0");
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
        expect(alternatives).toEqual(expect.arrayContaining(["M-0032", "M-0033", "M-0034"]));
    });

    it("no replicates: a stated descriptive outcome passes the check, an inferential draft does not, and the fourth check is the host's to refuse", () => {
        const situation = { ...BASE, n_per_group_min: 1, n_per_group_max: 1 };
        const inferential = check(snapshot, { situation, steps: [{ step_type: "differential_expression", method: "DESeq2 Wald test", package: "DESeq2" }] });
        if ("error" in inferential) throw new Error(inferential.message);
        expect(inferential.violations.length).toBeGreaterThan(0);
        const stated = check(snapshot, { situation, steps: [{ step_type: "differential_expression", method: "Descriptive log2 fold change of normalized counts, no test", package: "DESeq2", outcome: "descriptive_only" }] });
        if ("error" in stated) throw new Error(stated.message);
        expect(stated.violations).toEqual([]);
    });
});
