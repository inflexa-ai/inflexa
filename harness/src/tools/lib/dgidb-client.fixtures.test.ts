import { afterEach, describe, expect, it } from "bun:test";

import { fixtureCase, readFixture, runFixtureSuite } from "./__fixtures__/fixture-runner.js";
import { DgidbResponseSchema, searchDgidb } from "./dgidb-client.js";

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

/** Answer every request with the given payload. */
function stubFetch(body: unknown): void {
    globalThis.fetch = (async () =>
        new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

runFixtureSuite("dgidb golden fixtures", [
    fixtureCase({
        name: "DgidbResponseSchema — gene interactions",
        provider: "dgidb",
        fixture: "gene-egfr-interactions.json",
        drift: "gene-egfr-interactions.drift.json",
        schema: DgidbResponseSchema,
        assertOutput: (body) => {
            const nodes = body.data?.genes?.nodes ?? [];
            expect(nodes).toHaveLength(1);
            const node = nodes[0]!;
            expect(node!.name).toBe("EGFR");

            const types = (node!.interactions ?? []).flatMap((i) => i.interactionTypes ?? []);
            // GraphQL answers a nullable enum with an explicit null, thus the
            // fixture carries rows that a bare `.optional()` would reject.
            expect(types.filter((t) => t.directionality === null).length).toBeGreaterThan(0);
            expect(types.filter((t) => t.directionality === "INHIBITORY").length).toBeGreaterThan(0);
        },
    }),
    fixtureCase({
        name: "DgidbResponseSchema — the error envelope",
        provider: "dgidb",
        fixture: "graphql-error-envelope.json",
        drift: "graphql-error-envelope.drift.json",
        schema: DgidbResponseSchema,
        assertOutput: (body) => {
            // A document-validation error answers HTTP 200 with `errors` and no
            // `data` key. The client turns that into a throw, not into a result.
            expect(body.data).toBeUndefined();
            expect(body.errors?.[0]?.message).toContain("bogusField");
        },
    }),
]);

describe("the DGIdb client over the golden fixture", () => {
    it("keeps a row whose directionality is null", async () => {
        stubFetch(readFixture("dgidb", "gene-egfr-interactions.json"));

        const results = await searchDgidb(["EGFR"], "gene", { limit: 20 });

        const interactions = results[0]!.interactions;
        expect(results[0]!.found).toBe(true);
        expect(interactions).toHaveLength(6);
        const modulator = interactions.find((i) => i.interactionTypes.some((t) => t.type === "modulator"));
        expect(modulator).toBeDefined();
        expect(modulator!.interactionTypes[0]!.directionality).toBeUndefined();
    });

    it("skips a node whose name is null, and keeps the rest", async () => {
        // `Gene.name` is nullable in the SDL. A null-named node must not reject the
        // whole response, and it carries no key that an input can match.
        stubFetch({
            data: { genes: { nodes: [null, { name: null, interactions: [] }, { name: "EGFR", interactions: [] }] } },
        });

        const results = await searchDgidb(["EGFR", "BRAF"], "gene", {});

        expect(results.map((r) => r.found)).toEqual([true, false]);
    });
});
