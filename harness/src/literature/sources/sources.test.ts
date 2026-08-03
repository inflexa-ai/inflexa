import { describe, expect, it } from "bun:test";

import { createArxivSource } from "./arxiv.js";
import { createPubmedSource } from "./pubmed.js";
import { createSemanticScholarSource } from "./semantic-scholar.js";

const ARXIV_XML = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2401.01234v1</id>
    <title>Shared source paper</title>
    <summary>One parser serves both consumers.</summary>
    <published>2024-01-03T00:00:00Z</published>
    <author><name>Jane Smith</name></author>
    <category term="cs.LG"/>
    <link href="https://arxiv.org/abs/2401.01234v1" rel="alternate" type="text/html"/>
  </entry>
</feed>`;

const PUBMED_XML = `<?xml version="1.0"?>
<PubmedArticleSet>
  <PubmedArticle>
    <MedlineCitation>
      <PMID>12345678</PMID>
      <Article><ArticleTitle>Shared PubMed source</ArticleTitle></Article>
    </MedlineCitation>
  </PubmedArticle>
</PubmedArticleSet>`;

describe("shared literature authority sources", () => {
    it("uses one arXiv URL builder and Atom parser for search and exact lookup", async () => {
        const seen: URL[] = [];
        const source = createArxivSource({
            fetch: async (url) => {
                seen.push(new URL(String(url)));
                return new Response(ARXIV_XML);
            },
        });

        const search = await source.search({ query: "shared clients", categories: ["cs.LG"], limit: 3 });
        const exact = await source.lookupExact("2401.01234", 1);

        expect(search).toMatchObject({ status: "ok", value: [{ id: "2401.01234v1", title: "Shared source paper" }] });
        expect(exact).toMatchObject({ status: "ok", value: [{ id: "2401.01234v1" }] });
        expect(seen[0]?.searchParams.get("search_query")).toBe("all:shared clients AND (cat:cs.LG)");
        expect(seen[1]?.searchParams.get("id_list")).toBe("2401.01234");
    });

    it("uses one Semantic Scholar schema and mapper for search and identifier lookup", async () => {
        const seen: Array<{ url: URL; apiKey: string | null }> = [];
        const source = createSemanticScholarSource({
            apiKey: "test-key",
            fetch: async (url, init) => {
                const parsed = new URL(String(url));
                seen.push({ url: parsed, apiKey: new Headers(init?.headers).get("x-api-key") });
                const paper = {
                    paperId: "paper-1",
                    title: "Shared Semantic Scholar source",
                    abstract: null,
                    authors: [{ name: "Jane Smith" }],
                    externalIds: { DOI: "10.1000/example" },
                };
                return Response.json(parsed.pathname.endsWith("/paper/search") ? { data: [paper] } : paper);
            },
        });

        const search = await source.search("shared clients", 2);
        const exact = await source.lookupIdentifier("DOI:10.1000/example");

        expect(search).toMatchObject({ status: "ok", value: [{ id: "paper-1", title: "Shared Semantic Scholar source" }] });
        expect(exact).toMatchObject({ status: "ok", value: { id: "paper-1", externalIds: { DOI: "10.1000/example" } } });
        expect(seen[0]?.url.searchParams.get("query")).toBe("shared clients");
        expect(seen[1]?.url.pathname).toContain("DOI%3A10.1000%2Fexample");
        expect(seen.every(({ apiKey }) => apiKey === "test-key")).toBe(true);
    });

    it("uses one PubMed E-utilities client for discovery and exact article retrieval", async () => {
        const seen: URL[] = [];
        const source = createPubmedSource({
            apiKey: "ncbi-key",
            fetch: async (url) => {
                const parsed = new URL(String(url));
                seen.push(parsed);
                return parsed.pathname.endsWith("esearch.fcgi")
                    ? Response.json({ esearchresult: { idlist: ["12345678"], count: "1" } })
                    : new Response(PUBMED_XML);
            },
        });

        const ids = await source.searchIds("shared source[Title]", 5);
        const articles = await source.fetchArticles(["12345678"]);

        expect(ids).toEqual({ status: "ok", value: ["12345678"] });
        expect(articles).toMatchObject({ status: "ok", value: [{ pmid: "12345678", title: "Shared PubMed source" }] });
        expect(seen.map((url) => url.pathname.split("/").at(-1))).toEqual(["esearch.fcgi", "efetch.fcgi"]);
        expect(seen.every((url) => url.searchParams.get("api_key") === "ncbi-key")).toBe(true);
    });
});
