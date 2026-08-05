/**
 * geneDiseaseEvidence — one tool over the three gene↔disease evidence corpora:
 * the NHGRI-EBI GWAS Catalog, DisGeNET, and NCBI ClinVar.
 *
 * These were three tools with the same input skeleton (`query` + a
 * gene/disease/variant discriminator + a strength threshold + `limit`)
 * answering the same question — what genetic evidence links this gene to this
 * disease or trait. Picking between them was never a routing decision an agent
 * should spend a turn on; it is corpus coverage, so it rides in `sources` and
 * defaults to all of them. `search_pathway`'s `source: kegg | reactome | both`
 * is the same shape.
 *
 * Each source runs independently and reports its own outcome in `perSource`: a
 * missing DisGeNET key or a GWAS Catalog outage degrades that one corpus to
 * `unavailable` instead of failing a call the other two could have answered.
 *
 * The input is a flat object with a `queryType` discriminator — not a
 * `z.discriminatedUnion`, which `defineTool` rejects (model tool calling needs
 * a top-level `"type":"object"`).
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "../define-tool.js";
import { filterInformative, searchClinvar, type ClinicalSignificance, type ClinvarVariant } from "../lib/clinvar-client.js";
import { searchDisgenet, type Gda } from "../lib/disgenet-client.js";
import { searchGwasCatalog, type GwasAssociation } from "../lib/gwas-catalog-client.js";

const SOURCES = ["gwas", "disgenet", "clinvar"] as const;
type Source = (typeof SOURCES)[number];

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

/** DisGeNET has no variant-level lookup; the other two do. */
function applicableSources(queryType: "gene" | "disease" | "variant"): Source[] {
    return queryType === "variant" ? ["gwas", "clinvar"] : [...SOURCES];
}

const inputSchema = z.object({
    query: z
        .string()
        .min(1)
        .describe(
            "The entity, matching `queryType`. gene: a HUGO symbol ('PCSK9'); DisGeNET also takes an Entrez ID. disease: a disease or trait name " +
                "('LDL cholesterol'); DisGeNET also takes a UMLS CUI ('C0006142'). variant: a dbSNP rsID ('rs11591147').",
        ),
    queryType: z
        .enum(["gene", "disease", "variant"])
        .describe(
            "'gene' — the diseases/traits associated with a gene. 'disease' — the genes associated with a disease or trait (the GWAS Catalog calls it a " +
                "trait; this value covers both). 'variant' — one rsID; DisGeNET is skipped, having no variant-level lookup.",
        ),
    sources: z
        .array(z.enum(SOURCES))
        .min(1)
        .optional()
        .describe(
            "Corpora to query in parallel. Default ALL applicable — they carry different evidence types, and disagreement between them is itself informative. " +
                "'gwas': population SNP-trait associations with effect sizes and p-values (common-variant / MR support). " +
                "'disgenet': curated + text-mined gene-disease associations scored 0–1, broadest coverage; needs DISGENET_API_KEY. " +
                "'clinvar': clinically classified germline variants — pathogenicity and review status; rare/Mendelian rather than common-variant.",
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
        .enum(["ALL", "CURATED", "ANIMAL_MODELS", "BEFREE"])
        .optional()
        .describe("'disgenet' only. Provenance filter; default 'ALL'. Prefer 'CURATED' for anything you will quote — 'BEFREE' is text-mined and noisy."),
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
    queryType: "gene" | "disease" | "variant";
    perSource: SourceOutcome[];
    gwas?: GwasAssociation[];
    disgenet?: Gda[];
    clinvar?: ClinvarVariant[];
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
            "Genetic evidence linking a gene to a disease or trait, across the GWAS Catalog, DisGeNET and ClinVar in one call — 'is there human genetic " +
            "support for this target in this indication?'. See `sources` for what each corpus carries.\n" +
            "For the integrated, pre-scored view prefer opentargets({action:'target'}) FIRST — it folds genetic association together with tractability " +
            "and the drug landscape. Reach here for the underlying records: actual SNPs, effect sizes, scores and pathogenicity calls with their studies and PMIDs.\n" +
            "ALWAYS read `perSource` before concluding anything is absent. 'no_data' means that corpus genuinely has nothing; 'unavailable' means it " +
            "could not be reached (a missing DISGENET_API_KEY lands here — tell the user and proceed with the other two); 'not_applicable' means that " +
            "corpus has no lookup for this queryType. Only 'no_data' is evidence of absence, and none is worth retrying unchanged.",
        inputSchema,
        describeCall: "none",
        execute: async (input) => {
            const applicable = applicableSources(input.queryType);
            const requested = input.sources ?? applicable;
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

            const [gwas, disgenet, clinvar] = await Promise.all([
                selected.includes("gwas")
                    ? runSource<GwasAssociation>("gwas", async () => {
                          const searchType = input.queryType === "gene" ? "gene" : input.queryType === "disease" ? "trait" : "variant";
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
                          const records = await searchDisgenet(deps.disgenetApiKey, input.query, input.queryType === "gene" ? "gene" : "disease", {
                              limit,
                              ...(input.minScore !== undefined ? { minScore: input.minScore } : {}),
                              ...(input.disgenetSource !== undefined ? { source: input.disgenetSource } : {}),
                          });
                          return { records };
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

            return ok(output);
        },
    });
}
