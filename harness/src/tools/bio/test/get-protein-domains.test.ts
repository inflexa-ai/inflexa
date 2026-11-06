import { afterEach, describe, expect, it } from "bun:test";

import { presentAt } from "../../../lib/present.js";
import { restoreFetch, stubFetch, type SentRequest } from "../../__fixtures__/fetch-stub.js";
import { makeToolContext } from "../../__fixtures__/tool-context.js";
import { readFixture } from "../../lib/__fixtures__/fixture-runner.js";
import { createRunScriptTool } from "../../script/run-script.js";
import { getProteinDomainsTool, type GetProteinDomainsOutput } from "../get-protein-domains.js";

/** Each request that the tool sent, in call order. `stubAnswer` makes a new list, and each test ends with an empty list. */
let requests: SentRequest[] = [];

afterEach(() => {
    restoreFetch();
    requests = [];
});

/** Answer each request with one status and one body. A string body goes as it is. */
function stubAnswer(status: number, body: unknown): void {
    requests = stubFetch(() => ({ status, body }));
}

type GetProteinDomainsInput = Parameters<typeof getProteinDomainsTool.execute>[0];

async function callTool(input: GetProteinDomainsInput): Promise<GetProteinDomainsOutput> {
    const { ctx } = makeToolContext();
    return (await getProteinDomainsTool.execute(input, ctx))._unsafeUnwrap();
}

function onlyRequest(): SentRequest {
    expect(requests).toHaveLength(1);
    return presentAt(requests, 0);
}

const BRCA1 = "P38398";
const ENTRIES_URL = `https://www.ebi.ac.uk/interpro/api/entry/interpro/protein/uniprot/${BRCA1}/`;

describe("get_protein_domains — a known accession", () => {
    it("returns the InterPro entries in the order of their first residue, with the true count", async () => {
        stubAnswer(200, readFixture("interpro", "entries-P38398.json"));

        const out = await callTool({ uniprotAccession: BRCA1 });

        expect(out.uniprotAccession).toBe(BRCA1);
        expect(out.totalFound).toBe(9);
        expect(out.domains).toHaveLength(9);
        expect(out.domains.every((domain) => domain.accession.startsWith("IPR"))).toBe(true);
        const starts = out.domains.map((domain) => presentAt(domain.locations, 0).start);
        expect(starts).toEqual([...starts].sort((a, b) => a - b));
        const brct = out.domains.find((domain) => domain.accession === "IPR001357");
        expect(brct).toMatchObject({ name: "BRCT domain", type: "domain", locationCount: 2 });
        expect(brct?.locations).toEqual([
            { start: 1642, end: 1736 },
            { start: 1756, end: 1855 },
        ]);
        expect(brct?.memberDatabases.pfam?.PF00533).toBe("BRCA1 C Terminus (BRCT) domain");
    });

    it("asks for one page of the default size", async () => {
        stubAnswer(200, readFixture("interpro", "entries-P38398.json"));

        await callTool({ uniprotAccession: BRCA1 });

        expect(onlyRequest()).toEqual({ url: `${ENTRIES_URL}?page_size=50`, method: "GET", body: undefined });
    });

    it("sends limit as the page size", async () => {
        stubAnswer(200, readFixture("interpro", "entries-P38398.json"));

        await callTool({ uniprotAccession: BRCA1, limit: 3 });

        expect(onlyRequest().url).toBe(`${ENTRIES_URL}?page_size=3`);
    });

    it("trims the ranges of each entry to maxLocations, and keeps the true range count", async () => {
        stubAnswer(200, readFixture("interpro", "entries-P38398.json"));

        const out = await callTool({ uniprotAccession: BRCA1, maxLocations: 3 });

        const family = out.domains.find((domain) => domain.accession === "IPR011364");
        expect(family?.locationCount).toBe(8);
        expect(family?.locations).toEqual([
            { start: 55, end: 71 },
            { start: 760, end: 780 },
            { start: 1030, end: 1047 },
        ]);
    });
});

describe("get_protein_domains — no entry", () => {
    it("reads an HTTP 204 with an empty body as an empty result, with no retry and no error", async () => {
        stubAnswer(204, "");
        const { ctx } = makeToolContext();

        const result = await getProteinDomainsTool.execute({ uniprotAccession: "Q9ZZZ9" }, ctx);

        expect(result.isOk()).toBe(true);
        expect(result._unsafeUnwrap()).toEqual({ uniprotAccession: "Q9ZZZ9", domains: [], totalFound: 0 });
        expect(onlyRequest().url).toBe("https://www.ebi.ac.uk/interpro/api/entry/interpro/protein/uniprot/Q9ZZZ9/?page_size=50");
    });

    it("reads an HTTP 404 for a malformed accession as an empty result", async () => {
        stubAnswer(404, { Error: "'WSGIRequest' object has no attribute '_request'" });

        expect(await callTool({ uniprotAccession: "a b" })).toEqual({ uniprotAccession: "a b", domains: [], totalFound: 0 });
        expect(onlyRequest().url).toBe("https://www.ebi.ac.uk/interpro/api/entry/interpro/protein/uniprot/a%20b/?page_size=50");
    });
});

describe("get_protein_domains — an unexpected failure", () => {
    it("makes execute throw on a 5xx", async () => {
        stubAnswer(500, "<h1>Server Error (500)</h1>");
        const { ctx } = makeToolContext();

        await expect(getProteinDomainsTool.execute({ uniprotAccession: BRCA1 }, ctx)).rejects.toThrow("HTTP 500");
    });

    it("makes execute throw on a 4xx that is not a 404, because a refused request is not an absence", async () => {
        stubAnswer(403, "Forbidden");
        const { ctx } = makeToolContext();

        await expect(getProteinDomainsTool.execute({ uniprotAccession: BRCA1 }, ctx)).rejects.toThrow("HTTP 403");
    });

    it("makes execute throw on a payload that the schema refuses", async () => {
        stubAnswer(200, readFixture("interpro", "entries-P38398.drift.json"));
        const { ctx } = makeToolContext();

        await expect(getProteinDomainsTool.execute({ uniprotAccession: BRCA1 }, ctx)).rejects.toThrow("did not match the expected schema");
    });
});

describe("get_protein_domains — the input schema", () => {
    it("emits a top-level object schema", () => {
        expect(getProteinDomainsTool.jsonSchema.type).toBe("object");
    });

    it("trims the accession", () => {
        expect(getProteinDomainsTool.inputSchema.parse({ uniprotAccession: " P38398 " }).uniprotAccession).toBe(BRCA1);
    });

    it.each([[{ uniprotAccession: "  " }], [{ uniprotAccession: BRCA1, limit: 201 }], [{ uniprotAccession: BRCA1, maxLocations: 0 }]])(
        "refuses %j",
        (input) => {
            expect(getProteinDomainsTool.inputSchema.safeParse(input).success).toBe(false);
        },
    );
});

describe("get_protein_domains — describeCall", () => {
    it("names the accession", () => {
        expect(getProteinDomainsTool.describeCall?.({ uniprotAccession: BRCA1 })).toBe("P38398");
    });
});

describe("get_protein_domains — the description", () => {
    it("names the sequence of the ranges, and compares a variant only on a transcript that encodes it", () => {
        expect(getProteinDomainsTool.description).toContain("The ranges are on the canonical UniProt sequence of the accession.");
        expect(getProteinDomainsTool.description).toContain("only when its transcript encodes that canonical sequence");
    });
});

describe("get_protein_domains — the result type in a script", () => {
    it("gives an ok value that the output schema accepts, with entries and without", async () => {
        stubAnswer(200, readFixture("interpro", "entries-P38398.json"));
        const found = await callTool({ uniprotAccession: BRCA1 });
        stubAnswer(204, "");
        const empty = await callTool({ uniprotAccession: "Q9ZZZ9" });

        for (const out of [found, empty]) {
            expect(getProteinDomainsTool.outputSchema?.safeParse(out).success, JSON.stringify(out).slice(0, 200)).toBe(true);
        }
    });

    it("shows the result type in the catalog of run_script", () => {
        const catalog = createRunScriptTool([getProteinDomainsTool]).description;
        const entry = catalog.slice(catalog.indexOf("get_protein_domains(args:"));

        expect(entry).not.toContain("Promise<unknown>");
        expect(entry).toContain("locations: Array<{ end: number; start: number; }>;");
        expect(entry).toContain("memberDatabases: { [key: string]: { [key: string]: string; }; };");
        expect(entry).toContain("totalFound: number;");
    });

    it("gives a script the ranges of the entries", async () => {
        stubAnswer(200, readFixture("interpro", "entries-P38398.json"));
        const runScript = createRunScriptTool([getProteinDomainsTool]);

        const out = (
            await runScript.execute(
                {
                    code: `
                        const res = await tools.get_protein_domains({ uniprotAccession: "${BRCA1}" });
                        return res.domains.filter((d) => d.type === "domain" && d.locations.some((r) => r.start <= 1700 && 1700 <= r.end)).map((d) => d.accession);
                    `,
                },
                makeToolContext().ctx,
            )
        )._unsafeUnwrap();

        expect(out.error).toBeUndefined();
        expect(out.value).toEqual(["IPR001357"]);
    });
});
