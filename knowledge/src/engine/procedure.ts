/**
 * Procedure assembly: from the rules of a snapshot to one ordered procedure.
 *
 * The walk follows the step order of the modality for the question asked.
 * The assembly runs in two passes. The first pass matches the rules against
 * the situation of the caller and selects the method of the inferential step:
 * the differential expression step when the walk holds it, else the central
 * step of the question. The second pass matches the rules again with the
 * engine-derived field `inferential_method` set to that method id, then
 * assembles every step. A rule of a dependent step (normalization, shrinkage,
 * filtering, multiple testing, the report columns, the rank metric) conditions
 * on that field, thus it fires only once the method it depends on is known,
 * and it wins its step by the same specificity count as any other rule. A
 * comparison over an absent field is false, thus such a rule never fires in
 * the first pass.
 *
 * For each step type the most specific rule that names a method selects it.
 * The parameters of the applicable rules of that step type merge by name with
 * a method scope: a parameter of a rule that names a method belongs to that
 * method, a method-less rule scopes a parameter with `methods`, and a
 * parameter with no scope is generic. A strictly more specific rule overrides
 * a broader one. Two rules of equal specificity and equal strength that give
 * different values do not resolve: the step reports the conflict with both
 * claim ids and omits the parameter. The other method-naming rules become
 * alternatives. A disputed rule returns its sides and asks the caller to
 * choose and state the choice. A warn or flag rule attaches to the step as a
 * flag with its severity and its permitted outcome.
 *
 * The template of a step comes from the method the rules select. A template
 * that declares `honors` is eligible only when it honors every design
 * requirement of the situation: a pair, a blocking factor, a covariate list,
 * or a known balanced batch. A language preference selects among the eligible
 * templates and never changes a rule. When the eligible template in that
 * language is a declared substitute, the step names the substitute as its
 * method, with the method of record in `substitution`. When no template of
 * that language is eligible, the step keeps the first eligible template and
 * reports the limit.
 */

import type { DesignRequirement, Method, Modality, ParameterValue, Rule, Situation, StepType, Template, Preferences } from "../model.js";
import { evaluateCondition } from "./conditions.js";
import { matchRules, type MatchedRule, type NearMiss, type StoredRule } from "./rules.js";

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

/**
 * Two or more rules of equal specificity and equal strength give different
 * values for one parameter. The step omits the parameter and names every rule
 * of the tie with its value, thus the caller sees both claim ids.
 */
export interface ProcedureConflict {
    readonly parameter: string;
    readonly entries: readonly { readonly rule: string; readonly value: ParameterValue["value"] }[];
}

/**
 * The template of the step runs a declared substitute of the method the rules
 * select. The step names the substitute as its method, and this record keeps
 * the method of record, thus the answer, the package, and the decision record
 * name the procedure the script runs.
 */
export interface ProcedureSubstitution {
    /** The method of record: the method the rules select for the step. */
    readonly for: string;
    /** The label of the method of record. */
    readonly label: string;
    /** The template that runs the substitute, `id@version`. */
    readonly template: string;
}

/**
 * The caller asked for a language, and no template of the method in that
 * language is eligible for the step. The step keeps the first eligible
 * template, and the record names each template of the requested language
 * that a design requirement excluded.
 */
export interface ProcedureLimit {
    readonly requested_language: Template["language"];
    readonly reason: string;
    readonly skipped: readonly { readonly template: string; readonly missing: readonly DesignRequirement[] }[];
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
    readonly conflicts?: readonly ProcedureConflict[];
    readonly template?: string;
    readonly substitution?: ProcedureSubstitution;
    readonly limit?: ProcedureLimit;
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
    /** The rules that hold in the second pass, in match order: the rules the steps reference. */
    readonly applicable: readonly MatchedRule[];
    /** The rules that failed the fewest conditions in the second pass, for a `match: none` answer. */
    readonly nearest: readonly NearMiss[];
}

export interface Catalog {
    readonly methods: ReadonlyMap<string, Method>;
    readonly templates: ReadonlyMap<string, Template>;
}

/**
 * The engine-derived condition field: the method id of the inferential step,
 * set on the situation of the second pass. It is not a Situation slot, a
 * caller cannot set it, and the echo of a situation never carries it.
 */
export const INFERENTIAL_METHOD_FIELD = "inferential_method";

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
        case "tf_activity":
            return "tf_activity";
        case "deconvolution":
            return "deconvolution";
        case "coexpression":
            return "coexpression";
        case "clustering":
            return "clustering";
        case "survival":
            return "survival";
        case "signature_scoring":
            return "signature_scoring";
        default: {
            const unreachable: never = question;
            throw new Error(`unhandled question: ${String(unreachable)}`);
        }
    }
}

const STRENGTH_ORDER = { disputed: 0, common_practice: 1, consensus: 2 } as const;

/**
 * The methods a parameter applies to: its `methods` list, else the method of
 * its rule. Undefined means generic: the parameter applies to any method, and
 * to a step that selects none.
 */
function scopeOf(rule: Rule, parameter: ParameterValue): readonly string[] | undefined {
    return parameter.methods ?? (rule.action.method !== undefined ? [rule.action.method] : undefined);
}

interface Contribution {
    readonly matched: MatchedRule;
    readonly parameter: ParameterValue;
}

function compareContribution(a: Contribution, b: Contribution): number {
    // The most specific rule first, then the stronger rule, then the id for a stable order.
    return b.matched.specificity - a.matched.specificity || STRENGTH_ORDER[b.matched.rule.strength] - STRENGTH_ORDER[a.matched.rule.strength] || (a.matched.rule.id < b.matched.rule.id ? -1 : a.matched.rule.id > b.matched.rule.id ? 1 : 0);
}

/**
 * Merge the parameters of the candidate rules of one step by name, under the
 * method the step selects. A scoped parameter reaches the step only when the
 * scope lists the selected method. For one name the most specific rule wins,
 * and at equal specificity the stronger rule wins. Rules that tie on both and
 * give different values make a conflict, and the parameter is omitted.
 */
function mergeParameters(candidates: readonly MatchedRule[], selected: string | undefined): { parameters: ParameterValue[]; conflicts: ProcedureConflict[] } {
    const byName = new Map<string, Contribution[]>();
    for (const matched of candidates) {
        for (const parameter of matched.rule.action.parameters ?? []) {
            const scope = scopeOf(matched.rule, parameter);
            if (scope !== undefined && (selected === undefined || !scope.includes(selected))) continue;
            const contributions = byName.get(parameter.name) ?? [];
            contributions.push({ matched, parameter });
            byName.set(parameter.name, contributions);
        }
    }
    const parameters: ParameterValue[] = [];
    const conflicts: ProcedureConflict[] = [];
    for (const [name, contributions] of byName) {
        const ordered = [...contributions].sort(compareContribution);
        const top = ordered[0]!;
        const tied = ordered.filter((entry) => entry.matched.specificity === top.matched.specificity && entry.matched.rule.strength === top.matched.rule.strength);
        const values = new Set(tied.map((entry) => JSON.stringify(entry.parameter.value)));
        if (values.size > 1) {
            conflicts.push({ parameter: name, entries: tied.map((entry) => ({ rule: entry.matched.claim, value: entry.parameter.value })) });
            continue;
        }
        parameters.push(top.parameter);
    }
    return { parameters, conflicts };
}

/**
 * The design requirements of a situation: the facts of the sample table that
 * a script must carry into its test. A suspected batch is not a requirement,
 * because no term of the design names it.
 */
export function requirementsOf(situation: Situation): readonly DesignRequirement[] {
    const required: DesignRequirement[] = [];
    if (situation.paired) required.push("pairing");
    if (situation.blocking_factor !== undefined && situation.blocking_factor !== null) required.push("blocking_factor");
    if ((situation.covariates ?? []).length > 0) required.push("covariates");
    if (situation.batch === "known_balanced") required.push("batch");
    return required;
}

/**
 * The requirements of the situation that the template does not honor. A
 * template with no `honors` is not subject to the design requirements, thus
 * it misses none.
 */
function missingRequirements(template: Template, required: readonly DesignRequirement[]): readonly DesignRequirement[] {
    const honors = template.applicability.honors;
    if (honors === undefined) return [];
    return required.filter((requirement) => !honors.includes(requirement));
}

/** True when the template names the step and its own applicability holds in the situation. */
function applies(template: Template, step: StepType, situation: Situation): boolean {
    if (!template.step_types.includes(step)) return false;
    const applicability = template.applicability;
    if (applicability.count_sources && situation.count_source && !applicability.count_sources.includes(situation.count_source)) return false;
    if (applicability.min_replicates !== undefined && situation.n_per_group_min < applicability.min_replicates) return false;
    return (applicability.conditions ?? []).every((condition) => evaluateCondition(condition, situation));
}

/**
 * True when the template is eligible for the step in the situation: it names
 * the step, its applicability holds, and it honors every design requirement
 * of the situation. The check reads this to permit a substitute only where
 * the recommend would name it.
 */
export function templateHolds(template: Template, step: StepType, situation: Situation): boolean {
    return applies(template, step, situation) && missingRequirements(template, requirementsOf(situation)).length === 0;
}

function templateRef(template: Template): string {
    return `${template.id}@${template.version}`;
}

interface TemplateChoice {
    readonly template: Template;
    /** The method the template runs: the substitute when the template is one, else the method of record. */
    readonly method: Method;
    /** The method of record, when the template is a declared substitute for it. */
    readonly substitute_for?: Method;
    readonly limit?: ProcedureLimit;
}

/**
 * The template of a method for a step: the first eligible template of the
 * method. A template whose `honors` lacks a requirement of the situation is
 * skipped. A language preference of the caller selects, among the eligible
 * templates, the first one in that language. When none is in that language,
 * the choice keeps the first eligible template and carries the limit. A
 * preference never changes a rule. When the chosen template names the method
 * of record in `substitute_for`, the choice names the method the template
 * runs and keeps the method of record beside it.
 */
function templateFor(method: Method, step: StepType, situation: Situation, catalog: Catalog, preferences?: Preferences): TemplateChoice | undefined {
    const required = requirementsOf(situation);
    const holding: Template[] = [];
    const skipped: { readonly template: Template; readonly missing: readonly DesignRequirement[] }[] = [];
    let listed = 0;
    for (const id of method.templates ?? []) {
        const template = catalog.templates.get(id);
        if (!template || !template.step_types.includes(step)) continue;
        if (template.language === preferences?.language) listed += 1;
        if (!applies(template, step, situation)) continue;
        const missing = missingRequirements(template, required);
        if (missing.length > 0) {
            skipped.push({ template, missing });
            continue;
        }
        holding.push(template);
    }
    const requested = preferences?.language;
    const preferred = requested ? holding.find((template) => template.language === requested) : undefined;
    const chosen = preferred ?? holding[0];
    if (!chosen) return undefined;

    const substitute = chosen.substitute_for === method.id && chosen.method !== method.id ? catalog.methods.get(chosen.method) : undefined;
    let limit: ProcedureLimit | undefined;
    if (requested !== undefined && preferred === undefined) {
        const kept = `The step keeps ${templateRef(chosen)} in ${chosen.language}.`;
        const reason =
            listed === 0
                ? `${method.label} has no ${requested} template for the ${step} step. ${kept}`
                : `No ${requested} template of ${method.label} is eligible in this situation. ${kept}`;
        limit = {
            requested_language: requested,
            reason,
            skipped: skipped.filter((entry) => entry.template.language === requested).map((entry) => ({ template: templateRef(entry.template), missing: entry.missing })),
        };
    }
    return {
        template: chosen,
        method: substitute ?? method,
        ...(substitute ? { substitute_for: method } : {}),
        ...(limit ? { limit } : {}),
    };
}

const TRACKS_OF_LANGUAGE: Record<Template["language"], readonly string[]> = { python: ["python"], R: ["bioconductor", "cran"] };

/**
 * The package the step names: the first package of the method on a track of
 * the language of the chosen template, else the first package. With no
 * template, the first package.
 */
function primaryPackage(method: Method, language?: Template["language"]): ProcedureStep["package"] {
    const packages = method.packages ?? [];
    const tracks = language ? TRACKS_OF_LANGUAGE[language] : [];
    const first = packages.find((candidate) => tracks.includes(candidate.track)) ?? packages[0];
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

/** The steps of the walk: the steps of the question, plus each extra analysis at its place in the step order. */
function walkOf(situation: Situation, modality: Modality): readonly StepType[] {
    const base = modality.question_steps[situation.question] ?? modality.step_order;
    const extra = new Set<string>(situation.extra_analyses ?? []);
    return extra.size === 0 ? base : modality.step_order.filter((step) => base.includes(step) || extra.has(step));
}

/**
 * The rules that select the method of a step, in match order. A flag that
 * removes inference and names a method (the descriptive method of a design
 * without replicates) is the only one: the other methods are forbidden, not
 * alternatives.
 */
function selectingOf(candidates: readonly MatchedRule[]): readonly MatchedRule[] {
    const overriding = candidates.find(
        (matched) => matched.rule.severity === "flag" && matched.rule.action.method !== undefined && matched.rule.action.outcome !== undefined && removesInference(matched.rule.action.outcome),
    );
    return overriding ? [overriding] : candidates.filter((matched) => matched.rule.action.method !== undefined && matched.rule.severity !== "flag");
}

function readsInferentialMethod(matched: MatchedRule): boolean {
    return (matched.rule.conditions ?? []).some((condition) => condition.field === INFERENTIAL_METHOD_FIELD);
}

function withInferentialMethod(situation: Situation, method: string): Situation {
    // The derived field rides beside the Situation slots for the match only; the caller never sees it.
    return { ...situation, [INFERENTIAL_METHOD_FIELD]: method } as Situation;
}

export function assembleProcedure(rules: readonly StoredRule[], situation: Situation, modality: Modality, catalog: Catalog, preferences?: Preferences): AssembledProcedure {
    const walk = walkOf(situation, modality);
    const inferential: StepType = walk.includes("differential_expression") ? "differential_expression" : centralStep(situation.question);

    // Pass 1: the method of the inferential step, from the situation of the caller alone.
    const first = matchRules(rules, situation);
    const selected = selectingOf(first.applicable.filter((matched) => matched.rule.action.step_type === inferential))[0]?.rule.action.method;

    // Pass 2: every step, with the derived field set, thus a rule of a dependent step can read the method.
    const derived = selected === undefined ? situation : withInferentialMethod(situation, selected);
    const match = selected === undefined ? first : matchRules(rules, derived);

    const steps: ProcedureStep[] = [];
    const uncovered: StepType[] = [];
    let flagged = false;
    for (const step of walk) {
        // A rule that reads the derived field describes a dependent step. On the inferential step itself it
        // would be circular, thus it never selects or parameterizes that step, and the field stays true.
        const candidates = match.applicable.filter((matched) => matched.rule.action.step_type === step && (step !== inferential || !readsInferentialMethod(matched)));
        if (candidates.length === 0) {
            uncovered.push(step);
            continue;
        }
        const selecting = selectingOf(candidates);
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
        // The scope is judged on the method the rules select for the step, the method of record.
        const { parameters, conflicts } = mergeParameters(candidates, primary?.rule.action.method);
        const choice = method ? templateFor(method, step, derived, catalog, preferences) : undefined;
        // The step names the method its template runs: the substitute when the template is one, else the method of record.
        const runs = choice?.method ?? method;
        const pkg = runs ? primaryPackage(runs, choice?.template.language) : undefined;

        steps.push({
            step,
            ...(runs
                ? {
                      method: {
                          id: runs.id,
                          label: runs.label,
                          ...(runs.stato ? { stato: runs.stato } : {}),
                          ...(runs.edam_operation ? { edam: runs.edam_operation } : {}),
                      },
                  }
                : {}),
            ...(pkg ? { package: pkg } : {}),
            ...(parameters.length > 0 ? { parameters } : {}),
            ...(conflicts.length > 0 ? { conflicts } : {}),
            ...(choice ? { template: templateRef(choice.template) } : {}),
            ...(choice?.substitute_for ? { substitution: { for: choice.substitute_for.id, label: choice.substitute_for.label, template: templateRef(choice.template) } } : {}),
            ...(choice?.limit ? { limit: choice.limit } : {}),
            rules: candidates.map((matched) => matched.claim),
            ...(flags.length > 0 ? { flags } : {}),
            ...(alternatives.length > 0 ? { alternatives } : {}),
            ...(disputed ? { disputed } : {}),
            ...(forbids.length > 0 ? { forbids } : {}),
        });
    }
    const consistent = withoutInference(steps, walk);
    const central = centralStep(situation.question);
    const central_covered = consistent.steps.some((step) => step.step === central && step.method !== undefined);
    return {
        steps: consistent.steps,
        uncovered: uncovered.filter((step) => !consistent.dropped.includes(step)),
        dropped: consistent.dropped,
        flagged,
        central_covered,
        applicable: match.applicable,
        nearest: match.nearest,
    };
}

/**
 * The steps that act on an inferential test only: a shrinkage of the fold
 * changes and an adjustment of the p-values. Under a flag that removes
 * inference they have nothing to act on.
 */
export const INFERENCE_ONLY_STEPS: ReadonlySet<StepType> = new Set(["shrink_lfc", "multiple_testing"]);

/**
 * The flag of the differential expression step whose outcome removes
 * inference, when the assembled steps carry one. The assembler drops the
 * inference-only steps under it, and the check refuses a draft on them by
 * this same test, thus the two never disagree on which flag did it.
 */
export function removingFlag(steps: readonly ProcedureStep[]): ProcedureFlag | undefined {
    const de = steps.find((step) => step.step === "differential_expression");
    return de?.flags?.find((flag) => flag.severity === "flag" && flag.outcome !== undefined && removesInference(flag.outcome));
}

/**
 * A flag on the differential expression step that removes inference makes the
 * downstream inferential steps contradictory: there is no fold change to
 * shrink and no p-value to adjust. The procedure drops them and turns the
 * enrichment step descriptive, so a planner that copies the procedure as it
 * is copies a consistent one. The drop reads the walk, not the covered steps:
 * under the derived descriptive method a shrinkage rule of the tested methods
 * no longer fires, and the step is dropped, not uncovered.
 */
function withoutInference(steps: readonly ProcedureStep[], walk: readonly StepType[]): { steps: ProcedureStep[]; dropped: StepType[] } {
    const removing = removingFlag(steps);
    if (!removing) return { steps: [...steps], dropped: [] };
    const dropped = walk.filter((step) => INFERENCE_ONLY_STEPS.has(step));
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
