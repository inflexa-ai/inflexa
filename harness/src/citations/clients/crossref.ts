import { z } from "zod";

import type { CitationRecord, CitationSourceClient, CitationSourceOutcome, CitationSourceRequest } from "../types.js";
import { encodeDoiPath, firstNonEmpty, parseYear, sourceOutcome } from "./common.js";
import { firstSegmentOf } from "../../lib/text.js";
import { requestJson, type SourceHttpOptions, type SourceHttpResult } from "../../literature/sources/http.js";

const CrossrefItemSchema = z.looseObject({
    DOI: z.string().optional(),
    URL: z.string().optional(),
    title: z.array(z.string()).optional(),
    author: z.array(z.looseObject({ given: z.string().optional(), family: z.string().optional(), name: z.string().optional() })).optional(),
    issued: z.object({ "date-parts": z.array(z.array(z.number())).optional() }).optional(),
    published: z.object({ "date-parts": z.array(z.array(z.number())).optional() }).optional(),
    "container-title": z.array(z.string()).optional(),
    volume: z.string().optional(),
    page: z.string().optional(),
});
const ExactSchema = z.object({ message: CrossrefItemSchema });
const SearchSchema = z.object({ message: z.looseObject({ items: z.array(CrossrefItemSchema) }) });

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
        .filter((author) => author !== undefined);
    const dateParts = item.issued?.["date-parts"]?.[0] ?? item.published?.["date-parts"]?.[0];
    return {
        source: "crossref",
        sourceRecordId,
        identifiers: { doi },
        title,
        authors: authors !== undefined && authors.length > 0 ? authors : undefined,
        year: dateParts?.[0] === undefined ? undefined : parseYear(dateParts[0]),
        venue,
        volume: item.volume,
        firstPage: firstSegmentOf(item.page, "-–"),
        url: item.URL,
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
            const exact = request.plan.operation === "crossref_doi_if_owned";
            let url: string;
            if (exact) {
                if (doi === undefined) return sourceOutcome("crossref", request.plan.operation, "unavailable", 0, [], "the exact plan carries no DOI");
                const target = new URL(`https://api.crossref.org/works/${encodeDoiPath(doi)}`);
                if (options.mailto) target.searchParams.set("mailto", options.mailto);
                url = target.toString();
            } else {
                const params = new URLSearchParams({
                    "query.bibliographic": request.input.citation,
                    rows: String(options.maxCandidates ?? 5),
                });
                if (options.mailto) params.set("mailto", options.mailto);
                url = `https://api.crossref.org/works?${params}`;
            }
            const fetched = exact
                ? await requestJson(url, ExactSchema, options, signal, { headers }).then((result): SourceHttpResult<[z.infer<typeof CrossrefItemSchema>]> =>
                      result.status === "ok" ? { status: "ok", value: [result.value.message] } : result,
                  )
                : await requestJson(url, SearchSchema, options, signal, { headers }).then((result): SourceHttpResult<z.infer<typeof CrossrefItemSchema>[]> =>
                      result.status === "ok" ? { status: "ok", value: result.value.message.items } : result,
                  );
            if (fetched.status !== "ok") return sourceOutcome("crossref", request.plan.operation, fetched.status, 1, [], fetched.detail);
            const records = fetched.value.flatMap((item, index) => {
                const record = crossrefRecord(item, index);
                return record === undefined ? [] : [record];
            });
            return sourceOutcome("crossref", request.plan.operation, records.length === 0 ? "no_data" : "ok", 1, records);
        },
    };
}
