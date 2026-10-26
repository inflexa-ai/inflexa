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
});
