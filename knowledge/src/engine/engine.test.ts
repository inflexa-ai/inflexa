import { describe, expect, it } from "bun:test";

import { claimId, contentDigest } from "../canonical.js";
import type { Method, Modality, Rule, Situation, Template } from "../model.js";
import { normalizeSituation } from "../service/handlers.js";
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

function claimOf(stored: readonly StoredRule[], id: string): string {
    const found = stored.find((entry) => entry.rule.id === id);
    if (!found) throw new Error(`no stored rule ${id}`);
    return found.claim;
}

const COUNTS = { field: "data_state", op: "eq", value: "counts" } as const;

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

    it("orders by specificity, and the specific rule of the same method overrides the broad default", () => {
        const { applicable } = matchRules(rules, SITUATION);
        expect(applicable.map((m) => m.rule.id)).toEqual(["R-0002", "R-0001", "R-0005", "R-0004"]);
        const procedure = assembleProcedure(rules, SITUATION, MODALITY, CATALOG);
        expect(procedure.applicable.map((m) => m.rule.id)).toEqual(["R-0002", "R-0001", "R-0005", "R-0004"]);
        const de = procedure.steps.find((s) => s.step === "differential_expression")!;
        expect(de.method?.id).toBe("M-0001");
        expect(de.parameters).toEqual([{ name: "alpha", value: 0.05, default_source: "doi:x" }]);
        expect(de.conflicts).toBeUndefined();
        expect(de.template).toBe("tpl-two-group@1.0.0");
        expect(de.alternatives?.map((a) => a.method)).toEqual(["M-0002"]);
        // A generic parameter of a method-less rule reaches a step that selects no method.
        expect(procedure.steps.find((s) => s.step === "filter_low_counts")?.parameters).toEqual([{ name: "min_count", value: 10 }]);
        expect(procedure.uncovered).toEqual(["report"]);
        expect(procedure.central_covered).toBe(true);
        expect(procedure.flagged).toBe(false);
    });

    it("drops a parameter whose method scope lacks the selected method, and keeps a generic one", () => {
        const scoped = store([
            rule({ id: "R-0011", title: "broad edgeR", conditions: [COUNTS], action: { step_type: "differential_expression", method: "M-0002", parameters: [{ name: "test", value: "QL_F" }] } }),
            rule({
                id: "R-0012",
                title: "specific Wald",
                conditions: [COUNTS, { field: "n_per_group_min", op: "gte", value: 3 }],
                action: { step_type: "differential_expression", method: "M-0001", parameters: [{ name: "test", value: "Wald" }] },
            }),
            rule({
                id: "R-0013",
                title: "method-less with explicit scopes",
                conditions: [COUNTS],
                action: {
                    step_type: "differential_expression",
                    parameters: [
                        { name: "prior_count", value: 2, methods: ["M-0002"] },
                        { name: "alpha", value: 0.05, methods: ["M-0001", "M-0002"] },
                        { name: "fdr", value: "BH" },
                    ],
                },
            }),
        ]);
        const de = assembleProcedure(scoped, SITUATION, MODALITY, CATALOG).steps.find((s) => s.step === "differential_expression")!;
        expect(de.method?.id).toBe("M-0001");
        expect(de.parameters?.map((p) => [p.name, p.value])).toEqual([
            ["test", "Wald"],
            ["alpha", 0.05],
            ["fdr", "BH"],
        ]);
        expect(de.conflicts).toBeUndefined();
        expect(de.alternatives?.map((a) => a.method)).toEqual(["M-0002"]);
        // At 2 vs 2 the broad edgeR rule selects the method, and the Wald parameters drop with it.
        const two = assembleProcedure(scoped, { ...SITUATION, n_per_group_min: 2, n_per_group_max: 2 }, MODALITY, CATALOG).steps.find((s) => s.step === "differential_expression")!;
        expect(two.method?.id).toBe("M-0002");
        expect(two.parameters?.map((p) => [p.name, p.value])).toEqual([
            ["test", "QL_F"],
            ["prior_count", 2],
            ["alpha", 0.05],
            ["fdr", "BH"],
        ]);
    });

    it("reports a conflict at equal specificity and equal strength, omits the parameter, and lets a more specific rule override", () => {
        const tie = store([
            rule({ id: "R-0021", title: "alpha 0.05", conditions: [COUNTS], action: { step_type: "differential_expression", method: "M-0001", parameters: [{ name: "alpha", value: 0.05 }] } }),
            rule({ id: "R-0022", title: "alpha 0.1", conditions: [COUNTS], action: { step_type: "differential_expression", method: "M-0001", parameters: [{ name: "alpha", value: 0.1 }, { name: "fdr", value: "BH" }] } }),
        ]);
        const de = assembleProcedure(tie, SITUATION, MODALITY, CATALOG).steps.find((s) => s.step === "differential_expression")!;
        expect(de.method?.id).toBe("M-0001");
        expect(de.conflicts).toEqual([
            {
                parameter: "alpha",
                entries: [
                    { rule: claimOf(tie, "R-0021"), value: 0.05 },
                    { rule: claimOf(tie, "R-0022"), value: 0.1 },
                ],
            },
        ]);
        expect(de.parameters).toEqual([{ name: "fdr", value: "BH" }]);

        // A strictly more specific rule still overrides, and the tie below it makes no conflict.
        const specific = store([
            ...tie.map((s) => s.rule),
            rule({ id: "R-0023", title: "specific alpha", conditions: [COUNTS, { field: "n_per_group_min", op: "gte", value: 3 }], action: { step_type: "differential_expression", method: "M-0001", parameters: [{ name: "alpha", value: 0.01 }] } }),
        ]);
        const overridden = assembleProcedure(specific, SITUATION, MODALITY, CATALOG).steps.find((s) => s.step === "differential_expression")!;
        expect(overridden.conflicts).toBeUndefined();
        expect(overridden.parameters?.find((p) => p.name === "alpha")?.value).toBe(0.01);

        // At equal specificity the stronger rule wins without a conflict.
        const stronger = store([tie[0]!.rule, { ...tie[1]!.rule, strength: "common_practice" }]);
        const resolved = assembleProcedure(stronger, SITUATION, MODALITY, CATALOG).steps.find((s) => s.step === "differential_expression")!;
        expect(resolved.conflicts).toBeUndefined();
        expect(resolved.parameters?.find((p) => p.name === "alpha")?.value).toBe(0.05);
    });

    it("fires a rule conditioned on inferential_method only in the second pass, after the inferential step selects that method", () => {
        const dependent = store([
            rule({ id: "R-0031", title: "wald", conditions: [COUNTS], action: { step_type: "differential_expression", method: "M-0001" } }),
            rule({ id: "R-0032", title: "limma at two", conditions: [COUNTS, { field: "n_per_group_min", op: "eq", value: 2 }], action: { step_type: "differential_expression", method: "M-0003" } }),
            rule({ id: "R-0033", title: "generic filter", action: { step_type: "filter_low_counts", parameters: [{ name: "min_count", value: 10 }] } }),
            rule({ id: "R-0034", title: "filter for limma", conditions: [{ field: "inferential_method", op: "eq", value: "M-0003" }], action: { step_type: "filter_low_counts", method: "M-0002", parameters: [{ name: "min_count", value: 1 }] } }),
            rule({ id: "R-0035", title: "circular", conditions: [{ field: "inferential_method", op: "eq", value: "M-0003" }], action: { step_type: "differential_expression", method: "M-0001" } }),
        ]);
        const six = assembleProcedure(dependent, SITUATION, MODALITY, CATALOG);
        expect(six.steps.find((s) => s.step === "differential_expression")?.method?.id).toBe("M-0001");
        expect(six.applicable.map((m) => m.rule.id)).not.toContain("R-0034");
        const filterSix = six.steps.find((s) => s.step === "filter_low_counts")!;
        expect(filterSix.method).toBeUndefined();
        expect(filterSix.parameters).toEqual([{ name: "min_count", value: 10 }]);
        expect(filterSix.rules).toEqual([claimOf(dependent, "R-0033")]);

        const situation = { ...SITUATION, n_per_group_min: 2, n_per_group_max: 2 };
        // The first pass never holds the dependent rule: the field is absent from the situation of the caller.
        expect(matchRules(dependent, situation).applicable.map((m) => m.rule.id)).not.toContain("R-0034");
        const two = assembleProcedure(dependent, situation, MODALITY, CATALOG);
        expect(two.applicable.map((m) => m.rule.id)).toContain("R-0034");
        const de = two.steps.find((s) => s.step === "differential_expression")!;
        expect(de.method?.id).toBe("M-0003");
        // A rule that reads the derived field never selects the inferential step.
        expect(de.rules).not.toContain(claimOf(dependent, "R-0035"));
        const filterTwo = two.steps.find((s) => s.step === "filter_low_counts")!;
        expect(filterTwo.method?.id).toBe("M-0002");
        expect(filterTwo.parameters).toEqual([{ name: "min_count", value: 1 }]);
        expect(filterTwo.rules).toEqual([claimOf(dependent, "R-0034"), claimOf(dependent, "R-0033")]);
    });

    it("selects the template by the language preference among the templates that hold, and falls back to the first", () => {
        const python: Template = { ...TEMPLATE, id: "tpl-two-group-py", language: "python", body_file: "body.py" };
        const methods = new Map(CATALOG.methods);
        methods.set("M-0001", { ...METHODS[0]!, templates: ["tpl-two-group", "tpl-two-group-py"] });
        const catalog: Catalog = { methods, templates: new Map([[TEMPLATE.id, TEMPLATE], [python.id, python]]) };
        const de = (preferences?: { language: "R" | "python" }) => assembleProcedure(rules, SITUATION, MODALITY, catalog, preferences).steps.find((s) => s.step === "differential_expression")?.template;
        expect(de()).toBe("tpl-two-group@1.0.0");
        expect(de({ language: "python" })).toBe("tpl-two-group-py@1.0.0");
        expect(de({ language: "R" })).toBe("tpl-two-group@1.0.0");
    });

    const HONORING: Template = { ...TEMPLATE, applicability: { modality: "bulk_rna_seq", min_replicates: 2, honors: ["pairing", "blocking_factor", "covariates", "batch"] } };
    const NO_DESIGN: Template = { ...TEMPLATE, id: "tpl-two-group-py", language: "python", body_file: "body.py", applicability: { modality: "bulk_rna_seq", min_replicates: 2, honors: [] } };

    it("skips a template whose honors lacks a requirement of the design, and reports the limit of the requested language", () => {
        const methods = new Map(CATALOG.methods);
        methods.set("M-0001", { ...METHODS[0]!, templates: ["tpl-two-group", "tpl-two-group-py"] });
        const catalog: Catalog = { methods, templates: new Map([[HONORING.id, HONORING], [NO_DESIGN.id, NO_DESIGN]]) };
        const de = (situation: Situation, preferences?: { language: "R" | "python" }) => assembleProcedure(rules, situation, MODALITY, catalog, preferences).steps.find((s) => s.step === "differential_expression")!;

        const paired = de({ ...SITUATION, paired: true }, { language: "python" });
        expect(paired.template).toBe("tpl-two-group@1.0.0");
        expect(paired.method?.id).toBe("M-0001");
        expect(paired.limit).toEqual({ requested_language: "python", reason: expect.stringContaining("python"), skipped: [{ template: "tpl-two-group-py@1.0.0", missing: ["pairing"] }] });
        expect(paired.substitution).toBeUndefined();
        // Each requirement of the situation is named; a suspected batch is not one.
        expect(de({ ...SITUATION, paired: true, blocking_factor: "subject", covariates: ["age"], batch: "known_balanced" }, { language: "python" }).limit?.skipped[0]?.missing).toEqual(["pairing", "blocking_factor", "covariates", "batch"]);
        expect(de({ ...SITUATION, batch: "suspected" }, { language: "python" }).template).toBe("tpl-two-group-py@1.0.0");
        // Without the requirement the Python template holds and no limit is reported; without a preference there is no limit.
        const unpaired = de(SITUATION, { language: "python" });
        expect(unpaired.template).toBe("tpl-two-group-py@1.0.0");
        expect(unpaired.limit).toBeUndefined();
        expect(de({ ...SITUATION, paired: true }).limit).toBeUndefined();
        expect(de({ ...SITUATION, paired: true }, { language: "R" }).limit).toBeUndefined();
        // A template with no honors is not subject to the design requirements.
        const undeclared: Catalog = { methods, templates: new Map([[HONORING.id, HONORING], [NO_DESIGN.id, { ...NO_DESIGN, applicability: { modality: "bulk_rna_seq", min_replicates: 2 } }]]) };
        expect(assembleProcedure(rules, { ...SITUATION, paired: true }, MODALITY, undeclared, { language: "python" }).steps.find((s) => s.step === "differential_expression")?.template).toBe("tpl-two-group-py@1.0.0");
        // A method with no template of the requested language reports the limit as well.
        const rOnly: Catalog = { methods: new Map(CATALOG.methods), templates: new Map([[HONORING.id, HONORING]]) };
        const limited = assembleProcedure(rules, SITUATION, MODALITY, rOnly, { language: "python" }).steps.find((s) => s.step === "differential_expression")!;
        expect(limited.template).toBe("tpl-two-group@1.0.0");
        expect(limited.limit).toEqual({ requested_language: "python", reason: expect.stringContaining("no python template"), skipped: [] });
    });

    it("names a declared substitute as the method of the step, keeps the method of record in substitution.for, and takes the package of the language", () => {
        const record: Method = { id: "M-0001", label: "DESeq2 Wald test", packages: [{ name: "DESeq2", track: "bioconductor", version_range: ">=1.50" }, { name: "apeglm", track: "bioconductor" }, { name: "pydeseq2", track: "python", version_range: ">=0.5" }], templates: ["tpl-two-group", "tpl-two-group-py", "tpl-sub-py"] };
        const substitute: Method = { id: "M-0090", label: "pydeseq2 Wald contrasts per level", stato: "STATO:0000176", packages: [{ name: "pydeseq2", track: "python", version_range: ">=0.5" }], templates: ["tpl-sub-py"] };
        const subTemplate: Template = { ...NO_DESIGN, id: "tpl-sub-py", method: "M-0090", substitute_for: "M-0001", applicability: { modality: "bulk_rna_seq", min_replicates: 2, honors: ["pairing", "blocking_factor", "covariates", "batch"] } };
        const methods = new Map(CATALOG.methods);
        methods.set(record.id, record);
        methods.set(substitute.id, substitute);
        const catalog: Catalog = { methods, templates: new Map([[HONORING.id, HONORING], [NO_DESIGN.id, NO_DESIGN], [subTemplate.id, subTemplate]]) };
        const de = (situation: Situation, preferences?: { language: "R" | "python" }) => assembleProcedure(rules, situation, MODALITY, catalog, preferences).steps.find((s) => s.step === "differential_expression")!;

        // Unpaired: the same-method Python mirror comes first, and the package follows the language.
        const mirrored = de(SITUATION, { language: "python" });
        expect(mirrored.method?.id).toBe("M-0001");
        expect(mirrored.template).toBe("tpl-two-group-py@1.0.0");
        expect(mirrored.package?.name).toBe("pydeseq2");
        expect(mirrored.substitution).toBeUndefined();
        // Paired: the mirror is skipped, the substitute holds, and the step names the substitute.
        const substituted = de({ ...SITUATION, paired: true }, { language: "python" });
        expect(substituted.method).toEqual({ id: "M-0090", label: "pydeseq2 Wald contrasts per level", stato: "STATO:0000176" });
        expect(substituted.package).toEqual({ name: "pydeseq2", track: "python", version_range: ">=0.5" });
        expect(substituted.template).toBe("tpl-sub-py@1.0.0");
        expect(substituted.substitution).toEqual({ for: "M-0001", label: "DESeq2 Wald test", template: "tpl-sub-py@1.0.0" });
        expect(substituted.limit).toBeUndefined();
        // The rules of the step are unchanged: the substitute rides on the same claims as the method of record.
        expect(substituted.rules).toEqual(de({ ...SITUATION, paired: true }).rules);
        // No preference, or an R preference: the method of record with its R template and its R package.
        for (const step of [de({ ...SITUATION, paired: true }), de({ ...SITUATION, paired: true }, { language: "R" })]) {
            expect(step.method?.id).toBe("M-0001");
            expect(step.template).toBe("tpl-two-group@1.0.0");
            expect(step.package?.name).toBe("DESeq2");
            expect(step.substitution).toBeUndefined();
        }
        // A method whose packages hold no track of the language keeps its first package.
        methods.set(record.id, { ...record, packages: [{ name: "DESeq2", track: "bioconductor" }] });
        expect(de(SITUATION, { language: "python" }).package).toEqual({ name: "DESeq2", track: "bioconductor" });
    });

    it("permits a drafted substitute in the check where its template is eligible, and refuses it elsewhere", () => {
        const record: Method = { ...METHODS[0]!, templates: ["tpl-two-group", "tpl-sub-py"] };
        const substitute: Method = { id: "M-0090", label: "decoupler scores with a t-test", packages: [{ name: "decoupler", track: "python" }], templates: ["tpl-sub-py"] };
        const subTemplate: Template = { ...NO_DESIGN, id: "tpl-sub-py", method: "M-0090", substitute_for: "M-0001" };
        const methods = new Map(CATALOG.methods);
        methods.set(record.id, record);
        methods.set(substitute.id, substitute);
        const catalog: Catalog = { methods, templates: new Map([[HONORING.id, HONORING], [subTemplate.id, subTemplate]]) };
        const draft = { step_type: "differential_expression", method: "decoupler scores with a t-test", package: "decoupler", method_id: "M-0090" } as const;
        const unpaired = checkSteps(matchRules(rules, SITUATION).applicable, SITUATION, [draft], MODALITY, catalog);
        expect(unpaired.violations).toEqual([]);
        const paired = { ...SITUATION, paired: true };
        const refused = checkSteps(matchRules(rules, paired).applicable, paired, [draft], MODALITY, catalog);
        expect(refused.violations).toEqual([expect.objectContaining({ step_type: "differential_expression", permitted: ["DESeq2 Wald test", "edgeR quasi-likelihood F-test"] })]);
        expect(refused.violations[0]?.message).toContain("not a permitted method");
    });

    it("returns the nearest rules when nothing covers the central step", () => {
        const procedure = assembleProcedure(rules, { ...SITUATION, data_state: "log_normalized" }, MODALITY, CATALOG);
        expect(procedure.central_covered).toBe(false);
        expect(procedure.nearest.map((n) => n.title)).toContain("broad");
    });

    it("flags a design without replicates, reports the permitted outcome, and drops the inference-only steps of the walk", () => {
        const situation = { ...SITUATION, n_per_group_min: 1, n_per_group_max: 1 };
        const procedure = assembleProcedure(rules, situation, MODALITY, CATALOG);
        expect(procedure.flagged).toBe(true);
        const de = procedure.steps.find((s) => s.step === "differential_expression")!;
        expect(de.flags?.[0]).toMatchObject({ severity: "flag", outcome: "descriptive_only" });
        // An inference-only step that no rule covers under the descriptive method is dropped, not uncovered.
        const inferential: Modality = { ...MODALITY, question_steps: { ...MODALITY.question_steps, differential_expression: ["qc_sample_structure", "differential_expression", "shrink_lfc", "multiple_testing", "report"] } };
        const dropped = assembleProcedure(rules, situation, inferential, CATALOG);
        expect(dropped.dropped).toEqual(["shrink_lfc", "multiple_testing"]);
        expect(dropped.uncovered).toEqual(["report"]);
        expect(dropped.steps.map((s) => s.step)).toEqual(["qc_sample_structure", "differential_expression"]);
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

    it("warns when a drafted step omits a required parameter, and accepts the step that states it", () => {
        const required = store([
            rule({
                id: "R-0090",
                title: "wald with a required alpha",
                conditions: [{ field: "data_state", op: "eq", value: "counts" }],
                action: { step_type: "differential_expression", method: "M-0001", parameters: [{ name: "alpha", value: 0.05, default_source: "doi:10.1186/s13059-014-0550-8", required: true }] },
            }),
        ]);
        const { applicable } = matchRules(required, SITUATION);
        const omitted = checkSteps(applicable, SITUATION, [{ step_type: "differential_expression", method: "DESeq2 Wald test" }], MODALITY, CATALOG);
        expect(omitted.violations).toEqual([]);
        expect(omitted.warnings.map((finding) => finding.parameter)).toEqual(["alpha"]);
        expect(omitted.warnings[0]?.message).toContain("0.05");
        const stated = checkSteps(applicable, SITUATION, [{ step_type: "differential_expression", method: "DESeq2 Wald test", parameters: [{ name: "alpha", value: 0.05 }] }], MODALITY, CATALOG);
        expect(stated.ok).toBe(true);
    });

    it("does not warn for a required parameter scoped to a method the step does not select", () => {
        const required = store([
            rule({
                id: "R-0090",
                title: "wald with a required alpha",
                conditions: [COUNTS],
                action: { step_type: "differential_expression", method: "M-0001", parameters: [{ name: "alpha", value: 0.05, required: true }] },
            }),
            rule({
                id: "R-0091",
                title: "edgeR with a required prior count",
                conditions: [COUNTS],
                action: { step_type: "differential_expression", method: "M-0002", parameters: [{ name: "prior_count", value: 2, required: true }] },
            }),
        ]);
        const { applicable } = matchRules(required, SITUATION);
        const stated = checkSteps(applicable, SITUATION, [{ step_type: "differential_expression", method: "DESeq2 Wald test", parameters: [{ name: "alpha", value: 0.05 }] }], MODALITY, CATALOG);
        expect(stated.procedure.steps.find((s) => s.step === "differential_expression")?.parameters?.map((p) => p.name)).toEqual(["alpha"]);
        expect(stated.warnings).toEqual([]);
        expect(stated.ok).toBe(true);
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

    const NO_REPLICATES = rule({
        id: "R-0021",
        title: "no replicates",
        severity: "flag",
        conditions: [{ field: "n_per_group_min", op: "lt", value: 2 }],
        action: { step_type: "differential_expression", method: "M-0015", outcome: "descriptive_only", forbids: ["M-0001"] },
    });
    const DESCRIPTIVE: Method = { id: "M-0015", label: "Descriptive log fold changes only, no inferential test", packages: [{ name: "DESeq2", track: "bioconductor" }] };
    const SINGLE = { ...SITUATION, n_per_group_min: 1, n_per_group_max: 1 };

    it("accepts a draft that states the outcome of a flag that removes inference, and refuses a forbidden method under a stated outcome", () => {
        const flags = store([NO_REPLICATES]);
        const methods = new Map(CATALOG.methods);
        methods.set(DESCRIPTIVE.id, DESCRIPTIVE);
        const catalog = { ...CATALOG, methods };
        const applicable = matchRules(flags, SINGLE).applicable;
        const check = (draft: Parameters<typeof checkSteps>[2][number]) => checkSteps(applicable, SINGLE, [draft], MODALITY, catalog);

        expect(check({ step_type: "differential_expression", method: "DESeq2 Wald test", package: "DESeq2" }).violations[0]?.message).toContain('outcome: "descriptive_only"');
        // The outcome field does not carry a forbidden method: the violation cites the flag and names the exact escape.
        const labeled = check({ step_type: "differential_expression", method: "DESeq2 Wald test", package: "DESeq2", outcome: "descriptive_only" });
        expect(labeled.ok).toBe(false);
        expect(labeled.violations).toEqual([expect.objectContaining({ step_type: "differential_expression", rule: claimOf(flags, "R-0021") })]);
        expect(labeled.violations[0]?.message).toContain("method_id");
        expect(labeled.violations[0]?.message).toContain("M-0015");
        expect(check({ step_type: "differential_expression", method: "Descriptive only: normalized counts + log2 fold change, no inferential test (n=1 per group)", package: "DESeq2" }).violations).toEqual([]);
        // A draft with no descriptive mark resolves to the Wald test and keeps the violation, with the instruction.
        expect(check({ step_type: "differential_expression", method: "log2 fold change of normalized counts", package: "DESeq2" }).violations[0]?.message).toContain("Do not revise the wording again");
    });

    it("refuses a draft on a step the flag removed, whatever outcome it states", () => {
        const inferential: Modality = { ...MODALITY, step_order: ["qc_sample_structure", "differential_expression", "shrink_lfc", "multiple_testing", "report"] };
        const dropped = store([
            NO_REPLICATES,
            rule({ id: "R-0024", title: "apeglm", conditions: [COUNTS], action: { step_type: "shrink_lfc", method: "M-0013" } }),
            rule({ id: "R-0025", title: "BH", conditions: [COUNTS], action: { step_type: "multiple_testing", method: "M-0012", parameters: [{ name: "alpha", value: 0.05 }] } }),
        ]);
        const methods = new Map(CATALOG.methods);
        methods.set(DESCRIPTIVE.id, DESCRIPTIVE);
        methods.set("M-0013", { id: "M-0013", label: "apeglm log fold change shrinkage", packages: [{ name: "apeglm", track: "bioconductor" }] });
        methods.set("M-0012", { id: "M-0012", label: "Benjamini-Hochberg false discovery rate", packages: [{ name: "stats", track: "cran" }] });
        const catalog = { ...CATALOG, methods };
        const claim = claimOf(dropped, "R-0021");
        const apeglm = { step_type: "shrink_lfc", method: "apeglm log fold change shrinkage", package: "apeglm", method_id: "M-0013" } as const;
        const bh = { step_type: "multiple_testing", method: "Benjamini-Hochberg", method_id: "M-0012", outcome: "descriptive_only" } as const;

        const applicable = matchRules(dropped, SINGLE).applicable;
        const shrunk = checkSteps(applicable, SINGLE, [apeglm], inferential, catalog);
        expect(shrunk.ok).toBe(false);
        expect(shrunk.violations).toEqual([expect.objectContaining({ step_type: "shrink_lfc", rule: claim })]);
        expect(shrunk.violations[0]?.message).toContain("Remove the shrink_lfc step");
        const adjusted = checkSteps(applicable, SINGLE, [bh], inferential, catalog);
        expect(adjusted.ok).toBe(false);
        expect(adjusted.violations).toEqual([expect.objectContaining({ step_type: "multiple_testing", rule: claim })]);
        expect(checkSteps(applicable, SINGLE, [apeglm, bh], inferential, catalog).violations).toHaveLength(2);
        // With replicates the same drafts meet their rules: the refusal comes from the flag, not from the rules of the steps.
        const six = checkSteps(matchRules(dropped, SITUATION).applicable, SITUATION, [apeglm, bh], inferential, catalog);
        expect(six.violations).toEqual([]);
        expect(six.not_assessed).toEqual([]);
    });

    it("accepts the descriptive method by its exact id, and keeps the violation on the same wording without the id", () => {
        const flags = store([NO_REPLICATES]);
        const methods = new Map(CATALOG.methods);
        methods.set(DESCRIPTIVE.id, DESCRIPTIVE);
        const catalog = { ...CATALOG, methods };
        const applicable = matchRules(flags, SINGLE).applicable;
        const byId = checkSteps(applicable, SINGLE, [{ step_type: "differential_expression", method: "log2 fold change of normalized counts", package: "DESeq2", method_id: "M-0015" }], MODALITY, catalog);
        expect(byId.ok).toBe(true);
        expect(byId.violations).toEqual([]);
        const byWording = checkSteps(applicable, SINGLE, [{ step_type: "differential_expression", method: "log2 fold change of normalized counts", package: "DESeq2" }], MODALITY, catalog);
        expect(byWording.ok).toBe(false);
        expect(byWording.violations[0]?.message).toContain('method_id: "M-0015"');
    });

    it("uses the exact method id over the wording, and refuses an unknown id", () => {
        const { applicable } = matchRules(rules, SITUATION);
        // limma-voom is outside the permitted set at six per group; the id of the permitted method wins over that wording.
        const byWording = checkSteps(applicable, SITUATION, [{ step_type: "differential_expression", method: "limma-voom", package: "limma" }], MODALITY, CATALOG);
        expect(byWording.violations).toHaveLength(1);
        const byId = checkSteps(applicable, SITUATION, [{ step_type: "differential_expression", method: "limma-voom", package: "limma", method_id: "M-0001" }], MODALITY, CATALOG);
        expect(byId.violations).toEqual([]);
        expect(byId.ok).toBe(true);
        const unknown = checkSteps(applicable, SITUATION, [{ step_type: "differential_expression", method: "DESeq2 Wald test", method_id: "M-9999" }], MODALITY, CATALOG);
        expect(unknown.ok).toBe(false);
        expect(unknown.violations).toEqual([expect.objectContaining({ step_type: "differential_expression", rule: claimOf(rules, "R-0002"), permitted: ["DESeq2 Wald test", "edgeR quasi-likelihood F-test"] })]);
        expect(unknown.violations[0]?.message).toContain("M-9999");
        expect(unknown.violations[0]?.message).toContain("M-0001");
        expect(unknown.violations[0]?.message).toContain("M-0002");
    });

    it("reports a draft on a step no rule covers as not assessed, and keeps ok", () => {
        const { applicable } = matchRules(rules, SITUATION);
        const result = checkSteps(applicable, SITUATION, [{ step_type: "enrichment", method: "fgsea on a ranked list", package: "fgsea" }], MODALITY, CATALOG);
        expect(result.not_assessed).toEqual([{ step_type: "enrichment", reason: "no_rule", message: expect.stringContaining("enrichment") }]);
        expect(result.violations).toEqual([]);
        expect(result.warnings).toEqual([]);
        expect(result.ok).toBe(true);
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
        // Two methods that share every label token and the package tie, and a tie is unresolved: the map order must not decide.
        methods.set("M-0098", { id: "M-0098", label: "DESeq2 Wald test", packages: [{ name: "DESeq2", track: "bioconductor" }] });
        methods.set("M-0099", { id: "M-0099", label: "DESeq2 Wald test", packages: [{ name: "DESeq2", track: "bioconductor" }] });
        expect(resolveMethod({ step_type: "differential_expression", method: "DESeq2 Wald test", package: "DESeq2" }, methods)).toBeUndefined();
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

describe("normalizeSituation", () => {
    it("drops a false classifier flag, keeps a true one, and strips the engine-derived inferential_method", () => {
        const forced = normalizeSituation({ ...SITUATION, classifier: false, inferential_method: "M-0003" } as Situation);
        expect("classifier" in forced).toBe(false);
        expect("inferential_method" in forced).toBe(false);
        expect(normalizeSituation({ ...SITUATION, classifier: true }).classifier).toBe(true);
    });
});
