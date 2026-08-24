/**
 * The readout budget is what keeps enrichment off a per-file cost. These assert the
 * selection it produces over synthetic trees: one representative per set, a bounded
 * number of leftovers, and a count of what the bound left out.
 */

import { describe, expect, it } from "bun:test";

import { detectSets } from "./detect-sets.js";
import { MAX_LEFTOVER_READOUTS, readoutTargets, selectReadouts } from "./readout-budget.js";
import type { MemberFile } from "./set-types.js";
import type { ScannedFile } from "./types.js";

function file(path: string, format: string, extensions: string[] = []): ScannedFile {
    return { path, size: 100, extensions, format };
}

function leftover(path: string): MemberFile {
    return { path, name: path.slice(path.lastIndexOf("/") + 1), size: 100, format: "text", companions: [] };
}

describe("the leftover readout budget", () => {
    it("takes every leftover while they fit under the bound, and elides none", () => {
        const selection = selectReadouts([], [leftover("data/inputs/a.txt"), leftover("data/inputs/b.txt")]);

        expect(selection.individual).toEqual(["data/inputs/a.txt", "data/inputs/b.txt"]);
        expect(selection.individualElided).toBe(0);
    });

    it("caps the leftovers it opens and reports how many it left", () => {
        const many = Array.from({ length: MAX_LEFTOVER_READOUTS + 9 }, (_, i) => leftover(`data/inputs/one-off-${String(i).padStart(3, "0")}.txt`));
        const selection = selectReadouts([], many);

        expect(selection.individual).toHaveLength(MAX_LEFTOVER_READOUTS);
        expect(selection.individualElided).toBe(9);
        expect(selection.individual[0]).toBe("data/inputs/one-off-000.txt");
    });

    it("names one member per set plus the leftovers that fit, and nothing else", () => {
        const files = [
            ...Array.from({ length: 40 }, (_, i) => file(`data/inputs/calls/S${String(i + 1).padStart(3, "0")}.vcf`, "vcf", ["vcf"])),
            file("data/inputs/meta/samplesheet.csv", "csv", ["csv"]),
            file("data/inputs/README.md", "markdown", ["md"]),
        ];
        const targets = readoutTargets(detectSets(files));

        expect(targets.map((target) => target.path).sort()).toEqual([
            "data/inputs/README.md",
            "data/inputs/calls/S001.vcf",
            "data/inputs/meta/samplesheet.csv",
        ]);
    });
});
