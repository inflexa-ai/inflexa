import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { loadKnowledgeBase } from "../build/load-kb.js";
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
    "batch <- {{batch}}  # [adaptable: batch]",
].join("\n");

const PYTHON_TEMPLATE: Template = {
    ...TEMPLATE,
    id: "tpl-py",
    language: "python",
    parameters: [
        { name: "design", type: "formula", description: "d", adaptable: true },
        { name: "batch", type: "string", description: "b", adaptable: true, required: false },
        { name: "covariates", type: "string_list", description: "c", adaptable: true, required: false },
        { name: "min_samples", type: "integer", description: "m", adaptable: true, required: false },
    ],
    body_file: "body.py",
};

const PYTHON_BODY = [
    "DESIGN = {{design}}  # [adaptable: design]",
    "BATCH = {{batch}}  # [adaptable: batch]",
    "COVARIATES = {{covariates}}  # [adaptable: covariates]",
    "MIN_SAMPLES = {{min_samples}}  # [adaptable: min_samples]",
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
        expect(result.script).toContain("batch <- NA_character_");
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

    it("renders an optional slot when the caller gives it", () => {
        const result = renderTemplate(TEMPLATE, BODY, { design: "~ batch + condition", contrast: ["condition", "b", "a"], batch: "batch" });
        expect(result.ok && result.script).toContain('batch <- "batch"');
        expect(result.ok && result.script).not.toContain("NA_character_");
    });

    it("renders the absent literal of the language and the type for an optional slot with no value", () => {
        const r = renderTemplate(
            { ...TEMPLATE, parameters: [...TEMPLATE.parameters, { name: "order", type: "string_list", description: "o", adaptable: true, required: false }, { name: "n", type: "integer", description: "n", adaptable: true, required: false }] },
            `${BODY}\norder <- {{order}}  # [adaptable: order]\nn <- {{n}}  # [adaptable: n]`,
            { design: "~ condition", contrast: ["condition", "b", "a"] },
        );
        expect(r.ok && r.script).toContain("order <- character(0)");
        expect(r.ok && r.script).toContain("n <- NA_integer_");
        const py = renderTemplate(PYTHON_TEMPLATE, PYTHON_BODY, { design: "~ condition" });
        expect(py.ok).toBe(true);
        if (!py.ok) return;
        expect(py.script).toContain("BATCH = None");
        expect(py.script).toContain("COVARIATES = []");
        expect(py.script).toContain("MIN_SAMPLES = None");
        expect(py.slots.map((slot) => slot.name)).toEqual(["design"]);
        const given = renderTemplate(PYTHON_TEMPLATE, PYTHON_BODY, { design: "~ condition", covariates: ["age"], min_samples: 3 });
        expect(given.ok && given.script).toContain('COVARIATES = ["age"]');
        expect(given.ok && given.script).toContain("MIN_SAMPLES = 3");
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

describe("renderTemplate — Python literals", () => {
    it("writes a boolean as True or False and a list as a Python list when the template is Python", () => {
        const python = { ...TEMPLATE, language: "python" as const, body_file: "body.py" };
        const withBoolean = { ...python, parameters: [...python.parameters, { name: "py_flag", type: "boolean" as const, description: "b", adaptable: true }] };
        const body = `${BODY}\nPY_FLAG = {{py_flag}}  # [adaptable: py_flag]\n`;
        const slots: Record<string, unknown> = {};
        for (const parameter of withBoolean.parameters) if (parameter.adaptable && parameter.default === undefined) slots[parameter.name] = parameter.type === "string_list" ? ["a", "b"] : parameter.type === "boolean" ? true : parameter.type === "string" ? "x" : parameter.type === "formula" ? "~ condition" : 1;
        const rendered = renderTemplate(withBoolean, body, slots);
        if (!rendered.ok) throw new Error(JSON.stringify(rendered.issues));
        expect(rendered.script).toContain('["a", "b"]');
        expect(rendered.script).not.toContain("c(");
        expect(rendered.script).toContain("PY_FLAG = True");
    });
});

describe("renderTemplate — the import branch of tpl-deseq2-two-group", () => {
    const BASE = { metadata_path: "/work/data/metadata.csv", condition_column: "condition", reference_level: "control", test_level: "treated" };

    async function template(): Promise<Template & { readonly body: string }> {
        const loaded = await loadKnowledgeBase(join(import.meta.dir, "..", "..", "kb"));
        if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
        return loaded.kb.templates.find((candidate) => candidate.id === "tpl-deseq2-two-group")!;
    }

    it("requires import_state, and names the five states when the value is not permitted", async () => {
        const tpl = await template();
        expect(tpl.version).toBe("1.1.0");
        const absent = renderTemplate(tpl, tpl.body, { ...BASE, counts_path: "/work/data/counts.csv" });
        expect(absent.ok).toBe(false);
        if (!absent.ok) expect(absent.issues).toEqual([{ slot: "import_state", reason: "the slot is required and has no default" }]);
        const wrong = renderTemplate(tpl, tpl.body, { ...BASE, import_state: "salmon", counts_path: "/work/data/counts.csv" });
        expect(wrong.ok).toBe(false);
        if (!wrong.ok) expect(wrong.issues[0]?.permitted).toEqual(["quantifications", "estimated_counts_with_lengths", "corrected_counts", "integer_counts", "unknown"]);
    });

    it("renders the quantifications state without counts_path, with the tximport defaults in the slot report", async () => {
        const tpl = await template();
        const result = renderTemplate(tpl, tpl.body, { ...BASE, import_state: "quantifications", quant_dir: "/work/data/quant", tx2gene_path: "/work/data/tx2gene.csv" });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.script).toContain('IMPORT_STATE     <- "quantifications"');
        expect(result.script).toContain("COUNTS_PATH      <- NA_character_");
        expect(result.script).toContain('QUANT_DIR        <- "/work/data/quant"');
        expect(result.script).toContain('COUNTS_FROM_ABUNDANCE <- "no"');
        expect(result.script).toContain("LENGTH_OFFSET    <- TRUE");
        expect(result.script).toContain("DESeqDataSetFromTximport(");
        expect(result.slots.find((slot) => slot.name === "counts_from_abundance")).toMatchObject({ source: "default", value: "no", default_source: "vignette:tximport/2026-04-28#downstream-dge-in-bioconductor" });
        expect(result.slots.find((slot) => slot.name === "length_offset")).toMatchObject({ source: "default", value: true });
        expect(result.slots.find((slot) => slot.name === "counts_path")).toBeUndefined();
    });

    it("renders the integer_counts state with counts_path and no quantification slots", async () => {
        const tpl = await template();
        const result = renderTemplate(tpl, tpl.body, { ...BASE, import_state: "integer_counts", counts_path: "/work/data/counts.csv" });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.script).toContain('COUNTS_PATH      <- "/work/data/counts.csv"');
        expect(result.script).toContain("QUANT_DIR        <- NA_character_");
        expect(result.script).toContain("TX2GENE_PATH     <- NA_character_");
        expect(result.script).toContain("LENGTHS_PATH     <- NA_character_");
    });
});
