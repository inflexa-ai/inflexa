import { describe, expect, test } from "bun:test";

import { alphafoldEntryUrl, alphafoldPredictionUrl, parseStructureUrl } from "./structure-source.js";

describe("parseStructureUrl — the one grammar that admits a structure card source", () => {
    test("admits an AlphaFold PDB file and derives the accession, version and format", () => {
        expect(parseStructureUrl("https://alphafold.ebi.ac.uk/files/AF-P69905-F1-model_v6.pdb")).toEqual({
            provider: "alphafold",
            accession: "P69905",
            version: 6,
            format: "pdb",
            url: "https://alphafold.ebi.ac.uk/files/AF-P69905-F1-model_v6.pdb",
        });
    });

    test("admits the mmCIF sibling with format mmcif", () => {
        const source = parseStructureUrl("https://alphafold.ebi.ac.uk/files/AF-P69905-F1-model_v6.cif");
        expect(source?.format).toBe("mmcif");
        expect(source?.accession).toBe("P69905");
        expect(source?.version).toBe(6);
    });

    test("admits an isoform accession", () => {
        expect(parseStructureUrl("https://alphafold.ebi.ac.uk/files/AF-P38398-2-F1-model_v6.cif")?.accession).toBe("P38398-2");
    });

    test("refuses the same host outside the file grammar", () => {
        for (const url of [
            "https://alphafold.ebi.ac.uk/api/prediction/P38398",
            "https://alphafold.ebi.ac.uk/files/AF-P38398-F1-predicted_aligned_error_v6.png",
            "https://alphafold.ebi.ac.uk/files/AF-P38398-F1-model_v6.bcif",
            "https://alphafold.ebi.ac.uk/files/AF-P38398-F1-model_v6.pdb?download=1",
            "https://alphafold.ebi.ac.uk/files/AF-P38398-F1-model_v6.pdb#frag",
            "https://alphafold.ebi.ac.uk/files/../api/prediction/P38398",
            "https://alphafold.ebi.ac.uk/entry/P38398",
        ]) {
            expect(parseStructureUrl(url)).toBeNull();
        }
    });

    test("refuses a different scheme, host, or credential", () => {
        for (const url of [
            "http://alphafold.ebi.ac.uk/files/AF-P38398-F1-model_v6.pdb",
            "https://files.rcsb.org/download/1YCR.cif",
            "https://alphafold.ebi.ac.uk.evil.example/files/AF-P38398-F1-model_v6.pdb",
            "https://user:pw@alphafold.ebi.ac.uk/files/AF-P38398-F1-model_v6.pdb",
            "https://alphafold.ebi.ac.uk:8443/files/AF-P38398-F1-model_v6.pdb",
            "not a url",
            "",
        ]) {
            expect(parseStructureUrl(url)).toBeNull();
        }
    });
});

describe("derived AlphaFold URLs", () => {
    test("the entry page and the prediction endpoint derive from the accession", () => {
        expect(alphafoldEntryUrl("P38398")).toBe("https://alphafold.ebi.ac.uk/entry/P38398");
        expect(alphafoldPredictionUrl("P38398-2")).toBe("https://alphafold.ebi.ac.uk/api/prediction/P38398-2");
    });
});
