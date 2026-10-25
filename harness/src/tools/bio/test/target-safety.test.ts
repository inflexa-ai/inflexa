import { afterEach, describe, expect, it } from "bun:test";
import { isAllDigits } from "../../../lib/text.js";
import { parseJsonAs } from "../../../lib/parse-json.js";
import { z } from "zod";

/** A `fetch` test double: the callable plus the `preconnect` member that `typeof fetch` carries. */
function fetchDouble(run: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): typeof fetch {
    return Object.assign(run, { preconnect: fetch.preconnect });
}

import { makeToolContext } from "../../__fixtures__/tool-context.js";
import { targetSafetyTool } from "../target-safety.js";
import { presentAt } from "../../../lib/present.js";
import { awaitOk } from "../../../lib/test/result-assert.js";

const GqlVariablesSchema = z.object({ variables: z.record(z.string(), z.unknown()) });

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

function gqlResponse(data: unknown): Response {
    return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
}

/** Record every Open Targets GraphQL call so a test can assert what was queried. */
function stubOpenTargets(responder: () => Response): Record<string, unknown>[] {
    const seen: Record<string, unknown>[] = [];
    globalThis.fetch = fetchDouble((_url: unknown, init?: RequestInit) => {
        seen.push(parseJsonAs(String(init?.body ?? "{}"), GqlVariablesSchema).variables);
        return Promise.resolve(responder());
    });
    return seen;
}

/** A real panel entry — HTR2B is high-severity cardiac and carries an ENSG. */
const HTR2B = { gene: "HTR2B", chembl: "CHEMBL1833", uniprot: "P41595", ensembl: "ENSG00000135914" };

const LIABILITIES = [
    {
        event: "cardiac arrhythmia",
        biosamples: [{ tissueLabel: "heart" }, { tissueLabel: "myocardium" }],
        effects: [{ direction: "activation" }, { direction: "inhibition" }],
        datasource: "AOP-Wiki",
    },
];

function safetyData(symbol: string, liabilities: unknown[] = LIABILITIES) {
    return { target: { id: HTR2B.ensembl, approvedSymbol: symbol, safetyLiabilities: liabilities } };
}

describe("targetSafety — curated panel", () => {
    it("matches a gene symbol and summarizes severity and organ system", async () => {
        const { ctx } = makeToolContext();
        const result = (await targetSafetyTool.execute({ identifiers: [HTR2B.gene], sources: ["panel"] }, ctx))._unsafeUnwrap();

        expect(result.summary.panelMatched).toBe(1);
        expect(result.summary.bySeverity.high).toBe(1);
        expect(result.summary.byOrgan.cardiac).toBe(1);
        expect(presentAt(result.targets, 0).panelEntry?.clinical_consequence).toContain("valvulopathy");
        const versionParts = result.panelVersion.split(".");
        expect(versionParts.length === 3 && versionParts.every((part) => isAllDigits(part))).toBe(true);
    });

    it("detects each identifier shape without being told", async () => {
        const { ctx } = makeToolContext();
        const result = (
            await targetSafetyTool.execute({ identifiers: [HTR2B.gene, HTR2B.chembl, HTR2B.uniprot, HTR2B.ensembl], sources: ["panel"] }, ctx)
        )._unsafeUnwrap();

        expect(result.targets.map((t) => t.identifierType)).toEqual(["gene_symbol", "chembl_id", "uniprot", "ensembl_id"]);
        expect(result.targets.every((t) => t.panelEntry?.gene_symbol === HTR2B.gene)).toBe(true);
    });

    it("reports an unmatched identifier as a null entry, not a dropped row", async () => {
        const { ctx } = makeToolContext();
        const result = (await targetSafetyTool.execute({ identifiers: ["NOTATARGET"], sources: ["panel"] }, ctx))._unsafeUnwrap();

        expect(result.targets).toHaveLength(1);
        expect(presentAt(result.targets, 0).panelEntry).toBeNull();
        expect(result.summary.panelMatched).toBe(0);
    });

    it("filters by organ system and by minimum severity", async () => {
        const { ctx } = makeToolContext();

        const wrongOrgan = (await targetSafetyTool.execute({ identifiers: [HTR2B.gene], sources: ["panel"], filterOrgan: "hepatic" }, ctx))._unsafeUnwrap();
        expect(presentAt(wrongOrgan.targets, 0).panelEntry).toBeNull();

        const highOnly = (await targetSafetyTool.execute({ identifiers: [HTR2B.gene], sources: ["panel"], minSeverity: "high" }, ctx))._unsafeUnwrap();
        expect(presentAt(highOnly.targets, 0).panelEntry).not.toBeNull();
    });
});

describe("targetSafety — Open Targets liabilities", () => {
    it("flattens liabilities to tissues and effect directions", async () => {
        stubOpenTargets(() => gqlResponse(safetyData(HTR2B.gene)));

        const { ctx } = makeToolContext();
        const result = (await targetSafetyTool.execute({ identifiers: [HTR2B.gene], sources: ["opentargets"] }, ctx))._unsafeUnwrap();

        expect(presentAt(result.targets, 0).liabilities).toEqual([
            { event: "cardiac arrhythmia", biosamples: ["heart", "myocardium"], effects: "activation, inhibition", source: "AOP-Wiki" },
        ]);
        expect(result.summary.openTargetsWithLiabilities).toBe(1);
    });

    it("takes the Ensembl id from the panel entry rather than resolving it", async () => {
        const seen = stubOpenTargets(() => gqlResponse(safetyData(HTR2B.gene)));

        const { ctx } = makeToolContext();
        await awaitOk(targetSafetyTool.execute({ identifiers: [HTR2B.gene], sources: ["opentargets"] }, ctx));

        // One call only: the Ensembl resolution round-trip is skipped.
        expect(seen).toEqual([{ ensemblId: HTR2B.ensembl }]);
    });

    it("resolves a gene symbol that is not on the panel", async () => {
        const seen: string[] = [];
        globalThis.fetch = fetchDouble((url: unknown, init?: RequestInit) => {
            const u = String(url);
            seen.push(u);
            if (u.includes("ensembl")) return Promise.resolve(new Response(JSON.stringify({ id: "ENSG00000141510" }), { status: 200 }));
            const body = parseJsonAs(String(init?.body ?? "{}"), GqlVariablesSchema);
            expect(body.variables).toEqual({ ensemblId: "ENSG00000141510" });
            return Promise.resolve(gqlResponse({ target: { id: "ENSG00000141510", approvedSymbol: "TP53", safetyLiabilities: [] } }));
        });

        const { ctx } = makeToolContext();
        const result = (await targetSafetyTool.execute({ identifiers: ["TP53"], sources: ["opentargets"] }, ctx))._unsafeUnwrap();

        expect(seen.some((u) => u.includes("ensembl"))).toBe(true);
        expect(presentAt(result.targets, 0).ensemblId).toBe("ENSG00000141510");
        expect(presentAt(result.targets, 0).liabilities).toEqual([]);
    });

    it("notes an unknown Ensembl id instead of failing (not is_error)", async () => {
        stubOpenTargets(() => gqlResponse({ target: null }));

        const { ctx } = makeToolContext();
        const outcome = await targetSafetyTool.execute({ identifiers: [HTR2B.gene], sources: ["opentargets"] }, ctx);

        expect(outcome.isOk()).toBe(true);
        expect(presentAt(outcome._unsafeUnwrap().targets, 0).opentargetsNote).toContain("no Open Targets record");
    });

    it("skips a ChEMBL identifier that is not on the panel, saying why", async () => {
        stubOpenTargets(() => gqlResponse(safetyData(HTR2B.gene)));

        const { ctx } = makeToolContext();
        const result = (await targetSafetyTool.execute({ identifiers: ["CHEMBL9999999"], sources: ["opentargets"] }, ctx))._unsafeUnwrap();

        expect(presentAt(result.targets, 0).opentargetsNote).toContain("no Ensembl gene id available");
        expect(presentAt(result.targets, 0).liabilities).toBeUndefined();
    });

    it("keeps the panel half when Open Targets is unreachable", async () => {
        globalThis.fetch = fetchDouble(() => Promise.resolve(new Response("upstream down", { status: 500 })));

        const { ctx } = makeToolContext();
        const result = (await targetSafetyTool.execute({ identifiers: [HTR2B.gene] }, ctx))._unsafeUnwrap();

        expect(result.perSource.find((s) => s.source === "panel")).toMatchObject({ status: "ok", matched: 1 });
        expect(result.perSource.find((s) => s.source === "opentargets")).toMatchObject({ status: "unavailable" });
        expect(presentAt(result.targets, 0).panelEntry).not.toBeNull();
    });
});

describe("targetSafety — input validation", () => {
    it("caps the identifier list when Open Targets is included", async () => {
        const many = Array.from({ length: 30 }, (_, i) => `GENE${i}`);

        await expect(targetSafetyTool.inputSchema.parseAsync({ identifiers: many, sources: ["opentargets"] })).rejects.toThrow();
        // The default includes 'opentargets', so an unqualified sweep is capped too.
        await expect(targetSafetyTool.inputSchema.parseAsync({ identifiers: many })).rejects.toThrow();
        // Panel-only sweeps stay wide.
        expect(targetSafetyTool.inputSchema.safeParse({ identifiers: many, sources: ["panel"] }).success).toBe(true);
    });
});
