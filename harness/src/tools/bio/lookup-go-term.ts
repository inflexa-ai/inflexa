/**
 * lookupGoTerm — look up Gene Ontology terms via the QuickGO API (EBI).
 *
 * Supports direct ID lookup, keyword search, and gene annotation retrieval.
 * Multiple modes can be combined in a single call.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "../define-tool.js";
import { apiFetchValidated, describeApiError } from "../lib/api-utils.js";

const QUICKGO_BASE = "https://www.ebi.ac.uk/QuickGO/services";
const HEADERS = { Accept: "application/json" };

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

export const lookupGoTermTool = defineTool({
    id: "lookup_go_term",
    description:
        "Look up Gene Ontology terms from QuickGO (EBI). " +
        "Can look up a term by GO ID, search by keyword, or retrieve GO annotations " +
        "for a specific gene/protein. At least one of goId, query, or geneProductId must be provided.",
    inputSchema: z
        .object({
            goId: z
                .string()
                .regex(/^GO:\d{7}$/)
                .optional()
                .describe("Specific GO term ID (e.g. 'GO:0008150')"),
            query: z.string().optional().describe("Free-text search for GO terms (e.g. 'apoptotic process')"),
            limit: z.number().int().min(1).max(100).default(10).describe("Maximum number of results per query type"),
            geneProductId: z.string().optional().describe("UniProt ID to get annotations for (e.g. 'P04637')"),
            taxonId: z.number().int().optional().describe("NCBI Taxon ID to filter annotations (9606 = human, 10090 = mouse)"),
        })
        .refine((d) => d.goId || d.query || d.geneProductId, {
            message: "At least one of goId, query, or geneProductId is required",
        }),
    execute: async ({ goId, query, limit, geneProductId, taxonId }) => {
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
                    const params = new URLSearchParams({ query, limit: String(limit) });
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
                    const params = new URLSearchParams({
                        geneProductId,
                        limit: String(limit),
                    });
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
