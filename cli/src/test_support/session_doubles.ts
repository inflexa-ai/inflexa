import { err, errAsync, okAsync } from "neverthrow";

import { type SessionOpts } from "../tui/commands.tsx";
import type { Workspace } from "../tui/contexts/workspace.ts";
import type { Notice } from "../tui/theme.ts";
import type { Analysis } from "../types/analysis.ts";
import { threadListOf } from "./threads.ts";

/** A {@link SessionOpts} double with the notices channel its `notify` records into. */
export type SessionOptsDouble = {
    readonly opts: SessionOpts;
    readonly notices: Notice[];
};

/**
 * Session options whose server answers stand still: every listing is empty, every write succeeds and
 * keeps the report-page files, the thread read gives `null`, and `notify` records into `notices`.
 * `over` replaces the fields a case is about — including the ones the defaults answer statically.
 */
export function sessionOptsDouble(over: Partial<SessionOpts> = {}): SessionOptsDouble {
    const notices: Notice[] = [];
    const opts: SessionOpts = {
        ready: () => true,
        listThreads: () => okAsync(threadListOf([])),
        listReportChildren: () => okAsync(threadListOf([])),
        getThread: () => okAsync(null),
        updateTitle: () => okAsync(null),
        listThreadsWithArchived: () => okAsync(threadListOf([])),
        archiveThread: () => okAsync(undefined),
        unarchiveThread: () => okAsync(undefined),
        // The files stay by default: a case that is not about the files says so by leaving this alone.
        purgeThread: () => okAsync({ purged: [], pages: { kind: "kept" } }),
        chatBusy: () => false,
        resolveThreadId: () => Promise.resolve("thread-resolved"),
        workingDirFor: () => "/work",
        refreshThread: () => {},
        mintReportPageAccess: () => errAsync({ type: "aborted" }),
        openUrl: () => err({ type: "open_failed", code: null, cause: null }),
        notify: (n) => {
            notices.push(n);
        },
        ...over,
    };
    return { opts, notices };
}

/** What {@link sessionScopeDouble} hands back: the workspace plus the recorders a case asserts on. */
export type SwappableSessionScope = {
    readonly ws: Workspace;
    /** How many dialogs the flows opened. */
    readonly dialogs: () => number;
    /** How many dialogs the flows closed. */
    readonly closes: () => number;
    /** Each `openSession` write: the thread id the flow left and the analysis it landed on. */
    readonly opened: { threadId: string | null; analysisId: string }[];
    /** Move the open scope the way the analysis-switch keys of the user would. */
    readonly swapTo: (next: { analysis?: Analysis; sessionId?: string | null }) => void;
};

/**
 * A workspace stand-in recording the writes a session flow can make: dialogs, closes, and scope
 * swaps. The getters read the scope at each access, which a spread of `buildWorkspace` would freeze.
 *
 * Each flow reads the scope one time, awaits the server, then acts, and nothing is modal across that
 * await. To drive the swap from inside a fake read is how a case lands in that window with no timing.
 */
export function sessionScopeDouble(analysis: Analysis | null, sessionId: string | null): SwappableSessionScope {
    const opened: { threadId: string | null; analysisId: string }[] = [];
    let dialogs = 0;
    let closes = 0;
    const scope: { analysis: Analysis | null; sessionId: string | null } = { analysis, sessionId };
    // The getters read the scope at each access, which a spread of `buildWorkspace` would freeze.
    const ws: Workspace = {
        get analysis() {
            return scope.analysis;
        },
        get sessionId() {
            return scope.sessionId;
        },
        workingDir: "/work",
        project: null,
        anchor: null,
        inputCount: null,
        openDialog: () => {
            dialogs += 1;
        },
        closeDialog: () => {
            closes += 1;
        },
        openSession: (threadId: string | null, _workingDir: string, next: Analysis) => {
            opened.push({ threadId, analysisId: next.id });
        },
        refreshScope: () => {},
        quit: async () => {},
    };
    return {
        ws,
        dialogs: () => dialogs,
        closes: () => closes,
        opened,
        swapTo: (next) => {
            if (next.analysis !== undefined) scope.analysis = next.analysis;
            if (next.sessionId !== undefined) scope.sessionId = next.sessionId;
        },
    };
}
