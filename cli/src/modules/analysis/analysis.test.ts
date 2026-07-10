import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { makeBaseSlug, matchOutputPrefix, detectSourceAnalysis, createAnalysis, applyInputsDiff, renameAnalysisAndMoveWorkspace } from "./analysis.ts";
import { defaultOutputSubdir } from "./output.ts";
import { freshDb } from "../../test_support/db.ts";
import { insertAnchor, insertAnalysis } from "../../db/primary_mutation.ts";
import { findAnalysesByRef, listAnalyses, listAnalysisInputs } from "../../db/primary_query.ts";
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

    function row(id: string, slug: string, anchorId: string): Analysis {
        return { id, createdAt: 1, updatedAt: 1, name: asStr256(slug), slug, anchorId, projectId: null };
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

    test("a raw absolute-path input (no source anchor) detects nothing — the side-effect-free contract forbids resolving anchors", () => {
        seedAnchor("anc");
        insertAnalysis(row("SRC", "src", "anc"))._unsafeUnwrap();
        const i = input({ path: join(sep, "custom", "out", "r.csv"), analysisId: "OTHER" });
        expect(detectSourceAnalysis(i, "OTHER")._unsafeUnwrap()).toBeNull();
    });

    test("null when the input is no analysis's output", () => {
        seedAnchor("anc");
        const dst = insertAnalysis(row("DST", "dst", "anc"))._unsafeUnwrap();
        const i = input({ path: join("some", "other", "file.csv"), analysisId: dst.id, anchorId: "anc" });
        expect(detectSourceAnalysis(i, dst.id)._unsafeUnwrap()).toBeNull();
    });
});

describe("createAnalysis inputs", () => {
    let dir = "";

    beforeEach(() => {
        freshDb();
        // realpath so the analysis's stored paths match macOS's canonical /private/var.
        dir = realpathSync(mkdtempSync(join(tmpdir(), "inflexa-create-")));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    // The load-bearing regression: opening `inflexa` in a huge tree (e.g. $HOME) once enrolled the
    // whole cwd as an input, which the open-time parity check then data-profiled in full. Inputs are
    // user-driven — no paths in, no inputs out.
    test("with no inputPaths, the analysis starts with zero inputs (never defaults to cwd)", () => {
        const a = createAnalysis({ cwd: dir, name: str256("no-inputs")._unsafeUnwrap() })._unsafeUnwrap();
        expect(listAnalysisInputs(a.id)._unsafeUnwrap()).toHaveLength(0);
    });

    test("with an empty inputPaths array, the analysis still starts with zero inputs", () => {
        const a = createAnalysis({ cwd: dir, name: str256("empty-inputs")._unsafeUnwrap(), inputPaths: [] })._unsafeUnwrap();
        expect(listAnalysisInputs(a.id)._unsafeUnwrap()).toHaveLength(0);
    });

    test("explicit inputPaths are still enrolled", () => {
        writeFileSync(join(dir, "one.txt"), "x");
        const a = createAnalysis({ cwd: dir, name: str256("one-input")._unsafeUnwrap(), inputPaths: [join(dir, "one.txt")] })._unsafeUnwrap();
        const inputs = listAnalysisInputs(a.id)._unsafeUnwrap();
        expect(inputs).toHaveLength(1);
        expect(inputs[0]?.path).toContain("one.txt");
    });
});

describe("createAnalysis workspace precondition", () => {
    let dir = "";

    beforeEach(() => {
        freshDb();
        dir = realpathSync(mkdtempSync(join(tmpdir(), "inflexa-precond-")));
    });

    afterEach(() => {
        // The test leaves the dir read-only; restore the write bit so rmSync can clear it.
        chmodSync(dir, 0o755);
        rmSync(dir, { recursive: true, force: true });
    });

    test("a non-writable cwd fails with workspace_unavailable BEFORE any row or marker write", () => {
        chmodSync(dir, 0o555);
        expect(createAnalysis({ cwd: dir, name: str256("blocked")._unsafeUnwrap() })._unsafeUnwrapErr().type).toBe("workspace_unavailable");
        // The precondition runs first — no analysis row landed and no .inflexa marker was minted.
        expect(listAnalyses()._unsafeUnwrap()).toEqual([]);
        expect(existsSync(join(dir, ".inflexa"))).toBe(false);
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

describe("renameAnalysisAndMoveWorkspace", () => {
    let dir = "";

    beforeEach(() => {
        freshDb();
        // realpath so the anchor's canonical cached path matches macOS's /private/var.
        dir = realpathSync(mkdtempSync(join(tmpdir(), "inflexa-rename-")));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    test("moves an existing workspace tree — with its contents — to the new slug", () => {
        const a = createAnalysis({ cwd: dir, name: str256("Old Name")._unsafeUnwrap() })._unsafeUnwrap();
        const oldRoot = join(dir, ".inflexa", "analyses", a.slug);
        mkdirSync(join(oldRoot, "runs"), { recursive: true });
        writeFileSync(join(oldRoot, "runs", "log.txt"), "kept");

        const outcome = renameAnalysisAndMoveWorkspace(a, str256("New Name")._unsafeUnwrap())._unsafeUnwrap();
        expect(outcome.workspaceMoved).toBe(true);
        expect(outcome.analysis.slug).toBe("new-name");
        // The tree moved wholesale: nothing left at the old slug, contents intact at the new one.
        expect(existsSync(oldRoot)).toBe(false);
        expect(readFileSync(join(dir, ".inflexa", "analyses", "new-name", "runs", "log.txt"), "utf-8")).toBe("kept");
        // The row is authoritative and renamed with it.
        expect(findAnalysesByRef("new-name")._unsafeUnwrap()[0]?.id).toBe(a.id);
    });

    test("a missing workspace tree is the normal desync, not an error — the row still renames", () => {
        // Workspace creation is deferred to first use, so a never-opened analysis has no tree.
        const a = createAnalysis({ cwd: dir, name: str256("Loner")._unsafeUnwrap() })._unsafeUnwrap();

        const outcome = renameAnalysisAndMoveWorkspace(a, str256("Loner Renamed")._unsafeUnwrap())._unsafeUnwrap();
        expect(outcome.workspaceMoved).toBe(false);
        expect(outcome.moveError).toBeUndefined();
        expect(outcome.analysis.slug).toBe("loner-renamed");
        expect(findAnalysesByRef("loner-renamed")._unsafeUnwrap()[0]?.id).toBe(a.id);
        // Nothing was invented on disk at either slug.
        expect(existsSync(join(dir, ".inflexa", "analyses", "loner-renamed"))).toBe(false);
    });
});
