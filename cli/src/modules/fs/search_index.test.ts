import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { subsequenceScore } from "../../lib/fuzzy.ts";
import {
    createSearchIndexCache,
    DEFAULT_SEARCH_LIMITS,
    NameIndex,
    readFolderEntries,
    type ReadEntries,
    type SearchIndexCache,
    type SearchLimits,
    type SearchResult,
} from "./search_index.ts";

let root = "";
let clock = 0;
const caches: SearchIndexCache[] = [];
const gates: Array<() => void> = [];

beforeEach(() => {
    // realpath so that the paths of the hits match the canonical scope (macOS /var -> /private/var).
    root = realpathSync(mkdtempSync(join(tmpdir(), "inflexa-search-index-")));
    clock = 0;
});

afterEach(() => {
    for (const cache of caches.splice(0)) cache.stop();
    for (const release of gates.splice(0)) release();
    rmSync(root, { recursive: true, force: true });
});

function touch(...paths: string[]): void {
    for (const path of paths) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), "x");
    }
}

/** A cache on the fake clock, stopped after the test. */
function cacheWith(limits: Partial<SearchLimits> = {}, read: ReadEntries = readFolderEntries): SearchIndexCache {
    const cache = createSearchIndexCache({ ...DEFAULT_SEARCH_LIMITS, ...limits }, () => clock, read);
    caches.push(cache);
    return cache;
}

/** A read that records each path, and that holds each path in `held` until the test or the cleanup releases it. */
function recordingRead(held: ReadonlySet<string> = new Set()): { read: ReadEntries; reads: string[]; release: () => void } {
    const reads: string[] = [];
    const gate = Promise.withResolvers<void>();
    gates.push(gate.resolve);
    return {
        reads,
        release: gate.resolve,
        read: async (path) => {
            reads.push(path);
            if (held.has(path)) await gate.promise;
            return readFolderEntries(path);
        },
    };
}

async function searchOk(cache: SearchIndexCache, scope: string, query: string, limit = 200, hidden = false): Promise<SearchResult> {
    return (await cache.search(scope, hidden, query, limit))._unsafeUnwrap();
}

function names(result: SearchResult): string[] {
    return result.hits.map((hit) => (hit.subpath === "" ? hit.entry.name : `${hit.subpath}/${hit.entry.name}`));
}

describe("NameIndex", () => {
    test("reads back each name across a chunk boundary, ASCII or not", () => {
        // Chunks of 16, 32, 64, then 64 bytes: each name below reserves 3 bytes for each UTF-16 unit, thus the chunks fill
        // fast, grow to the cap, and then stay at the cap.
        const index = new NameIndex("/scope", 6, 16);
        const written = ["abcde", "fg", "hijkl", "été", "日本", "x".repeat(20), "y".repeat(20), "z"];
        const ids = written.map((name) => index.add(name, 0, "file", false));
        expect(ids.map((i) => index.nameOf(i))).toEqual(written);
        expect(ids.map((i) => index.pathOf(i))).toEqual(written.map((name) => join("/scope", name)));
    });

    test("keeps each name after the arrays grow", () => {
        const index = new NameIndex("/scope");
        const ids: number[] = [];
        for (let k = 0; k < 3000; k++) ids.push(index.add(`n${k}`, 0, "file", false));
        expect(index.count).toBe(3001);
        expect(index.nameOf(ids[0]!)).toBe("n0");
        expect(index.nameOf(ids[2999]!)).toBe("n2999");
    });

    test("builds the path and the subpath from the parent chain", () => {
        const index = new NameIndex("/scope");
        const a = index.add("a", 0, "folder", false);
        const b = index.add(".b", a, "folder", true);
        const file = index.add("c.txt", b, "file", false);
        const link = index.add("ext", 0, "symlink", false);
        expect(index.pathOf(0)).toBe("/scope");
        expect(index.pathOf(file)).toBe("/scope/a/.b/c.txt");
        expect(index.subpathOf(file)).toBe("a/.b");
        expect(index.subpathOf(a)).toBe("");
        expect(index.depthOf(file)).toBe(3);
        expect(index.entryOf(b)).toEqual({ name: ".b", path: "/scope/a/.b", kind: "folder", hidden: true });
        expect(index.kindOf(link)).toBe("symlink");
        expect(index.kindOf(file)).toBe("file");
    });

    test("joins the root scope with one separator", () => {
        const index = new NameIndex("/");
        const tmp = index.add("tmp", 0, "folder", false);
        expect(index.pathOf(index.add("x", tmp, "file", false))).toBe("/tmp/x");
    });
});

describe("NameIndex.rank", () => {
    function indexOf(entries: Array<[string, number]>): NameIndex {
        // Each entry is a name and the index of its parent.
        const index = new NameIndex("/s");
        for (const [name, parent] of entries) index.add(name, parent, "file", false);
        return index;
    }

    test("orders by score, then the shallower entry, then the code-unit name", () => {
        const index = new NameIndex("/s");
        const sub = index.add("sub", 0, "folder", false);
        index.add("vol", sub, "file", false);
        for (const name of ["bvol", "Bvol", "avol", "vol"]) index.add(name, 0, "file", false);
        const ranked = index.rank("vol", 10).map((i) => `${index.subpathOf(i)}/${index.nameOf(i)}`);
        expect(ranked).toEqual(["/vol", "sub/vol", "/Bvol", "/avol", "/bvol"]);
    });

    test("an empty query gives the shallowest entries in name order", () => {
        const index = new NameIndex("/s");
        const deep = index.add("a-folder", 0, "folder", false);
        index.add("aaa", deep, "file", false);
        for (const name of ["c", "b", "a"]) index.add(name, 0, "file", false);
        expect(index.rank("", 3).map((i) => index.nameOf(i))).toEqual(["a", "a-folder", "b"]);
    });

    test("keeps the best `limit` of more matches, in the order of a full sort", () => {
        const all: Array<[string, number]> = [];
        for (let k = 0; k < 30; k++) all.push([`${"x".repeat(k % 7)}a${k}`, 0]);
        const index = indexOf(all);
        const ranked = index.rank("a", 10).map((i) => index.nameOf(i));
        const sorted = all
            .map(([name]) => ({ name, score: subsequenceScore("a", name) }))
            .sort((p, q) => q.score - p.score || (p.name < q.name ? -1 : p.name > q.name ? 1 : 0))
            .slice(0, 10)
            .map((hit) => hit.name);
        expect(ranked).toEqual(sorted);
    });

    test("scores a name outside ASCII with the string semantics", () => {
        const index = indexOf([
            ["Été.csv", 0],
            ["plain.csv", 0],
        ]);
        expect(index.rank("été", 10).map((i) => index.nameOf(i))).toEqual(["Été.csv"]);
        expect(index.rank("tcsv", 10).map((i) => index.nameOf(i))).toEqual(["Été.csv"]);
        expect(index.rank("zz", 10)).toEqual([]);
    });

    test("orders two names outside ASCII by code unit", () => {
        // UTF-8 puts U+1F600 above U+FF21, and UTF-16 puts its surrogate pair below.
        const index = indexOf([
            ["Ａ", 0],
            ["\u{1f600}", 0],
        ]);
        expect(index.rank("", 2).map((i) => index.nameOf(i))).toEqual(["\u{1f600}", "Ａ"]);
    });
});

describe("the walk", () => {
    test("indexes each entry with its kind, and does not enter a link", async () => {
        touch("raw/counts.csv", "figures/volcano.png", "top.txt", ".cache/volcano.png");
        const outside = realpathSync(mkdtempSync(join(tmpdir(), "inflexa-search-outside-")));
        writeFileSync(join(outside, "deep.csv"), "x");
        symlinkSync(outside, join(root, "ext"));
        try {
            const cache = cacheWith();
            const all = await searchOk(cache, root, "");
            expect(all.truncated).toBe(false);
            expect(names(all).sort()).toEqual(["ext", "figures", "figures/volcano.png", "raw", "raw/counts.csv", "top.txt"]);
            const byName = new Map(all.hits.map((hit) => [hit.entry.name, hit]));
            expect(byName.get("figures")?.entry.kind).toBe("folder");
            expect(byName.get("ext")?.entry.kind).toBe("symlink");
            expect(byName.get("volcano.png")).toMatchObject({
                entry: { path: join(root, "figures", "volcano.png"), kind: "file", hidden: false },
                subpath: "figures",
                depth: 2,
            });
            expect((await searchOk(cache, root, "deep")).hits).toEqual([]);
        } finally {
            rmSync(outside, { recursive: true, force: true });
        }
    });

    test("indexes the hidden entries only for `hidden` true", async () => {
        touch(".cache/volcano.png", "figures/volcano.png");
        const cache = cacheWith();
        expect(names(await searchOk(cache, root, "volcano"))).toEqual(["figures/volcano.png"]);
        expect(names(await searchOk(cache, root, "volcano", 200, true)).sort()).toEqual([".cache/volcano.png", "figures/volcano.png"]);
    });

    test.skipIf(process.getuid?.() === 0)("skips a folder that it cannot read, and stays complete", async () => {
        touch("open.csv", "locked/inner.csv");
        chmodSync(join(root, "locked"), 0o000);
        try {
            const cache = cacheWith();
            const result = await searchOk(cache, root, "");
            expect(names(result).sort()).toEqual(["locked", "open.csv"]);
            expect(result.truncated).toBe(false);
        } finally {
            chmodSync(join(root, "locked"), 0o755);
        }
    });

    test("stops at the entry cap of one index", async () => {
        for (let k = 0; k < 25; k++) touch(`f${k}.csv`);
        const result = await searchOk(cacheWith({ maxEntries: 10 }), root, "");
        expect(result.truncated).toBe(true);
        // The cap counts the scope, which is no hit.
        expect(result.hits.length).toBe(9);
    });

    test("stops at the entry cap across the indexes", async () => {
        for (let k = 0; k < 25; k++) touch(`f${k}.csv`);
        const result = await searchOk(cacheWith({ maxTotalEntries: 6 }), root, "");
        expect(result.truncated).toBe(true);
        expect(result.hits.length).toBe(5);
    });

    test("stops at the depth cap", async () => {
        touch("a/b/c/deep.csv", "a/shallow.csv");
        const result = await searchOk(cacheWith({ maxDepth: 2 }), root, "");
        expect(result.truncated).toBe(true);
        expect(names(result).sort()).toEqual(["a", "a/b", "a/shallow.csv"]);
    });

    test("stops at the time budget", async () => {
        touch("a/1.csv", "b/2.csv", "c/3.csv", "d/4.csv");
        const recorder = recordingRead();
        // Each read takes 10 ms of the fake clock, thus the budget of 15 ms ends the walk after two reads.
        const read: ReadEntries = async (path) => {
            clock += 10;
            return recorder.read(path);
        };
        const result = await searchOk(cacheWith({ walkBudgetMs: 15, width: 1 }, read), root, "");
        expect(result.truncated).toBe(true);
        expect(recorder.reads.length).toBe(2);
    });

    test("the deadline cuts a walk whose read never settles", async () => {
        touch("top.csv", "slow/inner.csv", "slow/deeper/x.csv");
        const slow = join(root, "slow");
        const recorder = recordingRead(new Set([slow]));
        // The fake clock stays at 0, thus only the timer of the walk can see the budget pass.
        const cache = cacheWith({ walkBudgetMs: 30, firstWaitMs: 0 }, recorder.read);
        expect((await searchOk(cache, root, "")).truncated).toBe(true);
        await Bun.sleep(60);
        recorder.release();
        await Bun.sleep(20);
        const after = await searchOk(cache, root, "");
        expect(after.truncated).toBe(true);
        expect(names(after).sort()).toEqual(["slow", "top.csv"]);
        expect(recorder.reads).not.toContain(join(slow, "deeper"));
    });

    test("a search answers a walk that the deadline cut while the read of the scope hangs", async () => {
        const recorder = recordingRead(new Set([root]));
        const cache = cacheWith({ walkBudgetMs: 30, firstWaitMs: 0 }, recorder.read);
        const started = performance.now();
        expect(await searchOk(cache, root, "")).toEqual({ hits: [], truncated: true });
        expect(performance.now() - started).toBeGreaterThanOrEqual(25);
    });

    test("a walk that ends clears its deadline", async () => {
        touch("a/1.csv");
        // A budget that no other timer of the cache uses, thus the spy finds the deadline by its delay.
        const budget = 987_654;
        const setSpy = spyOn(globalThis, "setTimeout");
        const clearSpy = spyOn(globalThis, "clearTimeout");
        try {
            expect((await searchOk(cacheWith({ walkBudgetMs: budget }), root, "")).truncated).toBe(false);
            const armed = setSpy.mock.results.filter((_, k) => setSpy.mock.calls[k]?.[1] === budget).map((result) => result.value);
            expect(armed).toHaveLength(1);
            const cleared: unknown[] = clearSpy.mock.calls.map((call) => call[0]);
            expect(cleared).toContain(armed[0]);
        } finally {
            setSpy.mockRestore();
            clearSpy.mockRestore();
        }
    });

    test("a width of 1 reads each folder one time, one at a time", async () => {
        touch("a/x/1.csv", "a/y/2.csv", "b/3.csv", "c/4.csv");
        let inFlight = 0;
        let peak = 0;
        const reads: string[] = [];
        const read: ReadEntries = async (path) => {
            reads.push(path);
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await Bun.sleep(2);
            inFlight -= 1;
            return readFolderEntries(path);
        };
        await searchOk(cacheWith({ width: 1 }, read), root, "");
        expect(peak).toBe(1);
        expect(reads.sort()).toEqual([root, join(root, "a"), join(root, "a", "x"), join(root, "a", "y"), join(root, "b"), join(root, "c")].sort());
    });

    test("keeps at most `width` reads in flight", async () => {
        for (let k = 0; k < 20; k++) touch(`d${k}/f.csv`);
        let inFlight = 0;
        let peak = 0;
        const read: ReadEntries = async (path) => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await Bun.sleep(2);
            inFlight -= 1;
            return readFolderEntries(path);
        };
        await searchOk(cacheWith({ width: 4 }, read), root, "");
        expect(peak).toBeGreaterThan(1);
        expect(peak).toBeLessThanOrEqual(4);
    });
});

describe("the cache", () => {
    test("a second search reads no folder", async () => {
        touch("a/volcano.png");
        const recorder = recordingRead();
        const cache = cacheWith({}, recorder.read);
        await searchOk(cache, root, "volc");
        const before = recorder.reads.length;
        expect(names(await searchOk(cache, root, "a"))).toContain("a");
        expect(recorder.reads.length).toBe(before);
    });

    test("two concurrent searches read each folder one time", async () => {
        touch("a/1.csv", "b/2.csv");
        const recorder = recordingRead();
        const cache = cacheWith({}, recorder.read);
        await Promise.all([searchOk(cache, root, "1"), searchOk(cache, root, "2")]);
        expect(recorder.reads.sort()).toEqual([root, join(root, "a"), join(root, "b")].sort());
    });

    test("gives the read error of an absent scope and keeps no index", async () => {
        const recorder = recordingRead();
        const cache = cacheWith({}, recorder.read);
        const missing = join(root, "missing");
        expect((await cache.search(missing, false, "a", 10))._unsafeUnwrapErr()).toMatchObject({ type: "absent", path: missing });
        expect((await cache.search(missing, false, "a", 10))._unsafeUnwrapErr().type).toBe("absent");
        expect(recorder.reads).toEqual([missing, missing]);
    });

    test("waits for a slow read of the scope past `firstWaitMs`, and gives its error", async () => {
        const missing = join(root, "missing");
        const slow: ReadEntries = async (path) => {
            await Bun.sleep(40);
            return readFolderEntries(path);
        };
        const error = (await cacheWith({ firstWaitMs: 5 }, slow).search(missing, false, "a", 10))._unsafeUnwrapErr();
        expect(error).toMatchObject({ type: "absent", path: missing });
    });

    test.skipIf(process.getuid?.() === 0)("gives `unreadable` for a scope that it cannot read", async () => {
        const locked = join(root, "locked");
        mkdirSync(locked);
        chmodSync(locked, 0o000);
        try {
            const error = (await cacheWith().search(locked, false, "a", 10))._unsafeUnwrapErr();
            expect(error.type).toBe("unreadable");
        } finally {
            chmodSync(locked, 0o755);
        }
    });

    test("the timer evicts an idle index with no later search", async () => {
        touch("a.csv");
        const recorder = recordingRead();
        const cache = cacheWith({ ttlMs: 20 }, recorder.read);
        await searchOk(cache, root, "a");
        // The timer fires at its real delay and reads the fake clock, thus it finds the index idle.
        clock = 1000;
        await Bun.sleep(80);
        // Back at the time of the last search, the sweep of a call evicts nothing, thus a new walk shows the eviction of the timer.
        clock = 0;
        await searchOk(cache, root, "a");
        expect(recorder.reads).toEqual([root, root]);
    });

    test("the sweep of a call evicts an index past its TTL", async () => {
        touch("a.csv");
        const recorder = recordingRead();
        const cache = cacheWith({ ttlMs: 1000 }, recorder.read);
        await searchOk(cache, root, "a");
        clock = 500;
        await searchOk(cache, root, "a");
        expect(recorder.reads).toEqual([root]);
        clock = 2000;
        await searchOk(cache, root, "a");
        expect(recorder.reads).toEqual([root, root]);
    });

    function threeScopes(): string[] {
        const scopes = ["s1", "s2", "s3"].map((name) => join(root, name));
        for (const scope of scopes) {
            mkdirSync(scope);
            for (let k = 0; k < 7; k++) writeFileSync(join(scope, `f${k}.csv`), "x");
        }
        return scopes;
    }

    test("the total cap evicts the least recently used index", async () => {
        const [first, second, third] = threeScopes() as [string, string, string];
        const recorder = recordingRead();
        // Each scope has 8 entries. One index fits beside a new index of `maxEntries`, and two do not.
        const cache = cacheWith({ maxEntries: 10, maxTotalEntries: 25 }, recorder.read);
        for (const scope of [first, second, third]) await searchOk(cache, scope, "f");
        await searchOk(cache, third, "f");
        await searchOk(cache, second, "f");
        expect(recorder.reads).toEqual([first, second, third]);
        await searchOk(cache, first, "f");
        expect(recorder.reads).toEqual([first, second, third, first]);
    });

    test("the index count cap evicts the least recently used index", async () => {
        const [first, second, third] = threeScopes() as [string, string, string];
        const recorder = recordingRead();
        const cache = cacheWith({ maxIndexes: 2 }, recorder.read);
        for (const scope of [first, second, third]) await searchOk(cache, scope, "f");
        await searchOk(cache, third, "f");
        await searchOk(cache, second, "f");
        expect(recorder.reads).toEqual([first, second, third]);
    });

    test("an eviction stops the walk", async () => {
        touch("s1/a/deep/1.csv", "s2/b.csv");
        const first = join(root, "s1");
        const recorder = recordingRead(new Set([join(first, "a")]));
        const cache = cacheWith({ maxIndexes: 1, firstWaitMs: 0 }, recorder.read);
        expect((await searchOk(cache, first, "")).truncated).toBe(true);
        await searchOk(cache, join(root, "s2"), "");
        recorder.release();
        await Bun.sleep(20);
        expect(recorder.reads).not.toContain(join(first, "a", "deep"));
    });

    test("a search answers during the walk, and the walk continues to its end", async () => {
        touch("a/deep/volcano.png", "top.csv");
        const recorder = recordingRead(new Set([join(root, "a")]));
        const cache = cacheWith({ firstWaitMs: 20 }, recorder.read);
        const early = await searchOk(cache, root, "");
        expect(early.truncated).toBe(true);
        expect(names(early).sort()).toEqual(["a", "top.csv"]);
        recorder.release();
        await Bun.sleep(20);
        const late = await searchOk(cache, root, "volc");
        expect(late.truncated).toBe(false);
        expect(names(late)).toEqual(["a/deep/volcano.png"]);
    });

    test("the first search waits at most `firstWaitMs`, and a later search does not wait", async () => {
        touch("a/1.csv");
        const recorder = recordingRead(new Set([join(root, "a")]));
        const cache = cacheWith({ firstWaitMs: 60 }, recorder.read);
        let started = performance.now();
        expect((await searchOk(cache, root, "")).truncated).toBe(true);
        const firstWait = performance.now() - started;
        expect(firstWait).toBeGreaterThanOrEqual(50);
        expect(firstWait).toBeLessThan(1000);

        clock = 61;
        started = performance.now();
        expect((await searchOk(cache, root, "")).truncated).toBe(true);
        expect(performance.now() - started).toBeLessThan(30);
    });

    test("a small scope answers complete in the first search", async () => {
        touch("a/b/c.csv");
        const result = await searchOk(cacheWith(), root, "c.csv");
        expect(result.truncated).toBe(false);
        expect(names(result)).toEqual(["a/b/c.csv"]);
    });
});
