import { createContext, useContext } from "solid-js";
import { createStore } from "solid-js/store";
import type { JSX } from "solid-js";

import type { AnalysisDetail, AnchorView } from "../../api/analyses.ts";
import type { ProjectView } from "../../api/projects.ts";
import { fetchAnalysis } from "../../client/analyses.ts";
import { abort as abortConversationTurn } from "../hooks/conversation.ts";
import type { Analysis } from "../../types/analysis.ts";

/**
 * The open chat's rarely-changed, read-mostly scope plus the in-app capabilities, shared through
 * one Solid context. The value is a `createStore` (built by {@link createWorkspace}): component
 * consumers read these as plain reactive properties (`ws.analysis`, no call), while the module-level
 * command actions — which cannot call {@link useWorkspace} — read the same properties off the store
 * proxy as a plain snapshot (a store read outside a tracking scope is the current value). Fields are
 * deliberately flat (data first, then capabilities) so a read site stays `ws.analysis` / `ws.quit()`
 * — the same flat surface the command actions consume, so a command body and a component read it the
 * same way.
 */
export type Workspace = {
    /** The open analysis, or `null` when the chat is not analysis-scoped (keeps the command `enabled` guards meaningful). */
    analysis: Analysis | null;
    /**
     * The open chat's Postgres conversation thread id — the one session identity. `null` until it is
     * resolved, which cannot happen before the harness boot reaches `ready` (the thread store has no
     * pre-boot source); a non-null id may still have no row yet, since a freshly minted identity's row
     * is created by the first turn. Every session-scoped surface treats `null` as "not bound yet".
     */
    sessionId: string | null;
    /** The open chat's resolved working directory. */
    workingDir: string;
    /**
     * The analysis's linked project, read from the server (`GET {A}`) after each swap; `null` when unlinked,
     * until the read lands, and when the read fails.
     */
    project: ProjectView | null;
    /** The home folder of the analysis, from the same read. `null` until it lands, and when the anchor row is gone. */
    anchor: AnchorView | null;
    /** The count of the inputs of the analysis, from the same read. `null` until it lands. */
    inputCount: number | null;
    /** Push a modal (picker / prompt / results) onto the dialog stack. */
    openDialog: (render: () => JSX.Element) => void;
    /** Pop the top modal. */
    closeDialog: () => void;
    /** Swap the open chat in place — bind a different thread and/or analysis without a restart. */
    openSession: (threadId: string | null, workingDir: string, analysis: Analysis) => void;
    /**
     * Read the project, the anchor, and the input count of the open analysis again: after an input change
     * of this client, and at the end of a turn, whose agent can change the inputs. The server pushes nothing.
     */
    refreshScope: () => void;
    /** Quit the app cleanly (restore the terminal, then exit). */
    quit: () => Promise<void>;
};

/**
 * What {@link createWorkspace} needs from the host (`app.tsx`): the scope seed and the capabilities
 * that close over host-local state. The chat hot state (messages, stream, status) is reset
 * reactively by the `Chat` component watching `sessionId`, so the host passes no reset hook here.
 */
export type WorkspaceInit = {
    analysis: Analysis | null;
    /** The thread id to seed the scope with — `null` on every launch, since nothing pre-boot can resolve one. */
    sessionId: string | null;
    workingDir: string;
    openDialog: (render: () => JSX.Element) => void;
    closeDialog: () => void;
    quit: () => Promise<void>;
};

/**
 * What {@link openSession} drives beyond the store. Tests replace each one, thus a swap runs offline (no
 * server, no live turn).
 *
 * The instance lock of an analysis is not here: the server takes it at the first request for the analysis,
 * and the caller of a swap reads `GET {A}` before it swaps (`openAnalysis` in `commands.tsx`).
 */
export type WorkspaceOpts = {
    /** Abort any in-flight chat turn (real: `abort` from `hooks/conversation.ts`). */
    readonly abortTurn: () => void;
    /** One analysis with its scope, or `null` when the read fails (real: `GET {A}`). */
    readonly fetchDetail: (analysisId: string) => Promise<AnalysisDetail | null>;
};

/** The production {@link WorkspaceOpts}. */
export const DEFAULT_WORKSPACE_OPTS: WorkspaceOpts = {
    abortTurn: abortConversationTurn,
    fetchDetail: async (analysisId) =>
        (await fetchAnalysis(analysisId)).match(
            (detail) => detail,
            () => null,
        ),
};

/**
 * Build the workspace store. The store lives HERE, not in `app.tsx`, because the context owns its
 * reactivity: a Solid context only transports a value down the tree — it is NOT itself reactive, so
 * for the sidebar/status bar to repaint on an in-place swap the value must be a reactive primitive.
 * Accessors are deliberately avoided, so a `createStore` (which gives plain-property reactive reads)
 * is the mechanism. `openSession` is the SOLE writer of the scope data: it sets the three scope fields,
 * and the `GET {A}` read of each swap sets the project, the anchor, and the input count. The chat hot state is reset reactively by the `Chat`
 * component watching `sessionId`, not by a host callback here. The capability fields are never
 * written through the store. `opts` is injected only by tests.
 */
export function createWorkspace(init: WorkspaceInit, opts: WorkspaceOpts = DEFAULT_WORKSPACE_OPTS): Workspace {
    // The scope of the server arrives after the swap. A read that lands after a later swap is dropped, thus
    // the scope of a different analysis never shows. A failed read keeps the last answer.
    const refreshScope = (analysisId: string): void => {
        void opts.fetchDetail(analysisId).then((detail) => {
            if (detail === null || store.analysis?.id !== analysisId) return;
            setStore({ project: detail.project, anchor: detail.anchor, inputCount: detail.inputCount });
        });
    };
    const [store, setStore] = createStore<Workspace>({
        analysis: init.analysis,
        sessionId: init.sessionId,
        workingDir: init.workingDir,
        project: null,
        anchor: null,
        inputCount: null,
        openDialog: init.openDialog,
        closeDialog: init.closeDialog,
        quit: init.quit,
        // The store's own setter, captured here so the scope has a single writer. References
        // `store`/`setStore` from the destructuring above — created now, only invoked after the
        // store exists.
        openSession(threadId, workingDir, analysis) {
            const prev = store.analysis;
            // A swap to a different analysis aborts any in-flight turn BEFORE the scope moves, so no turn
            // keeps running against an analysis this chat no longer shows. A same-analysis session switch
            // leaves that abort to the Chat effect on `sessionId` (resetHotState).
            if (!prev || prev.id !== analysis.id) opts.abortTurn();
            if (prev?.id === analysis.id) setStore({ analysis, sessionId: threadId, workingDir });
            else setStore({ analysis, sessionId: threadId, workingDir, project: null, anchor: null, inputCount: null });
            // Read again for the same analysis too: a set-project or a rename swaps in place.
            refreshScope(analysis.id);
        },
        refreshScope() {
            const a = store.analysis;
            if (a !== null) refreshScope(a.id);
        },
    });
    if (init.analysis !== null) refreshScope(init.analysis.id);
    return store;
}

/** The chat scope + capabilities context. No default value: a missing Provider is a wiring bug. */
export const WorkspaceContext = createContext<Workspace>();

/**
 * Read the {@link Workspace} from context. Throws when called outside a `WorkspaceContext.Provider`.
 *
 * The `throw` is deliberate and does not owe a `Result`: a missing Provider is a WIRING bug — the same
 * invariant class as an exhaustive-switch `default`, a condition the component tree's shape makes
 * unreachable, not a runtime failure a caller could meaningfully handle. Every consumer already sits
 * under the Provider that `App` mounts; one that does not is broken at author time and cannot recover
 * by branching on an `Err`. Failing loud here beats handing back `undefined` and crashing deeper, at a
 * property read, where the stack no longer names the cause.
 */
export function useWorkspace(): Workspace {
    const ws = useContext(WorkspaceContext);
    if (!ws) throw new Error("useWorkspace must be called within a WorkspaceContext.Provider");
    return ws;
}
