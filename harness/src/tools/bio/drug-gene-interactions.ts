/**
 * drugGeneInteractions — one tool over the three drug↔gene corpora: DGIdb,
 * DrugBank, and PharmGKB.
 *
 * These were three tools with the same input skeleton (`query` + a gene/drug
 * discriminator + `limit`) answering one question in two directions: what drugs
 * hit this gene, and what genes does this drug act on. DGIdb *aggregates* the
 * other two (it names ChEMBL, DrugBank, PharmGKB and GuideToPharmacology among
 * its 30+ sources), so the choice between them was never a routing decision —
 * it is coverage, and it rides in `sources`.
 *
 * Unlike `gene_disease_evidence`, the default here is the AGGREGATOR ALONE:
 * DGIdb already covers what the other two hold, so fanning out by default would
 * mostly return the same interactions three times.
 *
 * Each source runs independently and reports its own outcome in `perSource`, so
 * a missing DrugBank key degrades that corpus rather than the whole call.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { createNoopLogger } from "../../lib/console-logger.js";
import type { Logger } from "../../lib/logger.js";
import { defineTool } from "../define-tool.js";
import { searchDgidb, type DgidbResult } from "../lib/dgidb-client.js";
import { searchDrugbank, type DrugResult } from "../lib/drugbank-client.js";
import { searchPharmgkb, type PharmgkbAnnotation } from "../lib/pharmgkb-client.js";

const SOURCES = ["dgidb", "drugbank", "pharmgkb"] as const;
type Source = (typeof SOURCES)[number];

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;
const MAX_INPUTS = 25;
/** Prose kept per DrugBank field when the full record is not requested. */
const PROSE_PREVIEW_CHARS = 200;
/** Targets and interactions kept per DrugBank record. */
const MAX_DRUG_TARGETS = 10;
const MAX_DRUG_INTERACTIONS = 10;

interface SourceOutcome {
    source: Source;
    status: "ok" | "no_data" | "unavailable";
    returned: number;
    detail?: string;
}

/**
 * A DrugBank record projected for context. `includeDrugRecord` decides whether
 * the five prose fields arrive whole or as previews — five 500-character fields
 * across ten records is 25k characters of narrative that a drug-vs-gene
 * question rarely needs.
 */
interface ProjectedDrug {
    drugbankId: string;
    name: string;
    type: string;
    groups: string[];
    categories: string[];
    halfLife: string;
    targets: DrugResult["targets"];
    targetCount: number;
    interactions: DrugResult["interactions"];
    interactionCount: number;
    description: string;
    indication: string;
    pharmacodynamics: string;
    mechanismOfAction: string;
    toxicity: string;
    proseTruncated: boolean;
}

const inputSchema = z.object({
    query: z
        .union([z.string().min(1), z.array(z.string().min(1)).min(1).max(MAX_INPUTS)])
        .describe(
            `One identifier or up to ${MAX_INPUTS} — batch rather than calling per identifier. 'gene_to_drugs': HUGO symbols. 'drug_to_genes': drug ` +
                "names, DrugBank IDs (DB00619), or DGIdb concept IDs. Only 'dgidb' batches; the others read the FIRST and report the rest as skipped.",
        ),
    direction: z
        .enum(["gene_to_drugs", "drug_to_genes"])
        .describe(
            "'gene_to_drugs' — what drugs act on these genes ('what is druggable in my gene set?'). 'drug_to_genes' — what genes these drugs act on " +
                "(target deconvolution, polypharmacology).",
        ),
    sources: z
        .array(z.enum(SOURCES))
        .min(1)
        .optional()
        .describe(
            "Corpora to query in parallel. Default ['dgidb'] ALONE — it aggregates the other two, so add them only for what they uniquely hold. " +
                "'dgidb': 30+ aggregated sources, per-interaction source count as confidence; the only one that batches. " +
                "'drugbank': the curated drug RECORD (indication, pharmacodynamics, mechanism, toxicity, half-life, DDIs); needs DRUGBANK_API_KEY. " +
                "'pharmgkb': pharmacogenomic annotations graded 1A…4 (1A guideline-backed); exact match only — 'CYP2D6' resolves, 'cytochrome P450 2D6' does not.",
        ),
    limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_LIMIT)
        .optional()
        .describe(
            `Max records per identifier per source (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}). DGIdb rows are ordered by source count descending; ` +
                "`totalInteractions` gives the pre-trim count.",
        ),
    interactionTypes: z.array(z.string()).optional().describe("'dgidb' only. Case-insensitive substring filter on interaction type, e.g. ['inhibitor']."),
    sourceDbs: z.array(z.string()).optional().describe("'dgidb' only. Keep only interactions from these underlying databases (substring), e.g. ['chembl']."),
    minSources: z.number().int().min(1).optional().describe("'dgidb' only. Drop interactions with fewer than this many supporting sources; default 1."),
    includeAttributes: z
        .boolean()
        .optional()
        .describe(
            "'dgidb' only. Default FALSE — attributes are verbose free-text pairs. True only when you need the assay detail, not the interaction's existence.",
        ),
    includeDrugRecord: z
        .boolean()
        .optional()
        .describe(
            `'drugbank' only. Default FALSE — the five prose fields come back as ${PROSE_PREVIEW_CHARS}-char previews with proseTruncated: true. ` +
                "True for full text; narrow `limit` when you do.",
        ),
});

interface DrugGeneOutput {
    direction: "gene_to_drugs" | "drug_to_genes";
    perSource: SourceOutcome[];
    dgidb?: DgidbResult[];
    drugbank?: ProjectedDrug[];
    pharmgkb?: PharmgkbAnnotation[];
}

function projectDrug(drug: DrugResult, includeFullProse: boolean): ProjectedDrug {
    const prose = (value: string): string => (includeFullProse ? value : value.slice(0, PROSE_PREVIEW_CHARS));
    return {
        drugbankId: drug.drugbankId,
        name: drug.name,
        type: drug.type,
        groups: drug.groups,
        categories: drug.categories,
        halfLife: drug.halfLife,
        targets: drug.targets.slice(0, MAX_DRUG_TARGETS),
        targetCount: drug.targets.length,
        interactions: drug.interactions.slice(0, MAX_DRUG_INTERACTIONS),
        interactionCount: drug.interactions.length,
        description: prose(drug.description),
        indication: prose(drug.indication),
        pharmacodynamics: prose(drug.pharmacodynamics),
        mechanismOfAction: prose(drug.mechanismOfAction),
        toxicity: prose(drug.toxicity),
        proseTruncated: !includeFullProse,
    };
}

/**
 * Run one corpus, folding its failure into an `unavailable` outcome so a dead
 * or unkeyed source cannot take down a call the others could answer.
 */
async function runSource<T>(source: Source, fetch: () => Promise<T[]>): Promise<{ outcome: SourceOutcome; records: T[] }> {
    try {
        const records = await fetch();
        return { outcome: { source, status: records.length > 0 ? "ok" : "no_data", returned: records.length }, records };
    } catch (error) {
        return {
            outcome: { source, status: "unavailable", returned: 0, detail: error instanceof Error ? error.message : String(error) },
            records: [],
        };
    }
}

export function createDrugGeneInteractionsTool(deps: { drugbankApiKey: string; logger?: Logger }) {
    const logger = (deps.logger ?? createNoopLogger()).named("drug_gene_interactions");

    return defineTool({
        id: "drug_gene_interactions",
        description:
            "Drug↔gene interactions across DGIdb (the Drug Gene Interaction Database), DrugBank and PharmGKB, in one call — 'what drugs hit these " +
            "genes?' and 'what genes does this drug act on?'. See `direction` and `sources` for the modes.\n" +
            "ACCEPTED IDENTIFIERS: a HUGO gene symbol ('EGFR') for direction 'gene_to_drugs'; a drug name ('imatinib'), a DrugBank ID ('DB00619') or a " +
            "DGIdb concept ID for 'drug_to_genes'. A brand name and a non-HUGO symbol match nothing — resolve the symbol with search_gene and the brand " +
            "name with search_faers({action:'label'}) first.\n" +
            "It answers whether an interaction is KNOWN, by whom, and of what type. For quotable POTENCY (IC50/Ki) use chembl({action:'bioactivity'}) instead.\n" +
            "Verbose fields (`includeAttributes`, `includeDrugRecord`) are off by default — both cost a lot of context and are rarely what the question needs.\n" +
            "ALWAYS read `perSource` before concluding an interaction is unknown: 'no_data' means that corpus has nothing; 'unavailable' means it could " +
            "not be reached (a missing DRUGBANK_API_KEY lands here — tell the user and proceed with DGIdb). A `found: false` entry means the identifier " +
            "is not in DGIdb at all, usually a non-HUGO symbol or a brand name. Neither is worth retrying unchanged.",
        inputSchema,
        describeCall: "none",
        execute: async (input) => {
            const inputs = typeof input.query === "string" ? [input.query] : input.query;
            const selected = input.sources ?? (["dgidb"] as Source[]);
            const limit = input.limit ?? DEFAULT_LIMIT;
            const isGeneSide = input.direction === "gene_to_drugs";

            const output: DrugGeneOutput = { direction: input.direction, perSource: [] };

            const [dgidb, drugbank, pharmgkb] = await Promise.all([
                selected.includes("dgidb")
                    ? runSource<DgidbResult>("dgidb", () =>
                          searchDgidb(
                              inputs,
                              isGeneSide ? "gene" : "drug",
                              {
                                  limit,
                                  ...(input.interactionTypes ? { interactionTypes: input.interactionTypes } : {}),
                                  ...(input.sourceDbs ? { sourceDbs: input.sourceDbs } : {}),
                                  ...(input.minSources !== undefined ? { minSources: input.minSources } : {}),
                                  ...(input.includeAttributes !== undefined ? { includeAttributes: input.includeAttributes } : {}),
                              },
                              (errors) => logger.warn("dgidb partial errors alongside data", { errors }),
                          ),
                      )
                    : null,
                selected.includes("drugbank")
                    ? runSource<ProjectedDrug>("drugbank", async () => {
                          if (!deps.drugbankApiKey) throw new Error("DRUGBANK_API_KEY is not configured");
                          const drugs = await searchDrugbank(deps.drugbankApiKey, inputs[0]!, isGeneSide ? "target" : "drug", limit);
                          return drugs.map((d) => projectDrug(d, input.includeDrugRecord ?? false));
                      })
                    : null,
                selected.includes("pharmgkb")
                    ? runSource<PharmgkbAnnotation>("pharmgkb", async () => {
                          const res = await searchPharmgkb(inputs[0]!, isGeneSide ? "gene" : "drug", limit);
                          return res.annotations;
                      })
                    : null,
            ]);

            // DrugBank and PharmGKB take one identifier per call; say so on the
            // outcome rather than letting the extra inputs vanish silently.
            const skipped = inputs.length > 1 ? `read only '${inputs[0]}' — this source takes one identifier per call` : "";
            const noteSkipped = (outcome: SourceOutcome): SourceOutcome => {
                const detail = [outcome.detail, skipped].filter(Boolean).join("; ");
                return detail ? { ...outcome, detail } : outcome;
            };

            if (dgidb) {
                output.perSource.push(dgidb.outcome);
                output.dgidb = dgidb.records;
            }
            if (drugbank) {
                output.perSource.push(noteSkipped(drugbank.outcome));
                output.drugbank = drugbank.records;
            }
            if (pharmgkb) {
                output.perSource.push(noteSkipped(pharmgkb.outcome));
                output.pharmgkb = pharmgkb.records;
            }

            return ok(output);
        },
    });
}
