/**
 * The tool that starts a report session from a conversation.
 *
 * The tool is the one report path of the conversation agent. It reads the parent
 * thread from the scope of the call, thus the agent cannot name a different
 * conversation. It carries the intent brief of the ask, and the spawn seeds the
 * context of the child with that brief.
 *
 * The order of the checks is fixed. The eyes gate runs first, because a
 * composition with no browser is a permanent condition and the advice is
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

import { createReportSessionSpawn, type ReportBrief, type SpawnRefusal } from "../app/spawn-report-session.js";
import { hasBrowserUrl, type ChromeConfig } from "../lib/chrome.js";
import { createNoopLogger } from "../lib/console-logger.js";
import { describeDbError, type DbError } from "../lib/db-result.js";
import type { Logger } from "../lib/logger.js";
import type { ThreadInputError, ThreadType } from "../memory/thread-store.js";
import { defineTool, type Tool, type ToolError } from "./define-tool.js";

/**
 * The brief of the ask, plus the one override of the advice.
 *
 * Each brief field is short prose. No field names a path, a dataset, or a
 * format, because the report session reads those from the workspace itself.
 */
const startReportSessionInput = z.object({
    objective: z.string().min(1).describe("The question that the report must answer."),
    audience: z.string().min(1).describe("The reader of the report."),
    angle: z.string().min(1).describe("The line that the report takes through the evidence."),
    exclusions: z.string().optional().describe("The material that the report must leave out."),
    openQuestions: z.string().optional().describe("The points that the user did not decide yet."),
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
 * `pool` and `chrome` build the spawn operation inside the factory, thus one
 * singleton tool serves every conversation and it reads the parent from the
 * scope of each call. The composition binds no capture seam here, thus the
 * browser endpoint is the one route to the eyes.
 */
export interface StartReportSessionToolDeps {
    readonly pool: Pool;
    readonly chrome: ChromeConfig;
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
 * chrome config of the composition.
 *
 * The factory builds the spawn operation with the same two values, thus the
 * spawn and the gate of the tool read one browser endpoint. The tool holds no
 * per-conversation value.
 */
export function createStartReportSessionTool(deps: StartReportSessionToolDeps): Tool<StartReportSessionInput, StartReportSessionResult> {
    const logger = (deps.logger ?? createNoopLogger()).named("start-report-session");
    const spawn = createReportSessionSpawn({ pool: deps.pool, chrome: deps.chrome });
    // The eyes of the composition are fixed at construction, thus the gate reads
    // one boolean and never a live probe of the sidecar.
    const eyesAvailable = hasBrowserUrl(deps.chrome);

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
