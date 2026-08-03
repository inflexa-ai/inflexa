import { z } from "zod";

import type { CitationRecord, CitationSourceClient, CitationSourceOutcome, CitationSourceRequest } from "../types.js";
import { encodeDoiPath, firstNonEmpty, parseYear, sourceOutcome } from "./common.js";
import { requestJson, type SourceHttpOptions } from "../../literature/sources/http.js";

const CrossrefItemSchema = z
    .object({
        DOI: z.string().optional(),
        URL: z.string().optional(),
        title: z.array(z.string()).optional(),
        author: z.array(z.object({ given: z.string().optional(), family: z.string().optional(), name: z.string().optional() }).passthrough()).optional(),
        issued: z.object({ "date-parts": z.array(z.array(z.number())).optional() }).optional(),
        published: z.object({ "date-parts": z.array(z.array(z.number())).optional() }).optional(),
        "container-title": z.array(z.string()).optional(),
        volume: z.string().optional(),
        page: z.string().optional(),
    })
    .passthrough();
const ExactSchema = z.object({ message: CrossrefItemSchema });
const SearchSchema = z.object({ message: z.object({ items: z.array(CrossrefItemSchema) }).passthrough() });

export interface CrossrefClientOptions extends SourceHttpOptions {
    readonly mailto?: string;
    readonly userAgent?: string;
    readonly maxCandidates?: number;
}

function crossrefRecord(item: z.infer<typeof CrossrefItemSchema>, index: number): CitationRecord | undefined {
    const doi = item.DOI?.toLocaleLowerCase("en-US");
    const sourceRecordId = firstNonEmpty([doi, item.URL, `candidate-${index}`]);
    if (sourceRecordId === undefined) return undefined;
    const title = firstNonEmpty(item.title ?? []);
    const venue = firstNonEmpty(item["container-title"] ?? []);
    const authors = item.author
        ?.map((author) => firstNonEmpty([author.name, [author.given, author.family].filter(Boolean).join(" ")]))
        .filter((author): author is string => author !== undefined);
    const dateParts = item.issued?.["date-parts"]?.[0] ?? item.published?.["date-parts"]?.[0];
    return {
        source: "crossref",
        sourceRecordId,
        identifiers: { ...(doi === undefined ? {} : { doi }) },
        ...(title === undefined ? {} : { title }),
        ...(authors === undefined || authors.length === 0 ? {} : { authors }),
        ...(dateParts?.[0] === undefined ? {} : { year: parseYear(dateParts[0])! }),
        ...(venue === undefined ? {} : { venue }),
        ...(item.volume === undefined ? {} : { volume: item.volume }),
        ...(item.page === undefined ? {} : { firstPage: item.page.split(/[-–]/)[0] }),
        ...(item.URL === undefined ? {} : { url: item.URL }),
    };
}

export function createCrossrefClient(options: CrossrefClientOptions = {}): CitationSourceClient {
    const headers: Record<string, string> = {};
    if (options.userAgent) headers["User-Agent"] = options.userAgent;
    return {
        source: "crossref",
        async resolve(request: CitationSourceRequest, signal?: AbortSignal): Promise<CitationSourceOutcome> {
            if (!request.plan.applicable) return sourceOutcome("crossref", request.plan.operation, "not_applicable", 0, [], request.plan.reason);
            if (request.plan.operation === "crossref_doi_if_owned" && request.registrationAgency?.toLocaleLowerCase("en-US") !== "crossref") {
                return sourceOutcome("crossref", request.plan.operation, "not_applicable", 0, [], "DOI is not registered by Crossref");
            }

            const doi = request.normalized.identifiers.doi;
            const exact = request.plan.operation === "crossref_doi_if_owned";
            const url = exact
                ? (() => {
                      const target = new URL(`https://api.crossref.org/works/${encodeDoiPath(doi!)}`);
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
            const result = exact
                ? await requestJson(url, ExactSchema, options, signal, { headers })
                : await requestJson(url, SearchSchema, options, signal, { headers });
            if (result.status !== "ok") return sourceOutcome("crossref", request.plan.operation, result.status, 1, [], result.detail);
            const items = exact ? [(result.value as z.infer<typeof ExactSchema>).message] : (result.value as z.infer<typeof SearchSchema>).message.items;
            const records = items.flatMap((item, index) => {
                const record = crossrefRecord(item, index);
                return record === undefined ? [] : [record];
            });
            return sourceOutcome("crossref", request.plan.operation, records.length === 0 ? "no_data" : "ok", 1, records);
        },
    };
}
