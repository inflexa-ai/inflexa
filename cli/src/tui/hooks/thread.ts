import { randomUUIDv7 } from "bun";
import { createEffect, createSignal } from "solid-js";
import { ResultAsync } from "neverthrow";
import { createThreadStore, type DbError, type Pool, type Thread, type ThreadPage } from "@inflexa-ai/harness";

import type { HarnessRuntime } from "../../modules/harness/runtime.ts";
import type { Workspace } from "../contexts/workspace.ts";
import type { Notice } from "../theme.ts";
import { bootState, harnessRuntime } from "./boot.ts";
import { notify } from "./notice.ts";

// The open chat's Postgres conversation thread — resolution plus the row's metadata — held here (not
// inside `app.tsx` / `layout/sidebar.tsx`) so the holder is decoupled from its renderers, the same
// split as `boot.ts` / `sidebar_live.ts`. Postgres is the only store of session identity, and it is
// reachable only once boot reaches `ready`, so both jobs live behind that edge: `watchOpenThread`
// binds a thread id into the workspace scope the moment a pool exists, and keeps a snapshot of that
// thread's row for the sidebar's SESSION section. One chat screen is mounted at a time, so a module
// singleton is correct; the snapshot is the only reactive cell (the generation token and the
// in-flight-resolution marker are plain infrastructure, nothing reacts to them).

/**
 * The SESSION rail's render input for the open thread:
 * - `unresolved` — no thread is bound yet (pre-`ready`, or the ready-edge resolution is in flight);
 * - `unavailable` — the row read failed (a `DbError`; never a crash);
 * - `absent` — a thread id is bound but has no row: a freshly minted identity whose row the first
 *   turn creates (`prepareChatTurn`), or a thread deleted out from under us;
 * - `loaded` — the live row, carrying the pg-owned title and timestamps.
 */
export type ThreadSnapshot = { kind: "unresolved" } | { kind: "unavailable" } | { kind: "absent" } | { kind: "loaded"; thread: Thread };

const [threadState, setThreadState] = createSignal<ThreadSnapshot>({ kind: "unresolved" });

/** The open thread's row snapshot — read in a tracking scope to repaint on a bind/rename/refresh. */
export const openThread = threadState;

/**
 * Injectable edges so thread resolution and the metadata read are unit-testable offline (no Postgres,
 * no booted runtime) — mirrors `RefreshSeams` in `sidebar_live.ts`. Production callers omit the
 * argument and get the real booted runtime + harness thread store.
 */
export type ThreadSeams = {
    /** The booted runtime handle, or `null` when boot is not ready. Real: {@link harnessRuntime}. */
    readonly runtime: () => HarnessRuntime | null;
    /** An analysis's live threads, most-recently-active first. Real: `createThreadStore(pool).listThreads`. */
    readonly listThreads: (pool: Pool, analysisId: string) => ResultAsync<ThreadPage, DbError>;
    /** One thread's row, or `null` when absent/soft-deleted. Real: `createThreadStore(pool).getThread`. */
    readonly getThread: (pool: Pool, threadId: string) => ResultAsync<Thread | null, DbError>;
    /** Raise a transient toast. Real: {@link notify}. Injected so the degrade path is observable. */
    readonly notify: (notice: Notice) => void;
};

const realThreadSeams: ThreadSeams = {
    runtime: harnessRuntime,
    listThreads: (pool, analysisId) => createThreadStore(pool).listThreads({ analysisId }),
    getThread: (pool, threadId) => createThreadStore(pool).getThread(threadId),
    notify,
};

/**
 * Pick the conversation thread to open for an analysis: its most-recently-active live thread, else a
 * freshly minted id. A mint is an IDENTITY, not a row — nothing is written here, and the row is
 * created by the first turn, so opening a chat and typing nothing persists nothing anywhere.
 *
 * Returns `null` when the runtime is not booted: the thread store lives in Postgres, which has no
 * pre-`ready` source, so the caller leaves the scope unbound and {@link watchOpenThread} binds one at
 * the ready edge. Minting eagerly there would strand the user on an empty chat while their existing
 * threads sat unread.
 *
 * A failed listing degrades to a fresh mint with a toast rather than an error: the user still gets a
 * working chat, and the unread threads are recoverable through the session picker once the read
 * succeeds again.
 */
export async function resolveThreadId(analysisId: string, seams: ThreadSeams = realThreadSeams): Promise<string | null> {
    const runtime = seams.runtime();
    if (!runtime) return null;
    return (await seams.listThreads(runtime.pool, analysisId)).match(
        (page) => page.threads[0]?.threadId ?? randomUUIDv7(),
        () => {
            seams.notify({ kind: "warn", text: "Could not list this analysis's conversations — starting a new one." });
            return randomUUIDv7();
        },
    );
}

// Monotonic token ordering every asynchronous write to the snapshot. A rapid session swap (or a
// rename poke landing beside one) interleaves its row reads and the older can resolve LAST; each read
// re-checks the token after its await so the newest refresh STARTED wins. Mirrors `refreshGeneration`
// in `sidebar_live.ts`.
let metadataGeneration = 0;

/**
 * Re-read the bound thread's row into the {@link openThread} snapshot. `null` (or an unbooted
 * runtime) resets it to `unresolved` — the sidebar's placeholder — and issues no query.
 *
 * Called by {@link watchOpenThread} on every bind/boot edge, and directly by the rename command,
 * whose write changes the row without changing the bound id (so no reactive edge would fire).
 */
export async function refreshOpenThread(threadId: string | null, seams: ThreadSeams = realThreadSeams): Promise<void> {
    // Bump BEFORE the guards so even the unresolved path invalidates an in-flight older read — a swap
    // to an unbound scope must not later be overwritten by a slow read from the previous one.
    const mine = ++metadataGeneration;
    const runtime = seams.runtime();
    if (!runtime || threadId === null) {
        setThreadState({ kind: "unresolved" });
        return;
    }
    const res = await seams.getThread(runtime.pool, threadId);
    if (mine !== metadataGeneration) return;
    res.match(
        (thread) => setThreadState(thread === null ? { kind: "absent" } : { kind: "loaded", thread }),
        () => setThreadState({ kind: "unavailable" }),
    );
}

// The analysis whose ready-edge resolution is in flight, so a repaint between the effect firing and
// its listing resolving cannot start a second one — two mints would race and the loser's id would be
// silently replaced. Cleared when that resolution settles.
let resolvingForAnalysisId: string | null = null;

/**
 * Wire the open thread's lifecycle. Call once from `App` (inside its reactive root). Two effects over
 * the boot phase and the workspace scope:
 *
 *  1. **bind at the ready edge** — when boot is `ready`, an analysis is open, and no thread is bound,
 *     resolve one ({@link resolveThreadId}) and write it into the scope through `openSession`, the
 *     single scope write path. Skipped the moment a thread is bound, so an in-place swap that resolved
 *     its own thread (the palette's analysis/session commands) is never re-resolved on top of.
 *  2. **track the row** — re-read the bound thread's row whenever the bound id or the boot phase
 *     changes, so the sidebar's SESSION section shows the pg title and age of whatever is open.
 */
export function watchOpenThread(workspace: Workspace, seams: ThreadSeams = realThreadSeams): void {
    createEffect(() => {
        const phase = bootState().phase;
        const analysis = workspace.analysis;
        const bound = workspace.sessionId;
        if (phase !== "ready" || !analysis || bound !== null) return;
        if (resolvingForAnalysisId === analysis.id) return;
        const analysisId = analysis.id;
        resolvingForAnalysisId = analysisId;
        void resolveThreadId(analysisId, seams).then((resolved) => {
            resolvingForAnalysisId = null;
            if (resolved === null) return;
            // The listing is a Postgres round-trip, during which the user can swap analyses or a
            // palette command can bind a thread itself. Both make this resolution stale, and writing it
            // would swap the user off the chat they just opened — so drop it. The reads here are
            // deliberately outside the tracking scope (this runs after the effect returned), so they
            // are a plain snapshot of the live scope, not new dependencies.
            const open = workspace.analysis;
            if (!open || open.id !== analysisId || workspace.sessionId !== null) return;
            workspace.openSession(resolved, workspace.workingDir, open);
        });
    });

    createEffect(() => {
        const phase = bootState().phase;
        const bound = workspace.sessionId;
        // Pre-`ready` there is no pool to read the row from, so collapse to the placeholder rather than
        // showing a bound id's stale metadata from a previous boot.
        void refreshOpenThread(phase === "ready" ? bound : null, seams);
    });
}

/** Test hook: drop the open-thread snapshot and any in-flight resolution/read. Test-only. */
export function __resetOpenThreadForTest(): void {
    metadataGeneration += 1;
    resolvingForAnalysisId = null;
    setThreadState({ kind: "unresolved" });
}
