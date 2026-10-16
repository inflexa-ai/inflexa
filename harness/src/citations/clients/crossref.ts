import { z } from "zod";

import type { CitationRecord, CitationSourceClient, CitationSourceOutcome, CitationSourceRequest } from "../types.js";
import { encodeDoiPath, firstNonEmpty, parseYear, sourceOutcome } from "./common.js";
import { requestJson, type SourceHttpOptions, type SourceHttpResult } from "../../literature/sources/http.js";

const CrossrefItemSchema = z
    .object({
        DOI: z.string().optional(),
        URL: z.string().optional(),
        title: z.array(z.string()).optional(),
        author: z.array(z.object({ given: z.string().optional(), family: z.string().optional(), name: z.string().optional() }).loose()).optional(),
        issued: z.object({ "date-parts": z.array(z.array(z.number())).optional() }).optional(),
        published: z.object({ "date-parts": z.array(z.array(z.number())).optional() }).optional(),
        "container-title": z.array(z.string()).optional(),
        volume: z.string().optional(),
        page: z.string().optional(),
    })
    .loose();
type CrossrefItem = z.infer<typeof CrossrefItemSchema>;

const ExactSchema = z.object({ message: CrossrefItemSchema });
const SearchSchema = z.object({ message: z.object({ items: z.array(CrossrefItemSchema) }).loose() });

/**
 * Read the items of one Crossref response. The caller pairs the schema with the reader of the
 * parsed value, so the one generic instantiation keeps the pair correlated: the `exact` lookup
 * answers one item, the bibliographic search answers the items array.
 */
async function crossrefItems<S extends z.ZodType>(
    url: string,
    schema: S,
    options: SourceHttpOptions,
    signal: AbortSignal | undefined,
    headers: Record<string, string>,
    itemsOf: (value: z.infer<S>) => CrossrefItem[],
): Promise<SourceHttpResult<CrossrefItem[]>> {
    const result = await requestJson(url, schema, options, signal, { headers });
    if (result.status !== "ok") return result;
    return { status: "ok", value: itemsOf(result.value) };
}

export type CrossrefClientOptions = SourceHttpOptions & {
    readonly mailto?: string;
    readonly userAgent?: string;
    readonly maxCandidates?: number;
};

function crossrefRecord(item: z.infer<typeof CrossrefItemSchema>, index: number): CitationRecord | undefined {
    const doi = item.DOI?.toLocaleLowerCase("en-US");
    const sourceRecordId = firstNonEmpty([doi, item.URL, `candidate-${index}`]);
    if (sourceRecordId === undefined) return undefined;
    const title = firstNonEmpty(item.title ?? []);
    const venue = firstNonEmpty(item["container-title"] ?? []);
    const authors = item.author
        ?.map((author) => firstNonEmpty([author.name, [author.given, author.family].filter(Boolean).join(" ")]))
        .filter((author: string | undefined): author is string => author !== undefined);
    const dateParts = item.issued?.["date-parts"]?.[0] ?? item.published?.["date-parts"]?.[0];
    return {
        source: "crossref",
        sourceRecordId,
        identifiers: { doi: !(doi === undefined) ? doi : undefined },
        title: !(title === undefined) ? title : undefined,
        authors: !(authors === undefined || authors.length === 0) ? authors : undefined,
        year: !(dateParts?.[0] === undefined) ? parseYear(dateParts[0]) : undefined,
        venue: !(venue === undefined) ? venue : undefined,
        volume: !(item.volume === undefined) ? item.volume : undefined,
        // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the grammar of this module's input: no builtin or parser knows it.
        firstPage: !(item.page === undefined) ? item.page.split(/[-–]/)[0] : undefined,
        url: !(item.URL === undefined) ? item.URL : undefined,
    };
}

export function createCrossrefClient(options: CrossrefClientOptions = {}): CitationSourceClient {
    const headers: Record<string, string> = {};
    if (options.userAgent) headers["User-Agent"] = options.userAgent;
    return {
        source: "crossref",
        async resolve(request: CitationSourceRequest, signal?: AbortSignal): Promise<CitationSourceOutcome> {
            if (!request.plan.applicable) return sourceOutcome("crossref", request.plan.operation, "not_applicable", 0, [], request.plan.reason);
            const registration = request.registrationAgency;
            if (request.plan.operation === "crossref_doi_if_owned") {
                // Skipping because ownership lies elsewhere is a finding; skipping because
                // nobody could tell us is a gap, and reporting the gap as `not_applicable`
                // would let an unchecked DOI reach `not_found` on complete coverage.
                if (registration.status === "undetermined") {
                    return sourceOutcome("crossref", request.plan.operation, "unavailable", 0, [], `registration agency undetermined: ${registration.detail}`);
                }
                if (registration.status === "absent") {
                    return sourceOutcome("crossref", request.plan.operation, "not_applicable", 0, [], "the DOI handle does not resolve");
                }
                if (registration.agency.toLocaleLowerCase("en-US") !== "crossref") {
                    return sourceOutcome("crossref", request.plan.operation, "not_applicable", 0, [], "DOI is not registered by Crossref");
                }
            }

            const doi = request.normalized.identifiers.doi;
            const exact = request.plan.operation === "crossref_doi_if_owned" && doi !== undefined;
            if (request.plan.operation === "crossref_doi_if_owned" && !exact) {
                throw new Error("a crossref_doi_if_owned plan must carry a DOI");
            }
            const url = exact
                ? (() => {
                      const target = new URL(`https://api.crossref.org/works/${encodeDoiPath(doi)}`);
                      if (options.mailto) target.searchParams.set("mailto", options.mailto);
                      return target.toString();
                  })()
                : (() => {
                      const params = new URLSearchParams({
                          "query.bibliographic": request.input.citation,
                          rows: String(options.maxCandidates ?? 5),
                      });
                      if (options.mailto) params.set("mailto", options.mailto);
                      return `https://api.crossref.org/works?${params}`;
                  })();
            const fetched = exact
                ? await crossrefItems(url, ExactSchema, options, signal, headers, (value) => [value.message])
                : await crossrefItems(url, SearchSchema, options, signal, headers, (value) => value.message.items);
            if (fetched.status !== "ok") return sourceOutcome("crossref", request.plan.operation, fetched.status, 1, [], fetched.detail);
            const records = fetched.value.flatMap((item, index) => {
                const record = crossrefRecord(item, index);
                return record === undefined ? [] : [record];
            });
            return sourceOutcome("crossref", request.plan.operation, records.length === 0 ? "no_data" : "ok", 1, records);
        },
    };
}
