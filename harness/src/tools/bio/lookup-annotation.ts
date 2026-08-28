/**
 * lookupAnnotation — one tool over the functional-annotation vocabularies:
 * Gene Ontology (QuickGO) and the pathway databases (KEGG, Reactome).
 *
 * These were two tools asking one question — "what is this gene or term known
 * to do?" — against different vocabularies. `search_pathway` already treated
 * the corpus as a parameter (`source: kegg | reactome | both`) rather than a
 * tool boundary; this extends the same shape to GO.
 *
 * The input is a flat object with a `vocabulary` discriminator — not a
 * `z.discriminatedUnion`, which `defineTool` rejects (model tool calling needs
 * a top-level `"type":"object"`). Per-vocabulary parameters are optional in the
 * schema and made conditionally required by `.refine`, so a malformed call
 * fails at the loop boundary naming the missing field instead of reaching an
 * API request that cannot be built.
 *
 * Absence policy: QuickGO gives each key and sends an explicit `null` for an
 * absent value. Thus a maybe-absent QuickGO field carries `.nullable()`, and
 * `pathway-client.ts` holds the policy of KEGG and Reactome.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type ToolError } from "../define-tool.js";
import { apiFetchValidated, describeApiError } from "../lib/api-utils.js";
import { getPathwayById, searchPathways, type Pathway } from "../lib/pathway-client.js";

const QUICKGO_BASE = "https://www.ebi.ac.uk/QuickGO/services";
const HEADERS = { Accept: "application/json" };

const DEFAULT_LIMIT = 10;

/**
 * The fields that the annotation search must name.
 *
 * QuickGO serves the label of a GO term only when the request asks for it. A
 * request that does not ask gets `"goName": null` on each row, thus every
 * annotation reads as an identifier with no name.
 */
const ANNOTATION_INCLUDE_FIELDS = "goName";

interface GoTerm {
    id: string;
    name: string;
    definition?: string;
    aspect?: string;
}

interface GoAnnotation {
    geneProductId: string;
    goId: string;
    goName: string;
    aspect?: string;
    evidenceCode?: string;
    qualifier?: string;
}

// QuickGO term response, validated at the fetch boundary. The `.transform`
// carries the (context-free) rename from the raw wire fields to the `GoTerm[]`
// we return, so parsing IS both the validation and the normalization — there
// is no separate raw interface or mapper to keep in sync.
export const GoTermResponseSchema = z
    .object({
        results: z
            .array(
                z.object({
                    id: z.string().optional(),
                    name: z.string().optional(),
                    definition: z.object({ text: z.string().optional() }).nullable().optional(),
                    aspect: z.string().optional(),
                }),
            )
            .optional(),
    })
    .transform((res): GoTerm[] =>
        (res.results ?? []).map((t) => ({
            id: t.id ?? "",
            name: t.name ?? "",
            definition: t.definition?.text ?? undefined,
            aspect: t.aspect ?? undefined,
        })),
    );

// QuickGO answers a `goName` with an explicit `null` on each row unless the
// request names the field. `ANNOTATION_INCLUDE_FIELDS` names it, and `goName`
// stays nullable because the wire can still send the null.
export const GoAnnotationResponseSchema = z
    .object({
        results: z
            .array(
                z.object({
                    geneProductId: z.string().optional(),
                    goId: z.string().optional(),
                    goName: z.string().nullable().optional(),
                    goAspect: z.string().optional(),
                    goEvidence: z.string().optional(),
                    qualifier: z.string().optional(),
                }),
            )
            .optional(),
    })
    .transform((res): GoAnnotation[] =>
        (res.results ?? []).map((a) => ({
            geneProductId: a.geneProductId ?? "",
            goId: a.goId ?? "",
            goName: a.goName ?? "",
            aspect: a.goAspect ?? undefined,
            evidenceCode: a.goEvidence ?? undefined,
            qualifier: a.qualifier ?? undefined,
        })),
    );

const inputSchema = z
    .object({
        vocabulary: z
            .enum(["go", "kegg", "reactome", "pathways"])
            .describe(
                "'go' — Gene Ontology via QuickGO (EBI); needs ONE of goId, query, or geneProductId. Returns terms[] { id, name, definition, aspect } " +
                    "and/or annotations[] { geneProductId, goId, goName, aspect, evidenceCode, qualifier }. " +
                    "'kegg' / 'reactome' — one pathway database; needs query or pathwayId. 'pathways' — both, in parallel; needs query or pathwayId. " +
                    "Returns pathways[] { id, name, source, url, description?, genes? }.",
            ),
        query: z
            .string()
            .min(1)
            .optional()
            .describe(
                "Free-text term. Required for the pathway vocabularies ('apoptosis', 'MAPK signaling') unless pathwayId is given; for 'go' it is one of " +
                    "the three accepted inputs.",
            ),
        pathwayId: z
            .string()
            .min(1)
            .optional()
            .describe(
                "Pathway vocabularies only. ONE pathway identifier, read back exactly as a search returned it — a Reactome stable ID ('R-HSA-109581') " +
                    "or a KEGG pathway ID ('hsa04010'). The prefix picks the database, so `vocabulary` and `organism` are ignored for it.",
            ),
        goId: z
            .string()
            .regex(/^GO:\d{7}$/)
            .optional()
            .describe("'go' only. A specific GO term ID, e.g. 'GO:0008150'."),
        geneProductId: z.string().min(1).optional().describe("'go' only. A UniProt accession, e.g. 'P04637', for that protein's GO annotations."),
        taxonId: z.number().int().optional().describe("'go' only, with geneProductId. NCBI Taxon ID filter (9606 = human, 10090 = mouse)."),
        organism: z.string().optional().describe("Pathway vocabularies only. KEGG organism code — 'hsa' (human, default), 'mmu' (mouse); mapped for Reactome."),
        includeGenes: z
            .boolean()
            .optional()
            .describe(
                "Pathway vocabularies only. Default FALSE — member-gene lists cost one request per pathway and run to hundreds of symbols. True only when " +
                    "you need the members, not the pathway identities.",
            ),
        limit: z
            .number()
            .int()
            .min(1)
            .max(100)
            .optional()
            .describe(`Max records per vocabulary queried (default ${DEFAULT_LIMIT}, max 100); with 'pathways' it applies to KEGG and Reactome separately.`),
    })
    .refine((d) => d.vocabulary === "go" || (d.query !== undefined && d.query.trim().length > 0) || (d.pathwayId !== undefined && d.pathwayId.length > 0), {
        message: "vocabulary 'kegg', 'reactome' and 'pathways' need query (the pathway term to search for) or pathwayId (one 'R-HSA-…' or 'hsa…' identifier)",
        path: ["query"],
    })
    .refine((d) => d.vocabulary !== "go" || d.pathwayId === undefined, {
        message: "pathwayId belongs to the pathway vocabularies — vocabulary 'go' takes goId instead",
        path: ["pathwayId"],
    })
    .refine((d) => d.vocabulary !== "go" || d.goId !== undefined || d.query !== undefined || d.geneProductId !== undefined, {
        message: "vocabulary 'go' needs at least one of goId (term by ID), query (free-text term search), or geneProductId (a protein's annotations)",
        path: ["goId"],
    })
    .refine((d) => d.vocabulary === "go" || (d.goId === undefined && d.geneProductId === undefined && d.taxonId === undefined), {
        message: "goId, geneProductId and taxonId belong to vocabulary 'go' — the pathway vocabularies take query + organism",
        path: ["vocabulary"],
    })
    .refine((d) => d.vocabulary !== "go" || (d.organism === undefined && d.includeGenes === undefined), {
        message: "organism and includeGenes belong to the pathway vocabularies — vocabulary 'go' filters annotations with taxonId instead",
        path: ["vocabulary"],
    });

type AnnotationOutput = { terms?: GoTerm[]; annotations?: GoAnnotation[] } | { pathways: Pathway[] };

export const lookupAnnotationTool = defineTool({
    id: "lookup_annotation",
    description:
        "Functional annotation for a gene, protein or term — the Gene Ontology (through EBI QuickGO) and the pathway databases KEGG and Reactome, behind " +
        "one `vocabulary`. Names what a gene is known to do, resolves a GO or pathway identifier, or finds the pathways a term belongs to.\n" +
        "ACCEPTED IDENTIFIERS: a GO term ID ('GO:0008150'), a UniProt accession for a protein's annotations ('P04637'), an NCBI Taxon ID ('9606'), a " +
        "Reactome stable ID ('R-HSA-109581'), a KEGG pathway ID ('hsa04010'), and free text for any of the vocabularies ('apoptosis').\n" +
        "This is annotation LOOKUP, not enrichment: to test whether a gene SET is over-represented in GO/KEGG/Reactome terms use " +
        "search_interactions({action:'enrichment'}), which does the statistics.\n" +
        "An empty terms / annotations / pathways array is valid no-data — report it and continue, do not retry the same input. An empty pathways array " +
        "for a pathwayId means neither database holds that identifier.",
    inputSchema,
    describeCall: "none",
    execute: async ({
        vocabulary,
        query,
        pathwayId,
        goId,
        geneProductId,
        taxonId,
        organism,
        includeGenes,
        limit,
    }): Promise<Result<AnnotationOutput, ToolError>> => {
        const cap = limit ?? DEFAULT_LIMIT;

        if (vocabulary !== "go") {
            if (pathwayId) {
                const pathway = await getPathwayById(pathwayId);
                return ok({ pathways: pathway ? [pathway] : [] });
            }
            const pathways = await searchPathways(query!, {
                source: vocabulary === "pathways" ? "both" : vocabulary,
                organism: organism ?? "hsa",
                includeGenes: includeGenes ?? false,
                maxResults: cap,
            });
            return ok({ pathways });
        }

        const tasks: Promise<void>[] = [];
        let terms: GoTerm[] | undefined;
        let annotations: GoAnnotation[] | undefined;

        if (goId) {
            tasks.push(
                (async () => {
                    const res = await apiFetchValidated(`${QUICKGO_BASE}/ontology/go/terms/${encodeURIComponent(goId)}`, GoTermResponseSchema, {
                        headers: HEADERS,
                    });
                    if (res.isErr()) throw new Error(`GO lookup: ${describeApiError(res.error)}`);
                    terms = res.value;
                })(),
            );
        }

        if (query) {
            tasks.push(
                (async () => {
                    const params = new URLSearchParams({ query, limit: String(cap) });
                    const res = await apiFetchValidated(`${QUICKGO_BASE}/ontology/go/search?${params}`, GoTermResponseSchema, { headers: HEADERS });
                    if (res.isErr()) throw new Error(`GO search: ${describeApiError(res.error)}`);
                    const searchTerms = res.value;
                    terms = terms ? [...terms, ...searchTerms] : searchTerms;
                })(),
            );
        }

        if (geneProductId) {
            tasks.push(
                (async () => {
                    const params = new URLSearchParams({ geneProductId, limit: String(cap), includeFields: ANNOTATION_INCLUDE_FIELDS });
                    if (taxonId) params.set("taxonId", String(taxonId));

                    const res = await apiFetchValidated(`${QUICKGO_BASE}/annotation/search?${params}`, GoAnnotationResponseSchema, { headers: HEADERS });
                    if (res.isErr()) throw new Error(`Annotations: ${describeApiError(res.error)}`);
                    annotations = res.value;
                })(),
            );
        }

        await Promise.all(tasks);
        return ok({ terms, annotations });
    },
});
