/**
 * The input scan — one deterministic pass over a staged input tree.
 *
 * Runs in the harness process over the workspace read seam, which is
 * sandbox-independent: the walk touches names and metadata, and format detection
 * compares a bounded byte prefix against a table. Neither is a decode, so neither
 * needs a container. Only the per-shape header readout (`enrich.ts`) runs a decoder,
 * and it runs in the sandbox.
 *
 * The scan is the SOLE enumeration pass. Before it, the profiler agent discovered
 * structure by issuing one command per input file, so its cost scaled with file
 * count and its step budget did not.
 */

import type { AgentSession } from "../auth/types.js";
import { unwrapOrThrow } from "../lib/result.js";
import type { WorkspaceFilesystem } from "../workspace/filesystem.js";

import { MAGIC_PREFIX_BYTES, detectFormat, extensionChain } from "./formats.js";
import { observeShapes } from "./shapes.js";
import type { FormatCount, InputScan, InputScanManifest, ScannedFile } from "./types.js";

/**
 * Files walked before the scan reports truncation instead of completing.
 *
 * Header decode is O(shapes), but the walk and its per-file prefix read are O(files),
 * and that arm needs a stated ceiling rather than an implicit one. 100k files is ~30s
 * of stat-and-prefix work against a 20-minute profile deadline, and two orders of
 * magnitude above the largest tree the platform has seen (3513). Past it the scan
 * stops and SAYS it stopped: a silently sampled manifest would describe a fraction of
 * the tree while reading as a description of all of it, which is the failure mode this
 * capability exists to remove.
 */
export const MAX_SCANNED_FILES = 100_000;

export interface ScanInputTreeArgs {
    readonly session: AgentSession;
    readonly fs: WorkspaceFilesystem;
    /** Directory to scan, relative to the analysis root (e.g. `data/inputs`). */
    readonly root: string;
    /** Walk ceiling; defaults to {@link MAX_SCANNED_FILES}. */
    readonly limit?: number;
    readonly signal?: AbortSignal;
}

/** Walk the tree breadth-first, reading a bounded prefix of each file for format detection. */
async function walk(args: ScanInputTreeArgs): Promise<{ files: ScannedFile[]; truncated: boolean }> {
    const { session, fs, root, signal } = args;
    const limit = args.limit ?? MAX_SCANNED_FILES;
    const files: ScannedFile[] = [];
    const queue: string[] = [root];
    let truncated = false;

    while (queue.length > 0) {
        signal?.throwIfAborted();
        const dir = queue.shift()!;
        const listing = unwrapOrThrow(await fs.list({ session, path: dir }));
        // A directory that vanished mid-walk, or one the seam refuses, is not a scan
        // failure — the tree is being described, not validated.
        if (listing.kind !== "ok") continue;

        for (const entry of listing.entries) {
            const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
            if (entry.type === "directory") {
                queue.push(path);
                continue;
            }
            if (files.length >= limit) {
                truncated = true;
                return { files, truncated };
            }
            const extensions = extensionChain(entry.name);
            const read = unwrapOrThrow(await fs.readBytes({ session, path, length: MAGIC_PREFIX_BYTES }));
            const prefix = read.kind === "ok" ? read.bytes : null;
            const { format, wrapper } = detectFormat({ path, extensions, prefix });
            files.push({
                path,
                size: entry.size ?? 0,
                extensions,
                format,
                ...(wrapper ? { wrapper } : {}),
            });
        }
    }

    return { files, truncated };
}

function formatCensus(files: readonly ScannedFile[]): FormatCount[] {
    const counts = new Map<string, number>();
    for (const file of files) counts.set(file.format, (counts.get(file.format) ?? 0) + 1);
    return [...counts.entries()].map(([format, count]) => ({ format, count })).sort((a, b) => b.count - a.count || a.format.localeCompare(b.format, "en"));
}

/** Assemble a manifest from an already-walked file set. Pure — the seam of the unit tests. */
export function buildManifest(root: string, files: readonly ScannedFile[], truncated: boolean, limit: number = MAX_SCANNED_FILES): InputScan {
    const observed = observeShapes(files);
    const manifest: InputScanManifest = {
        root,
        fileCount: files.length,
        totalBytes: files.reduce((sum, f) => sum + f.size, 0),
        truncated,
        ...(truncated ? { scanLimit: limit } : {}),
        shapesTruncated: observed.shapesTruncated,
        formats: formatCensus(files),
        shapes: observed.shapes,
        valueOverlaps: observed.valueOverlaps,
        unstructured: observed.unstructured,
    };
    return { files, manifest, positionValues: observed.positionValues };
}

/** Walk a staged input tree and observe its shapes. No model, no container. */
export async function scanInputTree(args: ScanInputTreeArgs): Promise<InputScan> {
    const limit = args.limit ?? MAX_SCANNED_FILES;
    const { files, truncated } = await walk(args);
    return buildManifest(args.root, files, truncated, limit);
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * Render a manifest for a briefing or a tool result.
 *
 * Bounded by construction — every list it draws from is already capped — so a tree of
 * three thousand files costs the same context as a tree of thirty. The wording states
 * observations only: it never calls a shape a kind, and it says outright that the
 * grouping decision is the reader's.
 */
export function renderInputScanManifest(manifest: InputScanManifest): string {
    const lines: string[] = [];
    lines.push(`Input scan of ${manifest.root} — ${manifest.fileCount} files, ${formatBytes(manifest.totalBytes)}.`);
    if (manifest.truncated) {
        lines.push(`INCOMPLETE: the walk stopped at its ${manifest.scanLimit ?? MAX_SCANNED_FILES}-file ceiling, so this describes part of the tree.`);
    }
    lines.push(`Formats: ${manifest.formats.map((f) => `${f.format} (${f.count})`).join(", ") || "none"}`);
    lines.push("");
    lines.push("These are OBSERVATIONS of filename structure, not a grouping of the dataset.");
    lines.push("A shape is a set of files whose names differ only at the marked positions; deciding");
    lines.push("what is one kind of data, and what the varying positions mean, is your judgement.");

    if (manifest.shapes.length > 0) {
        lines.push("");
        lines.push(`Shapes (${manifest.shapes.length}${manifest.shapesTruncated ? ", capped — the remainder is in the aggregate below" : ""}):`);
        for (const shape of manifest.shapes) {
            const location = shape.directory ? `${shape.directory}/` : "";
            const wrapper = shape.wrapper ? `, ${shape.wrapper}-compressed` : "";
            lines.push(`- ${shape.id}: ${shape.fileCount} files at ${location}${shape.pattern} (${shape.format}${wrapper}, ${formatBytes(shape.totalBytes)})`);
            for (const position of shape.variablePositions) {
                const prefix = position.prefix ? ` after "${position.prefix}"` : "";
                const shown = position.sampleValues.join(", ");
                const more = position.distinctValues > position.sampleValues.length ? ", …" : "";
                lines.push(`  - position <${position.index}>${prefix}: ${position.distinctValues} distinct values — ${shown}${more}`);
            }
            for (const pair of shape.cooccurrence) {
                const crossing = pair.observedPairs === pair.possiblePairs ? "fully crossed" : `partially crossed (${pair.possiblePairs} possible)`;
                lines.push(`  - positions <${pair.positions[0]}>×<${pair.positions[1]}>: ${pair.observedPairs} observed combinations, ${crossing}`);
            }
            if (shape.header) {
                const fields = Object.entries(shape.header.fields)
                    .map(([key, value]) => `${key}=${value}`)
                    .join(", ");
                lines.push(`  - header (${shape.header.path}): ${fields || shape.header.unavailable || "no fields read"}`);
            } else {
                lines.push(`  - example: ${shape.examplePaths[0] ?? "—"}`);
            }
        }
    }

    if (manifest.valueOverlaps.length > 0) {
        lines.push("");
        lines.push("Value overlap between shapes (evidence, NOT an assertion that they share an axis):");
        for (const overlap of manifest.valueOverlaps) {
            const gaps: string[] = [];
            if (overlap.onlyInFirst > 0) gaps.push(`${overlap.onlyInFirst} only in ${overlap.shapes[0]} (${overlap.onlyInFirstSample.join(", ")})`);
            if (overlap.onlyInSecond > 0) gaps.push(`${overlap.onlyInSecond} only in ${overlap.shapes[1]} (${overlap.onlyInSecondSample.join(", ")})`);
            const gapText = gaps.length > 0 ? `; ${gaps.join("; ")}` : "; no gaps";
            lines.push(
                `- ${overlap.shapes[0]}<${overlap.positions[0]}> vs ${overlap.shapes[1]}<${overlap.positions[1]}>: ` +
                    `${overlap.sharedValues} shared values${gapText}`,
            );
        }
    }

    if (manifest.unstructured.count > 0) {
        lines.push("");
        lines.push(`Files sharing no name structure with any other (${manifest.unstructured.count}, ${formatBytes(manifest.unstructured.totalBytes)}):`);
        for (const entry of manifest.unstructured.sample) {
            lines.push(`- ${entry.path} (${entry.format}, ${formatBytes(entry.size)})`);
        }
        if (manifest.unstructured.count > manifest.unstructured.sample.length) {
            lines.push(`- … ${manifest.unstructured.count - manifest.unstructured.sample.length} more not listed`);
        }
    }

    return lines.join("\n");
}
