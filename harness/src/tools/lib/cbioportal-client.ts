/**
 * Pure async client for cBioPortal somatic mutation frequencies.
 *
 * Used by §3.4 (Genetic Alterations — somatic mutation frequencies). Queries
 * the public cBioPortal REST API for mutation occurrence across all curated
 * cancer studies, then aggregates by cancer type to produce the spec's
 * "where is the target broken in human disease, and how often" view.
 */

import { apiFetch, describeApiError } from "./api-utils.js";

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

interface RawMolecularProfile {
    molecularProfileId: string;
    studyId: string;
    molecularAlterationType?: string;
}

interface RawMutationCount {
    studyId: string;
    sampleId: string;
    mutationCount: number;
}

interface RawSampleList {
    sampleListId: string;
    studyId: string;
    category?: string;
    sampleCount?: number;
}

interface RawCancerStudy {
    studyId: string;
    cancerTypeId?: string;
    cancerType?: { name?: string; cancerTypeId?: string };
    name?: string;
    description?: string;
}

async function listStudies(): Promise<RawCancerStudy[]> {
    const url = `${CBIOPORTAL_BASE}/studies?projection=SUMMARY&pageSize=10000`;
    const res = await apiFetch<RawCancerStudy[]>(url, { headers: HEADERS });
    if (res.isErr()) throw new Error(describeApiError(res.error));
    return res.value ?? [];
}

async function listAllSampleLists(): Promise<RawSampleList[]> {
    const url = `${CBIOPORTAL_BASE}/sample-lists?projection=SUMMARY&pageSize=10000`;
    const res = await apiFetch<RawSampleList[]>(url, { headers: HEADERS });
    if (res.isErr()) throw new Error(describeApiError(res.error));
    return res.value ?? [];
}

async function listMutationProfiles(): Promise<RawMolecularProfile[]> {
    const url = `${CBIOPORTAL_BASE}/molecular-profiles?projection=SUMMARY&pageSize=10000`;
    const res = await apiFetch<RawMolecularProfile[]>(url, { headers: HEADERS });
    if (res.isErr()) throw new Error(describeApiError(res.error));
    return (res.value ?? []).filter((p) => p.molecularAlterationType === "MUTATION_EXTENDED");
}

async function fetchMutationCountsForGene(entrezGeneId: number, profileIds: string[]): Promise<RawMutationCount[]> {
    if (profileIds.length === 0) return [];
    const url = `${CBIOPORTAL_BASE}/mutations/fetch?projection=SUMMARY`;
    const res = await apiFetch<RawMutationCount[]>(url, {
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
    const res = await apiFetch<{ entrezGeneId?: number }>(url, { headers: HEADERS });
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

    const [studies, profiles, sampleLists] = await Promise.all([listStudies(), listMutationProfiles(), listAllSampleLists()]);

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

    const mutations = await fetchMutationCountsForGene(entrezGeneId, profileIds);
    const mutatedStudySamples = new Map<string, Set<string>>();
    for (const m of mutations) {
        if (!mutatedStudySamples.has(m.studyId)) mutatedStudySamples.set(m.studyId, new Set());
        mutatedStudySamples.get(m.studyId)!.add(m.sampleId);
    }

    const byCancerType = new Map<string, { name: string; total: number; mutated: number; studies: Set<string> }>();
    for (const studyId of studiesWithMutations) {
        const sl = allSampleListByStudy.get(studyId);
        if (!sl?.sampleCount) continue;
        const study = studyById.get(studyId);
        const cancerTypeId = study?.cancerType?.cancerTypeId ?? study?.cancerTypeId ?? "unknown";
        const cancerTypeName = study?.cancerType?.name ?? cancerTypeId;
        if (!byCancerType.has(cancerTypeId)) {
            byCancerType.set(cancerTypeId, {
                name: cancerTypeName,
                total: 0,
                mutated: 0,
                studies: new Set(),
            });
        }
        const bucket = byCancerType.get(cancerTypeId)!;
        bucket.total += sl.sampleCount;
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
