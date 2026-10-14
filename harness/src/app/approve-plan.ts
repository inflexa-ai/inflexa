/**
 * Approve a stored plan by its id, with no model call.
 *
 * A host calls this when a person approves a plan. The function refuses a thread or a plan that does
 * not belong to the analysis, and a plan that a newer plan replaced. Then it starts the run of the plan,
 * emits the `approve-plan` provenance event, and appends one record to the thread. The record tells the
 * model that the run started, and it shows the person the approval and the run card.
 *
 * The function is an API boundary: it gives a `Result` for each outcome and never rejects for one. The
 * host gives the identity and the auth of the session, because the harness forwards the auth and never
 * mints it. The harness gives the provenance of the session.
 */

import { ResultAsync, err, ok, type Result } from "neverthrow";

import type { AgentSession, AuthContext, Identity } from "../auth/types.js";
import type { PlanApprovalPart } from "../contracts/chat-parts.js";
import type { ChatMessage } from "../contracts/message.js";
import { createNoopLogger } from "../lib/console-logger.js";
import type { DbError } from "../lib/db-result.js";
import { buildRunCardData, type RunCardData } from "../memory/card-builders.js";
import { conversationUIToChatMessages } from "../memory/conversation-display-storage.js";
import { conversationRecordTurn, createThreadHistory } from "../memory/thread-history.js";
import { createThreadStore } from "../memory/thread-store.js";
import { bindSessionEmit, type ProvenanceSeam } from "../provenance/seam.js";
import { loadPlanRecord } from "../state/index.js";
import { launchPlanRun, type LaunchPlanRunDeps, type LaunchPlanRunRefusal } from "../tools/execute-analysis.js";

/** The deps of an approval: the deps of the launch, and the provenance sink of the host. */
export type ApprovePlanDeps = LaunchPlanRunDeps & {
    readonly provenance?: ProvenanceSeam;
};

export type ApprovePlanInput = {
    analysisId: string;
    threadId: string;
    planId: string;
    identity: Identity;
    auth: AuthContext;
};

/**
 * The outcome of an approval. `started` is false when a run of the plan was already active: the
 * approval then changed nothing, and `message` is `null`. `message` is also `null` when the record
 * could not be appended, because the run started anyway. It has no `createdAt`: the transcript read
 * adds the time of the row.
 */
export type PlanApproval = {
    planId: string;
    runId: string;
    started: boolean;
    message: ChatMessage | null;
};

export type ApprovePlanRefusal = LaunchPlanRunRefusal | { type: "thread_not_found" } | { type: "superseded"; supersededBy: string };

const APPROVAL_PROVENANCE = { agentId: "plan-approval", callPath: ["plan-approval"] } as const;

function storeFailed(cause: DbError): Result<never, ApprovePlanRefusal> {
    return err({ type: "store_failed", cause });
}

/** The refusals that need no launch: a thread or a plan that does not belong, and a replaced plan. */
async function checkApprovable(deps: ApprovePlanDeps, input: ApprovePlanInput): Promise<Result<void, ApprovePlanRefusal>> {
    const read = await ResultAsync.combine([
        createThreadStore(deps.pool).getThread(input.threadId),
        loadPlanRecord(deps.pool, input.planId, { analysisId: input.analysisId }),
    ] as const);
    if (read.isErr()) return storeFailed(read.error);
    const [thread, record] = read.value;
    if (thread === null || thread.analysisId !== input.analysisId) return err({ type: "thread_not_found" });
    if (record === null) return err({ type: "plan_not_found", planId: input.planId });
    if (record.supersededBy !== null) return err({ type: "superseded", supersededBy: record.supersededBy });
    return ok(undefined);
}

async function approve(deps: ApprovePlanDeps, input: ApprovePlanInput): Promise<Result<PlanApproval, ApprovePlanRefusal>> {
    const logger = (deps.logger ?? createNoopLogger()).named("approve-plan");
    const { analysisId, threadId, planId } = input;

    const approvable = await checkApprovable(deps, input);
    if (approvable.isErr()) return err(approvable.error);

    // Read before the launch: the kernel writes the approval at this time, and the run writes
    // `run_started` from its workflow body after the launch, so the approval precedes the start.
    const approvedAtMs = Date.now();
    const session: AgentSession = {
        identity: input.identity,
        auth: input.auth,
        scope: { kind: "analysis", analysisId, threadId },
        provenance: APPROVAL_PROVENANCE,
    };
    const launched = await launchPlanRun(deps, { session, planId });
    if (launched.isErr()) return err(launched.error);
    const { runId, started } = launched.value;
    if (!started) return ok({ planId, runId, started: false, message: null });

    bindSessionEmit(deps.provenance, logger)({ type: "approve-plan", analysisId, threadId, planId, runId, atMs: approvedAtMs });

    const card = await buildRunCardData(deps.pool, { planId, analysisId, runId }).match(
        (data): RunCardData | null => data,
        (cause) => {
            logger.error("the run card of an approval could not be read", { analysisId, threadId, planId, runId, ...logger.errorFields(cause) });
            return null;
        },
    );
    const approval: PlanApprovalPart = { type: "data-plan-approval", planId, runId, approvedAt: new Date(approvedAtMs).toISOString() };
    const turn = conversationRecordTurn(`The person approved plan ${planId}. Run ${runId} started.`, [
        approval,
        ...(card === null ? [] : [{ type: "data-run-card" as const, ...card }]),
    ]);
    const appended = await createThreadHistory(deps.pool, logger).appendTurn(threadId, turn);
    if (appended.isErr()) {
        logger.error("the approval record could not be appended", { analysisId, threadId, planId, runId, ...logger.errorFields(appended.error) });
        return ok({ planId, runId, started: true, message: null });
    }
    return ok({ planId, runId, started: true, message: conversationUIToChatMessages(turn.displayMessages)[0] ?? null });
}

/** Approve the plan `planId` on the thread `threadId` of the analysis, and start its run. */
export function approvePlan(deps: ApprovePlanDeps, input: ApprovePlanInput): ResultAsync<PlanApproval, ApprovePlanRefusal> {
    return new ResultAsync(approve(deps, input));
}
