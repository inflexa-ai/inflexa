/**
 * Pure evaluation of a rule's `applies` conditions against the known dataset
 * facts. Three outcomes, and the third one is load-bearing: a condition over
 * a fact the profile does not hold gives `not_evaluable`, never a guess. The
 * grounded plan gate turns `not_evaluable` into advice, and only `applies`
 * into enforcement (the knowledge-rule-records spec).
 */

import type { RuleRecord } from "./rule-record.js";

/**
 * The dataset facts a rule condition can test. Every field is optional
 * because every one of them can be unknown — an unprofiled analysis has none.
 */
export interface KnowledgeFacts {
    /** The profile's domain, for example "transcriptomics". */
    readonly omicsType?: string;
    /** The profile's subtype, for example "bulk-rna-seq". */
    readonly omicsSubtype?: string;
    /** The smallest per-condition sample count, when a structured source holds it. */
    readonly minGroupN?: number;
}

export type RuleApplicability = "applies" | "not_applicable" | "not_evaluable";

type ConditionOutcome = "pass" | "fail" | "unknown";

/** Case- and separator-insensitive token set: "bulk RNA-seq" and "bulk_rna_seq" both give {bulk, rna, seq}. */
function tokensOf(value: string): Set<string> {
    return new Set(
        value
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter(Boolean),
    );
}

/**
 * The profile writes free-form terms, thus a bare string equality would drop a
 * rule on a spelling it never saw. The lattice is deliberate: the accepted
 * tokens contained in the fact is a match ("bulk transcriptomics" carries
 * "transcriptomics"), a partial overlap is `unknown` and surfaces as
 * `not_evaluable` ("rna-seq" against "bulk-rna-seq" cannot be decided), and a
 * disjoint pair fails. A rule thus degrades to advice on an ambiguous term,
 * and it never vanishes in silence.
 */
function evaluateCategorical(accepted: readonly string[] | undefined, fact: string | undefined): ConditionOutcome {
    if (accepted === undefined) return "pass";
    if (fact === undefined) return "unknown";
    const factTokens = tokensOf(fact);
    let overlap = false;
    for (const value of accepted) {
        const acceptedTokens = tokensOf(value);
        if (acceptedTokens.size === 0) continue;
        let contained = true;
        for (const token of acceptedTokens) {
            if (factTokens.has(token)) overlap = true;
            else contained = false;
        }
        if (contained) return "pass";
    }
    return overlap ? "unknown" : "fail";
}

function evaluateGroupSize(predicate: { lt?: number; gte?: number } | undefined, fact: number | undefined): ConditionOutcome {
    if (predicate === undefined) return "pass";
    if (fact === undefined) return "unknown";
    if (predicate.lt !== undefined && !(fact < predicate.lt)) return "fail";
    if (predicate.gte !== undefined && !(fact >= predicate.gte)) return "fail";
    return "pass";
}

/**
 * A failed condition dominates: the rule is `not_applicable` whatever the
 * other conditions say. Otherwise one unknown condition makes the whole rule
 * `not_evaluable`. A rule with no conditions applies to everything.
 */
export function evaluateRule(rule: RuleRecord, facts: KnowledgeFacts): RuleApplicability {
    const outcomes: ConditionOutcome[] = [
        evaluateCategorical(rule.applies.omicsType, facts.omicsType),
        evaluateCategorical(rule.applies.omicsSubtype, facts.omicsSubtype),
        evaluateGroupSize(rule.applies.minGroupN, facts.minGroupN),
    ];
    if (outcomes.includes("fail")) return "not_applicable";
    if (outcomes.includes("unknown")) return "not_evaluable";
    return "applies";
}
