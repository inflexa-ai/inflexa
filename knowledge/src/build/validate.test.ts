import { describe, expect, it } from "bun:test";

import type { KnowledgeBase, Rule, Template } from "../model.js";
import { validateKnowledgeBase } from "./validate.js";

function rule(partial: Partial<Rule> & Pick<Rule, "id" | "action">): Rule {
    return {
        title: partial.id,
        assertion: `assertion of ${partial.id}`,
        modality: "bulk_rna_seq",
        severity: "info",
        strength: "consensus",
        evidence_quality: "high",
        recommendation_strength: "strong",
        evidence: [{ direction: "supports", eco: "ECO:0000033", source: "S-0001", paraphrase: "x", retrieved: "2026-09-07" }],
        status: "active",
        license: "CC-BY-4.0",
        curator: "test",
        llm_drafted: false,
        curated: "2026-09-07",
        ...partial,
    };
}

function template(partial: Partial<Template> & Pick<Template, "id" | "method" | "step_types">): Template & { readonly body: string } {
    return {
        version: "1.0.0",
        label: partial.id,
        language: "R",
        license: "Apache-2.0",
        applicability: { modality: "bulk_rna_seq" },
        parameters: [],
        outputs: [{ name: "results", path: "output/results.csv" }],
        environment: [{ name: "limma", version: "3.60.0", track: "bioconductor" }],
        bioconductor: "3.23",
        body_file: "body.R",
        body: "",
        ...partial,
    };
}

const KB: KnowledgeBase = {
    sources: [{ id: "S-0001", title: "a source", year: 2026, doi: "10.1000/x" }],
    methods: [
        { id: "M-0001", label: "DESeq2 Wald test" },
        { id: "M-0003", label: "edgeR quasi-likelihood F-test" },
    ],
    rules: [],
    templates: [],
    modalities: [],
    terms: [],
};

describe("validateKnowledgeBase", () => {
    it("accepts a condition over classifier, import_state, and the engine-derived inferential_method, and a method-scoped parameter", () => {
        const scoped = rule({
            id: "R-0001",
            conditions: [
                { field: "classifier", op: "eq", value: true },
                { field: "import_state", op: "eq", value: "quantifications" },
                { field: "inferential_method", op: "in", value: ["M-0001", "M-0003"] },
            ],
            action: { step_type: "normalize", parameters: [{ name: "size_factors", value: "median_of_ratios", methods: ["M-0001"] }] },
        });
        expect(validateKnowledgeBase({ ...KB, rules: [scoped] })).toEqual([]);
    });

    it("rejects a parameter scope that names an unknown method, or that leaves out the method of the rule", () => {
        const unknown = rule({ id: "R-0003", action: { step_type: "enrichment", parameters: [{ name: "gsea_input", value: "full_ranked_list", methods: ["M-0999"] }] } });
        expect(validateKnowledgeBase({ ...KB, rules: [unknown] }).map((issue) => issue.message)).toEqual(["parameter gsea_input names an unknown method M-0999"]);
        const foreign = rule({ id: "R-0004", action: { step_type: "differential_expression", method: "M-0001", parameters: [{ name: "test", value: "Wald", methods: ["M-0003"] }] } });
        expect(validateKnowledgeBase({ ...KB, rules: [foreign] }).map((issue) => issue.message)).toEqual(["parameter test scopes to M-0003 but not to the method of the rule M-0001"]);
        const holding = rule({ id: "R-0005", action: { step_type: "differential_expression", method: "M-0001", parameters: [{ name: "test", value: "Wald", methods: ["M-0001", "M-0003"] }] } });
        expect(validateKnowledgeBase({ ...KB, rules: [holding] })).toEqual([]);
    });

    it("asks a template that a method lists under a different method for substitute_for equal to that method", () => {
        const methods = [...KB.methods, { id: "M-0034", label: "GSVA with limma", templates: ["tpl-gsva", "tpl-scores"] }, { id: "M-0059", label: "decoupler scores with a t-test", templates: ["tpl-scores"] }];
        const gsva = template({ id: "tpl-gsva", method: "M-0034", step_types: ["enrichment"] });
        const foreign = template({ id: "tpl-scores", method: "M-0059", step_types: ["enrichment"] });
        expect(validateKnowledgeBase({ ...KB, methods, templates: [gsva, foreign] }).map((issue) => issue.message)).toEqual([
            "lists the template tpl-scores of the method M-0059, and the template does not name M-0034 in substitute_for",
        ]);
        const bound = template({ ...foreign, substitute_for: "M-0034" });
        expect(validateKnowledgeBase({ ...KB, methods, templates: [gsva, bound] })).toEqual([]);
        // A filter method has no template of its own: it lists the count-model templates that realize its step.
        const filter = { id: "M-0007", label: "Low count filter", templates: ["tpl-gsva"] };
        expect(validateKnowledgeBase({ ...KB, methods: [...methods, filter], templates: [gsva, bound] })).toEqual([]);
    });

    it("asks substitute_for for a known method, not the own method, that shares a step type through a template or a rule", () => {
        const methods = [...KB.methods, { id: "M-0034", label: "GSVA with limma", templates: ["tpl-gsva"] }, { id: "M-0059", label: "decoupler scores with a t-test", templates: ["tpl-scores"] }];
        const gsva = template({ id: "tpl-gsva", method: "M-0034", step_types: ["enrichment"] });
        const own = template({ id: "tpl-scores", method: "M-0059", substitute_for: "M-0059", step_types: ["enrichment"] });
        expect(validateKnowledgeBase({ ...KB, methods, templates: [gsva, own] }).map((issue) => issue.message)).toEqual(["substitute_for names the own method M-0059"]);
        const unknown = template({ ...own, substitute_for: "M-0999" });
        expect(validateKnowledgeBase({ ...KB, methods, templates: [gsva, unknown] }).map((issue) => issue.message)).toEqual(["substitute_for names an unknown method M-0999"]);
        const apart = template({ ...own, substitute_for: "M-0034", step_types: ["tf_activity"] });
        expect(validateKnowledgeBase({ ...KB, methods, templates: [gsva, apart] }).map((issue) => issue.message)).toEqual([
            "substitute_for names M-0034, and no template or rule of that method shares a step type with this template",
        ]);
        const throughRule = rule({ id: "R-0102", action: { step_type: "tf_activity", method: "M-0034" } });
        expect(validateKnowledgeBase({ ...KB, methods, rules: [throughRule], templates: [gsva, apart] })).toEqual([]);
    });

    it("asks a template that runs a test between groups for an honors declaration, and leaves the other templates alone", () => {
        const metadata = [{ name: "counts", path: "{{counts_path}}" }, { name: "metadata", path: "{{metadata_path}}" }];
        const groupTest = template({ id: "tpl-group", method: "M-0001", step_types: ["enrichment"], inputs: metadata, applicability: { modality: "bulk_rna_seq", min_replicates: 3 } });
        expect(validateKnowledgeBase({ ...KB, templates: [groupTest] }).map((issue) => issue.message)).toEqual([
            "runs a test between groups and must declare applicability.honors (an empty list declares that the script honors no design requirement)",
        ]);
        const declared = template({ ...groupTest, applicability: { modality: "bulk_rna_seq", min_replicates: 3, honors: [] } });
        expect(validateKnowledgeBase({ ...KB, templates: [declared] })).toEqual([]);
        const noReplication = template({ ...groupTest, applicability: { modality: "bulk_rna_seq", min_replicates: 1 } });
        expect(validateKnowledgeBase({ ...KB, templates: [noReplication] })).toEqual([]);
        const resultsOnly = template({ ...groupTest, inputs: [{ name: "results", path: "{{results_path}}" }] });
        expect(validateKnowledgeBase({ ...KB, templates: [resultsOnly] })).toEqual([]);
        const qc = template({ ...groupTest, step_types: ["qc_sample_structure"] });
        expect(validateKnowledgeBase({ ...KB, templates: [qc] })).toEqual([]);
    });

    it("rejects a condition over a field that is not a Situation slot", () => {
        const foreign = rule({ id: "R-0002", conditions: [{ field: "selected_method", op: "eq", value: "M-0001" }], action: { step_type: "normalize", method: "M-0001" } });
        expect(validateKnowledgeBase({ ...KB, rules: [foreign] }).map((issue) => issue.message)).toEqual(["condition names an unknown Situation field selected_method"]);
    });
});
