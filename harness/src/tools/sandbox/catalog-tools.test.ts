import { describe, expect, it } from "bun:test";

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeToolContext } from "../__fixtures__/tool-context.js";
import { createListAvailablePackagesTool, queryPackages, type Section } from "./list-available-packages.js";

// The shape every source is normalized into before `queryPackages` sees it:
// one section per language track, each holding the canonical package names.
const SECTIONS: Section[] = [
    { title: "R (CRAN)", packages: [{ name: "Seurat" }, { name: "dplyr" }, { name: "ggplot2" }] },
    { title: "R (Bioconductor)", packages: [{ name: "DESeq2" }, { name: "edgeR" }, { name: "limma" }] },
    { title: "Python (pip)", packages: [{ name: "anndata" }, { name: "scanpy" }, { name: "pydeseq2" }] },
    { title: "System tools (CLI)", packages: [{ name: "bcftools" }, { name: "samtools" }] },
    { title: "Node (npm)", packages: [{ name: "typescript" }] },
];

describe("queryPackages — names (presence check)", () => {
    it("reports present/absent plus the language track, without returning the catalog", () => {
        const result = queryPackages(SECTIONS, { names: ["Seurat", "scanpy", "monocle3"] });
        if (!result.available || !("checked" in result)) throw new Error("expected a checked result");

        expect(result.checked).toEqual([
            { requested: "Seurat", present: true, name: "Seurat", section: "R (CRAN)" },
            { requested: "scanpy", present: true, name: "scanpy", section: "Python (pip)" },
            { requested: "monocle3", present: false },
        ]);
        // The whole point: a presence check does not carry the package listing.
        expect(result).not.toHaveProperty("content");
    });

    it("matches case-insensitively but echoes the catalog's canonical spelling", () => {
        const result = queryPackages(SECTIONS, { names: ["seurat", "DESEQ2"] });
        if (!result.available || !("checked" in result)) throw new Error("expected a checked result");

        // R names are case-sensitive at `library()` — the caller needs the exact one.
        expect(result.checked).toEqual([
            { requested: "seurat", present: true, name: "Seurat", section: "R (CRAN)" },
            { requested: "DESEQ2", present: true, name: "DESeq2", section: "R (Bioconductor)" },
        ]);
    });
});

describe("queryPackages — the two tracks of one name", () => {
    // One spelling in both tracks: a plan entry of `igraph` cannot say which
    // package it means, thus the census must answer both and mark the rows.
    const BOTH_TRACKS: Section[] = [
        {
            title: "Python (pip)",
            packages: [
                { name: "igraph", version: "1.0.0" },
                { name: "decoupler", version: "2.2.0" },
            ],
        },
        { title: "R (CRAN)", packages: [{ name: "igraph", version: "2.1.4" }] },
        { title: "R (Bioconductor)", packages: [{ name: "decoupleR", version: "2.17.0" }] },
    ];

    it("a both-track name answers once for each track", () => {
        const result = queryPackages(BOTH_TRACKS, { names: ["igraph"] });
        if (!result.available || !("checked" in result)) throw new Error("expected a checked result");

        expect(result.checked).toEqual([
            { requested: "igraph", present: true, name: "igraph", section: "Python (pip)", version: "1.0.0" },
            { requested: "igraph", present: true, name: "igraph", section: "R (CRAN)", version: "2.1.4" },
        ]);
    });

    it("a two-spelling pair answers with both spellings", () => {
        const result = queryPackages(BOTH_TRACKS, { names: ["decoupler"] });
        if (!result.available || !("checked" in result)) throw new Error("expected a checked result");

        expect(result.checked).toEqual([
            { requested: "decoupler", present: true, name: "decoupler", section: "Python (pip)", version: "2.2.0" },
            { requested: "decoupler", present: true, name: "decoupleR", section: "R (Bioconductor)", version: "2.17.0" },
        ]);
    });

    it("the listing marks a both-track name, and no other row", () => {
        const result = queryPackages(BOTH_TRACKS, {});
        if (!result.available || !("total" in result)) throw new Error("expected a listing result");

        expect(result.content).toContain("igraph==1.0.0 [both tracks — write python:igraph or r:igraph]");
        expect(result.content).toContain("igraph==2.1.4 [both tracks — write python:igraph or r:igraph]");
        // A two-spelling pair settles itself, thus neither row carries a mark.
        expect(result.content).toContain("decoupler==2.2.0");
        expect(result.content).toContain("decoupleR==2.17.0");
        expect(result.content.match(/both tracks/g)).toHaveLength(2);
    });
});

describe("queryPackages — listing", () => {
    it("bounds a no-arg call and reports truthful total/hasMore", () => {
        const result = queryPackages(SECTIONS, { limit: 4 });
        if (!result.available || !("total" in result)) throw new Error("expected a listing result");

        expect(result.total).toBe(12);
        expect(result.returned).toBe(4);
        expect(result.hasMore).toBe(true);
        expect(result.content).toContain("Seurat, dplyr, ggplot2");
        // Truncation is stated, not silent.
        expect(result.content).toContain("more");
    });

    it("returns everything with hasMore=false when the limit is not reached", () => {
        const result = queryPackages(SECTIONS, {});
        if (!result.available || !("total" in result)) throw new Error("expected a listing result");

        expect(result.total).toBe(12);
        expect(result.returned).toBe(12);
        expect(result.hasMore).toBe(false);
    });

    it("filters by language track", () => {
        const result = queryPackages(SECTIONS, { language: "r" });
        if (!result.available || !("total" in result)) throw new Error("expected a listing result");

        // The R triple only: CRAN + Bioconductor (+ GitHub when present).
        expect(result.total).toBe(6);
        expect(result.content).toContain("R (CRAN)");
        expect(result.content).toContain("R (Bioconductor)");
        expect(result.content).not.toContain("Python (pip)");
    });

    it("filters by case-insensitive substring query", () => {
        const result = queryPackages(SECTIONS, { query: "seq" });
        if (!result.available || !("total" in result)) throw new Error("expected a listing result");

        // DESeq2 + pydeseq2.
        expect(result.total).toBe(2);
        expect(result.content).toContain("DESeq2");
        expect(result.content).toContain("pydeseq2");
    });

    it("reports an empty match honestly rather than dumping the catalog", () => {
        const result = queryPackages(SECTIONS, { query: "nosuchpackage" });
        if (!result.available || !("total" in result)) throw new Error("expected a listing result");

        expect(result.total).toBe(0);
        expect(result.hasMore).toBe(false);
        expect(result.content).toContain("No packages match");
    });
});

// The tool's own read path had no coverage, which is how it stayed broken on hosts
// that never mount the farm at the sandbox's path: the read fails, the result is a
// data variant rather than an error, and nothing surfaces it.
describe("list_available_packages — reading the inventory", () => {
    const LOCK = {
        schema: 1,
        arch: "arm64",
        packages: [
            { name: "Seurat", version: "5.1.0", track: "cran", store_dir: "seurat-5.1.0-abcd1234abcd1234", hash: "a".repeat(64), requested: true },
            { name: "scanpy", version: "1.10.0", track: "python", store_dir: "scanpy-1.10.0-abcd1234abcd1234", hash: "b".repeat(64), requested: true },
        ],
        languages: {},
    };

    const IMAGE_RECORD = {
        schema: 1,
        image: { repository: "ghcr.io/inflexa-ai/sandbox-base", version: "20260901-3031713", arch: "amd64" },
        runtimes: { python: "3.12.3", r: "4.6.0", node: "24.8.0" },
        system_tools: [
            { name: "samtools", version: "1.22.1" },
            { name: "eagle2", version: "2.4.1", executable: "eagle" },
        ],
        node: [{ name: "echarts", version: "6.0.0" }],
    };

    /** A temp store root holding the farm lock, and the record bytes when the case wants one. */
    async function makeStore(recordBytes?: string): Promise<{ farmLockFile: string; imagePackagesFile: string }> {
        const dir = await mkdtemp(join(tmpdir(), "packages-"));
        const farmLockFile = join(dir, "inflexa.lock");
        const imagePackagesFile = join(dir, "image-packages.json");
        await writeFile(farmLockFile, JSON.stringify(LOCK));
        if (recordBytes !== undefined) await writeFile(imagePackagesFile, recordBytes);
        return { farmLockFile, imagePackagesFile };
    }

    it("reads the inflexa.lock at the injected host path rather than assuming the container's", async () => {
        const { farmLockFile } = await makeStore();

        const result = (
            await createListAvailablePackagesTool({ farmLockFile }).execute({ names: ["Seurat", "nonesuch"] }, makeToolContext().ctx)
        )._unsafeUnwrap() as { available: true; checked: { requested: string; present: boolean }[] };

        expect(result.available).toBe(true);
        // The lock records the store identity, thus the targeted check carries it.
        expect(result.checked).toEqual([
            {
                requested: "Seurat",
                present: true,
                name: "Seurat",
                section: "R (CRAN)",
                version: "5.1.0",
                storeDir: "seurat-5.1.0-abcd1234abcd1234",
                hash: "a".repeat(64),
            },
            { requested: "nonesuch", present: false },
        ]);
    });

    it("merges the image record into the report, with a version on each row", async () => {
        const deps = await makeStore(JSON.stringify(IMAGE_RECORD));

        const result = (await createListAvailablePackagesTool(deps).execute({}, makeToolContext().ctx))._unsafeUnwrap() as {
            available: true;
            total: number;
            content: string;
        };

        expect(result.available).toBe(true);
        // 2 farm packages + 2 image tools + 1 image node package.
        expect(result.total).toBe(5);
        expect(result.content).toContain("Python (pip)");
        expect(result.content).toContain("System tools (CLI)");
        expect(result.content).toContain("samtools==1.22.1");
        expect(result.content).toContain("Node (npm)");
        expect(result.content).toContain("echarts==6.0.0");
    });

    it("answers the cli language filter with the image tools alone", async () => {
        const deps = await makeStore(JSON.stringify(IMAGE_RECORD));

        const result = (await createListAvailablePackagesTool(deps).execute({ language: "cli" }, makeToolContext().ctx))._unsafeUnwrap() as {
            available: true;
            total: number;
            content: string;
        };

        expect(result.total).toBe(2);
        expect(result.content).toContain("samtools==1.22.1");
        expect(result.content).not.toContain("echarts");
        expect(result.content).not.toContain("Node (npm)");
    });

    it("answers the node language filter with the image packages alone", async () => {
        const deps = await makeStore(JSON.stringify(IMAGE_RECORD));

        const result = (await createListAvailablePackagesTool(deps).execute({ language: "node" }, makeToolContext().ctx))._unsafeUnwrap() as {
            available: true;
            total: number;
            content: string;
        };

        expect(result.total).toBe(1);
        expect(result.content).toContain("Node (npm)");
        expect(result.content).toContain("echarts==6.0.0");
        expect(result.content).not.toContain("System tools (CLI)");
    });

    // An agent invokes the binary, not the conda package that carries it.
    it("finds a tool by its executable name when the package name differs", async () => {
        const deps = await makeStore(JSON.stringify(IMAGE_RECORD));

        const result = (await createListAvailablePackagesTool(deps).execute({ names: ["eagle", "eagle2"] }, makeToolContext().ctx))._unsafeUnwrap() as {
            available: true;
            checked: { requested: string; present: boolean }[];
        };

        expect(result.checked).toEqual([
            { requested: "eagle", present: true, name: "eagle", section: "System tools (CLI)", version: "2.4.1" },
            // The conda package name is not what the report carries.
            { requested: "eagle2", present: false },
        ]);
    });

    // The farm is the authority on what a step imports; the record is an enrichment.
    it("keeps the farm entry when a record entry collides on a name", async () => {
        const dir = await mkdtemp(join(tmpdir(), "packages-"));
        const farmLockFile = join(dir, "inflexa.lock");
        const imagePackagesFile = join(dir, "image-packages.json");
        await writeFile(
            farmLockFile,
            JSON.stringify({
                ...LOCK,
                packages: [
                    { name: "echarts", version: "5.4.0", track: "node", store_dir: "echarts-5.4.0-abcd1234abcd1234", hash: "c".repeat(64), requested: true },
                ],
            }),
        );
        await writeFile(imagePackagesFile, JSON.stringify(IMAGE_RECORD));

        const result = (
            await createListAvailablePackagesTool({ farmLockFile, imagePackagesFile }).execute({ names: ["echarts"] }, makeToolContext().ctx)
        )._unsafeUnwrap() as { available: true; checked: { version?: string; storeDir?: string }[] };

        expect(result.checked[0]).toMatchObject({ present: true, name: "echarts", version: "5.4.0", storeDir: "echarts-5.4.0-abcd1234abcd1234" });
    });

    // A track that two sources carry renders as one heading, under the same first-writer rule as the check.
    it("folds a track that the farm and the record both carry into one heading", async () => {
        const dir = await mkdtemp(join(tmpdir(), "packages-"));
        const farmLockFile = join(dir, "inflexa.lock");
        const imagePackagesFile = join(dir, "image-packages.json");
        await writeFile(
            farmLockFile,
            JSON.stringify({
                ...LOCK,
                packages: [
                    { name: "echarts", version: "5.4.0", track: "node", store_dir: "echarts-5.4.0-abcd1234abcd1234", hash: "c".repeat(64), requested: true },
                    { name: "d3", version: "7.9.0", track: "node", store_dir: "d3-7.9.0-abcd1234abcd1234", hash: "d".repeat(64), requested: true },
                ],
            }),
        );
        await writeFile(imagePackagesFile, JSON.stringify(IMAGE_RECORD));

        const result = (
            await createListAvailablePackagesTool({ farmLockFile, imagePackagesFile }).execute({ language: "node" }, makeToolContext().ctx)
        )._unsafeUnwrap() as { available: true; total: number; content: string };

        expect(result.total).toBe(2);
        expect(result.content.match(/## Node \(npm\)/g)).toHaveLength(1);
        expect(result.content).toContain("echarts==5.4.0");
        expect(result.content).toContain("d3==7.9.0");
        expect(result.content).not.toContain("echarts==6.0.0");
    });

    it("a bound pool reader wins over the farm lock, and the listing renders name==version", async () => {
        const readPoolInventory = async () =>
            ({
                kind: "sections",
                sections: [
                    {
                        title: "Python (pip)",
                        packages: [{ name: "scipy", version: "1.16.3", storeDir: "scipy-1.16.3-ffff0000ffff0000", hash: "b".repeat(64) }],
                    },
                ],
            }) as const;
        // No farmLockFile: with a pool reader, the lock must not even be tried.
        const tool = createListAvailablePackagesTool({ readPoolInventory });

        const listing = (await tool.execute({}, makeToolContext().ctx))._unsafeUnwrap() as { available: true; content: string };
        expect(listing.content).toContain("scipy==1.16.3");

        const checked = (await tool.execute({ names: ["SCIPY"] }, makeToolContext().ctx))._unsafeUnwrap() as {
            available: true;
            checked: { present: boolean; version?: string; storeDir?: string }[];
        };
        expect(checked.checked[0]).toMatchObject({ present: true, name: "scipy", version: "1.16.3", storeDir: "scipy-1.16.3-ffff0000ffff0000" });
    });

    it("an unreadable pool reads as UNKNOWN with its reason, never as empty", async () => {
        const tool = createListAvailablePackagesTool({
            readPoolInventory: async () => ({ kind: "unavailable", reason: "the dependency graph names 1 edge(s) that it does not hold" }) as const,
        });

        const result = (await tool.execute({}, makeToolContext().ctx))._unsafeUnwrap() as { available: false; content: string };

        expect(result.available).toBe(false);
        expect(result.content).toContain("UNKNOWN");
        // The reason rides in the note: a structural fault must not read as a
        // transient flake, and only the cause tells the two apart.
        expect(result.content).toContain("the dependency graph names 1 edge(s)");
    });

    // A store packed before the record existed carries none. That is the state
    // of every host today, and it must degrade to the farm tracks alone.
    it("still reports the farm inventory when no image record is readable", async () => {
        const { farmLockFile, imagePackagesFile } = await makeStore();

        const result = (await createListAvailablePackagesTool({ farmLockFile, imagePackagesFile }).execute({}, makeToolContext().ctx))._unsafeUnwrap() as {
            available: true;
            total: number;
            content: string;
        };

        expect(result.available).toBe(true);
        expect(result.total).toBe(2);
        expect(result.content).not.toContain("System tools (CLI)");
    });

    it("still reports the farm inventory when the image record is invalid", async () => {
        for (const bytes of ["## System tools (CLI)\nsamtools, bcftools\n", JSON.stringify({ ...IMAGE_RECORD, schema: 2 })]) {
            const deps = await makeStore(bytes);

            const result = (await createListAvailablePackagesTool(deps).execute({}, makeToolContext().ctx))._unsafeUnwrap() as {
                available: true;
                total: number;
                content: string;
            };

            expect(result.available).toBe(true);
            expect(result.total).toBe(2);
            expect(result.content).not.toContain("samtools");
        }
    });

    // Naming packages in this state is worse than silence: the agent cannot verify any
    // of them, and a generous guess is exactly what produces a confident bad import.
    it("reports the package set as UNKNOWN when the inventory cannot be read, naming no packages", async () => {
        const missing = join(tmpdir(), "packages-does-not-exist-xyz", "inflexa.lock");
        const result = (await createListAvailablePackagesTool({ farmLockFile: missing }).execute({}, makeToolContext().ctx))._unsafeUnwrap() as {
            available: false;
            content: string;
        };

        expect(result.available).toBe(false);
        expect(result.content).toContain("UNKNOWN");
        expect(result.content).toMatch(/probe/i);
        for (const name of ["numpy", "pandas", "scanpy", "DESeq2"]) expect(result.content).not.toContain(name);
    });
});

// The shipped store is ~270 packages. A default that truncates it renders a partial
// list that reads as complete, which is how an agent concludes a package is absent
// when it was only unrendered. The default must return a real-sized store whole.
describe("queryPackages — a real-sized store is not truncated by default", () => {
    it("returns every package with hasMore=false at a catalog-scale size", () => {
        const sections: Section[] = [
            { title: "Python (pip)", packages: Array.from({ length: 180 }, (_, i) => ({ name: `pkg-python-${i}` })) },
            { title: "R (CRAN)", packages: Array.from({ length: 120 }, (_, i) => ({ name: `pkg-r-${i}` })) },
        ];

        const result = queryPackages(sections, {}) as { available: true; total: number; returned: number; hasMore: boolean; content: string };

        expect(result.total).toBe(300);
        expect(result.returned).toBe(300);
        expect(result.hasMore).toBe(false);
        expect(result.content).not.toContain("not shown");
        expect(result.content).toContain("pkg-r-119");
    });
});
