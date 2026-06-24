import { beforeEach, describe, expect, test } from "bun:test";

import { freshDb } from "../test_support/db.ts";
import { createMessage, createPart, createProject, createSession, insertAnalysis, insertAnchor } from "./primary_mutation.ts";
import { getAnchor, getSession, findProjectByRef, listSessionMessages, listRecentSessionMessages } from "./primary_query.ts";
import { asStr256 } from "../lib/types.ts";
import type { Anchor } from "../types/anchor.ts";
import type { Analysis } from "../types/analysis.ts";

// freshDb() resets + re-migrates the singleton DB before each test; the mutation/query functions
// drive that same connection (they call db() internally), so writes are read back through the real
// query layer. FK enforcement is ON (db() sets PRAGMA foreign_keys), which the chain + FK test rely on.
beforeEach(() => {
    freshDb();
});

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

describe("session + message + part round-trip", () => {
    test("messages and their parts assemble in order through the query layer", () => {
        insertAnchor(anchor("anc-s"))._unsafeUnwrap();
        const analysis: Analysis = {
            id: "ana-s",
            createdAt: 1,
            updatedAt: 1,
            name: asStr256("A"),
            slug: "a",
            outputDirectory: null,
            anchorId: "anc-s",
            projectId: null,
        };
        insertAnalysis(analysis)._unsafeUnwrap();
        const session = createSession({ analysisId: "ana-s" })._unsafeUnwrap();
        const msg = createMessage(session.id, "user")._unsafeUnwrap();
        createPart(session.id, msg.id, "hello")._unsafeUnwrap();

        expect(getSession(session.id)._unsafeUnwrap()).toEqual(session);

        const messages = listSessionMessages(session.id)._unsafeUnwrap();
        expect(messages).toHaveLength(1);
        const first = messages[0];
        expect(first?.info.role).toBe("user");
        const part = first?.parts[0];
        expect(part?.type).toBe("text");
        if (part?.type === "text") expect(part.text).toBe("hello");
    });
});

describe("listRecentSessionMessages (capped UI window)", () => {
    // randomUUIDv7 is monotonic within the process (verified), so creation order == id order; the
    // capped query relies on that to take "newest N" via ORDER BY id DESC.
    function seedSession(): string {
        insertAnchor(anchor("anc-cap"))._unsafeUnwrap();
        insertAnalysis({
            id: "ana-cap",
            createdAt: 1,
            updatedAt: 1,
            name: asStr256("Cap"),
            slug: "cap",
            outputDirectory: null,
            anchorId: "anc-cap",
            projectId: null,
        })._unsafeUnwrap();
        return createSession({ analysisId: "ana-cap" })._unsafeUnwrap().id;
    }

    test("returns only the newest `limit` messages, oldest→newest, each with its parts", () => {
        const sid = seedSession();
        const ids: string[] = [];
        for (let i = 0; i < 5; i++) {
            const m = createMessage(sid, i % 2 === 0 ? "user" : "assistant")._unsafeUnwrap();
            createPart(sid, m.id, `text-${i}`)._unsafeUnwrap();
            ids.push(m.id);
        }

        const recent = listRecentSessionMessages(sid, 3)._unsafeUnwrap();
        expect(recent.map((m) => m.info.id)).toEqual(ids.slice(-3)); // newest 3, in oldest→newest order
        const firstPart = recent[0]?.parts[0];
        expect(firstPart?.type).toBe("text");
        if (firstPart?.type === "text") expect(firstPart.text).toBe("text-2");
    });

    test("returns all messages when there are fewer than the limit", () => {
        const sid = seedSession();
        const m = createMessage(sid, "user")._unsafeUnwrap();
        createPart(sid, m.id, "only")._unsafeUnwrap();
        expect(listRecentSessionMessages(sid, 200)._unsafeUnwrap()).toHaveLength(1);
    });

    test("returns an empty list for a session with no messages", () => {
        const sid = seedSession();
        expect(listRecentSessionMessages(sid, 200)._unsafeUnwrap()).toEqual([]);
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
            outputDirectory: null,
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
