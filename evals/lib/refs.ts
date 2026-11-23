/**
 * A scripted `list_available_refs` over a reference store that a case states as text. It gives the result of the real
 * tool over the same files: a query walks to the files, a call with no query gives the files of a small subtree and
 * browses one level of a larger one, and each file carries the look at its start. A case that has no store on disk, such as a conversation or a planner case, reads it.
 */

import { posix } from "node:path";

import { parseUnknownRecord } from "@inflexa-ai/harness/lib/unknown-containers.js";
import { capCodePoints } from "@inflexa-ai/harness/loop/tool-detail.js";
import type { ReferenceInventoryEntry, ReferenceInventoryResult, ReferenceLook } from "@inflexa-ai/harness/tools/sandbox/list-available-refs.js";

import type { ToolScript } from "./agent.js";

const REFS_ROOT = "/mnt/refs";
const MAX_ENTRIES = 200;
/** A bare listing of a subtree with at most this many files gives the files, as the real tool does. */
const SMALL_TREE_FILES = 40;

/**
 * A file of the store: its text, or its text with the size on disk. A `.gz` path holds its text uncompressed, as
 * the look reads it after the decompression.
 */
export type RefFile = string | { readonly text: string; readonly bytes: number };

/** The files of a store, by path under `/mnt/refs`. */
export type RefStore = Readonly<Record<string, RefFile>>;

/** The formats of the real look, by suffix. */
const TEXT_FORMATS: Readonly<Record<string, string>> = {
    csv: "csv",
    tsv: "tsv",
    tab: "tsv",
    txt: "text",
    gmt: "gmt",
    gtf: "gtf",
    gff: "gff",
    gff3: "gff",
    bed: "bed",
    vcf: "vcf",
    fa: "fasta",
    fasta: "fasta",
    fna: "fasta",
    faa: "fasta",
    fai: "fasta index",
    fq: "fastq",
    fastq: "fastq",
    json: "json",
    obo: "obo",
    sam: "sam",
    mtx: "matrix market",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
    md: "markdown",
};

const DELIMITERS: Readonly<Record<string, string>> = { csv: ",", tsv: "\t" };

function suffixOf(name: string): string {
    return posix.extname(name).slice(1).toLowerCase();
}

function sniff(text: string): string | undefined {
    if (text.startsWith("##fileformat=VCF")) return "vcf";
    if (text.startsWith("%%MatrixMarket")) return "matrix market";
    if (text.startsWith(">")) return "fasta";
    if (text.startsWith("{") || text.startsWith("[")) return "json";
    return undefined;
}

function lookOfText(name: string, text: string): ReferenceLook {
    const suffix = suffixOf(name);
    const format = TEXT_FORMATS[suffix] ?? sniff(text) ?? (suffix === "" ? "text" : suffix);
    const lines = text
        .split("\n")
        .slice(0, 5)
        .map((line) => capCodePoints(line.endsWith("\r") ? line.slice(0, -1) : line, 200));
    while (lines.length > 0 && lines.at(-1) === "") lines.pop();
    const delimiter = DELIMITERS[format];
    const header = lines[0];
    if (delimiter === undefined || header === undefined) return { format, lines };
    const columns = header
        .split(delimiter)
        .slice(0, 50)
        .map((column) => column.trim())
        .map((column) => (column.length >= 2 && column.startsWith('"') && column.endsWith('"') ? column.slice(1, -1) : column));
    return { format, columns, lines };
}

function lookOf(path: string, file: RefFile): ReferenceLook {
    const name = posix.basename(path);
    const text = typeof file === "string" ? file : file.text;
    const suffix = suffixOf(name);
    if (suffix !== "gz" && suffix !== "bgz") return lookOfText(name, text);
    return { ...lookOfText(name.slice(0, -(suffix.length + 1)), text), compression: "gzip" };
}

function bytesOf(file: RefFile): number {
    return typeof file === "string" ? Buffer.byteLength(file, "utf8") : file.bytes;
}

/** The children of each directory of the store, by store-relative directory path, with `.` for the root. */
function treeOf(store: RefStore): Map<string, Set<string>> {
    const tree = new Map<string, Set<string>>([[".", new Set()]]);
    for (const path of Object.keys(store)) {
        const segments = path.split("/");
        for (let depth = 0; depth < segments.length; depth += 1) {
            const parent = depth === 0 ? "." : segments.slice(0, depth).join("/");
            const children = tree.get(parent) ?? new Set<string>();
            children.add(segments[depth] ?? "");
            tree.set(parent, children);
        }
    }
    return tree;
}

function join(directory: string, name: string): string {
    return directory === "." ? name : `${directory}/${name}`;
}

function fileEntry(store: RefStore, relative: string): ReferenceInventoryEntry {
    const file = store[relative] ?? "";
    return { path: `${REFS_ROOT}/${relative}`, kind: "file", bytes: bytesOf(file), look: lookOf(relative, file) };
}

/** Each file under `directory`, in the order of the stack walk of the real search. */
function walk(store: RefStore, tree: Map<string, Set<string>>, directory: string): ReferenceInventoryEntry[] {
    const entries: ReferenceInventoryEntry[] = [];
    const stack = [directory];
    for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
        for (const name of [...(tree.get(current) ?? [])].sort()) {
            const child = join(current, name);
            if (tree.has(child)) stack.push(child);
            else entries.push(fileEntry(store, child));
        }
    }
    return entries;
}

function countUnder(tree: Map<string, Set<string>>, directory: string): number {
    return [...(tree.get(directory) ?? [])].reduce((sum, name) => {
        const child = join(directory, name);
        return sum + 1 + (tree.has(child) ? countUnder(tree, child) : 0);
    }, 0);
}

/** The children of `directory`, with a summary of each directory, as the real browse gives them. */
function browse(store: RefStore, tree: Map<string, Set<string>>, directory: string): ReferenceInventoryEntry[] {
    return [...(tree.get(directory) ?? [])].sort().map((name) => {
        const child = join(directory, name);
        if (!tree.has(child)) return fileEntry(store, child);
        const files = walk(store, tree, child);
        const fileTypes = [...new Set(files.map((file) => posix.extname(file.path).toLowerCase()).filter((suffix) => suffix !== ""))].sort().slice(0, 10);
        return {
            path: `${REFS_ROOT}/${child}`,
            kind: "directory",
            bytes: files.reduce((sum, file) => sum + file.bytes, 0),
            fileCount: files.length,
            fileTypes,
            truncated: false,
        };
    });
}

function matches(entry: ReferenceInventoryEntry, needle: string): boolean {
    if (entry.path.toLowerCase().includes(needle)) return true;
    if (entry.kind !== "file" || entry.look === undefined) return false;
    const { format, columns = [], lines = [] } = entry.look;
    return [format, ...columns, ...lines].some((field) => field.toLowerCase().includes(needle));
}

function renderLook(look: ReferenceLook): string[] {
    const rendered = [`    ${look.format}${look.compression ? ` (${look.compression})` : ""}`];
    if (look.columns !== undefined) {
        rendered.push(`    columns: ${look.columns.join(", ")}`);
        for (const line of (look.lines ?? []).slice(1)) rendered.push(`    | ${line}`);
    } else {
        for (const line of look.lines ?? []) rendered.push(`    | ${line}`);
    }
    return rendered;
}

function render(path: string, entries: readonly ReferenceInventoryEntry[], truncated: boolean, scanned: number): string {
    if (entries.length === 0) return `Reference store path exists but contains no reference files: ${path}`;
    const lines = [`Reference files visible beneath ${path}:`];
    for (const entry of entries) {
        const details =
            entry.kind === "directory"
                ? `directory, ${entry.fileCount} files, ${entry.bytes} bytes${entry.fileTypes.length > 0 ? `, types: ${entry.fileTypes.join(", ")}` : ""}`
                : entry.kind === "file"
                  ? `file, ${entry.bytes} bytes`
                  : "symlink (not followed)";
        lines.push(`- ${entry.path} (${details})`);
        if (entry.kind === "file" && entry.look !== undefined) lines.push(...renderLook(entry.look));
    }
    if (truncated) lines.push(`Inventory truncated after scanning ${scanned} entries. Call list_available_refs with a narrower path to drill down.`);
    return lines.join("\n");
}

function noMatch(path: string, query: string, canDownload: boolean): string {
    const next = canDownload
        ? "The sandbox has no network. You can download the reference into the store with download_ref."
        : `The store at ${REFS_ROOT} is the only reference data that the sandbox can read, and the sandbox has no network. ` +
          "Say that the dataset is absent now. Do not guess a path, and do not use a different dataset in its place.";
    return `No reference beneath ${path} matches "${query}". ${next}`;
}

function result(fields: Partial<ReferenceInventoryResult> & Pick<ReferenceInventoryResult, "state" | "path" | "content">): ReferenceInventoryResult {
    return {
        available: fields.state !== "out_of_scope",
        entries: [],
        scannedEntries: 0,
        returned: 0,
        total: 0,
        truncated: false,
        hasMore: false,
        unlooked: 0,
        categories: [],
        ...fields,
    };
}

/** The store-relative directory of a `path` or `category` input, or the reason that the real tool refuses it. */
function resolve(input: string | undefined): { readonly relative: string } | { readonly reason: string } {
    if (input === undefined || input === "" || input === REFS_ROOT) return { relative: "." };
    const relative = input.startsWith(`${REFS_ROOT}/`) ? input.slice(REFS_ROOT.length + 1) : input.startsWith("/") ? undefined : input;
    if (relative === undefined || relative === "") return { reason: "Path is outside /mnt/refs." };
    const segments = relative.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
        return { reason: "Path traversal and empty path segments are not allowed." };
    }
    return { relative: posix.normalize(relative) };
}

/** The result of the real `list_available_refs` over `store` for one input. */
export function refsListing(store: RefStore, input: unknown, opts: { readonly canDownload?: boolean } = {}): ReferenceInventoryResult {
    const record = parseUnknownRecord(input) ?? {};
    const text = (key: string): string | undefined => (typeof record[key] === "string" ? record[key] : undefined);
    const requested = text("path") ?? text("category");
    const resolved = resolve(requested);
    if ("reason" in resolved) return result({ available: false, state: "out_of_scope", path: requested ?? REFS_ROOT, content: resolved.reason });
    const path = resolved.relative === "." ? REFS_ROOT : `${REFS_ROOT}/${resolved.relative}`;
    const tree = treeOf(store);
    if (!tree.has(resolved.relative)) {
        return store[resolved.relative] === undefined
            ? result({ state: "not_found", path, content: `Reference path does not exist: ${path}` })
            : result({ state: "not_a_directory", path, content: `Reference path is not a directory: ${path}` });
    }
    const query = text("query")?.trim() ?? "";
    const leaves = walk(store, tree, resolved.relative);
    const listed = query !== "" || leaves.length <= SMALL_TREE_FILES ? leaves : browse(store, tree, resolved.relative);
    const matched = query === "" ? listed : listed.filter((entry) => matches(entry, query.toLowerCase()));
    const limit = typeof record.limit === "number" ? record.limit : MAX_ENTRIES;
    const entries = matched.slice(0, limit);
    const truncated = entries.length < matched.length;
    const scannedEntries = countUnder(tree, resolved.relative);
    return result({
        state: listed.length === 0 ? "empty" : "populated",
        path,
        entries,
        scannedEntries,
        returned: entries.length,
        total: matched.length,
        truncated,
        hasMore: truncated,
        categories: [...new Set(listed.filter((entry) => entry.kind === "directory").map((entry) => posix.basename(entry.path)))].sort(),
        content:
            query !== "" && matched.length === 0 && listed.length > 0
                ? noMatch(path, query, opts.canDownload ?? true)
                : render(path, entries, truncated, scannedEntries),
    });
}

/** `list_available_refs` over `store`. An agent that holds `download_ref` reads the download hint of a miss. */
export function refsTool(store: RefStore, opts: { readonly canDownload?: boolean } = {}): ToolScript {
    return (input) => ({ ok: refsListing(store, input, opts) });
}

/** The grounding block of the planner seed: the leaf listing of the store, as the seed reads it. */
export function refsGrounding(store: RefStore): string {
    return `## Available Reference Data\n\n${refsListing(store, { query: "/" }).content}`;
}

/** The store path of a downloaded URL, as `download_ref` names it: the host, then the path of the URL. */
export function storePathOf(url: string): string {
    const parsed = new URL(url);
    return `${REFS_ROOT}/${parsed.hostname.toLowerCase()}${decodeURIComponent(parsed.pathname)}`;
}

/** The archives that `download_ref` extracts into a directory beside them, with `extract`. */
const ARCHIVE_SUFFIXES = [".tar.gz", ".tgz", ".tar", ".zip"];

/** The directory that `download_ref` extracts an archive at `path` into, or `undefined` for a file that is not an archive. */
export function extractedDirOf(path: string): string | undefined {
    const suffix = ARCHIVE_SUFFIXES.find((candidate) => path.toLowerCase().endsWith(candidate));
    return suffix === undefined ? undefined : path.slice(0, -suffix.length);
}

/** The answer of `download_ref` to one URL: a download to its store path, or a failure with the error of the tool. */
export type DownloadAnswer = { readonly status: "downloaded" } | { readonly status: "failed"; readonly error: string };

/** `download_ref`, with the answer of `answer` for each URL. The default downloads each URL. */
export function downloadRefTool(answer: (url: string) => DownloadAnswer = () => ({ status: "downloaded" })): ToolScript {
    return (input) => {
        const urls = parseUnknownRecord(input)?.urls;
        const list = Array.isArray(urls) ? urls.filter((url): url is string => typeof url === "string") : [];
        const [first] = list;
        if (first === undefined) return { error: "the call gives no URL" };
        const invalid = list.find((url) => !URL.canParse(url) || new URL(url).protocol !== "https:");
        if (invalid !== undefined) return { error: `${invalid} is not a valid HTTPS URL` };
        const hosts = new Set(list.map((url) => new URL(url).hostname.toLowerCase()));
        if (hosts.size > 1) return { error: `a call downloads from one host, and the URLs name ${[...hosts].join(" and ")}. Make one call for each host.` };
        const extract = parseUnknownRecord(input)?.extract === true;
        const files = list.map((url) => {
            const reply = answer(url);
            if (reply.status === "failed") return { url, status: "failed", error: reply.error };
            const path = storePathOf(url);
            if (!extract) return { url, status: "downloaded", path };
            const extracted = extractedDirOf(path);
            return extracted === undefined
                ? {
                      url,
                      status: "downloaded",
                      path,
                      extracted: false,
                      note: path.endsWith(".gz") ? "a gzip file of one file stays compressed" : "the file is not a tar or zip archive",
                  }
                : { url, status: "downloaded", path: extracted, extracted: true };
        });
        return { ok: { host: new URL(first).hostname.toLowerCase(), files } };
    };
}

/** What `run_inflexa` gives for an `inflexa refs` command: the CLI blocks it for each agent. */
export const INFLEXA_REFS_BLOCKED = {
    ok: { status: "blocked", message: "Agents download reference data with the download_ref tool; the `inflexa refs` commands are for the user." },
};
