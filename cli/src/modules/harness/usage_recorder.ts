import { err, Result, ResultAsync } from "neverthrow";
import type { LlmUsageRecord, NoticeFailure, Scope, UsageRecorder } from "@inflexa-ai/harness";

import type { DbError } from "../../db/errors.ts";
import { upsertLlmUsage, type LlmUsageEntry } from "../../db/primary_mutation.ts";

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
 * `analysis_id`, is what keeps a per-analysis read (`scope_kind = 'analysis'`) honest.
 *
 * Returns `null` only for a variant this code does not know — unreachable while the harness has one
 * (the `satisfies never` makes a second a compile error here), and reported by the caller rather
 * than dropped quietly if it ever happens at runtime against a newer harness.
 */
function scopeColumns(scope: Scope): ScopeColumns | null {
    switch (scope.kind) {
        case "analysis":
            return {
                scopeKind: scope.kind,
                scopeId: scope.analysisId,
                ...(scope.threadId === undefined ? {} : { threadId: scope.threadId }),
            };
        default:
            // A NEW `Scope` variant fails to compile at this line rather than silently reaching the
            // runtime report below — a forgotten mapping is a build error, not a lost record.
            scope.kind satisfies never;
            return null;
    }
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
    return {
        recordKey: call.recordKey,
        recordedAt,
        agentId: call.agentId,
        callPath: call.callPath.join(CALL_PATH_SEPARATOR),
        ...scope,
        ...(call.runId === undefined ? {} : { runId: call.runId }),
        ...(call.stepId === undefined ? {} : { stepId: call.stepId }),
        ...(call.requestedModelId === undefined ? {} : { requestedModelId: call.requestedModelId }),
        ...(call.servedModelId === undefined ? {} : { servedModelId: call.servedModelId }),
        usage: call.usage,
    };
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
 * `record` is total: an unknown scope variant, a failed write, and a throw from below each come back
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
            const scope = scopeColumns(call.scope);
            if (scope === null) {
                // Statically `never`, so the cast only names what actually arrived at runtime —
                // the whole point of the report is to say which unknown variant was dropped.
                return err({ reason: `usage record dropped: unhandled scope variant ${(call.scope as { kind: string }).kind}` });
            }
            return upsert(toEntry(call, Date.now(), scope)).mapErr((error): NoticeFailure => ({
                reason: `usage ledger write failed for ${call.recordKey}: ${error.type}`,
            }));
        },
        (cause): NoticeFailure => ({ reason: `usage ledger write threw: ${cause instanceof Error ? cause.message : "a non-Error value"}` }),
    );

    return {
        record(call: LlmUsageRecord): ResultAsync<void, NoticeFailure> {
            return new ResultAsync(Promise.resolve(write(call).andThen((written) => written)));
        },
    };
}
