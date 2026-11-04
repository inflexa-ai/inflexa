import { Result, ResultAsync } from "neverthrow";
import type { LlmUsageRecord, NoticeFailure, Scope, UsageRecorder } from "@inflexa-ai/harness";

import type { DbError } from "../../db/errors.ts";
import { upsertLlmUsage, type LlmUsageEntry } from "../../db/primary_mutation.ts";
import { messageOf } from "../../lib/cause.ts";

// The cli's realization of the harness `UsageRecorder` seam: one synchronous upsert into the local
// SQLite ledger per completed LLM call. The harness names no storage — it emits records and the
// embedder decides where they land — so this module is the ONLY place a harness usage record crosses
// into the cli's ledger vocabulary.
//
// Two contract terms shape everything here, and both are load-bearing rather than stylistic. `record`
// MUST NOT throw: the agent loop delivers the notice bare — no `await`, no `try` — so a throw that
// escapes before the `ResultAsync` exists would fail a turn that had otherwise succeeded, over a
// bookkeeping row. And `record` MUST NOT block: it runs synchronously at LLM-call cadence on the loop's
// hot path, which is why the write is a single-row insert against a local WAL file rather than anything
// buffered or asynchronous (an async writer would trade guaranteed durability for microseconds, and be
// the only async store in the cli).
//
// The harness also guarantees key stability but NOT at-most-once delivery — a replayed durable workflow
// body re-fires `record` with a byte-identical `recordKey` — which the storage layer absorbs by
// upserting on that key. Nothing here needs to dedupe.

/**
 * Separator between the call-path segments as the ledger stores them.
 *
 * The path is one column because every reader of it prints or groups the chain whole; splitting it
 * back apart is nobody's query. `>` reads as a call chain and cannot occur inside an agent id, which
 * is the only property the choice has to have. Deliberately NOT a re-derivation of the harness's own
 * key composition: that delimiter is private to `recordKeyFor`, and matching it by coincidence would
 * invite a future reader to treat the two as one contract.
 */
const CALL_PATH_SEPARATOR = ">";

/** The scope columns one {@link Scope} variant contributes. `threadId` is present only on the variant that carries one. */
type ScopeColumns = Pick<LlmUsageEntry, "scopeKind" | "scopeId" | "threadId">;

/**
 * Flatten a harness {@link Scope} to the ledger's `(scope_kind, scope_id)` pair plus the thread.
 *
 * Total by construction. Storing the discriminant, rather than collapsing the scope into a bare
 * `analysis_id`, is what keeps a per-analysis read (`scope_kind = 'analysis'`) honest. The function
 * reads the one member of `Scope` directly, thus a NEW `Scope` variant fails to compile at this read
 * rather than reaching the runtime.
 */
function scopeColumns(scope: Scope): ScopeColumns {
    const columns: ScopeColumns = { scopeKind: scope.kind, scopeId: scope.analysisId };
    if (scope.threadId !== undefined) columns.threadId = scope.threadId;
    return columns;
}

/**
 * Map one harness record onto its ledger row, stamping `recordedAt` at arrival.
 *
 * The harness stamps no time on a record (its own decision), so arrival at this sink is the only clock
 * available — and the first arrival is the truest one, which is why the storage layer's upsert leaves
 * an existing `recorded_at` alone.
 *
 * Every optional is OMITTED rather than defaulted. The token quantities ride through untouched for the
 * same reason: absent means the provider did not report it, never zero, and this mapping is exactly
 * where that distinction is easiest to lose.
 */
function toEntry(call: LlmUsageRecord, recordedAt: number, scope: ScopeColumns): LlmUsageEntry {
    const entry: LlmUsageEntry = {
        recordKey: call.recordKey,
        recordedAt,
        agentId: call.agentId,
        callPath: call.callPath.join(CALL_PATH_SEPARATOR),
        ...scope,
        usage: call.usage,
    };
    if (call.runId !== undefined) entry.runId = call.runId;
    if (call.stepId !== undefined) entry.stepId = call.stepId;
    if (call.requestedModelId !== undefined) entry.requestedModelId = call.requestedModelId;
    if (call.servedModelId !== undefined) entry.servedModelId = call.servedModelId;
    return entry;
}

/** What {@link createUsageRecorder} needs from the world around it. */
export type UsageRecorderDeps = {
    /**
     * The ledger write. Defaults to {@link upsertLlmUsage}; injectable so the failure path can be
     * driven from a test without breaking a real database to provoke it.
     */
    readonly upsert?: (entry: LlmUsageEntry) => Result<void, DbError>;
};

/**
 * Build the ledger-backed {@link UsageRecorder}.
 *
 * Constructed ONCE per booted runtime at the composition root and stamped by `assembleCoreRuntime`
 * onto the conversation agent and every registered workflow, so one runtime reports to one ledger.
 *
 * `record` is total: a failed write and a throw from below each come back
 * as the `err` of the notice, with a reason, and never as a throw. The recorder logs nothing itself —
 * the harness logs the reason of a failed notice, which is where "a usage-ledger fault must never fail
 * a turn" is realized.
 */
export function createUsageRecorder(deps: UsageRecorderDeps = {}): UsageRecorder {
    const upsert = deps.upsert ?? upsertLlmUsage;

    // The one sanctioned bridge from a throw in this module. The write already returns a `Result`, but
    // `record` may not throw for ANY input, and a synchronous throw from anywhere below (a bind
    // rejecting an unexpected value, a connection failing to open) would otherwise escape into the
    // agent loop. The mapper reads nothing off the record, so it cannot itself throw.
    const write = Result.fromThrowable(
        (call: LlmUsageRecord): Result<void, NoticeFailure> => {
            return upsert(toEntry(call, Date.now(), scopeColumns(call.scope))).mapErr((error): NoticeFailure => ({
                reason: `usage ledger write failed for ${call.recordKey}: ${error.type}`,
            }));
        },
        (cause): NoticeFailure => ({ reason: `usage ledger write threw: ${messageOf(cause)}` }),
    );

    return {
        record(call: LlmUsageRecord): ResultAsync<void, NoticeFailure> {
            return new ResultAsync(Promise.resolve(write(call).andThen((written) => written)));
        },
    };
}
