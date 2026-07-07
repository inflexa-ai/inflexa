/**
 * searchGwasCatalog — search NHGRI-EBI GWAS Catalog for SNP-trait associations.
 *
 * Public REST API, no key required. Three search modes:
 *   - 'gene' — gene-trait associations (via SNP-by-gene lookup, then assocs)
 *   - 'trait' — trait-gene associations (via EFO trait search, then assocs)
 *   - 'variant' — direct rsID lookup
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "../define-tool.js";
import { apiFetchValidated, describeApiError } from "../lib/api-utils.js";
import { GWAS_BASE, GWAS_HEADERS } from "../lib/gwas-catalog-config.js";

interface GwasAssociation {
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

// GWAS Catalog raw wire shapes (HAL+JSON), validated at the fetch boundary.
// Every field is optional because the API omits absent values; leaf strings
// that the API can return as an explicit `null` are `.nullable()`.
const RawGwasStudySchema = z.object({
    accessionId: z.string().optional(),
    pubmedId: z.string().optional(),
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
    riskFrequency: z.string().optional(),
    orPerCopyNum: z.number().nullable().optional(),
    betaNum: z.number().nullable().optional(),
    range: z.string().optional(),
});
type RawGwasAssociation = z.infer<typeof RawGwasAssociationSchema>;

const GwasEmbeddedSchema = z.object({
    _embedded: z.object({ associations: z.array(RawGwasAssociationSchema).optional() }).optional(),
    page: z.object({ totalElements: z.number().optional() }).optional(),
});

const GwasTraitSearchResponseSchema = z.object({
    _embedded: z
        .object({
            efoTraits: z.array(z.object({ _links: z.object({ self: z.object({ href: z.string().optional() }).optional() }).optional() })).optional(),
        })
        .optional(),
});

const GwasSnpSearchResponseSchema = z.object({
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

function mapAssociation(a: RawGwasAssociation): GwasAssociation {
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
        pubmedId: String(study.pubmedId ?? ""),
        sampleSize: String(study.initialSampleSize ?? ""),
    };
}

export const searchGwasCatalogTool = defineTool({
    id: "search_gwas_catalog",
    description:
        "Search the NHGRI-EBI GWAS Catalog for genome-wide association study results. " +
        "Returns SNP associations with traits/diseases, effect sizes, p-values, and mapped genes. " +
        "Use to find genetic evidence linking genes to phenotypes for target validation or " +
        "Mendelian randomization support.",
    inputSchema: z.object({
        query: z.string().describe("Gene symbol (e.g. PCSK9), trait keyword (e.g. cholesterol), or rsID (e.g. rs11591147)"),
        searchType: z
            .enum(["gene", "trait", "variant"])
            .describe("'gene' for gene-trait associations, 'trait' for trait-gene associations, 'variant' for a specific rsID"),
        pValueThreshold: z.number().default(5e-8).describe("P-value threshold for genome-wide significance"),
        limit: z.number().int().min(1).max(100).default(25).describe("Max results to return"),
    }),
    execute: async ({ query, searchType, pValueThreshold = 5e-8, limit = 25 }) => {
        let url: string;
        if (searchType === "variant") {
            const rsId = query.startsWith("rs") ? query : `rs${query}`;
            url = `${GWAS_BASE}/singleNucleotidePolymorphisms/${rsId}/associations?projection=associationBySnp`;
        } else if (searchType === "gene") {
            url = `${GWAS_BASE}/singleNucleotidePolymorphisms/search/findByGene?geneName=${encodeURIComponent(query)}&projection=snpByGene`;
        } else {
            url = `${GWAS_BASE}/efoTraits/search/findBySearchQuery?query=${encodeURIComponent(query)}`;
        }

        if (searchType === "trait") {
            const traitRes = await apiFetchValidated(url, GwasTraitSearchResponseSchema, { headers: GWAS_HEADERS });
            if (traitRes.isErr()) throw new Error(describeApiError(traitRes.error));

            const traits = traitRes.value?._embedded?.efoTraits ?? [];
            if (traits.length === 0) {
                return ok({ totalFound: 0, associations: [] as GwasAssociation[] });
            }

            const traitUri = traits[0]?._links?.self?.href;
            if (!traitUri) {
                return ok({ totalFound: 0, associations: [] as GwasAssociation[] });
            }

            const traitId = traitUri.split("/").pop();
            url = `${GWAS_BASE}/efoTraits/${traitId}/associations?size=${limit}`;
        }

        if (searchType === "gene") {
            const snpRes = await apiFetchValidated(url, GwasSnpSearchResponseSchema, { headers: GWAS_HEADERS });
            if (snpRes.isErr()) throw new Error(describeApiError(snpRes.error));

            const snps = snpRes.value?._embedded?.singleNucleotidePolymorphisms ?? [];
            const allAssocs: RawGwasAssociation[] = [];

            for (const snp of snps.slice(0, Math.min(limit, 10))) {
                const assocLink = snp?._links?.associations?.href;
                if (!assocLink) continue;
                const aRes = await apiFetchValidated(assocLink, GwasEmbeddedSchema, {
                    headers: GWAS_HEADERS,
                });
                if (aRes.isOk()) {
                    for (const a of aRes.value?._embedded?.associations ?? []) {
                        a._snpRsId = snp.rsId;
                        allAssocs.push(a);
                    }
                }
                if (allAssocs.length >= limit) break;
            }

            return ok({
                totalFound: allAssocs.length,
                associations: allAssocs.slice(0, limit).map(mapAssociation),
            });
        }

        const res = await apiFetchValidated(url, GwasEmbeddedSchema, { headers: GWAS_HEADERS });
        if (res.isErr()) throw new Error(describeApiError(res.error));

        const rawAssocs = res.value?._embedded?.associations ?? [];
        const totalFound = res.value?.page?.totalElements ?? rawAssocs.length;

        const filtered = rawAssocs
            .filter((a) => {
                const p = (a.pvalueMantissa ?? 1) * Math.pow(10, a.pvalueExponent ?? 0);
                return p <= pValueThreshold;
            })
            .slice(0, limit);

        return ok({
            totalFound,
            associations: filtered.map(mapAssociation),
        });
    },
});
