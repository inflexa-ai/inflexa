/**
 * Procedure assembly: from the applicable rules to one ordered procedure.
 *
 * The walk follows the step order of the modality for the question asked.
 * For each step type the most specific rule that names a method selects it.
 * The parameters of every applicable rule of that step type merge, with the
 * more specific rule last, thus a narrow rule overrides a broad default. The
 * other method-naming rules become alternatives. A disputed rule returns its
 * sides and asks the caller to choose and state the choice. A warn or flag
 * rule attaches to the step as a flag with its severity and its permitted
 * outcome.
 */

import type { Method, Modality, ParameterValue, Rule, Situation, StepType, Template, Preferences } from "../model.js";
import { evaluateCondition } from "./conditions.js";
import type { MatchedRule } from "./rules.js";

export interface ProcedureFlag {
    readonly rule: string;
    readonly severity: "warn" | "flag";
    readonly message: string;
    readonly outcome?: string;
}

export interface ProcedureAlternative {
    readonly method: string;
    readonly label: string;
    readonly when: string;
    readonly rules: readonly string[];
}

export interface ProcedureDisputed {
    readonly rule: string;
    readonly sides: readonly string[];
    readonly choose_and_state: true;
}

export interface ProcedureStep {
    readonly step: StepType;
    readonly method?: {
        readonly id: string;
        readonly label: string;
        readonly stato?: string;
        readonly edam?: string;
    };
    readonly package?: {
        readonly name: string;
        readonly track: string;
        readonly version_range?: string;
        readonly bioconductor?: string;
    };
    readonly parameters?: readonly ParameterValue[];
    readonly template?: string;
    readonly rules: readonly string[];
    readonly flags?: readonly ProcedureFlag[];
    readonly alternatives?: readonly ProcedureAlternative[];
    readonly disputed?: ProcedureDisputed;
    readonly forbids?: readonly string[];
}

export interface AssembledProcedure {
    readonly steps: readonly ProcedureStep[];
    /** Step types of the walk that no rule covers. Absence is reported, never filled. */
    readonly uncovered: readonly StepType[];
    /** Step types the procedure drops because a flag removed inference: a shrinkage or a multiple-testing step has nothing to act on. */
    readonly dropped: readonly StepType[];
    /** True when a flag rule changes the outcome of the whole analysis. */
    readonly flagged: boolean;
    /** True when the central step of the question has a method. */
    readonly central_covered: boolean;
}

export interface Catalog {
    readonly methods: ReadonlyMap<string, Method>;
    readonly templates: ReadonlyMap<string, Template>;
}

/** The step whose coverage decides `match: applicable` against `match: none`. */
export function centralStep(question: Situation["question"]): StepType {
    switch (question) {
        case "differential_expression":
        case "full_plan":
            return "differential_expression";
        case "enrichment":
            return "enrichment";
        case "qc":
            return "qc_sample_structure";
        default: {
            const unreachable: never = question;
            throw new Error(`unhandled question: ${String(unreachable)}`);
        }
    }
}

const STRENGTH_ORDER = { disputed: 0, common_practice: 1, consensus: 2 } as const;

function mergeParameters(rules: readonly MatchedRule[]): ParameterValue[] {
    // Broad rules first, specific rules last, thus the specific value wins by
    // name. At equal specificity the stronger rule applies last, thus a
    // consensus value beats a disputed one, and the id keeps a tie stable.
    const ordered = [...rules].sort(
        (a, b) => a.specificity - b.specificity || STRENGTH_ORDER[a.rule.strength] - STRENGTH_ORDER[b.rule.strength] || (a.rule.id < b.rule.id ? 1 : a.rule.id > b.rule.id ? -1 : 0),
    );
    const byName = new Map<string, ParameterValue>();
    for (const matched of ordered) {
        for (const parameter of matched.rule.action.parameters ?? []) byName.set(parameter.name, parameter);
    }
    return [...byName.values()];
}

/**
 * The template of a method for a step: the first template of the method whose
 * applicability holds. A language preference of the caller selects, among the
 * templates that hold, the first one in that language, and falls back to the
 * first one that holds. A preference never changes a rule or a method.
 */
function templateFor(method: Method, step: StepType, situation: Situation, catalog: Catalog, preferences?: Preferences): string | undefined {
    const holding: Template[] = [];
    for (const id of method.templates ?? []) {
        const template = catalog.templates.get(id);
        if (!template) continue;
        if (!template.step_types.includes(step)) continue;
        const applicability = template.applicability;
        if (applicability.count_sources && situation.count_source && !applicability.count_sources.includes(situation.count_source)) continue;
        if (applicability.min_replicates !== undefined && situation.n_per_group_min < applicability.min_replicates) continue;
        if ((applicability.conditions ?? []).some((condition) => !evaluateCondition(condition, situation))) continue;
        holding.push(template);
    }
    const preferred = preferences?.language ? holding.find((template) => template.language === preferences.language) : undefined;
    const chosen = preferred ?? holding[0];
    return chosen ? `${chosen.id}@${chosen.version}` : undefined;
}

function primaryPackage(method: Method): ProcedureStep["package"] {
    const first = method.packages?.[0];
    if (!first) return undefined;
    return {
        name: first.name,
        track: first.track,
        ...(first.version_range ? { version_range: first.version_range } : {}),
        ...(first.bioconductor ? { bioconductor: first.bioconductor } : {}),
    };
}

/** A flag outcome that leaves no inferential test: descriptive only, or a stop. */
export function removesInference(outcome: string): boolean {
    return outcome === "descriptive_only" || outcome.startsWith("stop");
}

function methodLabel(catalog: Catalog, id: string): string {
    return catalog.methods.get(id)?.label ?? id;
}

function flagOf(rule: Rule, claim: string): ProcedureFlag | undefined {
    if (rule.severity === "info") return undefined;
    return {
        rule: claim,
        severity: rule.severity,
        message: rule.assertion,
        ...(rule.action.outcome ? { outcome: rule.action.outcome } : {}),
    };
}

export function assembleProcedure(applicable: readonly MatchedRule[], situation: Situation, modality: Modality, catalog: Catalog, preferences?: Preferences): AssembledProcedure {
    const walk = modality.question_steps[situation.question] ?? modality.step_order;
    const steps: ProcedureStep[] = [];
    const uncovered: StepType[] = [];
    let flagged = false;
    for (const step of walk) {
        const candidates = applicable.filter((matched) => matched.rule.action.step_type === step);
        if (candidates.length === 0) {
            uncovered.push(step);
            continue;
        }
        // A flag that removes inference and names a method (the descriptive method of a design
        // without replicates) is the only method of the step: the others are forbidden, not alternatives.
        const overriding = candidates.find(
            (matched) => matched.rule.severity === "flag" && matched.rule.action.method !== undefined && matched.rule.action.outcome !== undefined && removesInference(matched.rule.action.outcome),
        );
        const selecting = overriding ? [overriding] : candidates.filter((matched) => matched.rule.action.method !== undefined && matched.rule.severity !== "flag");
        const primary = selecting[0];
        const method = primary?.rule.action.method ? catalog.methods.get(primary.rule.action.method) : undefined;
        const flags = candidates.map((matched) => flagOf(matched.rule, matched.claim)).filter((flag): flag is ProcedureFlag => flag !== undefined);
        if (flags.some((flag) => flag.severity === "flag" && flag.outcome !== undefined)) flagged = true;

        const alternatives: ProcedureAlternative[] = [];
        const seenAlternatives = new Set<string>();
        for (const alternative of primary?.rule.alternatives ?? []) {
            if (seenAlternatives.has(alternative.method)) continue;
            seenAlternatives.add(alternative.method);
            alternatives.push({ method: alternative.method, label: methodLabel(catalog, alternative.method), when: alternative.when, rules: [primary!.claim] });
        }
        for (const other of selecting.slice(1)) {
            const id = other.rule.action.method!;
            if (id === method?.id || seenAlternatives.has(id)) continue;
            seenAlternatives.add(id);
            alternatives.push({ method: id, label: methodLabel(catalog, id), when: other.rule.title, rules: [other.claim] });
        }

        const disputedRule = candidates.find((matched) => matched.rule.strength === "disputed" && (matched.rule.disputed_sides?.length ?? 0) > 0);
        const disputed: ProcedureDisputed | undefined = disputedRule
            ? { rule: disputedRule.claim, sides: disputedRule.rule.disputed_sides!.map((side) => side.label), choose_and_state: true }
            : undefined;

        const forbids = [...new Set(candidates.flatMap((matched) => matched.rule.action.forbids ?? []))];
        const parameters = mergeParameters(candidates);
        const template = method ? templateFor(method, step, situation, catalog, preferences) : undefined;

        steps.push({
            step,
            ...(method
                ? {
                      method: {
                          id: method.id,
                          label: method.label,
                          ...(method.stato ? { stato: method.stato } : {}),
                          ...(method.edam_operation ? { edam: method.edam_operation } : {}),
                      },
                  }
                : {}),
            ...(method && primaryPackage(method) ? { package: primaryPackage(method) } : {}),
            ...(parameters.length > 0 ? { parameters } : {}),
            ...(template ? { template } : {}),
            rules: candidates.map((matched) => matched.claim),
            ...(flags.length > 0 ? { flags } : {}),
            ...(alternatives.length > 0 ? { alternatives } : {}),
            ...(disputed ? { disputed } : {}),
            ...(forbids.length > 0 ? { forbids } : {}),
        });
    }
    const consistent = withoutInference(steps);
    const central = centralStep(situation.question);
    const central_covered = consistent.steps.some((step) => step.step === central && step.method !== undefined);
    return { steps: consistent.steps, uncovered, dropped: consistent.dropped, flagged, central_covered };
}

const INFERENCE_ONLY_STEPS: ReadonlySet<StepType> = new Set(["shrink_lfc", "multiple_testing"]);

/**
 * A flag on the differential expression step that removes inference makes the
 * downstream inferential steps contradictory: there is no fold change to
 * shrink and no p-value to adjust. The procedure drops them and turns the
 * enrichment step descriptive, so a planner that copies the procedure as it
 * is copies a consistent one.
 */
function withoutInference(steps: readonly ProcedureStep[]): { steps: ProcedureStep[]; dropped: StepType[] } {
    const de = steps.find((step) => step.step === "differential_expression");
    const removing = de?.flags?.find((flag) => flag.severity === "flag" && flag.outcome !== undefined && removesInference(flag.outcome));
    if (!removing) return { steps: [...steps], dropped: [] };
    const dropped = steps.filter((step) => INFERENCE_ONLY_STEPS.has(step.step)).map((step) => step.step);
    const kept = steps
        .filter((step) => !INFERENCE_ONLY_STEPS.has(step.step))
        .map((step) => {
            if (step.step !== "enrichment") return step;
            const parameters = [
                ...(step.parameters ?? []).filter((parameter) => parameter.name !== "rank_metric"),
                { name: "rank_metric", value: "descriptive_log2_fold_change", default_source: `rule:${removing.rule.split("@")[0]}` },
                { name: "inference", value: "none", default_source: `rule:${removing.rule.split("@")[0]}` },
            ];
            const flag: ProcedureFlag = {
                rule: removing.rule,
                severity: "flag",
                message:
                    "The design supports no inferential test, thus the enrichment is descriptive: rank the genes by the descriptive log2 fold change, report the leading edge of each set, and report no set-level p-value as evidence.",
                outcome: removing.outcome!,
            };
            return { ...step, parameters, flags: [...(step.flags ?? []), flag] };
        });
    return { steps: kept, dropped };
}
