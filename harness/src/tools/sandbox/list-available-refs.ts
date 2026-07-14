/**
 * Reference-store discovery — two coordinated surfaces over the read-only
 * store at /mnt/refs:
 *
 * - `createListAvailableRefsTool` — the wired sandbox tool. A bounded, no-follow
 *   inventory of what is ACTUALLY mounted (managed installs, user-added files),
 *   scanned live inside the sandbox. Narrow with `path`/`category`, filter with
 *   `query`, cap with `limit`; every response carries `returned`/`total`/
 *   `hasMore` and the `categories` present, so a listing is never an unbounded
 *   dump. Symlinks are never followed; nothing can be downloaded at runtime.
 * - `queryRefs` — a pure query over a parsed `/mnt/refs/registry.json` manifest
 *   (`files.by_category`), filtering on fields the registry carries: `local_path`,
 *   `category`, `subtype`, `organism`, `tax_id`, `dataset`, `rows`.
 */

import { basename, join, posix as posixPath } from "node:path";

import { ok } from "neverthrow";
import { z } from "zod";

import { REFERENCE_DATA_CATALOG } from "../../reference-data/catalog.js";
import { parseReferenceInstallReceipt } from "../../reference-data/receipt.js";
import type { SandboxClient } from "../../sandbox/client.js";
import type { SandboxRef } from "../../sandbox/types.js";
import { defineTool } from "../define-tool.js";
import { runSandboxExec } from "../workspace/run-exec.js";

const REFS_ROOT = "/mnt/refs";
const MAX_ENTRIES = 200;
const MAX_SCANNED_ENTRIES = 2_000;
const MAX_PATH_BYTES = 40_000;
const MAX_ENVELOPE_BYTES = 64_000;
const MAX_INPUT_PATH_BYTES = 4_096;

/** Default number of file entries a registry listing (`queryRefs`) returns. */
const DEFAULT_LIMIT = 40;

const SCAN_SCRIPT = String.raw`
import json, os, sys

ROOT = sys.argv[1]
RELATIVE = sys.argv[2]
TARGET = ROOT if RELATIVE == "." else os.path.join(ROOT, *RELATIVE.split("/"))
MAX_ENTRIES = int(sys.argv[3])
MAX_SCANNED = int(sys.argv[4])
MAX_PATH_BYTES = int(sys.argv[5])
MAX_ENVELOPE_BYTES = int(sys.argv[6])

def emit(value):
    print(json.dumps(value, separators=(",", ":")))

def capped_entries(path, limit):
    """Inspect and sort at most limit names; probe one extra only to mark truncation."""
    values = []
    visited = 0
    cut = False
    try:
        with os.scandir(path) as iterator:
            for entry in iterator:
                if visited >= limit:
                    cut = True
                    break
                visited += 1
                try:
                    if entry.is_symlink():
                        kind, size = "symlink", 0
                    elif entry.is_file(follow_symlinks=False):
                        kind, size = "file", entry.stat(follow_symlinks=False).st_size
                    elif entry.is_dir(follow_symlinks=False):
                        kind, size = "directory", 0
                    else:
                        kind, size = "other", 0
                    values.append((entry.name, kind, size))
                except OSError:
                    continue
    except OSError:
        return [], False
    values.sort(key=lambda value: value[0])
    return values, cut

if not os.path.isdir(ROOT) or os.path.islink(ROOT):
    emit({"state": "unavailable", "entries": [], "scannedEntries": 0, "truncated": False})
    raise SystemExit(0)

relative = RELATIVE
cursor = ROOT
if relative != ".":
    for part in relative.split(os.sep):
        cursor = os.path.join(cursor, part)
        if os.path.islink(cursor):
            emit({"state": "symlink", "entries": [], "scannedEntries": 0, "truncated": False})
            raise SystemExit(0)

if not os.path.exists(TARGET):
    emit({"state": "not_found", "entries": [], "scannedEntries": 0, "truncated": False})
    raise SystemExit(0)
if not os.path.isdir(TARGET):
    emit({"state": "not_a_directory", "entries": [], "scannedEntries": 0, "truncated": False})
    raise SystemExit(0)

entries = []
scanned = 0
path_bytes = 0
truncated = False

children, children_cut = capped_entries(TARGET, min(MAX_ENTRIES + 2, MAX_SCANNED))
truncated = children_cut

for name, kind, size in children:
    path = os.path.join(TARGET, name)
    rel = os.path.relpath(path, ROOT).replace(os.sep, "/")
    if rel == ".inflexa" or rel.startswith(".inflexa/") or rel == "registry.json":
        continue
    scanned += 1
    rendered = "/mnt/refs/" + rel
    item = None

    if kind == "symlink":
        item = {"path": rendered, "kind": "symlink", "bytes": 0}
    elif kind == "file":
        item = {"path": rendered, "kind": "file", "bytes": size}
    elif kind == "directory":
        total_bytes = 0
        file_count = 0
        file_types = set()
        directory_truncated = False
        stack = [path]
        while stack and scanned < MAX_SCANNED:
            current = stack.pop()
            descendants, descendants_cut = capped_entries(current, MAX_SCANNED - scanned)
            directory_truncated = directory_truncated or descendants_cut
            child_directories = []
            for child_name, child_kind, child_size in descendants:
                scanned += 1
                if child_kind == "directory":
                    child_directories.append(os.path.join(current, child_name))
                elif child_kind == "file":
                    file_count += 1
                    total_bytes += child_size
                    suffix = os.path.splitext(child_name)[1].lower()
                    if suffix:
                        file_types.add(suffix)
                if scanned >= MAX_SCANNED:
                    directory_truncated = True
                    break
            stack.extend(reversed(child_directories))
        item = {
            "path": rendered,
            "kind": "directory",
            "bytes": total_bytes,
            "fileCount": file_count,
            "fileTypes": sorted(file_types)[:10],
            "truncated": directory_truncated,
        }
        truncated = truncated or directory_truncated

    if item is not None:
        if len(entries) < MAX_ENTRIES and path_bytes + len(rendered.encode()) <= MAX_PATH_BYTES:
            entries.append(item)
            path_bytes += len(rendered.encode())
        else:
            truncated = True
    if scanned >= MAX_SCANNED:
        truncated = True
        break

receipts = []
receipt_bytes = 0
metadata_dir = os.path.join(ROOT, ".inflexa")
receipts_dir = os.path.join(metadata_dir, "receipts")
try:
    if os.path.islink(metadata_dir) or os.path.islink(receipts_dir):
        raise ValueError("symlinked metadata directory")
    receipt_entries, _ = capped_entries(receipts_dir, 100)
    for name, kind, _ in receipt_entries:
        path = os.path.join(receipts_dir, name)
        if kind != "file":
            continue
        # Per-file, so one unreadable or malformed receipt costs only its own labels.
        # A shared try would abandon the loop and silently drop every receipt sorting
        # after the bad one, quietly stripping metadata from datasets that are fine.
        try:
            with open(path, "rb") as handle:
                raw = handle.read(16385)
            if len(raw) > 16384 or receipt_bytes + len(raw) > 32768:
                continue
            parsed = json.loads(raw)
        except Exception:
            continue
        receipts.append(parsed)
        receipt_bytes += len(raw)
except Exception:
    pass

legacy_entries = []
try:
    registry_path = os.path.join(ROOT, "registry.json")
    if os.path.islink(registry_path):
        raise ValueError("symlinked registry")
    with open(registry_path, "rb") as handle:
        registry = json.loads(handle.read(131073))
    if isinstance(registry, dict):
        by_category = registry.get("files", {}).get("by_category", {})
        if isinstance(by_category, dict):
            for category in sorted(by_category):
                values = by_category.get(category)
                if not isinstance(values, list):
                    continue
                for item in values:
                    if len(legacy_entries) >= 200:
                        break
                    if isinstance(item, dict) and isinstance(item.get("local_path"), str):
                        legacy_entries.append({
                            "local_path": item["local_path"][:1000],
                            "category": str(category)[:500],
                            "dataset": str(item.get("dataset"))[:500] if item.get("dataset") is not None else None,
                            "subtype": str(item.get("subtype"))[:500] if item.get("subtype") is not None else None,
                            "organism": str(item.get("organism"))[:500] if item.get("organism") is not None else None,
                            "rows": item.get("rows"),
                            "endpoint": item.get("endpoint"),
                        })
except Exception:
    pass

payload = {
    "state": "empty" if len(entries) == 0 else "populated",
    "entries": entries,
    "scannedEntries": scanned,
    "truncated": truncated,
    "receipts": receipts,
    "legacyEntries": legacy_entries,
}
while len(json.dumps(payload, separators=(",", ":")).encode()) > MAX_ENVELOPE_BYTES:
    payload["truncated"] = True
    if payload["legacyEntries"]:
        payload["legacyEntries"].pop()
    elif payload["receipts"]:
        payload["receipts"].pop()
    elif payload["entries"]:
        payload["entries"].pop()
    else:
        break
emit(payload)
`;

const ListAvailableRefsInputSchema = z.object({
    path: z
        .string()
        .max(MAX_INPUT_PATH_BYTES)
        .optional()
        .describe("Directory beneath /mnt/refs to inspect — a returned absolute path or a store-relative path. Use it to drill into a subtree when a listing is truncated."),
    category: z
        .string()
        .max(MAX_INPUT_PATH_BYTES)
        .optional()
        .describe('Shorthand for a top-level group to inspect (e.g. "atlas_singlecell", "msigdb"); the groups present come back in `categories`. Ignored when `path` is given.'),
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
        .describe(`Max entries to return (default ${MAX_ENTRIES}); the response carries \`returned\`, \`total\`, and \`hasMore\` so truncation is never silent.`),
});

export interface ListAvailableRefsDeps {
    readonly sandboxClient: SandboxClient;
    readonly sandbox: SandboxRef;
    readonly workflowId: string;
    readonly stepId: string;
    readonly nextFunctionId: () => string;
    readonly deadlineMs: () => number;
    readonly markExecActive?: (execId: string) => Promise<void>;
    /** Filesystem root used by the scanner; production callers omit this. */
    readonly scanRoot?: string;
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
    readonly rows?: number;
    readonly endpoint?: string;
}

interface ReferenceInventoryEntryBase {
    readonly path: string;
    readonly metadata?: ReferenceInventoryMetadata;
}

/** A bounded, no-follow observation from the live reference mount. */
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

const RawScanSchema = z.object({
    state: z.enum(["unavailable", "empty", "populated", "not_found", "not_a_directory", "symlink"]),
    entries: z.array(
        z.discriminatedUnion("kind", [
            z.object({ path: z.string().startsWith(`${REFS_ROOT}/`), kind: z.literal("file"), bytes: z.number().nonnegative() }),
            z.object({ path: z.string().startsWith(`${REFS_ROOT}/`), kind: z.literal("symlink"), bytes: z.literal(0) }),
            z.object({
                path: z.string().startsWith(`${REFS_ROOT}/`),
                kind: z.literal("directory"),
                bytes: z.number().nonnegative(),
                fileCount: z.number().int().nonnegative(),
                fileTypes: z.array(z.string()),
                truncated: z.boolean(),
            }),
        ]),
    ),
    scannedEntries: z.number().int().nonnegative(),
    truncated: z.boolean(),
    receipts: z.array(z.unknown()).optional(),
    legacyEntries: z.array(z.unknown()).optional(),
});

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
            metadata.set(`${REFS_ROOT}/managed/${receipt.datasetId}/${receipt.datasetVersion}/${artifact.path}`, {
                datasetId: receipt.datasetId,
                version: receipt.datasetVersion,
                ...(dataset
                    ? {
                          title: dataset.title,
                          description: dataset.description,
                          sourceUrl: dataset.sourceUrl,
                          license: dataset.license.url ?? dataset.license.identifier,
                      }
                    : {}),
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

/** Case-insensitive substring match over an inventory entry's path and joined metadata labels. */
function entryMatchesQuery(entry: ReferenceInventoryEntry, needle: string): boolean {
    const fields = [entry.path, entry.metadata?.datasetId, entry.metadata?.title, entry.metadata?.category, entry.metadata?.subtype, entry.metadata?.organism];
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
        return "Reference store is not mounted at /mnt/refs. Reference data cannot be downloaded from sandbox workloads; provision it through the host setup flow.";
    if (scan.state === "not_found") return `Reference path does not exist: ${path}`;
    if (scan.state === "not_a_directory") return `Reference path is not a directory: ${path}`;
    if (scan.state === "symlink") return `Reference path crosses a symlink and was not scanned: ${path}`;
    if (scan.state === "empty") return `Reference store path is mounted but contains no reference files: ${path}`;

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
    }
    if (scan.truncated)
        lines.push(`Inventory truncated after scanning ${scan.scannedEntries} entries. Call list_available_refs with a narrower path to drill down.`);
    return lines.join("\n");
}

/** Create replay-safe reference discovery bound to the active sandbox. */
export function createListAvailableRefsTool(deps: ListAvailableRefsDeps) {
    return defineTool({
        id: "list_available_refs",
        executionMode: "workflow",
        description:
            "Inspect the reference files actually mounted read-only at /mnt/refs — the ONLY reference data that exists here; nothing can be downloaded at runtime. " +
            "Returns managed and user-added files even when no manifest names them; valid receipts and legacy registry data only add labels (dataset, category, organism, subtype). Symlinks are never followed. " +
            "Results are ALWAYS bounded — prefer a targeted query over a full dump: " +
            "`path` inspects one directory beneath /mnt/refs (a returned path, or store-relative) — drill in with it when a listing is truncated; " +
            '`category` is shorthand for a top-level group (e.g. "atlas_singlecell", "msigdb"), and the groups present come back in `categories`; ' +
            "`query` is a case-insensitive substring filter over each entry's path and its dataset/title/category/organism/subtype labels; " +
            "`limit` caps the entries returned. The response carries `returned`, `total`, and `hasMore`, so truncation is never silent. " +
            "Provision additional files through the host and re-run in a sandbox with that store mounted.",
        inputSchema: ListAvailableRefsInputSchema,
        execute: async ({ path, category, query, limit }, ctx) => {
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

            const execId = `${deps.workflowId}:${deps.stepId}:${deps.nextFunctionId()}`;
            const result = await runSandboxExec({
                sandboxClient: deps.sandboxClient,
                sandbox: deps.sandbox,
                execId,
                command: [
                    "python3",
                    "-c",
                    SCAN_SCRIPT,
                    deps.scanRoot ?? REFS_ROOT,
                    posixPath.relative(REFS_ROOT, requested.path) || ".",
                    String(MAX_ENTRIES),
                    String(MAX_SCANNED_ENTRIES),
                    String(MAX_PATH_BYTES),
                    String(MAX_ENVELOPE_BYTES),
                ],
                timeoutSeconds: 20,
                deadlineMs: deps.deadlineMs(),
                emit: ctx.emit,
                ...(deps.markExecActive ? { markExecActive: deps.markExecActive } : {}),
            });
            if (result.exitCode !== 0) throw new Error(`Reference inventory command failed (${result.exitCode}): ${result.stderr}`);

            if (Buffer.byteLength(result.stdout, "utf8") > MAX_ENVELOPE_BYTES + 1) {
                throw new Error("Reference inventory response exceeded its output bound");
            }
            const raw: RawScan = RawScanSchema.parse(JSON.parse(result.stdout));
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

export interface RegistryEntry {
    local_path: string;
    sha256: string;
    bytes: number;
    rows: number | null;
    category: string | null;
    subtype: string | null;
    organism: string | null;
    tax_id: string | null;
    dataset: string | null;
    endpoint: string | null;
}

export interface Registry {
    registry_version: string;
    build_id: string;
    generated_at: string;
    files: {
        by_category: Record<string, RegistryEntry[]>;
    };
    summary: {
        total_output_files: number;
        categories: string[];
    };
}

/**
 * Either the store is unmounted, or a bounded listing: `categories` always names
 * the full valid set (the drill-in index), and `total`/`hasMore` make truncation
 * explicit.
 */
export type RefsResult =
    | { readonly available: false; readonly content: string }
    | {
          readonly available: true;
          readonly total: number;
          readonly returned: number;
          readonly hasMore: boolean;
          readonly categories: readonly string[];
          readonly content: string;
      };

const CATEGORY_LABELS: Record<string, string> = {
    atlas_singlecell:
        "Single-cell reference atlases for label transfer (Pan-Cancer T cell — " +
        "Zheng 2021, Pan-Cancer Myeloid — Cheng 2021, Tumor Immune Cell Atlas — " +
        "Nieto 2021, Tabula Sapiens v2). Available as .h5ad (Python: anndata, " +
        "scanpy, scvi-tools, symphonypy) and/or .rds (R: Seurat, ProjecTILs). " +
        "Tabula Sapiens ships full + immune_subset variants. " +
        "Use these for label transfer BEFORE falling back to marker genes.",
    atlas_azimuth:
        "Azimuth references (Seurat-native): PBMC v1.0.0 and Tonsil v1.0.0. " +
        "Each entry is a (ref.Rds, idx.annoy) pair stored under " +
        "/mnt/refs/atlas_azimuth/{pbmc,tonsil}/. Load with " +
        "Azimuth::LoadReference(path) where path is the directory containing " +
        "ref.Rds + idx.annoy (e.g. '/mnt/refs/atlas_azimuth/pbmc'), then " +
        "Azimuth::RunAzimuth(query, reference = path).",
    atlas_projectils:
        "ProjecTILs reference atlases (Seurat .rds): human + mouse, CD8 + CD4. " +
        "Use ProjecTILs::ProjecTILs.classifier() to assign every CD8 to one of " +
        "the canonical TCF7+/GZMK+/TEX/TPEX/MAIT substates without re-deriving " +
        "the classifier from scratch.",
    celltypist_models:
        "Pre-staged CellTypist .pkl classifier models (Immune_All_Low backed by " +
        "the Cross-Tissue Immune Cell Atlas; Immune_All_High; Pan_Fetal_Human; " +
        "COVID19_Immune_Landscape). CELLTYPIST_FOLDER env var is preset, so " +
        "celltypist.annotate_cells(model='Immune_All_Low') resolves with no " +
        "network call.",
    marker_panels:
        "Marker gene panels: PanglaoDB (community, parquet long-format), " +
        "CellMarker 2.0 (tumor-context, parquet long-format), and the Cortex " +
        "hand-curated panel for Stage 1 substates (TCF7+ memory CD8, exhausted " +
        "CD8, effector-memory CD8, proliferating T, cDC1/cDC2/LAMP3+ DC, SPP1+ " +
        "TAM, C1Q+ TAM, Tregs) — JSON with full provenance.",
    gene_signatures:
        "Curated gene signatures from key tumor-immune papers: Sade-Feldman " +
        "2018 exhausted CD8 (Table S2), Jerby-Arnon 2018 malignant resistance " +
        "program (Table S1, Stage 3 classifier substrate), Tirosh 2016 AXL/MITF " +
        "programs, Puram 2017 p-EMT (Table S5, HNSCC), Reactome cGAS-STING " +
        "pathway (Stage 2.3 type-I IFN). JSON with PMID/DOI per entry.",
    normal_reference:
        "Normal-tissue references for safety firing checks: GTEx v8 per-tissue " +
        "median TPM (parquet) + sample attributes (parquet). Use to quantify " +
        "off-target activation of any nominated classifier across healthy tissues.",
    gene_mappings:
        "Gene ID Conversion Tables: Entrez/Ensembl/RefSeq/UniProt to symbol (NCBI); " +
        "orthologs (Ensembl Compara) — file: orthologs_{tax_id}.parquet, columns: " +
        "tax_id, ensembl_gene_id, entrez_id, symbol, relationship, other_tax_id, " +
        "other_ensembl_gene_id, other_entrez_id, other_symbol; symmetric — to find " +
        "human orthologs of Macaca fascicularis genes, open orthologs_9541.parquet " +
        "and filter other_tax_id == '9606'; cross-division (e.g. yeast↔mouse) " +
        "requires pivoting through human: yeast→human via orthologs_4896.parquet, " +
        "then human→mouse via orthologs_9606.parquet",
    omnipath: "OmniPath (interactions, regulons, annotations)",
    reactome: "Reactome Pathways",
    progeny: "PROGENy Pathway Weights (decoupler: source/target/weight/padj)",
    collectri: "CollecTRI TF-Target Regulons (decoupler: source/target/mor)",
    dorothea: "DoRothEA TF Regulons (decoupler: source/target/weight/confidence)",
    lincs: "LINCS L1000 Drug Perturbation Consensus Signatures (up/down gene sets)",
    hpa: "Human Protein Atlas (tissue RNA expression, target safety/secretome, full 107-column atlas)",
    wikipathways: "WikiPathways Gene Sets",
    msigdb: "MSigDB Gene Set Collections",
    safety_targets: "Curated Off-Target Safety Panel (CSV + JSON: chembl_id, gene_symbol, uniprot, organ_system, severity, clinical_consequence)",
};

const CATEGORY_ORDER = [
    "atlas_singlecell",
    "atlas_azimuth",
    "atlas_projectils",
    "celltypist_models",
    "marker_panels",
    "gene_signatures",
    "normal_reference",
    "safety_targets",
    "progeny",
    "collectri",
    "dorothea",
    "omnipath",
    "lincs",
    "msigdb",
    "wikipathways",
    "reactome",
    "hpa",
    "gene_mappings",
];

/** The registry's categories in canonical order, unknown ones appended. */
function orderedCategories(registry: Registry): string[] {
    const byCategory = registry.files.by_category;
    const known = new Set(CATEGORY_ORDER);
    return [...CATEGORY_ORDER.filter((c) => byCategory[c]), ...Object.keys(byCategory).filter((c) => !known.has(c))];
}

/** Case-insensitive substring match over the descriptive fields the registry carries. */
function matchesQuery(category: string, entry: RegistryEntry, needle: string): boolean {
    const haystack = [category, entry.local_path, entry.dataset, entry.organism, entry.subtype, entry.tax_id].filter(
        (v): v is string => typeof v === "string" && v.length > 0,
    );
    return haystack.some((field) => field.toLowerCase().includes(needle));
}

/** One file line: `name: /mnt/refs/<local_path>  (rows, subtype, dataset)`. */
function renderEntry(entry: RegistryEntry): string {
    const path = join(REFS_ROOT, entry.local_path);
    const name = basename(entry.local_path);
    const info = [entry.rows != null ? `${entry.rows.toLocaleString()} rows` : null, entry.subtype, entry.dataset].filter(Boolean).join(", ");
    return `  ${name}: ${path}${info ? `  (${info})` : ""}`;
}

/** The tool's input, as parsed from `inputSchema`. */
export interface RefsQuery {
    readonly category?: string;
    readonly query?: string;
    readonly limit?: number;
}

/**
 * Answer a refs query against a parsed registry. Pure — the tool's `execute` is
 * only the file read plus this call.
 */
export function queryRefs(registry: Registry, { category, query, limit }: RefsQuery): RefsResult {
    const categories = orderedCategories(registry);

    // An unknown category is a caller mistake, not a failure — name the valid set
    // rather than returning an empty listing with no explanation.
    if (category && !categories.includes(category)) {
        return {
            available: true,
            total: 0,
            returned: 0,
            hasMore: false,
            categories,
            content: `Unknown category "${category}". Valid categories: ${categories.join(", ")}.`,
        };
    }

    const needle = query?.trim().toLowerCase();
    const selected = category ? [category] : categories;

    // Filter first so `total` is the honest count of matching files, then bound.
    const matched = selected.map((c) => {
        const entries = registry.files.by_category[c] ?? [];
        return { category: c, entries: needle ? entries.filter((e) => matchesQuery(c, e, needle)) : entries };
    });
    const total = matched.reduce((n, m) => n + m.entries.length, 0);

    if (total === 0) {
        const scope = [category ? `category: ${category}` : null, query ? `query: "${query}"` : null].filter(Boolean).join(", ");
        return {
            available: true,
            total: 0,
            returned: 0,
            hasMore: false,
            categories,
            content: `No reference files match this filter${scope ? ` (${scope})` : ""}. Nothing can be downloaded at runtime.`,
        };
    }

    const cap = limit ?? DEFAULT_LIMIT;
    const lines: string[] = [];
    let returned = 0;
    for (const { category: c, entries } of matched) {
        if (entries.length === 0) continue;
        lines.push(`\n## ${CATEGORY_LABELS[c] ?? c}`);
        const room = cap - returned;
        if (room <= 0) {
            lines.push(`  ${entries.length} file(s) — not shown (limit reached). Call with category: "${c}" to list them.`);
            continue;
        }
        const shown = entries.slice(0, room);
        returned += shown.length;
        for (const entry of shown) lines.push(renderEntry(entry));
        const hidden = entries.length - shown.length;
        if (hidden > 0) lines.push(`  … and ${hidden} more in this category — call with category: "${c}" (and a higher \`limit\`) to list them.`);
    }

    const header = [
        `Reference Store (build ${registry.build_id}, ${registry.generated_at})`,
        `Mount: ${REFS_ROOT}`,
        `Matching files: ${total} (showing ${returned})`,
    ].join("\n");

    return {
        available: true,
        total,
        returned,
        hasMore: returned < total,
        categories,
        content: header + "\n" + lines.join("\n"),
    };
}
