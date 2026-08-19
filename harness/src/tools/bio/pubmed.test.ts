import { afterEach, describe, expect, it } from "bun:test";

import { makeToolContext } from "../__fixtures__/tool-context.js";
import { createPubMedTool } from "./pubmed.js";

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

const tool = createPubMedTool({});

/**
 * Route the NCBI E-utilities endpoints by URL and record every request, so a
 * test can assert which upstream endpoint an action actually reached and with
 * what parameters.
 */
function stubNcbi(responder: (url: URL) => Response): URL[] {
    const seen: URL[] = [];
    globalThis.fetch = (async (url: string) => {
        const parsed = new URL(url);
        seen.push(parsed);
        return responder(parsed);
    }) as unknown as typeof fetch;
    return seen;
}

function json(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function xml(body: string): Response {
    return new Response(body, { status: 200, headers: { "content-type": "application/xml" } });
}

const ESUMMARY_XML = `<?xml version="1.0"?>
<eSummaryResult>
  <DocSum>
    <Id>12345678</Id>
    <Item Name="PubDate" Type="Date">2021 Mar 15</Item>
    <Item Name="Source" Type="String">Nature</Item>
    <Item Name="AuthorList" Type="List">
      <Item Name="Author" Type="String">Smith J</Item>
      <Item Name="Author" Type="String">Doe A</Item>
    </Item>
    <Item Name="Title" Type="String">BRCA1 and drug resistance</Item>
    <Item Name="FullJournalName" Type="String">Nature Reviews Cancer</Item>
  </DocSum>
</eSummaryResult>`;

// An electronic-only or ahead-of-print record can carry a bare year in PubDate.
// The parser must keep that value as text. A numeric parse of it crashed the
// year extraction, and one such record discarded the whole result set.
const YEAR_ONLY_ESUMMARY_XML = `<?xml version="1.0"?>
<eSummaryResult>
  <DocSum>
    <Id>12345678</Id>
    <Item Name="PubDate" Type="Date">2021 Mar 15</Item>
    <Item Name="Source" Type="String">Nature</Item>
    <Item Name="AuthorList" Type="List">
      <Item Name="Author" Type="String">Smith J</Item>
    </Item>
    <Item Name="Title" Type="String">BRCA1 and drug resistance</Item>
    <Item Name="FullJournalName" Type="String">Nature Reviews Cancer</Item>
  </DocSum>
  <DocSum>
    <Id>40000001</Id>
    <Item Name="PubDate" Type="Date">2026</Item>
    <Item Name="Source" Type="String">Nat Rev Drug Discov</Item>
    <Item Name="Title" Type="String">Ahead-of-print record</Item>
  </DocSum>
</eSummaryResult>`;

const EFETCH_XML = `<?xml version="1.0"?>
<PubmedArticleSet>
  <PubmedArticle>
    <MedlineCitation>
      <PMID Version="1">12345678</PMID>
      <Article>
        <Journal>
          <Title>Nature Reviews Cancer</Title>
          <JournalIssue><PubDate><Year>2021</Year></PubDate></JournalIssue>
        </Journal>
        <ArticleTitle>BRCA1 and drug resistance</ArticleTitle>
        <Abstract><AbstractText Label="BACKGROUND">Resistance is common.</AbstractText></Abstract>
        <AuthorList><Author><LastName>Smith</LastName><ForeName>Jane</ForeName></Author></AuthorList>
      </Article>
      <MeshHeadingList>
        <MeshHeading><DescriptorName UI="D001943">Breast Neoplasms</DescriptorName></MeshHeading>
      </MeshHeadingList>
    </MedlineCitation>
    <PubmedData>
      <ArticleIdList><ArticleId IdType="doi">10.1038/s41568-021-00001</ArticleId></ArticleIdList>
    </PubmedData>
  </PubmedArticle>
</PubmedArticleSet>`;

const PMC_XML = `<?xml version="1.0"?>
<pmc-articleset>
  <article>
    <body>
      <sec><title>Introduction</title><p>BRCA1 is a tumour suppressor.</p></sec>
      <sec><title>Results</title><p>We observed resistance.</p><p>It was dose dependent.</p></sec>
    </body>
  </article>
</pmc-articleset>`;

// What PMC returns for an article that is not open-access: an envelope with no
// <article> body to parse.
const PMC_NOT_OPEN_ACCESS_XML = `<?xml version="1.0"?>
<pmc-articleset>
  <Reply>The publisher of this article does not allow downloading of the full text.</Reply>
</pmc-articleset>`;

describe("pubmed — action 'search'", () => {
    it("returns the total and the per-article summaries", async () => {
        const seen = stubNcbi((url) => {
            if (url.pathname.endsWith("esearch.fcgi")) return json({ esearchresult: { idlist: ["12345678"], count: "137" } });
            return xml(ESUMMARY_XML);
        });

        const { ctx } = makeToolContext();
        const result = (await tool.execute({ action: "search", query: '"BRCA1"[Gene]' }, ctx))._unsafeUnwrap();

        // The 'search' action reaches esearch, then esummary for the returned ids.
        expect(seen.map((u) => u.pathname.split("/").pop())).toEqual(["esearch.fcgi", "esummary.fcgi"]);
        expect(seen[0]!.searchParams.get("term")).toBe('"BRCA1"[Gene]');
        expect(seen[1]!.searchParams.get("id")).toBe("12345678");

        expect(result).toEqual({
            totalFound: 137,
            results: [
                {
                    pmid: "12345678",
                    title: "BRCA1 and drug resistance",
                    journal: "Nature Reviews Cancer",
                    year: "2021",
                    authors: "Smith J, Doe A",
                },
            ],
        });
    });

    it("defaults to 10 relevance-sorted results, and forwards maxResults / sort / dateRange when given", async () => {
        const defaults = stubNcbi((url) => (url.pathname.endsWith("esearch.fcgi") ? json({ esearchresult: { idlist: [], count: "0" } }) : xml(ESUMMARY_XML)));

        const { ctx } = makeToolContext();
        await tool.execute({ action: "search", query: "BRCA1" }, ctx);

        expect(defaults[0]!.searchParams.get("retmax")).toBe("10");
        expect(defaults[0]!.searchParams.get("sort")).toBe("relevance");
        expect(defaults[0]!.searchParams.get("mindate")).toBeNull();

        const explicit = stubNcbi((url) => (url.pathname.endsWith("esearch.fcgi") ? json({ esearchresult: { idlist: [], count: "0" } }) : xml(ESUMMARY_XML)));

        await tool.execute(
            {
                action: "search",
                query: "BRCA1",
                maxResults: 3,
                sort: "date",
                dateRange: { from: "2020/01/01", to: "2021/12/31" },
            },
            ctx,
        );

        expect(explicit[0]!.searchParams.get("retmax")).toBe("3");
        expect(explicit[0]!.searchParams.get("sort")).toBe("pub+date");
        expect(explicit[0]!.searchParams.get("mindate")).toBe("2020/01/01");
        expect(explicit[0]!.searchParams.get("maxdate")).toBe("2021/12/31");
        expect(explicit[0]!.searchParams.get("datetype")).toBe("pdat");
    });

    it("returns every summary when one record carries a year-only PubDate", async () => {
        stubNcbi((url) => {
            if (url.pathname.endsWith("esearch.fcgi")) return json({ esearchresult: { idlist: ["12345678", "40000001"], count: "2" } });
            return xml(YEAR_ONLY_ESUMMARY_XML);
        });

        const { ctx } = makeToolContext();
        const result = (await tool.execute({ action: "search", query: "Bender A[Author]" }, ctx))._unsafeUnwrap();

        expect(result).toEqual({
            totalFound: 2,
            results: [
                {
                    pmid: "12345678",
                    title: "BRCA1 and drug resistance",
                    journal: "Nature Reviews Cancer",
                    year: "2021",
                    authors: "Smith J",
                },
                {
                    pmid: "40000001",
                    title: "Ahead-of-print record",
                    journal: "Nat Rev Drug Discov",
                    year: "2026",
                    authors: "",
                },
            ],
        });
    });

    it("returns an empty results list when nothing matches (does not throw, and does not call esummary)", async () => {
        const seen = stubNcbi(() => json({ esearchresult: { idlist: [], count: "0" } }));

        const { ctx } = makeToolContext();
        const result = (await tool.execute({ action: "search", query: "no-such-topic-xyz" }, ctx))._unsafeUnwrap();

        expect(result).toEqual({ totalFound: 0, results: [] });
        expect(seen.map((u) => u.pathname.split("/").pop())).toEqual(["esearch.fcgi"]);
    });

    it("throws on an upstream 5xx failure", async () => {
        stubNcbi(() => new Response("upstream down", { status: 500 }));

        const { ctx } = makeToolContext();
        await expect(tool.execute({ action: "search", query: "BRCA1" }, ctx)).rejects.toThrow();
    });
});

describe("pubmed — action 'details'", () => {
    it("returns the article metadata, its PMC id, and the PMIDs PubMed had no record of", async () => {
        const seen = stubNcbi((url) => {
            if (url.pathname.includes("idconv")) return json({ records: [{ pmid: "12345678", pmcid: "PMC7654321" }] });
            return xml(EFETCH_XML);
        });

        const { ctx } = makeToolContext();
        const result = (await tool.execute({ action: "details", pmids: ["12345678", "99999999"] }, ctx))._unsafeUnwrap();

        // The 'details' action reaches efetch (db=pubmed) and the PMC ID converter.
        const efetch = seen.find((u) => u.pathname.endsWith("efetch.fcgi"))!;
        expect(efetch.searchParams.get("db")).toBe("pubmed");
        expect(efetch.searchParams.get("id")).toBe("12345678,99999999");
        expect(seen.some((u) => u.pathname.includes("idconv"))).toBe(true);

        expect(result).toEqual({
            articles: [
                {
                    pmid: "12345678",
                    title: "BRCA1 and drug resistance",
                    abstract: "BACKGROUND: Resistance is common.",
                    authors: ["Jane Smith"],
                    journal: "Nature Reviews Cancer",
                    year: "2021",
                    doi: "10.1038/s41568-021-00001",
                    meshTerms: ["Breast Neoplasms"],
                    pmcId: "PMC7654321",
                    // The true sizes travel even when the lists are not trimmed.
                    authorCount: 1,
                    meshTermCount: 1,
                },
            ],
            notFound: ["99999999"],
        });
    });

    it("trims the author and MeSH lists while reporting their true sizes", async () => {
        stubNcbi((url) => (url.pathname.includes("idconv") ? json({ records: [] }) : xml(EFETCH_XML)));

        const { ctx } = makeToolContext();
        const result = (await tool.execute({ action: "details", pmids: ["12345678"], maxAuthors: 0, maxMeshTerms: 0 }, ctx))._unsafeUnwrap();

        const article = result.articles[0]!;
        expect(article.authors).toEqual([]);
        expect(article.authorCount).toBe(1);
        expect(article.meshTerms).toEqual([]);
        expect(article.meshTermCount).toBe(1);
    });

    it("leaves pmcId null when the article has no open-access counterpart in PMC", async () => {
        stubNcbi((url) => (url.pathname.includes("idconv") ? json({ records: [{ pmid: "12345678" }] }) : xml(EFETCH_XML)));

        const { ctx } = makeToolContext();
        const result = (await tool.execute({ action: "details", pmids: ["12345678"] }, ctx))._unsafeUnwrap();

        expect(result).toEqual({
            articles: [expect.objectContaining({ pmid: "12345678", pmcId: null })],
            notFound: [],
        });
    });

    it("throws on an upstream 5xx failure", async () => {
        stubNcbi(() => new Response("upstream down", { status: 500 }));

        const { ctx } = makeToolContext();
        await expect(tool.execute({ action: "details", pmids: ["12345678"] }, ctx)).rejects.toThrow();
    });
});

describe("pubmed — action 'fulltext'", () => {
    it("returns available: true with the body text and its sections", async () => {
        const seen = stubNcbi(() => xml(PMC_XML));

        const { ctx } = makeToolContext();
        const result = (await tool.execute({ action: "fulltext", pmcId: "PMC7654321" }, ctx))._unsafeUnwrap();

        // The 'fulltext' action reaches efetch against db=pmc with the numeric id.
        expect(seen[0]!.searchParams.get("db")).toBe("pmc");
        expect(seen[0]!.searchParams.get("id")).toBe("7654321");

        expect(result).toEqual({
            pmcId: "PMC7654321",
            available: true,
            fullText: "## Introduction\n\nBRCA1 is a tumour suppressor.\n\n## Results\n\nWe observed resistance.\n\nIt was dose dependent.",
            sections: [
                { heading: "Introduction", text: "BRCA1 is a tumour suppressor." },
                { heading: "Results", text: "We observed resistance.\n\nIt was dose dependent." },
            ],
            // The outline covers every section, so a follow-up can name one.
            outline: [
                { heading: "Introduction", chars: 29, included: true },
                { heading: "Results", chars: 47, included: true },
            ],
            totalChars: 76,
            returnedChars: 76,
            truncated: false,
        });
    });

    it("filters to the named sections, leaving the rest in the outline", async () => {
        stubNcbi(() => xml(PMC_XML));

        const { ctx } = makeToolContext();
        const result = (await tool.execute({ action: "fulltext", pmcId: "PMC7654321", sections: ["results"] }, ctx))._unsafeUnwrap();

        expect(result.sections.map((s) => s.heading)).toEqual(["Results"]);
        expect(result.outline.map((o) => [o.heading, o.included])).toEqual([
            ["Introduction", false],
            ["Results", true],
        ]);
        expect(result.truncated).toBe(true);
        expect(result.totalChars).toBe(76);
    });

    it("returns the whole body when it fits inside the budget", async () => {
        stubNcbi(() => xml(PMC_XML));

        const { ctx } = makeToolContext();
        const result = (await tool.execute({ action: "fulltext", pmcId: "PMC7654321", maxChars: 500 }, ctx))._unsafeUnwrap();

        expect(result.sections).toHaveLength(2);
        expect(result.truncated).toBe(false);
        expect(result.returnedChars).toBe(result.totalChars);
    });

    it("rejects a maxChars below the schema floor", () => {
        expect(tool.inputSchema.safeParse({ action: "fulltext", pmcId: "PMC7654321", maxChars: 50 }).success).toBe(false);
    });

    it("returns available: false for an article that is not open-access (not is_error)", async () => {
        stubNcbi(() => xml(PMC_NOT_OPEN_ACCESS_XML));

        const { ctx } = makeToolContext();
        const outcome = await tool.execute({ action: "fulltext", pmcId: "PMC0000001" }, ctx);

        expect(outcome.isOk()).toBe(true);
        expect(outcome._unsafeUnwrap()).toEqual({ pmcId: "PMC0000001", available: false });
    });

    it("throws on an upstream 5xx failure", async () => {
        stubNcbi(() => new Response("upstream down", { status: 500 }));

        const { ctx } = makeToolContext();
        await expect(tool.execute({ action: "fulltext", pmcId: "PMC7654321" }, ctx)).rejects.toThrow();
    });
});

describe("pubmed — input validation", () => {
    it("emits a flat object schema whose only required field is the discriminator", () => {
        expect(tool.jsonSchema.type).toBe("object");
        expect(tool.jsonSchema.required).toEqual(["action"]);
    });

    it("rejects 'search' with no query", () => {
        const parsed = tool.inputSchema.safeParse({ action: "search" });

        expect(parsed.success).toBe(false);
        const message = parsed.success ? "" : parsed.error.issues.map((i) => i.message).join(" ");
        expect(message).toContain("query is required");
    });

    it("rejects 'details' with no pmids, telling the model where to get them", () => {
        const parsed = tool.inputSchema.safeParse({ action: "details" });

        expect(parsed.success).toBe(false);
        const message = parsed.success ? "" : parsed.error.issues.map((i) => i.message).join(" ");
        expect(message).toContain("pmids is required");
        expect(message).toContain("search");
    });

    it("rejects 'details' with an empty pmids array, and with more than 20", () => {
        expect(tool.inputSchema.safeParse({ action: "details", pmids: [] }).success).toBe(false);
        expect(tool.inputSchema.safeParse({ action: "details", pmids: Array.from({ length: 21 }, (_, i) => String(i)) }).success).toBe(false);
        expect(tool.inputSchema.safeParse({ action: "details", pmids: Array.from({ length: 20 }, (_, i) => String(i)) }).success).toBe(true);
    });

    it("rejects 'fulltext' with no pmcId, distinguishing it from a PMID", () => {
        const parsed = tool.inputSchema.safeParse({ action: "fulltext" });

        expect(parsed.success).toBe(false);
        const message = parsed.success ? "" : parsed.error.issues.map((i) => i.message).join(" ");
        expect(message).toContain("pmcId is required");
        expect(message).toContain("PMID is not a PMC ID");
    });

    it("rejects a 'fulltext' that passes pmids instead of a pmcId — the wrong identifier for the action", () => {
        expect(tool.inputSchema.safeParse({ action: "fulltext", pmids: ["12345678"] }).success).toBe(false);
    });

    it("accepts each action with its own identifier, applying the search defaults", () => {
        const search = tool.inputSchema.safeParse({ action: "search", query: "BRCA1" });
        expect(search.success).toBe(true);
        // `execute` owns the defaults now, so the parsed input carries only what was passed.
        expect(search.success && search.data).toMatchObject({ action: "search", query: "BRCA1" });

        expect(tool.inputSchema.safeParse({ action: "details", pmids: ["12345678"] }).success).toBe(true);
        expect(tool.inputSchema.safeParse({ action: "fulltext", pmcId: "PMC7654321" }).success).toBe(true);
    });

    it("rejects an unknown action", () => {
        expect(tool.inputSchema.safeParse({ action: "citations", query: "BRCA1" }).success).toBe(false);
    });
});
