import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readWorkspaceRoot, stageTaskInputs, writeWorkspaceMap } from "./stage.js";
import { TaskSchema, type Task } from "./tasks.js";

/** A dataset with every file the simulator and the Salmon patterns write, truth included. */
const DATASET_FILES: Record<string, string> = {
    "counts.csv": "gene,s1,s2\nG1,10,20\nG2,5,7\n",
    "tpm.csv": "gene,s1,s2\nG1,1.5,2.5\nG2,0.5,0.7\n",
    "log_expr.csv": "gene,s1,s2\nG1,1.3,1.8\nG2,0.6,0.8\n",
    "metadata.csv": "sample,condition,batch\ns1,control,A\ns2,treated,A\n",
    "gene_lengths.csv": "gene,length\nG1,1000\nG2,2000\n",
    "de_results.csv": "gene,base_mean,log2_fold_change,adjusted_pvalue\nG1,15,1,0.01\n",
    "signature_genes.csv": "gene\nG1\nG2\n",
    "tx2gene.csv": "transcript,gene\nT1,G1\nT2,G2\n",
    "quant/s1/quant.sf": "Name\tLength\tEffectiveLength\tTPM\tNumReads\nT1\t100\t80\t1.5\t10.5\n",
    "quant/s2/quant.sf": "Name\tLength\tEffectiveLength\tTPM\tNumReads\nT1\t100\t80\t2.5\t20.5\n",
    "truth.csv": "gene,de,log2_fold_change\nG1,1,1.0\n",
    "transcripts.csv": "transcript,gene,de\nT1,G1,1\n",
    "sim.json": '{"seed":1,"n_transcripts":2}\n',
};

const NEVER_STAGED = ["truth.csv", "transcripts.csv", "sim.json"];

function task(overrides: Partial<Task> & { id: string }): Task {
    return TaskSchema.parse({
        pattern: "two_group_n6",
        question: "Which genes change?",
        tissue: "liver",
        condition: "treatment",
        experimental_design: "two groups",
        count_source: "salmon",
        concerns: [],
        reference: "a reference",
        must_match: [],
        must_not_match: [],
        ...overrides,
    });
}

async function walk(dir: string, prefix = ""): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const key = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) out.push(...(await walk(join(dir, entry.name), key)));
        else out.push(key);
    }
    return out.sort();
}

function sha256(text: string): string {
    return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

let root: string;
let dataset: string;
let bare: string;
let workspaces = 0;

async function freshWorkspace(): Promise<string> {
    workspaces += 1;
    const path = join(root, `workspace-${workspaces}`);
    await mkdir(path, { recursive: true });
    return path;
}

beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "inflexa-eval-stage-"));
    dataset = join(root, "dataset");
    for (const [key, text] of Object.entries(DATASET_FILES)) {
        await mkdir(join(dataset, key, ".."), { recursive: true });
        await Bun.write(join(dataset, key), text);
    }
    // A dataset without the optional files and without a quant tree.
    bare = join(root, "bare");
    for (const key of ["counts.csv", "metadata.csv", "truth.csv", "sim.json"]) {
        await mkdir(bare, { recursive: true });
        await Bun.write(join(bare, key), DATASET_FILES[key] ?? "");
    }
});

afterAll(async () => {
    await rm(root, { recursive: true, force: true });
});

describe("stageTaskInputs", () => {
    test("a counts task stages the counts, the metadata, the lengths, the transcript map, and the quant tree under data/inputs/local, never the truth", async () => {
        const workspace = await freshWorkspace();
        const staged = await stageTaskInputs(task({ id: "counts-task" }), dataset, workspace);
        const expected = ["counts.csv", "metadata.csv", "gene_lengths.csv", "tx2gene.csv", "quant/s1/quant.sf", "quant/s2/quant.sf"];
        expect(staged.map((s) => s.key)).toEqual(expected);
        expect(await walk(join(workspace, "data"))).toEqual(expected.map((key) => `inputs/local/${key}`).sort());
        for (const name of NEVER_STAGED) expect(staged.some((s) => s.key === name || s.fileName === name)).toBe(false);
        expect(await walk(workspace)).not.toContain("data/inputs/local/truth.csv");
    });

    test("each entry carries the harness manifest fields", async () => {
        const workspace = await freshWorkspace();
        const staged = await stageTaskInputs(task({ id: "counts-task" }), dataset, workspace);
        for (const entry of staged) {
            expect(entry.mountName).toBe("local");
            expect(entry.relativePath).toBe(`inputs/local/${entry.key}`);
            expect(entry.fileName).toBe(entry.key.split("/").at(-1) ?? "");
            const text = DATASET_FILES[entry.key] ?? "";
            expect(entry.hash).toBe(sha256(text));
            expect(entry.size).toBe(Buffer.byteLength(text));
            expect(typeof entry.mtimeMs).toBe("number");
            expect(entry.fileId).toMatch(/^[a-z0-9]+$/);
            expect(await Bun.file(join(workspace, "data", entry.relativePath)).text()).toBe(text);
        }
        // The manifest rides in a DBOS workflow input, thus it must survive JSON.
        expect(JSON.parse(JSON.stringify(staged))).toEqual(staged);
    });

    test("fileIds are stable across stagings of the same task and differ between tasks", async () => {
        const first = await stageTaskInputs(task({ id: "counts-task" }), dataset, await freshWorkspace());
        const second = await stageTaskInputs(task({ id: "counts-task" }), dataset, await freshWorkspace());
        expect(second.map((s) => s.fileId)).toEqual(first.map((s) => s.fileId));
        expect(new Set(first.map((s) => s.fileId)).size).toBe(first.length);
        const other = await stageTaskInputs(task({ id: "other-task" }), dataset, await freshWorkspace());
        expect(other.map((s) => s.fileId)).not.toEqual(first.map((s) => s.fileId));
    });

    test("a tpm task stages tpm.csv and not counts.csv or log_expr.csv", async () => {
        const workspace = await freshWorkspace();
        const staged = await stageTaskInputs(task({ id: "tpm-task", data_state: "tpm_or_fpkm" }), dataset, workspace);
        const keys = staged.map((s) => s.key);
        expect(keys).toContain("tpm.csv");
        expect(keys).not.toContain("counts.csv");
        expect(keys).not.toContain("log_expr.csv");
        const files = await walk(join(workspace, "data"));
        expect(files).toContain("inputs/local/tpm.csv");
        expect(files).not.toContain("inputs/local/counts.csv");
    });

    test("a log-normalized task stages log_expr.csv, and a fastq task stages no matrix", async () => {
        const logged = await stageTaskInputs(task({ id: "log-task", data_state: "log_normalized" }), dataset, await freshWorkspace());
        expect(logged.map((s) => s.key)).toContain("log_expr.csv");
        expect(logged.map((s) => s.key)).not.toContain("counts.csv");
        const fastq = await stageTaskInputs(task({ id: "fastq-task", data_state: "fastq" }), bare, await freshWorkspace());
        expect(fastq.map((s) => s.key)).toEqual(["metadata.csv"]);
    });

    test("extra inputs are staged only when the task names them", async () => {
        const plain = await stageTaskInputs(task({ id: "plain" }), dataset, await freshWorkspace());
        expect(plain.map((s) => s.key)).not.toContain("de_results.csv");
        expect(plain.map((s) => s.key)).not.toContain("signature_genes.csv");
        const extra = await stageTaskInputs(task({ id: "extra", extra_inputs: ["de_results", "signature"] }), dataset, await freshWorkspace());
        expect(extra.map((s) => s.key)).toContain("de_results.csv");
        expect(extra.map((s) => s.key)).toContain("signature_genes.csv");
    });

    test("a dataset without the optional files stages the files it has", async () => {
        const workspace = await freshWorkspace();
        const staged = await stageTaskInputs(task({ id: "bare-task" }), bare, workspace);
        expect(staged.map((s) => s.key)).toEqual(["counts.csv", "metadata.csv"]);
        expect(await walk(join(workspace, "data"))).toEqual(["inputs/local/counts.csv", "inputs/local/metadata.csv"]);
    });

    test("a named extra input that the dataset lacks is an error", async () => {
        await expect(stageTaskInputs(task({ id: "missing", extra_inputs: ["signature"] }), bare, await freshWorkspace())).rejects.toThrow("signature_genes.csv");
    });
});

describe("workspace map", () => {
    test("writeWorkspaceMap maintains workspaces.json and readWorkspaceRoot reads it back", async () => {
        const outDir = join(root, "campaign");
        writeWorkspaceMap(outDir, "analysis-a", "/tmp/a");
        writeWorkspaceMap(outDir, "analysis-b", "/tmp/b");
        writeWorkspaceMap(outDir, "analysis-a", "/tmp/a2");
        expect(JSON.parse(await Bun.file(join(outDir, "workspaces.json")).text())).toEqual({ "analysis-a": "/tmp/a2", "analysis-b": "/tmp/b" });
        expect(readWorkspaceRoot(outDir, "analysis-a")).toBe("/tmp/a2");
        expect(readWorkspaceRoot(outDir, "analysis-b")).toBe("/tmp/b");
    });

    test("readWorkspaceRoot throws on an unknown id and on a missing map", () => {
        const outDir = join(root, "campaign");
        expect(() => readWorkspaceRoot(outDir, "analysis-z")).toThrow("analysis-z");
        expect(() => readWorkspaceRoot(join(root, "no-campaign"), "analysis-a")).toThrow("analysis-a");
    });
});
