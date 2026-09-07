/**
 * Input staging for a headless attempt: copy the inputs of a task from its
 * dataset directory into the workspace of the attempt, under
 * `data/inputs/local/<file>` (the layout the CLI stages), and build the harness
 * `StagedInput` manifest that rides into the data-profile trigger. The truth of
 * the simulation (truth.csv, transcripts.csv, sim.json) never leaves the dataset
 * directory: the candidate reads only the files a real user holds.
 *
 * The workspace map (`<outDir>/workspaces.json`) is the durable state behind the
 * eval's `resolveWorkspaceRoot`: the seam reads it on every call and throws on an
 * unknown id, as the workspace-root-resolution contract asks.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, readdir, stat, utimes } from "node:fs/promises";
import { dirname, join, posix } from "node:path";

import type { StagedInput } from "@inflexa-ai/harness";

import type { Task } from "./tasks.js";

/** The single flat mount every staged file lands under, the same as the CLI. */
const LOCAL_MOUNT_NAME = "local";
/** The staged tree's root relative to the data dir: `inputs/local`. */
const LOCAL_MOUNT_SUBDIR = posix.join("inputs", LOCAL_MOUNT_NAME);

/** The matrix file of each data state. A fastq task holds no matrix: the simulation has no reads. */
const MATRIX_FILE: Record<Task["data_state"], string | undefined> = {
    counts: "counts.csv",
    tpm_or_fpkm: "tpm.csv",
    log_normalized: "log_expr.csv",
    fastq: undefined,
};

/** The file of each extra input a task can name. */
const EXTRA_INPUT_FILE: Record<Task["extra_inputs"][number], string> = {
    de_results: "de_results.csv",
    signature: "signature_genes.csv",
};

/** Files staged when the dataset holds them: the gene lengths, and the transcript map of a Salmon dataset. */
const OPTIONAL_FILES = ["gene_lengths.csv", "tx2gene.csv"] as const;

/** The Salmon quantification tree of a dataset (`quant/<sample>/quant.sf`), staged whole when present. */
const QUANT_DIR = "quant";

/** The name of the workspace map inside the campaign output directory. */
const WORKSPACE_MAP_FILE = "workspaces.json";

async function exists(path: string): Promise<boolean> {
    return stat(path).then(
        () => true,
        () => false,
    );
}

/** Every file under `dir`, as posix paths relative to `dir`, in a stable order. */
async function walk(dir: string, prefix = ""): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const files: string[] = [];
    for (const entry of entries) {
        const key = posix.join(prefix, entry.name);
        if (entry.isDirectory()) files.push(...(await walk(join(dir, entry.name), key)));
        else if (entry.isFile()) files.push(key);
    }
    return files;
}

/**
 * The keys (paths relative to the dataset directory) the task stages. Selection is
 * by inclusion, thus the truth files are excluded without a deny list. A named
 * file that the dataset lacks is a dataset fault, not a silent omission.
 */
async function selectInputKeys(task: Task, datasetDir: string): Promise<string[]> {
    const required: string[] = [];
    const matrix = MATRIX_FILE[task.data_state];
    if (matrix) required.push(matrix);
    required.push("metadata.csv");
    for (const kind of task.extra_inputs) required.push(EXTRA_INPUT_FILE[kind]);
    for (const key of required) {
        if (!(await exists(join(datasetDir, key)))) throw new Error(`task ${task.id}: the dataset ${datasetDir} lacks ${key}`);
    }
    const optional: string[] = [];
    for (const key of OPTIONAL_FILES) {
        if (await exists(join(datasetDir, key))) optional.push(key);
    }
    const quantDir = join(datasetDir, QUANT_DIR);
    const quant = (await exists(quantDir)) ? await walk(quantDir, QUANT_DIR) : [];
    return [...required, ...optional, ...quant];
}

async function sha256File(path: string): Promise<string> {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(await Bun.file(path).arrayBuffer());
    return hasher.digest("hex");
}

/**
 * Deterministic file identity from the task id and the key: stable across
 * attempts and machines, thus a record can name a staged file by id. Opaque to
 * the harness, as the CLI's `anchorId|path` hash is.
 */
function deriveFileId(taskId: string, key: string): string {
    return Bun.hash(`${taskId}|${key}`).toString(36);
}

async function stageOne(taskId: string, datasetDir: string, key: string, workspaceRoot: string): Promise<StagedInput> {
    const source = join(datasetDir, key);
    // One stat gives the size and the mtime the manifest records, before the copy.
    const stats = await stat(source);
    const relativePath = posix.join(LOCAL_MOUNT_SUBDIR, key);
    const dest = join(workspaceRoot, "data", relativePath);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(source, dest);
    // A copy carries its own mtime; stamp the source's so the tree agrees with the manifest.
    await utimes(dest, stats.atime, stats.mtime);
    return {
        fileId: deriveFileId(taskId, key),
        mountName: LOCAL_MOUNT_NAME,
        key,
        fileName: posix.basename(key),
        hash: await sha256File(source),
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        relativePath,
    };
}

/**
 * Copy the inputs of the task into `<workspaceRoot>/data/inputs/local/` and
 * return the harness manifest, one entry per file, in a stable order: the
 * matrix of the data state, the sample table, the extra inputs the task names,
 * the gene lengths and the transcript map when present, then the quant tree
 * when present. Never truth.csv, transcripts.csv, or sim.json.
 */
export async function stageTaskInputs(task: Task, datasetDir: string, workspaceRoot: string): Promise<StagedInput[]> {
    const keys = await selectInputKeys(task, datasetDir);
    const staged: StagedInput[] = [];
    for (const key of keys) staged.push(await stageOne(task.id, datasetDir, key, workspaceRoot));
    return staged;
}

function readWorkspaceMap(path: string): Record<string, string> {
    let text: string;
    try {
        text = readFileSync(path, "utf8");
    } catch (cause) {
        if ((cause as { code?: string }).code === "ENOENT") return {};
        throw cause;
    }
    return JSON.parse(text) as Record<string, string>;
}

/** Record the workspace root of an analysis in `<outDir>/workspaces.json`; the write replaces the file whole. */
export function writeWorkspaceMap(outDir: string, analysisId: string, root: string): void {
    const path = join(outDir, WORKSPACE_MAP_FILE);
    const map = readWorkspaceMap(path);
    map[analysisId] = root;
    mkdirSync(outDir, { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(map, null, 2)}\n`);
    renameSync(temporary, path);
}

/**
 * The eval realization of the harness `ResolveWorkspaceRoot` seam, bound with
 * `(id) => readWorkspaceRoot(outDir, id)`: reads the map on every call, thus a
 * recovered workflow on a fresh process resolves, and throws on an unknown id.
 */
export function readWorkspaceRoot(outDir: string, analysisId: string): string {
    const root = readWorkspaceMap(join(outDir, WORKSPACE_MAP_FILE))[analysisId];
    if (root === undefined) throw new Error(`workspace root for ${analysisId}: unknown analysis (not in ${join(outDir, WORKSPACE_MAP_FILE)})`);
    return root;
}
