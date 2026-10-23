import { expect } from "bun:test";
import { z } from "zod";

import { fixtureCase, runFixtureSuite } from "../__fixtures__/fixture-runner.js";
import { AlphaFoldPredictionSchema } from "../alphafold-client.js";

runFixtureSuite("AlphaFold DB golden fixtures", [
    fixtureCase({
        name: "AlphaFoldPredictionSchema (single-entry response, canonical accession)",
        provider: "alphafold",
        fixture: "prediction-P69905.json",
        drift: "prediction-P69905.drift.json",
        schema: z.array(AlphaFoldPredictionSchema),
        assertOutput: (entries) => {
            expect(entries).toHaveLength(1);
            const entry = entries[0]!;
            expect(entry.uniprotAccession).toBe("P69905");
            expect(entry.globalMetricValue).toBe(98.06);
            expect(entry.plddtDocUrl).toBe("https://alphafold.ebi.ac.uk/files/AF-P69905-F1-confidence_v6.json");
            expect(entry.amAnnotationsUrl).toBe("https://alphafold.ebi.ac.uk/files/AF-P69905-F1-aa-substitutions.csv");
        },
    }),
    fixtureCase({
        name: "AlphaFoldPredictionSchema (multi-isoform response)",
        provider: "alphafold",
        fixture: "prediction-P38398.json",
        drift: "prediction-P38398.drift.json",
        schema: z.array(AlphaFoldPredictionSchema),
        assertOutput: (entries) => {
            expect(entries).toHaveLength(2);
            expect(entries[0]!.uniprotAccession).toBe("P38398");
            expect(entries[1]!.uniprotAccession).toBe("P38398-8");
            // The wire omits `amAnnotationsUrl` for a non-canonical isoform entry.
            expect(entries[1]!.amAnnotationsUrl).toBeUndefined();
        },
    }),
]);
