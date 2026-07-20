import { describe, expect, it } from "bun:test";

import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeToolContext } from "../__fixtures__/tool-context.js";
import { createListAvailableRefsTool } from "./list-available-refs.js";

const HASH = "a".repeat(64);

/** A store rooted at an arbitrary host path — the reported paths must still be `/mnt/refs/...`. */
async function makeStore(label: string): Promise<string> {
    return await mkdtemp(join(tmpdir(), `refs-${label}-`));
}

function createTool(refStorePath?: string) {
    return createListAvailableRefsTool(refStorePath === undefined ? {} : { refStorePath });
}

async function writeReceipt(root: string, datasetId: string, datasetVersion: string, artifacts: { path: string; bytes: number }[]): Promise<void> {
    await mkdir(join(root, ".inflexa", "receipts"), { recursive: true });
    await writeFile(
        join(root, ".inflexa", "receipts", `${datasetId}.json`),
        JSON.stringify({
            version: 1,
            datasetId,
            datasetVersion,
            activatedAt: "2026-07-14T10:30:00.000Z",
            artifacts: artifacts.map((artifact) => ({ ...artifact, sha256: HASH })),
        }),
    );
}

/** Stage a managed artifact at the layout the installer produces. */
async function stageManaged(root: string, datasetId: string, version: string, file: string, body: string): Promise<void> {
    const directory = join(root, "managed", datasetId, version);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, file), body);
}

describe("list_available_refs", () => {
    // The whole point of the host-side read: the store lives at an arbitrary host path,
    // but every reported path is the container path the caller will actually open.
    it("reads the host store and reports container paths", async () => {
        const root = await makeStore("host-path");
        await mkdir(join(root, "user", "cohort"), { recursive: true });
        await writeFile(join(root, "user", "cohort", "reference.h5ad"), "reference");

        const result = (await createTool(root).execute({ path: "user/cohort" }, makeToolContext().ctx))._unsafeUnwrap();

        expect(result.entries).toEqual([{ path: "/mnt/refs/user/cohort/reference.h5ad", kind: "file", bytes: 9 }]);
        expect(result.entries[0]!.path.startsWith(root)).toBe(false);
    });

    it("needs no sandbox and discovers manifest-free user files", async () => {
        const root = await makeStore("manifest-free");
        await mkdir(join(root, "user", "cohort"), { recursive: true });
        await writeFile(join(root, "user", "cohort", "reference.h5ad"), "reference");

        const tool = createTool(root);
        const result = (await tool.execute({}, makeToolContext().ctx))._unsafeUnwrap();

        expect(tool.executionMode).not.toBe("workflow");
        expect(result).toMatchObject({ available: true, state: "populated", truncated: false });
        expect(result.entries).toEqual([expect.objectContaining({ path: "/mnt/refs/user", kind: "directory", fileCount: 1, bytes: 9 })]);
        expect(result.entries[0]!.metadata).toBeUndefined();
    });

    it("merges valid receipt and legacy enrichment while retaining user files", async () => {
        const root = await makeStore("enrich");
        await stageManaged(root, "alpha", "2026.07", "reference.parquet", "x".repeat(12));
        await stageManaged(root, "ncbi-gene-human", "current", "Homo_sapiens.gene_info.gz", "x".repeat(15));
        await mkdir(join(root, "legacy"), { recursive: true });
        await writeFile(join(root, "legacy", "pathways.gmt"), "x".repeat(13));
        await mkdir(join(root, "user"), { recursive: true });
        await writeFile(join(root, "user", "custom.csv"), "x".repeat(14));

        await writeReceipt(root, "alpha", "2026.07", [{ path: "reference.parquet", bytes: 999 }]);
        await writeReceipt(root, "ncbi-gene-human", "current", [{ path: "Homo_sapiens.gene_info.gz", bytes: 1_024 }]);
        await writeFile(
            join(root, "registry.json"),
            JSON.stringify({ files: { by_category: { pathways: [{ local_path: "legacy/pathways.gmt", dataset: "legacy-pathways", rows: 200 }] } } }),
        );

        const tool = createTool(root);
        const managed = (await tool.execute({ path: "managed/alpha/2026.07" }, makeToolContext().ctx))._unsafeUnwrap();
        // Receipt for a dataset the catalog does not know: identity only, no provenance labels.
        expect(managed.entries[0]).toMatchObject({ bytes: 12, metadata: { datasetId: "alpha", version: "2026.07" } });
        expect(managed.entries[0]!.metadata?.title).toBeUndefined();

        // Receipt for a catalog dataset: provenance is joined in from the catalog entry.
        const catalogued = (await tool.execute({ path: "managed/ncbi-gene-human/current" }, makeToolContext().ctx))._unsafeUnwrap();
        expect(catalogued.entries[0]).toMatchObject({
            bytes: 15,
            metadata: {
                datasetId: "ncbi-gene-human",
                version: "current",
                title: "NCBI human gene identifiers",
                sourceUrl: "https://ftp.ncbi.nlm.nih.gov/gene/DATA/GENE_INFO/Mammalia/",
                license: "https://www.ncbi.nlm.nih.gov/home/about/policies/",
            },
        });

        const legacy = (await tool.execute({ path: "legacy" }, makeToolContext().ctx))._unsafeUnwrap();
        expect(legacy.entries[0]).toMatchObject({ bytes: 13, metadata: { datasetId: "legacy-pathways", category: "pathways", rows: 200 } });

        const user = (await tool.execute({ path: "user" }, makeToolContext().ctx))._unsafeUnwrap();
        expect(user.entries[0]).toEqual({ path: "/mnt/refs/user/custom.csv", kind: "file", bytes: 14 });
    });

    // Skills name no reference paths, so an agent finds a file by describing what it needs. That
    // only works if the searchable text and the rendered answer both carry meaning, not just paths.
    it("resolves a catalogued file by what it holds and renders how to read it", async () => {
        const root = await makeStore("by-meaning");
        await stageManaged(root, "collectri-human", "2.0", "CollecTRI_regulons.csv", "x".repeat(4_096));
        await stageManaged(root, "msigdb-hallmark-mouse", "2026.1", "mh.all.v2026.1.Mm.symbols.gmt", "x".repeat(2_048));
        await writeReceipt(root, "collectri-human", "2.0", [{ path: "CollecTRI_regulons.csv", bytes: 4_096 }]);
        await writeReceipt(root, "msigdb-hallmark-mouse", "2026.1", [{ path: "mh.all.v2026.1.Mm.symbols.gmt", bytes: 2_048 }]);

        const tool = createTool(root);
        // "regulon" appears in neither filename; it is only in the catalog's contents description.
        const byMeaning = (await tool.execute({ path: "managed/collectri-human/2.0", query: "regulon" }, makeToolContext().ctx))._unsafeUnwrap();
        expect(byMeaning.entries).toHaveLength(1);
        expect(byMeaning.entries[0]!.path).toBe("/mnt/refs/managed/collectri-human/2.0/CollecTRI_regulons.csv");
        expect(byMeaning.entries[0]!.metadata).toMatchObject({ organism: "human", format: "csv", category: "regulatory-networks" });
        // The reader and the column shape must reach the model, not just sit in structured metadata.
        expect(byMeaning.content).toContain("csv — TF-target regulons");
        expect(byMeaning.content).toContain("source (TF symbol)");

        // Organism is a first-class filter, so a mouse analysis cannot silently pick up human data.
        const byOrganism = (await tool.execute({ path: "managed/msigdb-hallmark-mouse/2026.1", query: "mouse" }, makeToolContext().ctx))._unsafeUnwrap();
        expect(byOrganism.entries.map((entry) => entry.metadata?.datasetId)).toEqual(["msigdb-hallmark-mouse"]);
    });

    // The defect this pins: a dataset's labels are joined onto its artifact deep under
    // `managed/{id}/{version}/`, so a root listing sees only the `managed` DIRECTORY,
    // which carries none. Searching by meaning from the root — the tool's advertised
    // primary workflow, and the whole point of describing artifacts — found nothing.
    it("finds a file by meaning from the store root, not just from its own directory", async () => {
        const root = await makeStore("root-search");
        await stageManaged(root, "collectri-human", "2.0", "CollecTRI_regulons.csv", "source,target");
        await writeReceipt(root, "collectri-human", "2.0", [{ path: "CollecTRI_regulons.csv", bytes: 13 }]);

        // No `path` — the caller does not know the layout, which is the premise.
        const result = (await createTool(root).execute({ query: "regulon" }, makeToolContext().ctx))._unsafeUnwrap();

        expect(result.entries).toHaveLength(1);
        expect(result.entries[0]!.path).toBe("/mnt/refs/managed/collectri-human/2.0/CollecTRI_regulons.csv");
        expect(result.entries[0]!.metadata).toMatchObject({ organism: "human", format: "csv" });
    });

    // Browsing must stay a directory summary — a recursive dump of every file is what
    // the bounding exists to prevent.
    it("browses one level when no query is given, summarizing directories", async () => {
        const root = await makeStore("browse");
        await stageManaged(root, "collectri-human", "2.0", "CollecTRI_regulons.csv", "source,target");

        const result = (await createTool(root).execute({}, makeToolContext().ctx))._unsafeUnwrap();

        expect(result.entries).toEqual([expect.objectContaining({ path: "/mnt/refs/managed", kind: "directory", fileCount: 1 })]);
    });

    it("ignores invalid and stale metadata without hiding observed files", async () => {
        const root = await makeStore("stale");
        await mkdir(join(root, "user"), { recursive: true });
        await writeFile(join(root, "user", "observed.csv"), "x".repeat(7));
        await mkdir(join(root, ".inflexa", "receipts"), { recursive: true });
        await writeFile(join(root, ".inflexa", "receipts", "bad.json"), JSON.stringify({ version: 99, datasetId: "bad" }));
        await writeFile(join(root, "registry.json"), JSON.stringify({ files: { by_category: { stale: [{ local_path: "missing.csv" }] } } }));

        const result = (await createTool(root).execute({ path: "user" }, makeToolContext().ctx))._unsafeUnwrap();
        expect(result.entries).toEqual([{ path: "/mnt/refs/user/observed.csv", kind: "file", bytes: 7 }]);
    });

    it("reports an unprovisioned store as data, not an error", async () => {
        const result = (await createTool().execute({}, makeToolContext().ctx))._unsafeUnwrap();
        expect(result).toMatchObject({ state: "unavailable", available: false, entries: [] });
        expect(result.content).toContain("No reference store is provisioned");
    });

    it("reports a configured-but-missing store as unavailable", async () => {
        const result = (await createTool(join(tmpdir(), "refs-does-not-exist-xyz")).execute({}, makeToolContext().ctx))._unsafeUnwrap();
        expect(result).toMatchObject({ state: "unavailable", available: false, entries: [] });
    });

    it("reports an empty store as data", async () => {
        const root = await makeStore("empty");
        const result = (await createTool(root).execute({}, makeToolContext().ctx))._unsafeUnwrap();
        expect(result).toMatchObject({ state: "empty", available: true, entries: [] });
        expect(result.content).toContain("contains no reference files");
    });

    it.each(["../etc", "/etc/passwd", "/mnt/refs/../etc", "user//cohort", ".inflexa/receipts"])("rejects out-of-scope path %s", async (path) => {
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

        const tool = createTool(root);
        const listed = (await tool.execute({ path: "user" }, makeToolContext().ctx))._unsafeUnwrap();
        expect(listed.entries[0]).toMatchObject({ kind: "symlink", path: "/mnt/refs/user/external", bytes: 0 });

        const through = (await tool.execute({ path: "user/external" }, makeToolContext().ctx))._unsafeUnwrap();
        expect(through.state).toBe("symlink");
        expect(through.entries).toEqual([]);
    });

    // Installer metadata is never reference data: a symlinked .inflexa or registry.json must not
    // become a route out of the store.
    it("does not read installer metadata through a symlink", async () => {
        const root = await makeStore("meta-symlink");
        const outside = await makeStore("meta-outside");
        await mkdir(join(outside, "receipts"), { recursive: true });
        await writeReceipt(outside, "collectri-human", "2.0", [{ path: "CollecTRI_regulons.csv", bytes: 4_096 }]);
        await writeFile(join(outside, "registry.json"), JSON.stringify({ files: { by_category: { fake: [{ local_path: "user/x.csv" }] } } }));
        await stageManaged(root, "collectri-human", "2.0", "CollecTRI_regulons.csv", "x".repeat(4_096));
        await symlink(join(outside, ".inflexa"), join(root, ".inflexa"));
        await symlink(join(outside, "registry.json"), join(root, "registry.json"));

        const result = (await createTool(root).execute({ path: "managed/collectri-human/2.0" }, makeToolContext().ctx))._unsafeUnwrap();
        expect(result.entries[0]!.metadata).toBeUndefined();
    });

    it("supports directory drill-down from the root", async () => {
        const root = await makeStore("drill");
        await mkdir(join(root, "user", "cohort"), { recursive: true });
        await writeFile(join(root, "user", "cohort", "reference.h5ad"), "reference");

        const tool = createTool(root);
        const rootResult = (await tool.execute({}, makeToolContext().ctx))._unsafeUnwrap();
        expect(rootResult.entries).toEqual([expect.objectContaining({ path: "/mnt/refs/user", kind: "directory", fileCount: 1, bytes: 9 })]);

        const userResult = (await tool.execute({ path: "/mnt/refs/user" }, makeToolContext().ctx))._unsafeUnwrap();
        expect(userResult.entries).toEqual([expect.objectContaining({ path: "/mnt/refs/user/cohort", kind: "directory", fileCount: 1 })]);

        const cohortResult = (await tool.execute({ path: "/mnt/refs/user/cohort" }, makeToolContext().ctx))._unsafeUnwrap();
        expect(cohortResult.entries).toEqual([{ path: "/mnt/refs/user/cohort/reference.h5ad", kind: "file", bytes: 9 }]);
    });

    // A single unparseable receipt used to abort the scan loop, silently dropping every receipt
    // that sorted after it — so one corrupt file stripped the labels off datasets that were fine.
    it("keeps enriching from the receipts that parse when one of them is corrupt", async () => {
        const root = await makeStore("bad-receipt");
        await stageManaged(root, "wikipathways-human", "2026.07.10", "wikipathways_Homo_sapiens.gmt", "pathway\tdescription\tGENE");
        await writeReceipt(root, "wikipathways-human", "2026.07.10", [{ path: "wikipathways_Homo_sapiens.gmt", bytes: 31 }]);
        // "aaa" sorts before "wikipathways", so a loop that dies on the bad file never reaches the good one.
        await writeFile(join(root, ".inflexa", "receipts", "aaa-corrupt.json"), "{ not json");

        const result = (await createTool(root).execute({ path: "managed/wikipathways-human/2026.07.10" }, makeToolContext().ctx))._unsafeUnwrap();

        expect(result.state).toBe("populated");
        expect(result.entries[0]).toMatchObject({
            path: "/mnt/refs/managed/wikipathways-human/2026.07.10/wikipathways_Homo_sapiens.gmt",
            kind: "file",
            metadata: { datasetId: "wikipathways-human", title: "WikiPathways human pathways" },
        });
    });

    it("bounds the scan and the final envelope for large subtrees and metadata", async () => {
        const root = await makeStore("large");
        await mkdir(join(root, "shards"), { recursive: true });
        for (let start = 0; start < 2_100; start += 200) {
            await Promise.all(
                Array.from({ length: Math.min(200, 2_100 - start) }, (_, offset) => {
                    const index = start + offset;
                    return writeFile(join(root, "shards", `${String(index).padStart(4, "0")}.parquet`), "x");
                }),
            );
        }
        const huge = "x".repeat(500);
        await writeFile(
            join(root, "registry.json"),
            JSON.stringify({
                files: {
                    by_category: {
                        huge: Array.from({ length: 200 }, (_, index) => ({ local_path: `shards/${String(index).padStart(4, "0")}.parquet`, dataset: huge })),
                    },
                },
            }),
        );

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
        expect(first.entries[0]!.path).toBe("/mnt/refs/shards/0000.parquet");
    });
});
