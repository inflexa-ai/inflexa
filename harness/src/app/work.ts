/**
 * The durable work of an analysis, as a host lists, stops, resumes, and holds it (work-pause spec).
 *
 * A work is a chat turn, a run, or a data profile. Each work that is active is in the list, and a work that waits
 * in a pause carries each of its waiting workflows. One work can have more than one waiting workflow: a sub-agent
 * of a turn and each step of a run wait in their own workflows. A stop ends a work in each state. A resume and a
 * hold reach only a work that waits. Only a client resumes paused work.
 */

import { DBOS } from "@dbos-inc/dbos-sdk";

import type { PauseCause, WorkKind } from "../contracts/chat-parts.js";
import type { RunAuthorizer } from "../execution/run-authorizer.js";
import type { RunCanceler } from "../execution/run-canceler.js";
import { createNoopLogger } from "../lib/console-logger.js";
import { passGate } from "../lib/hooks.js";
import type { Logger } from "../lib/logger.js";
import { unwrapOrThrow } from "../lib/result.js";
import { turnCredentials } from "../loop/turn-credentials.js";
import { queryTurnsOfAnalysis } from "../state/active-turns.js";
import { loadDataProfileStatus } from "../state/data-profile.js";
import type { Querier } from "../state/db.js";
import { clearPauses, queryPausesOfAnalysis, queryPausesOfWork, type PauseRecord } from "../state/paused-work.js";
import { queryActiveRunsByAnalysis } from "../state/runs.js";
import { HOLD_MESSAGE, RESUME_MESSAGE } from "../workflows/pause.js";
import type { ChatTurnSession } from "./chat-turn.js";

/** One waiting workflow of a paused work. */
export type PausedWorkflow = {
    readonly workflowId: string;
    readonly state: "retrying" | "paused";
    readonly cause: PauseCause;
    /** The count of timer retries before this wait. */
    readonly attempt: number;
    /** ISO 8601. Present for the state `retrying` only. */
    readonly retryAt?: string;
    /** ISO 8601. */
    readonly pausedAt: string;
};

/** One active work: a turn, a run, or a data profile. */
export type Work = {
    /** The turn id, the run id, or the id of the profile workflow. */
    readonly workId: string;
    readonly kind: WorkKind;
    readonly analysisId: string;
    readonly threadId?: string;
    /** Each waiting workflow of the work. Empty for a work that runs. */
    readonly waiting: readonly PausedWorkflow[];
};

export type WorkStop = { readonly kind: "stopped"; readonly work: Work } | { readonly kind: "not_found" };

export type WorkResume =
    | { readonly kind: "resumed"; readonly workflows: number }
    | { readonly kind: "not_found" }
    /** The host refused to renew the run credential under the session, thus the work stays paused. */
    | { readonly kind: "refused"; readonly reason: string };

/** `workflows` is the count of waits in `retrying` that the hold reached. A wait in `paused` needs no hold. */
export type WorkHold = { readonly kind: "held"; readonly workflows: number } | { readonly kind: "not_found" };

/** The durable work of a runtime, as a host uses it. */
export type WorkSurface = {
    /**
     * The active work of an analysis: each turn that holds a thread, each `running` run, and the profile that runs.
     * A pause row whose workflow ended is not in it, and the list deletes that row.
     */
    list(analysisId: string): Promise<Work[]>;
    /**
     * Stop the work, in each state: a turn stops, a run cancels with its children, and a profile fails. Work of a
     * different analysis than the session gives `not_found`.
     */
    stop(session: ChatTurnSession, workId: string): Promise<WorkStop>;
    /**
     * Resume the work: each of its waiting workflows sends its request again. A wait in `retrying` ends at once, thus
     * the same call is "retry now". For a turn, the credential of the session goes to the turn first. For a run or a
     * profile, the host renews the run credential under the session first, and a refusal sends nothing. Work of a
     * different analysis than the session gives `not_found`.
     */
    resume(session: ChatTurnSession, workId: string): Promise<WorkResume>;
    /**
     * Hold the work: each of its waits in `retrying` moves to `paused`, and its timer stops. The work then waits for a
     * resume. Work of a different analysis than the session gives `not_found`.
     */
    hold(session: ChatTurnSession, workId: string): Promise<WorkHold>;
};

export type WorkDeps = {
    readonly pool: Querier;
    readonly runAuthorizer: RunAuthorizer;
    readonly logger?: Logger;
    /** The stop of a chat turn. */
    readonly stopTurn: (turnId: string) => Promise<void>;
    readonly runCanceler: RunCanceler;
    /** The stop of the profile workflow of an analysis. */
    readonly stopProfile: (analysisId: string, workflowId: string) => Promise<void>;
};

/** The workflow statuses that can still wait. */
const ACTIVE_STATUSES: ReadonlySet<string> = new Set(["PENDING", "ENQUEUED"]);

/** The provenance of a run cancel that a stop of work makes. */
const WORK_STOP_PROVENANCE = { agentId: "work-stop", callPath: ["work-stop"] };

function workflowOf(record: PauseRecord): PausedWorkflow {
    return {
        workflowId: record.workflowId,
        state: record.state,
        cause: record.cause,
        attempt: record.attempt,
        retryAt: record.retryAt,
        pausedAt: record.pausedAt,
    };
}

async function activeWorkflows(workflowIds: readonly string[]): Promise<ReadonlySet<string>> {
    if (workflowIds.length === 0) return new Set();
    const statuses = await DBOS.listWorkflows({ workflowIDs: [...workflowIds], loadInput: false, loadOutput: false });
    return new Set(statuses.filter((status) => ACTIVE_STATUSES.has(status.status)).map((status) => status.workflowID));
}

export function createWork(deps: WorkDeps): WorkSurface {
    const logger = (deps.logger ?? createNoopLogger()).named("harness.work");

    async function list(analysisId: string): Promise<Work[]> {
        const [records, turns, runs, profile] = await Promise.all([
            (async () => unwrapOrThrow(await queryPausesOfAnalysis(deps.pool, analysisId)))(),
            (async () => unwrapOrThrow(await queryTurnsOfAnalysis(deps.pool, analysisId)))(),
            (async () => unwrapOrThrow(await queryActiveRunsByAnalysis(deps.pool, analysisId)))(),
            (async () => unwrapOrThrow(await loadDataProfileStatus(deps.pool, analysisId)))(),
        ]);
        const profileWorkflowId = profile?.status === "running" ? (profile.workflowId ?? undefined) : undefined;
        const active = await activeWorkflows([
            ...records.map((record) => record.workflowId),
            ...turns.map((turn) => turn.turnId),
            ...(profileWorkflowId === undefined ? [] : [profileWorkflowId]),
        ]);

        const ended = records.filter((record) => !active.has(record.workflowId)).map((record) => record.workflowId);
        if (ended.length > 0) {
            const cleared = await clearPauses(deps.pool, ended);
            if (cleared.isErr()) logger.warn("the rows of ended pauses did not clear", { op: cleared.error.op, workflows: ended.length });
        }
        const waitingOf = new Map<string, PausedWorkflow[]>();
        for (const record of records) {
            if (!active.has(record.workflowId)) continue;
            waitingOf.set(record.workId, [...(waitingOf.get(record.workId) ?? []), workflowOf(record)]);
        }

        const work = new Map<string, Work>();
        const add = (workId: string, kind: WorkKind, threadId: string | undefined): void => {
            if (work.has(workId)) return;
            work.set(workId, { workId, kind, analysisId, threadId, waiting: waitingOf.get(workId) ?? [] });
        };
        // A claim can outlive its turn, thus a turn is active while its workflow is. A `running` run is active while
        // its row is, because the run canceler also converges a row whose workflow ended.
        for (const turn of turns) if (active.has(turn.turnId)) add(turn.turnId, "turn", turn.threadId);
        for (const run of runs) add(run.runId, "run", run.threadId ?? undefined);
        if (profileWorkflowId !== undefined && active.has(profileWorkflowId)) add(profileWorkflowId, "profile", undefined);
        for (const record of records) if (active.has(record.workflowId)) add(record.workId, record.workKind, record.threadId);
        return [...work.values()];
    }

    return {
        list,

        async stop(session, workId) {
            const work = (await list(session.scope.analysisId)).find((candidate) => candidate.workId === workId);
            if (work === undefined) return { kind: "not_found" };
            switch (work.kind) {
                case "turn":
                    await deps.stopTurn(workId);
                    break;
                case "run": {
                    const { outcome, converged } = await deps.runCanceler.cancel(workId, { ...session, provenance: WORK_STOP_PROVENANCE });
                    // A run that ended before the cancel converged nothing, and needs nothing.
                    if (outcome === "canceled" && !(converged.steps && converged.charge && converged.mandate)) {
                        logger.warn("the stop of a run did not converge", { workId, ...converged });
                    }
                    break;
                }
                case "profile":
                    await deps.stopProfile(work.analysisId, workId);
                    break;
                default: {
                    const exhaustive: never = work.kind;
                    throw new Error(`unknown work kind: ${String(exhaustive)}`);
                }
            }
            logger.info("work stopped", { workId, kind: work.kind });
            return { kind: "stopped", work };
        },

        async resume(session, workId) {
            const records = unwrapOrThrow(await queryPausesOfWork(deps.pool, session.scope.analysisId, workId));
            if (records.length === 0) return { kind: "not_found" };
            // Each workflow of one work holds the same run credential, thus one renewal covers the work.
            const runSession = records.find((record) => record.runSession !== undefined)?.runSession;
            if (runSession !== undefined) {
                const renewed = await passGate("RunAuthorizer.renew", deps.runAuthorizer.renew(runSession, session.auth));
                if (renewed.isErr()) {
                    logger.warn("work resume refused", { workId, reason: renewed.error.reason });
                    return { kind: "refused", reason: renewed.error.reason };
                }
            }
            if (records.some((record) => record.workKind === "turn")) turnCredentials.put(workId, session.auth);
            // One send for each waiting workflow of the work. The key of the send is the topic of its pause, thus a
            // second resume of the same pause sends nothing new.
            await Promise.all(records.map((record) => DBOS.send(record.workflowId, RESUME_MESSAGE, record.topic, record.topic)));
            logger.info("work resumed", { workId, workflows: records.length });
            return { kind: "resumed", workflows: records.length };
        },

        async hold(session, workId) {
            const records = unwrapOrThrow(await queryPausesOfWork(deps.pool, session.scope.analysisId, workId));
            if (records.length === 0) return { kind: "not_found" };
            const retrying = records.filter((record) => record.state === "retrying");
            // The key of the send names the pause, thus a second hold of the same pause sends nothing new.
            await Promise.all(retrying.map((record) => DBOS.send(record.workflowId, HOLD_MESSAGE, record.topic, `${record.topic}:hold`)));
            logger.info("work held", { workId, workflows: retrying.length });
            return { kind: "held", workflows: retrying.length };
        },
    };
}
