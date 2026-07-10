import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { freshDb } from "../../test_support/db.ts";
import {
    archivedOutputSubdir,
    disposeWorkspace,
    ensureOutputDir,
    invalidateWorkspaceRoot,
    locateExistingOutputDir,
    resolveOutputDir,
    workspaceDataDir,
    workspaceRootForAnalysisId,
} from "./output.ts";
import { writeMarker } from "../anchor/marker.ts";
import { deleteAnalysis, insertAnalysis, insertAnchor } from "../../db/primary_mutation.ts";
import { asStr256 } from "../../lib/types.ts";
import type { Analysis } from "../../types/analysis.ts";

const created: string[] = [];

function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), "inflexa-output-"));
    created.push(dir);
    return dir;
}

function analysis(overrides: Partial<Analysis> = {}): Analysis {
    return {
        id: "ana1",
        createdAt: 1,
        updatedAt: 1,
        name: asStr256("A"),
        slug: "myslug",
        anchorId: "A1",
        projectId: null,
        ...overrides,
    };
}

function insertAnchorAt(id: string, cachedPath: string): void {
    insertAnchor({ id, createdAt: 1, updatedAt: 1, cachedPath, markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
}

// A resolvable "A1" anchor: marker on disk + row with the marker's path cached, so
// resolveAnchor's cheap cached-path step hits without any search.
function anchoredHome(): string {
    const home = tmp();
    writeMarker(home, "A1")._unsafeUnwrap();
    insertAnchorAt("A1", home);
    return home;
}

beforeEach(() => {
    freshDb();
    // The root memo is process state and outlives `freshDb()`; every test rebuilds its own anchor
    // under a fresh tmpdir, so a carried-over entry would resolve onto the previous test's home.
    invalidateWorkspaceRoot();
});

afterEach(() => {
    for (const dir of created) {
        // The non-writable-anchor test leaves its dir read-only; restore the write bit so the
        // recursive removal below can delete the marker inside. The unresolvable-anchor test
        // already deleted its dir — hence the existsSync guard.
        if (existsSync(dir)) chmodSync(dir, 0o755);
        rmSync(dir, { recursive: true, force: true });
    }
    created.length = 0;
});

describe("resolveOutputDir", () => {
    test("a resolvable, writable anchor → the derived root at <anchor>/.inflexa/analyses/<slug>", () => {
        const home = anchoredHome();
        expect(resolveOutputDir(analysis())._unsafeUnwrap()).toBe(join(home, ".inflexa", "analyses", "myslug"));
    });

    test("a resolvable but non-writable anchor → workspace_unavailable naming the folder (no fallback)", () => {
        const home = anchoredHome();
        chmodSync(home, 0o555);
        const error = resolveOutputDir(analysis())._unsafeUnwrapErr();
        expect(error.type).toBe("workspace_unavailable");
        if (error.type === "workspace_unavailable") expect(error.message).toContain(home);
    });

    test("an unresolvable anchor → workspace_unavailable (no fallback)", () => {
        const gone = tmp();
        insertAnchorAt("A1", gone);
        rmSync(gone, { recursive: true, force: true }); // anchor can no longer be located
        expect(resolveOutputDir(analysis())._unsafeUnwrapErr().type).toBe("workspace_unavailable");
    });
});

describe("locateExistingOutputDir", () => {
    test("an existing tree is revealed even when the home folder is not writable", () => {
        const home = anchoredHome();
        // Materialize the tree while the folder is still writable, then revoke write.
        ensureOutputDir(analysis())._unsafeUnwrap();
        chmodSync(home, 0o555);

        // resolveOutputDir (the write path) refuses, but the reveal path returns the tree.
        expect(resolveOutputDir(analysis())._unsafeUnwrapErr().type).toBe("workspace_unavailable");
        expect(locateExistingOutputDir(analysis())._unsafeUnwrap()).toBe(join(home, ".inflexa", "analyses", "myslug"));
    });

    test("a reachable folder with no materialized tree → ok(null)", () => {
        anchoredHome();
        expect(locateExistingOutputDir(analysis())._unsafeUnwrap()).toBeNull();
    });

    test("an unlocatable folder → workspace_unavailable", () => {
        const gone = tmp();
        insertAnchorAt("A1", gone);
        rmSync(gone, { recursive: true, force: true });
        expect(locateExistingOutputDir(analysis())._unsafeUnwrapErr().type).toBe("workspace_unavailable");
    });
});

describe("workspaceDataDir", () => {
    test("appends data/ to the resolved workspace root", () => {
        const home = anchoredHome();
        expect(workspaceDataDir(analysis())._unsafeUnwrap()).toBe(join(home, ".inflexa", "analyses", "myslug", "data"));
    });

    test("propagates the root's workspace_unavailable unchanged", () => {
        const gone = tmp();
        insertAnchorAt("A1", gone);
        rmSync(gone, { recursive: true, force: true });
        expect(workspaceDataDir(analysis())._unsafeUnwrapErr().type).toBe("workspace_unavailable");
    });
});

describe("workspaceRootForAnalysisId", () => {
    test("looks up the analysis row by id and resolves its workspace root", () => {
        const home = anchoredHome();
        insertAnalysis(analysis())._unsafeUnwrap();
        expect(workspaceRootForAnalysisId("ana1")._unsafeUnwrap()).toBe(join(home, ".inflexa", "analyses", "myslug"));
    });

    test("an unknown id → workspace_unavailable (a deleted row has no workspace), not a DbError", () => {
        expect(workspaceRootForAnalysisId("ghost")._unsafeUnwrapErr().type).toBe("workspace_unavailable");
    });

    test("memoizes a resolved root, and `invalidateWorkspaceRoot` forces a re-derivation", () => {
        anchoredHome();
        insertAnalysis(analysis())._unsafeUnwrap();
        const first = workspaceRootForAnalysisId("ana1")._unsafeUnwrap();

        // Drop the row the derivation reads. Only a memo hit can still answer; a fresh derivation
        // would report the analysis gone.
        deleteAnalysis("ana1")._unsafeUnwrap();
        expect(workspaceRootForAnalysisId("ana1")._unsafeUnwrap()).toBe(first);

        invalidateWorkspaceRoot("ana1");
        expect(workspaceRootForAnalysisId("ana1")._unsafeUnwrapErr().type).toBe("workspace_unavailable");
    });

    test("never caches a failure — the user may be fixing the folder between calls", () => {
        const home = anchoredHome();
        insertAnalysis(analysis())._unsafeUnwrap();
        chmodSync(home, 0o555);
        expect(workspaceRootForAnalysisId("ana1")._unsafeUnwrapErr().type).toBe("workspace_unavailable");

        chmodSync(home, 0o755);
        expect(workspaceRootForAnalysisId("ana1")._unsafeUnwrap()).toBe(join(home, ".inflexa", "analyses", "myslug"));
    });
});

describe("disposeWorkspace", () => {
    /** Seed a live workspace tree with one run artifact in it. Returns the anchor home. */
    function seedWorkspace(): string {
        const home = anchoredHome();
        insertAnalysis(analysis())._unsafeUnwrap();
        const root = join(home, ".inflexa", "analyses", "myslug");
        mkdirSync(join(root, "runs", "run-1"), { recursive: true });
        writeFileSync(join(root, "runs", "run-1", "result.csv"), "gene,count");
        return home;
    }

    test("archive moves the tree out of analyses/ and keeps its contents", () => {
        const home = seedWorkspace();

        const outcome = disposeWorkspace(analysis(), "archive")._unsafeUnwrap();
        expect(outcome.kind).toBe("archived");

        expect(existsSync(join(home, ".inflexa", "analyses", "myslug"))).toBe(false);
        const archived = join(home, archivedOutputSubdir("myslug"));
        expect(readFileSync(join(archived, "runs", "run-1", "result.csv"), "utf-8")).toBe("gene,count");
    });

    // The whole point: a freed slug must not resolve onto its predecessor's artifacts.
    test("after archiving, the live slug path is free for a new analysis of the same name", () => {
        const home = seedWorkspace();
        disposeWorkspace(analysis(), "archive")._unsafeUnwrap();
        expect(existsSync(join(home, ".inflexa", "analyses", "myslug", "runs"))).toBe(false);
    });

    test("archiving the same slug twice suffixes rather than clobbering the first archive", () => {
        const home = seedWorkspace();
        disposeWorkspace(analysis(), "archive")._unsafeUnwrap();

        // A second analysis takes the freed slug, then is itself deleted.
        mkdirSync(join(home, ".inflexa", "analyses", "myslug"), { recursive: true });
        writeFileSync(join(home, ".inflexa", "analyses", "myslug", "second.txt"), "second");
        const outcome = disposeWorkspace(analysis(), "archive")._unsafeUnwrap();

        expect(outcome.kind === "archived" && outcome.path.endsWith("myslug-2")).toBe(true);
        // The first archive is untouched.
        expect(existsSync(join(home, archivedOutputSubdir("myslug"), "runs", "run-1", "result.csv"))).toBe(true);
        expect(readFileSync(join(home, `${archivedOutputSubdir("myslug")}-2`, "second.txt"), "utf-8")).toBe("second");
    });

    test("delete removes the tree and archives nothing", () => {
        const home = seedWorkspace();

        expect(disposeWorkspace(analysis(), "delete")._unsafeUnwrap().kind).toBe("deleted");
        expect(existsSync(join(home, ".inflexa", "analyses", "myslug"))).toBe(false);
        expect(existsSync(join(home, ".inflexa", "analyses_archived"))).toBe(false);
    });

    test("a never-created tree is `absent`, not an error", () => {
        anchoredHome();
        insertAnalysis(analysis())._unsafeUnwrap();
        expect(disposeWorkspace(analysis(), "archive")._unsafeUnwrap().kind).toBe("absent");
    });

    test("an unlocatable anchor is `absent` — the tree lived inside the folder that vanished", () => {
        const gone = tmp();
        insertAnchorAt("A1", gone);
        rmSync(gone, { recursive: true, force: true });
        expect(disposeWorkspace(analysis(), "archive")._unsafeUnwrap().kind).toBe("absent");
    });

    // The delete flow disposes BEFORE dropping the row precisely so this failure changes nothing.
    test("a tree that cannot be moved is an err, and the tree survives", () => {
        const home = seedWorkspace();
        // Read-only `.inflexa/` blocks both the archive mkdir and the rename out of `analyses/`.
        chmodSync(join(home, ".inflexa"), 0o555);
        try {
            expect(disposeWorkspace(analysis(), "archive")._unsafeUnwrapErr().type).toBe("mutation_failed");
            expect(existsSync(join(home, ".inflexa", "analyses", "myslug", "runs", "run-1", "result.csv"))).toBe(true);
        } finally {
            chmodSync(join(home, ".inflexa"), 0o755);
        }
    });
});
