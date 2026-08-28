/**
 * Pure async client for cBioPortal somatic mutation frequencies.
 *
 * Used by §3.4 (Genetic Alterations — somatic mutation frequencies). Queries
 * the public cBioPortal REST API for mutation occurrence across all curated
 * cancer studies, then aggregates by cancer type to produce the spec's
 * "where is the target broken in human disease, and how often" view.
 *
 * Absence policy: cBioPortal omits the key of an absent value, and it never
 * sends an explicit `null`. Thus a maybe-absent field carries `.optional()`,
 * not `.nullable()`.
 */

import { z } from "zod";

import { apiFetchValidated, describeApiError } from "./api-utils.js";

const CBIOPORTAL_BASE = "https://www.cbioportal.org/api";
const HEADERS = { Accept: "application/json" } as const;

export interface CancerStudy {
    studyId: string;
    cancerType: string;
    cancerTypeName: string;
}

export interface MutationFrequency {
    cancerTypeId: string;
    cancerTypeName: string;
    totalSamples: number;
    mutatedSamples: number;
    frequency: number;
    studies: string[];
}

// Raw cBioPortal wire shapes, validated at the fetch boundary. Fields the code
// reads as map keys or feeds into `string[]` params stay required — a missing
// value there is a contract break we surface as `invalid_response`, not a silent
// `undefined`; every other field is optional because the API omits absent values.
const RawMolecularProfileSchema = z.object({
    molecularProfileId: z.string(),
    studyId: z.string(),
    molecularAlterationType: z.string().optional(),
});
type RawMolecularProfile = z.infer<typeof RawMolecularProfileSchema>;

// One mutation row of `mutations/fetch`. The aggregation counts the distinct
// samples of a study, thus it reads only the two key fields of the row.
export const RawMutationRowSchema = z.object({
    studyId: z.string(),
    sampleId: z.string(),
});
type RawMutationRow = z.infer<typeof RawMutationRowSchema>;

const RawSampleListSchema = z.object({
    sampleListId: z.string().optional(),
    studyId: z.string(),
    category: z.string().optional(),
    sampleCount: z.number().optional(),
});
type RawSampleList = z.infer<typeof RawSampleListSchema>;

export const RawCancerStudySchema = z.object({
    studyId: z.string(),
    cancerTypeId: z.string().optional(),
    // The nested block keys its identifier as `id`. The `projection=DETAILED`
    // answer carries the block, and `projection=SUMMARY` omits it, thus the
    // top-level `cancerTypeId` stays the fallback.
    cancerType: z.object({ id: z.string().optional(), name: z.string().optional() }).optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    /** The denominator of a study. The sample-list SUMMARY projection carries no count. */
    allSampleCount: z.number().optional(),
});
type RawCancerStudy = z.infer<typeof RawCancerStudySchema>;

async function listStudies(): Promise<RawCancerStudy[]> {
    const url = `${CBIOPORTAL_BASE}/studies?projection=SUMMARY&pageSize=10000`;
    const res = await apiFetchValidated(url, z.array(RawCancerStudySchema), { headers: HEADERS });
    if (res.isErr()) throw new Error(describeApiError(res.error));
    return res.value ?? [];
}

/**
 * The cancer-type vocabulary, keyed by its id. The study SUMMARY projection
 * carries the id alone, thus a row would otherwise report `esca` where it must
 * report `Esophageal Adenocarcinoma`.
 */
async function cancerTypeNames(): Promise<Map<string, string>> {
    const url = `${CBIOPORTAL_BASE}/cancer-types?pageSize=10000`;
    const res = await apiFetchValidated(url, z.array(z.object({ cancerTypeId: z.string().optional(), name: z.string().optional() })), { headers: HEADERS });
    const names = new Map<string, string>();
    if (res.isErr()) return names;
    for (const row of res.value ?? []) {
        if (row.cancerTypeId && row.name) names.set(row.cancerTypeId, row.name);
    }
    return names;
}

async function listAllSampleLists(): Promise<RawSampleList[]> {
    const url = `${CBIOPORTAL_BASE}/sample-lists?projection=SUMMARY&pageSize=10000`;
    const res = await apiFetchValidated(url, z.array(RawSampleListSchema), { headers: HEADERS });
    if (res.isErr()) throw new Error(describeApiError(res.error));
    return res.value ?? [];
}

async function listMutationProfiles(): Promise<RawMolecularProfile[]> {
    const url = `${CBIOPORTAL_BASE}/molecular-profiles?projection=SUMMARY&pageSize=10000`;
    const res = await apiFetchValidated(url, z.array(RawMolecularProfileSchema), { headers: HEADERS });
    if (res.isErr()) throw new Error(describeApiError(res.error));
    return (res.value ?? []).filter((p) => p.molecularAlterationType === "MUTATION_EXTENDED");
}

async function fetchMutationRowsForGene(entrezGeneId: number, profileIds: string[]): Promise<RawMutationRow[]> {
    if (profileIds.length === 0) return [];
    const url = `${CBIOPORTAL_BASE}/mutations/fetch?projection=SUMMARY`;
    const res = await apiFetchValidated(url, z.array(RawMutationRowSchema), {
        method: "POST",
        headers: { ...HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({
            molecularProfileIds: profileIds,
            entrezGeneIds: [entrezGeneId],
        }),
    });
    if (res.isErr()) throw new Error(describeApiError(res.error));
    return res.value ?? [];
}

/**
 * Resolve a gene symbol to its NCBI Entrez Gene ID via cBioPortal's gene
 * search endpoint. cBioPortal's mutation API requires entrezGeneId, not
 * symbol.
 */
async function resolveEntrezId(symbol: string): Promise<number | null> {
    const url = `${CBIOPORTAL_BASE}/genes/${encodeURIComponent(symbol)}`;
    const res = await apiFetchValidated(url, z.object({ entrezGeneId: z.number().optional() }), { headers: HEADERS });
    if (res.isErr()) return null;
    return res.value?.entrezGeneId ?? null;
}

/**
 * Compute somatic mutation frequencies for a target across all curated
 * cancer studies in cBioPortal, grouped by cancer type. Returns one row
 * per cancer type containing total samples checked, samples with at
 * least one mutation in the gene, and the contributing studies.
 */
export async function getSomaticMutationFrequencies(
    geneSymbol: string,
    options: { minSamplesPerCancerType?: number; maxStudies?: number } = {},
): Promise<{ entrezGeneId: number | null; rows: MutationFrequency[] }> {
    const minSamples = options.minSamplesPerCancerType ?? 50;
    const maxStudies = options.maxStudies ?? 500;

    const entrezGeneId = await resolveEntrezId(geneSymbol);
    if (entrezGeneId == null) return { entrezGeneId: null, rows: [] };

    const [studies, profiles, sampleLists, typeNames] = await Promise.all([listStudies(), listMutationProfiles(), listAllSampleLists(), cancerTypeNames()]);

    const allSampleListByStudy = new Map<string, RawSampleList>();
    for (const sl of sampleLists) {
        if (sl.category === "all_cases_in_study") {
            allSampleListByStudy.set(sl.studyId, sl);
        }
    }

    const studiesWithMutations = profiles
        .map((p) => p.studyId)
        .filter((sid) => allSampleListByStudy.has(sid))
        .slice(0, maxStudies);
    const profileIds = profiles.filter((p) => studiesWithMutations.includes(p.studyId)).map((p) => p.molecularProfileId);

    const studyById = new Map<string, RawCancerStudy>();
    for (const s of studies) studyById.set(s.studyId, s);

    const mutations = await fetchMutationRowsForGene(entrezGeneId, profileIds);
    const mutatedStudySamples = new Map<string, Set<string>>();
    for (const m of mutations) {
        if (!mutatedStudySamples.has(m.studyId)) mutatedStudySamples.set(m.studyId, new Set());
        mutatedStudySamples.get(m.studyId)!.add(m.sampleId);
    }

    const byCancerType = new Map<string, { name: string; total: number; mutated: number; studies: Set<string> }>();
    for (const studyId of studiesWithMutations) {
        const study = studyById.get(studyId);
        const sampleCount = study?.allSampleCount ?? 0;
        if (sampleCount === 0) continue;
        const cancerTypeId = study?.cancerType?.id ?? study?.cancerTypeId ?? "unknown";
        const cancerTypeName = study?.cancerType?.name ?? typeNames.get(cancerTypeId) ?? cancerTypeId;
        if (!byCancerType.has(cancerTypeId)) {
            byCancerType.set(cancerTypeId, {
                name: cancerTypeName,
                total: 0,
                mutated: 0,
                studies: new Set(),
            });
        }
        const bucket = byCancerType.get(cancerTypeId)!;
        bucket.total += sampleCount;
        bucket.mutated += mutatedStudySamples.get(studyId)?.size ?? 0;
        bucket.studies.add(studyId);
    }

    const rows: MutationFrequency[] = [];
    for (const [cancerTypeId, agg] of byCancerType.entries()) {
        if (agg.total < minSamples) continue;
        rows.push({
            cancerTypeId,
            cancerTypeName: agg.name,
            totalSamples: agg.total,
            mutatedSamples: agg.mutated,
            frequency: agg.total === 0 ? 0 : agg.mutated / agg.total,
            studies: [...agg.studies].sort(),
        });
    }
    rows.sort((a, b) => b.frequency - a.frequency);

    return { entrezGeneId, rows };
}
