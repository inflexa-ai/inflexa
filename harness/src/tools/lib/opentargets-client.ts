/**
 * Pure async client functions for the Open Targets Platform GraphQL API.
 *
 * Used directly by target-assessment workflow steps and by tool wrappers.
 */

import { z } from "zod";

import { apiFetchValidated, describeApiError } from "./api-utils.js";
import { OT_GRAPHQL, OT_HEADERS } from "./opentargets-config.js";

export interface Association {
    diseaseId: string;
    diseaseName: string;
    targetId?: string;
    targetSymbol?: string;
    targetName?: string;
    score: number;
    geneticAssociationScore: number | null;
    knownDrugScore: number | null;
    literatureScore: number | null;
    animalModelScore: number | null;
    somaticMutationScore: number | null;
    literaturePmids: string[];
}

export interface TargetTractability {
    smallMolecule: boolean | null;
    antibody: boolean | null;
    otherModalities: boolean | null;
}

export interface TargetInfo {
    ensemblId: string;
    approvedSymbol: string;
    approvedName: string;
    tractability: TargetTractability | null;
    associations: Association[];
}

export interface SafetyLiability {
    event: string;
    biosamples: string[];
    effects: string | null;
    source: string;
}

export interface BaselineExpressionEntry {
    tissueId: string;
    tissueLabel: string;
    organSystem: string | null;
    rna: { value: number; unit: string } | null;
    protein: { level: number | null } | null;
}

const TARGET_QUERY = `
  query TargetAssociations($ensemblId: String!, $size: Int!) {
    target(ensemblId: $ensemblId) {
      id
      approvedSymbol
      approvedName
      tractability {
        label
        modality
        value
      }
    }
    associations: target(ensemblId: $ensemblId) {
      associatedDiseases(page: { size: $size, index: 0 }) {
        rows {
          disease { id name }
          score
          datatypeScores {
            id
            score
          }
        }
      }
    }
  }
`;

const DISEASE_QUERY = `
  query DiseaseAssociations($efoId: String!, $size: Int!) {
    disease(efoId: $efoId) {
      id
      name
      associatedTargets(page: { size: $size, index: 0 }) {
        rows {
          target { id approvedSymbol approvedName }
          score
          datatypeScores {
            id
            score
          }
        }
      }
    }
  }
`;

const SAFETY_QUERY = `
  query TargetSafety($ensemblId: String!) {
    target(ensemblId: $ensemblId) {
      id
      approvedSymbol
      safetyLiabilities {
        event
        biosamples { tissueLabel }
        effects { direction }
        datasource
        literature
        url
      }
    }
  }
`;

const EXPRESSION_QUERY = `
  query TargetExpression($ensemblId: String!) {
    target(ensemblId: $ensemblId) {
      id
      approvedSymbol
      expressions {
        tissue {
          id
          label
          organs
        }
        rna { value unit }
        protein { level }
      }
    }
  }
`;

// Open Targets GraphQL `data` payload schemas, validated at the fetch boundary.
// Fields the mapping code reads behind a guard (optional chaining, `?? default`,
// `Array.isArray`) are `.nullable().optional()`; fields read directly — a missing
// value would otherwise mis-map — stay required so a contract break surfaces as
// `invalid_response` instead of silently producing garbage. Nullable matters
// because GraphQL returns an explicit `null` (not omission) for a nullable root
// that resolves empty — an unknown/retired id yields `{"target": null}`, which a
// bare `.optional()` rejects, turning a clean "not found" into a thrown error.
const DatatypeScoreSchema = z.object({ id: z.string().optional(), score: z.number().optional() });

const TargetAssociationsDataSchema = z.object({
    target: z
        .object({
            id: z.string(),
            approvedSymbol: z.string(),
            approvedName: z.string(),
            tractability: z
                .array(z.object({ label: z.string().optional(), modality: z.string().optional(), value: z.boolean().optional() }))
                .nullable()
                .optional(),
        })
        .nullable()
        .optional(),
    associations: z
        .object({
            associatedDiseases: z
                .object({
                    rows: z
                        .array(
                            z.object({
                                disease: z.object({ id: z.string(), name: z.string() }),
                                score: z.number(),
                                datatypeScores: z.array(DatatypeScoreSchema).nullable().optional(),
                            }),
                        )
                        .nullable()
                        .optional(),
                })
                .optional(),
        })
        .nullable()
        .optional(),
});

const DiseaseAssociationsDataSchema = z.object({
    disease: z
        .object({
            id: z.string().optional(),
            name: z.string().optional(),
            associatedTargets: z
                .object({
                    rows: z
                        .array(
                            z.object({
                                target: z
                                    .object({ id: z.string().optional(), approvedSymbol: z.string().optional(), approvedName: z.string().optional() })
                                    .nullable()
                                    .optional(),
                                score: z.number(),
                                datatypeScores: z.array(DatatypeScoreSchema).nullable().optional(),
                            }),
                        )
                        .nullable()
                        .optional(),
                })
                .optional(),
        })
        .nullable()
        .optional(),
});

const TargetSafetyDataSchema = z.object({
    target: z
        .object({
            id: z.string().optional(),
            approvedSymbol: z.string(),
            safetyLiabilities: z
                .array(
                    z.object({
                        event: z.string().nullable().optional(),
                        biosamples: z
                            .array(z.object({ tissueLabel: z.string().nullable().optional() }))
                            .nullable()
                            .optional(),
                        effects: z
                            .array(z.object({ direction: z.string().nullable().optional() }))
                            .nullable()
                            .optional(),
                        datasource: z.string().nullable().optional(),
                    }),
                )
                .nullable()
                .optional(),
        })
        .nullable()
        .optional(),
});

const TargetExpressionDataSchema = z.object({
    target: z
        .object({
            expressions: z
                .array(
                    z.object({
                        tissue: z.object({ id: z.string(), label: z.string(), organs: z.array(z.string()).nullable().optional() }),
                        rna: z.object({ value: z.number().nullable().optional(), unit: z.string().nullable().optional() }).nullable().optional(),
                        protein: z.object({ level: z.number().nullable().optional() }).nullable().optional(),
                    }),
                )
                .nullable()
                .optional(),
        })
        .nullable()
        .optional(),
});

function extractDatatype(datatypeScores: { id?: string; score?: number }[], id: string): number | null {
    const match = datatypeScores.find((d) => d.id === id);
    return match?.score ?? null;
}

async function gqlFetch<S extends z.ZodType>(query: string, variables: Record<string, unknown>, schema: S): Promise<z.infer<S>> {
    const res = await apiFetchValidated(OT_GRAPHQL, z.object({ data: schema.optional() }), {
        method: "POST",
        headers: OT_HEADERS,
        body: JSON.stringify({ query, variables }),
    });
    if (res.isErr()) throw new Error(describeApiError(res.error));
    if (!res.value.data) throw new Error("Open Targets returned no data");
    return res.value.data;
}

/** Fetch target info, tractability, and disease associations for an Ensembl gene id. */
export async function searchTargetAssociations(ensemblId: string, limit = 25): Promise<TargetInfo | null> {
    const data = await gqlFetch(TARGET_QUERY, { ensemblId, size: limit }, TargetAssociationsDataSchema);

    const target = data.target;
    if (!target) return null;

    const tractabilityEntries = target.tractability ?? [];
    const tractability: TargetTractability = {
        smallMolecule: tractabilityEntries.find((t) => t.modality === "SM")?.value ?? null,
        antibody: tractabilityEntries.find((t) => t.modality === "AB")?.value ?? null,
        otherModalities: tractabilityEntries.find((t) => t.modality === "OC")?.value ?? null,
    };

    const rows = data.associations?.associatedDiseases?.rows ?? [];
    const associations: Association[] = rows.map((row) => ({
        diseaseId: row.disease.id,
        diseaseName: row.disease.name,
        score: row.score,
        geneticAssociationScore: extractDatatype(row.datatypeScores ?? [], "genetic_association"),
        knownDrugScore: extractDatatype(row.datatypeScores ?? [], "known_drug"),
        literatureScore: extractDatatype(row.datatypeScores ?? [], "literature"),
        animalModelScore: extractDatatype(row.datatypeScores ?? [], "animal_model"),
        somaticMutationScore: extractDatatype(row.datatypeScores ?? [], "somatic_mutation"),
        literaturePmids: [],
    }));

    return {
        ensemblId: target.id,
        approvedSymbol: target.approvedSymbol,
        approvedName: target.approvedName,
        tractability,
        associations,
    };
}

/** Fetch target associations for a disease (EFO id). */
export async function searchDiseaseAssociations(efoId: string, limit = 25): Promise<Association[]> {
    const data = await gqlFetch(DISEASE_QUERY, { efoId, size: limit }, DiseaseAssociationsDataSchema);

    const rows = data.disease?.associatedTargets?.rows ?? [];
    return rows.map((row) => ({
        diseaseId: efoId,
        diseaseName: data.disease?.name ?? efoId,
        targetId: row.target?.id ?? "",
        targetSymbol: row.target?.approvedSymbol ?? "",
        targetName: row.target?.approvedName ?? "",
        score: row.score,
        geneticAssociationScore: extractDatatype(row.datatypeScores ?? [], "genetic_association"),
        knownDrugScore: extractDatatype(row.datatypeScores ?? [], "known_drug"),
        literatureScore: extractDatatype(row.datatypeScores ?? [], "literature"),
        animalModelScore: extractDatatype(row.datatypeScores ?? [], "animal_model"),
        somaticMutationScore: extractDatatype(row.datatypeScores ?? [], "somatic_mutation"),
        literaturePmids: [],
    }));
}

/** Fetch known safety liabilities for a target. */
export async function getTargetSafetyLiabilities(ensemblId: string): Promise<{ targetSymbol: string; safetyLiabilities: SafetyLiability[] } | null> {
    const data = await gqlFetch(SAFETY_QUERY, { ensemblId }, TargetSafetyDataSchema);

    const target = data.target;
    if (!target) return null;

    const safetyLiabilities: SafetyLiability[] = (target.safetyLiabilities ?? []).map((sl) => ({
        event: sl.event ?? "Unknown",
        biosamples: Array.isArray(sl.biosamples) ? sl.biosamples.map((b) => b.tissueLabel ?? "").filter(Boolean) : [],
        effects:
            Array.isArray(sl.effects) && sl.effects.length > 0
                ? sl.effects
                      .map((e) => e.direction ?? "")
                      .filter(Boolean)
                      .join(", ")
                : null,
        source: sl.datasource ?? "Unknown",
    }));

    return { targetSymbol: target.approvedSymbol, safetyLiabilities };
}

/**
 * Fetch baseline RNA/protein expression across tissues. Open Targets
 * exposes per-tissue expression with organ system tags — used by §2.7
 * (Off-Tissue Risk) and §3.9 (Normal Tissue Expression).
 */
export async function getBaselineExpression(ensemblId: string): Promise<BaselineExpressionEntry[]> {
    const data = await gqlFetch(EXPRESSION_QUERY, { ensemblId }, TargetExpressionDataSchema);

    const expressions = data.target?.expressions ?? [];
    return expressions.map((e) => ({
        tissueId: e.tissue.id,
        tissueLabel: e.tissue.label,
        organSystem: Array.isArray(e.tissue.organs) && e.tissue.organs.length > 0 ? e.tissue.organs[0] : null,
        rna: e.rna && typeof e.rna.value === "number" ? { value: e.rna.value, unit: e.rna.unit ?? "TPM" } : null,
        protein: e.protein ? { level: typeof e.protein.level === "number" ? e.protein.level : null } : null,
    }));
}
