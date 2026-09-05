import { describe, expect, it } from "bun:test";

import type { Template } from "../model.js";
import { matchEnvironment } from "./environment.js";
import { bodySlotNames, renderTemplate, unmarkedAdaptableSlots } from "./render.js";

const TEMPLATE: Template = {
    id: "tpl-x",
    version: "1.0.0",
    label: "x",
    language: "R",
    method: "M-0001",
    step_types: ["differential_expression"],
    license: "Apache-2.0",
    applicability: { modality: "bulk_rna_seq" },
    parameters: [
        { name: "design", type: "formula", description: "d", adaptable: true },
        { name: "contrast", type: "string_list", description: "c", adaptable: true },
        { name: "alpha", type: "number", description: "a", adaptable: false, default: 0.05, default_source: "doi:x" },
        { name: "min_count", type: "integer", description: "m", adaptable: true, default: 10, default_source: "doi:y", minimum: 1 },
        { name: "shrink", type: "string", description: "s", adaptable: true, default: "apeglm", enum: ["apeglm", "ashr"] },
        { name: "batch", type: "string", description: "b", adaptable: true, required: false },
    ],
    outputs: [{ name: "de", path: "output/de.csv" }],
    environment: [{ name: "DESeq2", version: "1.52.0", track: "bioconductor" }],
    bioconductor: "3.23",
    body_file: "body.R",
};

const BODY = [
    "design <- {{design}}  # [adaptable: design]",
    "contrast <- {{contrast}}  # [adaptable: contrast]",
    "alpha <- {{alpha}}",
    "min_count <- {{min_count}}  # [adaptable: min_count]",
    'shrink <- {{shrink}}  # [adaptable: shrink]',
    "{{#if batch}}batch <- {{batch}}  # [adaptable: batch]{{/if}}",
    "{{#unless batch}}batch <- NULL{{/unless}}",
].join("\n");

describe("renderTemplate", () => {
    it("renders literals by slot type and reports each slot with its source", () => {
        const result = renderTemplate(TEMPLATE, BODY, { design: "~ condition", contrast: ["condition", "treated", "control"] });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.script).toContain("design <- ~ condition");
        expect(result.script).toContain('contrast <- c("condition", "treated", "control")');
        expect(result.script).toContain("alpha <- 0.05");
        expect(result.script).toContain('shrink <- "apeglm"');
        expect(result.script).toContain("batch <- NULL");
        expect(result.script).not.toContain("{{");
        const alpha = result.slots.find((s) => s.name === "alpha")!;
        expect(alpha).toMatchObject({ source: "default", adaptable: false, default_source: "doi:x", lines: [3] });
        expect(result.slots.find((s) => s.name === "design")).toMatchObject({ source: "caller", lines: [1] });
    });

    it("refuses an unknown slot, a pinned slot, a bad enum, and a bad formula, and names the permitted values", () => {
        const result = renderTemplate(TEMPLATE, BODY, { design: "condition", contrast: ["a"], alpha: 0.1, shrink: "none", extra: 1 });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        const slots = result.issues.map((i) => i.slot).sort();
        expect(slots).toEqual(["alpha", "design", "extra", "shrink"]);
        expect(result.issues.find((i) => i.slot === "shrink")?.permitted).toEqual(["apeglm", "ashr"]);
        expect(result.issues.find((i) => i.slot === "extra")?.permitted).toContain("design");
    });

    it("requires an adaptable slot with no default", () => {
        const result = renderTemplate(TEMPLATE, BODY, { contrast: ["a", "b", "c"] });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.issues[0]).toMatchObject({ slot: "design" });
    });

    it("keeps an if block when the slot is given", () => {
        const result = renderTemplate(TEMPLATE, BODY, { design: "~ batch + condition", contrast: ["condition", "b", "a"], batch: "batch" });
        expect(result.ok && result.script).toContain('batch <- "batch"');
        expect(result.ok && result.script).not.toContain("batch <- NULL");
    });

    it("finds the body slots and the unmarked adaptable slots", () => {
        expect([...bodySlotNames(BODY)].sort()).toEqual(["alpha", "batch", "contrast", "design", "min_count", "shrink"]);
        expect(unmarkedAdaptableSlots(TEMPLATE, BODY)).toEqual([]);
        expect(unmarkedAdaptableSlots(TEMPLATE, "design <- {{design}}")).toContain("design");
    });
});

describe("matchEnvironment", () => {
    const pins = [
        { name: "DESeq2", version: "1.52.0", track: "bioconductor" as const },
        { name: "apeglm", version: "1.34.0", track: "bioconductor" as const },
    ];
    it("is exact, compatible, mismatch, or unknown", () => {
        expect(matchEnvironment(pins, [{ name: "DESeq2", version: "1.52.0" }, { name: "apeglm", version: "1.34.0" }]).match).toBe("exact");
        expect(matchEnvironment(pins, [{ name: "DESeq2", version: "1.52.1" }, { name: "apeglm", version: "1.34.0" }]).match).toBe("compatible");
        expect(matchEnvironment(pins, [{ name: "DESeq2", version: "1.44.0" }, { name: "apeglm", version: "1.34.0" }]).match).toBe("mismatch");
        expect(matchEnvironment(pins, [{ name: "DESeq2", version: "1.52.0" }]).match).toBe("mismatch");
        expect(matchEnvironment(pins, undefined).match).toBe("unknown");
    });
});
