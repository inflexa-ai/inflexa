/**
 * The check: drafted steps against the applicable rules.
 *
 * The caller sends the situation and the steps it drafted, each with a step
 * type, a method as the model wrote it, the catalog id of that method when
 * the draft copies it from the recommendation, an optional package, and the
 * key parameters. An id names its method exactly. A wording resolves onto the
 * catalog by its package and its label tokens, and a tie stays unresolved.
 * The check compares the method with the permitted set of the step type. A
 * forbidden method or a method outside the permitted set is a violation. A
 * parameter that differs from a sourced default is a warning, and so is a
 * required parameter that the step does not state. A flag rule whose outcome
 * removes inference is a violation on an inferential step, and a draft on a
 * step that such a flag drops is a violation whatever outcome it states. A
 * step that no rule covers is not assessed: the check reports it and never
 * counts it as clean. `ok` means no violation and no warning on the assessed
 * steps.
 */

import type { Method, Modality, Situation, StepType } from "../model.js";
import type { AssembledProcedure, Catalog, ProcedureFlag, ProcedureStep } from "./procedure.js";
import { assembleProcedure, INFERENCE_ONLY_STEPS, removesInference, removingFlag, templateHolds } from "./procedure.js";
import type { MatchedRule } from "./rules.js";

export interface DraftedStep {
    readonly step_type: StepType;
    readonly method: string;
    /** The catalog id of the method (`M-dddd`), copied from the recommendation. It wins over the wording. */
    readonly method_id?: string;
    readonly package?: string;
    readonly parameters?: readonly { readonly name: string; readonly value: string | number | boolean }[];
    /** The outcome the step states when a flag removes inference, for example `descriptive_only`. */
    readonly outcome?: string;
}

export interface CheckFinding {
    readonly step_type: StepType;
    readonly severity: "violation" | "warning";
    readonly rule: string;
    readonly message: string;
    readonly permitted?: readonly string[];
    /** The name of the required parameter that the step does not state. */
    readonly parameter?: string;
}

/** A drafted step that no rule of the snapshot covers in the situation. The check neither passed nor failed it. */
export interface CheckNotAssessed {
    readonly step_type: StepType;
    readonly reason: "no_rule";
    readonly message: string;
}

export interface CheckResult {
    /** True when the assessed steps carry no violation and no warning. A step in `not_assessed` does not count. */
    readonly ok: boolean;
    readonly violations: readonly CheckFinding[];
    readonly warnings: readonly CheckFinding[];
    readonly not_assessed: readonly CheckNotAssessed[];
}

const STOP_WORDS = new Set(["the", "a", "an", "of", "with", "and", "test", "via", "using", "on", "in", "for", "analysis"]);

function tokens(text: string): Set<string> {
    return new Set(
        text
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter((token) => token.length > 1 && !STOP_WORDS.has(token)),
    );
}

/**
 * Resolve a drafted wording onto the catalog. The score is a heuristic over
 * tokens, not an identity: a shared label token scores one, a named package
 * scores two, a label the draft names in full scores three more, and each
 * label token the draft does not mention costs a quarter point. Thus "apeglm
 * log fold change shrinkage" resolves to the shrinkage method and not to the
 * test method whose label also names apeglm, and "DESeq2 Wald test" resolves
 * to the Wald method and not to the shorter LRT label. A score at or below
 * zero is unresolved, and so is a tie between the two best scores: the
 * tokens cannot tell the two methods apart, and the map order must not
 * decide. A draft that carries the method id never comes here.
 *
 * With `labels: false` only a package name resolves. A step whose rules select
 * no method, for example the design step, carries a formula and prose in its
 * method text, and prose that negates a method ("no ComBat-seq") must not
 * resolve to it.
 */
export function resolveMethod(drafted: DraftedStep, methods: ReadonlyMap<string, Method>, options: { readonly labels: boolean } = { labels: true }): Method | undefined {
    const draftedTokens = tokens(`${drafted.method} ${drafted.package ?? ""}`);
    const packageTokens = tokens(drafted.package ?? "");
    let best: { method: Method; score: number } | undefined;
    let second = 0;
    for (const method of methods.values()) {
        let score = 0;
        for (const pkg of method.packages ?? []) {
            if ((options.labels ? draftedTokens : packageTokens).has(pkg.name.toLowerCase())) score += 2;
        }
        if (options.labels) {
            const labelTokens = tokens(method.label);
            let matched = 0;
            for (const token of labelTokens) {
                if (draftedTokens.has(token)) matched += 1;
                else score -= 0.25;
            }
            score += matched;
            if (matched === labelTokens.size && matched > 0) score += 3;
        }
        if (score <= 0) continue;
        if (best === undefined || score > best.score) {
            second = best?.score ?? 0;
            best = { method, score };
        } else if (score > second) {
            second = score;
        }
    }
    return best !== undefined && best.score > second ? best.method : undefined;
}

/**
 * The methods a draft may name for a step: the method of the step, the
 * alternatives of its rules, and each declared substitute of the method whose
 * template is eligible in the situation. The check assembles the procedure
 * with no language preference, thus the step names the method of record, and
 * a draft that copied a substitute from a recommend under a preference must
 * pass where that recommend named it, and only there.
 */
function permittedOf(step: ProcedureStep, situation: Situation, catalog: Catalog): { ids: string[]; labels: string[] } {
    const ids = [step.method?.id, ...(step.alternatives ?? []).map((alternative) => alternative.method)].filter((id): id is string => id !== undefined);
    if (step.method !== undefined) {
        for (const template of catalog.templates.values()) {
            if (template.substitute_for !== step.method.id || ids.includes(template.method)) continue;
            if (templateHolds(template, step.step, situation)) ids.push(template.method);
        }
    }
    return { ids, labels: ids.map((id) => catalog.methods.get(id)?.label ?? id) };
}

const INFERENTIAL_STEPS: ReadonlySet<StepType> = new Set(["differential_expression", "model_design", "shrink_lfc", "multiple_testing"]);

/**
 * A flag forbids an inferential step only when its outcome removes inference:
 * a descriptive-only design, or a stop. A flag whose outcome permits a labeled
 * result (a confounded batch that the report labels) is a warning on the
 * step, not a violation, because a violation would send the planner into a
 * revision it cannot satisfy.
 */
const forbidsInference = removesInference;

const DESCRIPTIVE_MARKS = ["descriptive", "no inferential", "no test", "no statistical test", "without a test", "not tested"];

/**
 * A draft satisfies a flag that removes inference when it states the outcome:
 * the typed `outcome` field names it, or the method text says the step is
 * descriptive, or the drafted method resolves to a descriptive method of the
 * catalog. A planner that drafted the permitted outcome must not receive a
 * violation, because it has nothing left to revise.
 */
function statesOutcome(draft: DraftedStep, outcome: string, resolved: Method | undefined): boolean {
    if (draft.outcome !== undefined && draft.outcome.toLowerCase() === outcome) return true;
    const text = `${draft.method} ${draft.outcome ?? ""}`.toLowerCase();
    if (outcome === "descriptive_only") {
        if (DESCRIPTIVE_MARKS.some((mark) => text.includes(mark))) return true;
        if (resolved !== undefined && /descriptive/i.test(resolved.label)) return true;
        return false;
    }
    return text.includes(outcome.replace(/_/g, " ")) || text.includes(outcome);
}

/**
 * The violation for a forbidden method under a flag that removes inference.
 * The stated outcome does not change the method, thus the label does not
 * carry the draft. The message names the exact escape, the method id of the
 * step, so the planner has nothing to reword.
 */
function forbiddenUnderFlag(draft: DraftedStep, resolved: Method, expected: ProcedureStep, flag: ProcedureFlag): string {
    const stated = statesOutcome(draft, flag.outcome ?? "", resolved)
        ? `${resolved.label} is forbidden in this situation, and the stated outcome does not change the method.`
        : `${resolved.label} is forbidden in this situation.`;
    const escape =
        expected.method !== undefined
            ? `Permitted: ${expected.method.label} (method_id ${expected.method.id}). State method_id: "${expected.method.id}" with outcome: "${flag.outcome}", then submit.`
            : `Permitted outcome: ${flag.outcome}. State it on the step with outcome: "${flag.outcome}" and a descriptive method, then submit.`;
    return `${flag.message} ${stated} ${escape} Do not revise the wording again.`;
}

export function checkSteps(
    applicable: readonly MatchedRule[],
    situation: Situation,
    drafted: readonly DraftedStep[],
    modality: Modality,
    catalog: Catalog,
): CheckResult & { readonly procedure: AssembledProcedure } {
    const procedure = assembleProcedure(applicable, situation, { ...modality, question_steps: { ...modality.question_steps, [situation.question]: modality.step_order } }, catalog);
    const byStep = new Map(procedure.steps.map((step) => [step.step, step]));
    const removing = removingFlag(procedure.steps);
    const violations: CheckFinding[] = [];
    const warnings: CheckFinding[] = [];
    const not_assessed: CheckNotAssessed[] = [];

    for (const draft of drafted) {
        // A shrinkage or an adjustment under a flag that removes inference has nothing to act on,
        // whatever outcome the draft states. The assembler dropped the step; the check refuses it by the same flag.
        if (removing !== undefined && INFERENCE_ONLY_STEPS.has(draft.step_type)) {
            violations.push({
                step_type: draft.step_type,
                severity: "violation",
                rule: removing.rule,
                message: `${removing.message} The design supports no inferential test, thus there is no fold change to shrink and no p-value to adjust. Remove the ${draft.step_type} step.`,
                permitted: [],
            });
            continue;
        }
        const expected = byStep.get(draft.step_type);
        if (!expected) {
            not_assessed.push({ step_type: draft.step_type, reason: "no_rule", message: `No rule of the snapshot covers ${draft.step_type} in this situation. The check did not assess it.` });
            continue;
        }
        const permitted = permittedOf(expected, situation, catalog);

        // The exact id wins over the wording. An unknown id fails closed, with the permitted ids in the message.
        let resolved: Method | undefined;
        if (draft.method_id !== undefined) {
            resolved = catalog.methods.get(draft.method_id);
            if (resolved === undefined) {
                const named = permitted.ids.length > 0 ? `The rules for this step name: ${permitted.ids.map((id, index) => `${permitted.labels[index]} (${id})`).join("; ")}.` : "The rules for this step name no method.";
                violations.push({
                    step_type: draft.step_type,
                    severity: "violation",
                    rule: expected.rules[0] ?? "",
                    message: `method_id ${draft.method_id} is not in the snapshot. ${named}`,
                    permitted: permitted.labels,
                });
                continue;
            }
        } else {
            resolved = resolveMethod(draft, catalog.methods, { labels: expected.method !== undefined });
        }

        // A draft that states the outcome of a flag that removes inference is accepted as it is:
        // the step is descriptive, and no method of the catalog has to match its wording. The method
        // is judged first, thus a forbidden method under a descriptive label stays forbidden.
        let statedOutcome = false;
        let refused = false;
        for (const flag of expected.flags ?? []) {
            if (flag.severity !== "flag" || flag.outcome === undefined || !INFERENTIAL_STEPS.has(draft.step_type)) continue;
            if (forbidsInference(flag.outcome)) {
                if (resolved !== undefined && (expected.forbids ?? []).includes(resolved.id)) {
                    violations.push({ step_type: draft.step_type, severity: "violation", rule: flag.rule, message: forbiddenUnderFlag(draft, resolved, expected, flag), permitted: permitted.labels });
                    refused = true;
                    break;
                }
                if (statesOutcome(draft, flag.outcome, resolved)) {
                    statedOutcome = true;
                    continue;
                }
                violations.push({
                    step_type: draft.step_type,
                    severity: "violation",
                    rule: flag.rule,
                    message: `${flag.message} Permitted outcome: ${flag.outcome}. State it on the step with outcome: "${flag.outcome}" and a descriptive method, then submit. Do not revise the wording again.`,
                    permitted: permitted.labels,
                });
            } else {
                warnings.push({ step_type: draft.step_type, severity: "warning", rule: flag.rule, message: `${flag.message} Permitted outcome: ${flag.outcome}.` });
            }
        }

        if (refused || statedOutcome) continue;

        if (resolved === undefined) {
            if (permitted.ids.length > 0) {
                warnings.push({
                    step_type: draft.step_type,
                    severity: "warning",
                    rule: expected.rules[0] ?? "",
                    message: `The method "${draft.method}" is not in the catalog. The rules for this step name: ${permitted.labels.join("; ")}.`,
                    permitted: permitted.labels,
                });
            }
            continue;
        }

        if ((expected.forbids ?? []).includes(resolved.id)) {
            violations.push({
                step_type: draft.step_type,
                severity: "violation",
                rule: expected.rules[0] ?? "",
                message: `${resolved.label} is forbidden in this situation.`,
                permitted: permitted.labels,
            });
            continue;
        }

        if (permitted.ids.length > 0 && !permitted.ids.includes(resolved.id)) {
            violations.push({
                step_type: draft.step_type,
                severity: "violation",
                rule: expected.rules[0] ?? "",
                message: `${resolved.label} is not a permitted method for ${draft.step_type} in this situation.`,
                permitted: permitted.labels,
            });
        }

        for (const required of (expected.parameters ?? []).filter((candidate) => candidate.required)) {
            if ((draft.parameters ?? []).some((parameter) => parameter.name === required.name)) continue;
            warnings.push({
                step_type: draft.step_type,
                severity: "warning",
                rule: expected.rules[0] ?? "",
                parameter: required.name,
                message: `The step states no ${required.name}. The rule sets it to ${String(required.value)}${required.default_source ? ` (${required.default_source})` : ""}. State ${required.name} on the step.`,
            });
        }

        for (const parameter of draft.parameters ?? []) {
            const sourced = expected.parameters?.find((candidate) => candidate.name === parameter.name);
            if (!sourced) continue;
            // A symbolic default such as `smallest_group_size` or `factor_numerator_denominator`
            // names a computation or a policy, not a value, and a phrase in the draft is prose.
            // Equality judges neither, thus only a plain value meets a plain value.
            const symbolic = (value: unknown): boolean => typeof value === "string" && /[_\s]/.test(value);
            if (typeof sourced.value === "string" && typeof parameter.value === "number") continue;
            if (symbolic(sourced.value) || symbolic(parameter.value)) continue;
            if (String(sourced.value) !== String(parameter.value)) {
                warnings.push({
                    step_type: draft.step_type,
                    severity: "warning",
                    rule: expected.rules[0] ?? "",
                    message: `Parameter ${parameter.name} = ${String(parameter.value)} differs from the sourced default ${String(sourced.value)}${sourced.default_source ? ` (${sourced.default_source})` : ""}.`,
                });
            }
        }
    }

    return { ok: violations.length === 0 && warnings.length === 0, violations, warnings, not_assessed, procedure };
}
