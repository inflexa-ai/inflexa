import { expect } from "bun:test";
import { z } from "zod";

import { fixtureCase, runFixtureSuite } from "../__fixtures__/fixture-runner.js";
import { MyGeneBatchRowSchema, type MyGeneHit, type MyGeneRow } from "../mygene-client.js";

function hitsFor(rows: MyGeneRow[], query: string): MyGeneHit[] {
    return rows.flatMap((row) => (row.kind === "hit" && row.hit.query === query ? [row.hit] : []));
}

function onlyHit(rows: MyGeneRow[], query: string): MyGeneHit {
    const hits = hitsFor(rows, query);
    expect(hits).toHaveLength(1);
    const [hit] = hits;
    if (hit === undefined) throw new Error(`no hit for ${query}`);
    return hit;
}

runFixtureSuite("mygene golden fixtures", [
    fixtureCase({
        name: "MyGeneBatchRowSchema — a mixed batch with each row variant",
        provider: "mygene",
        fixture: "batch-mixed.json",
        drift: "batch-mixed.drift.json",
        schema: z.array(MyGeneBatchRowSchema),
        assertOutput: (rows) => {
            // A symbol, an Entrez ID, and a UniProt-free gene each map to one hit, and `entrezgene` arrives as a string.
            expect(onlyHit(rows, "BRCA1")).toEqual({
                query: "BRCA1",
                symbol: "BRCA1",
                name: "BRCA1 DNA repair associated",
                entrez: 672,
                ensembl: ["ENSG00000012048"],
                uniprot: ["P38398"],
            });
            expect(onlyHit(rows, "672").symbol).toBe("BRCA1");
            expect(onlyHit(rows, "ENSG00000141510").entrez).toBe(7157);
            // A miss is a row of its own, not a dropped query.
            expect(rows).toContainEqual({ kind: "miss", query: "NOTAGENE123" });
            // `ensembl` and `Swiss-Prot` arrive as one value or as an array, and both map to an array.
            expect(onlyHit(rows, "HLA-A").ensembl.length).toBeGreaterThan(1);
            expect(onlyHit(rows, "CDKN2A").uniprot).toEqual(["P42771", "Q8N726"]);
            // An omitted key maps to an empty array or to null.
            expect(onlyHit(rows, "MIR21").uniprot).toEqual([]);
            expect(onlyHit(rows, "LOC100128288").ensembl).toEqual([]);
            expect(onlyHit(rows, "ENSG00000235872")).toEqual({
                query: "ENSG00000235872",
                symbol: null,
                name: null,
                entrez: null,
                ensembl: ["ENSG00000235872"],
                uniprot: [],
            });
            // A UniProt accession that a gene family shares gives each member.
            expect(hitsFor(rows, "P62805").length).toBeGreaterThan(1);
        },
    }),
]);
