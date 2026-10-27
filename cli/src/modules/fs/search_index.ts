import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { err, ok, ResultAsync } from "neverthrow";

import { readError, type FolderEntry, type FolderEntryType, type FolderReadError } from "../../lib/folder_listing.ts";
import { subsequenceScore, subsequenceScoreBytes } from "../../lib/fuzzy.ts";

/** The caps of a search cache. A test sets small values to reach each cap on a small tree. */
export type SearchLimits = {
    /** The count of folder reads that one walk keeps in flight. */
    readonly width: number;
    /** The deepest level below the scope that the index holds. The walk enters no folder at this depth. At most 254, because a depth is one byte. */
    readonly maxDepth: number;
    /** The most entries of one index, the scope included. */
    readonly maxEntries: number;
    /** The most entries across each index of one cache. */
    readonly maxTotalEntries: number;
    /**
     * The time from the start of a walk after which the walk starts no read and drops each read that lands. A timer cuts the
     * walk at this time also, thus a read that never settles does not keep the walk open.
     */
    readonly walkBudgetMs: number;
    /** The time after the last search of an index at which the cache evicts the index. */
    readonly ttlMs: number;
    /** The time from the start of a walk until which a search waits for the walk to end. */
    readonly firstWaitMs: number;
    /** The most indexes of one cache. */
    readonly maxIndexes: number;
};

/**
 * The production {@link SearchLimits}. Width 512 walks `~/repos` at about 1.05 times the time of `fd -uu` and `~` at about
 * 1.23 times, where 64 is 1.29 times on `~/repos`. At about 30 bytes for each entry, one index of `maxEntries` costs about
 * 120 MB, and `~` fits in one index. An index with no entry costs about 76 KB, thus `maxIndexes` empty scopes stay small.
 */
export const DEFAULT_SEARCH_LIMITS: SearchLimits = {
    width: 512,
    maxDepth: 64,
    maxEntries: 4_000_000,
    maxTotalEntries: 8_000_000,
    walkBudgetMs: 60_000,
    ttlMs: 120_000,
    firstWaitMs: 500,
    maxIndexes: 16,
};

/** The facts of a folder entry that the walk reads, from one `readdir` with the file types. */
export type SearchDirent = Pick<Dirent, "name" | "isDirectory" | "isSymbolicLink">;

/** Reads the entries of one folder. A test replaces it to count the reads or to hold one. A failure must reject, never throw. */
export type ReadEntries = (path: string) => Promise<readonly SearchDirent[]>;

/** The production {@link ReadEntries}: one `readdir` with the file types and no `stat`. */
export function readFolderEntries(path: string): Promise<readonly SearchDirent[]> {
    return readdir(path, { withFileTypes: true });
}

/** One hit of a search. */
export type SearchHit = {
    /** The entry, with its full path built from the parent chain. */
    entry: FolderEntry;
    /** The path of the folder that holds the entry, relative to the scope, with `/` as the separator. Empty for a direct child of the scope. */
    subpath: string;
    /** The level below the scope: 1 for a direct child. */
    depth: number;
};

/** The answer of a search. */
export type SearchResult = {
    /** At most `limit` hits, best first. */
    hits: SearchHit[];
    /** True when the walk had not ended at the time of the score, or when a cap or an eviction cut it. */
    truncated: boolean;
};

/**
 * The largest chunk, 16 MiB, as a shift. Each chunk owns a slot of this size in the space of the global offsets, whatever
 * its own size, thus the chunk of an offset is one shift and the position in it one mask.
 */
const CHUNK_SHIFT = 24;
/** The size of the first chunk. Each later chunk doubles the previous one, up to `2 ** CHUNK_SHIFT`. */
const FIRST_CHUNK_BYTES = 64 * 1024;
const INITIAL_CAPACITY = 1024;

const KIND_MASK = 0b11;
const KIND_FILE = 0;
const KIND_FOLDER = 1;
const KIND_SYMLINK = 2;
const FLAG_HIDDEN = 0b100;
const FLAG_NON_ASCII = 0b1000;

const KIND_CODES: Readonly<Record<FolderEntryType, number>> = { file: KIND_FILE, folder: KIND_FOLDER, symlink: KIND_SYMLINK };

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

/**
 * The names of a scope, as a parent tree in parallel typed arrays. Entry 0 is the scope itself. A name lives as UTF-8 in a
 * pool of chunks, and the index keeps no path string: a path is built from the parent chain, only for a folder read
 * and for a hit. A JS string for each name costs about 80 bytes against about 19 in the pool, and scores slower.
 */
export class NameIndex {
    /** The canonical path of the scope. */
    readonly scope: string;
    /** The count of entries, the scope included. */
    count = 0;
    private readonly chunkShift: number;
    private readonly chunkMask: number;
    private readonly maxChunkBytes: number;
    /** The size of the last chunk, which `add` fills. */
    private chunkBytes: number;
    // Chunks and not one array that doubles: the copy of a 100 MB pool stalls the event loop. The chunks double in size up
    // to the cap, thus a small scope holds a small pool, and no byte is ever copied.
    private readonly chunks: Uint8Array[] = [];
    private used = 0;
    private starts = new Uint32Array(INITIAL_CAPACITY);
    private lengths = new Uint16Array(INITIAL_CAPACITY);
    private parents = new Int32Array(INITIAL_CAPACITY);
    private depths = new Uint8Array(INITIAL_CAPACITY);
    private flags = new Uint8Array(INITIAL_CAPACITY);

    /**
     * `chunkShift` sets the largest chunk to `2 ** chunkShift` bytes, and `firstChunkBytes` the first chunk. The first chunk
     * must hold the worst case of the longest name. A test sets small values to cross chunks with a few names.
     */
    constructor(scope: string, chunkShift: number = CHUNK_SHIFT, firstChunkBytes: number = FIRST_CHUNK_BYTES) {
        this.scope = scope;
        this.chunkShift = chunkShift;
        this.maxChunkBytes = 2 ** chunkShift;
        this.chunkMask = this.maxChunkBytes - 1;
        this.chunkBytes = Math.min(firstChunkBytes, this.maxChunkBytes);
        this.chunks.push(new Uint8Array(this.chunkBytes));
        this.add("", -1, "folder", false);
    }

    /**
     * Append one entry and give its index. A name never crosses a chunk: when the worst case of its UTF-8 length does not fit,
     * a new chunk opens and the tail of the old one stays empty. The worst case is 3 bytes for each UTF-16 unit, and a name is
     * at most 255 units on each supported file system, thus at most 765 bytes, far below a chunk.
     */
    add(name: string, parent: number, kind: FolderEntryType, hidden: boolean): number {
        const i = this.count;
        if (i === this.starts.length) this.grow();
        const bound = name.length * 3;
        if (this.used + bound > this.chunkBytes) {
            this.chunkBytes = Math.min(this.chunkBytes * 2, this.maxChunkBytes);
            this.chunks.push(new Uint8Array(this.chunkBytes));
            this.used = 0;
        }
        const chunkIndex = this.chunks.length - 1;
        // The push above or the constructor made the last chunk.
        const chunk = this.chunks[chunkIndex]!;
        const at = this.used;
        // A plain loop for an ASCII name, because `encodeInto` needs a subarray view for each name.
        let written = name.length;
        let ascii = true;
        for (let k = 0; k < name.length; k++) {
            const unit = name.charCodeAt(k);
            if (unit >= 0x80) {
                ascii = false;
                break;
            }
            chunk[at + k] = unit;
        }
        if (!ascii) written = utf8Encoder.encodeInto(name, chunk.subarray(at, at + bound)).written;
        this.used = at + written;
        this.starts[i] = chunkIndex * this.maxChunkBytes + at;
        this.lengths[i] = written;
        this.parents[i] = parent;
        // The scope has no parent. Each other parent is an earlier entry, thus its depth is set.
        this.depths[i] = parent < 0 ? 0 : this.depths[parent]! + 1;
        this.flags[i] = KIND_CODES[kind] | (hidden ? FLAG_HIDDEN : 0) | (ascii ? 0 : FLAG_NON_ASCII);
        this.count = i + 1;
        return i;
    }

    private grow(): void {
        const capacity = this.starts.length * 2;
        this.starts = copyInto(new Uint32Array(capacity), this.starts);
        this.lengths = copyInto(new Uint16Array(capacity), this.lengths);
        this.parents = copyInto(new Int32Array(capacity), this.parents);
        this.depths = copyInto(new Uint8Array(capacity), this.depths);
        this.flags = copyInto(new Uint8Array(capacity), this.flags);
    }

    /** The level of entry `i` below the scope: 0 for the scope. */
    depthOf(i: number): number {
        // `i` is below `count`: the caller holds a hit index from `rank`, a parent from `parents`, or a folder index from the
        // walk stack. Each reader of entry `i` below obeys the same bound.
        return this.depths[i]!;
    }

    /** The kind of entry `i` from its dirent. */
    kindOf(i: number): FolderEntryType {
        // `i` is below `count`, with the same bound as in `depthOf`.
        const code = this.flags[i]! & KIND_MASK;
        return code === KIND_FOLDER ? "folder" : code === KIND_SYMLINK ? "symlink" : "file";
    }

    /** True when the name of entry `i` starts with `.`. */
    isHidden(i: number): boolean {
        // `i` is below `count`, with the same bound as in `depthOf`.
        return (this.flags[i]! & FLAG_HIDDEN) !== 0;
    }

    /** The name of entry `i`. The scope has the empty name. */
    nameOf(i: number): string {
        // `i` is below `count`, with the same bound as in `depthOf`. The chunk index comes from a `starts` value that `add`
        // wrote with the index of a chunk that it pushed, thus the chunk read finds a chunk.
        const start = this.starts[i]!;
        const local = start & this.chunkMask;
        return utf8Decoder.decode(this.chunks[start >>> this.chunkShift]!.subarray(local, local + this.lengths[i]!));
    }

    /** The full path of entry `i`. `join` keeps one separator after the scope `/`. */
    pathOf(i: number): string {
        if (i === 0) return this.scope;
        const names: string[] = [];
        for (let k = i; k > 0; k = this.parents[k]!) names.push(this.nameOf(k));
        names.reverse();
        return join(this.scope, ...names);
    }

    /** The path of the folder that holds entry `i`, relative to the scope, with `/` as the separator. */
    subpathOf(i: number): string {
        const names: string[] = [];
        for (let k = this.parents[i]!; k > 0; k = this.parents[k]!) names.push(this.nameOf(k));
        return names.reverse().join("/");
    }

    /** Entry `i` in the shape of a folder list entry. */
    entryOf(i: number): FolderEntry {
        return { name: this.nameOf(i), path: this.pathOf(i), kind: this.kindOf(i), hidden: this.isHidden(i) };
    }

    /**
     * The indexes of the best `limit` entries for `query`, best first: a higher score, then a lower depth, then a lower
     * code-unit name. One scan of the entries that exist at the call, with a min-heap whose root is the worst kept hit,
     * because a query of one letter matches most of a large tree and a sort of each match costs more than the scan. An
     * entry that does not reach the heap costs no allocation, unless its name or the query holds a byte outside ASCII.
     */
    rank(query: string, limit: number): number[] {
        const count = this.count;
        if (limit <= 0 || count <= 1) return [];
        const queryBytes = asciiQueryBytes(query);
        const heapEntries = new Int32Array(limit);
        const heapScores = new Int32Array(limit);
        let size = 0;
        for (let i = 1; i < count; i++) {
            let score: number;
            // `i` is below `count`, and the chunk index of a start is a chunk that `add` pushed.
            if (queryBytes !== null && (this.flags[i]! & FLAG_NON_ASCII) === 0) {
                const start = this.starts[i]!;
                const local = start & this.chunkMask;
                score = subsequenceScoreBytes(queryBytes, this.chunks[start >>> this.chunkShift]!, local, local + this.lengths[i]!);
            } else {
                score = subsequenceScore(query, this.nameOf(i));
            }
            if (score < 0) continue;
            // Each heap read below is at a position below `size`, and `size` is at most `limit`, the length of the heap arrays.
            if (size < limit) {
                heapEntries[size] = i;
                heapScores[size] = score;
                this.siftUp(heapEntries, heapScores, size);
                size += 1;
            } else if (this.worse(heapEntries[0]!, heapScores[0]!, i, score)) {
                heapEntries[0] = i;
                heapScores[0] = score;
                this.siftDown(heapEntries, heapScores, 0, size);
            }
        }
        const best: number[] = new Array<number>(size);
        // `end` and the root are below `size`, thus each heap read of the drain is inside the heap arrays.
        for (let end = size - 1; end >= 0; end--) {
            best[end] = heapEntries[0]!;
            heapEntries[0] = heapEntries[end]!;
            heapScores[0] = heapScores[end]!;
            this.siftDown(heapEntries, heapScores, 0, end);
        }
        return best;
    }

    /** True when entry `a` with score `scoreA` ranks below entry `b` with score `scoreB`. Equal names fall back to the index, so the order is total. */
    private worse(a: number, scoreA: number, b: number, scoreB: number): boolean {
        if (scoreA !== scoreB) return scoreA < scoreB;
        // `a` and `b` come from the heap, thus each is an entry below `count`.
        const depthA = this.depths[a]!;
        const depthB = this.depths[b]!;
        if (depthA !== depthB) return depthA > depthB;
        const byName = this.compareNames(a, b);
        return byName !== 0 ? byName > 0 : a > b;
    }

    /**
     * The code-unit order of two names. When one name is ASCII, the UTF-8 byte order is the same: the shared prefix is ASCII
     * in each name, and at the first difference an ASCII byte and an ASCII code unit are below each byte and each code unit
     * of a character outside ASCII. Only two names outside ASCII are decoded, because UTF-8 sorts a surrogate pair above
     * U+E000 to U+FFFF and UTF-16 sorts it below.
     */
    private compareNames(a: number, b: number): number {
        // `a` and `b` are entries below `count`, and the chunk index of each start is a chunk that `add` pushed. The byte reads
        // stay below the length of each name, inside its chunk.
        if ((this.flags[a]! & this.flags[b]! & FLAG_NON_ASCII) !== 0) {
            const nameA = this.nameOf(a);
            const nameB = this.nameOf(b);
            return nameA < nameB ? -1 : nameA > nameB ? 1 : 0;
        }
        const startA = this.starts[a]!;
        const startB = this.starts[b]!;
        const chunkA = this.chunks[startA >>> this.chunkShift]!;
        const chunkB = this.chunks[startB >>> this.chunkShift]!;
        const localA = startA & this.chunkMask;
        const localB = startB & this.chunkMask;
        const lengthA = this.lengths[a]!;
        const lengthB = this.lengths[b]!;
        const shared = Math.min(lengthA, lengthB);
        for (let k = 0; k < shared; k++) {
            const diff = chunkA[localA + k]! - chunkB[localB + k]!;
            if (diff !== 0) return diff;
        }
        return lengthA - lengthB;
    }

    private siftUp(entries: Int32Array, scores: Int32Array, from: number): void {
        let child = from;
        while (child > 0) {
            const parent = (child - 1) >> 1;
            // `child` and its parent are positions below the size of the heap.
            if (!this.worse(entries[child]!, scores[child]!, entries[parent]!, scores[parent]!)) return;
            swap(entries, scores, child, parent);
            child = parent;
        }
    }

    private siftDown(entries: Int32Array, scores: Int32Array, from: number, size: number): void {
        let parent = from;
        for (;;) {
            const left = parent * 2 + 1;
            if (left >= size) return;
            const right = left + 1;
            let worst = left;
            // `left`, `right`, and `parent` are checked below `size`, the count of the heap positions in use.
            if (right < size && this.worse(entries[right]!, scores[right]!, entries[left]!, scores[left]!)) worst = right;
            if (!this.worse(entries[worst]!, scores[worst]!, entries[parent]!, scores[parent]!)) return;
            swap(entries, scores, worst, parent);
            parent = worst;
        }
    }
}

function copyInto<T extends Uint8Array | Uint16Array | Uint32Array | Int32Array>(target: T, source: T): T {
    target.set(source);
    return target;
}

function swap(entries: Int32Array, scores: Int32Array, a: number, b: number): void {
    // The callers give two heap positions below the size of the heap.
    const entry = entries[a]!;
    const score = scores[a]!;
    entries[a] = entries[b]!;
    scores[a] = scores[b]!;
    entries[b] = entry;
    scores[b] = score;
}

/** The lower-case bytes of an ASCII query, or `null` for a query outside ASCII, which the string scorer must fold. */
function asciiQueryBytes(query: string): Uint8Array | null {
    const lowered = query.toLowerCase();
    const bytes = new Uint8Array(lowered.length);
    for (let k = 0; k < lowered.length; k++) {
        const unit = lowered.charCodeAt(k);
        if (unit >= 0x80) return null;
        bytes[k] = unit;
    }
    return bytes;
}

/** The count of the entries of each index of one cache, which the total cap reads at each insert. */
type EntryTotal = { value: number };

/** One index of a cache and the state of its walk. */
type CachedIndex = {
    readonly key: string;
    readonly index: NameIndex;
    readonly startedAt: number;
    lastUse: number;
    /** True when no read of the walk is in flight and none will start. */
    ended: boolean;
    /** True when a cap or an eviction cut the walk. It stays true for the life of the index. */
    truncated: boolean;
    /** True when the walk starts no read and drops each read that lands. */
    stopped: boolean;
    /** The failure of the read of the scope, which ends the walk. */
    error: FolderReadError | null;
    /** Resolves when the walk ends. */
    readonly end: Promise<void>;
    /** Resolves when the read of the scope settles, or when the walk is cut before it. */
    readonly scopeRead: Promise<void>;
    readonly begin: () => void;
    /** Cut the walk: no read starts, each read that lands is dropped, and the index is truncated. */
    readonly stop: () => void;
};

/**
 * The walk of one index: a stack of the indexes of the folders to read and `width` reads in flight, with no queue object and
 * no promise for each entry. The stack is LIFO, thus the walk goes deep first and the stack stays small. The walk does not
 * enter a link, because the dirent type of a link is not a folder. A folder that it cannot read is skipped and does not
 * truncate the index, as `fd` does. The caller inserts the index in its map before `begin`, thus a concurrent search finds it.
 */
function createWalk(
    key: string,
    scope: string,
    hidden: boolean,
    limits: SearchLimits,
    now: () => number,
    read: ReadEntries,
    total: EntryTotal,
    onEnd: (cached: CachedIndex) => void,
): CachedIndex {
    const index = new NameIndex(scope);
    total.value += 1;
    const ended = Promise.withResolvers<void>();
    const scopeRead = Promise.withResolvers<void>();
    const stack: number[] = [0];
    let inFlight = 0;
    let deadline: ReturnType<typeof setTimeout> | null = null;

    const cached: CachedIndex = {
        key,
        index,
        startedAt: now(),
        lastUse: now(),
        ended: false,
        truncated: false,
        stopped: false,
        error: null,
        end: ended.promise,
        scopeRead: scopeRead.promise,
        begin,
        stop: cut,
    };

    // The budget check at each read start and end cannot see a read that never settles, thus a timer also cuts the walk.
    // A cut walk with such a read never ends, and a search still answers it, truncated, at the end of its own wait.
    function begin(): void {
        deadline = setTimeout(cut, limits.walkBudgetMs);
        // A walk must not keep the process alive.
        deadline.unref();
        pump();
    }

    function disarm(): void {
        if (deadline !== null) clearTimeout(deadline);
        deadline = null;
    }

    function cut(): void {
        disarm();
        cached.truncated = true;
        cached.stopped = true;
        stack.length = 0;
        scopeRead.resolve();
        settle();
    }

    function settle(): void {
        if (cached.ended || inFlight > 0 || stack.length > 0) return;
        cached.ended = true;
        disarm();
        ended.resolve();
        onEnd(cached);
    }

    function overBudget(): boolean {
        return now() - cached.startedAt > limits.walkBudgetMs;
    }

    function insert(folder: number, dirents: readonly SearchDirent[]): void {
        if (cached.stopped) return;
        if (overBudget()) return cut();
        const childDepth = index.depthOf(folder) + 1;
        for (let k = 0; k < dirents.length; k++) {
            // `k` is below the length of the array.
            const dirent = dirents[k]!;
            const name = dirent.name;
            const isHidden = name.charCodeAt(0) === 0x2e;
            if (isHidden && !hidden) continue;
            if (index.count >= limits.maxEntries || total.value >= limits.maxTotalEntries) return cut();
            const isFolder = dirent.isDirectory();
            const entry = index.add(name, folder, isFolder ? "folder" : dirent.isSymbolicLink() ? "symlink" : "file", isHidden);
            total.value += 1;
            if (!isFolder) continue;
            if (childDepth < limits.maxDepth) stack.push(entry);
            else cached.truncated = true;
        }
    }

    function pump(): void {
        while (!cached.stopped && inFlight < limits.width && stack.length > 0) {
            if (overBudget()) return cut();
            // The loop condition holds a non-empty stack.
            const folder = stack.pop()!;
            inFlight += 1;
            read(folder === 0 ? scope : index.pathOf(folder)).then(
                (dirents) => {
                    inFlight -= 1;
                    insert(folder, dirents);
                    if (folder === 0) scopeRead.resolve();
                    pump();
                },
                (cause: unknown) => {
                    inFlight -= 1;
                    if (folder === 0) {
                        cached.error = readError(scope, cause);
                        cached.stopped = true;
                        stack.length = 0;
                        scopeRead.resolve();
                    }
                    pump();
                },
            );
        }
        settle();
    }

    return cached;
}

/** A cache of name indexes, one for each canonical scope and `hidden` value. */
export type SearchIndexCache = {
    /**
     * Search the names under `canonical`, a scope that the caller resolved with `realpath`. The first search of a scope
     * starts its walk, and each later search of it scores the index in memory, during the walk or after it. A search waits
     * for the read of the scope, then for the walk until `firstWaitMs` after the start of the walk, thus a later search
     * during the walk answers at once. A failed read of the scope gives its {@link FolderReadError} and removes the index.
     */
    readonly search: (canonical: string, hidden: boolean, query: string, limit: number) => ResultAsync<SearchResult, FolderReadError>;
    /** Clear the TTL timer, stop each walk, and drop each index. */
    readonly stop: () => void;
};

/**
 * Make a {@link SearchIndexCache}. An index leaves the cache at `ttlMs` after its last search, by a timer and by a sweep at
 * each search, and the least recently used index leaves first when a new index would pass `maxTotalEntries` or
 * `maxIndexes`. An eviction stops the walk. Nothing else stops a walk, thus a client that goes away leaves the walk to the
 * next search of the same scope.
 */
export function createSearchIndexCache(
    limits: SearchLimits = DEFAULT_SEARCH_LIMITS,
    now: () => number = Date.now,
    read: ReadEntries = readFolderEntries,
): SearchIndexCache {
    // The order of the map is the order of use, least recent first: each search moves its index to the end.
    const indexes = new Map<string, CachedIndex>();
    const total: EntryTotal = { value: 0 };
    let timer: ReturnType<typeof setTimeout> | null = null;

    function evict(cached: CachedIndex): void {
        indexes.delete(cached.key);
        total.value -= cached.index.count;
        cached.stop();
    }

    function onEnd(cached: CachedIndex): void {
        if (cached.error !== null && indexes.get(cached.key) === cached) evict(cached);
    }

    function sweep(): void {
        const at = now();
        for (const cached of indexes.values()) {
            if (at - cached.lastUse > limits.ttlMs) evict(cached);
        }
    }

    function makeRoom(): void {
        for (const cached of indexes.values()) {
            if (total.value + limits.maxEntries <= limits.maxTotalEntries && indexes.size < limits.maxIndexes) return;
            evict(cached);
        }
    }

    function arm(): void {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        let earliest = Infinity;
        for (const cached of indexes.values()) earliest = Math.min(earliest, cached.lastUse);
        if (earliest === Infinity) return;
        timer = setTimeout(
            () => {
                sweep();
                arm();
            },
            Math.max(0, earliest + limits.ttlMs - now()) + 1,
        );
        // An idle index must not keep the process alive.
        timer.unref();
    }

    /**
     * The wait of a search: always the read of the scope, so that a failed scope read gives its error and never an empty
     * answer, then the rest of the walk until `firstWaitMs` after its start.
     */
    async function waitForWalk(cached: CachedIndex): Promise<void> {
        await cached.scopeRead;
        const remaining = cached.startedAt + limits.firstWaitMs - now();
        if (cached.ended || remaining <= 0) return;
        let wait: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<void>((resolve) => {
            wait = setTimeout(resolve, remaining);
        });
        await Promise.race([cached.end, timeout]).finally(() => clearTimeout(wait));
    }

    function answer(cached: CachedIndex, query: string, limit: number): SearchResult {
        const index = cached.index;
        const hits = index.rank(query, limit).map((i): SearchHit => ({ entry: index.entryOf(i), subpath: index.subpathOf(i), depth: index.depthOf(i) }));
        return { hits, truncated: cached.truncated || !cached.ended };
    }

    function search(canonical: string, hidden: boolean, query: string, limit: number): ResultAsync<SearchResult, FolderReadError> {
        sweep();
        const key = `${canonical}\0${String(hidden)}`;
        const at = now();
        let cached = indexes.get(key);
        if (cached === undefined) {
            makeRoom();
            cached = createWalk(key, canonical, hidden, limits, now, read, total, onEnd);
            indexes.set(key, cached);
            cached.begin();
        } else {
            indexes.delete(key);
            indexes.set(key, cached);
        }
        cached.lastUse = at;
        arm();
        const found = cached;
        return ResultAsync.fromSafePromise(waitForWalk(found)).andThen(() => (found.error !== null ? err(found.error) : ok(answer(found, query, limit))));
    }

    function stop(): void {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        for (const cached of indexes.values()) cached.stop();
        indexes.clear();
        total.value = 0;
    }

    return { search, stop };
}
