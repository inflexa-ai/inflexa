import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { makeBaseSlug, matchOutputPrefix, detectSourceAnalysis, createAnalysis, applyInputsDiff } from "./analysis.ts";
import { defaultOutputSubdir } from "./output.ts";
import { freshDb } from "../../test_support/db.ts";
import { insertAnchor, insertAnalysis } from "../../db/primary_mutation.ts";
import { listAnalysisInputs } from "../../db/primary_query.ts";
import { asStr256, str256 } from "../../lib/types.ts";
import type { Analysis } from "../../types/analysis.ts";
import type { AnalysisInput } from "../../types/analysis.ts";

describe("makeBaseSlug", () => {
    test("lowercases and kebab-cases a name", () => {
        expect(makeBaseSlug("My Analysis")).toBe("my-analysis");
    });

    test("collapses runs of symbols into a single dash and trims the edges", () => {
        expect(makeBaseSlug("  --Foo___Bar!!!  ")).toBe("foo-bar");
    });

    test("strips diacritics via NFKD normalization", () => {
        expect(makeBaseSlug("Café")).toBe("cafe");
    });

    test("falls back to a generated handle when the name slugs to empty", () => {
        expect(makeBaseSlug("!!!")).toMatch(/^analysis-[0-9a-f]{6}$/);
    });
});

describe("matchOutputPrefix", () => {
    const candidates = [
        { id: "A", dir: join(sep, "data", "out-a") },
        { id: "B", dir: join(sep, "data", "out-b") },
    ];

    test("matches a path inside (or equal to) a candidate's output dir", () => {
        expect(matchOutputPrefix(join(sep, "data", "out-a", "r.csv"), candidates)).toBe("A");
        expect(matchOutputPrefix(join(sep, "data", "out-b"), candidates)).toBe("B");
    });

    test("requires a path boundary — a sibling prefix is not a match", () => {
        expect(matchOutputPrefix(join(sep, "data", "out-a-extra"), candidates)).toBeNull();
    });

    test("null when under no candidate", () => {
        expect(matchOutputPrefix(join(sep, "elsewhere"), candidates)).toBeNull();
    });
});

describe("detectSourceAnalysis", () => {
    beforeEach(() => {
        freshDb();
    });

    function row(id: string, slug: string, anchorId: string, outputDirectory: string | null = null): Analysis {
        return { id, createdAt: 1, updatedAt: 1, name: asStr256(slug), slug, outputDirectory, anchorId, projectId: null };
    }
    function seedAnchor(id: string): void {
        insertAnchor({ id, createdAt: 1, updatedAt: 1, cachedPath: "/tmp/x", markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
    }
    function input(partial: Partial<AnalysisInput> & Pick<AnalysisInput, "path" | "analysisId">): AnalysisInput {
        return { isDir: false, anchorId: null, ...partial };
    }

    test("links an anchor-relative input under a sibling's DEFAULT output to that analysis", () => {
        seedAnchor("anc");
        insertAnalysis(row("SRC", "src", "anc"))._unsafeUnwrap();
        const dst = insertAnalysis(row("DST", "dst", "anc"))._unsafeUnwrap();
        const i = input({ path: join(defaultOutputSubdir("src"), "result.csv"), analysisId: dst.id, anchorId: "anc" });
        expect(detectSourceAnalysis(i, dst.id)._unsafeUnwrap()).toBe("SRC");
    });

    test("links a raw absolute input under an analysis's EXPLICIT outputDirectory", () => {
        seedAnchor("anc");
        insertAnalysis(row("SRC", "src", "anc", join(sep, "custom", "out")))._unsafeUnwrap();
        const i = input({ path: join(sep, "custom", "out", "r.csv"), analysisId: "OTHER" });
        expect(detectSourceAnalysis(i, "OTHER")._unsafeUnwrap()).toBe("SRC");
    });

    test("null when the input is no analysis's output", () => {
        seedAnchor("anc");
        const dst = insertAnalysis(row("DST", "dst", "anc"))._unsafeUnwrap();
        const i = input({ path: join("some", "other", "file.csv"), analysisId: dst.id, anchorId: "anc" });
        expect(detectSourceAnalysis(i, dst.id)._unsafeUnwrap()).toBeNull();
    });
});

describe("applyInputsDiff", () => {
    let dir = "";

    beforeEach(() => {
        freshDb();
        // realpath so the analysis's stored paths match macOS's canonical /private/var.
        dir = realpathSync(mkdtempSync(join(tmpdir(), "inflexa-diff-")));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    test("a failed add batch skips the removals — the diff lands as a unit or not at all", () => {
        writeFileSync(join(dir, "keep.txt"), "x");
        const a = createAnalysis({ cwd: dir, name: str256("diff-a")._unsafeUnwrap(), inputPaths: [join(dir, "keep.txt")] })._unsafeUnwrap();
        const existing = listAnalysisInputs(a.id)._unsafeUnwrap();
        expect(existing).toHaveLength(1);

        // The add batch is all-or-nothing (classification short-circuits on the vanished path);
        // the recorded input must survive because the removals never ran.
        const failures = applyInputsDiff(a.id, [join(dir, "vanished.txt")], existing, dir);
        expect(failures.map((f) => f.op)).toEqual(["add"]);
        expect(listAnalysisInputs(a.id)._unsafeUnwrap()).toHaveLength(1);
    });

    test("adds then removals apply when the add batch succeeds", () => {
        writeFileSync(join(dir, "old.txt"), "x");
        writeFileSync(join(dir, "new.txt"), "x");
        const a = createAnalysis({ cwd: dir, name: str256("diff-b")._unsafeUnwrap(), inputPaths: [join(dir, "old.txt")] })._unsafeUnwrap();
        const existing = listAnalysisInputs(a.id)._unsafeUnwrap();

        const failures = applyInputsDiff(a.id, [join(dir, "new.txt")], existing, dir);
        expect(failures).toEqual([]);
        const after = listAnalysisInputs(a.id)._unsafeUnwrap();
        expect(after).toHaveLength(1);
        expect(after[0]?.path).toContain("new.txt");
    });
});
