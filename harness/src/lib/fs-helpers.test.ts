import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { link } from "node:fs/promises";

import { classifyWithinRoot, writeFileWithinRoot } from "./fs-helpers.js";

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

describe("classifyWithinRoot", () => {
    let root: string;
    let outside: string;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "cwr-root-"));
        outside = await mkdtemp(join(tmpdir(), "cwr-out-"));
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
    });

    it("classifies a real in-tree file as `in`", async () => {
        const p = join(root, "data", "x.csv");
        await mkdir(join(root, "data"), { recursive: true });
        await writeFile(p, "col\n1\n");
        expect(await classifyWithinRoot(root, p)).toBe("in");
    });

    it("classifies a hard-linked input as `in` (realpath does not follow hard links)", async () => {
        const original = join(outside, "user-original.csv");
        await writeFile(original, "secret,data\n");
        const staged = join(root, "data", "inputs", "local", "foo.csv");
        await mkdir(join(root, "data", "inputs", "local"), { recursive: true });
        await link(original, staged); // hard link, mirroring stageFile's linkSync
        expect(await classifyWithinRoot(root, staged)).toBe("in");
    });

    it("classifies a symlink escaping the tree as `escaped`", async () => {
        const victim = join(outside, "victim.txt");
        await writeFile(victim, "secret");
        const planted = join(root, "runs", "r1", "s1", "leak.txt");
        await mkdir(join(root, "runs", "r1", "s1"), { recursive: true });
        await symlink(victim, planted);
        expect(await classifyWithinRoot(root, planted)).toBe("escaped");
    });

    it("classifies a missing path (and a symlink to a missing target) as `absent`", async () => {
        expect(await classifyWithinRoot(root, join(root, "runs", "gone.txt"))).toBe("absent");
        const dangling = join(root, "dangling.txt");
        await symlink(join(outside, "does-not-exist"), dangling);
        expect(await classifyWithinRoot(root, dangling)).toBe("absent");
    });

    it("classifies an in-tree symlink as `in`", async () => {
        const realFile = join(root, "data", "real.csv");
        await mkdir(join(root, "data"), { recursive: true });
        await writeFile(realFile, "ok");
        const inTreeLink = join(root, "runs", "r1", "s1", "alias.csv");
        await mkdir(join(root, "runs", "r1", "s1"), { recursive: true });
        await symlink(realFile, inTreeLink);
        expect(await classifyWithinRoot(root, inTreeLink)).toBe("in");
    });
});
