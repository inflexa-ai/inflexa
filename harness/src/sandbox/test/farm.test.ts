import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readFarmLockFile } from "../farm.js";

describe("readFarmLockFile", () => {
    it("reads a lock whose pak_lock holds a non-finite number", async () => {
        // `JSON.stringify` cannot emit Infinity, so the raw text carries `1e999`,
        // which `JSON.parse` reads as Infinity — the population the verbatim
        // pak_lock leaf must accept.
        const dir = await mkdtemp(join(tmpdir(), "farm-lock-"));
        try {
            const lockPath = join(dir, "inflexa.lock");
            await writeFile(
                lockPath,
                `{"schema":1,"arch":"amd64","packages":[],"languages":{"r":{"version":"4.4.1","bioc_releases":["3.21"],"pak_lock":{"trees":{"cell":1e999}}}}}`,
            );

            const lock = readFarmLockFile(lockPath)._unsafeUnwrap();

            expect(lock.languages.r?.pak_lock).toEqual({ trees: { cell: Infinity } });
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("parses a source-built entry with its source, and an index entry without one, at schema 1", async () => {
        const dir = await mkdtemp(join(tmpdir(), "farm-lock-source-"));
        try {
            const lockPath = join(dir, "inflexa.lock");
            await writeFile(
                lockPath,
                JSON.stringify({
                    schema: 1,
                    arch: "amd64",
                    packages: [
                        {
                            name: "SeedMatchR",
                            version: "2.0.0",
                            track: "source",
                            store_dir: "/pool/seedmatchr-2.0.0-1e2b",
                            hash: "a".repeat(64),
                            requested: true,
                            source: {
                                url: "https://github.com/tacazares/SeedMatchR",
                                commit: "2fc0c4f7d2be974cd8fa4f2a55a71c1a63d38b1e",
                                pin: "SeedMatchR==2.0.0@git:2fc0c4f7d2be974cd8fa4f2a55a71c1a63d38b1e",
                            },
                        },
                        {
                            name: "Seurat",
                            version: "5.3.0",
                            track: "cran",
                            store_dir: "/pool/seurat-5.3.0-9c4d",
                            hash: "b".repeat(64),
                            requested: false,
                        },
                        {
                            name: "localpkg",
                            version: "1.0.0",
                            track: "source",
                            store_dir: "/pool/localpkg-1.0.0-77aa",
                            hash: "c".repeat(64),
                            requested: true,
                            source: { treeHash: "9b1deb4d3b7d4bad", pin: "localpkg==1.0.0@tree:9b1deb4d3b7d4bad" },
                        },
                    ],
                    languages: {},
                }),
            );

            const lock = readFarmLockFile(lockPath)._unsafeUnwrap();

            expect(lock.schema).toBe(1);
            expect(lock.packages[0]?.source).toEqual({
                url: "https://github.com/tacazares/SeedMatchR",
                commit: "2fc0c4f7d2be974cd8fa4f2a55a71c1a63d38b1e",
                pin: "SeedMatchR==2.0.0@git:2fc0c4f7d2be974cd8fa4f2a55a71c1a63d38b1e",
            });
            expect(lock.packages[1]?.source).toBeUndefined();
            expect(lock.packages[2]?.source).toEqual({ treeHash: "9b1deb4d3b7d4bad", pin: "localpkg==1.0.0@tree:9b1deb4d3b7d4bad" });
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
