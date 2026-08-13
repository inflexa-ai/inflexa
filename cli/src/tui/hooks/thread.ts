import { randomUUIDv7 } from "bun";
import { createEffect, createSignal } from "solid-js";
import { ResultAsync } from "neverthrow";
import { createThreadStore, type DbError, type Pool, type Thread, type ThreadPage } from "@inflexa-ai/harness";

import type { HarnessRuntime } from "../../modules/harness/runtime.ts";
import type { Workspace } from "../contexts/workspace.ts";
import type { Notice } from "../theme.ts";
import { bootState, harnessRuntime } from "./boot.ts";
import { notify } from "./notice.ts";
import { chatStatus, type ChatStatus } from "./status.ts";

// The open chat's Postgres conversation thread — resolution plus the row's metadata — held here (not
// inside `app.tsx` / `layout/sidebar.tsx`) so the holder is decoupled from its renderers, the same
// split as `boot.ts` / `sidebar_live.ts`. Postgres is the only store of session identity, and it is
// reachable only once boot reaches `ready`, so both jobs live behind that edge: `watchOpenThread`
// binds a thread id into the workspace scope the moment a pool exists, and keeps a snapshot of that
// thread's row for the sidebar's SESSION section. One chat screen is mounted at a time, so a module
// singleton is correct; the snapshot is the only reactive cell (the generation token, the
// in-flight-resolution marker, and the id the snapshot describes are plain infrastructure, nothing
// reacts to them).

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

// Which thread the CURRENT snapshot describes. A refresh for a DIFFERENT id must blank the rail
// synchronously: the row read is a full Postgres round-trip, and until it lands the snapshot still
// holds the thread the user just swapped (or deleted) away from — so the SESSION section would keep
// painting the previous conversation's title for that whole window. A refresh for the SAME id must
// NOT blank it: a rename poke or a post-turn re-read would otherwise flash the placeholder over a
// row that is still correct. Plain infrastructure, not a reactive cell — only the refresh reads it.
let snapshotThreadId: string | null = null;

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
    /**
     * An analysis's live conversations, most-recently-active first. The listing narrows on the
     * `conversation` type, and the narrow is necessary: the store orders by last activity, thus a
     * report child spawned a moment ago sorts ahead of every conversation. Without the narrow the next
     * launch would open that report child, and the report agent would answer the first message the
     * user types. Real: `createThreadStore(pool).listThreads` with `type`.
     */
    readonly listThreads: (pool: Pool, analysisId: string) => ResultAsync<ThreadPage, DbError>;
    /** One thread's row, or `null` when absent/soft-deleted. Real: `createThreadStore(pool).getThread`. */
    readonly getThread: (pool: Pool, threadId: string) => ResultAsync<Thread | null, DbError>;
    /** Raise a transient toast. Real: {@link notify}. Injected so the degrade path is observable. */
    readonly notify: (notice: Notice) => void;
};

/**
 * The production realizations of {@link ThreadSeams}.
 *
 * Exported so a test can observe the narrowing, which lives HERE and nowhere else: `resolveThreadId`
 * applies no filter of its own, and a seam injected in this one's place shows what the FAKE was told
 * rather than what the real one passes to the store.
 */
export const realThreadSeams: ThreadSeams = {
    runtime: harnessRuntime,
    listThreads: (pool, analysisId) => createThreadStore(pool).listThreads({ analysisId, type: "conversation" }),
    getThread: (pool, threadId) => createThreadStore(pool).getThread(threadId),
    notify,
};

/**
 * Pick the conversation thread to open for an analysis: its most-recently-active live conversation,
 * else a freshly minted id. A mint is an IDENTITY, not a row — nothing is written here, and the row is
 * created by the first turn, so opening a chat and typing nothing persists nothing anywhere.
 *
 * Returns `null` when the runtime is not booted: the thread store lives in Postgres, which has no
 * pre-`ready` source, so the caller leaves the scope unbound and {@link watchOpenThread} binds one at
 * the ready edge. Minting eagerly there would strand the user on an empty chat while their existing
 * threads sat unread.
 *
 * A failed listing degrades to a fresh mint with a toast rather than an error: the user still gets a
 * working chat, and the unread conversations are recoverable through the session picker once the read
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
 * A read for a thread the snapshot does not already describe resets it to `unresolved` SYNCHRONOUSLY,
 * before the query, so a swap never paints the previous conversation's title across the round-trip;
 * a read for the same thread leaves the snapshot standing, so a rename poke or a post-turn re-read
 * never blinks a correct row away.
 *
 * Called by {@link watchOpenThread} on every bind/boot/turn edge, and directly by the rename command,
 * whose write changes the row without changing the bound id (so no reactive edge would fire).
 */
export async function refreshOpenThread(threadId: string | null, seams: ThreadSeams = realThreadSeams): Promise<void> {
    // Bump BEFORE the guards so even the unresolved path invalidates an in-flight older read — a swap
    // to an unbound scope must not later be overwritten by a slow read from the previous one.
    const mine = ++metadataGeneration;
    const runtime = seams.runtime();
    if (!runtime || threadId === null) {
        snapshotThreadId = null;
        setThreadState({ kind: "unresolved" });
        return;
    }
    if (snapshotThreadId !== threadId) {
        snapshotThreadId = threadId;
        setThreadState({ kind: "unresolved" });
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
// silently replaced. Cleared by the resolution that OWNS it (see `clearResolutionOf`).
let resolvingForAnalysisId: string | null = null;

/**
 * Release the in-flight marker only if it still names this resolution's analysis.
 *
 * An unconditional clear would let a settling resolution for analysis A drop a marker that a later
 * effect run had since re-taken for analysis B, re-opening the double-mint this marker exists to
 * close. Today nothing reaches that interleaving — the scope is never left unbound while `ready`,
 * because `harnessRuntime()` is set before the phase flips (`hooks/boot.ts`), so every `openSession`
 * under `ready` binds a non-null id and the effect short-circuits. That invariant lives in another
 * module and is not this one's to assume: making the release conditional costs a comparison and
 * removes the dependency outright.
 */
function clearResolutionOf(analysisId: string): void {
    if (resolvingForAnalysisId === analysisId) resolvingForAnalysisId = null;
}

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
 *  3. **re-read after a turn** — re-read the bound thread's row on the `busy → idle` down-edge of
 *     {@link chatStatus}. The FIRST turn is what creates that row (and seeds its title from the
 *     message), and it does so under an unchanged bound id and boot phase — no edge above would fire,
 *     so without this the rail would read "new conversation" for the rest of the session. Every later
 *     turn rides the same edge, which is also what keeps the title and activity stamp current.
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
        void resolveThreadId(analysisId, seams).then(
            (resolved) => {
                clearResolutionOf(analysisId);
                if (resolved === null) return;
                // The listing is a Postgres round-trip, during which the user can swap analyses or a
                // palette command can bind a thread itself. Both make this resolution stale, and writing it
                // would swap the user off the chat they just opened — so drop it. The reads here are
                // deliberately outside the tracking scope (this runs after the effect returned), so they
                // are a plain snapshot of the live scope, not new dependencies.
                const open = workspace.analysis;
                if (!open || open.id !== analysisId || workspace.sessionId !== null) return;
                workspace.openSession(resolved, workspace.workingDir, open);
            },
            // The marker clears on BOTH settlement paths. A throw out of the thread store (its expected
            // failures ride the Result channel inside `resolveThreadId`, so a rejection here is an
            // unexpected one) would otherwise leave the marker set forever: every later ready edge would
            // see this analysis as already resolving and skip, stranding the chat permanently unbound.
            // The throw itself is absorbed rather than crashing the render root — the next ready edge is
            // the retry, and the scope simply stays unbound until then.
            () => {
                clearResolutionOf(analysisId);
            },
        );
    });

    createEffect(() => {
        const phase = bootState().phase;
        const bound = workspace.sessionId;
        // Pre-`ready` there is no pool to read the row from, so collapse to the placeholder rather than
        // showing a bound id's stale metadata from a previous boot.
        void refreshOpenThread(phase === "ready" ? bound : null, seams);
    });

    // The turn-completion down-edge. `prev` is closure-local per watcher invocation; seeded to the
    // current status so the effect's initial (synchronous) run never fires a false edge. Mirrors the
    // sidebar's ledger refresh, which hangs off the same edge for the same reason: a turn writes rows
    // nothing in the scope observes.
    //
    // Leaving `busy` at all is the edge, not reaching `idle`. A turn's thread row and its title are
    // created up front, before the agent runs, so a turn that fails afterwards has still written
    // exactly what this refresh exists to collect — and it settles on `error`, not `idle`. Keying on
    // `idle` would leave the rail reading "new conversation" for the rest of the session whenever a
    // chat's FIRST turn was the one that failed.
    let prev: ChatStatus = chatStatus();
    createEffect(() => {
        const status = chatStatus();
        const bound = workspace.sessionId;
        if (prev === "busy" && status !== "busy" && bound !== null) void refreshOpenThread(bound, seams);
        prev = status;
    });
}

/** Test hook: drop the open-thread snapshot and any in-flight resolution/read. Test-only. */
export function __resetOpenThreadForTest(): void {
    metadataGeneration += 1;
    resolvingForAnalysisId = null;
    snapshotThreadId = null;
    setThreadState({ kind: "unresolved" });
}
