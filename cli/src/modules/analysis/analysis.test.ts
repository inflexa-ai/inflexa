import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import {
    makeBaseSlug,
    matchOutputPrefix,
    detectSourceAnalysis,
    createAnalysis,
    applyInputsDiff,
    makeAnalysisFarm,
    renameAnalysisAndMoveWorkspace,
} from "./analysis.ts";
import { archivedOutputSubdir, defaultOutputSubdir, disposeWorkspace, invalidateWorkspaceRoot, resolveOutputDir } from "./output.ts";
import { env } from "../../lib/env.ts";
import { analysisFarmPath } from "../libs/composition.ts";
import { freshDb } from "../../test_support/db.ts";
import { assertTestSandbox } from "../../test_support/sandbox.ts";
import { deleteAnalysis, insertAnchor, insertAnalysis } from "../../db/primary_mutation.ts";
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

    // The analysis must not collide with its own slug: a same-name rename is a no-op on disk.
    test("renaming to the current name keeps the slug and does not move the tree", () => {
        const a = createAnalysis({ cwd: dir, name: str256("My Analysis")._unsafeUnwrap() })._unsafeUnwrap();
        expect(a.slug).toBe("my-analysis");
        const root = join(dir, ".inflexa", "analyses", "my-analysis");
        mkdirSync(join(root, "runs"), { recursive: true });
        writeFileSync(join(root, "runs", "log.txt"), "kept");

        const outcome = renameAnalysisAndMoveWorkspace(a, str256("My Analysis")._unsafeUnwrap())._unsafeUnwrap();

        expect(outcome.analysis.slug).toBe("my-analysis");
        expect(outcome.workspaceMoved).toBe(false);
        expect(outcome.moveError).toBeUndefined();
        expect(existsSync(join(dir, ".inflexa", "analyses", "my-analysis-2"))).toBe(false);
        expect(readFileSync(join(root, "runs", "log.txt"), "utf-8")).toBe("kept");
    });

    // Same slug, different display name — e.g. re-casing. The row's name changes, the tree stays put.
    test("renaming to a name that slugifies identically keeps the slug and updates the name", () => {
        const a = createAnalysis({ cwd: dir, name: str256("My Analysis")._unsafeUnwrap() })._unsafeUnwrap();

        const outcome = renameAnalysisAndMoveWorkspace(a, str256("my   analysis")._unsafeUnwrap())._unsafeUnwrap();

        expect(outcome.analysis.slug).toBe("my-analysis");
        expect(outcome.analysis.name).toBe(str256("my   analysis")._unsafeUnwrap());
        expect(outcome.workspaceMoved).toBe(false);
        expect(existsSync(join(dir, ".inflexa", "analyses", "my-analysis-2"))).toBe(false);
    });

    test("a genuinely new name still collides against SIBLINGS, suffixing past a taken slug", () => {
        createAnalysis({ cwd: dir, name: str256("Taken")._unsafeUnwrap() })._unsafeUnwrap();
        const b = createAnalysis({ cwd: dir, name: str256("Other")._unsafeUnwrap() })._unsafeUnwrap();

        const outcome = renameAnalysisAndMoveWorkspace(b, str256("Taken")._unsafeUnwrap())._unsafeUnwrap();
        expect(outcome.analysis.slug).toBe("taken-2");
    });
});

describe("delete → recreate does not inherit the previous analysis's artifacts", () => {
    let dir = "";

    beforeEach(() => {
        freshDb();
        invalidateWorkspaceRoot();
        dir = realpathSync(mkdtempSync(join(tmpdir(), "inflexa-recreate-")));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    test("a new analysis of the same name resolves onto a clean tree once the old one is disposed", () => {
        const first = createAnalysis({ cwd: dir, name: str256("Trial")._unsafeUnwrap() })._unsafeUnwrap();
        const firstRoot = resolveOutputDir(first)._unsafeUnwrap();
        mkdirSync(join(firstRoot, "runs", "run-1"), { recursive: true });
        writeFileSync(join(firstRoot, "runs", "run-1", "result.csv"), "old,data");

        // The delete command's order: retire the tree, then drop the row.
        disposeWorkspace(first, "archive")._unsafeUnwrap();
        deleteAnalysis(first.id)._unsafeUnwrap();

        const second = createAnalysis({ cwd: dir, name: str256("Trial")._unsafeUnwrap() })._unsafeUnwrap();
        const secondRoot = resolveOutputDir(second)._unsafeUnwrap();

        // The slug is reused — that is fine, because the bytes are no longer under it.
        expect(second.slug).toBe("trial");
        expect(secondRoot).toBe(firstRoot);
        expect(existsSync(join(secondRoot, "runs", "run-1", "result.csv"))).toBe(false);

        // And the first analysis's work is still on disk, where the user was told it would be.
        expect(readFileSync(join(dir, archivedOutputSubdir("trial"), "runs", "run-1", "result.csv"), "utf-8")).toBe("old,data");
    });
});

// --- the farm of a new analysis (tasks 8.1, 8.4, 2.1, 2.5) -------------------

describe("the package farm of a new analysis", () => {
    let dir = "";

    /**
     * A store root that holds the catalog template and no pool.
     *
     * The template is what gives a farm the architecture that the store serves, thus it
     * is the whole of what an EMPTY farm needs. A pool would add nothing here: the farm
     * of a new analysis links no package.
     */
    function seedStoreTemplate(): string {
        const root = env.libStoreDir;
        assertTestSandbox(root);
        assertTestSandbox(env.locksDir);
        rmSync(root, { recursive: true, force: true });
        const template = join(root, "farms", "catalog");
        mkdirSync(template, { recursive: true });
        writeFileSync(join(template, "lock.json"), JSON.stringify({ requested: ["beta"], resolved: [], store_dirs: ["beta-0.4.1-000000000000bbbb"] }));
        writeFileSync(join(template, "meta.json"), JSON.stringify({ version: "catalog", arch: "linux-arm64", tracks: ["python"] }));
        return root;
    }

    /**
     * The usability gate of the harness, as `libStoreUsable` decides it
     * (`harness/src/sandbox/docker-client.ts`).
     *
     * The harness publishes no reader of that gate, thus this mirrors the three questions
     * that it asks: a path that resolves to a directory, plus the two completeness
     * markers. `statSync` FOLLOWS a link exactly as the gate does, thus a farm that
     * dangles fails here as it fails there.
     */
    function passesTheUsabilityGate(farmPath: string): boolean {
        try {
            if (!statSync(farmPath).isDirectory()) return false;
        } catch {
            return false;
        }
        return existsSync(join(farmPath, "packages.txt")) && existsSync(join(farmPath, "meta.json"));
    }

    beforeEach(() => {
        freshDb();
        invalidateWorkspaceRoot();
        dir = realpathSync(mkdtempSync(join(tmpdir(), "inflexa-farm-")));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
        assertTestSandbox(env.libStoreDir);
        rmSync(env.libStoreDir, { recursive: true, force: true });
    });

    test("the farm is made with the analysis, it carries its markers only, and it passes the usability gate", async () => {
        const root = seedStoreTemplate();
        const analysis = createAnalysis({ cwd: dir, name: str256("Trial")._unsafeUnwrap() })._unsafeUnwrap();

        await makeAnalysisFarm(analysis.id);

        const farmPath = analysisFarmPath(root, analysis.id);
        expect(passesTheUsabilityGate(farmPath)).toBe(true);
        // The three markers, and nothing beside them: no python tree, no r tree, and no
        // link. The planner is what names a package into this farm, and it has not run.
        expect(readdirSync(farmPath).sort()).toEqual(["lock.json", "meta.json", "packages.txt"]);
    });

    test("a chat-only analysis keeps the empty farm, and it links no package", async () => {
        const root = seedStoreTemplate();
        const analysis = createAnalysis({ cwd: dir, name: str256("Only chat")._unsafeUnwrap() })._unsafeUnwrap();
        await makeAnalysisFarm(analysis.id);
        const farmPath = analysisFarmPath(root, analysis.id);
        const stamp = statSync(join(farmPath, "lock.json")).mtimeMs;

        // Chat runs no plan and no sandbox action, thus nothing extends the farm.

        expect(statSync(join(farmPath, "lock.json")).mtimeMs).toBe(stamp);
        expect(passesTheUsabilityGate(farmPath)).toBe(true);
        // The lock records no store directory, and the inventory advertises no section.
        const lock = JSON.parse(readFileSync(join(farmPath, "lock.json"), "utf8")) as { requested: string[]; store_dirs: string[] };
        expect({ requested: lock.requested, storeDirs: lock.store_dirs }).toEqual({ requested: [], storeDirs: [] });
        expect(readFileSync(join(farmPath, "packages.txt"), "utf8")).not.toContain("##");
    });

    test("a store that the machine does not hold yet never fails the creation of the analysis", async () => {
        // The catalog still downloads, or it was never asked for. The two stores then
        // disagree, which is the normal condition and never a hard error.
        assertTestSandbox(env.libStoreDir);
        rmSync(env.libStoreDir, { recursive: true, force: true });
        const analysis = createAnalysis({ cwd: dir, name: str256("Early")._unsafeUnwrap() })._unsafeUnwrap();

        await makeAnalysisFarm(analysis.id);

        // No farm, and no refusal: the analysis is on the machine, and chat, the workspace
        // read surface, and the planner want no package at all. The sandbox gate is what
        // refuses a sandbox action, with a reason of its own.
        expect(existsSync(analysisFarmPath(env.libStoreDir, analysis.id))).toBe(false);
        expect(
            listAnalyses()
                ._unsafeUnwrap()
                .map((a) => a.id),
        ).toEqual([analysis.id]);
    });
});
