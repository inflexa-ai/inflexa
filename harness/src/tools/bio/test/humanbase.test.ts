import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { requestUrlText } from "../../../lib/test/request-url.js";
import { presentAt } from "../../../lib/present.js";
import { makeToolContext } from "../../__fixtures__/tool-context.js";
import { readFixture } from "../../lib/__fixtures__/fixture-runner.js";
import { createRunScriptTool } from "../../script/run-script.js";
import { humanbaseTool, type HumanBaseOutput } from "../humanbase.js";

/** A `fetch` test double: the callable plus the `preconnect` member that `typeof fetch` carries. */
function fetchDouble(run: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): typeof fetch {
    return Object.assign(run, { preconnect: fetch.preconnect });
}

const realFetch = globalThis.fetch;

type SentRequest = { url: string; method: string; body: string | undefined };

/** Each request that the tool sent, in call order. */
let requests: SentRequest[] = [];

beforeEach(() => {
    requests = [];
});

afterEach(() => {
    globalThis.fetch = realFetch;
});

function bodyText(init: RequestInit | undefined): string | undefined {
    return typeof init?.body === "string" ? init.body : undefined;
}

/** Answer each request with one status and one body. */
function stubAnswer(status: number, body: unknown): void {
    globalThis.fetch = fetchDouble((input, init) => {
        requests.push({ url: requestUrlText(input), method: init?.method ?? "GET", body: bodyText(init) });
        const text = typeof body === "string" ? body : JSON.stringify(body);
        return Promise.resolve(new Response(text, { status, headers: { "content-type": "application/json" } }));
    });
}

type HumanBaseInput = Parameters<typeof humanbaseTool.execute>[0];

async function callHumanBase(input: HumanBaseInput): Promise<HumanBaseOutput> {
    const { ctx } = makeToolContext();
    return (await humanbaseTool.execute(input, ctx))._unsafeUnwrap();
}

function onlyRequest(): SentRequest {
    expect(requests).toHaveLength(1);
    return presentAt(requests, 0);
}

const NOT_FOUND = { detail: "Not found." };

describe("humanbase — action: network", () => {
    it("returns the subnetwork, weight-sorted, with the true edge count", async () => {
        stubAnswer(200, readFixture("humanbase", "network-blood-672.json"));

        const out = await callHumanBase({ action: "network", entrez: [672], context: "blood", limit: 3 });

        if (!("found" in out) || !out.found) throw new Error(`expected a found network, got ${JSON.stringify(out)}`);
        expect(out.context).toBe("blood");
        expect(out.giantVersion).toBe("v1");
        expect(out.genes).toHaveLength(6);
        expect(out.edges).toHaveLength(3);
        expect(out.totalEdges).toBe(15);
        expect(presentAt(out.edges, 0)).toEqual({ geneA: "MSH6", geneB: "MSH2", weight: 0.9853352847807836 });
        expect(out.edges.map((edge) => edge.weight)).toEqual([...out.edges.map((edge) => edge.weight)].sort((a, b) => b - a));
        expect(out.notFound).toEqual([]);
    });

    it("sends each Entrez ID as a repeated parameter, the default node size, and the v1 version of a plain slug", async () => {
        stubAnswer(200, readFixture("humanbase", "network-blood-672.json"));

        await callHumanBase({ action: "network", entrez: [672, 3553], context: "blood" });

        expect(onlyRequest().url).toBe("https://hb.flatironinstitute.org/api/integrations/blood/network/?entrez=672&entrez=3553&node_size=10&giant_version=v1");
    });

    it("derives the v3 version from a '-v3' slug, and passes the explicit null mincut through", async () => {
        stubAnswer(200, readFixture("humanbase", "network-blood-v3-672.json"));

        const out = await callHumanBase({ action: "network", entrez: [672], context: "blood-v3", nodeSize: 3 });

        expect(onlyRequest().url).toBe("https://hb.flatironinstitute.org/api/integrations/blood-v3/network/?entrez=672&node_size=3&giant_version=v3");
        if (!("found" in out) || !out.found) throw new Error(`expected a found network, got ${JSON.stringify(out)}`);
        expect(out.giantVersion).toBe("v3");
        expect(out.mincut).toBeNull();
    });

    it("lists a query ID that the answer does not hold in notFound", async () => {
        stubAnswer(200, readFixture("humanbase", "network-blood-672.json"));

        const out = await callHumanBase({ action: "network", entrez: [672, 999999999], context: "blood" });

        if (!("found" in out) || !out.found) throw new Error(`expected a found network, got ${JSON.stringify(out)}`);
        expect(out.notFound).toEqual([999999999]);
    });

    it("returns found: false for a 404, not an error", async () => {
        stubAnswer(404, NOT_FOUND);

        expect(await callHumanBase({ action: "network", entrez: [999999999], context: "blood" })).toEqual({ found: false, context: "blood" });
    });

    it("throws on a 400, because a refused request is not an absence", async () => {
        stubAnswer(400, { entrez: "Network queries are limited to 30 genes." });
        const { ctx } = makeToolContext();

        await expect(humanbaseTool.execute({ action: "network", entrez: [672], context: "blood" }, ctx)).rejects.toThrow("limited to 30 genes");
    });
});

describe("humanbase — action: relevant", () => {
    it("returns the contexts best first, trimmed to limit, with the true count", async () => {
        stubAnswer(200, readFixture("humanbase", "relevant-3553-672.json"));

        const out = await callHumanBase({ action: "relevant", entrez: [3553, 672], limit: 2 });

        if (!("contexts" in out)) throw new Error(`expected a context list, got ${JSON.stringify(out)}`);
        expect(out.totalFound).toBe(5);
        expect(out.contexts).toHaveLength(2);
        expect(presentAt(out.contexts, 0)).toMatchObject({ slug: "double-strand-break-repair", giantVersion: "v1", score: 1 });
    });

    it("posts the Entrez IDs as JSON strings, because the endpoint answers a JSON number with a 500", async () => {
        stubAnswer(200, readFixture("humanbase", "relevant-3553-672.json"));

        await callHumanBase({ action: "relevant", entrez: [3553, 672] });

        expect(onlyRequest()).toEqual({
            url: "https://hb.flatironinstitute.org/api/integrations/relevant/",
            method: "POST",
            body: '{"entrez":["3553","672"]}',
        });
    });

    it("returns an empty list for a gene set that HumanBase does not know", async () => {
        stubAnswer(200, []);

        expect(await callHumanBase({ action: "relevant", entrez: [999999999] })).toEqual({ contexts: [], totalFound: 0 });
    });

    it("returns an empty list for a 404, not an error", async () => {
        stubAnswer(404, NOT_FOUND);

        expect(await callHumanBase({ action: "relevant", entrez: [999999999] })).toEqual({ contexts: [], totalFound: 0 });
    });
});

describe("humanbase — action: contexts", () => {
    it("filters the list by a substring of the slug or the title", async () => {
        stubAnswer(200, readFixture("humanbase", "contexts-excerpt.json"));

        const out = await callHumanBase({ action: "contexts", query: "LIVER" });

        if (!("contexts" in out)) throw new Error(`expected a context list, got ${JSON.stringify(out)}`);
        expect(out.contexts.map((context) => context.slug)).toEqual(["liver", "liver-v3"]);
        expect(out.totalFound).toBe(2);
        expect(onlyRequest().url).toBe("https://hb.flatironinstitute.org/api/integrations/");
    });

    it("trims the unfiltered list to limit and reports the true count", async () => {
        stubAnswer(200, readFixture("humanbase", "contexts-excerpt.json"));

        const out = await callHumanBase({ action: "contexts", limit: 3 });

        if (!("contexts" in out)) throw new Error(`expected a context list, got ${JSON.stringify(out)}`);
        expect(out.contexts).toHaveLength(3);
        expect(out.totalFound).toBe(8);
    });

    it("returns an empty list when no context matches", async () => {
        stubAnswer(200, readFixture("humanbase", "contexts-excerpt.json"));

        expect(await callHumanBase({ action: "contexts", query: "no-such-context" })).toEqual({ contexts: [], totalFound: 0 });
    });
});

describe("humanbase — an unexpected failure", () => {
    it("makes execute throw on a 5xx", async () => {
        stubAnswer(500, "<h1>Server Error (500)</h1>");
        const { ctx } = makeToolContext();

        await expect(humanbaseTool.execute({ action: "contexts" }, ctx)).rejects.toThrow("HTTP 500");
    });
});

describe("humanbase — the input schema", () => {
    it("emits a top-level object schema", () => {
        expect(humanbaseTool.jsonSchema.type).toBe("object");
    });

    it.each([
        [{ action: "network", context: "blood" }, "entrez"],
        [{ action: "relevant" }, "entrez"],
        [{ action: "network", entrez: [672] }, "context"],
        [{ action: "network", entrez: Array.from({ length: 31 }, (_, i) => i + 1), context: "blood" }, "at most 30"],
        [{ action: "contexts", entrez: [672] }, "entrez does not apply"],
        [{ action: "relevant", entrez: [672], context: "blood" }, "network' only"],
        [{ action: "network", entrez: [672], context: "blood", query: "liver" }, "contexts' only"],
    ])("refuses %j", (input, message) => {
        const parsed = humanbaseTool.inputSchema.safeParse(input);

        expect(parsed.success).toBe(false);
        expect(JSON.stringify(parsed.error?.issues)).toContain(message);
    });

    it("accepts 30 Entrez IDs for 'network' and more for 'relevant'", () => {
        const thirty = Array.from({ length: 30 }, (_, i) => i + 1);

        expect(humanbaseTool.inputSchema.safeParse({ action: "network", entrez: thirty, context: "blood" }).success).toBe(true);
        expect(humanbaseTool.inputSchema.safeParse({ action: "relevant", entrez: [...thirty, 31] }).success).toBe(true);
    });
});

describe("humanbase — describeCall", () => {
    it("names the context and the genes of a network call", () => {
        expect(humanbaseTool.describeCall?.({ action: "network", context: "blood", entrez: [672, 3553] })).toBe("network blood: 672, 3553");
    });

    it("names the genes of a relevant call, and summarizes a large set", () => {
        expect(humanbaseTool.describeCall?.({ action: "relevant", entrez: [672] })).toBe("relevant: 672");
        expect(humanbaseTool.describeCall?.({ action: "relevant", entrez: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] })).toBe(
            "relevant: 10 genes: 1, 2, 3, 4, 5, 6, 7, 8, …",
        );
    });

    it("names the filter of a contexts call", () => {
        expect(humanbaseTool.describeCall?.({ action: "contexts", query: "liver" })).toBe("contexts liver");
        expect(humanbaseTool.describeCall?.({ action: "contexts" })).toBe("contexts");
    });
});

describe("humanbase — the result type in a script", () => {
    it("gives an ok value of each action that the output schema accepts", async () => {
        const outputs: HumanBaseOutput[] = [];
        stubAnswer(200, readFixture("humanbase", "network-blood-672.json"));
        outputs.push(await callHumanBase({ action: "network", entrez: [672], context: "blood" }));
        stubAnswer(404, NOT_FOUND);
        outputs.push(await callHumanBase({ action: "network", entrez: [999999999], context: "blood" }));
        stubAnswer(200, readFixture("humanbase", "relevant-3553-672.json"));
        outputs.push(await callHumanBase({ action: "relevant", entrez: [3553, 672] }));
        stubAnswer(200, readFixture("humanbase", "contexts-excerpt.json"));
        outputs.push(await callHumanBase({ action: "contexts" }));

        for (const out of outputs) {
            expect(humanbaseTool.outputSchema?.safeParse(out).success, JSON.stringify(out).slice(0, 200)).toBe(true);
        }
    });

    it("shows the whole result type in the catalog of run_script, the full name of a gene included", () => {
        const catalog = createRunScriptTool([humanbaseTool]).description;
        const entry = catalog.slice(catalog.indexOf("humanbase(args:"));

        expect(entry).not.toContain("Promise<unknown>");
        expect(entry).toContain("edges: Array<{ geneA: string; geneB: string; weight: number; }>");
        expect(entry).toContain("name: string;");
        expect(entry).toContain("score: number;");
    });
});
