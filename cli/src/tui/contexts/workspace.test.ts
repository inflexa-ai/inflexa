import { describe, expect, test } from "bun:test";

import type { AnalysisDetail } from "../../api/analyses.ts";
import type { ProjectView } from "../../api/projects.ts";
import { createWorkspace, type WorkspaceInit, type WorkspaceOpts } from "./workspace.ts";
import type { Analysis } from "../../types/analysis.ts";

// The swap runs offline: the turn abort and the project read of the server are fakes, so the tests assert
// the swap contract — a different analysis aborts the turn and swaps, a same-analysis swap does not abort,
// and the project read of an earlier swap never lands on a later one. The instance lock is the server's.

// Two analyses that differ by id (a real swap). Only id/name are load-bearing here.
const A = { id: "a1", name: "Alpha", projectId: null } as unknown as Analysis;
const B = { id: "b1", name: "Bravo", projectId: "p1" } as unknown as Analysis;
const PROJECT: ProjectView = {
    id: "p1",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    name: "Liver",
    description: null,
    tags: [],
};

function initFor(analysis: Analysis): WorkspaceInit {
    return { analysis, sessionId: "s1", workingDir: "/dir1", openDialog: () => {}, closeDialog: () => {}, quit: async () => {} };
}

/** The scope that `GET {A}` gives, with only the fields the store reads. */
function detail(project: ProjectView | null, inputCount: number): AnalysisDetail {
    return { project, anchor: null, inputCount } as unknown as AnalysisDetail;
}

/** Fakes plus recorders: each scope read parks until the test settles it. */
function makeOpts(): { opts: WorkspaceOpts; aborts: () => number; reads: string[]; settle: (analysisId: string, d: AnalysisDetail) => Promise<void> } {
    let aborts = 0;
    const reads: string[] = [];
    const pending = new Map<string, (d: AnalysisDetail | null) => void>();
    const opts: WorkspaceOpts = {
        abortTurn: () => {
            aborts += 1;
        },
        fetchDetail: (analysisId) => {
            reads.push(analysisId);
            return new Promise((resolve) => pending.set(analysisId, resolve));
        },
    };
    return {
        opts,
        aborts: () => aborts,
        reads,
        settle: async (analysisId, d) => {
            pending.get(analysisId)?.(d);
            await Promise.resolve();
        },
    };
}

describe("openSession — analysis swap", () => {
    test("refreshScope reads the open analysis again, as after an input change", async () => {
        const t = makeOpts();
        const ws = createWorkspace(initFor(A), t.opts);
        await t.settle("a1", detail(null, 1));

        ws.refreshScope();
        await t.settle("a1", detail(null, 2));

        expect(t.reads).toEqual(["a1", "a1"]);
        expect(ws.inputCount).toBe(2);
    });

    test("a different analysis: the turn is aborted, the scope swaps, and the project of the new analysis lands", async () => {
        const t = makeOpts();
        const ws = createWorkspace(initFor(A), t.opts);

        ws.openSession("s2", "/dir2", B);

        expect(t.aborts()).toBe(1);
        expect(ws.analysis?.id).toBe("b1");
        expect(ws.sessionId).toBe("s2");
        expect(ws.workingDir).toBe("/dir2");
        expect(ws.project).toBeNull();
        expect(ws.inputCount).toBeNull();
        await t.settle("b1", detail(PROJECT, 3));
        expect(ws.project?.name).toBe("Liver");
        expect(ws.inputCount).toBe(3);
    });

    test("same-analysis session swap: no explicit abort, session/dir updated in place, project read again", () => {
        const t = makeOpts();
        const ws = createWorkspace(initFor(A), t.opts);

        // Same analysis id, different session — the resume-into-a-different-session case.
        ws.openSession("s2", "/dir2", A);

        // No explicit abort — that case's abort is the Chat effect's job.
        expect(t.aborts()).toBe(0);
        expect(ws.analysis?.id).toBe("a1");
        expect(ws.sessionId).toBe("s2");
        expect(ws.workingDir).toBe("/dir2");
        expect(t.reads).toEqual(["a1", "a1"]);
    });

    test("a project read of an earlier swap never lands on a later analysis", async () => {
        const t = makeOpts();
        const ws = createWorkspace(initFor(A), t.opts);

        ws.openSession("s2", "/dir2", B);
        ws.openSession("s3", "/dir3", A);
        await t.settle("b1", detail(PROJECT, 3));

        expect(ws.analysis?.id).toBe("a1");
        expect(ws.project).toBeNull();
        expect(ws.inputCount).toBeNull();
    });
});
