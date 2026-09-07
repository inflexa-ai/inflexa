/**
 * The template contract as `GET /v1/templates/{id}` serves it. A step agent
 * reads the contract from its briefing before the render call, thus the
 * contract must carry every fact the agent needs to make one valid call: the
 * adaptable flags of the slots, the design requirements the script honors,
 * the files the script reads, and the input notes of the template.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadKnowledgeBase } from "../build/load-kb.js";
import { openSnapshot, writeSnapshot, type LoadedSnapshot } from "../store.js";
import { templateContract } from "./handlers.js";

let snapshot: LoadedSnapshot;
let dir: string;

beforeAll(async () => {
    const loaded = await loadKnowledgeBase(join(import.meta.dir, "..", "..", "kb"));
    if (!loaded.ok) throw new Error(loaded.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
    dir = mkdtempSync(join(tmpdir(), "kb-contract-"));
    const path = join(dir, "snapshot.sqlite");
    writeSnapshot(path, { kb: loaded.kb, date: "2026-09-07", schemaVersion: "test", vocabularies: [], toolDefinitionHash: "sha256:test" });
    snapshot = openSnapshot(path);
});

afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe("the template contract", () => {
    it("tpl-deseq2-two-group: the adaptable flags, the honors, the inputs, and the notes", () => {
        const contract = templateContract(snapshot, "tpl-deseq2-two-group");
        expect(contract).toBeDefined();
        expect(contract!.id).toBe("tpl-deseq2-two-group");
        expect(contract!.version).toBe("1.1.0");
        expect(contract!.method).toBe("M-0001");
        expect(contract!.substitute_for).toBeUndefined();
        expect(contract!.language).toBe("R");
        expect(contract!.honors).toEqual(["blocking_factor", "covariates", "batch"]);
        // The slots of the import path are adaptable, and the import state is the one required slot among them.
        const slot = (name: string) => contract!.parameters.find((entry) => entry.name === name);
        for (const name of ["import_state", "counts_path", "quant_dir", "tx2gene_path", "lengths_path", "counts_from_abundance", "length_offset"]) {
            expect(slot(name)?.adaptable, name).toBe(true);
        }
        expect(slot("import_state")?.required).toBe(true);
        expect(slot("import_state")?.enum).toEqual(["quantifications", "estimated_counts_with_lengths", "corrected_counts", "integer_counts", "unknown"]);
        expect(slot("counts_path")?.required).toBe(false);
        expect(slot("counts_from_abundance")?.default).toBe("no");
        expect(slot("length_offset")?.default).toBe(true);
        // Each input names the slot that gives its path.
        expect(contract!.inputs.map((input) => input.name)).toEqual(["counts", "quantifications", "tx2gene", "gene_lengths", "metadata"]);
        expect(contract!.inputs.find((input) => input.name === "counts")?.path).toBe("{{counts_path}}");
        expect(contract!.inputs.find((input) => input.name === "quantifications")?.path).toBe("{{quant_dir}}/<sample>/quant.sf");
        expect(contract!.inputs.find((input) => input.name === "tx2gene")?.path).toBe("{{tx2gene_path}}");
        expect(contract!.inputs.find((input) => input.name === "gene_lengths")?.path).toBe("{{lengths_path}}");
        expect(contract!.inputs.find((input) => input.name === "metadata")?.path).toBe("{{metadata_path}}");
        for (const input of contract!.inputs) expect(input.description, input.name).toBeTruthy();
        // The notes carry the input requirements of the template in prose.
        expect(contract!.notes).toContain("The input follows the import state.");
        expect(contract!.notes).toContain("quant.sf");
        expect(contract!.notes).toContain("tximport");
        expect(contract!.outputs.map((output) => output.name)).toEqual(expect.arrayContaining(["results", "import_counts", "import_lengths", "summary"]));
    });

    it("a template with no inputs and no notes serves an empty list and no notes field", () => {
        // Every template of the tree declares both, thus the absent case takes a copy of the two-group template without them.
        const template = snapshot.templates.get("tpl-deseq2-two-group")!;
        const { inputs: _inputs, ...withoutInputs } = template;
        const { notes: _notes, ...applicability } = template.applicability;
        const bare = { ...withoutInputs, applicability };
        const contract = templateContract({ ...snapshot, templates: new Map([[bare.id, bare]]) }, bare.id);
        expect(contract!.inputs).toEqual([]);
        expect("notes" in contract!).toBe(false);
        expect(contract!.honors).toEqual(["blocking_factor", "covariates", "batch"]);
    });

    it("an unknown template id gives no contract", () => {
        expect(templateContract(snapshot, "tpl-does-not-exist")).toBeUndefined();
    });
});
