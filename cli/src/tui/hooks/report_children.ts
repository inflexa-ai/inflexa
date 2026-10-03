import { createEffect, createSignal, untrack } from "solid-js";
import type { ResultAsync } from "neverthrow";

import type { ThreadList, ThreadSummary } from "../../api/conversation.ts";
import type { ClientError } from "../../client/api.ts";
import { fetchThreads } from "../../client/conversation.ts";
import type { Workspace } from "../contexts/workspace.ts";
import { bootState } from "./boot.ts";
import { chatStatus, type ChatStatus } from "./status.ts";

// The report sessions spawned from the open conversation thread, held here and not inside
// `components/chat.tsx`, thus the holder of the state stays separate from its renderer. This is the
// split of `thread.ts` and `status.ts`. The server reads the threads from Postgres, thus the listing
// sits behind the boot-ready edge. One chat screen is mounted at a time, thus a module singleton is
// correct.

// One frozen empty listing, thus every degraded read gives the same reference and a consumer of the
// signal reconciles nothing.
const NO_CHILDREN: readonly ThreadSummary[] = Object.freeze([]);

const [children, setChildren] = createSignal<readonly ThreadSummary[]>(NO_CHILDREN);

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
 * How the listing reaches the server. A test replaces each one, thus it drives the listing offline. This
 * mirrors `ThreadOpts` in `thread.ts`. A production caller omits the argument.
 */
export type ReportChildrenOpts = {
    /** True when the server runtime is ready to read the threads. Real: the boot phase is `ready`. */
    readonly ready: () => boolean;
    /**
     * One thread's live report children. The listing narrows on BOTH the parent id and the `report`
     * type. The type narrow is necessary because a conversation can spawn a thread of another kind
     * later, and such a thread is not a report. Real: `GET {A}/threads?type=report&parentThreadId=`, one
     * page of the server default.
     */
    readonly listThreads: (analysisId: string, parentThreadId: string) => ResultAsync<ThreadList, ClientError>;
};

const DEFAULT_REPORT_CHILDREN_OPTS: ReportChildrenOpts = {
    ready: () => bootState().phase === "ready",
    listThreads: (analysisId, parentThreadId) => fetchThreads(analysisId, { type: "report", parentThreadId }, { page: 0, perPage: 100 }),
};

// Monotonic token that orders every asynchronous write to the listing. A rapid session swap
// interleaves the listings and the older one can resolve LAST. Each read compares the token again
// after its await, thus the newest refresh that STARTED wins. This mirrors `metadataGeneration` in
// `thread.ts`.
let refreshGeneration = 0;

// The parent that the listing on screen describes. A refresh for a DIFFERENT parent empties the
// listing before it queries, because a query is a round trip and the transcript resets synchronously
// at a session swap. To hold the rows across that window paints the entries of the conversation the
// user just left over the transcript of the one they opened. A refresh for the SAME parent, which is
// what a settled turn asks for, keeps the rows and blinks nothing.
let listedParentThreadId: string | null = null;

/**
 * Read the open thread's report children into {@link reportChildren}. A `null` analysis, a `null`
 * thread, or a server that is not ready resets the listing to empty and issues no query.
 *
 * A failed listing degrades to no children and raises no notice. The children are an addition to the
 * transcript, thus their absence costs the reader nothing and a toast for each failed read would
 * interrupt the conversation over a surface that carries no message.
 */
export async function refreshReportChildren(
    analysisId: string | null,
    parentThreadId: string | null,
    opts: ReportChildrenOpts = DEFAULT_REPORT_CHILDREN_OPTS,
): Promise<void> {
    // Claim the token BEFORE the guards, thus even the empty path invalidates an older read that is
    // still in flight. A swap to an unbound scope must not take the listing of the previous one.
    const mine = ++refreshGeneration;
    if (parentThreadId !== listedParentThreadId) {
        listedParentThreadId = parentThreadId;
        setChildren(NO_CHILDREN);
    }
    if (!opts.ready() || analysisId === null || parentThreadId === null) {
        setChildren(NO_CHILDREN);
        return;
    }
    const res = await opts.listThreads(analysisId, parentThreadId);
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
export function watchReportChildren(workspace: Workspace, opts: ReportChildrenOpts = DEFAULT_REPORT_CHILDREN_OPTS): void {
    createEffect(() => {
        const ready = bootState().phase === "ready";
        const analysisId = workspace.analysis?.id ?? null;
        const parentThreadId = workspace.sessionId;
        // Before `ready` the server cannot list, thus collapse to empty rather than hold the children
        // of a previous boot.
        void refreshReportChildren(ready ? analysisId : null, ready ? parentThreadId : null, opts);
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
        // The scope reads sit inside `untrack`, thus this effect tracks the status alone. Tracked, they
        // would make a session swap run BOTH effects and issue two listings for one bind.
        if (prev === "busy" && status !== "busy") {
            untrack(() => void refreshReportChildren(workspace.analysis?.id ?? null, workspace.sessionId, opts));
        }
        prev = status;
    });
}

/** Test hook: drop the listing and any read that is in flight. Test-only. */
export function __resetReportChildrenForTest(): void {
    refreshGeneration += 1;
    listedParentThreadId = null;
    setChildren(NO_CHILDREN);
}
