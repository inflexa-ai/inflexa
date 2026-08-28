/**
 * geneDiseaseEvidence — one tool over the four gene↔disease evidence corpora:
 * the NHGRI-EBI GWAS Catalog, DisGeNET, NCBI ClinVar, and cBioPortal.
 *
 * The first three were three tools with the same input skeleton (`query` + a
 * gene/disease/variant discriminator + a strength threshold + `limit`)
 * answering the same question — what genetic evidence links this gene to this
 * disease or trait. Picking between them was never a routing decision an agent
 * should spend a turn on; it is corpus coverage, so it rides in `sources` and
 * defaults to all of them. `search_pathway`'s `source: kegg | reactome | both`
 * is the same shape.
 *
 * cBioPortal joins them as the somatic half of the same question, and it is the
 * one source that is NOT in the default set: it scans every curated study, thus
 * it costs several large requests that a routine gene query must not pay.
 *
 * Each source runs independently and reports its own outcome in `perSource`: a
 * missing DisGeNET key or a GWAS Catalog outage degrades that one corpus to
 * `unavailable` instead of failing a call the others could have answered.
 *
 * The input is a flat object with a `queryType` discriminator — not a
 * `z.discriminatedUnion`, which `defineTool` rejects (model tool calling needs
 * a top-level `"type":"object"`). A `queryType` that only one corpus can serve
 * — an accession of that corpus — marks the others `not_applicable` rather
 * than sending them a query they cannot read.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "../define-tool.js";
import { getSomaticMutationFrequencies, type MutationFrequency } from "../lib/cbioportal-client.js";
import { filterInformative, searchClinvar, type ClinicalSignificance, type ClinvarVariant } from "../lib/clinvar-client.js";
import { DISGENET_SOURCES, searchDisgenet, type Gda } from "../lib/disgenet-client.js";
import { searchGwasCatalog, type GwasAssociation, type GwasSearchType } from "../lib/gwas-catalog-client.js";

const SOURCES = ["gwas", "disgenet", "clinvar", "cbioportal"] as const;
type Source = (typeof SOURCES)[number];

const QUERY_TYPES = ["gene", "disease", "variant", "gwas_study", "clinvar_accession"] as const;
type QueryType = (typeof QUERY_TYPES)[number];

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

/**
 * Per-source outcome. `unavailable` (key absent, corpus erroring) and
 * `not_applicable` (the corpus has no lookup for this queryType) are both
 * normal states the caller must be able to tell apart from genuine no-data —
 * otherwise an unkeyed DisGeNET reads as "no genetic support".
 */
interface SourceOutcome {
    source: Source;
    status: "ok" | "no_data" | "unavailable" | "not_applicable";
    returned: number;
    totalFound?: number;
    detail?: string;
}

/** Which query types each corpus can read. An accession is readable by one corpus only. */
const SOURCE_QUERY_TYPES: Record<Source, readonly QueryType[]> = {
    gwas: ["gene", "disease", "variant", "gwas_study"],
    disgenet: ["gene", "disease"],
    clinvar: ["gene", "disease", "variant", "clinvar_accession"],
    cbioportal: ["gene"],
};

/**
 * cBioPortal stays out of the default set. It scans every curated study, thus
 * a caller opts into it by naming it in `sources`.
 */
const OPT_IN_SOURCES: readonly Source[] = ["cbioportal"];

function applicableSources(queryType: QueryType): Source[] {
    return SOURCES.filter((source) => SOURCE_QUERY_TYPES[source].includes(queryType));
}

/** The corpora a call queries when it names none. */
function defaultSources(queryType: QueryType): Source[] {
    return applicableSources(queryType).filter((source) => !OPT_IN_SOURCES.includes(source));
}

/**
 * The GWAS Catalog name for each query type it serves. `clinvar_accession` is
 * absent because `applicableSources` never selects the GWAS Catalog for it.
 */
const GWAS_SEARCH_TYPES: Partial<Record<QueryType, GwasSearchType>> = {
    gene: "gene",
    disease: "trait",
    variant: "variant",
    gwas_study: "study",
};

const inputSchema = z.object({
    query: z
        .string()
        .min(1)
        .describe(
            "The entity, matching `queryType`. gene: a HUGO symbol ('PCSK9'); DisGeNET also takes an Entrez ID, and cBioPortal takes the symbol " +
                "directly. disease: a disease or trait name ('LDL cholesterol'); DisGeNET also takes a UMLS CUI ('C0006142'). variant: a dbSNP rsID " +
                "('rs11591147'). gwas_study: a GWAS Catalog study accession ('GCST000392'). clinvar_accession: a ClinVar accession ('VCV000012345', " +
                "'RCV000009910') or a bare variation ID.",
        ),
    queryType: z
        .enum(QUERY_TYPES)
        .describe(
            "'gene' — the diseases/traits associated with a gene. 'disease' — the genes associated with a disease or trait (the GWAS Catalog calls it a " +
                "trait; this value covers both). 'variant' — one rsID; DisGeNET is skipped, having no variant-level lookup. 'gwas_study' — every " +
                "association reported by ONE GWAS Catalog study, read back from the studyAccession that a gwas record carries; GWAS Catalog only. " +
                "'clinvar_accession' — one ClinVar record, read back from the accession that a clinvar record carries; ClinVar only.",
        ),
    sources: z
        .array(z.enum(SOURCES))
        .min(1)
        .optional()
        .describe(
            "Corpora to query in parallel. Default ALL applicable EXCEPT cbioportal — they carry different evidence types, and disagreement between them " +
                "is itself informative. " +
                "'gwas': the NHGRI-EBI GWAS Catalog — population SNP-trait associations with effect sizes and p-values (common-variant / MR support). " +
                "'disgenet': curated + text-mined gene-disease associations scored 0–1, broadest coverage; needs DISGENET_API_KEY. " +
                "'clinvar': NCBI ClinVar — clinically classified germline variants, pathogenicity and review status; rare/Mendelian rather than " +
                "common-variant. " +
                "'cbioportal': the somatic half — how often the gene is mutated in each cancer type across every curated cBioPortal study, as " +
                "cancerTypeName, mutatedSamples/totalSamples, frequency and the contributing studies. OPT IN by naming it: it scans every study, so it is " +
                "several seconds slower than the rest, and it applies to queryType 'gene' only.",
        ),
    limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_LIMIT)
        .optional()
        .describe(
            `Max records PER SOURCE (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}); all three sources at the default return at most ` +
                `${DEFAULT_LIMIT * 3} records. Check each source's \`totalFound\` before raising it.`,
        ),
    pValueThreshold: z
        .number()
        .positive()
        .optional()
        .describe("'gwas' only. P-value ceiling; default 5e-8 (genome-wide significance). Raise for suggestive hits."),
    minScore: z.number().min(0).max(1).optional().describe("'disgenet' only. Minimum GDA score 0–1; default 0.1. Higher = stronger evidence."),
    disgenetSource: z
        .enum(DISGENET_SOURCES)
        .optional()
        .describe(
            "'disgenet' only. Provenance filter; default 'ALL'. Prefer 'CURATED' for anything you will quote — 'TEXTMINING_HUMAN' and " +
                "'TEXTMINING_MODELS' are text-mined and noisy, and 'MODELS' is animal-model evidence.",
        ),
    clinicalSignificance: z
        .enum(["pathogenic", "likely-pathogenic", "benign", "likely-benign", "uncertain"])
        .optional()
        .describe("'clinvar' only. Restrict to one pathogenicity classification; omit for all."),
    informativeOnly: z
        .boolean()
        .optional()
        .describe("'clinvar' only. Default TRUE — drop variants classified 'not provided', 'not specified' or 'reclassified', which carry no clinical signal."),
});

interface GeneDiseaseEvidenceOutput {
    query: string;
    queryType: QueryType;
    perSource: SourceOutcome[];
    gwas?: GwasAssociation[];
    disgenet?: Gda[];
    clinvar?: ClinvarVariant[];
    cbioportal?: MutationFrequency[];
}

/**
 * Run one corpus, folding its failure into an `unavailable` outcome. A source
 * that throws must not take the others down — that is the whole reason three
 * tools could become one without losing the ability to say "this corpus was
 * not reachable" as distinct from "this corpus knows nothing".
 */
async function runSource<T>(source: Source, fetch: () => Promise<{ records: T[]; totalFound?: number }>): Promise<{ outcome: SourceOutcome; records: T[] }> {
    try {
        const { records, totalFound } = await fetch();
        return {
            outcome: {
                source,
                status: records.length > 0 ? "ok" : "no_data",
                returned: records.length,
                ...(totalFound !== undefined ? { totalFound } : {}),
            },
            records,
        };
    } catch (error) {
        return {
            outcome: {
                source,
                status: "unavailable",
                returned: 0,
                detail: error instanceof Error ? error.message : String(error),
            },
            records: [],
        };
    }
}

export function createGeneDiseaseEvidenceTool(deps: { ncbiApiKey?: string; disgenetApiKey: string }) {
    return defineTool({
        id: "gene_disease_evidence",
        description:
            "Genetic evidence linking a gene to a disease or trait, across the NHGRI-EBI GWAS Catalog, DisGeNET, NCBI ClinVar and cBioPortal in one call " +
            "— 'is there human genetic support for this target in this indication?'. See `sources` for what each corpus carries.\n" +
            "For the integrated, pre-scored view prefer opentargets({action:'target'}) FIRST — it folds genetic association together with tractability " +
            "and the drug landscape. Reach here for the underlying records: actual SNPs, effect sizes, scores, pathogenicity calls and somatic mutation " +
            "frequencies with their studies and PMIDs.\n" +
            "ACCEPTED IDENTIFIERS, each named by its `queryType`: a HUGO gene symbol or an Entrez ID ('PCSK9', '5008'); a disease or trait name or a UMLS " +
            "CUI ('LDL cholesterol', 'C0006142'); a dbSNP rsID ('rs11591147'); a GWAS Catalog study accession ('GCST000392'); and a ClinVar accession " +
            "('VCV000012345'). The last two read one record back by the accession that an earlier result of this same tool reported.\n" +
            "ALWAYS read `perSource` before concluding anything is absent. 'no_data' means that corpus genuinely has nothing; 'unavailable' means it " +
            "could not be reached (a missing DISGENET_API_KEY lands here — tell the user and proceed with the others); 'not_applicable' means that " +
            "corpus has no lookup for this queryType. Only 'no_data' is evidence of absence, and none is worth retrying unchanged.",
        inputSchema,
        describeCall: "none",
        execute: async (input) => {
            const applicable = applicableSources(input.queryType);
            const requested = input.sources ?? defaultSources(input.queryType);
            const selected = requested.filter((s) => applicable.includes(s));
            const limit = input.limit ?? DEFAULT_LIMIT;

            const output: GeneDiseaseEvidenceOutput = {
                query: input.query,
                queryType: input.queryType,
                perSource: requested
                    .filter((s) => !applicable.includes(s))
                    .map((source) => ({
                        source,
                        status: "not_applicable" as const,
                        returned: 0,
                        detail: `${source} has no lookup for queryType '${input.queryType}'`,
                    })),
            };

            const [gwas, disgenet, clinvar, cbioportal] = await Promise.all([
                selected.includes("gwas")
                    ? runSource<GwasAssociation>("gwas", async () => {
                          const searchType = GWAS_SEARCH_TYPES[input.queryType]!;
                          const res = await searchGwasCatalog(input.query, searchType, {
                              limit,
                              ...(input.pValueThreshold !== undefined ? { pValueThreshold: input.pValueThreshold } : {}),
                          });
                          return { records: res.associations, totalFound: res.totalFound };
                      })
                    : null,
                selected.includes("disgenet")
                    ? runSource<Gda>("disgenet", async () => {
                          if (!deps.disgenetApiKey) throw new Error("DISGENET_API_KEY is not configured");
                          return await searchDisgenet(deps.disgenetApiKey, input.query, input.queryType === "gene" ? "gene" : "disease", {
                              limit,
                              ...(input.minScore !== undefined ? { minScore: input.minScore } : {}),
                              ...(input.disgenetSource !== undefined ? { source: input.disgenetSource } : {}),
                          });
                      })
                    : null,
                selected.includes("clinvar")
                    ? runSource<ClinvarVariant>("clinvar", async () => {
                          const res = await searchClinvar(deps.ncbiApiKey, input.query, {
                              limit,
                              ...(input.clinicalSignificance !== undefined ? { clinicalSignificance: input.clinicalSignificance as ClinicalSignificance } : {}),
                          });
                          const variants = (input.informativeOnly ?? true) ? filterInformative(res.variants) : res.variants;
                          return { records: variants, totalFound: res.totalFound };
                      })
                    : null,
                selected.includes("cbioportal")
                    ? runSource<MutationFrequency>("cbioportal", async () => {
                          const res = await getSomaticMutationFrequencies(input.query);
                          return { records: res.rows.slice(0, limit), totalFound: res.rows.length };
                      })
                    : null,
            ]);

            if (gwas) {
                output.perSource.push(gwas.outcome);
                output.gwas = gwas.records;
            }
            if (disgenet) {
                output.perSource.push(disgenet.outcome);
                output.disgenet = disgenet.records;
            }
            if (clinvar) {
                output.perSource.push(clinvar.outcome);
                output.clinvar = clinvar.records;
            }
            if (cbioportal) {
                output.perSource.push(cbioportal.outcome);
                output.cbioportal = cbioportal.records;
            }

            return ok(output);
        },
    });
}
