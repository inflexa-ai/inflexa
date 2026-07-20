/**
 * Reference-store discovery: `createListAvailableRefsTool`, a bounded, no-follow
 * inventory of what is ACTUALLY provisioned in the reference store (managed
 * installs and user-added files alike). Narrow with `path`/`category`, filter
 * with `query`, cap with `limit`; every response carries `returned`/`total`/
 * `hasMore` and the `categories` present, so a listing is never an unbounded
 * dump. Symlinks are never followed; nothing can be downloaded at runtime.
 *
 * The store is read from the host filesystem at the embedder-supplied
 * `refStorePath` and reported at `/mnt/refs`, the container path sandboxes mount
 * it at — read where it lives, render where the caller will open it. Reading it
 * host-side is what lets a planner ask what reference data exists before any
 * sandbox is created; a step agent asking mid-run sees the same store, because
 * the mount and this path are the same bytes.
 *
 * The scan reports paths; meaning is joined on afterwards from the install
 * receipt and the catalog it names (organism, format, and each file's internal
 * shape). Callers search by what the data IS, so the store's directory layout
 * stays an installer detail rather than an interface anything encodes. Metadata
 * only ever ENRICHES an entry — a file with no receipt and no catalog match is
 * still returned, because a user-provided store is as valid as a managed one.
 */

import { lstat, readFile, readdir } from "node:fs/promises";
import { join as hostJoin, posix as posixPath } from "node:path";

import { ok } from "neverthrow";
import { z } from "zod";

import { REFERENCE_DATA_CATALOG } from "../../reference-data/catalog.js";
import { parseReferenceInstallReceipt } from "../../reference-data/receipt.js";
import { defineTool } from "../define-tool.js";

/** Container path the ref store is mounted at; every reported path is rendered under it. */
const REFS_ROOT = "/mnt/refs";
const MAX_ENTRIES = 200;
const MAX_SCANNED_ENTRIES = 2_000;
const MAX_PATH_BYTES = 40_000;
const MAX_ENVELOPE_BYTES = 64_000;
const MAX_INPUT_PATH_BYTES = 4_096;
const MAX_RECEIPT_FILES = 100;
const MAX_RECEIPT_BYTES = 16_384;
const MAX_RECEIPT_TOTAL_BYTES = 32_768;
const MAX_REGISTRY_BYTES = 131_072;
const MAX_LEGACY_ENTRIES = 200;

const ListAvailableRefsInputSchema = z.object({
    path: z
        .string()
        .max(MAX_INPUT_PATH_BYTES)
        .optional()
        .describe(
            "Directory beneath /mnt/refs to inspect — a returned absolute path or a store-relative path. Use it to drill into a subtree when a listing is truncated.",
        ),
    category: z
        .string()
        .max(MAX_INPUT_PATH_BYTES)
        .optional()
        .describe(
            'Shorthand for a top-level group to inspect (e.g. "atlas_singlecell", "msigdb"); the groups present come back in `categories`. Ignored when `path` is given.',
        ),
    query: z
        .string()
        .optional()
        .describe("Case-insensitive substring filter over each entry's path and its dataset, title, category, organism, and subtype labels."),
    limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_ENTRIES)
        .optional()
        .describe(
            `Max entries to return (default ${MAX_ENTRIES}); the response carries \`returned\`, \`total\`, and \`hasMore\` so truncation is never silent.`,
        ),
});

export interface ListAvailableRefsDeps {
    /**
     * Host path of the reference store — the same bytes sandboxes see at
     * `/mnt/refs`. Omitted (or absent on disk) means no store is provisioned,
     * which is a normal state reported as `unavailable`, not an error.
     */
    readonly refStorePath?: string;
}

export interface ReferenceInventoryMetadata {
    readonly datasetId?: string;
    readonly version?: string;
    readonly title?: string;
    readonly description?: string;
    readonly sourceUrl?: string;
    readonly license?: string;
    readonly category?: string;
    readonly subtype?: string;
    readonly organism?: string;
    /** Logical content format, independent of compression — which reader to reach for. */
    readonly format?: string;
    /** The file's internal shape (key columns, identifier space), so a caller can use it without opening it first. */
    readonly contents?: string;
    readonly rows?: number;
    readonly endpoint?: string;
}

interface ReferenceInventoryEntryBase {
    readonly path: string;
    readonly metadata?: ReferenceInventoryMetadata;
}

/** A bounded, no-follow observation of the reference store. */
export type ReferenceInventoryEntry =
    | (ReferenceInventoryEntryBase & { readonly kind: "file"; readonly bytes: number })
    | (ReferenceInventoryEntryBase & { readonly kind: "symlink"; readonly bytes: 0 })
    | (ReferenceInventoryEntryBase & {
          readonly kind: "directory";
          readonly bytes: number;
          readonly fileCount: number;
          readonly fileTypes: readonly string[];
          readonly truncated: boolean;
      });

/**
 * Structured result returned for every expected reference-store state. Bounding
 * is explicit: `returned`/`total`/`hasMore` describe how much of the match set
 * this response carries, and `categories` is the drill-in index.
 */
export interface ReferenceInventoryResult {
    readonly available: boolean;
    readonly state: RawScan["state"] | "out_of_scope";
    readonly path: string;
    readonly entries: readonly ReferenceInventoryEntry[];
    readonly scannedEntries: number;
    readonly returned: number;
    readonly total: number;
    readonly truncated: boolean;
    readonly hasMore: boolean;
    readonly categories: readonly string[];
    readonly content: string;
}

interface RawScan {
    readonly state: "unavailable" | "empty" | "populated" | "not_found" | "not_a_directory" | "symlink";
    readonly entries: ReferenceInventoryEntry[];
    readonly scannedEntries: number;
    readonly truncated: boolean;
    readonly receipts?: unknown[];
    readonly legacyEntries?: unknown[];
}

function resolveRequestedPath(input: string | undefined): { ok: true; path: string } | { ok: false; reason: string } {
    if (input === undefined || input === "" || input === REFS_ROOT) return { ok: true, path: REFS_ROOT };
    if (Buffer.byteLength(input, "utf8") > MAX_INPUT_PATH_BYTES) {
        return { ok: false, reason: `Path exceeds the ${MAX_INPUT_PATH_BYTES}-byte POSIX path limit.` };
    }
    if (input.includes("\0") || input.includes("\\")) return { ok: false, reason: "Path must use safe POSIX segments beneath /mnt/refs." };

    const relative = input.startsWith(`${REFS_ROOT}/`) ? input.slice(REFS_ROOT.length + 1) : input.startsWith("/") ? undefined : input;
    if (relative === undefined || relative.length === 0) return { ok: false, reason: "Path is outside /mnt/refs." };
    const segments = relative.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
        return { ok: false, reason: "Path traversal and empty path segments are not allowed." };
    }
    if (segments[0] === ".inflexa" || relative === "registry.json") return { ok: false, reason: "Installer metadata is not reference data." };
    const normalized = posixPath.join(REFS_ROOT, relative);
    if (!normalized.startsWith(`${REFS_ROOT}/`)) return { ok: false, reason: "Path is outside /mnt/refs." };
    return { ok: true, path: normalized };
}

interface ScannedName {
    readonly name: string;
    readonly kind: "file" | "directory" | "symlink" | "other";
    readonly bytes: number;
}

/**
 * Inspect at most `limit` names in one directory, sorted by name.
 *
 * Sorting BEFORE the cap (rather than capping the raw readdir order) keeps
 * truncation deterministic: the same store yields the same prefix on every call,
 * which a durably-cached step result has to be able to promise.
 */
async function cappedEntries(directory: string, limit: number): Promise<{ values: ScannedName[]; cut: boolean }> {
    let names: string[];
    try {
        names = (await readdir(directory, { withFileTypes: true })).map((entry) => entry.name);
    } catch {
        return { values: [], cut: false };
    }
    names.sort();
    const cut = names.length > limit;
    const values: ScannedName[] = [];
    for (const name of names.slice(0, limit)) {
        try {
            // lstat, never stat: a symlink is reported as a symlink and never resolved,
            // so a link out of the store cannot smuggle in a foreign file's size or type.
            const stats = await lstat(hostJoin(directory, name));
            if (stats.isSymbolicLink()) values.push({ name, kind: "symlink", bytes: 0 });
            else if (stats.isFile()) values.push({ name, kind: "file", bytes: stats.size });
            else if (stats.isDirectory()) values.push({ name, kind: "directory", bytes: 0 });
            else values.push({ name, kind: "other", bytes: 0 });
        } catch {
            continue;
        }
    }
    return { values, cut };
}

/** Whether any component of `relative` beneath `root` is a symlink — the no-follow gate. */
async function crossesSymlink(root: string, relative: string): Promise<boolean> {
    let cursor = root;
    for (const segment of relative.split("/")) {
        cursor = hostJoin(cursor, segment);
        try {
            if ((await lstat(cursor)).isSymbolicLink()) return true;
        } catch {
            return false;
        }
    }
    return false;
}

/** Recursively total a directory's files, bounded by the remaining scan budget. */
async function summarizeDirectory(
    directory: string,
    scanned: number,
): Promise<{ bytes: number; fileCount: number; fileTypes: string[]; truncated: boolean; scanned: number }> {
    let totalBytes = 0;
    let fileCount = 0;
    let truncated = false;
    const fileTypes = new Set<string>();
    const stack = [directory];

    while (stack.length > 0 && scanned < MAX_SCANNED_ENTRIES) {
        const current = stack.pop()!;
        const { values, cut } = await cappedEntries(current, MAX_SCANNED_ENTRIES - scanned);
        truncated = truncated || cut;
        const childDirectories: string[] = [];
        for (const child of values) {
            scanned += 1;
            if (child.kind === "directory") childDirectories.push(hostJoin(current, child.name));
            else if (child.kind === "file") {
                fileCount += 1;
                totalBytes += child.bytes;
                const suffix = posixPath.extname(child.name).toLowerCase();
                if (suffix) fileTypes.add(suffix);
            }
            if (scanned >= MAX_SCANNED_ENTRIES) {
                truncated = true;
                break;
            }
        }
        stack.push(...childDirectories.reverse());
    }
    return { bytes: totalBytes, fileCount, fileTypes: [...fileTypes].sort().slice(0, 10), truncated, scanned };
}

/** Install receipts written by the host installer under `<root>/.inflexa/receipts`. */
async function readReceipts(root: string): Promise<unknown[]> {
    const receiptsDirectory = hostJoin(root, ".inflexa", "receipts");
    if (await crossesSymlink(root, ".inflexa")) return [];
    const { values } = await cappedEntries(receiptsDirectory, MAX_RECEIPT_FILES);
    const receipts: unknown[] = [];
    let totalBytes = 0;
    for (const entry of values) {
        if (entry.kind !== "file" || entry.bytes > MAX_RECEIPT_BYTES || totalBytes + entry.bytes > MAX_RECEIPT_TOTAL_BYTES) continue;
        // Per-file, so one unreadable or malformed receipt costs only its own labels.
        // A shared try would abandon the loop and silently drop every receipt sorting
        // after the bad one, quietly stripping metadata from datasets that are fine.
        try {
            receipts.push(JSON.parse(await readFile(hostJoin(receiptsDirectory, entry.name), "utf-8")));
            totalBytes += entry.bytes;
        } catch {
            continue;
        }
    }
    return receipts;
}

/** Labels from a `registry.json` an externally-provisioned store may carry. */
async function readLegacyEntries(root: string): Promise<unknown[]> {
    const legacyEntries: unknown[] = [];
    try {
        if (await crossesSymlink(root, "registry.json")) return [];
        const registryPath = hostJoin(root, "registry.json");
        if ((await lstat(registryPath)).size > MAX_REGISTRY_BYTES) return [];
        const registry: unknown = JSON.parse(await readFile(registryPath, "utf-8"));
        if (!registry || typeof registry !== "object") return [];
        const byCategory = (registry as { files?: { by_category?: unknown } }).files?.by_category;
        if (!byCategory || typeof byCategory !== "object") return [];
        for (const category of Object.keys(byCategory as Record<string, unknown>).sort()) {
            const values = (byCategory as Record<string, unknown>)[category];
            if (!Array.isArray(values)) continue;
            for (const item of values) {
                if (legacyEntries.length >= MAX_LEGACY_ENTRIES) break;
                if (item && typeof item === "object" && typeof (item as { local_path?: unknown }).local_path === "string") {
                    legacyEntries.push({ ...(item as Record<string, unknown>), category });
                }
            }
        }
    } catch {
        return legacyEntries;
    }
    return legacyEntries;
}

/** Scan the store beneath `root`, reporting every expected state as data. */
async function scanStore(root: string | undefined, relative: string): Promise<RawScan> {
    const empty = (): Omit<RawScan, "state"> => ({ entries: [], scannedEntries: 0, truncated: false });
    if (!root) return { state: "unavailable", ...empty() };
    try {
        if (!(await lstat(root)).isDirectory()) return { state: "unavailable", ...empty() };
    } catch {
        return { state: "unavailable", ...empty() };
    }

    if (relative !== "." && (await crossesSymlink(root, relative))) return { state: "symlink", ...empty() };

    const target = relative === "." ? root : hostJoin(root, ...relative.split("/"));
    let targetStats;
    try {
        targetStats = await lstat(target);
    } catch {
        return { state: "not_found", ...empty() };
    }
    if (!targetStats.isDirectory()) return { state: "not_a_directory", ...empty() };

    const entries: ReferenceInventoryEntry[] = [];
    let scanned = 0;
    let pathBytes = 0;
    let truncated = false;

    const { values: children, cut } = await cappedEntries(target, Math.min(MAX_ENTRIES + 2, MAX_SCANNED_ENTRIES));
    truncated = cut;

    for (const child of children) {
        const childRelative = relative === "." ? child.name : `${relative}/${child.name}`;
        if (childRelative === ".inflexa" || childRelative.startsWith(".inflexa/") || childRelative === "registry.json") continue;
        scanned += 1;
        const rendered = `${REFS_ROOT}/${childRelative}`;

        let entry: ReferenceInventoryEntry | undefined;
        if (child.kind === "symlink") entry = { path: rendered, kind: "symlink", bytes: 0 };
        else if (child.kind === "file") entry = { path: rendered, kind: "file", bytes: child.bytes };
        else if (child.kind === "directory") {
            const summary = await summarizeDirectory(hostJoin(target, child.name), scanned);
            scanned = summary.scanned;
            truncated = truncated || summary.truncated;
            entry = {
                path: rendered,
                kind: "directory",
                bytes: summary.bytes,
                fileCount: summary.fileCount,
                fileTypes: summary.fileTypes,
                truncated: summary.truncated,
            };
        }

        if (entry) {
            if (entries.length < MAX_ENTRIES && pathBytes + Buffer.byteLength(rendered, "utf8") <= MAX_PATH_BYTES) {
                entries.push(entry);
                pathBytes += Buffer.byteLength(rendered, "utf8");
            } else {
                truncated = true;
            }
        }
        if (scanned >= MAX_SCANNED_ENTRIES) {
            truncated = true;
            break;
        }
    }

    return {
        state: entries.length === 0 ? "empty" : "populated",
        entries,
        scannedEntries: scanned,
        truncated,
        receipts: await readReceipts(root),
        legacyEntries: await readLegacyEntries(root),
    };
}

function stringValue(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function enrichEntries(entries: readonly ReferenceInventoryEntry[], raw: RawScan): ReferenceInventoryEntry[] {
    const metadata = new Map<string, ReferenceInventoryMetadata>();
    for (const value of raw.receipts ?? []) {
        const receipt = parseReferenceInstallReceipt(value);
        if (!receipt) continue;
        const dataset = REFERENCE_DATA_CATALOG.datasets.find((candidate) => candidate.id === receipt.datasetId && candidate.version === receipt.datasetVersion);
        for (const artifact of receipt.artifacts) {
            // Per-artifact, not per-dataset: format and contents differ between files of the
            // same dataset (a Seurat object and its Annoy index are read nothing alike).
            const catalogArtifact = dataset?.artifacts.find((candidate) => candidate.path === artifact.path);
            metadata.set(`${REFS_ROOT}/managed/${receipt.datasetId}/${receipt.datasetVersion}/${artifact.path}`, {
                datasetId: receipt.datasetId,
                version: receipt.datasetVersion,
                ...(dataset
                    ? {
                          title: dataset.title,
                          description: dataset.description,
                          sourceUrl: dataset.sourceUrl,
                          license: dataset.license.url ?? dataset.license.identifier,
                          category: dataset.recommendation.group,
                          ...(dataset.organism ? { organism: dataset.organism } : {}),
                      }
                    : {}),
                ...(catalogArtifact ? { format: catalogArtifact.format, contents: catalogArtifact.contents } : {}),
            });
        }
    }

    for (const value of raw.legacyEntries ?? []) {
        if (!value || typeof value !== "object") continue;
        const item = value as Record<string, unknown>;
        const localPath = stringValue(item.local_path);
        if (!localPath) continue;
        const resolved = resolveRequestedPath(localPath);
        if (!resolved.ok) continue;
        const legacyMetadata: ReferenceInventoryMetadata = {
            ...(stringValue(item.dataset) ? { datasetId: stringValue(item.dataset)! } : {}),
            ...(stringValue(item.category) ? { category: stringValue(item.category)! } : {}),
            ...(stringValue(item.subtype) ? { subtype: stringValue(item.subtype)! } : {}),
            ...(stringValue(item.organism) ? { organism: stringValue(item.organism)! } : {}),
            ...(numberValue(item.rows) !== undefined ? { rows: numberValue(item.rows)! } : {}),
            ...(stringValue(item.endpoint) ? { endpoint: stringValue(item.endpoint)! } : {}),
        };
        metadata.set(resolved.path, { ...legacyMetadata, ...metadata.get(resolved.path) });
    }

    return entries.map((entry) => {
        const extra = metadata.get(entry.path);
        return extra ? { ...entry, metadata: extra } : entry;
    });
}

/**
 * Case-insensitive substring match over an inventory entry's path and joined metadata labels.
 * `description` and `contents` are in scope deliberately: a caller searching for what the data
 * IS ("regulon", "tf-target") should hit a file whose name says only "CollecTRI".
 */
function entryMatchesQuery(entry: ReferenceInventoryEntry, needle: string): boolean {
    const fields = [
        entry.path,
        entry.metadata?.datasetId,
        entry.metadata?.title,
        entry.metadata?.description,
        entry.metadata?.category,
        entry.metadata?.subtype,
        entry.metadata?.organism,
        entry.metadata?.format,
        entry.metadata?.contents,
    ];
    return fields.some((field) => typeof field === "string" && field.toLowerCase().includes(needle));
}

/** The drill-in index: directory groups present in the scan, plus any category labels joined from metadata. */
function collectCategories(entries: readonly ReferenceInventoryEntry[]): string[] {
    const names = new Set<string>();
    for (const entry of entries) {
        if (entry.kind === "directory") names.add(posixPath.basename(entry.path));
        if (entry.metadata?.category) names.add(entry.metadata.category);
    }
    return [...names].sort();
}

function renderContent(path: string, scan: RawScan, entries: readonly ReferenceInventoryEntry[]): string {
    if (scan.state === "unavailable")
        return "No reference store is provisioned. Reference data cannot be downloaded at runtime; provision it through the host setup flow.";
    if (scan.state === "not_found") return `Reference path does not exist: ${path}`;
    if (scan.state === "not_a_directory") return `Reference path is not a directory: ${path}`;
    if (scan.state === "symlink") return `Reference path crosses a symlink and was not scanned: ${path}`;
    if (scan.state === "empty") return `Reference store path exists but contains no reference files: ${path}`;

    const lines = [`Reference files visible beneath ${path}:`];
    for (const entry of entries) {
        const labels = entry.metadata
            ? [entry.metadata.title ?? entry.metadata.datasetId, entry.metadata.version, entry.metadata.category, entry.metadata.organism]
                  .filter(Boolean)
                  .join(", ")
            : "";
        const details =
            entry.kind === "directory"
                ? `directory, ${entry.fileCount} files, ${entry.bytes} bytes${entry.fileTypes.length > 0 ? `, types: ${entry.fileTypes.join(", ")}` : ""}${entry.truncated ? ", summary truncated" : ""}`
                : entry.kind === "file"
                  ? `file, ${entry.bytes} bytes`
                  : "symlink (not followed)";
        lines.push(`- ${entry.path} (${details}${labels ? `; ${labels}` : ""})`);
        // The deciding line: whether this file is the thing you need, and how to open it.
        // Without it a caller is back to inferring both from the filename.
        const shape = [entry.metadata?.format, entry.metadata?.contents].filter(Boolean).join(" — ");
        if (shape) lines.push(`    ${shape}`);
    }
    if (scan.truncated)
        lines.push(`Inventory truncated after scanning ${scan.scannedEntries} entries. Call list_available_refs with a narrower path to drill down.`);
    return lines.join("\n");
}

/** Create reference discovery over the host-visible reference store. */
export function createListAvailableRefsTool(deps: ListAvailableRefsDeps) {
    return defineTool({
        id: "list_available_refs",
        description:
            "Resolve reference data you need into a real path. Reports the reference data actually provisioned for this environment — the ONLY reference data that exists here; nothing can be downloaded at runtime. " +
            "Search by what the data IS, not by where you expect it: the store's directory layout is an installer detail and is not a stable interface. " +
            "Catalogued files come back with the organism, the format, and the file's internal shape (key columns, identifier space), so you can pick the right reader and the right species without opening the file first. " +
            "User-added files are returned too, with whatever labels exist — often none. Symlinks are never followed. " +
            "Paths are reported as the analysis environment sees them, so a returned path can be used verbatim in a script. " +
            "Results are ALWAYS bounded — prefer a targeted query over a full dump: " +
            '`query` is the main entry point, a case-insensitive substring filter over each entry\'s path and its dataset/title/category/organism/format/contents labels (e.g. "regulon", "hallmark", "mouse"); ' +
            "`path` inspects one directory beneath /mnt/refs (a returned path, or store-relative) — drill in with it when a listing is truncated; " +
            '`category` is shorthand for a top-level group (e.g. "pathways", "regulatory-networks"), and the groups present come back in `categories`; ' +
            "`limit` caps the entries returned. The response carries `returned`, `total`, and `hasMore`, so truncation is never silent. " +
            "An empty result means the data is genuinely absent — say so and proceed with what you have; do not guess a path. Provision additional files through the host setup flow.",
        inputSchema: ListAvailableRefsInputSchema,
        execute: async ({ path, category, query, limit }) => {
            // `category` is shorthand for a top-level path; an explicit `path` wins.
            const requestedInput = path ?? category;
            const requested = resolveRequestedPath(requestedInput);
            if (!requested.ok) {
                const response: ReferenceInventoryResult = {
                    available: false,
                    state: "out_of_scope",
                    path: requestedInput !== undefined && Buffer.byteLength(requestedInput, "utf8") <= MAX_INPUT_PATH_BYTES ? requestedInput : REFS_ROOT,
                    entries: [],
                    scannedEntries: 0,
                    returned: 0,
                    total: 0,
                    truncated: false,
                    hasMore: false,
                    categories: [],
                    content: requested.reason,
                };
                return ok(response);
            }

            const raw = await scanStore(deps.refStorePath, posixPath.relative(REFS_ROOT, requested.path) || ".");
            const enriched = enrichEntries(raw.entries, raw);
            const categories = collectCategories(enriched);
            const needle = query?.trim().toLowerCase();
            const matched = needle ? enriched.filter((entry) => entryMatchesQuery(entry, needle)) : enriched;
            const total = matched.length;
            const cap = limit ?? MAX_ENTRIES;
            let boundedEntries = matched.length > cap ? matched.slice(0, cap) : matched;

            const build = (list: readonly ReferenceInventoryEntry[], contentPath: string): ReferenceInventoryResult => {
                const truncated = raw.truncated || list.length < total;
                return {
                    available: raw.state !== "unavailable",
                    state: raw.state,
                    path: contentPath,
                    entries: list,
                    scannedEntries: raw.scannedEntries,
                    returned: list.length,
                    total,
                    truncated,
                    hasMore: truncated,
                    categories,
                    content: renderContent(contentPath, { ...raw, truncated }, list),
                };
            };

            let response = build(boundedEntries, requested.path);
            while (Buffer.byteLength(JSON.stringify(response), "utf8") > MAX_ENVELOPE_BYTES && boundedEntries.length > 0) {
                boundedEntries = boundedEntries.slice(0, -1);
                response = build(boundedEntries, requested.path);
            }
            if (Buffer.byteLength(JSON.stringify(response), "utf8") > MAX_ENVELOPE_BYTES) {
                response = {
                    ...build([], REFS_ROOT),
                    content: "Reference inventory output exceeded its bound. Call list_available_refs with a shorter, narrower path.",
                };
            }
            return ok(response);
        },
    });
}
