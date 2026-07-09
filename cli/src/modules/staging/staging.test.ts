import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, utimesSync, chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUIDv7 } from "bun";
import { createHash } from "node:crypto";

import { freshDb } from "../../test_support/db.ts";
import { insertAnchor, insertAnalysis, insertAnalysisInput, deleteAnalysisInput } from "../../db/primary_mutation.ts";
import { asStr256 } from "../../lib/types.ts";
import type { Analysis, AnalysisInput } from "../../types/analysis.ts";
import { stageInputs, enumerateInputSignatures, inputSignature } from "./staging.ts";

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

    test("anchorless absolute-path input stages under fileId/basename and survives reconciliation", async () => {
        // The live-run regression: an anchorless input's key was the absolute
        // host path, which staged to a different on-disk path than the key —
        // reconciliation then deleted the freshly staged file.
        const looseDir = join(testDir, "downloads");
        mkdirSync(looseDir, { recursive: true });
        const loosePath = join(looseDir, "GSE78220.csv");
        writeFileSync(loosePath, "sample,value\n");

        insertAnalysisInput({ path: loosePath, isDir: false, analysisId, anchorId: null })._unsafeUnwrap();

        const staged = (await stageInputs(analysisId, targetDir))._unsafeUnwrap();

        expect(staged).toHaveLength(1);
        const s = staged[0]!;
        const expectedFileId = Bun.hash(`|${loosePath}`).toString(36);
        expect(s.key).toBe(join(expectedFileId, "GSE78220.csv"));
        expect(s.key.includes("Users")).toBe(false);
        // The manifest path and the on-disk path agree, and the file is still
        // there AFTER stageInputs returned (reconciliation ran).
        expect(existsSync(join(targetDir, s.relativePath))).toBe(true);
    });

    test("two anchorless inputs with the same basename do not collide", async () => {
        const dirA = join(testDir, "a");
        const dirB = join(testDir, "b");
        mkdirSync(dirA, { recursive: true });
        mkdirSync(dirB, { recursive: true });
        writeFileSync(join(dirA, "data.csv"), "from-a");
        writeFileSync(join(dirB, "data.csv"), "from-b");

        insertAnalysisInput({ path: join(dirA, "data.csv"), isDir: false, analysisId, anchorId: null })._unsafeUnwrap();
        insertAnalysisInput({ path: join(dirB, "data.csv"), isDir: false, analysisId, anchorId: null })._unsafeUnwrap();

        const staged = (await stageInputs(analysisId, targetDir))._unsafeUnwrap();

        expect(staged).toHaveLength(2);
        const contents = staged.map((s) => readFileSync(join(targetDir, s.relativePath), "utf-8")).sort();
        expect(contents).toEqual(["from-a", "from-b"]);
    });

    test("noise directories are never staged from a directory input", async () => {
        const dirPath = join(anchorDir, "project");
        mkdirSync(join(dirPath, "node_modules", "pkg"), { recursive: true });
        mkdirSync(join(dirPath, ".git"), { recursive: true });
        mkdirSync(join(dirPath, ".inflexa"), { recursive: true });
        mkdirSync(join(dirPath, "data"), { recursive: true });
        writeFileSync(join(dirPath, "node_modules", "pkg", "index.js"), "dep");
        writeFileSync(join(dirPath, ".git", "HEAD"), "ref");
        writeFileSync(join(dirPath, ".inflexa", "id"), "{}");
        writeFileSync(join(dirPath, "data", "counts.csv"), "1,2,3");

        insertAnalysisInput({ path: "project", isDir: true, analysisId, anchorId })._unsafeUnwrap();

        const staged = (await stageInputs(analysisId, targetDir))._unsafeUnwrap();

        expect(staged.map((s) => s.key)).toEqual([join("project", "data", "counts.csv")]);
        expect(existsSync(join(targetDir, "inputs", "local", "project", "node_modules"))).toBe(false);
        expect(existsSync(join(targetDir, "inputs", "local", "project", ".git"))).toBe(false);
    });

    test("removing an input unlinks its staged files on the next run and prunes empty dirs", async () => {
        const dirPath = join(anchorDir, "bulk");
        mkdirSync(join(dirPath, "sub"), { recursive: true });
        writeFileSync(join(dirPath, "sub", "big.bin"), "payload");
        writeFileSync(join(anchorDir, "keep.csv"), "kept");

        const dirInput: AnalysisInput = { path: "bulk", isDir: true, analysisId, anchorId };
        insertAnalysisInput(dirInput)._unsafeUnwrap();
        insertAnalysisInput({ path: "keep.csv", isDir: false, analysisId, anchorId })._unsafeUnwrap();

        (await stageInputs(analysisId, targetDir))._unsafeUnwrap();
        expect(existsSync(join(targetDir, "inputs", "local", "bulk", "sub", "big.bin"))).toBe(true);

        deleteAnalysisInput(dirInput)._unsafeUnwrap();
        const staged = (await stageInputs(analysisId, targetDir))._unsafeUnwrap();

        expect(staged.map((s) => s.key)).toEqual(["keep.csv"]);
        expect(existsSync(join(targetDir, "inputs", "local", "keep.csv"))).toBe(true);
        expect(existsSync(join(targetDir, "inputs", "local", "bulk"))).toBe(false);
    });

    test("reconciliation also removes files an ignore rule now excludes", async () => {
        // Simulate a tree staged before the ignore rules existed: plant a
        // node_modules file directly in the staged tree, then re-stage.
        const plantedDir = join(targetDir, "inputs", "local", "old", "node_modules");
        mkdirSync(plantedDir, { recursive: true });
        writeFileSync(join(plantedDir, "stale.js"), "stale");
        writeFileSync(join(anchorDir, "fresh.csv"), "fresh");
        insertAnalysisInput({ path: "fresh.csv", isDir: false, analysisId, anchorId })._unsafeUnwrap();

        const staged = (await stageInputs(analysisId, targetDir))._unsafeUnwrap();

        expect(staged.map((s) => s.key)).toEqual(["fresh.csv"]);
        expect(existsSync(join(targetDir, "inputs", "local", "old"))).toBe(false);
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

describe("enumerateInputSignatures", () => {
    test("returns exactly the signature set stageInputs would materialize", async () => {
        // Cover every input shape at once: an anchored single file, an anchorless
        // absolute-path file, and a directory input whose subtree carries nested
        // files plus a dangling symlink both paths must skip identically.
        writeFileSync(join(anchorDir, "solo.csv"), "solo");

        const looseDir = join(testDir, "loose");
        mkdirSync(looseDir, { recursive: true });
        const loosePath = join(looseDir, "ext.csv");
        writeFileSync(loosePath, "ext");

        const dirPath = join(anchorDir, "dir");
        mkdirSync(join(dirPath, "sub"), { recursive: true });
        writeFileSync(join(dirPath, "a.txt"), "aaa");
        writeFileSync(join(dirPath, "sub", "b.txt"), "bbb");
        symlinkSync(join(dirPath, "missing-target.txt"), join(dirPath, "broken.txt"));

        insertAnalysisInput({ path: "solo.csv", isDir: false, analysisId, anchorId })._unsafeUnwrap();
        insertAnalysisInput({ path: loosePath, isDir: false, analysisId, anchorId: null })._unsafeUnwrap();
        insertAnalysisInput({ path: "dir", isDir: true, analysisId, anchorId })._unsafeUnwrap();

        const enumSigs = enumerateInputSignatures(analysisId)._unsafeUnwrap();
        const staged = (await stageInputs(analysisId, targetDir))._unsafeUnwrap();
        const manifestSigs = new Set(staged.map((s) => inputSignature(s.fileId, s.size, s.mtimeMs)));

        // solo.csv + ext.csv + dir/a.txt + dir/sub/b.txt (broken.txt skipped).
        expect(enumSigs.size).toBe(4);
        expect([...enumSigs].sort()).toEqual([...manifestSigs].sort());
    });

    test("enumerates with no session tree, returns ok, and writes nothing", () => {
        writeFileSync(join(anchorDir, "data.csv"), "x");
        insertAnalysisInput({ path: "data.csv", isDir: false, analysisId, anchorId })._unsafeUnwrap();

        // A session tree path staging would use, deliberately never created.
        const absentTree = join(testDir, "absent-session-tree");

        const result = enumerateInputSignatures(analysisId);
        expect(result.isOk()).toBe(true);
        expect(result._unsafeUnwrap().size).toBe(1);
        // Read-only: enumeration neither needs the tree nor stages any file.
        expect(existsSync(absentTree)).toBe(false);
        expect(existsSync(join(targetDir, "inputs"))).toBe(false);
    });

    test("skips an unresolvable input identically to stageInputs", async () => {
        writeFileSync(join(anchorDir, "real.csv"), "real");
        insertAnalysisInput({ path: "real.csv", isDir: false, analysisId, anchorId })._unsafeUnwrap();

        // A second input under an anchor whose cached path is gone and has no
        // on-disk marker — unresolvable, so both paths must drop it.
        const orphanAnchorId = "orphan-anchor-enum";
        insertAnchor({ id: orphanAnchorId, createdAt: 1, updatedAt: 1, cachedPath: "/nonexistent/path", markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
        insertAnalysisInput({ path: "ghost.csv", isDir: false, analysisId, anchorId: orphanAnchorId })._unsafeUnwrap();

        const enumSigs = enumerateInputSignatures(analysisId)._unsafeUnwrap();
        const staged = (await stageInputs(analysisId, targetDir))._unsafeUnwrap();
        const manifestSigs = new Set(staged.map((s) => inputSignature(s.fileId, s.size, s.mtimeMs)));

        expect(staged).toHaveLength(1);
        expect(enumSigs.size).toBe(1);
        expect([...enumSigs].sort()).toEqual([...manifestSigs].sort());
    });

    test("an in-place rewrite changes the signature but not the fileId", () => {
        const src = join(anchorDir, "counts.csv");
        writeFileSync(src, "aaa");
        insertAnalysisInput({ path: "counts.csv", isDir: false, analysisId, anchorId })._unsafeUnwrap();
        utimesSync(src, 1, 1);

        const before = [...enumerateInputSignatures(analysisId)._unsafeUnwrap()];
        expect(before).toHaveLength(1);

        // Rewrite the bytes at the SAME path and to the SAME length, so `size` cannot carry the drift
        // and only `mtimeMs` can. `deriveFileId` hashes `anchorId|path` and nothing else, so identity
        // is unchanged — which is precisely why the signature has to notice this edit.
        writeFileSync(src, "bbb");
        utimesSync(src, 2, 2);

        const after = [...enumerateInputSignatures(analysisId)._unsafeUnwrap()];
        expect(after).toHaveLength(1);
        expect(after[0]).not.toBe(before[0]);

        // The fileId is the signature's first `:`-separated field — unchanged across the edit.
        expect(after[0]!.split(":")[0]).toBe(before[0]!.split(":")[0]);
    });

    test("two mtimes differing only below the millisecond yield different signatures", () => {
        // A same-size rewrite frequently lands inside one millisecond (measured: 193 of 200 back-to-back
        // rewrites shared a whole-ms mtime), so the sub-ms digits are the only thing separating the two
        // versions. Rounding mtimeMs to whole milliseconds would silently collapse them into parity.
        expect(inputSignature("f", 10, 1000.4192)).not.toBe(inputSignature("f", 10, 1000));
        expect(inputSignature("f", 10, 1000.4192)).toBe("f:10:1000.4192");
    });

    test("the staged manifest records stat's mtimeMs verbatim", async () => {
        // The ledger's comparand comes from here; `enumerateInputSignatures` re-stats the same file.
        // If either side rounds and the other does not, every analysis reads as permanently drifted.
        const src = join(anchorDir, "counts.csv");
        writeFileSync(src, "aaa");
        insertAnalysisInput({ path: "counts.csv", isDir: false, analysisId, anchorId })._unsafeUnwrap();
        // A deterministic sub-ms mtime (utimes takes fractional SECONDS). On a filesystem with coarser
        // granularity this reads back whole and the assertion still holds — it just cannot bite there.
        utimesSync(src, 1, 2.0005);

        const staged = (await stageInputs(analysisId, targetDir))._unsafeUnwrap();
        expect(staged).toHaveLength(1);
        expect(staged[0]!.mtimeMs).toBe(statSync(src).mtimeMs);

        // The manifest and the enumeration must agree, or parity never converges.
        const enumerated = [...enumerateInputSignatures(analysisId)._unsafeUnwrap()];
        expect(enumerated).toEqual([inputSignature(staged[0]!.fileId, staged[0]!.size, staged[0]!.mtimeMs)]);
    });

    test("enumeration reads no file content", () => {
        // The hash-free contract: enumeration must never open an input. A file whose bytes are
        // unreadable (mode 000) still yields a signature, because stat does not need read permission.
        const p = join(anchorDir, "unreadable.csv");
        writeFileSync(p, "secret");
        chmodSync(p, 0o000);
        insertAnalysisInput({ path: "unreadable.csv", isDir: false, analysisId, anchorId })._unsafeUnwrap();
        try {
            expect(enumerateInputSignatures(analysisId)._unsafeUnwrap().size).toBe(1);
        } finally {
            chmodSync(p, 0o644);
        }
    });

    test("a file deleted between the walk and its stat is treated as removed, not an error", () => {
        // The DB and the filesystem routinely disagree; a gone input is drift, never a hard failure.
        writeFileSync(join(anchorDir, "kept.csv"), "k");
        insertAnalysisInput({ path: "kept.csv", isDir: false, analysisId, anchorId })._unsafeUnwrap();
        insertAnalysisInput({ path: "vanished.csv", isDir: false, analysisId, anchorId })._unsafeUnwrap();

        // `vanished.csv` was never created, so the walk resolves its path and the stat then misses.
        const result = enumerateInputSignatures(analysisId);
        expect(result.isOk()).toBe(true);
        expect(result._unsafeUnwrap().size).toBe(1);
    });
});
