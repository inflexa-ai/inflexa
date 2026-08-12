/**
 * Report-session spawn — the host-agnostic operation that makes a `report`
 * child thread from a conversation.
 *
 * The operation owns no table. It composes the reads and the writes that the
 * store, the thread history, and the working memory already give. `getThread`
 * finds the parent, and `latestSeq` gives the anchor. `listThreads` counts the
 * report children, and `createThread` writes the insert. `render` and
 * `appendTurn` make the seed, and `purgeThread` removes a child that holds no
 * seed. The two storage reads that this capability adds, `latestSeq` and
 * `countUserTurnsAfter`, live on the thread history, because that module owns
 * the `messages` table.
 *
 * The reads and the insert take no lock and no transaction. A concurrent turn
 * can append between the anchor read and the insert, and a retract can cut the
 * parent's tail. A transaction cannot keep the parent still one turn later, so
 * a lock buys no real guarantee. The anchor records the spawn point, and skew
 * past the parent's current end is a normal state a reader expects.
 *
 * A conversation thread id comes from the host UI. But the spawn is a harness
 * operation with no UI in front of it. Thus it mints a `randomUUID` and returns
 * the full row. A managed deployment gets the same behavior with no host code.
 *
 * The spawn also gates on the eyes of the composition. A report session records
 * a version only after a look at the rendered page, and only a browser can look.
 * Three routes give a look: the eyes seam, the capture seam, and a chrome config
 * that names a browser. A composition with none of the three can author a draft
 * that no gate ever accepts. The spawn refuses that session before it writes a
 * row, because a dead-end thread is worse than a refusal that names the absent
 * capability.
 *
 * The spawn seeds the context of the child at the anchor. It writes one message
 * that holds the brief and a copy of the working-memory render. The transcript
 * is append-only, thus the copy stays frozen at the anchor by construction, and
 * a later change to the working memory leaves it as it is. When the seed write
 * fails, the spawn purges the child, because a report thread with no context is
 * a dead end.
 *
 * The seed takes no redaction pass, and that is deliberate. The two parts are
 * agent-authored, the same trust tier as the working-memory render of a
 * conversation turn. The harness redacts the new input of a user one time, at
 * the assembly of that turn. A second pass here would scrub text that the
 * assembly already admitted, and it would report a false clean on the rest.
 *
 * The spawn mints one moment, and that moment carries two pins. The anchor pins
 * the transcript of the parent, and the injected anchor operation pins the data
 * of the analysis. A pin at the first tool call of a later turn reads a
 * different moment, thus the session can cite an artifact that the anchor never
 * held.
 *
 * The delta read gives the state that a caller reads before a new spawn. It
 * gives the report child with the greatest anchor. It also gives the count of
 * user turns of the parent past that anchor. The listing orders by `updated_at`
 * and not by the anchor, thus the read walks each page of the children.
 *
 * The unit of the delta is a turn, and it is not a raw seq. A turn appends after
 * its own loop runs, thus the anchor of a child sits below the rows of the ask
 * that made it. A raw seq comparison would name each child stale one turn after
 * the spawn.
 */

import { randomUUID } from "node:crypto";

import { ResultAsync, errAsync, okAsync } from "neverthrow";
import type { Pool } from "pg";

import type { DbError } from "../lib/db-result.js";
import { hasBrowserUrl, type ChromeConfig } from "../lib/chrome.js";
import { createNoopLogger } from "../lib/console-logger.js";
import type { AcquireEyes } from "../lib/eyes.js";
import type { Logger } from "../lib/logger.js";
import type { CapturePage } from "../lib/page-capture.js";
import type { DomainError } from "../lib/result.js";
import { conversationRecordTurn, createThreadHistory } from "../memory/thread-history.js";
import { createThreadStore, type Thread, type ThreadInputError, type ThreadPage, type ThreadType } from "../memory/thread-store.js";
import { createWorkingMemory } from "../memory/working-memory.js";
import type { EnsureSessionStateResult } from "./report-session-runtime.js";

/**
 * A spawn the operation refuses before it writes a row. Distinct from
 * `DbError`: nothing failed at the driver — the parent names a session the
 * spawn refuses, and each variant carries the identifiers that say which values
 * disagreed.
 *
 * The set is closed. `parent_not_found` covers an absent parent and an archived
 * one alike, because `getThread` filters the tombstone and a spawn into hidden
 * state is not permitted. `parent_not_a_conversation` keeps the tree flat: a
 * report session cannot spawn another. `empty_parent_transcript` refuses a
 * report on a parent that holds no messages, because such a report reports
 * nothing. `no_browser` refuses every spawn under a composition that gives no
 * route to a look: no eyes seam, no capture seam, and no configured browser
 * endpoint. It carries the line that explains the absent capability.
 */
export type SpawnRefusal =
    | {
          readonly type: "no_browser";
          readonly op: string;
          readonly parentThreadId: string;
          readonly detail: string;
      }
    | {
          readonly type: "parent_not_found";
          readonly op: string;
          readonly parentThreadId: string;
      }
    | {
          readonly type: "parent_not_a_conversation";
          readonly op: string;
          readonly parentThreadId: string;
          readonly threadType: ThreadType;
      }
    | {
          readonly type: "empty_parent_transcript";
          readonly op: string;
          readonly parentThreadId: string;
      };

// SpawnRefusal is a `DomainError` (string `type`) — the compile-time check keeps
// it inside the cross-subsystem error vocabulary.
type _AssertDomainError = SpawnRefusal extends DomainError ? true : never;
const _assertDomainError: _AssertDomainError = true;

/** The paging inputs `listReportSessions` forwards to the thread listing. */
export interface ReportSessionPaging {
    readonly page?: number;
    readonly perPage?: number;
}

/**
 * The intent brief of one report session. The caller writes it at the moment of
 * the ask, and each field is short prose.
 *
 * The brief carries intent alone. No field names a path, a dataset, or a format,
 * because the report session reads those from the workspace itself.
 */
export interface ReportBrief {
    /** The question that the report must answer. */
    readonly objective: string;
    /** The reader of the report. */
    readonly audience: string;
    /** The line that the report takes through the evidence. */
    readonly angle: string;
    /** The material that the report must leave out. */
    readonly exclusions?: string;
    /** The points that the user did not decide yet. */
    readonly openQuestions?: string;
}

/**
 * The report child that carries the greatest anchor. A tie on the anchor comes
 * from two concurrent spawns, and the newest `createdAt` wins it.
 */
export interface NewestReportChild {
    readonly threadId: string;
    readonly title: string | null;
    /** The `parentSeq` of the child — the point of the parent transcript that it was built on. */
    readonly anchor: number;
    readonly createdAt: Date;
}

/**
 * The state that a caller reads before a new spawn. `newestChild` is `null` when
 * the parent holds no live report child, and an archived child reads the same
 * way, because a steer into hidden state is not permitted. An absent parent
 * reads the same way.
 */
export interface ReportSessionDelta {
    readonly newestChild: NewestReportChild | null;
    /**
     * The count of the parent turns that a person opened past the anchor of
     * `newestChild` — the new work of the parent past that spawn point. A
     * synthetic record of the host adds nothing to it.
     *
     * It is `null` when `newestChild` is `null`, because a parent with no child
     * gives no anchor to count from. No count query runs in that case.
     */
    readonly userTurnsSinceAnchor: number | null;
}

/**
 * The construction inputs of the report-session operations.
 *
 * Three of the fields name a route to a look at the rendered page: `eyes`,
 * `capture`, and a `chrome` config that names a browser. One present route
 * passes the gate of the spawn.
 */
export interface ReportSessionSpawnDeps {
    readonly pool: Pool;
    /**
     * The chrome config that the same composition gives to the eyes tool. The
     * spawn reads only whether it names a browser, thus the spawn and the tool
     * decide the availability of the eyes from one value.
     */
    readonly chrome: ChromeConfig;
    /**
     * The capture seam that the same composition gives to the eyes tool. A
     * present seam is a route to a look with no browser endpoint, thus it
     * satisfies the gate on its own.
     */
    readonly capture?: CapturePage;
    /**
     * The eyes seam that the same composition gives to the eyes tool. A bound
     * seam gives a browser for one look, thus it satisfies the gate with no
     * configured endpoint. The spawn reads only the presence of the seam, and
     * it acquires no lease.
     */
    readonly eyes?: AcquireEyes;
    /**
     * The anchor operation of the report session runtime. The spawn runs it
     * after the seed of the child lands, thus the transcript anchor and the data
     * snapshot pin at one moment.
     *
     * The dep is optional. A composition that binds none pins no snapshot at the
     * spawn, and the first session tool call pins instead, because the operation
     * is idempotent.
     */
    readonly anchorSession?: (threadId: string) => Promise<EnsureSessionStateResult>;
    /** Operational logging seam. An omitted logger falls back to the no-op. */
    readonly logger?: Logger;
}

/**
 * Whether the composition gives a route to a look at the rendered page. The
 * three routes are the eyes seam, the capture seam, and a chrome config that
 * names a browser. One present route opens the gate.
 *
 * The spawn reads the rule before it writes a row. A caller that runs work
 * before the spawn reads the same rule, thus it skips that work under a closed
 * gate. The refusal itself stays with the spawn, and a caller copies no line of
 * it.
 *
 * The parameter names the route fields alone. Thus a caller passes the deps
 * value that it gives to `createReportSessionSpawn`, and the two answers cannot
 * disagree.
 *
 * No type binds a new route to the parameter. Thus this predicate is the one
 * gate expression of the module, and a new route belongs here and nowhere else.
 */
export function compositionHasEyes(deps: Pick<ReportSessionSpawnDeps, "chrome" | "capture" | "eyes">): boolean {
    return deps.eyes !== undefined || deps.capture !== undefined || hasBrowserUrl(deps.chrome);
}

export interface ReportSessionSpawn {
    /**
     * Make a `report` child of the parent conversation and return the full row.
     * The child takes the analysis of the parent, the parent thread id, and the
     * anchor — the parent's latest `messages.seq` at this moment. It also takes
     * one seed message that holds the brief and the working-memory render.
     *
     * The seed lands first, and the injected anchor operation then pins the data
     * snapshot of the child. A failed pin keeps the child and it keeps this
     * result on the ok channel, thus the outcome vocabulary holds no pin arm.
     *
     * Refused with a `SpawnRefusal`, no row written: a composition with no
     * eyes, an absent or archived parent, a parent that is not a conversation,
     * and a parent with no messages. A store refusal (`DbError`,
     * `ThreadInputError`) passes through unchanged. A failed seed write purges
     * the child and returns the fault, thus no context-less thread survives.
     */
    spawnReportSession(parentThreadId: string, brief: ReportBrief): ResultAsync<Thread, SpawnRefusal | DbError | ThreadInputError>;
    /**
     * The report sessions of one analysis, through the thread listing narrowed
     * to the type `report`. It adds no predicate of its own, so its answer and
     * the thread listing cannot disagree.
     */
    listReportSessions(analysisId: string, paging?: ReportSessionPaging): ResultAsync<ThreadPage, DbError>;
    /**
     * The state that a caller reads before a new spawn. It gives the live report
     * child of the parent with the greatest anchor. It also gives the count of
     * the parent turns that a person opened past that anchor.
     *
     * The count admits one turn of new work by construction. A turn appends
     * after its own loop runs, thus the anchor of a child sits below the rows of
     * the ask that made it, and that ask counts as one.
     *
     * The read picks the child first, thus one anchor bounds the count. A parent
     * with no child needs no anchor, and no count query runs. The read walks each
     * page of the children listing, because the listing orders by `updated_at`
     * and not by the anchor. It reads no model judgment, and it writes nothing.
     */
    reportSessionDelta(parentThreadId: string): ResultAsync<ReportSessionDelta, DbError>;
}

const OP = "spawn-report-session";

/** The line that the caller reads when the composition gives no eyes. */
const NO_BROWSER_DETAIL = "the composition gives no browser, thus a report session can never record a version";

/**
 * The page size of the walk over the report children of one parent. The
 * one-version policy keeps the count of children small, thus the walk reads one
 * page on each real parent. It is exported because a test seeds one row more
 * than one page, and a hard-coded count in the test would not follow a change
 * here.
 */
export const REPORT_CHILD_PAGE_SIZE = 100;

/**
 * Compose the child title. N counts the existing report children of the parent
 * plus one. A parent with no title yields `Report N` alone, because the seed of
 * the parent title is best-effort and can be absent.
 */
function composeTitle(parentTitle: string | null, n: number): string {
    const suffix = `Report ${n}`;
    return parentTitle && parentTitle.length > 0 ? `${parentTitle} — ${suffix}` : suffix;
}

/** Whether the caller gave text for an optional field of the brief. */
function hasText(field: string | undefined): field is string {
    return field !== undefined && field.trim().length > 0;
}

/**
 * Compose the seed message: the brief as short labeled prose, then the copy of
 * the working-memory render. An empty render adds nothing, because
 * `renderWorkingMemory` gives the empty string for a memory with no entry.
 */
function composeSeed(brief: ReportBrief, workingMemoryRender: string): string {
    const lines = [`Objective: ${brief.objective}`, `Audience: ${brief.audience}`, `Angle: ${brief.angle}`];
    if (hasText(brief.exclusions)) lines.push(`Exclusions: ${brief.exclusions}`);
    if (hasText(brief.openQuestions)) lines.push(`Open questions: ${brief.openQuestions}`);
    const briefBlock = `# Report Brief\n\n${lines.join("\n")}\n`;
    const memory = workingMemoryRender.trim();
    return memory.length === 0 ? briefBlock : `${briefBlock}\n${memory}\n`;
}

/**
 * The child with the greatest anchor, or `null` for no candidate. Two concurrent
 * spawns can write one anchor, and the newest `createdAt` then wins.
 */
function pickNewestChild(children: readonly Thread[]): NewestReportChild | null {
    let newest: NewestReportChild | null = null;
    for (const child of children) {
        // The store writes `parentThreadId` and `parentSeq` as one pair, thus a
        // child with no anchor names no point of the parent transcript and it
        // cannot advise.
        if (child.parentSeq === null) continue;
        const candidate: NewestReportChild = {
            threadId: child.threadId,
            title: child.title,
            anchor: child.parentSeq,
            createdAt: child.createdAt,
        };
        const wins =
            newest === null ||
            candidate.anchor > newest.anchor ||
            (candidate.anchor === newest.anchor && candidate.createdAt.getTime() > newest.createdAt.getTime());
        if (wins) newest = candidate;
    }
    return newest;
}

/**
 * Build the report-session operations bound to a Postgres pool. The factory
 * closure captures `pool` and constructs the store, the thread history, and the
 * working memory from it, the same way the chat-turn preparation does.
 */
export function createReportSessionSpawn(deps: ReportSessionSpawnDeps): ReportSessionSpawn {
    const { pool } = deps;
    const log = (deps.logger ?? createNoopLogger()).named("spawn-report-session");
    const store = createThreadStore(pool);
    const history = createThreadHistory(pool);
    const workingMemory = createWorkingMemory(pool);
    // The routes are fixed at construction, thus the gate reads one boolean and
    // never a live probe of the sidecar.
    const eyesAvailable = compositionHasEyes(deps);

    /**
     * Write the one seed message of the child and give the child back. The
     * message rides as a record, not as user input: nobody typed it in the child
     * thread, and a record is displayed but it never opens a turn.
     */
    function seedChildContext(child: Thread, brief: ReportBrief): ResultAsync<Thread, DbError> {
        return workingMemory
            .render(child.analysisId)
            .andThen((memory) => history.appendTurn(child.threadId, conversationRecordTurn(composeSeed(brief, memory))))
            .map(() => child)
            .orElse((fault) =>
                // A report thread with no context is a dead end, thus the purge
                // removes the child. The seed fault is the cause, thus it returns
                // from each route. A failed purge leaves the child, and the caller
                // still reads why the seed stopped.
                store
                    .purgeThread(child.threadId)
                    .andThen((): ResultAsync<Thread, DbError> => errAsync(fault))
                    .orElse((): ResultAsync<Thread, DbError> => errAsync(fault)),
            );
    }

    /**
     * Pin the data snapshot of the child, through the injected anchor operation.
     * The spawn mints one moment, and the transcript anchor and this snapshot are
     * the two pins of that moment.
     *
     * The pin runs after the seed. A failed seed purges the child, and
     * `cortex_report_session_state` carries no foreign key to the thread table,
     * thus a pin before a purged seed would leave an orphan row.
     *
     * A failed pin keeps the child. The operation is idempotent, thus the first
     * session tool call pins again, and a purge on a transient store fault would
     * cost the user the whole session. Thus the failure rides the logger alone.
     */
    async function pinSessionSnapshot(child: Thread): Promise<Thread> {
        const anchor = deps.anchorSession;
        if (anchor === undefined) return child;
        try {
            const pinned = await anchor(child.threadId);
            if (pinned.outcome === "failed") {
                log.warn("the snapshot pin of the new session failed", {
                    threadId: child.threadId,
                    analysisId: child.analysisId,
                    kind: pinned.kind,
                    detail: pinned.detail,
                });
            }
        } catch (cause) {
            // The dep speaks a promise, thus a foreign realization can reject.
            // The spawn keeps the child on that route as well.
            log.warn("the snapshot pin of the new session did not complete", {
                threadId: child.threadId,
                analysisId: child.analysisId,
                ...log.errorFields(cause),
            });
        }
        return child;
    }

    /**
     * Each live report child of the parent, across every page of the listing. The
     * listing orders by `updated_at`, thus one page can hide the child with the
     * greatest anchor. The default listing excludes an archived child, and this
     * walk keeps that scope.
     */
    function collectReportChildren(
        analysisId: string,
        parentThreadId: string,
        page: number,
        found: readonly Thread[],
    ): ResultAsync<readonly Thread[], DbError> {
        return store
            .listThreads({ analysisId, type: "report", parentThreadId, page, perPage: REPORT_CHILD_PAGE_SIZE })
            .andThen((result): ResultAsync<readonly Thread[], DbError> => {
                const all = [...found, ...result.threads];
                // An empty page also stops the walk. `hasMore` compares the offset
                // against a count from a second statement, thus a concurrent purge
                // can hold the flag true after the last row.
                if (!result.hasMore || result.threads.length === 0) return okAsync(all);
                return collectReportChildren(analysisId, parentThreadId, page + 1, all);
            });
    }

    function spawnReportSession(parentThreadId: string, brief: ReportBrief): ResultAsync<Thread, SpawnRefusal | DbError | ThreadInputError> {
        // The gate runs before the parent read. A session with no route to a look
        // reaches the record gate and refuses there forever, thus the spawn is the
        // one honest place to say so.
        if (!eyesAvailable) {
            return errAsync({ type: "no_browser", op: OP, parentThreadId, detail: NO_BROWSER_DETAIL });
        }
        return store.getThread(parentThreadId).andThen((parent): ResultAsync<Thread, SpawnRefusal | DbError | ThreadInputError> => {
            // An absent parent and an archived one arrive the same way — `getThread`
            // filters the tombstone — and both refuse as `parent_not_found`.
            if (parent === null) {
                return errAsync({ type: "parent_not_found", op: OP, parentThreadId });
            }
            // The tree stays flat: only a conversation spawns a report.
            if (parent.threadType !== "conversation") {
                return errAsync({ type: "parent_not_a_conversation", op: OP, parentThreadId, threadType: parent.threadType });
            }
            return history.latestSeq(parentThreadId).andThen((anchor): ResultAsync<Thread, SpawnRefusal | DbError | ThreadInputError> => {
                // `null` is a parent with no messages. A report on an empty transcript
                // reports nothing, so the refusal is the correct answer.
                if (anchor === null) {
                    return errAsync({ type: "empty_parent_transcript", op: OP, parentThreadId });
                }
                // `total`, not the page length: N counts every existing report child,
                // not the count on one page. Two concurrent spawns can compose one N.
                // The result is two titles a user renames, and no identifier collides.
                return store
                    .listThreads({ analysisId: parent.analysisId, type: "report", parentThreadId })
                    .andThen((children): ResultAsync<Thread, DbError | ThreadInputError> =>
                        store
                            .createThread({
                                threadId: randomUUID(),
                                analysisId: parent.analysisId,
                                title: composeTitle(parent.title, children.total + 1),
                                type: "report",
                                parentThreadId,
                                parentSeq: anchor,
                            })
                            // The seed follows the insert, thus the copy of the working
                            // memory is the state at the anchor.
                            .andThen((child) => seedChildContext(child, brief))
                            // The pin follows the seed. `pinSessionSnapshot` never
                            // rejects, thus the safe bridge adds no error variant.
                            .andThen((child) => ResultAsync.fromSafePromise(pinSessionSnapshot(child))),
                    );
            });
        });
    }

    function listReportSessions(analysisId: string, paging: ReportSessionPaging = {}): ResultAsync<ThreadPage, DbError> {
        return store.listThreads({ analysisId, type: "report", ...paging });
    }

    function reportSessionDelta(parentThreadId: string): ResultAsync<ReportSessionDelta, DbError> {
        // The children listing takes the analysis of the parent, thus the parent
        // read comes first. An absent or archived parent gives no advice, and the
        // spawn refuses it later with `parent_not_found`.
        return store.getThread(parentThreadId).andThen((parent): ResultAsync<ReportSessionDelta, DbError> => {
            if (parent === null) return okAsync({ newestChild: null, userTurnsSinceAnchor: null });
            // The child comes first, because the anchor of that child bounds the
            // count. A parent with no child gives no anchor, thus the read stops
            // here and the count query never runs.
            return collectReportChildren(parent.analysisId, parentThreadId, 0, []).andThen((children): ResultAsync<ReportSessionDelta, DbError> => {
                const newestChild = pickNewestChild(children);
                if (newestChild === null) return okAsync({ newestChild: null, userTurnsSinceAnchor: null });
                return history.countUserTurnsAfter(parentThreadId, newestChild.anchor).map((userTurnsSinceAnchor) => ({ newestChild, userTurnsSinceAnchor }));
            });
        });
    }

    return { spawnReportSession, listReportSessions, reportSessionDelta };
}
