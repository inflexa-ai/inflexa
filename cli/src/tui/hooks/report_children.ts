import { createEffect, createSignal } from "solid-js";
import type { ResultAsync } from "neverthrow";
import { createThreadStore, type DbError, type Pool, type Thread, type ThreadPage } from "@inflexa-ai/harness";

import type { HarnessRuntime } from "../../modules/harness/runtime.ts";
import type { Workspace } from "../contexts/workspace.ts";
import { bootState, harnessRuntime } from "./boot.ts";
import { chatStatus, type ChatStatus } from "./status.ts";

// The report sessions spawned from the open conversation thread, held here and not inside
// `components/chat.tsx`, thus the holder of the state stays separate from its renderer. This is the
// split of `thread.ts` and `status.ts`. Postgres is the only store of thread identity, thus the
// listing sits behind the boot-ready edge. One chat screen is mounted at a time, thus a module
// singleton is correct.

// One frozen empty listing, thus every degraded read gives the same reference and a consumer of the
// signal reconciles nothing.
const NO_CHILDREN: readonly Thread[] = Object.freeze([]);

const [children, setChildren] = createSignal<readonly Thread[]>(NO_CHILDREN);

/**
 * The live report children of the open conversation thread, in the order that the store gives them.
 * Read it in a tracking scope to repaint on a bind or a refresh.
 *
 * LIVE alone, and nothing here does the filter. The store hides an archived row unless
 * `includeArchived` widens the listing, and an archive stamps the whole subtree. Thus an archived
 * child leaves this surface at the next refresh, and a caller needs no rule of its own for it.
 */
export const reportChildren = children;

/**
 * Injectable edges, thus a test drives the listing offline with no Postgres and no booted runtime.
 * This mirrors `ThreadSeams` in `thread.ts`. A production caller omits the argument and gets the real
 * booted runtime and the real harness thread store.
 */
export type ReportChildrenSeams = {
    /** The booted runtime handle, or `null` when boot is not ready. Real: {@link harnessRuntime}. */
    readonly runtime: () => HarnessRuntime | null;
    /**
     * One thread's live report children. The listing narrows on BOTH the parent id and the `report`
     * type. The type narrow is necessary because a conversation can spawn a thread of another kind
     * later, and such a thread is not a report. Real: `createThreadStore(pool).listThreads`.
     */
    readonly listThreads: (pool: Pool, analysisId: string, parentThreadId: string) => ResultAsync<ThreadPage, DbError>;
};

const realReportChildrenSeams: ReportChildrenSeams = {
    runtime: harnessRuntime,
    listThreads: (pool, analysisId, parentThreadId) => createThreadStore(pool).listThreads({ analysisId, type: "report", parentThreadId }),
};

// Monotonic token that orders every asynchronous write to the listing. A rapid session swap
// interleaves the listings and the older one can resolve LAST. Each read compares the token again
// after its await, thus the newest refresh that STARTED wins. This mirrors `metadataGeneration` in
// `thread.ts`.
let refreshGeneration = 0;

/**
 * Read the open thread's report children into {@link reportChildren}. A `null` analysis, a `null`
 * thread, or an unbooted runtime resets the listing to empty and issues no query.
 *
 * A failed listing degrades to no children and raises no notice. The children are an addition to the
 * transcript, thus their absence costs the reader nothing and a toast for each failed read would
 * interrupt the conversation over a surface that carries no message.
 */
export async function refreshReportChildren(
    analysisId: string | null,
    parentThreadId: string | null,
    seams: ReportChildrenSeams = realReportChildrenSeams,
): Promise<void> {
    // Claim the token BEFORE the guards, thus even the empty path invalidates an older read that is
    // still in flight. A swap to an unbound scope must not take the listing of the previous one.
    const mine = ++refreshGeneration;
    const runtime = seams.runtime();
    if (!runtime || analysisId === null || parentThreadId === null) {
        setChildren(NO_CHILDREN);
        return;
    }
    const res = await seams.listThreads(runtime.pool, analysisId, parentThreadId);
    if (mine !== refreshGeneration) return;
    res.match(
        (page) => setChildren(page.threads),
        () => setChildren(NO_CHILDREN),
    );
}

/**
 * Wire the listing to the open thread and to the settlement of a turn. Call it one time from the
 * component that renders the entries, inside its reactive root.
 *
 * Two edges write the listing, and a turn is the second one for a concrete reason: a turn is what
 * spawns a report session, and the open scope does not move when it does. Without that edge a user
 * would ask for a report, watch the turn finish, and find no entry until they left the conversation
 * and came back.
 */
export function watchReportChildren(workspace: Workspace, seams: ReportChildrenSeams = realReportChildrenSeams): void {
    createEffect(() => {
        const ready = bootState().phase === "ready";
        const analysisId = workspace.analysis?.id ?? null;
        const parentThreadId = workspace.sessionId;
        // Before `ready` there is no pool to list from, thus collapse to empty rather than hold the
        // children of a previous boot.
        void refreshReportChildren(ready ? analysisId : null, ready ? parentThreadId : null, seams);
    });

    // The turn-completion down-edge, the shape `thread.ts` uses for the row of the open thread. `prev`
    // is closure-local and it is seeded to the current status, thus the first synchronous run fires no
    // false edge.
    //
    // Leaving `busy` at all is the edge, and not reaching `idle`. The spawn writes its row before the
    // rest of the turn runs, thus a turn that spawns a session and then fails has still written the row
    // that this read collects. Such a turn settles on `error`.
    let prev: ChatStatus = chatStatus();
    createEffect(() => {
        const status = chatStatus();
        const analysisId = workspace.analysis?.id ?? null;
        const parentThreadId = workspace.sessionId;
        if (prev === "busy" && status !== "busy") void refreshReportChildren(analysisId, parentThreadId, seams);
        prev = status;
    });
}

/** Test hook: drop the listing and any read that is in flight. Test-only. */
export function __resetReportChildrenForTest(): void {
    refreshGeneration += 1;
    setChildren(NO_CHILDREN);
}
