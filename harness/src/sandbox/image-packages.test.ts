import { describe, expect, it } from "bun:test";

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EMPTY_IMAGE_BASE, ImagePackagesSchema, imageBaseOf, readImagePackagesFile, resolvePackage, type PackageSources } from "./image-packages.js";
import { poolIndexOver, pythonIdentity, resolveQuery, rIdentity } from "./package-identity.js";

const RECORD = {
    schema: 1,
    image: { repository: "ghcr.io/inflexa-ai/sandbox-base", version: "20260901-3031713", arch: "amd64" },
    runtimes: { python: "3.12.3", r: "4.6.0", node: "24.8.0" },
    system_tools: [
        { name: "samtools", version: "1.22.1" },
        { name: "eagle2", version: "2.4.1", executable: "eagle" },
    ],
    node: [{ name: "echarts", version: "6.0.0" }],
};

describe("ImagePackagesSchema", () => {
    it("parses a record at schema 1", () => {
        const parsed = ImagePackagesSchema.safeParse(RECORD);
        if (!parsed.success) throw new Error(`expected a valid record: ${parsed.error.message}`);

        expect(parsed.data.image).toMatchObject({ repository: "ghcr.io/inflexa-ai/sandbox-base", version: "20260901-3031713", arch: "amd64" });
        expect(parsed.data.runtimes).toMatchObject({ python: "3.12.3", r: "4.6.0", node: "24.8.0" });
        expect(parsed.data.system_tools).toEqual([
            { name: "samtools", version: "1.22.1" },
            { name: "eagle2", version: "2.4.1", executable: "eagle" },
        ]);
        expect(parsed.data.node).toEqual([{ name: "echarts", version: "6.0.0" }]);
    });

    // The schema number is the break signal: a producer that changed the shape
    // must not be half-read by a reader that predates the change.
    it("refuses a record at an unknown schema number", () => {
        expect(ImagePackagesSchema.safeParse({ ...RECORD, schema: 2 }).success).toBe(false);
    });

    it("passes an additive field through, at the top level and inside an entry", () => {
        const parsed = ImagePackagesSchema.safeParse({
            ...RECORD,
            built_at: "2026-09-01T00:00:00Z",
            system_tools: [{ name: "samtools", version: "1.22.1", channel: "bioconda" }],
        });
        if (!parsed.success) throw new Error(`expected a valid record: ${parsed.error.message}`);

        expect(parsed.data as Record<string, unknown>).toHaveProperty("built_at", "2026-09-01T00:00:00Z");
        expect(parsed.data.system_tools[0] as Record<string, unknown>).toHaveProperty("channel", "bioconda");
    });

    it("parses the base sets of the two runtimes", () => {
        const parsed = ImagePackagesSchema.safeParse({ ...RECORD, r_base: ["grid", "stats"], python_stdlib: ["json", "pickle"] });
        if (!parsed.success) throw new Error(`expected a valid record: ${parsed.error.message}`);

        expect(parsed.data.r_base).toEqual(["grid", "stats"]);
        expect(parsed.data.python_stdlib).toEqual(["json", "pickle"]);
    });

    // A store packed before the two fields carries a record without them, and
    // that record must keep its tools and its node packages.
    it("parses a record without the base sets", () => {
        const parsed = ImagePackagesSchema.safeParse(RECORD);
        if (!parsed.success) throw new Error(`expected a valid record: ${parsed.error.message}`);

        expect(parsed.data.r_base).toBeUndefined();
        expect(parsed.data.python_stdlib).toBeUndefined();
    });

    it("refuses a missing track and an entry with no version", () => {
        expect(ImagePackagesSchema.safeParse({ ...RECORD, node: undefined }).success).toBe(false);
        expect(ImagePackagesSchema.safeParse({ ...RECORD, system_tools: [{ name: "samtools" }] }).success).toBe(false);
    });
});

describe("readImagePackagesFile", () => {
    it("reads and validates a record at its path", async () => {
        const dir = await mkdtemp(join(tmpdir(), "image-packages-"));
        const recordPath = join(dir, "image-packages.json");
        await writeFile(recordPath, JSON.stringify(RECORD));

        const record = readImagePackagesFile(recordPath)._unsafeUnwrap();

        expect(record.image.version).toBe("20260901-3031713");
        expect(record.system_tools.map((t) => t.executable ?? t.name)).toEqual(["samtools", "eagle"]);
    });

    // Absence is the state of every store packed before the record existed.
    it("reports an absent file as record_unreadable, carrying the path", async () => {
        const dir = await mkdtemp(join(tmpdir(), "image-packages-"));
        const recordPath = join(dir, "image-packages.json");

        const error = readImagePackagesFile(recordPath)._unsafeUnwrapErr();

        expect(error.type).toBe("record_unreadable");
        expect(error.recordPath).toBe(recordPath);
    });

    it("reports bytes that are not JSON as record_invalid", async () => {
        const dir = await mkdtemp(join(tmpdir(), "image-packages-"));
        const recordPath = join(dir, "image-packages.json");
        await writeFile(recordPath, "## System tools (CLI)\nsamtools, bcftools\n");

        expect(readImagePackagesFile(recordPath)._unsafeUnwrapErr().type).toBe("record_invalid");
    });

    it("reports JSON at an unknown schema number as record_invalid", async () => {
        const dir = await mkdtemp(join(tmpdir(), "image-packages-"));
        const recordPath = join(dir, "image-packages.json");
        await writeFile(recordPath, JSON.stringify({ ...RECORD, schema: 2 }));

        expect(readImagePackagesFile(recordPath)._unsafeUnwrapErr().type).toBe("record_invalid");
    });
});

describe("imageBaseOf", () => {
    const record = ImagePackagesSchema.parse({ ...RECORD, r_base: ["grDevices", "stats"], python_stdlib: ["json", "pickle"] });

    it("holds a base R package under its track and a standard-library module", () => {
        const { index } = imageBaseOf(record);

        expect(resolveQuery({ spelling: "stats", track: "r" }, index)).toEqual({ kind: "resolved", identity: rIdentity("stats") });
        expect(resolveQuery({ spelling: "json" }, index)).toEqual({ kind: "resolved", identity: pythonIdentity("json") });
    });

    it("suggests the spelling of a base R package, because an R name is case-sensitive", () => {
        expect(resolveQuery({ spelling: "grdevices" }, imageBaseOf(record).index)).toEqual({ kind: "unknown", suggestion: rIdentity("grDevices") });
    });

    it("holds nothing for a record from before the base sets", () => {
        expect(resolveQuery({ spelling: "stats" }, imageBaseOf(ImagePackagesSchema.parse(RECORD)).index)).toEqual({ kind: "unknown" });
    });
});

describe("resolvePackage — the pool first, then the pool and the image", () => {
    const image = imageBaseOf(ImagePackagesSchema.parse({ ...RECORD, r_base: ["grid", "stats"], python_stdlib: ["json", "optparse"] }));
    const sources: PackageSources = {
        pool: poolIndexOver([rIdentity("optparse"), pythonIdentity("igraph"), rIdentity("igraph"), pythonIdentity("scanpy"), rIdentity("Seurat")]),
        image,
    };

    // The R package `optparse` is in the pool, and Python lists `optparse` in
    // its standard library. A peer join makes the bare name ambiguous, and a
    // step that resolved before this rule then refuses.
    it("keeps the answer of the pool when an image name of the other track shares the spelling", () => {
        expect(resolvePackage({ spelling: "optparse" }, sources)).toEqual({ kind: "pool", identity: rIdentity("optparse") });
    });

    it("answers from the image, at the runtime version, for a name that only the image holds", () => {
        expect(resolvePackage({ spelling: "stats", track: "r" }, sources)).toEqual({ kind: "image", identity: rIdentity("stats"), version: "4.6.0" });
        expect(resolvePackage({ spelling: "json" }, sources)).toEqual({ kind: "image", identity: pythonIdentity("json"), version: "3.12.3" });
    });

    it("compares a pin of an image package with the runtime version", () => {
        expect(resolvePackage({ spelling: "stats", track: "r", version: "3.0.0" }, sources)).toEqual({
            kind: "image_version",
            identity: rIdentity("stats"),
            held: "4.6.0",
        });
        expect(resolvePackage({ spelling: "stats", track: "r", version: "4.6.0" }, sources)).toMatchObject({ kind: "image" });
    });

    it("reads no pin of a pool package, because the link pass picks that version", () => {
        expect(resolvePackage({ spelling: "scanpy", version: "0.0.1" }, sources)).toEqual({ kind: "pool", identity: pythonIdentity("scanpy") });
    });

    it("keeps a both-track name of the pool ambiguous, and a name of neither source unknown", () => {
        expect(resolvePackage({ spelling: "igraph" }, sources)).toEqual({ kind: "ambiguous", python: pythonIdentity("igraph"), r: rIdentity("igraph") });
        expect(resolvePackage({ spelling: "sklearn" }, sources)).toEqual({ kind: "unknown" });
        expect(resolvePackage({ spelling: "seurat" }, sources)).toEqual({ kind: "unknown", suggestion: rIdentity("Seurat") });
    });

    it("answers from the pool alone with the empty image base", () => {
        expect(resolvePackage({ spelling: "stats", track: "r" }, { pool: sources.pool, image: EMPTY_IMAGE_BASE })).toEqual({ kind: "unknown" });
    });
});
