import { z } from "zod";

import type { CitationRecord, CitationSourceClient, CitationSourceOutcome, CitationSourceRequest } from "../types.js";
import { firstNonEmpty, parseYear, sourceOutcome } from "./common.js";
import { requestJson, type SourceHttpOptions } from "../../literature/sources/http.js";

const HandleResponseSchema = z.object({ responseCode: z.number() }).passthrough();
const RegistrationAgencySchema = z.array(z.object({ DOI: z.string().optional(), RA: z.string().optional() }).passthrough());
const CslMetadataSchema = z
    .object({
        DOI: z.string().optional(),
        id: z.string().optional(),
        title: z.union([z.string(), z.array(z.string())]).optional(),
        author: z.array(z.object({ given: z.string().optional(), family: z.string().optional(), literal: z.string().optional() }).passthrough()).optional(),
        issued: z.object({ "date-parts": z.array(z.array(z.number())).optional() }).optional(),
        published: z.object({ "date-parts": z.array(z.array(z.number())).optional() }).optional(),
        "container-title": z.union([z.string(), z.array(z.string())]).optional(),
        volume: z.string().optional(),
        page: z.string().optional(),
        URL: z.string().optional(),
    })
    .passthrough();

function scalar(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? firstNonEmpty(value) : firstNonEmpty([value]);
}

function cslRecord(doi: string, registrationAgency: string | undefined, metadata: z.infer<typeof CslMetadataSchema> | undefined): CitationRecord {
    const authors = metadata?.author
        ?.map((author) => firstNonEmpty([author.literal, [author.given, author.family].filter(Boolean).join(" ")]))
        .filter((author): author is string => author !== undefined);
    const dateParts = metadata?.issued?.["date-parts"]?.[0] ?? metadata?.published?.["date-parts"]?.[0];
    const title = scalar(metadata?.title);
    const venue = scalar(metadata?.["container-title"]);
    return {
        source: "doi_registry",
        sourceRecordId: doi,
        identifiers: { doi },
        ...(title === undefined ? {} : { title }),
        ...(authors === undefined || authors.length === 0 ? {} : { authors }),
        ...(dateParts?.[0] === undefined ? {} : { year: parseYear(dateParts[0])! }),
        ...(venue === undefined ? {} : { venue }),
        ...(metadata?.volume === undefined ? {} : { volume: metadata.volume }),
        ...(metadata?.page === undefined ? {} : { firstPage: metadata.page.split(/[-–]/)[0] }),
        ...(registrationAgency === undefined ? {} : { registrationAgency }),
        ...(metadata?.URL === undefined ? {} : { url: metadata.URL }),
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
            const handle = await requestJson(`https://doi.org/api/handles/${encodeURIComponent(doi)}`, HandleResponseSchema, options, signal);
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
            const agencyResult = await requestJson(`https://doi.org/doiRA/${encodeURIComponent(doi)}`, RegistrationAgencySchema, options, signal);
            const registrationAgency = agencyResult.status === "ok" ? agencyResult.value[0]?.RA : undefined;

            requestCount += 1;
            const metadataResult = await requestJson(`https://doi.org/${doi}`, CslMetadataSchema, options, signal, {
                headers: { Accept: "application/vnd.citationstyles.csl+json" },
            });
            const metadata = metadataResult.status === "ok" ? metadataResult.value : undefined;
            const incomplete = agencyResult.status === "unavailable" || metadataResult.status === "unavailable";
            const detail = [
                agencyResult.status === "unavailable" ? agencyResult.detail : undefined,
                metadataResult.status === "unavailable" ? metadataResult.detail : undefined,
            ]
                .filter((value): value is string => value !== undefined)
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
                    ...(registrationAgency === undefined ? {} : { registrationAgency }),
                    metadataAvailable: metadata !== undefined,
                },
            };
        },
    };
}
