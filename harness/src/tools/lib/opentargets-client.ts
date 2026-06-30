/**
 * Pure async client functions for the Open Targets Platform GraphQL API.
 *
 * Used directly by target-assessment workflow steps and by tool wrappers.
 */

import { apiFetch, describeApiError } from "./api-utils.js";
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

function extractDatatype(datatypeScores: { id: string; score: number }[], id: string): number | null {
    const match = datatypeScores.find((d) => d.id === id);
    return match?.score ?? null;
}

async function gqlFetch<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await apiFetch<{ data?: T }>(OT_GRAPHQL, {
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
    const data = await gqlFetch<{
        target?: {
            id: string;
            approvedSymbol: string;
            approvedName: string;
            tractability?: { label: string; modality: string; value: boolean }[];
        };
        associations?: {
            associatedDiseases?: {
                rows: {
                    disease: { id: string; name: string };
                    score: number;
                    datatypeScores: { id: string; score: number }[];
                }[];
            };
        };
    }>(TARGET_QUERY, { ensemblId, size: limit });

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
    const data = await gqlFetch<{
        disease?: {
            id: string;
            name: string;
            associatedTargets?: {
                rows: {
                    target: { id: string; approvedSymbol: string; approvedName: string };
                    score: number;
                    datatypeScores: { id: string; score: number }[];
                }[];
            };
        };
    }>(DISEASE_QUERY, { efoId, size: limit });

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
    const data = await gqlFetch<{
        target?: {
            id: string;
            approvedSymbol: string;
            safetyLiabilities?: {
                event?: string;
                biosamples?: { tissueLabel?: string }[];
                effects?: { direction?: string }[];
                datasource?: string;
            }[];
        };
    }>(SAFETY_QUERY, { ensemblId });

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
    const data = await gqlFetch<{
        target?: {
            expressions?: {
                tissue: { id: string; label: string; organs?: string[] };
                rna?: { value?: number; unit?: string };
                protein?: { level?: number };
            }[];
        };
    }>(EXPRESSION_QUERY, { ensemblId });

    const expressions = data.target?.expressions ?? [];
    return expressions.map((e) => ({
        tissueId: e.tissue.id,
        tissueLabel: e.tissue.label,
        organSystem: Array.isArray(e.tissue.organs) && e.tissue.organs.length > 0 ? e.tissue.organs[0] : null,
        rna: e.rna && typeof e.rna.value === "number" ? { value: e.rna.value, unit: e.rna.unit ?? "TPM" } : null,
        protein: e.protein ? { level: typeof e.protein.level === "number" ? e.protein.level : null } : null,
    }));
}
