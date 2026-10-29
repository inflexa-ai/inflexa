/**
 * The entries of a compressed file, for the read tools of a script: a zip, a tar, a gzip-compressed tar, or one
 * gzip-compressed file.
 *
 * Each read runs on the host and holds the bytes in memory, thus each one has a cap. A zip names the size of each
 * entry in its index, thus a list reads no entry and a read decompresses one entry. A tar has no index, thus a list
 * and a read of a `.tar.gz` decompress the whole stream, up to {@link ARCHIVE_SCAN_CAP_BYTES}.
 */

import { basename } from "node:path";
import { gunzipSync } from "node:zlib";

import { unzipSync } from "fflate";
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
