/**
 * Pure async client functions for DisGeNET gene-disease associations (GDAs).
 *
 * Requires a DisGeNET API key; `getDisgenetHeaders` throws when it is absent.
 *
 * UNVERIFIED CONTRACT, 2026-08-28. Every data path of the v1 API demands a key,
 * and no key exists, thus no schema here parsed a live GDA answer. The contract
 * comes from two secondary sources: the public Swagger of the provider at
 * `https://api.disgenet.com/v2/api-docs`, which declares
 * `GeneDiseaseAssocSummaryDTO`, `Paging`, and the response envelope, and the
 * provider-authored R client `disgenet2r` 1.2.10, whose request code and column
 * renames encode the same shape. One live unauthenticated 200 on
 * `/public/version` proved the envelope itself.
 *
 * Absence policy: the v1 API omits the key of an absent value. Thus each field
 * carries `.optional()`, and `.nullable()` rides with it because the Swagger
 * marks no field as required.
 */

import { z } from "zod";

import { createNoopLogger } from "../../lib/console-logger.js";
import type { Logger } from "../../lib/logger.js";
import { apiFetchValidated, describeApiError } from "./api-utils.js";
import { DISGENET_BASE, getDisgenetHeaders } from "./disgenet-config.js";

// A single schema that both validates and normalizes one DisGeNET GDA record:
// the `.object(...)` half is the v1 wire shape, and the `.transform(...)` half
// maps it to the camelCase `Gda` we return. Parsing IS the validation
// (`apiFetchValidated` runs it over the JSON), and because the transform rides
// on the schema, `z.infer` below is the OUTPUT type — no separate raw interface
// and no separate mapper.
const GdaSchema = z
    .object({
        symbolOfGene: z.string().nullable().optional(),
        geneNcbiID: z.number().nullable().optional(),
        diseaseName: z.string().nullable().optional(),
        diseaseUMLSCUI: z.string().nullable().optional(),
        diseaseType: z.string().nullable().optional(),
        score: z.number().nullable().optional(),
        ei: z.number().nullable().optional(),
        yearInitial: z.number().nullable().optional(),
        yearFinal: z.number().nullable().optional(),
        numPMIDs: z.number().nullable().optional(),
    })
    .transform((gda) => ({
        geneSymbol: gda.symbolOfGene ?? "",
        geneId: gda.geneNcbiID ?? 0,
        diseaseName: gda.diseaseName ?? "",
        diseaseId: gda.diseaseUMLSCUI ?? "",
        diseaseType: gda.diseaseType ?? "",
        score: gda.score ?? 0,
        evidenceIndex: gda.ei ?? 0,
        yearInitial: gda.yearInitial ?? null,
        yearFinal: gda.yearFinal ?? null,
        nPmids: gda.numPMIDs ?? 0,
    }));

export type Gda = z.infer<typeof GdaSchema>;

/** The page record of the v1 envelope. Page numbers start at 0. */
export const DisgenetPagingSchema = z.object({
    currentPageNumber: z.number().nullable().optional(),
    pageSize: z.number().nullable().optional(),
    totalElements: z.number().nullable().optional(),
    totalElementsInPage: z.number().nullable().optional(),
});

/**
 * The v1 response envelope. `payload` holds the records, and `paging` holds the
 * count of the whole query. A gated or an empty answer carries a non-OK
 * `status` and an `error` record, and `payload` is then absent.
 */
export const GdaResponseSchema = z.object({
    status: z.string().nullable().optional(),
    payload: z.array(GdaSchema).nullable().optional(),
    paging: DisgenetPagingSchema.nullable().optional(),
    httpStatus: z.number().nullable().optional(),
    error: z
        .object({
            message: z.string().nullable().optional(),
            details: z.string().nullable().optional(),
            timestamp: z.string().nullable().optional(),
        })
        .nullable()
        .optional(),
});

export type DisgenetSearchType = "gene" | "disease";

/**
 * The source vocabulary of the v1 API. The v7 names `ANIMAL_MODELS` and
 * `BEFREE` are retired: the nearest v1 members are `MODELS` and
 * `TEXTMINING_HUMAN`.
 */
export const DISGENET_SOURCES = [
    "ALL",
    "BIOBANK",
    "CHEMBL",
    "CLINICALTRIALS",
    "CLINGEN",
    "CLINPGX",
    "CLINVAR",
    "CURATED",
    "FINNGEN",
    "GENCC",
    "GWASCAT",
    "HPO",
    "INFERRED",
    "MGD_HUMAN",
    "MGD_MOUSE",
    "MODELS",
    "ORPHANET",
    "PHEWASCAT",
    "PSYGENET",
    "RGD_HUMAN",
    "RGD_RAT",
    "TEXTMINING_HUMAN",
    "TEXTMINING_MODELS",
    "UKBIOBANK",
    "UNIPROT",
] as const;
export type DisgenetSource = (typeof DISGENET_SOURCES)[number];

export interface DisgenetSearchOptions {
    minScore?: number;
    source?: DisgenetSource;
    limit?: number;
}

/** The result of one GDA query: the records of the first page, and the count of the whole query. */
export interface DisgenetSearchResult {
    records: Gda[];
    totalFound: number;
}

/**
 * Gene-disease associations for a gene symbol or for a disease.
 *
 * The v1 route takes query parameters only, and it fixes the page at 100
 * records. Thus `limit` is applied over the first page here, and it is not sent
 * to the provider.
 *
 * A non-OK `status` with an `error` record is an expected gated outcome, not a
 * transport failure: a free academic key serves the curated sources only. Such
 * an answer gives an empty result. The envelope gives no marker that separates
 * the gated answer from a rejected query, thus the cause goes to the injected
 * `Logger` before the result degrades.
 */
export async function searchDisgenet(
    apiKey: string,
    query: string,
    searchType: DisgenetSearchType,
    options: DisgenetSearchOptions = {},
    logger?: Logger,
): Promise<DisgenetSearchResult> {
    const headers = getDisgenetHeaders(apiKey);
    const minScore = options.minScore ?? 0.1;
    const limit = options.limit ?? 25;
    const source = options.source ?? "ALL";

    const params = new URLSearchParams(searchType === "gene" ? { gene_symbol: query } : { disease: query });
    params.set("min_score", String(minScore));
    params.set("source", source);
    // Page numbers start at 0, thus page 0 is the first page.
    params.set("page_number", "0");

    const res = await apiFetchValidated(`${DISGENET_BASE}/gda/summary?${params}`, GdaResponseSchema, { headers });
    if (res.isErr()) throw new Error(describeApiError(res.error));

    const envelope = res.value;
    if (envelope.status !== "OK" || !envelope.payload) {
        const log = (logger ?? createNoopLogger()).named("disgenet-client").with({ query, searchType });
        log.error("gda query degraded to an empty result", {
            status: envelope.status ?? null,
            httpStatus: envelope.httpStatus ?? null,
            cause: envelope.error?.message ?? null,
        });
        return { records: [], totalFound: 0 };
    }

    return {
        records: envelope.payload.slice(0, limit),
        totalFound: envelope.paging?.totalElements ?? envelope.payload.length,
    };
}
