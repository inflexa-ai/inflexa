import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUIDv7 } from "bun";
import { createHash } from "node:crypto";

import { freshDb } from "../../test_support/db.ts";
import { insertAnchor, insertAnalysis, insertAnalysisInput } from "../../db/primary_mutation.ts";
import { asStr256 } from "../../lib/types.ts";
import type { Analysis, AnalysisInput } from "../../types/analysis.ts";
import { stageInputs } from "./staging.ts";

function sha256(content: string): string {
    return createHash("sha256").update(content).digest("hex");
}

let testDir: string;
let anchorDir: string;
let targetDir: string;
const anchorId = "anchor-stage-test";
const analysisId = "analysis-stage-test";

const analysis: Analysis = {
    id: analysisId,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    name: asStr256("Staging Test"),
    slug: "staging-test",
    outputDirectory: null,
    anchorId,
    projectId: null,
};

beforeEach(() => {
    freshDb();
    testDir = join(tmpdir(), `staging-test-${randomUUIDv7()}`);
    anchorDir = join(testDir, "data-root");
    targetDir = join(testDir, "staging-target");
    mkdirSync(anchorDir, { recursive: true });
    mkdirSync(targetDir, { recursive: true });

    insertAnchor({ id: anchorId, createdAt: 1, updatedAt: 1, cachedPath: anchorDir, markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
    // resolveAnchor needs a real on-disk marker to confirm the cached path is still valid.
    mkdirSync(join(anchorDir, ".inflexa"), { recursive: true });
    writeFileSync(join(anchorDir, ".inflexa", "id"), JSON.stringify({ schemaVersion: 1, anchorId }, null, 2) + "\n");
    insertAnalysis(analysis)._unsafeUnwrap();
});

afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
});

describe("stageInputs", () => {
    test("stages a single file input with correct hash and structure", async () => {
        const content = "id,value\n1,hello\n2,world\n";
        writeFileSync(join(anchorDir, "data.csv"), content);

        const input: AnalysisInput = { path: "data.csv", isDir: false, analysisId, anchorId };
        insertAnalysisInput(input)._unsafeUnwrap();

        const staged = (await stageInputs(analysisId, targetDir))._unsafeUnwrap();

        expect(staged).toHaveLength(1);
        const s = staged[0]!;
        expect(s.mountName).toBe("local");
        expect(s.key).toBe("data.csv");
        expect(s.fileName).toBe("data.csv");
        expect(s.hash).toBe(sha256(content));
        expect(s.size).toBe(Buffer.byteLength(content));
        expect(s.relativePath).toBe(join("inputs", "local", "data.csv"));

        const stagedPath = join(targetDir, s.relativePath);
        expect(existsSync(stagedPath)).toBe(true);
        expect(readFileSync(stagedPath, "utf-8")).toBe(content);
    });

    test("stages a directory input by walking its subtree", async () => {
        const dirPath = join(anchorDir, "multi");
        mkdirSync(join(dirPath, "sub"), { recursive: true });
        writeFileSync(join(dirPath, "a.txt"), "aaa");
        writeFileSync(join(dirPath, "sub", "b.txt"), "bbb");

        const input: AnalysisInput = { path: "multi", isDir: true, analysisId, anchorId };
        insertAnalysisInput(input)._unsafeUnwrap();

        const staged = (await stageInputs(analysisId, targetDir))._unsafeUnwrap();

        expect(staged).toHaveLength(2);
        const keys = staged.map((s) => s.key).sort();
        expect(keys).toEqual([join("multi", "a.txt"), join("multi", "sub", "b.txt")]);

        for (const s of staged) {
            const stagedPath = join(targetDir, s.relativePath);
            expect(existsSync(stagedPath)).toBe(true);
        }
    });

    test("multiple file inputs produce distinct fileIds", async () => {
        writeFileSync(join(anchorDir, "x.csv"), "x");
        writeFileSync(join(anchorDir, "y.csv"), "y");

        insertAnalysisInput({ path: "x.csv", isDir: false, analysisId, anchorId })._unsafeUnwrap();
        insertAnalysisInput({ path: "y.csv", isDir: false, analysisId, anchorId })._unsafeUnwrap();

        const staged = (await stageInputs(analysisId, targetDir))._unsafeUnwrap();
        expect(staged).toHaveLength(2);

        const ids = new Set(staged.map((s) => s.fileId));
        expect(ids.size).toBe(2);
    });

    test("returns empty manifest when the analysis has no inputs", async () => {
        const staged = (await stageInputs(analysisId, targetDir))._unsafeUnwrap();
        expect(staged).toHaveLength(0);
    });

    test("skips inputs whose anchor cannot be resolved", async () => {
        // Insert a second anchor whose cached path points nowhere and has no on-disk marker.
        const orphanAnchorId = "orphan-anchor";
        insertAnchor({ id: orphanAnchorId, createdAt: 1, updatedAt: 1, cachedPath: "/nonexistent/path", markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
        insertAnalysisInput({ path: "ghost.csv", isDir: false, analysisId, anchorId: orphanAnchorId })._unsafeUnwrap();

        const staged = (await stageInputs(analysisId, targetDir))._unsafeUnwrap();
        expect(staged).toHaveLength(0);
    });

    test("staged file content matches the source", async () => {
        const content = "linked-or-copied";
        writeFileSync(join(anchorDir, "link-test.csv"), content);
        insertAnalysisInput({ path: "link-test.csv", isDir: false, analysisId, anchorId })._unsafeUnwrap();

        const staged = (await stageInputs(analysisId, targetDir))._unsafeUnwrap();
        const stagedPath = join(targetDir, staged[0]!.relativePath);

        expect(readFileSync(stagedPath, "utf-8")).toBe(content);
    });

    test("stages the target of a file symlink inside a directory input", async () => {
        const dirPath = join(anchorDir, "linked");
        mkdirSync(dirPath, { recursive: true });
        writeFileSync(join(dirPath, "real.txt"), "real-content");
        symlinkSync(join(dirPath, "real.txt"), join(dirPath, "alias.txt"));

        insertAnalysisInput({ path: "linked", isDir: true, analysisId, anchorId })._unsafeUnwrap();

        const staged = (await stageInputs(analysisId, targetDir))._unsafeUnwrap();

        const keys = staged.map((s) => s.key).sort();
        expect(keys).toEqual([join("linked", "alias.txt"), join("linked", "real.txt")]);
        expect(readFileSync(join(targetDir, "inputs", "local", "linked", "alias.txt"), "utf-8")).toBe("real-content");
    });

    test("traverses a directory symlink inside a directory input", async () => {
        const dirPath = join(anchorDir, "tree");
        const externalDir = join(testDir, "external");
        mkdirSync(dirPath, { recursive: true });
        mkdirSync(externalDir, { recursive: true });
        writeFileSync(join(externalDir, "inside.txt"), "via-dir-link");
        symlinkSync(externalDir, join(dirPath, "ext"));

        insertAnalysisInput({ path: "tree", isDir: true, analysisId, anchorId })._unsafeUnwrap();

        const staged = (await stageInputs(analysisId, targetDir))._unsafeUnwrap();

        expect(staged.map((s) => s.key)).toEqual([join("tree", "ext", "inside.txt")]);
        expect(readFileSync(join(targetDir, "inputs", "local", "tree", "ext", "inside.txt"), "utf-8")).toBe("via-dir-link");
    });

    test("skips a dangling symlink without failing the walk", async () => {
        const dirPath = join(anchorDir, "partial");
        mkdirSync(dirPath, { recursive: true });
        writeFileSync(join(dirPath, "kept.txt"), "kept");
        symlinkSync(join(dirPath, "deleted-target.txt"), join(dirPath, "broken.txt"));

        insertAnalysisInput({ path: "partial", isDir: true, analysisId, anchorId })._unsafeUnwrap();

        const staged = (await stageInputs(analysisId, targetDir))._unsafeUnwrap();

        expect(staged.map((s) => s.key)).toEqual([join("partial", "kept.txt")]);
    });

    test("re-staging yields identical fileIds and refreshed content", async () => {
        const dirPath = join(anchorDir, "stable");
        mkdirSync(dirPath, { recursive: true });
        writeFileSync(join(dirPath, "member.txt"), "v1");
        writeFileSync(join(anchorDir, "top.csv"), "top");

        insertAnalysisInput({ path: "stable", isDir: true, analysisId, anchorId })._unsafeUnwrap();
        insertAnalysisInput({ path: "top.csv", isDir: false, analysisId, anchorId })._unsafeUnwrap();

        const first = (await stageInputs(analysisId, targetDir))._unsafeUnwrap();
        // Second pass hits existing hardlinked destinations (EEXIST → copy overwrite),
        // exercising the re-staging path rather than a pristine tree.
        writeFileSync(join(dirPath, "member.txt"), "v2");
        const second = (await stageInputs(analysisId, targetDir))._unsafeUnwrap();

        const idsByKey = (list: typeof first) => new Map(list.map((s) => [s.key, s.fileId]));
        expect(idsByKey(second)).toEqual(idsByKey(first));
        expect(readFileSync(join(targetDir, "inputs", "local", "stable", "member.txt"), "utf-8")).toBe("v2");
    });
});
