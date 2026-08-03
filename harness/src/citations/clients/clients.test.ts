import { describe, expect, it } from "bun:test";

import { normalizeCitation } from "../normalize.js";
import type { CitationInput, CitationSourceClient, CitationSourceOperation, CitationSourceRequest, RegistrationAgencyEvidence } from "../types.js";
import { createArxivCitationClient } from "./arxiv.js";
import { createCrossrefClient } from "./crossref.js";
import { createDoiRegistryClient } from "./doi-registry.js";
import { createPubmedCitationClient } from "./pubmed.js";
import { createSemanticScholarCitationClient } from "./semantic-scholar.js";

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function text(body: string, status = 200): Response {
    return new Response(body, { status, headers: { "content-type": "application/xml" } });
}

function request(
    input: CitationInput,
    source: CitationSourceRequest["plan"]["source"],
    operation: CitationSourceOperation,
    registrationAgency: RegistrationAgencyEvidence = { status: "undetermined", detail: "test" },
): CitationSourceRequest {
    return {
        input,
        normalized: normalizeCitation(input),
        plan: { source, operation, applicable: true, candidateGeneration: false, reason: "test" },
        registrationAgency,
    };
}

const PUBMED_XML = `<?xml version="1.0"?>
<PubmedArticleSet>
  <PubmedArticle>
    <MedlineCitation>
      <PMID Version="1">12345678</PMID>
      <Article>
        <Journal><Title>Nature Medicine</Title><JournalIssue><PubDate><Year>2021</Year></PubDate></JournalIssue></Journal>
        <ArticleTitle>Example biomedical study</ArticleTitle>
        <AuthorList><Author><ForeName>Jane</ForeName><LastName>Smith</LastName></Author></AuthorList>
      </Article>
    </MedlineCitation>
    <PubmedData><ArticleIdList><ArticleId IdType="doi">10.1000/example</ArticleId></ArticleIdList></PubmedData>
  </PubmedArticle>
</PubmedArticleSet>`;

const PUBMED_TWO_XML = PUBMED_XML.replace(
    "</PubmedArticleSet>",
    `<PubmedArticle>
      <MedlineCitation>
        <PMID Version="1">87654321</PMID>
        <Article>
          <Journal><Title>Cell</Title><JournalIssue><PubDate><Year>2022</Year></PubDate></JournalIssue></Journal>
          <ArticleTitle>Second biomedical study</ArticleTitle>
          <AuthorList><Author><ForeName>Alex</ForeName><LastName>Doe</LastName></Author></AuthorList>
        </Article>
      </MedlineCitation>
      <PubmedData><ArticleIdList><ArticleId IdType="doi">10.1000/second</ArticleId></ArticleIdList></PubmedData>
    </PubmedArticle>
  </PubmedArticleSet>`,
);

const ARXIV_XML = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2401.01234v1</id>
    <title>Example preprint</title>
    <summary>An abstract.</summary>
    <published>2024-01-03T00:00:00Z</published>
    <author><name>Jane Smith</name></author>
    <link href="https://arxiv.org/abs/2401.01234v1" rel="alternate" type="text/html"/>
  </entry>
</feed>`;

describe("DOI registry citation client", () => {
    it("keeps handle existence independent from registration agency and metadata", async () => {
        const urls: string[] = [];
        const fetcher: typeof fetch = async (url) => {
            urls.push(String(url));
            if (String(url).includes("/api/handles/")) return json({ responseCode: 1 });
            if (String(url).includes("/doiRA/")) return json([{ DOI: "10.1000/example", RA: "DataCite" }]);
            return json({ DOI: "10.1000/example", title: "Example dataset", author: [{ given: "Jane", family: "Smith" }], issued: { "date-parts": [[2022]] } });
        };
        const client = createDoiRegistryClient({ fetch: fetcher });
        const result = await client.resolve(request({ citation: "10.1000/example" }, "doi_registry", "doi_exact"));

        expect(result.status).toBe("ok");
        expect(result.requestCount).toBe(3);
        expect(result.identifierEvidence).toEqual({
            type: "doi",
            identifier: "10.1000/example",
            exists: true,
            registrationAgency: "DataCite",
            metadataAvailable: true,
        });
        expect(result.records[0]).toMatchObject({ title: "Example dataset", registrationAgency: "DataCite", year: 2022 });
        expect(urls).toHaveLength(3);
    });

    it("retains existence when negotiated metadata has no supported representation", async () => {
        const fetcher: typeof fetch = async (url) => {
            if (String(url).includes("/api/handles/")) return json({ responseCode: 1 });
            if (String(url).includes("/doiRA/")) return json([{ RA: "EIDR" }]);
            return text("not acceptable", 406);
        };
        const result = await createDoiRegistryClient({ fetch: fetcher }).resolve(request({ citation: "10.1000/example" }, "doi_registry", "doi_exact"));

        expect(result.status).toBe("ok");
        expect(result.identifierEvidence).toMatchObject({ exists: true, metadataAvailable: false, registrationAgency: "EIDR" });
        expect(result.records[0]?.identifiers.doi).toBe("10.1000/example");
        expect(result.records[0]?.title).toBeUndefined();
    });

    it("does not turn an unavailable handle lookup into negative identifier evidence", async () => {
        const result = await createDoiRegistryClient({ fetch: async () => text("rate limited", 429) }).resolve(
            request({ citation: "10.1000/example" }, "doi_registry", "doi_exact"),
        );

        expect(result.status).toBe("unavailable");
        expect(result.identifierEvidence).toBeUndefined();
    });
});

describe("Crossref citation client", () => {
    it("performs bounded bibliographic lookup with injected polite identity", async () => {
        let seen: { url: URL; headers: Headers } | undefined;
        const fetcher: typeof fetch = async (url, init) => {
            seen = { url: new URL(String(url)), headers: new Headers(init?.headers) };
            return json({
                message: {
                    items: [
                        {
                            DOI: "10.1000/example",
                            title: ["Example study"],
                            author: [{ given: "Jane", family: "Smith" }],
                            issued: { "date-parts": [[2021]] },
                            "container-title": ["Example Journal"],
                            volume: "12",
                            page: "10-20",
                        },
                    ],
                },
            });
        };
        const client = createCrossrefClient({ fetch: fetcher, mailto: "contact@example.org", userAgent: "inflexa-test/1.0", maxCandidates: 3 });
        const result = await client.resolve(request({ citation: "Smith. Example study." }, "crossref", "crossref_bibliographic"));

        expect(result.status).toBe("ok");
        expect(result.records[0]).toMatchObject({ identifiers: { doi: "10.1000/example" }, year: 2021, firstPage: "10" });
        expect(seen?.url.searchParams.get("mailto")).toBe("contact@example.org");
        expect(seen?.url.searchParams.get("rows")).toBe("3");
        expect(seen?.headers.get("user-agent")).toBe("inflexa-test/1.0");
    });

    it("does not call Crossref for a DOI owned by another agency", async () => {
        let called = false;
        const client = createCrossrefClient({ fetch: async () => ((called = true), json({})) });
        const base = request({ citation: "10.1000/example" }, "crossref", "crossref_doi_if_owned");
        const result = await client.resolve({ ...base, registrationAgency: { status: "determined", agency: "DataCite" } });
        expect(result.status).toBe("not_applicable");
        expect(result.detail).toBe("DOI is not registered by Crossref");
        expect(called).toBe(false);
    });

    it("reports an undetermined registration agency as unavailable, never as another agency's DOI", async () => {
        let called = false;
        const client = createCrossrefClient({ fetch: async () => ((called = true), json({})) });
        const base = request({ citation: "10.1000/example" }, "crossref", "crossref_doi_if_owned");

        const result = await client.resolve({ ...base, registrationAgency: { status: "undetermined", detail: "HTTP 503" } });

        expect(result.status).toBe("unavailable");
        expect(result.detail).toBe("registration agency undetermined: HTTP 503");
        expect(called).toBe(false);
    });

    it("attributes a skip to the handle when the registry established the DOI does not resolve", async () => {
        let called = false;
        const client = createCrossrefClient({ fetch: async () => ((called = true), json({})) });
        const base = request({ citation: "10.1000/example" }, "crossref", "crossref_doi_if_owned");

        const result = await client.resolve({ ...base, registrationAgency: { status: "absent" } });

        expect(result).toMatchObject({ status: "not_applicable", detail: "the DOI handle does not resolve" });
        expect(called).toBe(false);
    });

    it("identifies exact DOI requests with the configured polite contact", async () => {
        let seen: URL | undefined;
        const client = createCrossrefClient({
            mailto: "contact@example.org",
            fetch: async (url) => {
                seen = new URL(String(url));
                return json({ message: { DOI: "10.1000/example", title: ["Example study"] } });
            },
        });
        const base = request({ citation: "10.1000/example" }, "crossref", "crossref_doi_if_owned");

        const result = await client.resolve({ ...base, registrationAgency: { status: "determined", agency: "Crossref" } });

        expect(result.status).toBe("ok");
        expect(seen?.searchParams.get("mailto")).toBe("contact@example.org");
    });
});

describe("PubMed citation client", () => {
    it("retrieves exact PMID metadata without a discovery search", async () => {
        const urls: URL[] = [];
        const client = createPubmedCitationClient({
            apiKey: "ncbi-key",
            fetch: async (url) => {
                urls.push(new URL(String(url)));
                return text(PUBMED_XML);
            },
        });
        const result = await client.resolve(request({ citation: "PMID: 12345678" }, "pubmed", "pubmed_exact"));

        expect(result.status).toBe("ok");
        expect(result.records[0]).toMatchObject({ sourceRecordId: "12345678", title: "Example biomedical study", year: 2021 });
        expect(urls.map((url) => url.pathname.split("/").at(-1))).toEqual(["efetch.fcgi"]);
        expect(urls[0]?.searchParams.get("api_key")).toBe("ncbi-key");
    });

    it("uses structured ECitMatch slots rather than sending raw prose", async () => {
        const urls: URL[] = [];
        const input = { citation: "Raw reference text", venue: "Nature", year: 2021, volume: "12", authors: ["Smith J"] };
        const client = createPubmedCitationClient({
            fetch: async (url) => {
                const parsed = new URL(String(url));
                urls.push(parsed);
                return parsed.pathname.endsWith("ecitmatch.cgi") ? text("Nature|2021|12||Smith J|citation-0|12345678") : text(PUBMED_XML);
            },
        });
        const result = await client.resolve(request(input, "pubmed", "pubmed_structured"));

        expect(result.status).toBe("ok");
        expect(urls[0]?.searchParams.get("bdata")).toBe("Nature|2021|12||Smith J|citation-0|");
        expect(urls[0]?.searchParams.get("bdata")).not.toContain("Raw reference text");
    });

    it("batches exact PMIDs and maps the shared response back to input order", async () => {
        const urls: URL[] = [];
        const client = createPubmedCitationClient({
            fetch: async (url) => {
                urls.push(new URL(String(url)));
                return text(PUBMED_TWO_XML);
            },
        });
        const results = await client.resolveMany!([
            request({ citation: "PMID: 87654321" }, "pubmed", "pubmed_exact"),
            request({ citation: "PMID: 12345678" }, "pubmed", "pubmed_exact"),
        ]);

        expect(urls).toHaveLength(1);
        expect(urls[0]?.searchParams.get("id")).toBe("87654321,12345678");
        expect(results.map((result) => result.records[0]?.sourceRecordId)).toEqual(["87654321", "12345678"]);
    });
});

describe("arXiv citation client", () => {
    it("retrieves an exact arXiv id into the common record shape", async () => {
        let seen: URL | undefined;
        const client = createArxivCitationClient({
            fetch: async (url) => {
                seen = new URL(String(url));
                return text(ARXIV_XML);
            },
        });
        const result = await client.resolve(request({ citation: "arXiv:2401.01234v1" }, "arxiv", "arxiv_exact"));

        expect(result.status).toBe("ok");
        expect(result.records[0]).toMatchObject({ identifiers: { arxiv: "2401.01234" }, title: "Example preprint", year: 2024 });
        expect(seen?.searchParams.get("id_list")).toBe("2401.01234");
    });
});

describe("Semantic Scholar citation client", () => {
    it("uses an exact external identifier and injected API key", async () => {
        let seen: { url: string; headers: Headers } | undefined;
        const client = createSemanticScholarCitationClient({
            apiKey: "s2-key",
            fetch: async (url, init) => {
                seen = { url: String(url), headers: new Headers(init?.headers) };
                return json({
                    paperId: "paper-1",
                    title: "Example study",
                    year: 2021,
                    venue: "Example Journal",
                    authors: [{ name: "Jane Smith" }],
                    externalIds: { DOI: "10.1000/EXAMPLE", PubMed: "12345678" },
                });
            },
        });
        const result = await client.resolve(request({ citation: "10.1000/example" }, "semantic_scholar", "semantic_scholar_identifier"));

        expect(result.status).toBe("ok");
        expect(result.records[0]).toMatchObject({ identifiers: { doi: "10.1000/example", pmid: "12345678" } });
        expect(seen?.url).toContain("DOI%3A10.1000%2Fexample");
        expect(seen?.headers.get("x-api-key")).toBe("s2-key");
    });
});

interface FailureCase {
    readonly name: string;
    readonly create: (fetcher: typeof fetch, timeoutMs?: number) => CitationSourceClient;
    readonly request: CitationSourceRequest;
    readonly noData: () => Response;
    readonly malformed: () => Response;
}

const failureCases: readonly FailureCase[] = [
    {
        name: "DOI registry",
        create: (fetcher, timeoutMs) => createDoiRegistryClient({ fetch: fetcher, ...(timeoutMs === undefined ? {} : { timeoutMs }) }),
        request: request({ citation: "10.1000/example" }, "doi_registry", "doi_exact"),
        noData: () => json({ responseCode: 100 }),
        malformed: () => json({}),
    },
    {
        name: "Crossref",
        create: (fetcher, timeoutMs) => createCrossrefClient({ fetch: fetcher, ...(timeoutMs === undefined ? {} : { timeoutMs }) }),
        request: request({ citation: "Example citation" }, "crossref", "crossref_bibliographic"),
        noData: () => json({ message: { items: [] } }),
        malformed: () => json({}),
    },
    {
        name: "PubMed",
        create: (fetcher, timeoutMs) => createPubmedCitationClient({ fetch: fetcher, ...(timeoutMs === undefined ? {} : { timeoutMs }) }),
        request: request({ citation: "PMID: 12345678" }, "pubmed", "pubmed_exact"),
        noData: () => text("<PubmedArticleSet></PubmedArticleSet>"),
        malformed: () => text("not PubMed XML"),
    },
    {
        name: "arXiv",
        create: (fetcher, timeoutMs) => createArxivCitationClient({ fetch: fetcher, ...(timeoutMs === undefined ? {} : { timeoutMs }) }),
        request: request({ citation: "arXiv:2401.01234" }, "arxiv", "arxiv_exact"),
        noData: () => text("<feed></feed>"),
        malformed: () => text("not Atom XML"),
    },
    {
        name: "Semantic Scholar",
        create: (fetcher, timeoutMs) => createSemanticScholarCitationClient({ fetch: fetcher, ...(timeoutMs === undefined ? {} : { timeoutMs }) }),
        request: request({ citation: "10.1000/example" }, "semantic_scholar", "semantic_scholar_identifier"),
        noData: () => text("not found", 404),
        malformed: () => json({}),
    },
];

for (const entry of failureCases) {
    describe(`${entry.name} failure boundary`, () => {
        it("returns no_data for a successful negative response", async () => {
            const result = await entry.create(async () => entry.noData()).resolve(entry.request);
            expect(result.status).toBe("no_data");
        });

        it("returns unavailable for malformed upstream data", async () => {
            const result = await entry.create(async () => entry.malformed()).resolve(entry.request);
            expect(result.status).toBe("unavailable");
        });

        it("returns unavailable for rate limiting", async () => {
            const result = await entry.create(async () => text("rate limited", 429)).resolve(entry.request);
            expect(result.status).toBe("unavailable");
            expect(result.detail).toContain("429");
        });

        it("returns unavailable on timeout", async () => {
            const fetcher: typeof fetch = async (_url, init) =>
                await new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener("abort", () => reject(new DOMException("timeout", "AbortError")), { once: true });
                });
            const result = await entry.create(fetcher, 5).resolve(entry.request);
            expect(result.status).toBe("unavailable");
            expect(result.detail).toContain("timed out");
        });

        it("propagates caller cancellation instead of returning unavailable", async () => {
            const controller = new AbortController();
            controller.abort(new DOMException("caller canceled", "AbortError"));
            await expect(entry.create(async () => json({})).resolve(entry.request, controller.signal)).rejects.toThrow("caller canceled");
        });
    });
}
