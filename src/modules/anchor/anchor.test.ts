import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { freshDb } from "../../test_support/db.ts";
import { classifyMarkerSighting, resolveAnchor } from "./anchor.ts";
import { canonicalPath, writeMarker } from "./marker.ts";
import { insertAnchor } from "../../db/primary_mutation.ts";
import { getAnchor } from "../../db/primary_query.ts";
import type { Anchor, AnchorMarker } from "../../types/anchor.ts";

const created: string[] = [];

function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), "inflexa-anchor-"));
    created.push(dir);
    return dir;
}

function insertAnchorRow(id: string, cachedPath: string): void {
    const row: Anchor = { id, createdAt: 1, updatedAt: 1, cachedPath, markerWritten: true, lastSeen: 1 };
    insertAnchor(row)._unsafeUnwrap();
}

function marker(anchorId: string): AnchorMarker {
    return { schemaVersion: 1, anchorId };
}

beforeEach(() => {
    freshDb();
});

afterEach(() => {
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
    created.length = 0;
});

describe("resolveAnchor", () => {
    test("step 1 — returns the cached path when it still holds the marker", () => {
        const dir = tmp();
        writeMarker(dir, "A1");
        insertAnchorRow("A1", dir);
        expect(resolveAnchor("A1", { searchRoots: [dir] })._unsafeUnwrap()?.path).toBe(dir);
    });

    test("missing row — resolves to null (a marker/DB desync is not an error)", () => {
        // No anchor row: the user deleted/edited their local DB while a marker still references it.
        // resolveAnchor must degrade to null, NOT a query_failed error, or bare `inflexa` crashes.
        // _unsafeUnwrap throws on an Err, so a null return proves both "is ok" and "value is null".
        expect(resolveAnchor("ghost", { searchRoots: [tmp()] })._unsafeUnwrap()).toBeNull();
    });

    test("step 2 — self-heals to a search root that holds the marker after a move", () => {
        const moved = tmp();
        const stale = tmp(); // cached path, marker no longer here
        writeMarker(moved, "A1");
        insertAnchorRow("A1", stale);

        const result = resolveAnchor("A1", { searchRoots: [moved] })._unsafeUnwrap();
        expect(result?.path).toBe(canonicalPath(moved));
        // The drifted cached path was healed to the new (canonical) location.
        expect(getAnchor("A1")._unsafeUnwrap()?.cachedPath).toBe(canonicalPath(moved));
    });

    test("step 3 — leaves path null when the marker can't be located (never guesses)", () => {
        const gone = tmp();
        insertAnchorRow("A1", gone);
        rmSync(gone, { recursive: true, force: true }); // cached path gone, no marker anywhere
        const elsewhere = tmp(); // a search root with no matching marker

        expect(resolveAnchor("A1", { searchRoots: [elsewhere] })._unsafeUnwrap()?.path).toBeNull();
    });
});

describe("classifyMarkerSighting", () => {
    test("ok — no existing anchor row to conflict with", () => {
        expect(classifyMarkerSighting(tmp(), marker("ghost"))._unsafeUnwrap()).toBe("ok");
    });

    test("ok — the marker is sighted at the anchor's known location", () => {
        const dir = tmp();
        insertAnchorRow("A1", dir);
        expect(classifyMarkerSighting(dir, marker("A1"))._unsafeUnwrap()).toBe("ok");
    });

    test("copy — the original cached path still exists elsewhere", () => {
        const original = tmp();
        const copy = tmp();
        insertAnchorRow("A1", original); // original still on disk
        expect(classifyMarkerSighting(copy, marker("A1"))._unsafeUnwrap()).toBe("copy");
    });

    test("move — the original cached path is gone", () => {
        const gone = tmp();
        const moved = tmp();
        insertAnchorRow("A1", gone);
        rmSync(gone, { recursive: true, force: true });
        expect(classifyMarkerSighting(moved, marker("A1"))._unsafeUnwrap()).toBe("move");
    });
});
