/**
 * Per-previewId serialization for report iterations.
 *
 * Two iterations on the same preview must not race on its shared
 * `assets/` directory or version-dir creation. This lock ensures
 * sequential execution per previewId; iterations on different previewIds
 * remain fully parallel.
 *
 * SCOPE — in-process only. This Map is process-local: it serializes
 * iterations within one replica but gives NO cross-pod guarantee, and it
 * does not survive a DBOS replay. That is acceptable today because
 * `runReportIteration` runs in the in-process chat path (`passthroughStep`),
 * not as a durable workflow. When `iterateReport` is ported to a DBOS
 * workflow, replace this with a durable mechanism (a DBOS queue keyed by
 * previewId, or a Postgres advisory lock) — an in-process lock would then be
 * both a replay and a cross-replica correctness bug.
 */

const previewLocks = new Map<string, Promise<unknown>>();

/** @internal — exposed for tests to assert no leak after settlement. */
export const __previewLocksForTest = previewLocks;

export async function withPreviewLock<T>(previewId: string, fn: () => Promise<T>): Promise<T> {
    const prior = previewLocks.get(previewId) ?? Promise.resolve();
    const next = prior.then(fn, fn);
    // The stored promise must not surface as an unhandled rejection — callers
    // only see/handle `next`. Swallow on the stored chain after running the
    // cleanup hook.
    const stored: Promise<unknown> = next
        .finally(() => {
            if (previewLocks.get(previewId) === stored) previewLocks.delete(previewId);
        })
        .catch(() => undefined);
    previewLocks.set(previewId, stored);
    return next;
}
