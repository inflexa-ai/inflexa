import { createContext, useContext } from "solid-js";
import { createStore } from "solid-js/store";
import type { JSX } from "solid-js";

import { projectForAnalysis } from "../../modules/project/project.ts";
import { acquireAnalysisLock, releaseAnalysisLock } from "../../modules/analysis/lock.ts";
import { notify } from "../hooks/notice.ts";
import type { Analysis } from "../../types/analysis.ts";
import type { Project } from "../../types/project.ts";

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
    /** The currently-open chat session. */
    sessionId: string;
    /** The open chat's resolved working directory. */
    workingDir: string;
    /** The analysis's linked project, resolved from `analysis.projectId`; `null` when unlinked. */
    project: Project | null;
    /** Push a modal (picker / prompt / results) onto the dialog stack. */
    openDialog: (render: () => JSX.Element) => void;
    /** Pop the top modal. */
    closeDialog: () => void;
    /** Swap the open chat in place — resume a different analysis/session without a restart. */
    openSession: (sessionId: string, workingDir: string, analysis: Analysis) => void;
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
    sessionId: string;
    workingDir: string;
    openDialog: (render: () => JSX.Element) => void;
    closeDialog: () => void;
    quit: () => Promise<void>;
};

/**
 * Build the workspace store. The store lives HERE, not in `app.tsx`, because the context owns its
 * reactivity: a Solid context only transports a value down the tree — it is NOT itself reactive, so
 * for the sidebar/status bar to repaint on an in-place swap the value must be a reactive primitive.
 * Accessors are deliberately avoided, so a `createStore` (which gives plain-property reactive reads)
 * is the mechanism. `openSession` is the SOLE writer of the scope: it sets the four data fields
 * (project re-resolved from the new analysis). The chat hot state is reset reactively by the `Chat`
 * component watching `sessionId`, not by a host callback here. The capability fields are never
 * written through the store.
 */
export function createWorkspace(init: WorkspaceInit): Workspace {
    const [store, setStore] = createStore<Workspace>({
        analysis: init.analysis,
        sessionId: init.sessionId,
        workingDir: init.workingDir,
        project: projectForAnalysis(init.analysis),
        openDialog: init.openDialog,
        closeDialog: init.closeDialog,
        quit: init.quit,
        // The store's own setter, captured here so the scope has a single writer. References
        // `store`/`setStore` from the destructuring above — created now, only invoked after the
        // store exists. This is also the lock chokepoint: as the SOLE scope writer, re-keying the
        // analysis lock here means no in-process switch can bypass it. Invariant: acquire the target
        // BEFORE releasing the current, so a refused switch never strands us lockless.
        openSession(sessionId, workingDir, analysis) {
            const prev = store.analysis;
            // A same-analysis session switch (prev.id === analysis.id) needs no re-key — we already
            // hold this analysis's lock (acquire would re-entrantly succeed, release would drop the
            // lock we still want), so skip it entirely and just swap the session.
            if (!prev || prev.id !== analysis.id) {
                if (!acquireAnalysisLock(analysis.id).acquired) {
                    notify({ kind: "warn", text: `"${analysis.name}" is already open in another instance.` });
                    return; // keep the current analysis open and its lock held; abort the swap
                }
                if (prev) releaseAnalysisLock(prev.id);
            }
            setStore({ analysis, sessionId, workingDir, project: projectForAnalysis(analysis) });
        },
    });
    return store;
}

/** The chat scope + capabilities context. No default value: a missing Provider is a wiring bug. */
export const WorkspaceContext = createContext<Workspace>();

/**
 * Read the {@link Workspace} from context. Throws when called outside a `WorkspaceContext.Provider`
 * — failing loud beats handing back `undefined` and crashing deeper in a consumer.
 */
export function useWorkspace(): Workspace {
    const ws = useContext(WorkspaceContext);
    if (!ws) throw new Error("useWorkspace must be called within a WorkspaceContext.Provider");
    return ws;
}
