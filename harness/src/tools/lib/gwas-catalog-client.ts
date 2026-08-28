/**
 * Pure async client functions for the NHGRI-EBI GWAS Catalog REST API.
 *
 * Public, no key required. Four search paths: by gene (SNP-by-gene lookup then
 * per-SNP associations), by trait (EFO trait search then its associations), by
 * variant (direct rsID associations), and by study (the associations of one
 * GCST study accession).
 *
 * Absence policy: the sampled payloads show an explicit `null` for an absent
 * leaf value, and the key set of one projection stays constant. A key is absent
 * only when the projection that the request named excludes it.
 */

import { z } from "zod";

import { apiFetchValidated, describeApiError } from "./api-utils.js";
import { GWAS_BASE, GWAS_HEADERS } from "./gwas-catalog-config.js";

export interface GwasAssociation {
    rsId: string;
    pValue: number;
    pValueMantissa: number;
    pValueExponent: number;
    riskAllele: string;
    riskFrequency: string;
    orBeta: number | null;
    ci: string;
    trait: string;
    mappedGenes: string[];
    studyAccession: string;
    pubmedId: string;
    sampleSize: string;
}

export type GwasSearchType = "gene" | "trait" | "variant" | "study";

// GWAS Catalog raw wire shapes (HAL+JSON), validated at the fetch boundary.
// Every field is optional because the API omits absent values; leaf strings
// that the API can return as an explicit `null` are `.nullable()`.
//
// The `study` and `efoTraits` keys of an association exist only on some
// projections: `associationByStudy` nests the study, `associationByEfoTrait`
// nests the traits, and the gene path serves neither. Thus their absence is a
// property of the projection that the request named, and it is not drift.
const RawGwasStudySchema = z.object({
    accessionId: z.string().optional(),
    // The PubMed id is a field of the publication record, and never of the study
    // record itself.
    publicationInfo: z.object({ pubmedId: z.string().nullable().optional() }).optional(),
    initialSampleSize: z.string().optional(),
});
type RawGwasStudy = z.infer<typeof RawGwasStudySchema>;

// `_snpRsId` is not on the wire — the 'gene' search path assigns it after
// parsing (`a._snpRsId = snp.rsId`), so it stays a writable optional field.
const RawGwasAssociationSchema = z.object({
    _snpRsId: z.string().optional(),
    loci: z
        .array(
            z.object({
                strongestRiskAlleles: z.array(z.object({ riskAlleleName: z.string().nullable().optional() })).optional(),
                authorReportedGenes: z.array(z.object({ geneName: z.string().nullable().optional() })).optional(),
            }),
        )
        .optional(),
    efoTraits: z.array(z.object({ trait: z.string().nullable().optional() })).optional(),
    study: RawGwasStudySchema.optional(),
    pvalueMantissa: z.number().optional(),
    pvalueExponent: z.number().optional(),
    riskFrequency: z.string().nullable().optional(),
    orPerCopyNum: z.number().nullable().optional(),
    betaNum: z.number().nullable().optional(),
    range: z.string().nullable().optional(),
});
type RawGwasAssociation = z.infer<typeof RawGwasAssociationSchema>;

export const GwasEmbeddedSchema = z.object({
    _embedded: z.object({ associations: z.array(RawGwasAssociationSchema).optional() }).optional(),
    page: z.object({ totalElements: z.number().optional() }).optional(),
});

export const GwasTraitSearchResponseSchema = z.object({
    _embedded: z
        .object({
            efoTraits: z.array(z.object({ _links: z.object({ self: z.object({ href: z.string().optional() }).optional() }).optional() })).optional(),
        })
        .optional(),
});

export const GwasSnpSearchResponseSchema = z.object({
    _embedded: z
        .object({
            singleNucleotidePolymorphisms: z
                .array(
                    z.object({
                        rsId: z.string().optional(),
                        _links: z.object({ associations: z.object({ href: z.string().optional() }).optional() }).optional(),
                    }),
                )
                .optional(),
        })
        .optional(),
});

export function mapAssociation(a: RawGwasAssociation): GwasAssociation {
    const loci = a.loci ?? [];
    const riskAlleles: string[] = loci.flatMap((l) => l.strongestRiskAlleles?.map((ra) => String(ra.riskAlleleName ?? "")) ?? []);
    const genes: string[] = loci.flatMap((l) => l.authorReportedGenes?.map((g) => String(g.geneName ?? "")) ?? []);
    const traits = (a.efoTraits ?? []).map((t) => String(t.trait ?? ""));
    const study: RawGwasStudy = a.study ?? {};
    const pMantissa: number = a.pvalueMantissa ?? 0;
    const pExponent: number = a.pvalueExponent ?? 0;

    return {
        rsId: String(a._snpRsId ?? riskAlleles[0]?.split("-")[0] ?? ""),
        pValue: pMantissa * Math.pow(10, pExponent),
        pValueMantissa: pMantissa,
        pValueExponent: pExponent,
        riskAllele: riskAlleles.join(", "),
        riskFrequency: String(a.riskFrequency ?? ""),
        orBeta: (a.orPerCopyNum ?? a.betaNum ?? null) as number | null,
        ci: String(a.range ?? ""),
        trait: traits.join("; "),
        mappedGenes: [...new Set(genes)] as string[],
        studyAccession: String(study.accessionId ?? ""),
        pubmedId: String(study.publicationInfo?.pubmedId ?? ""),
        sampleSize: String(study.initialSampleSize ?? ""),
    };
}

export interface GwasSearchOptions {
    pValueThreshold?: number;
    limit?: number;
}

/** Max SNPs whose associations the 'gene' path walks; each is one request. */
const GENE_PATH_MAX_SNPS = 10;

export async function searchGwasCatalog(
    query: string,
    searchType: GwasSearchType,
    options: GwasSearchOptions = {},
): Promise<{ totalFound: number; associations: GwasAssociation[] }> {
    const pValueThreshold = options.pValueThreshold ?? 5e-8;
    const limit = options.limit ?? 25;

    if (searchType === "gene") {
        const url = `${GWAS_BASE}/singleNucleotidePolymorphisms/search/findByGene?geneName=${encodeURIComponent(query)}&projection=snpByGene`;
        const snpRes = await apiFetchValidated(url, GwasSnpSearchResponseSchema, { headers: GWAS_HEADERS });
        if (snpRes.isErr()) throw new Error(describeApiError(snpRes.error));

        const snps = snpRes.value?._embedded?.singleNucleotidePolymorphisms ?? [];
        const allAssocs: RawGwasAssociation[] = [];

        for (const snp of snps.slice(0, Math.min(limit, GENE_PATH_MAX_SNPS))) {
            const assocLink = snp?._links?.associations?.href;
            if (!assocLink) continue;
            const aRes = await apiFetchValidated(assocLink, GwasEmbeddedSchema, { headers: GWAS_HEADERS });
            if (aRes.isOk()) {
                for (const a of aRes.value?._embedded?.associations ?? []) {
                    a._snpRsId = snp.rsId;
                    allAssocs.push(a);
                }
            }
            if (allAssocs.length >= limit) break;
        }

        return { totalFound: allAssocs.length, associations: allAssocs.slice(0, limit).map(mapAssociation) };
    }

    let associationsUrl: string;
    if (searchType === "variant") {
        const rsId = query.startsWith("rs") ? query : `rs${query}`;
        associationsUrl = `${GWAS_BASE}/singleNucleotidePolymorphisms/${rsId}/associations?projection=associationBySnp`;
    } else if (searchType === "study") {
        // The study endpoint keys on the accession alone. The projection nests
        // the study record on each association, thus `mapAssociation` reads the
        // accession, the PubMed id and the sample size without a second request.
        associationsUrl = `${GWAS_BASE}/studies/${encodeURIComponent(query)}/associations?projection=associationByStudy&size=${limit}`;
    } else {
        // `findByEfoTrait` matches the EXACT EFO trait label (case-insensitive),
        // and it answers HTTP 200 with an empty `efoTraits` list when nothing
        // matches. A paraphrase of a label thus reads as clean no-data, and the
        // tool description warns the caller.
        const traitRes = await apiFetchValidated(
            `${GWAS_BASE}/efoTraits/search/findByEfoTrait?trait=${encodeURIComponent(query)}`,
            GwasTraitSearchResponseSchema,
            {
                headers: GWAS_HEADERS,
            },
        );
        if (traitRes.isErr()) throw new Error(describeApiError(traitRes.error));

        const traitUri = (traitRes.value?._embedded?.efoTraits ?? [])[0]?._links?.self?.href;
        if (!traitUri) return { totalFound: 0, associations: [] };

        associationsUrl = `${GWAS_BASE}/efoTraits/${traitUri.split("/").pop()}/associations?size=${limit}`;
    }

    const res = await apiFetchValidated(associationsUrl, GwasEmbeddedSchema, { headers: GWAS_HEADERS });
    if (res.isErr()) {
        // An accession or an rsID that the catalog does not hold is absence, not
        // a failure, thus it returns an empty record set.
        if (res.error.type === "http_status" && res.error.status === 404) return { totalFound: 0, associations: [] };
        throw new Error(describeApiError(res.error));
    }

    const rawAssocs = res.value?._embedded?.associations ?? [];
    const totalFound = res.value?.page?.totalElements ?? rawAssocs.length;

    const filtered = rawAssocs.filter((a) => (a.pvalueMantissa ?? 1) * Math.pow(10, a.pvalueExponent ?? 0) <= pValueThreshold).slice(0, limit);

    return { totalFound, associations: filtered.map(mapAssociation) };
}
