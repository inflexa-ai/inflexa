/**
 * The provenance seam -- the one surface through which the harness tells an embedder what happened.
 *
 * Three duties answer one host concern. A durable run states the facts of its own lifecycle. A session
 * states the acts that make a report. The report page needs the signed document of the analysis back, as
 * bytes. The embedder holds that document, thus the harness declares the vocabulary and the seam alone,
 * and it keeps no ledger of its own.
 *
 * One surface carries the three, and each member is optional alone. Thus a composition binds the members
 * that it records, and the harness reads an absent member as absence and never as an error. The run emit
 * takes an `AgentSession`, because a persisting realization needs the credential of the actor. The
 * workflow body passes the `RunSession` of its durable input, and the run canceler passes the session of
 * the cancel. A session act carries no session, thus the session emit takes the event alone.
 *
 * Both emit members are fire-and-forget. Neither gives a result, and the harness reads none. The writer
 * that wins the conditional terminal write of the run row emits `run_completed`. The body emits it before
 * its status write commits, or after a refused or failed write. The canceler emits it only when its write
 * changes the row, thus a refused cancel emits nothing.
 */

import type { AgentSession } from "../auth/types.js";
import type { Logger } from "../lib/logger.js";
import type { ProvenanceExport } from "../report-render/provenance-data.js";
import type { AuthoringBlock } from "../report-model/authoring-grammar.js";
import type { ExecuteAnalysisFinalStatus } from "../workflows/execute-analysis.js";

export type { ProvenanceExport } from "../report-render/provenance-data.js";

/**
 * A run-lifecycle provenance observation handed to an optional host observer.
 * Harness-owned plain union — the harness stays tsprov-free and bus-free; the
 * host maps these execution facts onto its own ledger vocabulary.
 *
 * In the workflow body, every `atMs` is epoch milliseconds read via `await DBOS.now()`, a
 * checkpointed step: a body re-executed by DBOS recovery reads the recorded value, so a
 * re-emitted event carries the identical timestamp and merges on the host's
 * ledger without a value conflict. The body never sources these from a wall clock
 * (`Date.now()`) — that would diverge across replays and defeat the merge.
 *
 * The run canceler is the second emit site of `step_completed` and `run_completed`, and it emits only
 * when its write of the run row changes the row. It is not a workflow, thus no replay fires its emits,
 * and it reads the wall clock one time for all of them.
 *
 * In the body, `run_completed.durationMs` is the terminal `atMs` minus the `run_started`
 * `atMs` (both `DBOS.now()` reads) — the true workflow-observed run span. The canceler holds no
 * `run_started` time, thus it measures from the `started_at` of the run row.
 *
 * `step_completed` fires once at EVERY scheduler-loop settlement — the only site
 * that observes every executed step (registration sees only artifact-producing
 * steps, and a child cannot observe its own parent-driven cancel). Steps that
 * were never dispatched (dependents of a failed sibling) emit nothing by design;
 * the run's terminal status carries that outcome. `status` maps the settlement
 * outcome: `complete` → `"completed"`, `canceled` → `"canceled"`,
 * `failed`/`blocked`/child-error → `"failed"`.
 *
 * `run_completed` fires at BOTH terminal boundaries (success and failure); the
 * `status` field distinguishes them.
 */
export type RunProvenanceEvent =
    | { type: "run_started"; analysisId: string; runId: string; planSummary: string; stepCount: number; atMs: number }
    | {
          type: "step_completed";
          analysisId: string;
          runId: string;
          stepId: string;
          /** Settlement outcome mapped to a terminal step status. */
          status: "completed" | "failed" | "canceled";
          /** The child's durable execution duration; absent when the child settled by throwing. */
          durationMs?: number;
          atMs: number;
      }
    | {
          type: "run_completed";
          analysisId: string;
          runId: string;
          /** The body's terminal status, resolved through `deriveFinalStatus`. */
          status: Exclude<ExecuteAnalysisFinalStatus, "running">;
          atMs: number;
          /** `atMs − run_started.atMs`: the workflow-observed run span in ms. */
          durationMs: number;
      };

/**
 * One act on one block of a draft.
 *
 * The kind rides beside the id, because an id alone tells a reader nothing about what the act touched.
 * The kind is the one that the document holds after the act: a change is permitted to change the kind,
 * and a remove states the kind that the draft carried before it.
 */
type BlockAct = {
    analysisId: string;
    threadId: string;
    blockId: string;
    blockKind: AuthoringBlock["kind"];
};

/**
 * One observation of a session.
 *
 * The union names one event for each act: the start of a session, the four block operations, the title,
 * the derivation, the preview, the record, the file write of a conversation turn, a script that read or wrote a
 * file, and the approval of a plan. Each event carries
 * the analysis and the thread, thus a consumer places it with no lookup. The title sits on the document,
 * thus the title event names no block.
 *
 * Each member carries what its own site holds at the moment that the act lands, and nothing more. The
 * derivation carries the chain of the table, because the site pins it and a consumer cannot rebuild it
 * from the path. The preview carries the page and the hash of the draft that it shows, thus a consumer
 * ties a page to the document that made it.
 *
 * The `create-session` event names the kind of the new session, and it names the parent thread of a child
 * session. An analysis holds sessions of more than one kind, and the thread id alone says neither. Thus
 * the document of the analysis tells the whole tree of the sessions, and a reader walks it with no second
 * read of the seam. A root session carries no parent, thus `parentThreadId` is absent on it.
 */
export type SessionProvenanceEvent =
    | {
          type: "create-session";
          analysisId: string;
          threadId: string;
          sessionKind: "conversation" | "report";
          parentThreadId?: string;
      }
    | ({ type: "add-block" } & BlockAct)
    | ({ type: "change-block" } & BlockAct)
    | ({ type: "remove-block" } & BlockAct)
    | ({ type: "move-block" } & BlockAct)
    | { type: "set-title"; analysisId: string; threadId: string; title: string }
    | {
          type: "run-derivation";
          analysisId: string;
          threadId: string;
          outputPath: string;
          outputHash: string;
          scriptHash: string;
          sources: ReadonlyArray<{ path: string; hash: string }>;
      }
    | { type: "preview"; analysisId: string; threadId: string; pagePath: string; documentHash: string }
    | { type: "record-version"; analysisId: string; threadId: string; versionId: string; replaced: boolean }
    | {
          /**
           * A host approved a plan and the approval started its run. This is the one session event that
           * carries a time: the approval is read before the launch, and the run emits `run_started` from
           * its workflow body, thus a record orders the approval before the start only through `atMs`.
           */
          type: "approve-plan";
          analysisId: string;
          threadId: string;
          planId: string;
          runId: string;
          /** Epoch milliseconds of the approval, read before the launch. */
          atMs: number;
      }
    | {
          /**
           * One file that a conversation turn wrote with a file tool — a write under no run and no
           * step, thus a session observation rather than a collector record. The hash and the size
           * come from the exact bytes written, computed in-process at the write site.
           */
          type: "write-file";
          analysisId: string;
          /** The conversation thread whose turn wrote the file. Absent when the scope carries none. */
          threadId?: string;
          /** Analysis-root-relative path of the landed file. */
          path: string;
          /** SHA-256 of the bytes written. */
          hash: string;
          /** Size in bytes. */
          size: number;
          /** The agent-visible file tool that authored the content (`write_file` / `edit_file`). */
          tool: string;
          /** The loop's tool-call id of the write — the replay-stable identity of the invocation. */
          invocationId: string;
      }
    | {
          /**
           * One script of `run_script` that read or wrote a file. The script, each file that it read, and each
           * file that it derived carry the hash of their exact bytes, thus a derived file chains to the files
           * that made it. The harness emits it from the fold of the call record, thus a replay emits it again
           * with the same values.
           */
          type: "run-script";
          analysisId: string;
          /** The thread whose turn ran the script. Absent when the scope carries none. */
          threadId?: string;
          /** The loop's tool-call id of the `run_script` call. */
          invocationId: string;
          /** The saved script. Absent when the session has no scratch directory. */
          script?: { path: string; hash: string; size: number };
          /** Each table that the script read, analysis-root-relative. */
          reads: ReadonlyArray<{ path: string; hash: string }>;
          /** Each file that the script derived, analysis-root-relative. */
          writes: ReadonlyArray<{ path: string; hash: string; size: number }>;
          /** Each tool that the script called, in call order. */
          tools: readonly string[];
          /** The script ran to its end. A failed script keeps the files that it wrote before the failure. */
          ok: boolean;
      };

/**
 * The provenance seam of the harness. An embedder realizes the members that it records, and the harness
 * never branches on which realization is bound.
 */
export type ProvenanceSeam = {
    /**
     * The run engine emits the facts of one run here.
     *
     * Synchronous by signature (`void`, never a promise): a host that needs input and output dispatches
     * the work rather than making a workflow body wait behind it. The session rides beside the event,
     * because a persisting realization needs the credential, the scope, and the identity of the actor.
     * The body passes the `RunSession` of its durable workflow input. The run canceler passes the
     * session of the cancel, because it holds no `RunSession`. A realization can ignore the parameter.
     */
    readonly emitRunEvent?: (event: RunProvenanceEvent, session: AgentSession) => void;
    /**
     * A session emits one act here. A session act runs under no authorized run, thus this member takes
     * the event alone. It is synchronous by signature for the same reason as the run emit.
     */
    readonly emitSessionEvent?: (event: SessionProvenanceEvent) => void;
    /**
     * The page staging reads the signed document of one analysis here.
     *
     * The member can be async, because a source can read a file or ask a service. It gives the bytes and
     * the attestation, or `undefined`. Absence is a normal result, not a fault: the page then carries no
     * provenance asset, and each other part of the render is what it was.
     */
    readonly readExport?: (analysisId: string) => ProvenanceExport | undefined | Promise<ProvenanceExport | undefined>;
};

/**
 * Bind the optional session emit and the logger of one site into a total emit.
 *
 * An absent member gives a call that does nothing. Thus a site emits where its act lands with no test of
 * its own, and absence stays a normal condition.
 *
 * The harness is host-agnostic, and it cannot assume that a host callback is total. Thus a throw of the
 * realization reaches the log and stops there: an observation is a record of an act, and a defect in it
 * must never undo the act that already landed.
 */
export function bindSessionEmit(seam: ProvenanceSeam | undefined, logger: Logger): (event: SessionProvenanceEvent) => void {
    const emit = seam?.emitSessionEvent;
    if (emit === undefined) {
        return () => undefined;
    }
    return (event: SessionProvenanceEvent): void => {
        try {
            emit(event);
        } catch (cause) {
            logger.error("the session emit of the provenance seam threw", {
                analysisId: event.analysisId,
                threadId: event.threadId,
                event: event.type,
                ...logger.errorFields(cause),
            });
        }
    };
}

/**
 * Bind the optional document read and the logger of one site into a total read.
 *
 * An absent member gives a call that answers absence. Thus a site asks at its one place with no test of
 * its own, and an unbound composition needs no branch.
 *
 * A throw of the realization reaches the log and becomes absence, for the same reason that a throw of an
 * emit stops at the log: the provenance of the page is an addition to the report, and a defect in it must
 * never cost the render.
 */
export function bindReadExport(seam: ProvenanceSeam | undefined, logger: Logger): (analysisId: string) => Promise<ProvenanceExport | undefined> {
    const read = seam?.readExport;
    if (read === undefined) {
        return () => Promise.resolve(undefined);
    }
    return async (analysisId: string): Promise<ProvenanceExport | undefined> => {
        try {
            return await read(analysisId);
        } catch (cause) {
            logger.error("the document read of the provenance seam threw", { analysisId, ...logger.errorFields(cause) });
            return undefined;
        }
    };
}
