/**
 * The entries of a compressed file, for the read tools of a script: a zip, a tar, a gzip-compressed tar, or one
 * gzip-compressed file.
 *
 * Each read runs on the host and holds the bytes in memory, thus each one has a cap. A zip names the size of each
 * entry in its index, thus a list reads no entry and a read decompresses one entry. A tar has no index, thus a list
 * and a read of a `.tar.gz` decompress the whole stream, up to {@link ARCHIVE_SCAN_CAP_BYTES}.
 *
 * The streamed extractors write a whole archive to disk, and their memory does not grow with the archive.
 */

import { mkdir, open, type FileHandle } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";

import { Unzip, UnzipInflate, unzipSync } from "fflate";
import { err, ok, type Result } from "neverthrow";

export type ArchiveKind = "zip" | "tar" | "tar-gzip" | "gzip";

/** The cap of the decompressed stream of a gzip-compressed tar or file that a list or a read decompresses. */
export const ARCHIVE_SCAN_CAP_BYTES = 64 * 1024 * 1024;

export type ArchiveEntry = { readonly name: string; readonly bytes: number };

/** Why an entry did not read. `too_large` carries the size of the entry, when the archive names it. */
export type EntryRefusal =
    | { readonly kind: "not_found" }
    | { readonly kind: "too_large"; readonly bytes: number | undefined }
    | { readonly kind: "unparsable"; readonly detail: string };

/** The kind of a compressed file by its name, or `undefined` for a file that is not one. */
export function archiveKindOf(path: string): ArchiveKind | undefined {
    const lower = path.toLowerCase();
    if (lower.endsWith(".zip")) return "zip";
    if (lower.endsWith(".tar")) return "tar";
    if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "tar-gzip";
    if (lower.endsWith(".gz")) return "gzip";
    return undefined;
}

/** The one entry of a gzip-compressed file: its name with no `.gz`. */
export function gzipEntryName(path: string): string {
    return basename(path).slice(0, -".gz".length);
}

/** The decompressed bytes of a gzip stream, or `too_large` past `cap`. */
function gunzip(content: Buffer, cap: number): Result<Buffer, EntryRefusal> {
    try {
        return ok(gunzipSync(content, { maxOutputLength: cap }));
    } catch (cause) {
        if (cause instanceof RangeError) return err({ kind: "too_large", bytes: undefined });
        return err({ kind: "unparsable", detail: "the gzip stream is damaged" });
    }
}

const TAR_BLOCK = 512;

/** One text field of a tar header: the bytes up to the first NUL. */
function tarText(block: Buffer, start: number, length: number): string {
    const field = block.subarray(start, start + length);
    const end = field.indexOf(0);
    return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

/** The `path` record of a pax extended header, which names an entry longer than the header field holds. */
function paxPath(data: Buffer): string | undefined {
    for (const line of data.toString("utf8").split("\n")) {
        const record = line.slice(line.indexOf(" ") + 1);
        if (record.startsWith("path=")) return record.slice("path=".length);
    }
    return undefined;
}

/**
 * Each regular file of a tar, with its data. A GNU long name and a pax `path` record rename the entry that follows
 * them. A directory, a link, and each other special entry is no file, thus it is skipped.
 */
function tarFiles(tar: Buffer): Result<Array<{ name: string; data: Buffer }>, EntryRefusal> {
    const files: Array<{ name: string; data: Buffer }> = [];
    let offset = 0;
    let longName: string | undefined;
    while (offset + TAR_BLOCK <= tar.length) {
        const header = tar.subarray(offset, offset + TAR_BLOCK);
        if (header.every((byte) => byte === 0)) break;
        const size = Number.parseInt(tarText(header, 124, 12).trim() || "0", 8);
        if (!Number.isSafeInteger(size) || size < 0) return err({ kind: "unparsable", detail: "a tar header has no valid size" });
        const dataStart = offset + TAR_BLOCK;
        if (dataStart + size > tar.length) return err({ kind: "unparsable", detail: "the tar ends inside an entry" });
        const data = tar.subarray(dataStart, dataStart + size);
        const type = String.fromCharCode(header[156] ?? 0);
        const prefix = tarText(header, 257, 6) === "ustar" ? tarText(header, 345, 155) : "";
        const name = longName ?? (prefix === "" ? tarText(header, 0, 100) : `${prefix}/${tarText(header, 0, 100)}`);
        if (type === "L") longName = tarText(data, 0, data.length);
        else if (type === "x") longName = paxPath(data) ?? longName;
        else {
            longName = undefined;
            if (type === "0" || type === "\0") files.push({ name, data });
        }
        offset = dataStart + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
    }
    return ok(files);
}

/** The tar inside a tar archive: the bytes themselves, or the decompressed stream of a `.tar.gz`. */
function tarOf(kind: "tar" | "tar-gzip", content: Buffer): Result<Buffer, EntryRefusal> {
    return kind === "tar" ? ok(content) : gunzip(content, ARCHIVE_SCAN_CAP_BYTES);
}

/** The files of a zip, as its index names them. A directory entry is no file. */
function zipIndex(content: Buffer): Result<ArchiveEntry[], EntryRefusal> {
    const entries: ArchiveEntry[] = [];
    try {
        unzipSync(content, {
            filter: (file) => {
                if (!file.name.endsWith("/")) entries.push({ name: file.name, bytes: file.originalSize });
                return false;
            },
        });
    } catch {
        return err({ kind: "unparsable", detail: "the zip is damaged" });
    }
    return ok(entries);
}

/** Each file of a compressed file, with its decompressed size. */
export function listArchive(kind: ArchiveKind, path: string, content: Buffer): Result<ArchiveEntry[], EntryRefusal> {
    switch (kind) {
        case "zip":
            return zipIndex(content);
        case "gzip": {
            // The last 4 bytes of a gzip stream hold the decompressed size, modulo 2^32.
            const bytes = content.length >= 4 ? content.readUInt32LE(content.length - 4) : 0;
            return ok([{ name: gzipEntryName(path), bytes }]);
        }
        case "tar":
        case "tar-gzip":
            return tarOf(kind, content)
                .andThen(tarFiles)
                .map((files) => files.map((file) => ({ name: file.name, bytes: file.data.length })));
        default: {
            const unhandled: never = kind;
            throw new Error(`unhandled archive kind: ${String(unhandled)}`);
        }
    }
}

/** The decompressed bytes of one entry, up to `cap`. */
export function readArchiveEntry(kind: ArchiveKind, path: string, content: Buffer, entry: string, cap: number): Result<Buffer, EntryRefusal> {
    switch (kind) {
        case "zip": {
            const index = zipIndex(content);
            if (index.isErr()) return err(index.error);
            const found = index.value.find((file) => file.name === entry);
            if (found === undefined) return err({ kind: "not_found" });
            if (found.bytes > cap) return err({ kind: "too_large", bytes: found.bytes });
            try {
                const data = unzipSync(content, { filter: (file) => file.name === entry })[entry];
                if (data === undefined) return err({ kind: "not_found" });
                // The index can lie about the size, thus the cap holds on the bytes too.
                if (data.length > cap) return err({ kind: "too_large", bytes: data.length });
                return ok(Buffer.from(data.buffer, data.byteOffset, data.length));
            } catch {
                return err({ kind: "unparsable", detail: `the entry ${entry} did not decompress` });
            }
        }
        case "gzip":
            if (entry !== gzipEntryName(path)) return err({ kind: "not_found" });
            return gunzip(content, cap);
        case "tar":
        case "tar-gzip": {
            const files = tarOf(kind, content).andThen(tarFiles);
            if (files.isErr()) return err(files.error);
            const found = files.value.find((file) => file.name === entry);
            if (found === undefined) return err({ kind: "not_found" });
            if (found.data.length > cap) return err({ kind: "too_large", bytes: found.data.length });
            return ok(found.data);
        }
        default: {
            const unhandled: never = kind;
            throw new Error(`unhandled archive kind: ${String(unhandled)}`);
        }
    }
}

/** Why a streamed extraction stopped. `unsafe_entry` names an entry whose path leaves the directory of the extraction. */
export type ExtractRefusal = { readonly kind: "unsafe_entry"; readonly entry: string } | { readonly kind: "unparsable"; readonly detail: string };

/** The most file paths that an extraction summary names. */
export const EXTRACT_SUMMARY_MAX_PATHS = 50;

/** What a streamed extraction wrote, and the link entries that it skipped. `paths` names the first files, relative to the directory of the extraction. */
export type ExtractSummary = {
    readonly files: number;
    readonly directories: number;
    readonly skippedLinks: number;
    readonly paths: readonly string[];
};

function countFile(summary: { files: number; paths: string[] }, dest: string, target: string): void {
    summary.files += 1;
    if (summary.paths.length < EXTRACT_SUMMARY_MAX_PATHS) summary.paths.push(relative(dest, target).split(sep).join("/"));
}

class ExtractStop extends Error {
    constructor(readonly refusal: ExtractRefusal) {
        super(refusal.kind === "unsafe_entry" ? `the entry ${refusal.entry} leaves the directory` : refusal.detail);
    }
}

/**
 * The host path of one archive entry below `dest`, or a refusal for an absolute entry or an entry with a `..`
 * segment. A backslash counts as a separator, because a zip made on Windows can use it.
 */
function entryTarget(dest: string, entry: string): string {
    const driveLetter = entry.charAt(1) === ":" && entry.charAt(0).toLowerCase() !== entry.charAt(0).toUpperCase();
    if (entry.startsWith("/") || entry.startsWith("\\") || driveLetter) throw new ExtractStop({ kind: "unsafe_entry", entry });
    const segments = entry
        .replaceAll("\\", "/")
        .split("/")
        .filter((segment) => segment !== "" && segment !== ".");
    if (segments.some((segment) => segment === ".." || segment.includes("\0"))) throw new ExtractStop({ kind: "unsafe_entry", entry });
    const target = resolve(dest, ...segments);
    if (target !== resolve(dest) && !target.startsWith(resolve(dest) + sep)) throw new ExtractStop({ kind: "unsafe_entry", entry });
    return target;
}

/** Reads exact byte counts from a stream of chunks, and holds at most one chunk beyond the bytes that it gives. */
class ChunkReader {
    private readonly iterator: AsyncIterator<Uint8Array>;
    private pending: Buffer = Buffer.alloc(0);
    private ended = false;

    constructor(source: AsyncIterable<Uint8Array>) {
        this.iterator = source[Symbol.asyncIterator]();
    }

    private async pull(): Promise<boolean> {
        if (this.ended) return false;
        const next = await this.iterator.next();
        if (next.done === true) {
            this.ended = true;
            return false;
        }
        const chunk = Buffer.from(next.value);
        this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
        return true;
    }

    /** Exactly `length` bytes, or `undefined` when the stream ends first. Use it only for a small `length`. */
    async take(length: number): Promise<Buffer | undefined> {
        while (this.pending.length < length) if (!(await this.pull())) return undefined;
        const taken = this.pending.subarray(0, length);
        this.pending = this.pending.subarray(length);
        return taken;
    }

    /** Give `length` bytes to `sink`, chunk by chunk. False when the stream ends first. */
    async pipe(length: number, sink: (chunk: Buffer) => Promise<void>): Promise<boolean> {
        let left = length;
        while (left > 0) {
            if (this.pending.length === 0 && !(await this.pull())) return false;
            const part = this.pending.subarray(0, Math.min(left, this.pending.length));
            this.pending = this.pending.subarray(part.length);
            left -= part.length;
            await sink(part);
        }
        return true;
    }
}

/** The size field of a tar header: octal text, or the base-256 form of GNU tar for an entry of 8 GiB or more. */
function tarSize(header: Buffer): number {
    const first = header[124] ?? 0;
    if ((first & 0x80) === 0) return Number.parseInt(tarText(header, 124, 12).trim() || "0", 8);
    let size = first & 0x7f;
    for (let index = 125; index < 136; index++) size = size * 256 + (header[index] ?? 0);
    return size;
}

/** The longest GNU long name or pax header that the extractor holds in memory. */
const TAR_META_CAP_BYTES = 1024 * 1024;

/**
 * Extract a tar stream into `dest`, a directory that exists. The memory holds one chunk of the stream at a time, and
 * a GNU long name or a pax header up to {@link TAR_META_CAP_BYTES}. Only a regular file and a directory reach the
 * disk. A link entry is skipped, and each other special entry is skipped too. An entry whose path is absolute or holds
 * `..` stops the extraction.
 */
export async function extractTarStream(source: AsyncIterable<Uint8Array>, dest: string): Promise<Result<ExtractSummary, ExtractRefusal>> {
    const reader = new ChunkReader(source);
    const paths: string[] = [];
    const summary = { files: 0, directories: 0, skippedLinks: 0, paths };
    let longName: string | undefined;
    try {
        for (;;) {
            const header = await reader.take(TAR_BLOCK);
            if (header === undefined || header.every((byte) => byte === 0)) break;
            const size = tarSize(header);
            if (!Number.isSafeInteger(size) || size < 0) return err({ kind: "unparsable", detail: "a tar header has no valid size" });
            const padding = Math.ceil(size / TAR_BLOCK) * TAR_BLOCK - size;
            const type = String.fromCharCode(header[156] ?? 0);
            const prefix = tarText(header, 257, 6) === "ustar" ? tarText(header, 345, 155) : "";
            const name = longName ?? (prefix === "" ? tarText(header, 0, 100) : `${prefix}/${tarText(header, 0, 100)}`);

            if (type === "L" || type === "x") {
                if (size > TAR_META_CAP_BYTES) return err({ kind: "unparsable", detail: "a tar name header is too large" });
                const data = await reader.take(size + padding);
                if (data === undefined) return err({ kind: "unparsable", detail: "the tar ends inside an entry" });
                const meta = data.subarray(0, size);
                longName = type === "L" ? tarText(meta, 0, meta.length) : (paxPath(meta) ?? longName);
                continue;
            }
            longName = undefined;

            let sink: ((chunk: Buffer) => Promise<void>) | undefined;
            let handle: FileHandle | undefined;
            if (type === "0" || type === "\0" || type === "7") {
                const target = entryTarget(dest, name);
                await mkdir(dirname(target), { recursive: true });
                const opened = await open(target, "w");
                handle = opened;
                sink = async (chunk) => {
                    await opened.write(chunk);
                };
                countFile(summary, dest, target);
            } else if (type === "5") {
                await mkdir(entryTarget(dest, name), { recursive: true });
                summary.directories += 1;
            } else if (type === "1" || type === "2") {
                summary.skippedLinks += 1;
            }
            try {
                const whole = await reader.pipe(size, sink ?? (() => Promise.resolve()));
                if (!whole) return err({ kind: "unparsable", detail: "the tar ends inside an entry" });
            } finally {
                await handle?.close();
            }
            if ((await reader.take(padding)) === undefined) return err({ kind: "unparsable", detail: "the tar ends inside an entry" });
        }
    } catch (cause) {
        if (cause instanceof ExtractStop) return err(cause.refusal);
        throw cause;
    }
    return ok(summary);
}

/**
 * The size of each piece of the zip stream that the decoder reads at one time. The decoder gives its output with no
 * pause, thus a small piece bounds the bytes that wait for the disk.
 */
const ZIP_PIECE_BYTES = 16 * 1024;

/**
 * Extract a zip stream into `dest`, a directory that exists, with the streamed `Unzip` of `fflate`. A streamed zip
 * reads the local headers only, and a local header does not mark a link. Thus a link entry reaches the disk as a
 * regular file that holds the target text, and no link is ever made. An entry whose path is absolute or holds `..`
 * stops the extraction.
 */
export async function extractZipStream(source: AsyncIterable<Uint8Array>, dest: string): Promise<Result<ExtractSummary, ExtractRefusal>> {
    const paths: string[] = [];
    const summary = { files: 0, directories: 0, skippedLinks: 0, paths };
    const work: Array<() => Promise<void>> = [];
    const handles = new Map<string, Promise<FileHandle>>();
    let failure: ExtractRefusal | undefined;

    const unzip = new Unzip((file) => {
        if (failure !== undefined) return;
        let target: string;
        try {
            target = entryTarget(dest, file.name);
        } catch (cause) {
            if (cause instanceof ExtractStop) failure = cause.refusal;
            return;
        }
        if (file.name.endsWith("/") || file.name.endsWith("\\")) {
            summary.directories += 1;
            work.push(async () => {
                await mkdir(target, { recursive: true });
            });
            return;
        }
        countFile(summary, dest, target);
        work.push(async () => {
            await mkdir(dirname(target), { recursive: true });
            handles.set(target, open(target, "w"));
        });
        file.ondata = (error, data, final) => {
            if (error !== null) {
                failure ??= { kind: "unparsable", detail: `the entry ${file.name} did not decompress` };
                return;
            }
            const copy = Buffer.from(data);
            work.push(async () => {
                const handle = await handles.get(target);
                if (handle === undefined) return;
                if (copy.length > 0) await handle.write(copy);
                if (final) {
                    handles.delete(target);
                    await handle.close();
                }
            });
        };
        try {
            file.start();
        } catch {
            failure ??= { kind: "unparsable", detail: `the entry ${file.name} uses a compression that the extractor cannot read` };
        }
    });
    unzip.register(UnzipInflate);

    const drain = async (): Promise<void> => {
        while (work.length > 0) await work.shift()?.();
    };
    const push = (piece: Uint8Array, final: boolean): void => {
        try {
            unzip.push(piece, final);
        } catch {
            failure ??= { kind: "unparsable", detail: "the zip is damaged" };
        }
    };

    try {
        for await (const chunk of source) {
            for (let offset = 0; offset < chunk.length && failure === undefined; offset += ZIP_PIECE_BYTES) {
                push(chunk.subarray(offset, offset + ZIP_PIECE_BYTES), false);
                await drain();
            }
            if (failure !== undefined) break;
        }
        if (failure === undefined) {
            push(new Uint8Array(0), true);
            await drain();
        }
    } finally {
        for (const handle of handles.values()) await handle.then((opened) => opened.close()).catch(() => undefined);
    }
    if (failure !== undefined) return err(failure);
    if (summary.files + summary.directories === 0) return err({ kind: "unparsable", detail: "the zip holds no entry" });
    return ok(summary);
}
