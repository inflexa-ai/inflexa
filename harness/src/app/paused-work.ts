/**
 * The paused work of an analysis, as a host lists and resumes it (work-pause spec).
 *
 * Each waiting workflow has a row. One work, a turn or a run or a profile, can have more than one waiting workflow:
 * a sub-agent of a turn and each step of a run wait in their own workflows. A host lists the work, and a resume sends
 * one message to the topic of each waiting workflow of the work. Only a client resumes paused work.
 */

import { DBOS } from "@dbos-inc/dbos-sdk";

import type { PauseCause, PausedWorkKind } from "../contracts/chat-parts.js";
import { createNoopLogger } from "../lib/console-logger.js";
import type { Logger } from "../lib/logger.js";
import { unwrapOrThrow } from "../lib/result.js";
import { turnCredentials } from "../loop/turn-credentials.js";
import type { Querier } from "../state/db.js";
import { clearPauses, queryPausesOfAnalysis, queryPausesOfWork, type PauseRecord } from "../state/paused-work.js";
import { HOLD_MESSAGE, RESUME_MESSAGE } from "../workflows/pause.js";
import type { ChatTurnSession } from "./chat-turn.js";

/** One waiting workflow of paused work. */
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

/** One paused work: a turn, a run, or a data profile, with each of its waiting workflows. */
export type PausedWork = {
    /** The turn id, the run id, or the id of the profile workflow. */
    readonly workId: string;
    readonly kind: PausedWorkKind;
    readonly analysisId: string;
    readonly threadId?: string;
    readonly waiting: readonly PausedWorkflow[];
};

export type PausedWorkResume = { readonly kind: "resumed"; readonly workflows: number } | { readonly kind: "not_found" };

/** `workflows` is the count of waits in `retrying` that the hold reached. A wait in `paused` needs no hold. */
export type PausedWorkHold = { readonly kind: "held"; readonly workflows: number } | { readonly kind: "not_found" };

/** The paused work of a runtime, as a host uses it. */
export type PausedWorkSurface = {
    /** The paused work of an analysis. A row whose workflow ended is not in it, and the list deletes that row. */
    list(analysisId: string): Promise<PausedWork[]>;
    /**
     * Resume the work: each of its waiting workflows sends its request again. A wait in `retrying` ends at once, thus
     * the same call is "retry now". For a turn, the credential of the session goes to the turn first. Work of a
     * different analysis than the session gives `not_found`.
     */
    resume(session: ChatTurnSession, workId: string): Promise<PausedWorkResume>;
    /**
     * Hold the work: each of its waits in `retrying` moves to `paused`, and its timer stops. The work then waits for a
     * resume. Work of a different analysis than the session gives `not_found`.
     */
    hold(session: ChatTurnSession, workId: string): Promise<PausedWorkHold>;
};

export type PausedWorkDeps = {
    readonly pool: Querier;
    readonly logger?: Logger;
};

/** The workflow statuses that can still wait. */
const ACTIVE_STATUSES: ReadonlySet<string> = new Set(["PENDING", "ENQUEUED"]);

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

export function createPausedWork(deps: PausedWorkDeps): PausedWorkSurface {
    const logger = (deps.logger ?? createNoopLogger()).named("harness.paused-work");
    return {
        async list(analysisId) {
            const records = unwrapOrThrow(await queryPausesOfAnalysis(deps.pool, analysisId));
            if (records.length === 0) return [];
            const statuses = await DBOS.listWorkflows({ workflowIDs: records.map((record) => record.workflowId), loadInput: false, loadOutput: false });
            const active = new Set(statuses.filter((status) => ACTIVE_STATUSES.has(status.status)).map((status) => status.workflowID));
            const ended = records.filter((record) => !active.has(record.workflowId)).map((record) => record.workflowId);
            if (ended.length > 0) {
                const cleared = await clearPauses(deps.pool, ended);
                if (cleared.isErr()) logger.warn("the rows of ended pauses did not clear", { op: cleared.error.op, workflows: ended.length });
            }
            const byWork = new Map<string, { readonly first: PauseRecord; readonly waiting: PausedWorkflow[] }>();
            for (const record of records) {
                if (!active.has(record.workflowId)) continue;
                const work = byWork.get(record.workId);
                if (work === undefined) byWork.set(record.workId, { first: record, waiting: [workflowOf(record)] });
                else work.waiting.push(workflowOf(record));
            }
            return [...byWork.values()].map(({ first, waiting }) => ({
                workId: first.workId,
                kind: first.workKind,
                analysisId: first.analysisId,
                threadId: first.threadId,
                waiting,
            }));
        },

        async resume(session, workId) {
            const records = unwrapOrThrow(await queryPausesOfWork(deps.pool, session.scope.analysisId, workId));
            if (records.length === 0) return { kind: "not_found" };
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
