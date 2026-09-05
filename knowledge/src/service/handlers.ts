/**
 * The handlers: pure functions from a loaded snapshot and a validated request
 * to a response. The server is a thin transport around them, thus the tests
 * call these directly with no socket.
 */

import { checkSteps } from "../engine/check.js";
import { assembleProcedure, type Catalog } from "../engine/procedure.js";
import { matchRules, type StoredRule } from "../engine/rules.js";
import type { Situation, Template } from "../model.js";
import { matchEnvironment } from "../render/environment.js";
import { renderTemplate } from "../render/render.js";
import { checkRSyntax } from "../render/syntax.js";
import type { LoadedSnapshot } from "../store.js";
import type {
    CheckRequest,
    CheckResponse,
    ClaimView,
    DecisionRecord,
    EvidenceView,
    RecommendRequest,
    RecommendResponse,
    RenderRequest,
    RenderResponse,
    SnapshotRef,
    TemplateContract,
    ValidationFailure,
} from "./api.js";

/**
 * A null, an empty list, and a false optional flag mean the same as an absent
 * field, thus a rule condition that tests for absence holds for a caller that
 * wrote the explicit form. `paired` is a required boolean whose false value
 * is a fact, thus it stays. The echo of the situation carries the normalized
 * form.
 */
const OPTIONAL_FLAGS: ReadonlySet<string> = new Set(["interaction"]);

export function normalizeSituation(situation: Situation): Situation {
    const normalized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(situation)) {
        if (value === undefined || value === null) continue;
        if (value === false && OPTIONAL_FLAGS.has(key)) continue;
        if (Array.isArray(value) && value.length === 0) continue;
        normalized[key] = value;
    }
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

export function recommend(snapshot: LoadedSnapshot, request: RecommendRequest): RecommendResponse | ValidationFailure {
    const situation = normalizeSituation(request.situation);
    const modality = snapshot.modalities.get(situation.modality);
    if (!modality) {
        return { error: "validation", message: `the snapshot holds no modality ${situation.modality}`, issues: [{ field: "modality", message: "unknown modality", permitted: [...snapshot.modalities.keys()] }] };
    }
    const detailed = request.response_format === "detailed";
    const { applicable, nearest } = matchRules(snapshot.rules, situation);
    const procedure = assembleProcedure(applicable, situation, modality, catalogOf(snapshot));
    const flags = procedure.steps.flatMap((step) => step.flags ?? []).filter((flag) => flag.severity === "flag");
    const match: RecommendResponse["match"] = procedure.flagged ? "flag" : procedure.central_covered ? "applicable" : "none";
    const claims = applicable.map((stored) => claimView(snapshot, stored, detailed));
    return {
        match,
        snapshot: snapshotRef(snapshot),
        situation,
        procedure: procedure.steps,
        uncovered: procedure.uncovered,
        flags,
        claims,
        ...(match === "none" ? { nearest, reason: "no rule selects a method for the central step of this question; the nearest rules and their failed conditions are listed" } : {}),
    };
}

export function check(snapshot: LoadedSnapshot, request: CheckRequest): CheckResponse | ValidationFailure {
    const situation = normalizeSituation(request.situation);
    const modality = snapshot.modalities.get(situation.modality);
    if (!modality) {
        return { error: "validation", message: `the snapshot holds no modality ${situation.modality}`, issues: [{ field: "modality", message: "unknown modality", permitted: [...snapshot.modalities.keys()] }] };
    }
    const { applicable } = matchRules(snapshot.rules, situation);
    const result = checkSteps(applicable, situation, request.steps, modality, catalogOf(snapshot));
    return { ok: result.ok, snapshot: snapshotRef(snapshot), violations: result.violations, warnings: result.warnings };
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
        language: template.language,
        step_types: template.step_types,
        applicability: template.applicability,
        parameters: template.parameters,
        outputs: template.outputs,
        environment: template.environment,
        bioconductor: template.bioconductor,
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
    const syntax = template.language === "R" ? await checkRSyntax(rendered.script) : { status: "unchecked" as const, reason: "no syntax checker for this language" };
    const citations: EvidenceView[] = (template.citations ?? []).flatMap((id) => {
        const source = snapshot.sources.get(id);
        if (!source) return [];
        return [{ ...(source.doi ? { doi: source.doi } : {}), ...(source.pmid ? { pmid: source.pmid } : {}), title: source.title, year: source.year, direction: "supports" as const }];
    });
    const record: DecisionRecord = {
        schema: "inflexa.decision_record/0.1",
        template: { id: template.id, version: template.version, label: template.label, method: template.method },
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
        template: { id: template.id, version: template.version, label: template.label, method: template.method, language: template.language },
        script: rendered.script,
        slots: rendered.slots,
        environment,
        syntax,
        outputs: template.outputs,
        decision_record: record,
    };
}
