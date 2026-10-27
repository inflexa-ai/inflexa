import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { err, ok, ResultAsync, type Result } from "neverthrow";

import { walkParentPid } from "../../lib/env.ts";
import { errnoCode } from "../../lib/fs.ts";

/**
 * The record protocol between the walk child (`inflexa server walk`) and the search cache of the local server. Each
 * record starts with one tag byte:
 *
 * - {@link TAG_ENTRY}: `u32 parent` (little-endian), `u8 kind` ({@link EntryKindCode}), `u16 length` (little-endian),
 *   then the UTF-8 bytes of the name.
 * - {@link TAG_SCOPE_ERROR}: `u8 length` and the ASCII errno code, then `u16 length` and the UTF-8 message. Nothing
 *   follows it.
 * - {@link TAG_SCOPE_READ}: no payload. The read of the scope landed.
 * - {@link TAG_END}: no payload. The walk is complete. A stream that ends without it was cut.
 *
 * Entry 0 is the scope and has no record. Each entry record gets the next index from 1 on each side, thus a parent
 * index names the same entry in the child and in the server.
 */
const TAG_ENTRY = 0;
const TAG_SCOPE_ERROR = 1;
const TAG_SCOPE_READ = 2;
const TAG_END = 3;

const ENTRY_HEADER_BYTES = 8;

/** The size of one buffer of records. One write for each full buffer keeps the cost of a pipe write off each entry. */
const RECORD_BUFFER_BYTES = 1 << 20;

/** The most buffers that wait for the pipe. The walk starts no read past it, thus a slow reader bounds the memory of the child. */
const MAX_PENDING_WRITES = 4;

/** The kind byte of an entry record. The search index keeps the same values in its flags. */
export const ENTRY_KIND = { file: 0, folder: 1, symlink: 2 } as const;

/** One value of {@link ENTRY_KIND}. */
export type EntryKindCode = (typeof ENTRY_KIND)[keyof typeof ENTRY_KIND];

/** The facts of a folder entry that the walk reads, from one `readdir` with the file types. */
export type SearchDirent = Pick<Dirent, "name" | "isDirectory" | "isSymbolicLink">;

/** Reads the entries of one folder. A test replaces it to count the reads or to hold one. A failure must reject, never throw. */
export type ReadEntries = (path: string) => Promise<readonly SearchDirent[]>;

/** The production {@link ReadEntries}: one `readdir` with the file types and no `stat`. */
export function readFolderEntries(path: string): Promise<readonly SearchDirent[]> {
    return readdir(path, { withFileTypes: true });
}

/** The rules of one walk, which the server gives to the child as flags. */
export type WalkOpts = {
    /** Write the entries whose name starts with `.`, and enter such folders. */
    readonly hidden: boolean;
    /** The walk enters a folder only when its level below the scope is below this value. */
    readonly maxDepth: number;
    /** The count of folder reads in flight. */
    readonly width: number;
};

/** Hands one buffer of records to the reader. A failure, for example `EPIPE` when the server is gone, must reject, never throw. */
export type WriteRecords = (bytes: Uint8Array) => Promise<void>;

/** A write of the records failed, thus nobody reads the walk. */
export type WalkWriteError = { type: "write_failed"; cause: unknown };

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

/** Fills one buffer with records and hands it on when the next record does not fit, or at a record that must land at once. */
class RecordEncoder {
    private buffer = new Uint8Array(RECORD_BUFFER_BYTES);
    private at = 0;

    constructor(private readonly send: (bytes: Uint8Array) => void) {}

    entry(parent: number, kind: EntryKindCode, name: string): void {
        // A name is at most 255 UTF-16 units on each supported file system, thus at most 765 bytes, which fits a u16.
        const bound = ENTRY_HEADER_BYTES + name.length * 3;
        if (this.at + bound > this.buffer.length) this.flush();
        const buffer = this.buffer;
        const at = this.at;
        buffer[at] = TAG_ENTRY;
        buffer[at + 1] = parent & 0xff;
        buffer[at + 2] = (parent >>> 8) & 0xff;
        buffer[at + 3] = (parent >>> 16) & 0xff;
        buffer[at + 4] = parent >>> 24;
        buffer[at + 5] = kind;
        const nameAt = at + ENTRY_HEADER_BYTES;
        // A plain loop for an ASCII name, because `encodeInto` needs a subarray view for each name.
        let written = name.length;
        for (let k = 0; k < name.length; k++) {
            const unit = name.charCodeAt(k);
            if (unit >= 0x80) {
                written = utf8Encoder.encodeInto(name, buffer.subarray(nameAt, nameAt + name.length * 3)).written;
                break;
            }
            buffer[nameAt + k] = unit;
        }
        buffer[at + 6] = written & 0xff;
        buffer[at + 7] = written >>> 8;
        this.at = nameAt + written;
    }

    scopeError(cause: unknown): void {
        const code = (errnoCode(cause) ?? "").slice(0, 255);
        const message = cause instanceof Error ? cause.message : String(cause);
        const bound = 4 + code.length + Math.min(message.length * 3, 0xffff);
        if (this.at + bound > this.buffer.length) this.flush();
        const buffer = this.buffer;
        let at = this.at;
        buffer[at] = TAG_SCOPE_ERROR;
        buffer[at + 1] = code.length;
        at += 2;
        // An errno code is ASCII.
        for (let k = 0; k < code.length; k++) buffer[at + k] = code.charCodeAt(k) & 0x7f;
        at += code.length;
        const messageAt = at + 2;
        const written = utf8Encoder.encodeInto(message, buffer.subarray(messageAt, messageAt + Math.min(message.length * 3, 0xffff))).written;
        buffer[at] = written & 0xff;
        buffer[at + 1] = written >>> 8;
        this.at = messageAt + written;
        this.flush();
    }

    /** A record whose meaning is its arrival, thus it flushes the buffer at once. */
    marker(tag: typeof TAG_SCOPE_READ | typeof TAG_END): void {
        if (this.at + 1 > this.buffer.length) this.flush();
        this.buffer[this.at] = tag;
        this.at += 1;
        this.flush();
    }

    flush(): void {
        if (this.at === 0) return;
        const full = this.buffer.subarray(0, this.at);
        // The reader can hold the buffer after the hand-off, thus each hand-off gets its own buffer.
        this.buffer = new Uint8Array(RECORD_BUFFER_BYTES);
        this.at = 0;
        this.send(full);
    }
}

/**
 * Walk `scope` and hand its records to `write`. The walk keeps `width` reads in flight from a LIFO stack of folders, thus
 * it goes deep first and the stack stays small. It takes no `stat`, does not enter a symbolic link (the dirent type of a
 * link is not a folder), skips a folder that it cannot read, and drops a hidden entry unless `opts.hidden`. A failed read
 * of the scope itself is a scope error record. `signal` stops the walk with no further record, as a kill of the child does.
 */
export function walkToRecords(scope: string, opts: WalkOpts, read: ReadEntries, write: WriteRecords, signal?: AbortSignal): ResultAsync<void, WalkWriteError> {
    const done = Promise.withResolvers<Result<void, WalkWriteError>>();
    const encoder = new RecordEncoder(send);
    // Parallel stacks of the folders to read: the index of the entry, its path, and its level below the scope.
    const stackIds: number[] = [0];
    const stackPaths: string[] = [scope];
    const stackDepths: number[] = [0];
    let next = 1;
    let inFlight = 0;
    let pendingWrites = 0;
    let tail: Promise<void> = Promise.resolve();
    let writeFailure: WalkWriteError | null = null;
    let scopeFailed = false;
    let finished = false;

    function send(bytes: Uint8Array): void {
        if (writeFailure !== null) return;
        pendingWrites += 1;
        tail = tail
            .then(() => (writeFailure === null ? write(bytes) : undefined))
            .then(
                () => {
                    pendingWrites -= 1;
                    pump();
                },
                (cause: unknown) => {
                    pendingWrites -= 1;
                    writeFailure ??= { type: "write_failed", cause };
                    pump();
                },
            );
    }

    function halted(): boolean {
        return signal?.aborted === true || writeFailure !== null || scopeFailed;
    }

    function emit(folder: number, path: string, depth: number, dirents: readonly SearchDirent[]): void {
        const childDepth = depth + 1;
        // The loop can flush many buffers past MAX_PENDING_WRITES, because the guard runs only between reads. The bound:
        // the records of one folder are smaller than the dirent list that `readdir` already holds, thus the memory of the
        // child at most doubles for that folder.
        for (let k = 0; k < dirents.length; k++) {
            // `k` is below the length of the array.
            const dirent = dirents[k]!;
            const name = dirent.name;
            if (!opts.hidden && name.charCodeAt(0) === 0x2e) continue;
            const isFolder = dirent.isDirectory();
            const entry = next;
            next += 1;
            encoder.entry(folder, isFolder ? ENTRY_KIND.folder : dirent.isSymbolicLink() ? ENTRY_KIND.symlink : ENTRY_KIND.file, name);
            if (isFolder && childDepth < opts.maxDepth) {
                stackIds.push(entry);
                stackPaths.push(join(path, name));
                stackDepths.push(childDepth);
            }
        }
    }

    function finish(): void {
        if (finished) return;
        finished = true;
        if (!halted()) encoder.marker(TAG_END);
        void tail.then(() => done.resolve(writeFailure === null ? ok(undefined) : err(writeFailure)));
    }

    function pump(): void {
        if (finished) return;
        while (!halted() && inFlight < opts.width && pendingWrites < MAX_PENDING_WRITES && stackIds.length > 0) {
            // The three stacks have the same length, and the loop condition holds a non-empty stack.
            const folder = stackIds.pop()!;
            const path = stackPaths.pop()!;
            const depth = stackDepths.pop()!;
            inFlight += 1;
            read(path).then(
                (dirents) => {
                    inFlight -= 1;
                    if (!halted()) {
                        emit(folder, path, depth, dirents);
                        if (folder === 0) encoder.marker(TAG_SCOPE_READ);
                    }
                    pump();
                },
                (cause: unknown) => {
                    inFlight -= 1;
                    if (folder === 0 && !halted()) {
                        encoder.scopeError(cause);
                        scopeFailed = true;
                    }
                    pump();
                },
            );
        }
        // A failed write ends the walk at once: nobody reads the records, and a read that never settles must not hold the
        // exit of the child.
        if (writeFailure !== null || (inFlight === 0 && (halted() || stackIds.length === 0))) finish();
    }

    pump();
    return new ResultAsync(done.promise);
}

/** Receives the records of a stream, in order. */
export type RecordSink = {
    /**
     * One entry. The name is `length` bytes of `bytes` from `start`, valid only during the call. Gives false to stop
     * the decode of the rest of the chunk.
     */
    entry(bytes: Uint8Array, start: number, length: number, parent: number, kind: EntryKindCode): boolean;
    /** The read of the scope failed with the errno `code` (empty when the failure had none) and `message`. */
    scopeError(code: string, message: string): void;
    /** The read of the scope landed. */
    scopeRead(): void;
    /** The walk is complete. */
    end(): void;
};

/** A byte that starts no known record, or an entry whose kind byte is unknown. The stream is not the record protocol. */
export type RecordDecodeError = { type: "bad_record"; tag: number };

const UNKNOWN_SIZE = -1;
const BAD_TAG = -2;

// The status of one dispatched record. A number and not a `Result`, because the decode dispatches each entry of a walk
// and a `Result` for each entry is one allocation for each entry.
const DISPATCH_GO = 0;
const DISPATCH_STOP = 1;
const DISPATCH_BAD = 2;

/** The size of the record at `start`, {@link UNKNOWN_SIZE} when `available` bytes do not show it yet, or {@link BAD_TAG}. */
function recordSize(bytes: Uint8Array, start: number, available: number): number {
    // Each read below is at an offset below `start + available`, inside `bytes`.
    switch (bytes[start]!) {
        case TAG_ENTRY:
            return available < ENTRY_HEADER_BYTES ? UNKNOWN_SIZE : ENTRY_HEADER_BYTES + (bytes[start + 6]! | (bytes[start + 7]! << 8));
        case TAG_SCOPE_ERROR: {
            if (available < 2) return UNKNOWN_SIZE;
            const codeEnd = 2 + bytes[start + 1]!;
            if (available < codeEnd + 2) return UNKNOWN_SIZE;
            return codeEnd + 2 + (bytes[start + codeEnd]! | (bytes[start + codeEnd + 1]! << 8));
        }
        case TAG_SCOPE_READ:
        case TAG_END:
            return 1;
        default:
            return BAD_TAG;
    }
}

/** The largest record: a scope error with a code of 255 bytes and a message of 65535 bytes. */
const MAX_RECORD_BYTES = 4 + 255 + 0xffff;

/**
 * A decoder of a record stream. Each call takes the next chunk and hands each whole record in it to `sink`. A record
 * that the chunk cuts waits in a carry buffer of fixed size, and the next chunk completes it. Thus a record is copied
 * at most once before the sink, and an entry in one chunk is read in place. The call gives false when the sink stopped
 * the decode.
 */
export function decodeRecords(sink: RecordSink): (chunk: Uint8Array) => Result<boolean, RecordDecodeError> {
    const carry = new Uint8Array(MAX_RECORD_BYTES);
    let carried = 0;

    function dispatch(bytes: Uint8Array, start: number): number {
        // `recordSize` measured a whole record at `start`, thus each read below is inside it.
        const tag = bytes[start]!;
        switch (tag) {
            case TAG_ENTRY: {
                const kind = bytes[start + 5]!;
                if (kind !== ENTRY_KIND.file && kind !== ENTRY_KIND.folder && kind !== ENTRY_KIND.symlink) return DISPATCH_BAD;
                const parent = (bytes[start + 1]! | (bytes[start + 2]! << 8) | (bytes[start + 3]! << 16) | (bytes[start + 4]! << 24)) >>> 0;
                const length = bytes[start + 6]! | (bytes[start + 7]! << 8);
                return sink.entry(bytes, start + ENTRY_HEADER_BYTES, length, parent, kind) ? DISPATCH_GO : DISPATCH_STOP;
            }
            case TAG_SCOPE_ERROR: {
                const codeEnd = start + 2 + bytes[start + 1]!;
                const messageLength = bytes[codeEnd]! | (bytes[codeEnd + 1]! << 8);
                const code = utf8Decoder.decode(bytes.subarray(start + 2, codeEnd));
                const message = utf8Decoder.decode(bytes.subarray(codeEnd + 2, codeEnd + 2 + messageLength));
                sink.scopeError(code, message);
                return DISPATCH_GO;
            }
            case TAG_SCOPE_READ:
                sink.scopeRead();
                return DISPATCH_GO;
            case TAG_END:
                sink.end();
                return DISPATCH_GO;
            default:
                return DISPATCH_BAD;
        }
    }

    function settle(status: number, tag: number): Result<boolean, RecordDecodeError> {
        return status === DISPATCH_STOP ? ok(false) : err({ type: "bad_record", tag });
    }

    // The tag reads of a bad record below are at offset 0 of a carry that holds bytes, or at an offset that the loop keeps
    // below the length of the chunk.
    return (chunk) => {
        let at = 0;
        if (carried > 0) {
            for (;;) {
                const size = recordSize(carry, 0, carried);
                if (size === BAD_TAG) return err({ type: "bad_record", tag: carry[0]! });
                if (size !== UNKNOWN_SIZE && carried >= size) break;
                if (at >= chunk.length) return ok(true);
                // Before the size is known, take one byte at a time: the header of a record is a few bytes.
                const take = Math.min(size === UNKNOWN_SIZE ? 1 : size - carried, chunk.length - at);
                carry.set(chunk.subarray(at, at + take), carried);
                carried += take;
                at += take;
            }
            carried = 0;
            const status = dispatch(carry, 0);
            if (status !== DISPATCH_GO) return settle(status, carry[0]!);
        }
        while (at < chunk.length) {
            const size = recordSize(chunk, at, chunk.length - at);
            if (size === BAD_TAG) return err({ type: "bad_record", tag: chunk[at]! });
            if (size === UNKNOWN_SIZE || at + size > chunk.length) {
                carry.set(chunk.subarray(at), 0);
                carried = chunk.length - at;
                return ok(true);
            }
            const status = dispatch(chunk, at);
            if (status !== DISPATCH_GO) return settle(status, chunk[at]!);
            at += size;
        }
        return ok(true);
    };
}

/** The flags of `inflexa server walk`, as commander gives them. */
export type WalkCommandFlags = { hidden?: boolean; depth?: string; width?: string };

/** How often the child looks for its parent. */
const PARENT_CHECK_MS = 1000;

/**
 * True when the server that started the walk child is gone: a dead parent reparents the child, thus `current` differs
 * from `expectedParent`. The server gives its pid in the environment of the child, thus a server at pid 1 is a normal
 * parent.
 */
export function parentGone(expectedParent: number, current: number): boolean {
    return current !== expectedParent;
}

/**
 * `inflexa server walk <scope>`: walk `scope` and stream its records to stdout, for the search cache of the local server
 * that started this process. The process exits at the end of the walk, at a failed write (`EPIPE` once the server stops
 * its read), and when the server is gone, by {@link parentGone}: before the walk starts and on each check after. The
 * pid of the server comes from the environment, thus the first check also catches a server that died before the start.
 * Without that variable, for example in a manual run, the parent at the start is the expected parent.
 */
export async function runWalkCommand(scope: string, flags: WalkCommandFlags, defaults: Pick<WalkOpts, "maxDepth" | "width">): Promise<void> {
    const maxDepth = wholeNumber(flags.depth, defaults.maxDepth);
    const width = wholeNumber(flags.width, defaults.width);
    if (maxDepth === null || maxDepth > 254 || width === null) {
        console.error(`--depth takes a whole number from 1 to 254 and --width a whole number of 1 or more.`);
        process.exit(2);
    }
    const parent = walkParentPid() ?? process.ppid;
    if (parentGone(parent, process.ppid)) process.exit(1);
    const parentCheck = setInterval(() => {
        if (parentGone(parent, process.ppid)) process.exit(1);
    }, PARENT_CHECK_MS);
    // The walk keeps the process alive. The check must not keep it alive after the walk.
    parentCheck.unref();
    // `Bun.write` and not a `FileSink`: after a write to a closed pipe, a `FileSink` rejects one promise and then drops
    // each later write in silence, thus the walk would not see the end of its reader. `Bun.write` rejects each time.
    const written = await walkToRecords(scope, { hidden: flags.hidden === true, maxDepth, width }, readFolderEntries, async (bytes) => {
        await Bun.write(Bun.stdout, bytes);
    });
    process.exit(written.isOk() ? 0 : 1);
}

/** `value` as a whole number of 1 or more, `fallback` when the flag is absent, or `null` when it is not such a number. */
function wholeNumber(value: string | undefined, fallback: number): number | null {
    if (value === undefined) return fallback;
    const parsed = /^\d+$/.test(value) ? Number(value) : 0;
    return parsed >= 1 ? parsed : null;
}
