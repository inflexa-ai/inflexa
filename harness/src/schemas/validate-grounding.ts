/**
 * The grounded plan gate (the planning-enhancements delta of the
 * knowledge-plane change). Two mechanical checks, both against what the
 * knowledge source actually returned in this invocation:
 *
 * 1. **Citation honesty.** A step may cite only a rule id that the knowledge
 *    brief or a knowledge tool returned. An unreturned citation is rejected —
 *    a citation from model memory is unreliable, and it would poison the
 *    decision chain that the citation exists to build.
 * 2. **Acknowledgment.** Each `reject`-severity rule that `applies` to the
 *    profiled data must be cited somewhere in the plan. The gate enforces the
 *    acknowledgment, not method compliance: a Phase-1 step carries no typed
 *    method, thus compliance stays with the model — but the rule text is in
 *    context, the citation is recorded, and the chain is auditable.
 *
 * `warn` and `note` outcomes, and every `not_evaluable` rule, return as
 * advisories and never block. With no returned rules the gate has nothing to
 * enforce, and it returns empty.
 */

import type { RuleMatch } from "../knowledge/knowledge-base.js";

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

export interface GroundingCheck {
    readonly violations: readonly GroundingViolation[];
    readonly advisories: readonly string[];
}

const MAX_ADVISORIES = 10;

export function checkGrounding(steps: readonly GroundedStep[], returnedRuleIds: ReadonlySet<string>, matches: Iterable<RuleMatch>): GroundingCheck {
    const violations: GroundingViolation[] = [];
    const advisories: string[] = [];

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

    for (const match of matches) {
        const rule = match.rule;
        const cited = citedIds.has(rule.id);
        if (match.applicability === "applies" && rule.effect.severity === "reject") {
            if (!cited) {
                violations.push({
                    path: "plan",
                    message: `applicable rule ${rule.id} (${rule.title}) is not acknowledged: ${rule.effect.statement}`,
                    hint: `Cite ${rule.id} in the grounding of the step it constrains, with a note on how the step obeys it — or revise the plan.`,
                });
            }
            continue;
        }
        if (advisories.length >= MAX_ADVISORIES) continue;
        if (match.applicability === "not_evaluable") {
            advisories.push(`${rule.id} (${rule.title}) could not be evaluated — a fact its conditions test is unknown.`);
        } else if (!cited && (rule.effect.severity === "warn" || rule.effect.severity === "note")) {
            advisories.push(`${rule.id} (${rule.title}) applies and is not cited: ${rule.effect.statement}`);
        }
    }

    return { violations, advisories };
}
