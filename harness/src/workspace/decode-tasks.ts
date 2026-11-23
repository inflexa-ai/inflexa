/**
 * The decodes of untrusted file content that run in a decode worker (`lib/host-workers.ts`): a table, the files of a
 * compressed file, the text of a PDF, and the start of a gzip file. The main thread reads the bytes through the workspace seam, which confines
 * the path, and transfers them. The worker opens a named entry of a compressed file, decodes it, and posts the answer.
 *
 * An expected outcome (a missing entry, a table over the budget, a damaged file) is a variant of the answer. Only a
 * fault of the worker itself fails the task.
 */

import { Gunzip } from "fflate";

import { readPdfText, type PdfText } from "../lib/pdf-text.js";
import { decodeTable, type TableDecode, type TableDecodeOptions, type TabularFormat } from "../report-model/production-resolver.js";
import { listArchive, readArchiveEntry, type ArchiveEntry, type ArchiveKind, type EntryRefusal } from "../tools/script/archive.js";

/** One entry of a compressed file that a read names, and the cap of its decompressed bytes. */
export type ArchiveEntryRef = { readonly kind: ArchiveKind; readonly entry: string; readonly entryCap: number };

export type TableTask = {
    readonly kind: "table";
    readonly bytes: ArrayBuffer;
    readonly path: string;
    readonly archive?: ArchiveEntryRef;
    readonly format: TabularFormat;
    readonly options: TableDecodeOptions;
};

export type ArchiveListTask = { readonly kind: "archive-list"; readonly bytes: ArrayBuffer; readonly path: string; readonly archive: ArchiveKind };

export type PdfTextTask = {
    readonly kind: "pdf-text";
    readonly bytes: ArrayBuffer;
    readonly path: string;
    readonly archive?: ArchiveEntryRef;
    readonly first: number;
    readonly last: number;
};

/** The starts of gzip files, each one cut from the start of its file. The worker decompresses each to at most `cap` bytes. */
export type GzipStartsTask = { readonly kind: "gzip-starts"; readonly starts: readonly ArrayBuffer[]; readonly cap: number };

export type HostTask = TableTask | ArchiveListTask | PdfTextTask | GzipStartsTask;

/** A named entry that did not open. */
export type EntryAnswer = { readonly kind: "entry"; readonly refusal: EntryRefusal };

export type TableAnswer = TableDecode | EntryAnswer;
export type ArchiveListAnswer = { readonly kind: "entries"; readonly entries: ArchiveEntry[] } | EntryAnswer;
export type PdfTextAnswer = { readonly kind: "text"; readonly text: PdfText } | { readonly kind: "unreadable" } | EntryAnswer;

/** The decompressed start of each gzip start, in the order of the task. A start that gives no byte is `undefined`. */
export type GzipStartsAnswer = { readonly kind: "starts"; readonly starts: readonly (Uint8Array | undefined)[] };

export type HostTaskAnswer<T extends HostTask> = T extends TableTask
    ? TableAnswer
    : T extends ArchiveListTask
      ? ArchiveListAnswer
      : T extends PdfTextTask
        ? PdfTextAnswer
        : T extends GzipStartsTask
          ? GzipStartsAnswer
          : never;

/** The bytes that a read names: the file itself, or its named entry. */
function namedBytes(bytes: ArrayBuffer, path: string, archive: ArchiveEntryRef | undefined): Buffer | EntryAnswer {
    const content = Buffer.from(bytes);
    if (archive === undefined) return content;
    const opened = readArchiveEntry(archive.kind, path, content, archive.entry, archive.entryCap);
    return opened.isOk() ? opened.value : { kind: "entry", refusal: opened.error };
}

/** The input of one push to the inflater. A push of a small input stops the inflate soon after `cap`, also for a highly compressed start. */
const GZIP_PUSH_BYTES = 1_024;

/**
 * The decompressed start of one gzip start, at most `cap` bytes past one push. The start is a cut of its file, thus
 * the stream never ends, and the inflater gives what the bytes before the cut hold. A damaged stream keeps the
 * bytes that it gave before the damage.
 */
function gzipStart(start: Uint8Array, cap: number): Uint8Array | undefined {
    const chunks: Uint8Array[] = [];
    let size = 0;
    const inflater = new Gunzip((chunk) => {
        chunks.push(chunk);
        size += chunk.length;
    });
    try {
        for (let offset = 0; offset < start.length && size < cap; offset += GZIP_PUSH_BYTES) inflater.push(start.subarray(offset, offset + GZIP_PUSH_BYTES));
    } catch {
        // The bytes before the damage stay a valid start.
    }
    return size === 0 ? undefined : Buffer.concat(chunks).subarray(0, cap);
}

/** Run one decode task. The worker entry calls it, and a test can call it on the main thread. */
export async function runDecodeTask(task: HostTask): Promise<HostTaskAnswer<HostTask>> {
    switch (task.kind) {
        case "table": {
            const named = namedBytes(task.bytes, task.path, task.archive);
            if ("kind" in named) return named;
            return decodeTable(task.format, named, task.options);
        }
        case "archive-list": {
            const listed = listArchive(task.archive, task.path, Buffer.from(task.bytes));
            return listed.isOk() ? { kind: "entries", entries: listed.value } : { kind: "entry", refusal: listed.error };
        }
        case "pdf-text": {
            const named = namedBytes(task.bytes, task.path, task.archive);
            if ("kind" in named) return named;
            try {
                return { kind: "text", text: await readPdfText(named, { first: task.first, last: task.last }) };
            } catch {
                return { kind: "unreadable" };
            }
        }
        case "gzip-starts":
            return { kind: "starts", starts: task.starts.map((start) => gzipStart(new Uint8Array(start), task.cap)) };
        default: {
            const unhandled: never = task;
            throw new Error(`unhandled decode task: ${JSON.stringify(unhandled)}`);
        }
    }
}
