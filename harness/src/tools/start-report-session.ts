/**
 * The tool that starts a report session from a conversation.
 *
 * The tool is the one report path of the conversation agent. It reads the parent
 * thread from the scope of the call, thus the agent cannot name a different
 * conversation. It carries the intent brief of the ask, and the spawn seeds the
 * context of the child with that brief.
 *
 * The order of the checks is fixed. The eyes gate runs first. A composition
 * that names no route to a look is a permanent condition, and the advice is
 * transient state. The advice runs next. At one user turn or less of the parent
 * past the anchor of the newest report child, the tool starts nothing and it
 * names that child. The spawn runs last.
 *
 * Each degraded condition is a typed outcome in the ok channel: a scope with no
 * thread id, a composition with no eyes, the advice, each refusal of the spawn,
 * and a store fault. The tool never throws for one of them.
 */

import { ok, type Result } from "neverthrow";
import type { Pool } from "pg";
import { z } from "zod";

import type { EnsureSessionStateResult } from "../app/report-session-runtime.js";
import { compositionHasEyes, createReportSessionSpawn, type ReportBrief, type ReportSessionSpawnDeps, type SpawnRefusal } from "../app/spawn-report-session.js";
import type { ChromeConfig } from "../lib/chrome.js";
import { createNoopLogger } from "../lib/console-logger.js";
import { describeDbError, type DbError } from "../lib/db-result.js";
import type { AcquireEyes } from "../lib/eyes.js";
import type { Logger } from "../lib/logger.js";
import type { ThreadInputError, ThreadType } from "../memory/thread-store.js";
import { defineTool, type Tool, type ToolError } from "./define-tool.js";

/**
 * The character bound of each brief field. The whole brief lands in one durable
 * message row, thus the schema holds no unbounded string out of the store.
 *
 * The description caps the brief at approximately 2000 tokens, and a token is
 * about four characters. Thus the five bounds sum to 8000 characters, and the
 * widest brief that the schema admits still meets the cap that the agent reads.
 *
 * The share of each field follows its role. `audience` names one reader, thus a
 * phrase is enough. `objective` and `angle` carry a sentence or two. Each
 * optional field carries a list of items, thus it takes the largest share.
 */
const BRIEF_MAX = {
    objective: 1500,
    audience: 200,
    angle: 1500,
    exclusions: 2400,
    openQuestions: 2400,
} as const;

/**
 * The brief of the ask, plus the one override of the advice.
 *
 * Each brief field is short prose. No field names a path, a dataset, or a
 * format, because the report session reads those from the workspace itself.
 */
const startReportSessionInput = z.object({
    objective: z.string().min(1).max(BRIEF_MAX.objective).describe("The question that the report must answer."),
    audience: z.string().min(1).max(BRIEF_MAX.audience).describe("The reader of the report."),
    angle: z.string().min(1).max(BRIEF_MAX.angle).describe("The line that the report takes through the evidence."),
    exclusions: z.string().max(BRIEF_MAX.exclusions).optional().describe("The material that the report must leave out."),
    openQuestions: z.string().max(BRIEF_MAX.openQuestions).optional().describe("The points that the user did not decide yet."),
    newSessionAnyway: z
        .boolean()
        .optional()
        .describe(
            "Set it to true to start a new session when the conversation holds no user turn of new work after the last report session. The default is false.",
        ),
});

export type StartReportSessionInput = z.infer<typeof startReportSessionInput>;

/**
 * The typed outcome of the tool. Each arm is ok-channel data, thus the tool
 * never throws for a degraded condition.
 *
 * `started` and `existing-session` name a report thread. `refused` names a call
 * whose scope carries no conversation thread. The four refusals of the spawn
 * keep their own names, thus the agent reads one reason from the spawn and from
 * the tool alike. `failed` is a store fault, and it carries a short line.
 */
export type StartReportSessionResult =
    | { outcome: "started"; threadId: string; title: string | null }
    | { outcome: "existing-session"; threadId: string; title: string | null }
    | { outcome: "refused"; detail: string }
    | { outcome: "no_browser"; detail: string }
    | { outcome: "parent_not_found" }
    | { outcome: "parent_not_a_conversation"; threadType: ThreadType }
    | { outcome: "empty_parent_transcript" }
    | { outcome: "failed"; detail: string };

/**
 * The construction deps of the tool.
 *
 * The fields build the spawn operation inside the factory. Thus one singleton
 * tool serves every conversation, and it reads the parent from the scope of each
 * call.
 *
 * Two of the fields name a route to a look at the rendered page: `eyes` and a
 * `chrome` config that names a browser. The tool binds no capture seam. That
 * seam replaces the transport of the eyes tool, and the tool here never looks at
 * a page. A composition that binds a capture seam straight to the spawn still
 * opens the gate of that spawn.
 */
export interface StartReportSessionToolDeps {
    readonly pool: Pool;
    readonly chrome: ChromeConfig;
    /**
     * The eyes seam of the composition. A bound seam gives a browser for one
     * look, thus the spawn accepts a session with no configured endpoint. The
     * tool passes the seam to the spawn, and it acquires no lease.
     */
    readonly eyes?: AcquireEyes;
    /**
     * The anchor operation of the report session runtime, which the spawn runs
     * after the seed of the child lands. The composition binds it, thus the tool
     * carries no stale value of its own.
     */
    readonly anchorSession?: (threadId: string) => Promise<EnsureSessionStateResult>;
    readonly logger?: Logger;
}

/** The line that a call reads when the scope names no conversation thread. */
const NO_THREAD_SCOPE_DETAIL = "the scope of the call names no conversation thread, thus the tool cannot start a child session";

/** The line that a call reads when the thread store refuses the shape of the child. */
const STORE_REFUSED_DETAIL = "the thread store refused the shape of the child session";

/**
 * Map a fault of the spawn onto its arm. The switch is exhaustive over the three
 * error unions, thus a new variant fails the build instead of falling into one
 * arm in silence.
 */
function toOutcome(fault: SpawnRefusal | DbError | ThreadInputError): StartReportSessionResult {
    switch (fault.type) {
        case "no_browser":
            return { outcome: "no_browser", detail: fault.detail };
        case "parent_not_found":
            return { outcome: "parent_not_found" };
        case "parent_not_a_conversation":
            return { outcome: "parent_not_a_conversation", threadType: fault.threadType };
        case "empty_parent_transcript":
            return { outcome: "empty_parent_transcript" };
        case "query_failed":
        case "mutation_failed":
        case "connection_failed":
        case "constraint_violation":
            return { outcome: "failed", detail: describeDbError(fault) };
        case "parent_analysis_mismatch":
        case "parent_anchor_unpaired":
        case "unknown_thread_type":
            return { outcome: "failed", detail: STORE_REFUSED_DETAIL };
    }
}

/** The cause of a fault, or `undefined` for a fault that carries none. */
function causeOf(fault: SpawnRefusal | DbError | ThreadInputError): unknown {
    return "cause" in fault ? fault.cause : undefined;
}

/**
 * Make the tool that starts a report session, over one Postgres pool and the
 * eyes of the composition.
 *
 * The factory builds the deps of the spawn one time. The spawn and the gate of
 * the tool read that one value, thus the two gates cannot disagree. The tool
 * holds no per-conversation value.
 */
export function createStartReportSessionTool(deps: StartReportSessionToolDeps): Tool<StartReportSessionInput, StartReportSessionResult> {
    const logger = (deps.logger ?? createNoopLogger()).named("start-report-session");
    const spawnDeps: ReportSessionSpawnDeps = {
        pool: deps.pool,
        chrome: deps.chrome,
        ...(deps.eyes ? { eyes: deps.eyes } : {}),
        ...(deps.anchorSession ? { anchorSession: deps.anchorSession } : {}),
        ...(deps.logger ? { logger: deps.logger } : {}),
    };
    const spawn = createReportSessionSpawn(spawnDeps);
    // The gate reads the routes of the very spawn below, thus the two answers
    // come from one value. The routes are fixed at construction, thus the gate
    // reads one boolean and never a live probe of the sidecar.
    const eyesAvailable = compositionHasEyes(spawnDeps);

    return defineTool({
        id: "start_report_session",
        description:
            "Start an interactive report session as a child of this conversation. " +
            "The user composes the report in that chat, with the report agent. " +
            "Give the intent brief: the objective, the audience, and the angle of the report. " +
            "The brief carries intent only. Do not name a path, a dataset, or a format in it, " +
            "because the session reads those from the workspace. " +
            "Keep the whole brief under approximately 2000 tokens. " +
            "When the conversation holds no user turn of new work after the last report session, the tool " +
            "starts nothing and it names that session. The ask that started that session is not new work. " +
            "Then tell the user to continue in that chat.",
        inputSchema: startReportSessionInput,
        executionMode: "inline",
        describeCall: "none",
        execute: async (input, ctx): Promise<Result<StartReportSessionResult, ToolError>> => {
            const brief: ReportBrief = {
                objective: input.objective,
                audience: input.audience,
                angle: input.angle,
                exclusions: input.exclusions,
                openQuestions: input.openQuestions,
            };

            const { scope } = ctx.session;
            if (scope.kind !== "analysis" || scope.threadId === undefined || scope.threadId.length === 0) {
                return ok({ outcome: "refused", detail: NO_THREAD_SCOPE_DETAIL });
            }
            const parentThreadId = scope.threadId;

            // The eyes gate has priority over the advice, and the advice costs two
            // reads. The spawn holds the same gate before each read of its own,
            // thus a blind composition reaches the `no_browser` refusal of the
            // spawn with no read and no write. As a result the tool copies no
            // detail line of the spawn.
            if (eyesAvailable) {
                const delta = await spawn.reportSessionDelta(parentThreadId);
                if (delta.isErr()) {
                    logger.warn("the report session delta did not read", {
                        parentThreadId,
                        reason: delta.error.type,
                        ...logger.errorFields(delta.error.cause),
                    });
                    return ok(toOutcome(delta.error));
                }
                const { newestChild, userTurnsSinceAnchor } = delta.value;
                // The rule admits one turn. A turn appends after its own loop
                // runs, thus the ask that made the child is itself one user turn
                // past the anchor. A rule at zero would never advise again after
                // that turn commits. A second user turn is real work, and a new
                // session can report on it.
                if (input.newSessionAnyway !== true && newestChild !== null && userTurnsSinceAnchor !== null && userTurnsSinceAnchor <= 1) {
                    return ok({ outcome: "existing-session", threadId: newestChild.threadId, title: newestChild.title });
                }
            }

            const spawned = await spawn.spawnReportSession(parentThreadId, brief);
            return ok(
                spawned.match(
                    (child): StartReportSessionResult => ({ outcome: "started", threadId: child.threadId, title: child.title }),
                    (fault): StartReportSessionResult => {
                        const outcome = toOutcome(fault);
                        if (outcome.outcome === "failed") {
                            logger.warn("the report session did not start", { parentThreadId, reason: fault.type, ...logger.errorFields(causeOf(fault)) });
                        }
                        return outcome;
                    },
                ),
            );
        },
    });
}
