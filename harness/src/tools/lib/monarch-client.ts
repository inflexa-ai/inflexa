/**
 * Pure async client functions for the Monarch Initiative association API.
 *
 * Monarch curates human gene→phenotype annotations (HPO, from HPOA/OMIM/
 * Orphanet) and causal gene→disease assertions (MONDO). Both are *human*
 * loss-of-function evidence: what is observed in people carrying variation in
 * the gene, as opposed to a mouse knockout's phenotype or an aggregate
 * gene-disease association score.
 *
 * Each phenotype association carries its HPO ancestor closure, which is what
 * lets a consumer resolve the phenotype onto an organ system by identifier
 * rather than by matching prose.
 *
 * The API is keyless and public.
 */

import { z } from "zod";

import { apiFetchValidated, describeApiError, isUnexpectedApiError } from "./api-utils.js";

const MONARCH_BASE = "https://api-v3.monarchinitiative.org/v3/api";

/** Row cap per association category — a well-annotated gene carries a few hundred. */
const ASSOCIATION_ROW_CAP = 300;

/** The closure arrays make these responses large; the default timeout is short for them. */
const REQUEST_TIMEOUT_MS = 120_000;

const HUMAN_TAXON = "NCBITaxon:9606";

/** Phenotype terms live in the HPO namespace; a model-organism term would not. */
const HPO_NAMESPACE = "HP";

/**
 * One association row. Every field is optional because Monarch returns the same
 * envelope for every category and populates only what applies; the reader below
 * treats a missing field as absent rather than trusting the wire.
 */
const MonarchAssociationSchema = z.object({
    predicate: z.string().optional(),
    subject: z.string().optional(),
    subject_taxon: z.string().nullish(),
    object: z.string().optional(),
    object_label: z.string().nullish(),
    object_namespace: z.string().nullish(),
    object_closure: z.array(z.string()).nullish(),
    publications: z.array(z.string()).nullish(),
    primary_knowledge_source: z.string().nullish(),
    disease_context_qualifier: z.string().nullish(),
    has_percentage: z.number().nullish(),
    evidence_count: z.number().nullish(),
});
type MonarchAssociation = z.infer<typeof MonarchAssociationSchema>;

const MonarchAssociationPageSchema = z.object({
    total: z.number().optional(),
    items: z.array(MonarchAssociationSchema).optional(),
});

/** A curated human phenotype attributed to variation in the gene. */
export interface MonarchPhenotypeAssociation {
    /** HPO term id, e.g. `HP:0001392`. */
    readonly hpoId: string;
    readonly label: string;
    /** The term's HPO ancestor closure, for identifier-based organ resolution. */
    readonly ancestorIds: string[];
    /** PMIDs (as `PMID:…` curies) cited by the annotation. */
    readonly publications: string[];
    /** The disease the phenotype was annotated under, when the annotation names one. */
    readonly diseaseContext: string | null;
    /** Share of affected individuals showing the phenotype, when annotated. */
    readonly frequencyPercent: number | null;
    readonly primaryKnowledgeSource: string | null;
}

/** A disease the gene is asserted to cause. */
export interface MonarchDiseaseAssociation {
    /** MONDO term id, e.g. `MONDO:0007265`. */
    readonly mondoId: string;
    readonly label: string;
    readonly predicate: string;
    readonly primaryKnowledgeSource: string | null;
    readonly publications: string[];
}

export interface MonarchGeneProfile {
    /** The curie the gene was queried by, e.g. `HGNC:1097`. */
    readonly geneCurie: string;
    readonly phenotypes: MonarchPhenotypeAssociation[];
    readonly phenotypeTotal: number;
    readonly phenotypesTruncated: boolean;
    readonly diseases: MonarchDiseaseAssociation[];
    readonly diseaseTotal: number;
    readonly diseasesTruncated: boolean;
}

async function fetchAssociations(geneCurie: string, category: string): Promise<{ items: MonarchAssociation[]; total: number }> {
    const params = new URLSearchParams({
        subject: geneCurie,
        category,
        limit: String(ASSOCIATION_ROW_CAP),
    });
    const res = await apiFetchValidated(`${MONARCH_BASE}/association?${params.toString()}`, MonarchAssociationPageSchema, {
        timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (res.isErr()) {
        // A 4xx means the gene curie is not one Monarch holds — an expected
        // "not found", returned as an empty page. Anything else is a real
        // failure and surfaces.
        if (isUnexpectedApiError(res.error)) throw new Error(describeApiError(res.error));
        return { items: [], total: 0 };
    }
    const items = res.value.items ?? [];
    return { items, total: res.value.total ?? items.length };
}

/**
 * Human phenotype annotations only.
 *
 * Monarch serves a gene's phenotype edges from several annotation sets; the
 * filter keeps the rows whose subject is the human gene and whose object is an
 * HPO term, so model-organism phenotypes stay with the collector that owns them.
 */
function toPhenotype(row: MonarchAssociation): MonarchPhenotypeAssociation | null {
    if (!row.object || !row.object.startsWith(`${HPO_NAMESPACE}:`)) return null;
    if (row.subject_taxon != null && row.subject_taxon !== HUMAN_TAXON) return null;
    return {
        hpoId: row.object,
        label: row.object_label ?? "",
        ancestorIds: row.object_closure ?? [],
        publications: row.publications ?? [],
        diseaseContext: row.disease_context_qualifier ?? null,
        frequencyPercent: row.has_percentage ?? null,
        primaryKnowledgeSource: row.primary_knowledge_source ?? null,
    };
}

function toDisease(row: MonarchAssociation): MonarchDiseaseAssociation | null {
    if (!row.object || !row.object.startsWith("MONDO:")) return null;
    return {
        mondoId: row.object,
        label: row.object_label ?? "",
        predicate: row.predicate ?? "biolink:causes",
        primaryKnowledgeSource: row.primary_knowledge_source ?? null,
        publications: row.publications ?? [],
    };
}

/**
 * Curated human phenotype and causal-disease associations for one gene.
 *
 * `geneCurie` is a prefixed identifier Monarch resolves — an HGNC id
 * (`HGNC:1097`) or an NCBI gene id (`NCBIGene:673`). A gene Monarch does not
 * hold returns an empty profile rather than an error.
 */
export async function getGenePhenotypeProfile(geneCurie: string): Promise<MonarchGeneProfile> {
    const [phenoPage, diseasePage] = await Promise.all([
        fetchAssociations(geneCurie, "biolink:GeneToPhenotypicFeatureAssociation"),
        fetchAssociations(geneCurie, "biolink:CausalGeneToDiseaseAssociation"),
    ]);

    const phenotypes: MonarchPhenotypeAssociation[] = [];
    for (const row of phenoPage.items) {
        const p = toPhenotype(row);
        if (p) phenotypes.push(p);
    }

    const diseases: MonarchDiseaseAssociation[] = [];
    for (const row of diseasePage.items) {
        const d = toDisease(row);
        if (d) diseases.push(d);
    }

    return {
        geneCurie,
        phenotypes,
        phenotypeTotal: phenoPage.total,
        phenotypesTruncated: phenoPage.total > phenoPage.items.length,
        diseases,
        diseaseTotal: diseasePage.total,
        diseasesTruncated: diseasePage.total > diseasePage.items.length,
    };
}
