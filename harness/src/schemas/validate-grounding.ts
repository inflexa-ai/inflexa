/**
 * The grounded plan gate (the planning-enhancements delta of the
 * knowledge-plane change). The gate has two arms, and they carry different
 * force on purpose:
 *
 * 1. **Citation honesty — blocking.** A step can cite only a rule id that the
 *    knowledge brief or a knowledge tool returned in this invocation. An
 *    unreturned citation is rejected. The test is mechanical, it needs no
 *    knowledge of the data, and it has no false positive: the set is exactly
 *    what the source returned. A citation from model memory would poison the
 *    decision chain that the citation exists to build.
 * 2. **Rule acknowledgment — advisory.** Every applicable rule that the plan
 *    does not cite comes back as advisory content, ranked by severity. Nothing
 *    blocks.
 *
 * Why the second arm advises and does not block: a Phase-1 step carries no
 * typed method, thus the gate cannot tell whether a step obeys a rule. A block
 * on the citation alone punishes an honest plan for a missing formality, and
 * it rests on a fact supply that Phase 1 does not build. The advisory carries
 * the same rule text to the same reader, and it cannot deadlock a planner.
 *
 * A `reject`-severity advisory is never cut by the cap. It is the one the
 * reader must not miss, and a first-in cap used to drop exactly that one.
 */

import type { RuleMatch } from "../knowledge/knowledge-base.js";
import type { RuleSeverity } from "../knowledge/rule-record.js";

/** The step shape the gate reads — structural, thus a test needs no full plan. */
export interface GroundedStep {
    readonly id: string;
    readonly grounding?: readonly { readonly id: string; readonly note?: string }[];
}

export interface GroundingViolation {
    readonly path: string;
    readonly message: string;
    readonly hint?: string;
}

/** One uncited or unevaluated rule, for the planner and for the analyst. */
export interface GroundingAdvisory {
    readonly ruleId: string;
    readonly severity: RuleSeverity;
    readonly applicability: "applies" | "not_evaluable";
    readonly message: string;
}

export interface GroundingCheck {
    /** Blocking. Citation honesty only. */
    readonly violations: readonly GroundingViolation[];
    /** Never blocking. Ranked `reject` first, and a `reject` entry is never cut. */
    readonly advisories: readonly GroundingAdvisory[];
}

/** The cap on advisories that are NOT `reject` severity. A reject entry always rides. */
const MAX_SOFT_ADVISORIES = 10;

const SEVERITY_RANK: Record<RuleSeverity, number> = { reject: 0, warn: 1, note: 2 };
const APPLICABILITY_RANK: Record<GroundingAdvisory["applicability"], number> = { applies: 0, not_evaluable: 1 };

function compareAdvisories(a: GroundingAdvisory, b: GroundingAdvisory): number {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;
    const byApplicability = APPLICABILITY_RANK[a.applicability] - APPLICABILITY_RANK[b.applicability];
    if (byApplicability !== 0) return byApplicability;
    return a.ruleId.localeCompare(b.ruleId);
}

function advisoryFor(match: RuleMatch, cited: boolean): GroundingAdvisory | null {
    const rule = match.rule;
    if (match.applicability === "not_evaluable") {
        const remedy =
            rule.effect.severity === "reject"
                ? " Give the fact to knowledge_search — for a group-size condition, pass minGroupN — so the rule can be evaluated."
                : "";
        return {
            ruleId: rule.id,
            severity: rule.effect.severity,
            applicability: "not_evaluable",
            message: `${rule.id} (${rule.title}) could not be evaluated, because a fact its conditions test is not established.${remedy}`,
        };
    }
    if (cited) return null;
    const recommendation = rule.recommendation === undefined ? "" : ` Recommendation: ${rule.recommendation}`;
    return {
        ruleId: rule.id,
        severity: rule.effect.severity,
        applicability: "applies",
        message: `${rule.id} (${rule.title}) applies and the plan cites it nowhere: ${rule.effect.statement}${recommendation}`,
    };
}

export function checkGrounding(steps: readonly GroundedStep[], returnedRuleIds: ReadonlySet<string>, matches: Iterable<RuleMatch>): GroundingCheck {
    const violations: GroundingViolation[] = [];

    const citedIds = new Set<string>();
    for (const [index, step] of steps.entries()) {
        for (const cited of step.grounding ?? []) {
            citedIds.add(cited.id);
            if (!returnedRuleIds.has(cited.id)) {
                violations.push({
                    path: `plan.steps[${index}].grounding`,
                    message: `step ${step.id} cites ${cited.id}, but the knowledge source did not return that id in this invocation`,
                    hint: "Cite only rule ids from the Knowledge Rules block of your seed or from a knowledge_search/knowledge_read result.",
                });
            }
        }
    }

    const all: GroundingAdvisory[] = [];
    for (const match of matches) {
        const advisory = advisoryFor(match, citedIds.has(match.rule.id));
        if (advisory !== null) all.push(advisory);
    }
    all.sort(compareAdvisories);

    // The cap counts the soft entries only, thus a `reject` advisory can never
    // be crowded out by a long tail of notes.
    const advisories: GroundingAdvisory[] = [];
    let soft = 0;
    for (const advisory of all) {
        if (advisory.severity === "reject") {
            advisories.push(advisory);
            continue;
        }
        if (soft >= MAX_SOFT_ADVISORIES) continue;
        soft += 1;
        advisories.push(advisory);
    }

    return { violations, advisories };
}
