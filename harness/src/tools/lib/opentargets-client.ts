/**
 * Pure async client functions for the Open Targets Platform GraphQL API.
 *
 * Used directly by target-assessment workflow steps and by tool wrappers.
 *
 * Absence policy: the nullability of the GraphQL SDL encodes an absent value.
 * Open Targets answers each requested field with a key and an explicit `null`,
 * thus the SDL gives each modifier and `.optional()` is wrong.
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

/**
 * One disease or trait that Open Targets holds, as the free-text resolver
 * returns it. The `id` is the identifier that `searchDiseaseAssociations`
 * accepts. Open Targets keys a disease on the EFO ontology, which imports
 * MONDO, Orphanet and HP, thus an id can read `EFO_…`, `MONDO_…` or `HP_…`.
 */
export interface DiseaseCandidate {
    id: string;
    name: string;
    description: string | null;
}

export interface BaselineExpressionEntry {
    tissueId: string;
    tissueLabel: string;
    organSystem: string | null;
    /**
     * The Open Targets datasource of the row, for example `gtex`,
     * `tabula_sapiens` or `DICE`. One target carries rows of more than one
     * datasource, and each datasource has its own unit and its own resolution.
     * Thus a consumer that compares two entries must first compare this value.
     */
    datasourceId: string;
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

const DISEASE_SEARCH_QUERY = `
  query DiseaseSearch($queryString: String!, $size: Int!) {
    search(queryString: $queryString, entityNames: ["disease"], page: { size: $size, index: 0 }) {
      total
      hits {
        id
        name
        description
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
  query TargetBaselineExpression($ensemblId: String!, $size: Int!) {
    target(ensemblId: $ensemblId) {
      id
      approvedSymbol
      baselineExpression(page: { size: $size, index: 0 }) {
        count
        rows {
          unit
          median
          q1
          q3
          min
          max
          datasourceId
          targetId
          tissueBiosample { biosampleId biosampleName }
          tissueBiosampleParent { biosampleId biosampleName }
        }
      }
    }
  }
`;

/**
 * The page size of one `baselineExpression` request.
 *
 * `Pagination.size` caps at 3000 in the SDL, and one target carries more than
 * 1400 rows. Thus a smaller page drops tissues, and it gives no signal that it
 * dropped them.
 */
const BASELINE_EXPRESSION_PAGE_SIZE = 3000;

// Open Targets GraphQL `data` payload schemas, validated at the fetch boundary.
// Fields the mapping code reads behind a guard (optional chaining, `?? default`,
// `Array.isArray`) are `.nullable().optional()`; fields read directly — a missing
// value would otherwise mis-map — stay required so a contract break surfaces as
// `invalid_response` instead of silently producing garbage. Nullable matters
// because GraphQL returns an explicit `null` (not omission) for a nullable root
// that resolves empty — an unknown/retired id yields `{"target": null}`, which a
// bare `.optional()` rejects, turning a clean "not found" into a thrown error.
const DatatypeScoreSchema = z.object({ id: z.string().optional(), score: z.number().optional() });

export const TargetAssociationsDataSchema = z.object({
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

const DiseaseSearchDataSchema = z.object({
    search: z
        .object({
            total: z.number().nullable().optional(),
            hits: z
                .array(
                    z.object({
                        id: z.string(),
                        name: z.string().nullable().optional(),
                        description: z.string().nullable().optional(),
                    }),
                )
                .nullable()
                .optional(),
        })
        .nullable()
        .optional(),
});

export const TargetSafetyDataSchema = z.object({
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

/** `Biosample`, as `BaselineExpressionRow` embeds it. Both leaf fields are non-null in the SDL. */
const BiosampleSchema = z.object({ biosampleId: z.string(), biosampleName: z.string() });

/**
 * `Target.baselineExpression`, per the SDL.
 *
 * The modifiers come from the SDL and from nothing else: `BaselineExpression!`
 * and its `count`, `rows`, `unit`, `datasourceId` and `targetId` are non-null,
 * the five quantile fields are `Float` and thus nullable, and each biosample
 * link is a nullable `Biosample`.
 */
export const TargetExpressionDataSchema = z.object({
    target: z
        .object({
            baselineExpression: z.object({
                count: z.number(),
                rows: z.array(
                    z.object({
                        unit: z.string(),
                        median: z.number().nullable(),
                        q1: z.number().nullable(),
                        q3: z.number().nullable(),
                        min: z.number().nullable(),
                        max: z.number().nullable(),
                        datasourceId: z.string(),
                        targetId: z.string(),
                        tissueBiosample: BiosampleSchema.nullable(),
                        tissueBiosampleParent: BiosampleSchema.nullable(),
                    }),
                ),
            }),
        })
        .nullable(),
});

function extractDatatype(datatypeScores: { id?: string; score?: number }[], id: string): number | null {
    const match = datatypeScores.find((d) => d.id === id);
    return match?.score ?? null;
}

async function gqlFetch<S extends z.ZodType>(query: string, variables: Record<string, unknown>, schema: S): Promise<z.infer<S>> {
    const res = await apiFetchValidated(
        OT_GRAPHQL,
        z.object({ data: schema.optional(), errors: z.array(z.object({ message: z.string().optional() })).optional() }),
        {
            method: "POST",
            headers: OT_HEADERS,
            body: JSON.stringify({ query, variables }),
        },
    );
    if (res.isErr()) throw new Error(describeApiError(res.error));
    if (!res.value.data) {
        // A GraphQL server answers HTTP 200 with an `errors` array and no `data`
        // key when the document itself is invalid, for example when it names a
        // retired field. Without the first message the caller sees only "no
        // data", which names no cause and points at no field.
        const firstError = res.value.errors?.[0]?.message;
        throw new Error(firstError ? `Open Targets returned no data: ${firstError}` : "Open Targets returned no data");
    }
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

/**
 * Resolve a free-text disease or trait name to the disease ids that
 * `searchDiseaseAssociations` accepts. A name that matches nothing gives an
 * empty candidate list, which is a normal outcome and not an error.
 */
export async function searchDiseases(query: string, limit = 10): Promise<{ total: number; candidates: DiseaseCandidate[] }> {
    const data = await gqlFetch(DISEASE_SEARCH_QUERY, { queryString: query, size: limit }, DiseaseSearchDataSchema);

    const hits = data.search?.hits ?? [];
    return {
        total: data.search?.total ?? hits.length,
        candidates: hits.map((hit) => ({
            id: hit.id,
            name: hit.name ?? "",
            description: hit.description ?? null,
        })),
    };
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
 * Map one `baselineExpression` page onto the baseline-expression entries.
 *
 * The function is pure, thus the golden-fixture table exercises it against a
 * stored payload.
 */
export function mapBaselineExpression(data: z.infer<typeof TargetExpressionDataSchema>): BaselineExpressionEntry[] {
    const entries: BaselineExpressionEntry[] = [];
    for (const row of data.target?.baselineExpression.rows ?? []) {
        // A row with no tissue biosample measures a cell type alone, thus it
        // carries no tissue identity and it cannot become a tissue entry.
        const tissue = row.tissueBiosample;
        if (!tissue) continue;
        entries.push({
            tissueId: tissue.biosampleId,
            tissueLabel: tissue.biosampleName,
            organSystem: row.tissueBiosampleParent?.biosampleName ?? null,
            datasourceId: row.datasourceId,
            rna: row.median === null ? null : { value: row.median, unit: row.unit },
            // The `baselineExpression` surface carries no protein measurement,
            // thus the protein level of an entry is always absent.
            protein: null,
        });
    }
    return entries;
}

/**
 * Fetch baseline RNA expression across tissues. Open Targets gives one row for
 * each tissue and datasource, with the parent biosample as the organ system —
 * used by §2.7 (Off-Tissue Risk) and §3.9 (Normal Tissue Expression).
 */
export async function getBaselineExpression(ensemblId: string, limit = BASELINE_EXPRESSION_PAGE_SIZE): Promise<BaselineExpressionEntry[]> {
    const data = await gqlFetch(EXPRESSION_QUERY, { ensemblId, size: limit }, TargetExpressionDataSchema);
    return mapBaselineExpression(data);
}
