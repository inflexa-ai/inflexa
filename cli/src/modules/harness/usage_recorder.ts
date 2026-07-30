import type { Result } from "neverthrow";
import type { LlmUsageRecord, Logger, Scope, UsageRecorder } from "@inflexa-ai/harness";

import type { DbError } from "../../db/errors.ts";
import { upsertLlmUsage, type LlmUsageEntry } from "../../db/primary_mutation.ts";

// The cli's realization of the harness `UsageRecorder` seam: one synchronous upsert into the local
// SQLite ledger per completed LLM call. The harness names no storage — it emits records and the
// embedder decides where they land — so this module is the ONLY place a harness usage record crosses
// into the cli's ledger vocabulary.
//
// Two contract terms from the seam shape everything here, and both are load-bearing rather than
// stylistic. `record` MUST NOT throw: the agent loop delivers bare — no `await`, no `try` — so an
// escaping error would surface inside the loop body and fail a turn that had otherwise succeeded, over
// a bookkeeping row. And `record` MUST NOT block: it is called at LLM-call cadence from the loop's hot
// path, which is why the write is a single-row insert against a local WAL file rather than anything
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
 * Total over both variants by construction. The cli launches only analysis-scoped work today, but
 * dropping the target-assessment variant — or collapsing both into a bare `analysis_id` — would make
 * the ledger silently lie about a record it did receive. Storing the discriminant is what keeps a
 * per-analysis read (`scope_kind = 'analysis'`) honest.
 *
 * `billingContextId` is deliberately not stored: it is a managed-billing coordinate with no meaning to
 * a local ledger, and the row's identity question is "which workload spent this".
 *
 * Returns `null` only for a variant this code does not know — unreachable while the union has two
 * members (the `satisfies never` makes a third a compile error here), and reported by the caller
 * rather than dropped quietly if it ever happens at runtime against a newer harness.
 */
function scopeColumns(scope: Scope): ScopeColumns | null {
    switch (scope.kind) {
        case "analysis":
            return {
                scopeKind: scope.kind,
                scopeId: scope.analysisId,
                ...(scope.threadId === undefined ? {} : { threadId: scope.threadId }),
            };
        case "target-assessment":
            return { scopeKind: scope.kind, scopeId: scope.targetAssessmentId };
        default:
            // A NEW `Scope` variant fails to compile at this line rather than silently reaching the
            // runtime report below — a forgotten mapping is a build error, not a lost record.
            scope satisfies never;
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
     * Diagnostics sink. The harness's own `Logger` seam rather than a pino handle, because this is a
     * harness seam realization and the seam's contract says a recorder owns its error handling on the
     * injected logger — the composition root already holds the pino-backed realization to pass.
     */
    readonly logger: Logger;
    /**
     * The ledger write. Defaults to {@link upsertLlmUsage}; injectable so the swallow-and-log path can
     * be driven from a test without breaking a real database to provoke it.
     */
    readonly upsert?: (entry: LlmUsageEntry) => Result<void, DbError>;
};

/**
 * Build the ledger-backed {@link UsageRecorder}.
 *
 * Constructed ONCE per booted runtime at the composition root and stamped by `assembleCoreRuntime`
 * onto the conversation agent and every registered workflow, so one runtime reports to one ledger.
 *
 * `record` is total and silent: it returns `void` (never a promise), consumes the write's `Result`
 * itself, and reports a fault at `warn` before discarding it. Swallowing is the contract, not laziness
 * — the seam is precisely the boundary where "a usage-ledger fault must never fail a turn" is
 * realized, which is why the `Result` dies here instead of propagating.
 */
export function createUsageRecorder(deps: UsageRecorderDeps): UsageRecorder {
    const upsert = deps.upsert ?? upsertLlmUsage;
    const log = deps.logger.named("usage");

    return {
        record(call: LlmUsageRecord): void {
            // The one sanctioned swallowing `try`/`catch` in this module. It does not bridge a throw
            // into a `Result` (the write already returns one) — it exists because `record` may not
            // throw for ANY input, and a synchronous throw from anywhere below (a bind rejecting an
            // unexpected value, a connection failing to open) would otherwise escape into the agent
            // loop. The catch reads nothing off `call`, so it cannot itself throw; the record key is
            // dropped from the diagnostic deliberately to keep that guarantee unconditional.
            try {
                const scope = scopeColumns(call.scope);
                if (scope === null) {
                    // Statically `never`, so the cast only names what actually arrived at runtime —
                    // the whole point of the report is to say which unknown variant was dropped.
                    log.warn("usage record dropped: unhandled scope variant", { scopeKind: (call.scope as { kind: string }).kind });
                    return;
                }
                upsert(toEntry(call, Date.now(), scope)).match(
                    () => {},
                    (error) => log.warn("usage ledger write failed", { recordKey: call.recordKey, error: error.type }),
                );
            } catch (cause) {
                log.warn("usage ledger write threw", log.errorFields(cause));
            }
        },
    };
}
