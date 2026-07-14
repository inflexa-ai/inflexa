import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUIDv7 } from "bun";

import { existingRefStoreConfig, existingRefStorePath } from "./runtime.ts";

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("existingRefStorePath", () => {
    test("accepts exactly an existing real directory without creating a missing path", async () => {
        const root = join(tmpdir(), `refs-runtime-${randomUUIDv7()}`);
        const missing = join(root, "missing");
        const directory = join(root, "directory");
        const file = join(root, "file");
        const link = join(root, "link");
        roots.push(root);
        mkdirSync(directory, { recursive: true });
        writeFileSync(file, "not a directory");
        symlinkSync(directory, link);

        expect(existingRefStorePath(directory)).toBe(directory);
        expect(existingRefStoreConfig(directory)).toEqual({ refStorePath: directory });
        expect(existingRefStorePath(file)).toBeUndefined();
        expect(existingRefStorePath(link)).toBeUndefined();
        expect(existingRefStorePath(missing)).toBeUndefined();
        expect(existingRefStoreConfig(missing)).toEqual({});
        expect(await Bun.file(missing).exists()).toBe(false);
    });
});
