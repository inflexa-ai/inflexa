/**
 * Test-only `KnowledgeClient` with canned answers. Not a `*.test.ts` file, so
 * the test runner ignores it; imported by the knowledge tool unit tests.
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

export function recommendAnswer(): RecommendResponse {
    return {
        match: "applicable",
        snapshot: SNAPSHOT,
        procedure: [
            { step: "qc_sample_structure", method: { id: "M-0006", label: "Sample structure QC" }, template: "tpl-qc-eda@1.0.0", rules: ["R-0033@1a2b"] },
            {
                step: "differential_expression",
                method: { id: "M-0001", label: "DESeq2 Wald test with apeglm log fold change shrinkage" },
                package: { name: "DESeq2", track: "bioconductor" },
                template: "tpl-deseq2-two-group@1.0.0",
                rules: ["R-0001@e7d0"],
                parameters: [{ name: "alpha", value: 0.05, default_source: "doi:10.1186/s13059-014-0550-8" }],
                alternatives: [{ method: "M-0003", label: "edgeR quasi-likelihood F-test", when: "robustness" }],
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
            {
                id: "R-0001@e7d0",
                statement: "With 2 to 11 replicates use DESeq2 Wald or edgeR QL.",
                strength: "consensus",
                evidence: [{ doi: "10.1261/rna.053959.115", title: "How many biological replicates", year: 2016, direction: "supports" }],
            },
        ],
    };
}

export function renderAnswer(): RenderResponse {
    return {
        ok: true,
        snapshot: SNAPSHOT,
        template: { id: "tpl-deseq2-two-group", version: "1.0.0", label: "DESeq2 two-group", method: "M-0001", language: "R" },
        script: 'COUNTS <- "/analysis-001/data/inputs/f1/counts.csv"  # [adaptable: counts_path]\nmessage("hello")\n',
        slots: [{ name: "counts_path", value: "/analysis-001/data/inputs/f1/counts.csv", source: "caller", adaptable: true, lines: [1] }],
        environment: { match: "exact" },
        syntax: { status: "ok" },
        outputs: [{ name: "results", path: "output/de_results.csv" }],
        decision_record: {
            schema: "inflexa.decision_record/0.1",
            template: { id: "tpl-deseq2-two-group", version: "1.0.0" },
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
    const checkAnswer: CheckResponse = { ok: true, snapshot: SNAPSHOT, violations: [], warnings: [] };
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
