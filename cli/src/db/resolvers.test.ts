import { beforeEach, describe, expect, test } from "bun:test";

import { freshDb } from "../test_support/db.ts";
import { createProject, insertAnalysis, insertAnchor } from "./primary_mutation.ts";
import { findAnalysesByRef, findProjectByRef } from "./primary_query.ts";
import { matchAnalysis } from "../modules/analysis/analysis.ts";
import { asStr256 } from "../lib/types.ts";
import type { Anchor } from "../types/anchor.ts";

beforeEach(() => {
    freshDb();
});

function anchor(id: string): Anchor {
    return { id, createdAt: 1, updatedAt: 1, cachedPath: "/tmp/x", markerWritten: true, lastSeen: 1 };
}

// Seed an analysis with a caller-chosen id (insertAnalysis takes a fully-formed row), so the
// id-first ordering can be exercised deterministically. Requires its anchor to exist (FK).
function seedAnalysis(id: string, name: string, slug: string, anchorId: string): void {
    insertAnalysis({
        id,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        name: asStr256(name),
        slug,
        anchorId,
        projectId: null,
    })._unsafeUnwrap();
}

describe("findProjectByRef", () => {
    test("resolves by id and by name", () => {
        const project = createProject({ name: asStr256("Acme"), description: null, tags: [] })._unsafeUnwrap();
        expect(findProjectByRef(project.id)._unsafeUnwrap()?.id).toBe(project.id);
        expect(findProjectByRef("Acme")._unsafeUnwrap()?.id).toBe(project.id);
    });

    test("prefers an id match over a name match (single id-priority query)", () => {
        const first = createProject({ name: asStr256("First"), description: null, tags: [] })._unsafeUnwrap();
        // A second project whose NAME equals the first's id — so the ref matches two different rows.
        createProject({ name: asStr256(first.id), description: null, tags: [] })._unsafeUnwrap();
        expect(findProjectByRef(first.id)._unsafeUnwrap()?.id).toBe(first.id);
    });

    test("returns null when nothing matches", () => {
        expect(findProjectByRef("ghost")._unsafeUnwrap()).toBeNull();
    });
});

describe("findAnalysesByRef", () => {
    test("sorts an exact id match first, ahead of name/slug matches", () => {
        insertAnchor(anchor("ah1"))._unsafeUnwrap();
        insertAnchor(anchor("ah2"))._unsafeUnwrap();
        seedAnalysis("X", "by-id", "by-id-slug", "ah1"); // id === "X"
        seedAnalysis("other", "X", "x-slug", "ah2"); // name === "X"
        const rows = findAnalysesByRef("X")._unsafeUnwrap();
        expect(rows.length).toBeGreaterThanOrEqual(2);
        expect(rows[0]?.id).toBe("X");
    });
});

describe("matchAnalysis", () => {
    test("surfaces same-name siblings as `others`", () => {
        insertAnchor(anchor("ah1"))._unsafeUnwrap();
        insertAnchor(anchor("ah2"))._unsafeUnwrap();
        // Same name under two anchors is allowed — UNIQUE is on (anchor_id, slug), not name.
        seedAnalysis("id1", "Dup", "dup", "ah1");
        seedAnalysis("id2", "Dup", "dup", "ah2");
        const match = matchAnalysis("Dup")._unsafeUnwrap();
        expect(match?.others).toHaveLength(1);
    });

    test("returns no `others` for an exact id match (ids are unique)", () => {
        insertAnchor(anchor("ah1"))._unsafeUnwrap();
        seedAnalysis("solo-id", "Solo", "solo", "ah1");
        const match = matchAnalysis("solo-id")._unsafeUnwrap();
        expect(match?.analysis.id).toBe("solo-id");
        expect(match?.others).toEqual([]);
    });

    test("returns null when nothing matches", () => {
        expect(matchAnalysis("nope")._unsafeUnwrap()).toBeNull();
    });
});
