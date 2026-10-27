import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { selfInvocation } from "../../lib/cli.ts";
import { NameIndex } from "./search_index.ts";
import {
    decodeRecords,
    isWalkChildInvocation,
    parentGone,
    readFolderEntries,
    WALK_COMMAND,
    walkToRecords,
    type EntryKindCode,
    type ReadEntries,
    type RecordSink,
    type WalkOpts,
} from "./walk_child.ts";

let root = "";

beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "inflexa-walk-child-")));
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

function touch(...paths: string[]): void {
    for (const path of paths) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), "x");
    }
}

const OPTS: WalkOpts = { hidden: true, maxDepth: 64, width: 8 };

/** The buffers that a walk writes. */
async function walkBytes(scope: string, opts: WalkOpts = OPTS, read: ReadEntries = readFolderEntries): Promise<Uint8Array[]> {
    const chunks: Uint8Array[] = [];
    const written = await walkToRecords(scope, opts, read, async (bytes) => {
        chunks.push(bytes);
    });
    expect(written.isOk()).toBe(true);
    return chunks;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
    const all = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let at = 0;
    for (const chunk of chunks) {
        all.set(chunk, at);
        at += chunk.length;
    }
    return all;
}

type Decoded = { index: NameIndex; events: string[] };

/** Decode `chunks` into an index, and log each record that is not an entry. */
function decode(scope: string, chunks: readonly Uint8Array[]): Decoded {
    const index = new NameIndex(scope);
    const events: string[] = [];
    const sink: RecordSink = {
        entry(bytes: Uint8Array, start: number, length: number, parent: number, kind: EntryKindCode) {
            index.addBytes(bytes, start, length, parent, kind);
            return true;
        },
        scopeError: (code, message) => events.push(`error ${code} ${message}`),
        scopeRead: () => events.push("scope read"),
        end: () => events.push("end"),
    };
    const push = decodeRecords(sink);
    for (const chunk of chunks) expect(push(chunk)._unsafeUnwrap()).toBe(true);
    return { index, events };
}

/** Each entry of `index` as `path kind hidden`, in index order. */
function rows(index: NameIndex): string[] {
    const out: string[] = [];
    for (let i = 1; i < index.count; i++) out.push(`${index.pathOf(i)} ${index.kindOf(i)} ${String(index.isHidden(i))} ${index.depthOf(i)}`);
    return out;
}

/** The same tree built in the test process with `NameIndex.add`, in the order of the decoded index. */
function inProcessRows(decoded: NameIndex): string[] {
    const index = new NameIndex(decoded.scope);
    for (let i = 1; i < decoded.count; i++) {
        const name = decoded.nameOf(i);
        const parentPath = decoded.pathOf(i).slice(0, -name.length - 1);
        let parent = 0;
        for (let p = 0; p < index.count; p++) if (index.pathOf(p) === parentPath) parent = p;
        index.add(name, parent, decoded.kindOf(i), name.startsWith("."));
    }
    return rows(index);
}

describe("walkToRecords and decodeRecords", () => {
    test("the records of a temp tree build the same index as an in-process build", async () => {
        touch("raw/counts.csv", "figures/volcano.png", "top.txt", ".cache/hidden.png", "été/日本.csv");
        symlinkSync(join(root, "raw"), join(root, "ext"));
        const decoded = decode(root, await walkBytes(root));
        expect(decoded.events).toEqual(["scope read", "end"]);
        expect(rows(decoded.index).sort()).toEqual(
            [
                `${join(root, ".cache")} folder true 1`,
                `${join(root, ".cache", "hidden.png")} file false 2`,
                `${join(root, "ext")} symlink false 1`,
                `${join(root, "figures")} folder false 1`,
                `${join(root, "figures", "volcano.png")} file false 2`,
                `${join(root, "raw")} folder false 1`,
                `${join(root, "raw", "counts.csv")} file false 2`,
                `${join(root, "top.txt")} file false 1`,
                `${join(root, "été")} folder false 1`,
                `${join(root, "été", "日本.csv")} file false 2`,
            ].sort(),
        );
        expect(rows(decoded.index)).toEqual(inProcessRows(decoded.index));
    });

    test("drops the hidden entries without `hidden`, and enters no folder at the depth cap", async () => {
        touch(".cache/a.csv", "a/b/c.csv", "a/top.csv");
        const decoded = decode(root, await walkBytes(root, { hidden: false, maxDepth: 2, width: 1 }));
        expect(rows(decoded.index).sort()).toEqual(
            [`${join(root, "a")} folder false 1`, `${join(root, "a", "b")} folder false 2`, `${join(root, "a", "top.csv")} file false 2`].sort(),
        );
    });

    test("the scope read record lands in its own write, before the walk ends", async () => {
        touch("a/1.csv");
        const chunks = await walkBytes(root);
        // The first write holds the entry `a` and the scope read record, the last write the rest and the end record.
        expect(chunks.length).toBe(2);
        expect(decode(root, chunks.slice(0, 1)).events).toEqual(["scope read"]);
    });

    test("an absent scope gives the error record with its code, and no end record", async () => {
        const missing = join(root, "missing");
        const { index, events } = decode(missing, await walkBytes(missing));
        expect(index.count).toBe(1);
        expect(events).toHaveLength(1);
        expect(events[0]).toStartWith("error ENOENT ");
        expect(events[0]).toContain("missing");
    });

    test("a scope that is a file gives the error record of ENOTDIR", async () => {
        touch("file.csv");
        const { events } = decode(root, await walkBytes(join(root, "file.csv")));
        expect(events).toHaveLength(1);
        expect(events[0]).toStartWith("error ENOTDIR ");
    });

    test("a record split across chunks decodes as one", async () => {
        touch("alpha/été.csv", "beta.txt");
        const all = concat(await walkBytes(root));
        const whole = decode(root, [all]);
        for (const size of [1, 2, 3, 5, 7]) {
            const pieces: Uint8Array[] = [];
            for (let at = 0; at < all.length; at += size) pieces.push(all.slice(at, at + size));
            const split = decode(root, pieces);
            expect(rows(split.index)).toEqual(rows(whole.index));
            expect(split.events).toEqual(["scope read", "end"]);
        }
    });

    test("a split error record decodes as one", async () => {
        const all = concat(await walkBytes(join(root, "missing")));
        const pieces: Uint8Array[] = [];
        for (let at = 0; at < all.length; at += 3) pieces.push(all.slice(at, at + 3));
        expect(decode(root, pieces).events).toEqual(decode(root, [all]).events);
    });

    test("an unknown tag is a decode error", () => {
        const push = decodeRecords({ entry: () => true, scopeError: () => undefined, scopeRead: () => undefined, end: () => undefined });
        expect(push(new Uint8Array([2, 9]))._unsafeUnwrapErr()).toEqual({ type: "bad_record", tag: 9 });
    });

    test("a sink that gives false stops the decode of the chunk", () => {
        const names: string[] = [];
        const push = decodeRecords({
            entry: (bytes, start, length) => {
                names.push(new TextDecoder().decode(bytes.subarray(start, start + length)));
                return false;
            },
            scopeError: () => undefined,
            scopeRead: () => undefined,
            end: () => undefined,
        });
        const record = (name: string): number[] => [0, 0, 0, 0, 0, 0, name.length, 0, ...[...name].map((c) => c.charCodeAt(0))];
        expect(push(new Uint8Array([...record("a"), ...record("b")]))._unsafeUnwrap()).toBe(false);
        expect(names).toEqual(["a"]);
    });

    test("a failed write stops the walk and gives `write_failed`", async () => {
        touch("a/1.csv", "b/2.csv");
        const reads: string[] = [];
        const read: ReadEntries = async (path) => {
            reads.push(path);
            return readFolderEntries(path);
        };
        const error = (await walkToRecords(root, { ...OPTS, width: 1 }, read, () => Promise.reject(new Error("EPIPE"))))._unsafeUnwrapErr();
        expect(error).toMatchObject({ type: "write_failed" });
        expect(reads.length).toBeLessThan(3);
    });

    test("a failed write settles the walk at once, beside a read that never settles", async () => {
        touch("a/1.csv", "b/2.csv");
        const read: ReadEntries = (path) => (path === root ? readFolderEntries(path) : new Promise(() => undefined));
        const error = (await walkToRecords(root, OPTS, read, () => Promise.reject(new Error("EPIPE"))))._unsafeUnwrapErr();
        expect(error).toMatchObject({ type: "write_failed" });
    });

    test("an aborted walk writes no end record", async () => {
        touch("a/1.csv");
        const abort = new AbortController();
        const chunks: Uint8Array[] = [];
        const read: ReadEntries = async (path) => {
            if (path !== root) abort.abort();
            return readFolderEntries(path);
        };
        (
            await walkToRecords(
                root,
                OPTS,
                read,
                async (bytes) => {
                    chunks.push(bytes);
                },
                abort.signal,
            )
        )._unsafeUnwrap();
        expect(decode(root, chunks).events).toEqual(["scope read"]);
    });
});

describe("isWalkChildInvocation", () => {
    test("matches only the arguments that start the walk child", () => {
        expect(isWalkChildInvocation(["server", "walk", "/data", "--depth", "64"])).toBe(true);
        expect(isWalkChildInvocation(["server", "status"])).toBe(false);
        expect(isWalkChildInvocation(["walk", "server"])).toBe(false);
        expect(isWalkChildInvocation([])).toBe(false);
    });
});

describe("parentGone", () => {
    test("the expected parent is not gone", () => {
        expect(parentGone(4242, 4242)).toBe(false);
    });

    test("a server at pid 1 is not gone", () => {
        expect(parentGone(1, 1)).toBe(false);
    });

    test("a different parent is gone", () => {
        expect(parentGone(4242, 4343)).toBe(true);
    });
});

describe("inflexa server walk", () => {
    /** Runs the real walk child of `root` with `parentPid` as the server pid, and gives its exit code and its records. */
    async function runChild(parentPid: string): Promise<{ code: number; events: string[] }> {
        const child = Bun.spawn({
            cmd: selfInvocation([...WALK_COMMAND, root]),
            env: { ...Bun.env, INFLEXA_WALK_PARENT_PID: parentPid },
            stdin: "ignore",
            stdout: "pipe",
            stderr: "ignore",
        });
        const bytes = new Uint8Array(await new Response(child.stdout).arrayBuffer());
        const events: string[] = [];
        const push = decodeRecords({
            entry: () => true,
            scopeError: () => events.push("error"),
            scopeRead: () => events.push("read"),
            end: () => events.push("end"),
        });
        expect(push(bytes).isOk()).toBe(true);
        return { code: await child.exited, events };
    }

    test("walks to the end record under its server", async () => {
        writeFileSync(join(root, "a.csv"), "x");
        const { code, events } = await runChild(String(process.pid));
        expect(code).toBe(0);
        expect(events).toEqual(["read", "end"]);
    });

    test("exits before the walk when its server died before the start", async () => {
        writeFileSync(join(root, "a.csv"), "x");
        const { code, events } = await runChild("999999");
        expect(code).toBe(1);
        expect(events).toEqual([]);
    });
});
