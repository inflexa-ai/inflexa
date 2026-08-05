/**
 * LLM step wrapper shared by every DBOS workflow that makes a model call.
 *
 * Each call goes through `runLlmStep` — it wraps `DBOS.runStep({name})` around
 * the chat provider call and classifies caught errors:
 *
 *   - `isBudgetExceeded(err) === true` (billing-gateway 402): self-send a
 *     `BUDGET_EXCEEDED_TOPIC` marker addressed to this workflow's own
 *     id, then return a sentinel marker. The wrapper does NOT call
 *     `DBOS.cancelWorkflow` itself — the workflow's own terminal block
 *     reads the marker, writes `status = "suspended_insufficient_funds"`
 *     in its own named `DBOS.runStep`, then issues `DBOS.cancelWorkflow` +
 *     a trailing `runStep` to materialise the CANCELLED terminal state.
 *     Deferring the cancel keeps the terminal handler's DB writes inside
 *     DBOS step boundaries (replay-cached).
 *   - anything else: rethrow, so the caller decides whether the failure is a
 *     coverage envelope or a hard error.
 *
 * The step name is attempt-numbered by the caller — e.g.
 * `"ta-synth:liability-bullets:0"`. On 402 + top-up + `DBOS.resumeWorkflow`
 * the caller bumps the attempt counter so the resumed call lands a fresh
 * DBOS cache slot rather than replaying the cancelled prior attempt. Because
 * the name comes from the caller, relocating this module cannot move an
 * existing step's cache slot.
 */

import { DBOS } from "@dbos-inc/dbos-sdk";

import { createNoopLogger } from "../../lib/console-logger.js";
import type { Logger } from "../../lib/logger.js";
import { unwrapOrThrow } from "../../lib/result.js";
import { isBudgetExceeded } from "../../loop/budget-exceeded.js";
import type { AgentChat, ChatRequest, ChatResponse } from "../../providers/types.js";
import type { AgentSession } from "../../auth/types.js";

/**
 * DBOS message topic the LLM step uses to mark the workflow as
 * self-cancelled on a billing-gateway 402. The terminal handler drains the topic
 * to dispatch to its suspend path rather than the generic operator-cancel
 * handler.
 *
 * The `ta-` spelling outlives the move: a topic is persisted with the message in
 * DBOS's notification table, so renaming it would strand a marker sent by a
 * workflow that was already in flight. The topic is scoped to the receiving
 * workflow id, so one name serves every workflow.
 *
 * Distinct from `sandbox-step.ts`'s `"child-budget-exceeded"`, which carries a
 * child step's exhaustion to its parent. This one a workflow sends to itself.
 */
export const BUDGET_EXCEEDED_TOPIC = "ta-budget-exceeded";

export interface BudgetExceededMarker {
    readonly stepName: string;
    readonly agentId: string;
    readonly error: string;
}

export interface RunLlmStepOptions {
    /** Operational logging seam; omitted falls back to no-op. */
    readonly logger?: Logger;
    /** Durable-step name — already attempt-numbered by the caller. */
    readonly stepName: string;
    /** Agent id stamped in the marker for telemetry. */
    readonly agentId: string;
    readonly provider: AgentChat;
    readonly req: ChatRequest;
    readonly session: AgentSession;
    readonly signal?: AbortSignal;
}

/**
 * Sentinel returned (NOT thrown) when the wrapper has self-cancelled the
 * workflow. The next `DBOS.runStep` after this point raises
 * `DBOSWorkflowCancelledError`, so call sites only see this value on the
 * synchronous return path before the cancel materialises. Callers MUST NOT
 * wrap this as a coverage envelope — the workflow is unwinding.
 *
 * A registry symbol, so identity holds across module realms. Its `ta.` key is
 * kept for the same reason the topic's is: it is an identity other code already
 * pins, not a description of who may use it.
 */
export const BUDGET_EXCEEDED_SENTINEL = Symbol.for("ta.budget-exceeded");

export type RunLlmStepResult =
    { readonly kind: "ok"; readonly response: ChatResponse } | { readonly kind: "budget-exceeded"; readonly sentinel: typeof BUDGET_EXCEEDED_SENTINEL };

/**
 * Run one LLM call inside a `DBOS.runStep` boundary. On a billing-gateway 402 the
 * workflow self-cancels and the caller receives a sentinel result; on any
 * other throw the original error rethrows.
 */
export async function runLlmStep(opts: RunLlmStepOptions): Promise<RunLlmStepResult> {
    const { stepName, agentId, provider, req, session, signal } = opts;

    try {
        const response = await DBOS.runStep(async () => unwrapOrThrow(await provider.chat(req, session, signal)), { name: stepName });
        return { kind: "ok", response };
    } catch (err) {
        if (!isBudgetExceeded(err)) {
            throw err;
        }

        const workflowId = DBOS.workflowID;
        if (!workflowId) {
            // Should not happen — the wrapper is only callable from inside a
            // workflow body. Surface as a generic throw so the caller does not
            // misclassify as coverage failure.
            throw err;
        }

        const marker: BudgetExceededMarker = {
            stepName,
            agentId,
            error: err instanceof Error ? err.message : String(err),
        };

        // Self-send a marker so the terminal handler's `DBOS.recv(topic, 0)`
        // drain sees it before the body unwinds. DBOS persists the send under
        // (workflowID, function_id), so replay does not duplicate the
        // marker. The send is wrapped in `DBOS.runStep` to own the slot.
        //
        // The workflow is NOT cancelled here — the body propagates the
        // sentinel through phase outputs, the terminal block runs its DB
        // writes inside DBOS step boundaries, and the cancel materialises at
        // the very end via the terminal block's trailing
        // `DBOS.cancelWorkflow` + `DBOS.runStep("self-cancel-budget-exceeded")`.
        try {
            await DBOS.runStep(() => DBOS.send(workflowId, marker, BUDGET_EXCEEDED_TOPIC), { name: `${stepName}:notify-budget-exceeded` });
        } catch (sendErr) {
            const logger = (opts.logger ?? createNoopLogger()).named("llm-step");
            logger.warn("notify-budget-exceeded send failed (non-fatal)", { stepName, ...logger.errorFields(sendErr) });
        }

        return { kind: "budget-exceeded", sentinel: BUDGET_EXCEEDED_SENTINEL };
    }
}

/**
 * Drain the budget-exceeded topic for this workflow. Called from the
 * terminal handler (after the body has unwound) to decide whether the
 * workflow cancelled because of a 402 or because of an operator-initiated
 * cancel. Returns the first marker (or `null` if none queued).
 */
export async function readBudgetExceededMarker(): Promise<BudgetExceededMarker | null> {
    const msg = await DBOS.recv<BudgetExceededMarker>(BUDGET_EXCEEDED_TOPIC, 0);
    return msg ?? null;
}
