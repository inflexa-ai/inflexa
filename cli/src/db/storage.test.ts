import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import type { Database } from "bun:sqlite";

import { freshDb } from "../test_support/db.ts";
import { db } from "./primary.ts";
import {
    addPin,
    createProject,
    deleteAnalysis,
    deleteProject,
    insertAnalysis,
    insertAnchor,
    recordAnalysisActivity,
    recordRecentFile,
    recordRunSeen,
    removePin,
    renameAnalysis,
    updateAnalysisProject,
} from "./primary_mutation.ts";
import {
    findProjectByRef,
    getAnchor,
    getProjectWithCount,
    getRunSeenBaseline,
    listAnalysisNames,
    listAnalysisPage,
    listPins,
    listRecentFiles,
    listSeenRunIds,
} from "./primary_query.ts";
import { asStr256 } from "../lib/types.ts";
import type { Anchor } from "../types/anchor.ts";
import type { Analysis } from "../types/analysis.ts";

// freshDb() resets + re-migrates the singleton DB before each test; the mutation/query functions
// drive that same connection (they call db() internally), so writes are read back through the real
// query layer. FK enforcement is ON (db() sets PRAGMA foreign_keys), which the chain + FK test rely on.
beforeEach(() => {
    freshDb();
});

/** The shared connection that the db functions drive, without a reset. */
function sharedConn(): Database {
    return db()._unsafeUnwrap();
}

function anchor(id: string, overrides: Partial<Anchor> = {}): Anchor {
    return { id, createdAt: 1, updatedAt: 1, cachedPath: "/tmp/x", markerWritten: true, lastSeen: 1, ...overrides };
}

describe("project round-trip", () => {
    test("a created project reads back with identical fields", () => {
        const created = createProject({ name: asStr256("Acme"), description: "a desc", tags: ["a", "b"] })._unsafeUnwrap();
        expect(findProjectByRef(created.id)._unsafeUnwrap()).toEqual(created);
    });

    test("tags round-trip through the comma-join losslessly, and [] stays []", () => {
        const tagged = createProject({ name: asStr256("Tagged"), description: null, tags: ["x", "y", "z"] })._unsafeUnwrap();
        expect(findProjectByRef(tagged.id)._unsafeUnwrap()?.tags).toEqual(["x", "y", "z"]);
        const none = createProject({ name: asStr256("NoTags"), description: null, tags: [] })._unsafeUnwrap();
        expect(findProjectByRef(none.id)._unsafeUnwrap()?.tags).toEqual([]);
    });
});

describe("anchor round-trip", () => {
    test("an inserted anchor reads back (marker_written 0/1 → boolean)", () => {
        const written = insertAnchor(anchor("anc-a", { cachedPath: "/home/p", markerWritten: false }))._unsafeUnwrap();
        expect(getAnchor("anc-a")._unsafeUnwrap()).toEqual(written);
    });

    test("a missing anchor reads back as null on the ok channel (absence is not an error)", () => {
        expect(getAnchor("does-not-exist")._unsafeUnwrap()).toBeNull();
    });
});

describe("DbError constraint classification", () => {
    test("a duplicate project name is a unique violation", () => {
        createProject({ name: asStr256("Dup"), description: null, tags: [] })._unsafeUnwrap();
        createProject({ name: asStr256("Dup"), description: null, tags: [] }).match(
            () => {
                throw new Error("expected a unique violation");
            },
            (e) => {
                expect(e.type).toBe("constraint_violation");
                if (e.type === "constraint_violation") expect(e.constraint).toBe("unique");
            },
        );
    });

    test("an analysis referencing a missing anchor is a foreign_key violation", () => {
        const orphan: Analysis = {
            id: "ana-fk",
            createdAt: 1,
            updatedAt: 1,
            name: asStr256("Orphan"),
            slug: "orphan",
            anchorId: "ghost-anchor",
            projectId: null,
        };
        insertAnalysis(orphan).match(
            () => {
                throw new Error("expected a foreign_key violation");
            },
            (e) => {
                expect(e.type).toBe("constraint_violation");
                if (e.type === "constraint_violation") expect(e.constraint).toBe("foreign_key");
            },
        );
    });

    test("a null in a NOT NULL column is a not_null violation", () => {
        // Deliberately violate the type to drive the NOT NULL path: anchors.cached_path is NOT NULL,
        // but the typed Anchor forbids null — cast through unknown to force the DB-level error.
        const bad = anchor("anc-null", { cachedPath: null as unknown as string });
        insertAnchor(bad).match(
            () => {
                throw new Error("expected a not_null violation");
            },
            (e) => {
                expect(e.type).toBe("constraint_violation");
                if (e.type === "constraint_violation") expect(e.constraint).toBe("not_null");
            },
        );
    });
});

function analysis(id: string, createdAt: number, overrides: Partial<Analysis> = {}): Analysis {
    return { id, createdAt, updatedAt: createdAt, name: asStr256(id), slug: id, anchorId: "anc", projectId: null, ...overrides };
}

/** The activity time of one analysis, read through the list page: the column stays off the entity. */
function activityOf(id: string): number | undefined {
    const page = listAnalysisPage({ projectId: null, sort: "created", limit: 100, offset: 0 })._unsafeUnwrap();
    return page.items.find((item) => item.analysis.id === id)?.lastActivityAt;
}

describe("the activity time of an analysis", () => {
    beforeEach(() => {
        insertAnchor(anchor("anc"))._unsafeUnwrap();
    });

    test("an inserted analysis has its creation time as its activity time", () => {
        insertAnalysis(analysis("a1", 5_000))._unsafeUnwrap();
        expect(activityOf("a1")).toBe(5_000);
    });

    test("recordAnalysisActivity raises the time, never lowers it, and leaves updated_at alone", () => {
        insertAnalysis(analysis("a1", 5_000))._unsafeUnwrap();

        expect(recordAnalysisActivity("a1", 9_000)._unsafeUnwrap()).toBe(1);
        expect(activityOf("a1")).toBe(9_000);
        expect(recordAnalysisActivity("a1", 8_000)._unsafeUnwrap()).toBe(1);
        expect(activityOf("a1")).toBe(9_000);

        const page = listAnalysisPage({ projectId: null, sort: "created", limit: 10, offset: 0 })._unsafeUnwrap();
        expect(page.items[0]?.analysis.updatedAt).toBe(5_000);
    });

    test("recordAnalysisActivity changes 0 rows for an unknown id", () => {
        expect(recordAnalysisActivity("nope", 9_000)._unsafeUnwrap()).toBe(0);
    });

    test("a rename, a project change, and a project delete raise the time to their write time, never lower", () => {
        const project = createProject({ name: asStr256("Acme"), description: null, tags: [] })._unsafeUnwrap();
        insertAnalysis(analysis("a1", 1_000))._unsafeUnwrap();
        insertAnalysis(analysis("a2", 1_000))._unsafeUnwrap();
        insertAnalysis(analysis("a3", 1_000, { projectId: project.id }))._unsafeUnwrap();
        const before = Date.now();

        renameAnalysis("a1", asStr256("renamed"), "renamed")._unsafeUnwrap();
        updateAnalysisProject("a2", project.id)._unsafeUnwrap();
        deleteProject(project.id)._unsafeUnwrap();

        for (const id of ["a1", "a2", "a3"]) {
            const item = listAnalysisPage({ projectId: null, sort: "created", limit: 10, offset: 0 })
                ._unsafeUnwrap()
                .items.find((i) => i.analysis.id === id);
            expect(item?.lastActivityAt).toBe(item?.analysis.updatedAt as number);
            expect(item?.lastActivityAt).toBeGreaterThanOrEqual(before);
        }

        recordAnalysisActivity("a1", Date.now() + 100_000)._unsafeUnwrap();
        const later = activityOf("a1") as number;
        renameAnalysis("a1", asStr256("again"), "again")._unsafeUnwrap();
        expect(activityOf("a1")).toBe(later);
    });
});

describe("the analysis page orders", () => {
    beforeEach(() => {
        insertAnchor(anchor("anc"))._unsafeUnwrap();
    });

    test("activity puts an older analysis with newer activity first, and created does not", () => {
        insertAnalysis(analysis("old", 1_000))._unsafeUnwrap();
        insertAnalysis(analysis("new", 2_000))._unsafeUnwrap();
        recordAnalysisActivity("old", 3_000)._unsafeUnwrap();

        const ids = (sort: "activity" | "created") =>
            listAnalysisPage({ projectId: null, sort, limit: 10, offset: 0 })
                ._unsafeUnwrap()
                .items.map((item) => item.analysis.id);

        expect(ids("activity")).toEqual(["old", "new"]);
        expect(ids("created")).toEqual(["new", "old"]);
    });

    test("each order breaks a tie with the id, thus two pages never overlap", () => {
        for (const id of ["a", "b", "c"]) insertAnalysis(analysis(id, 1_000))._unsafeUnwrap();

        for (const sort of ["activity", "created"] as const) {
            const first = listAnalysisPage({ projectId: null, sort, limit: 2, offset: 0 })._unsafeUnwrap();
            const second = listAnalysisPage({ projectId: null, sort, limit: 2, offset: 2 })._unsafeUnwrap();
            expect(first.items.map((item) => item.analysis.id)).toEqual(["c", "b"]);
            expect(second.items.map((item) => item.analysis.id)).toEqual(["a"]);
            expect(first.total).toBe(3);
        }
    });

    test("the project filter applies to the activity order", () => {
        const project = createProject({ name: asStr256("Acme"), description: null, tags: [] })._unsafeUnwrap();
        insertAnalysis(analysis("in-1", 1_000, { projectId: project.id }))._unsafeUnwrap();
        insertAnalysis(analysis("in-2", 2_000, { projectId: project.id }))._unsafeUnwrap();
        insertAnalysis(analysis("out", 3_000))._unsafeUnwrap();
        recordAnalysisActivity("in-1", 9_000)._unsafeUnwrap();

        const page = listAnalysisPage({ projectId: project.id, sort: "activity", limit: 10, offset: 0 })._unsafeUnwrap();

        expect(page.items.map((item) => item.analysis.id)).toEqual(["in-1", "in-2"]);
        expect(page.total).toBe(2);
    });
});

describe("getProjectWithCount", () => {
    test("gives the project with its analysis count, null for an unknown id, and null for a name", () => {
        insertAnchor(anchor("anc"))._unsafeUnwrap();
        const project = createProject({ name: asStr256("trial-42"), description: null, tags: [] })._unsafeUnwrap();
        insertAnalysis(analysis("a1", 1_000, { projectId: project.id }))._unsafeUnwrap();
        insertAnalysis(analysis("a2", 2_000, { projectId: project.id }))._unsafeUnwrap();

        expect(getProjectWithCount(project.id)._unsafeUnwrap()).toEqual({ project, analysisCount: 2 });
        expect(getProjectWithCount("nope")._unsafeUnwrap()).toBeNull();
        expect(getProjectWithCount("trial-42")._unsafeUnwrap()).toBeNull();
    });
});

describe("the seen state of the runs", () => {
    beforeEach(() => {
        insertAnchor(anchor("anc"))._unsafeUnwrap();
        insertAnalysis(analysis("a1", 1_000))._unsafeUnwrap();
        insertAnalysis(analysis("a2", 1_000))._unsafeUnwrap();
    });

    test("a second mark of a run changes 0 rows and keeps the first time", () => {
        expect(recordRunSeen("r1", "a1", 5_000)._unsafeUnwrap()).toBe(1);
        expect(recordRunSeen("r1", "a1", 6_000)._unsafeUnwrap()).toBe(0);

        const seenAt = sharedConn().query("SELECT seen_at FROM run_seen_marks WHERE run_id = 'r1'").get();
        expect(seenAt).toEqual({ seen_at: 5_000 });
    });

    test("the baseline is the time of the migration", () => {
        expect(getRunSeenBaseline()._unsafeUnwrap()).toBeGreaterThan(0);
    });

    test("the seen lookup gives the ids of the list that have a mark", () => {
        recordRunSeen("r1", "a1", 5_000)._unsafeUnwrap();
        recordRunSeen("r2", "a2", 5_000)._unsafeUnwrap();
        recordRunSeen("r3", "a2", 5_000)._unsafeUnwrap();

        expect(listSeenRunIds(["r1", "r2", "unseen", "r1"])._unsafeUnwrap()).toEqual(new Set(["r1", "r2"]));
    });

    test("an empty list gives an empty set and sends no query", () => {
        const query = spyOn(sharedConn(), "query");

        expect(listSeenRunIds([])._unsafeUnwrap()).toEqual(new Set());
        expect(query).not.toHaveBeenCalled();
    });

    test("a list sends one query", () => {
        const query = spyOn(sharedConn(), "query");

        listSeenRunIds(["r1", "r2", "unseen"])._unsafeUnwrap();

        expect(query).toHaveBeenCalledTimes(1);
    });

    test("the delete of an analysis removes its marks and keeps the others", () => {
        recordRunSeen("r1", "a1", 5_000)._unsafeUnwrap();
        recordRunSeen("r2", "a1", 5_000)._unsafeUnwrap();
        recordRunSeen("r3", "a2", 5_000)._unsafeUnwrap();

        deleteAnalysis("a1")._unsafeUnwrap();

        expect(listSeenRunIds(["r1", "r2", "r3"])._unsafeUnwrap()).toEqual(new Set(["r3"]));
    });

    test("a mark of an analysis with no row is a foreign_key violation", () => {
        recordRunSeen("r1", "ghost", 5_000).match(
            () => {
                throw new Error("expected a foreign_key violation");
            },
            (e) => {
                expect(e.type).toBe("constraint_violation");
                if (e.type === "constraint_violation") expect(e.constraint).toBe("foreign_key");
            },
        );
    });

    test("an absent baseline row gives a null baseline and keeps the marks", () => {
        recordRunSeen("r1", "a1", 5_000)._unsafeUnwrap();
        sharedConn().run("DELETE FROM run_seen_baseline");

        expect(getRunSeenBaseline()._unsafeUnwrap()).toBeNull();
        expect(listSeenRunIds(["r1"])._unsafeUnwrap()).toEqual(new Set(["r1"]));
    });
});

describe("the names of a list of analyses", () => {
    beforeEach(() => {
        insertAnchor(anchor("anc"))._unsafeUnwrap();
        insertAnalysis(analysis("a1", 1_000, { name: asStr256("trial"), slug: "trial" }))._unsafeUnwrap();
        insertAnalysis(analysis("a2", 1_000, { name: asStr256("bulk"), slug: "bulk" }))._unsafeUnwrap();
    });

    test("an id with no row has no entry", () => {
        const names = listAnalysisNames(["a1", "a2", "gone", "a1"])._unsafeUnwrap();

        expect(names).toEqual(
            new Map([
                ["a1", "trial"],
                ["a2", "bulk"],
            ]),
        );
    });

    test("an empty list gives an empty map and sends no query", () => {
        const conn = sharedConn();
        const query = spyOn(conn, "query");

        expect(listAnalysisNames([])._unsafeUnwrap()).toEqual(new Map());
        expect(query).not.toHaveBeenCalled();
    });

    test("a list past the ceiling of bound parameters gives the known names with no error", () => {
        const unknown = Array.from({ length: 40_000 }, (_, i) => `ghost-${i}`);

        const names = listAnalysisNames(["a1", ...unknown, "a2"])._unsafeUnwrap();

        expect(names).toEqual(
            new Map([
                ["a1", "trial"],
                ["a2", "bulk"],
            ]),
        );
    });

    test("a list sends one query", () => {
        const query = spyOn(sharedConn(), "query");

        listAnalysisNames(["a1", "a2", "gone"])._unsafeUnwrap();

        expect(query).toHaveBeenCalledTimes(1);
    });
});

describe("the pins of the picker", () => {
    test("the pins come oldest first, and a page counts all of them", () => {
        addPin({ path: "/b", label: null, isDir: true })._unsafeUnwrap();
        addPin({ path: "/a", label: null, isDir: true })._unsafeUnwrap();

        const page = listPins({ limit: 1, offset: 0 })._unsafeUnwrap();

        expect(page.items.map((p) => p.path)).toEqual(["/b"]);
        expect(page.total).toBe(2);
        expect(
            listPins({ limit: 1, offset: 1 })
                ._unsafeUnwrap()
                .items.map((p) => p.path),
        ).toEqual(["/a"]);
    });

    test("a pin round-trips with its label and its kind", () => {
        const { pin, created } = addPin({ path: "/data/study", label: "Study", isDir: true })._unsafeUnwrap();

        expect(created).toBe(true);
        expect(listPins({ limit: 10, offset: 0 })._unsafeUnwrap().items).toEqual([pin]);
        expect(pin).toMatchObject({ path: "/data/study", label: "Study", isDir: true });
    });

    test("a second add of a path keeps the first pin", () => {
        const first = addPin({ path: "/data/study", label: "Study", isDir: true })._unsafeUnwrap();

        const second = addPin({ path: "/data/study", label: "Other", isDir: true })._unsafeUnwrap();

        expect(second.created).toBe(false);
        expect(second.pin).toEqual(first.pin);
        expect(listPins({ limit: 10, offset: 0 })._unsafeUnwrap().total).toBe(1);
    });

    test("a removal returns 1 for a pin and 0 for an unknown id", () => {
        const { pin } = addPin({ path: "/d", label: null, isDir: true })._unsafeUnwrap();

        expect(removePin(pin.id)._unsafeUnwrap()).toBe(1);
        expect(removePin(pin.id)._unsafeUnwrap()).toBe(0);
        expect(listPins({ limit: 10, offset: 0 })._unsafeUnwrap().total).toBe(0);
    });
});

describe("the recent files of the picker", () => {
    let now = 1_000;
    let clock: ReturnType<typeof spyOn>;

    beforeEach(() => {
        now = 1_000;
        clock = spyOn(Date, "now").mockImplementation(() => now++);
        insertAnchor(anchor("anc"))._unsafeUnwrap();
        insertAnalysis(analysis("a1", 1_000))._unsafeUnwrap();
        insertAnalysis(analysis("a2", 1_000))._unsafeUnwrap();
    });

    afterEach(() => {
        clock.mockRestore();
    });

    function record(path: string, analysisId: string | null, cap = 100): void {
        recordRecentFile({ path, isDir: false, analysisId, cap })._unsafeUnwrap();
    }

    function pathsOf(analysisId: string | null): string[] {
        return listRecentFiles({ analysisId, limit: 100 })
            ._unsafeUnwrap()
            .map((r) => r.path);
    }

    test("a second record moves updated_at and adds no row", () => {
        record("/a.csv", null);
        record("/b.csv", null);
        const before = listRecentFiles({ analysisId: null, limit: 10 })._unsafeUnwrap();
        const firstA = before.find((r) => r.path === "/a.csv")!;

        record("/a.csv", null);

        const after = listRecentFiles({ analysisId: null, limit: 10 })._unsafeUnwrap();
        expect(after.map((r) => r.path)).toEqual(["/a.csv", "/b.csv"]);
        expect(after[0]!.id).toBe(firstA.id);
        expect(after[0]!.createdAt).toBe(firstA.createdAt);
        expect(after[0]!.updatedAt).toBeGreaterThan(firstA.updatedAt);
    });

    test("a read has an exact scope", () => {
        record("/a.csv", "a1");
        record("/b.csv", null);
        record("/c.csv", "a2");

        expect(pathsOf("a1")).toEqual(["/a.csv"]);
        expect(pathsOf(null)).toEqual(["/b.csv"]);
    });

    test("one path has one row in each scope", () => {
        record("/a.csv", null);
        record("/a.csv", "a1");
        record("/a.csv", "a1");

        expect(pathsOf(null)).toEqual(["/a.csv"]);
        expect(pathsOf("a1")).toEqual(["/a.csv"]);
    });

    test("the limit keeps the newest rows", () => {
        for (const p of ["/1", "/2", "/3"]) record(p, null);

        expect(
            listRecentFiles({ analysisId: null, limit: 2 })
                ._unsafeUnwrap()
                .map((r) => r.path),
        ).toEqual(["/3", "/2"]);
    });

    test("the cap of one scope removes its oldest row and keeps the other scope", () => {
        record("/m.csv", null);
        for (const p of ["/1", "/2", "/3"]) record(p, "a1", 3);

        record("/4", "a1", 3);

        expect(pathsOf("a1")).toEqual(["/4", "/3", "/2"]);
        expect(pathsOf(null)).toEqual(["/m.csv"]);
    });

    test("the cap of the machine scope leaves the analysis scope", () => {
        record("/a.csv", "a1");
        for (const p of ["/1", "/2", "/3"]) record(p, null, 2);

        expect(pathsOf(null)).toEqual(["/3", "/2"]);
        expect(pathsOf("a1")).toEqual(["/a.csv"]);
    });

    test("a record of an analysis with no row is a foreign_key violation and leaves no row", () => {
        recordRecentFile({ path: "/a.csv", isDir: false, analysisId: "ghost", cap: 100 }).match(
            () => {
                throw new Error("expected a foreign_key violation");
            },
            (e) => {
                expect(e.type).toBe("constraint_violation");
                if (e.type === "constraint_violation") expect(e.constraint).toBe("foreign_key");
            },
        );
        expect(sharedConn().query("SELECT COUNT(*) AS n FROM recent_files").get()).toEqual({ n: 0 });
    });
});
