import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync, symlinkSync, utimesSync, chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUIDv7 } from "bun";
import { createHash } from "node:crypto";

import { freshDb } from "../../test_support/db.ts";
import { insertAnchor, insertAnalysis, insertAnalysisInput, deleteAnalysisInput } from "../../db/primary_mutation.ts";
import { asStr256 } from "../../lib/types.ts";
import type { Analysis, AnalysisInput } from "../../types/analysis.ts";
import { stageInputs, enumerateInputSignatures, inputSignature, isInputSetMaterialized } from "./staging.ts";

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

    test("a file present in DB but deleted on disk is skipped, reconciled away, and never fails staging", async () => {
        // The desync the shared-walk existence gate closes: an input whose source is deleted while its
        // row survives. Before the gate, staging deleted the stale staged copy and then failed to
        // re-link the gone source, so `stageAndSeed` mapped to `staging_failed` and the parity loop
        // toasted "could not start profiling" on every edge. Now enumeration and staging BOTH skip it,
        // and reconciliation removes the orphaned copy — parity converges over the survivors.
        writeFileSync(join(anchorDir, "keep.csv"), "keep");
        writeFileSync(join(anchorDir, "gone.csv"), "gone");
        insertAnalysisInput({ path: "keep.csv", isDir: false, analysisId, anchorId })._unsafeUnwrap();
        insertAnalysisInput({ path: "gone.csv", isDir: false, analysisId, anchorId })._unsafeUnwrap();

        const first = (await stageInputs(analysisId, targetDir))._unsafeUnwrap();
        expect(first).toHaveLength(2);
        expect(existsSync(join(targetDir, "inputs", "local", "gone.csv"))).toBe(true);

        // Delete the source on disk while its DB row stays — the routine DB/filesystem disagreement.
        rmSync(join(anchorDir, "gone.csv"), { force: true });

        // Enumeration skips the gone file (reports drift over the survivor)…
        const enumSigs = enumerateInputSignatures(analysisId)._unsafeUnwrap();
        expect(enumSigs.size).toBe(1);

        // …and staging COMPLETES over the survivor rather than hard-failing on the dead link.
        const second = (await stageInputs(analysisId, targetDir))._unsafeUnwrap();
        expect(second.map((s) => s.key)).toEqual(["keep.csv"]);
        // The stale staged copy of the now-gone input is reconciled away — no orphan lingers.
        expect(existsSync(join(targetDir, "inputs", "local", "gone.csv"))).toBe(false);
        // Both callers land on the SAME identity space — the divergence the gate structurally closes.
        const manifestSigs = new Set(second.map((s) => inputSignature(s.fileId, s.size, s.mtimeMs)));
        expect([...enumSigs].sort()).toEqual([...manifestSigs].sort());
    });

    test("a directory input whose root vanished is skipped, not a staging failure", async () => {
        // Symmetry with the single-file case: a whole directory input deleted on disk. Before the shared
        // gate, `walkFiles` ENOENT-faulted inside staging (→ `staging_failed`) while enumeration skipped
        // it, so the two callers diverged. Now the root existence check skips it in the shared walk.
        const dirPath = join(anchorDir, "vanished-dir");
        mkdirSync(dirPath, { recursive: true });
        writeFileSync(join(dirPath, "inside.txt"), "x");
        writeFileSync(join(anchorDir, "survivor.csv"), "s");
        insertAnalysisInput({ path: "vanished-dir", isDir: true, analysisId, anchorId })._unsafeUnwrap();
        insertAnalysisInput({ path: "survivor.csv", isDir: false, analysisId, anchorId })._unsafeUnwrap();

        rmSync(dirPath, { recursive: true, force: true });

        const enumSigs = enumerateInputSignatures(analysisId)._unsafeUnwrap();
        expect(enumSigs.size).toBe(1);
        const staged = (await stageInputs(analysisId, targetDir))._unsafeUnwrap();
        expect(staged.map((s) => s.key)).toEqual(["survivor.csv"]);
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

describe("stageInputs — the staged tree records what it materialized", () => {
    test("a hardlinked staged file reports its source's size and mtime", async () => {
        const src = join(anchorDir, "linked.csv");
        writeFileSync(src, "a,b\n1,2\n");
        // A deterministic sub-millisecond mtime: the fraction is exactly what a truncating stamp would
        // drop, and the predicate compares mtimeMs at full precision.
        utimesSync(src, 1, 2.0005);
        insertAnalysisInput({ path: "linked.csv", isDir: false, analysisId, anchorId })._unsafeUnwrap();

        const staged = (await stageInputs(analysisId, targetDir))._unsafeUnwrap();
        const stagedStats = statSync(join(targetDir, staged[0]!.relativePath));
        const srcStats = statSync(src);

        expect(stagedStats.size).toBe(srcStats.size);
        expect(stagedStats.mtimeMs).toBe(srcStats.mtimeMs);
        // The placement mode this case exists to cover: one inode under two names.
        expect(stagedStats.ino).toBe(srcStats.ino);
    });

    test("a copied staged file reports its source's size and mtime too", async () => {
        // Forcing the cross-filesystem fallback needs a source `linkSync` refuses: a root-owned system
        // binary is that on both platforms this runs on — macOS keeps it on the sealed read-only system
        // volume, and Linux's `fs.protected_hardlinks` (on by default) refuses a link to a file the
        // caller neither owns nor may write. Both surface as EPERM, which drops staging into
        // `copyFileSync`. The inode assertion below proves the fallback actually ran, so a platform that
        // permitted the link would fail loudly here rather than silently re-testing the hardlink path.
        const systemFile = "/bin/ls";
        insertAnalysisInput({ path: systemFile, isDir: false, analysisId, anchorId: null })._unsafeUnwrap();

        const staged = (await stageInputs(analysisId, targetDir))._unsafeUnwrap();
        const stagedStats = statSync(join(targetDir, staged[0]!.relativePath));
        const srcStats = statSync(systemFile);

        expect(stagedStats.ino).not.toBe(srcStats.ino);
        expect(stagedStats.size).toBe(srcStats.size);
        // `copyFileSync` stamps the destination with its own creation time; without the source's mtime
        // copied back on, the staged tree could never record which input set it materialized.
        expect(stagedStats.mtimeMs).toBe(srcStats.mtimeMs);
    });

    test("staging by hardlink never touches the source's mtime, so nothing drifts afterwards", async () => {
        // The constraint the copy branch's `utimesSync` must never cross: a hardlink shares the source's
        // inode, so stamping the staged path would rewrite the USER'S OWN input file — and since
        // `enumerateInputSignatures` reads that file's mtime, staging would manufacture drift against
        // the very profile it was staging for.
        const src = join(anchorDir, "untouched.csv");
        writeFileSync(src, "payload");
        utimesSync(src, 1, 2.0005);
        insertAnalysisInput({ path: "untouched.csv", isDir: false, analysisId, anchorId })._unsafeUnwrap();

        const before = statSync(src).mtimeMs;
        const signaturesBefore = [...enumerateInputSignatures(analysisId)._unsafeUnwrap()];

        (await stageInputs(analysisId, targetDir))._unsafeUnwrap();

        expect(statSync(src).mtimeMs).toBe(before);
        expect([...enumerateInputSignatures(analysisId)._unsafeUnwrap()]).toEqual(signaturesBefore);
    });
});

describe("isInputSetMaterialized", () => {
    /** Register one file input and stage it, returning its source path — the materialized baseline. */
    async function stagedBaseline(name = "counts.csv", content = "id,value\n1,2\n"): Promise<string> {
        const src = join(anchorDir, name);
        writeFileSync(src, content);
        insertAnalysisInput({ path: name, isDir: false, analysisId, anchorId })._unsafeUnwrap();
        (await stageInputs(analysisId, targetDir))._unsafeUnwrap();
        return src;
    }

    test("an unchanged input set reads as materialized", async () => {
        await stagedBaseline();
        expect(isInputSetMaterialized(analysisId, targetDir)._unsafeUnwrap()).toBe(true);
    });

    test("an input replaced at the same path reads as not materialized", async () => {
        const src = await stagedBaseline();
        // Replace-at-the-same-path — what a text editor, `mv`, or a re-download does: the new bytes land
        // in a NEW inode that the staged hardlink knows nothing about, so the tree holds the old file.
        const replacement = join(testDir, "replacement.csv");
        writeFileSync(replacement, "id,value\n9,9,9\n");
        renameSync(replacement, src);
        expect(isInputSetMaterialized(analysisId, targetDir)._unsafeUnwrap()).toBe(false);
    });

    test("a truncate-in-place edit is carried by the shared inode, so the tree stays current", async () => {
        // Not a miss: hardlink placement means the staged path IS the source, so a truncate-write (the
        // other half of "edited in place") leaves the tree holding exactly the new bytes — there is
        // nothing for staging to do. Drift against a COMPLETED profile is judged separately, on the
        // recorded signatures, so such an edit still re-profiles. The one case it does not reach is a
        // `failed` row, whose retry is gated on this predicate; the deliberate re-profile covers it.
        const src = await stagedBaseline();
        writeFileSync(src, "id,value\n9,9\n");
        utimesSync(src, 3, 3);
        expect(isInputSetMaterialized(analysisId, targetDir)._unsafeUnwrap()).toBe(true);
        expect(statSync(join(targetDir, "inputs", "local", "counts.csv")).mtimeMs).toBe(statSync(src).mtimeMs);
    });

    test("a newly registered input reads as not materialized", async () => {
        await stagedBaseline();
        writeFileSync(join(anchorDir, "extra.csv"), "extra");
        insertAnalysisInput({ path: "extra.csv", isDir: false, analysisId, anchorId })._unsafeUnwrap();
        expect(isInputSetMaterialized(analysisId, targetDir)._unsafeUnwrap()).toBe(false);
    });

    test("a removed input whose staged file lingers reads as not materialized", async () => {
        await stagedBaseline();
        const removed: AnalysisInput = { path: "removed.csv", isDir: false, analysisId, anchorId };
        writeFileSync(join(anchorDir, "removed.csv"), "gone soon");
        insertAnalysisInput(removed)._unsafeUnwrap();
        (await stageInputs(analysisId, targetDir))._unsafeUnwrap();

        deleteAnalysisInput(removed)._unsafeUnwrap();

        // Every expected file still matches; only the orphan the mirror pass owes a deletion says
        // otherwise — which is exactly the extra-file arm of the predicate.
        expect(existsSync(join(targetDir, "inputs", "local", "removed.csv"))).toBe(true);
        expect(isInputSetMaterialized(analysisId, targetDir)._unsafeUnwrap()).toBe(false);
    });

    test("a hand-deleted staged file reads as not materialized, and staging restores it", async () => {
        await stagedBaseline();
        const stagedPath = join(targetDir, "inputs", "local", "counts.csv");
        rmSync(stagedPath, { force: true });

        expect(isInputSetMaterialized(analysisId, targetDir)._unsafeUnwrap()).toBe(false);

        (await stageInputs(analysisId, targetDir))._unsafeUnwrap();
        expect(existsSync(stagedPath)).toBe(true);
        expect(isInputSetMaterialized(analysisId, targetDir)._unsafeUnwrap()).toBe(true);
    });

    test("an input set that was never staged reads as not materialized", async () => {
        writeFileSync(join(anchorDir, "fresh.csv"), "fresh");
        insertAnalysisInput({ path: "fresh.csv", isDir: false, analysisId, anchorId })._unsafeUnwrap();
        // The tree does not exist at all — the wedged-analysis state this predicate has to catch.
        expect(isInputSetMaterialized(analysisId, join(testDir, "never-staged"))._unsafeUnwrap()).toBe(false);
    });

    test("a copy-staged input set reads as materialized on the next check", async () => {
        // The reason the copy fallback stamps the mtime at all: without it this analysis would re-hash
        // its whole input set on every parity check, forever.
        insertAnalysisInput({ path: "/bin/ls", isDir: false, analysisId, anchorId: null })._unsafeUnwrap();
        (await stageInputs(analysisId, targetDir))._unsafeUnwrap();
        expect(isInputSetMaterialized(analysisId, targetDir)._unsafeUnwrap()).toBe(true);
    });

    test("reads no file content — a mode-000 input is still answerable", async () => {
        // The cost contract: stat and readdir only. A file whose bytes are unreadable still answers,
        // because neither side of the comparison opens it.
        const src = await stagedBaseline("locked.csv", "secret");
        chmodSync(src, 0o000);
        try {
            expect(isInputSetMaterialized(analysisId, targetDir)._unsafeUnwrap()).toBe(true);
        } finally {
            chmodSync(src, 0o644);
        }
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

    test("enumerates with no staging target, returns ok, and writes nothing", () => {
        writeFileSync(join(anchorDir, "data.csv"), "x");
        insertAnalysisInput({ path: "data.csv", isDir: false, analysisId, anchorId })._unsafeUnwrap();

        // A workspace data-dir path staging would use, deliberately never created.
        const absentTree = join(testDir, "absent-data-dir");

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
