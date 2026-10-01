import { afterEach, describe, expect, it } from "bun:test";

import { makeToolContext } from "../__fixtures__/tool-context.js";
import { readFixture } from "../lib/__fixtures__/fixture-runner.js";
import { createSearchPatentsTool } from "./search-patents.js";

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

interface SeenRequest {
    readonly url: URL;
    readonly body: unknown;
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Route a stubbed fetch by URL substring, and record each request. Unmatched URLs 404. */
function stubFetch(routes: Array<[string, () => Response]>): SeenRequest[] {
    const seen: SeenRequest[] = [];
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
        const request: SeenRequest = {
            url: new URL(String(input)),
            body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
        };
        seen.push(request);
        for (const [needle, make] of routes) {
            if (request.url.toString().includes(needle)) return make();
        }
        return json({ error: { status: 404, code: "NOT_FOUND", message: "unrouted" } }, 404);
    }) as typeof fetch;
    return seen;
}

const tool = createSearchPatentsTool({ apiKey: "amass_test" });

/** Parse the input the way the loop does, thus the defaults of the schema apply. */
async function run(input: Record<string, unknown>) {
    const { ctx } = makeToolContext();
    return tool.execute(tool.inputSchema.parse(input), ctx);
}

const PATENT = "AMPC_EzkKarMF7cIFSt3SZg13CV1tr3M";

describe("search_patents — action 'search'", () => {
    it("asks for no claims and no description, and joins a list filter with commas", async () => {
        const seen = stubFetch([["/patentcore/records?", () => json(readFixture("amass", "patent-search.json"))]]);

        const result = (await run({ query: "imatinib mesylate crystal", assignee: ["Novartis", "Natco"], countryCode: ["US", "CN"] }))._unsafeUnwrap();

        const params = seen[0]!.url.searchParams;
        expect(params.getAll("include")).toEqual([]);
        expect(params.get("assignee")).toBe("Novartis,Natco");
        expect(params.get("countryCode")).toBe("US,CN");
        expect(params.get("limit")).toBe("10");
        if (!("patents" in result)) throw new Error("expected a search answer");
        expect(result.patents[0]!.publicationNumber).toBe("CN-103570677-A");
        expect(result.patents[0]).not.toHaveProperty("claims");
    });

    it("rejects a limit above 20", () => {
        expect(tool.inputSchema.safeParse({ query: "imatinib", limit: 21 }).success).toBe(false);
    });
});

describe("search_patents — action 'details'", () => {
    it("resolves a publication number, then asks for the claims only when told to", async () => {
        const lookup = readFixture("amass", "patent-lookup.json") as { data: unknown[] };
        const seen = stubFetch([
            ["/patentcore/records/lookup", () => json({ data: [lookup.data[0]] })],
            [`/patentcore/records/${PATENT}`, () => json(readFixture("amass", "patent-record.json"))],
        ]);

        const result = (await run({ action: "details", publicationNumber: "CN-103570677-A", includeClaims: true }))._unsafeUnwrap();

        expect(seen[0]!.body).toEqual({ items: [{ publicationNumber: "CN-103570677-A" }] });
        expect(seen[1]!.url.searchParams.getAll("include")).toEqual(["claims"]);
        expect(result).toMatchObject({ status: "found", patent: { amassId: PATENT, claims: "" } });
    });

    it("gives the candidates of an application number with two publications", async () => {
        const lookup = readFixture("amass", "patent-lookup.json") as { data: unknown[] };
        const seen = stubFetch([["/patentcore/records/lookup", () => json({ data: [lookup.data[1]] })]]);

        const result = (await run({ action: "details", applicationNumber: "CN-201310332334-A" }))._unsafeUnwrap();

        expect(result).toEqual({ status: "ambiguous", candidates: ["AMPC_VqlmWsgcRLp4IrwXtNg7n4bp0RT", PATENT] });
        expect(seen).toHaveLength(1);
    });

    it("gives not_found for an in-band lookup miss, with no get request", async () => {
        const lookup = readFixture("amass", "patent-lookup.json") as { data: unknown[] };
        const seen = stubFetch([["/patentcore/records/lookup", () => json({ data: [lookup.data[2]] })]]);

        const result = (await run({ action: "details", publicationNumber: "US-0000000-B2" }))._unsafeUnwrap();

        expect(result).toEqual({ status: "not_found" });
        expect(seen).toHaveLength(1);
    });

    it("takes exactly one identifier", () => {
        expect(tool.inputSchema.safeParse({ action: "details", amassId: PATENT, publicationNumber: "US-1-B2" }).success).toBe(false);
    });
});

describe("search_patents — the key", () => {
    it("throws terminally with no key, before a request goes to Amass", async () => {
        const seen = stubFetch([]);
        const keyless = createSearchPatentsTool({ apiKey: "" });
        const { ctx } = makeToolContext();
        await expect(keyless.execute(keyless.inputSchema.parse({ query: "imatinib" }), ctx)).rejects.toThrow(/AMASS_API_KEY/);
        expect(seen).toHaveLength(0);
    });

    it("throws on a rejected key, never an empty result", async () => {
        stubFetch([["/patentcore/records?", () => json({ error: { status: 401, code: "UNAUTHORIZED", message: "Unauthorized" } }, 401)]]);
        await expect(run({ query: "imatinib" })).rejects.toThrow(/AMASS_API_KEY/);
    });
});
