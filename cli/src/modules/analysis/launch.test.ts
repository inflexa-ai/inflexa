import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { freshDb } from "../../test_support/db.ts";
import { insertAnalysis, insertAnalysisInput, insertAnchor } from "../../db/primary_mutation.ts";
import { listAnalyses, listAnalysisInputs, listAnchors } from "../../db/primary_query.ts";
import { writeMarker } from "../anchor/marker.ts";
import { asStr256 } from "../../lib/types.ts";
import type { Analysis } from "../../types/analysis.ts";
import { matchAnalysis } from "./analysis.ts";
import { resolveResumeTarget } from "./launch.ts";

// The launcher's resolvers run against a real seeded database rather than mocks: every branch worth
// pinning is a DB read plus an anchor resolution, both of which the temp-DB harness gives for free (the
// bunfig [test].preload sandboxes XDG_* — see src/test_support/preload.ts).
//
// WHICH SEAM each claim is asserted at, and why:
//   • The happy paths go through `resolveResumeTarget` itself — the real exported entry `inflexa resume`
//     calls — because an explicit id/name ref is the one resolver path that reaches a ChatTarget with NO
//     clack prompt in the way. The prompting resolvers (`resolveNewTarget`, `resolveDefaultTarget`,
//     `pickOrStartTarget`) all funnel through `promptText`/`select`/`confirm`, which either block on a
//     TTY or `fail()` the process without one, so they are out of reach from a test process by design.
//   • The unknown-ref claim is asserted one layer DOWN, on `matchAnalysis` — the resolver whose `null`
//     `resolveResumeTarget` keys its bail-out on. The bail-out itself is `fail()`, a CLI-boundary
//     `process.exit(1)` (lib/cli.ts): calling it here would take the whole bun test process down with
//     it, so the deepest seam that still RETURNS is the one asserted. What is provable from a test is
//     that an unknown ref resolves to the in-band `null` — never an error, and never a stray match —
//     which is exactly the input the exit branch reads.

const created: string[] = [];

function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), "inflexa-launch-"));
    created.push(dir);
    return dir;
}

/**
 * An anchored analysis whose folder is real and holds its marker, so `resolveAnchor` settles on step 1
 * (the cached path still holds the marker) — the resolution the launcher takes on every ordinary resume.
 */
function seedAnalysisAt(dir: string, opts?: { name?: string }): Analysis {
    writeMarker(dir, "ANC1")._unsafeUnwrap();
    insertAnchor({ id: "ANC1", createdAt: 1, updatedAt: 1, cachedPath: dir, markerWritten: true, lastSeen: 1 })._unsafeUnwrap();
    const analysis = insertAnalysis({
        id: "ANA1",
        createdAt: 1,
        updatedAt: 1,
        name: asStr256(opts?.name ?? "My Analysis"),
        slug: "my-analysis",
        anchorId: "ANC1",
        projectId: null,
    })._unsafeUnwrap();
    insertAnalysisInput({ path: "in.csv", isDir: false, analysisId: analysis.id, anchorId: "ANC1" })._unsafeUnwrap();
    return analysis;
}

beforeEach(() => {
    freshDb();
});

afterEach(() => {
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
    created.length = 0;
});

describe("resolveResumeTarget", () => {
    test("an existing analysis resolves to its anchor path and nothing else", () => {
        const dir = tmp();
        const seeded = seedAnalysisAt(dir);

        const target = resolveResumeTarget(seeded.id);

        expect(target.workingDir).toBe(dir);
        expect(target.analysis).toEqual(seeded);
        // The ChatTarget shape is load-bearing: it is the entire contract with the renderer, and the
        // resolver deliberately binds NO conversation thread (that needs Postgres, which the launcher
        // must not start). A third key appearing here would be that decision quietly reversed.
        expect(Object.keys(target).sort()).toEqual(["analysis", "workingDir"]);
    });

    test("the same analysis resolves by name, not only by id", () => {
        const dir = tmp();
        const seeded = seedAnalysisAt(dir, { name: "Bulk RNA" });
        expect(resolveResumeTarget("Bulk RNA")).toEqual({ workingDir: dir, analysis: seeded });
    });

    test("resolving persists nothing — no row is created in any table", () => {
        const dir = tmp();
        const seeded = seedAnalysisAt(dir);
        const counts = () => ({
            anchors: listAnchors()._unsafeUnwrap().length,
            analyses: listAnalyses()._unsafeUnwrap().length,
            inputs: listAnalysisInputs(seeded.id)._unsafeUnwrap().length,
        });
        const before = counts();

        resolveResumeTarget(seeded.id);

        // The no-litter claim in resolveChatTarget's contract: a launch that opens a chat nobody types
        // into persists nothing. Row COUNTS are the assertion, not row equality — the resolve is a
        // user-driven sighting, so `resolveAnchor` deliberately bumps the anchor's `last_seen`
        // heartbeat. That is an update to an existing row, never a new one.
        expect(counts()).toEqual(before);
        expect(before.anchors).toBe(1);
        expect(before.analyses).toBe(1);
        expect(before.inputs).toBe(1);
    });
});

describe("matchAnalysis — the ref resolution behind resolveResumeTarget's bail-out", () => {
    test("an unknown ref resolves to null on the ok channel, never an error", () => {
        seedAnalysisAt(tmp());
        // `_unsafeUnwrap` throws on an Err, so a null return proves both "is ok" and "value is null" —
        // and null is precisely what drives `resolveResumeTarget`'s `No analysis found matching "…"`
        // exit. A DbError here would instead surface as a "Failed to resolve analysis" crash.
        expect(matchAnalysis("nope")._unsafeUnwrap()).toBeNull();
    });

    test("an empty database resolves any ref to null", () => {
        expect(matchAnalysis("ANA1")._unsafeUnwrap()).toBeNull();
    });
});
