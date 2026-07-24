import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describeContext, resolveContext, type ResolvedContext } from "./context.ts";
import { freshDb } from "../../test_support/db.ts";
import { insertAnalysis, insertAnchor } from "../../db/primary_mutation.ts";
import type { Analysis } from "../../types/analysis.ts";
import { asStr256 } from "../../lib/types.ts";

function analysis(name: string): Analysis {
    return {
        id: "a1",
        createdAt: 0,
        updatedAt: 0,
        name: asStr256(name),
        slug: "slug",
        anchorId: "anchor1",
        projectId: null,
    };
}

describe("describeContext", () => {
    test("analysis: names the analysis and its anchor path", () => {
        const summary = describeContext({ kind: "analysis", analysis: analysis("My A"), anchorPath: "/home/x" });
        expect(summary).toContain('analysis "My A"');
        expect(summary).toContain("/home/x");
    });

    test("anchor: pluralizes the analysis count (1 analysis vs 2 analyses)", () => {
        expect(describeContext({ kind: "anchor", anchorPath: "/p", analyses: [analysis("a")] })).toContain("1 analysis");
        expect(describeContext({ kind: "anchor", anchorPath: "/p", analyses: [analysis("a"), analysis("b")] })).toContain("2 analyses");
    });

    test("pick: pluralizes candidates, treating 0 as plural", () => {
        expect(describeContext({ kind: "pick", analyses: [] })).toContain("0 candidates");
    });

    test("copy: flags the copied folder for re-mint/fork", () => {
        const ctx: ResolvedContext = { kind: "copy", cwd: "/c", marker: { schemaVersion: 1, anchorId: "anchor1" } };
        expect(describeContext(ctx)).toContain("re-mint or fork");
    });

    test("empty: reports nothing-here for the cwd", () => {
        expect(describeContext({ kind: "empty", cwd: "/nowhere" })).toContain("/nowhere");
    });
});

describe("resolveContext ambient tier", () => {
    const roots: string[] = [];
    function unmarkedCwd(): string {
        const p = mkdtempSync(join(tmpdir(), "inflexa-ctx-"));
        roots.push(p);
        return p;
    }
    function seedAnalysis(id: string): Analysis {
        return insertAnalysis({ id, createdAt: 1, updatedAt: 1, name: asStr256(id), slug: id.toLowerCase(), anchorId: "anc", projectId: null })._unsafeUnwrap();
    }
    beforeEach(() => {
        freshDb();
        insertAnchor({ id: "anc", createdAt: 1, updatedAt: 1, cachedPath: "/tmp/x", markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
    });
    afterEach(() => {
        for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
    });

    test("resolves the ambient analysis when no explicit flag is set", () => {
        const amb = seedAnalysis("AMB");
        const ctx = resolveContext(unmarkedCwd(), { ambientAnalysis: amb.id })._unsafeUnwrap();
        expect(ctx.kind).toBe("analysis");
        expect(ctx.kind === "analysis" ? ctx.analysis.id : null).toBe("AMB");
    });

    test("an explicit --analysis flag overrides the ambient ref", () => {
        seedAnalysis("AMB");
        const exp = seedAnalysis("EXP");
        const ctx = resolveContext(unmarkedCwd(), { analysis: exp.id, ambientAnalysis: "AMB" })._unsafeUnwrap();
        expect(ctx.kind === "analysis" ? ctx.analysis.id : null).toBe("EXP");
    });

    test("an unmatched ambient ref falls through to the marker walk-up (empty here)", () => {
        const ctx = resolveContext(unmarkedCwd(), { ambientAnalysis: "does-not-exist" })._unsafeUnwrap();
        expect(ctx.kind).toBe("empty");
    });
});
