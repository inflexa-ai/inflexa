import { describe, expect, test } from "bun:test";

import { evaluateRule, type KnowledgeFacts } from "./evaluate-rule.js";
import { CorpusManifestSchema, RuleRecordSchema, type RuleRecord } from "./rule-record.js";

const VALID_RECORD = {
    id: "INFLEXA-R-000101",
    title: "No inferential DE without biological replication",
    applies: { omicsType: ["transcriptomics"], minGroupN: { lt: 2 } },
    effect: {
        severity: "reject",
        statement: "With one sample in a group there is no within-group variance to estimate. Do not run an inferential DE test.",
    },
    recommendation: "Report descriptive log2 fold changes only.",
    evidence: {
        eco: "ECO:0000212",
        sources: [{ citation: "Conesa A et al. (2016) Genome Biology", doi: "10.1186/s13059-016-0881-8" }],
    },
    version: "1.0.0",
};

describe("RuleRecordSchema", () => {
    test("a cited record validates", () => {
        const parsed = RuleRecordSchema.safeParse(VALID_RECORD);
        expect(parsed.success).toBe(true);
    });

    test("a record with no resolvable locator fails validation", () => {
        const uncited = {
            ...VALID_RECORD,
            evidence: { sources: [{ citation: "An unpublished opinion" }] },
        };
        const parsed = RuleRecordSchema.safeParse(uncited);
        expect(parsed.success).toBe(false);
        expect(JSON.stringify(parsed.success ? [] : parsed.error.issues)).toContain("locator");
    });

    test("an unknown condition key fails validation", () => {
        const unknownKey = {
            ...VALID_RECORD,
            applies: { omicsType: ["transcriptomics"], phaseOfMoon: ["full"] },
        };
        const parsed = RuleRecordSchema.safeParse(unknownKey);
        expect(parsed.success).toBe(false);
    });

    test("a malformed id fails validation", () => {
        const parsed = RuleRecordSchema.safeParse({ ...VALID_RECORD, id: "RULE-1" });
        expect(parsed.success).toBe(false);
    });

    test("a pmid or a url is also a resolvable locator", () => {
        const byPmid = { ...VALID_RECORD, evidence: { sources: [{ citation: "X", pmid: "27022035" }] } };
        const byUrl = { ...VALID_RECORD, evidence: { sources: [{ citation: "X", url: "https://example.org/guideline" }] } };
        expect(RuleRecordSchema.safeParse(byPmid).success).toBe(true);
        expect(RuleRecordSchema.safeParse(byUrl).success).toBe(true);
    });
});

describe("CorpusManifestSchema", () => {
    test("a manifest names its identity, its version, and its rule files", () => {
        const parsed = CorpusManifestSchema.safeParse({
            corpusId: "inflexa-knowledge",
            version: "0.1.0",
            ruleFiles: ["rules/bulk-transcriptomics.json"],
        });
        expect(parsed.success).toBe(true);
    });

    test("a manifest with no rule files fails validation", () => {
        const parsed = CorpusManifestSchema.safeParse({ corpusId: "x", version: "1", ruleFiles: [] });
        expect(parsed.success).toBe(false);
    });

    test("an unknown manifest key from a newer corpus is ignored, never fatal", () => {
        const parsed = CorpusManifestSchema.safeParse({
            corpusId: "x",
            version: "0.2.0",
            ruleFiles: ["rules/all.json"],
            description: "a field this harness does not know",
        });
        expect(parsed.success).toBe(true);
    });
});

describe("locator strength", () => {
    test("a doi the citation resolver cannot resolve fails validation", () => {
        const fake = { ...VALID_RECORD, evidence: { sources: [{ citation: "X", doi: "see lab notebook" }] } };
        expect(RuleRecordSchema.safeParse(fake).success).toBe(false);
    });

    test("a doi with a resolver-visible shape passes", () => {
        const real = { ...VALID_RECORD, evidence: { sources: [{ citation: "X", doi: "doi:10.1093/nar/gku864" }] } };
        expect(RuleRecordSchema.safeParse(real).success).toBe(true);
    });
});

describe("evaluateRule", () => {
    const rule = RuleRecordSchema.parse(VALID_RECORD) as RuleRecord;

    test("matching facts give applies", () => {
        const facts: KnowledgeFacts = { omicsType: "Transcriptomics", minGroupN: 1 };
        expect(evaluateRule(rule, facts)).toBe("applies");
    });

    test("a failed condition gives not_applicable", () => {
        const facts: KnowledgeFacts = { omicsType: "transcriptomics", minGroupN: 5 };
        expect(evaluateRule(rule, facts)).toBe("not_applicable");
    });

    test("a missing fact gives not_evaluable", () => {
        const facts: KnowledgeFacts = { omicsType: "transcriptomics" };
        expect(evaluateRule(rule, facts)).toBe("not_evaluable");
    });

    test("a failed condition dominates a missing fact", () => {
        const facts: KnowledgeFacts = { omicsType: "proteomics" };
        expect(evaluateRule(rule, facts)).toBe("not_applicable");
    });

    test("a rule with no conditions applies to everything", () => {
        const universal = RuleRecordSchema.parse({
            ...VALID_RECORD,
            id: "INFLEXA-R-000201",
            applies: {},
        }) as RuleRecord;
        expect(evaluateRule(universal, {})).toBe("applies");
    });

    test("a separator or case variant of a term still matches", () => {
        expect(evaluateRule(rule, { omicsType: "Bulk Transcriptomics", minGroupN: 1 })).toBe("applies");
        const subtyped = RuleRecordSchema.parse({
            ...VALID_RECORD,
            id: "INFLEXA-R-000102",
            applies: { omicsSubtype: ["bulk-rna-seq"] },
        }) as RuleRecord;
        expect(evaluateRule(subtyped, { omicsSubtype: "bulk_rna_seq" })).toBe("applies");
        expect(evaluateRule(subtyped, { omicsSubtype: "bulk RNA-seq" })).toBe("applies");
    });

    test("a partial term overlap degrades to not_evaluable, never to a silent drop", () => {
        const subtyped = RuleRecordSchema.parse({
            ...VALID_RECORD,
            id: "INFLEXA-R-000102",
            applies: { omicsSubtype: ["bulk-rna-seq"] },
        }) as RuleRecord;
        expect(evaluateRule(subtyped, { omicsSubtype: "RNA-seq" })).toBe("not_evaluable");
        expect(evaluateRule(subtyped, { omicsSubtype: "proteomics" })).toBe("not_applicable");
    });

    test("a gte bound composes with an lt bound into a range", () => {
        const ranged = RuleRecordSchema.parse({
            ...VALID_RECORD,
            id: "INFLEXA-R-000103",
            applies: { minGroupN: { gte: 2, lt: 3 } },
        }) as RuleRecord;
        expect(evaluateRule(ranged, { minGroupN: 2 })).toBe("applies");
        expect(evaluateRule(ranged, { minGroupN: 3 })).toBe("not_applicable");
        expect(evaluateRule(ranged, { minGroupN: 1 })).toBe("not_applicable");
    });
});
