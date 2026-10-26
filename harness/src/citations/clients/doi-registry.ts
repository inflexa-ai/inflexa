import { z } from "zod";

import type { CitationRecord, CitationSourceClient, CitationSourceOutcome, CitationSourceRequest } from "../types.js";
import { encodeDoiPath, firstNonEmpty, parseYear, sourceOutcome } from "./common.js";
import { firstSegmentOf } from "../../lib/text.js";
import { requestJson, type SourceHttpOptions } from "../../literature/sources/http.js";

const HandleResponseSchema = z.looseObject({ responseCode: z.number() });
const RegistrationAgencySchema = z.array(z.looseObject({ DOI: z.string().optional(), RA: z.string().optional() }));
const CslMetadataSchema = z.looseObject({
    DOI: z.string().optional(),
    id: z.string().optional(),
    title: z.union([z.string(), z.array(z.string())]).optional(),
    author: z.array(z.looseObject({ given: z.string().optional(), family: z.string().optional(), literal: z.string().optional() })).optional(),
    issued: z.object({ "date-parts": z.array(z.array(z.number())).optional() }).optional(),
    published: z.object({ "date-parts": z.array(z.array(z.number())).optional() }).optional(),
    "container-title": z.union([z.string(), z.array(z.string())]).optional(),
    volume: z.string().optional(),
    page: z.string().optional(),
    URL: z.string().optional(),
});

function scalar(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? firstNonEmpty(value) : firstNonEmpty([value]);
}

function cslRecord(doi: string, registrationAgency: string | undefined, metadata: z.infer<typeof CslMetadataSchema> | undefined): CitationRecord {
    const authors = metadata?.author
        ?.map((author) => firstNonEmpty([author.literal, [author.given, author.family].filter(Boolean).join(" ")]))
        .filter((author) => author !== undefined);
    const dateParts = metadata?.issued?.["date-parts"]?.[0] ?? metadata?.published?.["date-parts"]?.[0];
    const title = scalar(metadata?.title);
    const venue = scalar(metadata?.["container-title"]);
    return {
        source: "doi_registry",
        sourceRecordId: doi,
        identifiers: { doi },
        title,
        authors: authors !== undefined && authors.length > 0 ? authors : undefined,
        year: dateParts?.[0] === undefined ? undefined : parseYear(dateParts[0]),
        venue,
        volume: metadata?.volume,
        firstPage: firstSegmentOf(metadata?.page, "-–"),
        registrationAgency,
        url: metadata?.URL,
    };
}

export function createDoiRegistryClient(options: SourceHttpOptions = {}): CitationSourceClient {
    return {
        source: "doi_registry",
        async resolve(request: CitationSourceRequest, signal?: AbortSignal): Promise<CitationSourceOutcome> {
            const doi = request.normalized.identifiers.doi;
            if (!request.plan.applicable || doi === undefined) {
                return sourceOutcome("doi_registry", request.plan.operation, "not_applicable", 0, [], request.plan.reason);
            }

            let requestCount = 1;
            const handle = await requestJson(`https://doi.org/api/handles/${encodeDoiPath(doi)}`, HandleResponseSchema, options, signal);
            if (handle.status !== "ok") {
                return handle.status === "no_data"
                    ? {
                          ...sourceOutcome("doi_registry", request.plan.operation, handle.status, requestCount, [], handle.detail),
                          identifierEvidence: { type: "doi", identifier: doi, exists: false, metadataAvailable: false },
                      }
                    : sourceOutcome("doi_registry", request.plan.operation, handle.status, requestCount, [], handle.detail);
            }
            if (handle.value.responseCode !== 1) {
                return {
                    ...sourceOutcome("doi_registry", request.plan.operation, "no_data", requestCount),
                    identifierEvidence: { type: "doi", identifier: doi, exists: false, metadataAvailable: false },
                };
            }

            requestCount += 1;
            const agencyResult = await requestJson(`https://doi.org/doiRA/${encodeDoiPath(doi)}`, RegistrationAgencySchema, options, signal);
            const registrationAgency = agencyResult.status === "ok" ? agencyResult.value[0]?.RA : undefined;

            requestCount += 1;
            const metadataResult = await requestJson(`https://doi.org/${encodeDoiPath(doi)}`, CslMetadataSchema, options, signal, {
                headers: { Accept: "application/vnd.citationstyles.csl+json" },
            });
            const metadata = metadataResult.status === "ok" ? metadataResult.value : undefined;
            const incomplete = agencyResult.status === "unavailable" || metadataResult.status === "unavailable";
            const detail = [
                agencyResult.status === "unavailable" ? agencyResult.detail : undefined,
                metadataResult.status === "unavailable" ? metadataResult.detail : undefined,
            ]
                .filter((value) => value !== undefined)
                .join("; ");
            return {
                ...sourceOutcome(
                    "doi_registry",
                    request.plan.operation,
                    incomplete ? "unavailable" : "ok",
                    requestCount,
                    [cslRecord(doi, registrationAgency, metadata)],
                    detail || undefined,
                ),
                identifierEvidence: {
                    type: "doi",
                    identifier: doi,
                    exists: true,
                    registrationAgency,
                    metadataAvailable: metadata !== undefined,
                },
            };
        },
    };
}
