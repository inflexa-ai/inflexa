import { afterEach, describe, expect, test } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import type { PausePart } from "@inflexa-ai/harness/contracts/index.js";

import type { PausedWork, PausedWorkList } from "../../api/paused_work.ts";
import type { ClientError } from "../../client/api.ts";
import {
    __resetPausesForTest,
    applyPausePart,
    clearTurnPause,
    dockedPause,
    headWait,
    notePausePart,
    pausedProfileOf,
    pausedRunOf,
    pausedWorkSnapshot,
    pauseWordOf,
    refreshPausedWork,
    remedyOf,
    type TurnWait,
} from "./pauses.ts";
import { pollPausedWork } from "./sidebar_live.ts";

afterEach(() => {
    __resetPausesForTest();
});

const SCOPE = { analysisId: "A", threadId: "T" };

/** A `data-pause` part of the turn `turn-1`, in the state `paused` with a refusal of the host, unless `over` says otherwise. */
function part(over: Partial<PausePart> = {}): PausePart {
    return {
        type: "data-pause",
        id: "turn-1",
        workId: "turn-1",
        workKind: "turn",
        state: "paused",
        cause: { kind: "host", reason: "payment_required" },
        attempt: 0,
        ...over,
    };
}

/** One paused work as `GET {A}/paused-work` gives it. */
function work(over: Partial<PausedWork> = {}): PausedWork {
    return {
        workId: "run-1",
        kind: "run",
        analysisId: "A",
        waiting: [{ workflowId: "run-1-0", state: "paused", cause: { kind: "outage" }, attempt: 4, pausedAt: "2026-10-27T10:00:00.000Z" }],
        ...over,
    };
}

function listOf(items: PausedWork[]): PausedWorkList {
    return { pausedWork: items, total: items.length, page: 0, perPage: 200, hasMore: false };
}

const serverErr: ClientError = { type: "http", status: 500, body: { error: "internal_error", message: "The server failed to handle the request." } };

describe("applyPausePart — the waits of a turn reconcile by the workflow id", () => {
    test("a waiting state puts the wait in place, and a second part of the same workflow replaces it", () => {
        const first = applyPausePart([], part());
        expect(first).toEqual([{ workflowId: "turn-1", state: "paused", cause: { kind: "host", reason: "payment_required" }, attempt: 0 }]);

        const next = applyPausePart(first, part({ state: "retrying", cause: { kind: "outage" }, attempt: 1, retryAt: "2026-10-27T10:05:00.000Z" }));
        expect(next).toEqual([{ workflowId: "turn-1", state: "retrying", cause: { kind: "outage" }, attempt: 1, retryAt: "2026-10-27T10:05:00.000Z" }]);
    });

    test("the state `running` removes the wait of its workflow alone", () => {
        const waits = applyPausePart(applyPausePart([], part()), part({ id: "turn-1-sub" }));
        expect(applyPausePart(waits, part({ state: "running", cause: undefined, attempt: undefined })).map((w) => w.workflowId)).toEqual(["turn-1-sub"]);
    });

    test("a waiting part with no cause changes nothing", () => {
        const waits = applyPausePart([], part());
        expect(applyPausePart(waits, part({ id: "other", cause: undefined }))).toEqual(waits);
    });
});

describe("headWait — the wait that the prompt shows", () => {
    const retrying: TurnWait = { workflowId: "w1", state: "retrying", cause: { kind: "outage" }, attempt: 0 };
    const paused: TurnWait = { workflowId: "w2", state: "paused", cause: { kind: "credential" }, attempt: 0 };

    test("a wait in `paused` comes before a wait in `retrying`, because only the user ends it", () => {
        expect(headWait([retrying, paused])).toBe(paused);
        expect(headWait([retrying])).toBe(retrying);
        expect(headWait([])).toBeNull();
    });
});

describe("the pause of the turn of the open thread", () => {
    test("a part docks its turn, and the last `running` part removes the dock", () => {
        notePausePart(SCOPE, part());
        notePausePart(SCOPE, part({ id: "turn-1-sub", state: "retrying", cause: { kind: "outage" } }));
        expect(dockedPause()).toMatchObject({ analysisId: "A", threadId: "T", turnId: "turn-1", wait: { workflowId: "turn-1", state: "paused" }, others: 1 });

        notePausePart(SCOPE, part({ state: "running", cause: undefined }));
        expect(dockedPause()).toMatchObject({ wait: { workflowId: "turn-1-sub", state: "retrying" }, others: 0 });

        notePausePart(SCOPE, part({ id: "turn-1-sub", state: "running", cause: undefined }));
        expect(dockedPause()).toBeNull();
    });

    test("a part of a different turn starts the pause of that turn", () => {
        notePausePart(SCOPE, part());
        notePausePart(SCOPE, part({ id: "turn-2", workId: "turn-2" }));
        expect(dockedPause()).toMatchObject({ turnId: "turn-2", others: 0 });
    });

    test("a clear of a different turn keeps the pause, and a clear of its own turn removes it", () => {
        notePausePart(SCOPE, part());
        clearTurnPause("turn-2");
        expect(dockedPause()?.turnId).toBe("turn-1");
        clearTurnPause("turn-1");
        expect(dockedPause()).toBeNull();
    });
});

describe("refreshPausedWork — the paused work of the open analysis", () => {
    test("a read loads the items, and the marks and the remedy read them by analysis", async () => {
        const turn = work({ workId: "turn-1", kind: "turn", threadId: "T", remedy: "Run `inflexa up` to sign in again." });
        const items = await refreshPausedWork("A", { fetch: () => okAsync(listOf([work(), work({ workId: "wf-p", kind: "profile" }), turn])) });

        expect(items).toHaveLength(3);
        expect(pausedRunOf("A", "run-1")?.workId).toBe("run-1");
        expect(pausedRunOf("B", "run-1")).toBeUndefined();
        expect(pausedProfileOf("A")?.workId).toBe("wf-p");
        expect(remedyOf("A", "turn-1")).toBe("Run `inflexa up` to sign in again.");
    });

    test("a failed read keeps a loaded snapshot of the same analysis, and gives no items", async () => {
        await refreshPausedWork("A", { fetch: () => okAsync(listOf([work()])) });
        expect(await refreshPausedWork("A", { fetch: () => errAsync(serverErr) })).toBeNull();
        expect(pausedRunOf("A", "run-1")).toBeDefined();

        await refreshPausedWork("B", { fetch: () => errAsync(serverErr) });
        expect(pausedWorkSnapshot()).toEqual({ kind: "unavailable" });
    });

    test("the word of a mark is `paused` when a wait waits for the user, else `retrying`", () => {
        expect(pauseWordOf(work())).toBe("paused");
        expect(
            pauseWordOf(
                work({ waiting: [{ workflowId: "w", state: "retrying", cause: { kind: "outage" }, attempt: 0, pausedAt: "2026-10-27T10:00:00.000Z" }] }),
            ),
        ).toBe("retrying");
    });
});

describe("pollPausedWork — a paused turn of the open thread is read again", () => {
    test("the turn of the open thread is read, and a turn of a different thread is not", async () => {
        const watched: string[] = [];
        const items = [work(), work({ workId: "turn-x", kind: "turn", threadId: "other" }), work({ workId: "turn-1", kind: "turn", threadId: "T" })];
        await pollPausedWork("A", "T", { refresh: async () => items, watchTurn: async (_a, _t, turnId) => void watched.push(turnId) });
        expect(watched).toEqual(["turn-1"]);
    });

    test("no bound thread, or a failed read, reads no turn", async () => {
        const watched: string[] = [];
        const opts = { watchTurn: async (_a: string, _t: string, turnId: string) => void watched.push(turnId) };
        await pollPausedWork("A", null, { ...opts, refresh: async () => [work({ workId: "turn-1", kind: "turn", threadId: "T" })] });
        await pollPausedWork("A", "T", { ...opts, refresh: async () => null });
        expect(watched).toEqual([]);
    });
});
