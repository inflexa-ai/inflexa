import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeFileWithinRoot } from "./fs-helpers.js";

describe("writeFileWithinRoot", () => {
    let root: string;
    let outside: string;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "wfwr-root-"));
        outside = await mkdtemp(join(tmpdir(), "wfwr-out-"));
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
    });

    it("writes a file inside the tree, creating parents", async () => {
        const target = join(root, "runs", "r1", "s1", "output", "summary.md");
        await writeFileWithinRoot(root, target, "hello");
        expect(await readFile(target, "utf8")).toBe("hello");
    });

    it("refuses a lexically out-of-root target", async () => {
        await expect(writeFileWithinRoot(root, join(outside, "x.md"), "nope")).rejects.toThrow(/outside the workspace root/);
    });

    it("refuses to write through a symlinked leaf a step planted", async () => {
        const victim = join(outside, "victim.txt");
        await writeFile(victim, "original");
        const stepOut = join(root, "runs", "r1", "s1", "output");
        await mkdir(stepOut, { recursive: true });
        // The escape a compromised sandbox agent would attempt: output/summary.md -> <outside>/victim.txt
        await symlink(victim, join(stepOut, "summary.md"));

        await expect(writeFileWithinRoot(root, join(stepOut, "summary.md"), "pwned")).rejects.toThrow();
        expect(await readFile(victim, "utf8")).toBe("original");
    });

    it("refuses to write through a symlinked intermediate directory", async () => {
        const evilDir = join(outside, "evil");
        await mkdir(evilDir, { recursive: true });
        const stepDir = join(root, "runs", "r1", "s1");
        await mkdir(stepDir, { recursive: true });
        // output -> <outside>/evil, so output/summary.md would land outside the tree.
        await symlink(evilDir, join(stepDir, "output"));

        await expect(writeFileWithinRoot(root, join(stepDir, "output", "summary.md"), "pwned")).rejects.toThrow(/symlink/);
        await expect(readFile(join(evilDir, "summary.md"), "utf8")).rejects.toThrow();
    });

    it("overwrites an existing real file", async () => {
        const target = join(root, "runs", "r1", "s1", "output", "summary.md");
        await writeFileWithinRoot(root, target, "first");
        await writeFileWithinRoot(root, target, "second");
        expect(await readFile(target, "utf8")).toBe("second");
    });
});
