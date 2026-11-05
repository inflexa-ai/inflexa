import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { fixtureCase, readFixture, runFixtureSuite } from "../__fixtures__/fixture-runner.js";
import { giantVersionOf, HumanBaseIntegrationSchema, HumanBaseNetworkSchema, HumanBaseRelevantSchema } from "../humanbase-client.js";
import { presentAt } from "../../../lib/present.js";

runFixtureSuite("humanbase golden fixtures", [
    fixtureCase({
        name: "HumanBaseIntegrationSchema — each row variant of the context list",
        provider: "humanbase",
        fixture: "contexts-excerpt.json",
        drift: "contexts-excerpt.drift.json",
        schema: z.array(HumanBaseIntegrationSchema),
        assertOutput: (rows) => {
            const bySlug = new Map(rows.map((row) => [row.slug, row]));
            // A v1 tissue carries a BRENDA term, a v1 process a GO term.
            expect(bySlug.get("blood")).toEqual({
                slug: "blood",
                title: "blood",
                giantVersion: "v1",
                term: { id: "BTO:0000089", ontology: "BRENDA Ontology" },
            });
            expect(bySlug.get("actin-cytoskeleton-reorganization")?.term).toEqual({ id: "GO:0031532", ontology: "Gene Ontology (BP)" });
            // A v3 context and the two v1 contexts with no term carry an explicit null.
            expect(bySlug.get("blood-v3")).toEqual({ slug: "blood-v3", title: "blood", giantVersion: "v3", term: null });
            expect(bySlug.get("global")?.term).toBeNull();
            expect(bySlug.get("global")?.giantVersion).toBe("v1");
            expect(bySlug.get("epithelial-cell-of-proximal-tubule")?.term).toBeNull();
        },
    }),
    fixtureCase({
        name: "HumanBaseRelevantSchema — the contexts ranked for a gene set",
        provider: "humanbase",
        fixture: "relevant-3553-672.json",
        drift: "relevant-3553-672.drift.json",
        schema: z.array(HumanBaseRelevantSchema),
        assertOutput: (rows) => {
            expect(presentAt(rows, 0).slug).toBe("double-strand-break-repair");
            expect(presentAt(rows, 0).score).toBe(1);
            expect(rows.every((row) => typeof row.score === "number")).toBe(true);
            // The endpoint ranks the v1 contexts only.
            expect(rows.every((row) => row.giantVersion === "v1")).toBe(true);
            expect(rows.find((row) => row.slug === "mononuclear-phagocyte")?.term?.ontology).toBe("BRENDA Ontology");
        },
    }),
    fixtureCase({
        name: "HumanBaseNetworkSchema — a v1 network, with a numeric mincut",
        provider: "humanbase",
        fixture: "network-blood-672.json",
        drift: "network-blood-672.drift.json",
        schema: HumanBaseNetworkSchema,
        assertOutput: (network) => {
            expect(network.mincut).toBeCloseTo(0.1067, 4);
            expect(network.genes).toHaveLength(6);
            expect(network.genes.find((gene) => gene.entrez === 672)).toEqual({
                entrez: 672,
                symbol: "BRCA1",
                description: "BRCA1 DNA repair associated",
                ensembl: "ENSG00000012048",
                hgnc: "HGNC:1100",
                query: true,
            });
            expect(network.genes.filter((gene) => gene.query).map((gene) => gene.entrez)).toEqual([672]);
            // One edge for each gene pair, and each edge index resolves to a symbol.
            expect(network.edges).toHaveLength(15);
            expect(network.edges.every((edge) => edge.geneA !== "" && edge.geneB !== "")).toBe(true);
            const msh = network.edges.find((edge) => edge.geneA === "MSH6" && edge.geneB === "MSH2");
            expect(msh?.weight).toBeCloseTo(0.9853, 4);
        },
    }),
    fixtureCase({
        name: "HumanBaseNetworkSchema — a v3 network, with an explicit null mincut",
        provider: "humanbase",
        fixture: "network-blood-v3-672.json",
        drift: "network-blood-v3-672.drift.json",
        schema: HumanBaseNetworkSchema,
        assertOutput: (network) => {
            expect(network.mincut).toBeNull();
            expect(network.genes.map((gene) => gene.symbol)).toEqual(["BRCA1", "EZH2", "TMPO", "KIF18A"]);
            expect(network.edges).toHaveLength(6);
            expect(presentAt(network.edges, 0)).toEqual({ geneA: "BRCA1", geneB: "TMPO", weight: 0.999976 });
        },
    }),
]);

describe("HumanBaseNetworkSchema — the edge indices", () => {
    it("rejects an edge that names a gene index outside genes", () => {
        const network = z.looseObject({ genes: z.array(z.json()), edges: z.array(z.json()) }).parse(readFixture("humanbase", "network-blood-v3-672.json"));
        const broken = { ...network, edges: [...network.edges, { id: 99, source: 0, target: network.genes.length, weight: 0.5 }] };

        expect(HumanBaseNetworkSchema.safeParse(broken).success).toBe(false);
    });
});

describe("giantVersionOf", () => {
    it("reads the GIANT version from the slug suffix", () => {
        expect(giantVersionOf("blood-v3")).toBe("v3");
        expect(giantVersionOf("blood")).toBe("v1");
        expect(giantVersionOf("global")).toBe("v1");
    });

    it("agrees with the version of each context of the excerpt", () => {
        const rows = z
            .array(z.object({ slug: z.string(), context: z.object({ version: z.object({ identifier: z.string() }).nullable() }) }))
            .parse(readFixture("humanbase", "contexts-excerpt.json"));

        for (const row of rows) {
            expect(giantVersionOf(row.slug)).toBe(row.context.version === null ? "v1" : "v3");
        }
    });
});
