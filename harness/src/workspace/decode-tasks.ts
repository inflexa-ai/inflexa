/**
 * The decodes of untrusted file content that run in a decode worker (`lib/host-workers.ts`): a table, the files of a
 * compressed file, and the text of a PDF. The main thread reads the bytes through the workspace seam, which confines
 * the path, and transfers them. The worker opens a named entry of a compressed file, decodes it, and posts the answer.
 *
 * An expected outcome (a missing entry, a table over the budget, a damaged file) is a variant of the answer. Only a
 * fault of the worker itself fails the task.
 */

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

export type HostTask = TableTask | ArchiveListTask | PdfTextTask;

/** A named entry that did not open. */
export type EntryAnswer = { readonly kind: "entry"; readonly refusal: EntryRefusal };

export type TableAnswer = TableDecode | EntryAnswer;
export type ArchiveListAnswer = { readonly kind: "entries"; readonly entries: ArchiveEntry[] } | EntryAnswer;
export type PdfTextAnswer = { readonly kind: "text"; readonly text: PdfText } | { readonly kind: "unreadable" } | EntryAnswer;

export type HostTaskAnswer<T extends HostTask> = T extends TableTask
    ? TableAnswer
    : T extends ArchiveListTask
      ? ArchiveListAnswer
      : T extends PdfTextTask
        ? PdfTextAnswer
        : never;

/** The bytes that a read names: the file itself, or its named entry. */
function namedBytes(bytes: ArrayBuffer, path: string, archive: ArchiveEntryRef | undefined): Buffer | EntryAnswer {
    const content = Buffer.from(bytes);
    if (archive === undefined) return content;
    const opened = readArchiveEntry(archive.kind, path, content, archive.entry, archive.entryCap);
    return opened.isOk() ? opened.value : { kind: "entry", refusal: opened.error };
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
        default: {
            const unhandled: never = task;
            throw new Error(`unhandled decode task: ${JSON.stringify(unhandled)}`);
        }
    }
}
