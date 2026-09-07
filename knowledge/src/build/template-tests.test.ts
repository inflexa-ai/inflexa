import { describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkExpectation, datasetPresent } from "./template-tests.js";

const TRUTH = ['"gene","de","lfc","planted_set"', '"G1",1,1.2,"HALLMARK_X"', '"G2",0,0,"ISOFORM_SWITCH"', '"G3",0,0,"ISOFORM_SWITCH"', '"G4",0,0,"ISOFORM_SWITCH"', '"G5",0,0,"ISOFORM_SWITCH"', '"G6",0,0,""'].join("\n");

const RESULTS = ['"gene","log2_fold_change","adjusted_pvalue"', '"G1",1.1,0.001', '"G2",0.9,0.01', '"G3",0.2,0.4', '"G4",-0.1,NA', '"G5",0.3,0.2', '"G6",0.0,0.9'].join("\n");

async function fixture(truth: string): Promise<{ dataDir: string; stepDir: string }> {
    const root = await mkdtemp(join(tmpdir(), "inflexa-tpl-test-"));
    const dataDir = join(root, "data");
    const stepDir = join(root, "step");
    await mkdir(join(stepDir, "output"), { recursive: true });
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, "truth.csv"), truth);
    await writeFile(join(stepDir, "output", "de_results.csv"), RESULTS);
    return { dataDir, stepDir };
}

describe("truth_switch_calls", () => {
    it("measures the share of the ISOFORM_SWITCH genes called at adjusted_pvalue < 0.05", async () => {
        const { dataDir, stepDir } = await fixture(TRUTH);
        try {
            const low = await checkExpectation("truth_switch_calls output/de_results.csv <= 0.05", stepDir, dataDir);
            expect(low.ok).toBe(false);
            expect(low.detail).toContain("truth_switch_calls = 0.250");
            expect(low.detail).toContain("1/4 switch genes called");
            const high = await checkExpectation("truth_switch_calls output/de_results.csv >= 0.25", stepDir, dataDir);
            expect(high.ok).toBe(true);
        } finally {
            await rm(join(dataDir, ".."), { recursive: true, force: true });
        }
    });

    it("counts a DE gene and an unplanted gene as neither switch nor call", async () => {
        const { dataDir, stepDir } = await fixture(TRUTH);
        try {
            // G1 (DE, called) and G6 (unplanted) do not enter the share: 1 of 4, not 2 of 6.
            const result = await checkExpectation("truth_switch_calls output/de_results.csv == 0.25", stepDir, dataDir);
            expect(result.ok).toBe(true);
        } finally {
            await rm(join(dataDir, ".."), { recursive: true, force: true });
        }
    });

    it("fails on a truth without an ISOFORM_SWITCH gene instead of a vacuous pass", async () => {
        const { dataDir, stepDir } = await fixture(['"gene","de","lfc","planted_set"', '"G1",1,1.2,""', '"G2",0,0,""'].join("\n"));
        try {
            const result = await checkExpectation("truth_switch_calls output/de_results.csv <= 0.05", stepDir, dataDir);
            expect(result.ok).toBe(false);
            expect(result.detail).toContain("no ISOFORM_SWITCH gene");
        } finally {
            await rm(join(dataDir, ".."), { recursive: true, force: true });
        }
    });
});

describe("datasetPresent", () => {
    it("accepts counts.csv, a quant/ directory beside it, and nothing else", async () => {
        const root = await mkdtemp(join(tmpdir(), "inflexa-tpl-data-"));
        try {
            const empty = join(root, "empty");
            await mkdir(empty);
            expect(await datasetPresent(empty)).toBe(false);
            expect(await datasetPresent(join(root, "absent"))).toBe(false);

            const counts = join(root, "counts");
            await mkdir(counts);
            await writeFile(join(counts, "counts.csv"), "gene,s1\nG1,1\n");
            expect(await datasetPresent(counts)).toBe(true);

            const quant = join(root, "quant-only");
            await mkdir(join(quant, "quant", "sample_01"), { recursive: true });
            await writeFile(join(quant, "quant", "sample_01", "quant.sf"), "Name\tLength\tEffectiveLength\tTPM\tNumReads\n");
            expect(await datasetPresent(quant)).toBe(true);

            // A file named quant is not a quantification tree.
            const file = join(root, "quant-file");
            await mkdir(file);
            await writeFile(join(file, "quant"), "");
            expect(await datasetPresent(file)).toBe(false);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
