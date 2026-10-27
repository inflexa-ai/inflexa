import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ArtifactOrigin, Pool } from "@inflexa-ai/harness";
import { errAsync, okAsync } from "neverthrow";

import type { ApiError } from "../../api/common.ts";
import type { FilePreview, FolderList, FsSearch, HomeFolder } from "../../api/fs.ts";
import { insertAnalysis, insertAnalysisInput, insertAnchor } from "../../db/primary_mutation.ts";
import { db } from "../../db/primary.ts";
import { entryDetails } from "../../lib/folder_listing.ts";
import { subsequenceScore } from "../../lib/fuzzy.ts";
import type { LockOutcome } from "../../lib/lock.ts";
import { asStr256 } from "../../lib/types.ts";
import { invalidateWorkspaceRoot, workspaceRootForAnalysisId } from "../../modules/analysis/output.ts";
import { writeMarker } from "../../modules/anchor/marker.ts";
import { DEFAULT_SEARCH_LIMITS, readFolderEntries, type SearchIndexCache, type SearchLimits } from "../../modules/fs/search_index.ts";
import type { HarnessRuntime } from "../../modules/harness/runtime.ts";
import { freshDb } from "../../test_support/db.ts";
import { idleBoot } from "../../test_support/server.ts";
import type { ServerBoot } from "../boot.ts";
import { DEFAULT_FS_ROUTE_OPTS, fsRoutes, type FsRouteOpts } from "./fs.ts";

// The routes alone, with no app and no bearer check: `app.test.ts` covers those. Each `as` cast of a body below
// reads JSON that the route under test builds from the same `src/api/` type.
const routes = fsRoutes(idleBoot());

let root = "";
const searchCaches: SearchIndexCache[] = [];

/** Routes whose search cache the cleanup stops, thus no walk and no TTL timer outlives its test. */
function searchRoutes(boot: ServerBoot, opts: Partial<FsRouteOpts> = {}): ReturnType<typeof fsRoutes> {
    return fsRoutes(boot, { ...DEFAULT_FS_ROUTE_OPTS, ...opts, onSearchCache: (cache) => searchCaches.push(cache) });
}

function searchLimits(limits: Partial<SearchLimits>): SearchLimits {
    return { ...DEFAULT_SEARCH_LIMITS, ...limits };
}

async function searchBody(app: ReturnType<typeof fsRoutes>, path: string, query: string): Promise<FsSearch> {
    const response = await app.request(`/search?path=${encodeURIComponent(path)}${query}`);
    expect(response.status).toBe(200);
    return (await response.json()) as FsSearch;
}

beforeEach(() => {
    // realpath so path assertions match the canonical paths of the listing (macOS /var -> /private/var).
    root = realpathSync(mkdtempSync(join(tmpdir(), "inflexa-fs-routes-")));
});

afterEach(() => {
    for (const cache of searchCaches.splice(0)) cache.stop();
    rmSync(root, { recursive: true, force: true });
});

function list(path: string, query = ""): Promise<Response> {
    return Promise.resolve(routes.request(`/list?path=${encodeURIComponent(path)}${query}`));
}

async function listBody(path: string, query = ""): Promise<FolderList> {
    const response = await list(path, query);
    expect(response.status).toBe(200);
    return (await response.json()) as FolderList;
}

/** The standard folder of the sort scenarios: the folder `beta`, the files `alpha.txt` and `Zeta.txt`, and the file `.env`. */
function seedSortFolder(): void {
    mkdirSync(join(root, "beta"));
    writeFileSync(join(root, "alpha.txt"), "12345");
    writeFileSync(join(root, "Zeta.txt"), "x");
    writeFileSync(join(root, ".env"), "x");
}

describe("GET /api/v1/fs/home", () => {
    test("gives the canonical home folder of the server user", async () => {
        const response = await routes.request("/home");
        expect(response.status).toBe(200);
        expect((await response.json()) as HomeFolder).toEqual({ path: realpathSync(homedir()) });
    });

    test("gives the real path of a home folder behind a link", async () => {
        const real = join(root, "real-home");
        mkdirSync(real);
        symlinkSync(real, join(root, "home-link"));
        const linked = fsRoutes(idleBoot(), { ...DEFAULT_FS_ROUTE_OPTS, homedir: () => join(root, "home-link") });
        const response = await linked.request("/home");
        expect(response.status).toBe(200);
        expect((await response.json()) as HomeFolder).toEqual({ path: real });
    });

    test("gives the home path as the operating system gives it when the server cannot resolve it", async () => {
        const missing = join(root, "no-such-home");
        const missingHome = fsRoutes(idleBoot(), { ...DEFAULT_FS_ROUTE_OPTS, homedir: () => missing });
        const response = await missingHome.request("/home");
        expect(response.status).toBe(200);
        expect((await response.json()) as HomeFolder).toEqual({ path: missing });
    });
});

describe("the analysis guard of the fs routes", () => {
    let acquired: string[] = [];
    let outcome: LockOutcome = { acquired: true };
    let guarded = fsRoutes(idleBoot());

    beforeEach(() => {
        freshDb();
        insertAnchor({ id: "A1", createdAt: 1, updatedAt: 1, cachedPath: root, markerWritten: false, lastSeen: 1 })._unsafeUnwrap();
        insertAnalysis({ id: "a1", createdAt: 1, updatedAt: 1, name: asStr256("Study"), slug: "study", anchorId: "A1", projectId: null })._unsafeUnwrap();
        acquired = [];
        outcome = { acquired: true };
        guarded = fsRoutes(idleBoot(), {
            ...DEFAULT_FS_ROUTE_OPTS,
            acquireLock: (analysisId) => {
                acquired.push(analysisId);
                return outcome;
            },
        });
    });

    function guardedList(analysisId: string): Promise<Response> {
        return Promise.resolve(guarded.request(`/list?path=${encodeURIComponent(root)}&analysisId=${encodeURIComponent(analysisId)}`));
    }

    test("404 `not_found` for an unknown analysis on /list, with no lock call", async () => {
        const response = await guardedList("nope");
        expect(response.status).toBe(404);
        const body = (await response.json()) as ApiError;
        expect(body.error).toBe("not_found");
        expect(body.message).toContain("nope");
        expect(acquired).toEqual([]);
    });

    test("404 `not_found` for an unknown analysis on /home", async () => {
        const response = await guarded.request("/home?analysisId=nope");
        expect(response.status).toBe(404);
        expect(((await response.json()) as ApiError).error).toBe("not_found");
    });

    test("409 `locked` with the pid of the holder from a different live process", async () => {
        outcome = { acquired: false, holderPid: 4242 };
        const response = await guardedList("a1");
        expect(response.status).toBe(409);
        const body = (await response.json()) as ApiError;
        expect(body.error).toBe("locked");
        expect(body.details).toEqual({ holderPid: 4242 });
        expect(acquired).toEqual(["a1"]);
    });

    test("takes no lock for an absent or an empty analysis id", async () => {
        expect((await guarded.request(`/list?path=${encodeURIComponent(root)}`)).status).toBe(200);
        expect((await guardedList("")).status).toBe(200);
        expect(acquired).toEqual([]);
    });

    test("takes one lock for a known analysis", async () => {
        const response = await guardedList("a1");
        expect(response.status).toBe(200);
        expect(acquired).toEqual(["a1"]);
    });

    test("404 `not_found` for an unknown analysis on /search, with no lock call and no folder read", async () => {
        const read: string[] = [];
        // The cache reads the clock at each search, thus a clock with no read shows that no search, and no walk, started.
        let clockReads = 0;
        const counted = searchRoutes(idleBoot(), {
            now: () => {
                clockReads += 1;
                return Date.now();
            },
            acquireLock: (analysisId) => {
                acquired.push(analysisId);
                return outcome;
            },
            entryDetails: (entry, identity) => {
                read.push(entry.path);
                return entryDetails(entry, identity);
            },
        });
        writeFileSync(join(root, "a.csv"), "x");
        const response = await counted.request(`/search?path=${encodeURIComponent(root)}&q=a&analysisId=nope`);
        expect(response.status).toBe(404);
        expect(((await response.json()) as ApiError).error).toBe("not_found");
        expect(acquired).toEqual([]);
        expect(read).toEqual([]);
        expect(clockReads).toBe(0);
    });

    test("404 `not_found` for an unknown analysis on /preview, with no lock call", async () => {
        const response = await guarded.request(`/preview?path=${encodeURIComponent(root)}&analysisId=nope`);
        expect(response.status).toBe(404);
        expect(((await response.json()) as ApiError).error).toBe("not_found");
        expect(acquired).toEqual([]);
    });
});

describe("GET /api/v1/fs/list", () => {
    test("lists the folders first, then the files in case-insensitive order, and hides the dot-entries", async () => {
        seedSortFolder();
        const body = await listBody(root);
        expect(body.entries.map((e) => e.name)).toEqual(["beta", "alpha.txt", "Zeta.txt"]);
        expect(body).toMatchObject({ total: 3, page: 0, perPage: 100, hasMore: false });
        expect(body.folder.path).toBe(root);

        const [beta, alpha] = body.entries;
        expect(beta).toMatchObject({ type: "folder", kind: null, size: null, link: null, hidden: false, path: join(root, "beta") });
        expect(alpha).toMatchObject({ type: "file", kind: "table", size: 5, readable: true, link: null, hidden: false });
        expect(typeof alpha?.mode).toBe("number");
        expect(new Date(alpha?.modifiedAt ?? "").toISOString()).toBe(alpha?.modifiedAt ?? "");
    });

    test("shows the hidden entries on request", async () => {
        seedSortFolder();
        const body = await listBody(root, "&hidden=true");
        expect(body.entries.map((e) => [e.name, e.hidden])).toEqual([
            ["beta", false],
            [".env", true],
            ["alpha.txt", false],
            ["Zeta.txt", false],
        ]);
        expect(body.total).toBe(4);
    });

    test("gives the stored target and the target kind of a link, and sorts the links after the folders", async () => {
        mkdirSync(join(root, "real"));
        mkdirSync(join(root, "z-folder"));
        symlinkSync("real", join(root, "data"));
        symlinkSync(join(root, "missing"), join(root, "gone"));
        const body = await listBody(root);
        expect(body.entries.map((e) => e.name)).toEqual(["real", "z-folder", "data", "gone"]);
        const [, , data, gone] = body.entries;
        expect(data).toMatchObject({ type: "symlink", kind: null, size: null, link: { target: "real", broken: false, targetKind: "folder" } });
        expect(gone).toEqual({
            name: "gone",
            path: join(root, "gone"),
            type: "symlink",
            kind: null,
            link: { target: join(root, "missing"), broken: true, targetKind: null },
            size: null,
            modifiedAt: null,
            mode: null,
            readable: null,
            writable: null,
            hidden: false,
            itemCount: null,
            isInput: false,
            origin: null,
        });
    });

    test("pages a large folder", async () => {
        for (let i = 0; i < 250; i += 1) writeFileSync(join(root, `f${String(i).padStart(3, "0")}.txt`), "x");
        const body = await listBody(root, "&page=1&perPage=100");
        expect(body.entries.map((e) => e.name)).toEqual(Array.from({ length: 100 }, (_, i) => `f${String(i + 100).padStart(3, "0")}.txt`));
        expect(body).toMatchObject({ total: 250, page: 1, perPage: 100, hasMore: true });
    });

    test("reads the facts of the entries of the returned page only", async () => {
        for (let i = 0; i < 250; i += 1) writeFileSync(join(root, `f${String(i).padStart(3, "0")}.txt`), "x");
        const read: string[] = [];
        const counted = fsRoutes(idleBoot(), {
            ...DEFAULT_FS_ROUTE_OPTS,
            entryDetails: (entry, identity) => {
                read.push(entry.name);
                return entryDetails(entry, identity);
            },
        });
        const response = await counted.request(`/list?path=${encodeURIComponent(root)}&page=2&perPage=100`);
        expect(((await response.json()) as FolderList).entries).toHaveLength(50);
        expect(read).toHaveLength(50);
        expect(read[0]).toBe("f200.txt");
    });

    test("a read that does not end stops only its own request", async () => {
        writeFileSync(join(root, "f.txt"), "x");
        let release: () => void = () => {};
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const hung = fsRoutes(idleBoot(), {
            ...DEFAULT_FS_ROUTE_OPTS,
            entryDetails: async (entry, identity) => {
                await held;
                return entryDetails(entry, identity);
            },
        });
        const pending = Promise.resolve(hung.request(`/list?path=${encodeURIComponent(root)}`));
        const home = await hung.request("/home");
        expect(home.status).toBe(200);

        release();
        expect((await pending).status).toBe(200);
    });

    test("gives the canonical path of a folder reached through a link", async () => {
        const real = join(root, "real");
        mkdirSync(real);
        writeFileSync(join(real, "f.txt"), "x");
        symlinkSync(real, join(root, "l"));
        const body = await listBody(join(root, "l"));
        expect(body.folder.path).toBe(real);
        expect(body.entries[0]?.path).toBe(join(real, "f.txt"));
        expect(body.folder.readable).toBe(true);
    });

    test("removes a `..` segment of the path as text", async () => {
        mkdirSync(join(root, "a"));
        mkdirSync(join(root, "b"));
        const body = await listBody(join(root, "a", "..", "b"));
        expect(body.folder.path).toBe(join(root, "b"));
    });

    test("gives the kind of each file from the kind map, and null for an unknown name", async () => {
        for (const name of ["a.csv", "b.png", "c.py", "d.log", "e.json", "f.md", "g.unknown", "README"]) writeFileSync(join(root, name), "x");
        const body = await listBody(root);
        expect(body.entries.map((e) => [e.name, e.kind])).toEqual([
            ["a.csv", "table"],
            ["b.png", "figure"],
            ["c.py", "code"],
            ["d.log", "log"],
            ["e.json", "data"],
            ["f.md", "doc"],
            ["g.unknown", null],
            ["README", null],
        ]);
    });

    test("gives the item count of a folder and of a link to a folder, and null for a file", async () => {
        mkdirSync(join(root, "sub"));
        writeFileSync(join(root, "sub", "a.csv"), "x");
        writeFileSync(join(root, "sub", ".hidden"), "x");
        writeFileSync(join(root, "b.csv"), "x");
        symlinkSync("sub", join(root, "link"));
        symlinkSync(join(root, "b.csv"), join(root, "filelink"));

        const count = (body: FolderList, name: string): number | null | undefined => body.entries.find((e) => e.name === name)?.itemCount;
        const shown = await listBody(root);
        expect(count(shown, "sub")).toBe(1);
        expect(count(shown, "link")).toBe(1);
        expect(count(shown, "b.csv")).toBeNull();
        expect(count(shown, "filelink")).toBeNull();

        const withHidden = await listBody(root, "&hidden=true");
        expect(count(withHidden, "sub")).toBe(2);
        // The count of a folder equals the `total` of a list of that folder with the same `hidden` value.
        expect((await listBody(join(root, "sub"), "&hidden=true")).total).toBe(2);
        expect((await listBody(join(root, "sub"))).total).toBe(1);
    });

    test.skipIf(process.getuid?.() === 0)("keeps a folder that the server cannot read in the list with a null item count", async () => {
        const locked = join(root, "locked");
        mkdirSync(locked);
        chmodSync(locked, 0o000);
        try {
            const body = await listBody(root);
            expect(body.entries[0]).toMatchObject({ name: "locked", type: "folder", itemCount: null });
        } finally {
            chmodSync(locked, 0o755);
        }
    });

    test("reads the facts in a queue of fixed width", async () => {
        for (let i = 0; i < 60; i += 1) writeFileSync(join(root, `f${String(i).padStart(2, "0")}.txt`), "x");
        let inFlight = 0;
        let peak = 0;
        const measured = fsRoutes(idleBoot(), {
            ...DEFAULT_FS_ROUTE_OPTS,
            entryDetails: async (entry, identity) => {
                inFlight += 1;
                peak = Math.max(peak, inFlight);
                await Bun.sleep(2);
                inFlight -= 1;
                return entryDetails(entry, identity);
            },
        });
        const response = await measured.request(`/list?path=${encodeURIComponent(root)}`);
        expect(response.status).toBe(200);
        expect(peak).toBeGreaterThan(1);
        expect(peak).toBeLessThanOrEqual(16);
    });

    test("lists the root of the disk, with no entry that carries the content of a file", async () => {
        const body = await listBody("/");
        expect(body.folder.path).toBe("/");
        for (const entry of body.entries) {
            expect(Object.keys(entry).sort()).toEqual([
                "hidden",
                "isInput",
                "itemCount",
                "kind",
                "link",
                "mode",
                "modifiedAt",
                "name",
                "origin",
                "path",
                "readable",
                "size",
                "type",
                "writable",
            ]);
        }
    });
});

describe("GET /api/v1/fs/list namePrefix", () => {
    function seedPrefixFolder(): void {
        for (const name of ["Counts.csv", "counts-raw.csv", "meta.json", ".counts"]) writeFileSync(join(root, name), "x");
    }

    test("selects the entries whose name starts with the prefix, with no regard to case", async () => {
        seedPrefixFolder();
        const body = await listBody(root, "&namePrefix=cou");
        expect(body.entries.map((e) => e.name)).toEqual(["counts-raw.csv", "Counts.csv"]);
        expect(body.total).toBe(2);
    });

    test("gives a hidden entry only for a prefix that starts with a dot", async () => {
        seedPrefixFolder();
        const body = await listBody(root, "&namePrefix=.c");
        expect(body.entries.map((e) => e.name)).toEqual([".counts"]);
        expect(body.total).toBe(1);
    });

    test("does not let `hidden` change which entries a prefix selects", async () => {
        seedPrefixFolder();
        expect((await listBody(root, "&namePrefix=cou&hidden=true")).entries.map((e) => e.name)).toEqual(["counts-raw.csv", "Counts.csv"]);
        expect((await listBody(root, "&namePrefix=.c&hidden=false")).entries.map((e) => e.name)).toEqual([".counts"]);
    });

    test("treats an empty prefix as no prefix, and keeps the hidden rule of the request", async () => {
        seedPrefixFolder();
        const hiddenOff = await listBody(root, "&namePrefix=");
        expect(hiddenOff.entries.map((e) => e.name)).toEqual(["counts-raw.csv", "Counts.csv", "meta.json"]);
        expect(hiddenOff.total).toBe(3);
        expect((await listBody(root, "&namePrefix=&hidden=true")).total).toBe(4);
    });

    test("counts the total after the prefix filter and pages over the selected entries", async () => {
        for (let i = 0; i < 30; i += 1) writeFileSync(join(root, `a${String(i).padStart(2, "0")}.txt`), "x");
        for (let i = 0; i < 5; i += 1) writeFileSync(join(root, `b${i}.txt`), "x");
        const body = await listBody(root, "&namePrefix=A&page=1&perPage=10");
        expect(body).toMatchObject({ total: 30, page: 1, perPage: 10, hasMore: true });
        expect(body.entries.map((e) => e.name)).toEqual(Array.from({ length: 10 }, (_, i) => `a${String(i + 10).padStart(2, "0")}.txt`));
    });

    test("gives an empty page for a prefix that no name has", async () => {
        seedPrefixFolder();
        expect(await listBody(root, "&namePrefix=zzz")).toMatchObject({ entries: [], total: 0, hasMore: false });
    });
});

describe("GET /api/v1/fs/list isInput and origin", () => {
    const identity = { version: "0.0.0-test", apiVersion: 1, startedAt: "2026-10-02T00:00:00.000Z" } as const;
    // The route only passes the pool to the injected read, thus a stand-in object is enough.
    const runtime = { pool: {} as Pool } as unknown as HarnessRuntime;
    const readyBoot: ServerBoot = {
        state: () => ({ ...identity, phase: "ready", connection: { provider: "anthropic", mode: "cliproxy", model: "m" } }),
        runtime: () => runtime,
        start: async () => undefined,
    };

    type OriginCall = { analysisId: string; paths: readonly string[] };
    let home = "";
    let outside = "";
    let workspace = "";
    let calls: OriginCall[] = [];
    let rows: ArtifactOrigin[] = [];
    let failing = false;

    function listWith(boot: ServerBoot): ReturnType<typeof fsRoutes> {
        return fsRoutes(boot, {
            ...DEFAULT_FS_ROUTE_OPTS,
            acquireLock: () => ({ acquired: true }),
            artifactOrigins: (_pool, analysisId, paths): ReturnType<FsRouteOpts["artifactOrigins"]> => {
                calls.push({ analysisId, paths });
                return failing ? errAsync({ type: "query_failed", op: "test", cause: "down" }) : okAsync(rows);
            },
        });
    }

    async function listAs(boot: ServerBoot, path: string, query: string): Promise<FolderList> {
        const response = await listWith(boot).request(`/list?path=${encodeURIComponent(path)}${query}`);
        expect(response.status).toBe(200);
        return (await response.json()) as FolderList;
    }

    beforeEach(async () => {
        freshDb();
        // The workspace-root memo is process state that outlives freshDb().
        invalidateWorkspaceRoot();
        calls = [];
        rows = [];
        failing = false;
        // realpath so the paths match the canonical paths of the route (macOS /var -> /private/var).
        home = realpathSync(mkdtempSync(join(tmpdir(), "inflexa-fs-analysis-")));
        outside = realpathSync(mkdtempSync(join(tmpdir(), "inflexa-fs-outside-")));
        (await writeMarker(home, "A1"))._unsafeUnwrap();
        insertAnchor({ id: "A1", createdAt: 1, updatedAt: 1, cachedPath: home, markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
        insertAnalysis({ id: "a1", createdAt: 1, updatedAt: 1, name: asStr256("Study"), slug: "study", anchorId: "A1", projectId: null })._unsafeUnwrap();
        workspace = (await workspaceRootForAnalysisId("a1"))._unsafeUnwrap();
    });

    afterEach(() => {
        invalidateWorkspaceRoot();
        rmSync(home, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
    });

    function declareInput(path: string, isDir: boolean): void {
        insertAnalysisInput({ path, isDir, analysisId: "a1", anchorId: null })._unsafeUnwrap();
    }

    function seedOutput(): string {
        const output = join(workspace, "runs", "r1", "s1", "output");
        mkdirSync(output, { recursive: true });
        writeFileSync(join(output, "de.csv"), "x");
        writeFileSync(join(output, "other.csv"), "x");
        return output;
    }

    test("gives isInput false and origin null for each entry without an analysis id", async () => {
        const output = seedOutput();
        declareInput(output, true);
        rows = [{ path: "runs/r1/s1/output/de.csv", runId: "r1", stepId: "s1" }];
        const body = await listAs(readyBoot, output, "");
        expect(body.entries.map((e) => [e.name, e.isInput, e.origin])).toEqual([
            ["de.csv", false, null],
            ["other.csv", false, null],
        ]);
        expect(calls).toEqual([]);
    });

    test("marks an entry that is a declared input folder, with a boundary-safe test", async () => {
        mkdirSync(join(outside, "study"));
        mkdirSync(join(outside, "study-old"));
        writeFileSync(join(outside, "study", "counts.csv"), "x");
        declareInput(join(outside, "study"), true);

        const parent = await listAs(readyBoot, outside, "&analysisId=a1");
        expect(parent.entries.map((e) => [e.name, e.isInput])).toEqual([
            ["study", true],
            ["study-old", false],
        ]);
        const inside = await listAs(readyBoot, join(outside, "study"), "&analysisId=a1");
        expect(inside.entries.map((e) => [e.name, e.isInput])).toEqual([["counts.csv", true]]);
    });

    test("marks an entry that is a declared input file", async () => {
        writeFileSync(join(outside, "counts.csv"), "x");
        writeFileSync(join(outside, "other.csv"), "x");
        declareInput(join(outside, "counts.csv"), false);
        const body = await listAs(readyBoot, outside, "&analysisId=a1");
        expect(body.entries.map((e) => [e.name, e.isInput])).toEqual([
            ["counts.csv", true],
            ["other.csv", false],
        ]);
    });

    test("marks only the path of a declared input file, and not a sibling or a path inside it", async () => {
        mkdirSync(join(outside, "sub"));
        writeFileSync(join(outside, "sub", "x.csv"), "x");
        writeFileSync(join(outside, "sub.bak"), "x");
        // The row says file while the disk holds a folder: a file input never marks a path inside it.
        declareInput(join(outside, "sub"), false);

        const parent = await listAs(readyBoot, outside, "&analysisId=a1");
        expect(parent.entries.map((e) => [e.name, e.isInput])).toEqual([
            ["sub", true],
            ["sub.bak", false],
        ]);
        const inside = await listAs(readyBoot, join(outside, "sub"), "&analysisId=a1");
        expect(inside.entries.map((e) => [e.name, e.isInput])).toEqual([["x.csv", false]]);
    });

    test("marks the entry of an input that is stored relative to its anchor", async () => {
        mkdirSync(join(home, "data"));
        writeFileSync(join(home, "data", "counts.csv"), "x");
        writeFileSync(join(home, "data", "other.csv"), "x");
        insertAnalysisInput({ path: "data/counts.csv", isDir: false, analysisId: "a1", anchorId: "A1" })._unsafeUnwrap();

        const body = await listAs(readyBoot, join(home, "data"), "&analysisId=a1");
        expect(body.entries.map((e) => [e.name, e.isInput])).toEqual([
            ["counts.csv", true],
            ["other.csv", false],
        ]);
    });

    test("marks no entry for an input whose anchor folder cannot be located, and still marks the located inputs", async () => {
        writeFileSync(join(outside, "lost.csv"), "x");
        writeFileSync(join(outside, "kept.csv"), "x");
        insertAnchor({ id: "A2", createdAt: 1, updatedAt: 1, cachedPath: join(outside, "gone"), markerWritten: false, lastSeen: 1 })._unsafeUnwrap();
        insertAnalysisInput({ path: "lost.csv", isDir: false, analysisId: "a1", anchorId: "A2" })._unsafeUnwrap();
        declareInput(join(outside, "kept.csv"), false);

        const body = await listAs(readyBoot, outside, "&analysisId=a1");
        expect(body.entries.map((e) => [e.name, e.isInput])).toEqual([
            ["kept.csv", true],
            ["lost.csv", false],
        ]);
    });

    test("gives the kind and the item count of each entry with an analysis id as without one", async () => {
        mkdirSync(join(outside, "sub"));
        writeFileSync(join(outside, "sub", "a.csv"), "x");
        writeFileSync(join(outside, "sub", "b.csv"), "x");
        writeFileSync(join(outside, "plot.png"), "x");
        symlinkSync("sub", join(outside, "link"));

        const without = await listAs(readyBoot, outside, "");
        const withAnalysis = await listAs(readyBoot, outside, "&analysisId=a1");
        const facts = (body: FolderList): (string | number | null)[][] => body.entries.map((e) => [e.name, e.kind, e.itemCount]);
        expect(facts(withAnalysis)).toEqual([
            ["sub", null, 2],
            ["link", null, 2],
            ["plot.png", "figure", null],
        ]);
        expect(facts(without)).toEqual(facts(withAnalysis));
    });

    test("500 `internal_error` when the read of the declared inputs fails, with no ledger read", async () => {
        db()._unsafeUnwrap().run("ALTER TABLE analysis_inputs RENAME TO analysis_inputs_unreadable");
        const response = await listWith(readyBoot).request(`/list?path=${encodeURIComponent(outside)}&analysisId=a1`);
        expect(response.status).toBe(500);
        expect(((await response.json()) as ApiError).error).toBe("internal_error");
        expect(calls).toEqual([]);
    });

    test("500 `internal_error` when the read of the anchor for the workspace folder fails, with no ledger read", async () => {
        db()._unsafeUnwrap().run("ALTER TABLE anchors RENAME TO anchors_unreadable");
        const response = await listWith(readyBoot).request(`/list?path=${encodeURIComponent(outside)}&analysisId=a1`);
        expect(response.status).toBe(500);
        expect(((await response.json()) as ApiError).error).toBe("internal_error");
        expect(calls).toEqual([]);
    });

    test("gives the step that wrote a file, and null for a file with no ledger row", async () => {
        const output = seedOutput();
        rows = [{ path: "runs/r1/s1/output/de.csv", runId: "r1", stepId: "s1" }];
        const body = await listAs(readyBoot, output, "&analysisId=a1");
        expect(body.entries.map((e) => [e.name, e.origin])).toEqual([
            ["de.csv", { runId: "r1", stepId: "s1" }],
            ["other.csv", null],
        ]);
    });

    test("gives a null origin for a ledger row that has no run or no step", async () => {
        const output = seedOutput();
        rows = [
            { path: "runs/r1/s1/output/de.csv", runId: null, stepId: null },
            { path: "runs/r1/s1/output/other.csv", runId: "r1", stepId: null },
        ];
        const body = await listAs(readyBoot, output, "&analysisId=a1");
        expect(body.entries.map((e) => e.origin)).toEqual([null, null]);
    });

    test("sends one ledger read for a page, with the relative paths of the page", async () => {
        const output = join(workspace, "big");
        mkdirSync(output, { recursive: true });
        for (let i = 0; i < 150; i += 1) writeFileSync(join(output, `f${String(i).padStart(3, "0")}.txt`), "x");
        await listAs(readyBoot, output, "&analysisId=a1&perPage=100");
        expect(calls).toHaveLength(1);
        expect(calls[0]?.analysisId).toBe("a1");
        expect(calls[0]?.paths).toEqual(Array.from({ length: 100 }, (_, i) => `big/f${String(i).padStart(3, "0")}.txt`));
    });

    test("sends one ledger read for the hits of a search, and gives the origin of each hit", async () => {
        mkdirSync(join(workspace, "out"), { recursive: true });
        for (let i = 0; i < 5; i += 1) writeFileSync(join(workspace, "out", `hit${i}.csv`), "x");
        for (let i = 0; i < 20; i += 1) writeFileSync(join(workspace, `other${i}.txt`), "x");
        rows = [{ path: "out/hit0.csv", runId: "r1", stepId: "s1" }];
        const app = searchRoutes(readyBoot, {
            acquireLock: () => ({ acquired: true }),
            artifactOrigins: (_pool, analysisId, paths): ReturnType<FsRouteOpts["artifactOrigins"]> => {
                calls.push({ analysisId, paths });
                return okAsync(rows);
            },
        });
        const body = await searchBody(app, workspace, "&q=hit.csv&analysisId=a1");
        expect(body.hits).toHaveLength(5);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.analysisId).toBe("a1");
        expect([...(calls[0]?.paths ?? [])].sort()).toEqual(Array.from({ length: 5 }, (_, i) => `out/hit${i}.csv`));
        expect(body.hits.map((hit) => [hit.entry.name, hit.entry.origin])).toEqual([
            ["hit0.csv", { runId: "r1", stepId: "s1" }],
            ["hit1.csv", null],
            ["hit2.csv", null],
            ["hit3.csv", null],
            ["hit4.csv", null],
        ]);
    });

    test("sends no ledger read for a folder outside the workspace, and gives null origins", async () => {
        writeFileSync(join(outside, "f.csv"), "x");
        const body = await listAs(readyBoot, outside, "&analysisId=a1");
        expect(calls).toEqual([]);
        expect(body.entries.map((e) => e.origin)).toEqual([null]);
    });

    test("gives no origin to the workspace folder itself, and sends no ledger read for it", async () => {
        mkdirSync(workspace, { recursive: true });
        const body = await listAs(readyBoot, dirname(workspace), "&analysisId=a1&hidden=true");
        expect(body.entries.find((e) => e.path === workspace)?.origin).toBeNull();
        expect(calls).toEqual([]);
    });

    test("answers with null origins and sends no ledger read before the runtime boot is ready", async () => {
        const output = seedOutput();
        rows = [{ path: "runs/r1/s1/output/de.csv", runId: "r1", stepId: "s1" }];
        const body = await listAs(idleBoot(), output, "&analysisId=a1");
        expect(body.entries.map((e) => e.origin)).toEqual([null, null]);
        expect(calls).toEqual([]);
    });

    test("answers with null origins when the ledger read fails", async () => {
        const output = seedOutput();
        failing = true;
        const body = await listAs(readyBoot, output, "&analysisId=a1");
        expect(calls).toHaveLength(1);
        expect(body.entries.map((e) => e.origin)).toEqual([null, null]);
        expect(body.total).toBe(2);
    });
});

describe("GET /api/v1/fs/list errors", () => {
    async function expectError(response: Response, status: number, code: ApiError["error"]): Promise<ApiError> {
        expect(response.status).toBe(status);
        const body = (await response.json()) as ApiError;
        expect(body.error).toBe(code);
        return body;
    }

    test("400 `validation_error` for no path", async () => {
        const body = await expectError(await routes.request("/list"), 400, "validation_error");
        expect(body.details).toEqual({ formErrors: [], fieldErrors: { path: ["The path must be absolute."] } });
    });

    test("400 `validation_error` for a relative path", async () => {
        const body = await expectError(await list("data"), 400, "validation_error");
        expect(body.details).toEqual({ formErrors: [], fieldErrors: { path: ["The path must be absolute."] } });
    });

    test("400 `validation_error` for a path that holds a NUL byte", async () => {
        const body = await expectError(await list(`${root}/a\0b`), 400, "validation_error");
        expect(body.details).toEqual({ formErrors: [], fieldErrors: { path: ["The path must be absolute."] } });
    });

    test("400 `validation_error` for a `hidden` value that is not `true` or `false`", async () => {
        const body = await expectError(await list(root, "&hidden=yes"), 400, "validation_error");
        expect(body.details).toEqual({ formErrors: [], fieldErrors: { hidden: ["must be true or false"] } });
    });

    test("404 `not_found` for a folder that does not exist", async () => {
        await expectError(await list(join(root, "missing")), 404, "not_found");
    });

    test("400 `validation_error` for the path of a file", async () => {
        writeFileSync(join(root, "f.txt"), "x");
        const body = await expectError(await list(join(root, "f.txt")), 400, "validation_error");
        expect(body.details).toEqual({ formErrors: [], fieldErrors: { path: ["The path is not a folder."] } });
    });

    test.skipIf(process.getuid?.() === 0)("403 `forbidden` for a folder with mode 000, with the cause", async () => {
        const locked = join(root, "locked");
        mkdirSync(locked);
        chmodSync(locked, 0o000);
        try {
            const body = await expectError(await list(locked), 403, "forbidden");
            expect(body.message).toContain("EACCES");
            expect(body.details).toEqual({ code: "EACCES" });
        } finally {
            chmodSync(locked, 0o755);
        }
    });
});

describe("GET /api/v1/fs/preview", () => {
    function previewWith(opts: Partial<FsRouteOpts>): ReturnType<typeof fsRoutes> {
        return fsRoutes(idleBoot(), { ...DEFAULT_FS_ROUTE_OPTS, ...opts });
    }

    function preview(path: string, app: ReturnType<typeof fsRoutes> = routes): Promise<Response> {
        return Promise.resolve(app.request(`/preview?path=${encodeURIComponent(path)}`));
    }

    async function previewBody(path: string, app: ReturnType<typeof fsRoutes> = routes): Promise<FilePreview> {
        const response = await preview(path, app);
        expect(response.status).toBe(200);
        return (await response.json()) as FilePreview;
    }

    describe("the members", () => {
        test("gives a table with the full text, the separator, the column count, and the row count", async () => {
            const text = 'gene,"a,b",c\nTP53,1,2\nEGFR,3,4\n';
            writeFileSync(join(root, "counts.csv"), text);
            expect(await previewBody(join(root, "counts.csv"))).toEqual({ kind: "table", text, separator: ",", columnCount: 3, rowCount: 2 });
        });

        test("gives a table from a head that is cut, with the text to its last line end and a null row count", async () => {
            const text = `g\tv\n${"x\t1\n".repeat(20)}`;
            writeFileSync(join(root, "counts.tsv"), text);
            const body = await previewBody(join(root, "counts.tsv"), previewWith({ previewBytes: 32 }));
            expect(body).toMatchObject({ kind: "table", separator: "\t", columnCount: 2, rowCount: null });
            const head = body.kind === "table" ? body.text : "";
            expect(head.endsWith("\n")).toBe(true);
            expect(head.length).toBeLessThanOrEqual(32);
            expect(text.startsWith(head)).toBe(true);
        });

        test("chooses the tab when the header holds a tab and a comma", async () => {
            writeFileSync(join(root, "mixed.csv"), "a,b\tc\n1,2\n");
            expect(await previewBody(join(root, "mixed.csv"))).toMatchObject({ kind: "table", separator: "\t", columnCount: 2 });
        });

        test("does not end the header record at a line end inside double quotes", async () => {
            writeFileSync(join(root, "h.csv"), 'name,"unit\nlabel"\nA,1\nB,2\n');
            expect(await previewBody(join(root, "h.csv"))).toMatchObject({ kind: "table", separator: ",", columnCount: 2, rowCount: 2 });
        });

        test("gives text for a cut head whose only line end is inside double quotes in the header", async () => {
            writeFileSync(join(root, "cut.csv"), 'name,"unit\nlabel"\nA,1\nB,2\n');
            expect(await previewBody(join(root, "cut.csv"), previewWith({ previewBytes: 12 }))).toMatchObject({ kind: "text", language: "csv" });
        });

        test("does not count a line end inside double quotes as the end of a record", async () => {
            writeFileSync(join(root, "q.csv"), 'h1,h2\n"a\nb",1\nc,2\n');
            expect(await previewBody(join(root, "q.csv"))).toMatchObject({ kind: "table", columnCount: 2, rowCount: 2 });
        });

        test("counts a last record that has no line end, and handles CRLF line ends", async () => {
            writeFileSync(join(root, "a.csv"), "h1,h2\r\n1,2\r\n3,4");
            expect(await previewBody(join(root, "a.csv"))).toMatchObject({ kind: "table", columnCount: 2, rowCount: 2 });
            writeFileSync(join(root, "b.csv"), "h1,h2\r\n");
            expect(await previewBody(join(root, "b.csv"))).toMatchObject({ kind: "table", columnCount: 2, rowCount: 0 });
        });

        test("gives text for a table file whose header holds no tab and no comma", async () => {
            writeFileSync(join(root, "notes.txt"), "hello\nworld\n");
            expect(await previewBody(join(root, "notes.txt"))).toEqual({ kind: "text", language: "text", code: "hello\nworld\n" });
        });

        test("gives text, and not a table, for a head that holds no line end", async () => {
            writeFileSync(join(root, "wide.csv"), "aaaa,bbbb,cccc,dddd");
            expect(await previewBody(join(root, "wide.csv"), previewWith({ previewBytes: 8 }))).toEqual({
                kind: "text",
                language: "csv",
                code: "aaaa,bbb",
            });
        });

        test("keeps the whole decoded text of a cut head with no line end, and drops a character that the cut splits", async () => {
            writeFileSync(join(root, "wide.txt"), "é".repeat(10));
            expect(await previewBody(join(root, "wide.txt"), previewWith({ previewBytes: 5 }))).toEqual({ kind: "text", language: "text", code: "éé" });
        });

        test("gives the text of a source file with the language of its extension", async () => {
            writeFileSync(join(root, "analysis.py"), "print(1)\n");
            writeFileSync(join(root, "run.sh"), "echo 1\n");
            writeFileSync(join(root, "view.ipynb"), "{}");
            writeFileSync(join(root, "odd.xyz"), "x");
            expect(await previewBody(join(root, "analysis.py"))).toEqual({ kind: "text", language: "python", code: "print(1)\n" });
            expect(await previewBody(join(root, "run.sh"))).toMatchObject({ language: "bash" });
            expect(await previewBody(join(root, "view.ipynb"))).toMatchObject({ language: "json" });
            expect(await previewBody(join(root, "odd.xyz"))).toMatchObject({ kind: "text", language: "text" });
        });

        test("gives an empty file as text", async () => {
            writeFileSync(join(root, "empty.py"), "");
            expect(await previewBody(join(root, "empty.py"))).toEqual({ kind: "text", language: "python", code: "" });
        });

        test("gives a figure with the read URL of the real path, and reads no byte of it", async () => {
            writeFileSync(join(root, "volcano.png"), "not an image");
            writeFileSync(join(root, "note.py"), "x");
            const readSpies: { mock: { calls: unknown[] } }[] = [];
            const counted = previewWith({
                open: async (path, flags) => {
                    const handle = await open(path, flags);
                    // The spy calls through, thus it counts the reads of the handle and changes none.
                    readSpies.push(spyOn(handle, "read"));
                    return handle;
                },
            });
            const readCount = (): number => readSpies.reduce((sum, spy) => sum + spy.mock.calls.length, 0);

            // A text file reads its head with the same handle, thus the count can move.
            await previewBody(join(root, "note.py"), counted);
            expect(readCount()).toBeGreaterThan(0);

            const before = readCount();
            const body = await previewBody(join(root, "volcano.png"), counted);
            expect(body).toEqual({ kind: "figure", src: `/api/v1/fs/read?path=${encodeURIComponent(join(root, "volcano.png"))}`, alt: "volcano.png" });
            expect(readSpies).toHaveLength(2);
            expect(readCount()).toBe(before);
        });

        test("gives a card for a head that holds a NUL byte, with the extension in lower case as the format", async () => {
            writeFileSync(join(root, "matrix.H5AD"), Buffer.from([0x89, 0x48, 0x00, 0x46]));
            writeFileSync(join(root, "blob"), Buffer.from([0x00]));
            expect(await previewBody(join(root, "matrix.H5AD"))).toEqual({ kind: "card", format: "h5ad" });
            expect(await previewBody(join(root, "blob"))).toEqual({ kind: "card", format: null });
        });

        test("gives a card for a head that is not UTF-8, with no NUL byte", async () => {
            writeFileSync(join(root, "latin.csv"), Buffer.from([0x63, 0xe9, 0x0a]));
            expect(await previewBody(join(root, "latin.csv"))).toEqual({ kind: "card", format: "csv" });
        });

        test("gives a folder with the count of its entries, the kinds, and the first names", async () => {
            mkdirSync(join(root, "raw"));
            for (const name of ["a.csv", "b.csv", "plot.png", "README", ".cache"]) writeFileSync(join(root, name), "x");
            expect(await previewBody(root)).toEqual({
                kind: "folder",
                items: 5,
                kinds: [
                    { kind: "folder", count: 1 },
                    { kind: "table", count: 2 },
                    { kind: "figure", count: 1 },
                ],
                names: [
                    { name: "raw", dir: true, kind: null },
                    { name: "a.csv", dir: false, kind: "table" },
                    { name: "b.csv", dir: false, kind: "table" },
                    { name: "plot.png", dir: false, kind: "figure" },
                    { name: "README", dir: false, kind: null },
                ],
            });
        });

        test("names the first entries of a large folder in the order of the folder list", async () => {
            mkdirSync(join(root, "zz"));
            for (let i = 0; i < 25; i += 1) writeFileSync(join(root, `f${String(24 - i).padStart(2, "0")}.txt`), "x");
            const body = await previewBody(root);
            expect(body).toMatchObject({ kind: "folder", items: 26 });
            const names = body.kind === "folder" ? body.names : [];
            expect(names.map((entry) => entry.name)).toEqual(["zz", ...Array.from({ length: 9 }, (_, i) => `f${String(i).padStart(2, "0")}.txt`)]);
        });

        test("gives an empty folder with no kind", async () => {
            expect(await previewBody(root)).toEqual({ kind: "folder", items: 0, kinds: [], names: [] });
        });

        test("gives the preview of the target for a link to a file and for a link to a folder", async () => {
            writeFileSync(join(root, "run7.csv"), "a,b\n1,2\n");
            symlinkSync("run7.csv", join(root, "latest.csv"));
            mkdirSync(join(root, "real"));
            writeFileSync(join(root, "real", "x.py"), "x");
            symlinkSync("real", join(root, "link"));
            expect(await previewBody(join(root, "latest.csv"))).toMatchObject({ kind: "table", columnCount: 2, rowCount: 1 });
            expect(await previewBody(join(root, "link"))).toMatchObject({ kind: "folder", items: 1 });
        });

        test("takes the kind from the name of the real path", async () => {
            writeFileSync(join(root, "plot.png"), "x");
            symlinkSync("plot.png", join(root, "latest"));
            const body = await previewBody(join(root, "latest"));
            expect(body).toEqual({ kind: "figure", src: `/api/v1/fs/read?path=${encodeURIComponent(join(root, "plot.png"))}`, alt: "plot.png" });
        });

        test("removes a `..` segment of the path as text", async () => {
            mkdirSync(join(root, "a"));
            writeFileSync(join(root, "b.py"), "x");
            expect(await previewBody(join(root, "a", "..", "b.py"))).toMatchObject({ kind: "text" });
        });
    });

    describe("the open", () => {
        function tracked(replace?: (path: string, flags: number) => Promise<Awaited<ReturnType<typeof open>>>): {
            app: ReturnType<typeof fsRoutes>;
            opened: () => number;
            closed: () => number;
        } {
            let opened = 0;
            let closed = 0;
            const app = previewWith({
                open: async (path, flags) => {
                    const handle = await (replace ?? open)(path, flags);
                    opened += 1;
                    const close = handle.close.bind(handle);
                    handle.close = async (): Promise<void> => {
                        closed += 1;
                        await close();
                    };
                    return handle;
                },
            });
            return { app, opened: () => opened, closed: () => closed };
        }

        test("closes the handle of a file, of a figure, and of a folder", async () => {
            writeFileSync(join(root, "a.py"), "x");
            writeFileSync(join(root, "p.png"), "x");
            mkdirSync(join(root, "d"));
            const { app, opened, closed } = tracked();
            for (const name of ["a.py", "p.png", "d"]) expect((await preview(join(root, name), app)).status).toBe(200);
            expect([opened(), closed()]).toEqual([3, 3]);
        });

        test("403 `forbidden` for a symbolic link that replaces the last part after the resolve, with no byte of the target", async () => {
            writeFileSync(join(root, "secret.txt"), "TOP-SECRET");
            symlinkSync(join(root, "secret.txt"), join(root, "late-link"));
            writeFileSync(join(root, "a.csv"), "a,b\n");
            const app = previewWith({ open: (_path, flags) => open(join(root, "late-link"), flags) });
            const response = await preview(join(root, "a.csv"), app);
            expect(response.status).toBe(403);
            const text = await response.text();
            expect(JSON.parse(text)).toMatchObject({ error: "forbidden" });
            expect(text).not.toContain("TOP-SECRET");
        });

        test("403 `forbidden` for a folder whose real path is not the opened folder after the read, and closes the handle", async () => {
            mkdirSync(join(root, "asked"));
            mkdirSync(join(root, "other"));
            writeFileSync(join(root, "asked", "a.csv"), "x");
            const { app, opened, closed } = tracked((_path, flags) => open(join(root, "other"), flags));
            const response = await preview(join(root, "asked"), app);
            expect(response.status).toBe(403);
            expect(((await response.json()) as ApiError).error).toBe("forbidden");
            expect([opened(), closed()]).toEqual([1, 1]);
        });

        test("403 `forbidden` with the code of the operating system for an open that fails", async () => {
            writeFileSync(join(root, "a.csv"), "x");
            const app = previewWith({ open: () => Promise.reject(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })) });
            const response = await preview(join(root, "a.csv"), app);
            expect(response.status).toBe(403);
            expect(((await response.json()) as ApiError).details).toEqual({ code: "EACCES" });
        });

        test("400 `validation_error` for an open that fails the way a socket does", async () => {
            writeFileSync(join(root, "a.csv"), "x");
            const app = previewWith({ open: () => Promise.reject(Object.assign(new Error("ENXIO"), { code: "ENXIO" })) });
            const response = await preview(join(root, "a.csv"), app);
            expect(response.status).toBe(400);
            expect(((await response.json()) as ApiError).error).toBe("validation_error");
        });
    });

    describe("the errors", () => {
        async function expectError(response: Response, status: number, code: ApiError["error"]): Promise<ApiError> {
            expect(response.status).toBe(status);
            const body = (await response.json()) as ApiError;
            expect(body.error).toBe(code);
            return body;
        }

        test("400 `validation_error` for no path, an empty path, a relative path, and a path with a NUL byte", async () => {
            const absent = await expectError(await routes.request("/preview"), 400, "validation_error");
            expect(absent.details).toEqual({ formErrors: [], fieldErrors: { path: ["The path must be absolute."] } });
            await expectError(await routes.request("/preview?path="), 400, "validation_error");
            await expectError(await preview("data/counts.csv"), 400, "validation_error");
            await expectError(await preview(`${root}/a\0b`), 400, "validation_error");
        });

        test("404 `not_found` for a path that does not exist", async () => {
            await expectError(await preview(join(root, "missing.csv")), 404, "not_found");
        });

        test("404 `not_found` for a link to a path that does not exist", async () => {
            symlinkSync(join(root, "missing"), join(root, "gone"));
            await expectError(await preview(join(root, "gone")), 404, "not_found");
        });

        test("404 `not_found` for a loop of links", async () => {
            symlinkSync(join(root, "b"), join(root, "a"));
            symlinkSync(join(root, "a"), join(root, "b"));
            await expectError(await preview(join(root, "a")), 404, "not_found");
        });

        test("404 `not_found` for a path with a part that is not a folder", async () => {
            writeFileSync(join(root, "f.txt"), "x");
            await expectError(await preview(join(root, "f.txt", "inner")), 404, "not_found");
        });

        test.skipIf(process.platform === "win32")("400 `validation_error` for a FIFO", async () => {
            const fifo = join(root, "pipe");
            expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
            const body = await expectError(await preview(fifo), 400, "validation_error");
            expect(body.details).toEqual({ formErrors: [], fieldErrors: { path: ["The path is not a file or a folder."] } });
        });

        test.skipIf(process.getuid?.() === 0)("403 `forbidden` with the code EACCES for a file with mode 000", async () => {
            const locked = join(root, "locked.csv");
            writeFileSync(locked, "x");
            chmodSync(locked, 0o000);
            try {
                const body = await expectError(await preview(locked), 403, "forbidden");
                expect(body.details).toEqual({ code: "EACCES" });
            } finally {
                chmodSync(locked, 0o644);
            }
        });

        test.skipIf(process.getuid?.() === 0)("403 `forbidden` with the code EACCES for a folder with mode 000", async () => {
            const locked = join(root, "locked");
            mkdirSync(locked);
            chmodSync(locked, 0o000);
            try {
                const body = await expectError(await preview(locked), 403, "forbidden");
                expect(body.details).toEqual({ code: "EACCES" });
            } finally {
                chmodSync(locked, 0o755);
            }
        });
    });
});

describe("GET /api/v1/fs/search", () => {
    let clock = 0;

    beforeEach(() => {
        clock = 0;
    });

    function seedData(): void {
        mkdirSync(join(root, "raw"));
        mkdirSync(join(root, "figures"));
        writeFileSync(join(root, "raw", "counts.csv"), "x");
        writeFileSync(join(root, "figures", "volcano.png"), "x");
    }

    test("gives a nested hit with its path, its subpath, and its kind", async () => {
        seedData();
        const body = await searchBody(searchRoutes(idleBoot()), root, "&q=volc");
        expect(body.truncated).toBe(false);
        expect(body.hits).toHaveLength(1);
        expect(body.hits[0]).toMatchObject({
            entry: { name: "volcano.png", path: join(root, "figures", "volcano.png"), type: "file", kind: "figure", isInput: false, origin: null },
            subpath: "figures",
        });
    });

    test("gives a folder as a hit, with its item count and an empty subpath", async () => {
        seedData();
        const body = await searchBody(searchRoutes(idleBoot()), root, "&q=fig");
        const figures = body.hits.find((hit) => hit.entry.name === "figures");
        expect(figures).toMatchObject({ entry: { type: "folder", kind: null, itemCount: 1 }, subpath: "" });
    });

    test("keeps a hidden entry out of the hits without `hidden`, and gives it with `hidden=true`", async () => {
        mkdirSync(join(root, ".cache"));
        mkdirSync(join(root, "figures"));
        writeFileSync(join(root, ".cache", "volcano.png"), "x");
        writeFileSync(join(root, "figures", "volcano.png"), "x");
        const app = searchRoutes(idleBoot());
        const shown = await searchBody(app, root, "&q=volcano");
        expect(shown.hits.map((hit) => `${hit.subpath}/${hit.entry.name}`)).toEqual(["figures/volcano.png"]);
        const withHidden = await searchBody(app, root, "&q=volcano&hidden=true");
        expect(withHidden.hits.map((hit) => `${hit.subpath}/${hit.entry.name}`).sort()).toEqual([".cache/volcano.png", "figures/volcano.png"]);
    });

    test("gives the best `limit` hits in the order of the score", async () => {
        const names = Array.from({ length: 30 }, (_, k) => `${"x".repeat(k % 7)}a${k}.txt`);
        for (const name of names) writeFileSync(join(root, name), "x");
        const body = await searchBody(searchRoutes(idleBoot()), root, "&q=a&limit=10");
        const best = names
            .map((name) => ({ name, score: subsequenceScore("a", name) }))
            .sort((p, q) => q.score - p.score || (p.name < q.name ? -1 : p.name > q.name ? 1 : 0))
            .slice(0, 10)
            .map((hit) => hit.name);
        expect(body.hits.map((hit) => hit.entry.name)).toEqual(best);
    });

    test("gives 50 hits by default and for a bad `limit`, and at most 200", async () => {
        for (let i = 0; i < 250; i += 1) writeFileSync(join(root, `f${String(i).padStart(3, "0")}.txt`), "x");
        const app = searchRoutes(idleBoot());
        expect((await searchBody(app, root, "&q=f")).hits).toHaveLength(50);
        expect((await searchBody(app, root, "&q=f&limit=abc")).hits).toHaveLength(50);
        expect((await searchBody(app, root, "&q=f&limit=0")).hits).toHaveLength(50);
        expect((await searchBody(app, root, "&q=f&limit=7")).hits).toHaveLength(7);
        expect((await searchBody(app, root, "&q=f&limit=500")).hits).toHaveLength(200);
    });

    test("matches each entry for an absent or an empty query", async () => {
        seedData();
        const app = searchRoutes(idleBoot());
        expect((await searchBody(app, root, "")).hits).toHaveLength(4);
        expect((await searchBody(app, root, "&q=")).hits).toHaveLength(4);
    });

    test("reads the facts of the hits only", async () => {
        for (let i = 0; i < 997; i += 1) writeFileSync(join(root, `f${String(i).padStart(4, "0")}.txt`), "x");
        for (let i = 0; i < 3; i += 1) writeFileSync(join(root, `volcano-${i}.png`), "x");
        const read: string[] = [];
        const app = searchRoutes(idleBoot(), {
            entryDetails: (entry, identity) => {
                read.push(entry.name);
                return entryDetails(entry, identity);
            },
        });
        const body = await searchBody(app, root, "&q=volcano");
        expect(body.hits.map((hit) => hit.entry.name)).toEqual(["volcano-0.png", "volcano-1.png", "volcano-2.png"]);
        expect(read.sort()).toEqual(["volcano-0.png", "volcano-1.png", "volcano-2.png"]);
    });

    test("sets `truncated` at the entry cap of one index", async () => {
        for (let i = 0; i < 25; i += 1) writeFileSync(join(root, `f${i}.csv`), "x");
        const body = await searchBody(searchRoutes(idleBoot(), { search: searchLimits({ maxEntries: 10 }) }), root, "");
        expect(body.truncated).toBe(true);
        // The cap counts the scope, which is no hit.
        expect(body.hits.length).toBeLessThanOrEqual(9);
    });

    test("sets `truncated` at the depth cap, and gives no hit below it", async () => {
        mkdirSync(join(root, "a", "b", "c"), { recursive: true });
        writeFileSync(join(root, "a", "b", "c", "deep.csv"), "x");
        const body = await searchBody(searchRoutes(idleBoot(), { search: searchLimits({ maxDepth: 2 }) }), root, "&q=deep");
        expect(body).toEqual({ hits: [], truncated: true });
    });

    test("walks a scope again after its TTL, and answers from the index before it", async () => {
        writeFileSync(join(root, "a.csv"), "x");
        const app = searchRoutes(idleBoot(), { search: searchLimits({ ttlMs: 1000 }), now: () => clock });
        expect((await searchBody(app, root, "&q=csv")).hits.map((hit) => hit.entry.name)).toEqual(["a.csv"]);
        writeFileSync(join(root, "b.csv"), "x");
        clock = 500;
        expect((await searchBody(app, root, "&q=csv")).hits.map((hit) => hit.entry.name)).toEqual(["a.csv"]);
        clock = 2000;
        expect((await searchBody(app, root, "&q=csv")).hits.map((hit) => hit.entry.name)).toEqual(["a.csv", "b.csv"]);
    });

    test.skipIf(process.getuid?.() === 0)("skips a folder that it cannot read, and stays complete", async () => {
        const locked = join(root, "locked");
        mkdirSync(locked);
        writeFileSync(join(locked, "inner.csv"), "x");
        writeFileSync(join(root, "open.csv"), "x");
        chmodSync(locked, 0o000);
        try {
            const app = searchRoutes(idleBoot());
            const body = await searchBody(app, root, "&q=open");
            expect(body.hits.map((hit) => hit.entry.name)).toEqual(["open.csv"]);
            expect(body.truncated).toBe(false);
            expect((await searchBody(app, root, "&q=locked")).hits.map((hit) => [hit.entry.name, hit.entry.type])).toEqual([["locked", "folder"]]);
        } finally {
            chmodSync(locked, 0o755);
        }
    });

    test("does not enter a symbolic link, and gives the link as an entry", async () => {
        const outside = realpathSync(mkdtempSync(join(tmpdir(), "inflexa-fs-search-outside-")));
        try {
            writeFileSync(join(outside, "deep.csv"), "x");
            symlinkSync(outside, join(root, "ext"));
            const app = searchRoutes(idleBoot());
            expect((await searchBody(app, root, "&q=deep")).hits).toEqual([]);
            const link = (await searchBody(app, root, "&q=ext")).hits;
            expect(link).toHaveLength(1);
            expect(link[0]?.entry).toMatchObject({ name: "ext", type: "symlink", link: { targetKind: "folder" }, itemCount: 1 });
        } finally {
            rmSync(outside, { recursive: true, force: true });
        }
    });

    test("over a real listener, a client disconnect does not stop the walk", async () => {
        mkdirSync(join(root, "slow"));
        writeFileSync(join(root, "slow", "inside.csv"), "x");
        writeFileSync(join(root, "top.csv"), "x");
        const slow = join(root, "slow");
        const reads: string[] = [];
        const slowStarted = Promise.withResolvers<void>();
        const gate = Promise.withResolvers<void>();
        const app = searchRoutes(idleBoot(), {
            readEntries: async (path) => {
                reads.push(path);
                if (path === slow) {
                    slowStarted.resolve();
                    await gate.promise;
                }
                return readFolderEntries(path);
            },
        });
        const serverAborted = Promise.withResolvers<void>();
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: (request, bun) => {
                request.signal.addEventListener("abort", () => serverAborted.resolve());
                return app.fetch(request, bun);
            },
        });
        const url = (query: string): string => `http://127.0.0.1:${server.port}/search?path=${encodeURIComponent(root)}${query}`;
        try {
            const client = new AbortController();
            const first = fetch(url("&q=inside"), { signal: client.signal }).then(
                () => "answered",
                () => "aborted",
            );
            await slowStarted.promise;
            client.abort();
            expect(await first).toBe("aborted");
            await serverAborted.promise;
            gate.resolve();
            await Bun.sleep(20);

            const response = await fetch(url("&q=inside"));
            expect(response.status).toBe(200);
            // The body is the `FsSearch` that the route builds.
            const body = (await response.json()) as FsSearch;
            expect(body.truncated).toBe(false);
            expect(body.hits.map((hit) => `${hit.subpath}/${hit.entry.name}`)).toEqual(["slow/inside.csv"]);
            expect(reads.sort()).toEqual([root, slow]);
        } finally {
            gate.resolve();
            await server.stop(true);
        }
    });

    test("searches the canonical scope of a path through a link", async () => {
        seedData();
        const linked = `${root}-link`;
        symlinkSync(root, linked);
        try {
            const body = await searchBody(searchRoutes(idleBoot()), linked, "&q=volc");
            expect(body.hits[0]?.entry.path).toBe(join(root, "figures", "volcano.png"));
        } finally {
            rmSync(linked, { force: true });
        }
    });
});

describe("GET /api/v1/fs/search errors", () => {
    async function expectError(response: Response, status: number, code: ApiError["error"]): Promise<ApiError> {
        expect(response.status).toBe(status);
        const body = (await response.json()) as ApiError;
        expect(body.error).toBe(code);
        return body;
    }

    function search(path: string, query = "&q=a"): Promise<Response> {
        return Promise.resolve(searchRoutes(idleBoot()).request(`/search?path=${encodeURIComponent(path)}${query}`));
    }

    test("400 `validation_error` for no path, a relative path, and a path with a NUL byte", async () => {
        const absent = await expectError(await searchRoutes(idleBoot()).request("/search?q=a"), 400, "validation_error");
        expect(absent.details).toEqual({ formErrors: [], fieldErrors: { path: ["The path must be absolute."] } });
        await expectError(await search("data"), 400, "validation_error");
        await expectError(await search(`${root}/a\0b`), 400, "validation_error");
    });

    test("400 `validation_error` for a `hidden` value that is not `true` or `false`", async () => {
        const body = await expectError(await search(root, "&q=a&hidden=yes"), 400, "validation_error");
        expect(body.details).toEqual({ formErrors: [], fieldErrors: { hidden: ["must be true or false"] } });
    });

    test("404 `not_found` for a scope that does not exist", async () => {
        await expectError(await search(join(root, "missing")), 404, "not_found");
    });

    test("400 `validation_error` for the path of a file", async () => {
        writeFileSync(join(root, "f.txt"), "x");
        const body = await expectError(await search(join(root, "f.txt")), 400, "validation_error");
        expect(body.details).toEqual({ formErrors: [], fieldErrors: { path: ["The path is not a folder."] } });
    });

    test.skipIf(process.getuid?.() === 0)("403 `forbidden` with the code EACCES for a scope with mode 000", async () => {
        const locked = join(root, "locked");
        mkdirSync(locked);
        chmodSync(locked, 0o000);
        try {
            const body = await expectError(await search(locked), 403, "forbidden");
            expect(body.details).toEqual({ code: "EACCES" });
        } finally {
            chmodSync(locked, 0o755);
        }
    });
});
