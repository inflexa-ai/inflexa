import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { freshDb } from "../../test_support/db.ts";
import { resolveOutputDir, workspaceDataDir, workspaceRootForAnalysisId } from "./output.ts";
import { writeMarker } from "../anchor/marker.ts";
import { insertAnalysis, insertAnchor } from "../../db/primary_mutation.ts";
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
});
