/**
 * The check: drafted steps against the applicable rules.
 *
 * The caller sends the situation and the steps it drafted, each with a step
 * type, a method as the model wrote it, an optional package, and the key
 * parameters. The check resolves the drafted method onto the catalog by its
 * package and its label tokens, then compares it with the permitted set of
 * the step type. A forbidden method or a method outside the permitted set is
 * a violation. A parameter that differs from a sourced default is a warning.
 * A flag rule whose outcome forbids inference is a violation on an inferential
 * step. Nothing applicable gives `ok`.
 */

import type { Method, Modality, Situation, StepType } from "../model.js";
import type { AssembledProcedure, Catalog, ProcedureStep } from "./procedure.js";
import { assembleProcedure, removesInference } from "./procedure.js";
import type { MatchedRule } from "./rules.js";

export interface DraftedStep {
    readonly step_type: StepType;
    readonly method: string;
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
}

export interface CheckResult {
    readonly ok: boolean;
    readonly violations: readonly CheckFinding[];
    readonly warnings: readonly CheckFinding[];
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
 * Resolve a drafted method onto the catalog. A shared label token scores one,
 * a named package scores two, a label the draft names in full scores three
 * more, and each label token the draft does not mention costs a quarter
 * point. Thus "apeglm log fold change shrinkage" resolves to the shrinkage
 * method and not to the test method whose label also names apeglm, and
 * "DESeq2 Wald test" resolves to the Wald method and not to the shorter LRT
 * label. A score at or below zero is unresolved.
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
        if (score > 0 && (best === undefined || score > best.score)) best = { method, score };
    }
    return best?.method;
}

function permittedOf(step: ProcedureStep, catalog: Catalog): { ids: string[]; labels: string[] } {
    const ids = [step.method?.id, ...(step.alternatives ?? []).map((alternative) => alternative.method)].filter((id): id is string => id !== undefined);
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

export function checkSteps(
    applicable: readonly MatchedRule[],
    situation: Situation,
    drafted: readonly DraftedStep[],
    modality: Modality,
    catalog: Catalog,
): CheckResult & { readonly procedure: AssembledProcedure } {
    const procedure = assembleProcedure(applicable, situation, { ...modality, question_steps: { ...modality.question_steps, [situation.question]: modality.step_order } }, catalog);
    const byStep = new Map(procedure.steps.map((step) => [step.step, step]));
    const violations: CheckFinding[] = [];
    const warnings: CheckFinding[] = [];

    for (const draft of drafted) {
        const expected = byStep.get(draft.step_type);
        if (!expected) continue;
        const permitted = permittedOf(expected, catalog);
        const resolved = resolveMethod(draft, catalog.methods, { labels: expected.method !== undefined });

        // A draft that states the outcome of a flag that removes inference is accepted as it is:
        // the step is descriptive, and no method of the catalog has to match its wording.
        let statedOutcome = false;
        for (const flag of expected.flags ?? []) {
            if (flag.severity !== "flag" || flag.outcome === undefined || !INFERENTIAL_STEPS.has(draft.step_type)) continue;
            if (forbidsInference(flag.outcome)) {
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

        if (statedOutcome) continue;

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

    return { ok: violations.length === 0 && warnings.length === 0, violations, warnings, procedure };
}
