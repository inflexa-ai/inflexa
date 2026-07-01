/**
 * LLM step wrapper for the target-assessment DBOS workflow body.
 *
 * Each Phase-2 decision and Phase-5 synthesis LLM call goes through
 * `runLlmStep` — it wraps `DBOS.runStep({name})` around the chat provider
 * call and classifies caught errors:
 *
 *   - `isBudgetExceeded(err) === true` (billing-gateway 402): self-send a
 *     `BUDGET_EXCEEDED_TOPIC` marker addressed to this workflow's own
 *     id, then return a sentinel marker. The wrapper does NOT call
 *     `DBOS.cancelWorkflow` itself — the workflow body's terminal block
 *     reads the marker, writes `status = "suspended_insufficient_funds"`
 *     via `DBOS.runStep({name: "ta-terminal-suspended"})`, then issues
 *     `DBOS.cancelWorkflow` + a trailing `runStep` to materialise the
 *     CANCELLED terminal state. Deferring the cancel keeps the terminal
 *     handler's DB writes inside DBOS step boundaries (replay-cached).
 *   - anything else: rethrow so the caller wraps the failure as
 *     `coverage: "queried_no_data"` with `error.kind: "synthesis-unavailable"`
 *     (or `"queried_no_data"` for decisions).
 *
 * The step name is attempt-numbered by the caller — e.g.
 * `"ta-synth:liability-bullets:0"`. On 402 + top-up + `DBOS.resumeWorkflow`
 * the caller bumps the attempt counter so the resumed call lands a fresh
 * DBOS cache slot rather than replaying the cancelled prior attempt.
 */

import { DBOS } from "@dbos-inc/dbos-sdk";

import { unwrapOrThrow } from "../../../lib/result.js";
import { isBudgetExceeded } from "../../../loop/budget-exceeded.js";
import type { AgentChat, ChatRequest, Message } from "../../../providers/types.js";
import type { AgentSession } from "../../../auth/types.js";

/**
 * DBOS message topic the LLM step uses to mark the workflow as
 * self-cancelled on a billing-gateway 402. The terminal handler drains the topic
 * to dispatch to `markAssessmentSuspended` rather than the generic
 * operator-cancel handler.
 */
export const BUDGET_EXCEEDED_TOPIC = "ta-budget-exceeded";

export interface BudgetExceededMarker {
    readonly stepName: string;
    readonly agentId: string;
    readonly error: string;
}

export interface RunLlmStepOptions {
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
 * wrap this as `coverage: "queried_no_data"` — the workflow is unwinding.
 */
export const BUDGET_EXCEEDED_SENTINEL = Symbol.for("ta.budget-exceeded");

export type RunLlmStepResult =
    | { readonly kind: "ok"; readonly message: Message }
    | { readonly kind: "budget-exceeded"; readonly sentinel: typeof BUDGET_EXCEEDED_SENTINEL };

/**
 * Run one LLM call inside a `DBOS.runStep` boundary. On a billing-gateway 402 the
 * workflow self-cancels and the caller receives a sentinel result; on any
 * other throw the original error rethrows.
 */
export async function runLlmStep(opts: RunLlmStepOptions): Promise<RunLlmStepResult> {
    const { stepName, agentId, provider, req, session, signal } = opts;

    try {
        const message = await DBOS.runStep(async () => unwrapOrThrow(await provider.chat(req, session, signal)), { name: stepName });
        return { kind: "ok", message };
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
            console.warn(`[ta-llm-step] notify-budget-exceeded send failed (non-fatal): ${sendErr instanceof Error ? sendErr.message : sendErr}`);
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
