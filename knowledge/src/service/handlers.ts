/**
 * The handlers: pure functions from a loaded snapshot and a validated request
 * to a response. The server is a thin transport around them, thus the tests
 * call these directly with no socket.
 */

import { checkSteps } from "../engine/check.js";
import { assembleProcedure, INFERENTIAL_METHOD_FIELD, type Catalog, type ProcedureFlag, type ProcedureStep } from "../engine/procedure.js";
import type { StoredRule } from "../engine/rules.js";
import type { Modality, Situation, Template } from "../model.js";
import { matchEnvironment } from "../render/environment.js";
import { renderTemplate } from "../render/render.js";
import { checkSyntax } from "../render/syntax.js";
import type { LoadedSnapshot } from "../store.js";
import type {
    CheckRequest,
    CheckResponse,
    ClaimView,
    DecisionRecord,
    EvidenceView,
    MethodRef,
    RecommendRequest,
    RecommendResponse,
    RenderRequest,
    RenderResponse,
    SnapshotRef,
    TemplateContract,
    TemplateIdentity,
    ValidationFailure,
} from "./api.js";

/**
 * A null, an empty list, and a false optional flag mean the same as an absent
 * field, thus a rule condition that tests for absence holds for a caller that
 * wrote the explicit form. `paired` is a required boolean whose false value
 * is a fact, thus it stays. The echo of the situation carries the normalized
 * form.
 */
const OPTIONAL_FLAGS: ReadonlySet<string> = new Set(["interaction", "classifier"]);

/**
 * The engine derives these fields in the second pass of the assembly. A value
 * from the caller is dropped before the match, thus a caller cannot force a
 * method through a condition field.
 */
const DERIVED_FIELDS: ReadonlySet<string> = new Set([INFERENTIAL_METHOD_FIELD]);

/**
 * The one derived default of the situation. A count table has an import
 * state, and a caller that gives none has not established it: the state is
 * `unknown`, and the rule for the missing length input fires. The default
 * also keeps the field present for a template condition (`not_in` over an
 * absent field is false), thus the count templates stay eligible for a caller
 * that predates the field.
 */
const DEFAULT_IMPORT_STATE: NonNullable<Situation["import_state"]> = "unknown";

export function normalizeSituation(situation: Situation): Situation {
    const normalized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(situation)) {
        if (DERIVED_FIELDS.has(key)) continue;
        if (value === undefined || value === null) continue;
        if (value === false && OPTIONAL_FLAGS.has(key)) continue;
        if (Array.isArray(value) && value.length === 0) continue;
        normalized[key] = value;
    }
    if (normalized.data_state === "counts" && normalized.import_state === undefined) normalized.import_state = DEFAULT_IMPORT_STATE;
    // Every kept value came from the validated situation, thus the shape holds.
    return normalized as unknown as Situation;
}

function snapshotRef(snapshot: LoadedSnapshot): SnapshotRef {
    return { date: snapshot.meta.date, digest: snapshot.meta.digest };
}

function catalogOf(snapshot: LoadedSnapshot): Catalog {
    return { methods: snapshot.methods, templates: snapshot.templates };
}

function evidenceViews(snapshot: LoadedSnapshot, stored: StoredRule, detailed: boolean): EvidenceView[] {
    return stored.rule.evidence.map((line) => {
        const source = snapshot.sources.get(line.source);
        return {
            ...(source?.doi ? { doi: source.doi } : {}),
            ...(source?.pmid ? { pmid: source.pmid } : {}),
            ...(source?.url && !source.doi ? { url: source.url } : {}),
            title: source?.title ?? line.source,
            year: source?.year ?? 0,
            direction: line.direction,
            ...(detailed
                ? {
                      eco: line.eco,
                      ...(line.paraphrase ? { paraphrase: line.paraphrase } : {}),
                      ...(line.span ? { span: line.span } : {}),
                      ...(line.anchor ? { anchor: line.anchor } : {}),
                  }
                : {}),
        };
    });
}

export function claimView(snapshot: LoadedSnapshot, stored: StoredRule, detailed: boolean): ClaimView {
    const rule = stored.rule;
    return {
        id: stored.claim,
        rule: rule.id,
        title: rule.title,
        statement: rule.assertion,
        step_type: rule.action.step_type,
        severity: rule.severity,
        strength: rule.strength,
        evidence_quality: rule.evidence_quality,
        recommendation_strength: rule.recommendation_strength,
        evidence: evidenceViews(snapshot, stored, detailed),
        ...(detailed && rule.alternatives ? { alternatives: rule.alternatives.map((alternative) => ({ method: snapshot.methods.get(alternative.method)?.label ?? alternative.method, when: alternative.when })) } : {}),
        ...(rule.disputed_sides ? { disputed_sides: rule.disputed_sides.map((side) => side.label) } : {}),
        status: rule.status,
        ...(rule.replaced_by ? { replaced_by: snapshot.rules.find((candidate) => candidate.rule.id === rule.replaced_by)?.claim ?? rule.replaced_by } : {}),
        license: rule.license,
    };
}

/**
 * The claim ids a procedure references: the rules of each step, the rule of
 * each step flag, the rules of each alternative, the rule of a dispute, and
 * the top-level flags. The step rules cover the other four today, because the
 * engine draws them from the same candidates, but the union keeps the
 * invariant explicit against a later cross-step reference.
 */
function referencedClaims(steps: readonly ProcedureStep[], flags: readonly ProcedureFlag[]): Set<string> {
    const referenced = new Set<string>();
    for (const step of steps) {
        for (const claim of step.rules) referenced.add(claim);
        for (const flag of step.flags ?? []) referenced.add(flag.rule);
        for (const alternative of step.alternatives ?? []) for (const claim of alternative.rules) referenced.add(claim);
        if (step.disputed) referenced.add(step.disputed.rule);
    }
    for (const flag of flags) referenced.add(flag.rule);
    return referenced;
}

export function recommend(snapshot: LoadedSnapshot, request: RecommendRequest): RecommendResponse | ValidationFailure {
    const situation = normalizeSituation(request.situation);
    const modality = snapshot.modalities.get(situation.modality);
    if (!modality) {
        return { error: "validation", message: `the snapshot holds no modality ${situation.modality}`, issues: [{ field: "modality", message: "unknown modality", permitted: [...snapshot.modalities.keys()] }] };
    }
    const detailed = request.response_format === "detailed";
    const procedure = assembleProcedure(snapshot.rules, situation, modality, catalogOf(snapshot), request.preferences);
    // One rule reaches the answer once, even when its flag rides on more than one step
    // (a flag that removes inference marks the enrichment step as descriptive as well).
    const seenFlags = new Set<string>();
    const flags = procedure.steps
        .flatMap((step) => step.flags ?? [])
        .filter((flag) => flag.severity === "flag")
        .filter((flag) => {
            const key = `${flag.rule}:${flag.outcome ?? ""}`;
            if (seenFlags.has(key)) return false;
            seenFlags.add(key);
            return true;
        });
    const match: RecommendResponse["match"] = procedure.flagged ? "flag" : procedure.central_covered ? "applicable" : "none";
    // The answer carries the claims the procedure references, in match order. A rule for a step outside the walk
    // is applicable but unused, and its view is on demand at GET /v1/claims/{claim}.
    const referenced = referencedClaims(procedure.steps, flags);
    const claims = procedure.applicable.filter((stored) => referenced.has(stored.claim)).map((stored) => claimView(snapshot, stored, detailed));
    return {
        match,
        snapshot: snapshotRef(snapshot),
        situation,
        procedure: procedure.steps,
        uncovered: procedure.uncovered,
        ...(procedure.dropped.length > 0 ? { dropped: procedure.dropped } : {}),
        flags,
        claims,
        ...(match === "none" ? { nearest: procedure.nearest, reason: "no rule selects a method for the central step of this question; the nearest rules and their failed conditions are listed" } : {}),
    };
}

export function check(snapshot: LoadedSnapshot, request: CheckRequest): CheckResponse | ValidationFailure {
    const situation = normalizeSituation(request.situation);
    const modality = snapshot.modalities.get(situation.modality);
    if (!modality) {
        return { error: "validation", message: `the snapshot holds no modality ${situation.modality}`, issues: [{ field: "modality", message: "unknown modality", permitted: [...snapshot.modalities.keys()] }] };
    }
    // The check assembles the procedure over the full step order, thus it takes the rules of the two-pass match
    // over that same walk: a rule of a dependent step holds only once the inferential method is known, and the
    // draft is judged against the procedure the recommend returned.
    const walk: Modality = { ...modality, question_steps: { ...modality.question_steps, [situation.question]: modality.step_order } };
    const procedure = assembleProcedure(snapshot.rules, situation, walk, catalogOf(snapshot));
    const result = checkSteps(procedure.applicable, situation, request.steps, modality, catalogOf(snapshot));
    return { ok: result.ok, snapshot: snapshotRef(snapshot), violations: result.violations, warnings: result.warnings, not_assessed: result.not_assessed };
}

function resolveTemplate(snapshot: LoadedSnapshot, reference: string): { template: Template; body: string } | ValidationFailure {
    const [id, version] = reference.split("@");
    const template = snapshot.templates.get(id!);
    if (!template) {
        return { error: "validation", message: `unknown template ${id}`, issues: [{ field: "template", message: "unknown template id", permitted: [...snapshot.templates.keys()] }] };
    }
    if (version !== undefined && version !== template.version) {
        return {
            error: "validation",
            message: `the snapshot serves ${template.id}@${template.version}, not ${version}`,
            issues: [{ field: "template", message: "version not served", permitted: [`${template.id}@${template.version}`] }],
        };
    }
    return { template, body: snapshot.templateBodies.get(template.id) ?? "" };
}

export function templateContract(snapshot: LoadedSnapshot, id: string): TemplateContract | undefined {
    const template = snapshot.templates.get(id);
    if (!template) return undefined;
    return {
        id: template.id,
        version: template.version,
        label: template.label,
        method: template.method,
        ...(template.substitute_for ? { substitute_for: template.substitute_for } : {}),
        language: template.language,
        step_types: template.step_types,
        applicability: template.applicability,
        ...(template.applicability.honors ? { honors: template.applicability.honors } : {}),
        parameters: template.parameters,
        inputs: template.inputs ?? [],
        outputs: template.outputs,
        ...(template.applicability.notes ? { notes: template.applicability.notes } : {}),
        environment: template.environment,
        bioconductor: template.bioconductor,
    };
}

function methodRef(snapshot: LoadedSnapshot, id: string): MethodRef {
    return { id, label: snapshot.methods.get(id)?.label ?? id };
}

/**
 * The identity a render answer gives its template: the method the script
 * runs, and the method of record when the template is a substitute. The
 * recommend names the same method on the step under the preference that
 * selects this template.
 */
function templateIdentity(snapshot: LoadedSnapshot, template: Template): TemplateIdentity {
    return {
        id: template.id,
        version: template.version,
        label: template.label,
        method: methodRef(snapshot, template.method),
        ...(template.substitute_for ? { substitute_for: methodRef(snapshot, template.substitute_for) } : {}),
    };
}

export async function render(snapshot: LoadedSnapshot, request: RenderRequest): Promise<RenderResponse | ValidationFailure> {
    const resolved = resolveTemplate(snapshot, request.template);
    if ("error" in resolved) return resolved;
    const { template, body } = resolved;
    const rendered = renderTemplate(template, body, request.slots);
    if (!rendered.ok) {
        return { error: "validation", message: "one or more slot values are not valid for this template", issues: rendered.issues };
    }
    const environment = matchEnvironment(template.environment, request.farm);
    const syntax = await checkSyntax(template.language, rendered.script);
    const citations: EvidenceView[] = (template.citations ?? []).flatMap((id) => {
        const source = snapshot.sources.get(id);
        if (!source) return [];
        return [{ ...(source.doi ? { doi: source.doi } : {}), ...(source.pmid ? { pmid: source.pmid } : {}), title: source.title, year: source.year, direction: "supports" as const }];
    });
    const record: DecisionRecord = {
        schema: "inflexa.decision_record/0.1",
        template: templateIdentity(snapshot, template),
        snapshot: snapshotRef(snapshot),
        rendered_at: new Date().toISOString(),
        slots: rendered.slots,
        environment,
        syntax,
        citations,
        unvetted_edits: [],
    };
    return {
        ok: true,
        snapshot: snapshotRef(snapshot),
        template: { ...templateIdentity(snapshot, template), language: template.language },
        script: rendered.script,
        slots: rendered.slots,
        environment,
        syntax,
        outputs: template.outputs,
        decision_record: record,
    };
}
