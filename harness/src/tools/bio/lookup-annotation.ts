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
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type ToolError } from "../define-tool.js";
import { apiFetchValidated, describeApiError } from "../lib/api-utils.js";
import { searchPathways, type Pathway } from "../lib/pathway-client.js";

const QUICKGO_BASE = "https://www.ebi.ac.uk/QuickGO/services";
const HEADERS = { Accept: "application/json" };

const DEFAULT_LIMIT = 10;

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
const GoTermResponseSchema = z
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

const GoAnnotationResponseSchema = z
    .object({
        results: z
            .array(
                z.object({
                    geneProductId: z.string().optional(),
                    goId: z.string().optional(),
                    goName: z.string().optional(),
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
                    "'kegg' / 'reactome' — one pathway database; needs query. 'pathways' — both, in parallel; needs query. " +
                    "Returns pathways[] { id, name, source, url, genes? }.",
            ),
        query: z
            .string()
            .min(1)
            .optional()
            .describe(
                "Free-text term. Required for the pathway vocabularies ('apoptosis', 'MAPK signaling'); for 'go' it is one of the three accepted inputs.",
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
    .refine((d) => d.vocabulary === "go" || (d.query !== undefined && d.query.trim().length > 0), {
        message: "query is required for vocabulary 'kegg', 'reactome' and 'pathways' — the pathway term to search for",
        path: ["query"],
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
        "Functional annotation for a gene, protein or term — Gene Ontology (QuickGO) and the pathway databases (KEGG, Reactome) behind one `vocabulary`. " +
        "Names what a gene is known to do, resolves a GO or pathway identifier, or finds the pathways a term belongs to.\n" +
        "This is annotation LOOKUP, not enrichment: to test whether a gene SET is over-represented in GO/KEGG/Reactome terms use " +
        "search_interactions({action:'enrichment'}), which does the statistics.\n" +
        "An empty terms / annotations / pathways array is valid no-data — do not retry the same input.",
    inputSchema,
    execute: async ({ vocabulary, query, goId, geneProductId, taxonId, organism, includeGenes, limit }): Promise<Result<AnnotationOutput, ToolError>> => {
        const cap = limit ?? DEFAULT_LIMIT;

        if (vocabulary !== "go") {
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
                    const params = new URLSearchParams({ geneProductId, limit: String(cap) });
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
