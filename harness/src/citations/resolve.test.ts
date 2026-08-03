import { describe, expect, it } from "bun:test";

import { createCitationResolver } from "./resolve.js";
import type { CitationRecord, CitationSource, CitationSourceClient, CitationSourceOutcome, CitationSourceRequest } from "./types.js";

const SOURCES: readonly CitationSource[] = ["doi_registry", "crossref", "pubmed", "arxiv", "semantic_scholar"];

function noData(source: CitationSource, request: CitationSourceRequest): CitationSourceOutcome {
    return { source, operation: request.plan.operation, status: "no_data", requestCount: 1, records: [] };
}

function doiRecord(doi: string): CitationRecord {
    return { source: "doi_registry", sourceRecordId: doi, identifiers: { doi }, title: "Example study", year: 2021 };
}

function clientSet(
    handler: (source: CitationSource, request: CitationSourceRequest, signal?: AbortSignal) => Promise<CitationSourceOutcome>,
    counts: Partial<Record<CitationSource, number>> = {},
): CitationSourceClient[] {
    return SOURCES.map((source) => ({
        source,
        resolve: async (request, signal) => {
            counts[source] = (counts[source] ?? 0) + 1;
            return await handler(source, request, signal);
        },
    }));
}

async function matchingHandler(source: CitationSource, request: CitationSourceRequest): Promise<CitationSourceOutcome> {
    if (source === "doi_registry") {
        const doi = request.normalized.identifiers.doi!;
        return {
            source,
            operation: request.plan.operation,
            status: "ok",
            requestCount: 1,
            records: [doiRecord(doi)],
            identifierEvidence: { type: "doi", identifier: doi, exists: true, registrationAgency: "Crossref", metadataAvailable: true },
        };
    }
    return noData(source, request);
}

describe("CitationResolver batch orchestration", () => {
    it("deduplicates normalized identifiers and reconstructs original input order", async () => {
        const counts: Partial<Record<CitationSource, number>> = {};
        const resolver = createCitationResolver({}, { clients: clientSet(matchingHandler, counts) });
        const results = await resolver.resolveMany([
            { citation: "DOI: 10.1000/EXAMPLE" },
            { citation: "PMID: 12345678" },
            { citation: "https://doi.org/10.1000/example" },
        ]);

        expect(results.map((result) => result.input.citation)).toEqual(["DOI: 10.1000/EXAMPLE", "PMID: 12345678", "https://doi.org/10.1000/example"]);
        expect(results[0]?.verdict).toBe("verified");
        expect(results[2]?.verdict).toBe("verified");
        expect(counts.doi_registry).toBe(1);
        expect(counts.pubmed).toBe(2);
    });

    it("preserves every caller's supplied values when normalized duplicates share work", async () => {
        const counts: Partial<Record<CitationSource, number>> = {};
        const resolver = createCitationResolver({}, { clients: clientSet(matchingHandler, counts) });

        const results = await resolver.resolveMany([
            { citation: "10.1000/example", title: "Example Study" },
            { citation: "10.1000/example", title: "EXAMPLE STUDY" },
        ]);

        expect(results.map((result) => result.input.title)).toEqual(["Example Study", "EXAMPLE STUDY"]);
        expect(counts.doi_registry).toBe(1);
    });

    it("uses a source batch method and preserves per-input mapping", async () => {
        let batchCalls = 0;
        const pubmed: CitationSourceClient = {
            source: "pubmed",
            resolve: async (request) => noData("pubmed", request),
            resolveMany: async (requests) => {
                batchCalls += 1;
                return requests.map((request) => {
                    const pmid = request.normalized.identifiers.pmid!;
                    return {
                        source: "pubmed",
                        operation: request.plan.operation,
                        status: "ok",
                        requestCount: 1,
                        records: [{ source: "pubmed", sourceRecordId: pmid, identifiers: { pmid }, title: `Paper ${pmid}` }],
                    };
                });
            },
        };
        const others = clientSet(async (source, request) => noData(source, request)).filter((client) => client.source !== "pubmed");
        const resolver = createCitationResolver({}, { clients: [...others, pubmed] });
        const results = await resolver.resolveMany([{ citation: "PMID: 111" }, { citation: "PMID: 222" }]);

        expect(batchCalls).toBe(1);
        expect(results.map((result) => result.candidates[0]?.records[0]?.sourceRecordId)).toEqual(["111", "222"]);
    });

    it("coalesces concurrent identical calls", async () => {
        const counts: Partial<Record<CitationSource, number>> = {};
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const clients = clientSet(async (source, request) => {
            if (source === "doi_registry") await gate;
            return matchingHandler(source, request);
        }, counts);
        const resolver = createCitationResolver({}, { clients });
        const first = resolver.resolveOne({ citation: "10.1000/example" });
        const second = resolver.resolveOne({ citation: "DOI:10.1000/EXAMPLE" });
        await Promise.resolve();
        release();
        await Promise.all([first, second]);
        expect(counts.doi_registry).toBe(1);
        expect(counts.crossref).toBe(1);
    });

    it("enforces the configured batch maximum", async () => {
        const resolver = createCitationResolver({ maxBatchSize: 1 }, { clients: clientSet(matchingHandler) });
        await expect(resolver.resolveMany([{ citation: "PMID: 1" }, { citation: "PMID: 2" }])).rejects.toThrow("exceeds configured maximum");
    });

    it("propagates cancellation through a pending source", async () => {
        const clients = clientSet(async (source, request, signal) => {
            if (source !== "doi_registry") return noData(source, request);
            await new Promise<void>((_resolve, reject) => {
                signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
            return noData(source, request);
        });
        const resolver = createCitationResolver({}, { clients });
        const controller = new AbortController();
        const pending = resolver.resolveOne({ citation: "10.1000/example" }, { signal: controller.signal });
        controller.abort(new DOMException("cancel resolution", "AbortError"));
        await expect(pending).rejects.toThrow("cancel resolution");
    });
});

describe("CitationResolver cache policy", () => {
    it("caches positive outcomes within the positive TTL", async () => {
        const counts: Partial<Record<CitationSource, number>> = {};
        const resolver = createCitationResolver({ cache: { positiveTtlMs: 100 } }, { clients: clientSet(matchingHandler, counts), now: () => 0 });
        await resolver.resolveOne({ citation: "10.1000/example" });
        await resolver.resolveOne({ citation: "DOI:10.1000/EXAMPLE" });
        expect(counts.doi_registry).toBe(1);
    });

    it("expires negative entries on their shorter TTL", async () => {
        let now = 0;
        const counts: Partial<Record<CitationSource, number>> = {};
        const clients = clientSet(async (source, request) => noData(source, request), counts);
        const resolver = createCitationResolver({ cache: { negativeTtlMs: 10 } }, { clients, now: () => now });
        const input = { citation: "No such bibliographic work" };
        await resolver.resolveOne(input);
        await resolver.resolveOne(input);
        expect(counts.crossref).toBe(1);
        now = 11;
        await resolver.resolveOne(input);
        expect(counts.crossref).toBe(2);
    });

    it("does not cache a result containing unavailable coverage", async () => {
        const counts: Partial<Record<CitationSource, number>> = {};
        const clients = clientSet(
            async (source, request) =>
                source === "crossref"
                    ? { source, operation: request.plan.operation, status: "unavailable", requestCount: 1, records: [], detail: "HTTP 503" }
                    : noData(source, request),
            counts,
        );
        const resolver = createCitationResolver({}, { clients });
        const input = { citation: "An unresolved work" };
        await resolver.resolveOne(input);
        await resolver.resolveOne(input);
        expect(counts.crossref).toBe(2);
    });

    it("never derives not_found from an unavailable DOI handle lookup", async () => {
        const resolver = createCitationResolver(
            {},
            {
                clients: clientSet(async (source, request) =>
                    source === "doi_registry"
                        ? { source, operation: request.plan.operation, status: "unavailable", requestCount: 1, records: [], detail: "HTTP 503" }
                        : noData(source, request),
                ),
            },
        );

        const result = await resolver.resolveOne({ citation: "10.1000/example" });

        expect(result).toMatchObject({ verdict: "inconclusive", coverage: "partial" });
    });
});

describe("CitationResolver canonical outcome fixtures", () => {
    it("returns not_found only after every applicable source completes with no data", async () => {
        const resolver = createCitationResolver({}, { clients: clientSet(async (source, request) => noData(source, request)) });

        const result = await resolver.resolveOne({ citation: "A canonical work that does not exist anywhere" });

        expect(result).toMatchObject({ verdict: "not_found", coverage: "complete" });
        expect(result.candidates).toEqual([]);
    });

    it("reports supplied metadata mismatches without discarding the identified record", async () => {
        const resolver = createCitationResolver(
            {},
            {
                clients: clientSet(async (source, request) => {
                    if (source !== "doi_registry") return noData(source, request);
                    const doi = request.normalized.identifiers.doi!;
                    return {
                        source,
                        operation: request.plan.operation,
                        status: "ok",
                        requestCount: 1,
                        records: [{ ...doiRecord(doi), title: "Canonical title", year: 2021 }],
                        identifierEvidence: { type: "doi", identifier: doi, exists: true, registrationAgency: "Crossref", metadataAvailable: true },
                    };
                }),
            },
        );

        const result = await resolver.resolveOne({ citation: "10.1000/example", title: "Incorrect supplied title", year: 1999 });

        expect(result.verdict).toBe("metadata_mismatch");
        expect(result.comparisons.map(({ field, status }) => [field, status])).toEqual([
            ["title", "mismatch"],
            ["year", "mismatch"],
        ]);
        expect(result.candidates[0]?.records[0]?.title).toBe("Canonical title");
    });

    it("retains matching evidence and partial coverage when another source is unavailable", async () => {
        const resolver = createCitationResolver(
            {},
            {
                clients: clientSet(async (source, request) => {
                    if (source === "crossref") {
                        return { source, operation: request.plan.operation, status: "unavailable", requestCount: 1, records: [], detail: "HTTP 503" };
                    }
                    if (source === "semantic_scholar") {
                        return {
                            source,
                            operation: request.plan.operation,
                            status: "ok",
                            requestCount: 1,
                            records: [
                                {
                                    source,
                                    sourceRecordId: "canonical-paper",
                                    identifiers: { corpusId: "canonical-paper" },
                                    title: "A canonical source-failure fixture",
                                    authors: ["Jane Smith"],
                                    year: 2024,
                                },
                            ],
                        };
                    }
                    return noData(source, request);
                }),
            },
        );

        const result = await resolver.resolveOne({
            citation: "Smith J. A canonical source-failure fixture. 2024.",
            title: "A canonical source-failure fixture",
            authors: ["Jane Smith"],
            year: 2024,
        });

        expect(result.sourceOutcomes.find((outcome) => outcome.source === "crossref")?.status).toBe("unavailable");
        expect(result.sourceOutcomes.find((outcome) => outcome.source === "semantic_scholar")?.records).toHaveLength(1);
        expect(result.coverage).toBe("partial");
        expect(result.verdict).not.toBe("not_found");
    });
});
