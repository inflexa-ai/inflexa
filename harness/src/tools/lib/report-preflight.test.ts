import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageReportAssets } from "./report-preflight.js";

let tmp: string;
let analysisRoot: string;
let assetsDirAbs: string;

beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "preflight-"));
    analysisRoot = join(tmp, "analysis");
    assetsDirAbs = join(tmp, "preview-assets");
    await mkdir(analysisRoot, { recursive: true });
});

afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
});

describe("stageReportAssets", () => {
    it("copies a CSV and enriches with kind, size, columns, head rows, row count", async () => {
        await mkdir(join(analysisRoot, "runs/r1/output"), { recursive: true });
        const csv = "gene_id,mean,detect_rate\nGENE1,12.5,0.98\nGENE2,8.2,0.81\nGENE3,4.7,0.55\n";
        await writeFile(join(analysisRoot, "runs/r1/output/genes.csv"), csv);

        const r = await stageReportAssets({
            sources: [{ path: "runs/r1/output/genes.csv" }],
            analysisRoot,
            assetsDirAbs,
        });

        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.staged).toHaveLength(1);
        const a = r.staged[0];
        expect(a.name).toBe("genes.csv");
        expect(a.path).toBe("runs/r1/output/genes.csv");
        expect(a.kind).toBe("csv");
        expect(a.sizeBytes).toBe(Buffer.byteLength(csv));
        expect(a.columns).toEqual(["gene_id", "mean", "detect_rate"]);
        expect(a.headRows).toEqual([
            ["GENE1", "12.5", "0.98"],
            ["GENE2", "8.2", "0.81"],
            ["GENE3", "4.7", "0.55"],
        ]);
        expect(a.rowCount).toBe(3);

        const copied = await readFile(join(assetsDirAbs, "genes.csv"), "utf8");
        expect(copied).toBe(csv);
    });

    it("infers image kind for PNG and skips tabular enrichment", async () => {
        await mkdir(join(analysisRoot, "fig"), { recursive: true });
        await writeFile(join(analysisRoot, "fig/plot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

        const r = await stageReportAssets({
            sources: [{ path: "fig/plot.png" }],
            analysisRoot,
            assetsDirAbs,
        });

        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.staged[0].kind).toBe("image");
        expect(r.staged[0].columns).toBeUndefined();
        expect(r.staged[0].rowCount).toBeUndefined();
    });

    it("infers tsv kind and parses with tab delimiter", async () => {
        await mkdir(join(analysisRoot, "x"), { recursive: true });
        await writeFile(join(analysisRoot, "x/data.tsv"), "a\tb\tc\n1\t2\t3\n");

        const r = await stageReportAssets({
            sources: [{ path: "x/data.tsv" }],
            analysisRoot,
            assetsDirAbs,
        });

        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.staged[0].kind).toBe("tsv");
        expect(r.staged[0].columns).toEqual(["a", "b", "c"]);
        expect(r.staged[0].headRows).toEqual([["1", "2", "3"]]);
        expect(r.staged[0].rowCount).toBe(1);
    });

    it("rejects oversized sources with a clear reason", async () => {
        await mkdir(join(analysisRoot, "big"), { recursive: true });
        const huge = Buffer.alloc(51 * 1024 * 1024, 0x61);
        await writeFile(join(analysisRoot, "big/raw.csv"), huge);

        const r = await stageReportAssets({
            sources: [{ path: "big/raw.csv" }],
            analysisRoot,
            assetsDirAbs,
        });

        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.reason).toMatch(/exceeds 50MB/);
    });

    it("rejects missing sources", async () => {
        const r = await stageReportAssets({
            sources: [{ path: "runs/missing.csv" }],
            analysisRoot,
            assetsDirAbs,
        });

        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.reason).toMatch(/not found/);
    });

    it("rejects path traversal escapes", async () => {
        const r = await stageReportAssets({
            sources: [{ path: "../escape.csv" }],
            analysisRoot,
            assetsDirAbs,
        });

        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.reason).toMatch(/escapes analysis root/);
    });

    it("rejects absolute paths", async () => {
        const r = await stageReportAssets({
            sources: [{ path: "/etc/passwd" }],
            analysisRoot,
            assetsDirAbs,
        });

        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.reason).toMatch(/relative to analysis root/);
    });

    it("supports `as` for renaming the destination", async () => {
        await mkdir(join(analysisRoot, "runs"), { recursive: true });
        await writeFile(join(analysisRoot, "runs/data.csv"), "x,y\n1,2\n");

        const r = await stageReportAssets({
            sources: [{ path: "runs/data.csv", as: "renamed.csv" }],
            analysisRoot,
            assetsDirAbs,
        });

        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.staged[0].name).toBe("renamed.csv");
        const copied = await readFile(join(assetsDirAbs, "renamed.csv"), "utf8");
        expect(copied).toBe("x,y\n1,2\n");
    });

    it("rejects duplicate destination names from different source paths", async () => {
        await mkdir(join(analysisRoot, "a"), { recursive: true });
        await mkdir(join(analysisRoot, "b"), { recursive: true });
        await writeFile(join(analysisRoot, "a/dup.csv"), "x\n");
        await writeFile(join(analysisRoot, "b/dup.csv"), "y\n");

        const r = await stageReportAssets({
            sources: [{ path: "a/dup.csv" }, { path: "b/dup.csv" }],
            analysisRoot,
            assetsDirAbs,
        });

        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.reason).toMatch(/duplicate asset name/);
    });

    it("dedupes identical source paths without erroring", async () => {
        await mkdir(join(analysisRoot, "a"), { recursive: true });
        await writeFile(join(analysisRoot, "a/foo.csv"), "x\n");

        const r = await stageReportAssets({
            sources: [{ path: "a/foo.csv" }, { path: "a/foo.csv" }],
            analysisRoot,
            assetsDirAbs,
        });

        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.staged).toHaveLength(1);
    });

    it("handles a CSV without a trailing newline", async () => {
        await mkdir(join(analysisRoot, "x"), { recursive: true });
        await writeFile(join(analysisRoot, "x/no-nl.csv"), "a,b\n1,2\n3,4");

        const r = await stageReportAssets({
            sources: [{ path: "x/no-nl.csv" }],
            analysisRoot,
            assetsDirAbs,
        });

        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.staged[0].rowCount).toBe(2);
    });

    it("rejects symlinks pointing outside analysisRoot", async () => {
        const outsideFile = join(tmp, "outside-secret.txt");
        await writeFile(outsideFile, "secret");
        await mkdir(join(analysisRoot, "runs/r1/output"), { recursive: true });
        await symlink(outsideFile, join(analysisRoot, "runs/r1/output/exfil.csv"));

        const r = await stageReportAssets({
            sources: [{ path: "runs/r1/output/exfil.csv" }],
            analysisRoot,
            assetsDirAbs,
        });

        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.reason).toMatch(/escapes analysis root via symlink/);
    });

    it("rejects `as` containing a path separator", async () => {
        await mkdir(join(analysisRoot, "runs"), { recursive: true });
        await writeFile(join(analysisRoot, "runs/data.csv"), "x,y\n1,2\n");

        const r = await stageReportAssets({
            sources: [{ path: "runs/data.csv", as: "subdir/renamed.csv" }],
            analysisRoot,
            assetsDirAbs,
        });

        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.reason).toMatch(/flat filename \(no path separators\)/);
    });

    it("rejects directories as sources", async () => {
        await mkdir(join(analysisRoot, "dir"), { recursive: true });

        const r = await stageReportAssets({
            sources: [{ path: "dir" }],
            analysisRoot,
            assetsDirAbs,
        });

        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.reason).toMatch(/not a regular file/);
    });

    it("enriches array-of-objects JSON with columns, head rows, row count", async () => {
        await mkdir(join(analysisRoot, "runs/r1/output"), { recursive: true });
        const rows = [
            { gene_id: "GENE1", mean: 12.5, detect_rate: 0.98 },
            { gene_id: "GENE2", mean: 8.2, detect_rate: 0.81 },
            { gene_id: "GENE3", mean: 4.7, detect_rate: 0.55 },
        ];
        await writeFile(join(analysisRoot, "runs/r1/output/genes.json"), JSON.stringify(rows));

        const r = await stageReportAssets({
            sources: [{ path: "runs/r1/output/genes.json" }],
            analysisRoot,
            assetsDirAbs,
        });

        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const a = r.staged[0];
        expect(a.kind).toBe("json");
        expect(a.columns).toEqual(["gene_id", "mean", "detect_rate"]);
        expect(a.rowCount).toBe(3);
    });
});
