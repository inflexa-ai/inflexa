import { describe, expect, it } from "bun:test";

import { chmod, mkdir, mkdtemp, readFile, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";

import { z } from "zod";

import { makeToolContext } from "../../__fixtures__/tool-context.js";
import { createListAvailableRefsTool } from "../list-available-refs.js";
import { parseJsonAs } from "../../../lib/parse-json.js";
import { presentAt } from "../../../lib/present.js";

/** A store rooted at an arbitrary host path — the reported paths must still be `/mnt/refs/...`. */
async function makeStore(label: string): Promise<string> {
    return await mkdtemp(join(tmpdir(), `refs-${label}-`));
}

function createTool(refStorePath?: string, canDownload?: boolean) {
    return createListAvailableRefsTool({ refStorePath, canDownload });
}

/** Write a file below the store, with its parent directories. */
async function put(root: string, relative: string, body: string | Uint8Array): Promise<string> {
    const path = join(root, ...relative.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    return path;
}

/** A fixed modification time, thus a test can write a file again with the same key. */
const FIXED_TIME = 1_700_000_000;

describe("list_available_refs", () => {
    // The whole point of the host-side read: the store lives at an arbitrary host path,
    // but every reported path is the container path the caller will actually open.
    it("reads the host store and reports container paths", async () => {
        const root = await makeStore("host-path");
        await put(root, "user/cohort/reference.h5ad", "reference");

        const result = (await createTool(root).execute({ path: "user/cohort" }, makeToolContext().ctx))._unsafeUnwrap();

        expect(result.entries).toEqual([expect.objectContaining({ path: "/mnt/refs/user/cohort/reference.h5ad", kind: "file", bytes: 9 })]);
        expect(presentAt(result.entries, 0).path.startsWith(root)).toBe(false);
    });

    it("needs no sandbox and discovers manifest-free user files", async () => {
        const root = await makeStore("manifest-free");
        await put(root, "user/cohort/reference.h5ad", "reference");

        const result = (await createTool(root).execute({}, makeToolContext().ctx))._unsafeUnwrap();

        expect(result).toMatchObject({ available: true, state: "populated", truncated: false, unlooked: 0 });
        expect(result.entries).toEqual([expect.objectContaining({ path: "/mnt/refs/user/cohort/reference.h5ad", kind: "file", bytes: 9 })]);
    });

    // Skills name no reference paths, so an agent finds a file by describing what it needs. The
    // name of a file the user added says nothing, thus the start of the file carries the meaning.
    it("finds a file by its content from the store root, and renders its first lines", async () => {
        const root = await makeStore("by-content");
        const sets = "HALLMARK_APOPTOSIS\thttp://example.org\tCASP3\tBAX\nHALLMARK_HYPOXIA\thttp://example.org\tHIF1A\n";
        await put(root, "mine/sets.gmt", sets);
        await put(root, "mine/other.txt", "nothing to see\n");

        const result = (await createTool(root).execute({ query: "hallmark" }, makeToolContext().ctx))._unsafeUnwrap();

        expect(result.entries).toEqual([
            {
                path: "/mnt/refs/mine/sets.gmt",
                kind: "file",
                bytes: Buffer.byteLength(sets),
                look: {
                    format: "gmt",
                    lines: ["HALLMARK_APOPTOSIS\thttp://example.org\tCASP3\tBAX", "HALLMARK_HYPOXIA\thttp://example.org\tHIF1A"],
                },
            },
        ]);
        expect(result.content).toContain("- /mnt/refs/mine/sets.gmt");
        expect(result.content).toContain("    | HALLMARK_APOPTOSIS");
    });

    it("gives the columns of a compressed table from its decompressed start", async () => {
        const root = await makeStore("gzip");
        const rows = Array.from({ length: 20_000 }, (_, index) => `GENE${index}\t${index}\t${index * 7}`).join("\n");
        // Larger than the look reads, thus the look decompresses a cut stream.
        await put(root, "tables/genes.tsv.gz", gzipSync(`symbol\tentrez\tlength\n${rows}\n`));

        const result = (await createTool(root).execute({ path: "tables" }, makeToolContext().ctx))._unsafeUnwrap();

        expect(presentAt(result.entries, 0)).toMatchObject({
            path: "/mnt/refs/tables/genes.tsv.gz",
            look: { format: "tsv", compression: "gzip", columns: ["symbol", "entrez", "length"] },
        });
        const found = (await createTool(root).execute({ query: "entrez" }, makeToolContext().ctx))._unsafeUnwrap();
        expect(found.entries.map((entry) => entry.path)).toEqual(["/mnt/refs/tables/genes.tsv.gz"]);
    });

    it("gives the format and no text for a binary file", async () => {
        const root = await makeStore("binary");
        await put(root, "atlas/cells.h5ad", new Uint8Array([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0xff]));

        const result = (await createTool(root).execute({ path: "atlas" }, makeToolContext().ctx))._unsafeUnwrap();

        expect(presentAt(result.entries, 0)).toEqual({ path: "/mnt/refs/atlas/cells.h5ad", kind: "file", bytes: 12, look: { format: "hdf5" } });
    });

    // Browsing must stay a directory summary — a recursive dump of every file is what
    // the bounding exists to prevent.
    // A download nests each file under its host and the path of its URL, thus the folders of a small store name nothing.
    it("lists the files of a small store with their looks when no query is given", async () => {
        const root = await makeStore("browse-small");
        await put(root, "ftp.ebi.ac.uk/pub/databases/collectri/CollecTRI_regulons.csv", "source,target\n");

        const result = (await createTool(root).execute({}, makeToolContext().ctx))._unsafeUnwrap();

        expect(result.entries.map((entry) => [entry.path, entry.kind, "look" in entry])).toEqual([
            ["/mnt/refs/ftp.ebi.ac.uk/pub/databases/collectri/CollecTRI_regulons.csv", "file", true],
        ]);
    });

    it("browses one level of a larger store when no query is given, summarizing directories", async () => {
        const root = await makeStore("browse-large");
        await Promise.all(Array.from({ length: 41 }, (_, index) => put(root, `shards/${String(index).padStart(2, "0")}.tsv`, "a\tb\n")));

        const result = (await createTool(root).execute({}, makeToolContext().ctx))._unsafeUnwrap();

        expect(result.entries).toEqual([expect.objectContaining({ path: "/mnt/refs/shards", kind: "directory", fileCount: 41 })]);
    });

    it("tells an agent without download_ref to report a reference that matches nothing as absent", async () => {
        const root = await makeStore("miss");
        await put(root, "collectri/CollecTRI_regulons.csv", "source,target");

        const result = (await createTool(root).execute({ query: "hallmark" }, makeToolContext().ctx))._unsafeUnwrap();

        expect(result.total).toBe(0);
        expect(result.content).toBe(
            'No reference beneath /mnt/refs matches "hallmark". The store at /mnt/refs is the only reference data that the sandbox can read, and the sandbox has no network. Say that the dataset is absent now. Do not guess a path, and do not use a different dataset in its place.',
        );
    });

    it("tells an agent with download_ref that it can download a reference that matches nothing", async () => {
        const root = await makeStore("miss-download");
        await put(root, "collectri/CollecTRI_regulons.csv", "source,target");

        const result = (await createTool(root, true).execute({ query: "hallmark" }, makeToolContext().ctx))._unsafeUnwrap();

        expect(result.total).toBe(0);
        expect(result.content).toBe(
            'No reference beneath /mnt/refs matches "hallmark". The sandbox has no network. You can download the reference into the store with download_ref.',
        );
    });

    it("lists no store metadata, and no search finds it", async () => {
        const root = await makeStore("metadata");
        await put(root, "user/observed.csv", "gene,score\n");
        await put(root, ".inflexa/sources.jsonl", '{"path":"user/observed.csv","url":"https://example.org/observed.csv"}\n');

        const tool = createTool(root);
        const listed = (await tool.execute({}, makeToolContext().ctx))._unsafeUnwrap();
        expect(listed.entries.map((entry) => entry.path)).toEqual(["/mnt/refs/user/observed.csv"]);
        const searched = (await tool.execute({ query: "example.org" }, makeToolContext().ctx))._unsafeUnwrap();
        expect(searched.entries).toEqual([]);
        const sources = (await tool.execute({ query: "sources" }, makeToolContext().ctx))._unsafeUnwrap();
        expect(sources.entries).toEqual([]);
    });

    // A cached look is the proof that no read happened: the file below changes its bytes but
    // keeps its size and its modification time, and the answer keeps the bytes of the first read.
    it("reads no file content for a file whose look is in the cache, and keeps the cache in the store", async () => {
        const root = await makeStore("cache-hit");
        const file = await put(root, "sets/a.gmt", "ALPHA_SET\tna\tA\n");
        await utimes(file, FIXED_TIME, FIXED_TIME);

        const tool = createTool(root);
        const first = (await tool.execute({ path: "sets" }, makeToolContext().ctx))._unsafeUnwrap();
        expect(presentAt(first.entries, 0)).toMatchObject({ look: { lines: ["ALPHA_SET\tna\tA"] } });

        await writeFile(file, "OMEGA_SET\tna\tA\n");
        await utimes(file, FIXED_TIME, FIXED_TIME);
        const second = (await tool.execute({ path: "sets" }, makeToolContext().ctx))._unsafeUnwrap();
        expect(presentAt(second.entries, 0)).toMatchObject({ look: { lines: ["ALPHA_SET\tna\tA"] } });

        const cache = parseJsonAs(await readFile(join(root, ".inflexa", "peek-cache.json"), "utf-8"), z.json());
        expect(cache).toMatchObject({ version: 1, looks: { "sets/a.gmt": { bytes: 15, mtimeMs: FIXED_TIME * 1000, look: { format: "gmt" } } } });
    });

    it("looks at a file again when a file of a different size replaces it", async () => {
        const root = await makeStore("cache-miss");
        const file = await put(root, "sets/a.gmt", "ALPHA_SET\tna\tA\n");
        await utimes(file, FIXED_TIME, FIXED_TIME);

        const tool = createTool(root);
        (await tool.execute({ path: "sets" }, makeToolContext().ctx))._unsafeUnwrap();
        await writeFile(file, "OMEGA_SET\tna\tA\tB\n");
        await utimes(file, FIXED_TIME, FIXED_TIME);
        const second = (await tool.execute({ path: "sets" }, makeToolContext().ctx))._unsafeUnwrap();

        expect(presentAt(second.entries, 0)).toMatchObject({ look: { lines: ["OMEGA_SET\tna\tA\tB"] } });
    });

    it("keeps the cache in memory for a store that the host cannot write", async () => {
        const root = await makeStore("read-only");
        const file = await put(root, "sets/a.gmt", "ALPHA_SET\tna\tA\n");
        await utimes(file, FIXED_TIME, FIXED_TIME);
        await chmod(root, 0o555);
        try {
            const tool = createTool(root);
            const first = (await tool.execute({ path: "sets" }, makeToolContext().ctx))._unsafeUnwrap();
            expect(first).toMatchObject({ state: "populated", unlooked: 0 });
            expect(presentAt(first.entries, 0)).toMatchObject({ look: { lines: ["ALPHA_SET\tna\tA"] } });
            expect(await stat(join(root, ".inflexa")).catch(() => undefined)).toBeUndefined();

            await writeFile(file, "OMEGA_SET\tna\tA\n");
            await utimes(file, FIXED_TIME, FIXED_TIME);
            const second = (await tool.execute({ path: "sets" }, makeToolContext().ctx))._unsafeUnwrap();
            expect(presentAt(second.entries, 0)).toMatchObject({ look: { lines: ["ALPHA_SET\tna\tA"] } });
        } finally {
            await chmod(root, 0o755);
        }
    });

    it("bounds the new looks of one call, says that the rest matched on their path, and looks at them on the next call", async () => {
        const root = await makeStore("look-bound");
        await Promise.all(Array.from({ length: 250 }, (_, index) => put(root, `sets/${String(index).padStart(3, "0")}.gmt`, `SET_${index}\tna\tGENE\n`)));

        const tool = createTool(root);
        const first = (await tool.execute({ query: "gmt", limit: 1 }, makeToolContext().ctx))._unsafeUnwrap();
        expect(first.unlooked).toBe(50);
        expect(first.content).toContain("50 files have no look yet and matched on their path only.");
        // A file past the bound matches on its path only, thus its content finds nothing yet.
        const unseen = (await tool.execute({ query: "set_249" }, makeToolContext().ctx))._unsafeUnwrap();
        expect(unseen.unlooked).toBe(0);
        expect(unseen.entries.map((entry) => entry.path)).toEqual(["/mnt/refs/sets/249.gmt"]);
    });

    // An omitted path reads the container mountpoint, so the two calls are the same
    // call. Asserting they agree pins the fallback without making the assertion depend
    // on whether the machine running the test happens to have `/mnt/refs`.
    it("falls back to the container mount when no store path is configured", async () => {
        const omitted = (await createTool().execute({}, makeToolContext().ctx))._unsafeUnwrap();
        const explicit = (await createTool("/mnt/refs").execute({}, makeToolContext().ctx))._unsafeUnwrap();
        expect(omitted).toEqual(explicit);
    });

    it("reports a configured-but-missing store as unavailable", async () => {
        const result = (await createTool(join(tmpdir(), "refs-does-not-exist-xyz")).execute({}, makeToolContext().ctx))._unsafeUnwrap();
        expect(result).toMatchObject({ state: "unavailable", available: false, entries: [] });
        expect(result.content).toContain("No reference store is provisioned");
    });

    it("reports an empty store as data", async () => {
        const root = await makeStore("empty");
        const result = (await createTool(root).execute({}, makeToolContext().ctx))._unsafeUnwrap();
        expect(result).toMatchObject({ state: "empty", available: true, entries: [] });
        expect(result.content).toContain("contains no reference files");
    });

    it.each(["../etc", "/etc/passwd", "/mnt/refs/../etc", "user//cohort", ".inflexa/sources.jsonl"])("rejects out-of-scope path %s", async (path) => {
        const root = await makeStore("scope");
        const result = (await createTool(root).execute({ path }, makeToolContext().ctx))._unsafeUnwrap();
        expect(result).toMatchObject({ state: "out_of_scope", available: false });
    });

    it("bounds an oversized zero-entry path rejection", async () => {
        const root = await makeStore("oversized-path");
        const result = (await createTool(root).execute({ path: "a".repeat(70_000) }, makeToolContext().ctx))._unsafeUnwrap();
        expect(result).toMatchObject({ state: "out_of_scope", available: false, path: "/mnt/refs", entries: [] });
        expect(result.content).toContain("4096-byte");
        expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(64_000);
    });

    // A symlink is the one way a store could hand back a file outside itself; it is reported
    // as an opaque symlink and never resolved, so nothing downstream can be pointed off-store.
    it("reports symlinks without following them, and refuses to traverse through one", async () => {
        const root = await makeStore("symlink");
        const outside = await makeStore("outside");
        await writeFile(join(outside, "secret.csv"), "x".repeat(100));
        await mkdir(join(root, "user"), { recursive: true });
        await symlink(outside, join(root, "user", "external"));
        await symlink(join(outside, "secret.csv"), join(root, "user", "linked.csv"));

        const tool = createTool(root);
        const listed = (await tool.execute({ path: "user" }, makeToolContext().ctx))._unsafeUnwrap();
        expect(listed.entries).toEqual([
            { kind: "symlink", path: "/mnt/refs/user/external", bytes: 0 },
            { kind: "symlink", path: "/mnt/refs/user/linked.csv", bytes: 0 },
        ]);

        const through = (await tool.execute({ path: "user/external" }, makeToolContext().ctx))._unsafeUnwrap();
        expect(through.state).toBe("symlink");
        expect(through.entries).toEqual([]);
    });

    // The store metadata directory is never a route out of the store: a symlinked .inflexa gets no cache write.
    it("writes no cache through a symlinked metadata directory", async () => {
        const root = await makeStore("meta-symlink");
        const outside = await makeStore("meta-outside");
        await put(root, "sets/a.gmt", "ALPHA_SET\tna\tA\n");
        await symlink(outside, join(root, ".inflexa"));

        const result = (await createTool(root).execute({ path: "sets" }, makeToolContext().ctx))._unsafeUnwrap();

        expect(presentAt(result.entries, 0)).toMatchObject({ look: { format: "gmt" } });
        expect(await stat(join(outside, "peek-cache.json")).catch(() => undefined)).toBeUndefined();
    });

    it("supports directory drill-down from the root", async () => {
        const root = await makeStore("drill");
        await put(root, "user/cohort/reference.h5ad", "reference");
        await Promise.all(Array.from({ length: 40 }, (_, index) => put(root, `user/cohort/shards/${String(index).padStart(2, "0")}.tsv`, "a\tb\n")));

        const tool = createTool(root);
        const rootResult = (await tool.execute({}, makeToolContext().ctx))._unsafeUnwrap();
        expect(rootResult.entries).toEqual([expect.objectContaining({ path: "/mnt/refs/user", kind: "directory", fileCount: 41 })]);

        const userResult = (await tool.execute({ path: "/mnt/refs/user" }, makeToolContext().ctx))._unsafeUnwrap();
        expect(userResult.entries).toEqual([expect.objectContaining({ path: "/mnt/refs/user/cohort", kind: "directory", fileCount: 41 })]);

        const cohortResult = (await tool.execute({ path: "/mnt/refs/user/cohort" }, makeToolContext().ctx))._unsafeUnwrap();
        expect(cohortResult.entries.map((entry) => [entry.path, entry.kind, entry.bytes])).toEqual([
            ["/mnt/refs/user/cohort/reference.h5ad", "file", 9],
            ["/mnt/refs/user/cohort/shards", "directory", 160],
        ]);
    });

    it("bounds the scan and the final envelope for large subtrees", async () => {
        const root = await makeStore("large");
        await mkdir(join(root, "shards"), { recursive: true });
        for (let start = 0; start < 2_100; start += 200) {
            await Promise.all(
                Array.from({ length: Math.min(200, 2_100 - start) }, (_, offset) => {
                    const index = start + offset;
                    return writeFile(join(root, "shards", `${String(index).padStart(4, "0")}.tsv`), `${"x".repeat(300)}\t${"y".repeat(300)}\n`);
                }),
            );
        }

        const tool = createTool(root);
        const summary = (await tool.execute({}, makeToolContext().ctx))._unsafeUnwrap();
        expect(summary.scannedEntries).toBe(2_000);
        expect(summary.entries).toEqual([expect.objectContaining({ path: "/mnt/refs/shards", kind: "directory", truncated: true, fileCount: 1_999 })]);

        const result = (await tool.execute({ path: "shards" }, makeToolContext().ctx))._unsafeUnwrap();
        expect(result.truncated).toBe(true);
        expect(result.entries.length).toBeLessThanOrEqual(200);
        expect(result.content).toContain("narrower path");
        expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(64_000);
    });

    // Truncation must be stable: a durably-cached step result cannot return a different
    // prefix of the same store on replay.
    it("truncates deterministically", async () => {
        const root = await makeStore("deterministic");
        await mkdir(join(root, "shards"), { recursive: true });
        await Promise.all(Array.from({ length: 300 }, (_, index) => writeFile(join(root, "shards", `${String(index).padStart(4, "0")}.parquet`), "x")));

        const tool = createTool(root);
        const first = (await tool.execute({ path: "shards" }, makeToolContext().ctx))._unsafeUnwrap();
        const second = (await tool.execute({ path: "shards" }, makeToolContext().ctx))._unsafeUnwrap();
        expect(first.entries.map((entry) => entry.path)).toEqual(second.entries.map((entry) => entry.path));
        expect(presentAt(first.entries, 0).path).toBe("/mnt/refs/shards/0000.parquet");
    });
});
