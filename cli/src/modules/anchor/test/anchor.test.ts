import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { freshDb } from "../../../test_support/db.ts";
import { hungMarker, releaseHungMarker } from "../../../test_support/hung_marker.ts";
import { classifyMarkerSighting, getOrCreateAnchorForCwd, giveCopyNewIdentity, resolveAnchor } from "../anchor.ts";
import { canonicalPathAsync } from "../../../lib/paths.ts";
import { readMarker, writeMarker } from "../marker.ts";
import { insertAnchor } from "../../../db/primary_mutation.ts";
import { getAnchor } from "../../../db/primary_query.ts";
import type { Anchor, AnchorMarker } from "../../../types/anchor.ts";

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
    test("step 1 — returns the cached path when it still holds the marker", async () => {
        const dir = tmp();
        (await writeMarker(dir, "A1"))._unsafeUnwrap();
        insertAnchorRow("A1", dir);
        expect((await resolveAnchor("A1", { searchRoots: [dir] }))._unsafeUnwrap()?.path).toBe(dir);
    });

    test("missing row — resolves to null (a marker/DB desync is not an error)", async () => {
        // No anchor row: the user deleted/edited their local DB while a marker still references it.
        // resolveAnchor must degrade to null, NOT a query_failed error, or bare `inflexa` crashes.
        // _unsafeUnwrap throws on an Err, so a null return proves both "is ok" and "value is null".
        expect((await resolveAnchor("ghost", { searchRoots: [tmp()] }))._unsafeUnwrap()).toBeNull();
    });

    test("step 2 — self-heals to a search root that holds the marker after a move", async () => {
        const moved = tmp();
        const stale = tmp(); // cached path, marker no longer here
        (await writeMarker(moved, "A1"))._unsafeUnwrap();
        insertAnchorRow("A1", stale);

        const result = (await resolveAnchor("A1", { searchRoots: [moved] }))._unsafeUnwrap();
        expect(result?.path).toBe(await canonicalPathAsync(moved));
        // The drifted cached path was healed to the new (canonical) location.
        expect(getAnchor("A1")._unsafeUnwrap()?.cachedPath).toBe(await canonicalPathAsync(moved));
    });

    test("step 3 — leaves path null when the marker can't be located (never guesses)", async () => {
        const gone = tmp();
        insertAnchorRow("A1", gone);
        rmSync(gone, { recursive: true, force: true }); // cached path gone, no marker anywhere
        const elsewhere = tmp(); // a search root with no matching marker

        expect((await resolveAnchor("A1", { searchRoots: [elsewhere] }))._unsafeUnwrap()?.path).toBeNull();
    });

    test("a marker read that does not answer counts as no match, and the resolve ends", async () => {
        const hung = tmp();
        const pipe = hungMarker(hung);
        insertAnchorRow("A1", hung);
        try {
            expect((await resolveAnchor("A1", { searchRoots: [tmp()] }))._unsafeUnwrap()?.path).toBeNull();
        } finally {
            releaseHungMarker(pipe);
        }
    }, 10_000);

    test("step 3 — a miss is remembered: the same resolve does not search the known folders again", async () => {
        const gone = tmp();
        insertAnchorRow("A1", gone);
        rmSync(gone, { recursive: true, force: true });
        const known = tmp();
        insertAnchorRow("B1", known);
        const elsewhere = tmp();
        expect((await resolveAnchor("A1", { searchRoots: [elsewhere] }))._unsafeUnwrap()?.path).toBeNull();

        // The folder of A1 now sits at a known anchor folder, which only the search reads.
        (await writeMarker(known, "A1"))._unsafeUnwrap();
        expect((await resolveAnchor("A1", { searchRoots: [elsewhere] }))._unsafeUnwrap()?.path).toBeNull();
        // A resolve from different roots searches a different set of folders.
        expect((await resolveAnchor("A1", { searchRoots: [tmp()] }))._unsafeUnwrap()?.path).toBe(await canonicalPathAsync(known));
    });
});

describe("classifyMarkerSighting", () => {
    test("ok — no existing anchor row to conflict with", async () => {
        expect((await classifyMarkerSighting(tmp(), marker("ghost")))._unsafeUnwrap()).toEqual({ kind: "ok" });
    });

    test("ok — the marker is sighted at the anchor's known location", async () => {
        const dir = tmp();
        insertAnchorRow("A1", dir);
        expect((await classifyMarkerSighting(dir, marker("A1")))._unsafeUnwrap()).toEqual({ kind: "ok" });
    });

    test("copy — the original cached path still holds the same marker", async () => {
        const original = tmp();
        const copy = tmp();
        (await writeMarker(original, "A1"))._unsafeUnwrap();
        insertAnchorRow("A1", original);
        expect((await classifyMarkerSighting(copy, marker("A1")))._unsafeUnwrap()).toEqual({ kind: "copy", original: await canonicalPathAsync(original) });
    });

    test("move — a new folder at the old path, with no marker, is not the original", async () => {
        const reused = tmp();
        const moved = tmp();
        insertAnchorRow("A1", reused);
        expect((await classifyMarkerSighting(moved, marker("A1")))._unsafeUnwrap()).toEqual({ kind: "move" });
    });

    test("move — the original cached path is gone", async () => {
        const gone = tmp();
        const moved = tmp();
        insertAnchorRow("A1", gone);
        rmSync(gone, { recursive: true, force: true });
        expect((await classifyMarkerSighting(moved, marker("A1")))._unsafeUnwrap()).toEqual({ kind: "move" });
    });
});

describe("a duplicated project folder", () => {
    /** `cp -r original copy`: the copy carries the marker of the original, and the row still points at the original. */
    async function duplicate(): Promise<{ original: string; copy: string }> {
        const original = await canonicalPathAsync(tmp());
        const copy = await canonicalPathAsync(tmp());
        (await writeMarker(original, "A1"))._unsafeUnwrap();
        (await writeMarker(copy, "A1"))._unsafeUnwrap();
        insertAnchorRow("A1", original);
        return { original, copy };
    }

    test("the ensure of the copy refuses it and leaves the anchor at the original", async () => {
        const { original, copy } = await duplicate();
        expect((await getOrCreateAnchorForCwd(copy))._unsafeUnwrapErr()).toEqual({ type: "folder_is_copy", dir: copy, original });
        expect(getAnchor("A1")._unsafeUnwrap()?.cachedPath).toBe(original);
    });

    test("the ensure of a moved folder still heals the cached path", async () => {
        const reused = tmp();
        const moved = await canonicalPathAsync(tmp());
        (await writeMarker(moved, "A1"))._unsafeUnwrap();
        insertAnchorRow("A1", reused);
        expect((await getOrCreateAnchorForCwd(moved))._unsafeUnwrap().cachedPath).toBe(moved);
    });

    test("a new identity gives the copy its own marker and anchor, and the original keeps its own", async () => {
        const { original, copy } = await duplicate();
        const outcome = (await giveCopyNewIdentity(copy))._unsafeUnwrap();
        expect(outcome).toMatchObject({ previousAnchorId: "A1", path: copy, original });
        expect(outcome.anchorId).not.toBe("A1");
        expect((await readMarker(copy))._unsafeUnwrap()?.anchorId).toBe(outcome.anchorId);
        expect((await readMarker(original))._unsafeUnwrap()).toEqual(marker("A1"));
        expect(getAnchor(outcome.anchorId)._unsafeUnwrap()?.cachedPath).toBe(copy);
        expect(getAnchor("A1")._unsafeUnwrap()?.cachedPath).toBe(original);
        expect((await classifyMarkerSighting(copy, marker(outcome.anchorId)))._unsafeUnwrap()).toEqual({ kind: "ok" });
    });

    test("a new identity refuses a folder that is not a copy, and changes nothing", async () => {
        const dir = await canonicalPathAsync(tmp());
        (await writeMarker(dir, "A1"))._unsafeUnwrap();
        insertAnchorRow("A1", dir);
        expect((await giveCopyNewIdentity(dir))._unsafeUnwrapErr()).toEqual({ type: "not_a_copy", dir });
        expect((await readMarker(dir))._unsafeUnwrap()?.anchorId).toBe("A1");
    });
});
