import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseTSV } from "./api-utils.js";
import { fixtureCase, runFixtureSuite } from "./__fixtures__/fixture-runner.js";
import {
    keggPathwaysForGene,
    parseKeggPathwayLinks,
    ReactomeParticipantEntitiesSchema,
    ReactomeParticipantsSchema,
    ReactomeSearchResponseSchema,
    selectKeggGeneId,
} from "./pathway-client.js";

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

const FIXTURES_DIR = fileURLToPath(new URL("./__fixtures__/", import.meta.url));

/** KEGG answers text, not JSON, thus a KEGG fixture is read as raw text. */
function readTextFixture(provider: string, file: string): string {
    return readFileSync(join(FIXTURES_DIR, provider, file), "utf8");
}

describe("KEGG golden fixtures", () => {
    it("gives an empty body when a gene symbol goes to find/pathway", () => {
        // `find/pathway/{query}` matches a pathway NAME. A gene symbol matches
        // nothing, thus the old membership route contributed zero KEGG rows.
        const body = readTextFixture("kegg", "find-pathway-TP53.txt");
        expect(parseTSV(body)).toHaveLength(0);
    });

    it("resolves the gene identifier by an exact alias match, not by rank", () => {
        const rows = parseTSV(readTextFixture("kegg", "find-hsa-TP53.txt"));
        // The provider ranks `TP53BP2` first, thus the first row is a different gene.
        expect(rows[0]![0]).toBe("hsa:7159");
        expect(selectKeggGeneId(rows, "TP53")).toBe("hsa:7157");
        expect(selectKeggGeneId(rows, "tp53")).toBe("hsa:7157");
    });

    it("answers null when no row carries the exact symbol", () => {
        const rows = parseTSV(readTextFixture("kegg", "find-hsa-TP53.drift.txt"));
        expect(rows.length).toBeGreaterThan(0);
        expect(selectKeggGeneId(rows, "TP53")).toBeNull();
    });

    it("reads the pathway identifiers of a gene without the path prefix", () => {
        const ids = parseKeggPathwayLinks(parseTSV(readTextFixture("kegg", "link-pathway-hsa7157.txt")));
        expect(ids.length).toBeGreaterThan(20);
        expect(ids).toContain("hsa04010");
        expect(ids.some((id) => id.startsWith("path:"))).toBe(false);
    });

    it("names a pathway from the organism list", () => {
        const names = new Map(parseTSV(readTextFixture("kegg", "list-pathway-hsa.txt")).map((cols) => [cols[0]!, cols[1]!]));
        expect(names.get("hsa04010")).toBe("MAPK signaling pathway - Homo sapiens (human)");
    });

    it("gives the pathway memberships of a gene over the three golden bodies", async () => {
        const seen: string[] = [];
        globalThis.fetch = (async (input: unknown) => {
            const url = String(input);
            seen.push(url);
            if (url.includes("/find/hsa/")) return new Response(readTextFixture("kegg", "find-hsa-TP53.txt"));
            if (url.includes("/link/pathway/")) return new Response(readTextFixture("kegg", "link-pathway-hsa7157.txt"));
            if (url.includes("/list/pathway/")) return new Response(readTextFixture("kegg", "list-pathway-hsa.txt"));
            return new Response("unrouted", { status: 404 });
        }) as unknown as typeof fetch;

        const pathways = await keggPathwaysForGene("TP53", "hsa", 25);

        expect(seen[0]).toBe("https://rest.kegg.jp/find/hsa/TP53");
        expect(seen[1]).toBe("https://rest.kegg.jp/link/pathway/hsa%3A7157");
        const mapk = pathways.find((pw) => pw.id === "hsa04010");
        expect(mapk).toMatchObject({
            id: "hsa04010",
            name: "MAPK signaling pathway - Homo sapiens (human)",
            source: "kegg",
            url: "https://www.kegg.jp/pathway/hsa04010",
        });
        // The list fixture names nine pathways, and the gene links more. An
        // unnamed identifier stays its own label rather than dropping out.
        expect(pathways.length).toBeGreaterThan(9);
        expect(pathways.every((pw) => pw.name !== "")).toBe(true);
    });
});

runFixtureSuite("Reactome golden fixtures", [
    fixtureCase({
        name: "ReactomeSearchResponseSchema",
        provider: "reactome",
        fixture: "search-query-TP53.json",
        drift: "search-query-TP53.drift.json",
        schema: ReactomeSearchResponseSchema,
        assertOutput: (response) => {
            const entry = response.results?.[0]?.entries?.[0];
            expect(entry?.stId).toBe("R-HSA-5633007");
            // A search hit carries the query inside `<span class="highlighting">`.
            expect(entry?.name).toContain('<span class="highlighting"');
        },
    }),
    fixtureCase({
        name: "ReactomeParticipantsSchema",
        provider: "reactome",
        fixture: "data-participants.json",
        drift: "data-participants.drift.json",
        schema: ReactomeParticipantsSchema,
        assertOutput: (participants) => {
            expect(participants[0]!.displayName).toBe("p-T389/412-RPS6KB1 [cytosol]");
        },
    }),
    fixtureCase({
        name: "ReactomeParticipantEntitiesSchema",
        provider: "reactome",
        fixture: "data-participants.json",
        drift: "data-participants-entities.drift.json",
        schema: ReactomeParticipantEntitiesSchema,
        assertOutput: (participants) => {
            const refs = participants.flatMap((p) => p.refEntities ?? []);
            expect(refs.length).toBeGreaterThan(0);
            expect(refs.some((r) => r.identifier === "P23443-1")).toBe(true);
        },
    }),
]);
