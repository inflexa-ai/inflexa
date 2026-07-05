import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { libStoreMount, libStorePlatform } from "./config.ts";

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

describe("libStorePlatform (docker --platform from the active store's arch)", () => {
    /** Stage `current -> <version>` with the given meta.json body, so libStorePlatform can read it. */
    async function stage(version: string, meta: unknown): Promise<void> {
        await mkdir(join(root, version), { recursive: true });
        await writeFile(join(root, version, "meta.json"), JSON.stringify(meta));
        await symlink(version, join(root, "current"));
    }

    test("maps a valid amd64 store to linux/amd64", async () => {
        await stage("2026.07.04-abc", { version: "2026.07.04-abc", arch: "linux-amd64", tracks: ["python", "conda", "node"] });
        expect(libStorePlatform(root)).toBe("linux/amd64");
    });

    test("maps a valid arm64 store to linux/arm64", async () => {
        await stage("2026.07.04-abc", { version: "2026.07.04-abc", arch: "linux-arm64", tracks: ["python", "conda", "node"] });
        expect(libStorePlatform(root)).toBe("linux/arm64");
    });

    test("returns null when the active version's meta.json is missing", async () => {
        await mkdir(join(root, "2026.07.04-abc"), { recursive: true });
        await symlink("2026.07.04-abc", join(root, "current"));
        expect(libStorePlatform(root)).toBeNull();
    });

    test("returns null for an unknown arch (a foreign/local build)", async () => {
        await stage("2026.07.04-abc", { version: "2026.07.04-abc", arch: "solaris", tracks: ["python"] });
        expect(libStorePlatform(root)).toBeNull();
    });

    test("returns null when no current symlink exists", () => {
        expect(libStorePlatform(root)).toBeNull();
    });
});
