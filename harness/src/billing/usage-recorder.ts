/**
 * `UsageRecorder` — the per-call LLM usage-accounting seam.
 *
 * Sibling of `ResolveBilling` and `RunCharge`, and complementary to both:
 * `ResolveBilling` stamps attribution onto a wire call, `RunCharge` brackets a
 * run for managed billing, and `UsageRecorder` streams the fine-grained token
 * telemetry every completed LLM call produces. The harness names no storage or
 * display technology — it emits records; the embedder decides where they land.
 *
 * The loop is the single delivery site (it sees every reply in both execution
 * modes and already holds the session), so a realization is wired once at the
 * composition root and reaches every `runAgent` invocation through the deps
 * bags. OSS default: `createNoopUsageRecorder` (`./noop-usage-recorder.ts`).
 */

import type { ResultAsync } from "neverthrow";

import type { Scope } from "../auth/types.js";
import type { NoticeFailure } from "../lib/hooks.js";
import type { ChatUsage } from "../providers/types.js";

/** One completed LLM call's token usage, with the attribution held at the call site. */
export interface LlmUsageRecord {
    /**
     * Idempotency key. Stable across every replay of the same call: under a
     * `RunFrame` it composes the `runId`, the frame's `stepId` when it carries
     * one, the session's provenance call path, the dispatching tool call's id
     * when the loop runs nested inside one, and the loop's deterministic step
     * name; outside a `RunFrame` (the chat path, where no replay exists) it is
     * freshly minted. Every component past the frame is load-bearing, because
     * a step name is unique only within one loop invocation and loops routinely
     * share a frame: the `stepId` keeps sibling step workflows of one run
     * apart, the call path keeps distinct agent chains under one frame apart,
     * and the invocation id keeps parallel dispatches of one sub-agent apart.
     * The harness guarantees key stability, not at-most-once delivery —
     * consumers MUST upsert on this key, or a replayed workflow body will
     * double-count the call.
     */
    readonly recordKey: string;
    /** Agent that made the call — a sub-agent records under its own id. */
    readonly agentId: string;
    /** Provenance path from the root agent down to `agentId`. */
    readonly callPath: readonly string[];
    /** Scope ids as attribution: `analysisId`. */
    readonly scope: Scope;
    /** Present only for calls made inside a run (the session carries a `RunFrame`). */
    readonly runId?: string;
    /** Present only for calls made inside a run step. */
    readonly stepId?: string;
    /** Model the harness asked for; absent when the provider does not report it. */
    readonly requestedModelId?: string;
    /** Model that actually answered; absent when the endpoint does not report it. */
    readonly servedModelId?: string;
    /** What the provider reported. Unreported figures stay absent, never zeroed. */
    readonly usage: ChatUsage;
}

/**
 * Records one `LlmUsageRecord` per completed LLM call.
 *
 * `record` is a notice (see `lib/hooks.ts`). It gives a failure as an `err`,
 * never as a throw. The loop does not wait for the result and puts no `try`
 * around the call. When the result arrives, the loop logs the reason of an
 * `err`, and the run continues with no change. A recorder that blocks does not
 * make a run slower, but a realization that throws before it returns a
 * `ResultAsync` still fails the run it was only meant to observe.
 */
export interface UsageRecorder {
    record(record: LlmUsageRecord): ResultAsync<void, NoticeFailure>;
}
