/**
 * Pure async client functions for the IMPC (International Mouse Phenotyping
 * Consortium) Solr API.
 *
 * Used by §3.10.1 (Knockout phenotype card).
 */

import { apiFetch, describeApiError, isUnexpectedApiError } from "./api-utils.js";

const IMPC_BASE = "https://www.ebi.ac.uk/mi/impc/solr";
const PHENOTYPE_ROW_CAP = 500;
const VIABILITY_PROCEDURE = "Viability Primary Screen";

const ORGAN_SYSTEM_MAP: Record<string, string> = {
    "cardiovascular system phenotype": "cardiovascular",
    "digestive/alimentary phenotype": "gastrointestinal",
    "endocrine/exocrine gland phenotype": "endocrine",
    "hematopoietic system phenotype": "hematologic",
    "hearing/vestibular/ear phenotype": "auditory",
    "homeostasis/metabolism phenotype": "metabolic",
    "immune system phenotype": "immune",
    "integument phenotype": "skin",
    "liver/biliary system phenotype": "hepatic",
    "muscle phenotype": "musculoskeletal",
    "nervous system phenotype": "cns",
    "renal/urinary system phenotype": "renal",
    "reproductive system phenotype": "reproductive",
    "respiratory system phenotype": "respiratory",
    "skeleton phenotype": "skeleton",
    "vision/eye phenotype": "vision",
    "adipose tissue phenotype": "metabolic",
    "behavior/neurological phenotype": "cns",
    "growth/size/body region phenotype": "growth",
    "mortality/aging": "mortality",
    "craniofacial phenotype": "craniofacial",
    "limbs/digits/tail phenotype": "musculoskeletal",
    "pigmentation phenotype": "skin",
    "embryo phenotype": "growth",
};

/** A single IMPC Solr document — fields vary by core; all optional. */
interface ImpcSolrDoc {
    mp_term_id?: string;
    mp_term_name?: string;
    p_value?: number;
    top_level_mp_term_name?: unknown;
    sex?: unknown;
    parameter_stable_id?: string;
    parameter_name?: string;
    marker_symbol?: string;
    mgi_accession_id?: string;
}

/** The `response` envelope shared by every IMPC Solr core. */
interface ImpcSolrResponse {
    response?: { docs?: ImpcSolrDoc[]; numFound?: number };
}

export interface MpTerm {
    id: string;
    term: string;
    bestPValue: number | null;
}

export interface PhenotypeProfile {
    mpTerms: MpTerm[];
    organSystems: string[];
    sexDimorphic: boolean;
    phenotypeCount: number;
}

export interface ViabilityCall {
    zygosity: string;
    parameterStableId: string;
    mpTerm: { id: string; name: string } | null;
}

export type ViabilityCategory = "lethal_pre_weaning" | "subviable" | "viable" | null;

export interface KoPhenotypeProfile {
    geneSymbol: string;
    mouseMarkerSymbol: string | null;
    mgiAccessionId: string | null;
    viability: ViabilityCategory;
    viabilityCalls: ViabilityCall[];
    mpTerms: MpTerm[];
    organSystems: string[];
    sexDimorphic: boolean;
    phenotypeCount: number;
    phenotypeDocsTotal: number;
    phenotypesTruncated: boolean;
}

function escapeSolrValue(value: string): string {
    return value.replace(/([+\-&|!(){}[\]^"~*?:\\/\s])/g, "\\$1");
}

export function parsePhenotypeResponse(raw: unknown): PhenotypeProfile {
    // `raw` is the untyped IMPC Solr response; we reach `.response.docs` defensively
    // (optional-chained, defaulted to []) and treat each doc's fields as optional below.
    const docs: ImpcSolrDoc[] = (raw as ImpcSolrResponse | null)?.response?.docs ?? [];
    if (!Array.isArray(docs) || docs.length === 0) {
        return { mpTerms: [], organSystems: [], sexDimorphic: false, phenotypeCount: 0 };
    }

    const byMp = new Map<string, MpTerm>();
    const organCounts = new Map<string, number>();
    const mpToSexes = new Map<string, Set<string>>();
    const allSexes = new Set<string>();

    for (const doc of docs) {
        const mpId: string | undefined = doc.mp_term_id;
        if (!mpId) continue;
        const newP = typeof doc.p_value === "number" && Number.isFinite(doc.p_value) ? doc.p_value : null;
        const existing = byMp.get(mpId);
        if (!existing) {
            byMp.set(mpId, { id: mpId, term: doc.mp_term_name ?? "", bestPValue: newP });
        } else if (newP !== null && (existing.bestPValue === null || newP < existing.bestPValue)) {
            existing.bestPValue = newP;
        }

        const tops: unknown = doc.top_level_mp_term_name;
        if (Array.isArray(tops)) {
            for (const t of tops) {
                const key = typeof t === "string" ? t.toLowerCase() : "";
                const bucket = ORGAN_SYSTEM_MAP[key];
                if (bucket) organCounts.set(bucket, (organCounts.get(bucket) ?? 0) + 1);
            }
        }

        const sex = typeof doc.sex === "string" ? doc.sex.toLowerCase() : "";
        if (sex) {
            allSexes.add(sex);
            if (!mpToSexes.has(mpId)) mpToSexes.set(mpId, new Set());
            mpToSexes.get(mpId)!.add(sex);
        }
    }

    const mpTerms = [...byMp.values()].sort((a, b) => {
        const ap = a.bestPValue ?? 1;
        const bp = b.bestPValue ?? 1;
        return ap - bp;
    });

    const organSystems = [...organCounts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);

    const bothSexesTested = allSexes.has("male") && allSexes.has("female");
    const sexDimorphic =
        bothSexesTested && [...mpToSexes.values()].some((sexes) => (sexes.has("male") && !sexes.has("female")) || (sexes.has("female") && !sexes.has("male")));

    return { mpTerms, organSystems, sexDimorphic, phenotypeCount: byMp.size };
}

export function buildViabilityCalls(docsB: unknown, docsC: unknown): ViabilityCall[] {
    // `docsB`/`docsC` are untyped IMPC Solr responses; the `.response.docs` reach is
    // optional-chained + defaulted, so a shape mismatch degrades to an empty result.
    const bDocs: ImpcSolrDoc[] = (docsB as ImpcSolrResponse | null)?.response?.docs ?? [];
    const cDocs: ImpcSolrDoc[] = (docsC as ImpcSolrResponse | null)?.response?.docs ?? [];
    const seen = new Set<string>();
    const out: ViabilityCall[] = [];

    for (const d of bDocs) {
        const pid = d.parameter_stable_id;
        if (!pid || seen.has(pid)) continue;
        seen.add(pid);
        out.push({
            zygosity: d.parameter_name ?? "",
            parameterStableId: pid,
            mpTerm: d.mp_term_id && d.mp_term_name ? { id: d.mp_term_id, name: d.mp_term_name } : null,
        });
    }

    for (const d of cDocs) {
        const pid = d.parameter_stable_id;
        if (!pid || seen.has(pid)) continue;
        seen.add(pid);
        out.push({
            zygosity: d.parameter_name ?? "",
            parameterStableId: pid,
            mpTerm: null,
        });
    }
    return out;
}

export function derivedViability(calls: ViabilityCall[]): ViabilityCategory {
    if (calls.length === 0) return null;
    if (calls.some((c) => c.mpTerm?.id === "MP:0011100")) return "lethal_pre_weaning";
    if (calls.some((c) => c.mpTerm?.id === "MP:0011110")) return "subviable";
    return "viable";
}

async function resolveImpcGene(humanSymbol: string): Promise<{ mouseMarkerSymbol: string; mgiAccessionId: string } | null> {
    const q = `human_gene_symbol:${escapeSolrValue(humanSymbol)}`;
    const url = `${IMPC_BASE}/gene/select?q=${encodeURIComponent(q)}` + `&rows=1&fl=marker_symbol,mgi_accession_id&wt=json`;
    const res = await apiFetch<ImpcSolrResponse>(url);
    if (res.isErr()) {
        if (isUnexpectedApiError(res.error)) throw new Error(describeApiError(res.error));
        return null;
    }
    const docs = res.value?.response?.docs ?? [];
    if (!Array.isArray(docs) || docs.length === 0) return null;
    const doc = docs[0];
    if (!doc.marker_symbol || !doc.mgi_accession_id) return null;
    return {
        mouseMarkerSymbol: String(doc.marker_symbol),
        mgiAccessionId: String(doc.mgi_accession_id),
    };
}

async function fetchPhenotypes(mouseSym: string): Promise<{ raw: unknown; numFound: number }> {
    const q = `marker_symbol:${escapeSolrValue(mouseSym)}`;
    const url = `${IMPC_BASE}/genotype-phenotype/select?q=${encodeURIComponent(q)}` + `&rows=${PHENOTYPE_ROW_CAP}&wt=json`;
    const res = await apiFetch<ImpcSolrResponse>(url);
    if (res.isErr()) {
        if (isUnexpectedApiError(res.error)) throw new Error(describeApiError(res.error));
        return { raw: { response: { docs: [] } }, numFound: 0 };
    }
    const numFound = Number(res.value?.response?.numFound ?? 0);
    return { raw: res.value, numFound };
}

async function fetchAssignedViability(mouseSym: string): Promise<unknown> {
    const q = `marker_symbol:${escapeSolrValue(mouseSym)} AND procedure_name:"${VIABILITY_PROCEDURE}"`;
    const url = `${IMPC_BASE}/genotype-phenotype/select?q=${encodeURIComponent(q)}` + `&rows=20&wt=json`;
    const res = await apiFetch<ImpcSolrResponse>(url);
    if (res.isErr()) {
        if (isUnexpectedApiError(res.error)) throw new Error(describeApiError(res.error));
        return { response: { docs: [] } };
    }
    return res.value;
}

async function fetchScreenRan(mouseSym: string): Promise<unknown> {
    const q = `marker_symbol:${escapeSolrValue(mouseSym)} AND parameter_stable_id:IMPC_VIA_*`;
    const url = `${IMPC_BASE}/statistical-result/select?q=${encodeURIComponent(q)}` + `&rows=50&fl=parameter_stable_id,parameter_name&wt=json`;
    const res = await apiFetch<ImpcSolrResponse>(url);
    if (res.isErr()) {
        if (isUnexpectedApiError(res.error)) throw new Error(describeApiError(res.error));
        return { response: { docs: [] } };
    }
    return res.value;
}

/** Full KO phenotype profile for a human gene. */
export async function getKoPhenotypeProfile(geneSymbol: string): Promise<KoPhenotypeProfile> {
    const empty: KoPhenotypeProfile = {
        geneSymbol,
        mouseMarkerSymbol: null,
        mgiAccessionId: null,
        viability: null,
        viabilityCalls: [],
        mpTerms: [],
        organSystems: [],
        sexDimorphic: false,
        phenotypeCount: 0,
        phenotypeDocsTotal: 0,
        phenotypesTruncated: false,
    };

    const gene = await resolveImpcGene(geneSymbol);
    if (!gene) return empty;

    const [pheno, viaAssigned, viaRan] = await Promise.all([
        fetchPhenotypes(gene.mouseMarkerSymbol),
        fetchAssignedViability(gene.mouseMarkerSymbol),
        fetchScreenRan(gene.mouseMarkerSymbol),
    ]);

    const profile = parsePhenotypeResponse(pheno.raw);
    const viabilityCalls = buildViabilityCalls(viaAssigned, viaRan);
    const viability = derivedViability(viabilityCalls);

    return {
        geneSymbol,
        mouseMarkerSymbol: gene.mouseMarkerSymbol,
        mgiAccessionId: gene.mgiAccessionId,
        viability,
        viabilityCalls,
        ...profile,
        phenotypeDocsTotal: pheno.numFound,
        phenotypesTruncated: pheno.numFound > PHENOTYPE_ROW_CAP,
    };
}
