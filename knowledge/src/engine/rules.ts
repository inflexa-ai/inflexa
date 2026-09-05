/**
 * Rule matching and the hit policy.
 *
 * The policy: collect every active rule whose conditions all hold, order the
 * rules of one step type by specificity (the count of conditions), then by
 * strength (consensus before common practice before disputed), then by id
 * for a stable order. A disputed rule is never silently resolved: the caller
 * gets both sides. A flag rule is a result, not an error.
 */

import type { Condition, Rule, Situation } from "../model.js";
import { describeCondition, evaluateCondition } from "./conditions.js";

export interface StoredRule {
    readonly rule: Rule;
    /** The claim identifier, `R-0031@e7d0`. */
    readonly claim: string;
    readonly digest: string;
}

export interface MatchedRule extends StoredRule {
    readonly specificity: number;
}

export interface NearMiss {
    readonly claim: string;
    readonly title: string;
    readonly failed: readonly string[];
}

const STRENGTH_RANK = { consensus: 0, common_practice: 1, disputed: 2 } as const;

export function compareMatched(a: MatchedRule, b: MatchedRule): number {
    if (a.specificity !== b.specificity) return b.specificity - a.specificity;
    const strength = STRENGTH_RANK[a.rule.strength] - STRENGTH_RANK[b.rule.strength];
    if (strength !== 0) return strength;
    return a.rule.id < b.rule.id ? -1 : a.rule.id > b.rule.id ? 1 : 0;
}

export interface MatchResult {
    readonly applicable: readonly MatchedRule[];
    /** The rules that failed the fewest conditions, with the failed predicates. Used by a `match: none` answer. */
    readonly nearest: readonly NearMiss[];
}

export function matchRules(rules: readonly StoredRule[], situation: Situation): MatchResult {
    const applicable: MatchedRule[] = [];
    const misses: { readonly stored: StoredRule; readonly failed: Condition[] }[] = [];
    for (const stored of rules) {
        if (stored.rule.status === "deprecated") continue;
        if (stored.rule.modality !== situation.modality) continue;
        const conditions = stored.rule.conditions ?? [];
        const failed = conditions.filter((condition) => !evaluateCondition(condition, situation));
        if (failed.length === 0) {
            applicable.push({ ...stored, specificity: conditions.length });
        } else {
            misses.push({ stored, failed });
        }
    }
    applicable.sort(compareMatched);
    const fewest = misses.reduce((min, miss) => Math.min(min, miss.failed.length), Number.POSITIVE_INFINITY);
    const nearest = misses
        .filter((miss) => miss.failed.length === fewest)
        .slice(0, 5)
        .map((miss) => ({ claim: miss.stored.claim, title: miss.stored.rule.title, failed: miss.failed.map(describeCondition) }));
    return { applicable, nearest };
}
