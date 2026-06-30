import type { ClinicalTrialAttributionV5, ClinicalTrialRowV5, ResolvedTrialInterventionV5 } from "@inflexa-ai/harness/contracts/target-dossier.js";

type TrialLike = {
    nctId: string;
    title: string;
    officialTitle?: string | null;
    conditions?: string[];
    interventions?: string[];
    interventionDetails?: Array<{
        name: string;
        type?: string | null;
        description?: string | null;
        otherNames?: string[];
    }>;
    studyType?: string | null;
    primaryPurpose?: string | null;
    briefSummary?: string | null;
    detailedDescription?: string | null;
};

export type KnownClassDrug = {
    name: string;
    moleculeChemblId?: string | null;
    targetUniprots?: string[];
};

export type TherapeuticProgram = {
    programId: string;
    name: string;
    targetSymbol: string;
    targetUniprot?: string | null;
    modality?: string | null;
    nctIds?: string[];
};

export type ClinicalEvidenceAttributionContext = {
    assessmentSymbol: string;
    assessmentUniprot: string;
    familyUniprots: string[];
    knownClassDrugs: KnownClassDrug[];
    therapeuticPrograms: TherapeuticProgram[];
};

export type ClinicalEvidenceAttributionResult = {
    attribution: ClinicalTrialAttributionV5;
    eligible_for_toxicology_aggregation: boolean;
};

function normalize(text: string): string {
    return text
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, " ")
        .trim();
}

function tokenMatch(haystack: string, needle: string): boolean {
    const h = ` ${normalize(haystack)} `;
    const n = normalize(needle);
    if (!n) return false;
    return h.includes(` ${n} `);
}

function trialText(trial: TrialLike): string {
    return [
        trial.title,
        trial.officialTitle,
        ...(trial.conditions ?? []),
        ...(trial.interventions ?? []),
        ...(trial.interventionDetails ?? []).flatMap((i) => [i.name, i.description, ...(i.otherNames ?? [])]),
        trial.briefSummary,
        trial.detailedDescription,
    ]
        .filter((v): v is string => typeof v === "string" && v.length > 0)
        .join(" ");
}

function interventionDetails(trial: TrialLike): NonNullable<TrialLike["interventionDetails"]> {
    if (trial.interventionDetails && trial.interventionDetails.length > 0) {
        return trial.interventionDetails;
    }
    return (trial.interventions ?? []).map((name) => ({
        name,
        type: null,
        description: null,
        otherNames: [],
    }));
}

function toResolvedIntervention(
    intervention: NonNullable<TrialLike["interventionDetails"]>[number],
    source: string,
    extras: Partial<ResolvedTrialInterventionV5> = {},
): ResolvedTrialInterventionV5 {
    return {
        name: intervention.name,
        intervention_type: intervention.type ?? null,
        target_uniprots: extras.target_uniprots ?? [],
        resolver_source: source,
        ...extras,
    };
}

function isDiagnosticOrBiomarkerOnly(trial: TrialLike): boolean {
    const details = interventionDetails(trial);
    const hasOnlyDiagnostic =
        details.length > 0 && details.every((i) => ["DIAGNOSTIC_TEST", "OTHER", "PROCEDURE"].includes(String(i.type ?? "").toUpperCase()));
    const design = `${trial.studyType ?? ""} ${trial.primaryPurpose ?? ""}`.toUpperCase();
    return hasOnlyDiagnostic || /\bOBSERVATIONAL\b|\bBASIC_SCIENCE\b/.test(design);
}

function targetBiomarkerMention(trial: TrialLike, symbol: string): boolean {
    const text = normalize(trialText(trial));
    const sym = normalize(symbol);
    if (!sym) return false;
    const wrapped = ` ${text} `;
    return wrapped.includes(` ${sym} `) || wrapped.includes(`S ${sym} `) || wrapped.includes(` ${sym} LEVEL`) || wrapped.includes(` ${sym} CONCENTRATION`);
}

function excluded(
    relationship: ClinicalTrialAttributionV5["relationship"],
    reason: string,
    basisKind: ClinicalTrialAttributionV5["basis"][number]["kind"],
    source: string,
    resolved_interventions: ResolvedTrialInterventionV5[],
): ClinicalEvidenceAttributionResult {
    return {
        eligible_for_toxicology_aggregation: false,
        attribution: {
            relationship,
            evidence_role: relationship === "target_biomarker" || relationship === "pathway_biomarker" ? "contextual" : "excluded",
            basis: [{ kind: basisKind, source }],
            resolved_interventions,
            exclusion_reason: reason,
        },
    };
}

export function classifyClinicalEvidenceTrial(trial: TrialLike, ctx: ClinicalEvidenceAttributionContext): ClinicalEvidenceAttributionResult {
    const details = interventionDetails(trial);

    for (const program of ctx.therapeuticPrograms) {
        const matchesProgram =
            (program.nctIds ?? []).includes(trial.nctId) ||
            details.some((i) => tokenMatch(i.name, program.name) || (i.otherNames ?? []).some((alias) => tokenMatch(alias, program.name))) ||
            tokenMatch(trial.title, program.name);
        const hitsTarget = normalize(program.targetSymbol) === normalize(ctx.assessmentSymbol) || program.targetUniprot === ctx.assessmentUniprot;
        if (matchesProgram && hitsTarget) {
            const matched = details.find((i) => tokenMatch(i.name, program.name)) ??
                details[0] ?? {
                    name: program.name,
                    type: null,
                    description: null,
                    otherNames: [],
                };
            return {
                eligible_for_toxicology_aggregation: true,
                attribution: {
                    relationship: "direct_modulator",
                    evidence_role: "supports_target",
                    basis: [
                        {
                            kind: "therapeutic_program_match",
                            source: "therapeutic_programs",
                            excerpt: `${program.name} targets ${program.targetSymbol}`,
                        },
                    ],
                    resolved_interventions: [
                        toResolvedIntervention(matched, "therapeutic_programs", {
                            therapeutic_program_id: program.programId,
                            target_uniprots: program.targetUniprot ? [program.targetUniprot] : [],
                        }),
                    ],
                },
            };
        }
    }

    for (const intervention of details) {
        const candidates = [intervention.name, ...(intervention.otherNames ?? [])];
        const matchedDrug = ctx.knownClassDrugs.find((drug) => candidates.some((candidate) => tokenMatch(candidate, drug.name)));
        if (!matchedDrug) continue;

        const targetUniprots = matchedDrug.targetUniprots ?? [];
        if (targetUniprots.includes(ctx.assessmentUniprot)) {
            return {
                eligible_for_toxicology_aggregation: true,
                attribution: {
                    relationship: "class_modulator",
                    evidence_role: "supports_target",
                    basis: [{ kind: "known_class_drug", source: "chembl" }],
                    resolved_interventions: [
                        toResolvedIntervention(intervention, "chembl", {
                            chembl_id: matchedDrug.moleculeChemblId ?? null,
                            target_uniprots: targetUniprots,
                        }),
                    ],
                },
            };
        }

        if (targetUniprots.some((u) => ctx.familyUniprots.includes(u))) {
            return excluded(
                "related_family_target",
                "Intervention targets a related family receptor, not the assessed target.",
                "related_family_target",
                "chembl",
                [
                    toResolvedIntervention(intervention, "chembl", {
                        chembl_id: matchedDrug.moleculeChemblId ?? null,
                        target_uniprots: targetUniprots,
                    }),
                ],
            );
        }
    }

    const text = trialText(trial);
    if (targetBiomarkerMention(trial, ctx.assessmentSymbol)) {
        const resolved = details.map((i) => toResolvedIntervention(i, "ctgov"));
        return excluded(
            "target_biomarker",
            isDiagnosticOrBiomarkerOnly(trial)
                ? "Target is used as a biomarker or diagnostic endpoint, not as a therapeutic intervention."
                : "Target is mentioned in biomarker/outcome context without target-modulating intervention evidence.",
            "biomarker_endpoint",
            "ctgov",
            resolved,
        );
    }

    const conditionOnly = (trial.conditions ?? []).some((c) => tokenMatch(c, ctx.assessmentSymbol));
    if (conditionOnly) {
        return excluded(
            "condition_only",
            "Trial matched only by condition text and has no target-modulating intervention evidence.",
            "condition_only",
            "ctgov",
            details.map((i) => toResolvedIntervention(i, "ctgov")),
        );
    }

    return excluded(
        "unrelated",
        "No intervention or mechanism evidence links this trial to the assessed target.",
        "text_match",
        "ctgov",
        details.map((i) => toResolvedIntervention(i, "ctgov")),
    );
}

export function attachClinicalEvidenceAttribution<T extends TrialLike>(
    trial: T,
    ctx: ClinicalEvidenceAttributionContext,
): T & Pick<ClinicalTrialRowV5, "attribution" | "eligible_for_toxicology_aggregation"> {
    const result = classifyClinicalEvidenceTrial(trial, ctx);
    return { ...trial, ...result };
}
