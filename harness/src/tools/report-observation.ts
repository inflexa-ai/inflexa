/**
 * The report observation seam -- what one report session tells its embedder.
 *
 * A session of an analysis starts, composes a document, derives a table, previews a page, and records a
 * version. The record of those acts belongs to the embedder, which holds the signed document of the
 * analysis. Thus the harness declares the vocabulary and the seam alone, and it keeps no ledger of its
 * own.
 *
 * The union names one event for each act: the creation of a session, the four block operations, the
 * title, the derivation, the preview, and the record. Each event carries the analysis and the thread,
 * thus a consumer places it with no lookup. A block event names the block that it changed. The title
 * sits on the document, thus the title event names no block.
 *
 * The seam is fire-and-forget. It gives no result, and the harness reads none. A tool emits after the
 * act lands, thus a refused act and a failed act each emit nothing and the record states what happened.
 */

import type { Logger } from "../lib/logger.js";
import type { DerivationSource } from "../state/report-session-state.js";

/**
 * One observation of a report session.
 *
 * Each member carries what its own site holds at the moment that the act lands, and nothing more. The
 * derivation carries the chain of the table, because the site pins it and a consumer cannot rebuild it
 * from the path. The preview carries the page and the hash of the draft that it shows, thus a consumer
 * ties a page to the document that made it.
 *
 * The `create-session` event names the kind of the new session, and it names the parent thread of a
 * child session. An analysis holds sessions of more than one kind, and the thread id alone says
 * neither. Thus the document of the analysis tells the whole tree of the sessions, and a reader walks
 * it with no second read of the seam. A root session carries no parent, thus `parentThreadId` is absent
 * on it.
 */
export type ReportObservationEvent =
    | {
          type: "create-session";
          analysisId: string;
          threadId: string;
          sessionKind: "conversation" | "report";
          parentThreadId?: string;
      }
    | { type: "add-block"; analysisId: string; threadId: string; blockId: string }
    | { type: "change-block"; analysisId: string; threadId: string; blockId: string }
    | { type: "remove-block"; analysisId: string; threadId: string; blockId: string }
    | { type: "move-block"; analysisId: string; threadId: string; blockId: string }
    | { type: "set-title"; analysisId: string; threadId: string; title: string }
    | {
          type: "run-derivation";
          analysisId: string;
          threadId: string;
          outputPath: string;
          outputHash: string;
          scriptHash: string;
          sources: readonly DerivationSource[];
      }
    | { type: "preview"; analysisId: string; threadId: string; pagePath: string; documentHash: string }
    | { type: "record-version"; analysisId: string; threadId: string; versionId: string; replaced: boolean };

/**
 * The optional observation seam of the report tools.
 *
 * Synchronous by signature (`void`, never a promise), the same as the run-lifecycle observer: a host that
 * needs input and output dispatches the work rather than making a tool call wait behind it.
 */
export type EmitReportObservation = (event: ReportObservationEvent) => void;

/**
 * Bind the optional seam and the logger of one tool into a total emit.
 *
 * An absent seam gives a call that does nothing. Thus a tool emits at its landing site with no test of
 * its own, and absence stays a normal condition.
 *
 * The harness is host-agnostic, and it cannot assume that a host callback is total. Thus a throw of the
 * realization reaches the log and stops there: an observer is a record of an act, and a defect in it must
 * never undo the act that already landed.
 */
export function bindReportObservation(emit: EmitReportObservation | undefined, logger: Logger): EmitReportObservation {
    if (emit === undefined) {
        return () => undefined;
    }
    return (event: ReportObservationEvent): void => {
        try {
            emit(event);
        } catch (cause) {
            logger.error("the report observation seam threw", {
                analysisId: event.analysisId,
                threadId: event.threadId,
                event: event.type,
                ...logger.errorFields(cause),
            });
        }
    };
}
