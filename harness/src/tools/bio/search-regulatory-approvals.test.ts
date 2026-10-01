import { afterEach, describe, expect, it } from "bun:test";

import { makeToolContext } from "../__fixtures__/tool-context.js";
import { readFixture } from "../lib/__fixtures__/fixture-runner.js";
import { createSearchRegulatoryApprovalsTool } from "./search-regulatory-approvals.js";

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

interface SeenRequest {
    readonly url: URL;
    readonly method: string;
    readonly authorization: string | null;
    readonly body: unknown;
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function envelope(status: number, code: string, message: string): Response {
    return json({ error: { status, code, message } }, status);
}

/** Route a stubbed fetch by URL substring, and record each request. Unmatched URLs 404. */
function stubFetch(routes: Array<[string, (request: SeenRequest) => Response]>): SeenRequest[] {
    const seen: SeenRequest[] = [];
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
        const request: SeenRequest = {
            url: new URL(String(input)),
            method: init?.method ?? "GET",
            authorization: new Headers(init?.headers).get("authorization"),
            body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
        };
        seen.push(request);
        for (const [needle, make] of routes) {
            if (request.url.toString().includes(needle)) return make(request);
        }
        return envelope(404, "NOT_FOUND", "unrouted");
    }) as typeof fetch;
    return seen;
}

const tool = createSearchRegulatoryApprovalsTool({ apiKey: "amass_test" });

/** Parse the input the way the loop does, thus the defaults of the schema apply. */
async function run(input: Record<string, unknown>) {
    const { ctx } = makeToolContext();
    return tool.execute(tool.inputSchema.parse(input), ctx);
}

const GLEEVEC = "AMRC_MMqv8cAEmfYfgoetgm9HSnLBlQg";

function lookupAnswer(items: Array<{ input: Record<string, string>; amassIds?: string[] }>): Response {
    return json({
        data: items.map((item) => (item.amassIds ? item : { input: item.input, error: { code: "NOT_FOUND", message: "Record not found." } })),
    });
}

describe("search_regulatory_approvals — the key", () => {
    it("sends the key as a Bearer token", async () => {
        const seen = stubFetch([["/regulatorycore/records?", () => json({ data: [] })]]);
        await run({ query: "imatinib" });
        expect(seen[0]!.authorization).toBe("Bearer amass_test");
    });

    it("throws terminally with no key, before a request goes to Amass", async () => {
        const seen = stubFetch([]);
        const keyless = createSearchRegulatoryApprovalsTool({ apiKey: "" });
        const { ctx } = makeToolContext();
        await expect(keyless.execute(keyless.inputSchema.parse({ query: "imatinib" }), ctx)).rejects.toThrow(/AMASS_API_KEY/);
        expect(seen).toHaveLength(0);
    });
});

describe("search_regulatory_approvals — action 'search'", () => {
    it("keeps 5 matched sections of a record, grouped by document, with the true count", async () => {
        const base = (readFixture("amass", "regulatory-search.json") as { data: Array<Record<string, unknown>> }).data[0]!;
        const label = { docType: "FDA_LABEL", textType: "Label", sourceUrl: "https://example.test/label.pdf", sourceDate: "2026-07-15" };
        const sections = Array.from({ length: 16 }, (_, i) => ({
            ...label,
            documentSectionId: `AMRCDS_${i}`,
            amassId: GLEEVEC,
            path: `${i + 1}`,
            title: `Section ${i + 1}`,
            matchedText: `excerpt ${i + 1}`,
        }));
        stubFetch([["/regulatorycore/records?", () => json({ data: [{ ...base, documentSections: sections }] })]]);

        const result = (await run({ query: "imatinib" }))._unsafeUnwrap();

        if (!("authorizations" in result)) throw new Error("expected a search answer");
        const row = result.authorizations[0]!;
        expect(row.matchedSectionCount).toBe(16);
        expect(row.matchedDocuments).toHaveLength(1);
        expect(row.matchedDocuments[0]!.sourceUrl).toBe(label.sourceUrl);
        expect(row.matchedDocuments[0]!.sections).toHaveLength(5);
        expect(row.matchedDocuments[0]!.sections[0]).toEqual({ documentSectionId: "AMRCDS_0", path: "1", title: "Section 1", matchedText: "excerpt 1" });
    });

    it("sends the filters, repeats a list filter, and scopes the match to one record", async () => {
        const seen = stubFetch([["/regulatorycore/records?", () => json({ data: [] })]]);

        const result = (await run({ query: "hepatotoxicity", agency: ["FDA", "EMA"], isOrphan: true, amassId: GLEEVEC }))._unsafeUnwrap();

        expect(result).toEqual({ authorizations: [] });
        const params = seen[0]!.url.searchParams;
        expect(params.get("query")).toBe("hepatotoxicity");
        expect(params.getAll("agency")).toEqual(["FDA", "EMA"]);
        expect(params.get("isOrphan")).toBe("true");
        expect(params.get("amassId")).toBe(GLEEVEC);
        expect(params.get("limit")).toBe("10");
    });

    it("rejects a limit above 20, which would double the price of the search", () => {
        const parsed = tool.inputSchema.safeParse({ query: "imatinib", limit: 50 });
        expect(parsed.success).toBe(false);
    });

    it("requires a query", () => {
        expect(tool.inputSchema.safeParse({ action: "search" }).success).toBe(false);
    });
});

describe("search_regulatory_approvals — action 'details'", () => {
    it("tries each prefix of a bare FDA number in one lookup, then gets the matched record", async () => {
        const seen = stubFetch([
            [
                "/records/lookup",
                () =>
                    lookupAnswer([
                        { input: { fdaApplicationNumber: "NDA021588" }, amassIds: [GLEEVEC] },
                        { input: { fdaApplicationNumber: "BLA021588" } },
                        { input: { fdaApplicationNumber: "ANDA021588" } },
                    ]),
            ],
            [`/records/${GLEEVEC}`, () => json(readFixture("amass", "regulatory-record-fda.json"))],
        ]);

        const result = (await run({ action: "details", fdaApplicationNumber: "021588" }))._unsafeUnwrap();

        const lookups = seen.filter((request) => request.url.pathname.endsWith("/lookup"));
        expect(lookups).toHaveLength(1);
        expect(lookups[0]!.method).toBe("POST");
        expect(lookups[0]!.body).toEqual({
            items: [{ fdaApplicationNumber: "NDA021588" }, { fdaApplicationNumber: "BLA021588" }, { fdaApplicationNumber: "ANDA021588" }],
        });
        expect(result).toMatchObject({ status: "found", authorization: { amassId: GLEEVEC, sectionCount: 120 } });
        const get = seen.find((request) => request.url.pathname.endsWith(GLEEVEC))!;
        expect(get.url.searchParams.getAll("include")).toEqual(["fdaDetails", "emaDetails"]);
    });

    it("gives the table of contents with no text and no repeated document fields", async () => {
        stubFetch([[`/records/${GLEEVEC}`, () => json(readFixture("amass", "regulatory-record-fda.json"))]]);

        const result = (await run({ action: "details", amassId: GLEEVEC }))._unsafeUnwrap();

        if (!("authorization" in result)) throw new Error("expected an authorization");
        const entry = result.authorization.documents[0]!.sections[0]!;
        expect(Object.keys(entry).sort()).toEqual(["documentSectionId", "path", "title"]);
    });

    it("sends the product code of a package NDC", async () => {
        const seen = stubFetch([["/records/lookup", () => lookupAnswer([{ input: { ndc: "0078-0401" } }])]]);

        await run({ action: "details", ndc: "0078-0401-05" });

        expect(seen[0]!.body).toEqual({ items: [{ ndc: "0078-0401" }] });
    });

    it("gives not_found for an in-band lookup miss, with no get request", async () => {
        const lookup = readFixture("amass", "regulatory-lookup.json") as { data: Array<{ error?: unknown }> };
        const seen = stubFetch([["/records/lookup", () => json({ data: lookup.data.filter((item) => item.error !== undefined) })]]);

        const result = (await run({ action: "details", emaProductNumber: "EMEA/H/C/999999" }))._unsafeUnwrap();

        expect(result).toEqual({ status: "not_found" });
        expect(seen).toHaveLength(1);
    });

    it("gives the candidates of an identifier with two records, with no get request", async () => {
        const seen = stubFetch([["/records/lookup", () => lookupAnswer([{ input: { splSetId: "set-1" }, amassIds: ["AMRC_a", "AMRC_b"] }])]]);

        const result = (await run({ action: "details", splSetId: "set-1" }))._unsafeUnwrap();

        expect(result).toEqual({ status: "ambiguous", candidates: ["AMRC_a", "AMRC_b"] });
        expect(seen).toHaveLength(1);
    });

    it("gives not_found for an unknown Amass ID", async () => {
        stubFetch([["/records/AMRC_unknown", () => json(readFixture("amass", "regulatory-not-found.json"), 404)]]);

        const result = (await run({ action: "details", amassId: "AMRC_unknown" }))._unsafeUnwrap();

        expect(result).toEqual({ status: "not_found" });
    });

    it("takes exactly one identifier", () => {
        expect(tool.inputSchema.safeParse({ action: "details" }).success).toBe(false);
        expect(tool.inputSchema.safeParse({ action: "details", amassId: GLEEVEC, ndc: "0078-0401" }).success).toBe(false);
    });
});

describe("search_regulatory_approvals — action 'section'", () => {
    it("gives the full text of one section", async () => {
        const fixture = readFixture("amass", "regulatory-section.json") as { data: { amassId: string; documentSectionId: string } };
        const { amassId, documentSectionId } = fixture.data;
        stubFetch([[`/document-sections/${documentSectionId}`, () => json(fixture)]]);

        const result = (await run({ action: "section", amassId, documentSectionId }))._unsafeUnwrap();

        if (!("section" in result)) throw new Error("expected a section");
        expect(result.section.content).toHaveLength(5296);
    });

    it("gives not_found for an unknown section", async () => {
        stubFetch([["/document-sections/AMRCDS_unknown", () => envelope(404, "NOT_FOUND", "Document section not found")]]);

        const result = (await run({ action: "section", amassId: GLEEVEC, documentSectionId: "AMRCDS_unknown" }))._unsafeUnwrap();

        expect(result).toEqual({ status: "not_found" });
    });

    it("requires the record and the section ID", () => {
        expect(tool.inputSchema.safeParse({ action: "section", documentSectionId: "AMRCDS_x" }).success).toBe(false);
    });
});

describe("search_regulatory_approvals — the status of an answer", () => {
    it("throws on a rejected key and names AMASS_API_KEY, never an empty result", async () => {
        stubFetch([["/regulatorycore/records?", () => envelope(401, "UNAUTHORIZED", "Unauthorized")]]);
        await expect(run({ query: "imatinib" })).rejects.toThrow(/AMASS_API_KEY/);
    });

    it("throws on a 403 and names the credits", async () => {
        stubFetch([["/regulatorycore/records?", () => envelope(403, "FORBIDDEN", "Forbidden")]]);
        await expect(run({ query: "imatinib" })).rejects.toThrow(/credits/);
    });

    it("gives a tool error with the message of Amass for a 422, which the caller can repair", async () => {
        stubFetch([["/regulatorycore/records?", () => envelope(422, "UNPROCESSABLE_ENTITY", "minAuthorizationDate is after maxAuthorizationDate")]]);

        const result = await run({ query: "imatinib", minAuthorizationDate: "2025-01-01", maxAuthorizationDate: "2020-01-01" });

        expect(result.isErr()).toBe(true);
        expect(result._unsafeUnwrapErr().error).toContain("minAuthorizationDate is after maxAuthorizationDate");
        expect(result._unsafeUnwrapErr().retryable).toBe(false);
    });

    it("gives the per-field reasons of a 400", async () => {
        stubFetch([
            [
                "/regulatorycore/records?",
                () => json({ error: { status: 400, code: "BAD_REQUEST", message: "Validation failed", fields: { limit: "Must be between 1 and 300" } } }, 400),
            ],
        ]);

        const result = await run({ query: "imatinib" });

        expect(result._unsafeUnwrapErr().error).toContain("limit: Must be between 1 and 300");
    });

    it("throws with the code and the message of an undocumented 4xx", async () => {
        stubFetch([["/regulatorycore/records?", () => envelope(402, "PAYMENT_REQUIRED", "No credits left")]]);
        await expect(run({ query: "imatinib" })).rejects.toThrow(/PAYMENT_REQUIRED.*No credits left/);
    });

    it("throws on a lookup item with an error code other than NOT_FOUND", async () => {
        stubFetch([["/records/lookup", () => json({ data: [{ input: { ndc: "x" }, error: { code: "INVALID_IDENTIFIER", message: "Bad NDC" } }] })]]);
        await expect(run({ action: "details", ndc: "x" })).rejects.toThrow(/INVALID_IDENTIFIER/);
    });
});
