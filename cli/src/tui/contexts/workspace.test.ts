import { describe, expect, test } from "bun:test";

import { createWorkspace, type WorkspaceInit, type WorkspaceSeams } from "./workspace.ts";
import type { LockOutcome } from "../../lib/lock.ts";
import type { Notice } from "../theme.ts";
import type { Analysis } from "../../types/analysis.ts";

// The swap DECISION is exercised offline: the lock, the turn abort, and the notice channel are
// injected as fakes (no lock files, no second process, no live turn), so the tests assert the
// analysis-swap contract — refused → scope unchanged; acquired → lock exchanged +
// turn aborted; same-analysis → no lock churn — without touching the real singletons.

// Two analyses that differ by id (a real swap) — `projectId: null` so `projectForAnalysis` returns
// null without a DB read. Only id/name are load-bearing here.
const A = { id: "a1", name: "Alpha", projectId: null } as unknown as Analysis;
const B = { id: "b1", name: "Bravo", projectId: null } as unknown as Analysis;

function initFor(analysis: Analysis): WorkspaceInit {
    return { analysis, sessionId: "s1", workingDir: "/dir1", openDialog: () => {}, closeDialog: () => {}, quit: async () => {} };
}

/** Fakes plus recorders for every seam the swap drives. */
function makeSeams(acquire: (key: string) => LockOutcome): {
    seams: WorkspaceSeams;
    acquired: string[];
    released: string[];
    aborts: number;
    notices: Notice[];
} {
    const acquired: string[] = [];
    const released: string[] = [];
    const notices: Notice[] = [];
    let aborts = 0;
    const seams: WorkspaceSeams = {
        acquireLock: (key) => {
            acquired.push(key);
            return acquire(key);
        },
        releaseLock: (key) => {
            released.push(key);
        },
        abortTurn: () => {
            aborts += 1;
        },
        notify: (n) => {
            notices.push(n);
        },
    };
    return {
        seams,
        acquired,
        released,
        notices,
        get aborts() {
            return aborts;
        },
    };
}

describe("openSession — analysis swap decision", () => {
    test("refused when the target is locked elsewhere: scope unchanged, no exchange, actionable notice", () => {
        const t = makeSeams(() => ({ acquired: false, holderPid: 4242 }));
        const ws = createWorkspace(initFor(A), t.seams);

        ws.openSession("s2", "/dir2", B);

        // Current scope is untouched — no partial state.
        expect(ws.analysis?.id).toBe("a1");
        expect(ws.sessionId).toBe("s1");
        expect(ws.workingDir).toBe("/dir1");
        // The old lock is kept (never released) and no turn was aborted.
        expect(t.released).toEqual([]);
        expect(t.aborts).toBe(0);
        // The notice names the conflicting analysis AND the holder pid.
        expect(t.notices).toHaveLength(1);
        const notice = t.notices[0];
        expect(notice?.kind).toBe("warn");
        expect(notice?.text).toContain("Bravo");
        expect(notice?.text).toContain("4242");
    });

    test("acquired: new lock claimed, in-flight turn aborted, old lock released, scope swapped", () => {
        const t = makeSeams(() => ({ acquired: true }));
        const ws = createWorkspace(initFor(A), t.seams);

        ws.openSession("s2", "/dir2", B);

        expect(t.acquired).toEqual(["b1"]); // target claimed
        expect(t.aborts).toBe(1); // in-flight turn aborted before the release
        expect(t.released).toEqual(["a1"]); // old analysis lock released
        expect(ws.analysis?.id).toBe("b1");
        expect(ws.sessionId).toBe("s2");
        expect(ws.workingDir).toBe("/dir2");
        expect(t.notices).toEqual([]); // success is silent
    });

    test("same-analysis session swap: no lock churn, session/dir updated in place", () => {
        const t = makeSeams(() => ({ acquired: true }));
        const ws = createWorkspace(initFor(A), t.seams);

        // Same analysis id, different session — the resume-into-a-different-session case.
        ws.openSession("s2", "/dir2", A);

        // No acquire, no release, no explicit abort — that case's abort is the Chat effect's job.
        expect(t.acquired).toEqual([]);
        expect(t.released).toEqual([]);
        expect(t.aborts).toBe(0);
        expect(ws.analysis?.id).toBe("a1");
        expect(ws.sessionId).toBe("s2");
        expect(ws.workingDir).toBe("/dir2");
    });
});
