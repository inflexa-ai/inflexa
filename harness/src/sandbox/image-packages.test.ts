import { describe, expect, it } from "bun:test";

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ImagePackagesSchema, readImagePackagesFile } from "./image-packages.js";

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
