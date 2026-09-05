import { describe, expect, it } from "bun:test";

import { claimId, contentDigest } from "../canonical.js";
import type { Method, Modality, Rule, Situation, Template } from "../model.js";
import { checkSteps, resolveMethod } from "./check.js";
import { evaluateCondition } from "./conditions.js";
import { assembleProcedure, type Catalog } from "./procedure.js";
import { matchRules, type StoredRule } from "./rules.js";

const SITUATION: Situation = {
    question: "differential_expression",
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

const METHODS: Method[] = [
    { id: "M-0001", label: "DESeq2 Wald test", packages: [{ name: "DESeq2", track: "bioconductor", version_range: ">=1.50" }], templates: ["tpl-two-group"] },
    { id: "M-0002", label: "edgeR quasi-likelihood F-test", packages: [{ name: "edgeR", track: "cran" }] },
    { id: "M-0003", label: "limma-voom", packages: [{ name: "limma", track: "cran" }] },
];

const TEMPLATE: Template = {
    id: "tpl-two-group",
    version: "1.0.0",
    label: "two group",
    language: "R",
    method: "M-0001",
    step_types: ["differential_expression"],
    license: "Apache-2.0",
    applicability: { modality: "bulk_rna_seq", min_replicates: 2 },
    parameters: [],
    outputs: [{ name: "results", path: "output/de.csv" }],
    environment: [{ name: "DESeq2", version: "1.52.0", track: "bioconductor" }],
    bioconductor: "3.23",
    body_file: "body.R",
};

const MODALITY: Modality = {
    id: "bulk_rna_seq",
    label: "Bulk RNA-seq",
    step_order: ["qc_sample_structure", "filter_low_counts", "differential_expression", "enrichment", "report"],
    question_steps: {
        differential_expression: ["qc_sample_structure", "filter_low_counts", "differential_expression", "report"],
        enrichment: ["enrichment"],
        qc: ["qc_sample_structure"],
        full_plan: ["qc_sample_structure", "filter_low_counts", "differential_expression", "enrichment", "report"],
    },
};

function rule(partial: Partial<Rule> & Pick<Rule, "id" | "action">): Rule {
    return {
        title: partial.id,
        assertion: `assertion of ${partial.id}`,
        modality: "bulk_rna_seq",
        severity: "info",
        strength: "consensus",
        evidence_quality: "high",
        recommendation_strength: "strong",
        evidence: [{ direction: "supports", eco: "ECO:0000033", source: "S-0001", paraphrase: "x", retrieved: "2026-09-04" }],
        status: "active",
        license: "CC-BY-4.0",
        curator: "test",
        llm_drafted: false,
        curated: "2026-09-04",
        ...partial,
    };
}

function store(rules: Rule[]): StoredRule[] {
    return rules.map((r) => {
        const digest = contentDigest(r);
        return { rule: r, digest, claim: claimId(r.id, digest) };
    });
}

const CATALOG: Catalog = { methods: new Map(METHODS.map((m) => [m.id, m])), templates: new Map([[TEMPLATE.id, TEMPLATE]]) };

describe("evaluateCondition", () => {
    it("fails every comparison over an absent field, and holds only is_null", () => {
        expect(evaluateCondition({ field: "n_timepoints", op: "gte", value: 2 }, SITUATION)).toBe(false);
        expect(evaluateCondition({ field: "n_timepoints", op: "is_null" }, SITUATION)).toBe(true);
        expect(evaluateCondition({ field: "covariates", op: "not_null" }, SITUATION)).toBe(false);
    });
    it("handles in and not_in over lists", () => {
        expect(evaluateCondition({ field: "data_state", op: "in", value: ["counts", "fastq"] }, SITUATION)).toBe(true);
        expect(evaluateCondition({ field: "batch", op: "not_in", value: ["known_confounded"] }, SITUATION)).toBe(true);
    });
});

describe("matchRules and assembleProcedure", () => {
    const rules = store([
        rule({ id: "R-0001", title: "broad", conditions: [{ field: "data_state", op: "eq", value: "counts" }], action: { step_type: "differential_expression", method: "M-0001", parameters: [{ name: "alpha", value: 0.1 }] } }),
        rule({
            id: "R-0002",
            title: "specific",
            conditions: [
                { field: "data_state", op: "eq", value: "counts" },
                { field: "n_per_group_min", op: "gte", value: 3 },
            ],
            action: { step_type: "differential_expression", method: "M-0001", parameters: [{ name: "alpha", value: 0.05, default_source: "doi:x" }] },
            alternatives: [{ method: "M-0002", when: "robustness" }],
        }),
        rule({ id: "R-0003", title: "tpm forbids", conditions: [{ field: "data_state", op: "eq", value: "tpm_or_fpkm" }], action: { step_type: "differential_expression", method: "M-0003", forbids: ["M-0001", "M-0002"] } }),
        rule({ id: "R-0004", title: "filter", action: { step_type: "filter_low_counts", parameters: [{ name: "min_count", value: 10 }] } }),
        rule({ id: "R-0005", title: "low depth", severity: "warn", conditions: [{ field: "n_groups", op: "eq", value: 2 }], action: { step_type: "qc_sample_structure" } }),
        rule({ id: "R-0006", title: "no replicates", severity: "flag", conditions: [{ field: "n_per_group_min", op: "lt", value: 2 }], action: { step_type: "differential_expression", outcome: "descriptive_only" } }),
    ]);

    it("orders by specificity and merges parameters with the specific rule last", () => {
        const { applicable } = matchRules(rules, SITUATION);
        expect(applicable.map((m) => m.rule.id)).toEqual(["R-0002", "R-0001", "R-0005", "R-0004"]);
        const procedure = assembleProcedure(applicable, SITUATION, MODALITY, CATALOG);
        const de = procedure.steps.find((s) => s.step === "differential_expression")!;
        expect(de.method?.id).toBe("M-0001");
        expect(de.parameters).toEqual([{ name: "alpha", value: 0.05, default_source: "doi:x" }]);
        expect(de.template).toBe("tpl-two-group@1.0.0");
        expect(de.alternatives?.map((a) => a.method)).toEqual(["M-0002"]);
        expect(procedure.uncovered).toEqual(["report"]);
        expect(procedure.central_covered).toBe(true);
        expect(procedure.flagged).toBe(false);
    });

    it("selects the template by the language preference among the templates that hold, and falls back to the first", () => {
        const python: Template = { ...TEMPLATE, id: "tpl-two-group-py", language: "python", body_file: "body.py" };
        const methods = new Map(CATALOG.methods);
        methods.set("M-0001", { ...METHODS[0]!, templates: ["tpl-two-group", "tpl-two-group-py"] });
        const catalog: Catalog = { methods, templates: new Map([[TEMPLATE.id, TEMPLATE], [python.id, python]]) };
        const { applicable } = matchRules(rules, SITUATION);
        const de = (preferences?: { language: "R" | "python" }) => assembleProcedure(applicable, SITUATION, MODALITY, catalog, preferences).steps.find((s) => s.step === "differential_expression")?.template;
        expect(de()).toBe("tpl-two-group@1.0.0");
        expect(de({ language: "python" })).toBe("tpl-two-group-py@1.0.0");
        expect(de({ language: "R" })).toBe("tpl-two-group@1.0.0");
    });

    it("returns the nearest rules when nothing covers the central step", () => {
        const { applicable, nearest } = matchRules(rules, { ...SITUATION, data_state: "log_normalized" });
        const procedure = assembleProcedure(applicable, { ...SITUATION, data_state: "log_normalized" }, MODALITY, CATALOG);
        expect(procedure.central_covered).toBe(false);
        expect(nearest.map((n) => n.title)).toContain("broad");
    });

    it("flags a design without replicates and reports the permitted outcome", () => {
        const situation = { ...SITUATION, n_per_group_min: 1, n_per_group_max: 1 };
        const { applicable } = matchRules(rules, situation);
        const procedure = assembleProcedure(applicable, situation, MODALITY, CATALOG);
        expect(procedure.flagged).toBe(true);
        const de = procedure.steps.find((s) => s.step === "differential_expression")!;
        expect(de.flags?.[0]).toMatchObject({ severity: "flag", outcome: "descriptive_only" });
    });

    it("checks drafted steps: a forbidden method is a violation, a changed default is a warning", () => {
        const tpm = { ...SITUATION, data_state: "tpm_or_fpkm" as const };
        const { applicable } = matchRules(rules, tpm);
        const result = checkSteps(applicable, tpm, [{ step_type: "differential_expression", method: "DESeq2 Wald", package: "DESeq2" }], MODALITY, CATALOG);
        expect(result.ok).toBe(false);
        expect(result.violations[0]?.message).toContain("forbidden");
        expect(result.violations[0]?.permitted).toEqual(["limma-voom"]);

        const counts = matchRules(rules, SITUATION);
        const drafted = checkSteps(counts.applicable, SITUATION, [{ step_type: "differential_expression", method: "DESeq2", parameters: [{ name: "alpha", value: 0.1 }] }], MODALITY, CATALOG);
        expect(drafted.violations).toEqual([]);
        expect(drafted.warnings[0]?.message).toContain("alpha");
    });

    it("turns a flag that permits a labeled result into a warning, and a flag that removes inference into a violation", () => {
        const flags = store([
            rule({ id: "R-0020", title: "confounded", severity: "flag", conditions: [{ field: "batch", op: "eq", value: "known_confounded" }], action: { step_type: "differential_expression", outcome: "confounded_label_or_stop" } }),
            rule({ id: "R-0021", title: "no replicates", severity: "flag", conditions: [{ field: "n_per_group_min", op: "lt", value: 2 }], action: { step_type: "differential_expression", outcome: "descriptive_only" } }),
        ]);
        const confounded = { ...SITUATION, batch: "known_confounded" as const };
        const labeled = checkSteps(matchRules(flags, confounded).applicable, confounded, [{ step_type: "differential_expression", method: "DESeq2 Wald test, labeled as confounded" }], MODALITY, CATALOG);
        expect(labeled.violations).toEqual([]);
        expect(labeled.warnings[0]?.message).toContain("confounded_label_or_stop");
        const single = { ...SITUATION, n_per_group_min: 1, n_per_group_max: 1 };
        const inference = checkSteps(matchRules(flags, single).applicable, single, [{ step_type: "differential_expression", method: "DESeq2 Wald test" }], MODALITY, CATALOG);
        expect(inference.violations[0]?.message).toContain("descriptive_only");
    });

    it("accepts a draft that states the outcome of a flag that removes inference, and refuses an inferential draft", () => {
        const flags = store([
            rule({ id: "R-0021", title: "no replicates", severity: "flag", conditions: [{ field: "n_per_group_min", op: "lt", value: 2 }], action: { step_type: "differential_expression", method: "M-0015", outcome: "descriptive_only" } }),
        ]);
        const methods = new Map(CATALOG.methods);
        methods.set("M-0015", { id: "M-0015", label: "Descriptive log fold changes only, no inferential test", packages: [{ name: "DESeq2", track: "bioconductor" }] });
        const catalog = { ...CATALOG, methods };
        const single = { ...SITUATION, n_per_group_min: 1, n_per_group_max: 1 };
        const applicable = matchRules(flags, single).applicable;
        const check = (draft: Parameters<typeof checkSteps>[2][number]) => checkSteps(applicable, single, [draft], MODALITY, catalog);

        expect(check({ step_type: "differential_expression", method: "DESeq2 Wald test", package: "DESeq2" }).violations[0]?.message).toContain('outcome: "descriptive_only"');
        expect(check({ step_type: "differential_expression", method: "DESeq2 Wald test", package: "DESeq2", outcome: "descriptive_only" }).violations).toEqual([]);
        expect(check({ step_type: "differential_expression", method: "Descriptive only: normalized counts + log2 fold change, no inferential test (n=1 per group)", package: "DESeq2" }).violations).toEqual([]);
        // A draft with no descriptive mark resolves to the Wald test and keeps the violation, with the instruction.
        expect(check({ step_type: "differential_expression", method: "log2 fold change of normalized counts", package: "DESeq2" }).violations[0]?.message).toContain("Do not revise the wording again");
    });

    it("resolves a drafted step to the method with the closest label, not to a longer label that shares its tokens", () => {
        const methods = new Map<string, Method>([
            ["M-0001", { id: "M-0001", label: "DESeq2 Wald test with apeglm log fold change shrinkage", packages: [{ name: "DESeq2", track: "bioconductor" }, { name: "apeglm", track: "bioconductor" }] }],
            ["M-0013", { id: "M-0013", label: "apeglm log fold change shrinkage", packages: [{ name: "apeglm", track: "bioconductor" }] }],
        ]);
        expect(resolveMethod({ step_type: "shrink_lfc", method: "apeglm log fold change shrinkage" }, methods)?.id).toBe("M-0013");
        expect(resolveMethod({ step_type: "differential_expression", method: "DESeq2 Wald test", package: "DESeq2" }, methods)?.id).toBe("M-0001");
        methods.set("M-0002", { id: "M-0002", label: "DESeq2 likelihood ratio test", packages: [{ name: "DESeq2", track: "bioconductor" }] });
        expect(resolveMethod({ step_type: "differential_expression", method: "DESeq2 Wald test", package: "DESeq2" }, methods)?.id).toBe("M-0001");
        methods.set("M-0018", { id: "M-0018", label: "ComBat-seq batch adjustment of raw counts", packages: [{ name: "sva", track: "bioconductor" }] });
        expect(resolveMethod({ step_type: "model_design", method: "~ condition only; no batch term, no ComBat-seq" }, methods, { labels: false })).toBeUndefined();
    });

    it("does not warn when a symbolic default meets a numeric draft value", () => {
        const symbolic = store([
            rule({ id: "R-0010", title: "filter", action: { step_type: "filter_low_counts", method: "M-0001", parameters: [{ name: "min_samples", value: "smallest_group_size" }, { name: "min_count", value: 10 }] } }),
        ]);
        const { applicable } = matchRules(symbolic, SITUATION);
        const result = checkSteps(applicable, SITUATION, [{ step_type: "filter_low_counts", method: "DESeq2 Wald test", parameters: [{ name: "min_samples", value: 6 }, { name: "min_count", value: 5 }] }], MODALITY, CATALOG);
        expect(result.warnings.map((w) => w.message)).toEqual([expect.stringContaining("min_count")]);
    });

    it("says ok when the drafted steps agree with the rules", () => {
        const { applicable } = matchRules(rules, SITUATION);
        const result = checkSteps(applicable, SITUATION, [{ step_type: "differential_expression", method: "DESeq2 Wald test", package: "DESeq2" }], MODALITY, CATALOG);
        expect(result.ok).toBe(true);
    });
});
