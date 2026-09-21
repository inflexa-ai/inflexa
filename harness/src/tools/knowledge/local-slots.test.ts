/**
 * The bytes of `bindLocalSlots` are the bytes of the reference renderer of
 * the knowledge service for the same values. The literals below are the
 * ones the service writes; a change on either side must land here too.
 */

import { describe, expect, it } from "bun:test";

import type { TemplateParameter } from "./client.js";
import { bindLocalSlots, validateLocalSlot } from "./local-slots.js";

const PARAMETERS: TemplateParameter[] = [
    { name: "design", type: "formula", description: "d", adaptable: true, local: true },
    { name: "counts_path", type: "string", description: "p", adaptable: true, local: true },
    { name: "batch_column", type: "string", description: "b", adaptable: true, local: true, required: false },
    { name: "covariate_columns", type: "string_list", description: "c", adaptable: true, local: true, required: false },
    { name: "output_prefix", type: "string", description: "o", adaptable: true, local: true, default: "de", pattern: "^[a-z]+$" },
    { name: "n_top", type: "integer", description: "n", adaptable: true, local: true, default: 5 },
    { name: "flag", type: "boolean", description: "f", adaptable: true, local: true, required: false },
    { name: "min_count", type: "integer", description: "m", adaptable: true, default: 10 },
];

const R_SCRIPT = [
    "design <- {{design}}  # [adaptable: design]",
    "counts <- read.csv({{counts_path}})  # [adaptable: counts_path]",
    "batch <- {{batch_column}}  # [adaptable: batch_column]",
    "covariates <- {{covariate_columns}}  # [adaptable: covariate_columns]",
    "prefix <- {{output_prefix}}  # [adaptable: output_prefix]",
    "n_top <- {{n_top}}  # [adaptable: n_top]",
    "flag <- {{flag}}  # [adaptable: flag]",
    "min_count <- 10  # [adaptable: min_count]",
].join("\n");

const LOCALS = { design: "~ batch + condition", counts_path: "/a/counts.csv", covariate_columns: ["sex", "age"] };

describe("bindLocalSlots", () => {
    it("R: the literals of the service for a formula, a string, a list, a default, an absent optional, and a boolean", () => {
        const bound = bindLocalSlots({ language: "R", parameters: PARAMETERS }, R_SCRIPT, { ...LOCALS, flag: true });
        if (!bound.ok) throw new Error(JSON.stringify(bound.issues));
        expect(bound.script.split("\n")).toEqual([
            "design <- ~ batch + condition  # [adaptable: design]",
            'counts <- read.csv("/a/counts.csv")  # [adaptable: counts_path]',
            "batch <- NA_character_  # [adaptable: batch_column]",
            'covariates <- c("sex", "age")  # [adaptable: covariate_columns]',
            'prefix <- "de"  # [adaptable: output_prefix]',
            "n_top <- 5  # [adaptable: n_top]",
            "flag <- TRUE  # [adaptable: flag]",
            "min_count <- 10  # [adaptable: min_count]",
        ]);
        expect(bound.slots.map((slot) => [slot.name, slot.source, slot.lines])).toEqual([
            ["design", "caller", [1]],
            ["counts_path", "caller", [2]],
            ["covariate_columns", "caller", [4]],
            ["output_prefix", "default", [5]],
            ["n_top", "default", [6]],
            ["flag", "caller", [7]],
        ]);
    });

    it("Python: None and [] for an absent scalar and an absent list, True for a boolean", () => {
        const script = [
            "BATCH = {{batch_column}}",
            "COVARIATES = {{covariate_columns}}",
            "FLAG = {{flag}}",
            "COUNTS = {{counts_path}}",
            "DESIGN = {{design}}",
        ].join("\n");
        const bound = bindLocalSlots({ language: "python", parameters: PARAMETERS }, script, {
            design: "~ condition",
            counts_path: "/a/counts.csv",
            flag: false,
        });
        if (!bound.ok) throw new Error(JSON.stringify(bound.issues));
        expect(bound.script).toBe('BATCH = None\nCOVARIATES = []\nFLAG = False\nCOUNTS = "/a/counts.csv"\nDESIGN = ~ condition');
    });

    it("keeps the read flag of the marked report, and a marker of a slot that is not local", () => {
        const bound = bindLocalSlots({ language: "R", parameters: PARAMETERS }, "x <- {{counts_path}}\ny <- {{unknown_slot}}", { ...LOCALS }, [
            { name: "counts_path", read: false },
        ]);
        if (!bound.ok) throw new Error(JSON.stringify(bound.issues));
        expect(bound.script).toBe('x <- "/a/counts.csv"\ny <- {{unknown_slot}}');
        expect(bound.slots.find((slot) => slot.name === "counts_path")).toMatchObject({ read: false });
    });

    it("refuses a required slot with no value, a value the contract refuses, a slot that is not local, and a type this host does not render", () => {
        const missing = bindLocalSlots({ language: "R", parameters: PARAMETERS }, R_SCRIPT, { counts_path: "/a/counts.csv" });
        expect(missing.ok).toBe(false);
        if (!missing.ok) expect(missing.issues.map((issue) => issue.slot)).toEqual(["design"]);
        const wrong = bindLocalSlots({ language: "R", parameters: PARAMETERS }, R_SCRIPT, { ...LOCALS, output_prefix: "Not-Lower" });
        expect(wrong.ok).toBe(false);
        const stray = bindLocalSlots({ language: "R", parameters: PARAMETERS }, R_SCRIPT, { ...LOCALS, min_count: 3 });
        expect(stray.ok).toBe(false);
        expect(validateLocalSlot({ name: "odd", type: "matrix", description: "o", adaptable: true, local: true }, "x")).toMatchObject({ slot: "odd" });
    });
});
