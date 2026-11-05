import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { restoreFetch, stubFetch, type SentRequest } from "../../__fixtures__/fetch-stub.js";
import { makeToolContext } from "../../__fixtures__/tool-context.js";
import { readFixture } from "../../lib/__fixtures__/fixture-runner.js";
import { createRunScriptTool } from "../../script/run-script.js";
import { MYGENE_HITS_PER_ID } from "../../lib/mygene-client.js";
import { humanbaseTool } from "../humanbase.js";
import { resolveGeneIdsTool } from "../resolve-gene-ids.js";

/** Each request that the tools sent, in call order. */
let requests: SentRequest[] = [];

beforeEach(() => {
    requests = [];
});

afterEach(restoreFetch);

/** Answer each request by its host. A host with no route answers 599. */
function stubHosts(routes: Array<[host: string, status: number, body: unknown]>): void {
    requests = stubFetch((url) => {
        const route = routes.find(([host]) => url.host === host);
        return route === undefined ? { status: 599, body: "no route" } : { status: route[1], body: route[2] };
    });
}

const MYGENE = "mygene.info";
const HUMANBASE = "hb.flatironinstitute.org";

const BRCA1_HIT = {
    query: "BRCA1",
    _id: "672",
    _score: 18.13,
    ensembl: { gene: "ENSG00000012048" },
    entrezgene: "672",
    name: "BRCA1 DNA repair associated",
    symbol: "BRCA1",
    uniprot: { "Swiss-Prot": "P38398" },
};

async function callResolve(identifiers: string[], species = "human"): ReturnType<typeof resolveGeneIdsTool.execute> {
    return resolveGeneIdsTool.execute({ identifiers, species }, makeToolContext().ctx);
}

describe("resolve_gene_ids", () => {
    it("maps a symbol to its Entrez, Ensembl, and UniProt IDs", async () => {
        stubHosts([[MYGENE, 200, { max_total: 1, hits: [BRCA1_HIT] }]]);

        const out = (await callResolve(["BRCA1"]))._unsafeUnwrap();

        expect(out).toEqual({
            genes: [{ query: "BRCA1", symbol: "BRCA1", name: "BRCA1 DNA repair associated", entrez: 672, ensembl: ["ENSG00000012048"], uniprot: ["P38398"] }],
            notFound: [],
            ambiguous: [],
            truncated: [],
        });
    });

    it("posts one batch with the fixed scopes and the species, trimmed and without a duplicate", async () => {
        stubHosts([[MYGENE, 200, { max_total: 1, hits: [BRCA1_HIT] }]]);

        (await callResolve([" BRCA1 ", "BRCA1", "7157"], "mouse"))._unsafeUnwrap();

        expect(requests).toEqual([
            {
                url: "https://mygene.info/v3/query",
                method: "POST",
                body: '{"q":["BRCA1","7157"],"scopes":"symbol,entrezgene,ensembl.gene,uniprot","fields":"symbol,name,entrezgene,ensembl.gene,uniprot.Swiss-Prot","species":"mouse","size":100,"with_total":true}',
            },
        ]);
    });

    it("reports each miss and each ambiguous identifier of a partial batch", async () => {
        stubHosts([[MYGENE, 200, readFixture("mygene", "batch-mixed.json")]]);

        const out = (await callResolve(["BRCA1", "NOTAGENE123", "P62805"]))._unsafeUnwrap();

        expect(out.notFound).toEqual(["NOTAGENE123"]);
        expect(out.ambiguous).toEqual(["P62805"]);
        expect(out.genes.filter((gene) => gene.query === "P62805")).toHaveLength(14);
        expect(out.truncated).toEqual([]);
    });

    it("lists an identifier whose hits filled the cap in truncated", async () => {
        const member = (i: number): Record<string, unknown> => ({ query: "P62805", _id: String(i), entrezgene: String(i), symbol: `H4C${i}` });
        const hits = [...Array.from({ length: MYGENE_HITS_PER_ID }, (_, i) => member(i + 1)), BRCA1_HIT];
        stubHosts([[MYGENE, 200, { max_total: MYGENE_HITS_PER_ID + 20, hits, msg: "1 query terms return > 100 hits" }]]);

        const out = (await callResolve(["P62805", "BRCA1"]))._unsafeUnwrap();

        expect(out.truncated).toEqual(["P62805"]);
        expect(out.ambiguous).toEqual(["P62805"]);
        expect(out.genes).toHaveLength(MYGENE_HITS_PER_ID + 1);
    });

    it("gives an empty data variant when no identifier matches, not an error", async () => {
        stubHosts([[MYGENE, 200, { max_total: 0, hits: [{ query: "NOTAGENE123", notfound: true }] }]]);

        expect((await callResolve(["NOTAGENE123"]))._unsafeUnwrap()).toEqual({ genes: [], notFound: ["NOTAGENE123"], ambiguous: [], truncated: [] });
    });

    it("throws the message of an HTTP 400, such as an unknown species", async () => {
        stubHosts([[MYGENE, 400, { code: 400, success: false, error: "cannot map some species to taxids." }]]);

        await expect(callResolve(["BRCA1"], "notaspecies")).rejects.toThrow("cannot map some species to taxids");
    });

    it("makes execute throw on a 5xx", async () => {
        stubHosts([[MYGENE, 500, "<h1>Server Error</h1>"]]);

        await expect(callResolve(["BRCA1"])).rejects.toThrow("HTTP 500");
    });

    it("refuses an empty list and a list of more than 200 identifiers", () => {
        expect(resolveGeneIdsTool.inputSchema.safeParse({ identifiers: [] }).success).toBe(false);
        expect(resolveGeneIdsTool.inputSchema.safeParse({ identifiers: Array.from({ length: 201 }, (_, i) => String(i + 1)) }).success).toBe(false);
        expect(resolveGeneIdsTool.inputSchema.parse({ identifiers: ["BRCA1"] }).species).toBe("human");
    });
});

describe("resolve_gene_ids — describeCall", () => {
    it("lists a small batch in full", () => {
        expect(resolveGeneIdsTool.describeCall?.({ identifiers: ["BRCA1", "672"], species: "human" })).toBe("BRCA1, 672");
    });

    it("gives the count and a sample of a large batch", () => {
        const identifiers = Array.from({ length: 10 }, (_, i) => `G${i + 1}`);

        expect(resolveGeneIdsTool.describeCall?.({ identifiers, species: "human" })).toBe("10 genes: G1, G2, G3, G4, G5, G6, G7, G8, …");
    });
});

describe("resolve_gene_ids — in a script", () => {
    it("shows its whole result type in the catalog of run_script", () => {
        const catalog = createRunScriptTool([resolveGeneIdsTool]).description;
        const entry = catalog.slice(catalog.indexOf("resolve_gene_ids(args:"));

        expect(entry).not.toContain("Promise<unknown>");
        expect(entry).toContain("entrez: number | null;");
        expect(entry).toContain("name: string | null;");
        expect(entry).toContain("ambiguous: Array<string>;");
        expect(entry).toContain("truncated: Array<string>;");
    });

    it("gives the Entrez IDs that a script passes on to humanbase in the same script", async () => {
        stubHosts([
            [MYGENE, 200, { max_total: 1, hits: [BRCA1_HIT, { query: "NOTAGENE123", notfound: true }] }],
            [HUMANBASE, 200, readFixture("humanbase", "network-blood-672.json")],
        ]);
        const runScript = createRunScriptTool([resolveGeneIdsTool, humanbaseTool]);

        const out = (
            await runScript.execute(
                {
                    code: `
                        const ids = await tools.resolve_gene_ids({ identifiers: ["BRCA1", "NOTAGENE123"] });
                        const entrez = ids.genes.map((gene) => gene.entrez).filter((id) => id !== null);
                        const net = await tools.humanbase({ action: "network", context: "blood", entrez });
                        return {
                            notFound: ids.notFound,
                            found: net.found,
                            query: net.genes.filter((gene) => gene.query).map((gene) => gene.symbol),
                            strongest: net.edges[0],
                        };
                    `,
                },
                makeToolContext().ctx,
            )
        )._unsafeUnwrap();

        expect(out.error).toBeUndefined();
        expect(out.ok).toBe(true);
        expect(out.calls).toEqual([
            { tool: "resolve_gene_ids", ok: true },
            { tool: "humanbase", ok: true },
        ]);
        expect(out.value).toEqual({
            notFound: ["NOTAGENE123"],
            found: true,
            query: ["BRCA1"],
            strongest: { geneA: "MSH6", geneB: "MSH2", weight: 0.9853352847807836 },
        });
        expect(requests.map((request) => request.url)).toEqual([
            "https://mygene.info/v3/query",
            "https://hb.flatironinstitute.org/api/integrations/blood/network/?entrez=672&node_size=10&giant_version=v1",
        ]);
    });
});
