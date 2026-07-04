import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { libStoreMount } from "./config.ts";

let root: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "libmount-"));
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

describe("libStoreMount (coupling guard)", () => {
    test("leaves the mount unset when no current pointer exists", () => {
        expect(libStoreMount(root)).toBeNull();
    });

    test("returns the store root once current is a symlink to an existing version", async () => {
        await mkdir(join(root, "2026.07.04-abc"), { recursive: true });
        await symlink("2026.07.04-abc", join(root, "current"));
        expect(libStoreMount(root)).toBe(root);
    });

    // finding 4b: existsSync FOLLOWS links, so a real-dir or out-of-root `current` used to
    // pass the guard while readActive says "no store". The predicate now mirrors readActive.
    test("leaves the mount unset when current is a real directory (deref restore)", async () => {
        await mkdir(join(root, "current"), { recursive: true });
        expect(libStoreMount(root)).toBeNull();
    });

    test("leaves the mount unset when current is a dangling symlink", async () => {
        await symlink("2026.07.04-gone", join(root, "current")); // target does not exist
        expect(libStoreMount(root)).toBeNull();
    });
});
