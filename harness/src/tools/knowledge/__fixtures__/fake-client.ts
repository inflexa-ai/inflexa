/**
 * Test-only `KnowledgeClient` with canned answers. Not a `*.test.ts` file, so
 * the test runner ignores it; imported by the knowledge tool unit tests.
 *
 * Each recommend answer keeps the invariant of the service: the `claims`
 * array holds one view per rule the procedure references (the step rules,
 * the flags, and the rules of the alternatives), in that order.
 */

import type {
    CheckResponse,
    DraftedStep,
    FarmPackage,
    KnowledgeClient,
    KnowledgeSituation,
    RecommendResponse,
    RenderResponse,
    KnowledgePreferences,
} from "../client.js";

export const SNAPSHOT = { date: "2026-09-04", digest: "sha256:71ac0000000000000000000000000000000000000000000000000000000000ab" };

const DE_METHOD = { id: "M-0001", label: "DESeq2 Wald test with apeglm log fold change shrinkage" };
const QC_STEP = { step: "qc_sample_structure", method: { id: "M-0006", label: "Sample structure QC" }, template: "tpl-qc-eda@1.0.0", rules: ["R-0033@1a2b"] };

function claim(id: string, statement: string): RecommendResponse["claims"][number] {
    return {
        id,
        statement,
        strength: "consensus",
        evidence: [{ doi: "10.1261/rna.053959.115", title: "How many biological replicates", year: 2016, direction: "supports" }],
    };
}

/** A two-group answer: QC, a multiple-testing step with a parameter conflict, the DESeq2 test, and a flagged enrichment. */
export function recommendAnswer(): RecommendResponse {
    return {
        match: "applicable",
        snapshot: SNAPSHOT,
        procedure: [
            QC_STEP,
            {
                step: "differential_expression",
                method: DE_METHOD,
                package: { name: "DESeq2", track: "bioconductor" },
                template: "tpl-deseq2-two-group@1.0.0",
                rules: ["R-0001@e7d0"],
                parameters: [{ name: "alpha", value: 0.05, default_source: "doi:10.1186/s13059-014-0550-8" }],
                alternatives: [{ method: "M-0003", label: "edgeR quasi-likelihood F-test", when: "robustness", rules: ["R-0001@e7d0"] }],
            },
            {
                step: "multiple_testing",
                method: { id: "M-0012", label: "Benjamini-Hochberg false discovery rate" },
                rules: ["R-0010@2b3c", "R-0166@4d5e"],
                conflicts: [
                    {
                        parameter: "independent_filtering",
                        entries: [
                            { rule: "R-0010@2b3c", value: true },
                            { rule: "R-0166@4d5e", value: false },
                        ],
                    },
                ],
            },
            {
                step: "enrichment",
                method: { id: "M-0010", label: "fgsea preranked GSEA on the Wald statistic with MSigDB Hallmark" },
                package: { name: "fgsea", track: "bioconductor" },
                template: "tpl-fgsea-preranked@1.0.0",
                rules: ["R-0107@0a1b"],
                parameters: [{ name: "gene_set_collection", value: "msigdb_hallmark_human" }],
                flags: [{ rule: "R-0103@c0de", severity: "warn", message: "Few DE genes: ORA has no power." }],
            },
        ],
        uncovered: ["report"],
        flags: [],
        claims: [
            claim("R-0033@1a2b", "Inspect the sample structure before the model."),
            claim("R-0001@e7d0", "With 2 to 11 replicates use DESeq2 Wald or edgeR QL."),
            claim("R-0010@2b3c", "Adjust the p-values with Benjamini-Hochberg at alpha 0.05."),
            claim("R-0166@4d5e", "Under the DESeq2 test, the independent filtering of the results follows the test."),
            claim("R-0107@0a1b", "Rank every tested gene by the Wald statistic for a preranked GSEA."),
            claim("R-0103@c0de", "An over-representation analysis on few DE genes has no power."),
        ],
    };
}

/** A Python preference on per-sample pathway scores: the template is a declared substitute of the method of record. */
export function substitutionAnswer(): RecommendResponse {
    return {
        match: "applicable",
        snapshot: SNAPSHOT,
        procedure: [
            { ...QC_STEP, template: "tpl-qc-python@1.0.0" },
            {
                step: "enrichment",
                method: { id: "M-0059", label: "decoupler ulm per-sample pathway scores with a two-sample t-test on the scores" },
                package: { name: "decoupler", track: "python" },
                template: "tpl-decoupler-scores@1.0.0",
                rules: ["R-0102@9c0d"],
                parameters: [{ name: "gene_set_collection", value: "msigdb_hallmark_human" }],
                substitution: { for: "M-0034", label: "GSVA per-sample pathway scores with limma on the scores", template: "tpl-decoupler-scores@1.0.0" },
            },
        ],
        uncovered: ["report"],
        flags: [],
        claims: [
            claim("R-0033@1a2b", "Inspect the sample structure before the model."),
            claim("R-0102@9c0d", "Score each sample per set, then test the scores with the design of the gene-level model."),
        ],
    };
}

/** A Python preference on a paired design: no Python template honors the pairing, thus the step keeps the R template and reports the limit. */
export function limitAnswer(): RecommendResponse {
    return {
        match: "applicable",
        snapshot: SNAPSHOT,
        procedure: [
            { ...QC_STEP, template: "tpl-qc-python@1.0.0" },
            {
                step: "differential_expression",
                method: DE_METHOD,
                package: { name: "DESeq2", track: "bioconductor" },
                template: "tpl-deseq2-blocked@1.0.0",
                rules: ["R-0011@3d4e"],
                limit: {
                    requested_language: "python",
                    reason: "no Python template of M-0001 honors pairing",
                    skipped: [{ template: "tpl-pydeseq2-two-group@1.0.0", missing: ["pairing"] }],
                },
            },
        ],
        uncovered: ["report"],
        flags: [],
        claims: [
            claim("R-0033@1a2b", "Inspect the sample structure before the model."),
            claim("R-0011@3d4e", "A paired design puts the subject in the design as a block."),
        ],
    };
}

/** A clean check whose drafted shrinkage step no rule covers. */
export function notAssessedCheckAnswer(): CheckResponse {
    return {
        ok: true,
        snapshot: SNAPSHOT,
        violations: [],
        warnings: [],
        not_assessed: [
            {
                step_type: "shrink_lfc",
                reason: "no_rule",
                message: "No rule of the snapshot covers shrink_lfc in this situation. The check did not assess it.",
            },
        ],
    };
}

export function renderAnswer(): RenderResponse {
    return {
        ok: true,
        snapshot: SNAPSHOT,
        template: { id: "tpl-deseq2-two-group", version: "1.0.0", label: "DESeq2 two-group", method: DE_METHOD, language: "R" },
        script: 'COUNTS <- "/analysis-001/data/inputs/f1/counts.csv"  # [adaptable: counts_path]\nmessage("hello")\n',
        slots: [{ name: "counts_path", value: "/analysis-001/data/inputs/f1/counts.csv", source: "caller", adaptable: true, lines: [1] }],
        environment: { match: "exact" },
        syntax: { status: "ok" },
        outputs: [{ name: "results", path: "output/de_results.csv" }],
        decision_record: {
            schema: "inflexa.decision_record/0.1",
            template: { id: "tpl-deseq2-two-group", version: "1.0.0", label: "DESeq2 two-group", method: DE_METHOD },
            snapshot: SNAPSHOT,
            slots: [],
            unvetted_edits: [],
        },
    };
}

/** A render of a declared substitute: the template object names the substitute as its method and the method of record beside it. */
export function substituteRenderAnswer(): RenderResponse {
    const method = { id: "M-0059", label: "decoupler ulm per-sample pathway scores with a two-sample t-test on the scores" };
    const substitute_for = { id: "M-0034", label: "GSVA per-sample pathway scores with limma on the scores" };
    return {
        ...renderAnswer(),
        template: { id: "tpl-decoupler-scores", version: "1.0.0", label: "decoupler pathway scores", method, substitute_for, language: "python" },
        script: 'SCORES = "/analysis-001/data/inputs/f1/counts.csv"  # [adaptable: counts_path]\nprint("hello")\n',
        decision_record: {
            schema: "inflexa.decision_record/0.1",
            template: { id: "tpl-decoupler-scores", version: "1.0.0", label: "decoupler pathway scores", method, substitute_for },
            snapshot: SNAPSHOT,
            slots: [],
            unvetted_edits: [],
        },
    };
}

export interface FakeCalls {
    readonly recommend: { situation: KnowledgeSituation; preferences?: KnowledgePreferences }[];
    readonly check: { situation: KnowledgeSituation; steps: readonly DraftedStep[] }[];
    readonly render: { template: string; slots: Readonly<Record<string, unknown>>; farm?: readonly FarmPackage[] }[];
}

export function fakeKnowledgeClient(
    answers: Partial<{
        recommend: Awaited<ReturnType<KnowledgeClient["recommend"]>>;
        check: Awaited<ReturnType<KnowledgeClient["check"]>>;
        render: Awaited<ReturnType<KnowledgeClient["render"]>>;
    }> = {},
): { client: KnowledgeClient; calls: FakeCalls } {
    const calls: FakeCalls = { recommend: [], check: [], render: [] };
    const checkAnswer: CheckResponse = { ok: true, snapshot: SNAPSHOT, violations: [], warnings: [], not_assessed: [] };
    const client: KnowledgeClient = {
        async recommend(situation, _responseFormat, preferences) {
            calls.recommend.push({ situation, ...(preferences ? { preferences } : {}) });
            return answers.recommend ?? recommendAnswer();
        },
        async check(situation, steps) {
            calls.check.push({ situation, steps });
            return answers.check ?? checkAnswer;
        },
        async render(template, slots, farm) {
            calls.render.push({ template, slots, ...(farm ? { farm } : {}) });
            return answers.render ?? renderAnswer();
        },
    };
    return { client, calls };
}
